/**
 * Unit test: `ConsoleLogger` normalizes a raw `Error` in metadata before
 * emission (X2-5), so it renders its `message` and `stack` rather than `{}`;
 * a redact path into the normalized object still redacts; and a non-`Error`
 * value is left untouched (plan §3.6).
 *
 * @module
 */
// deno-lint-ignore-file no-console
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

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

describe('ConsoleLogger — raw Error metadata (X2-5)', () => {
  it('emits message and stack for a raw Error instead of {}', () => {
    const { runtime } = createFakeRuntime({ clock: 1_700_000_000_000 });
    const logger = new ConsoleLogger(runtime, { level: 'error' });
    const boom = new Error('the raw error message');

    const { output } = captureConsole(() => {
      logger.error('something failed', { error: boom });
    });

    expect(output.length).toBe(1);
    const entry = JSON.parse(output[0]!) as Record<string, unknown>;
    // The Error is normalized, not flattened to {}.
    const error = entry.error as Record<string, unknown>;
    expect(error).toEqual(
      expect.objectContaining({ name: 'Error', message: 'the raw error message' }),
    );
    expect(typeof error.stack).toBe('string');
    expect(error.stack).toContain('the raw error message');
    // The raw non-enumerable fields are gone: the entry is fully serializable.
    expect(JSON.parse(JSON.stringify(entry)).error).toEqual(error);
  });

  it('redacts a path into the normalized Error object', () => {
    const { runtime } = createFakeRuntime({ clock: 1_700_000_000_000 });
    const logger = new ConsoleLogger(runtime, { level: 'error', redact: ['error.message'] });
    const boom = new Error('secret in the message');

    const { output } = captureConsole(() => {
      logger.error('something failed', { error: boom });
    });

    const entry = JSON.parse(output[0]!) as Record<string, unknown>;
    const error = entry.error as Record<string, unknown>;
    // Normalized first (so the path exists), then redacted.
    expect(error.message).toBe('[Redacted]');
    expect(error.name).toBe('Error');
  });

  it('leaves a non-Error value untouched', () => {
    const { runtime } = createFakeRuntime({ clock: 1_700_000_000_000 });
    const logger = new ConsoleLogger(runtime, { level: 'info' });

    const { output } = captureConsole(() => {
      logger.info('user created', { userId: '123', nested: { a: 1 } });
    });

    const entry = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(entry.userId).toBe('123');
    expect(entry.nested).toEqual({ a: 1 });
  });
});
