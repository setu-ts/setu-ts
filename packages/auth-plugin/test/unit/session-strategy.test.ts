/**
 * Tests for the internal SessionStrategy.
 *
 * The strategy is configured through `AuthPluginOptions.session` and is never
 * barrel-exported, so these tests import it from its module directly.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IAuthStrategy, IRequest, ISessionService, SessionView } from '@setu-ts/common';
import { SessionStrategy } from '../../src/strategies/session-strategy.ts';

/**
 * Build a minimal IRequest carrying the given headers.
 */
function makeRequest(headers: Record<string, string> = {}): IRequest {
  const h = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    h.set(key, value);
  }
  return {
    method: 'GET',
    url: 'http://localhost/',
    path: '/',
    headers: h,
    json: <T>() => Promise.resolve({} as T),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  };
}

/**
 * An ISessionService that always opens the given view and records every
 * Headers object it is handed.
 */
function makeSessionService(view: SessionView | null, calls: Headers[]): ISessionService {
  return {
    from: () => {
      throw new Error('from() is not used by the session strategy');
    },
    fromHeaders: (headers: Headers) => {
      calls.push(headers);
      return Promise.resolve(view);
    },
  };
}

describe('SessionStrategy', () => {
  it('is an IAuthStrategy named session', () => {
    const strategy: IAuthStrategy = new SessionStrategy({
      sessionService: makeSessionService(null, []),
      toPrincipal: () => null,
    });
    expect(strategy.name).toBe('session');
  });

  it('returns null when no session opens, without calling toPrincipal (the chain continues)', async () => {
    const strategy = new SessionStrategy({
      sessionService: makeSessionService(null, []),
      toPrincipal: () => {
        throw new Error('toPrincipal must not run when no session opened');
      },
    });
    const principal = await strategy.authenticate(makeRequest({ cookie: 'sid=gone' }));
    expect(principal).toBeNull();
  });

  it('returns null when toPrincipal says the session carries no identity (the chain continues)', async () => {
    const view: SessionView = { id: 's1', data: { cart: ['a'] } };
    const strategy = new SessionStrategy({
      sessionService: makeSessionService(view, []),
      toPrincipal: () => null,
    });
    const principal = await strategy.authenticate(makeRequest({ cookie: 'sid=s1' }));
    expect(principal).toBeNull();
  });

  it('maps the session through the caller toPrincipal — no convention is read', async () => {
    // The identity lives under a key no framework code knows about. A
    // convention-based reader (e.g. `view.data.user`) would see nothing here,
    // which is what makes the required callback load-bearing.
    const view: SessionView = { id: 's1', data: { operatorId: 'op-42' } };
    const seen: SessionView[] = [];
    const strategy = new SessionStrategy({
      sessionService: makeSessionService(view, []),
      toPrincipal: (v: SessionView) => {
        seen.push(v);
        const operatorId = v.data.operatorId;
        if (typeof operatorId !== 'string') {
          return null;
        }
        return { id: operatorId, roles: ['operator'] };
      },
    });
    const principal = await strategy.authenticate(makeRequest({ cookie: 'sid=s1' }));
    expect(principal).toEqual({ id: 'op-42', roles: ['operator'] });
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('s1');
  });

  it('opens the session from the request headers', async () => {
    const calls: Headers[] = [];
    const strategy = new SessionStrategy({
      sessionService: makeSessionService(null, calls),
      toPrincipal: () => null,
    });
    await strategy.authenticate(makeRequest({ cookie: 'sid=abc' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].get('cookie')).toBe('sid=abc');
  });
});
