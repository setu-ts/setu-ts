import { unusedPort as nodeUnusedPort } from '../../../../test/node-helpers.ts';
/** Real-socket heartbeat exercise for the portable client. */

import { describe, expect, it } from 'vitest';
import { createRealtimeClient } from '../../src/realtime/realtime-client.ts';
import { createRealtimeClientApp } from '../../../../apps/realtime-clients/src/app.ts';

function freePort(): Promise<number> {
  return nodeUnusedPort();
}

describe('createRealtimeClient (e2e)', () => {
  it('keeps a read-only subscriber alive through the real idle sweep', async () => {
    const port = await freePort();
    const app = createRealtimeClientApp();
    await app.start({ port });
    let unexpectedlyClosed = false;
    let stopping = false;
    const client = createRealtimeClient({
      url: `ws://127.0.0.1:${port}/ws/idle`,
      parse: (data) => data,
      reconnect: { maxAttempts: 0 },
      onMessage: () => {},
      onStateChange: (state) => {
        if (state === 'closed' && !stopping) unexpectedlyClosed = true;
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 140));
      expect(unexpectedlyClosed).toBe(false);
    } finally {
      stopping = true;
      client.close();
      await app.stop();
    }
  });
});
