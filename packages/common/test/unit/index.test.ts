/**
 * Workspace smoke test: verifies the package stub resolves and the test
 * pipeline is wired up. Replaced by real tests in Milestone 1.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('@hono-enterprise/common (stub)', () => {
  it('should resolve the package entry point', async () => {
    const mod = await import('../../src/index.ts');
    expect(mod).toBeDefined();
  });
});
