/**
 * Compile-time contract tests for route-scoped WebSocket upgrade guards.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPrincipal } from '../../src/services/auth.ts';
import type {
  IWebSocketService,
  WebSocketConnectionContext,
  WebSocketGuardDecision,
  WebSocketRouteOptions,
  WebSocketUpgradeDecision,
  WebSocketUpgradeGuard,
} from '../../src/services/websocket.ts';

/** Strict identity check for compile-time contract assertions. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
  : false;

type ExpectedRouteUpgrade = (
  request: Request,
  principal?: IPrincipal,
) => Promise<WebSocketUpgradeDecision | null>;

const routeUpgradeSignaturePinned: Equals<
  NonNullable<IWebSocketService['routeUpgrade']>,
  ExpectedRouteUpgrade
> = true;

const existingRouteOptions: WebSocketRouteOptions = {
  protocols: ['chat'],
  heartbeat: false,
};

const guard: WebSocketUpgradeGuard = (
  context: WebSocketConnectionContext,
): WebSocketGuardDecision => context.user === undefined ? { status: 401 } : true;

describe('WebSocket upgrade-guard contracts', () => {
  it('accepts true as an upgrade decision', () => {
    const decision: WebSocketGuardDecision = true;

    expect(decision).toBe(true);
  });

  it('accepts a refusal object as an upgrade decision', () => {
    const decision: WebSocketGuardDecision = { status: 403 };

    expect(decision).toEqual({ status: 403 });
  });

  it('rejects a bare number as an upgrade decision', () => {
    // The `@ts-expect-error` is the assertion: an UNUSED directive is itself a
    // compile error, so this fails if the union ever widens to admit a number.
    // @ts-expect-error — a guard must return true or a refusal object, never a bare status.
    const invalidDecision: WebSocketGuardDecision = 401;

    expect(invalidDecision).toBe(401);
  });

  it('keeps guards optional for existing route options', () => {
    const guardedRouteOptions: WebSocketRouteOptions = { guards: [guard] };

    expect(existingRouteOptions.protocols).toEqual(['chat']);
    expect(existingRouteOptions.heartbeat).toBe(false);
    expect(guardedRouteOptions.guards).toEqual([guard]);
  });

  it('preserves the routeUpgrade signature', () => {
    expect(routeUpgradeSignaturePinned).toBe(true);
  });
});
