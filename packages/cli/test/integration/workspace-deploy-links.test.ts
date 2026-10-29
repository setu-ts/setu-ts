import { tempDir } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
/**
 * `setu workspace deploy` reads secrets and manifests only from regular files inside the
 * workspace — on a REAL filesystem, with real links (M122 audit F2).
 *
 * A branch can replace `k8s/secrets/<member>` with a committed symlink, and git checkout then
 * removes the operator's ignored directory to make room. Followed, the link loaded another
 * project's `.env` into a pod that branch's code runs in, and hid a tracked file from
 * `git ls-files`. A fake filesystem has no links or FIFOs, so this drives the real one.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { parseArgs } from '../../src/args.ts';
import { runWorkspaceCommand } from '../../src/commands/workspace.ts';
import { runCheckCommand } from '../../src/commands/check.ts';
import { createCommandRunner, type CommandRunner } from '../../src/utils/run-command.ts';
import { workspaceK8sFiles } from '../../src/workspace/k8s.ts';
import {
  renderWorkspaceManifest,
  WORKSPACE_VERSION,
  type WorkspaceManifest,
} from '../../src/workspace/manifest.ts';
import { transportSpec } from '../../src/workspace/transport.ts';

const fs = createNodeRuntimeServices().fs!;
const CANARY = 'canary-outside-host-file';
let base = '';
let root = '';
let outside = '';

const manifest: WorkspaceManifest = {
  version: WORKSPACE_VERSION,
  runtime: 'node',
  basePort: 3000,
  transport: 'http',
  members: [{ name: 'portal', port: 3000 }],
};

beforeEach(async () => {
  base = await nodeFs.realpath(await tempDir({ prefix: 'setu-m122-links-' }));
  root = `${base}/ws`;
  outside = `${base}/outside`;
  await nodeFs.mkdir(`${root}/apps/portal`, { recursive: true });
  await nodeFs.mkdir(`${root}/k8s`, { recursive: true });
  await nodeFs.mkdir(outside);
  await nodeFs.writeFile(`${root}/setu.workspace.json`, renderWorkspaceManifest(manifest));
  await nodeFs.writeFile(`${root}/package-lock.json`, '{}');
  for (const file of workspaceK8sFiles(manifest, transportSpec('http'))) {
    await nodeFs.writeFile(`${root}/${file.path}`, file.contents);
  }
  await nodeFs.writeFile(`${root}/apps/portal/.env.example`, 'SESSION_SECRET=\n');
  await nodeFs.writeFile(`${outside}/.env`, `SESSION_SECRET=${CANARY}\n`);
});

afterEach(async () => {
  await nodeFs.chmod(`${root}/k8s/secrets/portal/.env`, 0o600).catch(() => {});
  await nodeFs.rm(base, { recursive: true }).catch(() => {});
});

/** Runs `deploy` against a recording runner; returns the exit code, output and applies. */
async function deploy() {
  const out: string[] = [];
  const err: string[] = [];
  const inputs: string[] = [];
  const runner: CommandRunner = (command, args, options) => {
    if (options.input !== undefined) inputs.push(options.input);
    const line = `${command} ${args.join(' ')}`;
    if (line === 'git rev-parse --short HEAD')
      return Promise.resolve({ code: 128, stdout: '', stderr: '' });
    if (line === 'git rev-parse --is-inside-work-tree') {
      return Promise.resolve({
        code: 128,
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      });
    }
    if (line === 'kubectl config current-context') {
      return Promise.resolve({ code: 0, stdout: 'kind-dev\n', stderr: '' });
    }
    // A Secret apply answers with its resourceVersion, as the API server does.
    if (args.includes('--server-side'))
      return Promise.resolve({ code: 0, stdout: '1', stderr: '' });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const code = await runWorkspaceCommand(parseArgs(['deploy', '--namespace', 'shop']), {
    fs,
    cwd: root,
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    now: () => 0,
    runCommand: runner,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), inputs };
}

describe('setu workspace deploy reads only regular files inside the workspace', () => {
  it('deploys a plain values file (positive control)', async () => {
    await nodeFs.mkdir(`${root}/k8s/secrets/portal`, { recursive: true });
    await nodeFs.writeFile(`${root}/k8s/secrets/portal/.env`, 'SESSION_SECRET=inside\n');
    const result = await deploy();
    expect(result.code, result.err).toBe(0);
    expect(result.inputs.some((input) => input.includes(`SESSION_SECRET: ${btoa('inside')}`))).toBe(
      true,
    );
  });

  it('refuses a secrets directory that links outside the workspace', async () => {
    await nodeFs.mkdir(`${root}/k8s/secrets`);
    await nodeFs.symlink(outside, `${root}/k8s/secrets/portal`, 'dir');
    const result = await deploy();
    expect(result.code).toBe(1);
    expect(result.err).toContain('through a symbolic link');
    expect(result.inputs).toEqual([]);
    expect(`${result.out}${result.err}`).not.toContain(CANARY);
  });

  it('refuses a values file that is itself a link', async () => {
    await nodeFs.mkdir(`${root}/k8s/secrets/portal`, { recursive: true });
    await nodeFs.symlink(`${outside}/.env`, `${root}/k8s/secrets/portal/.env`);
    const result = await deploy();
    expect(result.code).toBe(1);
    expect(result.err).toContain('k8s/secrets/portal/.env');
    expect(result.inputs).toEqual([]);
  });

  it('refuses a FIFO instead of hanging on it', async () => {
    await nodeFs.mkdir(`${root}/k8s/secrets/portal`, { recursive: true });
    execFileSync('mkfifo', [`${root}/k8s/secrets/portal/.env`]);
    const result = await deploy();
    expect(result.code).toBe(1);
    expect(result.err).toContain('k8s/secrets/portal/.env');
    expect(result.inputs).toEqual([]);
  }, 10_000);

  it.skipIf(process.getuid?.() === 0)(
    'reports an unreadable values file instead of crashing',
    async () => {
      await nodeFs.mkdir(`${root}/k8s/secrets/portal`, { recursive: true });
      await nodeFs.writeFile(`${root}/k8s/secrets/portal/.env`, 'SESSION_SECRET=x\n');
      await nodeFs.chmod(`${root}/k8s/secrets/portal/.env`, 0o000);
      const result = await deploy();
      expect(result.code).toBe(1);
      expect(result.err).toContain('k8s/secrets/portal/.env:');
      expect(result.inputs).toEqual([]);
    },
  );

  it('refuses a members.yaml that links outside the workspace', async () => {
    await nodeFs.writeFile(
      `${outside}/members.yaml`,
      await nodeFs.readFile(`${root}/k8s/members.yaml`),
    );
    await nodeFs.rm(`${root}/k8s/members.yaml`);
    await nodeFs.symlink(`${outside}/members.yaml`, `${root}/k8s/members.yaml`);
    const result = await deploy();
    expect(result.code).toBe(1);
    expect(result.err).toContain('k8s/members.yaml');
    expect(result.inputs).toEqual([]);
  });
});

describe('setu check refuses a member .env that Compose would follow (re-audit N4)', () => {
  /** Runs `setu check` on the workspace; returns its exit code and errors. */
  async function check() {
    const err: string[] = [];
    await nodeFs.writeFile(
      `${root}/package.json`,
      '{"name":"ws","private":true,"workspaces":["apps/*"]}',
    );
    await nodeFs.writeFile(`${root}/apps/portal/package.json`, '{"name":"portal"}');
    const code = await runCheckCommand(parseArgs(['check']), {
      fs,
      cwd: root,
      log: () => {},
      error: (m) => err.push(m),
    });
    return { code, err: err.join('\n') };
  }

  it('accepts a regular .env (positive control)', async () => {
    await nodeFs.writeFile(`${root}/apps/portal/.env`, 'SESSION_SECRET=local\n');
    expect((await check()).err).not.toContain('apps/portal/.env');
  });

  it('refuses a linked .env and a non-regular one', async () => {
    await nodeFs.symlink(`${outside}/.env`, `${root}/apps/portal/.env`);
    const linked = await check();
    expect(linked.code).toBe(1);
    expect(linked.err).toContain('apps/portal/.env is a symbolic link. docker compose follows it');
    await nodeFs.rm(`${root}/apps/portal/.env`);
    await nodeFs.mkdir(`${root}/apps/portal/.env`);
    const directory = await check();
    expect(directory.code).toBe(1);
    expect(directory.err).toContain('apps/portal/.env is not a regular file');
  });
});

describe('the committed-values check ignores inherited GIT_* variables (audit 3, L1)', () => {
  it('refuses a committed values file even with GIT_DIR and GIT_INDEX_FILE aimed elsewhere', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 'm122@example.test');
    git('config', 'user.name', 'm122');
    await nodeFs.mkdir(`${root}/k8s/secrets/portal`, { recursive: true });
    await nodeFs.writeFile(`${root}/k8s/secrets/portal/.env`, 'SESSION_SECRET=committed\n');
    git('add', '-A');
    git('commit', '-qm', 'committed values');
    const real = createCommandRunner();
    const runner: CommandRunner = (command, args, options) => {
      if (command === 'git') return real(command, args, options);
      if (args.join(' ') === 'config current-context') {
        return Promise.resolve({ code: 0, stdout: 'kind-dev\n', stderr: '' });
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    const saved = { dir: process.env['GIT_DIR'], index: process.env['GIT_INDEX_FILE'] };
    process.env['GIT_DIR'] = '/nonexistent-m122';
    process.env['GIT_INDEX_FILE'] = `${outside}/empty-index`;
    const err: string[] = [];
    try {
      const code = await runWorkspaceCommand(
        parseArgs(['deploy', '--namespace', 'shop', '--tag', 'v1']),
        {
          fs,
          cwd: root,
          log: () => {},
          error: (m) => err.push(m),
          now: () => 0,
          runCommand: runner,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('k8s/secrets/portal/.env is tracked by git');
    } finally {
      for (const [name, value] of [
        ['GIT_DIR', saved.dir],
        ['GIT_INDEX_FILE', saved.index],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
