import { after, before, describe, it } from 'node:test';
import { run } from '../../scripts/lib/run.ts';
import { freePort, SOURCE_HOST_ARGS, startHost, stopHost, waitForHttp } from '../smoke-helpers.ts';
import type { Host } from '../smoke-helpers.ts';
import { exerciseRealtimeClients } from './driver.ts';

/** Runs a command to completion and fails, naming it, if it does. */
async function runOrFail(command: string, args: readonly string[]): Promise<void> {
  const outcome = await run(command, args, { inherit: true });
  if (outcome.code !== 0) throw new Error(`${command} ${args.join(' ')} exited ${outcome.code}.`);
}

describe('realtime-clients example', () => {
  let server: Host;
  let baseUrl: string;

  before(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = startHost(process.execPath, [...SOURCE_HOST_ARGS, 'main.ts', String(port)]);
    await waitForHttp(`${baseUrl}/resume`, { label: 'Realtime client server' });
  });

  after(async () => {
    await stopHost(server);
  });

  it('works from this Node process', async () => {
    await exerciseRealtimeClients(baseUrl);
  });

  it('works from Node with type stripping', async () => {
    await runOrFail('node', ['--experimental-strip-types', 'driver.ts', baseUrl]);
  });

  it('works from Bun', async () => {
    await runOrFail('bun', ['driver.ts', baseUrl]);
  });

  it('works from workerd', async () => {
    // `npx wrangler` downloads Wrangler on first use, which on a cold runner
    // takes longer than the readiness budget below. Resolve it first.
    await runOrFail('npx', ['--yes', 'wrangler', '--version']);

    const workerdPort = await freePort();
    const worker = startHost('npx', [
      'wrangler',
      'dev',
      'worker.ts',
      '--port',
      String(workerdPort),
      '--log-level',
      'error',
    ]);
    try {
      const workerdUrl = `http://127.0.0.1:${workerdPort}`;
      await waitForHttp(workerdUrl, { label: 'workerd client host' });
      const response = await fetch(`${workerdUrl}/?baseUrl=${encodeURIComponent(baseUrl)}`);
      if (!response.ok) throw new Error(`The workerd client driver returned ${response.status}.`);
    } finally {
      await stopHost(worker);
    }
  });
});
