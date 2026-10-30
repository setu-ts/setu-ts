import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { describeError } from '@setu-ts/common';
import { attachPoolErrorListener } from '../../src/adapters/drizzle/pool-error-listener.ts';

describe('attachPoolErrorListener', () => {
  it('attaches once and reports an idle error without throwing', () => {
    const pool = new EventEmitter();
    const logs: unknown[] = [];
    const warn = (message: string, meta: Record<string, unknown>): void => {
      logs.push({ message, meta });
    };
    expect(attachPoolErrorListener({ $client: pool }, warn)).toBe(true);
    expect(attachPoolErrorListener({ $client: pool }, warn)).toBe(false);
    const error = new Error('Connection terminated');
    expect(() => pool.emit('error', error)).not.toThrow();
    expect(logs).toEqual([
      {
        message: 'Database pool reported an idle-connection error',
        meta: { error: describeError(error) },
      },
    ]);
  });
  it('preserves an application listener', () => {
    const pool = new EventEmitter();
    pool.on('error', () => {});
    expect(
      attachPoolErrorListener({ $client: pool }, () => {
        throw new Error('unexpected');
      }),
    ).toBe(false);
    pool.emit('error', new Error('app handled'));
    expect(pool.listenerCount('error')).toBe(1);
  });
  it('ignores missing clients and non-emitters', () => {
    for (const database of [
      null,
      undefined,
      1,
      {},
      { $client: null },
      { $client: 1 },
      { $client: {} },
      { $client: { on() {} } },
      {
        $client: {
          listenerCount() {
            return 0;
          },
        },
      },
    ]) {
      expect(attachPoolErrorListener(database, () => {})).toBe(false);
    }
  });
});
