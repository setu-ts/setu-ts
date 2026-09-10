/**
 * H-70c-1 — the `audit` health indicator must report REACHABILITY, not just
 * lifecycle.
 *
 * Every assertion here fails against the pre-fix indicator, which reported
 * `storage.isReady() ? 'up' : 'down'`. That was in practice a literal `up`:
 * `isReady()` is a hardcoded `true` on three of the four shipped backends, so
 * a database whose connection had gone and a file path whose volume had been
 * unmounted both read healthy while every audited record was being lost.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HealthCheckResult,
  IFileSystem,
  IPluginContext,
  IRuntimeServices,
  StatResult,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { AuditPlugin, createAuditIndicator } from '../../src/plugin/audit-plugin.ts';
import type { IAuditStorage } from '../../src/interfaces/index.ts';
import type { IAuditDbClient } from '../../src/interfaces/index.ts';
import { LogAuditStorage } from '../../src/storage/log-audit.ts';

/**
 * A monotonic clock the test can step past the probe's 5s cache TTL.
 *
 * Without it the second read of an indicator returns the FIRST outcome, so a
 * test asserting a state change would compare a value against itself and pass
 * whatever the code did.
 */
class Clock {
  #ms = 1_000;
  read = (): number => this.#ms;
  advance(ms: number): void {
    this.#ms += ms;
  }
}

/** Real timers and an injected monotonic clock: the probe is bounded on both. */
function fakeRuntime(fs?: IFileSystem, clock: Clock = new Clock()): IRuntimeServices {
  return {
    platform: () => 'node',
    version: () => '1.0.0',
    hostname: () => 'localhost',
    uuid: () => crypto.randomUUID(),
    randomBytes: () => new Uint8Array(),
    subtle: {} as SubtleCrypto,
    // A FIXED wall-clock reading. `Date.now()` is banned outside
    // `packages/runtime`, and a double that reaches the host clock while the
    // probe clock is deterministic makes time-sensitive behaviour depend on
    // when the suite happens to run. Nothing under test reads this member.
    now: () => 1_700_000_000_000,
    hrtime: clock.read,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as number),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (h: unknown) => clearInterval(h as number),
    env: {},
    exit: () => {},
    ...(fs === undefined ? {} : { fs }),
  } as unknown as IRuntimeServices;
}

/** Registered plugin: its indicator plus the capabilities it published. */
interface Registered {
  readonly indicator: () => Promise<HealthCheckResult>;
  readonly services: Map<string, unknown>;
}

/** Registers the plugin against a fake context and hands back its indicator. */
async function registerAudit(
  options: Parameters<typeof AuditPlugin>[0],
  runtime: IRuntimeServices,
): Promise<Registered> {
  const services = new Map<string, unknown>([[CAPABILITIES.RUNTIME, runtime]]);
  let indicator: (() => Promise<HealthCheckResult>) | undefined;
  const ctx = {
    services: {
      get: (t: string) => services.get(t),
      has: (t: string) => services.has(t),
      register: (t: string, s: unknown) => void services.set(t, s),
    },
    runtime,
    health: {
      register: (_n: string, fn: () => Promise<HealthCheckResult>) => void (indicator = fn),
    },
    lifecycle: { onClose: () => {} },
  } as unknown as IPluginContext;

  await AuditPlugin(options).register!(ctx);
  if (indicator === undefined) throw new Error('no audit indicator registered');
  return { indicator, services };
}

describe('audit health — reachability (H-70c-1)', () => {
  it('reports the in-process memory sink reachable, not merely unknown', async () => {
    const { indicator } = await registerAudit({ storage: 'memory' }, fakeRuntime());
    expect(await indicator()).toEqual({
      status: 'up',
      data: { storage: 'memory', reachable: true },
    });
  });

  it('reports DOWN when the database client cannot be reached', async () => {
    // The pre-fix indicator answered `up` here: `DatabaseAuditStorage.isReady()`
    // is a constant `true`, so a dropped connection, a dropped table or a
    // revoked grant were all invisible while every append was failing.
    const client: IAuditDbClient = {
      insert: () => Promise.reject(new Error('ECONNREFUSED')),
      select: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const { indicator } = await registerAudit(
      { storage: 'database', options: { client } },
      fakeRuntime(),
    );
    expect(await indicator()).toEqual({
      status: 'down',
      data: { storage: 'database', reachable: false },
    });
  });

  it('probes the database by READING a sentinel key, never by writing', async () => {
    // An audit probe may not `insert`: it would write a fabricated record into
    // the trail this plugin exists to keep trustworthy.
    const inserts: unknown[] = [];
    const selects: Array<Record<string, unknown> | undefined> = [];
    const client: IAuditDbClient = {
      insert: (_t, row) => {
        inserts.push(row);
        return Promise.resolve();
      },
      select: (_t, criteria) => {
        selects.push(criteria);
        return Promise.resolve([]);
      },
    };
    const { indicator } = await registerAudit(
      { storage: 'database', options: { client, table: 'trail' } },
      fakeRuntime(),
    );

    expect((await indicator()).status).toBe('up');
    expect(inserts).toEqual([]);
    expect(selects).toEqual([{ id: '__setu_audit_health_probe__' }]);
  });

  it('reports DOWN when the file sink directory cannot be reached', async () => {
    const fs = {
      stat: () => Promise.reject(new Error('ENOENT: no such file or directory')),
      readFile: () => Promise.reject(new Error('ENOENT')),
      writeFile: () => Promise.resolve(),
      mkdir: () => Promise.resolve(),
    } as unknown as IFileSystem;
    const { indicator } = await registerAudit(
      { storage: 'file', options: { path: '/mnt/audit/trail.log' } },
      fakeRuntime(fs),
    );
    expect(await indicator()).toEqual({
      status: 'down',
      data: { storage: 'file', reachable: false },
    });
  });

  it('reports DOWN after an append fails, even while the directory still stats', async () => {
    // The truest signal this backend has, and it costs no probe I/O: the write
    // the audit trail depends on is the write being reported. A stat-only
    // probe is satisfied throughout this test, so it passes only because the
    // failed append is tracked.
    const clock = new Clock();
    const fs = {
      // `isDirectory: true` — a real `StatResult` for a directory carries it,
      // and the probe reads it. A double that omits it reports a parent that
      // is not a directory, which is a shape no filesystem produces here.
      stat: () =>
        Promise.resolve(
          { size: 0, isFile: false, isDirectory: true } as unknown as StatResult,
        ),
      readFile: () => Promise.reject(new Error('ENOENT')),
      writeFile: () => Promise.reject(new Error('EROFS: read-only file system')),
      mkdir: () => Promise.resolve(),
    } as unknown as IFileSystem;
    const { indicator, services } = await registerAudit(
      { storage: 'file', options: { path: '/srv/audit/trail.log' } },
      fakeRuntime(fs, clock),
    );

    expect((await indicator()).status).toBe('up');

    const auditor = services.get(CAPABILITIES.AUDIT) as {
      log(e: Record<string, unknown>): Promise<void>;
    };
    await expect(auditor.log({ action: 'delete', resource: 'user', result: 'success' }))
      .rejects.toThrow('EROFS');

    // Past the probe's cache TTL, or the first (healthy) outcome is replayed.
    clock.advance(6_000);
    expect(await indicator()).toEqual({
      status: 'down',
      data: { storage: 'file', reachable: false },
    });
  });

  it('reports DOWN when the configured parent is a regular file, not a directory', async () => {
    // `/srv/audit` existing as a FILE stats perfectly well, and then
    // `ensureDir()` and every append under `/srv/audit/trail.log` fail. A
    // probe that read only "the stat resolved" published that sink as
    // healthy — reading `isDirectory` is what tells the two apart.
    const fs = {
      stat: () =>
        Promise.resolve(
          { size: 12, isFile: true, isDirectory: false } as unknown as StatResult,
        ),
      readFile: () => Promise.reject(new Error('ENOTDIR')),
      writeFile: () => Promise.reject(new Error('ENOTDIR')),
      mkdir: () => Promise.reject(new Error('ENOTDIR')),
    } as unknown as IFileSystem;
    const { indicator } = await registerAudit(
      { storage: 'file', options: { path: '/srv/audit/trail.log' } },
      fakeRuntime(fs),
    );
    expect(await indicator()).toEqual({
      status: 'down',
      data: { storage: 'file', reachable: false },
    });
  });

  it('caches the outcome, so scraping health never turns into sink load', async () => {
    let calls = 0;
    const client: IAuditDbClient = {
      insert: () => Promise.resolve(),
      select: () => {
        calls += 1;
        return Promise.resolve([]);
      },
    };
    const clock = new Clock();
    const { indicator } = await registerAudit(
      { storage: 'database', options: { client } },
      fakeRuntime(undefined, clock),
    );

    await indicator();
    await indicator();
    await indicator();
    expect(calls).toBe(1);

    clock.advance(6_000);
    await indicator();
    expect(calls).toBe(2);
  });
});

describe('the audit indicator honours the whole port, not only what ships today', () => {
  /**
   * Both arms below are UNREACHABLE through `AuditPlugin`'s own factory: every
   * backend it builds implements `isHealthy`, and each one's `isReady()` is a
   * constant `true` once constructed. They are driven through the exported
   * seam instead, because `IAuditStorage` declares both members as contract —
   * and an indicator that ignored a port member because today's four
   * implementations happen not to exercise it is how the next backend ships
   * broken.
   */
  function runtimeFor(): IRuntimeServices {
    return fakeRuntime();
  }

  function ctxFor(runtime: IRuntimeServices): IPluginContext {
    return { runtime } as unknown as IPluginContext;
  }

  it('reports DOWN for a backend that says it is not ready, without probing', async () => {
    let probed = false;
    const storage = {
      isReady: () => false,
      isHealthy: () => {
        probed = true;
        return Promise.resolve(true);
      },
    } as unknown as IAuditStorage;

    const runtime = runtimeFor();
    const indicator = createAuditIndicator(storage, 'memory', ctxFor(runtime));

    expect(await indicator()).toEqual({
      status: 'down',
      data: { storage: 'memory', reachable: false },
    });
    // Lifecycle decides first: a backend that never started is not contacted.
    expect(probed).toBe(false);
  });

  it("reports 'unknown', never true, for a backend with no probe", async () => {
    const storage = { isReady: () => true } as unknown as IAuditStorage;
    const runtime = runtimeFor();
    const indicator = createAuditIndicator(storage, 'memory', ctxFor(runtime));

    expect(await indicator()).toEqual({
      status: 'up',
      data: { storage: 'memory', reachable: 'unknown' },
    });
  });
});

describe('LogAuditStorage reachability', () => {
  it('reports reachable while a logger is configured', async () => {
    const logger = {
      level: 'info' as const,
      fatal: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => logger,
    };
    const storage = new LogAuditStorage({ logger });
    expect(await storage.isHealthy()).toBe(true);
  });

  it('reports unreachable with no logger — the sink does not exist', async () => {
    const storage = new LogAuditStorage();
    expect(storage.isReady()).toBe(false);
    expect(await storage.isHealthy()).toBe(false);
  });
});
