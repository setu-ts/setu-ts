/**
 * A real `setu new --template rest` project converted with `setu adopt`.
 *
 * The three rows this drives are the ones a fixture cannot prove: the project
 * BOOTS and answers `/ready` from the probes the workspace records, the entry the
 * CLI actually wrote is the one the rewrite matches, and the dotenv pair ends up
 * where the member runs with the root copy gone.
 *
 * @module
 */
import { run as runProcess, tempDir } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from '../../src/cli.ts';
import { bootAndProbe, unusedPort, useWorkspacePackages } from '../fixtures/generated-project.ts';
import { DISCOVERY_SPECIFIER, SERVICE_PORT_EXPORT } from '../../src/workspace/discovery-module.ts';
import { WORKSPACE_MANIFEST } from '../../src/workspace/manifest.ts';

const runtime = createNodeRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/** Boots the member and asks the recorded health path. */
const READY_PROBE = `import { createApp } from './setu.config.ts';

const app = await createApp();
await app.start();
const response = await app.fetch(new Request('http://localhost/ready'));
console.log('__PROBE_RESULT__' + JSON.stringify({ status: response.status }));
await app.stop();
`;

/** One path in a project tree: its kind, and its bytes or link target. */
type TreeEntry =
  | { readonly kind: 'dir' }
  | { readonly kind: 'file'; readonly contents: string }
  | { readonly kind: 'link'; readonly target: string };

/**
 * Snapshots a tree without following links, so a refusal cannot hide a mutated
 * file behind a link that readFile would resolve.
 */
async function snapshotTree(root: string): Promise<Record<string, TreeEntry>> {
  const entries: Record<string, TreeEntry> = {};
  async function visit(relative: string): Promise<void> {
    const directory = relative === '' ? root : `${root}/${relative}`;
    for (const entry of await nodeFs.readdir(directory, { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        entries[path] = { kind: 'link', target: await nodeFs.readlink(`${root}/${path}`) };
      } else if (entry.isDirectory()) {
        entries[path] = { kind: 'dir' };
        await visit(path);
      } else {
        entries[path] = {
          kind: 'file',
          contents: (await nodeFs.readFile(`${root}/${path}`)).toString('base64'),
        };
      }
    }
  }
  await visit('');
  return entries;
}

describe('setu adopt on a real scaffold', () => {
  let root: string;
  const out: string[] = [];
  const err: string[] = [];

  const run = (argv: readonly string[]) =>
    runCli(argv, {
      fs,
      cwd: root,
      now: () => runtime.now(),
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });

  beforeEach(async () => {
    root = await tempDir({ prefix: 'setu-adopt-e2e-' });
    out.length = 0;
    err.length = 0;
  });

  afterEach(async () => {
    await nodeFs.rm(root, { recursive: true });
  });

  it('serves /ready, binds the allocated port, and keeps the dotenv pair with the member', async () => {
    const port = await unusedPort();
    expect(await run(['new', 'svc', '--template', 'rest', '--runtime', 'deno'])).toBe(0);

    const project = `${root}/svc`;
    // The scaffold emits the pair this conversion has to move.
    expect(await nodeFs.readFile(`${project}/.env`, 'utf8')).toContain('Local configuration.');

    expect(await run(['adopt', '--dir', project, '--port', String(port)])).toBe(0);
    expect(err.join('\n')).toBe('');

    const member = `${project}/apps/svc`;
    // The entry the CLI rendered is the one the rewrite matches — no hand edit.
    const main = await nodeFs.readFile(`${member}/main.ts`, 'utf8');
    expect(main).toContain(`import { ${SERVICE_PORT_EXPORT} } from '${DISCOVERY_SPECIFIER}';`);
    expect(main).toContain(`await app.start({ port: ${SERVICE_PORT_EXPORT} });`);
    expect(out.join('\n')).not.toContain('port yourself');

    // The dotenv pair moved with the member; nothing is left at the root.
    expect(await nodeFs.readFile(`${member}/.env`, 'utf8')).toContain('Local configuration.');
    expect(await nodeFs.readFile(`${member}/.env.example`, 'utf8')).toContain('Copy this file');
    await expect(nodeFs.readFile(`${project}/.env`, 'utf8')).rejects.toThrow();

    // The manifest records what the dependencies declare, and the probes follow it.
    const manifest = JSON.parse(
      await nodeFs.readFile(`${project}/${WORKSPACE_MANIFEST}`, 'utf8'),
    ) as { members: { healthProbes?: boolean; metricsEndpoint?: boolean }[] };
    expect(manifest.members[0]).toMatchObject({ healthProbes: true, metricsEndpoint: true });
    const k8s = await nodeFs.readFile(`${project}/k8s/members.yaml`, 'utf8');
    expect(k8s).toMatch(/readinessProbe:\n\s+httpGet:\n\s+path: \/ready/);

    // The generated root ignore rules cover the moved file, checked by git itself.
    expect((await runProcess('git', { args: ['init', '-q'], cwd: project })).code).toBe(0);
    expect(
      (
        await runProcess('git', {
          args: ['check-ignore', `apps/svc/.env`],
          cwd: project,
        })
      ).code,
    ).toBe(0);

    await useWorkspacePackages(member);
    const result = (await bootAndProbe(member, READY_PROBE)) as { status?: number };
    expect(result.status).toBe(200);
  });

  // F1: a root rule `/.env` is anchored to the repository root and stops matching
  // the file once it lives under apps/. The member's own .gitignore keeps it
  // ignored, which is checked by git itself rather than by reading the rule.
  it('keeps a moved dotenv file ignored when the root .gitignore is anchored', async () => {
    const port = await unusedPort();
    expect(await run(['new', 'svc', '--template', 'rest', '--runtime', 'deno'])).toBe(0);

    const project = `${root}/svc`;
    await nodeFs.writeFile(`${project}/.gitignore`, 'node_modules/\n/.env\n');

    expect(await run(['adopt', '--dir', project, '--port', String(port)])).toBe(0);
    expect(err.join('\n')).toBe('');

    const member = `${project}/apps/svc`;

    expect((await runProcess('git', { args: ['init', '-q'], cwd: project })).code).toBe(0);
    expect(
      (await runProcess('git', { args: ['check-ignore', '-q', 'apps/svc/.env'], cwd: project }))
        .code,
    ).toBe(0);
    // The example is committed, so it must NOT be ignored.
    expect(
      (
        await runProcess('git', {
          args: ['check-ignore', '-q', 'apps/svc/.env.example'],
          cwd: project,
        })
      ).code,
    ).not.toBe(0);

    expect(await nodeFs.readFile(`${member}/.gitignore`, 'utf8')).toContain('/.env');
  });

  // The member `.gitignore` is generated output, so a refusal at plan time is the
  // only thing standing between a committed link and a write through it. It must
  // refuse a dry run too: a clean plan for a conversion the real run refuses is
  // the defect this covers.
  it('refuses a linked member .gitignore before a dry run or a conversion writes', async () => {
    expect(await run(['new', 'svc', '--template', 'rest', '--runtime', 'deno'])).toBe(0);

    const project = `${root}/svc`;
    const outside = `${root}/outside-gitignore`;
    await nodeFs.writeFile(outside, 'outside\n');
    await nodeFs.mkdir(`${project}/apps/svc`, { recursive: true });
    await nodeFs.symlink(outside, `${project}/apps/svc/.gitignore`);
    const before = await snapshotTree(project);

    out.length = 0;
    err.length = 0;
    expect(await run(['adopt', '--dir', project, '--dry-run'])).toBe(1);
    expect(err.join('\n')).toContain('symbolic link');
    expect(out.join('\n')).not.toContain('would move');
    expect(await snapshotTree(project)).toEqual(before);

    out.length = 0;
    err.length = 0;
    expect(await run(['adopt', '--dir', project])).toBe(1);
    expect(err.join('\n')).toContain('symbolic link');
    expect(await snapshotTree(project)).toEqual(before);
  });

  // The write batch refuses a dangling link before writing through it, but the
  // moves have already happened by then: without the rollback the project's
  // `.env` is left under apps/ and would be staged by a root `/.env` rule.
  it('rolls every move back when a root target is a dangling link', async () => {
    expect(await run(['new', 'svc', '--template', 'rest', '--runtime', 'deno'])).toBe(0);

    const project = `${root}/svc`;
    await nodeFs.symlink(`${root}/missing-dockerignore`, `${project}/.dockerignore`);
    const before = await snapshotTree(project);

    out.length = 0;
    err.length = 0;
    expect(await run(['adopt', '--dir', project])).toBe(1);
    expect(err.join('\n')).toContain('link to something that does not exist');
    expect(err.join('\n')).toContain('Nothing was changed: every move was undone.');
    expect(await snapshotTree(project)).toEqual(before);
  });
});
