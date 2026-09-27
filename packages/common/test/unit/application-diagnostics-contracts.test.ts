/**
 * Contract tests for the M98i cache-diagnostics DTOs, declared against the
 * `@setu-ts/common` barrel so dropping an export fails `deno check`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  CacheDiagnosticsOperation,
  CacheDiagnosticsRecord,
  CacheDiagnosticsResponse,
  CacheDiagnosticsSnapshot,
  ICacheDiagnosticsSource,
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
