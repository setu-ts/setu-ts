/**
 * Command-level tests for `setu generate module`.
 *
 * The aggregate schematic is the only one that reads project state beyond the
 * manifest and the only one emitting a file the CLI rewrites, so its command
 * path is tested apart from the per-schematic unit tests.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createFakeFs, createRecorder, type FakeFs } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runGenerateCommand } from '../../src/commands/generate.ts';

/** A Deno manifest declaring the given `@setu-ts` packages as installed. */
const manifest = (...packages: readonly string[]) =>
  JSON.stringify({
    imports: Object.fromEntries(
      packages.map((p) => [`@setu-ts/${p}`, `jsr:@setu-ts/${p}@^0.1.0-alpha.1`]),
    ),
  });

/** A class-based project manifest. */
const CLASS_BASED = { '/app/deno.json': manifest('decorator-plugin', 'di-plugin') };

interface Harness {
  readonly fs: FakeFs;
  readonly out: ReturnType<typeof createRecorder>;
  readonly err: ReturnType<typeof createRecorder>;
  run(argv: readonly string[]): Promise<number>;
}

function harness(seed: Readonly<Record<string, string>> = CLASS_BASED): Harness {
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  return {
    fs,
    out,
    err,
    run: (argv) =>
      runGenerateCommand(parseArgs(argv), {
        fs,
        cwd: '/app',
        now: () => Date.UTC(2026, 6, 28, 12, 30, 45),
        log: out.sink,
        error: err.sink,
      }),
  };
}

describe('setu generate module', () => {
  it('never imports a quoted artifact name into a flat or module barrel', async () => {
    const h = harness({ '/app/deno.json': manifest('logger-plugin') });
    expect(await h.run(['module', 'orders'])).toBe(0);
    await h.fs.writeFile(
      `/app/src/modules/orders/q'y.controller.ts`,
      new TextEncoder().encode("export function registerQ'yRoutes() {}"),
    );
    expect(await h.run(['route', 'summary', '--module', 'orders'])).toBe(0);
    expect(h.fs.read('/app/src/modules/orders/index.ts')).not.toContain("q'y");
    // A flat project, with its own barrel.
    const flat = harness({ '/app/deno.json': manifest('logger-plugin') });
    await flat.fs.writeFile(
      `/app/src/controllers/q'y.controller.ts`,
      new TextEncoder().encode("export function registerQ'yRoutes() {}"),
    );
    expect(await flat.run(['route', 'health'])).toBe(0);
    expect(flat.fs.read('/app/src/controllers/index.ts')).not.toContain("q'y");
  });
  it('reports hostile artifact names escaped and never lists them in either barrel', async () => {
    const h = harness({ '/app/deno.json': manifest('logger-plugin') });
    expect(await h.run(['module', 'orders'])).toBe(0);
    const hostile = "q'y\n\u001b[31m";
    await h.fs.writeFile(
      `/app/src/modules/orders/${hostile}.controller.ts`,
      new TextEncoder().encode(`export function registerQ'yRoutes() {}`),
    );
    expect(await h.run(['route', 'summary', '--module', 'orders'])).toBe(0);
    expect(h.fs.read('/app/src/modules/orders/index.ts')).not.toContain("q'y");
    const flat = harness({ '/app/deno.json': manifest('logger-plugin') });
    await flat.fs.writeFile(
      `/app/src/controllers/${hostile}.controller.ts`,
      new TextEncoder().encode(`export function registerQ'yRoutes() {}`),
    );
    expect(await flat.run(['route', 'health'])).toBe(0);
    expect(flat.fs.read('/app/src/controllers/index.ts')).not.toContain("q'y");
    for (const run of [h, flat]) {
      expect(run.err.text()).toContain(
        'not a kebab-case identifier, so it cannot be listed in the barrel. Rename the file.',
      );
      expect(run.err.lines.some((line) => line.includes(hostile))).toBe(false);
      expect(run.err.text()).not.toContain('\u001b');
    }
  });
  it('excludes a class-based module with a missing declaration export instead of importing it as legacy', async () => {
    const h = harness({
      ...CLASS_BASED,
      '/app/src/modules/broken/broken.controller.ts': 'export class BrokenController {}',
      '/app/src/modules/broken/broken.service.ts': 'export class BrokenService {}',
      '/app/src/modules/broken/broken.module.ts': 'export class RenamedModule {}',
    });
    expect(await h.run(['module', 'orders'])).toBe(0);
    const barrel = h.fs.read('/app/src/modules/index.ts');
    expect(barrel).toContain('OrdersModule');
    expect(barrel).not.toContain('Broken');
    expect(h.err.text()).toContain('BrokenModule');
    expect(h.err.text()).toContain('as an export');
  });
  it('writes eight files and reads the generated module declaration back', async () => {
    const h = harness();

    expect(await h.run(['module', 'user'])).toBe(0);

    expect(h.fs.writes).toEqual([
      '/app/src/modules/user/user.service.ts',
      '/app/src/modules/user/user.controller.ts',
      '/app/src/modules/user/user.module.ts',
      '/app/src/modules/user/index.ts',
      '/app/src/modules/index.ts',
      '/app/src/modules/user/user.test.ts',
      '/app/src/modules/user/user.e2e.test.ts',
      '/app/test/support/server.ts',
    ]);
    expect(h.fs.read('/app/src/modules/user/user.controller.ts')).toContain(
      'export class UserController',
    );
    expect(h.fs.read('/app/src/modules/user/user.module.ts')).toContain('@Module({');
    expect(h.fs.read('/app/src/modules/index.ts')).toContain('UserModule');
  });

  it('writes functional route output when decorators are absent', async () => {
    const h = harness({ '/app/deno.json': manifest('logger-plugin') });

    expect(await h.run(['module', 'user'])).toBe(0);

    expect(h.fs.writes).toContain('/app/src/modules/user/user.controller.ts');
    expect(h.fs.read('/app/src/modules/user/user.controller.ts')).toContain('status(201)');
  });

  it('lists a previously generated module alongside the new one', async () => {
    // The barrel is a function of what is on disk, so the second generate must
    // pick the first module up rather than dropping it.
    const h = harness();
    await h.run(['module', 'billing']);

    expect(await h.run(['module', 'user'])).toBe(0);

    const barrel = h.fs.read('/app/src/modules/index.ts');
    expect(barrel).toContain('BillingModule');
    expect(barrel).toContain('UserModule');
  });

  it('preserves the old barrel exports while reporting a legacy module', async () => {
    const h = harness({
      ...CLASS_BASED,
      '/app/src/modules/users/users.controller.ts': 'export class UsersController {}',
      '/app/src/modules/users/users.service.ts': 'export class UsersService {}',
      '/app/src/modules/index.ts': '// old CLI-managed module barrel',
    });

    expect(await h.run(['module', 'orders'])).toBe(0);

    const barrel = h.fs.read('/app/src/modules/index.ts');
    expect(barrel).toContain('export const MODULES');
    expect(barrel).toContain('export const MODULE_CONTROLLERS');
    expect(barrel).toContain('export const MODULE_SERVICES');
    expect(barrel).toContain('UsersController');
    expect(barrel).toContain('UsersService');
    // The declared module joins MODULES; only the legacy one is listed by class.
    expect(barrel).toContain('OrdersModule');
    expect(barrel).not.toContain('OrdersController');
    expect(h.err.text()).toContain('MODULES activation barrel');
  });

  it('reports a module directory whose name cannot enter the barrel, escaped', async () => {
    const hostile = 'Bad\u001b[31m';
    const h = harness({
      ...CLASS_BASED,
      [`/app/src/modules/${hostile}/${hostile}.controller.ts`]: 'export class X {}',
      [`/app/src/modules/${hostile}/${hostile}.service.ts`]: 'export class Y {}',
    });

    expect(await h.run(['module', 'orders'])).toBe(0);

    const barrel = h.fs.read('/app/src/modules/index.ts');
    expect(barrel).toContain('OrdersModule');
    expect(barrel).not.toContain('Bad');
    const report = h.err.text();
    expect(report).toContain('its name is not a kebab-case identifier');
    // The control character is escaped, never written to the terminal raw.
    expect(report).not.toContain('\u001b');
    expect(report).toContain('src/modules/Bad');
  });

  it('refuses to regenerate a module over its own files', async () => {
    // The barrel is exempt from the overwrite check; the module's own files are
    // not, so a repeat must still refuse rather than silently rewriting work.
    const h = harness();
    await h.run(['module', 'user']);
    const writesBefore = h.fs.writes.length;

    expect(await h.run(['module', 'user'])).toBe(1);

    expect(h.fs.writes.length).toBe(writesBefore);
    expect(h.err.text()).toContain('Refusing to overwrite existing files');
    expect(h.err.text()).toContain('/app/src/modules/user/user.service.ts');
    // The exemption must not leak into the error report.
    expect(h.err.text()).not.toContain('/app/src/modules/index.ts');
  });

  it('prints all eight planned paths under --dry-run and writes nothing', async () => {
    const h = harness();

    expect(await h.run(['module', 'user', '--dry-run'])).toBe(0);

    expect(h.fs.writes).toEqual([]);
    expect(h.fs.mkdirs).toEqual([]);
    const printed = h.out.lines.filter((l) => l.startsWith('would create'));
    expect(printed.length).toBe(8);
    expect(h.out.text()).toContain('would create /app/src/modules/index.ts');
  });

  it('roots both the scan and the writes at --dir', async () => {
    const h = harness({ '/elsewhere/deno.json': manifest('decorator-plugin') });

    expect(await h.run(['module', 'user', '--dir', '/elsewhere'])).toBe(0);

    expect(h.fs.writes).toContain('/elsewhere/src/modules/index.ts');
    expect(h.fs.writes.every((p) => p.startsWith('/elsewhere/'))).toBe(true);
  });

  it('succeeds in a project that has no src/modules directory yet', async () => {
    // `readdir` rejects there; the scan must report no modules rather than
    // failing the command.
    const h = harness();

    expect(await h.run(['module', 'first'])).toBe(0);

    expect(h.fs.read('/app/src/modules/index.ts')).toContain('FirstModule');
  });

  it('rejects a name that cannot begin an identifier', async () => {
    const h = harness();

    expect(await h.run(['module', '2fa'])).toBe(2);

    expect(h.fs.writes).toEqual([]);
  });

  it('appears in the schematic list for a decorated project', async () => {
    const h = harness();

    expect(await h.run(['--help'])).toBe(0);

    expect(h.out.text()).toContain('module');
    expect(h.out.text()).not.toContain('module  (unavailable');
  });

  it('is listed when the decorator plugin is absent', async () => {
    const h = harness({ '/app/deno.json': manifest('logger-plugin') });

    expect(await h.run(['--help'])).toBe(0);

    expect(h.out.text()).toContain('module');
    expect(h.out.text()).not.toContain('module  (unavailable');
  });
});
