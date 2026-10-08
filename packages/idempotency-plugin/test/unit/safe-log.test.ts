/**
 * `safeLog` (M109a audit round 3, O1): a log line can never change an
 * idempotency outcome.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ILogger } from '@setu-ts/common';
import { safeLog } from '../../src/core/safe-log.ts';

describe('safeLog', () => {
  it('writes through the logger the thunk returns, at the given level', () => {
    const lines: unknown[][] = [];
    const logger = {
      warn: (...args: unknown[]) => void lines.push(['warn', ...args]),
      error: (...args: unknown[]) => void lines.push(['error', ...args]),
    } as unknown as ILogger;
    safeLog(() => logger, 'warn', 'w', { a: 1 });
    safeLog(() => logger, 'error', 'e', { b: 2 });
    expect(lines).toEqual([['warn', 'w', { a: 1 }], ['error', 'e', { b: 2 }]]);
  });

  it('discards a throw from the logger and from the thunk', () => {
    const throwing = {
      warn: () => {
        throw new Error('down');
      },
    } as unknown as ILogger;
    expect(() => safeLog(() => throwing, 'warn', 'w', {})).not.toThrow();
    expect(() =>
      safeLog(
        () => {
          throw new Error('thunk');
        },
        'error',
        'e',
        {},
      )
    ).not.toThrow();
  });

  it('does nothing when no logger is registered', () => {
    expect(() => safeLog(() => undefined, 'warn', 'w', {})).not.toThrow();
  });
});
