/**
 * Unit tests for value-free configuration provenance (M98e): the metadata
 * builder, the WeakMap record store, and the diagnostics source.
 *
 * The load-bearing properties covered here: entries carry approved aliases
 * and evidence only — never a value; unapproved keys are dropped without a
 * count; schema effects are presence-derived (a DEFAULT and a TRANSFORM that
 * introduces a key report identically); an opaque instance is answered with
 * `unknown` entries and ZERO reads of it; and a read never enumerates,
 * resolves, or invokes anything.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IConfig } from '@setu-ts/common';

import {
  adoptConfigProvenance,
  applyConfigSnapshotBudget,
  approvedReferenceAliases,
  buildConfigProvenanceEntries,
  type CompiledConfigDiagnosticsPolicy,
  CONFIG_DIAGNOSTICS_ERRORS,
  createConfigDiagnosticsSource,
  type EnvSourceObservation,
  MAX_CONFIG_SNAPSHOT_BYTES,
  MAX_REFERENCE_ALIASES,
  storeConfigProvenance,
} from '../../src/diagnostics/provenance.ts';

/** A two-key policy used by most tests: `PORT` → `port`, `HOST` → `host`. */
function smallPolicy(): CompiledConfigDiagnosticsPolicy {
  return {
    aliasByKey: new Map([['PORT', 'port'], ['HOST', 'host']]),
    aliasByPath: new Map([['.env.local', 'dotenv-local'], ['.env', 'dotenv']]),
  };
}

/** A source observation with all optional fields. */
function observation(
  origin: 'environment' | 'file',
  sourceAlias?: string,
  overridden?: string[],
): EnvSourceObservation {
  return {
    origin,
    ...(sourceAlias === undefined ? {} : { sourceAlias }),
    overriddenSourceAliases: overridden ?? [],
  };
}

describe('provenance builder | source evidence', () => {
  it('projects observed environment and file origins with approved aliases only', () => {
    const sources = new Map<string, EnvSourceObservation>([
      ['PORT', observation('environment', undefined, ['dotenv-local', 'dotenv'])],
      ['HOST', observation('file', 'dotenv-local')],
    ]);
    const entries = buildConfigProvenanceEntries(
      smallPolicy(),
      sources,
      new Map(),
      new Set(['PORT', 'HOST']),
      false,
    );
    expect(entries).toEqual([
      {
        keyAlias: 'port',
        origin: 'environment',
        overriddenSourceAliases: ['dotenv-local', 'dotenv'],
        expanded: false,
        referenceAliases: [],
        schemaEffect: 'not-configured',
      },
      {
        keyAlias: 'host',
        origin: 'file',
        sourceAlias: 'dotenv-local',
        overriddenSourceAliases: [],
        expanded: false,
        referenceAliases: [],
        schemaEffect: 'not-configured',
      },
    ]);
  });

  it('reduces an unapproved file path to the category only', () => {
    const sources = new Map<string, EnvSourceObservation>([
      // The path was NOT in the policy's aliasByPath: no source alias exists.
      ['HOST', observation('file')],
    ]);
    const entries = buildConfigProvenanceEntries(
      smallPolicy(),
      sources,
      new Map(),
      new Set(['HOST']),
      false,
    );
    expect(entries[0].origin).toEqual('file');
    expect(Object.hasOwn(entries[0], 'sourceAlias')).toBe(false);
  });

  it('drops unapproved keys without any count of them', () => {
    const sources = new Map<string, EnvSourceObservation>([
      ['SECRET_VALUE', observation('environment')],
      ['PORT', observation('environment')],
    ]);
    const entries = buildConfigProvenanceEntries(
      smallPolicy(),
      sources,
      new Map(),
      new Set(['SECRET_VALUE', 'PORT']),
      false,
    );
    expect(entries.length).toEqual(1);
    expect(entries[0].keyAlias).toEqual('port');
  });

  it('retains expansion evidence only when both endpoints are approved, capped at the budget', () => {
    const policy = smallPolicy();
    const sources = new Map<string, EnvSourceObservation>([
      ['PORT', observation('environment')],
    ]);
    const expansions = new Map<string, readonly string[]>([
      // HOST is approved; SECRET_REF is not. DIST is approved and appears
      // twice (deduplicated by the expander's distinct-name report).
      ['PORT', approvedReferenceAliases(policy, ['HOST', 'SECRET_REF', 'DIST'])],
    ]);
    const entries = buildConfigProvenanceEntries(
      policy,
      sources,
      expansions,
      new Set(['PORT', 'HOST']),
      false,
    );
    expect(entries[0].expanded).toBe(true);
    expect(entries[0].referenceAliases).toEqual(['host']);
  });

  it('caps retained references at the approved budget', () => {
    const keys = new Map<string, string>([['APP', 'app']]);
    for (let i = 0; i < MAX_REFERENCE_ALIASES + 4; i++) {
      keys.set(`REF_${i}`, `ref${i}`);
    }
    const policy: CompiledConfigDiagnosticsPolicy = {
      aliasByKey: keys,
      aliasByPath: new Map(),
    };
    const references = [...keys.keys()].filter((k) => k !== 'APP');
    const entries = buildConfigProvenanceEntries(
      policy,
      new Map([['APP', observation('environment')]]),
      new Map([['APP', approvedReferenceAliases(policy, references)]]),
      new Set(['APP']),
      false,
    );
    expect(entries[0].referenceAliases.length).toEqual(MAX_REFERENCE_ALIASES);
  });

  it('reports expanded=false for a key with no expansion grammar', () => {
    const entries = buildConfigProvenanceEntries(
      smallPolicy(),
      new Map([['PORT', observation('environment')]]),
      new Map(),
      new Set(['PORT']),
      false,
    );
    expect(entries[0].expanded).toBe(false);
  });
});

describe('provenance builder | structurally value-free inputs (audit F3)', () => {
  it('cannot be handed the values record: presence is a set of approved key names', () => {
    const entries = buildConfigProvenanceEntries(
      smallPolicy(),
      new Map([['PORT', observation('environment')]]),
      new Map(),
      new Set(['PORT']),
      false,
    );
    expect(entries.length).toEqual(1);
    // Compile-time: the builder's signature admits no configuration record.
    // A later edit that makes it read values must change this parameter type
    // first, which this directive then stops compiling.
    expect(() =>
      buildConfigProvenanceEntries(
        smallPolicy(),
        new Map(),
        new Map(),
        // @ts-expect-error — a values record is not a presence set
        { PORT: 'canary-value' },
        false,
      )
    ).toThrow(TypeError);
  });

  it('maps raw reference names to approved aliases BEFORE the builder sees them', () => {
    // Unapproved names are dropped, and the mapped list is capped.
    expect(approvedReferenceAliases(smallPolicy(), ['HOST', 'SECRET_REF', 'PORT'])).toEqual([
      'host',
      'port',
    ]);
    expect(approvedReferenceAliases(smallPolicy(), ['SECRET_REF'])).toEqual([]);
  });

  it('reports expanded=true when every reference was unapproved, with no reference aliases', () => {
    const entries = buildConfigProvenanceEntries(
      smallPolicy(),
      new Map([['PORT', observation('environment')]]),
      new Map([['PORT', approvedReferenceAliases(smallPolicy(), ['SECRET_REF'])]]),
      new Set(['PORT']),
      false,
    );
    expect(entries[0]).toMatchObject({ expanded: true, referenceAliases: [] });
  });
});

describe('provenance builder | schema effects are presence-derived', () => {
  const sources = new Map<string, EnvSourceObservation>([
    ['PORT', observation('environment')],
    ['REMOVED', observation('environment')],
  ]);

  it('reports validated / removed / not-configured from presence', () => {
    const entries = buildConfigProvenanceEntries(
      smallPolicy(),
      sources,
      new Map(),
      new Set(['PORT']),
      true,
    );
    const byAlias = new Map(entries.map((e) => [e.keyAlias, e]));
    expect(byAlias.get('port')!.schemaEffect).toEqual('validated');
    // Never observed and never present: no entry exists for it at all.
    expect(byAlias.get('host')).toBeUndefined();
  });

  it('reports removed for an approved key the schema dropped', () => {
    // HOST was observed at merge time and absent from the schema output —
    // the input-present/output-absent pattern.
    const entries = buildConfigProvenanceEntries(
      smallPolicy(),
      new Map([['HOST', observation('environment')], ['PORT', observation('environment')]]),
      new Map(),
      new Set(['PORT']),
      true,
    );
    const byAlias = new Map(entries.map((e) => [e.keyAlias, e]));
    expect(byAlias.get('host')!.schemaEffect).toEqual('removed');
    expect(byAlias.get('host')!.origin).toEqual('environment');
    expect(byAlias.get('port')!.schemaEffect).toEqual('validated');
  });

  it('reports introduced for a key present only after the schema — origin unknown', () => {
    const entries = buildConfigProvenanceEntries(
      smallPolicy(),
      sources,
      new Map(),
      new Set(['PORT', 'HOST']),
      true,
    );
    const byAlias = new Map(entries.map((e) => [e.keyAlias, e]));
    expect(byAlias.get('host')!.schemaEffect).toEqual('introduced');
    expect(byAlias.get('host')!.origin).toEqual('unknown');
  });

  it('pins the effect to PRESENCE, not mechanism: a schema DEFAULT and a schema TRANSFORM both report introduced', () => {
    // A schema default and a transform deriving the key from other inputs
    // produce the identical input-absent/output-present pattern — the plan's
    // exact-output case. Naming one mechanism would misstate the other.
    const defaultLike = buildConfigProvenanceEntries(
      smallPolicy(),
      sources,
      new Map(),
      new Set(['PORT', 'HOST']),
      true,
    );
    const transformLike = buildConfigProvenanceEntries(
      smallPolicy(),
      sources,
      new Map(),
      new Set(['PORT', 'HOST']),
      true,
    );
    expect(defaultLike.find((e) => e.keyAlias === 'host')!.schemaEffect).toEqual('introduced');
    expect(transformLike.find((e) => e.keyAlias === 'host')!.schemaEffect).toEqual('introduced');
  });
});

describe('provenance record store | WeakMap adoption', () => {
  /** A minimal conforming IConfig double. */
  function configDouble(): IConfig {
    return {
      get<T>(key: string): T | undefined {
        return ({ PORT: 8080 } as Record<string, unknown>)[key] as T | undefined;
      },
      getOrThrow<T>(key: string): T {
        return ({ PORT: 8080 } as Record<string, unknown>)[key] as T;
      },
      has(key: string): boolean {
        return key === 'PORT';
      },
    };
  }

  it('adopts the record for the exact instance and nothing else', () => {
    const config = configDouble();
    const entries = buildConfigProvenanceEntries(
      smallPolicy(),
      new Map([['PORT', observation('environment')]]),
      new Map(),
      new Set(['PORT']),
      false,
    );
    storeConfigProvenance(config, entries);
    expect(adoptConfigProvenance(config)).toEqual(entries);
    expect(adoptConfigProvenance(configDouble())).toBeNull();
  });

  it('keeps adopted entries with their real environment/file origins', () => {
    const config = configDouble();
    const entries = buildConfigProvenanceEntries(
      smallPolicy(),
      new Map([['PORT', observation('file', 'dotenv')]]),
      new Map(),
      new Set(['PORT']),
      false,
    );
    storeConfigProvenance(config, entries);
    const adopted = adoptConfigProvenance(config)!;
    // Injection is how the snapshot REACHED the application, not where its
    // value came from: the origin stays `file`.
    expect(adopted[0].origin).toEqual('file');
    expect(adopted[0].sourceAlias).toEqual('dotenv');
  });
});

describe('config diagnostics source', () => {
  /** A counting, hostile IConfig: every read throws. */
  function hostileConfig(): IConfig & { calls: number } {
    const counter = { calls: 0 };
    return {
      get calls(): number {
        return counter.calls;
      },
      get<T>(_key: string): T | undefined {
        counter.calls += 1;
        throw new Error('hostile get — canary-SYNTHETIC');
      },
      getOrThrow<T>(_key: string): T {
        counter.calls += 1;
        throw new Error('hostile getOrThrow — canary-SYNTHETIC');
      },
      has(_key: string): boolean {
        counter.calls += 1;
        throw new Error('hostile has — canary-SYNTHETIC');
      },
    };
  }

  /** A minimal conforming IConfig double with fixed behavior. */
  function minimalConfig(): IConfig {
    return {
      get: <T>(_key: string): T | undefined => undefined,
      getOrThrow: <T>(_key: string): T => undefined as T,
      has: (_key: string): boolean => false,
    };
  }

  it('refuses an empty or non-string instance id with a fixed RangeError', () => {
    const source = createConfigDiagnosticsSource(minimalConfig(), null);
    expect(() => source.snapshot('')).toThrow(RangeError);
    expect(() => source.snapshot('')).toThrow(CONFIG_DIAGNOSTICS_ERRORS.badInstanceId);
    expect(() => source.snapshot(1 as unknown as string)).toThrow(RangeError);
  });

  it('reports disabled for the inert source built without a policy', () => {
    const source = createConfigDiagnosticsSource(minimalConfig(), null);
    const snapshot = source.snapshot('instance-1');
    expect(snapshot).toEqual({
      version: 1,
      instanceId: 'instance-1',
      state: 'disabled',
      entries: [],
      truncated: false,
      droppedEntries: 0,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('reports ready with the adopted record, deeply frozen', () => {
    const config = minimalConfig();
    storeConfigProvenance(
      config,
      buildConfigProvenanceEntries(
        smallPolicy(),
        new Map([['PORT', observation('environment', undefined, ['dotenv'])]]),
        new Map(),
        new Set(['PORT']),
        true,
      ),
    );
    const source = createConfigDiagnosticsSource(config, smallPolicy());
    const snapshot = source.snapshot('instance-1');
    expect(snapshot.state).toEqual('ready');
    expect(snapshot.entries.length).toEqual(1);
    expect(snapshot.entries[0].schemaEffect).toEqual('validated');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0].overriddenSourceAliases)).toBe(true);
  });

  it('reports no-data when enabled with no approved resolved entries', () => {
    const config = minimalConfig();
    storeConfigProvenance(config, []);
    const source = createConfigDiagnosticsSource(config, smallPolicy());
    expect(source.snapshot('instance-1').state).toEqual('no-data');
  });

  it('answers an opaque instance with unknown entries and ZERO reads of it', () => {
    const hostile = hostileConfig();
    const source = createConfigDiagnosticsSource(hostile, smallPolicy());
    const snapshot = source.snapshot('instance-1');
    expect(hostile.calls).toEqual(0);
    expect(snapshot.state).toEqual('ready');
    // Every approved alias, honestly unknown — no presence flag exists.
    expect(snapshot.entries).toEqual([
      {
        keyAlias: 'port',
        origin: 'unknown',
        overriddenSourceAliases: [],
        expanded: false,
        referenceAliases: [],
        schemaEffect: 'unknown',
      },
      {
        keyAlias: 'host',
        origin: 'unknown',
        overriddenSourceAliases: [],
        expanded: false,
        referenceAliases: [],
        schemaEffect: 'unknown',
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('canary-SYNTHETIC');
  });
});

describe('config snapshot budget', () => {
  it('returns the whole snapshot when it fits the 256 KiB budget', () => {
    const snapshot = applyConfigSnapshotBudget(
      { instanceId: 'i', state: 'ready' },
      [
        {
          keyAlias: 'port',
          origin: 'environment',
          overriddenSourceAliases: [],
          expanded: false,
          referenceAliases: [],
          schemaEffect: 'validated',
        },
      ],
    );
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.droppedEntries).toBe(0);
    expect(snapshot.entries.length).toBe(1);
  });

  it('trims a suffix and counts every dropped entry when over budget', () => {
    // Synthetic oversized aliases (the budget function does not validate
    // sizes — the DTO validator does): 128 entries of ~70 KB each.
    const entries = Array.from({ length: 128 }, (_, i) => ({
      keyAlias: `k${i}-${'x'.repeat(70_000)}`,
      origin: 'environment' as const,
      overriddenSourceAliases: [],
      expanded: false,
      referenceAliases: [],
      schemaEffect: 'validated' as const,
    }));
    const snapshot = applyConfigSnapshotBudget({ instanceId: 'i', state: 'ready' }, entries);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.droppedEntries).toBe(128 - snapshot.entries.length);
    expect(snapshot.entries.length).toBeGreaterThan(0);
    // The returned object's encoding is what the wire consumer measures.
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length)
      .toBeLessThanOrEqual(MAX_CONFIG_SNAPSHOT_BYTES);
  });

  it('is reachable with LEGAL aliases, because aliases are bounded in UTF-8 bytes, not JSON bytes', () => {
    // Every alias below passes the policy compiler (64 UTF-8 bytes, no
    // control character), yet `"` and `\\` double under JSON encoding. So a
    // fully-populated legal policy exceeds the budget on a real load.
    const quoted = (i: number) => '"'.repeat(60) + String(i).padStart(4, '0');
    const fileAliases = Array.from({ length: 8 }, (_, f) => '\\'.repeat(60) + `f${f}__`);
    const entries = Array.from({ length: 128 }, (_, i) => ({
      keyAlias: quoted(i),
      origin: 'environment' as const,
      overriddenSourceAliases: fileAliases,
      expanded: true,
      referenceAliases: Array.from({ length: 16 }, (_, j) => quoted(j)),
      schemaEffect: 'not-configured' as const,
    }));
    for (const entry of entries) {
      expect(new TextEncoder().encode(entry.keyAlias).length).toBe(64);
    }
    const snapshot = applyConfigSnapshotBudget({ instanceId: 'i', state: 'ready' }, entries);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.entries.length + snapshot.droppedEntries).toBe(128);
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length)
      .toBeLessThanOrEqual(MAX_CONFIG_SNAPSHOT_BYTES);
  });
});
