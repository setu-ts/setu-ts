/**
 * M98f — the queue protocol: exact validation of an UNTRUSTED queue source's
 * batch (a multi-provider contribution any installed plugin can register),
 * the field-by-field projection of the merged batch, and the one validator
 * both sides of the wire run over it.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { QueueDiagnosticsBatch } from '@setu-ts/common';
import {
  isQueueBatchProjection,
  projectQueueBatch,
  readQueueSourceBatch,
} from '../../src/protocol/queue-protocol.ts';
import { parseTarget } from '../../src/protocol/protocol.ts';
import { sourceAttempt, sourceBatch, TEST_INSTANCE_ID } from '../fixtures/helpers.ts';

const CANARY = 'canary-extra-field-SYNTHETIC';

describe('parseTarget — the queues operation', () => {
  it('accepts the canonical paged target and shares the events grammar', () => {
    expect(parseTarget('/v1/queues', 'after=0&limit=128')).toEqual({
      op: 'queues',
      canonicalTarget: '/v1/queues?after=0&limit=128',
      after: 0,
      limit: 128,
    });
    for (
      const search of [
        '',
        'limit=1&after=0',
        'after=01&limit=1',
        'after=0&limit=0',
        'after=0&limit=129',
      ]
    ) {
      expect(parseTarget('/v1/queues', search)).toBeNull();
    }
    expect(parseTarget('/v1/queues/', 'after=0&limit=1')).toBeNull();
  });
});

describe('readQueueSourceBatch', () => {
  it('copies a valid batch field by field', () => {
    const value = sourceBatch({
      attempts: [sourceAttempt(3), sourceAttempt(4)],
      depths: [{
        queueAlias: 'emails',
        ready: 1,
        processing: 0,
        dead: 2,
        scope: 'process-local',
        coverage: 'partial',
        ageMs: 7,
      }],
      next: 4,
      lost: 2,
    });
    const validated = readQueueSourceBatch(value, 0)!;
    expect(validated.instanceAlias).toBe('mailer');
    expect(validated.attempts.map((a) => a.sequence)).toEqual([3, 4]);
    expect(validated.depths[0].coverage).toBe('partial');
    expect(validated.lost).toBe(2);
  });

  it('accepts a disabled batch that carries no instance alias', () => {
    const disabled = sourceBatch({ state: 'disabled' });
    delete (disabled as unknown as Record<string, unknown>).instanceAlias;
    expect(readQueueSourceBatch(disabled, 0)!.instanceAlias).toBeNull();
  });

  const refusals: [string, (cursor: number) => unknown][] = [
    ['a non-object', () => 'batch'],
    ['an extra key', () => ({ ...sourceBatch(), [CANARY]: 1 })],
    ['a wrong version', () => sourceBatch({ version: 2 as 1 })],
    ['an unknown state', () => sourceBatch({ state: 'collection-failed' as 'ready' })],
    ['an enabled batch without an alias', () => {
      const batch = sourceBatch();
      delete (batch as unknown as Record<string, unknown>).instanceAlias;
      return batch;
    }],
    ['a disabled batch with an alias', () => sourceBatch({ state: 'disabled' })],
    ['a disabled batch with attempts', () => {
      const batch = sourceBatch({ state: 'disabled', attempts: [sourceAttempt(1)], next: 1 });
      delete (batch as unknown as Record<string, unknown>).instanceAlias;
      return batch;
    }],
    ['a disabled batch with depths', () => {
      const batch = sourceBatch({
        state: 'disabled',
        depths: [{
          queueAlias: 'emails',
          ready: 1,
          processing: 0,
          dead: 0,
          scope: 'process-local',
          coverage: 'complete',
          ageMs: 0,
        }],
      });
      delete (batch as unknown as Record<string, unknown>).instanceAlias;
      return batch;
    }],
    ['a ready batch with a null alias and an attempt', () =>
      sourceBatch({
        instanceAlias: null as unknown as string,
        attempts: [sourceAttempt(1)],
        next: 1,
      })],
    ['an oversized alias', () => sourceBatch({ instanceAlias: 'x'.repeat(65) })],
    ['a control character in an alias', () => sourceBatch({ instanceAlias: 'a\u001b[2Jb' })],
    ['an unknown coverage', () => sourceBatch({ depthCoverage: 'full' as 'complete' })],
    ['the connector-only failure', () => sourceBatch({ failure: 'source-read-failed' as 'none' })],
    ['too many attempts', () =>
      sourceBatch({
        attempts: Array.from({ length: 129 }, (_, i) => sourceAttempt(i + 1)),
        next: 129,
      })],
    [
      'a non-increasing sequence',
      () => sourceBatch({ attempts: [sourceAttempt(2), sourceAttempt(2)], next: 2, lost: 1 }),
    ],
    [
      'a sequence at or before the cursor',
      () => sourceBatch({ attempts: [sourceAttempt(5)], next: 5 }),
    ],
    ['a next that disagrees', () => sourceBatch({ attempts: [sourceAttempt(1)], next: 9 })],
    [
      'a lost that disagrees',
      () => sourceBatch({ attempts: [sourceAttempt(3)], next: 3, lost: 0 }),
    ],
    ['a non-zero lost on an empty page', () => sourceBatch({ lost: 1 })],
    ['an empty page that moves the cursor', () => sourceBatch({ next: 3 })],
    ['an attempt with an extra field', () =>
      sourceBatch({
        attempts: [{ ...sourceAttempt(1), payload: CANARY } as never],
        next: 1,
      })],
    ['an attempt with a raw-looking job alias', () =>
      sourceBatch({
        attempts: [{ ...sourceAttempt(1), jobAlias: 'raw-uuid' }],
        next: 1,
      })],
    ['an unknown settlement', () =>
      sourceBatch({
        attempts: [{ ...sourceAttempt(1), settlement: 'maybe' as 'unknown' }],
        next: 1,
      })],
    [
      'a negative duration',
      () => sourceBatch({ attempts: [{ ...sourceAttempt(1), durationMs: -1 }], next: 1 }),
    ],
    [
      'a non-integer attempt',
      () => sourceBatch({ attempts: [{ ...sourceAttempt(1), attempt: 0 }], next: 1 }),
    ],
    ['a negative depth count', () =>
      sourceBatch({
        depths: [{
          queueAlias: 'e',
          ready: -1,
          processing: 0,
          dead: 0,
          scope: 'process-local',
          coverage: 'complete',
          ageMs: 0,
        }],
      })],
    ['a depth with an extra field', () =>
      sourceBatch({
        depths: [{
          queueAlias: 'e',
          ready: 1,
          processing: 0,
          dead: 0,
          scope: 'process-local',
          coverage: 'complete',
          ageMs: 0,
          secret: CANARY,
        } as never],
      })],
    ['too many depths', () =>
      sourceBatch({
        depths: Array.from({ length: 65 }, () => ({
          queueAlias: 'e',
          ready: 0,
          processing: 0,
          dead: 0,
          scope: 'process-local' as const,
          coverage: 'complete' as const,
          ageMs: 0,
        })),
      })],
    ['a non-boolean closed', () => sourceBatch({ closed: 'no' as unknown as boolean })],
    ['a fractional counter', () => sourceBatch({ droppedAttempts: 0.5 })],
    ['a throwing getter', () => {
      const batch = sourceBatch();
      Object.defineProperty(batch, 'attempts', {
        enumerable: true,
        get() {
          throw new Error(CANARY);
        },
      });
      return batch;
    }],
  ];

  for (const [label, build] of refusals) {
    it(`refuses ${label}`, () => {
      const cursor = label.includes('before the cursor') ? 5 : 0;
      expect(readQueueSourceBatch(build(cursor), cursor)).toBeNull();
    });
  }
});

/** A valid merged batch. */
function mergedBatch(overrides: Partial<QueueDiagnosticsBatch> = {}): QueueDiagnosticsBatch {
  return {
    version: 1,
    instanceId: TEST_INSTANCE_ID,
    state: 'ready',
    sources: [{
      sourceId: 'q1',
      state: 'ready',
      instanceAlias: 'mailer',
      depthCoverage: 'complete',
      failure: 'none',
      lost: 0,
      droppedAttempts: 0,
      evictedJobAliases: 0,
    }],
    events: [{
      sequence: 1,
      sourceId: 'q1',
      instanceAlias: 'mailer',
      queueAlias: 'emails',
      jobAlias: 'j1',
      attempt: 1,
      durationMs: 3,
      outcome: 'completed',
      settlement: 'acknowledged',
      ageMs: 4,
    }],
    depths: [{
      sourceId: 'q1',
      instanceAlias: 'mailer',
      queueAlias: 'emails',
      ready: 0,
      processing: 0,
      dead: 0,
      scope: 'process-local',
      coverage: 'complete',
      ageMs: 1,
    }],
    next: 1,
    lost: 0,
    truncatedSources: 0,
    truncatedDepths: 0,
    ...overrides,
  };
}

describe('projectQueueBatch + isQueueBatchProjection', () => {
  it('projects exactly the DTO fields, dropping any extra', () => {
    const hostile = mergedBatch();
    (hostile as unknown as Record<string, unknown>)[CANARY] = CANARY;
    (hostile.events[0] as unknown as Record<string, unknown>).payload = CANARY;
    (hostile.sources[0] as unknown as Record<string, unknown>).token = CANARY;
    (hostile.depths[0] as unknown as Record<string, unknown>).url = CANARY;
    const projected = projectQueueBatch(hostile);
    expect(JSON.stringify(projected)).not.toContain(CANARY);
    expect(projected).toEqual(projectQueueBatch(mergedBatch()));
    expect(isQueueBatchProjection(projected)).toBe(true);
  });

  it('accepts the unsupported batch and a disabled source without an alias', () => {
    expect(isQueueBatchProjection(mergedBatch({
      state: 'unsupported',
      sources: [],
      events: [],
      depths: [],
      next: 0,
    }))).toBe(true);
    const disabled = mergedBatch({ events: [], depths: [], next: 0 });
    const status = { ...disabled.sources[0], state: 'disabled' as const };
    delete (status as unknown as Record<string, unknown>).instanceAlias;
    expect(isQueueBatchProjection({ ...disabled, sources: [status] })).toBe(true);
  });

  const invalid: [string, () => unknown][] = [
    ['a non-object', () => []],
    ['an extra key', () => ({ ...mergedBatch(), extra: 1 })],
    ['an empty instance', () => mergedBatch({ instanceId: '' })],
    ['an unsupported batch with sources', () => mergedBatch({ state: 'unsupported' })],
    ['a ready batch with no sources', () => mergedBatch({ sources: [], events: [], depths: [] })],
    [
      'a duplicate source id',
      () => mergedBatch({ sources: [mergedBatch().sources[0], mergedBatch().sources[0]] }),
    ],
    [
      'a non-q source id',
      () => mergedBatch({ sources: [{ ...mergedBatch().sources[0], sourceId: 'queue.a' }] }),
    ],
    ['a source id beyond q16', () =>
      mergedBatch({
        sources: [{ ...mergedBatch().sources[0], sourceId: 'q17' }],
        events: [],
        depths: [],
      })],
    [
      'an event naming no listed source',
      () => mergedBatch({ events: [{ ...mergedBatch().events[0], sourceId: 'q2' }] }),
    ],
    [
      'a depth naming no listed source',
      () => mergedBatch({ depths: [{ ...mergedBatch().depths[0], sourceId: 'q2' }] }),
    ],
    [
      'non-increasing event sequences',
      () => mergedBatch({ events: [mergedBatch().events[0], mergedBatch().events[0]] }),
    ],
    ['a next that is not the last event', () => mergedBatch({ next: 7 })],
    [
      'a control character in an event alias',
      () => mergedBatch({ events: [{ ...mergedBatch().events[0], queueAlias: 'a\nb' }] }),
    ],
    [
      'an unknown source state',
      () => mergedBatch({ sources: [{ ...mergedBatch().sources[0], state: 'fine' as 'ready' }] }),
    ],
    ['a fractional truncation count', () => mergedBatch({ truncatedDepths: 0.5 })],
    ['more than 128 events', () =>
      mergedBatch({
        events: Array.from(
          { length: 129 },
          (_, i) => ({ ...mergedBatch().events[0], sequence: i + 1 }),
        ),
        next: 129,
      })],
    [
      'an invalid depth scope',
      () =>
        mergedBatch({
          depths: [{ ...mergedBatch().depths[0], scope: 'cluster' as 'process-local' }],
        }),
    ],
  ];
  for (const [label, build] of invalid) {
    it(`refuses ${label}`, () => {
      expect(isQueueBatchProjection(build())).toBe(false);
    });
  }
});
