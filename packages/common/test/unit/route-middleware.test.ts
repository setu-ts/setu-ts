import { describe, expect, it } from 'vitest';
import { routeMiddlewareOf } from '../../src/index.ts';
import type {
  MiddlewareFunction,
  RouteDefinition,
  RouteMiddlewareGroups,
} from '../../src/index.ts';

describe('routeMiddlewareOf', () => {
  const handler: RouteDefinition['handler'] = (ctx) => ctx.response.text('ok');
  const a: MiddlewareFunction = (_ctx, next) => next();
  const b: MiddlewareFunction = (_ctx, next) => next();
  const c: MiddlewareFunction = (_ctx, next) => next();
  const middlewareGroups: RouteMiddlewareGroups = {
    groups: { second: [b], first: [c] },
    select: () => {
      throw new Error('startup scans must not select');
    },
  };
  it('returns an empty array without middleware', () => {
    expect(routeMiddlewareOf({ handler })).toEqual([]);
  });
  it('includes static middleware only', () => {
    expect(routeMiddlewareOf({ handler, middleware: [a] })).toEqual([a]);
  });
  it('includes every declared group in key order without selecting', () => {
    expect(routeMiddlewareOf({ handler, middlewareGroups })).toEqual([b, c]);
  });
  it('puts static middleware before groups', () => {
    expect(routeMiddlewareOf({ handler, middleware: [a], middlewareGroups })).toEqual([a, b, c]);
  });
});
