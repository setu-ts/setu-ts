/**
 * Tests for `PushChannel` — token extraction + payload shaping.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NotificationMessage } from '@setu-ts/common';
import type { PushTransport } from '../../src/interfaces/index.ts';
import { PushChannel } from '../../src/channels/push-channel.ts';

describe('PushChannel', () => {
  it('calls transport.send with title when subject is present', async () => {
    let captured: Parameters<PushTransport['send']>[0] | undefined;
    const transport: PushTransport = {
      send: (msg) => {
        captured = msg;
        return Promise.resolve();
      },
    };
    const channel = new PushChannel('push', transport);
    const notification: NotificationMessage = {
      channels: ['push'],
      to: { token: 'device-token-1' },
      subject: 'Alert',
      body: 'Push body',
    };

    await channel.send(notification);

    expect(captured).toBeDefined();
    expect(captured!.to).toBe('device-token-1');
    expect(captured!.body).toBe('Push body');
    expect(captured!.title).toBe('Alert');
  });

  it('omits title when subject is absent (exactOptionalPropertyTypes)', async () => {
    let captured: Parameters<PushTransport['send']>[0] | undefined;
    const transport: PushTransport = {
      send: (msg) => {
        captured = msg;
        return Promise.resolve();
      },
    };
    const channel = new PushChannel('push', transport);
    const notification: NotificationMessage = {
      channels: ['push'],
      to: { token: 'device-token-1' },
      body: 'Push body',
    };

    await channel.send(notification);

    expect(captured).toBeDefined();
    expect(captured!.to).toBe('device-token-1');
    expect(captured!.body).toBe('Push body');
    expect('title' in captured!).toBe(false);
  });

  it('throws when to.token is missing', async () => {
    const transport: PushTransport = {
      send: () => Promise.resolve(),
    };
    const channel = new PushChannel('push', transport);
    const notification: NotificationMessage = {
      channels: ['push'],
      to: {},
      body: 'Push body',
    };

    await expect(channel.send(notification)).rejects.toThrow(
      'Push channel requires "to.token"',
    );
  });
});
