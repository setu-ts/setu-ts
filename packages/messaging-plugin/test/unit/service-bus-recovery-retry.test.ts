import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import type { IServiceBusTransport } from '../../src/brokers/service-bus-broker.ts';
import { isServiceBusEntityMissing } from '../../src/brokers/service-bus-faults.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { serviceBusTransport, flushCloud } from '../fixtures/cloud-transports.ts';
import { serviceBusFaults } from '../fixtures/service-bus-errors.ts';

const missing = serviceBusFaults.find(({ code }) => code === 'MessagingEntityNotFound')!.error;
const transient = serviceBusFaults.find(
  ({ code }) => code === 'ServiceCommunicationProblem',
)!.error;
const disabled = serviceBusFaults.find(({ code }) => code === 'MessagingEntityDisabled')!.error;
const unauthorized = serviceBusFaults.find(({ code }) => code === 'UnauthorizedAccess')!.error;

const atomHelper = new URL('./util/atomXmlHelper.js', import.meta.resolve('@azure/service-bus'));
const { buildError } = (await import(atomHelper.href)) as {
  buildError(response: {
    status: number;
    parsedBody: string;
    request: { method: string; headers: { get(name: string): string | undefined } };
  }): Error;
};

const { RestError } = (await import(
  createRequire(import.meta.resolve('@azure/service-bus')).resolve('@typespec/ts-http-runtime')
)) as { RestError: new (message: string, options: { code: string }) => Error };

function managementFailure(status: number): Error {
  try {
    return buildError({
      status,
      parsedBody: 'management failure',
      request: { method: 'PUT', headers: { get: () => undefined } },
    });
  } catch (error) {
    // The SDK builder throws for HTTP statuses absent from its ATOM status table.
    if (error instanceof Error) return error;
    throw error;
  }
}

function harness() {
  const fake = serviceBusTransport();
  const clock = clockRuntime();
  const warn = vi.fn();
  const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
    client: fake.transport,
    consumerRetry: false,
    logger: { error: vi.fn(), warn },
  });
  const fail = (index = 0, error: Error = missing): void => {
    vi.mocked(fake.transport.open).mock.calls[index]![3]!.onReceiveError!(error, 'receive');
  };
  return { ...fake, clock, warn, broker, fail };
}

describe('Service Bus missing entity identification', () => {
  it.each([
    { label: 'direct missing', error: missing, expected: true },
    { label: 'last missing', error: new AggregateError([transient, missing]), expected: true },
    {
      label: 'earlier missing before transient',
      error: new AggregateError([missing, transient]),
      expected: false,
    },
    {
      label: 'earlier missing before another refusal',
      error: new AggregateError([missing, disabled]),
      expected: false,
    },
    { label: 'empty aggregate', error: new AggregateError([]), expected: false },
  ])('uses only the last aggregate entry: $label', ({ error, expected }) => {
    expect(isServiceBusEntityMissing(error)).toBe(expected);
  });

  it('recovers a fan-out receiver when the last aggregate entry confirms missing', async () => {
    const h = harness();
    const handler = vi.fn();
    await h.broker.connect();
    try {
      await h.broker.subscribe('orders', handler, { fanOut: true });
      h.fail(0, new AggregateError([transient, missing]));
      await flushCloud();
      expect(h.opens).toHaveLength(2);
      await h.opens[1]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });
});

describe('Service Bus fan-out recovery retries', () => {
  it.each([
    { status: 408, retry: true },
    { status: 429, retry: true },
    { status: 500, retry: true },
    { status: 503, retry: true },
    { status: 401, retry: false },
    { status: 403, retry: false },
    { status: 404, retry: false },
    { status: 501, retry: false },
    { status: 505, retry: false },
  ])(
    'handles an SDK administration HTTP $status failure, retry=$retry',
    async ({ status, retry }) => {
      const h = harness();
      const handler = vi.fn();
      const error = managementFailure(status);
      expect(error).toMatchObject({ name: 'RestError', statusCode: status });
      if (status === 503) expect(error).toMatchObject({ code: 'ServerBusyError' });
      await h.broker.connect();
      try {
        await h.broker.subscribe('orders', handler, { fanOut: true });
        vi.mocked(h.transport.createSubscription).mockRejectedValueOnce(error);
        h.fail();
        await flushCloud();
        expect(h.clock.timerCount()).toBe(retry ? 1 : 0);
        await h.clock.advance(1000);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(retry ? 3 : 2);
        if (retry) {
          await h.opens[1]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
          expect(handler).toHaveBeenCalledOnce();
        }
      } finally {
        await h.broker.disconnect();
        expect(h.clock.timerCount()).toBe(0);
      }
    },
  );

  it('stops recovery on an administration 403 even when the error is marked retryable', async () => {
    const h = harness();
    const error = Object.assign(managementFailure(403), { retryable: true });
    expect(error).toMatchObject({ name: 'RestError', statusCode: 403, retryable: true });
    await h.broker.connect();
    try {
      await h.broker.subscribe('orders', vi.fn(), { fanOut: true });
      vi.mocked(h.transport.createSubscription).mockRejectedValueOnce(error);
      h.fail();
      await flushCloud();
      expect(h.clock.timerCount()).toBe(0);
      expect(h.warn).toHaveBeenCalledOnce();
      await h.clock.advance(5000);
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
    } finally {
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it('stops waiting for an old receiver close after the bound, recovers, and lets the close finish', async () => {
    const h = harness();
    const handler = vi.fn();
    const hung = Promise.withResolvers<void>();
    await h.broker.connect();
    try {
      await h.broker.subscribe('orders', handler, { fanOut: true });
      h.opens[0]!.close.mockReturnValueOnce(hung.promise);
      h.fail();
      await flushCloud();
      await h.clock.advance(4999);
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(1);
      await h.clock.advance(1);
      expect(h.warn).toHaveBeenCalledExactlyOnceWith(
        'Service Bus retired fan-out receiver did not close within 5000ms; recovery continues and the close finishes in the background',
      );
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
      expect(h.opens).toHaveLength(2);
      // The old receiver's late deliveries stay fenced.
      await h.opens[0]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      expect(handler).not.toHaveBeenCalled();
      await h.opens[1]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      expect(handler).toHaveBeenCalledOnce();
      hung.resolve();
      await flushCloud();
      expect(h.opens[0]!.close).toHaveBeenCalledOnce();
    } finally {
      hung.resolve();
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it('stops waiting for a delete after a failed recovery open, retries, and recovers again after a late delete', async () => {
    const h = harness();
    const handler = vi.fn();
    const hung = Promise.withResolvers<void>();
    await h.broker.connect();
    try {
      await h.broker.subscribe('orders', handler, { fanOut: true });
      vi.mocked(h.transport.open).mockRejectedValueOnce(transient);
      vi.mocked(h.transport.deleteSubscription).mockReturnValueOnce(hung.promise);
      h.fail();
      await flushCloud();
      expect(h.transport.deleteSubscription).toHaveBeenCalledOnce();
      await h.clock.advance(4999);
      expect(h.clock.timerCount()).toBe(1);
      await h.clock.advance(1);
      expect(h.warn).toHaveBeenCalledWith(
        'Service Bus fan-out subscription delete did not finish within 5000ms; recovery continues',
      );
      await h.clock.advance(1000);
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(3);
      expect(h.opens).toHaveLength(2);
      // The late delete removes the recreated entity; its receiver reports it
      // missing and recovery recreates it again.
      hung.resolve();
      await flushCloud();
      h.fail(2);
      await flushCloud();
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(4);
      expect(h.opens).toHaveLength(3);
      await h.opens[2]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      hung.resolve();
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it.each(['unsubscribe', 'disconnect'] as const)(
    'stops waiting for a hung retired receiver close on %s after the bound',
    async (end) => {
      const h = harness();
      const hung = Promise.withResolvers<void>();
      await h.broker.connect();
      try {
        const sub = await h.broker.subscribe('orders', vi.fn(), { fanOut: true });
        h.opens[0]!.close.mockReturnValueOnce(hung.promise);
        h.fail();
        await flushCloud();
        await h.clock.advance(5000);
        expect(h.opens).toHaveLength(2);
        h.warn.mockClear();
        let done = false;
        const ending = (end === 'unsubscribe' ? sub.unsubscribe() : h.broker.disconnect()).then(
          () => {
            done = true;
          },
        );
        await flushCloud();
        expect(done).toBe(false);
        await h.clock.advance(5000);
        await ending;
        expect(done).toBe(true);
        expect(h.warn).toHaveBeenCalledExactlyOnceWith(
          'Service Bus retired fan-out receiver did not close within 5000ms; the subscription closes without it',
        );
        expect(h.opens[1]!.close).toHaveBeenCalledOnce();
        expect(h.clock.timerCount()).toBe(0);
      } finally {
        hung.resolve();
        await h.broker.disconnect();
        expect(h.clock.timerCount()).toBe(0);
      }
    },
  );

  it.each(['unsubscribe', 'disconnect'] as const)(
    'releases a bounded recovery wait at once on %s',
    async (end) => {
      const h = harness();
      const hung = Promise.withResolvers<void>();
      await h.broker.connect();
      try {
        const sub = await h.broker.subscribe('orders', vi.fn(), { fanOut: true });
        vi.mocked(h.transport.open).mockRejectedValueOnce(transient);
        vi.mocked(h.transport.deleteSubscription).mockReturnValueOnce(hung.promise);
        h.fail();
        await flushCloud();
        expect(h.clock.timerCount()).toBe(1);
        if (end === 'unsubscribe') await sub.unsubscribe();
        else await h.broker.disconnect();
        expect(h.clock.timerCount()).toBe(0);
        await h.clock.advance(10000);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
      } finally {
        hung.resolve();
        await h.broker.disconnect();
        expect(h.clock.timerCount()).toBe(0);
      }
    },
  );

  it.each(['REQUEST_SEND_ERROR', 'ECONNABORTED', 'ENETDOWN', 'ERR_TLS_CERT_ALTNAME_INVALID'])(
    'retries an administration request that got no answer (RestError %s, no status)',
    async (code) => {
      const h = harness();
      const handler = vi.fn();
      const error = new RestError('request failed', { code });
      expect(error).toMatchObject({ name: 'RestError', code });
      expect((error as { statusCode?: unknown }).statusCode).toBeUndefined();
      await h.broker.connect();
      try {
        await h.broker.subscribe('orders', handler, { fanOut: true });
        vi.mocked(h.transport.createSubscription).mockRejectedValueOnce(error);
        h.fail();
        await flushCloud();
        expect(h.clock.timerCount()).toBe(1);
        await h.clock.advance(1000);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(3);
        await h.opens[1]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
        expect(handler).toHaveBeenCalledOnce();
      } finally {
        await h.broker.disconnect();
        expect(h.clock.timerCount()).toBe(0);
      }
    },
  );

  it('bounds a recovery create that never answers, then retries and resumes delivery', async () => {
    const h = harness();
    const handler = vi.fn();
    const hung = Promise.withResolvers<void>();
    await h.broker.connect();
    try {
      await h.broker.subscribe('orders', handler, { fanOut: true });
      vi.mocked(h.transport.createSubscription).mockReturnValueOnce(hung.promise);
      h.fail();
      await flushCloud();
      await h.clock.advance(4999);
      expect(h.warn).not.toHaveBeenCalled();
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
      await h.clock.advance(1);
      expect(h.warn).toHaveBeenCalledExactlyOnceWith(
        'Service Bus fan-out receiver recovery failed (RecoveryCallTimeout)',
      );
      await h.clock.advance(1000);
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(3);
      expect(h.opens).toHaveLength(2);
      await h.opens[1]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      expect(handler).toHaveBeenCalledOnce();
      // The late answer finds the handle still open: the same name is in use.
      const deletes = vi.mocked(h.transport.deleteSubscription).mock.calls.length;
      hung.resolve();
      await flushCloud();
      expect(h.transport.deleteSubscription).toHaveBeenCalledTimes(deletes);
    } finally {
      hung.resolve();
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it('deletes a timed-out create that answers after close, quietly when it is already gone', async () => {
    const h = harness();
    const hung = Promise.withResolvers<void>();
    await h.broker.connect();
    try {
      const sub = await h.broker.subscribe('orders', vi.fn(), { fanOut: true });
      vi.mocked(h.transport.createSubscription).mockReturnValueOnce(hung.promise);
      h.fail();
      await flushCloud();
      await h.clock.advance(6000);
      expect(h.opens).toHaveLength(2);
      await sub.unsubscribe();
      expect(h.transport.deleteSubscription).toHaveBeenCalledTimes(1);
      h.warn.mockClear();
      vi.mocked(h.transport.deleteSubscription).mockRejectedValueOnce(managementFailure(404));
      hung.resolve();
      await flushCloud();
      // The late create may have landed after close's delete, so it is deleted again.
      expect(h.transport.deleteSubscription).toHaveBeenCalledTimes(2);
      expect(h.warn).not.toHaveBeenCalled();
    } finally {
      hung.resolve();
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it('warns once when a late create cannot be deleted for another reason', async () => {
    const h = harness();
    const hung = Promise.withResolvers<void>();
    await h.broker.connect();
    try {
      const sub = await h.broker.subscribe('orders', vi.fn(), { fanOut: true });
      vi.mocked(h.transport.createSubscription).mockReturnValueOnce(hung.promise);
      h.fail();
      await flushCloud();
      await sub.unsubscribe();
      vi.mocked(h.transport.deleteSubscription).mockRejectedValueOnce(managementFailure(503));
      hung.resolve();
      await flushCloud();
      expect(h.warn).toHaveBeenCalledOnce();
      expect(String(h.warn.mock.calls[0]![0])).toContain('was not deleted');
    } finally {
      hung.resolve();
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it.each(['unsubscribe', 'disconnect'] as const)(
    'releases a hung recovery create on %s and deletes the entity if it answers later',
    async (end) => {
      const h = harness();
      const hung = Promise.withResolvers<void>();
      await h.broker.connect();
      try {
        const sub = await h.broker.subscribe('orders', vi.fn(), { fanOut: true });
        vi.mocked(h.transport.createSubscription).mockReturnValueOnce(hung.promise);
        h.fail();
        await flushCloud();
        expect(h.clock.timerCount()).toBe(1);
        if (end === 'unsubscribe') await sub.unsubscribe();
        else await h.broker.disconnect();
        expect(h.clock.timerCount()).toBe(0);
        const deletes = vi.mocked(h.transport.deleteSubscription).mock.calls.length;
        hung.resolve();
        await flushCloud();
        expect(h.transport.deleteSubscription).toHaveBeenCalledTimes(deletes + 1);
        await h.clock.advance(5000);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
        expect(h.warn).not.toHaveBeenCalled();
      } finally {
        hung.resolve();
        await h.broker.disconnect();
        expect(h.clock.timerCount()).toBe(0);
      }
    },
  );

  it.each(['create', 'open'] as const)(
    'retries transient %s failures with one timer and one warning, then resumes delivery',
    async (stage) => {
      const h = harness();
      const handler = vi.fn();
      let failedOpen: Parameters<IServiceBusTransport['open']> | undefined;
      await h.broker.connect();
      try {
        await h.broker.subscribe('orders', handler, { fanOut: true });
        const name = h.opens[0]!.name;
        if (stage === 'create')
          vi.mocked(h.transport.createSubscription)
            .mockRejectedValueOnce(transient)
            .mockRejectedValueOnce(transient);
        else
          vi.mocked(h.transport.open)
            .mockImplementationOnce((...args) => {
              failedOpen = args;
              return Promise.reject(transient);
            })
            .mockRejectedValueOnce(transient);
        h.fail();
        h.fail();
        h.fail();
        await flushCloud();
        expect(h.clock.timerCount()).toBe(1);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
        expect(h.warn).toHaveBeenCalledTimes(1);
        if (failedOpen !== undefined) {
          await failedOpen[2]({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
          failedOpen[3]!.onReceiveError!(missing, 'receive');
          expect(handler).not.toHaveBeenCalled();
        }
        h.fail();
        await h.clock.advance(999);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
        expect(h.clock.timerCount()).toBe(1);
        await h.clock.advance(1);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(3);
        expect(h.warn).toHaveBeenCalledTimes(1);
        expect(h.clock.timerCount()).toBe(1);
        h.fail();
        await h.clock.advance(1000);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(4);
        expect(h.clock.timerCount()).toBe(0);
        expect(h.opens).toHaveLength(2);
        for (const args of vi.mocked(h.transport.createSubscription).mock.calls)
          expect(args).toEqual(['orders', name, { autoDeleteOnIdleMs: 300000 }]);
        await h.opens[1]!.deliver({ payload: '{"restored":true}', ack: vi.fn(), nack: vi.fn() });
        expect(handler).toHaveBeenCalledExactlyOnceWith(
          { restored: true },
          { topic: 'orders', headers: {} },
        );
        await h.clock.advance(5000);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(4);
        expect(h.warn).toHaveBeenCalledTimes(1);
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
  )('cancels scheduled $stage recovery on $end', async ({ stage, end }) => {
    const h = harness();
    await h.broker.connect();
    try {
      const sub = await h.broker.subscribe('orders', vi.fn(), { fanOut: true });
      if (stage === 'create')
        vi.mocked(h.transport.createSubscription).mockRejectedValueOnce(transient);
      else vi.mocked(h.transport.open).mockRejectedValueOnce(transient);
      h.fail();
      await flushCloud();
      expect(h.clock.timerCount()).toBe(1);
      h.fail();
      h.fail();
      await flushCloud();
      expect(h.clock.timerCount()).toBe(1);
      const creates = vi.mocked(h.transport.createSubscription).mock.calls.length;
      const opens = vi.mocked(h.transport.open).mock.calls.length;
      if (end === 'unsubscribe') await sub.unsubscribe();
      else await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
      h.fail();
      await h.clock.advance(5000);
      expect(h.transport.createSubscription).toHaveBeenCalledTimes(creates);
      expect(h.transport.open).toHaveBeenCalledTimes(opens);
      expect(h.clock.timerCount()).toBe(0);
    } finally {
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });

  it.each(['create', 'open'] as const)(
    'keeps SDK authorization refusal terminal during recovery %s',
    async (stage) => {
      const h = harness();
      await h.broker.connect();
      try {
        await h.broker.subscribe('orders', vi.fn(), { fanOut: true });
        if (stage === 'create')
          vi.mocked(h.transport.createSubscription).mockRejectedValueOnce(unauthorized);
        else vi.mocked(h.transport.open).mockRejectedValueOnce(unauthorized);
        h.fail();
        await flushCloud();
        expect(h.clock.timerCount()).toBe(0);
        expect(h.warn).toHaveBeenCalledTimes(1);
        await h.clock.advance(5000);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(2);
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
  )(
    'cleans an in-flight retry $stage after $end without scheduling more work',
    async ({ stage, end }) => {
      const h = harness();
      const gate = Promise.withResolvers<void>();
      const handler = vi.fn();
      const originalOpen = vi.mocked(h.transport.open).getMockImplementation()!;
      await h.broker.connect();
      try {
        const sub = await h.broker.subscribe('orders', handler, { fanOut: true });
        if (stage === 'create')
          vi.mocked(h.transport.createSubscription)
            .mockRejectedValueOnce(transient)
            .mockReturnValueOnce(gate.promise);
        else
          vi.mocked(h.transport.open)
            .mockRejectedValueOnce(transient)
            .mockImplementationOnce(async (...args) => {
              const opened = await originalOpen(...args);
              await gate.promise;
              return opened;
            });
        h.fail();
        await flushCloud();
        expect(h.clock.timerCount()).toBe(1);
        await h.clock.advance(1000);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(3);
        // Only the in-flight create's bound remains armed.
        expect(h.clock.timerCount()).toBe(stage === 'create' ? 1 : 0);
        h.fail();
        // Inside the recovery create's 5000 ms bound, so the create stays in flight.
        await h.clock.advance(4000);
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(3);
        if (end === 'unsubscribe') await sub.unsubscribe();
        else await h.broker.disconnect();
        const deletes = vi.mocked(h.transport.deleteSubscription).mock.calls.length;
        gate.resolve();
        await flushCloud();
        if (stage === 'create')
          expect(h.transport.deleteSubscription).toHaveBeenCalledTimes(deletes + 1);
        else expect(h.opens[1]!.close).toHaveBeenCalledOnce();
        for (const opened of h.opens)
          await opened.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
        await h.clock.advance(5000);
        expect(handler).not.toHaveBeenCalled();
        expect(h.transport.createSubscription).toHaveBeenCalledTimes(3);
        expect(h.clock.timerCount()).toBe(0);
      } finally {
        gate.resolve();
        await flushCloud();
        await h.broker.disconnect();
        expect(h.clock.timerCount()).toBe(0);
      }
    },
  );

  it('bounds cleanup warnings across repeated failed retry operations', async () => {
    const h = harness();
    await h.broker.connect();
    try {
      await h.broker.subscribe('orders', vi.fn(), { fanOut: true });
      vi.mocked(h.transport.open).mockRejectedValueOnce(transient).mockRejectedValueOnce(transient);
      vi.mocked(h.transport.deleteSubscription).mockRejectedValue(new Error('remote secret'));
      h.fail();
      await flushCloud();
      expect(h.warn).toHaveBeenCalledTimes(2);
      await h.clock.advance(1000);
      expect(h.transport.deleteSubscription).toHaveBeenCalledTimes(2);
      expect(h.warn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(h.warn.mock.calls)).not.toContain('remote secret');
      await h.clock.advance(1000);
      expect(h.opens).toHaveLength(2);
      expect(h.clock.timerCount()).toBe(0);
      expect(h.warn).toHaveBeenCalledTimes(2);
    } finally {
      await h.broker.disconnect();
      expect(h.clock.timerCount()).toBe(0);
    }
  });
});
