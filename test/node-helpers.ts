import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';

/** Reserve and release an ephemeral IPv4 port before a socket test binds it. */
export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return address.port;
}

/** All temporary test artifacts stay below the workspace's ignored scratch directory. */
export async function tempDir(options: { prefix?: string; dir?: string } = {}): Promise<string> {
  const base = options.dir ?? fileURLToPath(new URL('../.tmp/node-tests/', import.meta.url));
  await mkdir(base, { recursive: true });
  return mkdtemp(resolve(base, options.prefix ?? 'test-'));
}

/**
 * Node flags for a test subprocess that runs workspace TypeScript: strips types and resolves
 * `@setu-ts/*` to source as Vitest does, so the child never depends on a built `dist/`.
 */
export const NODE_SOURCE_ARGS: readonly string[] = [
  '--experimental-transform-types',
  '--import',
  new URL('../scripts/lib/source-register.ts', import.meta.url).href,
];

/** The running Deno executable, or `undefined` under any other runtime. */
function runningDeno(): string | undefined {
  return 'Deno' in globalThis ? process.execPath : undefined;
}

/**
 * Find Deno for tests of generated Deno projects; absence is a failure, never a skip.
 *
 * Under Deno (the browser gate's harness) the running executable is the answer: that harness grants
 * read access to the workspace only, so a PATH scan cannot see the binary and would report it
 * missing.
 */
export function denoBinary(path = process.env.PATH ?? '', self = runningDeno()): string {
  if (self !== undefined) return self;
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, process.platform === 'win32' ? 'deno.exe' : 'deno');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next PATH entry */
    }
  }
  throw new Error('deno is required on PATH for generated-project tests');
}

export interface RunOptions {
  args?: readonly string[];
  cwd?: string | URL;
  env?: Record<string, string>;
  clearEnv?: boolean;
  stdout?: 'piped' | 'inherit' | 'null';
  stderr?: 'piped' | 'inherit' | 'null';
  stdin?: 'piped' | 'inherit' | 'null';
  signal?: AbortSignal;
}
export interface RunResult {
  code: number;
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** Spawn without a shell, preserving exit status and the stream boundaries used by e2e tests. */
export function spawnProcess(command: string, options: RunOptions = {}) {
  const stdio = (value: string | undefined) =>
    value === 'piped' || value === undefined ? 'pipe' : value === 'null' ? 'ignore' : 'inherit';
  const child = spawn(command, [...(options.args ?? [])], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    env: { ...(options.clearEnv ? {} : process.env), ...options.env },
    stdio: [stdio(options.stdin), stdio(options.stdout), stdio(options.stderr)],
  });
  const status = new Promise<{ code: number; success: boolean; signal: NodeJS.Signals | null }>(
    (accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) =>
        accept({ code: code ?? 1, success: code === 0, signal }),
      );
    },
  );
  return {
    pid: child.pid,
    status,
    stdout: child.stdout ? (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>) : null,
    stderr: child.stderr ? (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>) : null,
    stdin: child.stdin ? (Writable.toWeb(child.stdin) as WritableStream<Uint8Array>) : null,
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      child.kill(signal);
    },
    async output(): Promise<RunResult> {
      const drain = async (stream: ReadableStream<Uint8Array> | null) =>
        stream ? new Uint8Array(await new Response(stream).arrayBuffer()) : new Uint8Array();
      const [stdout, stderr, result] = await Promise.all([
        drain(this.stdout),
        drain(this.stderr),
        status,
      ]);
      return { ...result, stdout, stderr };
    },
  };
}

/** Run a real subprocess and return bytes, including a nonzero exit code. */
export function run(command: string, options: RunOptions = {}): Promise<RunResult> {
  return spawnProcess(command, options).output();
}

/** A Workers/Deno upgrade response double; Node's web Response only accepts status 200–599. */
export function upgradeResponse(body: BodyInit | null = null, init: ResponseInit = {}): Response {
  const response = new Response(body, { ...init, status: 200 });
  Object.defineProperty(response, 'status', { value: init.status ?? 101 });
  return response;
}

const NativeResponse = globalThis.Response;
/** Workers-only constructor behavior, supplied explicitly by off-Workers adapter tests. */
export class WorkersResponse extends NativeResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    if (init?.status === 101) Object.defineProperty(this, 'status', { value: 101 });
    if (init && 'webSocket' in init) {
      Object.defineProperty(this, 'webSocket', { value: init.webSocket });
    }
  }
}

/** Evaluate generated TypeScript in a real temporary module; Node does not support TS data URLs. */
export async function importSource(source: string): Promise<Record<string, unknown>> {
  const { writeFile, rm } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const directory = await tempDir();
  try {
    const path = `${directory}/module.ts`;
    await writeFile(path, source);
    return await import(/* @vite-ignore */ pathToFileURL(path).href);
  } finally {
    await rm(directory, { recursive: true });
  }
}

/** Raw TCP for protocol tests; fetch rewrites forbidden Upgrade/Connection headers. */
export async function connect(options: { hostname?: string; port: number }) {
  const { createConnection } = await import('node:net');
  const socket = createConnection({ host: options.hostname ?? '127.0.0.1', port: options.port });
  await new Promise<void>((accept, reject) => {
    socket.once('error', reject);
    socket.once('connect', accept);
  });
  const chunks = socket[Symbol.asyncIterator]();
  let pending = new Uint8Array();
  return {
    async read(buffer: Uint8Array): Promise<number | null> {
      if (pending.length === 0) {
        const next = await chunks.next();
        if (next.done) return null;
        pending = new Uint8Array(next.value);
      }
      const count = Math.min(buffer.length, pending.length);
      buffer.set(pending.subarray(0, count));
      pending = pending.subarray(count);
      return count;
    },
    async write(buffer: Uint8Array): Promise<number> {
      await new Promise<void>((accept, reject) =>
        socket.write(buffer, (error) => (error ? reject(error) : accept())),
      );
      return buffer.length;
    },
    close() {
      socket.destroy();
    },
  };
}

/**
 * Real HTTP listener using Node's adapter of the web Fetch API.
 *
 * @throws {Error} If the listener cannot bind its requested address.
 */
export async function serveHttp(
  options: { port?: number; hostname?: string; onListen?: (address: { port: number }) => void },
  handler: (request: Request) => Response | Promise<Response>,
) {
  const { serve } = await import('@hono/node-server');
  const { promise, resolve: ready, reject: failed } = Promise.withResolvers<{ port: number }>();
  const server = serve(
    {
      fetch: handler,
      port: options.port ?? 0,
      hostname: options.hostname ?? '127.0.0.1',
    },
    (address) => ready({ port: address.port }),
  );
  server.once('error', failed);
  let addr: { port: number };
  try {
    addr = await promise;
  } finally {
    server.removeListener('error', failed);
  }
  options.onListen?.(addr);
  return {
    addr,
    async shutdown() {
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
    },
  };
}
