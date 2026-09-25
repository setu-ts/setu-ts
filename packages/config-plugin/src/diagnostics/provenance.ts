/**
 * Value-free configuration provenance (M98e) — the private policy compiler,
 * metadata builder, load-time record store, and diagnostics source behind
 * `IConfigDiagnosticsSource`.
 *
 * The seam rule for everything in this module: provenance is recorded while
 * configuration is ALREADY being resolved, from structure only. A builder
 * observes source categories, approved aliases, displacement relationships,
 * the existing `${NAME}` grammar, and schema input/output property PRESENCE.
 * It never compares, hashes, serializes, measures, or retains a value, never
 * enumerates the environment or a custom `IConfig`, and never adds a read to
 * the configuration object. Unapproved keys are dropped without a count (a
 * count would disclose how many exist), and unapproved file paths are
 * reduced to their category.
 *
 * The record travels with the exact configuration object through a
 * module-private `WeakMap`, so `loadConfig` followed by
 * `ConfigPlugin({ instance })` remains ONE snapshot with ONE metadata pass,
 * and the record's lifetime follows the object — GC owns the cleanup.
 *
 * @module
 */

import type {
  ConfigDiagnosticsSnapshot,
  ConfigProvenanceEntry,
  IConfig,
  IConfigDiagnosticsSource,
} from '@setu-ts/common';

import type { ConfigDiagnosticsOptions } from '../options.ts';

/**
 * Fixed provenance errors. Each names the constraint it enforces and never
 * echoes a supplied value: a construction-time diagnostics failure is an
 * attacker-reachable path for whatever the options contain.
 *
 * @internal
 */
export const CONFIG_DIAGNOSTICS_ERRORS = {
  notEnabled: 'Config diagnostics: enabled must be the literal true.',
  badOptions: 'Config diagnostics: the diagnostics option must be an object.',
  badKeys: 'Config diagnostics: keys must map exact configuration key names to display aliases.',
  badFiles: 'Config diagnostics: files must map exact configured paths to source aliases.',
  tooManyKeys: 'Config diagnostics: more than 128 approved keys.',
  tooManyFiles: 'Config diagnostics: more than eight approved files.',
  aliasBytes: 'Config diagnostics: an alias must be 1 to 64 UTF-8 bytes.',
  aliasControl: 'Config diagnostics: an alias contains a control character.',
  duplicateAlias: 'Config diagnostics: an alias is not unique.',
  badInstanceId: 'Config diagnostics: snapshot requires a non-empty instance identifier.',
} as const;

/** Fixed bounds (not configurable), matching the approved budgets. */
const MAX_APPROVED_KEYS = 128;
const MAX_APPROVED_FILES = 8;
const MAX_ALIAS_BYTES = 64;
/** The retained expansion references per key — the approved budget. */
export const MAX_REFERENCE_ALIASES = 16;
/** The maximum displaced-source aliases retained per key — the approved budget. */
export const MAX_OVERRIDDEN_ALIASES = 8;

/**
 * The fixed 256 KiB snapshot budget, as the exact UTF-8 byte length of the
 * compact JSON — the same bound the connector measures on the wire.
 *
 * @internal
 */
export const MAX_CONFIG_SNAPSHOT_BYTES = 262_144;

/** C0/C1 control code points, described by code point to avoid a literal regex class. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Reports whether a value is a plain non-null, non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Recursively freezes a DTO so a reader holding it can observe nothing that
 * happens afterwards. Private to this package (each inspector package owns
 * its own copy of this stdlib idiom; no plugin may import another to share
 * one).
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * A validated provenance policy. Produced once by
 * {@linkcode compileConfigDiagnosticsPolicy} at the earliest call of
 * `loadConfig` or `ConfigPlugin(...)`, so an invalid option refuses before
 * any application exists and every later consumer reads only the compiled
 * maps.
 *
 * @internal
 */
export interface CompiledConfigDiagnosticsPolicy {
  /** Exact configuration key → approved alias, in declared (projection) order. */
  readonly aliasByKey: ReadonlyMap<string, string>;
  /** Exact configured `.env` path → approved source alias. */
  readonly aliasByPath: ReadonlyMap<string, string>;
}

/**
 * Validates the provenance options and compiles them into the maps every
 * other seam consumes. The ONE validation of these options.
 *
 * `enabled` is checked at runtime, not only by its literal-`true` type: a
 * JavaScript or configuration-driven caller passing `enabled: false` is
 * refused rather than silently opted in.
 *
 * @param options - The raw provenance options
 * @returns The compiled policy
 * @throws {RangeError} With a fixed, value-free message for any violation
 * @internal
 */
export function compileConfigDiagnosticsPolicy(
  options: ConfigDiagnosticsOptions,
): CompiledConfigDiagnosticsPolicy {
  if (!isPlainRecord(options)) {
    throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.badOptions);
  }
  if (options.enabled !== true) {
    throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.notEnabled);
  }
  if (!isPlainRecord(options.keys)) {
    throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.badKeys);
  }

  const entries = Object.entries(options.keys);
  if (entries.length > MAX_APPROVED_KEYS) {
    throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.tooManyKeys);
  }
  const encoder = new TextEncoder();
  const aliasByKey = new Map<string, string>();
  const seenKeyAliases = new Set<string>();
  for (const [key, alias] of entries) {
    if (typeof alias !== 'string') {
      throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.badKeys);
    }
    const bytes = encoder.encode(alias).length;
    if (bytes < 1 || bytes > MAX_ALIAS_BYTES) {
      throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.aliasBytes);
    }
    if (hasControlCharacter(alias)) {
      throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.aliasControl);
    }
    if (seenKeyAliases.has(alias)) {
      throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.duplicateAlias);
    }
    seenKeyAliases.add(alias);
    aliasByKey.set(key, alias);
  }

  const aliasByPath = new Map<string, string>();
  const files = options.files;
  if (files !== undefined) {
    if (!isPlainRecord(files)) {
      throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.badFiles);
    }
    const fileEntries = Object.entries(files);
    if (fileEntries.length > MAX_APPROVED_FILES) {
      throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.tooManyFiles);
    }
    const seenFileAliases = new Set<string>();
    for (const [path, alias] of fileEntries) {
      if (typeof alias !== 'string') {
        throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.badFiles);
      }
      const bytes = encoder.encode(alias).length;
      if (bytes < 1 || bytes > MAX_ALIAS_BYTES) {
        throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.aliasBytes);
      }
      if (hasControlCharacter(alias)) {
        throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.aliasControl);
      }
      if (seenFileAliases.has(alias)) {
        throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.duplicateAlias);
      }
      seenFileAliases.add(alias);
      aliasByPath.set(path, alias);
    }
  }

  return { aliasByKey, aliasByPath };
}

/**
 * The source observation one key's FINAL value carries after the existing
 * merge steps: where it came from, its approved source alias when the origin
 * is an approved file path, and the approved aliases of every source its
 * value displaced, in displacement order. Produced by the env loader and
 * consumed once at the end of the load.
 *
 * @internal
 */
export interface EnvSourceObservation {
  readonly origin: 'environment' | 'file';
  /** The approved alias, only for a file origin whose exact path was approved. */
  readonly sourceAlias?: string;
  /** Approved aliases of the displaced sources, lowest-precedence first. */
  readonly overriddenSourceAliases: readonly string[];
}

/**
 * Builds the final provenance entries from the load's already-collected
 * observations. Pure: it reads only the observed structure — never a value.
 *
 * An entry exists when the key was observed at merge time OR is present in
 * the post-schema snapshot; a key neither observed nor present produces no
 * entry, and no count of such keys is kept. `unknown` origin with schema
 * effect `introduced` is the recorded answer for a key that appeared only
 * after schema parsing; `unknown` with `unknown` is reserved for an opaque
 * injected instance, which this function never produces.
 *
 * @param policy - The compiled policy (declaration order is projection order)
 * @param sources - Final per-key source observations from the merge
 * @param expansions - Raw `${NAME}` reference names per expanded key
 * @param finalData - The post-schema (or post-merge) configuration record
 * @param schemaConfigured - Whether a validation schema ran
 * @returns The frozen entries, in approved-key declaration order
 * @internal
 */
export function buildConfigProvenanceEntries(
  policy: CompiledConfigDiagnosticsPolicy,
  sources: ReadonlyMap<string, EnvSourceObservation>,
  expansions: ReadonlyMap<string, readonly string[]>,
  finalData: Readonly<Record<string, unknown>>,
  schemaConfigured: boolean,
): readonly ConfigProvenanceEntry[] {
  const entries: ConfigProvenanceEntry[] = [];
  for (const [key, alias] of policy.aliasByKey) {
    const observation = sources.get(key);
    const outputPresent = Object.hasOwn(finalData, key);
    if (observation === undefined && !outputPresent) {
      continue;
    }
    const schemaEffect = !schemaConfigured
      ? 'not-configured'
      : observation !== undefined && outputPresent
      ? 'validated'
      : observation === undefined && outputPresent
      ? 'introduced'
      : 'removed';
    const rawReferences = expansions.get(key) ?? [];
    const referenceAliases = rawReferences
      .map((reference) => policy.aliasByKey.get(reference))
      .filter((referenceAlias): referenceAlias is string => referenceAlias !== undefined)
      .slice(0, MAX_REFERENCE_ALIASES);
    const overriddenSourceAliases = (observation?.overriddenSourceAliases ?? []).slice(
      0,
      MAX_OVERRIDDEN_ALIASES,
    );
    entries.push(deepFreeze({
      keyAlias: alias,
      origin: observation === undefined ? 'unknown' : observation.origin,
      ...(observation?.sourceAlias === undefined ? {} : { sourceAlias: observation.sourceAlias }),
      overriddenSourceAliases: Object.freeze(overriddenSourceAliases),
      expanded: rawReferences.length > 0,
      referenceAliases: Object.freeze(referenceAliases),
      schemaEffect,
    }));
  }
  return Object.freeze(entries);
}

/**
 * The module-private record store. WeakMap keys are unenumerable by
 * construction, and the record's lifetime follows the exact configuration
 * object — close drops connector access and GC owns the cleanup.
 * @internal
 */
const provenanceRecords = new WeakMap<IConfig, readonly ConfigProvenanceEntry[]>();

/**
 * Stores the frozen provenance record for the exact configuration object a
 * load produced. Storing twice for one object replaces the record, which is
 * the correct outcome for a repeated load of the same instance path.
 *
 * @param config - The configuration object the loader built
 * @param entries - The frozen entries built at load time
 * @internal
 */
export function storeConfigProvenance(
  config: IConfig,
  entries: readonly ConfigProvenanceEntry[],
): void {
  provenanceRecords.set(config, entries);
}

/**
 * Adopts the provenance record for an exact instance, or reports `null` when
 * the instance was not produced by this loader — the opaque-instance case,
 * which the source answers with `unknown` entries and never resolves through
 * reads.
 *
 * @param config - The instance the plugin was handed
 * @returns The frozen record entries, or `null`
 * @internal
 */
export function adoptConfigProvenance(config: IConfig): readonly ConfigProvenanceEntry[] | null {
  return provenanceRecords.get(config) ?? null;
}

/**
 * Applies the fixed 256 KiB snapshot budget to the final DTO: the exact
 * UTF-8 byte length of the compact JSON encoding of the RETURNED object is
 * the number the wire consumer measures, so trimming runs on the final
 * shape — omitting later entries, setting `truncated`, and counting every
 * omitted entry in `droppedEntries` until it fits.
 *
 * The retained set is bounded to 128 approved keys of bounded size, so the
 * budget is unreachable through real captures; the decidable trim is still
 * carried and tested directly rather than left behind an uncoverable branch.
 *
 * @param scalar - The snapshot's scalar members
 * @param entries - The projected entries, in stable declaration order
 * @returns The bounded snapshot DTO
 * @internal
 */
export function applyConfigSnapshotBudget(
  scalar: {
    readonly instanceId: string;
    readonly state: ConfigDiagnosticsSnapshot['state'];
  },
  entries: readonly ConfigProvenanceEntry[],
): ConfigDiagnosticsSnapshot {
  const encoder = new TextEncoder();
  const build = (
    kept: readonly ConfigProvenanceEntry[],
    isTruncated: boolean,
  ): ConfigDiagnosticsSnapshot => ({
    version: 1,
    instanceId: scalar.instanceId,
    state: scalar.state,
    entries: kept,
    truncated: isTruncated,
    droppedEntries: entries.length - kept.length,
  });
  const measure = (candidate: ConfigDiagnosticsSnapshot): number =>
    encoder.encode(JSON.stringify(candidate)).length;

  const whole = build(entries, false);
  if (measure(whole) <= MAX_CONFIG_SNAPSHOT_BYTES) {
    return whole;
  }
  // Dropping a suffix entry only shrinks the encoding, so the encoded length
  // is monotone in the retained count and the largest fitting prefix is
  // found by bisection.
  let low = 0;
  let high = entries.length - 1;
  let best = build([], true);
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = build(entries.slice(0, mid), true);
    if (measure(candidate) <= MAX_CONFIG_SNAPSHOT_BYTES) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Creates the `IConfigDiagnosticsSource` for one configuration instance.
 *
 * With no compiled policy (the `diagnostics` option was absent) the source
 * is inert: every snapshot reports `disabled` and no data is read. With a
 * policy, the source adopts the load-time record when the exact instance has
 * one; otherwise the instance is opaque and every approved alias is reported
 * with origin and schema effect `unknown` — honestly, with no presence flag
 * and without a single read of the instance. A read never enumerates,
 * resolves, or invokes anything.
 *
 * @param config - The configuration instance the plugin registers
 * @param policy - The compiled policy, or `null` for the inert disabled source
 * @returns The source
 * @internal
 */
export function createConfigDiagnosticsSource(
  config: IConfig,
  policy: CompiledConfigDiagnosticsPolicy | null,
): IConfigDiagnosticsSource {
  return {
    snapshot(instanceId: string): ConfigDiagnosticsSnapshot {
      if (typeof instanceId !== 'string' || instanceId === '') {
        throw new RangeError(CONFIG_DIAGNOSTICS_ERRORS.badInstanceId);
      }
      if (policy === null) {
        return deepFreeze({
          version: 1,
          instanceId,
          state: 'disabled',
          entries: Object.freeze([]),
          truncated: false,
          droppedEntries: 0,
        });
      }
      const adopted = adoptConfigProvenance(config);
      const entries = adopted ??
        [...policy.aliasByKey.values()].map((alias) =>
          deepFreeze({
            keyAlias: alias,
            origin: 'unknown' as const,
            overriddenSourceAliases: Object.freeze([]),
            expanded: false,
            referenceAliases: Object.freeze([]),
            schemaEffect: 'unknown' as const,
          })
        );
      const state = entries.length === 0 ? 'no-data' : 'ready';
      return deepFreeze(applyConfigSnapshotBudget({ instanceId, state }, entries));
    },
  };
}
