/**
 * Tests for `SmsChannel` — address extraction + payload shaping.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NotificationMessage } from '@setu-ts/common';
import type { SmsTransport } from '../../src/interfaces/index.ts';
import { SmsChannel } from '../../src/channels/sms-channel.ts';

describe('SmsChannel', () => {
  it('calls transport.send with correct SmsMessage shape', async () => {
    let captured: Parameters<SmsTransport['send']>[0] | undefined;
    const transport: SmsTransport = {
      send: (msg) => {
        captured = msg;
        return Promise.resolve();
      },
    };
    const channel = new SmsChannel('sms', transport);
    const notification: NotificationMessage = {
      channels: ['sms'],
      to: { phone: '+1234567890' },
      body: 'SMS body',
    };

    await channel.send(notification);

    expect(captured).toBeDefined();
    expect(captured!.to).toBe('+1234567890');
    expect(captured!.body).toBe('SMS body');
    expect(channel.name).toBe('sms');
  });

  it('throws when to.phone is missing', async () => {
    const transport: SmsTransport = {
      send: () => Promise.resolve(),
    };
    const channel = new SmsChannel('sms', transport);
    const notification: NotificationMessage = {
      channels: ['sms'],
      to: {},
      body: 'SMS body',
    };

    await expect(channel.send(notification)).rejects.toThrow(
      'SMS channel requires "to.phone"',
    );
  });
});
