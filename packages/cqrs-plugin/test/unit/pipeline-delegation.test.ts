/**
 * Request-bus delegation tests for the shared behavior composer.
 */
import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import { RequestBus } from '../../src/bus/request-bus.ts';

describe('RequestBus behavior-chain delegation', () => {
  it('preserves declared ordering, terminal execution, and result propagation', async () => {
    const calls: string[] = [];
    const bus = new RequestBus([
      {
        handle: (_request, next) => {
          calls.push('first-before');
          return next().then((result) => {
            calls.push('first-after');
            return `${String(result)}:first`;
          });
        },
      },
      {
        handle: (_request, next) => {
          calls.push('second-before');
          return next().then((result) => {
            calls.push('second-after');
            return `${String(result)}:second`;
          });
        },
      },
    ]);
    bus.registerHandler('delegation', () => {
      calls.push('terminal');
      return Promise.resolve('result');
    });

    const result = await bus.execute<string>({ type: 'delegation', data: null });

    expect(calls).toEqual([
      'first-before',
      'second-before',
      'terminal',
      'second-after',
      'first-after',
    ]);
    expect(result).toBe('result:second:first');
  });

  it('preserves short-circuiting and returns the short-circuit result', async () => {
    const calls: string[] = [];
    const bus = new RequestBus([
      {
        handle: (_request, _next) => {
          calls.push('short-circuit');
          return 'early-result';
        },
      },
      {
        handle: (_request, next) => {
          calls.push('downstream');
          return next();
        },
      },
    ]);
    bus.registerHandler('delegation', () => {
      calls.push('terminal');
      return Promise.resolve('terminal-result');
    });

    const result = await bus.execute<string>({ type: 'delegation', data: null });

    expect(calls).toEqual(['short-circuit']);
    expect(result).toBe('early-result');
  });
});
