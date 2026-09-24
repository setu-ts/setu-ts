/**
 * Unit tests for protocol v1: canonical target parsing (and every rejected
 * alias), DTO projection against the exact field allowlist, fixed error
 * bodies/statuses, and the client-side projection validators.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  currentInspectorsManifest,
  errorBody,
  INSPECTOR_KEYS,
  isBatchProjection,
  isHealthSnapshotProjection,
  isInspectorsManifest,
  isSnapshotProjection,
  legacyStatusBody,
  parseStatusBody,
  parseTarget,
  projectBatch,
  projectEvent,
  projectHealthSnapshot,
  projectSnapshot,
  PROTOCOL_ERRORS,
  statusBody,
} from '../../src/protocol/protocol.ts';
import { minimalBatch, minimalSnapshot, TEST_INSTANCE_ID } from '../fixtures/helpers.ts';

describe('Protocol — canonical target parsing', () => {
  it('accepts exactly the four canonical targets', () => {
    expect(parseTarget('/v1/status', '')).toEqual({
      op: 'status',
      canonicalTarget: '/v1/status',
      after: 0,
      limit: 0,
    });
    expect(parseTarget('/v1/snapshot', '')).toEqual({
      op: 'snapshot',
      canonicalTarget: '/v1/snapshot',
      after: 0,
      limit: 0,
    });
    expect(parseTarget('/v1/health', '')).toEqual({
      op: 'health',
      canonicalTarget: '/v1/health',
      after: 0,
      limit: 0,
    });
    expect(parseTarget('/v1/events', 'after=0&limit=128')).toEqual({
      op: 'events',
      canonicalTarget: '/v1/events?after=0&limit=128',
      after: 0,
      limit: 128,
    });
    expect(parseTarget('/v1/events', 'after=123&limit=1')?.canonicalTarget).toEqual(
      '/v1/events?after=123&limit=1',
    );
  });

  it('rejects every non-canonical target shape', () => {
    const rejected: readonly [string, string][] = [
      // Unknown operations and trailing paths
      ['/v1/status/', ''],
      ['/v1/status/extra', ''],
      ['/v1/unknown', ''],
      ['/v2/status', ''],
      ['/', ''],
      ['/v1/events/extra', 'after=0&limit=1'],
      // Encoded aliases
      ['/%76%31/status', ''],
      ['/v1/%73napshot', ''],
      ['/v1/events', 'after%3D0&limit=1'],
      // Query field violations on the fixed targets
      ['/v1/status', 'x=1'],
      ['/v1/snapshot', 'after=0'],
      ['/v1/health', 'x=1'],
      ['/v1/health/', ''],
      ['/v1/health/extra', ''],
      // Events query: order, duplicates, unknown fields, missing fields
      ['/v1/events', 'limit=1&after=0'],
      ['/v1/events', 'after=0&limit=1&extra=2'],
      ['/v1/events', 'after=0&limit=1&limit=2'],
      ['/v1/events', 'after=0'],
      ['/v1/events', 'limit=1'],
      ['/v1/events', ''],
      // Non-canonical numbers
      ['/v1/events', 'after=007&limit=1'],
      ['/v1/events', 'after=0&limit=001'],
      ['/v1/events', 'after=-1&limit=1'],
      ['/v1/events', 'after=0&limit=0'],
      ['/v1/events', 'after=0&limit=129'],
      ['/v1/events', `after=${'9'.repeat(17)}&limit=1`],
    ];
    for (const [path, search] of rejected) {
      expect(parseTarget(path, search)).toBe(null);
    }
  });

  it('accepts the boundary limit of 128 and after of 0', () => {
    expect(parseTarget('/v1/events', 'after=0&limit=128')).not.toBe(null);
    expect(parseTarget('/v1/events', 'after=1&limit=128')).not.toBe(null);
  });
});

describe('Protocol — projection', () => {
  it('projects a snapshot field-by-field, optional fields only when present', () => {
    const projected = projectSnapshot(minimalSnapshot() as never);
    expect(projected).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'running',
      failureCode: null,
      nodes: [
        { id: 'p1', kind: 'plugin', label: 'catalog', version: '1.0.0' },
        { id: 'c1', kind: 'capability', label: 'catalog-items', registered: true },
      ],
      edges: [{ from: 'p1', to: 'c1', kind: 'owns' }],
      truncated: false,
      droppedEvents: 0,
    });
    // The serialized body stays far under the 256 KiB ceiling.
    expect(JSON.stringify(projected).length).toBeLessThan(256 * 1024);
  });

  it('projects an event with its optional fields in the allowed set', () => {
    const projected = projectEvent({
      sequence: 3,
      operationId: 'op3',
      parentOperationId: 'op1',
      kind: 'middleware',
      stage: 'global',
      nodeId: 'm1',
      outcome: 'short-circuit',
      atMs: 4,
      durationMs: 1,
      statusCode: 403,
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
    });
    expect(projected).toEqual({
      sequence: 3,
      operationId: 'op3',
      parentOperationId: 'op1',
      kind: 'middleware',
      stage: 'global',
      nodeId: 'm1',
      outcome: 'short-circuit',
      atMs: 4,
      durationMs: 1,
      statusCode: 403,
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
    });
  });

  it('projects a batch', () => {
    const projected = projectBatch(minimalBatch() as never);
    expect(projected.version).toEqual(1);
    expect(projected.instanceId).toEqual(TEST_INSTANCE_ID);
    expect(Array.isArray(projected.events)).toBe(true);
    expect(projected.next).toEqual(1);
    expect(projected.lost).toEqual(0);
    expect(projected.closed).toEqual(false);
  });
});

describe('Protocol — status body and fixed errors', () => {
  it('builds the status body with the four allowed fields and the manifest', () => {
    expect(statusBody(TEST_INSTANCE_ID, 899_999, currentInspectorsManifest())).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      expiresInMs: 899_999,
      inspectors: currentInspectorsManifest(),
    });
  });

  it('builds the legacy M98b status body with exactly the three fields', () => {
    expect(legacyStatusBody(TEST_INSTANCE_ID, 899_999)).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      expiresInMs: 899_999,
    });
  });

  it('serves the fixed inspector manifest with health true and the rest false', () => {
    const manifest = currentInspectorsManifest();
    expect(manifest.health).toBe(true);
    for (const key of INSPECTOR_KEYS) {
      if (key !== 'health') {
        expect(manifest[key]).toBe(false);
      }
    }
    expect(Object.keys(manifest).length).toBe(11);
    expect(isInspectorsManifest(manifest)).toBe(true);
    expect(isInspectorsManifest({ ...manifest, extra: true })).toBe(false);
    expect(isInspectorsManifest({ ...manifest, health: 'yes' })).toBe(false);
    expect(isInspectorsManifest(null)).toBe(false);
  });

  it('maps every fixed error code to its HTTP status', () => {
    expect(PROTOCOL_ERRORS['invalid-request']).toEqual(400);
    expect(PROTOCOL_ERRORS.unauthorized).toEqual(401);
    expect(PROTOCOL_ERRORS.expired).toEqual(401);
    expect(PROTOCOL_ERRORS['unsupported-version']).toEqual(400);
    expect(PROTOCOL_ERRORS.unavailable).toEqual(503);
    expect(PROTOCOL_ERRORS['rate-limited']).toEqual(429);
    // The fixed error shape: version and the code, nothing else.
    expect(errorBody('unauthorized')).toEqual({ version: 1, error: 'unauthorized' });
    expect(errorBody('rate-limited')).toEqual({ version: 1, error: 'rate-limited' });
  });
});

describe('Protocol — client-side validators', () => {
  it('accepts the legacy three-field status body and resolves the all-false manifest', () => {
    const parsed = parseStatusBody({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      expiresInMs: 5,
    });
    expect(parsed).not.toBe(null);
    expect(parsed?.instanceId).toBe(TEST_INSTANCE_ID);
    expect(parsed?.expiresInMs).toBe(5);
    expect(Object.values(parsed?.inspectors ?? {})).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('accepts the new four-field status body with a well-formed manifest', () => {
    const parsed = parseStatusBody({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      expiresInMs: 5,
      inspectors: currentInspectorsManifest(),
    });
    expect(parsed).not.toBe(null);
    expect(parsed?.inspectors.health).toBe(true);
  });

  it('rejects status-body key drift, bad scalars, and malformed manifests', () => {
    // Missing / extra keys
    expect(
      parseStatusBody({ version: 1, instanceId: TEST_INSTANCE_ID }),
    ).toBe(null);
    expect(
      parseStatusBody({ version: 1, instanceId: TEST_INSTANCE_ID, expiresInMs: 5, x: 1 }),
    ).toBe(null);
    // Bad scalars
    expect(
      parseStatusBody({ version: 2, instanceId: TEST_INSTANCE_ID, expiresInMs: 5 }),
    ).toBe(null);
    expect(parseStatusBody({ version: 1, instanceId: '', expiresInMs: 5 })).toBe(null);
    expect(
      parseStatusBody({ version: 1, instanceId: TEST_INSTANCE_ID, expiresInMs: -1 }),
    ).toBe(null);
    // Non-objects
    expect(parseStatusBody(null)).toBe(null);
    expect(parseStatusBody('status')).toBe(null);
    // Malformed manifests: unknown, missing, extra key, non-boolean
    const bad = (inspectors: Record<string, unknown>): ReturnType<typeof parseStatusBody> =>
      parseStatusBody({
        version: 1,
        instanceId: TEST_INSTANCE_ID,
        expiresInMs: 5,
        inspectors,
      });
    expect(bad({ ...currentInspectorsManifest(), extra: true })).toBe(null);
    expect(bad({ ...currentInspectorsManifest(), health: 'yes' })).toBe(null);
    const { health: _dropped, ...missingOne } = currentInspectorsManifest();
    expect(bad(missingOne)).toBe(null);
  });

  it('accepts well-formed snapshots and rejects malformed ones', () => {
    expect(isSnapshotProjection(minimalSnapshot())).toBe(true);
    expect(isSnapshotProjection(minimalSnapshot(null))).toBe(true);
    expect(isSnapshotProjection({ ...minimalSnapshot(), version: 2 })).toBe(false);
    expect(isSnapshotProjection({ ...minimalSnapshot(), nodes: 'many' })).toBe(false);
    expect(isSnapshotProjection({ ...minimalSnapshot(), edges: [{ from: 'a' }] })).toBe(false);
    expect(isSnapshotProjection({ ...minimalSnapshot(), truncated: 'no' })).toBe(false);
    expect(isSnapshotProjection([])).toBe(false);
  });

  it('accepts well-formed batches and rejects malformed ones', () => {
    expect(isBatchProjection(minimalBatch())).toBe(true);
    expect(isBatchProjection(minimalBatch(undefined as unknown as string, null))).toBe(true);
    expect(isBatchProjection({ ...minimalBatch(), version: 2 })).toBe(false);
    expect(isBatchProjection({ ...minimalBatch(), events: [{}] })).toBe(false);
    expect(isBatchProjection({ ...minimalBatch(), next: 'x' })).toBe(false);
    expect(isBatchProjection({ ...minimalBatch(), closed: 1 })).toBe(false);
  });
});

describe('Protocol — health projection and validator (M98d)', () => {
  const reported = {
    indicatorAlias: 'database',
    status: 'up',
    state: 'reported',
    latencyMs: 3,
    ageMs: 12,
    origin: 'application',
  };
  const neverObserved = {
    indicatorAlias: 'cache',
    state: 'never-observed',
    latencyMs: null,
    ageMs: null,
    origin: 'scheduled',
  };
  const snapshot = {
    version: 1,
    instanceId: TEST_INSTANCE_ID,
    state: 'ready',
    observations: [reported, neverObserved],
    truncated: false,
    droppedObservations: 1,
  };

  it('projects a health snapshot field-by-field, optional status only when present', () => {
    const projected = projectHealthSnapshot(snapshot as never);
    expect(projected).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      state: 'ready',
      observations: [
        {
          indicatorAlias: 'database',
          state: 'reported',
          latencyMs: 3,
          ageMs: 12,
          origin: 'application',
          status: 'up',
        },
        {
          indicatorAlias: 'cache',
          state: 'never-observed',
          latencyMs: null,
          ageMs: null,
          origin: 'scheduled',
        },
      ],
      truncated: false,
      droppedObservations: 1,
    });
    // The never-observed observation carries NO status key.
    const obs = projected.observations as Record<string, unknown>[];
    expect('status' in obs[1]).toBe(false);
  });

  it('accepts a well-formed health snapshot and rejects malformed ones', () => {
    expect(isHealthSnapshotProjection(snapshot)).toBe(true);
    expect(isHealthSnapshotProjection({ ...snapshot, version: 2 })).toBe(false);
    expect(isHealthSnapshotProjection({ ...snapshot, instanceId: '' })).toBe(false);
    expect(isHealthSnapshotProjection({ ...snapshot, state: 'bogus' })).toBe(false);
    expect(isHealthSnapshotProjection({ ...snapshot, observations: 'many' })).toBe(false);
    expect(isHealthSnapshotProjection({ ...snapshot, truncated: 'no' })).toBe(false);
    expect(isHealthSnapshotProjection({ ...snapshot, droppedObservations: 'x' })).toBe(false);
    expect(isHealthSnapshotProjection([])).toBe(false);
  });

  it('rejects an observation with a bad enum, missing alias, or bad nullability', () => {
    const check = (obs: Record<string, unknown>): boolean =>
      isHealthSnapshotProjection({ ...snapshot, observations: [obs] });
    expect(check({ ...reported, state: 'bogus' })).toBe(false);
    expect(check({ ...reported, status: 'bogus' })).toBe(false);
    expect(check({ ...reported, origin: 'bogus' })).toBe(false);
    expect(check({ ...reported, indicatorAlias: '' })).toBe(false);
    expect(check({ ...neverObserved, latencyMs: 5 })).toBe(true);
    expect(check({ ...reported, latencyMs: '3' })).toBe(false);
    expect(check({ ...reported, ageMs: '12' })).toBe(false);
  });
});
