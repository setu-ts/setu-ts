/**
 * Tests for {@linkcode MemoryProvider}.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryProvider } from '../../src/providers/memory-provider.ts';

describe('MemoryProvider', () => {
  it('connects without error', async () => {
    const provider = new MemoryProvider();
    await provider.connect();
    expect(provider.isReady()).toBe(true);
  });

  it('disconnects without error', async () => {
    const provider = new MemoryProvider();
    await provider.connect();
    await provider.disconnect();
  });

  it('put → get read-back round-trip', async () => {
    const provider = new MemoryProvider();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await provider.put('test-key', data);
    const result = await provider.get('test-key');
    expect(result).toEqual(data);
  });

  it('delete returns true when key exists', async () => {
    const provider = new MemoryProvider();
    await provider.put('key', new Uint8Array([1]));
    const deleted = await provider.delete('key');
    expect(deleted).toBe(true);
  });

  it('delete returns false when key does not exist', async () => {
    const provider = new MemoryProvider();
    const deleted = await provider.delete('nonexistent');
    expect(deleted).toBe(false);
  });

  it('exists returns true for present key', async () => {
    const provider = new MemoryProvider();
    await provider.put('key', new Uint8Array([1]));
    expect(await provider.exists('key')).toBe(true);
  });

  it('exists returns false for absent key', async () => {
    const provider = new MemoryProvider();
    expect(await provider.exists('absent')).toBe(false);
  });

  it('get returns null for absent key', async () => {
    const provider = new MemoryProvider();
    const result = await provider.get('absent');
    expect(result).toBeNull();
  });

  it('getSignedUrl returns memory:// URL with expires', async () => {
    const provider = new MemoryProvider();
    const url = await provider.getSignedUrl('hello/world.txt', { expiresIn: 3600 });
    expect(url).toMatch(/^memory:\/\/.*\?expires=\d+$/);
  });

  it('getSignedUrl computes expiry from the injected clock (runtime.now), not Date.now', async () => {
    // Fixed epoch-ms clock → expiry is epoch-seconds + expiresIn, deterministic.
    const provider = new MemoryProvider(() => 1_700_000_000_000);
    const url = await provider.getSignedUrl('a.txt', { expiresIn: 3600 });
    expect(url).toBe('memory://a.txt?expires=1700003600');
  });

  it('not-connected put/get still works (no connection gating)', async () => {
    // MemoryProvider doesn't gate on connected state.
    const provider = new MemoryProvider();
    await provider.put('k', new Uint8Array([99]));
    expect(await provider.get('k')).toEqual(new Uint8Array([99]));
  });
});
