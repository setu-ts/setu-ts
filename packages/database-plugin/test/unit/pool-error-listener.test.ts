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
  it('gives every checked-out client one listener that reports without throwing (X94-1)', () => {
    const pool = new EventEmitter();
    const logs: { message: string; meta: Record<string, unknown> }[] = [];
    const warn = (message: string, meta: Record<string, unknown>): void => {
      logs.push({ message, meta });
    };
    expect(attachPoolErrorListener({ $client: pool }, warn)).toBe(true);
    // A second attach must not add a second checkout handler.
    attachPoolErrorListener({ $client: pool }, warn);
    expect(pool.listenerCount('acquire')).toBe(1);
    const client = new EventEmitter();
    pool.emit('acquire', client);
    pool.emit('acquire', client);
    expect(client.listenerCount('error')).toBe(1);
    const error = Object.assign(new Error('terminating connection'), { code: '57P01' });
    expect(() => client.emit('error', error)).not.toThrow();
    expect(logs).toEqual([
      {
        message: 'Database pool reported a checked-out-connection error',
        meta: { error: describeError(error) },
      },
    ]);
    // Released: the pool's idle listener covers it, so the checkout one goes.
    pool.emit('release', undefined, client);
    expect(client.listenerCount('error')).toBe(0);
    pool.emit('acquire', client);
    expect(client.listenerCount('error')).toBe(1);
    // Values that are not emitters, and clients never checked out, are skipped.
    for (const value of [null, 1, {}]) {
      expect(() => pool.emit('acquire', value)).not.toThrow();
      expect(() => pool.emit('release', undefined, value)).not.toThrow();
    }
    expect(() => pool.emit('release', undefined, new EventEmitter())).not.toThrow();
  });
  it('removes the listener on a mysql2-style release that passes only the connection', () => {
    const pool = new EventEmitter();
    attachPoolErrorListener({ $client: pool }, () => {});
    const connection = new EventEmitter();
    pool.emit('acquire', connection);
    expect(connection.listenerCount('error')).toBe(1);
    // mysql2's pool emits `release(connection)`; pg-pool emits `release(err, client)`.
    pool.emit('release', connection);
    expect(connection.listenerCount('error')).toBe(0);
    // A pg release carrying an error still names the client second.
    const client = new EventEmitter();
    pool.emit('acquire', client);
    pool.emit('release', new Error('broken'), client);
    expect(client.listenerCount('error')).toBe(0);
  });
  it('instruments checkouts even when the application owns the pool listener', () => {
    const pool = new EventEmitter();
    pool.on('error', () => {});
    expect(attachPoolErrorListener({ $client: pool }, () => {})).toBe(false);
    const client = new EventEmitter();
    pool.emit('acquire', client);
    expect(client.listenerCount('error')).toBe(1);
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
