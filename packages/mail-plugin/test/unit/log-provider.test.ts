import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

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
    await provider.send({ from: 'me@x.com', to: 'solo@x.com', subject: 'S' });
    expect(provider.messages).toHaveLength(1);
    expect(provider.messages[0]?.to).toBe('solo@x.com');
  });
});
