/** Opt-in schema readiness evaluation. @module */
import { createCachedProbe } from '@setu-ts/common';
import type { HealthCheckResult, ProbeTiming } from '@setu-ts/common';
import type { DatabaseReadinessOptions, IDatabaseService } from '../interfaces/index.ts';
import { createMigrationLedger } from './migration-ledger.ts';

/** Validate before registration; diagnostics name options, never their values. */
export function validateMigrationReadiness(
  options: DatabaseReadinessOptions,
): DatabaseReadinessOptions {
  const failure =
    'readiness.migrations must be an array of unique non-empty strings, at most 10000';
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('readiness must be an object with a migrations array');
  }
  // Read every option exactly ONCE and keep a private frozen copy (the M105/M106
  // pattern): re-reading the caller's object after validation would let a getter
  // or a later mutation hand register() names that never passed this check.
  let source: unknown;
  let ledgerEntity: unknown;
  let length: unknown;
  try {
    source = options.migrations;
    ledgerEntity = options.ledgerEntity;
    length = Array.isArray(source) ? source.length : undefined;
  } catch {
    throw new TypeError(failure);
  }
  if (typeof length !== 'number' || length > 10_000) throw new TypeError(failure);
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index++) {
    let name: unknown;
    try {
      name = (source as readonly unknown[])[index];
    } catch {
      throw new TypeError(failure);
    }
    if (typeof name !== 'string' || name.trim() === '' || seen.has(name)) {
      throw new TypeError(failure);
    }
    seen.add(name);
    names.push(name);
  }
  if (
    ledgerEntity !== undefined &&
    (typeof ledgerEntity !== 'string' || ledgerEntity.trim() === '')
  ) {
    throw new TypeError('readiness.ledgerEntity must be a non-empty string');
  }
  return Object.freeze({
    migrations: Object.freeze(names),
    ...(ledgerEntity === undefined ? {} : { ledgerEntity }),
  });
}

/**
 * Compose the existing indicator with a bounded, cached ledger read when reachable.
 * @param database - Database owning the migration ledger
 * @param options - Expected migrations and optional ledger entity
 * @param timing - Monotonic clock and timer services
 * @returns An evaluator preserving unreachable results with unknown migration state
 */
export function createMigrationReadiness(
  database: IDatabaseService,
  options: DatabaseReadinessOptions,
  timing: ProbeTiming,
): (result: HealthCheckResult) => Promise<HealthCheckResult> {
  const expected = new Set(options.migrations);
  const ledger = createMigrationLedger(
    database,
    options.ledgerEntity === undefined ? undefined : { entity: options.ledgerEntity },
  );
  const probe = createCachedProbe<readonly string[] | 'unreadable'>({
    probe: () => ledger.applied(),
    fallback: 'unreadable',
    ttlMs: 5000,
    timeoutMs: 2000,
    ...timing,
  });
  return async (result) => {
    if (
      result.status === 'down' ||
      result.data?.reachable === false ||
      result.data?.reachable === 'unknown'
    ) {
      return { ...result, data: { ...result.data, migrations: { state: 'unknown' } } };
    }
    const applied = await probe();
    if (applied === 'unreadable') {
      return { status: 'down', data: { ...result.data, migrations: { state: 'unreadable' } } };
    }
    const present = new Set(applied);
    const pending = [...expected].filter((name) => !present.has(name)).length;
    if (pending > 0) {
      return {
        status: 'degraded',
        data: { ...result.data, migrations: { state: 'pending', pending } },
      };
    }
    const unknown = applied.filter((name) => !expected.has(name)).length;
    return {
      ...result,
      data: {
        ...result.data,
        migrations: {
          state: 'current',
          applied: applied.length,
          ...(unknown > 0 && { unknown }),
        },
      },
    };
  };
}
