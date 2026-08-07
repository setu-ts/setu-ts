/**
 * Tests for `SlackChannel` — channel extraction + payload shaping.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NotificationMessage } from '@setu-ts/common';
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

  it('treats an empty to.channel as absent (Slack rejects channel: "")', async () => {
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
      // A configured channel name that resolved to the empty string.
      to: { channel: '' },
      body: 'Alert!',
    };

    await channel.send(notification);

    expect(captured).toBeDefined();
    expect(captured!.text).toBe('Alert!');
    // Forwarding `channel: ''` would make the webhook reject the whole message;
    // omitting it posts to the webhook's default channel.
    expect('channel' in captured!).toBe(false);
  });
});
