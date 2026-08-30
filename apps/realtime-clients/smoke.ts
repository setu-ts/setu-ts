import { exerciseRealtimeClients } from './driver.ts';

function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr as Deno.NetAddr;
  listener.close();
  return address.port;
}

async function waitForServer(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await fetch(`${baseUrl}/resume`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('Realtime client server did not start within ten seconds.');
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
  await waitForServer(baseUrl);
  await exerciseRealtimeClients(baseUrl);
  await run('node', ['--experimental-strip-types', 'driver.ts', baseUrl]);
  await run('bun', ['driver.ts', baseUrl]);

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
    await waitForServer(`http://127.0.0.1:${workerdPort}`);
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
