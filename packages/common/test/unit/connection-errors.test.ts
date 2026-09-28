/**
 * `createConnectionErrorReporter` / `attachConnectionErrorReporter`: the one
 * implementation every Redis-owning package routes its client's `'error'`
 * events through, instead of `ioredis`'s own `console.error` fallback.
 *
 * Imported from the barrel on purpose: a re-export is covered by being loaded,
 * so only a barrel import catches a dropped export (the M56 defect class).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { attachConnectionErrorReporter, createConnectionErrorReporter } from '../../src/index.ts';
import type {
  ConnectionErrorLogger,
  ConnectionErrorReporter,
  ConnectionErrorReporterOptions,
} from '../../src/index.ts';

interface Entry {
  readonly level: 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
}

function recordingLogger(): { logger: ConnectionErrorLogger; entries: Entry[] } {
  const entries: Entry[] = [];
  const logger: ConnectionErrorLogger = {
    warn: (message, metadata) => entries.push({ level: 'warn', message, metadata }),
    info: (message, metadata) => entries.push({ level: 'info', message, metadata }),
    debug: (message, metadata) => entries.push({ level: 'debug', message, metadata }),
  };
  return { logger, entries };
}

/** A minimal event emitter recording listeners by event name. */
function fakeEmitter() {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  return {
    on(event: string, listener: (value: unknown) => void): unknown {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
    emit(event: string, value?: unknown): void {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    count(event: string): number {
      return listeners.get(event)?.length ?? 0;
    },
  };
}

describe('createConnectionErrorReporter', () => {
  it('warns on the first error and names the source', () => {
    const { logger, entries } = recordingLogger();
    const reporter = createConnectionErrorReporter({ source: 'pkg: redis', logger: () => logger });

    reporter.report(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    expect(entries).toEqual([
      {
        level: 'warn',
        message: 'pkg: redis: connection error: connect ECONNREFUSED 127.0.0.1:6379',
        metadata: { source: 'pkg: redis', error: 'connect ECONNREFUSED 127.0.0.1:6379' },
      },
    ]);
  });

  it('logs consecutive identical errors at debug with a running count', () => {
    const { logger, entries } = recordingLogger();
    const reporter = createConnectionErrorReporter({ source: 's', logger: () => logger });

    for (let i = 0; i < 4; i++) reporter.report(new Error('refused'));

    expect(entries.map((e) => e.level)).toEqual(['warn', 'debug', 'debug', 'debug']);
    expect(entries.map((e) => e.metadata?.['repeats'])).toEqual([undefined, 1, 2, 3]);
    expect(entries[1].message).toBe('s: connection error repeated: refused');
  });

  it('warns again when the message changes', () => {
    const { logger, entries } = recordingLogger();
    const reporter = createConnectionErrorReporter({ source: 's', logger: () => logger });

    reporter.report(new Error('read ECONNRESET'));
    reporter.report(new Error('connect ECONNREFUSED'));
    reporter.report(new Error('connect ECONNREFUSED'));
    reporter.report(new Error('read ECONNRESET'));

    expect(entries.map((e) => e.level)).toEqual(['warn', 'warn', 'debug', 'warn']);
    expect(entries[3].metadata?.['repeats']).toBeUndefined();
  });

  it('logs recovery once at info and resets, so the next outage warns again', () => {
    const { logger, entries } = recordingLogger();
    const reporter = createConnectionErrorReporter({ source: 's', logger: () => logger });

    reporter.report(new Error('refused'));
    reporter.report(new Error('refused'));
    reporter.recovered();
    reporter.recovered();
    reporter.report(new Error('refused'));

    expect(entries.map((e) => e.level)).toEqual(['warn', 'debug', 'info', 'warn']);
    expect(entries[2]).toEqual({
      level: 'info',
      message: 's: connection recovered after 2 error(s)',
      metadata: { source: 's', errors: 2 },
    });
  });

  it('logs nothing on recovery when no error was reported', () => {
    const { logger, entries } = recordingLogger();
    const reporter = createConnectionErrorReporter({ source: 's', logger: () => logger });

    reporter.recovered();

    expect(entries).toEqual([]);
  });

  it('reads the logger at call time, not at construction', () => {
    const { logger, entries } = recordingLogger();
    const holder: { current?: ConnectionErrorLogger } = {};
    const reporter = createConnectionErrorReporter({ source: 's', logger: () => holder.current });

    reporter.report(new Error('before'));
    holder.current = logger;
    reporter.report(new Error('after'));

    expect(entries.map((e) => e.metadata?.['error'])).toEqual(['after']);
  });

  it('drops the event when no logger is registered, without throwing', () => {
    const reporter = createConnectionErrorReporter({ source: 's', logger: () => undefined });

    expect(() => {
      reporter.report(new Error('x'));
      reporter.recovered();
    }).not.toThrow();
  });

  it('never throws when the logger or its accessor throws', () => {
    const throwing: ConnectionErrorLogger = {
      warn: () => {
        throw new Error('sink down');
      },
      info: () => {
        throw new Error('sink down');
      },
      debug: () => {
        throw new Error('sink down');
      },
    };
    const viaLogger = createConnectionErrorReporter({ source: 's', logger: () => throwing });
    const viaAccessor = createConnectionErrorReporter({
      source: 's',
      logger: () => {
        throw new Error('accessor down');
      },
    });

    expect(() => {
      viaLogger.report(new Error('a'));
      viaLogger.report(new Error('a'));
      viaLogger.recovered();
      viaAccessor.report(new Error('a'));
    }).not.toThrow();
  });

  it('logs a non-Error value by its string form, and survives one that cannot be stringified', () => {
    const { logger, entries } = recordingLogger();
    const reporter = createConnectionErrorReporter({ source: 's', logger: () => logger });
    const hostile = {
      toString(): string {
        throw new Error('no');
      },
    };

    reporter.report('plain string');
    reporter.report(hostile);

    expect(entries.map((e) => e.metadata?.['error'])).toEqual([
      'plain string',
      'unrepresentable error value',
    ]);
  });

  it('accepts its options through the exported type', () => {
    const options: ConnectionErrorReporterOptions = { source: 's', logger: () => undefined };
    const reporter: ConnectionErrorReporter = createConnectionErrorReporter(options);

    expect(typeof reporter.report).toBe('function');
  });
});

describe('attachConnectionErrorReporter', () => {
  it("routes 'error' to report and 'ready' to recovered", () => {
    const { logger, entries } = recordingLogger();
    const reporter = createConnectionErrorReporter({ source: 's', logger: () => logger });
    const client = fakeEmitter();

    expect(attachConnectionErrorReporter(client, reporter)).toBe(true);
    client.emit('error', new Error('refused'));
    client.emit('error', new Error('refused'));
    client.emit('ready');

    expect(client.count('error')).toBe(1);
    expect(client.count('ready')).toBe(1);
    expect(entries.map((e) => e.level)).toEqual(['warn', 'debug', 'info']);
  });

  it('attaches to a function-typed client (a class instance callable object)', () => {
    const reporter = createConnectionErrorReporter({ source: 's', logger: () => undefined });
    const emitter = fakeEmitter();
    const callable = Object.assign(() => undefined, { on: emitter.on.bind(emitter) });

    expect(attachConnectionErrorReporter(callable, reporter)).toBe(true);
    expect(emitter.count('error')).toBe(1);
  });

  it('refuses a value with no on method', () => {
    const reporter = createConnectionErrorReporter({ source: 's', logger: () => undefined });

    expect(attachConnectionErrorReporter(null, reporter)).toBe(false);
    expect(attachConnectionErrorReporter(undefined, reporter)).toBe(false);
    expect(attachConnectionErrorReporter('client', reporter)).toBe(false);
    expect(attachConnectionErrorReporter({}, reporter)).toBe(false);
    expect(attachConnectionErrorReporter({ on: 'not a function' }, reporter)).toBe(false);
  });
});
