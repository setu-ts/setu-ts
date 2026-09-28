// deno-lint-ignore-file no-console -- captures console.error/warn to prove ioredis wrote nothing there.
/**
 * Shared real-Redis harness for the connection-error routing suites.
 *
 * Six packages build `ioredis` clients, and each proves the same thing against
 * a real server: stopping it produces connection errors that reach the logger
 * — de-duplicated, recovery included — and NOTHING reaches the console, which
 * is where `ioredis` writes an `'error'` event that has no listener. One
 * harness, so the six suites cannot drift about what "routed" means.
 *
 * Stops and restarts the container publishing the `REDIS_URL` port; callers
 * guard with `ignore: REDIS_URL === undefined`, and the suite partition runs
 * every `REDIS_URL` suite alone.
 *
 * @module
 */
import { expect } from '@std/expect';
import type { ILogger, IPlugin, LogMetadata } from '../../src/index.ts';
import { CAPABILITIES } from '../../src/index.ts';

/** The Redis the guarded suites drive, or `undefined` to skip them. */
export const REDIS_URL: string | undefined = Deno.env.get('REDIS_URL');

/**
 * `REDIS_URL` with `localhost` pinned to IPv4: on some hosts `localhost`
 * resolves to `::1` only, where the container does not listen.
 *
 * @returns The IPv4 form of `REDIS_URL`
 */
export function redisUrl(): string {
  if (REDIS_URL === undefined) {
    throw new Error('REDIS_URL is not set; guard the suite with ignore');
  }
  return REDIS_URL.replace(/localhost/g, '127.0.0.1');
}

/** One recorded log call. */
export interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly metadata: LogMetadata | undefined;
}

/** A full `ILogger` that records every call, for `CAPABILITIES.LOGGER`. */
export class RecordingLogger implements ILogger {
  readonly level = 'trace' as const;
  readonly entries: LogEntry[] = [];

  #push(level: string, message: string, metadata: LogMetadata | undefined): void {
    this.entries.push({ level, message, metadata });
  }
  fatal(message: string, metadata?: LogMetadata): void {
    this.#push('fatal', message, metadata);
  }
  error(message: string, metadata?: LogMetadata): void {
    this.#push('error', message, metadata);
  }
  warn(message: string, metadata?: LogMetadata): void {
    this.#push('warn', message, metadata);
  }
  info(message: string, metadata?: LogMetadata): void {
    this.#push('info', message, metadata);
  }
  debug(message: string, metadata?: LogMetadata): void {
    this.#push('debug', message, metadata);
  }
  trace(message: string, metadata?: LogMetadata): void {
    this.#push('trace', message, metadata);
  }
  child(): ILogger {
    return this;
  }

  /**
   * The entries a connection-error reporter wrote for `source`.
   *
   * @param source - The reporter's source label
   * @returns Matching entries, oldest first
   */
  forSource(source: string): LogEntry[] {
    return this.entries.filter((entry) => entry.metadata?.['source'] === source);
  }
}

/**
 * Publishes a logger under `CAPABILITIES.LOGGER`, as `LoggerPlugin` would.
 *
 * @param logger - The logger to publish
 * @returns The plugin
 */
export function loggerPlugin(logger: ILogger): IPlugin {
  return {
    name: 'test-logger',
    version: '0.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(ctx): void {
      ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
}

async function docker(args: string[]): Promise<string> {
  const out = await new Deno.Command('docker', { args }).output();
  if (!out.success) {
    throw new Error(`docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

async function containerIdForPort(port: number): Promise<string> {
  const ids = (await docker(['ps', '-q', '--filter', `publish=${port}`])).trim();
  if (ids === '') {
    throw new Error(`no container publishing port ${port}`);
  }
  return ids.split('\n')[0];
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await wait(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** What {@linkcode expectOutageRoutedToLogger} drives. */
export interface OutageScenario {
  /** The logger the reporter under test writes to. */
  readonly logger: RecordingLogger;
  /** The reporter's source label, as the package builds it. */
  readonly source: string;
  /** Builds and connects the client, through the package's real entry point. */
  start(): Promise<void>;
  /** Releases everything `start` created. */
  stop(): Promise<void>;
}

/**
 * Stops the real Redis under a connected, package-built client and asserts the
 * resulting connection errors reached the logger and not the console.
 *
 * Asserts, in order: a `warn` opens the outage; identical repeats arrive at
 * `debug` with a running count (so one outage is not N warnings); every
 * `debug` repeats the entry before it; restarting Redis yields one `info`
 * recovery line; and `console.error` / `console.warn` received nothing for the
 * whole window — `ioredis` writes an unlistened `'error'` there.
 *
 * @param scenario - The client to drive and the logger to read
 */
export async function expectOutageRoutedToLogger(scenario: OutageScenario): Promise<void> {
  const url = new URL(redisUrl());
  const containerId = await containerIdForPort(url.port === '' ? 6379 : Number(url.port));

  const printed: unknown[][] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => printed.push(['error', ...args]);
  console.warn = (...args: unknown[]) => printed.push(['warn', ...args]);

  let stopped = false;
  try {
    await scenario.start();

    await docker(['stop', containerId]);
    stopped = true;
    // A warn plus at least one repeat is enough to prove de-duplication. Also
    // stop waiting on the first console line, so a missing listener fails on
    // the console assertion below rather than on a timeout.
    await waitFor(
      () => printed.length > 0 || scenario.logger.forSource(scenario.source).length >= 3,
      `connection errors from ${scenario.source}`,
      30_000,
    );

    await docker(['start', containerId]);
    stopped = false;
    if (printed.length === 0) {
      await waitFor(
        () => scenario.logger.forSource(scenario.source).some((e) => e.level === 'info'),
        `recovery from ${scenario.source}`,
        30_000,
      );
    }
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    if (stopped) {
      await new Deno.Command('docker', { args: ['start', containerId] }).output();
    }
    await scenario.stop();
  }

  expect(printed).toEqual([]);

  const entries = scenario.logger.forSource(scenario.source);
  expect(entries[0].level).toBe('warn');
  expect(entries[0].message.startsWith(`${scenario.source}: connection error: `)).toBe(true);
  const debugs = entries.filter((entry) => entry.level === 'debug');
  // De-duplicated: at least one repeat arrived at debug instead of warn.
  expect(debugs.length).toBeGreaterThanOrEqual(1);
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].level === 'debug') {
      expect(entries[i].metadata?.['error']).toBe(entries[i - 1].metadata?.['error']);
      expect(entries[i].metadata?.['repeats']).toBeGreaterThanOrEqual(1);
    }
  }
  const recovery = entries.filter((entry) => entry.level === 'info');
  expect(recovery.length).toBeGreaterThanOrEqual(1);
  expect(recovery[0].message).toMatch(/connection recovered after \d+ error\(s\)$/);
}
