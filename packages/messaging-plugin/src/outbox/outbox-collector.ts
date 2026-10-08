/**
 * The outbox's optional Prometheus instruments (M107 §3.11), on the M45b
 * collector pattern: built only when `CAPABILITIES.METRICS` is registered,
 * every instrument created eagerly (creation unguarded, so a name colliding
 * with another metric type fails `register()` loudly), and every WRITE guarded
 * — observing the relay must never break it.
 *
 * The `topic` label is taken only from a row that passed decode, and is
 * bounded: after {@linkcode MAX_TOPIC_LABELS} distinct values this instance
 * labels every further topic {@linkcode OTHER_TOPIC_LABEL}. A row's topic is
 * editable by anyone with write access to the outbox table (§10 D13), so an
 * unbounded label would let such a writer grow the metrics backend without
 * limit.
 *
 * Every instrument also carries an `outbox` label naming the instance's
 * capability token (`outbox` or `outbox.<name>`): the metrics service hands
 * back the SAME instrument for a name registered twice, so two named
 * messaging instances would otherwise overwrite each other's gauges.
 *
 * Internal to the plugin; not exported from the barrel.
 *
 * @module
 */
import type { ICounter, IGauge, IMetricsService, MetricOptions } from '@setu-ts/common';

import type { OutboxRelayObserver } from './relay.ts';

/** The most distinct `topic` label values one instance emits. */
export const MAX_TOPIC_LABELS = 100;

/** The `topic` label value once {@linkcode MAX_TOPIC_LABELS} is reached. */
export const OTHER_TOPIC_LABEL = 'other';

/** The `topic` label value of a poisoned row that could not be decoded. */
export const INVALID_ROW_TOPIC_LABEL = 'invalid-row';

/** The six instrument names. */
export const OUTBOX_METRICS = {
  /** Counter: rows published and marked sent. */
  PUBLISHED: 'outbox_published_total',
  /** Counter: publish failures. */
  PUBLISH_FAILURES: 'outbox_publish_failures_total',
  /** Counter: rows made `failed`. */
  POISONED: 'outbox_poisoned_total',
  /** Counter: observed overlaps, by origin. */
  OVERLAPS: 'outbox_overlaps_total',
  /** Gauge: pending rows, at the last store read. */
  PENDING: 'outbox_pending_rows',
  /** Gauge: the oldest pending row's age, at the last store read. */
  OLDEST_PENDING: 'outbox_oldest_pending_seconds',
} as const;

/** Names the outbox instance. */
const OUTBOX_LABEL = 'outbox';
/** The row's topic. */
const TOPIC_LABEL = 'topic';
/** What an overlap involved. */
const ORIGIN_LABEL = 'origin';

/** Counter names. */
type CounterName =
  | typeof OUTBOX_METRICS.PUBLISHED
  | typeof OUTBOX_METRICS.PUBLISH_FAILURES
  | typeof OUTBOX_METRICS.POISONED
  | typeof OUTBOX_METRICS.OVERLAPS;

/** Gauge names. */
type GaugeName = typeof OUTBOX_METRICS.PENDING | typeof OUTBOX_METRICS.OLDEST_PENDING;

/** Creation options per counter, keyed so a wrong lookup is a compile error. */
const COUNTER_OPTIONS: Readonly<Record<CounterName, MetricOptions>> = {
  [OUTBOX_METRICS.PUBLISHED]: {
    help: 'Outbox rows published and marked sent',
    labels: [OUTBOX_LABEL, TOPIC_LABEL],
  },
  [OUTBOX_METRICS.PUBLISH_FAILURES]: {
    help: 'Outbox publish failures',
    labels: [OUTBOX_LABEL, TOPIC_LABEL],
  },
  [OUTBOX_METRICS.POISONED]: {
    help: 'Outbox rows made failed (attempts exhausted, or undecodable)',
    labels: [OUTBOX_LABEL, TOPIC_LABEL],
  },
  [OUTBOX_METRICS.OVERLAPS]: {
    help: 'Rows another sweep had already sent, by what was involved',
    labels: [OUTBOX_LABEL, ORIGIN_LABEL],
  },
};

/** Creation options per gauge. */
const GAUGE_OPTIONS: Readonly<Record<GaugeName, MetricOptions>> = {
  [OUTBOX_METRICS.PENDING]: {
    help: 'Pending outbox rows at the last store read',
    labels: [OUTBOX_LABEL],
  },
  [OUTBOX_METRICS.OLDEST_PENDING]: {
    help: 'Age of the oldest pending outbox row at the last store read, in seconds',
    labels: [OUTBOX_LABEL],
  },
};

/**
 * Creates and updates the outbox instruments.
 *
 * @internal
 */
export class OutboxCollector implements OutboxRelayObserver {
  readonly #instance: string;
  readonly #report: (error: Error) => void;
  readonly #topics = new Set<string>();
  readonly #published: ICounter;
  readonly #failures: ICounter;
  readonly #poisoned: ICounter;
  readonly #overlaps: ICounter;
  readonly #pending: IGauge;
  readonly #oldest: IGauge;

  /**
   * @param metrics - The service resolved from `CAPABILITIES.METRICS`
   * @param instance - The outbox capability token, the `outbox` label value
   * @param report - Receives any error an instrument write throws
   */
  constructor(metrics: IMetricsService, instance: string, report: (error: Error) => void) {
    this.#instance = instance;
    this.#report = report;
    this.#published = metrics.counter(
      OUTBOX_METRICS.PUBLISHED,
      COUNTER_OPTIONS[OUTBOX_METRICS.PUBLISHED],
    );
    this.#failures = metrics.counter(
      OUTBOX_METRICS.PUBLISH_FAILURES,
      COUNTER_OPTIONS[OUTBOX_METRICS.PUBLISH_FAILURES],
    );
    this.#poisoned = metrics.counter(
      OUTBOX_METRICS.POISONED,
      COUNTER_OPTIONS[OUTBOX_METRICS.POISONED],
    );
    this.#overlaps = metrics.counter(
      OUTBOX_METRICS.OVERLAPS,
      COUNTER_OPTIONS[OUTBOX_METRICS.OVERLAPS],
    );
    this.#pending = metrics.gauge(OUTBOX_METRICS.PENDING, GAUGE_OPTIONS[OUTBOX_METRICS.PENDING]);
    this.#oldest = metrics.gauge(
      OUTBOX_METRICS.OLDEST_PENDING,
      GAUGE_OPTIONS[OUTBOX_METRICS.OLDEST_PENDING],
    );
  }

  /** @inheritdoc */
  published(topic: string): void {
    this.#guard(() => this.#published.inc(1, this.#topicLabels(topic)));
  }

  /** @inheritdoc */
  publishFailed(topic: string): void {
    this.#guard(() => this.#failures.inc(1, this.#topicLabels(topic)));
  }

  /** @inheritdoc */
  poisoned(topic: string | undefined): void {
    this.#guard(() =>
      this.#poisoned.inc(
        1,
        topic === undefined
          ? { [OUTBOX_LABEL]: this.#instance, [TOPIC_LABEL]: INVALID_ROW_TOPIC_LABEL }
          : this.#topicLabels(topic),
      )
    );
  }

  /** @inheritdoc */
  overlap(kind: 'scheduled' | 'dispatch' | 'stale'): void {
    this.#guard(() =>
      this.#overlaps.inc(1, { [OUTBOX_LABEL]: this.#instance, [ORIGIN_LABEL]: kind })
    );
  }

  /**
   * Writes the two gauges from one store read (the health indicator's).
   *
   * @param pending - Pending rows across every store
   * @param oldestPendingAgeMs - The oldest pending row's age, or `undefined`
   *   when nothing is pending (the gauge reads `0`)
   */
  syncStats(pending: number, oldestPendingAgeMs: number | undefined): void {
    this.#guard(() => {
      const labels = { [OUTBOX_LABEL]: this.#instance };
      this.#pending.set(pending, labels);
      this.#oldest.set((oldestPendingAgeMs ?? 0) / 1000, labels);
    });
  }

  /** The label set for a decoded row's topic, bounded per instance. */
  #topicLabels(topic: string): Readonly<Record<string, string>> {
    let label = topic;
    if (!this.#topics.has(topic)) {
      if (this.#topics.size < MAX_TOPIC_LABELS) this.#topics.add(topic);
      else label = OTHER_TOPIC_LABEL;
    }
    return { [OUTBOX_LABEL]: this.#instance, [TOPIC_LABEL]: label };
  }

  /**
   * Runs one instrument write, reporting rather than propagating a failure:
   * the observer is called from inside the relay, and a throwing metrics
   * backend must not end a sweep or leave a row unmarked.
   */
  #guard(write: () => void): void {
    try {
      write();
    } catch (error) {
      try {
        this.#report(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // A broken reporter is the last resort: there is nowhere left to
        // report to, and throwing here would reach the relay.
      }
    }
  }
}
