/**
 * Every web stream a published package builds, classified against the
 * kernel's abort rule for a streamed response: when the client leaves, the
 * kernel cancels the body and runs the request's `ctx.defer` cleanups once
 * the body's `cancel()` settles (or after 5000 ms). The kernel cannot see a
 * source's `pull`, so a source that does work in `pull` must make `cancel()`
 * wait for it, or that work can outlive the request's resources.
 *
 * The table is the enumeration; the test fails when a source is added,
 * moved or removed without a classification, or when the code a row's
 * classification rests on changes.
 *
 * @module
 */
import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/** How a stream source relates to the cancel contract. */
type Kind =
  /** Pushes from `start` (or enqueues once); `pull` does no work. */
  | 'push'
  /** `pull` does work and `cancel()` waits for it. */
  | 'cancel-awaits-pull'
  /** Forwards `cancel()` to the stream it wraps and returns its promise. */
  | 'forwards-cancel'
  /** `cancel()` does not wait for work in `pull`; the work uses only the stream's own source. */
  | 'cancel-does-not-await'
  /** The kernel's own wrapper: the reader that applies the rule. */
  | 'kernel-wrapper';

/** One classified source. */
interface Row {
  readonly file: string;
  /** How many `new ReadableStream` constructions the file holds. */
  readonly count: number;
  readonly kind: Kind;
  /** Text the classification rests on; it must still be in the file. */
  readonly evidence: RegExp;
  /** The lane that owns a source outside Core that does not meet the contract. */
  readonly handOver?: string;
}

const ROWS: readonly Row[] = [
  {
    file: 'packages/agent-runs-plugin/src/log/respond.ts',
    count: 1,
    kind: 'push',
    evidence: /new ReadableStream<Uint8Array>\(\{\s*start\(controller\)/,
  },
  {
    file: 'packages/graphql-plugin/src/transports/sse/graphql-sse-handler.ts',
    count: 1,
    kind: 'push',
    evidence: /new ReadableStream<Uint8Array>\(\{\s*start: \(controller\)/,
  },
  {
    // An async generator queues `return()` behind a pending `next()`.
    file: 'packages/grpc-plugin/src/transports/native-grpc-reply.ts',
    count: 1,
    kind: 'cancel-awaits-pull',
    evidence: /async cancel\(reason\) \{[\s\S]{0,120}await iterator\?\.return\?\.\(\)/,
  },
  {
    file: 'packages/grpc-plugin/src/transports/rpc-call.ts',
    count: 1,
    kind: 'cancel-awaits-pull',
    evidence: /async cancel\(\) \{\s*await iterator\.return\?\.\(\)/,
  },
  {
    file: 'packages/kernel/src/context/deferred.ts',
    count: 1,
    kind: 'kernel-wrapper',
    evidence: /const cancelled = reader\.cancel\(signal\?\.reason\)/,
  },
  {
    file: 'packages/kernel/src/context/stream-guard.ts',
    count: 1,
    kind: 'forwards-cancel',
    evidence: /cancel\(reason: unknown\): Promise<void> \{\s*return reader\.cancel\(reason\);/,
  },
  {
    file: 'packages/runtime/src/adapters/bun/bun-http-adapter.ts',
    count: 1,
    kind: 'forwards-cancel',
    evidence: /cancel\(reason\) \{\s*return reader\.cancel\(reason\);/,
  },
  {
    file: 'packages/runtime/src/adapters/deno/deno-http-adapter.ts',
    count: 1,
    kind: 'forwards-cancel',
    evidence: /cancel\(reason\) \{\s*return reader\.cancel\(reason\);/,
  },
  {
    // A file read stream: its pull touches only the file handle it closes.
    file: 'packages/runtime/src/adapters/deno/deno-runtime.ts',
    count: 1,
    kind: 'cancel-does-not-await',
    evidence: /cancel: async \(\) => \{\s*cancelled = true;\s*await closeFile\(\);/,
  },
  {
    file: 'packages/runtime/src/adapters/node/node-http-adapter.ts',
    count: 2,
    kind: 'forwards-cancel',
    evidence: /cancel\(reason\) \{\s*return reader\.cancel\(reason\);/,
  },
  {
    file: 'packages/sse-plugin/src/connection/sse-connection.ts',
    count: 1,
    kind: 'push',
    evidence: /new ReadableStream<Uint8Array>\(\s*\{\s*start\(controller\)/,
  },
  {
    // Node Readable adapter (pull waits for 'readable'), the eager iterable
    // pump (in start), and the event-push adapter.
    file: 'packages/storage-plugin/src/providers/provider-stream.ts',
    count: 3,
    kind: 'cancel-does-not-await',
    evidence: /cancel\(\): void \{\s*closed = true;/,
    handOver: 'M143r (Integrations lane)',
  },
  {
    file: 'packages/storage-plugin/src/providers/s3-provider.ts',
    count: 1,
    kind: 'push',
    evidence: /new ReadableStream\(\{\s*start\(controller\) \{\s*controller\.enqueue\(res\.Body\);/,
  },
  {
    file: 'packages/storage-plugin/src/services/storage-service.ts',
    count: 1,
    kind: 'push',
    evidence: /new ReadableStream\(\{\s*start\(controller\) \{\s*controller\.enqueue\(data\);/,
  },
];

/** Sources a package passes through rather than builds; its `cancel()` is the library's. */
const PASS_THROUGH: readonly Row[] = [
  {
    // React Router's server render stream (react-dom's renderToReadableStream).
    file: 'packages/react-router-plugin/src/handler/request-bridge.ts',
    count: 0,
    kind: 'forwards-cancel',
    evidence: /if \(response\.body instanceof ReadableStream\) \{/,
    handOver: "M143l (Web lane): confirm React's render stream cancel() waits for render work",
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

/** Each package's `src` file that constructs a web stream, with its count. */
async function constructions(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const pkg of await readdir('packages', { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = `packages/${pkg.name}/src`;
    let files: string[];
    try {
      files = await sources(src);
    } catch {
      continue;
    }
    for (const file of files) {
      const n = ((await readFile(file, 'utf8')).match(/new ReadableStream\b/g) ?? []).length;
      if (n > 0) counts.set(file, n);
    }
  }
  return counts;
}

describe('response stream sources and the cancel contract', () => {
  it('classifies every web stream a package builds', async () => {
    const found = await constructions();
    expect(Object.fromEntries(found)).toEqual(
      Object.fromEntries(ROWS.map((row) => [row.file, row.count])),
    );
  });

  it.each([...ROWS, ...PASS_THROUGH])('$file is $kind', async (row) => {
    expect(await readFile(row.file, 'utf8')).toMatch(row.evidence);
  });

  it('names a hand-over for every source outside Core that does not wait in cancel()', () => {
    const core = /^packages\/(kernel|runtime|common|logger-plugin|health-plugin)\//;
    for (const row of [...ROWS, ...PASS_THROUGH]) {
      if (core.test(row.file)) continue;
      if (row.kind === 'cancel-does-not-await' || row.count === 0) {
        expect(row.handOver, row.file).toBeDefined();
      }
    }
  });
});
