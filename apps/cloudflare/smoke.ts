// deno-lint-ignore-file no-console -- an unavailable external prerequisite must be visible in CI.
function unusedPort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr;
  listener.close();
  if (!('port' in address)) throw new Error('Expected a TCP listener.');
  return address.port;
}

async function waitForReady(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/value/ready`, { signal: AbortSignal.timeout(250) });
      if (response.status === 404) return;
    } catch {
      // Wrangler has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Wrangler did not start within five seconds.');
}

let check: Deno.CommandStatus | null = null;
try {
  check = await new Deno.Command('wrangler', { args: ['--version'] }).output();
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) {
    throw error;
  }
}
if (check === null || !check.success) {
  console.warn(
    'SKIP: Wrangler is not installed; Cloudflare smoke check was not run.',
  );
  Deno.exit(77);
}

const port = unusedPort();
const baseUrl = `http://127.0.0.1:${port}`;
const bundle = await new Deno.Command('deno', {
  args: ['bundle', 'worker.ts', '-o', '../../.tmp/m37-cloudflare-worker.mjs'],
  stdout: 'null',
  stderr: 'inherit',
}).output();
if (!bundle.success) throw new Error('Deno could not bundle the Cloudflare Worker.');
const worker = new Deno.Command('wrangler', {
  args: [
    'dev',
    '../../.tmp/m37-cloudflare-worker.mjs',
    '--config',
    'wrangler.toml',
    '--local',
    '--test-scheduled',
    '--compatibility-date',
    '2025-09-01',
    '--compatibility-flag',
    'nodejs_compat',
    '--persist-to',
    '../../.tmp/m37-cloudflare-smoke',
    '--port',
    String(port),
    '--log-level',
    'error',
  ],
  stdout: 'null',
  stderr: 'null',
}).spawn();

try {
  await waitForReady(baseUrl);
  const written = await fetch(`${baseUrl}/value/smoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'written-by-wrangler' }),
  });
  if (written.status !== 204) {
    throw new Error(`KV write returned ${written.status}.`);
  }

  const value = await (await fetch(`${baseUrl}/value/smoke`)).json();
  if (value.value !== 'written-by-wrangler') {
    throw new Error('KV read did not return the written value.');
  }

  const scheduled = await fetch(`${baseUrl}/__scheduled?cron=*/5+*+*+*+*`);
  if (!scheduled.ok) {
    throw new Error(`Scheduled trigger returned ${scheduled.status}.`);
  }
  const runs = await (await fetch(`${baseUrl}/value/scheduled-runs`)).json();
  if (runs.value !== '1') {
    throw new Error('Scheduled handler did not write its KV confirmation.');
  }
} finally {
  worker.kill('SIGTERM');
  await worker.status;
}
