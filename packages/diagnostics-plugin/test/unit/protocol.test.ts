/**
 * Unit tests for protocol v1: canonical target parsing (and every rejected
 * alias), DTO projection against the exact field allowlist, fixed error
 * bodies/statuses, and the client-side projection validators.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  errorBody,
  isBatchProjection,
  isSnapshotProjection,
  isStatusBody,
  parseTarget,
  projectBatch,
  projectEvent,
  projectSnapshot,
  PROTOCOL_ERRORS,
  statusBody,
} from '../../src/protocol/protocol.ts';
import { minimalBatch, minimalSnapshot, TEST_INSTANCE_ID } from '../fixtures/helpers.ts';

describe('Protocol — canonical target parsing', () => {
  it('accepts exactly the three canonical targets', () => {
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
  it('builds the status body with the three allowed fields', () => {
    expect(statusBody(TEST_INSTANCE_ID, 899_999)).toEqual({
      version: 1,
      instanceId: TEST_INSTANCE_ID,
      expiresInMs: 899_999,
    });
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
  it('accepts the well-formed status body and rejects key drift', () => {
    expect(isStatusBody({ version: 1, instanceId: TEST_INSTANCE_ID, expiresInMs: 5 })).toBe(
      true,
    );
    expect(isStatusBody({ version: 1, instanceId: TEST_INSTANCE_ID })).toBe(false);
    expect(isStatusBody({ version: 1, instanceId: TEST_INSTANCE_ID, expiresInMs: 5, x: 1 })).toBe(
      false,
    );
    expect(isStatusBody({ version: 2, instanceId: TEST_INSTANCE_ID, expiresInMs: 5 })).toBe(
      false,
    );
    expect(isStatusBody({ version: 1, instanceId: '', expiresInMs: 5 })).toBe(false);
    expect(isStatusBody({ version: 1, instanceId: TEST_INSTANCE_ID, expiresInMs: -1 })).toBe(
      false,
    );
    expect(isStatusBody(null)).toBe(false);
    expect(isStatusBody('status')).toBe(false);
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
