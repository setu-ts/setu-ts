import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { LogProvider } from '../../../src/providers/log-provider.ts';

describe('LogProvider health (M70c)', () => {
  it('is always reachable — it never touches a network', async () => {
    const provider = new LogProvider();
    expect(await provider.isHealthy()).toBe(true);
    await provider.connect();
    expect(await provider.isHealthy()).toBe(true);
    await provider.disconnect();
    expect(await provider.isHealthy()).toBe(true);
  });
});
