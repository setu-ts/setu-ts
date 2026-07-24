/**
 * Tests for `NotificationService` — parallel fan-out + `AggregateError`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NotificationChannel } from '../../src/interfaces/index.ts';
import { NotificationService } from '../../src/services/notification-service.ts';

describe('NotificationService', () => {
  it('resolves when channels array is empty', async () => {
    const service = new NotificationService(new Map());
    await expect(
      service.send({ channels: [], to: {}, body: 'hello' }),
    ).resolves.toBeUndefined();
  });

  it('dispatches to all requested channels on success', async () => {
    const calls: string[] = [];
    const channelA: NotificationChannel = {
      name: 'a',
      send: (): Promise<void> => {
        calls.push('a');
        return Promise.resolve();
      },
    };
    const channelB: NotificationChannel = {
      name: 'b',
      send: (): Promise<void> => {
        calls.push('b');
        return Promise.resolve();
      },
    };
    const map = new Map([['a', channelA], ['b', channelB]]);
    const service = new NotificationService(map);

    await service.send({
      channels: ['a', 'b'],
      to: {},
      body: 'hello',
    });

    expect(calls).toEqual(['a', 'b']);
  });

  it('throws AggregateError when one channel rejects with an Error and other still runs', async () => {
    const otherCalled: string[] = [];
    const failingChannel: NotificationChannel = {
      name: 'fail',
      send: (): Promise<void> => {
        throw new Error('boom');
      },
    };
    const workingChannel: NotificationChannel = {
      name: 'ok',
      send: (): Promise<void> => {
        otherCalled.push('ok');
        return Promise.resolve();
      },
    };
    const map = new Map([['fail', failingChannel], ['ok', workingChannel]]);
    const service = new NotificationService(map);

    try {
      await service.send({
        channels: ['fail', 'ok'],
        to: {},
        body: 'hello',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const aggErr = err as AggregateError;
      expect(aggErr.errors.length).toBe(1);
      expect(aggErr.errors[0].message).toBe('boom');
      expect(otherCalled).toEqual(['ok']);
      return;
    }
    throw new Error('expected to have thrown');
  });

  it('throws AggregateError when one channel rejects with a non-Error value', async () => {
    const map = new Map<string, NotificationChannel>([
      [
        'fail',
        {
          name: 'fail',
          send: (): Promise<void> => {
            throw 'string-rejection';
          },
        },
      ],
    ]);
    const service = new NotificationService(map);

    try {
      await service.send({
        channels: ['fail'],
        to: {},
        body: 'hello',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const aggErr = err as AggregateError;
      expect(aggErr.errors.length).toBe(1);
      expect(aggErr.errors[0]).toBeInstanceOf(Error);
      expect(aggErr.errors[0].message).toBe('string-rejection');
      return;
    }
    throw new Error('expected to have thrown');
  });

  it('throws AggregateError for unknown channel name', async () => {
    const map = new Map<string, NotificationChannel>();
    const service = new NotificationService(map);

    try {
      await service.send({
        channels: ['nonexistent'],
        to: {},
        body: 'hello',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const aggErr = err as AggregateError;
      expect(aggErr.errors.length).toBe(1);
      expect(aggErr.errors[0].message).toContain('Unknown notification channel: nonexistent');
      return;
    }
    throw new Error('expected to have thrown');
  });

  it('aggregates errors from all failing channels', async () => {
    const map = new Map<string, NotificationChannel>([
      [
        'a',
        {
          name: 'a',
          send: (): Promise<void> => {
            throw new Error('err-a');
          },
        },
      ],
      [
        'b',
        {
          name: 'b',
          send: (): Promise<void> => {
            throw new Error('err-b');
          },
        },
      ],
    ]);
    const service = new NotificationService(map);

    try {
      await service.send({
        channels: ['a', 'b'],
        to: {},
        body: 'hello',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const aggErr = err as AggregateError;
      expect(aggErr.errors.length).toBe(2);
      return;
    }
    throw new Error('expected to have thrown');
  });

  it('throws single AggregateError for a single failing channel', async () => {
    const map = new Map<string, NotificationChannel>([
      [
        'x',
        {
          name: 'x',
          send: (): Promise<void> => {
            throw new Error('single-fail');
          },
        },
      ],
    ]);
    const service = new NotificationService(map);

    await expect(
      service.send({
        channels: ['x'],
        to: {},
        body: 'hello',
      }),
    ).rejects.toBeInstanceOf(AggregateError);
  });
});
