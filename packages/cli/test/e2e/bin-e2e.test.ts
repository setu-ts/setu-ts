/**
 * The `setu` and `npm create @setu-ts` executables, run as Node runs them.
 *
 * Each is spawned on Node with its TypeScript loaded through `tsx` and
 * `@setu-ts/*` mapped to this workspace's sources — the published binary's
 * shape — so the assertions cover the process boundary itself: the exit code
 * reaches the shell, and output written to a PIPE arrives whole.
 *
 * @module
 */
import { tempDir } from '../../../../test/node-helpers.ts';
import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../src/cli.ts';
import { VERSION } from '../../src/constants.ts';

const SETU = fileURLToPath(new URL('../../src/bin.ts', import.meta.url));
const CREATE = fileURLToPath(new URL('../../../create/src/bin.ts', import.meta.url));

let root = '';
beforeEach(async () => {
  root = await tempDir({ prefix: 'setu-bin-' });
});
afterEach(async () => {
  await nodeFs.rm(root, { recursive: true }).catch(() => {});
});

/** Runs an executable on Node through `tsx`, with output piped. */
function exec(
  bin: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tsx = createRequire(import.meta.url).resolve('tsx/esm');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        new URL('../../../../scripts/lib/source-register.ts', import.meta.url).href,
        '--import',
        pathToFileURL(tsx).href,
        bin,
        ...args,
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** What the in-process CLI prints for the same arguments. */
async function inProcess(args: readonly string[]): Promise<string[]> {
  const lines: string[] = [];
  await runCli(args, {
    fs: createNodeRuntimeServices().fs!,
    cwd: root,
    now: () => 0,
    log: (line) => lines.push(line),
    error: () => {},
  });
  return lines;
}

describe('the setu executable', () => {
  it('prints its version and exits 0', async () => {
    const result = await exec(SETU, ['--version']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`setu ${VERSION}`);
  });

  it('carries a usage error to the shell as exit 2', async () => {
    const result = await exec(SETU, ['new']);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toBe('');
  });

  // The whole plan arrives through the pipe, line for line what the CLI prints
  // in-process. That `bin.ts` sets `process.exitCode` and never calls
  // `process.exit` — the property that keeps a large output from being cut off
  // while a pipe drains — is pinned by `test/unit/bin.test.ts`; this volume
  // (one line per planned file) fits a pipe buffer and cannot show truncation.
  it('delivers the full dry-run plan through a pipe', async () => {
    const args = ['new', 'shop', '--template', 'full-stack', '--dry-run'];
    const expected = await inProcess(args);
    expect(expected.length).toBeGreaterThan(30);
    const result = await exec(SETU, args);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toEqual(expected);
  });

  it('scaffolds a Node project by default', async () => {
    const result = await exec(SETU, ['new', 'shop', '--yes']);
    expect(result.code, result.stderr).toBe(0);
    await nodeFs.stat(`${root}/shop/package.json`);
    await expect(nodeFs.stat(`${root}/shop/deno.json`)).rejects.toThrow();
  });
});

describe('the npm create executable', () => {
  it('is setu new with the caller arguments', async () => {
    const result = await exec(CREATE, ['shop', '--template', 'rest', '--yes']);
    expect(result.code, result.stderr).toBe(0);
    const manifest = JSON.parse(await nodeFs.readFile(`${root}/shop/package.json`, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['@setu-ts/kernel']).toBe(`^${VERSION}`);
  });

  it('passes a usage error through as exit 2', async () => {
    const result = await exec(CREATE, ['--template', 'nope', 'shop']);
    expect(result.code).toBe(2);
  });
});
