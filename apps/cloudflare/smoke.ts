import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { run } from '../../scripts/lib/run.ts';
import { delay, freePort, skip, startHost, stopHost, waitForHttp } from '../smoke-helpers.ts';
import type { Host } from '../smoke-helpers.ts';

const SCRATCH = '../../.tmp/cloudflare-example';
const BUNDLE = `${SCRATCH}/worker.mjs`;

/** Whether the `wrangler` binary is on PATH. */
async function wranglerAvailable(): Promise<boolean> {
  try {
    return (await run('wrangler', ['--version'])).code === 0;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Bundles the Worker so workerd never evaluates the Node, Deno or Bun adapters. */
async function bundleWorker(): Promise<void> {
  const { code } = await run(
    'pnpm',
    [
      'exec',
      'esbuild',
      'worker.ts',
      '--bundle',
      '--format=esm',
      '--platform=browser',
      '--tsconfig=../../tsconfig.apps.json',
      '--external:node:*',
      `--outfile=${BUNDLE}`,
    ],
    { inherit: true },
  );
  if (code !== 0) throw new Error('esbuild could not bundle the Worker.');
}

function startWrangler(port: number): Host {
  return startHost('wrangler', [
    'dev',
    BUNDLE,
    '--config',
    'wrangler.toml',
    '--local',
    '--test-scheduled',
    '--compatibility-date',
    '2025-09-01',
    '--compatibility-flag',
    'nodejs_compat',
    '--persist-to',
    `${SCRATCH}/state`,
    '--port',
    String(port),
    '--log-level',
    'error',
  ]);
}

if (!(await wranglerAvailable())) skip('Wrangler is not installed; the Worker was not run.');

describe('cloudflare example on workerd', () => {
  let worker: Host;
  let baseUrl: string;

  const readValue = async (key: string): Promise<string | undefined> => {
    const response = await fetch(`${baseUrl}/value/${key}`);
    return response.ok ? (await response.json()).value : undefined;
  };

  before(async () => {
    await bundleWorker();
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    worker = startWrangler(port);
    // `/value/<unset key>` answers 404 once the Worker is serving.
    await waitForHttp(`${baseUrl}/value/ready`, {
      label: 'Wrangler',
      isReady: (response) => response.status === 404,
    });
  });

  after(async () => {
    await stopHost(worker);
  });

  it('reads back a KV value it wrote', async () => {
    const written = await fetch(`${baseUrl}/value/smoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'written-by-wrangler' }),
    });

    assert.equal(written.status, 204);
    assert.equal(await readValue('smoke'), 'written-by-wrangler');
  });

  it('runs the scheduled handler', async () => {
    const triggered = await fetch(`${baseUrl}/__scheduled?cron=*/5+*+*+*+*`);

    assert.ok(triggered.ok, `scheduled trigger returned ${triggered.status}`);
    assert.equal(await readValue('scheduled-runs'), '1');
  });

  it('detects the Cloudflare Workers runtime', async () => {
    const { detected } = await (await fetch(`${baseUrl}/diag/platform`)).json();

    assert.equal(detected, 'cloudflare-workers');
  });

  it('delivers a published message to the subscriber in another invocation', async () => {
    // Unique per run: `--persist-to` keeps KV between runs, so a fixed value
    // would be satisfied by an earlier run's delivery.
    const note = `audited-${crypto.randomUUID()}`;
    const published = await fetch(`${baseUrl}/publish/${note}`, { method: 'POST' });
    assert.equal(published.status, 202);

    let seen: string | undefined;
    for (let attempt = 0; attempt < 60 && seen !== note; attempt += 1) {
      seen = await readValue('last-audit');
      if (seen !== note) await delay(250);
    }
    assert.equal(seen, note);
  });

  it('answers a request through a Durable Object reply inbox', async () => {
    const response = await fetch(`${baseUrl}/double/21`);

    assert.ok(response.ok, `request/reply returned ${response.status}`);
    assert.deepEqual(await response.json(), { answer: 42 });
  });
});
