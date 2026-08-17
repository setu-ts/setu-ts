import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryProvider } from '../../../src/providers/memory-provider.ts';

describe('MemoryProvider health (M70c)', () => {
  it('is always reachable — an in-memory store has no backend to lose', async () => {
    const provider = new MemoryProvider();
    expect(await provider.isHealthy()).toBe(true);
    await provider.connect();
    expect(await provider.isHealthy()).toBe(true);
    await provider.disconnect();
    expect(await provider.isHealthy()).toBe(true);
  });
});
