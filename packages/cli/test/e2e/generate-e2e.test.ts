/**
 * Drives `runCli` against a REAL temp directory through the REAL Deno
 * filesystem services — the same wiring `src/main.ts` builds — and reads every
 * write back from disk.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import { CUSTOM_SCHEMATIC_DIR } from '../../src/schematics/custom.ts';
import { useWorkspacePackages } from '../fixtures/generated-project.ts';

const runtime = createDenoRuntimeServices();
const fs: IFileSystem = runtime.fs!;

describe('setu end-to-end on a real filesystem', () => {
  let root: string;
  let out: string[];
  let err: string[];

  const run = (argv: readonly string[]) =>
    runCli(argv, {
      fs,
      cwd: root,
      now: () => runtime.now(),
      log: (m) => out.push(m),
      error: (m) => err.push(m),
    });

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: 'setu-e2e-' });
    out = [];
    err = [];
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  it('scaffolds a project whose files exist on disk', async () => {
    expect(await run(['new', 'shop-api'])).toBe(0);
    for (const name of ['deno.json', 'main.ts', 'README.md', '.gitignore']) {
      const info = await Deno.stat(`${root}/shop-api/${name}`);
      expect(info.isFile).toBe(true);
    }
  });

  it('scaffolds a deno.json that parses and pins the framework', async () => {
    await run(['new', 'shop-api']);
    const manifest = JSON.parse(await Deno.readTextFile(`${root}/shop-api/deno.json`));
    expect(manifest.imports['@setu-ts/kernel']).toContain('jsr:@setu-ts/kernel@');
    // No compiler options: standard decorators need none, and declaring any
    // would replace Deno's default set.
    expect(manifest.compilerOptions).toBeUndefined();
  });

  it('generates into the scaffolded project and reads the file back', async () => {
    await run(['new', 'shop-api']);
    const project = `${root}/shop-api`;

    expect(await run(['g', 'service', 'user-profile', '--dir', project])).toBe(0);

    const written = await Deno.readTextFile(`${project}/src/services/user-profile.service.ts`);
    expect(written).toContain('export function describeUserProfile');
    expect(written).toContain("return 'user-profile';");
  });

  it('creates nested directories that did not exist', async () => {
    await run(['new', 'shop-api']);
    // `src/jobs` rather than `src` itself: a scaffolded project now carries the
    // three seam barrels that need no plugin, so `src/routes`, `src/middleware`
    // and `src/plugins` exist from the start. `job` hosts no seam, so its
    // directory is still created by the generate rather than by the scaffold.
    const info = await Deno.stat(`${root}/shop-api/src/jobs`).catch(() => undefined);
    expect(info).toBeUndefined();

    await run(['g', 'job', 'send-invoice', '--dir', `${root}/shop-api`]);
    expect((await Deno.stat(`${root}/shop-api/src/jobs`)).isDirectory).toBe(true);
  });

  // The milestone's own claim, end to end on a real filesystem: the ONE HTTP
  // handler a decorator-free project can generate reaches a registration site
  // with no edit to a file the developer owns.
  it('wires a generated route into a template-less project with no hand edit', async () => {
    await run(['new', 'shop-api']);
    const project = `${root}/shop-api`;

    expect(await run(['g', 'route', 'orders', '--dir', project])).toBe(0);

    const barrel = await Deno.readTextFile(`${project}/src/controllers/index.ts`);
    expect(barrel).toContain('registerOrdersRoutes,');
    expect(barrel).toContain('register(router, services);');

    // The scaffolded config already calls the barrel, so nothing further is needed.
    const config = await Deno.readTextFile(`${project}/setu.config.ts`);
    expect(config).toContain("from './src/controllers/index.ts'");
    expect(config).toContain('registerGeneratedRoutes(app.router, app.services);');
  });

  it('honours the plugin gate against a real manifest on disk', async () => {
    await run(['new', 'shop-api']);
    const project = `${root}/shop-api`;

    // auth-plugin is absent from the scaffolded manifest.
    expect(await run(['g', 'guard', 'admin', '--dir', project])).toBe(1);
    await expect(Deno.stat(`${project}/src/guards/admin.guard.ts`)).rejects.toThrow();

    const manifest = JSON.parse(await Deno.readTextFile(`${project}/deno.json`));
    manifest.imports['@setu-ts/auth-plugin'] = 'jsr:@setu-ts/auth-plugin@^0.1.0';
    await Deno.writeTextFile(`${project}/deno.json`, JSON.stringify(manifest, null, 2));

    expect(await run(['g', 'guard', 'admin', '--dir', project])).toBe(0);
    expect(await Deno.readTextFile(`${project}/src/guards/admin.guard.ts`))
      .toContain('requireAdmin');
  });

  it('writes nothing to disk under --dry-run', async () => {
    expect(await run(['new', 'shop-api', '--dry-run'])).toBe(0);
    await expect(Deno.stat(`${root}/shop-api`)).rejects.toThrow();
    expect(out.some((line) => line.startsWith('would create'))).toBe(true);
  });

  it('refuses to overwrite a real file and leaves it byte-identical', async () => {
    await run(['new', 'shop-api']);
    const project = `${root}/shop-api`;
    await run(['g', 'service', 'billing', '--dir', project]);

    const path = `${project}/src/services/billing.service.ts`;
    await Deno.writeTextFile(path, 'HAND WRITTEN');

    expect(await run(['g', 'service', 'billing', '--dir', project])).toBe(1);
    expect(await Deno.readTextFile(path)).toBe('HAND WRITTEN');
  });

  it('loads a custom schematic from disk through the real import path', async () => {
    await Deno.mkdir(`${root}/${CUSTOM_SCHEMATIC_DIR}`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/${CUSTOM_SCHEMATIC_DIR}/readme.ts`,
      `export function schematic(names) {
  return [{ path: \`docs/\${names.kebab}.md\`, contents: \`# \${names.pascal}\\n\` }];
}
`,
    );

    expect(await run(['g', 'custom', 'readme', 'order-item'])).toBe(0);
    expect(await Deno.readTextFile(`${root}/docs/order-item.md`)).toBe('# OrderItem\n');
  });

  // D3. The gate the CLI shipped pointed at a step it would not take: `setu
  // generate --help` said "install @setu-ts/auth-plugin" and offered no command,
  // so unlocking a gated schematic meant hand-editing `deno.json`. This is the
  // whole round trip on a REAL filesystem — refused, added, accepted.
  it('unlocks a gated schematic through setu add', async () => {
    expect(await run(['new', 'svc'])).toBe(0);
    const project = `${root}/svc`;

    // Refused first, so the test cannot pass because the gate was never there.
    expect(await run(['g', 'guard', 'admin', '--dir', project])).toBe(1);
    expect(err.join('\n')).toContain('add auth');

    expect(await run(['add', 'auth', '--dir', project])).toBe(0);

    const manifest = JSON.parse(
      await Deno.readTextFile(`${project}/deno.json`),
    ) as { imports: Record<string, string> };
    expect(manifest.imports['@setu-ts/auth-plugin']).toContain('jsr:@setu-ts/auth-plugin@');

    // And now the same command succeeds — which is only possible because
    // `detectPlugins` reads the manifest `add` just wrote.
    expect(await run(['g', 'guard', 'admin', '--dir', project])).toBe(0);
    expect((await Deno.stat(`${project}/src/guards/admin.guard.ts`)).isFile).toBe(true);
  });

  // E8's own risk, found by review rather than by a gate. Merging `src/routes/`
  // into `src/controllers/` put two families in ONE directory under ONE barrel,
  // and in a FUNCTIONAL project both emit `register<Pascal>Routes` — so
  // `g route widget` then `g controller widget` each reported success and left a
  // barrel importing that symbol from two files. Measured: `TS2300 Duplicate
  // identifier`, twice, so the generated project did not compile.
  //
  // The guard existed (M60) but returned early for any project without
  // `decorator-plugin`, on a premise E8 and M65 had both invalidated.
  it('refuses a controller whose HTTP path a route already claims, functionally', async () => {
    expect(await run(['new', 'shop', '--template', 'rest'])).toBe(0);
    const project = `${root}/shop`;

    // The default composition: no decorator-plugin, which is exactly the case the
    // guard used to skip.
    const manifest = JSON.parse(await Deno.readTextFile(`${project}/deno.json`)) as {
      imports: Record<string, string>;
    };
    expect(Object.keys(manifest.imports)).not.toContain('@setu-ts/decorator-plugin');

    expect(await run(['g', 'route', 'widget', '--dir', project])).toBe(0);
    expect(await run(['g', 'controller', 'widget', '--dir', project])).toBe(1);

    // Refused BEFORE writing: the colliding file must not exist.
    await expect(Deno.stat(`${project}/src/controllers/widget.controller.ts`)).rejects.toThrow();

    // A distinct name is still generated, so the guard did not over-refuse.
    expect(await run(['g', 'controller', 'gadget', '--dir', project])).toBe(0);

    // And the barrel the two would have broken still type-checks for real. This is
    // the assertion the unit test cannot make: TS2300 is a property of the emitted
    // file, not of the guard's return value.
    await useWorkspacePackages(project);
    const checked = await new Deno.Command(Deno.execPath(), {
      args: ['check', `${project}/src/controllers/index.ts`],
      cwd: project,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    expect(checked.code, new TextDecoder().decode(checked.stderr)).toBe(0);
  });

  // D5. The one schematic gated on `database-plugin` produced a file nothing
  // imported and nothing could run, so every project that used it hand-wrote the
  // same runner. Type-checking it is not enough — the point is that it RUNS.
  it('generates a migration runner that actually applies migrations', async () => {
    expect(await run(['new', 'svc'])).toBe(0);
    const project = `${root}/svc`;
    expect(await run(['add', 'database', '--dir', project])).toBe(0);
    expect(await run(['g', 'migration', 'add-users', '--dir', project])).toBe(0);
    expect(await run(['g', 'migration', 'add-orders', '--dir', project])).toBe(0);

    await useWorkspacePackages(project);

    const applied = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '-A',
        '--node-modules-dir=none',
        '--config',
        `${project}/deno.json`,
        `${project}/src/migrations/run.ts`,
      ],
      cwd: project,
      stdout: 'piped',
      stderr: 'piped',
    }).output();

    const out = new TextDecoder().decode(applied.stdout);
    expect(applied.code, new TextDecoder().decode(applied.stderr)).toBe(0);
    // Both migrations ran, oldest first — filename order IS application order.
    expect(out).toContain('up ');
    expect(out.match(/^up /gm)?.length).toBe(2);

    const reversed = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '-A',
        '--node-modules-dir=none',
        '--config',
        `${project}/deno.json`,
        `${project}/src/migrations/run.ts`,
        '--down',
      ],
      cwd: project,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    expect(reversed.code).toBe(0);
    expect(new TextDecoder().decode(reversed.stdout).match(/^down /gm)?.length).toBe(2);
  });

  it('generates every ungated schematic into one project', async () => {
    await run(['new', 'shop-api']);
    const project = `${root}/shop-api`;

    // `controller` is gated on decorator-plugin, which this project lacks.
    for (const schematic of ['plugin', 'service', 'route', 'middleware', 'job']) {
      expect(await run([`g`, schematic, 'order-item', '--dir', project])).toBe(0);
    }

    const found: string[] = [];
    for await (const entry of Deno.readDir(`${project}/src`)) found.push(entry.name);
    expect(found.sort()).toEqual([
      // One HTTP directory since M70h/E8 — `controllers` holds both kinds.
      'controllers',
      'jobs',
      'middleware',
      'plugins',
      'services',
    ]);
  });
});
