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
