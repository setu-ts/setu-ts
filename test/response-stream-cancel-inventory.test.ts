/**
 * Every web stream a published package builds or hands the kernel as a
 * response body, classified against the kernel's abort rule for a streamed
 * response: when the client leaves, the kernel cancels the body and runs the
 * request's `ctx.defer` cleanups once the body's `cancel()` settles. The
 * kernel cannot see a source's `pull` or a pump it started, so a source that
 * does work of its own must make `cancel()` wait for it, or that work can
 * outlive the request's resources.
 *
 * Sites are found with the TypeScript compiler, not by text: every
 * `new ReadableStream`, `Readable.toWeb(…)` and `ReadableStream.from(…)`
 * (constructions), and every `….response.stream(…)` / `response.stream(…)`
 * call (hand-offs), in each package's `src`. Text inside a string — the
 * CLI's templates — is not code and is not counted. The tables are the
 * enumeration: the test fails when a site is added, moved or removed without
 * a row, or when the code a row's classification rests on changes. A row's
 * classification is evidence in the source, read by a person; the kernel's
 * own wrapper is also proved by behaviour in `packages/kernel/test`.
 *
 * @module
 */
import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** How a stream source relates to the cancel contract. */
type Kind =
  /** Pushes from `start` (or enqueues once); it does no work of its own after that. */
  | 'push'
  /** Does work of its own and `cancel()` waits for it. */
  | 'cancel-awaits-work'
  /** Forwards `cancel()` to the stream it wraps and returns its promise. */
  | 'forwards-cancel'
  /** `cancel()` does not wait for the source's own work; that work uses only the stream's own source. */
  | 'cancel-does-not-await'
  /** The kernel's own wrapper: the reader that applies the rule. */
  | 'kernel-wrapper'
  /** A hand-off of a body built in this package (classified in CONSTRUCTIONS). */
  | 'own-construction'
  /** A hand-off of a body another package, library or runtime built; its `cancel()` is theirs. */
  | 'pass-through';

/** One classified file. */
interface Row {
  readonly file: string;
  /** How many sites of this table's shape the file holds. */
  readonly count: number;
  readonly kind: Kind;
  /** Text the classification rests on; it must still be in the file. */
  readonly evidence: RegExp;
  /** For a pass-through: the CONSTRUCTIONS row that builds the body, when one does. */
  readonly builtBy?: string;
  /**
   * Whether this source's `cancel()` always settles. The kernel waits for it
   * with no time limit, so one that hangs keeps the request's resources:
   * `always`; `as-its-source` (it forwards to the stream it wraps);
   * `may-hang` (named case); `unknown` (another library's stream).
   */
  readonly cancelSettles: 'always' | 'as-its-source' | 'may-hang' | 'unknown';
  /** The lane that owns a site outside Core that does not, or may not, meet the contract. */
  readonly handOver?: string;
}

const CONSTRUCTIONS: readonly Row[] = [
  {
    file: 'packages/agent-runs-plugin/src/log/respond.ts',
    count: 1,
    cancelSettles: 'always',
    kind: 'push',
    evidence: /new ReadableStream<Uint8Array>\(\{\s*start\(controller\)/,
  },
  {
    file: 'packages/graphql-plugin/src/transports/sse/graphql-sse-handler.ts',
    count: 1,
    cancelSettles: 'always',
    kind: 'push',
    evidence: /new ReadableStream<Uint8Array>\(\{\s*start: \(controller\)/,
  },
  {
    // An async generator queues `return()` behind a pending `next()`.
    file: 'packages/grpc-plugin/src/transports/native-grpc-reply.ts',
    count: 1,
    cancelSettles: 'may-hang',
    kind: 'cancel-awaits-work',
    evidence: /async cancel\(reason\) \{[\s\S]{0,120}await iterator\?\.return\?\.\(\)/,
    handOver:
      'M143c (Services lane): cancel() awaits iterator.return(), queued behind a next() a stuck handler generator never settles',
  },
  {
    file: 'packages/grpc-plugin/src/transports/rpc-call.ts',
    count: 1,
    cancelSettles: 'may-hang',
    kind: 'cancel-awaits-work',
    evidence: /async cancel\(\) \{\s*await iterator\.return\?\.\(\)/,
    handOver:
      'M143c (Services lane): cancel() awaits iterator.return(), queued behind a next() a stuck handler generator never settles',
  },
  {
    file: 'packages/kernel/src/context/deferred.ts',
    count: 1,
    cancelSettles: 'as-its-source',
    kind: 'kernel-wrapper',
    evidence: /reader\.cancel\(/,
  },
  {
    file: 'packages/kernel/src/context/stream-guard.ts',
    count: 1,
    cancelSettles: 'as-its-source',
    kind: 'forwards-cancel',
    evidence: /cancel\(reason: unknown\): Promise<void> \{\s*return reader\.cancel\(reason\);/,
  },
  {
    file: 'packages/runtime/src/adapters/bun/bun-http-adapter.ts',
    count: 1,
    cancelSettles: 'as-its-source',
    kind: 'forwards-cancel',
    evidence: /cancel\(reason\) \{\s*return reader\.cancel\(reason\);/,
  },
  {
    // Node's `Readable.toWeb` over a file read stream: cancel destroys the
    // Readable, whose reads use only its own file descriptor.
    file: 'packages/runtime/src/adapters/bun/bun-runtime.ts',
    count: 1,
    cancelSettles: 'always',
    kind: 'cancel-does-not-await',
    evidence: /const web = Readable\.toWeb\(stream as never\);/,
  },
  {
    file: 'packages/runtime/src/adapters/deno/deno-http-adapter.ts',
    count: 1,
    cancelSettles: 'as-its-source',
    kind: 'forwards-cancel',
    evidence: /cancel\(reason\) \{\s*return reader\.cancel\(reason\);/,
  },
  {
    // A file read stream: its pull touches only the file handle it closes.
    file: 'packages/runtime/src/adapters/deno/deno-runtime.ts',
    count: 1,
    cancelSettles: 'always',
    kind: 'cancel-does-not-await',
    evidence: /cancel: async \(\) => \{\s*cancelled = true;\s*await closeFile\(\);/,
  },
  {
    file: 'packages/runtime/src/adapters/node/node-http-adapter.ts',
    count: 2,
    cancelSettles: 'as-its-source',
    kind: 'forwards-cancel',
    evidence: /cancel\(reason\) \{\s*return reader\.cancel\(reason\);/,
  },
  {
    file: 'packages/runtime/src/adapters/node/node-runtime.ts',
    count: 1,
    cancelSettles: 'always',
    kind: 'cancel-does-not-await',
    evidence: /const web = Readable\.toWeb\(stream as never\);/,
  },
  {
    file: 'packages/sse-plugin/src/connection/sse-connection.ts',
    count: 1,
    cancelSettles: 'always',
    kind: 'push',
    evidence: /new ReadableStream<Uint8Array>\(\s*\{\s*start\(controller\)/,
  },
  {
    // Node Readable adapter (pull waits for 'readable'), the eager iterable
    // pump (in start), and the event-push adapter. Each cancel sets a flag
    // and returns without awaiting.
    file: 'packages/storage-plugin/src/providers/provider-stream.ts',
    count: 3,
    cancelSettles: 'always',
    kind: 'cancel-does-not-await',
    evidence:
      /cancel\(\): void \{\s*closed = true;[\s\S]*cancel\(\): void \{\s*closed = true;[\s\S]*cancel\(\): void \{\s*stopped = true;/,
    handOver: 'M143r (Integrations lane)',
  },
  {
    file: 'packages/storage-plugin/src/providers/s3-provider.ts',
    count: 1,
    cancelSettles: 'always',
    kind: 'push',
    evidence: /new ReadableStream\(\{\s*start\(controller\) \{\s*controller\.enqueue\(res\.Body\);/,
  },
  {
    file: 'packages/storage-plugin/src/services/storage-service.ts',
    count: 1,
    cancelSettles: 'always',
    kind: 'push',
    evidence: /new ReadableStream\(\{\s*start\(controller\) \{\s*controller\.enqueue\(data\);/,
  },
];

const HAND_OFFS: readonly Row[] = [
  {
    file: 'packages/agent-runs-plugin/src/log/respond.ts',
    count: 1,
    cancelSettles: 'always',
    kind: 'own-construction',
    evidence: /return ctx\.response\.stream\(stream\);/,
  },
  {
    // The Workers Cache API's stored body (workerd's own stream).
    file: 'packages/cloudflare-plugin/src/cache-api/cache-api-middleware.ts',
    count: 1,
    cancelSettles: 'unknown',
    kind: 'pass-through',
    evidence: /response\.stream\(cached\.body\);/,
    handOver: "M143o (Workers lane): confirm workerd's cached body needs no cancel() wait",
  },
  {
    file: 'packages/graphql-plugin/src/transports/sse/graphql-sse-handler.ts',
    count: 2,
    cancelSettles: 'always',
    kind: 'own-construction',
    evidence: /return response\.stream\(controller\.readable\);/,
  },
  {
    file: 'packages/kernel/src/application/application.ts',
    count: 3,
    cancelSettles: 'as-its-source',
    kind: 'kernel-wrapper',
    evidence: /wrapDeferredStream\(/,
  },
  {
    // The MCP SDK's transport response body, and a dispatched snapshot's body.
    file: 'packages/mcp-plugin/src/plugin/mcp-plugin.ts',
    count: 2,
    cancelSettles: 'unknown',
    kind: 'pass-through',
    evidence: /return request\.response\.stream\(response\.body\);/,
    handOver: "M143l (Web lane): confirm the MCP SDK body's cancel() waits for tool work",
  },
  {
    // React Router's server render stream (react-dom's renderToReadableStream).
    file: 'packages/react-router-plugin/src/handler/request-bridge.ts',
    count: 1,
    cancelSettles: 'unknown',
    kind: 'pass-through',
    evidence: /return ctx\.response\.stream\(response\.body\);/,
    handOver: "M143l (Web lane): confirm React's render stream cancel() waits for render work",
  },
  {
    file: 'packages/sse-plugin/src/connection/sse-connection.ts',
    count: 1,
    cancelSettles: 'always',
    kind: 'own-construction',
    evidence: /value: ctx\.response\.stream\(stream\),/,
  },
  {
    file: 'packages/static-plugin/src/handler/static-handler.ts',
    count: 2,
    cancelSettles: 'always',
    kind: 'pass-through',
    evidence: /if \(body instanceof ReadableStream\) \{\s*return response\.stream\(body\);/,
    builtBy: 'packages/runtime/src/adapters/node/node-runtime.ts',
  },
];

/** Every `.ts` file under a directory. */
async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (entry.isFile() && path.endsWith('.ts') && !path.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

/** Whether an expression is the identifier `name` (or `….name`). */
function named(node: ts.Expression, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name;
  return ts.isPropertyAccessExpression(node) && node.name.text === name;
}

/** Counts the construction and hand-off sites in one file's code. */
function sites(path: string, text: string): { constructions: number; handOffs: number } {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  let constructions = 0;
  let handOffs = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && named(node.expression, 'ReadableStream')) constructions++;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: target, name } = node.expression;
      if (name.text === 'toWeb' && named(target, 'Readable')) constructions++;
      if (name.text === 'from' && named(target, 'ReadableStream')) constructions++;
      if (name.text === 'stream' && named(target, 'response')) handOffs++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { constructions, handOffs };
}

/** Each package `src` file with sites, per shape. */
async function inventory(): Promise<{
  constructions: Record<string, number>;
  handOffs: Record<string, number>;
}> {
  const constructions: Record<string, number> = {};
  const handOffs: Record<string, number> = {};
  for (const pkg of await readdir('packages', { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    let files: string[];
    try {
      files = await sources(`packages/${pkg.name}/src`);
    } catch {
      continue;
    }
    for (const path of files) {
      const found = sites(path, await readFile(path, 'utf8'));
      if (found.constructions > 0) constructions[path] = found.constructions;
      if (found.handOffs > 0) handOffs[path] = found.handOffs;
    }
  }
  return { constructions, handOffs };
}

/** A table as `{ file: count }`. */
function tally(rows: readonly Row[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.file, row.count]));
}

describe('response stream sources and the cancel contract', () => {
  it('classifies every web stream a package builds', async () => {
    expect((await inventory()).constructions).toEqual(tally(CONSTRUCTIONS));
  });

  it('classifies every body a package hands to response.stream()', async () => {
    expect((await inventory()).handOffs).toEqual(tally(HAND_OFFS));
  });

  it('counts code only, never text inside a string', () => {
    const text = 'const t = `ctx.response.stream(new ReadableStream({}))`;\nnew ReadableStream();';
    expect(sites('x.ts', text)).toEqual({ constructions: 1, handOffs: 0 });
  });

  it.each([...CONSTRUCTIONS, ...HAND_OFFS])('$file is $kind', async (row) => {
    expect(await readFile(row.file, 'utf8')).toMatch(row.evidence);
  });

  it('names a hand-over for every site outside Core that may not wait in, or settle, cancel()', () => {
    const core = /^packages\/(kernel|runtime|common|logger-plugin|health-plugin)\//;
    const built = new Set(CONSTRUCTIONS.map((row) => row.file));
    for (const row of [...CONSTRUCTIONS, ...HAND_OFFS]) {
      if (core.test(row.file)) continue;
      if (row.builtBy !== undefined) {
        expect(built.has(row.builtBy), row.file).toBe(true);
        continue;
      }
      if (
        row.kind === 'cancel-does-not-await' ||
        row.kind === 'pass-through' ||
        row.cancelSettles === 'may-hang' ||
        row.cancelSettles === 'unknown'
      ) {
        expect(row.handOver, row.file).toBeDefined();
      }
    }
  });
});
