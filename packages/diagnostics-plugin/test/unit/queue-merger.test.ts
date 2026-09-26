/**
 * M98f — the connector's queue merger: registration-order merging, the M98a
 * cursor contract over the merge ring, the two-ring loss accounting that keeps
 * a contiguous merge sequence from reading as complete coverage, isolated
 * source failures, the 16-source bound and the frame budget.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IQueueDiagnosticsSource, QueueDiagnosticsSourceBatch } from '@setu-ts/common';
import {
  fitFrameBudget,
  MAX_MERGED_ATTEMPTS,
  QueueObservationMerger,
} from '../../src/transport/queue-merger.ts';
import { isQueueBatchProjection, projectQueueBatch } from '../../src/protocol/queue-protocol.ts';
import {
  MutableClock,
  ScriptedQueueSource,
  sourceBatch,
  TEST_INSTANCE_ID,
} from '../fixtures/helpers.ts';

function merge(sources: IQueueDiagnosticsSource[], clock = new MutableClock()) {
  return { merger: new QueueObservationMerger(sources, clock), clock };
}

describe('QueueObservationMerger', () => {
  it('answers unsupported, with no sources, when none is registered', () => {
    const { merger } = merge([]);
    const batch = merger.read(TEST_INSTANCE_ID, 0, 128)!;
    expect(batch.state).toBe('unsupported');
    expect(batch.sources).toEqual([]);
    expect(batch.next).toBe(0);
    expect(isQueueBatchProjection(projectQueueBatch(batch))).toBe(true);
  });

  it('merges in registration order behind opaque q<N> ids, one status per source', () => {
    const a = new ScriptedQueueSource(1_024, 'alpha');
    const b = new ScriptedQueueSource(1_024, 'beta');
    a.produce(2);
    b.produce(1);
    const { merger } = merge([a, b]);
    const batch = merger.read(TEST_INSTANCE_ID, 0, 128)!;
    expect(batch.sources.map((s) => [s.sourceId, s.instanceAlias])).toEqual([
      ['q1', 'alpha'],
      ['q2', 'beta'],
    ]);
    expect(batch.events.map((e) => [e.sequence, e.sourceId])).toEqual([
      [1, 'q1'],
      [2, 'q1'],
      [3, 'q2'],
    ]);
    expect(batch.depths.map((d) => d.sourceId)).toEqual(['q1', 'q2']);
    expect(isQueueBatchProjection(projectQueueBatch(batch))).toBe(true);
  });

  it('drains only NEW source attempts on each read', () => {
    const a = new ScriptedQueueSource();
    a.produce(3);
    const { merger } = merge([a]);
    expect(merger.read(TEST_INSTANCE_ID, 0, 128)!.next).toBe(3);
    a.produce(2);
    const second = merger.read(TEST_INSTANCE_ID, 3, 128)!;
    expect(second.events.map((e) => e.sequence)).toEqual([4, 5]);
    expect(second.events.map((e) => e.jobAlias)).toEqual(['j4', 'j5']);
  });

  it('recomputes ageMs from the drain anchor at every read', () => {
    const a = new ScriptedQueueSource();
    a.produce(1);
    const { merger, clock } = merge([a]);
    expect(merger.read(TEST_INSTANCE_ID, 0, 128)!.events[0].ageMs).toBe(10);
    clock.advance(500);
    const later = merger.read(TEST_INSTANCE_ID, 0, 128)!;
    expect(later.events[0].ageMs).toBe(510);
    expect(later.depths[0].ageMs).toBe(5);
  });

  it('pages the merge ring with the M98a contract: exact loss, no duplicates, echoed cursor', () => {
    const a = new ScriptedQueueSource();
    const b = new ScriptedQueueSource();
    const { merger } = merge([a, b]);
    // Overflow the 1,024-event merge ring through two sources and several
    // drains, then resume from a PRE-overflow cursor.
    for (let round = 0; round < 4; round++) {
      a.produce(200);
      b.produce(200);
      merger.read(TEST_INSTANCE_ID, 0, 1);
    }
    const resumed = merger.read(TEST_INSTANCE_ID, 5, 128)!;
    const first = resumed.events[0].sequence;
    expect(first).toBe(1_600 - MAX_MERGED_ATTEMPTS + 1);
    expect(resumed.lost).toBe(first - 5 - 1);
    const sequences = resumed.events.map((e) => e.sequence);
    expect(sequences).toEqual(sequences.map((_, i) => first + i));
    // after: 0 is NOT special-cased on an evicted ring.
    expect(merger.read(TEST_INSTANCE_ID, 0, 1)!.lost).toBe(first - 1);
    // Successive pages never repeat a sequence.
    const next = merger.read(TEST_INSTANCE_ID, resumed.next, 128)!;
    expect(next.events[0].sequence).toBe(resumed.next + 1);
    expect(next.lost).toBe(0);
    // An empty page echoes its cursor; a cursor beyond the sequence refuses.
    const empty = merger.read(TEST_INSTANCE_ID, 1_600, 128)!;
    expect(empty.events).toEqual([]);
    expect(empty.next).toBe(1_600);
    expect(empty.lost).toBe(0);
    expect(merger.read(TEST_INSTANCE_ID, 1_601, 128)).toBeNull();
  });

  it('reports a SOURCE ring that wrapped between reads on that source, not in the batch lost', () => {
    const busy = new ScriptedQueueSource(100);
    const quiet = new ScriptedQueueSource(100);
    const { merger } = merge([busy, quiet]);
    busy.produce(10);
    merger.read(TEST_INSTANCE_ID, 0, 128);
    // The busy source outruns the poller: 250 more attempts into a 100-slot
    // ring, so 150 are gone before the connector reads again.
    busy.produce(250);
    quiet.produce(1);
    const batch = merger.read(TEST_INSTANCE_ID, 10, 128)!;
    // The merge sequence is contiguous and its own lost is zero...
    expect(batch.lost).toBe(0);
    const sequences = batch.events.map((e) => e.sequence);
    expect(sequences).toEqual(sequences.map((_, i) => 11 + i));
    // ...while the loss surfaces on the source that dropped it.
    expect(batch.sources[0].lost).toBe(150);
    expect(batch.sources[1].lost).toBe(0);
  });

  it('isolates a throwing or invalid source as collection-failed without merging it', () => {
    const good = new ScriptedQueueSource();
    good.produce(1);
    const throwing: IQueueDiagnosticsSource = {
      read(): never {
        throw new Error('canary-source-error-SYNTHETIC');
      },
    };
    const invalid: IQueueDiagnosticsSource = {
      read: () => ({ ...sourceBatch(), secret: 'x' }) as unknown as QueueDiagnosticsSourceBatch,
    };
    const { merger } = merge([throwing, good, invalid]);
    const batch = merger.read(TEST_INSTANCE_ID, 0, 128)!;
    expect(batch.sources.map((s) => [s.sourceId, s.state, s.failure])).toEqual([
      ['q1', 'collection-failed', 'source-read-failed'],
      ['q2', 'ready', 'none'],
      ['q3', 'collection-failed', 'source-read-failed'],
    ]);
    expect('instanceAlias' in batch.sources[0]).toBe(false);
    expect(batch.events.map((e) => e.sourceId)).toEqual(['q2']);
    expect(JSON.stringify(batch)).not.toContain('canary-source-error-SYNTHETIC');
    expect(isQueueBatchProjection(projectQueueBatch(batch))).toBe(true);
  });

  it('keeps a disabled source visible, with no events or depths', () => {
    const disabled: IQueueDiagnosticsSource = {
      read: (after: number) => {
        const batch = sourceBatch({ state: 'disabled', depthCoverage: 'disabled', next: after });
        delete (batch as unknown as Record<string, unknown>).instanceAlias;
        return batch;
      },
    };
    const batch = merge([disabled]).merger.read(TEST_INSTANCE_ID, 0, 128)!;
    expect(batch.sources[0].state).toBe('disabled');
    expect(batch.depths).toEqual([]);
  });

  it('stops draining a closed source after its closed batch', () => {
    let reads = 0;
    const closed: IQueueDiagnosticsSource = {
      read: (after: number) => {
        reads += 1;
        return sourceBatch({ closed: true, state: 'no-data', next: after });
      },
    };
    merge([closed]).merger.read(TEST_INSTANCE_ID, 0, 128);
    expect(reads).toBe(1);
  });

  it('bounds one drain even against a source that keeps producing', () => {
    const endless = new ScriptedQueueSource();
    endless.produce(1_024);
    const { merger } = merge([endless]);
    merger.read(TEST_INSTANCE_ID, 0, 1);
    expect(endless.reads).toBeLessThanOrEqual(1_024 / 128 + 1);
  });

  it('discards everything retained on close and stops draining', () => {
    const source = new ScriptedQueueSource();
    source.produce(3);
    const { merger } = merge([source]);
    expect(merger.read(TEST_INSTANCE_ID, 0, 128)!.events.length).toBe(3);
    merger.close();
    merger.close();
    source.produce(2);
    const reads = source.reads;
    const after = merger.read(TEST_INSTANCE_ID, 0, 128)!;
    expect(after.events).toEqual([]);
    expect(after.depths).toEqual([]);
    expect(source.reads).toBe(reads);
  });

  it('reads at most 16 sources and counts the rest as truncated', () => {
    const all = Array.from({ length: 18 }, () => new ScriptedQueueSource());
    const batch = merge(all).merger.read(TEST_INSTANCE_ID, 0, 128)!;
    expect(batch.sources.length).toBe(16);
    expect(batch.truncatedSources).toBe(2);
    expect(all[16].reads).toBe(0);
    expect(all[17].reads).toBe(0);
  });
});

describe('fitFrameBudget', () => {
  it('trims depths from the tail to fit 256 KiB, counting them, and keeps every event', () => {
    const alias = (seed: string) => seed.padEnd(64, 'x');
    const sources = Array.from({ length: 16 }, (_, s): IQueueDiagnosticsSource => {
      const scripted = new ScriptedQueueSource(1_024, alias(`inst-${s}-`));
      scripted.produce(8);
      return {
        read: (after: number, limit?: number) => {
          const batch = scripted.read(after, limit);
          return {
            ...batch,
            depths: Array.from({ length: 64 }, (_, q) => ({
              queueAlias: alias(`queue-${q}-`),
              ready: Number.MAX_SAFE_INTEGER,
              processing: Number.MAX_SAFE_INTEGER,
              dead: Number.MAX_SAFE_INTEGER,
              scope: 'shared-backend' as const,
              coverage: 'partial' as const,
              ageMs: 123_456.789,
            })),
          };
        },
      };
    });
    const batch = merge(sources).merger.read(TEST_INSTANCE_ID, 0, 128)!;
    const bytes = new TextEncoder().encode(JSON.stringify(projectQueueBatch(batch))).length;
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
    expect(batch.truncatedDepths).toBeGreaterThan(0);
    expect(batch.depths.length + batch.truncatedDepths).toBe(16 * 64);
    expect(batch.events.length).toBe(128);
    expect(isQueueBatchProjection(projectQueueBatch(batch))).toBe(true);

    // With every depth removed the worst-case frame is far inside the budget,
    // which is why depths are the ONLY member ever trimmed.
    const noDepths = { ...batch, depths: [] };
    expect(new TextEncoder().encode(JSON.stringify(noDepths)).length).toBeLessThan(70 * 1024);
  });

  it('returns a batch that already fits unchanged', () => {
    const scripted = new ScriptedQueueSource();
    scripted.produce(3);
    const batch = merge([scripted]).merger.read(TEST_INSTANCE_ID, 0, 128)!;
    expect(fitFrameBudget(batch)).toBe(batch);
  });
});
