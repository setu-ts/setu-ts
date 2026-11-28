import { describe, expect, it } from 'vitest';
import { errorLabel } from '../../src/log/error-label.ts';

describe('errorLabel', () => {
  it('names an error by its string name and anything else by its type', () => {
    class QuotaExceededError extends Error {
      override name = 'QuotaExceededError';
    }
    expect(errorLabel(new QuotaExceededError('secret'))).toBe('QuotaExceededError');
    expect(errorLabel('secret string')).toBe('string');
    expect(errorLabel(undefined)).toBe('undefined');
    expect(errorLabel(Object.assign(new Error('x'), { name: { leaked: 'secret' } }))).toBe(
      'object',
    );
  });

  it('reads name once, so a stateful getter cannot pass a check and log a different value', () => {
    let reads = 0;
    const error = new Error('x');
    Object.defineProperty(error, 'name', {
      get: () => (++reads === 1 ? 'Error' : { leaked: 'secret' }),
    });
    expect(errorLabel(error)).toBe('Error');
    expect(reads).toBe(1);
  });

  it('labels an error whose name getter throws without throwing', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'name', {
      get: () => {
        throw new Error('boom');
      },
    });
    expect(errorLabel(error)).toBe('object');
  });
});

describe('errorLabel with a hostile Proxy', () => {
  it('labels a revoked Proxy and a throwing getPrototypeOf trap without throwing', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(errorLabel(proxy)).toBe('object');
    const trap = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('boom');
        },
      },
    );
    expect(errorLabel(trap)).toBe('object');
  });
});
