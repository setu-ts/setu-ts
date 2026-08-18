import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { StaticProvider } from '../../../src/providers/static-provider.ts';
import { createFakeRuntime } from '../../fixtures/fakes.ts';

describe('StaticProvider health (M70c)', () => {
  it('is always reachable — the map is in memory', async () => {
    const provider = new StaticProvider(
      { billing: [{ host: '10.0.0.1', port: 80 }] },
      createFakeRuntime(),
    );
    expect(await provider.isHealthy()).toBe(true);
  });
});
