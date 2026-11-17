import { describe, expect, it, vi } from 'vitest';
import { createPageRouteMatcher, pageBuildOf } from '../../src/policies/page-route-matcher.ts';
import type { PageRouteSource } from '../../src/interfaces/index.ts';

describe('page route matcher', () => {
  const routes = {
    root: { id: 'root', path: '' },
    layout: { id: 'layout', parentId: 'root', path: 'app', caseSensitive: true },
    index: { id: 'index', parentId: 'layout', index: true, path: 'settings', caseSensitive: true },
    page: { id: 'page', parentId: 'layout', path: ':id' },
    absent: undefined,
  };
  it('groups a nested tree, preserves case sensitivity and index, and caches per build', () => {
    const matcher = vi.fn<PageRouteSource['matchRoutes']>(() => [
      { route: { id: 'root' } },
      { route: { id: 'page' } },
    ]);
    const match = createPageRouteMatcher(matcher);
    const build = { routes, basename: '/shop/' };
    expect(match(build, '/shop/app/one')).toEqual(['root', 'page']);
    const tree = matcher.mock.calls[0]![0];
    expect(tree).toEqual([
      {
        id: 'root',
        path: '',
        children: [
          {
            id: 'layout',
            path: 'app',
            caseSensitive: true,
            children: [
              { id: 'index', path: 'settings', index: true },
              { id: 'page', path: ':id', children: [] },
            ],
          },
        ],
      },
    ]);
    match(build, '/shop/app/two');
    expect(matcher.mock.calls[1]![0]).toBe(tree);
    match({ ...build }, '/shop/app/three');
    expect(matcher.mock.calls[2]![0]).not.toBe(tree);
    expect(matcher).toHaveBeenLastCalledWith(expect.any(Array), '/shop/app/three', '/shop/');
  });

  it.each([
    ['/login.data', '/login'],
    ['/login/_.data', '/login/'],
    ['/_.data', '/'],
    ['/login.data.data', '/login.data'],
    ['/login%2Edata', '/login%2Edata'],
    ['/login/', '/login/'],
  ])('normalizes %s to %s', (input, output) => {
    const matcher = vi.fn(() => null);
    expect(createPageRouteMatcher(matcher)({ routes }, input)).toEqual([]);
    expect(matcher).toHaveBeenCalledWith(expect.any(Array), output, undefined);
  });

  it.each([undefined, null, 42])('rejects a matched route with non-string id %j', (id) => {
    const matches = [{ route: id === undefined ? {} : { id } }] as unknown as NonNullable<
      ReturnType<PageRouteSource['matchRoutes']>
    >;
    const match = createPageRouteMatcher(() => matches);
    expect(() => match({ routes }, '/app')).toThrow('page route match must have a string route id');
  });

  it.each([
    ['/', undefined, '/__manifest'],
    ['/shop/', undefined, '/shop/__manifest'],
    ['/shop', '/custom', '/shop/custom'],
    ['/', '', '/__manifest'],
  ])('skips the lazy manifest with basename %s and path %s', (basename, manifestPath, pathname) => {
    const matcher = vi.fn(() => null);
    const match = createPageRouteMatcher(matcher);
    const discovery = { mode: 'lazy', ...(manifestPath === undefined ? {} : { manifestPath }) };
    expect(match({ routes, basename, routeDiscovery: discovery }, pathname)).toEqual([]);
    expect(matcher).not.toHaveBeenCalled();
    match({ routes, basename, routeDiscovery: { ...discovery, mode: 'initial' } }, pathname);
    expect(matcher).toHaveBeenCalledOnce();
  });

  it('defaults the lazy manifest basename and permits pathless non-index routes', () => {
    const matcher = vi.fn(() => null);
    const match = createPageRouteMatcher(matcher);
    match({ routes, routeDiscovery: { mode: 'lazy' } }, '/__manifest');
    expect(matcher).not.toHaveBeenCalled();
    match({ routes: { root: { id: 'root' } } }, '/');
    expect(matcher).toHaveBeenCalledWith([{ id: 'root', children: [] }], '/', undefined);
  });

  it.each([null, {}, { routes: null }, { routes: { bad: null } }, { routes: { bad: { id: 1 } } }])(
    'rejects an invalid build boundary %j',
    (build) => {
      expect(() => pageBuildOf(build)).toThrow('page policies require');
    },
  );
});
