import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IMessageBroker,
  IRealtimeBackplane,
  ISubscription,
  RealtimeFrame,
  RealtimeFrameHandler,
} from '../../src/index.ts';

/**
 * A structural `IMessageBroker` that OMITS `isHealthy`. This file compiles
 * only if the widening is optional — the proof that no existing implementor
 * (custom brokers, `cloudflare-plugin`'s messaging arm) breaks.
 */
const brokerWithoutHealth: IMessageBroker = {
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  publish: () => Promise.resolve(),
  subscribe: (): Promise<ISubscription> =>
    Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  request: <TReq, TRes>(_topic: string, _message: TReq): Promise<TRes> =>
    Promise.reject(new Error('not implemented')),
  respond: (): Promise<ISubscription> => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
};

/**
 * A structural `IMessageBroker` that IMPLEMENTS `isHealthy`. The method must
 * type-check against `() => Promise<boolean>` — the shape every in-repo
 * broker builds its probe through.
 */
const brokerWithHealth: IMessageBroker = {
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  publish: () => Promise.resolve(),
  subscribe: (): Promise<ISubscription> =>
    Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  request: <TReq, TRes>(_topic: string, _message: TReq): Promise<TRes> =>
    Promise.reject(new Error('not implemented')),
  respond: (): Promise<ISubscription> => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  isHealthy: () => Promise.resolve(true),
};

/**
 * A structural `IRealtimeBackplane` that OMITS `isHealthy` — same non-breaking
 * proof for the backplane port (the `'custom'` arm and `cloudflare-plugin`'s
 * Durable Object backplane implement this shape).
 */
const backplaneWithoutHealth: IRealtimeBackplane = {
  origin: 'test-origin',
  connect: () => Promise.resolve(),
  publish: (_frame: RealtimeFrame) => Promise.resolve(),
  subscribe: (_handler: RealtimeFrameHandler) => Promise.resolve(() => {}),
  close: () => Promise.resolve(),
};

/**
 * A structural `IRealtimeBackplane` that IMPLEMENTS `isHealthy`.
 */
const backplaneWithHealth: IRealtimeBackplane = {
  origin: 'test-origin',
  connect: () => Promise.resolve(),
  publish: (_frame: RealtimeFrame) => Promise.resolve(),
  subscribe: (_handler: RealtimeFrameHandler) => Promise.resolve(() => {}),
  close: () => Promise.resolve(),
  isHealthy: () => Promise.resolve(false),
};

describe('isHealthy?() port widenings (M70c)', () => {
  it('an IMessageBroker omitting isHealthy still satisfies the type', () => {
    expect(brokerWithoutHealth.isHealthy).toBeUndefined();
  });

  it('an IMessageBroker implementing isHealthy answers Promise<boolean>', async () => {
    expect(await brokerWithHealth.isHealthy?.()).toBe(true);
  });

  it('an IRealtimeBackplane omitting isHealthy still satisfies the type', () => {
    expect(backplaneWithoutHealth.isHealthy).toBeUndefined();
  });

  it('an IRealtimeBackplane implementing isHealthy answers Promise<boolean>', async () => {
    expect(await backplaneWithHealth.isHealthy?.()).toBe(false);
  });
});
