/**
 * The test harness a generated test imports, chosen by target runtime.
 *
 * `@std/testing/bdd` is not portable, which review established by running it
 * rather than by reading it: `describe()` reaches `Deno.test` inside
 * `_test_suite.js`, so on Bun the generated `*.service.test.ts` dies with
 * `ReferenceError: Deno is not defined` before a single assertion runs, and on
 * Node the same. Emitting it into a `--runtime node|bun` project produced a file
 * that could not execute at all — and A3, which made every template declare a
 * `test` task, would have pointed those two runtimes at exactly that file.
 *
 * So the harness is per target rather than fixed. Each runtime's own is used,
 * all three spell `describe`/`it`/`expect` the same way, and the emitted test
 * body is therefore identical across targets — only the import line moves.
 *
 * Bun and Node need no dependency for this (`bun:test` and `node:test` are
 * built in), which is why `@std/testing` and `@std/expect` are declared only for
 * Deno targets: declaring them elsewhere shipped two dependencies that could not
 * work.
 *
 * @module
 */

import type { TargetRuntime } from '../constants.ts';

/** How a generated test reaches `describe`, `it` and `expect` on one runtime. */
export interface TestHarness {
  /** The import statement(s) the test file opens with. */
  readonly imports: string;
  /** Whether this runtime needs `@std/testing`/`@std/expect` declared. */
  readonly needsStdDeps: boolean;
}

/**
 * Resolves the test harness for a target runtime.
 *
 * Cloudflare Workers takes the Deno harness: a Workers project is developed on
 * the Deno toolchain here (its `deno.json` is what `setu generate` reads), and
 * its tests run there rather than inside an isolate.
 *
 * @param runtime - The scaffolded project's target
 * @returns The harness that runtime can actually execute
 */
export function testHarnessFor(runtime: TargetRuntime): TestHarness {
  if (runtime === 'bun') {
    return {
      imports: "import { describe, expect, it } from 'bun:test';",
      needsStdDeps: false,
    };
  }

  if (runtime === 'node') {
    // `node:test` exposes `describe`/`it`; `expect` is not built in, so the
    // assertion goes through `node:assert`, which is. Reaching for a matcher
    // library would add a dependency to satisfy a generated stub.
    return {
      imports: "import { describe, it } from 'node:test';\nimport assert from 'node:assert';",
      needsStdDeps: false,
    };
  }

  return {
    imports:
      "import { describe, it } from '@std/testing/bdd';\nimport { expect } from '@std/expect';",
    needsStdDeps: true,
  };
}

/**
 * Renders one equality assertion in the target's own idiom.
 *
 * Node has no `expect`, so the emitted body cannot be shared verbatim across all
 * three. Keeping the difference in ONE function means a generated test never
 * mixes idioms.
 *
 * @param runtime - The scaffolded project's target
 * @param actual - The expression under test
 * @param expected - The expected value, in source form
 * @returns The assertion statement
 */
export function renderEquals(
  runtime: TargetRuntime,
  actual: string,
  expected: string,
): string {
  if (runtime === 'node') return `assert.deepStrictEqual(${actual}, ${expected});`;
  return `expect(${actual}).toEqual(${expected});`;
}
