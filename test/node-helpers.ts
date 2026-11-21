import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';

/**
 * The first and last port a test may be given. The range sits below the range an
 * operating system assigns from on its own (Linux 32768–60999, macOS and Windows
 * 49152–65535), so no outgoing connection and no listener on port `0` is ever
 * handed one of these.
 */
export const TEST_PORT_RANGE: { readonly first: number; readonly last: number } = {
  first: 20_000,
  last: 32_767,
};

/** What a port allocator reads from its host; tests replace each part. */
export interface PortAllocatorOptions {
  /** The directory holding one claim file per port, shared by every test process. */
  readonly directory: string;
  /** The first port of the range. */
  readonly first: number;
  /** The last port of the range. */
  readonly last: number;
  /** The claiming process id. */
  readonly pid?: number;
  /** Whether a process id belongs to a running process. */
  readonly alive?: (pid: number) => boolean;
  /** Why a listener cannot bind the port right now, or `undefined` when it can. */
  readonly bindError?: (port: number) => Promise<Error | undefined>;
  /** A number in `[0, 1)` choosing where a search starts. */
  readonly random?: () => number;
}

/** Hands out ports no other test process is using or about to use. */
export interface PortAllocator {
  /** One free, claimed port. */
  port(): Promise<number>;
  /** The first of `count` consecutive free, claimed ports. */
  range(count: number): Promise<number>;
  /** Drops every claim this allocator holds. */
  release(): void;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

/**
 * `process.kill(pid, 0)` delivers nothing: it only reports whether the process exists.
 * Only "no such process" means gone. A process owned by someone else (`EPERM`) is
 * running, and a runtime that refuses the question (Deno without the grant) has not
 * said the process is gone, so its claim is kept.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function bindFailure(port: number): Promise<Error | undefined> {
  return new Promise((accept) => {
    const server = createServer();
    server.once('error', (error) => accept(error));
    server.listen(port, '127.0.0.1', () => server.close(() => accept(undefined)));
  });
}

/**
 * Builds a port allocator over a claims directory.
 *
 * Asking the operating system for a free port (`listen(0)`), closing it and binding
 * the number later is a race: the system draws from the same range for every
 * outgoing connection and every other test, so the port can be taken before the
 * test's server starts (the "address already in use" failures in CI). Here a port
 * comes from a range the system never assigns from, and is claimed with an
 * exclusively created file, so two test processes cannot be given the same one.
 *
 * A claim lasts until {@linkcode PortAllocator.release}, or until its process no
 * longer exists (a worker that was killed never releases); only then can another
 * caller take it over. A claim is never taken from a running process, whatever its
 * age, so a holder's release can only ever remove its own claim. The cost is that a
 * process id reused by an unrelated program keeps one dead claim's port out of use
 * until that program ends.
 *
 * A takeover holds a per-port marker file while it checks the claim again and
 * replaces it. Only a marker holder removes another process's claim, and only after
 * finding its process gone while holding the marker: a process that is gone cannot
 * release or re-create its claim, and nobody else can create a file that exists, so
 * the claim removed is the one that was checked. A marker left by a crashed process
 * only keeps that one port from being taken over.
 *
 * Liveness is asked of this machine's process table, so one claims directory must not
 * be shared between process-id namespaces (two containers with a common `/tmp`).
 *
 * @param options - The claims directory, the range, and replaceable host parts
 * @returns The allocator
 */
export function createPortAllocator(options: PortAllocatorOptions): PortAllocator {
  const { directory, first, last } = options;
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? processAlive;
  const bindError = options.bindError ?? bindFailure;
  const random = options.random ?? Math.random;
  const span = last - first + 1;
  const held = new Set<number>();
  const file = (port: number): string => join(directory, String(port));
  let refusal: Error | undefined;

  function create(port: number): boolean {
    try {
      writeFileSync(file(port), String(pid), { flag: 'wx' });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      return false;
    }
    held.add(port);
    return true;
  }

  /** Whether the port's claim belongs to a process that no longer exists. */
  function stale(port: number): boolean {
    let owner: number;
    try {
      owner = Number(readFileSync(file(port), 'utf8'));
    } catch (error) {
      // Released between the failed create and this read: its owner is alive.
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
    // An empty or unreadable id is a claim still being written: its owner is alive.
    return Number.isInteger(owner) && owner > 0 && !alive(owner);
  }

  /**
   * Replaces a stale claim with this process's. The marker admits one process at a
   * time, and the claim is checked again while it is held: an earlier holder may
   * have replaced the stale claim with a live one.
   */
  function takeOver(port: number): boolean {
    const marker = `${file(port)}.taking`;
    try {
      writeFileSync(marker, String(pid), { flag: 'wx' });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      return false;
    }
    try {
      if (!stale(port)) return false;
      rmSync(file(port), { force: true });
      return create(port);
    } finally {
      rmSync(marker, { force: true });
    }
  }

  function claim(port: number): boolean {
    if (create(port)) return true;
    return stale(port) && takeOver(port);
  }

  function drop(port: number): void {
    held.delete(port);
    rmSync(file(port), { force: true });
  }

  /** Claims and bind-checks `count` ports from `base`, or leaves nothing behind. */
  async function take(base: number, count: number): Promise<boolean> {
    const taken: number[] = [];
    for (let port = base; port < base + count; port++) {
      const claimed = claim(port);
      if (claimed) taken.push(port);
      const refused = claimed ? await bindError(port) : undefined;
      if (refused !== undefined) refusal = refused;
      if (!claimed || refused !== undefined) {
        for (const each of taken) drop(each);
        return false;
      }
    }
    return true;
  }

  async function range(count: number): Promise<number> {
    mkdirSync(directory, { recursive: true });
    refusal = undefined;
    const bases = span - count + 1;
    const start = Math.floor(random() * Math.max(bases, 1));
    for (let offset = 0; offset < bases; offset++) {
      const base = first + ((start + offset) % bases);
      if (await take(base, count)) return base;
    }
    // A host that refuses every bind is not a full range: say why the last one failed.
    throw new Error('no free test port', refusal === undefined ? {} : { cause: refusal });
  }

  return {
    port: () => range(1),
    range,
    release() {
      for (const port of [...held]) drop(port);
    },
  };
}

let shared: PortAllocator | undefined;

/** The allocator every test process shares. */
function sharedAllocator(): PortAllocator {
  if (shared === undefined) {
    const allocator = createPortAllocator({
      directory: join(tmpdir(), 'setu-ts-test-ports'),
      ...TEST_PORT_RANGE,
    });
    // Reached by a process that ends on its own. Vitest ends its workers with a
    // signal, which runs no exit handler: there `test/setup/release-ports.ts` releases
    // after each test file.
    process.once('exit', () => allocator.release());
    shared = allocator;
  }
  return shared;
}

/**
 * A port for a server the test starts later, in this process or a child.
 *
 * It is claimed for this process until {@linkcode releaseTestPorts} runs or the
 * process is gone, so no other test is given it, and it lies outside the range the
 * operating system assigns from, so nothing else is either. A port that is requested
 * and never bound refuses connections.
 *
 * @returns A free TCP port
 * @throws {Error} `no free test port`, with the last bind error as its cause, when
 *   the whole range is claimed or cannot be bound
 */
export function unusedPort(): Promise<number> {
  return sharedAllocator().port();
}

/**
 * A run of `count` consecutive free ports, for a workspace whose members bind
 * `base`, `base + 1`, ….
 *
 * @param count - How many consecutive ports the caller binds
 * @returns The first port of the run
 * @throws {Error} `no free test port`, as {@linkcode unusedPort} does
 */
export function unusedPortRange(count: number): Promise<number> {
  return sharedAllocator().range(count);
}

/** Drops every port claim this process holds; the Vitest setup file calls it after each test file. */
export function releaseTestPorts(): void {
  shared?.release();
}

/** Temporary test directories stay below the workspace's ignored scratch directory. */
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
      // A test helper must not replace the global Request/Response: on the Deno
      // lane, Deno.serve refuses a Response built from node-server's class.
      overrideGlobalObjects: false,
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
