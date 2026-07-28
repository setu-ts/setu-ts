/**
 * Drives `runCli` against a REAL temp directory through the REAL Deno
 * filesystem services — the same wiring `src/main.ts` builds — and reads every
 * write back from disk.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@hono-enterprise/runtime';
import type { IFileSystem } from '@hono-enterprise/common';
import { runCli } from '../../src/cli.ts';
import { CUSTOM_SCHEMATIC_DIR } from '../../src/schematics/custom.ts';

const runtime = createDenoRuntimeServices();
const fs: IFileSystem = runtime.fs!;

describe('honoe end-to-end on a real filesystem', () => {
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
    root = await Deno.makeTempDir({ prefix: 'honoe-e2e-' });
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
    expect(manifest.imports['@hono-enterprise/kernel']).toContain('jsr:@hono-enterprise/kernel@');
    expect(manifest.compilerOptions.experimentalDecorators).toBe(true);
  });

  it('generates into the scaffolded project and reads the file back', async () => {
    await run(['new', 'shop-api']);
    const project = `${root}/shop-api`;

    expect(await run(['g', 'service', 'user-profile', '--dir', project])).toBe(0);

    const written = await Deno.readTextFile(`${project}/src/services/user-profile.service.ts`);
    expect(written).toContain('export class UserProfileService');
    expect(written).toContain("return 'user-profile';");
  });

  it('creates nested directories that did not exist', async () => {
    await run(['new', 'shop-api']);
    const info = await Deno.stat(`${root}/shop-api/src`).catch(() => undefined);
    expect(info).toBeUndefined();

    await run(['g', 'route', 'orders', '--dir', `${root}/shop-api`]);
    expect((await Deno.stat(`${root}/shop-api/src/routes`)).isDirectory).toBe(true);
  });

  it('honours the plugin gate against a real manifest on disk', async () => {
    await run(['new', 'shop-api']);
    const project = `${root}/shop-api`;

    // auth-plugin is absent from the scaffolded manifest.
    expect(await run(['g', 'guard', 'admin', '--dir', project])).toBe(1);
    await expect(Deno.stat(`${project}/src/guards/admin.guard.ts`)).rejects.toThrow();

    const manifest = JSON.parse(await Deno.readTextFile(`${project}/deno.json`));
    manifest.imports['@hono-enterprise/auth-plugin'] = 'jsr:@hono-enterprise/auth-plugin@^0.1.0';
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

  it('generates every ungated schematic into one project', async () => {
    await run(['new', 'shop-api']);
    const project = `${root}/shop-api`;

    for (const schematic of ['plugin', 'controller', 'service', 'route', 'middleware', 'job']) {
      expect(await run([`g`, schematic, 'order-item', '--dir', project])).toBe(0);
    }

    const found: string[] = [];
    for await (const entry of Deno.readDir(`${project}/src`)) found.push(entry.name);
    expect(found.sort()).toEqual([
      'controllers',
      'jobs',
      'middleware',
      'plugins',
      'routes',
      'services',
    ]);
  });
});
