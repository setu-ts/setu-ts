/**
 * `OptionalDependencyUnavailableError`: the one error class every guarded
 * lazy `import()` catch throws when an optional dependency is absent.
 *
 * Imported from the barrel on purpose: a re-export is covered by being
 * loaded, so only a barrel import catches a dropped export (the M56 defect
 * class).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { OptionalDependencyUnavailableError } from '../../src/index.ts';

describe('OptionalDependencyUnavailableError', () => {
  it('names the dependency in `dependency` and in the message', () => {
    const error = new OptionalDependencyUnavailableError('ioredis');

    expect(error.dependency).toBe('ioredis');
    expect(error.message).toBe(
      "Optional dependency 'ioredis' could not be loaded. Install it in the application, or choose an option that does not need it on this runtime.",
    );
  });

  it('carries `name`, `cause` identity and `instanceof Error`', () => {
    const cause = new Error('Cannot find package \'ioredis\'');
    const error = new OptionalDependencyUnavailableError('ioredis', { cause });

    expect(error.name).toBe('OptionalDependencyUnavailableError');
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });

  it('omits `cause` when none is given', () => {
    const error = new OptionalDependencyUnavailableError('mongodb');

    expect(error.cause).toBeUndefined();
    expect(error.dependency).toBe('mongodb');
  });
});
