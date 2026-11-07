import { it, expect } from 'vitest';
import type { IRequestContext, IPrincipal } from '@setu-ts/common';
import { REQUIRED_SCOPES_STATE_KEY } from '@setu-ts/common';
import { createTestContext } from '@setu-ts/testing';
import { accessGate, isVisible } from '../../src/serve/visibility.ts';
import { tool } from '../fixtures.ts';
const publicTool = tool();
const authTool = { ...publicTool, authenticated: true };
const scoped = { ...authTool, requiredScopes: ['read'] };
const principal: IPrincipal = { id: 'one', roles: [], scopes: ['read'] };
it.each([
  [undefined, publicTool, true],
  [undefined, authTool, false],
  [undefined, scoped, false],
  [principal, publicTool, true],
  [principal, authTool, true],
  [principal, scoped, true],
  [{ ...principal, scopes: [] }, scoped, false],
  // A raw claim string is not a scope list: no substring match ('xreadx' ⊅ 'read').
  [{ ...principal, scopes: 'xreadx' as unknown as readonly string[] }, scoped, false],
] as const)('visibility table %j', (user, entry, expected) => {
  expect(isVisible(entry, user)).toBe(expected);
});
function ctx(user?: IPrincipal): IRequestContext {
  return createTestContext({ request: user === undefined ? {} : { user } });
}
it.each([
  null,
  [],
  [{ method: 'tools/call', params: { name: 'read' } }],
  {},
  { method: 'tools/list' },
  { method: 'tools/call' },
  { method: 'tools/call', params: { name: 1 } },
  { method: 'tools/call', params: { name: 'unknown' } },
])('passes non-single-call and unknown %j', (body) => {
  expect(accessGate(body, [scoped], ctx())).toBe(false);
});
it('answers hidden calls 401/403 and records the scopes for the existing challenge writer', () => {
  const body = { method: 'tools/call', params: { name: 'read' } };
  const anon = ctx();
  expect(accessGate(body, [scoped], anon)).toBe(true);
  expect(anon.response.snapshot().status).toBe(401);
  const missing = ctx({ ...principal, scopes: [] });
  expect(accessGate(body, [scoped], missing)).toBe(true);
  expect(missing.response.snapshot().status).toBe(403);
  expect(missing.state.get(REQUIRED_SCOPES_STATE_KEY)).toEqual(['read']);
  expect(accessGate(body, [scoped], ctx(principal))).toBe(false);
});
