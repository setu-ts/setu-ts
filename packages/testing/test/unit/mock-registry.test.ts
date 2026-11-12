import { describe, expect, expectTypeOf, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceRegistry, IMailer } from '@setu-ts/common';
import { MockServiceRegistry } from '../../src/mock-registry.ts';

it('keeps the public overloads identical to IServiceRegistry', () => {
  expectTypeOf<MockServiceRegistry['get']>().toEqualTypeOf<IServiceRegistry['get']>();
  expectTypeOf<MockServiceRegistry['getAll']>().toEqualTypeOf<IServiceRegistry['getAll']>();
  expectTypeOf<MockServiceRegistry['register']>().toEqualTypeOf<IServiceRegistry['register']>();
  expectTypeOf<MockServiceRegistry['registerFactory']>().toEqualTypeOf<
    IServiceRegistry['registerFactory']
  >();
  const check = (registry: MockServiceRegistry): void => {
    // @ts-expect-error The logger token cannot resolve a mailer.
    registry.get<IMailer>(CAPABILITIES.LOGGER);
    // @ts-expect-error A partial double cannot register under the bound logger token.
    registry.register<object>(CAPABILITIES.LOGGER, {});
  };
  expectTypeOf(check).toBeFunction();
});

describe('MockServiceRegistry', () => {
  it('register then get returns the service', () => {
    const registry = new MockServiceRegistry();
    const svc = { foo: 'bar' };
    registry.register('token', svc);
    expect(registry.get('token')).toBe(svc);
  });

  it('has returns true after register', () => {
    const registry = new MockServiceRegistry();
    registry.register('token', {});
    expect(registry.has('token')).toBe(true);
  });

  it('get throws verbatim kernel message on miss', () => {
    const registry = new MockServiceRegistry();
    let errMsg = '';
    try {
      registry.get('missing');
    } catch (e) {
      errMsg = (e as Error).message;
    }
    expect(errMsg).toBe(
      "No service registered for capability 'missing'. Register a plugin that provides it, or check the token spelling against CAPABILITIES.",
    );
  });

  it('second register without options throws the kernel duplicate message', () => {
    const registry = new MockServiceRegistry();
    registry.register('t', { a: 1 });
    // Assert the message verbatim — it must match the kernel ServiceRegistry's,
    // or a test that pins the text would pass here and fail against the real
    // registry. A bare "something threw" check cannot catch that drift.
    let message: string | undefined;
    try {
      registry.register('t', { b: 2 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(
      "Capability 't' is already registered. Use { override: true } to replace it.",
    );
    // The original registration survives a rejected duplicate.
    expect(registry.get('t')).toEqual({ a: 1 });
  });

  it('register with override: true replaces', () => {
    const registry = new MockServiceRegistry();
    const svc1 = { version: 1 };
    const svc2 = { version: 2 };
    registry.register('t', svc1);
    registry.register('t', svc2, { override: true });
    expect(registry.get('t')).toBe(svc2);
  });

  it('register with multi: true appends', () => {
    const registry = new MockServiceRegistry();
    const svc1 = { n: 1 };
    const svc2 = { n: 2 };
    registry.register('t', svc1);
    registry.register('t', svc2, { multi: true });
    expect(registry.getAll('t')).toHaveLength(2);
  });

  it('getAll includes the single registration (matching kernel semantics)', () => {
    const registry = new MockServiceRegistry();
    const svc = { data: 'single' };
    registry.register('t', svc);
    const all = registry.getAll('t');
    expect(all).toEqual([svc]);
  });

  it('registerFactory resolves once and caches', () => {
    const registry = new MockServiceRegistry();
    let callCount = 0;
    registry.registerFactory('t', () => {
      callCount++;
      return { count: callCount };
    });
    const first = registry.get('t');
    const second = registry.get('t');
    expect(first).toBe(second);
    expect(callCount).toBe(1);
  });

  it('unregister removes and reports correctly', () => {
    const registry = new MockServiceRegistry();
    registry.register('t', { v: 1 });
    expect(registry.unregister('t')).toBe(true);
    expect(registry.has('t')).toBe(false);
    expect(registry.unregister('t')).toBe(false);
  });

  it('registrations records every call with multi flag', () => {
    const registry = new MockServiceRegistry();
    registry.register('a', {});
    registry.register('b', {}, { multi: true });
    registry.registerFactory('c', () => ({}));
    expect(registry.registrations).toEqual([
      { token: 'a', multi: false },
      { token: 'b', multi: true },
      { token: 'c', multi: false },
    ]);
  });
});
