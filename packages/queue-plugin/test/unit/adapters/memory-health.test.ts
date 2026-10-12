import { describe, expect, it } from 'vitest';
import { MemoryQueue } from '../../../src/adapters/memory-queue.ts';

describe('MemoryQueue health (M70c)', () => {
  it('is always reachable — an in-process store has no backend to lose', async () => {
    const queue = new MemoryQueue();
    expect(await queue.isHealthy()).toBe(true);
    await queue.connect();
    expect(await queue.isHealthy()).toBe(true);
    await queue.disconnect();
    expect(await queue.isHealthy()).toBe(true);
  });
});
