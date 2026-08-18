// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/**
 * §3.7 real-outage bar: drives a **real** Redis backend through a **real**
 * stop and restart for the Redis backplane, asserting
 * `up → (stop) down → (restart) up`, including recovery (X3-2: this arm
 * self-heals — the probe flips back to reachable once the connections are
 * ready again).
 *
 * Guarded on `REDIS_URL`. NOT in `ALLOW_SKIP`.
 * `test/apps-gate.test.ts` pins the service, port mapping, and env var.
 *
 * F2 regression: without the bound `ping.call(client)` fix, the probe reports
 * `false` forever against a healthy Redis, so the baseline `up` assertion
 * would fail if F2 regresses.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RedisBackplane } from '../../src/transports/redis-backplane.ts';

// ── Docker stop/start helpers ───────────────────────────────────────────────

async function docker(args: string[]): Promise<string> {
  const out = await new Deno.Command('docker', { args }).output();
  if (!out.success) {
    throw new Error(
      `docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

async function containerIdForPort(port: number): Promise<string> {
  const ids = (await docker(['ps', '-q', '--filter', `publish=${port}`])).trim();
  if (ids === '') {
    throw new Error(`no container publishing port ${port}`);
  }
  return ids.split('\n')[0];
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitTrue(
  pred: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await wait(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function toIpv4(url: string): string {
  return url.replace(/localhost/g, '127.0.0.1');
}

describe('REAL Redis backplane outage (§3.7)', () => {
  it('up → stop → down → restart → up (X3-2 self-heals)', async () => {
    const url = Deno.env.get('REDIS_URL');
    if (url === undefined) {
      console.log('SKIP: REDIS_URL not set');
      return;
    }

    let ioredisPresent = false;
    try {
      await import('npm:ioredis@5.x');
      ioredisPresent = true;
    } catch {
      // npm:ioredis not available
    }
    if (!ioredisPresent) {
      console.log('SKIP: npm:ioredis@5.x not available');
      return;
    }

    const port = new URL(url).port === '' ? 6379 : Number(new URL(url).port);
    const containerId = await containerIdForPort(port);

    const backplane = new RedisBackplane(
      { transport: 'redis', url: toIpv4(url) },
      'outage-origin',
      'outage-topic',
    );

    try {
      await backplane.connect();
      const probe = backplane.isHealthy;
      expect(typeof probe).toBe('function');
      if (typeof probe !== 'function') return;

      // (up) baseline: F2 regression — the bound ping must report reachable.
      // Poll: the two ioredis connections settle to 'ready' asynchronously.
      await waitTrue(async () => (await probe()) === true, 'up baseline', 15_000);
      expect(await probe()).toBe(true);

      // (stop) real Redis stop → probe reports down
      await docker(['stop', containerId]);
      await waitTrue(async () => (await probe()) === false, 'down after stop', 30_000);
      expect(await probe()).toBe(false);

      // (restart) real Redis start → probe reports up again (X3-2 self-heals)
      await docker(['start', containerId]);
      await waitTrue(async () => (await probe()) === true, 'up after restart', 30_000);
      expect(await probe()).toBe(true);
    } finally {
      await backplane.close();
      await new Deno.Command('docker', { args: ['start', containerId] }).output();
    }
  });
});
