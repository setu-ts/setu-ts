/**
 * §0.1 P2 — every registration site reaches the tracing decorator.
 *
 * A declared processor is registered against the SERVICE object rather than
 * resolved from the registry, so a wrapper reachable only through
 * `CAPABILITIES.QUEUE` would leave the entire `processors` arm — the shape a
 * CLI-scaffolded application uses — with no consumer span at all, while every
 * test driving `queue.process()` imperatively kept passing. That is the plan
 * defect this file exists to hold shut.
 *
 * Driven through a REAL kernel application, because the defect is in how the
 * plugin wires its own registration sites; a test that constructs `TracedQueue`
 * directly cannot see it.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJob, IPlugin, IQueue, ISpan, ITelemetryService, SpanOptions } from '@setu-ts/common';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';
import { RuntimePlugin } from '@setu-ts/runtime';

/** Records the spans a telemetry capability was asked to open. */
function recordingTelemetry(): {
  plugin: IPlugin;
  spans: { name: string; options?: SpanOptions }[];
} {
  const spans: { name: string; options?: SpanOptions }[] = [];
  const span = {
    setAttribute: () => span,
    setAttributes: () => span,
    setStatus: () => {},
    recordException: () => {},
    end: () => {},
    spanContext: () => ({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: '01',
    }),
  } as unknown as ISpan;
  const service: ITelemetryService = {
    withSpan: <T>(name: string, fn: (s: ISpan) => Promise<T>, options?: SpanOptions) => {
      spans.push({ name, ...(options === undefined ? {} : { options }) });
      return fn(span);
    },
  };
  return {
    spans,
    plugin: {
      name: 'fake-telemetry',
      version: '0.0.0',
      provides: [CAPABILITIES.TELEMETRY],
      register(ctx) {
        ctx.services.register<ITelemetryService>(CAPABILITIES.TELEMETRY, service);
      },
    },
  };
}

/** Waits for a value to appear, driving the real poll loop. */
async function until<T>(read: () => T | undefined, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the job to be delivered');
}

describe('declared processors reach the tracing decorator', () => {
  it('traces a processor registered through the `processors` arm', async () => {
    const telemetry = recordingTelemetry();
    let seen: IJob<unknown> | undefined;

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        telemetry.plugin,
        QueuePlugin({
          adapter: 'memory',
          pollIntervalMs: 5,
          processors: [{
            name: 'declared.job',
            processor: (job) => {
              seen = job;
            },
          }],
        }),
      ],
    });
    await app.start();

    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    await queue.add('declared.job', { id: 1 });
    await until(() => seen);
    await app.stop();

    // The producer half.
    expect(telemetry.spans.some((s) => s.name === 'enqueue declared.job')).toBe(true);
    // The consumer half — the one a token-only wrapper would miss entirely.
    const consumer = telemetry.spans.find((s) => s.name === 'process declared.job');
    expect(consumer).toBeDefined();
    expect(consumer?.options?.kind).toBe('consumer');
    // …and it is parented from the header the producer wrote, which is what
    // makes the two halves one trace rather than two.
    expect(consumer?.options?.parentContext?.traceId)
      .toBe('0af7651916cd43dd8448eb211c80319c');
    expect(seen?.headers?.traceparent).toBeDefined();
  });

  it('traces a processor registered through a `processors` FACTORY', async () => {
    // The factory arm registers in `onInit` rather than `register()`, so it is
    // a second, separately-wired call site.
    const telemetry = recordingTelemetry();
    let seen: IJob<unknown> | undefined;

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        telemetry.plugin,
        QueuePlugin({
          adapter: 'memory',
          pollIntervalMs: 5,
          processors: [() => ({
            name: 'factory.job',
            processor: (job) => {
              seen = job;
            },
          })],
        }),
      ],
    });
    await app.start();

    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    await queue.add('factory.job', { id: 1 });
    await until(() => seen);
    await app.stop();

    expect(telemetry.spans.some((s) => s.name === 'process factory.job')).toBe(true);
  });

  it('traces a processor registered imperatively through the capability', async () => {
    const telemetry = recordingTelemetry();
    let seen: IJob<unknown> | undefined;

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        telemetry.plugin,
        QueuePlugin({
          adapter: 'memory',
          pollIntervalMs: 5,
        }),
      ],
    });
    await app.start();

    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    queue.process('imperative.job', (job) => {
      seen = job;
    });
    await queue.add('imperative.job', { id: 1 });
    await until(() => seen);
    await app.stop();

    expect(telemetry.spans.some((s) => s.name === 'process imperative.job')).toBe(true);
  });

  it('registers the UNDECORATED service when no telemetry is present', async () => {
    // Byte-identical to the pre-M90i composition: nothing is injected and the
    // job carries no framework-written header.
    let seen: IJob<unknown> | undefined;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({
          adapter: 'memory',
          pollIntervalMs: 5,
          processors: [{
            name: 'plain.job',
            processor: (job) => {
              seen = job;
            },
          }],
        }),
      ],
    });
    await app.start();

    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    await queue.add('plain.job', { id: 1 });
    await until(() => seen);
    await app.stop();

    expect('headers' in (seen as object)).toBe(false);
  });

  it("delivers a CALLER's headers with no telemetry registered", async () => {
    // `headers` is a public option on a public contract, so its delivery cannot
    // depend on which capabilities happen to be registered.
    let seen: IJob<unknown> | undefined;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({
          adapter: 'memory',
          pollIntervalMs: 5,
          processors: [{
            name: 'caller.job',
            processor: (job) => {
              seen = job;
            },
          }],
        }),
      ],
    });
    await app.start();

    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    await queue.add('caller.job', { id: 1 }, { headers: { 'x-tenant': 't-1' } });
    await until(() => seen);
    await app.stop();

    expect(seen?.headers).toEqual({ 'x-tenant': 't-1' });
  });
});
