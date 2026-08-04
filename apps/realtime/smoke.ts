// deno-lint-ignore-file no-console -- a skipped prerequisite must be visible in CI.
import { createRealtimeReplica } from './src/app.ts';
const redisUrl = Deno.env.get('REDIS_URL');
if (redisUrl === undefined) {
  console.warn(
    'SKIP: set REDIS_URL to run the two-replica realtime backplane smoke check.',
  );
  Deno.exit(77);
}

function unusedPort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr;
  listener.close();
  if (!('port' in address)) throw new Error('Expected a TCP listener.');
  return address.port;
}

async function readMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<void> {
  const decoder = new TextDecoder();
  let received = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(
        'SSE stream closed before the cross-replica event arrived.',
      );
    }
    received += decoder.decode(value, { stream: true });
    if (received.includes(`data: ${expected}`)) return;
  }
}

const replicaAPort = unusedPort();
const replicaBPort = unusedPort();
const replicaA = createRealtimeReplica(redisUrl);
const replicaB = createRealtimeReplica(redisUrl);
const signal = new AbortController();

try {
  await replicaA.start({ port: replicaAPort });
  await replicaB.start({ port: replicaBPort });
  const events = await fetch(`http://127.0.0.1:${replicaBPort}/events`, {
    signal: signal.signal,
  });
  if (events.body === null || !events.ok) {
    throw new Error('Replica B did not open an SSE stream.');
  }

  const expected = 'from-replica-a';
  const delivered = readMessage(events.body.getReader(), expected);
  const published = await fetch(`http://127.0.0.1:${replicaAPort}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: expected }),
  });
  if (published.status !== 204) {
    throw new Error(`Replica A publish returned ${published.status}.`);
  }

  await Promise.race([
    delivered,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('Timed out waiting for replica B.')),
        5_000,
      );
    }),
  ]);
} finally {
  signal.abort();
  await Promise.all([replicaA.stop(), replicaB.stop()]);
}
