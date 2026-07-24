/**
 * Tests for `SlackChannel` — channel extraction + payload shaping.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NotificationMessage } from '@hono-enterprise/common';
import type { SlackTransport } from '../../src/interfaces/index.ts';
import { SlackChannel } from '../../src/channels/slack-channel.ts';

describe('SlackChannel', () => {
  it('calls transport.send with channel when to.channel is present', async () => {
    let captured: Parameters<SlackTransport['send']>[0] | undefined;
    const transport: SlackTransport = {
      send: (msg) => {
        captured = msg;
        return Promise.resolve();
      },
    };
    const channel = new SlackChannel('slack', transport);
    const notification: NotificationMessage = {
      channels: ['slack'],
      to: { channel: '#general' },
      body: 'Alert!',
    };

    await channel.send(notification);

    expect(captured).toBeDefined();
    expect(captured!.text).toBe('Alert!');
    expect(captured!.channel).toBe('#general');
  });

  it('omits channel when to.channel is absent (exactOptionalPropertyTypes)', async () => {
    let captured: Parameters<SlackTransport['send']>[0] | undefined;
    const transport: SlackTransport = {
      send: (msg) => {
        captured = msg;
        return Promise.resolve();
      },
    };
    const channel = new SlackChannel('slack', transport);
    const notification: NotificationMessage = {
      channels: ['slack'],
      to: {},
      body: 'Alert!',
    };

    await channel.send(notification);

    expect(captured).toBeDefined();
    expect(captured!.text).toBe('Alert!');
    expect('channel' in captured!).toBe(false);
  });
});
