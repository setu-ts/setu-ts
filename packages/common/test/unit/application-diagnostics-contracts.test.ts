/**
 * Contract tests for the M98i cache-diagnostics and M98k scheduler-diagnostics
 * DTOs, declared against the `@setu-ts/common` barrel so dropping an export
 * fails `deno check`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  CacheDiagnosticsOperation,
  CacheDiagnosticsRecord,
  CacheDiagnosticsResponse,
  CacheDiagnosticsSnapshot,
  ICacheDiagnosticsSource,
  ISchedulerDiagnosticsSource,
  IStorageDiagnosticsSource,
  SchedulerDiagnosticsOperation,
  SchedulerDiagnosticsRecord,
  SchedulerDiagnosticsResponse,
  SchedulerDiagnosticsSnapshot,
  StorageDiagnosticsOperation,
  StorageDiagnosticsRecord,
  StorageDiagnosticsResponse,
  StorageDiagnosticsSnapshot,
} from '../../src/index.ts';
import { CAPABILITIES } from '../../src/index.ts';

const RECORD: CacheDiagnosticsRecord = {
  alias: 'primary',
  operation: 'get',
  count: 1,
  lastDurationMs: null,
  ageMs: 0,
  succeeded: 1,
  failed: 0,
  hits: 0,
  misses: 1,
  present: 0,
  absent: 0,
  removed: 0,
  notRemoved: 0,
};

describe('cache diagnostics contracts (M98i)', () => {
  it('types a source, snapshot and response with exactly the documented fields', () => {
    const snapshot: CacheDiagnosticsSnapshot = {
      state: 'ready',
      alias: 'primary',
      coverage: 'owned-instance',
      records: [RECORD],
      dropped: 0,
    };
    const source: ICacheDiagnosticsSource = { snapshot: () => snapshot };
    const response: CacheDiagnosticsResponse = {
      version: 1,
      instanceId: 'id',
      state: 'ready',
      sources: [{ sourceId: 's1', snapshot: source.snapshot() }],
    };
    expect(response.sources[0]!.snapshot.records[0]).toEqual(RECORD);
    expect(Object.keys(RECORD).length).toBe(13);
    expect(CAPABILITIES.CACHE_DIAGNOSTICS).toBe('cache-diagnostics');
  });

  it('admits only the five fixed operations and no eviction', () => {
    const operations: CacheDiagnosticsOperation[] = ['get', 'set', 'delete', 'has', 'clear'];
    // @ts-expect-error — no eviction operation exists
    const evict: CacheDiagnosticsOperation = 'evict';
    void evict;
    expect(operations.length).toBe(5);
    // @ts-expect-error — coverage is always owned-instance
    const wide: CacheDiagnosticsSnapshot['coverage'] = 'all';
    void wide;
  });
});

describe('scheduler diagnostics contracts (M98k)', () => {
  const RECORD: SchedulerDiagnosticsRecord = {
    alias: 'tick-alias',
    operation: 'fire',
    count: 1,
    lastDurationMs: null,
    ageMs: 0,
    started: 1,
    succeeded: 1,
    failed: 0,
    contended: 0,
    lockFailed: 0,
    retryAttempts: 0,
    lastLatenessMs: 3,
  };

  it('types a source, snapshot and response with exactly the documented fields', () => {
    const snapshot: SchedulerDiagnosticsSnapshot = {
      state: 'ready',
      alias: 'cron',
      coverage: 'owned-instance',
      records: [RECORD],
      dropped: 0,
    };
    const source: ISchedulerDiagnosticsSource = { snapshot: () => snapshot };
    const response: SchedulerDiagnosticsResponse = {
      version: 1,
      instanceId: 'id',
      state: 'ready',
      sources: [{ sourceId: 's1', snapshot: source.snapshot() }],
    };
    expect(response.sources[0]!.snapshot.records[0]).toEqual(RECORD);
    expect(Object.keys(RECORD).length).toBe(12);
    expect(Object.keys(snapshot).length).toBe(5);
    expect(Object.keys(response).length).toBe(4);
    expect(CAPABILITIES.SCHEDULER_DIAGNOSTICS).toBe('scheduler-diagnostics');
  });

  it('admits only the two fixed operations and no missed counter', () => {
    const operations: SchedulerDiagnosticsOperation[] = ['fire', 'attempt'];
    // @ts-expect-error — a skipped local fire is not a missed execution
    const missed: SchedulerDiagnosticsOperation = 'missed';
    void missed;
    expect(operations.length).toBe(2);
    // @ts-expect-error — coverage is always owned-instance
    const wide: SchedulerDiagnosticsSnapshot['coverage'] = 'cluster';
    void wide;
  });
});

const STORAGE_RECORD: StorageDiagnosticsRecord = {
  alias: 'primary',
  operation: 'put',
  count: 1,
  lastDurationMs: 2,
  ageMs: 0,
  succeeded: 1,
  failed: 0,
  lastBytes: 3,
};

describe('storage diagnostics contracts (M98m)', () => {
  it('types a source, snapshot and response with exactly the documented fields', () => {
    const snapshot: StorageDiagnosticsSnapshot = {
      state: 'ready',
      alias: 'primary',
      coverage: 'owned-instance',
      records: [STORAGE_RECORD],
      dropped: 0,
    };
    const source: IStorageDiagnosticsSource = { snapshot: () => snapshot };
    const response: StorageDiagnosticsResponse = {
      version: 1,
      instanceId: 'id',
      state: 'ready',
      sources: [{ sourceId: 's1', snapshot: source.snapshot() }],
    };
    expect(response.sources[0]!.snapshot.records[0]).toEqual(STORAGE_RECORD);
    expect(Object.keys(STORAGE_RECORD).length).toBe(8);
    expect(CAPABILITIES.STORAGE_DIAGNOSTICS).toBe('storage-diagnostics');
  });

  it('admits only the six fixed operations and no eviction', () => {
    const operations: StorageDiagnosticsOperation[] = [
      'put',
      'get',
      'delete',
      'exists',
      'getSignedUrl',
      'getStream',
    ];
    // @ts-expect-error — no list operation exists
    const list: StorageDiagnosticsOperation = 'list';
    void list;
    expect(operations.length).toBe(6);
    // @ts-expect-error — coverage is always owned-instance
    const wide: StorageDiagnosticsSnapshot['coverage'] = 'all';
    void wide;
  });
});
