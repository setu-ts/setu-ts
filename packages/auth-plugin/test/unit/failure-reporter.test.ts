/**
 * `createStateChangeReporter`: one warn per reason change per key, repeats at
 * debug, and a recovery that lets the next failure warn again.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { createStateChangeReporter } from '../../src/issuers/failure-reporter.ts';

/** Records every sink call in order. */
function recordingSinks(): {
  readonly lines: Array<{ level: 'warn' | 'debug'; message: string }>;
  readonly sinks: {
    warn: (message: string) => void;
    debug: (message: string) => void;
  };
} {
  const lines: Array<{ level: 'warn' | 'debug'; message: string }> = [];
  return {
    lines,
    sinks: {
      warn: (message) => lines.push({ level: 'warn', message }),
      debug: (message) => lines.push({ level: 'debug', message }),
    },
  };
}

describe('createStateChangeReporter', () => {
  it('warns on the first failure of a key', () => {
    const { sinks, lines } = recordingSinks();
    const reporter = createStateChangeReporter(sinks);

    reporter.failed('idp', 'discovery-issuer-mismatch', 'first');

    expect(lines).toEqual([{ level: 'warn', message: 'first' }]);
  });

  it('debugs a repeat of the same reason', () => {
    const { sinks, lines } = recordingSinks();
    const reporter = createStateChangeReporter(sinks);

    reporter.failed('idp', 'discovery-issuer-mismatch', 'first');
    reporter.failed('idp', 'discovery-issuer-mismatch', 'second');

    expect(lines).toEqual([
      { level: 'warn', message: 'first' },
      { level: 'debug', message: 'second' },
    ]);
  });

  it('warns again when the reason changes', () => {
    const { sinks, lines } = recordingSinks();
    const reporter = createStateChangeReporter(sinks);

    reporter.failed('idp', 'discovery-issuer-mismatch', 'mismatch');
    reporter.failed('idp', 'http-status', 'status');

    expect(lines.map((line) => line.level)).toEqual(['warn', 'warn']);
    expect(lines.map((line) => line.message)).toEqual(['mismatch', 'status']);
  });

  it('warns again after a recovery, even for the same reason', () => {
    const { sinks, lines } = recordingSinks();
    const reporter = createStateChangeReporter(sinks);

    reporter.failed('idp', 'http-status', 'before');
    reporter.recovered('idp');
    reporter.failed('idp', 'http-status', 'after');

    expect(lines.map((line) => line.level)).toEqual(['warn', 'warn']);
    expect(lines.map((line) => line.message)).toEqual(['before', 'after']);
  });

  it('tracks keys independently', () => {
    const { sinks, lines } = recordingSinks();
    const reporter = createStateChangeReporter(sinks);

    reporter.failed('idp', 'http-status', 'idp');
    reporter.failed('other', 'http-status', 'other');
    reporter.failed('idp', 'http-status', 'idp repeat');

    expect(lines.map((line) => line.level)).toEqual(['warn', 'warn', 'debug']);
    expect(lines.map((line) => line.message)).toEqual(['idp', 'other', 'idp repeat']);
  });

  it('swallows a throwing warn sink', () => {
    const reporter = createStateChangeReporter({
      warn: () => {
        throw new Error('warn down');
      },
      debug: () => {},
    });

    expect(() => reporter.failed('idp', 'http-status', 'first')).not.toThrow();
  });

  it('swallows a throwing debug sink', () => {
    const reporter = createStateChangeReporter({
      warn: () => {},
      debug: () => {
        throw new Error('debug down');
      },
    });

    reporter.failed('idp', 'http-status', 'first');
    expect(() => reporter.failed('idp', 'http-status', 'repeat')).not.toThrow();
  });
});
