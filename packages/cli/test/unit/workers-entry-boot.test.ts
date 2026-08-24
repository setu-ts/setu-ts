/**
 * X9-8: only a successful boot is memoised, and no stack reaches the client.
 *
 * The emitted Workers entry used `booted ??= boot(env)`, which cached the raw
 * promise — ONE failed boot (a mistyped binding, a broker briefly down at
 * cold start) was permanent for the isolate's life, and the raw error
 * propagated to the client. The entry now claims the boot through
 * `ensureBooted`, which clears itself on rejection so the next request
 * retries, and `fetch` answers a generic `503` while reporting the real
 * error through `console.error` (sanctioned here: this is CLI-emitted output,
 * and `no-console` exempts `packages/cli`).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { TargetRuntime } from '../../src/constants.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { REST_TEMPLATE } from '../../src/templates/rest.ts';

/** The rendered Workers entry for the REST template. */
function workersEntry(): string {
  const resolved = resolveHost(REST_TEMPLATE, 'cloudflare-workers');
  const files = projectFiles('proj', 'cloudflare-workers' as TargetRuntime, resolved);
  const entry = files.find((f) => f.path === 'src/index.ts');
  expect(entry).toBeDefined();
  return entry?.contents ?? '';
}

describe('generated Workers entry boot semantics (X9-8)', () => {
  it('does not memoise the raw boot promise', () => {
    const entry = workersEntry();
    // The old statement cached the rejection forever.
    expect(entry).not.toContain('??=');
    expect(entry).toContain('function ensureBooted');
    // A rejected boot CLEARS the slot before rethrowing.
    expect(entry).toContain('booted = undefined;');
  });

  it('answers a failed BOOT with a generic 503, never the stack', () => {
    const entry = workersEntry();
    expect(entry).toContain("new Response('Service Unavailable', { status: 503 })");
    // The real error goes to the platform's logs, not the response body.
    expect(entry).toContain("console.error('setu: application failed to start', error)");
    expect(entry).not.toContain('error.message)');
    expect(entry).toContain('try {');
  });

  it('reports a REQUEST failure separately from a boot failure', () => {
    const entry = workersEntry();
    // Folding both into one catch logged 'failed to start' for a fault that had
    // nothing to do with startup, and answered 503 — a drain signal to a load
    // balancer — for a single bad request. `app.fetch` does throw: the kernel
    // rejects with no HTTP adapter registered, and an adapter may reject on a
    // malformed request.
    expect(entry).toContain("console.error('setu: request failed', error)");
    expect(entry).toContain("new Response('Internal Server Error', { status: 500 })");
    // `app.fetch` is NOT inside the boot try block.
    const bootCatch = entry.indexOf("console.error('setu: application failed to start'");
    const fetchCall = entry.indexOf('await app.fetch(request)');
    expect(fetchCall).toBeGreaterThan(bootCatch);
    // Still no stack in either body.
    expect(entry).not.toContain('String(error)');
  });

  it('keeps one shared boot across fetch and every worker export', () => {
    const entry = workersEntry();
    expect(entry.match(/async function boot/g)).toHaveLength(1);
    // The REST template contributes no worker export, so fetch is the only
    // claim site — but the claim must exist.
    expect((entry.match(/await ensureBooted\(env\)/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
