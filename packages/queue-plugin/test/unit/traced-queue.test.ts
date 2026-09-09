/**
 * X34-1 / X29-3 — the queue trace channel, at the decorator level.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  AddJobOptions,
  IJob,
  IQueue,
  ISpan,
  ITelemetryService,
  JobProcessor,
  ProcessOptions,
  RecurringOptions,
  SpanOptions,
} from '@setu-ts/common';
import { TRACEPARENT_HEADER } from '@setu-ts/common';

import { TracedQueue } from '../../src/tracing/traced-queue.ts';

/** Records what the decorator handed the inner queue. */
class RecordingQueue implements IQueue {
  readonly added: Array<{ name: string; data: unknown; options?: AddJobOptions }> = [];
  readonly processors = new Map<string, (job: IJob<unknown>) => void | Promise<void>>();
  readonly recurring: Array<{ name: string; options: RecurringOptions }> = [];

  add<T>(name: string, data: T, options?: AddJobOptions): Promise<string> {
    this.added.push({ name, data, ...(options === undefined ? {} : { options }) });
    return Promise.resolve('job-1');
  }
  process<T>(name: string, processor: JobProcessor<T>, _options?: ProcessOptions): void {
    this.processors.set(name, processor as (job: IJob<unknown>) => void | Promise<void>);
  }
  addRecurring<T>(name: string, _data: T, options: RecurringOptions): Promise<void> {
    this.recurring.push({ name, options });
    return Promise.resolve();
  }
}

/** A telemetry service handing out a fixed span context and recording options. */
function fakeTelemetry(
  spanContext = {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    traceFlags: '01',
  },
): { service: ITelemetryService; spans: Array<{ name: string; options?: SpanOptions }> } {
  const spans: Array<{ name: string; options?: SpanOptions }> = [];
  const span = {
    setAttribute: () => span,
    setAttributes: () => span,
    setStatus: () => {},
    recordException: () => {},
    end: () => {},
    spanContext: () => spanContext,
  } as unknown as ISpan;
  return {
    spans,
    service: {
      withSpan: <T>(name: string, fn: (s: ISpan) => Promise<T>, options?: SpanOptions) => {
        spans.push({ name, ...(options === undefined ? {} : { options }) });
        return fn(span);
      },
    },
  };
}

describe('TracedQueue', () => {
  describe('add — the producer half', () => {
    it('injects a well-formed W3C traceparent from the producer span', async () => {
      const inner = new RecordingQueue();
      const { service } = fakeTelemetry();
      await new TracedQueue(inner, service).add('orders', { id: 1 });

      const header = inner.added[0]?.options?.headers?.[TRACEPARENT_HEADER];
      expect(header).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });

    it("preserves the caller's own headers and merges the traceparent on top", async () => {
      const inner = new RecordingQueue();
      const { service } = fakeTelemetry();
      await new TracedQueue(inner, service).add('orders', { id: 1 }, {
        headers: { 'x-tenant': 't-1' },
        maxAttempts: 7,
      });

      const options = inner.added[0]?.options;
      expect(options?.headers?.['x-tenant']).toBe('t-1');
      expect(options?.headers?.[TRACEPARENT_HEADER]).toBeDefined();
      // Every other option survives the rebuild.
      expect(options?.maxAttempts).toBe(7);
    });

    it('opens a producer span named for the job', async () => {
      const inner = new RecordingQueue();
      const { service, spans } = fakeTelemetry();
      await new TracedQueue(inner, service).add('orders', {});

      expect(spans[0]?.name).toBe('enqueue orders');
      expect(spans[0]?.options?.kind).toBe('producer');
      expect(spans[0]?.options?.attributes?.['messaging.destination.name']).toBe('orders');
      expect(spans[0]?.options?.attributes?.['messaging.operation']).toBe('enqueue');
    });

    it('injects NOTHING when the span reports an empty context', async () => {
      // A noop or non-recording span reports empty identifiers, and the codec
      // then yields null. Injecting a malformed traceparent would be worse than
      // injecting none: the consumer would parent from a trace that does not
      // exist rather than starting an honest root.
      const inner = new RecordingQueue();
      const { service } = fakeTelemetry({ traceId: '', spanId: '', traceFlags: '' });
      await new TracedQueue(inner, service).add('orders', {}, { maxAttempts: 2 });

      expect(inner.added[0]?.options?.headers).toBeUndefined();
      // The caller's options still reach the queue untouched.
      expect(inner.added[0]?.options?.maxAttempts).toBe(2);
    });

    it("returns the inner queue's job id", async () => {
      const inner = new RecordingQueue();
      const { service } = fakeTelemetry();
      expect(await new TracedQueue(inner, service).add('orders', {})).toBe('job-1');
    });
  });

  describe('process — the consumer half', () => {
    it('parents the consumer span from the delivered job headers', async () => {
      const inner = new RecordingQueue();
      const { service, spans } = fakeTelemetry();
      new TracedQueue(inner, service).process('orders', () => {});

      await inner.processors.get('orders')?.({
        id: 'j-1',
        name: 'orders',
        data: {},
        attempts: 1,
        headers: {
          [TRACEPARENT_HEADER]: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      });

      expect(spans[0]?.name).toBe('process orders');
      expect(spans[0]?.options?.kind).toBe('consumer');
      expect(spans[0]?.options?.parentContext?.traceId)
        .toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(spans[0]?.options?.parentContext?.spanId).toBe('00f067aa0ba902b7');
      expect(spans[0]?.options?.attributes?.['messaging.message.id']).toBe('j-1');
    });

    it('runs a job carrying NO headers, starting an honest root', async () => {
      const inner = new RecordingQueue();
      const { service, spans } = fakeTelemetry();
      let ran = false;
      new TracedQueue(inner, service).process('orders', () => {
        ran = true;
      });

      await inner.processors.get('orders')?.(
        { id: 'j-1', name: 'orders', data: {}, attempts: 1 },
      );

      expect(ran).toBe(true);
      expect(spans[0]?.options?.parentContext?.traceId).toBeUndefined();
    });

    it('delivers the job to the wrapped processor unchanged', async () => {
      const inner = new RecordingQueue();
      const { service } = fakeTelemetry();
      let seen: IJob<{ id: number }> | undefined;
      new TracedQueue(inner, service).process<{ id: number }>('orders', (job) => {
        seen = job;
      });

      const job = { id: 'j-1', name: 'orders', data: { id: 9 }, attempts: 3 };
      await inner.processors.get('orders')?.(job);
      expect(seen).toEqual(job);
    });

    it('passes ProcessOptions through untouched', () => {
      const inner = new RecordingQueue();
      const { service } = fakeTelemetry();
      const options: ProcessOptions = { concurrency: 4 };
      let received: ProcessOptions | undefined;
      inner.process = <T>(n: string, p: JobProcessor<T>, o?: ProcessOptions) => {
        received = o;
        inner.processors.set(n, p as (job: IJob<unknown>) => void | Promise<void>);
      };
      new TracedQueue(inner, service).process('orders', () => {}, options);
      expect(received).toBe(options);
    });

    it('propagates a processor failure so retry/dead-letter still sees it', async () => {
      const inner = new RecordingQueue();
      const { service } = fakeTelemetry();
      new TracedQueue(inner, service).process('orders', () => {
        throw new Error('handler exploded');
      });

      await expect(
        inner.processors.get('orders')?.(
          { id: 'j-1', name: 'orders', data: {}, attempts: 1 },
        ),
      ).rejects.toThrow('handler exploded');
    });
  });

  describe('addRecurring', () => {
    it('is delegated untraced', async () => {
      // A recurring job fires on a schedule, so the call that registers it is
      // not the cause of any particular run; parenting future runs to it would
      // assert a causal link that does not exist.
      const inner = new RecordingQueue();
      const { service, spans } = fakeTelemetry();
      await new TracedQueue(inner, service).addRecurring('nightly', {}, { cron: '0 0 * * *' });

      expect(inner.recurring[0]?.name).toBe('nightly');
      expect(spans).toHaveLength(0);
    });
  });
});
