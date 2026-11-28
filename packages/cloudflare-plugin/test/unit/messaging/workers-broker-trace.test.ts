import { WorkersResponse } from '../../../../../test/node-helpers.ts';
import { afterAll, beforeAll } from 'vitest';
const nativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = WorkersResponse;
});
afterAll(() => {
  globalThis.Response = nativeResponse;
});
/**
 * A trace crosses Workers messaging (V13-210): a producer span's
 * `traceparent` rides the envelope's framework `trace` field and the consumer
 * span is parented from it.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import type { ISpan, ITelemetryService, SpanOptions } from '@setu-ts/common';

import { WorkersBroker } from '../../../src/messaging/workers-broker.ts';
import { FakeQueueBatch, FakeQueueMessage, FakeQueueProducer } from '../../fakes.ts';
import { FakeDurableObjectNamespace } from '../../do-fakes.ts';
import { FakeBrokerRuntime } from '../../messaging-fakes.ts';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

/** Records every span: its name, options, and a fixed span context. */
class RecordingTelemetry implements ITelemetryService {
  readonly spans: { readonly name: string; readonly options: SpanOptions | undefined }[] = [];

  withSpan<T>(name: string, fn: (span: ISpan) => Promise<T>, options?: SpanOptions): Promise<T> {
    this.spans.push({ name, options });
    const span = {
      setAttribute: () => span,
      setAttributes: () => span,
      setStatus: () => {},
      recordException: () => {},
      end: () => {},
      spanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: '01' }),
    } as unknown as ISpan;
    return fn(span);
  }
}

const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

describe('WorkersBroker trace propagation', () => {
  it('writes the producer span traceparent into the envelope, never into the caller headers', async () => {
    const producer = new FakeQueueProducer();
    const telemetry = new RecordingTelemetry();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime(), {
      telemetry: () => telemetry,
    });

    await broker.publish('orders', { n: 1 }, { headers: { tenant: 'acme' } });

    expect(producer.sends[0]?.body).toMatchObject({
      trace: TRACEPARENT,
      headers: { tenant: 'acme' },
    });
    expect(telemetry.spans[0]).toMatchObject({
      name: 'publish orders',
      options: {
        kind: 'producer',
        attributes: {
          'messaging.system': 'cloudflare_queues',
          'messaging.destination.name': 'orders',
          'messaging.operation': 'publish',
        },
      },
    });
  });

  it('writes no trace field without telemetry, or when the thunk answers undefined', async () => {
    for (const options of [{}, { telemetry: () => undefined }]) {
      const producer = new FakeQueueProducer();
      const broker = new WorkersBroker(producer, new FakeBrokerRuntime(), options);
      await broker.publish('t', 1);
      expect(producer.sends[0]?.body).not.toHaveProperty('trace');
    }
  });

  it('runs a subscriber inside a consumer span parented from the envelope', async () => {
    const telemetry = new RecordingTelemetry();
    const broker = new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime(), {
      telemetry: () => telemetry,
    });
    const seen: unknown[] = [];
    await broker.subscribe('orders', (payload) => {
      seen.push(payload);
    });

    await broker.dispatch(
      new FakeQueueBatch('q', [
        new FakeQueueMessage('m1', {
          v: 1,
          kind: 'msg',
          topic: 'orders',
          id: 'id-7',
          payload: { n: 1 },
          trace: TRACEPARENT,
        }),
      ]),
    );

    expect(seen).toEqual([{ n: 1 }]);
    expect(telemetry.spans[0]?.name).toBe('receive orders');
    expect(telemetry.spans[0]?.options).toMatchObject({
      kind: 'consumer',
      attributes: { 'messaging.message.id': 'id-7', 'messaging.operation': 'receive' },
      parentContext: { traceId: TRACE_ID, spanId: SPAN_ID },
    });
  });

  it('delivers an envelope with a malformed or missing trace under a root span', async () => {
    const telemetry = new RecordingTelemetry();
    const broker = new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime(), {
      telemetry: () => telemetry,
    });
    const seen: unknown[] = [];
    await broker.subscribe('t', (payload) => {
      seen.push(payload);
    });
    const envelope = { v: 1, kind: 'msg', topic: 't', id: 'i', payload: 1 };

    await broker.dispatch(
      new FakeQueueBatch('q', [
        new FakeQueueMessage('a', { ...envelope, trace: 'garbage' }),
        new FakeQueueMessage('b', { ...envelope, trace: 42 }),
      ]),
    );

    expect(seen).toEqual([1, 1]);
    for (const span of telemetry.spans) {
      expect(span.options?.parentContext).not.toHaveProperty('traceId');
    }
  });

  it('traces a request and its responder on one trace id', async () => {
    const telemetry = new RecordingTelemetry();
    const runtime = new FakeBrokerRuntime();
    const producer = new FakeQueueProducer();
    const inbox = new FakeDurableObjectNamespace('reply-inbox');
    const broker = new WorkersBroker(producer, runtime, {
      telemetry: () => telemetry,
      replyInbox: { namespace: inbox, binding: 'INBOX', defaultTimeoutMs: 50 },
    });
    await broker.respond('price', (payload: number) => Promise.resolve(payload * 2));

    const pending = broker.request<number, number>('price', 21);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sent = producer.sends.at(-1)?.body as { trace?: string };
    expect(sent.trace).toBe(TRACEPARENT);

    await broker.dispatch(new FakeQueueBatch('q', [new FakeQueueMessage('r', sent)]));
    await expect(pending).resolves.toBe(42);

    expect(telemetry.spans.map((s) => s.name)).toEqual(['publish rr.req.price', 'receive price']);
    expect(telemetry.spans[1]?.options?.parentContext).toMatchObject({ traceId: TRACE_ID });
  });
});
