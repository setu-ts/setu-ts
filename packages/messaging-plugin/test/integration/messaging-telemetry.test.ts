/**
 * MessagingPlugin ↔ telemetry integration.
 *
 * The milestone's objective is that a trace SURVIVES a publish. That needs an
 * assertion on trace IDENTITY, not merely on a parent context being present: a
 * consumer span parented into the wrong trace satisfies `toBeDefined()`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, type IMessageBroker, type IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { TelemetryService } from '../../../telemetry-plugin/src/services/telemetry-service.ts';
import { createFakeTracerHost } from '../../../telemetry-plugin/test/fixtures/fake-tracer-host.ts';
import { MessagingPlugin } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function fakeRuntimePlugin(): IPlugin {
  const runtime = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx) {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

function telemetryPlugin(
  host: ReturnType<typeof createFakeTracerHost>,
  options: { name?: string; priority?: number } = {},
): IPlugin {
  return {
    name: options.name ?? 'test-telemetry',
    version: '1.0.0',
    provides: [CAPABILITIES.TELEMETRY],
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    register(ctx) {
      ctx.services.register(CAPABILITIES.TELEMETRY, new TelemetryService(host));
    },
  };
}

/** The traceId of the recorded span with this name, for identity assertions. */
function traceIdOf(
  host: ReturnType<typeof createFakeTracerHost>,
  name: string,
): string | undefined {
  return host.recordedSpans.find((s) => s.name === name)?.context.traceId;
}

describe('MessagingPlugin telemetry integration', () => {
  it('gives the consumer span the SAME traceId as the producer span', async () => {
    const host = createFakeTracerHost();
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), telemetryPlugin(host), MessagingPlugin({ broker: 'memory' })],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

    const seen: unknown[] = [];
    await broker.subscribe('orders', (message) => {
      seen.push(message);
    });
    await broker.publish('orders', { id: 'o-1' });

    expect(seen).toEqual([{ id: 'o-1' }]);
    // The producer span opens first; the in-memory delivery runs inside it.
    expect(host.recordedSpans.map((s) => s.name)).toEqual([
      'publish orders',
      'receive orders',
    ]);

    // Identity, not mere presence. This is what a broken traceparent would fail.
    const receiveCall = host.recordedCalls.find((c) => c.args[0] === 'receive orders');
    const parent = (receiveCall?.args[1] as { parentContext?: { traceId?: string } })
      .parentContext;
    const producerTrace = traceIdOf(host, 'publish orders');
    expect(parent?.traceId).toBeDefined();
    expect(parent?.traceId).toBe(producerTrace);

    await app.stop();
  });

  it('propagates trace context through request-reply', async () => {
    const host = createFakeTracerHost();
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), telemetryPlugin(host), MessagingPlugin({ broker: 'memory' })],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    await broker.respond('orders', (message) => Promise.resolve({ received: message }));

    const response = await broker.request<{ id: string }, { received: { id: string } }>('orders', {
      id: 'order-1',
    });

    expect(response).toEqual({ received: { id: 'order-1' } });
    expect(host.recordedSpans.map((span) => span.name)).toEqual([
      'publish rr.req.orders',
      'receive rr.req.orders',
    ]);
    const receiveCall = host.recordedCalls.find((call) => call.args[0] === 'receive rr.req.orders');
    const parent = (receiveCall?.args[1] as { parentContext?: { traceId?: string } })
      .parentContext;
    expect(parent?.traceId).toBe(traceIdOf(host, 'publish rr.req.orders'));

    await app.stop();
  });

  it('registers the broker untraced when no telemetry capability exists', async () => {
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), MessagingPlugin({ broker: 'memory' })],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

    const seen: unknown[] = [];
    await broker.subscribe('orders', (message) => {
      seen.push(message);
    });
    await broker.publish('orders', { id: 'o-1' });

    // Behaviour is byte-identical to a pre-M75 application.
    expect(seen).toEqual([{ id: 'o-1' }]);
    expect(broker.constructor.name).toBe('InMemoryBroker');

    await app.stop();
  });

  it('honours tracing: false even when telemetry IS registered', async () => {
    const host = createFakeTracerHost();
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        telemetryPlugin(host),
        MessagingPlugin({ broker: 'memory', tracing: false }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

    await broker.subscribe('orders', () => {});
    await broker.publish('orders', { id: 'o-1' });

    expect(host.recordedSpans).toEqual([]);
    expect(broker.constructor.name).toBe('InMemoryBroker');

    await app.stop();
  });

  it('wraps with a REPLACEMENT telemetry provider registered at a higher priority number', async () => {
    // Priority alone does not guarantee ordering for a provider that sits after
    // messaging; the optionalDependencies edge does. This is the case that edge
    // exists for (the M45b lesson).
    const host = createFakeTracerHost();
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        MessagingPlugin({ broker: 'memory' }),
        telemetryPlugin(host, { name: 'late-telemetry', priority: 900 }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

    await broker.subscribe('orders', () => {});
    await broker.publish('orders', { id: 'o-1' });

    expect(host.recordedSpans.map((s) => s.name)).toContain('publish orders');

    await app.stop();
  });
});
