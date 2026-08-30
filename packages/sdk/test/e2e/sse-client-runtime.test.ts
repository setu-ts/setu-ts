/** Real-server SSE client exercise. */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createSseClient } from '../../src/realtime/sse-client.ts';
import { createRealtimeClientApp } from '../../../../apps/realtime-clients/src/app.ts';

function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr as Deno.NetAddr;
  listener.close();
  return address.port;
}

describe('createSseClient (e2e)', () => {
  it('sends bearer credentials, filters heartbeats, and resumes after a cut stream', async () => {
    const port = freePort();
    const app = createRealtimeClientApp();
    await app.start({ port });
    const events: Array<{ readonly id?: string }> = [];
    let resolveEvents: (() => void) | undefined;
    const complete = new Promise<void>((resolve) => resolveEvents = resolve);
    const client = createSseClient({
      url: `http://127.0.0.1:${port}/events`,
      headers: { authorization: 'Bearer smoke-token' },
      reconnect: { delayMs: 1, maxAttempts: 3 },
      onEvent: (event) => {
        events.push(event);
        if (events.length === 2) resolveEvents?.();
      },
    });
    try {
      await Promise.race([
        complete,
        new Promise<void>((_resolve, reject) =>
          setTimeout(() => reject(new Error('timed out')), 2_000)
        ),
      ]);
      client.close();
      const resume = await (await fetch(`http://127.0.0.1:${port}/resume`)).json() as {
        readonly resumedWith: string | null;
      };
      expect(events).toHaveLength(2);
      expect(events.some((event) => event.id === undefined)).toBe(false);
      expect(resume.resumedWith).toBe(events[0]?.id);
    } finally {
      client.close();
      await app.stop();
    }
  });
});
