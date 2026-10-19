/** Opt-in schema readiness evaluation. @module */
import { createCachedProbe } from '@setu-ts/common';
import type { HealthCheckResult, ProbeTiming } from '@setu-ts/common';
import type { DatabaseReadinessOptions, IDatabaseService } from '../interfaces/index.ts';
import { createMigrationLedger } from './migration-ledger.ts';

/** Validate before registration; diagnostics name options, never their values. */
export function validateMigrationReadiness(options: DatabaseReadinessOptions): void {
  const names = options.migrations;
  if (
    !Array.isArray(names) ||
    names.length > 10_000 ||
    Array.from(names).some((name: unknown) => typeof name !== 'string' || name.trim() === '') ||
    new Set(names).size !== names.length
  ) {
    throw new TypeError(
      'readiness.migrations must be an array of unique non-empty strings, at most 10000',
    );
  }
  if (
    options.ledgerEntity !== undefined &&
    (typeof options.ledgerEntity !== 'string' || options.ledgerEntity.trim() === '')
  ) {
    throw new TypeError('readiness.ledgerEntity must be a non-empty string');
  }
}

/** Compose the existing indicator with an independent bounded, cached ledger read. */
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
    if (result.status === 'down') return result;
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
