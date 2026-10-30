import { describe, expect, it } from 'vitest';

import { LogProvider } from '../../src/providers/log-provider.ts';
import type { ILogger } from '@setu-ts/common';
import type { OutgoingMail } from '../../src/interfaces/index.ts';

const MESSAGE: OutgoingMail = {
  from: 'me@x.com',
  to: ['a@x.com', 'b@x.com'],
  subject: 'Hi',
  text: 'yo',
};

describe('LogProvider', () => {
  it('D5 retains the latest 1,000 messages in order while forwarding all 1,001 to the sink', async () => {
    const sunk: OutgoingMail[] = [];
    const provider = new LogProvider({ sink: (message) => sunk.push(message) });
    await provider.connect();
    try {
      for (let i = 0; i < 1_001; i++) {
        await provider.send({ ...MESSAGE, subject: `message-${i}` });
      }
      expect(sunk).toHaveLength(1_001);
      expect(provider.messages).toHaveLength(1_000);
      expect(provider.messages).toEqual(sunk.slice(1));
    } finally {
      await provider.disconnect();
    }
  });

  it('records, forwards to the sink, and logs via the injected logger', async () => {
    const sunk: OutgoingMail[] = [];
    const logged: Array<{ msg: string; meta?: Record<string, unknown> | undefined }> = [];
    const logger = {
      info: (msg: string, meta?: Record<string, unknown>): void => {
        logged.push({ msg, meta });
      },
      debug: (): void => {},
      warn: (): void => {},
      error: (): void => {},
    } as unknown as ILogger;

    const provider = new LogProvider({ logger, sink: (m) => sunk.push(m) });
    await provider.connect();
    expect(provider.isReady()).toBe(true);

    await provider.send(MESSAGE);

    expect(provider.messages).toEqual([MESSAGE]);
    expect(sunk).toEqual([MESSAGE]);
    expect(logged[0]?.meta?.to).toBe('a@x.com, b@x.com');
    expect(logged[0]?.meta?.subject).toBe('Hi');

    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
  });

  it('works with no logger and no sink, and joins a single recipient string', async () => {
    const provider = new LogProvider();
    await provider.connect();
    await provider.send({ from: 'me@x.com', to: 'solo@x.com', subject: 'S' });
    expect(provider.messages).toHaveLength(1);
    expect(provider.messages[0]?.to).toBe('solo@x.com');
  });

  it('rejects a send before connect and after disconnect, recording nothing', async () => {
    // The SMTP and SES providers refuse a send outside connect..disconnect;
    // the log provider recorded it, so a send after app.stop() reported
    // success. Observed through `.catch`, so a synchronous throw would fail.
    const sunk: OutgoingMail[] = [];
    const provider = new LogProvider({ sink: (m) => sunk.push(m) });
    const before = await provider.send(MESSAGE).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(before).toBe('LogProvider is not connected');

    await provider.connect();
    await provider.disconnect();
    const after = await provider.send(MESSAGE).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(after).toBe('LogProvider is not connected');

    expect(provider.messages).toHaveLength(0);
    expect(sunk).toHaveLength(0);
  });
});
