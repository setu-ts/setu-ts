/**
 * Unit tests for the settled notification surface (X8-12).
 *
 * A two-channel fan-out with one failure asserts `send` still throws an
 * `AggregateError` whose members name the channel, and that `sendSettled`
 * throws nothing and reports one `ok: false` naming the same channel. The
 * remaining cases pin `sendSettled`'s branches: the empty-channel early return,
 * an all-success fan-out, and an unknown channel.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ChannelSendResult, NotificationMessage } from '@setu-ts/common';

import { NotificationService } from '../../src/services/notification-service.ts';
import type { NotificationChannel } from '../../src/interfaces/index.ts';

function channel(name: string, fail?: unknown): NotificationChannel {
  return {
    name,
    send: (): Promise<void> => {
      if (fail !== undefined) {
        throw fail;
      }
      return Promise.resolve();
    },
  };
}

const message = (channels: string[]): NotificationMessage => ({
  channels,
  to: {},
  body: 'hello',
});

describe('sendSettled', () => {
  it('reports one ok:false naming the failing channel while send still throws', async () => {
    const service = new NotificationService(
      new Map([
        ['email', channel('email')],
        ['sms', channel('sms', new Error('sms down'))],
      ]),
    );

    // `send` throws an AggregateError whose member names the channel.
    let threw: unknown;
    try {
      await service.send(message(['email', 'sms']));
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(AggregateError);
    const members = (threw as AggregateError).errors as Error[];
    expect(members.map((e) => e.message)).toEqual(["channel 'sms' failed"]);
    expect((members[0].cause as Error).message).toBe('sms down');

    // `sendSettled` throws nothing and reports the same channel as failed.
    const results = await service.sendSettled(message(['email', 'sms']));
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ channel: 'email', ok: true });
    expect(results[1].ok).toBe(false);
    if (results[1].ok === false) {
      expect(results[1].channel).toBe('sms');
      expect(results[1].error.message).toBe('sms down');
    }
  });

  it('returns an empty array for an empty channel list', async () => {
    const service = new NotificationService(new Map());
    await expect(service.sendSettled(message([]))).resolves.toEqual([]);
  });

  it('reports every channel ok on a full success', async () => {
    const service = new NotificationService(
      new Map([
        ['email', channel('email')],
        ['sms', channel('sms')],
      ]),
    );

    const results: readonly ChannelSendResult[] = await service.sendSettled(
      message(['email', 'sms']),
    );
    expect(results).toEqual([
      { channel: 'email', ok: true },
      { channel: 'sms', ok: true },
    ]);
  });

  it('reports an unknown channel as ok:false with the unknown-channel error', async () => {
    const service = new NotificationService(new Map([['email', channel('email')]]));

    const results = await service.sendSettled(message(['email', 'carrier-pigeon']));
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ channel: 'email', ok: true });
    expect(results[1].ok).toBe(false);
    if (results[1].ok === false) {
      expect(results[1].channel).toBe('carrier-pigeon');
      expect(results[1].error.message).toContain('Unknown notification channel: carrier-pigeon');
    }
  });
});
