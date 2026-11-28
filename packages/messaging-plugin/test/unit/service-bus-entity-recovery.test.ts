import { describe, expect, it, vi } from 'vitest';
import { ServiceBusBroker, adaptServiceBusModule } from '../../src/brokers/service-bus-broker.ts';
import { RequestReplyCore } from '../../src/brokers/request-reply-core.ts';
import type { RequestReplyDeps } from '../../src/brokers/request-reply-core.ts';
import type { ReplyInbox } from '../../src/brokers/inbox.ts';
import { SubscriptionNameExistsError } from '../../src/brokers/fan-out.ts';
import { RequestTimeoutError } from '../../src/errors.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { serviceBusTransport, flushCloud } from '../fixtures/cloud-transports.ts';
import { serviceBusSdk } from '../fixtures/service-bus-sdk.ts';
import { serviceBusFaults } from '../fixtures/service-bus-errors.ts';
import { isServiceBusEntityMissing } from '../../src/brokers/service-bus-faults.ts';

const missing = serviceBusFaults.find(({ code }) => code === 'MessagingEntityNotFound')!.error;
const transient = serviceBusFaults.find(
  ({ code }) => code === 'ServiceCommunicationProblem',
)!.error;
const disabled = serviceBusFaults.find(({ code }) => code === 'MessagingEntityDisabled')!.error;

function harness(retry = false) {
  const fake = serviceBusTransport();
  const clock = clockRuntime();
  const warn = vi.fn();
  const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
    client: fake.transport,
    consumerRetry: retry ? { maxAttempts: 3, delaysMs: [10] } : false,
    logger: { error: vi.fn(), warn },
  });
  const receiveError = (index: number, error: Error = missing, source = 'receive'): void => {
    vi.mocked(fake.transport.open).mock.calls[index]![3]!.onReceiveError!(error, source);
  };
  return { ...fake, clock, broker, warn, receiveError };
}

describe('Service Bus missing reply inbox recovery', () => {
  it('recognizes only a translated missing entity, excluding other refusals and non-errors', () => {
    expect(isServiceBusEntityMissing(missing)).toBe(true);
    for (const error of [null, undefined, 'MessagingEntityNotFound', {}, transient, disabled])
      expect(isServiceBusEntityMissing(error)).toBe(false);
  });

  it.each([
    { kind: 'missing', error: missing, source: 'receive', creates: 2 },
    {
      kind: 'aggregate missing last',
      error: new AggregateError([transient, missing]),
      source: 'receive',
      creates: 2,
    },
    {
      kind: 'aggregate missing earlier',
      error: new AggregateError([missing, disabled]),
      source: 'receive',
      creates: 1,
    },
    { kind: 'transient', error: transient, source: 'receive', creates: 1 },
    { kind: 'settlement', error: missing, source: 'complete', creates: 1 },
    { kind: 'disabled', error: disabled, source: 'receive', creates: 1 },
  ])(
    'handles an SDK $kind report without disconnecting pending requests',
    async ({ error, source, creates }) => {
      const sdk = serviceBusSdk();
      const clock = clockRuntime();
      const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
        client: adaptServiceBusModule(sdk.module, {
          connectionString: 'x',
          adminConnectionString: 'x',
        }),
      });
      const pending: Promise<unknown>[] = [];
      await broker.connect();
      try {
        let settled = false;
        const first = broker
          .request('orders', {}, { timeoutMs: 25 })
          .catch((failure: unknown) => failure);
        pending.push(first);
        void first.then(() => {
          settled = true;
        });
        await flushCloud();
        await sdk.subscribe.mock.calls[0]![0].processError({
          error,
          errorSource: source as 'receive' | 'complete',
          entityPath: 'messaging.replies',
          fullyQualifiedNamespace: 'local',
          identifier: 'inbox',
        });
        await flushCloud();
        expect(settled).toBe(false);
        pending.push(
          broker.request('orders', {}, { timeoutMs: 25 }).catch((failure: unknown) => failure),
        );
        await flushCloud();
        expect(sdk.createSubscription).toHaveBeenCalledTimes(creates);
        expect(sdk.createSubscription).toHaveBeenLastCalledWith(
          'messaging.replies',
          expect.stringMatching(/^rr-inbox-/),
          { autoDeleteOnIdle: 'PT300S' },
        );
        await clock.advance(25);
        for (const result of await Promise.all(pending))
          expect(result).toBeInstanceOf(RequestTimeoutError);
      } finally {
        await broker.disconnect();
        await Promise.all(pending);
        expect(clock.timerCount()).toBe(0);
      }
    },
  );

  it.each(['messaging.replies', 'orders', 'rr.req.orders'])(
    'invalidates only a missing shared inbox topic when sending to %s',
    async (topic) => {
      const h = harness();
      const pending: Promise<unknown>[] = [];
      await h.broker.connect();
      try {
        pending.push(h.broker.request('orders', {}).catch((error: unknown) => error));
        await flushCloud();
        vi.mocked(h.transport.send).mockRejectedValueOnce(missing);
        await expect(h.broker.publish(topic, {})).rejects.toBe(missing);
        pending.push(h.broker.request('orders', {}).catch((error: unknown) => error));
        await flushCloud();
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(
          topic === 'messaging.replies' ? 2 : 1,
        );
      } finally {
        await h.broker.disconnect();
        await Promise.all(pending);
        expect(h.clock.timerCount()).toBe(0);
      }
    },
  );

  it('ignores retired inbox callbacks and closes both retired and successor receivers', async () => {
    const h = harness();
    const pending: Promise<unknown>[] = [];
    await h.broker.connect();
    try {
      pending.push(
        h.broker.request('orders', {}, { timeoutMs: 25 }).catch((error: unknown) => error),
      );
      await flushCloud();
      h.receiveError(0);
      pending.push(
        h.broker.request('orders', {}, { timeoutMs: 25 }).catch((error: unknown) => error),
      );
      await flushCloud();
      expect(h.opens).toHaveLength(2);
      expect(h.opens[0]!.close).toHaveBeenCalledOnce();
      h.receiveError(0);
      h.receiveError(0, transient);
      const envelope = JSON.parse(vi.mocked(h.transport.send).mock.calls[1]![1]) as {
        correlationId: string;
      };
      await h.opens[0]!.deliver({
        payload: JSON.stringify({
          kind: 'rr-reply',
          correlationId: envelope.correlationId,
          ok: true,
          payload: 'stale',
        }),
        ack: vi.fn(),
        nack: vi.fn(),
      });
      pending.push(
        h.broker.request('orders', {}, { timeoutMs: 25 }).catch((error: unknown) => error),
      );
      await flushCloud();
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
      await h.clock.advance(25);
      for (const result of await Promise.all(pending))
        expect(result).toBeInstanceOf(RequestTimeoutError);
    } finally {
      await h.broker.disconnect();
      await Promise.all(pending);
      expect(h.opens.every(({ close }) => close.mock.calls.length === 1)).toBe(true);
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it('keeps a successor cached when an older inbox initialization rejects during close', async () => {
    const clock = clockRuntime();
    const gate = Promise.withResolvers<ReplyInbox>();
    const openInbox = vi
      .fn<RequestReplyDeps['openInbox']>()
      .mockReturnValueOnce(gate.promise)
      .mockImplementation(() =>
        Promise.resolve({ address: 'reply', close: () => Promise.resolve() }),
      );
    const core = new RequestReplyCore({
      openInbox,
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      uuid: () => clock.runtime.uuid(),
      setTimeout: (fn, ms) => clock.runtime.setTimeout(fn, ms),
      clearTimeout: (handle) => clock.runtime.clearTimeout(handle),
    });
    const pending: Promise<unknown>[] = [];
    let closing: Promise<void> | undefined;
    try {
      pending.push(core.request('old', {}).catch((error: unknown) => error));
      closing = core.close();
      pending.push(core.request('new', {}).catch((error: unknown) => error));
      await flushCloud();
      gate.reject(new Error('retired initialization'));
      await closing;
      pending.push(core.request('newer', {}).catch((error: unknown) => error));
      await flushCloud();
      expect(openInbox).toHaveBeenCalledTimes(2);
    } finally {
      gate.reject(new Error('retired initialization'));
      await closing;
      await core.close();
      await Promise.all(pending);
      expect(clock.timerCount()).toBe(0);
    }
  });

  it('retires an inbox reported missing before its open resolves without erasing the successor', async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const originalOpen = vi.mocked(h.transport.open).getMockImplementation()!;
    const pending: Promise<unknown>[] = [];
    vi.mocked(h.transport.open).mockImplementationOnce(async (...args) => {
      const opened = await originalOpen(...args);
      args[3]!.onReceiveError!(missing, 'receive');
      await gate.promise;
      return opened;
    });
    await h.broker.connect();
    try {
      pending.push(h.broker.request('old', {}).catch((error: unknown) => error));
      await flushCloud();
      pending.push(h.broker.request('new', {}).catch((error: unknown) => error));
      await flushCloud();
      expect(h.opens).toHaveLength(2);
      gate.resolve();
      await flushCloud();
      expect(h.opens[0]!.close).toHaveBeenCalledOnce();
      pending.push(h.broker.request('newer', {}).catch((error: unknown) => error));
      await flushCloud();
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();
      await flushCloud();
      await h.broker.disconnect();
      await Promise.all(pending);
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it('attempts retired inbox deletion after close failure and waits for retirement during disconnect', async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const pending: Promise<unknown>[] = [];
    let closing: Promise<void> | undefined;
    await h.broker.connect();
    try {
      pending.push(h.broker.request('orders', {}).catch((error: unknown) => error));
      await flushCloud();
      h.opens[0]!.close.mockImplementationOnce(() => gate.promise);
      h.receiveError(0);
      await flushCloud();
      pending.push(h.broker.request('orders', {}).catch((error: unknown) => error));
      await flushCloud();
      expect(h.opens).toHaveLength(2);
      let settled = false;
      closing = h.broker.disconnect();
      void closing.then(() => {
        settled = true;
      });
      await flushCloud();
      expect(settled).toBe(false);
      gate.reject(new Error('retired receiver close failed'));
      await closing;
      expect(h.transport.deleteSubscription).toHaveBeenCalledTimes(2);
      expect(h.opens[1]!.close).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await (closing ?? h.broker.disconnect());
      await Promise.all(pending);
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it('does not let an older missing-topic send invalidate a newer inbox', async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const pending: Promise<unknown>[] = [];
    await h.broker.connect();
    try {
      pending.push(h.broker.request('orders', {}).catch((error: unknown) => error));
      await flushCloud();
      vi.mocked(h.transport.send).mockReturnValueOnce(gate.promise);
      const send = h.broker.publish('messaging.replies', {}).catch((error: unknown) => error);
      pending.push(send);
      await flushCloud();
      h.receiveError(0);
      pending.push(h.broker.request('orders', {}).catch((error: unknown) => error));
      await flushCloud();
      expect(h.opens).toHaveLength(2);
      gate.reject(missing);
      expect(await send).toBe(missing);
      pending.push(h.broker.request('orders', {}).catch((error: unknown) => error));
      await flushCloud();
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();
      await h.broker.disconnect();
      await Promise.all(pending);
      expect(h.clock.timerCount()).toBe(0);
    }
  });
});

describe('Service Bus missing fan-out receiver recovery', () => {
  it.each([false, true])(
    'recreates the same final subscription and resumes delivery, collision=%s',
    async (collision) => {
      const h = harness();
      const handler = vi.fn();
      await h.broker.connect();
      try {
        const sub = await h.broker.subscribe('orders', handler, { fanOut: true });
        const finalName = vi.mocked(h.transport.createSubscription).mock.calls[0]![1];
        if (collision)
          vi.mocked(h.transport.createSubscription).mockRejectedValueOnce(
            new SubscriptionNameExistsError({}),
          );
        h.receiveError(0);
        h.receiveError(0);
        h.receiveError(0);
        await flushCloud();
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
        expect(h.transport.createSubscription).toHaveBeenLastCalledWith('orders', finalName, {
          autoDeleteOnIdleMs: 300000,
        });
        expect(h.opens).toHaveLength(2);
        expect(h.opens[1]!.name).toBe(finalName);
        expect(h.opens[0]!.close).toHaveBeenCalledOnce();
        await h.opens[0]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
        h.receiveError(0);
        await h.opens[1]!.deliver({ payload: '{"restored":true}', ack: vi.fn(), nack: vi.fn() });
        expect(handler).toHaveBeenCalledExactlyOnceWith(
          { restored: true },
          { topic: 'orders', headers: {} },
        );
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
        await sub.unsubscribe();
        expect(h.opens[1]!.close).toHaveBeenCalledOnce();
      } finally {
        await h.broker.disconnect();
        expect(h.clock.timerCount()).toBe(0);
      }
    },
  );

  it.each([
    { kind: 'transient', independent: true, error: transient, source: 'receive' },
    { kind: 'settlement', independent: true, error: missing, source: 'complete' },
    { kind: 'disabled', independent: true, error: disabled, source: 'receive' },
    { kind: 'durable', independent: false, error: missing, source: 'receive' },
  ])(
    'retains a $kind receiver without recreating its entity',
    async ({ independent, error, source }) => {
      const h = harness();
      await h.broker.connect();
      try {
        await h.broker.subscribe(
          'orders',
          vi.fn(),
          independent ? { fanOut: true } : { queue: 'workers' },
        );
        h.receiveError(0, error, source);
        await flushCloud();
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(independent ? 1 : 0);
        expect(h.transport.open).toHaveBeenCalledOnce();
        expect(h.opens[0]!.close).not.toHaveBeenCalled();
      } finally {
        await h.broker.disconnect();
        expect(h.clock.timerCount()).toBe(0);
      }
    },
  );

  it('dispatches a recovered delivery before the replacement open resolves', async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const handler = vi.fn();
    const originalOpen = vi.mocked(h.transport.open).getMockImplementation()!;
    await h.broker.connect();
    try {
      await h.broker.subscribe('orders', handler, { fanOut: true });
      vi.mocked(h.transport.open).mockImplementationOnce(async (...args) => {
        const opened = await originalOpen(...args);
        await args[2]({ payload: '{"early":true}', ack: vi.fn(), nack: vi.fn() });
        await gate.promise;
        return opened;
      });
      h.receiveError(0);
      await flushCloud();
      expect(handler).toHaveBeenCalledExactlyOnceWith(
        { early: true },
        { topic: 'orders', headers: {} },
      );
    } finally {
      gate.resolve();
      await flushCloud();
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it('does not settle an older delivery after its handler finishes in a retired generation', async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const handler = vi.fn(() => gate.promise);
    const ack = vi.fn();
    const nack = vi.fn();
    let delivery: void | Promise<void>;
    await h.broker.connect();
    try {
      await h.broker.subscribe('orders', handler, { fanOut: true });
      delivery = h.opens[0]!.deliver({ payload: '{}', ack, nack });
      await flushCloud();
      h.receiveError(0);
      await flushCloud();
      gate.resolve();
      await delivery;
      expect(h.opens).toHaveLength(2);
      expect(ack).not.toHaveBeenCalled();
      expect(nack).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it('cancels a held retry before closing the missing receiver', async () => {
    const h = harness(true);
    const handler = vi.fn(() => {
      throw new Error('retry');
    });
    const nack = vi.fn();
    const deadLetter = vi.fn(() => Promise.resolve());
    let delivery: void | Promise<void>;
    await h.broker.connect();
    try {
      await h.broker.subscribe('orders', handler, { fanOut: true });
      delivery = h.opens[0]!.deliver({
        payload: '{}',
        ack: vi.fn(),
        nack,
        deadLetter,
        deliveryCount: 0,
      });
      await flushCloud();
      expect(h.clock.timerCount()).toBe(1);
      h.receiveError(0);
      await flushCloud();
      await delivery;
      expect(h.clock.timerCount()).toBe(0);
      expect(nack).toHaveBeenCalledOnce();
      expect(deadLetter).not.toHaveBeenCalled();
      expect(h.opens[0]!.close).toHaveBeenCalledOnce();
      expect(h.opens).toHaveLength(2);
    } finally {
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it.each(['create', 'open', 'close', 'delete'] as const)(
    'contains recovery %s failures and still attempts independent cleanup',
    async (stage) => {
      const h = harness();
      const failure = new Error('remote secret');
      await h.broker.connect();
      try {
        await h.broker.subscribe('orders', vi.fn(), { fanOut: true });
        if (stage === 'create')
          vi.mocked(h.transport.createSubscription).mockRejectedValueOnce(failure);
        if (stage === 'open') vi.mocked(h.transport.open).mockRejectedValueOnce(failure);
        if (stage === 'close') h.opens[0]!.close.mockRejectedValueOnce(failure);
        if (stage === 'delete') {
          vi.mocked(h.transport.open).mockRejectedValueOnce(failure);
          vi.mocked(h.transport.deleteSubscription).mockRejectedValueOnce(failure);
        }
        h.receiveError(0);
        await flushCloud();
        expect(h.opens[0]!.close).toHaveBeenCalledOnce();
        expect(h.warn).toHaveBeenCalled();
        expect(JSON.stringify(h.warn.mock.calls)).not.toContain('remote secret');
        if (stage === 'open' || stage === 'delete')
          expect(h.transport.deleteSubscription).toHaveBeenCalledOnce();
        if (stage === 'close') expect(h.opens).toHaveLength(2);
      } finally {
        await h.broker.disconnect();
        expect(h.clock.timerCount()).toBe(0);
      }
    },
  );

  it.each(
    (['create', 'open'] as const).flatMap((stage) =>
      (['unsubscribe', 'disconnect'] as const).map((end) => ({ stage, end })),
    ),
  )('cleans late recovery $stage after $end without dispatching', async ({ stage, end }) => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const handler = vi.fn();
    const originalOpen = vi.mocked(h.transport.open).getMockImplementation()!;
    await h.broker.connect();
    try {
      const sub = await h.broker.subscribe('orders', handler, { fanOut: true });
      if (stage === 'create')
        vi.mocked(h.transport.createSubscription).mockReturnValueOnce(gate.promise);
      else
        vi.mocked(h.transport.open).mockImplementationOnce(async (...args) => {
          const opened = await originalOpen(...args);
          await gate.promise;
          return opened;
        });
      h.receiveError(0);
      await flushCloud();
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
      if (end === 'unsubscribe') await sub.unsubscribe();
      else await h.broker.disconnect();
      const deletesBeforeRelease = vi.mocked(h.transport.deleteSubscription).mock.calls.length;
      gate.resolve();
      await flushCloud();
      if (stage === 'create')
        expect(vi.mocked(h.transport.deleteSubscription).mock.calls.length).toBe(
          deletesBeforeRelease + 1,
        );
      else expect(h.opens[1]!.close).toHaveBeenCalledOnce();
      for (const opened of h.opens)
        await opened.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await flushCloud();
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it('keeps late recovery cleanup on the retired subscription after reconnect', async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    await h.broker.connect();
    try {
      await h.broker.subscribe('orders', oldHandler, { fanOut: true });
      const oldName = h.opens[0]!.name;
      vi.mocked(h.transport.createSubscription).mockReturnValueOnce(gate.promise);
      h.receiveError(0);
      await flushCloud();
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
      await h.broker.disconnect();
      await h.broker.connect();
      await h.broker.subscribe('orders', newHandler, { fanOut: true });
      const newName = h.opens[1]!.name;
      expect(newName).not.toBe(oldName);
      gate.resolve();
      await flushCloud();
      expect(h.transport.deleteSubscription).toHaveBeenCalledExactlyOnceWith('orders', oldName);
      h.receiveError(0);
      await h.opens[0]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      await h.opens[1]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      expect(oldHandler).not.toHaveBeenCalled();
      expect(newHandler).toHaveBeenCalledOnce();
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(3);
    } finally {
      gate.resolve();
      await flushCloud();
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it('fences a replacement that reports missing before its open resolves', async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const handler = vi.fn();
    const originalOpen = vi.mocked(h.transport.open).getMockImplementation()!;
    await h.broker.connect();
    try {
      await h.broker.subscribe('orders', handler, { fanOut: true });
      vi.mocked(h.transport.open).mockImplementationOnce(async (...args) => {
        const opened = await originalOpen(...args);
        args[3]!.onReceiveError!(missing, 'receive');
        await gate.promise;
        return opened;
      });
      h.receiveError(0);
      await flushCloud();
      expect(h.opens).toHaveLength(3);
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(3);
      expect(new Set(h.opens.map(({ name }) => name)).size).toBe(1);
      gate.resolve();
      await flushCloud();
      expect(h.opens[1]!.close).toHaveBeenCalledOnce();
      h.receiveError(1);
      await h.opens[1]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      await h.opens[2]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      expect(handler).toHaveBeenCalledOnce();
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(3);
      expect(h.transport.deleteSubscription).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await flushCloud();
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });
});
