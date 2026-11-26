/**
 * Integration fixtures: the cleanup runner attempts every step and a failed
 * setup keeps its own error; the frozen relay refuses an endpoint it cannot
 * relay before it starts.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { cleanupAfter, cleanupAll } from '../fixtures/cleanup-all.ts';
import { relayTarget } from '../fixtures/frozen-relay.ts';

describe('fixture cleanup', () => {
  it('attempts every step after one fails, then throws that failure', async () => {
    const ran: string[] = [];
    const failure = new Error('close failed');
    const outcome = await cleanupAll([
      () => {
        ran.push('close');
        throw failure;
      },
      () => {
        ran.push('pool');
      },
      () => Promise.reject(new Error('drop failed')).finally(() => ran.push('drop')),
      () => {
        ran.push('admin');
      },
    ]).catch((error: unknown) => error);
    expect(ran).toEqual(['close', 'pool', 'drop', 'admin']);
    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors[0]).toBe(failure);
    await expect(cleanupAll([() => Promise.reject(failure)])).rejects.toBe(failure);
    await expect(cleanupAll([() => undefined])).resolves.toBeUndefined();
  });

  it('rethrows the setup error even when cleanup fails too', async () => {
    const setup = new Error('setup failed');
    const ran: string[] = [];
    await expect(
      cleanupAfter(setup, [
        () => Promise.reject(new Error('disconnect failed')),
        () => {
          ran.push('admin');
        },
      ]),
    ).rejects.toBe(setup);
    expect(ran).toEqual(['admin']);
  });
});

describe('frozen relay target', () => {
  it('accepts plaintext endpoints and refuses TLS ones by scheme', () => {
    expect(relayTarget('http://127.0.0.1:8082/')).toEqual({ host: '127.0.0.1', port: 8082 });
    expect(relayTarget('127.0.0.1:8086')).toEqual({ host: '127.0.0.1', port: 8086 });
    expect(() => relayTarget('https://account.documents.azure.com:443/')).toThrow(
      /plaintext only.*'https:'.*http:\/\//,
    );
  });
});
