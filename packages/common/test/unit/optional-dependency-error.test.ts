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
      "Optional dependency 'ioredis' could not be loaded. Install it where 'the package that loads it' is installed, in the version range that package declares for it — in an npm, Yarn or Bun workspace that is usually the workspace root, not the member — or choose an option that does not need it on this runtime.",
    );
  });

  it('names the loading package only in the message and preserves the cause', () => {
    const cause = new Error('missing peer');
    const error = new OptionalDependencyUnavailableError('ioredis', {
      cause,
      requiredBy: '@setu-ts/cache-plugin',
    });

    expect(error.message).toBe(
      "Optional dependency 'ioredis' could not be loaded by '@setu-ts/cache-plugin'. Install it where '@setu-ts/cache-plugin' is installed, in the version range that package declares for it — in an npm, Yarn or Bun workspace that is usually the workspace root, not the member — or choose an option that does not need it on this runtime.",
    );
    expect(error.dependency).toBe('ioredis');
    expect(error.name).toBe('OptionalDependencyUnavailableError');
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
    expect(Object.hasOwn(error, 'requiredBy')).toBe(false);
  });

  it('omits cause with a named loader and no rejection', () => {
    const error = new OptionalDependencyUnavailableError('ioredis', {
      requiredBy: '@setu-ts/cache-plugin',
    });
    expect(Object.hasOwn(error, 'cause')).toBe(false);
    expect(Object.hasOwn(error, 'requiredBy')).toBe(false);
  });

  it('carries `name`, `cause` identity and `instanceof Error`', () => {
    const cause = new Error("Cannot find package 'ioredis'");
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
