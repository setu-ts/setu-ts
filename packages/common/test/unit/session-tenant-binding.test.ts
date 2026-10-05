/**
 * The shared tenant-binding key and pure compare helper (M101c, V8-7).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  type ISession,
  SESSION_STATE_KEY,
  SESSION_TENANT_BINDING_KEY,
  tenantBindingMismatch,
} from '../../src/index.ts';

/** A minimal `ISession` double: the helper only calls `get`. */
function fakeSession(bound: string | undefined): ISession {
  return {
    id: 's1',
    isNew: false,
    get: <T = unknown>(key: string): T | undefined =>
      (key === SESSION_TENANT_BINDING_KEY ? bound : undefined) as unknown as T | undefined,
    set: () => {},
    has: () => false,
    delete: () => false,
    clear: () => {},
    regenerate: () => {},
    destroy: () => {},
    toJSON: () => ({}),
  };
}

describe('tenantBindingMismatch (M101c, V8-7)', () => {
  it('is false for an unbound session regardless of the request tenant', () => {
    expect(tenantBindingMismatch(fakeSession(undefined), 'a')).toBe(false);
    expect(tenantBindingMismatch(fakeSession(undefined), undefined)).toBe(false);
  });

  it('is false when the request carries no tenant', () => {
    expect(tenantBindingMismatch(fakeSession('a'), undefined)).toBe(false);
  });

  it('is false when both sides agree', () => {
    expect(tenantBindingMismatch(fakeSession('a'), 'a')).toBe(false);
  });

  it('is true when both sides differ', () => {
    expect(tenantBindingMismatch(fakeSession('a'), 'b')).toBe(true);
  });

  it('ignores a non-string value under the binding key', () => {
    // A hand-rolled session that stored a non-string under the key is
    // unbound for the compare, not a crash.
    const session: ISession = {
      id: 's1',
      isNew: false,
      get: <T = unknown>(_key: string): T | undefined => 42 as unknown as T | undefined,
      set: () => {},
      has: () => false,
      delete: () => false,
      clear: () => {},
      regenerate: () => {},
      destroy: () => {},
      toJSON: () => ({}),
    };
    expect(tenantBindingMismatch(session, 'a')).toBe(false);
  });
});

describe('the shared key constants follow the state-key convention (M101c, V8-7)', () => {
  it("SESSION_STATE_KEY is the session plugin's committed state key", () => {
    // `<owner>:<kebab>` — owned by the package that WRITES the key.
    expect(SESSION_STATE_KEY).toBe('session-plugin:session');
    expect(SESSION_STATE_KEY).toMatch(/^[a-z-]+:[a-z-]+$/);
  });

  it('SESSION_TENANT_BINDING_KEY is the reserved session-payload key', () => {
    // A session PAYLOAD key, not a `ctx.state` key, so it keeps its historical
    // `__setu_` prefix rather than the `<owner>:<kebab>` shape.
    expect(SESSION_TENANT_BINDING_KEY).toBe('__setu_tenant');
  });
});
