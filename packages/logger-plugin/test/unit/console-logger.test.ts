// deno-lint-ignore-file no-console
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ILogger } from '@setu-ts/common';

import { ConsoleLogger } from '../../src/loggers/console-logger.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** Captures console.log output for the duration of the callback. */
function captureConsole<T>(fn: () => T): { output: string[]; result: T } {
  const output: string[] = [];
  const original = console.log;
  // deno-lint-ignore no-explicit-any
  (console as any).log = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  try {
    const result = fn();
    return { output, result };
  } finally {
    (console as { log: typeof console.log }).log = original;
  }
}

describe('ConsoleLogger', () => {
  beforeEach(() => {
    // Reset state if needed; each test creates its own fake runtime.
  });

  describe('level filtering', () => {
    it('emits only entries at or above the configured level', () => {
      const { runtime } = createFakeRuntime({ clock: 1_700_000_000_000 });
      const logger = new ConsoleLogger(runtime, { level: 'warn' });
      const { output } = captureConsole(() => {
        logger.fatal('fatal msg');
        logger.error('error msg');
        logger.warn('warn msg');
        logger.info('info msg');
        logger.debug('debug msg');
        logger.trace('trace msg');
      });
      expect(output.length).toBe(3);
      expect(output.some((l) => l.includes('"fatal"'))).toBe(true);
      expect(output.some((l) => l.includes('"error"'))).toBe(true);
      expect(output.some((l) => l.includes('"warn"'))).toBe(true);
      expect(output.some((l) => l.includes('"info"'))).toBe(false);
      expect(output.some((l) => l.includes('"debug"'))).toBe(false);
      expect(output.some((l) => l.includes('"trace"'))).toBe(false);
    });

    it('defaults to info level', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime);
      expect(logger.level).toBe('info');
    });

    it('emits all levels at trace', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'trace' });
      const { output } = captureConsole(() => {
        logger.fatal('f');
        logger.error('e');
        logger.warn('w');
        logger.info('i');
        logger.debug('d');
        logger.trace('t');
      });
      expect(output.length).toBe(6);
    });
  });

  describe('structured output', () => {
    it('emits JSON lines with level, time, msg, and metadata', () => {
      const { runtime } = createFakeRuntime({ clock: 1_700_000_000_000 });
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const { output } = captureConsole(() => {
        logger.info('user created', { userId: '123' });
      });
      expect(output.length).toBe(1);
      const entry = JSON.parse(output[0]!);
      expect(entry.level).toBe('info');
      expect(entry.time).toBe(1_700_000_000_000);
      expect(entry.msg).toBe('user created');
      expect(entry.userId).toBe('123');
    });

    it('emits entries without metadata when none is provided', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const { output } = captureConsole(() => {
        logger.info('hello');
      });
      expect(output.length).toBe(1);
      const entry = JSON.parse(output[0]!);
      expect(entry.msg).toBe('hello');
      expect(entry.level).toBe('info');
    });
  });

  describe('child logger', () => {
    it('merges bindings into every entry', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const child = logger.child({ requestId: 'abc' });
      const { output } = captureConsole(() => {
        child.info('processing');
      });
      expect(output.length).toBe(1);
      const entry = JSON.parse(output[0]!);
      expect(entry.requestId).toBe('abc');
      expect(entry.msg).toBe('processing');
    });

    it('child of child accumulates bindings', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const child = logger.child({ requestId: 'abc' });
      const grandchild = child.child({ userId: '42' });
      const { output } = captureConsole(() => {
        grandchild.info('nested');
      });
      const entry = JSON.parse(output[0]!);
      expect(entry.requestId).toBe('abc');
      expect(entry.userId).toBe('42');
    });

    it('child metadata does not override parent bindings when absent', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const child = logger.child({ requestId: 'abc' });
      const { output } = captureConsole(() => {
        child.info('msg', { extra: 'data' });
      });
      const entry = JSON.parse(output[0]!);
      expect(entry.requestId).toBe('abc');
      expect(entry.extra).toBe('data');
    });

    it('returns an ILogger', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime);
      const child: ILogger = logger.child({ k: 'v' });
      expect(child).toBeDefined();
    });
  });

  describe('redaction', () => {
    it('redacts top-level paths', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, {
        level: 'info',
        redact: ['password', 'token'],
      });
      const { output } = captureConsole(() => {
        logger.info('login', { password: 'secret', token: 'abc', user: 'bob' });
      });
      const entry = JSON.parse(output[0]!);
      expect(entry.password).toBe('[Redacted]');
      expect(entry.token).toBe('[Redacted]');
      expect(entry.user).toBe('bob');
    });

    it('redacts nested dot-paths', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, {
        level: 'info',
        redact: ['auth.token'],
      });
      const { output } = captureConsole(() => {
        logger.info('req', { auth: { token: 'secret', user: 'bob' } });
      });
      const entry = JSON.parse(output[0]!);
      expect(entry.auth.token).toBe('[Redacted]');
      expect(entry.auth.user).toBe('bob');
    });

    it('does not redact when no redact paths are configured', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const { output } = captureConsole(() => {
        logger.info('msg', { password: 'secret' });
      });
      const entry = JSON.parse(output[0]!);
      expect(entry.password).toBe('secret');
    });

    it('ignores redact paths that do not exist', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, {
        level: 'info',
        redact: ['nonexistent'],
      });
      const { output } = captureConsole(() => {
        logger.info('msg', { foo: 'bar' });
      });
      const entry = JSON.parse(output[0]!);
      expect(entry.foo).toBe('bar');
    });
  });

  // A log call must emit one line and never throw. `LogMetadata` is
  // `Readonly<Record<string, unknown>>` and carries no JSON constraint, so
  // every value below is legal metadata by the contract — and each one used to
  // take the caller down. That is worst in a catch block, where the TypeError
  // replaces the error being reported.
  describe('metadata JSON.stringify refuses', () => {
    it('emits a circular structure instead of throwing', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const cyclic: Record<string, unknown> = { t: 1 };
      cyclic.self = cyclic;

      const { output } = captureConsole(() => {
        logger.info('m', { r: cyclic });
      });

      const entry = JSON.parse(output[0]!);
      expect(entry.r.self).toBe('[Circular]');
      expect(entry.r.t).toBe(1);
      expect(entry.msg).toBe('m');
    });

    it('does not mistake a shared object for a cycle', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const shared = { a: 1 };

      const { output } = captureConsole(() => {
        logger.info('m', { x: shared, y: shared });
      });

      const entry = JSON.parse(output[0]!);
      expect(entry.x).toEqual({ a: 1 });
      expect(entry.y).toEqual({ a: 1 });
    });

    it('emits a bigint instead of throwing', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info' });

      const { output } = captureConsole(() => {
        logger.info('m', { v: 9007199254740993n });
      });

      expect(JSON.parse(output[0]!).v).toBe('9007199254740993');
    });

    it('keeps the entry when metadata throws while being read', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const hostile = {
        toJSON(): never {
          throw new Error('boom');
        },
      };

      const { output } = captureConsole(() => {
        logger.error('database write failed', { r: hostile });
      });

      // The message is the half an operator is looking for, so it survives.
      const entry = JSON.parse(output[0]!);
      expect(entry.msg).toBe('database write failed');
      expect(entry.level).toBe('error');
      expect(entry.metadata).toBe('[unserializable metadata]');
    });

    it('emits exactly one line per call on every refused input', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const hostile = {
        get x(): never {
          throw new Error('boom');
        },
      };

      const { output } = captureConsole(() => {
        logger.info('a', { r: cyclic });
        logger.info('b', { v: 1n });
        logger.info('c', { r: hostile });
      });

      expect(output.length).toBe(3);
    });

    // The getter cases above nest the hostile object one level down, so the
    // throw happens inside JSON.stringify. A getter on the TOP-LEVEL metadata
    // fires during the spread in #log instead — before normalizeMetadata,
    // before redaction, and before the serializer sees the object at all.
    it('survives a throwing getter on the top-level metadata object', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const hostile = {
        get x(): never {
          throw new Error('boom');
        },
      };

      const { output } = captureConsole(() => {
        logger.error('payment failed', hostile);
      });

      expect(output.length).toBe(1);
      const entry = JSON.parse(output[0]!);
      expect(entry.msg).toBe('payment failed');
      expect(entry.level).toBe('error');
      expect(entry.metadata).toBe('[unserializable metadata]');
    });

    it('survives a top-level throwing getter in pretty mode', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info', pretty: true });
      const hostile = {
        get x(): never {
          throw new Error('boom');
        },
      };

      const { output } = captureConsole(() => {
        logger.info('m', hostile);
      });

      expect(output.length).toBe(1);
      expect(output[0]).toContain('[unserializable metadata]');
      expect(output[0]).toContain('m');
    });

    // A getter one level DOWN survives the spread — which copies `outer` by
    // reference without reading through it — and fires inside #redactFields
    // when the redact path walks into it. That is a third distinct reader,
    // after the spread and the serializer. (A getter on the top-level object
    // cannot reach it: the spread throws first.)
    it('survives a throwing getter reached by a redact path', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, {
        level: 'info',
        redact: ['outer.a.b'],
      });
      const outer = {
        get a(): never {
          throw new Error('boom');
        },
      };

      const { output } = captureConsole(() => {
        logger.info('m', { outer });
      });

      expect(output.length).toBe(1);
      expect(JSON.parse(output[0]!).metadata).toBe('[unserializable metadata]');
    });

    it('survives the same inputs in pretty mode', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, { level: 'info', pretty: true });
      const cyclic: Record<string, unknown> = { t: 1 };
      cyclic.self = cyclic;
      const hostile = {
        toJSON(): never {
          throw new Error('boom');
        },
      };

      const { output } = captureConsole(() => {
        logger.info('a', { r: cyclic });
        logger.info('b', { r: hostile });
      });

      expect(output.length).toBe(2);
      expect(output[0]).toContain('[Circular]');
      expect(output[1]).toContain('[unserializable metadata]');
    });
  });

  describe('pretty mode', () => {
    it('pretty-prints entries with a human-readable prefix', () => {
      const { runtime } = createFakeRuntime({ clock: 1_700_000_000_000 });
      const logger = new ConsoleLogger(runtime, { level: 'info', pretty: true });
      const { output } = captureConsole(() => {
        logger.info('server started', { port: 3000 });
      });
      expect(output.length).toBe(1);
      expect(output[0]).toContain('[INFO]');
      expect(output[0]).toContain('server started');
      expect(output[0]).toContain('"port":3000');
    });

    it('pretty-prints without metadata suffix when metadata is empty', () => {
      const { runtime } = createFakeRuntime({ clock: 1_700_000_000_000 });
      const logger = new ConsoleLogger(runtime, { level: 'info', pretty: true });
      const { output } = captureConsole(() => {
        logger.info('hello');
      });
      expect(output[0]).toContain('hello');
      expect(output[0]).not.toContain('{');
    });
  });

  describe('timestamps', () => {
    it('uses runtime.now() for the time field', () => {
      const { runtime, tick } = createFakeRuntime({ clock: 1000 });
      const logger = new ConsoleLogger(runtime, { level: 'info' });
      const { output: out1 } = captureConsole(() => {
        logger.info('first');
      });
      tick(500);
      const { output: out2 } = captureConsole(() => {
        logger.info('second');
      });
      const e1 = JSON.parse(out1[0]!);
      const e2 = JSON.parse(out2[0]!);
      expect(e1.time).toBe(1000);
      expect(e2.time).toBe(1500);
    });
  });
});
