import { describe, expect, it, vi } from 'vitest';
import { serviceBusFaults } from '../fixtures/service-bus-errors.ts';
import { BackendOutcomeUnknownError, httpStatusHintOf } from '@setu-ts/common';
import { ServiceBusBroker, MessagingPlugin, PublishTimeoutError } from '../../src/index.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { serviceBusTransport, flushCloud } from '../fixtures/cloud-transports.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import {
  isServiceBusOutage,
  serviceBusPublishCause,
} from '../../src/brokers/service-bus-faults.ts';

describe('Service Bus publish bound', () => {
  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
  ])('classifies raw socket %s as an uncertain publish and records an outage', async (code) => {
    const error = Object.assign(new Error('socket failed'), { code });
    const h = serviceBusTransport();
    vi.mocked(h.transport.send).mockRejectedValueOnce(error);
    const broker = new ServiceBusBroker(clockRuntime().runtime, new JsonSerializer(), {
      client: h.transport,
    });
    await broker.connect();
    try {
      const result: unknown = await broker
        .publish('orders', {})
        .catch((failure: unknown) => failure);
      expect(result).toBeInstanceOf(BackendOutcomeUnknownError);
      expect(httpStatusHintOf(result)?.status).toBe(504);
      expect((result as Error).cause).toBe(error);
      expect(isServiceBusOutage(error)).toBe(true);
      expect(await broker.reachability()).toBe(false);
    } finally {
      await broker.disconnect();
    }
  });
  it.each(
    [404, 500, NaN, Infinity].flatMap((statusCode) =>
      [false, true].map((positive) => ({ statusCode, positive })),
    ),
  )(
    'preserves a status-only rejection $statusCode and prior positive=$positive evidence',
    async ({ statusCode, positive }) => {
      const error = Object.assign(new Error('status refusal'), { statusCode });
      const h = serviceBusTransport();
      const broker = new ServiceBusBroker(clockRuntime().runtime, new JsonSerializer(), {
        client: h.transport,
      });
      await broker.connect();
      try {
        if (positive) await broker.publish('orders', {});
        vi.mocked(h.transport.send).mockRejectedValueOnce(error);
        await expect(broker.publish('orders', {})).rejects.toBe(error);
        expect(isServiceBusOutage(error)).toBe(false);
        expect(await broker.reachability()).toBe(positive ? true : undefined);
      } finally {
        await broker.disconnect();
      }
    },
  );

  it('uses SDK translations, including retryable authorization refusals', () => {
    for (const { error, code } of serviceBusFaults) expect(error).toMatchObject({ code });
    expect(serviceBusFaults.find(({ code }) => code === 'UnauthorizedAccess')!.error).toMatchObject(
      { retryable: true },
    );
  });
  it('treats a translated session lock loss as an outage only inside an aggregate', () => {
    const { error } = serviceBusFaults.find(({ code }) => code === 'SessionLockLost')!;
    expect(error).toMatchObject({ code: 'SessionLockLost', retryable: false });
    expect(isServiceBusOutage(error)).toBe(false);
    expect(isServiceBusOutage(new AggregateError([new Error('earlier socket'), error]))).toBe(true);
  });
  it.each(
    (['rejection', 'deadline', 'success'] as const).flatMap((outcome) =>
      [false, true].map((reconnect) => ({ outcome, reconnect })),
    ),
  )(
    'fences late $outcome evidence after disconnect, reconnect=$reconnect',
    async ({ outcome, reconnect }) => {
      const clock = clockRuntime();
      const h = serviceBusTransport();
      const pending = Promise.withResolvers<void>();
      vi.mocked(h.transport.send).mockReturnValueOnce(pending.promise);
      const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
        client: h.transport,
        publishTimeoutMs: 25,
      });
      await broker.connect();
      const result = broker.publish('orders', {}).catch((error: unknown) => error);
      await flushCloud();
      await broker.disconnect();
      expect(await broker.reachability()).toBeUndefined();
      if (reconnect) await broker.connect();
      if (outcome === 'deadline') await clock.advance(25);
      else if (outcome === 'rejection') pending.reject(new Error('old socket'));
      else pending.resolve();
      await result;
      expect(await broker.reachability()).toBeUndefined();
      await broker.disconnect();
    },
  );
  it.each([false, true])(
    'fences a send begun during transport close, reconnect=%s',
    async (reconnect) => {
      const h = serviceBusTransport();
      const closeEntered = Promise.withResolvers<void>();
      const closeGate = Promise.withResolvers<void>();
      const sendEntered = Promise.withResolvers<void>();
      const sendGate = Promise.withResolvers<void>();
      vi.mocked(h.transport.close).mockImplementationOnce(() => {
        closeEntered.resolve();
        return closeGate.promise;
      });
      vi.mocked(h.transport.send).mockImplementationOnce(() => {
        sendEntered.resolve();
        return sendGate.promise;
      });
      const broker = new ServiceBusBroker(clockRuntime().runtime, new JsonSerializer(), {
        client: h.transport,
      });
      await broker.connect();
      const closing = broker.disconnect();
      await closeEntered.promise;
      const result = broker.publish('orders', {}).catch((error: unknown) => error);
      await sendEntered.promise;
      closeGate.resolve();
      await closing;
      if (reconnect) await broker.connect();
      sendGate.reject(new Error('retired socket'));
      expect(await result).toBeInstanceOf(BackendOutcomeUnknownError);
      expect(await broker.reachability()).toBeUndefined();
      await broker.disconnect();
    },
  );
  it('keeps an in-flight send current across an already-ready connect', async () => {
    const h = serviceBusTransport();
    const pending = Promise.withResolvers<void>();
    vi.mocked(h.transport.send).mockReturnValueOnce(pending.promise);
    const broker = new ServiceBusBroker(clockRuntime().runtime, new JsonSerializer(), {
      client: h.transport,
    });
    await broker.connect();
    const result = broker.publish('orders', {});
    await flushCloud();
    await broker.connect();
    pending.resolve();
    await result;
    expect(await broker.reachability()).toBe(true);
    await broker.disconnect();
  });
  it.each([0, 25, undefined])(
    'bounds the whole send with %s and aborts on expiry',
    async (timeout) => {
      const clock = clockRuntime();
      const h = serviceBusTransport();
      const pending = Promise.withResolvers<void>();
      vi.mocked(h.transport.send).mockReturnValue(pending.promise);
      const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
        client: h.transport,
        ...(timeout === undefined ? {} : { publishTimeoutMs: timeout }),
      });
      await broker.connect();
      const result = broker.publish('orders', {}).catch((error: unknown) => error);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await flushCloud();
      const signal = vi.mocked(h.transport.send).mock.calls[0]![4]!.abortSignal!;
      await clock.advance(timeout === 0 ? 16000 : (timeout ?? 15000) - 1);
      expect(settled).toBe(false);
      if (timeout === 0) {
        pending.resolve();
        await result;
        expect(signal.aborted).toBe(false);
      } else {
        await clock.advance(1);
        expect(await result).toBeInstanceOf(PublishTimeoutError);
        expect(signal.aborted).toBe(true);
        expect(await broker.reachability()).toBe(false);
      }
      await broker.disconnect();
    },
  );

  const cases = [
    ...serviceBusFaults,
    ...serviceBusFaults.map(({ error, aggregateOutage, code }) => ({
      code: `aggregate-${code}`,
      error: new AggregateError([new Error('earlier socket'), error]),
      outage: aggregateOutage,
    })),
    { error: new Error('socket'), outage: true },
    { error: new AggregateError([new Error('first'), new Error('last failure')]), outage: true },
  ];
  it.each(cases)('classifies $error.code with outage=$outage', async ({ error, outage }) => {
    const h = serviceBusTransport();
    vi.mocked(h.transport.send).mockRejectedValue(error);
    const broker = new ServiceBusBroker(clockRuntime().runtime, new JsonSerializer(), {
      client: h.transport,
    });
    await broker.connect();
    expect(isServiceBusOutage(error)).toBe(outage);
    const result: unknown = await broker.publish('orders', {}).catch((caught: unknown) => caught);
    if (outage) {
      expect(result).toBeInstanceOf(BackendOutcomeUnknownError);
      expect(httpStatusHintOf(result)?.status).toBe(504);
      expect(await broker.reachability()).toBe(false);
      if (error instanceof AggregateError)
        expect(result).toMatchObject({
          cause: { message: error.errors.at(-1).message, cause: error },
        });
    } else {
      expect(result).toBe(error);
      expect(await broker.reachability()).toBeUndefined();
    }
    await broker.disconnect();
  });
  it('handles raw and empty aggregate causes', () => {
    expect(isServiceBusOutage(null)).toBe(true);
    expect(isServiceBusOutage('socket')).toBe(true);
    expect(isServiceBusOutage(new AggregateError([]))).toBe(true);
    expect(isServiceBusOutage(new AggregateError([null]))).toBe(true);
    expect(isServiceBusOutage(new AggregateError(['last']))).toBe(true);
    expect(serviceBusPublishCause(new AggregateError([], 'empty'))).toMatchObject({
      message: 'empty',
    });
    expect(serviceBusPublishCause(new AggregateError(['last']))).toMatchObject({ message: 'last' });
  });
  it.each([-1, NaN, Infinity, 2147483648])(
    'refuses bound %s in both plugin arms and standalone',
    (publishTimeoutMs) => {
      expect(() =>
        MessagingPlugin({ broker: 'service-bus', connectionString: 'x', publishTimeoutMs }),
      ).toThrow(RangeError);
      expect(() =>
        MessagingPlugin({
          broker: 'service-bus',
          client: serviceBusTransport().transport,
          publishTimeoutMs,
        }),
      ).toThrow(RangeError);
      expect(
        () =>
          new ServiceBusBroker(clockRuntime().runtime, new JsonSerializer(), { publishTimeoutMs }),
      ).toThrow(RangeError);
    },
  );
});
