/**
 * The published surface of `@setu-ts/logger-plugin`.
 *
 * M90i ships a signal, not an API: the trace-enriching decorator is internal,
 * exactly as `messaging-plugin`'s `TracedBroker` and `queue-plugin`'s
 * `TracedQueue` are. Nothing else would notice a leak — a re-export file is
 * fully covered merely by being loaded, and no test imports through the barrel
 * (the M56 defect class).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';

/** Every value the barrel is expected to publish. */
const EXPECTED_VALUES = [
  'LoggerPlugin',
  'ConsoleLogger',
  'NoopLogger',
  'PinoLogger',
  'createRequestLoggerMiddleware',
] as const;

describe('barrel exports', () => {
  for (const name of EXPECTED_VALUES) {
    it(`exports ${name}`, () => {
      expect(typeof (barrel as Record<string, unknown>)[name]).toBe('function');
    });
  }

  it('publishes exactly the documented value surface — no more', () => {
    // A membership test rather than a per-name presence check: presence checks
    // pass just as well when something extra has leaked.
    expect(Object.keys(barrel).sort()).toEqual([...EXPECTED_VALUES].sort());
  });

  it('does NOT export the trace-enriching decorator', () => {
    expect('TraceEnrichedLogger' in barrel).toBe(false);
  });
});
