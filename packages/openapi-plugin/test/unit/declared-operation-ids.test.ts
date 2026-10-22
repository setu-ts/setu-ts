import { describe, expect, it } from 'vitest';
import type { RouteInfo } from '@setu-ts/common';
import { OperationIdError } from '../../src/errors.ts';
import {
  claimDeclaredOperationIds,
  isRouteExcluded,
  DEFAULT_EXCLUDED_OWNERS,
} from '../../src/generators/declared-operation-ids.ts';

function route(path: string, operationId?: string, owner?: string): RouteInfo {
  return {
    method: 'GET',
    path,
    definition: {
      handler: (ctx) => ctx.response.json({}),
      ...(operationId !== undefined ? { schema: { operationId } } : {}),
    },
    ...(owner !== undefined ? { owner } : {}),
  };
}

describe('claimDeclaredOperationIds', () => {
  const included = (): boolean => false;

  it('returns only declared ids and preserves nonblank ids verbatim', () => {
    expect(
      claimDeclaredOperationIds(
        [
          route('/plain'),
          {
            method: 'POST',
            path: '/schema',
            definition: { handler: (ctx) => ctx.response.json({}), schema: {} },
          },
          route('/users', ' listUsers '),
          route('/other', 'listUsers'),
        ],
        included,
      ),
    ).toEqual(new Set([' listUsers ', 'listUsers']));
    expect(claimDeclaredOperationIds([], included)).toEqual(new Set());
  });

  it.each(['', ' ', '\n\t\r', '\u00a0'])('refuses blank id %j and names its route', (id) => {
    const claim = (): Set<string> => claimDeclaredOperationIds([route('/blank', id)], included);
    expect(claim).toThrow(OperationIdError);
    expect(claim).toThrow(expect.objectContaining({ name: 'OperationIdError', reason: 'blank' }));
    expect(claim).toThrow(JSON.stringify(id));
    expect(claim).toThrow('GET /blank');
  });

  it('refuses duplicate ids and names both routes with their methods', () => {
    const claim = (): Set<string> =>
      claimDeclaredOperationIds(
        [route('/users', 'list'), { ...route('/members', 'list'), method: 'POST' }],
        included,
      );
    expect(claim).toThrow(OperationIdError);
    expect(claim).toThrow(expect.objectContaining({ reason: 'duplicate' }));
    expect(claim).toThrow('"list"');
    expect(claim).toThrow('GET /users and POST /members');
  });

  it('ignores blank and duplicate ids excluded by path or owner', () => {
    const excludedPaths = new Set(['/hidden', '/blank']);
    const excludedOwners = new Set(['ops']);
    expect(
      claimDeclaredOperationIds(
        [
          route('/hidden', 'list'),
          route('/blank', ''),
          route('/owned', 'list', 'ops'),
          route('/owned-blank', ' ', 'ops'),
          route('/users', 'list'),
          route('/plain'),
          route('/visible', 'visible', 'app'),
        ],
        (r) => isRouteExcluded(r, excludedPaths, excludedOwners),
      ),
    ).toEqual(new Set(['list', 'visible']));
  });

  it('shares the default operational owner exclusions and permits an explicit empty set', () => {
    for (const owner of DEFAULT_EXCLUDED_OWNERS) {
      const r = route('/custom-operational-path', '', owner);
      expect(isRouteExcluded(r, new Set(), new Set(DEFAULT_EXCLUDED_OWNERS))).toBe(true);
      expect(isRouteExcluded(r, new Set(), new Set())).toBe(false);
    }
  });
});
