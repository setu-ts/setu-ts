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

/** What the fake `setu.config.ts` records about every application it builds. */
interface BootLog {
  readonly built: string[];
  readonly stopped: string[];
}

/** The emitted entry's default export, as the platform invokes it. */
interface WorkerModule {
  readonly default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
}

/**
 * Writes the emitted entry beside a fake `setu.config.ts` and imports it.
 *
 * The fake factory names each application after `env.NAME`, answers its name
 * from `fetch`, and fails to start when `env.FAIL` is set (or 20 ms later when
 * `env.FAIL_LATER` is) — enough to observe
 * which application served a request and which ones were stopped. Each call
 * uses a fresh directory, so the entry's module-level state starts empty.
 */
async function loadEntry(): Promise<{ worker: WorkerModule['default']; log: BootLog }> {
  const dir = await Deno.makeTempDir({ prefix: 'workers-entry-' });
  await Deno.mkdir(`${dir}/src`);
  await Deno.writeTextFile(`${dir}/src/index.ts`, workersEntry());
  await Deno.writeTextFile(
    `${dir}/setu.config.ts`,
    `export const log = { built: [] as string[], stopped: [] as string[] };
export function createApp(env: Record<string, unknown>) {
  const name = String(env.NAME);
  log.built.push(name);
  return Promise.resolve({
    start: () =>
      env.FAIL_LATER
        ? new Promise<void>((_, reject) => setTimeout(() => reject(new Error('late')), 20))
        : env.FAIL
        ? Promise.reject(new Error('boot failed'))
        : Promise.resolve(),
    stop: () => { log.stopped.push(name); return Promise.resolve(); },
    fetch: () => Promise.resolve(new Response(name)),
  });
}
`,
  );
  const entry = (await import(`file://${dir}/src/index.ts`)) as WorkerModule;
  const config = (await import(`file://${dir}/setu.config.ts`)) as { log: BootLog };
  return { worker: entry.default, log: config.log };
}

/** Lets the best-effort `stop()` of a superseded application settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('generated Workers entry rebuilds when bindings change', () => {
  const request = () => new Request('http://worker.test/');

  it('reuses one application while every request carries the same env', async () => {
    const { worker, log } = await loadEntry();
    const env = { NAME: 'a' };
    const bodies = await Promise.all([
      worker.fetch(request(), env).then((r) => r.text()),
      worker.fetch(request(), env).then((r) => r.text()),
    ]);
    expect(await (await worker.fetch(request(), env)).text()).toBe('a');
    expect(bodies).toEqual(['a', 'a']);
    expect(log.built).toEqual(['a']);
    expect(log.stopped).toEqual([]);
  });

  it('builds a new application for a new env and stops the old one', async () => {
    const { worker, log } = await loadEntry();
    expect(await (await worker.fetch(request(), { NAME: 'old' })).text()).toBe('old');
    // A bindings-only deploy that reuses the isolate hands later requests a
    // different env object; serving from the old application would use the
    // old bindings.
    expect(await (await worker.fetch(request(), { NAME: 'new' })).text()).toBe('new');
    await settle();
    expect(log.built).toEqual(['old', 'new']);
    expect(log.stopped).toEqual(['old']);
  });

  it('retries a failed boot instead of caching the failure', async () => {
    const { worker, log } = await loadEntry();
    const failing = { NAME: 'bad', FAIL: true };
    expect((await worker.fetch(request(), failing)).status).toBe(503);
    // Same env again: the failure was not cached, so the boot is attempted anew.
    expect((await worker.fetch(request(), failing)).status).toBe(503);
    const good = { NAME: 'good' };
    expect(await (await worker.fetch(request(), good)).text()).toBe('good');
    expect(await (await worker.fetch(request(), good)).text()).toBe('good');
    expect(log.built).toEqual(['bad', 'bad', 'good']);
  });

  it('keeps a newer application when a superseded boot fails late', async () => {
    const { worker, log } = await loadEntry();
    // The old env's boot is still in flight when the bindings change.
    const stale = worker.fetch(request(), { NAME: 'stale', FAIL_LATER: true });
    const fresh = { NAME: 'fresh' };
    expect(await (await worker.fetch(request(), fresh)).text()).toBe('fresh');
    expect((await stale).status).toBe(503);
    // The stale attempt's rejection must not clear the slot the fresh boot now
    // holds: the next request reuses 'fresh' rather than booting it again.
    expect(await (await worker.fetch(request(), fresh)).text()).toBe('fresh');
    expect(log.built).toEqual(['stale', 'fresh']);
  });
});
