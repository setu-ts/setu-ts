/** Real registry-overlay installs of generated applications, without booting them. */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../src/cli.ts';
import { detectPlugins } from '../../src/utils/plugin-detector.ts';
import { ADDABLE, RUNTIME_RESTRICTIONS } from '../../src/commands/add.ts';
import { TOOLING_PACKAGES } from '../../src/agents/package-data.ts';
import { npmInstall, startOverlay, type RegistryOverlay } from '../fixtures/node-project.ts';

const root = resolve('.tmp/agents-e2e');
const fs = createNodeRuntimeServices().fs!;
let overlay: RegistryOverlay;
const run = (args: readonly string[], cwd = root) =>
  runCli(args, { fs, cwd, now: () => 0, log: () => {}, error: () => {} });

beforeAll(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  overlay = await startOverlay();
}, 300_000);
afterAll(async () => {
  await overlay?.close();
  await rm(root, { recursive: true, force: true });
});

async function verify(project: string, member = false): Promise<readonly string[]> {
  expect(await run(['agents'], project)).toBe(0);
  const text = await readFile(`${project}/AGENTS.md`, 'utf8');
  const installed = await detectPlugins(fs, project);
  const agentPackages = [...installed].filter((pkg) => !TOOLING_PACKAGES.has(pkg));
  const before = text.split('## Not installed')[0];
  const rows = [...before.matchAll(/^\| @setu-ts\/([\w-]+) \|/gm)].map((m) => m[1]);
  expect(installed.has('cli')).toBe(true);
  expect(rows).not.toContain('cli');
  expect(rows.sort()).toEqual(agentPackages.sort());
  const absent = [...text.split('## Not installed')[1].matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]);
  expect(absent).toEqual(
    [...ADDABLE]
      .filter(
        ([, { pkg }]) =>
          !installed.has(pkg) && (RUNTIME_RESTRICTIONS.get(pkg)?.runtimes.includes('node') ?? true),
      )
      .map(([name]) => name),
  );
  expect(text).toContain(installed.has('decorator-plugin') ? 'TC39 decorators' : 'router.get');
  if (installed.has('messaging-plugin')) expect(text).toContain('versioned topics');
  expect(before).toContain('@setu-ts/cache-plugin');
  expect(text.split('## Not installed')[1]).not.toContain('`cache`');
  const missing: string[] = [];
  for (const pkg of agentPackages) {
    const row = before.split('\n').find((line) => line.startsWith(`| @setu-ts/${pkg} |`))!;
    const path = row.split('|').at(-2)!.trim();
    expect(path).toBe(`${member ? '../../' : ''}node_modules/@setu-ts/${pkg}/AGENT_CARD.md`);
    try {
      expect((await stat(resolve(project, path))).isFile()).toBe(true);
    } catch (cause) {
      if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'ENOENT') throw cause;
      missing.push(`${project}/${path}`);
    }
  }
  expect(await run(['agents', '--check'], project)).toBe(0);
  expect(installed.has('audit-plugin')).toBe(false);
  expect(await run(['add', 'audit'], project)).toBe(0);
  expect(await run(['agents', '--check'], project)).toBe(1);
  return missing;
}

describe('agent briefs through packed installs', () => {
  for (const template of ['rest', 'class-based', 'microservice']) {
    it(`${template}: installs cards, gathers real packages and detects add drift`, async () => {
      expect(await run(['new', template, '--template', template, '--runtime', 'node'])).toBe(0);
      const project = `${root}/${template}`;
      expect(await run(['add', 'cache'], project)).toBe(0);
      const result = await npmInstall(project, overlay);
      expect(result.code, result.output).toBe(0);
      expect(await verify(project), 'all named cards must ship in the installed tarballs').toEqual(
        [],
      );
    }, 180_000);
  }
  it('writes root and both members when invoked from a member', async () => {
    expect(await run(['new', 'workspace', '--workspace', '--runtime', 'node'])).toBe(0);
    const workspace = `${root}/workspace`;
    for (const member of ['a', 'b']) {
      expect(await run(['g', 'app', member, '--template', 'rest'], workspace)).toBe(0);
      expect(await run(['add', 'cache'], `${workspace}/apps/${member}`)).toBe(0);
    }
    const result = await npmInstall(workspace, overlay);
    expect(result.code, result.output).toBe(0);
    expect((await stat(`${workspace}/node_modules/@setu-ts/common/AGENT_CARD.md`)).isFile()).toBe(
      true,
    );
    expect(await run(['agents'], `${workspace}/apps/a`)).toBe(0);
    expect(await readFile(`${workspace}/AGENTS.md`, 'utf8')).toContain('apps/b/AGENTS.md');
    expect(await run(['agents', '--check'], workspace)).toBe(0);
    const missing: string[] = [];
    for (const member of ['a', 'b'])
      missing.push(...(await verify(`${workspace}/apps/${member}`, true)));
    expect(missing, 'all named member card paths must resolve from the member directory').toEqual(
      [],
    );
  }, 180_000);
});
