/**
 * X8-4 — the queue's Prometheus signal.
 *
 * `/metrics` carried no queue, job or dead-letter series at all, so a job that
 * exhausted its retries produced nothing an alert could act on. The counter is
 * incremented at the ONE site that settles a job, which is what makes summing
 * it over `outcome` equal the number of jobs that settled — the double-count
 * trap M45b named.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  ICounter,
  IGauge,
  IHistogram,
  IMetric,
  IMetricsService,
  ISummary,
  MetricOptions,
} from '@setu-ts/common';
import { QueueCollector } from '../../src/metrics/queue-collector.ts';
import {
  COUNTER_OPTIONS,
  JOB_NAME_LABEL,
  OUTCOME_LABEL,
  QUEUE_METRICS,
} from '../../src/metrics/metric-names.ts';

/** One recorded increment. */
interface Increment {
  readonly value: number;
  readonly labels: Record<string, string> | undefined;
}

/** A metrics service recording what was created and what was written. */
class RecordingMetrics implements IMetricsService {
  readonly created = new Map<string, MetricOptions | undefined>();
  readonly increments: Increment[] = [];
  /** When set, every `inc` throws — a backend refusing a write. */
  refuse = false;
  /** When set, every `inc` throws a non-`Error`, which a capability may do. */
  throwNonError = false;

  counter(name: string, options?: MetricOptions): ICounter {
    this.created.set(name, options);
    return {
      inc: (value?: number, labels?: Record<string, string>) => {
        if (this.throwNonError) {
          throw 'backend exploded';
        }
        if (this.refuse) {
          throw new Error('metric labels rejected');
        }
        this.increments.push({ value: value ?? 1, labels });
      },
    } as unknown as ICounter;
  }

  gauge(): IGauge {
    throw new Error('not used');
  }
  histogram(): IHistogram {
    throw new Error('not used');
  }
  summary(): ISummary {
    throw new Error('not used');
  }
  get(): IMetric | undefined {
    return undefined;
  }
}

describe('QueueCollector (X8-4)', () => {
  it('should declare the series at construction, before any job has run', () => {
    // So an operator scraping a freshly started replica sees the queue declared
    // with its # HELP and # TYPE lines rather than an empty response.
    const metrics = new RecordingMetrics();

    new QueueCollector(metrics, () => {});

    expect(metrics.created.get(QUEUE_METRICS.JOBS)).toEqual(
      COUNTER_OPTIONS[QUEUE_METRICS.JOBS],
    );
    expect(metrics.increments).toHaveLength(0);
  });

  it('should record one increment per settled job, labelled by name and outcome', () => {
    const metrics = new RecordingMetrics();
    const collector = new QueueCollector(metrics, () => {});

    collector.jobSettled('thumbnail', 'completed');
    collector.jobSettled('thumbnail', 'retried');
    collector.jobSettled('thumbnail', 'dead_lettered');

    expect(metrics.increments).toEqual([
      { value: 1, labels: { [JOB_NAME_LABEL]: 'thumbnail', [OUTCOME_LABEL]: 'completed' } },
      { value: 1, labels: { [JOB_NAME_LABEL]: 'thumbnail', [OUTCOME_LABEL]: 'retried' } },
      { value: 1, labels: { [JOB_NAME_LABEL]: 'thumbnail', [OUTCOME_LABEL]: 'dead_lettered' } },
    ]);
  });

  it('should increment by ONE rather than assigning a cumulative total', () => {
    // Writing the running total would double-count on every settle, which is
    // precisely the bug these tests exist to catch.
    const metrics = new RecordingMetrics();
    const collector = new QueueCollector(metrics, () => {});

    collector.jobSettled('a', 'completed');
    collector.jobSettled('a', 'completed');

    expect(metrics.increments.map((i) => i.value)).toEqual([1, 1]);
  });

  it('should report a refusing backend instead of letting it escape', () => {
    // `MetricBase.validateLabels` throws on an undeclared or incomplete label
    // set, and `IMetricsService` is a replaceable capability — an unguarded
    // write would take the worker loop down (the M45b review finding).
    const metrics = new RecordingMetrics();
    const errors: Error[] = [];
    const collector = new QueueCollector(metrics, (error) => errors.push(error));
    metrics.refuse = true;

    expect(() => collector.jobSettled('a', 'completed')).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('metric labels rejected');
  });
});

describe('QueueCollector — a non-Error thrown by the backend', () => {
  it('should normalize a thrown non-Error before reporting it', () => {
    // A replaceable capability can throw anything; the reporter's contract is
    // `(error: Error)`, so a bare string must not reach it unwrapped.
    const metrics = new RecordingMetrics();
    const errors: Error[] = [];
    const collector = new QueueCollector(metrics, (error) => errors.push(error));
    metrics.throwNonError = true;

    collector.jobSettled('a', 'completed');

    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]!.message).toContain('backend exploded');
  });
});
