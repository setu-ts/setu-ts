/**
 * The Slack channel carries the notification's `subject` (V13-257), escaped so
 * it cannot inject a mention, and the real provider posts it over HTTP.
 *
 * @module
 */
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { escapeSlackText, SlackChannel } from '../../src/channels/slack-channel.ts';
import { SlackProvider } from '../../src/providers/slack-provider.ts';
import type { SlackMessage } from '../../src/interfaces/index.ts';

function recordingChannel(): { channel: SlackChannel; sent: SlackMessage[] } {
  const sent: SlackMessage[] = [];
  const channel = new SlackChannel('slack', {
    send: (message: SlackMessage) => {
      sent.push(message);
      return Promise.resolve();
    },
  });
  return { channel, sent };
}

describe('Slack subject (V13-257)', () => {
  it('leads the text with the subject in bold, then the body', async () => {
    const { channel, sent } = recordingChannel();
    await channel.send({
      channels: ['slack'],
      to: { channel: '#deploys' },
      subject: 'Deploy finished',
      body: 'Build 412 is live.',
    });
    expect(sent).toEqual([{ text: '*Deploy finished*\nBuild 412 is live.', channel: '#deploys' }]);
  });

  it('sends the body alone without a subject or with an empty one', async () => {
    const { channel, sent } = recordingChannel();
    await channel.send({ channels: ['slack'], to: {}, body: 'plain' });
    await channel.send({ channels: ['slack'], to: {}, subject: '', body: 'plain' });
    expect(sent).toEqual([{ text: 'plain' }, { text: 'plain' }]);
  });

  it('escapes the subject so it cannot ping the channel', async () => {
    const { channel, sent } = recordingChannel();
    await channel.send({ channels: ['slack'], to: {}, subject: '<!channel> & co', body: 'b' });
    expect(sent[0]!.text).toBe('*&lt;!channel&gt; &amp; co*\nb');
    expect(escapeSlackText('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });

  it('the real provider posts the subject on the wire', async () => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        bodies.push(body);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const channel = new SlackChannel(
        'slack',
        new SlackProvider({ webhookUrl: `http://127.0.0.1:${port}/hook` }),
      );
      await channel.send({
        channels: ['slack'],
        to: { channel: '#deploys' },
        subject: 'Deploy finished',
        body: 'Build 412 is live.',
      });
      expect(JSON.parse(bodies[0]!)).toEqual({
        text: '*Deploy finished*\nBuild 412 is live.',
        channel: '#deploys',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
