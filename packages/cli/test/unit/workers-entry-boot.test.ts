/**
 * X9-8: only a successful boot is memoised, and no stack reaches the client.
 * Also: one app per binding environment, retired only when nothing holds it.
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
import { afterAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { TargetRuntime } from '../../src/constants.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { REST_TEMPLATE } from '../../src/templates/rest.ts';
import { getTemplate } from '../../src/templates/registry.ts';

/** The rendered Workers entry for a template (REST by default). */
function workersEntry(host = REST_TEMPLATE): string {
  const resolved = resolveHost(host, 'cloudflare-workers');
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
    expect(entry).toContain('function acquire');
    // A rejected boot is forgotten so the next request retries it.
    expect(entry).toContain('if (apps.get(env) === created) apps.delete(env);');
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

  it('keeps one shared cache across fetch and every worker export', () => {
    const entry = workersEntry();
    expect(entry.match(/async function boot/g)).toHaveLength(1);
    // The REST template contributes no worker export, so fetch is the only
    // claim site — but the claim must exist.
    expect(entry.match(/const booted = acquire\(env\);/g)).toHaveLength(1);
  });

  it('releases its hold in a finally on every export, queue included', () => {
    // A retired app is stopped only once nothing holds it, so a hold that is
    // never released would keep every superseded app alive, and one released
    // early would stop an app under a queue batch still running on it.
    const entry = workersEntry(getTemplate('microservice'));
    expect(entry).toContain('async queue(');
    const acquires = entry.match(/const booted = acquire\(env\);\n {4}try \{/g) ?? [];
    const releases = entry.match(/\} finally \{\n {6}release\(booted\);\n {4}\}/g) ?? [];
    expect(acquires).toHaveLength(2);
    expect(releases).toHaveLength(2);
  });
});

/** What the fake `setu.config.ts` records about every application it builds. */
interface BootLog {
  readonly built: string[];
  readonly stopped: string[];
  /** When set, every `fetch` waits on it, so a request can be held open. */
  hold: Promise<void> | undefined;
}

/** The emitted entry's default export, as the platform invokes it. */
interface WorkerModule {
  readonly default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
}

/** Every directory `loadEntry` created, removed when the suite ends. */
const tempDirs: string[] = [];

/**
 * Writes the emitted entry beside a fake `setu.config.ts` and imports it.
 *
 * The fake factory names each application after `env.NAME` and answers its
 * name from `fetch`. It fails to start when `env.FAIL` is set, or 20 ms later
 * when `env.FAIL_LATER` is. Each call uses a fresh directory, so the entry's
 * module-level cache starts empty.
 */
async function loadEntry(): Promise<{ worker: WorkerModule['default']; log: BootLog }> {
  const dir = await Deno.makeTempDir({ prefix: 'workers-entry-' });
  tempDirs.push(dir);
  await Deno.mkdir(`${dir}/src`);
  await Deno.writeTextFile(`${dir}/src/index.ts`, workersEntry());
  await Deno.writeTextFile(
    `${dir}/setu.config.ts`,
    `export const log = {
  built: [] as string[],
  stopped: [] as string[],
  hold: undefined as Promise<void> | undefined,
};
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
    stop: () => {
      log.stopped.push(name);
      return Promise.resolve();
    },
    fetch: async () => {
      if (log.hold !== undefined) await log.hold;
      return new Response(name);
    },
  });
}
`,
  );
  const entry = (await import(`file://${dir}/src/index.ts`)) as WorkerModule;
  const config = (await import(`file://${dir}/setu.config.ts`)) as { log: BootLog };
  return { worker: entry.default, log: config.log };
}

/** Lets pending boots and best-effort `stop()` calls settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const request = () => new Request('http://worker.test/');

/** Serves one request and returns its body. */
async function body(
  worker: WorkerModule['default'],
  env: Record<string, unknown>,
): Promise<string> {
  return await (await worker.fetch(request(), env)).text();
}

describe('generated Workers entry keeps one app per binding environment', () => {
  afterAll(async () => {
    for (const dir of tempDirs) await Deno.remove(dir, { recursive: true });
  });

  it('reuses one application while every request carries the same env', async () => {
    const { worker, log } = await loadEntry();
    const env = { NAME: 'a' };
    expect(await Promise.all([body(worker, env), body(worker, env)])).toEqual(['a', 'a']);
    expect(await body(worker, env)).toBe('a');
    expect(log.built).toEqual(['a']);
    expect(log.stopped).toEqual([]);
  });

  it('serves a new env from a new app built from it', async () => {
    const { worker, log } = await loadEntry();
    expect(await body(worker, { NAME: 'old' })).toBe('old');
    // A bindings-only deploy that keeps the isolate hands later requests a
    // different env; serving them from the old app would use old bindings.
    expect(await body(worker, { NAME: 'new' })).toBe('new');
    expect(log.built).toEqual(['old', 'new']);
  });

  it('alternates between two envs without rebuilding or stopping either', async () => {
    // A gradual deployment routes each request to a version independently, so
    // one isolate can see two envs in turn.
    const { worker, log } = await loadEntry();
    const a = { NAME: 'a' };
    const b = { NAME: 'b' };
    for (let i = 0; i < 20; i++) {
      expect(await body(worker, i % 2 === 0 ? a : b)).toBe(i % 2 === 0 ? 'a' : 'b');
    }
    await settle();
    expect(log.built).toEqual(['a', 'b']);
    expect(log.stopped).toEqual([]);
  });

  it('stops the least recently used app when a third env arrives', async () => {
    const { worker, log } = await loadEntry();
    const a = { NAME: 'a' };
    const b = { NAME: 'b' };
    await body(worker, a);
    await body(worker, b);
    await body(worker, a); // b is now the least recently used
    expect(await body(worker, { NAME: 'c' })).toBe('c');
    await settle();
    expect(log.stopped).toEqual(['b']);
    // a is still cached: it is reused, not rebuilt.
    expect(await body(worker, a)).toBe('a');
    expect(log.built).toEqual(['a', 'b', 'c']);
  });

  it('retires an app once a rollout has moved every request off it', async () => {
    const { worker, log } = await loadEntry();
    await body(worker, { NAME: 'old' });
    const current = { NAME: 'new' };
    // One short of the threshold: the old app may still be in use somewhere.
    for (let i = 0; i < 99; i++) await body(worker, current);
    await settle();
    expect(log.stopped).toEqual([]);
    await body(worker, current);
    await settle();
    expect(log.stopped).toEqual(['old']);
  });

  it('keeps the working app while the new env keeps failing to start', async () => {
    const { worker, log } = await loadEntry();
    const good = { NAME: 'good' };
    await body(worker, good);
    // More failed requests than RETIRE_AFTER_USES: if retirement ran on a boot
    // that had not succeeded, the working app would be stopped here, in favour
    // of one that cannot start.
    const broken = { NAME: 'broken', FAIL: true };
    for (let i = 0; i < 120; i++) {
      expect((await worker.fetch(request(), broken)).status).toBe(503);
    }
    await settle();
    expect(log.stopped).toEqual([]);
    expect(await body(worker, good)).toBe('good');
  });

  it('does not stop a retired app while a request is still using it', async () => {
    const { worker, log } = await loadEntry();
    const a = { NAME: 'a' };
    await body(worker, a);
    let releaseHold = () => {};
    log.hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const inFlight = body(worker, a);
    await settle();
    log.hold = undefined;
    await body(worker, { NAME: 'b' });
    await body(worker, { NAME: 'c' }); // pushes a out of the cache
    await settle();
    expect(log.stopped).toEqual([]);
    releaseHold();
    expect(await inFlight).toBe('a');
    await settle();
    expect(log.stopped).toEqual(['a']);
  });

  it('retries a failed boot instead of caching the failure', async () => {
    const { worker, log } = await loadEntry();
    const failing = { NAME: 'bad', FAIL: true };
    expect((await worker.fetch(request(), failing)).status).toBe(503);
    // Same env again: the failure was not cached, so the boot is attempted anew.
    expect((await worker.fetch(request(), failing)).status).toBe(503);
    expect(log.built).toEqual(['bad', 'bad']);
  });

  it('keeps a newer application when an older boot fails late', async () => {
    const { worker, log } = await loadEntry();
    // The old env's boot is still in flight when the bindings change.
    const stale = worker.fetch(request(), { NAME: 'stale', FAIL_LATER: true });
    const fresh = { NAME: 'fresh' };
    expect(await body(worker, fresh)).toBe('fresh');
    expect((await stale).status).toBe(503);
    // The stale attempt's rejection must not disturb the fresh app.
    expect(await body(worker, fresh)).toBe('fresh');
    expect(log.built).toEqual(['stale', 'fresh']);
    expect(log.stopped).toEqual([]);
  });

  it('ignores a late failure from a boot that was evicted and replaced', async () => {
    const { worker, log } = await loadEntry();
    // Mutable on purpose: the SAME env object fails its first boot late and
    // starts cleanly the second time.
    const env: Record<string, unknown> = { NAME: 'x', FAIL_LATER: true };
    const first = worker.fetch(request(), env);
    // Two other envs start while x's first boot is in flight, pushing it out.
    await body(worker, { NAME: 'a' });
    await body(worker, { NAME: 'b' });
    env.FAIL_LATER = false;
    expect(await body(worker, env)).toBe('x');
    // The evicted attempt now fails. It must not erase the attempt that
    // replaced it, or the next request would build x a third time.
    expect((await first).status).toBe(503);
    expect(await body(worker, env)).toBe('x');
    expect(log.built).toEqual(['x', 'a', 'b', 'x']);
  });
});
