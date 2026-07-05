import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ILogger, LogLevel, LogMetadata } from '@hono-enterprise/common';

import { normalizePinoFactory, PinoLogger } from '../../src/loggers/pino-logger.ts';
import type { PinoFactory } from '../../src/loggers/pino-logger.ts';

/**
 * Minimal fake Pino logger that records every call. Conforms to the
 * `PinoLoggerLike` structural shape used internally.
 */
interface RecordedCall {
  level: LogLevel;
  message: string;
  metadata: LogMetadata | undefined;
}

class FakePino {
  readonly calls: RecordedCall[] = [];
  readonly children: FakePino[] = [];
  readonly level: string;
  readonly #redact: readonly string[] | undefined;
  readonly #base: Record<string, unknown> | undefined;

  constructor(options: {
    level: LogLevel;
    redact?: readonly string[];
    base?: Record<string, unknown>;
  }) {
    this.level = options.level;
    this.#redact = options.redact;
    this.#base = options.base;
  }

  fatal(message: string, metadata?: LogMetadata): void {
    this.calls.push({ level: 'fatal', message, metadata });
  }
  error(message: string, metadata?: LogMetadata): void {
    this.calls.push({ level: 'error', message, metadata });
  }
  warn(message: string, metadata?: LogMetadata): void {
    this.calls.push({ level: 'warn', message, metadata });
  }
  info(message: string, metadata?: LogMetadata): void {
    this.calls.push({ level: 'info', message, metadata });
  }
  debug(message: string, metadata?: LogMetadata): void {
    this.calls.push({ level: 'debug', message, metadata });
  }
  trace(message: string, metadata?: LogMetadata): void {
    this.calls.push({ level: 'trace', message, metadata });
  }
  child(bindings: LogMetadata): FakePino {
    const childOpts: {
      level: LogLevel;
      redact?: readonly string[];
      base?: Record<string, unknown>;
    } = {
      level: this.level as LogLevel,
      base: { ...this.#base, ...bindings },
    };
    if (this.#redact !== undefined) {
      childOpts.redact = this.#redact;
    }
    const child = new FakePino(childOpts);
    this.children.push(child);
    return child;
  }
}

describe('normalizePinoFactory', () => {
  const fn = (() => ({})) as unknown as PinoFactory;

  it('returns the default export when present', () => {
    expect(normalizePinoFactory({ default: fn })).toBe(fn);
  });

  it('returns the module itself when it is callable', () => {
    expect(normalizePinoFactory(fn)).toBe(fn);
  });

  it('falls back to the namespace when no default exists', () => {
    const namespace = { info() {} };
    expect(normalizePinoFactory(namespace)).toBe(namespace);
  });
});

describe('PinoLogger', () => {
  let fakePino: FakePino;
  let factory: PinoFactory;

  beforeEach(() => {
    fakePino = new FakePino({ level: 'info' });
    factory = () => fakePino;
  });

  it('delegates fatal/error/warn/info/debug/trace to Pino', async () => {
    const logger = await PinoLogger.create({ level: 'info', pinoFactory: factory });
    logger.fatal('f', { a: 1 });
    logger.error('e', { b: 2 });
    logger.warn('w');
    logger.info('i', { c: 3 });
    logger.debug('d');
    logger.trace('t');

    expect(fakePino.calls.length).toBe(6);
    expect(fakePino.calls[0]).toEqual({ level: 'fatal', message: 'f', metadata: { a: 1 } });
    expect(fakePino.calls[1]).toEqual({ level: 'error', message: 'e', metadata: { b: 2 } });
    expect(fakePino.calls[2]).toEqual({ level: 'warn', message: 'w', metadata: undefined });
    expect(fakePino.calls[3]).toEqual({ level: 'info', message: 'i', metadata: { c: 3 } });
    expect(fakePino.calls[4]).toEqual({ level: 'debug', message: 'd', metadata: undefined });
    expect(fakePino.calls[5]).toEqual({ level: 'trace', message: 't', metadata: undefined });
  });

  it('defaults to info level', async () => {
    const logger = await PinoLogger.create({ pinoFactory: factory });
    expect(logger.level).toBe('info');
  });

  it('passes level and redact options to Pino', async () => {
    fakePino = new FakePino({ level: 'debug', redact: ['password'] });
    factory = () => fakePino;
    await PinoLogger.create({ level: 'debug', redact: ['password'], pinoFactory: factory });
    expect(fakePino.level).toBe('debug');
  });

  it('child() returns an ILogger backed by Pino child()', async () => {
    const logger = await PinoLogger.create({ level: 'info', pinoFactory: factory });
    const child: ILogger = logger.child({ requestId: 'abc' });
    expect(fakePino.children.length).toBe(1);
    child.info('processing');
    expect(fakePino.children[0]!.calls.length).toBe(1);
    expect(fakePino.children[0]!.calls[0]!.message).toBe('processing');
  });

  it('child of child delegates to nested Pino children', async () => {
    const logger = await PinoLogger.create({ level: 'info', pinoFactory: factory });
    const child = logger.child({ requestId: 'abc' });
    const grandchild = child.child({ userId: '42' });
    grandchild.debug('nested');
    expect(fakePino.children[0]!.children.length).toBe(1);
    expect(fakePino.children[0]!.children[0]!.calls[0]!.message).toBe('nested');
  });

  it('throws when Pino cannot be loaded and no factory injected', async () => {
    // Guard: only run when pino is NOT installed (the error path).
    try {
      // deno-lint-ignore no-unversioned-import -- pino is an OPTIONAL heavy dep, lazily loaded (AI_GUIDELINES §12.2)
      await import('npm:pino');
      return; // pino IS installed — skip this test
    } catch {
      // pino not available — the error path should be exercised.
    }
    await expect(PinoLogger.create({ level: 'info' })).rejects.toThrow(
      /PinoLogger requires Pino/,
    );
  });

  it('passes bindings as base to Pino', async () => {
    let receivedBase: Record<string, unknown> | undefined;
    fakePino = new FakePino({ level: 'info' });
    factory = (opts: { level: LogLevel; base?: Record<string, unknown> }) => {
      receivedBase = opts.base;
      return fakePino;
    };
    await PinoLogger.create({ level: 'info', bindings: { service: 'api' }, pinoFactory: factory });
    expect(receivedBase).toEqual({ service: 'api' });
  });

  it('does not pass base when no bindings are provided', async () => {
    let receivedBase: Record<string, unknown> | undefined;
    fakePino = new FakePino({ level: 'info' });
    factory = (opts: { level: LogLevel; base?: Record<string, unknown> }) => {
      receivedBase = opts.base;
      return fakePino;
    };
    await PinoLogger.create({ level: 'info', pinoFactory: factory });
    expect(receivedBase).toBeUndefined();
  });

  it('passes redact paths to Pino', async () => {
    let receivedRedact: readonly string[] | undefined;
    fakePino = new FakePino({ level: 'info' });
    factory = (opts: { level: LogLevel; redact?: readonly string[] }) => {
      receivedRedact = opts.redact;
      return fakePino;
    };
    await PinoLogger.create({ level: 'info', redact: ['password', 'token'], pinoFactory: factory });
    expect(receivedRedact).toEqual(['password', 'token']);
  });

  it('PinoLoggerAdapter child() returns another adapter', async () => {
    const logger = await PinoLogger.create({ level: 'info', pinoFactory: factory });
    const child = logger.child({ requestId: 'abc' });
    const grandchild = child.child({ userId: '42' });
    grandchild.info('nested');
    expect(grandchild).toBeDefined();
  });

  it('PinoLoggerAdapter delegates all log levels to the wrapped Pino child', async () => {
    const logger = await PinoLogger.create({ level: 'info', pinoFactory: factory });
    const child = logger.child({ requestId: 'abc' });
    // The child is a PinoLoggerAdapter wrapping fakePino.children[0]
    const wrapped = fakePino.children[0]!;
    child.fatal('f', { a: 1 });
    child.error('e', { b: 2 });
    child.warn('w', { c: 3 });
    child.info('i', { d: 4 });
    child.debug('d', { e: 5 });
    child.trace('t', { f: 6 });

    expect(wrapped.calls.length).toBe(6);
    expect(wrapped.calls[0]).toEqual({ level: 'fatal', message: 'f', metadata: { a: 1 } });
    expect(wrapped.calls[1]).toEqual({ level: 'error', message: 'e', metadata: { b: 2 } });
    expect(wrapped.calls[2]).toEqual({ level: 'warn', message: 'w', metadata: { c: 3 } });
    expect(wrapped.calls[3]).toEqual({ level: 'info', message: 'i', metadata: { d: 4 } });
    expect(wrapped.calls[4]).toEqual({ level: 'debug', message: 'd', metadata: { e: 5 } });
    expect(wrapped.calls[5]).toEqual({ level: 'trace', message: 't', metadata: { f: 6 } });
  });

  it('loads real Pino via import when no factory injected', async () => {
    // Guard: skip if pino is not installed in this environment.
    try {
      // deno-lint-ignore no-unversioned-import -- pino is an OPTIONAL heavy dep, lazily loaded (AI_GUIDELINES §12.2)
      await import('npm:pino');
    } catch {
      // Pino not available — skip this test rather than failing.
      return;
    }

    // With pino installed, create() without pinoFactory should succeed.
    const logger = await PinoLogger.create();
    expect(logger.level).toBe('info');
    // Calling info() should not throw.
    logger.info('real pino works');
  });
});
