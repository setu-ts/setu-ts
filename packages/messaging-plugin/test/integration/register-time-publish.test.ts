/**
 * The X16-1 regression (M89c plan §3.1): a plugin that publishes — and AWAITS
 * the publish — during its own `register()` no longer deadlocks startup.
 *
 * Before M89c the in-memory `publish` resolved only when every handler had
 * RETURNED; with a behaviour factory configured, delivery was held on the
 * chain gate, which opens at the END of `onInit` — which cannot run until
 * every `register()` has returned. The awaited publish in `register()` closed
 * that circle: no boot, no error, no log. Now `publish` resolves on dispatch
 * hand-off, `register()` returns, `onInit` opens the gate, and the held
 * message is delivered through the COMPLETE chain — instance behaviour,
 * factory behaviour, then the handler. Reverting §3.1 makes this test hang.
 *
 * Driven through a REAL `InMemoryBroker` (no real backend, AI_GUIDELINES
 * §6.7).
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IIngressBehavior,
  IngressContext,
  IPlugin,
  IPluginContext,
  RegistryFactory,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { MessagingPlugin } from '../../src/plugin/messaging-plugin.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

interface Harness {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly initHooks: (() => void | Promise<void>)[];
}

function createHarness(): Harness {
  const registered = new Map<string, unknown>();
  const initHooks: (() => void | Promise<void>)[] = [];

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
      register: (): void => {},
    },
    lifecycle: {
      onClose: (): void => {},
      onInit: (hook: () => void | Promise<void>): void => {
        initHooks.push(hook);
      },
    },
  } as unknown as IPluginContext;

  return { ctx, registered, initHooks };
}

describe('a register-time awaited publish no longer deadlocks startup (X16-1)', () => {
  it('boots, and the message is delivered through the COMPLETE chain after onInit', async () => {
    const harness = createHarness();
    const log: string[] = [];
    const received: unknown[] = [];

    // The instance behaviour is available at register(); the factory one can
    // only resolve at onInit — which is why the gate exists.
    const instanceBehavior: IIngressBehavior = {
      handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
        expect(ctx.kind).toBe('messaging');
        log.push('instance');
        return next();
      },
    };
    const factoryBehavior: RegistryFactory<IIngressBehavior> = (services) => {
      // Resolves a capability through the registry, as a real factory does.
      void services;
      return {
        handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
          expect(ctx.kind).toBe('messaging');
          log.push('factory');
          return next();
        },
      };
    };

    const messaging = MessagingPlugin({
      broker: 'memory',
      behaviors: [instanceBehavior, factoryBehavior],
      subscriptions: [
        {
          topic: 'orders.created',
          handler: (message) => {
            received.push(message);
          },
        },
      ],
    });
    await messaging.register(harness.ctx);

    // The gate is armed: a publish handed off NOW is held until onInit.
    expect(harness.initHooks).toHaveLength(1);

    // The second plugin resolves the broker in its own register() — the door
    // no deferral inside the messaging plugin can close — and AWAITS a
    // publish there. Pre-M89c this line hung the boot.
    let publishResolvedDuringRegister = false;
    const earlyPublisher: IPlugin = {
      name: 'early-publisher',
      version: '0.0.0-test',
      async register(ctx: IPluginContext): Promise<void> {
        const broker = ctx.services.get<{
          publish: (topic: string, message: unknown) => Promise<void>;
        }>(CAPABILITIES.MESSAGING);
        await broker.publish('orders.created', { orderId: 1 });
        publishResolvedDuringRegister = true;
      },
    };
    await earlyPublisher.register(harness.ctx);

    // publish resolved on hand-off — the register() that awaited it returned,
    // so startup can proceed to onInit at all.
    expect(publishResolvedDuringRegister).toBe(true);
    expect(log).toEqual([]);
    expect(received).toEqual([]);

    // Startup completes: the gate opens, the held message flows through the
    // COMPLETE chain.
    for (const hook of harness.initHooks) {
      await hook();
    }
    await new Promise((r) => setTimeout(r, 10));

    expect(log).toEqual(['instance', 'factory']);
    expect(received).toEqual([{ orderId: 1 }]);
  });
});
