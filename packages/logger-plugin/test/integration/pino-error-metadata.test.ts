/**
 * Integration test: a raw `Error` in metadata reaches a REAL Pino sink with its
 * message (plan §3.6, X2-5). This is the guarded `npm:pino` probe (the M4
 * precedent) and also settles §8's pino-argument-order risk: Pino's signature
 * is `(obj, msg)` — the structured object FIRST — so if the wrapper passed the
 * arguments swapped, the metadata would be dropped and the message would never
 * reach the sink.
 *
 * The test builds a real Pino logger (through `PinoLogger.create` with a
 * factory that wraps real Pino on a capturing stream), logs a raw `Error`, and
 * asserts the normalized message appears in the captured output.
 *
 * @module
 */
// deno-lint-ignore-file no-explicit-any
import { Writable } from 'node:stream';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { PinoLogger } from '../../src/loggers/pino-logger.ts';
import type { PinoFactory } from '../../src/loggers/pino-logger.ts';
import type { LogMetadata } from '@setu-ts/common';

/** A real `Writable` that captures the lines Pino writes to it. */
function captureStream(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe('PinoLogger — raw Error metadata reaches a real Pino sink (X2-5)', () => {
  it('emits the Error message through real Pino (metadata is not dropped)', async () => {
    // Guard: only run when real Pino is installed (the M4 precedent).
    let pino: (destination?: unknown, options?: Record<string, unknown>) => unknown;
    try {
      // pino is an OPTIONAL heavy dep, lazily loaded (AI_GUIDELINES §12.2)
      const mod = await import('npm:pino@10.x');
      pino = (mod as { default: typeof pino }).default;
    } catch {
      // Pino not available in this environment — skip rather than fail.
      return;
    }

    const { lines, stream } = captureStream();
    // A factory that builds REAL Pino writing to the capturing stream, so the
    // wrapper's normalization and argument order are exercised end to end.
    // `PinoLoggerLike` is internal to the module, so the real Pino instance is
    // cast at this boundary (the test's only `any`).
    const factory: PinoFactory = (opts) => pino(stream, { level: opts.level }) as any;
    const logger = await PinoLogger.create({ level: 'info', pinoFactory: factory });

    logger.error('something failed', { error: new Error('the pino metadata message') });

    // Give Pino a moment to flush the capture stream.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = lines.join('');
    // The metadata's message reached the sink — proving (obj, msg) order and
    // that the raw Error was normalized rather than flattened to {}.
    expect(output).toContain('the pino metadata message');
    expect(output).toContain('something failed');
  });
});

/**
 * Regression tests for M70f re-review finding 1: an `Error` supplied as a BASE
 * binding (via the `bindings` option) or a CHILD binding (via `child()`) must be
 * preserved in the emitted record — normalized to its serializable shape — and
 * not collapsed to `{}` by Pino's `JSON.stringify`. These drive a REAL Pino
 * logger (the guarded `npm:pino` probe) end to end.
 */
describe('PinoLogger — Error-valued base and child bindings survive (X2-5, finding 1)', () => {
  /** Parses each captured line into its JSON record. */
  function records(lines: string[]): Record<string, unknown>[] {
    return lines
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** Finds the record whose `msg` matches, if any. */
  function findRecord(
    all: Record<string, unknown>[],
    msg: string,
  ): Record<string, unknown> | undefined {
    return all.find((record) => record.msg === msg);
  }

  /**
   * Builds a real Pino logger writing to a fresh capturing stream, optionally
   * with base `bindings`. Returns `undefined` when real Pino is unavailable
   * (skip rather than fail, the M4 precedent).
   */
  async function realLogger(
    bindings?: LogMetadata,
  ): Promise<{ logger: PinoLogger; lines: string[] } | undefined> {
    let pino: (options?: Record<string, unknown>, destination?: unknown) => unknown;
    try {
      // pino is an OPTIONAL heavy dep, lazily loaded (AI_GUIDELINES §12.2)
      const mod = await import('npm:pino@10.x');
      pino = (mod as { default: typeof pino }).default;
    } catch {
      return undefined;
    }
    const { lines, stream } = captureStream();
    // Forward the FULL options object as Pino's FIRST argument: the wrapper's
    // `#buildPino` calls `factory(pinoOptions)` and pino's args normalizer
    // treats arg 1 as options and arg 2 as the destination — passing the stream
    // first would make pino read it as options and discard the real options
    // (including `base`), so the base bindings would never reach the sink.
    const factory: PinoFactory = (opts) => pino(opts, stream) as any;
    // `exactOptionalPropertyTypes` is on: omit `bindings` rather than passing
    // undefined.
    const logger = await PinoLogger.create({
      level: 'info',
      pinoFactory: factory,
      ...(bindings === undefined ? {} : { bindings }),
    });
    return { logger, lines };
  }

  it('preserves an Error supplied as a BASE binding in the emitted record', async () => {
    const built = await realLogger({ error: new Error('base binding error message') });
    if (built === undefined) {
      return;
    }
    built.logger.info('base binding logged');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const record = findRecord(records(built.lines), 'base binding logged');
    expect(record).toBeDefined();
    // The base error binding is present and carries the serialized Error shape
    // (name, message, stack) — NOT flattened to {}.
    const error = (record as { error?: Record<string, unknown> }).error;
    expect(error).toBeDefined();
    expect(error?.message).toBe('base binding error message');
    expect(error?.name).toBe('Error');
    expect(typeof error?.stack).toBe('string');
    expect(Object.keys(error ?? {}).length).toBeGreaterThan(0);
  });

  it('preserves an Error supplied as a CHILD binding in the emitted record', async () => {
    const built = await realLogger();
    if (built === undefined) {
      return;
    }
    const child = built.logger.child({ error: new Error('child binding error message') });
    child.info('child binding logged');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const record = findRecord(records(built.lines), 'child binding logged');
    expect(record).toBeDefined();
    // The child error binding is present and carries the serialized Error shape
    // (name, message, stack) — NOT flattened to {}.
    const error = (record as { error?: Record<string, unknown> }).error;
    expect(error).toBeDefined();
    expect(error?.message).toBe('child binding error message');
    expect(error?.name).toBe('Error');
    expect(typeof error?.stack).toBe('string');
    expect(Object.keys(error ?? {}).length).toBeGreaterThan(0);
  });
});
