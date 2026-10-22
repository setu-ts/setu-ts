/**
 * The project-module loader's guarded `tsx` import (M113d §3.1): with the
 * package made unresolvable, the loader rejects with
 * `OptionalDependencyUnavailableError` instead of the raw module error.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';

describe('importProjectModule — the guarded import (M113d §3.1)', () => {
  it('rejects with OptionalDependencyUnavailableError when tsx is absent', async () => {
    const { importProjectModule } = await import('../../../src/utils/ts-loader.ts');
    vi.doMock('tsx/esm/api', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await importProjectModule('file:///tmp/setu.config.ts', '/tmp');
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('tsx');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('tsx/esm/api');
    }
  });
});
