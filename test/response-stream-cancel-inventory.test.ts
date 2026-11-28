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
 * (constructions), and every call of a `stream` method declared on
 * `IResponse` or the kernel's `ResponseBuilder`, whatever the receiver is
 * called (hand-offs, resolved by the type checker), in each package's `src`. Text inside a string — the
 * CLI's templates — is not code and is not counted. The tables are the
 * enumeration: the test fails when a site is added, moved or removed without
 * a row, or when the code a row's classification rests on changes. A row's
 * classification is evidence in the source, read by a person; the kernel's
 * own wrapper is also proved by behaviour in `packages/kernel/test`.
 *
 * @module
 */
import { readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** How a stream source relates to the cancel contract. */
type Kind =
  /**
   * Pushes from `start` (or enqueues once) and does no work of its own after
   * that; writes driven from outside the source (an SSE connection's writes,
   * a GraphQL event pump) are the writer's, not the source's.
   */
  | 'push'
  /** Does work of its own and `cancel()` waits for it. */
  | 'cancel-awaits-work'
  /** Forwards `cancel()` to the stream it wraps and returns its promise. */
  | 'forwards-cancel'
  /** `cancel()` does not wait for the source's own work (in `pull`, or a pump it started). */
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
   * `always`; `as-its-source` (it forwards to the stream it wraps, or
   * destroys that stream and awaits it, so it settles when a source that
   * honours `destroy()` does); `may-hang` (named case: the gRPC rows await
   * a handler generator they never end first); `unknown` (another
   * library's stream).
   */
  readonly cancelSettles: 'always' | 'as-its-source' | 'may-hang' | 'unknown';
  /** The lane that owns a site outside Core that does not, or may not, meet the contract. */
  readonly handOver?: string;
}

const CONSTRUCTIONS: readonly Row[] = [
  {
    // Cancellation waits for the replay pump's final store read to settle.
    file: 'packages/agent-runs-plugin/src/log/respond.ts',
    count: 1,
    cancelSettles: 'may-hang',
    kind: 'cancel-awaits-work',
    evidence: /pump = \(async \(\) => \{[\s\S]*async cancel\(\) \{\s*abort\(\);\s*await pump;/,
    handOver:
      'Data lane: cancel() awaits a store read that has no bound of its own; bound the store (pg query_timeout), as the database README documents',
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
      'M143c (Services lane): cancel() aborts the handler signal first, then awaits iterator.return() with no bound; a handler that ignores the signal still holds it (documented in the grpc-plugin README)',
  },
  {
    file: 'packages/grpc-plugin/src/transports/rpc-call.ts',
    count: 1,
    cancelSettles: 'may-hang',
    kind: 'cancel-awaits-work',
    evidence: /async cancel\(reason\) \{[\s\S]{0,120}await iterator\.return\?\.\(\)/,
    handOver:
      'M143c (Services lane): cancel() aborts the handler signal first, then awaits iterator.return() with no bound; a handler that ignores the signal still holds it (documented in the grpc-plugin README)',
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
    // A pull stream over the GCS read iterator after its first chunk:
    // `cancel()` destroys the source, then awaits the iterator's `return()`,
    // so it settles when its source does. The SDK's stream ends a pending
    // read on destroy; an injected source whose `return()` queues behind a
    // pending read holds the cancel, and `createReadStream()`'s JSDoc makes
    // ending that read the source's job.
    file: 'packages/storage-plugin/src/providers/gcs-provider.ts',
    count: 1,
    cancelSettles: 'as-its-source',
    kind: 'cancel-awaits-work',
    evidence:
      /async cancel\(\): Promise<void> \{\s*release\(\);\s*(?:\/\/[^\n]*\n\s*)*await iterator\.return\?\.\(\);/,
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
    evidence: /new ReadableStream\(\{\s*start\(controller\) \{\s*controller\.enqueue\(body\);/,
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
    // Three settle-path wraps (cleanups, early stream, plain stream), one
    // guard-only settle hand-off, and the RPC reply hand-off (#sendRpcResponse),
    // whose body the settle path then handles.
    file: 'packages/kernel/src/application/application.ts',
    count: 5,
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
function sources(directory: string): string[] {
  const found: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sources(path));
    else if (entry.isFile() && path.endsWith('.ts') && !path.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

/** Whether an expression is the identifier `name` (or `….name`). */
function named(node: ts.Expression, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name;
  return ts.isPropertyAccessExpression(node) && node.name.text === name;
}

/** The types whose `stream` method hands a body to the response. */
const RESPONSE_TYPES = new Set(['IResponse', 'ResponseBuilder']);

/** Whether a `….stream(…)` call resolves to a `stream` declared on a response type. */
function isResponseStream(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  if (call.expression.name.text !== 'stream') return false;
  const symbol = checker.getSymbolAtLocation(call.expression.name);
  return (symbol?.declarations ?? []).some((declaration) => {
    const owner = declaration.parent;
    return (
      (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)) &&
      owner.name !== undefined &&
      RESPONSE_TYPES.has(owner.name.text)
    );
  });
}

/** Counts the construction and hand-off sites in one file of a program. */
function sites(
  checker: ts.TypeChecker,
  file: ts.SourceFile,
): { constructions: number; handOffs: number } {
  let constructions = 0;
  let handOffs = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && named(node.expression, 'ReadableStream')) constructions++;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: target, name } = node.expression;
      if (name.text === 'toWeb' && named(target, 'Readable')) constructions++;
      if (name.text === 'from' && named(target, 'ReadableStream')) constructions++;
      if (isResponseStream(checker, node)) handOffs++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { constructions, handOffs };
}

/** A program over the given files, with the repository's type-check options. */
function programOf(files: readonly string[]): ts.Program {
  const config = ts.getParsedCommandLineOfConfigFile(
    'tsconfig.check.json',
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  );
  return ts.createProgram([...files], { ...config?.options, noEmit: true });
}

/** Each package `src` file with sites, per shape. */
function inventory(): { constructions: Record<string, number>; handOffs: Record<string, number> } {
  const files = readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => sources(`packages/${entry.name}/src`));
  const program = programOf(files);
  const checker = program.getTypeChecker();
  const constructions: Record<string, number> = {};
  const handOffs: Record<string, number> = {};
  for (const path of files) {
    const file = program.getSourceFile(path);
    if (file === undefined) continue;
    const found = sites(checker, file);
    if (found.constructions > 0) constructions[path] = found.constructions;
    if (found.handOffs > 0) handOffs[path] = found.handOffs;
  }
  return { constructions, handOffs };
}

/** A table as `{ file: count }`. */
function tally(rows: readonly Row[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.file, row.count]));
}

describe('response stream sources and the cancel contract', () => {
  // One type-checked program over every package's src (about 3 s).
  const found = inventory();

  it('classifies every web stream a package builds', () => {
    expect(found.constructions).toEqual(tally(CONSTRUCTIONS));
  });

  it('classifies every body a package hands to a response stream() method', () => {
    expect(found.handOffs).toEqual(tally(HAND_OFFS));
  });

  it('finds a hand-off through any receiver name and never text inside a string', () => {
    const path = 'packages/kernel/test/fixtures/stream-sites.virtual.ts';
    const text = [
      "import type { IResponse } from '@setu-ts/common';",
      'export function send(reply: IResponse, body: ReadableStream<Uint8Array>): void {',
      '  const r = reply;',
      '  r.stream(body);',
      '  const t = `reply.stream(new ReadableStream({}))`;',
      '  void t;',
      '  void new ReadableStream();',
      '}',
    ].join('\n');
    const host = ts.createCompilerHost({});
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, version, ...rest) =>
      name.endsWith('stream-sites.virtual.ts')
        ? ts.createSourceFile(name, text, version, true)
        : original(name, version, ...rest);
    const options = programOf([]).getCompilerOptions();
    const program = ts.createProgram([path], options, host);
    const file = program.getSourceFile(path);
    expect(file).toBeDefined();
    expect(sites(program.getTypeChecker(), file!)).toEqual({ constructions: 1, handOffs: 1 });
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
