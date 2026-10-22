import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  freePort,
  skip,
  SOURCE_HOST_ARGS,
  startHost,
  stopHost,
  waitForHttp,
} from '../smoke-helpers.ts';
import type { Host } from '../smoke-helpers.ts';

const redisUrl = process.env['REDIS_URL'] ?? skip('set REDIS_URL to run the two-replica check.');

/**
 * Starts one replica in a process of its own.
 *
 * Two replicas in one process would share the backplane's in-process
 * transport, so the check would pass with no cross-replica delivery at all.
 */
async function startReplica(): Promise<{ host: Host; baseUrl: string }> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const host = startHost(process.execPath, [...SOURCE_HOST_ARGS, 'main.ts', String(port)], {
    ...process.env,
    REDIS_URL: redisUrl,
  });
  // Any answer proves the socket is bound; this path is deliberately unrouted.
  await waitForHttp(`${baseUrl}/__ready`, { label: `Replica on port ${port}` });
  return { host, baseUrl };
}

/** Reads an SSE stream until a `data:` line carrying the expected message arrives. */
async function readUntil(stream: ReadableStream<Uint8Array>, expected: string): Promise<void> {
  const decoder = new TextDecoder();
  let received = '';
  for await (const chunk of stream) {
    received += decoder.decode(chunk, { stream: true });
    if (received.includes(`data: ${expected}`)) return;
  }
  throw new Error('The SSE stream closed before the message arrived.');
}

describe('realtime example', () => {
  const replicas: { host: Host; baseUrl: string }[] = [];
  const streaming = new AbortController();

  before(async () => {
    replicas.push(await startReplica(), await startReplica());
  });

  after(async () => {
    streaming.abort();
    await Promise.all(replicas.map(({ host }) => stopHost(host)));
  });

  it('delivers a message published on replica A to a subscriber on replica B', async () => {
    const [publisher, subscriber] = replicas;
    const events = await fetch(`${subscriber!.baseUrl}/events`, { signal: streaming.signal });
    assert.ok(events.ok && events.body !== null, 'replica B did not open an SSE stream');
    const delivered = readUntil(events.body, 'from-replica-a');

    const published = await fetch(`${publisher!.baseUrl}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'from-replica-a' }),
    });
    assert.equal(published.status, 204);

    await Promise.race([
      delivered,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Timed out waiting for replica B.')), 5_000).unref();
      }),
    ]);
  });
});
