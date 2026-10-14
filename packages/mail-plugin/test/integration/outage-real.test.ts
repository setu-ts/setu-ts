import { run as runProcess } from '../../../../test/node-helpers.ts';
/**
 * §3.7 real-outage bar: drives a **real** Mailpit (SMTP) backend through a
 * **real** stop and restart, asserting `up → (stop) down → (restart) up`.
 *
 * Guarded on `SMTP_URL` (e.g. `smtp://localhost:1025`): absent it, this suite
 * skips. `ALLOW_SKIP` does not apply here — that variable is read only by
 * `scripts/check-apps.ts` and governs `apps/`. What keeps this suite honest is
 * `test/apps-gate.test.ts`, which pins the service, port mapping and env var in
 * both workflows, so CI cannot silently stop running it.
 * `test/apps-gate.test.ts` pins the service, port mapping, and env var.
 */
import { describe, expect, it } from 'vitest';
import { SmtpProvider } from '../../src/providers/smtp-provider.ts';

// ── Docker stop/start helpers ───────────────────────────────────────────────

async function docker(args: string[]): Promise<string> {
  const out = await runProcess('docker', { args });
  if (!out.success) {
    throw new Error(`docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
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

describe('REAL Mailpit/SMTP outage (§3.7)', () => {
  it(
    'up → stop → down → restart → up',
    { skip: process.env['SMTP_URL'] === undefined },
    async () => {
      const url = process.env['SMTP_URL'];
      if (url === undefined) throw new Error('Backend guard failed');

      await import('nodemailer');

      const parsed = new URL(url);
      const port = parsed.port === '' ? 1025 : Number(parsed.port);
      const containerId = await containerIdForPort(port);

      // Connect via the explicit IPv4 loopback so nodemailer never dials the
      // IPv6 loopback (`::1`), which the scoped test net permission does not
      // grant and which would throw an uncaught `NotCapable` after the suite.
      const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;

      const provider = new SmtpProvider({ host, port, secure: false });

      try {
        await provider.connect();
        const probe = provider.isHealthy;
        expect(typeof probe).toBe('function');
        if (typeof probe !== 'function') return;

        // (up) baseline
        await waitTrue(async () => (await probe()) === true, 'up baseline', 15_000);
        expect(await probe()).toBe(true);

        // (stop) real Mailpit stop → verify() fails → down
        await docker(['stop', containerId]);
        await waitTrue(async () => (await probe()) === false, 'down after stop', 30_000);
        expect(await probe()).toBe(false);

        // (restart) real Mailpit start → verify() succeeds → up
        await docker(['start', containerId]);
        await waitTrue(async () => (await probe()) === true, 'up after restart', 30_000);
        expect(await probe()).toBe(true);
      } finally {
        await provider.disconnect();
        await runProcess('docker', { args: ['start', containerId] });
      }
    },
  );
});
