/**
 * Unit tests for the per-runtime test harness.
 *
 * `@std/testing/bdd` is not portable, and that was established by RUNNING it
 * rather than reading it: on Bun the generated `*.service.test.ts` failed with
 * `ReferenceError: Deno is not defined`, raised from `Deno.test` inside
 * `@std/testing/_test_suite.js`. Both replacements were then verified on the
 * real runtimes — `bun test` reports `1 pass`, `npm test` reports `pass 1`.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs/promises';
import { run as runProcess, tempDir } from '../../../../../test/node-helpers.ts';
import { renderTestServer } from '../../../src/schematics/test-harness.ts';

import { renderEquals, testHarnessFor } from '../../../src/schematics/test-harness.ts';
import { TARGET_RUNTIMES } from '../../../src/constants.ts';

describe('testHarnessFor', () => {
  it('gives Bun its built-in runner, needing no dependency', () => {
    const harness = testHarnessFor('bun');
    expect(harness.imports).toContain("from 'bun:test'");
    expect(harness.needsStdDeps).toBe(false);
  });

  it('gives Node its built-in runner and assert, needing no dependency', () => {
    const harness = testHarnessFor('node');
    expect(harness.imports).toContain("from 'node:test'");
    expect(harness.imports).toContain("from 'node:assert'");
    expect(harness.needsStdDeps).toBe(false);
  });

  it('gives Deno the std harness, which is the only one that needs declaring', () => {
    const harness = testHarnessFor('deno');
    expect(harness.imports).toContain("from '@std/testing/bdd'");
    expect(harness.needsStdDeps).toBe(true);
  });

  it('gives Workers the Node harness, because its tests run under tsx --test', () => {
    // Workers tests boot the real Worker on workerd through wrangler, but they
    // execute under `tsx --test` exactly as the Node arm's do (V10-23).
    const harness = testHarnessFor('cloudflare-workers');
    expect(harness.imports).toContain("from 'node:test'");
    expect(harness.imports).toContain("from 'node:assert'");
    expect(harness.needsStdDeps).toBe(false);
  });

  it('never emits the non-portable std harness to a runtime that cannot run it', () => {
    // The regression this file exists for, asserted over every target rather
    // than by naming two — a fifth runtime would be covered on arrival.
    for (const runtime of TARGET_RUNTIMES) {
      const harness = testHarnessFor(runtime);
      if (runtime === 'node' || runtime === 'bun' || runtime === 'cloudflare-workers') {
        expect(harness.imports, runtime).not.toContain('@std/');
        expect(harness.needsStdDeps, runtime).toBe(false);
      }
    }
  });

  it('always provides describe and it, whatever the runtime', () => {
    // The emitted test body is identical across targets; only the import moves.
    for (const runtime of TARGET_RUNTIMES) {
      expect(harnessNames(runtime), runtime).toContain('describe');
      expect(harnessNames(runtime), runtime).toContain('it');
    }
  });
});

/** The bound names a harness's import statements bring in. */
function harnessNames(runtime: (typeof TARGET_RUNTIMES)[number]): string {
  return testHarnessFor(runtime).imports;
}

describe('renderEquals', () => {
  it('uses assert on Node and Workers, which run node:test', () => {
    for (const runtime of ['node', 'cloudflare-workers'] as const) {
      expect(renderEquals(runtime, 'listWidget()', '[]'), runtime).toBe(
        'assert.deepStrictEqual(listWidget(), []);',
      );
    }
  });

  it('uses expect everywhere else', () => {
    for (const runtime of ['deno', 'bun'] as const) {
      expect(renderEquals(runtime, 'listWidget()', '[]'), runtime).toBe(
        'expect(listWidget()).toEqual([]);',
      );
    }
  });

  it('pairs its idiom with the harness that supplies it', () => {
    // The failure this prevents is a generated test that imports `node:assert`
    // and then calls `expect`, or the reverse — one function decides both.
    for (const runtime of TARGET_RUNTIMES) {
      const usesAssert = renderEquals(runtime, 'x()', '[]').startsWith('assert.');
      expect(testHarnessFor(runtime).imports.includes('node:assert'), runtime).toBe(usesAssert);
    }
  });
});

describe('generated socket test server', () => {
  for (const [kind, failures, expectedAttempts, ok, stopFails] of [
    ['code', 1, 2, true, false],
    ['message', 1, 2, true, false],
    ['code', 5, 3, false, false],
    ['other', 5, 1, false, false],
    ['code', 1, 2, true, true],
    ['message', 1, 2, true, true],
    ['code', 5, 3, false, true],
    ['other', 5, 1, false, true],
  ] as const) {
    it(`handles ${kind} startup failures (${failures}) and closes every app${stopFails ? ' with failing cleanup' : ''}`, async () => {
      const root = await tempDir({ prefix: 'setu-test-server-' });
      try {
        await nodeFs.mkdir(`${root}/test/support`, { recursive: true });
        await nodeFs.writeFile(`${root}/test/support/server.ts`, renderTestServer('node'));
        await nodeFs.writeFile(
          `${root}/setu.config.ts`,
          `
let attempts = 0;
let stops = 0;
export function createApp() {
  return {
    async start(options: { port: number; hostname: string }): Promise<void> {
      attempts++;
      if (options.port <= 0 || options.hostname !== '127.0.0.1') throw new Error('bad listen options');
      if (attempts <= ${failures}) {
        const error = new Error(${JSON.stringify(kind === 'message' ? 'Address already in use' : 'startup failed')});
        ${kind === 'code' ? "Object.assign(error, { code: 'EADDRINUSE' });" : ''}
        throw error;
      }
    },
    async stop(): Promise<void> {
      stops++;
      ${stopFails ? `if (attempts <= ${failures}) throw new Error('cleanup failed');` : ''}
    },
  };
}
export function counts() { return { attempts, stops }; }
`,
        );
        await nodeFs.writeFile(
          `${root}/probe.ts`,
          `
import { startTestServer } from './test/support/server.ts';
import { counts } from './setu.config.ts';
let ok = false;
let message = '';
try {
  const server = await startTestServer();
  ok = server.baseUrl.startsWith('http://127.0.0.1:');
  await server.stop();
} catch (error) { message = error instanceof Error ? error.message : String(error); }
console.log(JSON.stringify({ ok, message, ...counts() }));
`,
        );
        const result = await runProcess(process.execPath, {
          args: [`${root}/probe.ts`],
          stdout: 'piped',
          stderr: 'piped',
        });
        expect(result.code, new TextDecoder().decode(result.stderr)).toBe(0);
        expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
          ok,
          message: ok ? '' : 'startup failed',
          attempts: expectedAttempts,
          stops: expectedAttempts,
        });
      } finally {
        await nodeFs.rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe('generated Workers test server', () => {
  it('boots the real Worker through wrangler and keeps the shared signature', () => {
    const server = renderTestServer('cloudflare-workers');
    expect(server).toContain("import { createTestHarness } from 'wrangler';");
    // Anchored to the file, never the working directory (M119h audit F2).
    expect(server).toContain("configPath: new URL('../../wrangler.toml', import.meta.url)");
    expect(server).not.toContain("configPath: './wrangler.toml'");
    expect(server).toContain('const { url } = await harness.listen();');
    expect(server).toContain('baseUrl: url.origin');
    expect(server).toContain('await harness.close();');
    expect(server).not.toContain("from 'node:net'");
  });

  it('exports the same startTestServer signature on every runtime', () => {
    const signature = 'export async function startTestServer(): Promise<';
    for (const runtime of TARGET_RUNTIMES) {
      expect(renderTestServer(runtime), runtime).toContain(signature);
    }
  });
});
