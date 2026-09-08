import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createCoalescer } from '../../src/services/coalescer.ts';

describe('createCoalescer', () => {
  it('runs one leader and marks later callers as joined', async () => {
    const coalescer = createCoalescer();
    const store = {};
    let calls = 0;
    let release: (() => void) | undefined;
    const pending = new Promise<string>((resolve) => {
      release = (): void => resolve('value');
    });
    const work = async (): Promise<string> => {
      calls++;
      return await pending;
    };

    const leader = coalescer.run(store, 'key', work);
    const waiter = coalescer.run(store, 'key', work);
    await Promise.resolve();
    expect(calls).toBe(1);

    release?.();
    await expect(leader).resolves.toEqual({ value: 'value', joined: false, ok: true });
    await expect(waiter).resolves.toEqual({ value: 'value', joined: true, ok: true });
  });

  it('clears a settled entry so the next call starts fresh work', async () => {
    const coalescer = createCoalescer();
    const store = {};
    let calls = 0;
    const work = (): Promise<number> => Promise.resolve(++calls);

    await expect(coalescer.run(store, 'key', work)).resolves.toEqual({
      value: 1,
      joined: false,
      ok: true,
    });
    await expect(coalescer.run(store, 'key', work)).resolves.toEqual({
      value: 2,
      joined: false,
      ok: true,
    });
  });

  it('clears a rejected entry so the next call can retry', async () => {
    const coalescer = createCoalescer();
    const store = {};

    await expect(coalescer.run(store, 'key', (): Promise<string> => {
      return Promise.reject(new Error('failed'));
    })).resolves.toMatchObject({ joined: false, ok: false });
    await expect(coalescer.run(store, 'key', (): Promise<string> => Promise.resolve('recovered')))
      .resolves.toEqual({ value: 'recovered', joined: false, ok: true });
  });

  it('reports a rejected leader to waiters without losing that they joined', async () => {
    const coalescer = createCoalescer();
    const store = {};
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fail = async (): Promise<string> => {
      await pending;
      throw new Error('failed');
    };

    const leader = coalescer.run(store, 'key', fail);
    const waiter = coalescer.run(store, 'key', fail);
    release?.();

    await expect(leader).resolves.toMatchObject({ joined: false, ok: false });
    await expect(waiter).resolves.toMatchObject({ joined: true, ok: false });
  });

  it('keeps separate coalescers independent for the same key', async () => {
    const coalescer = createCoalescer();
    const first = {};
    const second = {};
    let firstCalls = 0;
    let secondCalls = 0;

    await Promise.all([
      coalescer.run(first, 'key', (): Promise<string> => {
        firstCalls++;
        return Promise.resolve('first');
      }),
      coalescer.run(second, 'key', (): Promise<string> => {
        secondCalls++;
        return Promise.resolve('second');
      }),
    ]);

    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });
});
