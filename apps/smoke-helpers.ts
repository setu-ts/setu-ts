/* eslint-disable no-console -- a skipped prerequisite must be visible in CI. */
/** Node host utilities shared by the example smoke checks. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

/** Exit code `check:apps` reads as "skipped, external prerequisite unavailable". */
const SKIP_EXIT_CODE = 77;

/** A child process started by {@link startHost}. */
export interface Host {
  /** Sends a signal to the child. Throws if the child has already exited. */
  kill(signal?: NodeJS.Signals): boolean;
  /** Resolves with the child's exit code once it has exited. */
  readonly status: Promise<number>;
}

/** Reports a missing prerequisite and exits with the code `check:apps` treats as a skip. */
export function skip(reason: string): never {
  console.warn(`SKIP: ${reason}`);
  process.exit(SKIP_EXIT_CODE);
}

/** Binds an ephemeral loopback port, then releases it for the example server. */
export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** Starts a child process whose exit is observable even if it fails before the caller awaits. */
export function startHost(command: string, args: readonly string[], env = process.env): Host {
  const child = spawn(command, [...args], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  const status = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  void status.catch(() => {});
  return { kill: (signal: NodeJS.Signals = 'SIGTERM') => child.kill(signal), status };
}

/**
 * Stops a host and waits for it to exit.
 *
 * Safe to call from a `finally` block: a host that already exited is not an
 * error here, so it cannot replace the failure that is being reported.
 */
export async function stopHost(host: Host): Promise<void> {
  try {
    host.kill('SIGTERM');
  } catch {
    // Already exited.
  }
  await host.status.catch(() => {});
}

/** Options for {@link waitForHttp}. */
export interface WaitForHttpOptions {
  /** Names the server in the timeout error. */
  readonly label: string;
  /** How long to keep polling. Defaults to ten seconds. */
  readonly timeoutMs?: number;
  /** Decides whether a response means "ready". Defaults to any response at all. */
  readonly isReady?: (response: Response) => boolean | Promise<boolean>;
}

/** Polls a URL until the server behind it answers. */
export async function waitForHttp(url: string, options: WaitForHttpOptions): Promise<void> {
  const deadline = performance.now() + (options.timeoutMs ?? 10_000);
  while (performance.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(250) });
      const ready = (await options.isReady?.(response)) ?? true;
      if (!response.bodyUsed) await response.body?.cancel();
      if (ready) return;
    } catch {
      // Not listening yet.
    }
    await delay(100);
  }
  throw new Error(`${options.label} did not start in time.`);
}

/** Resolves after the given number of milliseconds. */
export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Node/tsx arguments that preserve the caller's source redirect for a child example. */
export const SOURCE_HOST_ARGS = [
  '--import',
  'tsx',
  '--import',
  new URL('../scripts/lib/source-register.ts', import.meta.url).href,
] as const;
