import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runGenerateCommand } from '../../src/commands/generate.ts';
import type { GeneratedFile } from '../../src/utils/file-writer.ts';

const DENO_MANIFEST = (...packages: readonly string[]) =>
  JSON.stringify({
    imports: Object.fromEntries(
      packages.map((p) => [`@hono-enterprise/${p}`, `jsr:@hono-enterprise/${p}@^0.1.0-alpha.1`]),
    ),
  });

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  run(argv: readonly string[], load?: (url: string) => Promise<Record<string, unknown>>): Promise<
    number
  >;
}

function harness(seed: Readonly<Record<string, string>> = {}): Harness {
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv, load) =>
      runGenerateCommand(parseArgs(argv), {
        fs,
        cwd: '/app',
        // Fixed clock: the migration schematic's filename must be deterministic.
        now: () => Date.UTC(2026, 6, 28, 12, 30, 45),
        log: out.sink,
        error: err.sink,
        ...(load === undefined ? {} : { load }),
      }),
  };
}

describe('runGenerateCommand', () => {
  it('generates an ungated schematic and reads the write back', async () => {
    const h = harness();
    expect(await h.run(['service', 'user-profile'])).toBe(0);
    expect(h.fs.writes).toEqual(['/app/src/services/user-profile.service.ts']);
    expect(h.fs.read('/app/src/services/user-profile.service.ts'))
      .toContain('export class UserProfileService');
    expect(h.out.text()).toContain('created /app/src/services/user-profile.service.ts');
  });

  it('roots generated paths at --dir', async () => {
    const h = harness();
    expect(await h.run(['service', 'billing', '--dir', '/elsewhere'])).toBe(0);
    expect(h.fs.writes).toEqual(['/elsewhere/src/services/billing.service.ts']);
  });

  it('creates the parent directory before writing', async () => {
    const h = harness();
    await h.run(['service', 'billing']);
    expect(h.fs.mkdirs).toEqual(['/app/src/services']);
  });

  describe('--dry-run', () => {
    it('performs zero writes and zero mkdirs', async () => {
      const h = harness();
      expect(await h.run(['service', 'billing', '--dry-run'])).toBe(0);
      expect(h.fs.writes).toEqual([]);
      expect(h.fs.mkdirs).toEqual([]);
    });

    it('reports every path it would create', async () => {
      const h = harness();
      await h.run(['service', 'billing', '--dry-run']);
      expect(h.out.text()).toBe('would create /app/src/services/billing.service.ts');
    });
  });

  describe('overwrite protection', () => {
    it('aborts with a non-zero code and writes nothing when a target exists', async () => {
      const h = harness({ '/app/src/services/billing.service.ts': 'MINE' });
      expect(await h.run(['service', 'billing'])).toBe(1);
      expect(h.fs.writes).toEqual([]);
      expect(h.fs.mkdirs).toEqual([]);
      expect(h.err.text()).toContain('Refusing to overwrite');
      expect(h.err.text()).toContain('/app/src/services/billing.service.ts');
    });

    it('leaves the existing file untouched', async () => {
      const h = harness({ '/app/src/services/billing.service.ts': 'MINE' });
      await h.run(['service', 'billing']);
      expect(h.fs.read('/app/src/services/billing.service.ts')).toBe('MINE');
    });

    it('checks every planned path before the first write', async () => {
      // A custom schematic emitting three files, the second of which exists.
      const load = () =>
        Promise.resolve({
          schematic: (): readonly GeneratedFile[] => [
            { path: 'a.ts', contents: 'A' },
            { path: 'b.ts', contents: 'B' },
            { path: 'c.ts', contents: 'C' },
          ],
        });
      const h = harness({ '/app/b.ts': 'EXISTING' });
      expect(await h.run(['custom', 'triple', 'thing'], load)).toBe(1);
      expect(h.fs.writes).toEqual([]);
      expect(h.fs.has('/app/a.ts')).toBe(false);
      expect(h.fs.has('/app/c.ts')).toBe(false);
    });
  });

  describe('plugin gating', () => {
    it('refuses a gated schematic when its plugin is absent', async () => {
      const h = harness();
      expect(await h.run(['guard', 'admin'])).toBe(1);
      expect(h.fs.writes).toEqual([]);
      expect(h.err.text()).toContain('@hono-enterprise/auth-plugin');
    });

    it('allows the same schematic once its plugin is installed', async () => {
      const h = harness({ '/app/deno.json': DENO_MANIFEST('auth-plugin') });
      expect(await h.run(['guard', 'admin'])).toBe(0);
      expect(h.fs.read('/app/src/guards/admin.guard.ts')).toContain('export function requireAdmin');
    });

    it('allows an ungated schematic with no plugins installed', async () => {
      const h = harness();
      expect(await h.run(['job', 'nightly'])).toBe(0);
    });

    const gates: readonly (readonly [string, string])[] = [
      ['guard', 'auth-plugin'],
      ['health-indicator', 'health-plugin'],
      ['metric', 'metrics-plugin'],
      ['command-handler', 'cqrs-plugin'],
      ['query-handler', 'cqrs-plugin'],
      ['event-handler', 'events-plugin'],
      ['migration', 'database-plugin'],
    ];

    for (const [schematic, plugin] of gates) {
      it(`gates ${schematic} on ${plugin}`, async () => {
        const blocked = harness();
        expect(await blocked.run([schematic, 'thing'])).toBe(1);
        expect(blocked.err.text()).toContain(plugin);

        const allowed = harness({ '/app/deno.json': DENO_MANIFEST(plugin) });
        expect(await allowed.run([schematic, 'thing'])).toBe(0);
      });
    }
  });

  describe('usage errors', () => {
    it('returns 2 and lists schematics when none is named', async () => {
      const h = harness();
      expect(await h.run([])).toBe(2);
      expect(h.out.text()).toContain('Schematics:');
    });

    it('returns 0 for --help', async () => {
      const h = harness();
      expect(await h.run(['--help'])).toBe(0);
      expect(h.out.text()).toContain('Schematics:');
    });

    it('returns 0 for -h', async () => {
      const h = harness();
      expect(await h.run(['-h'])).toBe(0);
    });

    it('marks a gated schematic unavailable in --help when its plugin is absent', async () => {
      const h = harness();
      await h.run(['--help']);
      expect(h.out.text()).toContain('guard  (unavailable — install @hono-enterprise/auth-plugin)');
    });

    it('lists a gated schematic plainly once its plugin is installed', async () => {
      const h = harness({ '/app/deno.json': DENO_MANIFEST('auth-plugin') });
      await h.run(['--help']);
      expect(h.out.text()).not.toContain('guard  (unavailable');
    });

    it('returns 2 for an unknown schematic', async () => {
      const h = harness();
      expect(await h.run(['nonsense', 'thing'])).toBe(2);
      expect(h.err.text()).toContain('Unknown schematic: nonsense');
    });

    it('returns 2 for an inherited property name rather than crashing', async () => {
      const h = harness();
      expect(await h.run(['constructor', 'thing'])).toBe(2);
      expect(h.err.text()).toContain('Unknown schematic: constructor');
    });

    it('returns 2 when the name is missing', async () => {
      const h = harness();
      expect(await h.run(['service'])).toBe(2);
      expect(h.err.text()).toContain('generate service <name>');
    });
  });

  describe('custom schematics', () => {
    it('generates from a loaded module', async () => {
      const load = () =>
        Promise.resolve({
          schematic: (names: { kebab: string }): readonly GeneratedFile[] => [
            { path: `custom/${names.kebab}.txt`, contents: names.kebab },
          ],
        });
      const h = harness();
      expect(await h.run(['custom', 'my-gen', 'order-item'], load)).toBe(0);
      expect(h.fs.read('/app/custom/order-item.txt')).toBe('order-item');
    });

    it('returns 2 when the custom schematic name is missing', async () => {
      const h = harness();
      expect(await h.run(['custom'])).toBe(2);
      expect(h.err.text()).toContain('generate custom <schematic-name> <name>');
    });

    it('returns 2 when the target name is missing', async () => {
      const h = harness();
      expect(await h.run(['custom', 'my-gen'])).toBe(2);
    });

    it('returns 1 when the module cannot be loaded', async () => {
      const h = harness();
      const load = () => Promise.reject(new Error('boom'));
      expect(await h.run(['custom', 'missing', 'thing'], load)).toBe(1);
      expect(h.err.text()).toContain('Cannot load custom schematic "missing"');
    });

    it('returns 1 when the module exports no schematic function', async () => {
      const h = harness();
      expect(await h.run(['custom', 'bad', 'thing'], () => Promise.resolve({}))).toBe(1);
      expect(h.err.text()).toContain("must export a 'schematic' function");
    });

    it('returns 1 when the schematic throws', async () => {
      const load = () =>
        Promise.resolve({
          schematic: () => {
            throw new Error('template blew up');
          },
        });
      const h = harness();
      expect(await h.run(['custom', 'broken', 'thing'], load)).toBe(1);
      expect(h.err.text()).toContain('template blew up');
      expect(h.fs.writes).toEqual([]);
    });

    it('reports a schematic that throws a non-Error value', async () => {
      const load = () =>
        Promise.resolve({
          schematic: () => {
            throw 'a bare string';
          },
        });
      const h = harness();
      expect(await h.run(['custom', 'broken', 'thing'], load)).toBe(1);
      expect(h.err.text()).toContain('a bare string');
    });

    it('returns 1 when the schematic produces no files', async () => {
      const load = () => Promise.resolve({ schematic: () => [] });
      const h = harness();
      expect(await h.run(['custom', 'empty', 'thing'], load)).toBe(1);
      expect(h.err.text()).toContain('produced no files');
    });

    it('passes the detected plugins and runtime target through to the schematic', async () => {
      let seen: { runtime: string; plugins: readonly string[] } | undefined;
      const load = () =>
        Promise.resolve({
          schematic: (
            _names: unknown,
            options: { runtime: string; plugins: ReadonlySet<string> },
          ): readonly GeneratedFile[] => {
            seen = { runtime: options.runtime, plugins: [...options.plugins] };
            return [{ path: 'x.txt', contents: 'x' }];
          },
        });
      const h = harness({ '/app/deno.json': DENO_MANIFEST('cache-plugin') });
      await h.run(['custom', 'probe', 'thing', '--runtime', 'bun'], load);
      expect(seen).toEqual({ runtime: 'bun', plugins: ['cache-plugin'] });
    });

    it('defaults the runtime target to deno for an unrecognised value', async () => {
      let seen: string | undefined;
      const load = () =>
        Promise.resolve({
          schematic: (
            _names: unknown,
            options: { runtime: string },
          ): readonly GeneratedFile[] => {
            seen = options.runtime;
            return [{ path: 'x.txt', contents: 'x' }];
          },
        });
      const h = harness();
      await h.run(['custom', 'probe', 'thing', '--runtime', 'solaris'], load);
      expect(seen).toBe('deno');
    });
  });

  it('returns 1 and reports the cause when the write fails', async () => {
    const fs = createFakeFs();
    const err = createRecorder();
    const code = await runGenerateCommand(parseArgs(['service', 'billing']), {
      fs: { ...fs, writeFile: () => Promise.reject(new Error('read-only fs')) },
      cwd: '/app',
      now: () => 0,
      log: () => {},
      error: err.sink,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('Failed to write: read-only fs');
  });

  it('reports a non-Error write failure', async () => {
    const fs = createFakeFs();
    const err = createRecorder();
    const code = await runGenerateCommand(parseArgs(['service', 'billing']), {
      fs: { ...fs, writeFile: () => Promise.reject('EROFS') },
      cwd: '/app',
      now: () => 0,
      log: () => {},
      error: err.sink,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('Failed to write: EROFS');
  });

  it('uses the injected clock for the migration filename', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST('database-plugin') });
    expect(await h.run(['migration', 'add-orders'])).toBe(0);
    expect(h.fs.writes).toEqual(['/app/src/migrations/20260728123045-add-orders.ts']);
  });
});
