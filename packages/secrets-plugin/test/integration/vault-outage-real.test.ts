/**
 * Real HashiCorp Vault outage (M101a V8-4) — local-only: CI runs no Vault.
 *
 * `docker pause` freezes the Vault process while its socket stays open, so
 * the TCP connection succeeds and the request simply never answers — the
 * shape that used to park a secret read for the platform fetch timeout and
 * then surface as a masked `500`. Through a real kernel app with the real
 * `HealthPlugin`: while paused, the route answers `503` inside
 * `requestTimeoutMs` and `/health` reports `secrets` down; after unpause the
 * route answers `200` again.
 *
 * Guarded with `ignore:` on `VAULT_ADDR` + `VAULT_TOKEN` (never an early
 * return, so an unset variable is reported as IGNORED). The container is
 * found by its published port, and the suite unpauses it on every exit.
 *
 * ```sh
 * docker run -d --name m101a-vault --cap-add=IPC_LOCK \
 *   -e VAULT_DEV_ROOT_TOKEN_ID=root -p 58200:8200 hashicorp/vault:1.18
 * VAULT_ADDR=http://127.0.0.1:58200 VAULT_TOKEN=root deno test -A \
 *   packages/secrets-plugin/test/integration/vault-outage-real.test.ts
 * ```
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { HandlerResult, IRequestContext, ISecretManager } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { errorHandler } from '@setu-ts/exceptions';

import { SecretsPlugin } from '../../src/index.ts';

const address = Deno.env.get('VAULT_ADDR');
const token = Deno.env.get('VAULT_TOKEN');
const skip = address === undefined || token === undefined;

const BOUND_MS = 1000;

async function docker(args: string[]): Promise<string> {
  const out = await new Deno.Command('docker', { args }).output();
  if (!out.success) {
    throw new Error(`docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

async function containerIdForPort(port: number): Promise<string> {
  const ids = (await docker(['ps', '-q', '--filter', `publish=${port}`])).trim();
  if (ids === '') throw new Error(`no container publishing port ${port}`);
  return ids.split('\n')[0];
}

describe('REAL Vault outage (M101a V8-4)', { ignore: skip }, () => {
  it('paused Vault → 503 within the bound and secrets down → unpaused → 200', async () => {
    const base = address!.replace(/\/+$/, '');
    // Seed the secret the route reads.
    const seeded = await fetch(`${base}/v1/secret/data/m101a/password`, {
      method: 'POST',
      headers: { 'X-Vault-Token': token!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { value: 's3cret' } }),
    });
    await seeded.body?.cancel();
    expect(seeded.ok).toBe(true);

    const port = Number(new URL(base).port);
    const containerId = await containerIdForPort(port);

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SecretsPlugin({
          provider: 'vault',
          options: { address: base, token: token!, cacheTtl: 0, requestTimeoutMs: BOUND_MS },
        }),
        HealthPlugin(),
      ],
    });
    app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 10, name: 'errors' });
    app.router.get('/secret', {
      handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
        const secrets = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
        return ctx.response.json({ value: await secrets.get('m101a/password') });
      },
    });
    await app.start();

    let paused = false;
    try {
      const baseline = await app.inject({ method: 'GET', url: 'http://localhost/secret' });
      expect(baseline.statusCode).toBe(200);
      expect(baseline.json()).toEqual({ value: 's3cret' });

      await docker(['pause', containerId]);
      paused = true;

      const started = performance.now();
      const refused = await app.inject({ method: 'GET', url: 'http://localhost/secret' });
      const elapsed = performance.now() - started;
      expect(refused.statusCode).toBe(503);
      expect((refused.json() as { title?: string }).title).toBe('Service Unavailable');
      expect(elapsed).toBeLessThan(BOUND_MS * 3);

      const health = await app.inject({ method: 'GET', url: 'http://localhost/health' });
      expect(health.statusCode).toBe(503);
      const checks = (health.json() as { checks?: Record<string, { status: string }> }).checks;
      expect(checks?.['secrets']?.status).toBe('down');

      await docker(['unpause', containerId]);
      paused = false;
      const recovered = await app.inject({ method: 'GET', url: 'http://localhost/secret' });
      expect(recovered.statusCode).toBe(200);
    } finally {
      if (paused) await docker(['unpause', containerId]).catch(() => {});
      await app.stop();
    }
  });
});
