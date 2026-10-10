/**
 * The optional outbox metrics (M107 §3.11, the M45b collector pattern): the
 * six instruments created eagerly against the REAL metrics service, the
 * `topic` label bounded at 100 distinct values per instance, and every write
 * guarded so a throwing metrics backend never reaches the relay.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ICounter, IGauge, IMetricsService } from '@setu-ts/common';
import { MetricsService } from '@setu-ts/metrics-plugin';

import {
  INVALID_ROW_TOPIC_LABEL,
  MAX_TOPIC_LABELS,
  OTHER_TOPIC_LABEL,
  OUTBOX_METRICS,
  OutboxCollector,
} from '../../../src/outbox/outbox-collector.ts';
import { outboxHarness } from '../../fixtures/outbox.ts';

/** A metrics service recording every instrument write. */
function recordingMetrics(): IMetricsService & {
  readonly writes: { name: string; value: number; labels: Record<string, string> }[];
  readonly created: string[];
  fail: boolean;
} {
  const writes: { name: string; value: number; labels: Record<string, string> }[] = [];
  const created: string[] = [];
  const state = { fail: false };
  const instrument = (name: string) => {
    created.push(name);
    const write = (value = 1, labels: Readonly<Record<string, string>> = {}) => {
      if (state.fail) throw new Error('metrics backend refused');
      writes.push({ name, value, labels: { ...labels } });
    };
    return { inc: write, set: write, dec: write, observe: write } as unknown as
      & ICounter
      & IGauge;
  };
  return Object.assign(state, {
    writes,
    created,
    counter: instrument,
    gauge: instrument,
    histogram: () => {
      throw new Error('not used');
    },
    summary: () => {
      throw new Error('not used');
    },
    render: () => '',
  }) as unknown as ReturnType<typeof recordingMetrics>;
}

describe('outbox metrics collector', () => {
  it('creates all six instruments eagerly, declared on the real metrics service', () => {
    const metrics = new MetricsService();
    new OutboxCollector(metrics, 'outbox', () => {});
    const text = metrics.render();
    for (const name of Object.values(OUTBOX_METRICS)) {
      expect(text).toContain(`# TYPE ${name}`);
    }
  });

  it('labels each counter with the instance and the decoded topic', () => {
    const metrics = recordingMetrics();
    const collector = new OutboxCollector(metrics, 'outbox.billing', () => {});
    collector.published('orders.v1');
    collector.publishFailed('orders.v1');
    collector.poisoned('orders.v1');
    collector.poisoned(undefined);
    collector.overlap('claim-lost');
    collector.syncStats(7, 2_500);
    collector.syncStats(0, undefined);
    expect(metrics.writes).toEqual([
      {
        name: OUTBOX_METRICS.PUBLISHED,
        value: 1,
        labels: { outbox: 'outbox.billing', topic: 'orders.v1' },
      },
      {
        name: OUTBOX_METRICS.PUBLISH_FAILURES,
        value: 1,
        labels: { outbox: 'outbox.billing', topic: 'orders.v1' },
      },
      {
        name: OUTBOX_METRICS.POISONED,
        value: 1,
        labels: { outbox: 'outbox.billing', topic: 'orders.v1' },
      },
      {
        name: OUTBOX_METRICS.POISONED,
        value: 1,
        labels: { outbox: 'outbox.billing', topic: INVALID_ROW_TOPIC_LABEL },
      },
      {
        name: OUTBOX_METRICS.OVERLAPS,
        value: 1,
        labels: { outbox: 'outbox.billing', kind: 'claim-lost' },
      },
      { name: OUTBOX_METRICS.PENDING, value: 7, labels: { outbox: 'outbox.billing' } },
      { name: OUTBOX_METRICS.OLDEST_PENDING, value: 2.5, labels: { outbox: 'outbox.billing' } },
      { name: OUTBOX_METRICS.PENDING, value: 0, labels: { outbox: 'outbox.billing' } },
      { name: OUTBOX_METRICS.OLDEST_PENDING, value: 0, labels: { outbox: 'outbox.billing' } },
    ]);
  });

  it('caps the topic label at 100 distinct values, then labels other', () => {
    const metrics = recordingMetrics();
    const collector = new OutboxCollector(metrics, 'outbox', () => {});
    for (let n = 0; n < MAX_TOPIC_LABELS + 5; n++) collector.published(`t${n}.v1`);
    // A topic seen before the cap keeps its own label afterwards.
    collector.published('t0.v1');
    const topics = metrics.writes.map((w) => w.labels.topic);
    expect(new Set(topics).size).toBe(MAX_TOPIC_LABELS + 1);
    expect(topics.slice(MAX_TOPIC_LABELS, MAX_TOPIC_LABELS + 5)).toEqual(
      Array(5).fill(OTHER_TOPIC_LABEL),
    );
    expect(topics.at(-1)).toBe('t0.v1');
    // The cap is shared across instruments: a new topic on another counter is other too.
    collector.publishFailed('brand-new.v1');
    expect(metrics.writes.at(-1)!.labels.topic).toBe(OTHER_TOPIC_LABEL);
  });

  it('reports a throwing write instead of throwing, and survives a throwing reporter', () => {
    const metrics = recordingMetrics();
    const reported: string[] = [];
    const collector = new OutboxCollector(metrics, 'outbox', (e) => reported.push(e.message));
    metrics.fail = true;
    expect(() => collector.published('orders.v1')).not.toThrow();
    expect(() => collector.overlap('duplicate')).not.toThrow();
    expect(() => collector.syncStats(1, 1)).not.toThrow();
    expect(reported).toEqual(Array(3).fill('metrics backend refused'));
    const silent = new OutboxCollector(metrics, 'outbox', () => {
      throw new Error('reporter broke');
    });
    expect(() => silent.poisoned(undefined)).not.toThrow();
  });

  it('a throwing metrics backend never ends a sweep or leaves a row unmarked', async () => {
    const metrics = recordingMetrics();
    metrics.fail = true;
    const reported: string[] = [];
    const collector = new OutboxCollector(metrics, 'outbox', (e) => reported.push(e.message));
    const h = await outboxHarness({ observer: collector });
    await h.write({ n: 1 });
    await h.write({ n: 2 });
    const result = await h.sweep();
    expect(result.published).toBe(2);
    expect(result.endedBy).toBe('complete');
    expect(h.broker.sequence()).toEqual([1, 2]);
    expect(reported.length).toBe(2);
  });
});
