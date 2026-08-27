/**
 * Compile-time contract tests for the M73 realtime-authentication additions:
 * the required `ISessionService.fromHeaders` member, the optional
 * `WebSocketConnectionContext.user` member, and the widened
 * `IWebSocketService.routeUpgrade` signature.
 *
 * These assertions are decided by `deno task check` — if a required member is
 * ever dropped or an optional one is narrowed away, this file stops compiling.
 * The `@ts-expect-error` directive is self-validating: an unused directive
 * fails the build, so a required member silently becoming optional is caught.
 * Runtime expectations are asserted alongside so the file also fails loudly
 * under `deno task test`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IRequestContext,
  ISession,
  ISessionService,
  IWebSocketService,
  WebSocketConnectionContext,
  WebSocketUpgradeDecision,
} from '../../src/index.ts';

// Compile-time: a `WebSocketConnectionContext` literal WITHOUT `user` still
// satisfies the interface — the member is optional, so existing `onOpen`
// consumers and builders are unaffected.
const contextWithoutUser: WebSocketConnectionContext = {
  url: 'ws://example.com/ws/chat?room=lobby',
  path: '/ws/chat',
  query: { room: 'lobby' },
  headers: new Headers(),
};

// Compile-time: a literal WITH `user` satisfies the interface, pinning that
// the member exists and carries the `IPrincipal` shape.
const contextWithUser: WebSocketConnectionContext = {
  url: 'ws://example.com/ws/chat',
  path: '/ws/chat',
  query: {},
  headers: new Headers(),
  user: { id: 'u-1', roles: ['admin'] },
};

// Compile-time: a single-parameter `routeUpgrade` implementation is still
// assignable to the widened signature — a lower-arity function remains
// assignable when the added parameter is optional.
type RouteUpgrade = NonNullable<IWebSocketService['routeUpgrade']>;
const singleParamRouteUpgrade: RouteUpgrade = (_request: Request): Promise<
  WebSocketUpgradeDecision | null
> => Promise.resolve(null);

// `fromHeaders` is a REQUIRED member of `ISessionService`: an implementation
// that omits it is a compile error. The directive is self-validating — if the
// member ever becomes optional, it goes unused and the build fails.
// @ts-expect-error — `fromHeaders` is missing from this `ISessionService` implementation
const missingFromHeaders: ISessionService = {
  from: (_ctx: IRequestContext): ISession => {
    throw new Error('not implemented');
  },
};

describe('WebSocketConnectionContext.user is optional (M73)', () => {
  it('a literal without `user` still satisfies the interface', () => {
    expect(contextWithoutUser.path).toBe('/ws/chat');
    expect(contextWithoutUser.query.room).toBe('lobby');
  });

  it('a literal with a principal satisfies the interface', () => {
    expect(contextWithUser.user?.id).toBe('u-1');
  });
});

describe('IWebSocketService.routeUpgrade widening (M73)', () => {
  it('a single-parameter implementation is assignable to the widened signature', async () => {
    const decision = await singleParamRouteUpgrade(new Request('http://example.com/ws/chat'));

    expect(decision).toBeNull();
  });
});

describe('ISessionService.fromHeaders is required (M73)', () => {
  it('an implementation omitting it does not compile (self-validating directive)', () => {
    expect(missingFromHeaders).toBeDefined();
  });
});
