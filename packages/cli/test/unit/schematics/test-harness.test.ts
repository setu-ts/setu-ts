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

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

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

  it('gives Workers the Deno harness, because that is its toolchain', () => {
    // A Workers project's tests run on the Deno toolchain its `deno.json`
    // describes, not inside an isolate.
    expect(testHarnessFor('cloudflare-workers').imports).toContain("from '@std/testing/bdd'");
  });

  it('never emits the non-portable std harness to a runtime that cannot run it', () => {
    // The regression this file exists for, asserted over every target rather
    // than by naming two — a fifth runtime would be covered on arrival.
    for (const runtime of TARGET_RUNTIMES) {
      const harness = testHarnessFor(runtime);
      if (runtime === 'node' || runtime === 'bun') {
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
  it('uses assert on Node, which has no expect', () => {
    expect(renderEquals('node', 'listWidget()', '[]'))
      .toBe('assert.deepStrictEqual(listWidget(), []);');
  });

  it('uses expect everywhere else', () => {
    for (const runtime of ['deno', 'bun', 'cloudflare-workers'] as const) {
      expect(renderEquals(runtime, 'listWidget()', '[]'), runtime)
        .toBe('expect(listWidget()).toEqual([]);');
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
