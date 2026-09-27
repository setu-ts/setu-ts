import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { CapabilityToken, IServiceRegistry, RegisterOptions } from '@setu-ts/common';

/**
 * The optional `isCurrent` identity method (M98h) is a TYPE contract: a
 * third-party registry-shaped double that predates it must keep compiling
 * (the member is optional), and a consumer that needs a current-provider
 * check must treat an absent method as "cannot verify" rather than fall back
 * to `get`. These tests type-check the surface and run a minimal consumer.
 */
describe('IServiceRegistry.isCurrent — the optional identity contract (M98h)', () => {
  /**
   * A minimal registry-shaped double. `get`/`getAll` keep the interface's
   * generic return types so the object is genuinely assignable; `get` throws
   * (it is never used to verify identity) and `getAll` returns an empty list.
   */
  function makeRegistry(withIsCurrent: boolean): IServiceRegistry {
    const base = {
      register(_token: CapabilityToken, _service: object, _options?: RegisterOptions): void {},
      registerFactory(
        _token: CapabilityToken,
        _factory: () => object,
        _options?: RegisterOptions,
      ): void {},
      get<T extends object>(_token: CapabilityToken): T {
        throw new Error('get must never be used to verify identity');
      },
      getAll<T extends object>(_token: CapabilityToken): readonly T[] {
        return [];
      },
      has(_token: CapabilityToken): boolean {
        return false;
      },
      unregister(_token: CapabilityToken): boolean {
        return false;
      },
    };
    if (!withIsCurrent) {
      // Type-checks only when `isCurrent` is OPTIONAL on the interface.
      return base as IServiceRegistry;
    }
    return {
      ...base,
      isCurrent(token: CapabilityToken, _instance: object): boolean {
        return token === 'authorization';
      },
    };
  }

  it('a registry-shaped double WITHOUT isCurrent is still assignable', () => {
    const legacy = makeRegistry(false);
    expect(Object.hasOwn(legacy, 'isCurrent')).toBe(false);
    expect(typeof legacy.isCurrent).toBe('undefined');
  });

  it('a registry-shaped double WITH isCurrent is assignable and callable', () => {
    let calls = 0;
    const modern: IServiceRegistry = {
      ...makeRegistry(false),
      isCurrent(token: CapabilityToken, _instance: object): boolean {
        calls++;
        return token === 'authorization';
      },
    };
    expect(Object.hasOwn(modern, 'isCurrent')).toBe(true);
    expect(modern.isCurrent?.('authorization', {})).toBe(true);
    expect(modern.isCurrent?.('other', {})).toBe(false);
    expect(calls).toBe(2);
  });

  it('a consumer treats an absent isCurrent as "cannot verify", never via get', () => {
    const registry = makeRegistry(false);
    const canVerify = typeof registry.isCurrent === 'function';
    expect(canVerify).toBe(false);
    // The consumer must NOT call get to verify; it reports it cannot verify.
    const coverage = canVerify ? 'verified' : 'provider-identity-unavailable';
    expect(coverage).toBe('provider-identity-unavailable');
  });
});
