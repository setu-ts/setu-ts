import { describe, expect, it, vi } from 'vitest';
import { ServiceBusError } from '@azure/service-bus';
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
    ...['ServiceCommunicationProblem', 'ServiceTimeout', 'ServiceBusy'].map((code) => ({
      error: new ServiceBusError('outage', code as 'ServiceBusy'),
      outage: true,
    })),
    ...[
      'MessagingEntityNotFound',
      'UnauthorizedAccess',
      'MessageSizeExceeded',
      'QuotaExceeded',
    ].map((code) => ({
      error: Object.assign(new ServiceBusError('refused', code as 'QuotaExceeded'), {
        retryable: false,
      }),
      outage: false,
    })),
    {
      error: Object.assign(new Error('retryable'), { code: 'other', retryable: true }),
      outage: true,
    },
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
        expect(result).toMatchObject({ cause: { message: 'last failure', cause: error } });
    } else {
      expect(result).toBe(error);
      expect(await broker.reachability()).toBeUndefined();
    }
    await broker.disconnect();
  });
  it('handles raw and empty aggregate causes', () => {
    expect(isServiceBusOutage(null)).toBe(true);
    expect(isServiceBusOutage('socket')).toBe(true);
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
