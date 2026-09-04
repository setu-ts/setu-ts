/**
 * The bounded chain-gate wait (M89c plan §3.2/§3.3), driven against an
 * INJECTED clock so the bound is deterministic — no real 10 s waits.
 *
 * - A gate that never settles (the `onInit`-never-ran case) rejects a held
 *   dispatch after `chainReadyTimeoutMs` with `ChainGateTimeoutError`, whose
 *   message names `register()` as the likely cause; the default bound is
 *   10 000 ms.
 * - A REJECTED gate still refuses delivery FOREVER (C3) — the bound is not a
 *   way past a failed startup.
 * - `chainReadyTimeoutMs: 0` disables the bound and waits forever.
 * - Without a gate (no behaviour factory) nothing is armed and delivery is
 *   never deferred.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IIngressBehavior,
  IngressContext,
  IRuntimeServices,
  ISubscription,
  MessageHandler,
  MessageMetadata,
  SubscribeOptions,
  TimerHandle,
} from '@setu-ts/common';
import { PipelinedBroker } from '../../src/pipeline/pipelined-broker.ts';
import { ChainGateTimeoutError } from '../../src/errors.ts';
import type { MessageBrokerAdapter } from '../../src/brokers/message-broker.ts';

/**
 * A manual clock: `setTimeout` records the pending call and hands back a
 * handle; the test FIRES it. No real time passes.
 */
interface ManualClock {
  readonly runtime: IRuntimeServices;
  /** The `ms` value each armed timer was created with, in arm order. */
  readonly armedMs: number[];
  /** Handles cleared so far — the cleanup assertion reads this. */
  readonly cleared: TimerHandle[];
  /** Fires every still-armed timer, in arm order. */
  fireAll(): void;
}

function createManualClock(): ManualClock {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const armedMs: number[] = [];
  const cleared: TimerHandle[] = [];

  const runtime = {
    setTimeout: (fn: () => void, ms: number): TimerHandle => {
      const id = nextId++;
      armedMs.push(ms);
      pending.set(id, fn);
      return { id } as TimerHandle;
    },
    clearTimeout: (handle: TimerHandle): void => {
      cleared.push(handle);
      pending.delete((handle as { id: number }).id);
    },
  } as unknown as IRuntimeServices;

  return {
    runtime,
    armedMs,
    cleared,
    fireAll(): void {
      for (const fn of pending.values()) {
        fn();
      }
      pending.clear();
    },
  };
}

/** Recording adapter: captures the WRAPPED handler `subscribeWithHeaders` installs. */
function createCapturingAdapter(): {
  adapter: MessageBrokerAdapter;
  wrapped: { handler?: MessageHandler<unknown> };
  metadata: MessageMetadata;
} {
  const wrapped: { handler?: MessageHandler<unknown> } = {};
  const adapter: MessageBrokerAdapter = {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    isReady: () => true,
    reachability: () => Promise.resolve(true),
    publish: () => Promise.resolve(),
    publishWithHeaders: () => Promise.resolve(),
    subscribe: <T>(
      topic: string,
      handler: MessageHandler<T>,
      options?: SubscribeOptions,
    ): Promise<ISubscription> => adapter.subscribeWithHeaders(topic, handler, options),
    subscribeWithHeaders: <T>(
      _topic: string,
      handler: MessageHandler<T>,
      _options?: SubscribeOptions,
    ): Promise<ISubscription> => {
      wrapped.handler = handler as MessageHandler<unknown>;
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
    request: () => Promise.resolve({} as never),
    requestWithHeaders: () => Promise.resolve({} as never),
    respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  };
  const metadata = {
    topic: 'orders',
    messageId: 'm1',
    timestamp: new Date(0),
    headers: {},
  } as MessageMetadata;
  return { adapter, wrapped, metadata };
}

function passThrough(log: string[], label: string): IIngressBehavior {
  return {
    handle(_ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
      log.push(label);
      return next();
    },
  };
}

/** Whether a held dispatch has settled yet, without awaiting its outcome. */
function observe(promise: void | Promise<void>): { settled: () => boolean } {
  const state = { settled: false };
  void Promise.resolve(promise).then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return { settled: () => state.settled };
}

/** Awaits a held dispatch and returns its error (or `undefined` on success). */
function outcomeOf(promise: void | Promise<void>): Promise<unknown> {
  return Promise.resolve(promise).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('PipelinedBroker bounded chain-gate wait (M89c §3.2)', () => {
  it('arms the bound with the configured timeoutMs and rejects a never-opened gate', async () => {
    const clock = createManualClock();
    const { promise: neverOpen } = Promise.withResolvers<void>();
    const { adapter, wrapped, metadata } = createCapturingAdapter();
    const piped = new PipelinedBroker(
      adapter,
      [],
      neverOpen,
      { runtime: clock.runtime, timeoutMs: 25 },
    );
    await piped.subscribe('orders', () => {});

    const held = wrapped.handler!({ id: 1 }, metadata);
    const state = observe(held);

    // The bound was armed with the configured value and the dispatch is held.
    expect(clock.armedMs).toEqual([25]);
    await new Promise((r) => setTimeout(r, 5));
    expect(state.settled()).toBe(false);

    clock.fireAll();
    const error: unknown = await outcomeOf(held);
    expect(error).toBeInstanceOf(ChainGateTimeoutError);
    expect((error as ChainGateTimeoutError).timeoutMs).toBe(25);
    expect((error as Error).message).toContain('register()');
  });

  it('defaults the bound to 10 000 ms when timeoutMs is omitted', async () => {
    const clock = createManualClock();
    const { promise: neverOpen } = Promise.withResolvers<void>();
    const { adapter, wrapped, metadata } = createCapturingAdapter();
    const piped = new PipelinedBroker(adapter, [], neverOpen, { runtime: clock.runtime });
    await piped.subscribe('orders', () => {});

    void wrapped.handler!({ id: 1 }, metadata);

    expect(clock.armedMs).toEqual([10_000]);
  });

  it('clears the timer when the gate opens first — the held dispatch is delivered', async () => {
    const clock = createManualClock();
    const { promise: chainReady, resolve: open } = Promise.withResolvers<void>();
    const { adapter, wrapped, metadata } = createCapturingAdapter();
    const handlerSeen: unknown[] = [];
    const piped = new PipelinedBroker(
      adapter,
      [],
      chainReady,
      { runtime: clock.runtime, timeoutMs: 60_000 },
    );
    await piped.subscribe('orders', (message) => {
      handlerSeen.push(message);
    });

    const held = wrapped.handler!({ n: 1 }, metadata);
    expect(clock.armedMs).toEqual([60_000]);

    open();
    await held;
    expect(handlerSeen).toEqual([{ n: 1 }]);
    // The finally-cleanup released the timer: cleared, never fired.
    expect(clock.cleared.length).toBe(1);
    expect(clock.armedMs.length).toBe(1);
  });

  it('a REJECTED gate still refuses delivery forever (C3) — no timeout shortcuts it', async () => {
    const clock = createManualClock();
    const { promise: chainReady, reject: fail } = Promise.withResolvers<void>();
    const { adapter, wrapped, metadata } = createCapturingAdapter();
    const piped = new PipelinedBroker(
      adapter,
      [],
      chainReady,
      { runtime: clock.runtime, timeoutMs: 25 },
    );
    await piped.subscribe('orders', () => {});

    const held1 = wrapped.handler!({ n: 1 }, metadata);
    fail(new Error('startup failed'));

    const firstError: unknown = await outcomeOf(held1);
    // The gate's OWN rejection — not a ChainGateTimeoutError.
    expect(firstError).not.toBeInstanceOf(ChainGateTimeoutError);
    expect((firstError as Error).message).toBe('startup failed');

    // Later dispatches get the SAME refusal: the gate stays in place.
    const held2 = wrapped.handler!({ n: 2 }, metadata);
    const secondError: unknown = await outcomeOf(held2);
    expect(secondError).not.toBeInstanceOf(ChainGateTimeoutError);
    expect((secondError as Error).message).toBe('startup failed');
  });

  it('timeoutMs: 0 disables the bound — no timer is armed and the gate is waited on', async () => {
    const clock = createManualClock();
    const { promise: chainReady, resolve: open } = Promise.withResolvers<void>();
    const { adapter, wrapped, metadata } = createCapturingAdapter();
    const handlerSeen: unknown[] = [];
    const piped = new PipelinedBroker(
      adapter,
      [],
      chainReady,
      { runtime: clock.runtime, timeoutMs: 0 },
    );
    await piped.subscribe('orders', (message) => {
      handlerSeen.push(message);
    });

    const held = wrapped.handler!({ n: 1 }, metadata);

    expect(clock.armedMs).toEqual([]);
    // Still held after a settle — wait-forever, not a fast timeout.
    await new Promise((r) => setTimeout(r, 5));
    expect(handlerSeen).toEqual([]);

    open();
    await held;
    expect(handlerSeen).toEqual([{ n: 1 }]);
  });

  it('no gate is armed without a factory — delivery is never deferred', async () => {
    const log: string[] = [];
    const { adapter, wrapped, metadata } = createCapturingAdapter();
    const piped = new PipelinedBroker(adapter, [passThrough(log, 'behavior')]);
    await piped.subscribe('orders', () => {
      log.push('handler');
    });

    expect(wrapped.handler).toBeDefined();
    await wrapped.handler!({ id: 1 }, metadata);

    // Ran to completion with no gate and no clock in the picture.
    expect(log).toEqual(['behavior', 'handler']);
  });
});
