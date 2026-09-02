/**
 * No-options-unchanged (M86 §3.9) — with no behaviours configured, NO
 * `PipelinedBroker` sits in the broker chain: the adapter receives the
 * application's own handler reference, byte-for-byte the pre-arm wiring.
 *
 * The property is asserted THROUGH the broker chain — what handler reference
 * the underlying adapter actually received — never by reading a private
 * field, which a refactor could silently invalidate. A negative control with
 * one behaviour configured proves the identity assertion discriminates.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HealthCheckResult,
  IMessageBroker,
  IngressContext,
  IPluginContext,
  ISubscription,
  MessageHandler,
  MessageMetadata,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { MessagingPlugin } from '../../src/plugin/messaging-plugin.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** A recording broker's observation of what the plugin's chain handed it. */
interface RecordingBroker {
  readonly instance: IMessageBroker;
  readonly subscribed: { topic: string; handler: MessageHandler<unknown> }[];
  readonly responded: { topic: string; handler: RequestHandler<unknown, unknown> }[];
  /** Delivers to every handler subscribed on the topic, as a real broker would. */
  deliver(topic: string, message: unknown): Promise<void>;
}

/**
 * Builds a recording broker exposing the FULL internal seam, so
 * `asBrokerAdapter` returns it unchanged and the plugin registers it as-is.
 * It records the handler REFERENCE each subscribe/respond actually received —
 * the observable the identity assertions below read.
 */
function createRecordingBroker(metadata: MessageMetadata): RecordingBroker {
  const subscribed: { topic: string; handler: MessageHandler<unknown> }[] = [];
  const responded: { topic: string; handler: RequestHandler<unknown, unknown> }[] = [];

  const subscribe = <T>(
    topic: string,
    handler: MessageHandler<T>,
    _options?: SubscribeOptions,
  ): Promise<ISubscription> => {
    subscribed.push({ topic, handler: handler as MessageHandler<unknown> });
    return Promise.resolve({ unsubscribe: () => Promise.resolve() });
  };

  const base: IMessageBroker = {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    publish: <T>(_topic: string, _message: T) => Promise.resolve(),
    subscribe,
    request: <TReq, TRes>(_topic: string, _message: TReq, _options?: RequestOptions) =>
      Promise.resolve({} as TRes),
    respond: <TReq, TRes>(
      topic: string,
      handler: RequestHandler<TReq, TRes>,
      _options?: SubscribeOptions,
    ) => {
      responded.push({ topic, handler: handler as RequestHandler<unknown, unknown> });
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
    isHealthy: () => Promise.resolve(true),
  };

  // Expose the internal seam members `asBrokerAdapter` probes for, so the
  // instance is registered unchanged rather than re-wrapped.
  const full = base as IMessageBroker & {
    isReady(): boolean;
    reachability(): Promise<boolean | undefined>;
    publishWithHeaders<T>(
      topic: string,
      message: T,
      headers: Readonly<Record<string, string>>,
    ): Promise<void>;
    subscribeWithHeaders<T>(
      topic: string,
      handler: MessageHandler<T>,
      options?: SubscribeOptions,
    ): Promise<ISubscription>;
    requestWithHeaders<TReq, TRes>(
      topic: string,
      message: TReq,
      headers: Readonly<Record<string, string>>,
      options?: RequestOptions,
    ): Promise<TRes>;
  };
  full.isReady = () => true;
  full.reachability = () => Promise.resolve(true);
  // The header-aware internal path funnels into the same registration, the
  // way every first-party broker does.
  full.subscribeWithHeaders = subscribe;
  full.requestWithHeaders = <TReq, TRes>(
    _topic: string,
    _message: TReq,
    _headers: Readonly<Record<string, string>>,
    _options?: RequestOptions,
  ): Promise<TRes> => Promise.resolve({} as TRes);
  full.publishWithHeaders = async (topic: string, message: unknown): Promise<void> => {
    for (const sub of subscribed) {
      if (sub.topic === topic) {
        // The SAME message reference and the broker's own metadata.
        await sub.handler(message, metadata);
      }
    }
  };

  return {
    instance: full,
    subscribed,
    responded,
    deliver: (topic, message) => full.publishWithHeaders(topic, message, {}),
  };
}

async function boot(options: Record<string, unknown>): Promise<{
  service: IMessageBroker;
  registered: Map<string, unknown>;
}> {
  const registered = new Map<string, unknown>();
  const ctx = {
    runtime: createFakeRuntime(),
    services: {
      has: (token: string): boolean => registered.has(token),
      get: <T>(token: string): T => {
        const found = registered.get(token);
        if (found === undefined) {
          throw new Error(`no service for ${token}`);
        }
        return found as T;
      },
      register: <T>(token: string, service: T): void => {
        registered.set(token, service);
      },
    },
    health: {
      register: (_name: string, _check: () => Promise<HealthCheckResult>): void => {},
    },
    lifecycle: {
      onClose: (_hook: () => void | Promise<void>): void => {},
      onInit: (_hook: () => void | Promise<void>): void => {},
    },
  } as unknown as IPluginContext;

  const plugin = MessagingPlugin(options as never);
  await plugin.register(ctx);
  const service = registered.get(CAPABILITIES.MESSAGING);
  if (service === undefined) {
    throw new Error('plugin did not register the broker');
  }
  return { service: service as IMessageBroker, registered };
}

describe('Messaging zero-configuration broker chain is unchanged (M86 §3.9)', () => {
  it('with no behaviors, the adapter receives the application handler by the SAME reference', async () => {
    const metadata: MessageMetadata = { topic: 'orders', headers: {} };
    const recording = createRecordingBroker(metadata);
    const { service } = await boot({ broker: 'custom', instance: recording.instance });

    let ran = false;
    const handler: MessageHandler<{ n: number }> = () => {
      ran = true;
    };
    await service.subscribe('orders', handler);

    expect(recording.subscribed).toHaveLength(1);
    expect(recording.subscribed[0]?.topic).toBe('orders');
    // NO PipelinedBroker between the resolved service and the adapter.
    expect(recording.subscribed[0]?.handler).toBe(handler);

    // Delivery is byte-identical too: the handler receives the SAME message
    // reference and the broker's own metadata, and runs within the publish
    // await exactly as it did before the arm existed.
    const seen: { message: unknown; meta: MessageMetadata }[] = [];
    const watcher: MessageHandler<{ n: number }> = (message, meta) => {
      seen.push({ message, meta });
    };
    await service.subscribe('orders', watcher);

    const payload = { n: 1 };
    await recording.deliver('orders', payload);

    expect(ran).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe(payload);
    expect(seen[0]?.meta).toBe(metadata);
  });

  it('an explicitly empty behaviors arm changes the chain identically', async () => {
    const recording = createRecordingBroker({ topic: 'orders', headers: {} });
    const { service } = await boot({
      broker: 'custom',
      instance: recording.instance,
      behaviors: [],
    });

    const handler: MessageHandler<{ n: number }> = () => {};
    await service.subscribe('orders', handler);

    expect(recording.subscribed).toHaveLength(1);
    expect(recording.subscribed[0]?.handler).toBe(handler);
  });

  it('negative control: one configured behavior WRAPS the handler the adapter receives', async () => {
    const recording = createRecordingBroker({ topic: 'orders', headers: {} });
    const { service } = await boot({
      broker: 'custom',
      instance: recording.instance,
      behaviors: [{ handle: (_ctx: IngressContext, next: () => Promise<void>) => next() }],
    });

    const handler: MessageHandler<{ n: number }> = () => {};
    await service.subscribe('orders', handler);

    expect(recording.subscribed).toHaveLength(1);
    // The wrapped closure is NOT the application's reference — proving the
    // identity assertion above can tell "no decorator" from "decorator".
    expect(recording.subscribed[0]?.handler).not.toBe(handler);
  });

  it('respond is untouched in both configurations — the adapter always gets the same reference', async () => {
    const plain = createRecordingBroker({ topic: 'pricing', headers: {} });
    const chained = createRecordingBroker({ topic: 'pricing', headers: {} });

    const plainBoot = await boot({ broker: 'custom', instance: plain.instance });
    const chainedBoot = await boot({
      broker: 'custom',
      instance: chained.instance,
      behaviors: [{ handle: (_ctx: IngressContext, next: () => Promise<void>) => next() }],
    });

    const responder: RequestHandler<{ q: string }, number> = () => 42;
    await plainBoot.service.respond('pricing', responder);
    await chainedBoot.service.respond('pricing', responder);

    // `respond` is forwarded unwrapped whether or not a chain exists (§3.12).
    expect(plain.responded[0]?.handler).toBe(responder);
    expect(chained.responded[0]?.handler).toBe(responder);
  });
});
