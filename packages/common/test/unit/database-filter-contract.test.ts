import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { FilterExpression, RouteInfo } from '@setu-ts/common';

describe('database filter public contract', () => {
  it('exports filter expressions and keeps route ownership optional', () => {
    const filter: FilterExpression = {
      type: 'and',
      filters: [
        { type: 'comparison', field: 'name', operator: 'contains', value: 'Ada' },
        { type: 'comparison', field: 'id', operator: 'in', value: ['u1', null] },
      ],
    };
    const applicationRoute: RouteInfo = {
      method: 'GET',
      path: '/health',
      definition: { handler: () => ({ __handlerResult: true } as never) },
    };

    expect(filter.type).toBe('and');
    expect(applicationRoute.owner).toBe(undefined);
  });
});
