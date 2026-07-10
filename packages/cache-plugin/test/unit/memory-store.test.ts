import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { MemoryStore } from '../../src/stores/memory-store.ts';

describe('MemoryStore', () => {
  let clock: number;
  let store: MemoryStore;

  function createStore(maxSize = 1000): MemoryStore {
    return new MemoryStore('', {
      maxSize,
      clock: () => clock,
    });
  }

  it('connect sets ready to true', async () => {
    store = createStore();
    expect(store.isReady()).toBe(false);
    await store.connect();
    expect(store.isReady()).toBe(true);
  });

  it('disconnect sets ready to false and clears map', async () => {
    store = createStore();
    await store.connect();
    await store.set('k', 'v');
    await store.disconnect();
    expect(store.isReady()).toBe(false);
    expect(await store.get('k')).toBeNull();
  });

  describe('set/get round-trip', () => {
    it('stores and retrieves a value', async () => {
      clock = 1000;
      store = createStore();
      await store.connect();
      await store.set('key', { foo: 'bar' });
      const result = await store.get('key');
      expect(result).toEqual({ foo: 'bar' });
    });

    it('returns null for missing key', async () => {
      clock = 1000;
      store = createStore();
      await store.connect();
      expect(await store.get<string>('missing')).toBeNull();
    });
  });

  describe('TTL', () => {
    it('returns value before expiry', async () => {
      clock = 1000;
      store = createStore();
      await store.connect();
      await store.set('ttl-key', 'val', 10); // 10s TTL
      clock = 1050; // 50ms later
      expect(await store.get('ttl-key')).toBe('val');
    });

    it('returns null after expiry', async () => {
      clock = 1000;
      store = createStore();
      await store.connect();
      await store.set('ttl-key', 'val', 10); // 10s TTL = expires at 11000
      clock = 11001; // 1ms after expiry
      expect(await store.get('ttl-key')).toBeNull();
    });

    it('no TTL means entry never expires', async () => {
      clock = 1000;
      store = createStore();
      await store.connect();
      await store.set('no-ttl', 'forever');
      clock = 999_999_999;
      expect(await store.get('no-ttl')).toBe('forever');
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entry when over maxSize', async () => {
      clock = 1000;
      store = createStore(3);
      await store.connect();
      await store.set('a', 1);
      await store.set('b', 2);
      await store.set('c', 3);
      // Map is full, inserting 'd' evicts 'a'
      await store.set('d', 4);
      expect(await store.get('a')).toBeNull();
      expect(await store.get('d')).toBe(4);
    });

    it('promotes accessed entry to MRU position', async () => {
      clock = 1000;
      store = createStore(3);
      await store.connect();
      await store.set('a', 1);
      await store.set('b', 2);
      await store.set('c', 3);
      // Access 'a' to promote it
      await store.get('a');
      // Now 'b' is oldest; inserting 'd' should evict 'b'
      await store.set('d', 4);
      expect(await store.get('a')).toBe(1);
      expect(await store.get('b')).toBeNull();
      expect(await store.get('d')).toBe(4);
    });

    it('overwrite does not trigger eviction', async () => {
      clock = 1000;
      store = createStore(2);
      await store.connect();
      await store.set('a', 1);
      await store.set('b', 2);
      // Overwrite 'a' — no new key, no eviction
      await store.set('a', 10);
      expect(await store.get('a')).toBe(10);
      expect(await store.get('b')).toBe(2);
    });
  });

  describe('has/delete/clear', () => {
    it('has returns true for existing entry', async () => {
      clock = 1000;
      store = createStore();
      await store.connect();
      await store.set('k', 'v');
      expect(await store.has('k')).toBe(true);
    });

    it('has returns false for missing entry', async () => {
      clock = 1000;
      store = createStore();
      await store.connect();
      expect(await store.has('missing')).toBe(false);
    });

    it('has returns false for expired entry', async () => {
      clock = 1000;
      store = createStore();
      await store.connect();
      await store.set('ttl', 'val', 5);
      clock = 6001;
      expect(await store.has('ttl')).toBe(false);
    });

    it('delete removes entry', async () => {
      clock = 1000;
      store = createStore();
      await store.connect();
      await store.set('k', 'v');
      expect(await store.delete('k')).toBe(true);
      expect(await store.get('k')).toBeNull();
    });

    it('delete returns false for missing entry', async () => {
      clock = 1000;
      store = createStore();
      await store.connect();
      expect(await store.delete('missing')).toBe(false);
    });

    it('clear empties all entries', async () => {
      clock = 1000;
      store = createStore();
      await store.connect();
      await store.set('a', 1);
      await store.set('b', 2);
      await store.clear();
      expect(await store.get('a')).toBeNull();
      expect(await store.get('b')).toBeNull();
    });
  });

  describe('default clock (production path)', () => {
    it('set→get round-trip with default clock (no injection)', async () => {
      // Exercises the production default-clock path — previously threw
      // "TypeError: Illegal invocation" because performance.now was detached.
      const store = new MemoryStore('');
      await store.connect();
      await store.set('prod-key', { hello: 'world' });
      const result = await store.get('prod-key');
      expect(result).toEqual({ hello: 'world' });
    });
  });
});
