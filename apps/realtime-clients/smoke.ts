import { exerciseRealtimeClients } from './driver.ts';

function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr as Deno.NetAddr;
  listener.close();
  return address.port;
}

/**
 * Waits for a server to answer, naming it if it never does.
 *
 * Two different servers are awaited below — the Deno host and the workerd one —
 * so a fixed message reports the wrong one. The CI failure this replaces said
 * "Realtime client server did not start" while that host was already serving
 * and it was workerd that had not appeared.
 *
 * @param baseUrl - Origin to poll
 * @param label - Which server this is, used in the failure
 */
async function waitForServer(baseUrl: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await fetch(`${baseUrl}/resume`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`${label} did not start within ten seconds.`);
}

async function run(command: string, args: readonly string[]): Promise<void> {
  const outcome = await new Deno.Command(command, {
    args: [...args],
    stdout: 'inherit',
    stderr: 'inherit',
  })
    .output();
  if (!outcome.success) throw new Error(`${command} realtime driver failed.`);
}

const serverPort = freePort();
const baseUrl = `http://127.0.0.1:${serverPort}`;
const server = new Deno.Command('deno', {
  args: ['run', '-A', 'main.ts', String(serverPort)],
  stdout: 'null',
  stderr: 'inherit',
}).spawn();

try {
  await waitForServer(baseUrl, 'Realtime client server');
  await exerciseRealtimeClients(baseUrl);
  await run('node', ['--experimental-strip-types', 'driver.ts', baseUrl]);
  await run('bun', ['driver.ts', baseUrl]);

  // `npx wrangler` installs the package on first use, and on a cold runner that
  // download costs far more than waitForServer's ten-second budget — so the
  // server was up while the probe had already given up. Measured: resolving it
  // first costs ~1.2s warm, after which `wrangler dev` binds in ~1.3s, well
  // inside the budget. Paying it here leaves the window timing startup only.
  //
  // `run` throws on failure, so a genuinely unavailable wrangler is a named
  // error rather than a timeout blamed on the server. apps/cloudflare takes the
  // other route for the same prerequisite — it probes the BARE `wrangler`
  // binary and skips when absent — which is why that check skips on CI while
  // this one runs.
  await run('npx', ['--yes', 'wrangler', '--version']);

  const workerdPort = freePort();
  const worker = new Deno.Command('npx', {
    args: [
      'wrangler',
      'dev',
      'worker.ts',
      '--port',
      String(workerdPort),
      '--log-level',
      'error',
    ],
    stdout: 'null',
    stderr: 'inherit',
  }).spawn();
  try {
    await waitForServer(`http://127.0.0.1:${workerdPort}`, 'workerd client host');
    const response = await fetch(
      `http://127.0.0.1:${workerdPort}/?baseUrl=${encodeURIComponent(baseUrl)}`,
    );
    if (!response.ok) {
      throw new Error(`workerd client driver returned ${response.status}.`);
    }
  } finally {
    worker.kill('SIGTERM');
    await worker.status;
  }
} finally {
  try {
    server.kill('SIGTERM');
  } catch {
    // A startup failure already terminated the child; preserve its original error.
  }
  await server.status;
}
