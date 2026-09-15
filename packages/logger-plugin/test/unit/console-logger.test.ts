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

    // The suite's other nested cases build their metadata inline, so nothing
    // held a reference to read back — which is why the mutation below shipped.
    // Every case here keeps the object the caller would have kept.
    it("does not write into the caller's nested object", () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, {
        level: 'info',
        redact: ['auth.token'],
      });
      const user = { token: 'secret-abc', name: 'bob' };

      const { output } = captureConsole(() => {
        logger.info('login', { auth: user });
      });

      // Redacted on the way out ...
      expect(JSON.parse(output[0]!).auth.token).toBe('[Redacted]');
      // ... and the application's own object is untouched.
      expect(user.token).toBe('secret-abc');
      expect(user.name).toBe('bob');
    });

    it('leaves a later unredacted log of the same object intact', () => {
      const { runtime } = createFakeRuntime();
      const redacting = new ConsoleLogger(runtime, {
        level: 'info',
        redact: ['auth.token'],
      });
      const plain = new ConsoleLogger(runtime, { level: 'info' });
      const user = { token: 'secret-abc' };

      const { output } = captureConsole(() => {
        redacting.info('login', { auth: user });
        plain.info('audit', { auth: user });
      });

      expect(JSON.parse(output[0]!).auth.token).toBe('[Redacted]');
      // The corruption was durable: this read '[Redacted]' before the fix,
      // so anything persisting `user` afterwards stored the literal string.
      expect(JSON.parse(output[1]!).auth.token).toBe('secret-abc');
    });

    it('leaves every intermediate object intact on a deep path', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, {
        level: 'info',
        redact: ['x.b.c.d'],
      });
      const deep = { b: { c: { d: 'deep-secret', e: 'keep' } } };

      const { output } = captureConsole(() => {
        logger.info('msg', { x: deep });
      });

      const entry = JSON.parse(output[0]!);
      expect(entry.x.b.c.d).toBe('[Redacted]');
      expect(entry.x.b.c.e).toBe('keep');
      expect(deep.b.c.d).toBe('deep-secret');
    });

    it('redacts two paths sharing a prefix without mutating the caller', () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, {
        level: 'info',
        redact: ['a.token', 'a.secret'],
      });
      const account = { token: 't', secret: 's', keep: 'k' };

      const { output } = captureConsole(() => {
        logger.info('msg', { a: account });
      });

      const entry = JSON.parse(output[0]!);
      expect(entry.a.token).toBe('[Redacted]');
      expect(entry.a.secret).toBe('[Redacted]');
      expect(entry.a.keep).toBe('k');
      expect(account).toEqual({ token: 't', secret: 's', keep: 'k' });
    });

    it("stops at an array, matching pino's dotted-path behaviour", () => {
      const { runtime } = createFakeRuntime();
      const logger = new ConsoleLogger(runtime, {
        level: 'info',
        redact: ['users.token'],
      });

      const { output } = captureConsole(() => {
        logger.info('list', { users: [{ token: 'a' }, { token: 'b' }] });
      });

      // Pins the documented limit: pino needs `users[*].token` for an array
      // and would equally not match the dotted form, so descending here would
      // make one option behave differently per transport. Unifying the two
      // syntaxes is M96's, not this fix's.
      const entry = JSON.parse(output[0]!);
      expect(entry.users[0].token).toBe('a');
      expect(entry.users[1].token).toBe('b');
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
