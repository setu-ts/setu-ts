// deno-lint-ignore-file no-console -- a skipped prerequisite must be visible in CI.
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

/**
 * Starts one replica in a process of its own.
 *
 * Separate processes are the whole point of this check: both replicas inside a
 * single process would be carried by the backplane's process-local `'memory'`
 * transport, so the check would stay green with no cross-replica delivery at
 * all — the exact demonstration this example exists to make.
 */
function spawnReplica(port: number, url: string): Deno.ChildProcess {
  return new Deno.Command('deno', {
    args: ['run', '-A', 'main.ts', String(port)],
    env: { REDIS_URL: url },
    stdout: 'null',
    stderr: 'inherit',
  }).spawn();
}

async function waitForReady(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      // Any answer proves the socket is bound; this path is deliberately unrouted.
      await fetch(`http://127.0.0.1:${port}/__ready`, {
        signal: AbortSignal.timeout(250),
      }).then((response) => response.body?.cancel());
      return;
    } catch {
      // The replica has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Replica on port ${port} did not start within ten seconds.`);
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
const replicaA = spawnReplica(replicaAPort, redisUrl);
const replicaB = spawnReplica(replicaBPort, redisUrl);
const streaming = new AbortController();

try {
  await waitForReady(replicaAPort);
  await waitForReady(replicaBPort);
  const events = await fetch(`http://127.0.0.1:${replicaBPort}/events`, {
    signal: streaming.signal,
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
  streaming.abort();
  for (const replica of [replicaA, replicaB]) {
    replica.kill('SIGTERM');
  }
  await Promise.all([replicaA.status, replicaB.status]);
}
