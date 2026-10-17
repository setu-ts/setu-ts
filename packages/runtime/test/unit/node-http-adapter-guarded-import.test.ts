/**
 * The Node serve host's guarded `@hono/node-server` import (M113d §3.1):
 * with the package made unresolvable, `listen()` rejects with
 * `OptionalDependencyUnavailableError` instead of the raw module error.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import { NodeHttpAdapter } from '../../src/adapters/node/node-http-adapter.ts';

describe('defaultNodeServeHost — the guarded import (M113d §3.1)', () => {
  it('listen rejects with OptionalDependencyUnavailableError when the package is absent', async () => {
    vi.doMock('@hono/node-server', () => {
      throw new Error('Cannot find package');
    });
    try {
      const adapter = new NodeHttpAdapter();
      let caught: unknown;
      try {
        await adapter.listen(0);
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@hono/node-server');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@hono/node-server');
    }
  });
});
