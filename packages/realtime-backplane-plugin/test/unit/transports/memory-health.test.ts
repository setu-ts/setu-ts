import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryBackplane } from '../../../src/transports/memory-backplane.ts';

describe('MemoryBackplane health (M70c)', () => {
  it('is always reachable — a real single-process bus has no backend to lose', async () => {
    const backplane = new MemoryBackplane('node-a', 'health-unit-mem');
    // Even before connect, the in-process bus is reachable: there is no
    // external dependency whose outage could make it down (M47).
    expect(await backplane.isHealthy()).toBe(true);
    await backplane.connect();
    expect(await backplane.isHealthy()).toBe(true);
    await backplane.close();
    expect(await backplane.isHealthy()).toBe(true);
  });
});
