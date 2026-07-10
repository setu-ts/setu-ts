import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { NoopStore } from '../../src/stores/noop-store.ts';

describe('NoopStore', () => {
  it('connect sets ready to true', async () => {
    const store = new NoopStore();
    expect(store.isReady()).toBe(true);
    await store.connect();
    expect(store.isReady()).toBe(true);
  });

  it('disconnect sets ready to false', async () => {
    const store = new NoopStore();
    await store.connect();
    await store.disconnect();
    expect(store.isReady()).toBe(false);
  });

  it('get always returns null', async () => {
    const store = new NoopStore();
    const result = await store.get<string>('any-key');
    expect(result).toBeNull();
  });

  it('set resolves without error', async () => {
    const store = new NoopStore();
    await expect(store.set('key', 'value', 60)).resolves.toBeUndefined();
  });

  it('delete always returns false', async () => {
    const store = new NoopStore();
    const result = await store.delete('any-key');
    expect(result).toBe(false);
  });

  it('has always returns false', async () => {
    const store = new NoopStore();
    const result = await store.has('any-key');
    expect(result).toBe(false);
  });

  it('clear resolves without error', async () => {
    const store = new NoopStore();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
