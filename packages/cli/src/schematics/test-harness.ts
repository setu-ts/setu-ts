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
import type { DerivedNames } from '../utils/names.ts';
import { stringLiteral } from '../workspace/runtime-profile.ts';

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
 * Cloudflare Workers takes the Node harness: its tests boot the real Worker on
 * workerd through wrangler and run under `tsx --test`, exactly as the Node
 * arm's do, so they use `node:test` and `node:assert` rather than the Deno
 * modules a Workers project does not import.
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

  if (runtime === 'node' || runtime === 'cloudflare-workers') {
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
 * mixes idioms. Workers runs through `node:test`, so it follows Node's idiom.
 *
 * @param runtime - The scaffolded project's target
 * @param actual - The expression under test
 * @param expected - The expected value, in source form
 * @returns The assertion statement
 */
export function renderEquals(runtime: TargetRuntime, actual: string, expected: string): string {
  if (runtime === 'node' || runtime === 'cloudflare-workers') {
    return `assert.deepStrictEqual(${actual}, ${expected});`;
  }
  return `expect(${actual}).toEqual(${expected});`;
}

/**
 * Test support that boots the real application for a generated test.
 *
 * A socket target starts the application on a free loopback port. A Workers
 * project cannot: `wrangler dev` serves a `fetch` export, and a template may
 * need the bindings its `wrangler.toml` declares to boot at all. So it starts
 * the Worker on workerd through wrangler's test harness instead, which supplies
 * those bindings. Both variants export the same `startTestServer()` signature,
 * so every generated test body is runtime-independent.
 *
 * @param runtime - The scaffolded project's target
 * @returns The `test/support/server.ts` contents
 */
export function renderTestServer(runtime: TargetRuntime): string {
  if (runtime === 'cloudflare-workers') {
    return `import { createTestHarness } from 'wrangler';

/**
 * Boots the real Worker on workerd, with the bindings \`wrangler.toml\` declares.
 *
 * The config is located from this file, not the working directory: wrangler
 * resolves a relative path from \`process.cwd()\`, so tests started elsewhere would
 * load that directory's \`wrangler.toml\`, build command included.
 */
export async function startTestServer(): Promise<
  { readonly baseUrl: string; readonly stop: () => Promise<void> }
> {
  const harness = createTestHarness({
    workers: [{ configPath: new URL('../../wrangler.toml', import.meta.url) }],
  });
  const { url } = await harness.listen();
  return {
    baseUrl: url.origin,
    stop: async () => {
      await harness.close();
    },
  };
}
`;
  }
  return `import { createServer } from 'node:net';
import { createApp } from '../../setu.config.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No TCP port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
  return port;
}

/** Boots the real application on a free loopback port. */
export async function startTestServer(): Promise<
  { readonly baseUrl: string; readonly stop: () => Promise<void> }
> {
  for (let attempt = 0;; attempt++) {
    const port = await freePort();
    const app = await createApp();
    try {
      await app.start({ port, hostname: '127.0.0.1' });
      return {
        baseUrl: \`http://127.0.0.1:\${port}\`,
        stop: async () => {
          await app.stop();
        },
      };
    } catch (error) {
      try {
        await app.stop();
      } catch {
        // Cleanup must not replace the start error or prevent a bind retry.
      }
      if (
        attempt >= 2 || !(error instanceof Error) ||
        !(('code' in error && error.code === 'EADDRINUSE') ||
          /EADDRINUSE|address already in use/i.test(error.message))
      ) throw error;
    }
  }
}
`;
}

/** Module contract that survives replacing the in-memory store. */
export function renderModuleTest(names: DerivedNames, runtime: TargetRuntime): string {
  const eq = (actual: string, expected: string): string => renderEquals(runtime, actual, expected);
  if (runtime === 'cloudflare-workers') {
    return `${testHarnessFor(runtime).imports}
import { startTestServer } from '../../../test/support/server.ts';

describe('${names.kebab} module', () => {
  it('lists records and reads a created record back', async () => {
    const server = await startTestServer();
    try {
      const list = await fetch(server.baseUrl + '/${names.kebab}');
      ${eq('list.status', '200')}
      const listed: { items: unknown[] } = await list.json();
      ${eq('Array.isArray(listed.items)', 'true')}
      const created = await fetch(server.baseUrl + '/${names.kebab}', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Example' }),
      });
      ${eq('created.status', '201')}
      const record: { id: string; name: string } = await created.json();
      ${eq('record.name', "'Example'")}
      const read = await fetch(server.baseUrl + '/${names.kebab}/' + record.id);
      ${eq('read.status', '200')}
      ${eq('await read.json()', 'record')}
    } finally {
      await server.stop();
    }
  });
});
`;
  }
  return `${testHarnessFor(runtime).imports}
import { createTestApp } from '@setu-ts/testing';
import { createApp } from '../../../setu.config.ts';

describe('${names.kebab} module', () => {
  it('lists records and reads a created record back', async () => {
    const app = await createTestApp({ app: await createApp() });
    try {
      const list = await app.inject({ method: 'GET', url: '/${names.kebab}' });
      ${eq('list.statusCode', '200')}
      ${eq('Array.isArray(list.json<{ items: unknown[] }>().items)', 'true')}
      const created = await app.inject({
        method: 'POST',
        url: '/${names.kebab}',
        body: { name: 'Example' },
      });
      ${eq('created.statusCode', '201')}
      const record = created.json<{ id: string; name: string }>();
      ${eq('record.name', "'Example'")}
      const read = await app.inject({ method: 'GET', url: \`/${names.kebab}/\${record.id}\` });
      ${eq('read.statusCode', '200')}
      ${eq('read.json()', 'record')}
    } finally {
      await app.stop();
    }
  });
});
`;
}

/** Real-socket module contract, including validation and OpenAPI when installed. */
export function renderModuleE2e(
  names: DerivedNames,
  runtime: TargetRuntime,
  validation: boolean,
  openapi: boolean,
): string {
  const eq = (actual: string, expected: string): string => renderEquals(runtime, actual, expected);
  return `${testHarnessFor(runtime).imports}
import { startTestServer } from '../../../test/support/server.ts';

describe('${names.kebab} e2e', () => {
  it('creates and reads a record over HTTP', async () => {
    const server = await startTestServer();
    try {
      const created = await fetch(server.baseUrl + '/${names.kebab}', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Example' }),
      });
      ${eq('created.status', '201')}
      const record: { id: string; name: string } = await created.json();
      ${eq('record.name', "'Example'")}
      const read = await fetch(server.baseUrl + '/${names.kebab}/' + record.id);
      ${eq('read.status', '200')}
      ${eq('await read.json()', 'record')}
      ${validation ? `const invalid = await fetch(server.baseUrl + '/${names.kebab}', {\n        method: 'POST',\n        headers: { 'content-type': 'application/json' },\n        body: '{}',\n      });\n      ${eq('invalid.status', '400')}\n      await invalid.text();` : ''}
      ${openapi ? `const spec = await fetch(server.baseUrl + '/openapi.json');\n      const document: { paths: Record<string, unknown> } = await spec.json();\n      ${eq(`Object.hasOwn(document.paths, '/${names.kebab}')`, 'true')}` : ''}
    } finally {
      await server.stop();
    }
  });
});
`.replace(/^[ \t]+\n/gm, '');
}

/** App-level socket smoke test requesting each advertised probe. */
export function renderAppE2e(
  runtime: TargetRuntime,
  paths: readonly string[],
  support = '../support/server.ts',
): string {
  return `${testHarnessFor(runtime).imports}
import { startTestServer } from '${support}';

describe('application e2e', () => {
  it('serves its public endpoints over HTTP', async () => {
    const server = await startTestServer();
    try {
      for (const path of [${paths.map(stringLiteral).join(', ')}]) {
        const response = await fetch(server.baseUrl + path);
        ${renderEquals(runtime, 'response.status', '200')}
        await response.text();
      }
    } finally {
      await server.stop();
    }
  });
});
`;
}
