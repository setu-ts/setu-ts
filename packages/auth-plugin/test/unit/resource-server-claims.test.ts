/**
 * Claim parsing for the resource-server surface: OAuth scopes and RFC 8693
 * `act` actors.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import { isScopeToken, parseActClaim, parseScopeClaim } from '../../src/resource-server/claims.ts';

describe('parseScopeClaim', () => {
  const cases: Array<[string, Record<string, unknown>, readonly string[] | undefined]> = [
    ['absent', {}, undefined],
    ['scope string split on spaces', { scope: 'read write' }, ['read', 'write']],
    ['empty entries dropped', { scope: '  read   write  ' }, ['read', 'write']],
    ['empty string', { scope: '' }, []],
    ['duplicates removed, order kept', { scope: 'b a b' }, ['b', 'a']],
    ['scope wins over scp', { scope: 'read', scp: ['write'] }, ['read']],
    ['non-string scope refuses rather than falling back', { scope: ['read'], scp: ['write'] }, []],
    ['null scope refuses rather than falling back', { scope: null, scp: ['write'] }, []],
    ['scp string split on spaces', { scp: 'read write' }, ['read', 'write']],
    ['scp array', { scp: ['read', 'write'] }, ['read', 'write']],
    ['scp array duplicates removed', { scp: ['read', 'write', 'read'] }, ['read', 'write']],
    ['scp empty array', { scp: [] }, []],
    ['scp array with a non-string entry', { scp: ['read', 7] }, []],
    ['scp number', { scp: 7 }, []],
    ['scp object', { scp: { read: true } }, []],
    ['both absent', { sub: 'u1' }, undefined],
    ['scope number', { scope: 42 }, []],
    ['scope object', { scope: { read: true } }, []],
    ['scope boolean', { scope: false }, []],
    ['scope explicitly undefined', { scope: undefined, scp: 'read' }, []],
    ['scp null', { scp: null }, []],
    ['scp boolean', { scp: false }, []],
    ['scp explicitly undefined', { scp: undefined }, []],
  ];

  it.each(cases)('%s', (_label, claims, expected) => {
    expect(parseScopeClaim(claims)).toEqual(expected);
  });
});

describe('parseActClaim', () => {
  it('reports an absent act as no actor', () => {
    expect(parseActClaim({ sub: 'u1' })).toEqual({ ok: true, actor: undefined });
  });

  it('takes the id from sub and keeps the act members except its own act', () => {
    expect(
      parseActClaim({
        sub: 'user',
        act: { sub: 'agent', iss: 'https://as.test', act: { sub: 'prior' } },
      }),
    ).toEqual({
      ok: true,
      actor: { id: 'agent', claims: { sub: 'agent', iss: 'https://as.test' } },
    });
  });

  it('falls back to a non-empty client_id when sub is absent or empty', () => {
    expect(parseActClaim({ act: { client_id: 'agent-client' } })).toEqual({
      ok: true,
      actor: { id: 'agent-client', claims: { client_id: 'agent-client' } },
    });
    expect(parseActClaim({ act: { sub: '', client_id: 'agent-client' } })).toEqual({
      ok: true,
      actor: { id: 'agent-client', claims: { sub: '', client_id: 'agent-client' } },
    });
  });

  it('prefers a non-empty sub over client_id', () => {
    expect(parseActClaim({ act: { sub: 'agent', client_id: 'client' } })).toEqual({
      ok: true,
      actor: { id: 'agent', claims: { sub: 'agent', client_id: 'client' } },
    });
  });

  const malformed: Array<[string, unknown]> = [
    ['array', []],
    ['string', 'agent'],
    ['number', 7],
    ['null', null],
    ['empty object', {}],
    ['non-string sub', { sub: 7 }],
    ['empty sub and client_id', { sub: '', client_id: '' }],
    ['non-string client_id', { client_id: 7 }],
  ];

  it.each(malformed)('refuses a malformed act: %s', (_label, act) => {
    expect(parseActClaim({ act })).toEqual({ ok: false });
  });
});

describe('isScopeToken', () => {
  it.each(['read', 'tools:read', 'a-b_c.d~e', '!', '~'])('accepts %j', (value) => {
    expect(isScopeToken(value)).toBe(true);
  });

  it.each(['', 'a b', 'a"b', 'a\\b', 'café', 'a\nb', 'a\tb', '\u007f', 'a\u0080b'])(
    'refuses %j',
    (value) => {
      expect(isScopeToken(value)).toBe(false);
    },
  );
});
