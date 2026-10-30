import { tempDir } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
/**
 * The CLI never reads for a move, or writes, through a symbolic link inside a
 * project — on a REAL filesystem, with real links (M101f re-audit N9, N10).
 *
 * A link is committed content: git stores it as readily as a file, so a cloned
 * project can carry `src/ext -> ../../outside` or a `deno.json` that points at a
 * file elsewhere. Following one let `adopt` move (and so delete) files outside
 * the project, and let the writers overwrite or merge into a file outside it.
 * A fake filesystem has no links, so this drives the real one. The positive
 * control matters as much: a project reached through a LINKED PARENT directory
 * must keep working, which a naive "is anything a link" check would break.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { createRecorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runAdoptCommand } from '../../src/commands/adopt.ts';
import { runDevtoolCommand } from '../../src/commands/devtool.ts';
import { runGenerateCommand } from '../../src/commands/generate.ts';
import { runNewCommand } from '../../src/commands/new.ts';
import { runWorkspaceCommand } from '../../src/commands/workspace.ts';
import { devEntryVariants } from '../../src/devtool/dev-entry.ts';
import { renderWorkspaceManifest } from '../../src/workspace/manifest.ts';
import { workspaceProfile } from '../../src/workspace/runtime-profile.ts';

const fs = createNodeRuntimeServices().fs!;
let base = '';
let outside = '';

beforeEach(async () => {
  base = await nodeFs.realpath(await tempDir({ prefix: 'setu-symlink-' }));
  outside = `${base}/outside`;
  await nodeFs.mkdir(outside);
});

afterEach(async () => {
  await nodeFs.rm(base, { recursive: true }).catch(() => {});
});

/** A minimal standalone Deno project the commands accept. */
async function project(dir: string): Promise<void> {
  await nodeFs.mkdir(`${dir}/src`, { recursive: true });
  await nodeFs.writeFile(
    `${dir}/deno.json`,
    JSON.stringify({ tasks: { start: 'deno run -A main.ts' } }, null, 2),
  );
  await nodeFs.writeFile(
    `${dir}/setu.config.ts`,
    'export function createApp(devtool?: { plugins?: readonly IPlugin[]; diagnostics?: ' +
      'KernelDiagnosticsOptions }) { return createApplication({ plugins: [...(devtool?.plugins ' +
      '?? [])], ...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } ' +
      ': {}) }); }\n',
  );
  await nodeFs.writeFile(`${dir}/main.ts`, "import { createApp } from './setu.config.ts';\n");
}

function deps(cwd: string) {
  const out = createRecorder();
  return { out, deps: { fs, cwd, now: () => 0, log: out.sink, error: out.sink } };
}

describe('commands refuse to follow a link inside a project', () => {
  it('adopt does not walk a linked directory, so nothing outside moves (N9)', async () => {
    const dir = `${base}/app`;
    await project(dir);
    await nodeFs.writeFile(`${outside}/precious.txt`, 'keep me');
    await nodeFs.symlink(outside, `${dir}/src/ext`);
    for (const dryRun of [true, false]) {
      const { out, deps: d } = deps(dir);
      expect(
        await runAdoptCommand(parseArgs(['--name', 'orders', ...(dryRun ? ['--dry-run'] : [])]), d),
      ).toBe(1);
      expect(out.text()).toContain('through a symbolic link');
    }
    expect(await nodeFs.readFile(`${outside}/precious.txt`, 'utf8')).toBe('keep me');
    await expect(nodeFs.stat(`${dir}/setu.workspace.json`)).rejects.toThrow();
  });

  it('generate does not write a barrel through a link (N10)', async () => {
    const dir = `${base}/app`;
    await project(dir);
    await nodeFs.mkdir(`${dir}/src/controllers`);
    await nodeFs.writeFile(`${outside}/victim.ts`, 'untouched');
    await nodeFs.symlink(`${outside}/victim.ts`, `${dir}/src/controllers/index.ts`);
    const { out, deps: d } = deps(dir);
    expect(await runGenerateCommand(parseArgs(['route', 'billing']), d)).not.toBe(0);
    expect(out.text()).toContain('through a symbolic link');
    expect(await nodeFs.readFile(`${outside}/victim.ts`, 'utf8')).toBe('untouched');
  });

  it('devtool enable does not merge into a linked deno.json (N10)', async () => {
    const dir = `${base}/app`;
    await project(dir);
    const manifest = await nodeFs.readFile(`${dir}/deno.json`, 'utf8');
    await nodeFs.writeFile(`${outside}/deno.json`, manifest);
    await nodeFs.rm(`${dir}/deno.json`);
    await nodeFs.symlink(`${outside}/deno.json`, `${dir}/deno.json`);
    const { out, deps: d } = deps(dir);
    expect(await runDevtoolCommand(parseArgs(['enable', '--devtool-port', '45999']), d)).toBe(1);
    expect(out.text()).toContain('through a symbolic link');
    expect(await nodeFs.readFile(`${outside}/deno.json`, 'utf8')).toBe(manifest);
  });

  it('ports --reallocate does not rewrite a linked main.dev.ts (N10)', async () => {
    const ws = `${base}/ws`;
    await nodeFs.mkdir(`${ws}/apps/orders`, { recursive: true });
    await nodeFs.writeFile(
      `${ws}/setu.workspace.json`,
      renderWorkspaceManifest({
        version: 1,
        basePort: 8600,
        devtoolBasePort: 8700,
        runtime: 'deno',
        transport: 'http',
        members: [{ name: 'orders', port: 8600, devtoolPort: 8700 }],
      }),
    );
    await nodeFs.writeFile(
      `${ws}/deno.json`,
      JSON.stringify({ workspace: ['./apps/*'], tasks: { dev: workspaceProfile('deno').runAll } }),
    );
    const entry = devEntryVariants(8700)[0]!;
    await nodeFs.writeFile(`${outside}/main.dev.ts`, entry);
    await nodeFs.symlink(`${outside}/main.dev.ts`, `${ws}/apps/orders/main.dev.ts`);
    const out = createRecorder();
    expect(
      await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
        fs,
        cwd: ws,
        log: out.sink,
        error: out.sink,
        portAvailable: () => Promise.resolve(true),
      }),
    ).toBe(1);
    expect(out.text()).toContain('through a symbolic link');
    expect(await nodeFs.readFile(`${outside}/main.dev.ts`, 'utf8')).toBe(entry);
  });

  it('adopt refuses a link whose name carries a backslash (N11)', async () => {
    // On POSIX `\\` is an ordinary filename character; a check that rewrote it
    // into a separator verified a different path from the one then moved.
    const dir = `${base}/app`;
    await project(dir);
    await nodeFs.writeFile(`${outside}/precious.txt`, 'keep me');
    await nodeFs.symlink(outside, `${dir}/src/ext\\x`);
    for (const dryRun of [true, false]) {
      const { out, deps: d } = deps(dir);
      expect(
        await runAdoptCommand(parseArgs(['--name', 'orders', ...(dryRun ? ['--dry-run'] : [])]), d),
      ).toBe(1);
      expect(out.text()).toContain('backslash');
    }
    expect(await nodeFs.readFile(`${outside}/precious.txt`, 'utf8')).toBe('keep me');
    await expect(nodeFs.stat(`${dir}/setu.workspace.json`)).rejects.toThrow();
  });

  it('a manifest member name that is not one path segment is refused (N11)', async () => {
    const ws = `${base}/ws`;
    await nodeFs.mkdir(`${ws}/apps`, { recursive: true });
    await nodeFs.mkdir(`${outside}/src/discovery`, { recursive: true });
    await nodeFs.writeFile(`${outside}/src/discovery/services.ts`, 'untouched');
    for (const name of ['evil\\x', 'a/b', '..']) {
      if (name === 'evil\\x') await nodeFs.symlink(outside, `${ws}/apps/${name}`);
      await nodeFs.writeFile(
        `${ws}/setu.workspace.json`,
        JSON.stringify({
          version: 1,
          basePort: 8600,
          runtime: 'deno',
          transport: 'http',
          members: [{ name, port: 8600 }],
        }),
      );
      const out = createRecorder();
      expect(
        await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
          fs,
          cwd: ws,
          log: out.sink,
          error: out.sink,
          portAvailable: () => Promise.resolve(true),
        }),
      ).toBe(1);
    }
    expect(await nodeFs.readFile(`${outside}/src/discovery/services.ts`, 'utf8')).toBe('untouched');
  });

  it('adopt refuses a linked top-level directory even when it is empty (N12)', async () => {
    const dir = `${base}/app`;
    await project(dir);
    await nodeFs.mkdir(`${outside}/empty`);
    await nodeFs.symlink(`${outside}/empty`, `${dir}/test`);
    const { out, deps: d } = deps(dir);
    expect(await runAdoptCommand(parseArgs(['--name', 'orders']), d)).toBe(1);
    expect(out.text()).toContain('through a symbolic link');
    // Nothing pruned: the committed link is still there.
    expect((await nodeFs.lstat(`${dir}/test`)).isSymbolicLink()).toBe(true);
  });

  it('still works for a project reached through a LINKED parent directory', async () => {
    // The root is resolved the same way as each target, so only links INSIDE
    // the project are refused; a project under a linked path is ordinary.
    await nodeFs.mkdir(`${base}/real`);
    await nodeFs.symlink(`${base}/real`, `${base}/linked`);
    const { out, deps: d } = deps(`${base}/linked`);
    expect(await runNewCommand(parseArgs(['shop']), d)).toBe(0);
    const generated = deps(`${base}/linked/shop`);
    expect(await runGenerateCommand(parseArgs(['route', 'billing']), generated.deps)).toBe(0);
    expect(generated.out.text()).not.toContain('symbolic link');
    expect(out.text()).not.toContain('symbolic link');
    await nodeFs.stat(`${base}/real/shop/src/controllers/billing.controller.ts`);
  });
});
