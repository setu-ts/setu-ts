import { describe, expect, it, vi } from 'vitest';
import type { IRequestContext } from '@setu-ts/common';
import { createPageRouteSelector } from '../../src/policies/page-route-matcher.ts';
import type { PageRouteSource } from '../../src/interfaces/index.ts';

function request(path: string): IRequestContext {
  return { request: { method: 'GET', url: `http://local${path}` } } as IRequestContext;
}
function selector(
  build: () => unknown,
  matchRoutes: PageRouteSource['matchRoutes'],
  ids: readonly string[] = ['page'],
): ReturnType<typeof createPageRouteSelector> {
  return createPageRouteSelector(
    { build, matchRoutes },
    new Map<string, 'all'>(ids.map((id) => [id, 'all'])),
    build(),
  );
}

describe('page route selector matching', () => {
  // Keep the reduced layout tree (four routes) below half the full tree.
  const unguardedRoutes = Object.fromEntries(
    Array.from(
      { length: 4 },
      (_, index) =>
        [`pad${index}`, { id: `pad${index}`, parentId: 'root', path: `pad-${index}` }] as const,
    ),
  );
  const routes = {
    root: { id: 'root', path: '' },
    layout: { id: 'layout', parentId: 'root', path: 'app', caseSensitive: true },
    index: { id: 'index', parentId: 'layout', index: true, path: 'settings', caseSensitive: true },
    page: { id: 'page', parentId: 'layout', path: ':id' },
    sibling: { id: 'sibling', parentId: 'root', path: 'elsewhere' },
    ...unguardedRoutes,
    absent: undefined,
  };
  const splatRoutes = {
    root: { id: 'root', path: '' },
    page: { id: 'page', parentId: 'root', path: '*' },
    sibling: { id: 'sibling', parentId: 'root', path: 'elsewhere' },
    ...unguardedRoutes,
  };
  it('groups both trees, preserves case sensitivity and index paths, and caches per build', async () => {
    const matcher = vi.fn<PageRouteSource['matchRoutes']>(() => [
      { route: { id: 'root' } },
      { route: { id: 'layout' } },
      { route: { id: 'page' } },
    ]);
    let build = { routes, basename: '/shop/' };
    const select = selector(() => build, matcher, ['root', 'layout', 'page']);
    expect(await select(request('/shop/app/one'))).toEqual(['root', 'layout', 'page']);
    expect(matcher).toHaveBeenCalledTimes(2);
    const reduced = matcher.mock.calls[0]![0];
    const full = matcher.mock.calls[1]![0];
    const expected = [
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
    ];
    expect(reduced).toEqual(expected);
    expect(full).toEqual([
      {
        ...expected[0],
        children: [
          ...expected[0]!.children,
          { id: 'sibling', path: 'elsewhere', children: [] },
          ...Object.values(unguardedRoutes).map(({ id, path }) => ({ id, path, children: [] })),
        ],
      },
    ]);
    expect(await select(request('/shop/app/two'))).toEqual(['root', 'layout', 'page']);
    expect(matcher).toHaveBeenCalledTimes(4);
    expect(matcher.mock.calls[2]![0]).toBe(reduced);
    expect(matcher.mock.calls[3]![0]).toBe(full);
    build = { ...build };
    expect(await select(request('/shop/app/three'))).toEqual(['root', 'layout', 'page']);
    expect(matcher).toHaveBeenCalledTimes(6);
    expect(matcher.mock.calls[4]![0]).not.toBe(reduced);
    expect(matcher.mock.calls[5]![0]).not.toBe(full);
    expect(matcher).toHaveBeenLastCalledWith(expect.any(Array), '/shop/app/three', '/shop/');
  });

  it.each([
    ['/login.data', '/login'],
    ['/login/_.data', '/login/'],
    ['/_.data', '/'],
    ['/login.data.data', '/login.data'],
    ['/login%2Edata', '/login%2Edata'],
    ['/login/', '/login/'],
  ])('normalizes %s to %s before both matches', async (input, output) => {
    const matcher = vi.fn<PageRouteSource['matchRoutes']>(() => [
      { route: { id: 'root' } },
      { route: { id: 'page' } },
    ]);
    const select = selector(() => ({ routes: splatRoutes }), matcher);
    expect(await select(request(input))).toEqual(['page']);
    expect(matcher).toHaveBeenCalledTimes(2);
    expect(matcher).toHaveBeenNthCalledWith(1, expect.any(Array), output, undefined);
    expect(matcher).toHaveBeenNthCalledWith(2, expect.any(Array), output, undefined);
  });

  it('returns no selection when the matcher finds no route', async () => {
    const matcher = vi.fn<PageRouteSource['matchRoutes']>(() => null);
    const select = selector(() => ({ routes }), matcher);
    expect(await select(request('/missing'))).toEqual([]);
    expect(matcher).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, 42])('rejects a matched route with non-string id %j', async (id) => {
    const matches = [{ route: id === undefined ? {} : { id } }] as unknown as NonNullable<
      ReturnType<PageRouteSource['matchRoutes']>
    >;
    const select = selector(
      () => ({ routes }),
      () => matches,
    );
    await expect(select(request('/app/one'))).rejects.toThrow(
      'page route match must have a string route id',
    );
  });

  it.each([undefined, null, 42])(
    'rejects a full match with non-string id %j after a valid prefilter',
    async (id) => {
      const matches = [{ route: id === undefined ? {} : { id } }] as unknown as NonNullable<
        ReturnType<PageRouteSource['matchRoutes']>
      >;
      const matcher = vi
        .fn<PageRouteSource['matchRoutes']>()
        .mockReturnValueOnce([
          { route: { id: 'root' } },
          { route: { id: 'layout' } },
          { route: { id: 'page' } },
        ])
        .mockReturnValue(matches);
      const select = selector(() => ({ routes }), matcher);
      await expect(select(request('/app/one'))).rejects.toThrow(
        'page route match must have a string route id',
      );
      expect(matcher).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['/', undefined, '/__manifest'],
    ['/shop/', undefined, '/shop/__manifest'],
    ['/shop', '/custom', '/shop/custom'],
    ['/', '', '/__manifest'],
  ])(
    'skips the lazy manifest with basename %s and path %s',
    async (basename, manifestPath, pathname) => {
      const matcher = vi.fn<PageRouteSource['matchRoutes']>(() => null);
      const discovery = { mode: 'lazy', ...(manifestPath === undefined ? {} : { manifestPath }) };
      let build = { routes, basename, routeDiscovery: discovery };
      const select = selector(() => build, matcher);
      expect(await select(request(pathname))).toEqual([]);
      expect(matcher).not.toHaveBeenCalled();
      build = { ...build, routeDiscovery: { ...discovery, mode: 'initial' } };
      expect(await select(request(pathname))).toEqual([]);
      expect(matcher).toHaveBeenCalledOnce();
    },
  );

  it('defaults the lazy manifest basename and preserves pathless non-index nodes', async () => {
    const matcher = vi.fn<PageRouteSource['matchRoutes']>(() => null);
    let build: unknown = { routes, routeDiscovery: { mode: 'lazy' } };
    const select = selector(() => build, matcher);
    expect(await select(request('/__manifest'))).toEqual([]);
    expect(matcher).not.toHaveBeenCalled();
    build = { routes: { root: { id: 'root' }, page: { id: 'page', parentId: 'root' } } };
    expect(await select(request('/'))).toEqual([]);
    expect(matcher).toHaveBeenCalledWith(
      [{ id: 'root', children: [{ id: 'page', children: [] }] }],
      '/',
      undefined,
    );
  });

  it('preserves an as-is manifest without a basename and joins it when a basename exists', async () => {
    const matcher = vi.fn<PageRouteSource['matchRoutes']>(() => [
      { route: { id: 'root' } },
      { route: { id: 'page' } },
    ]);
    const initial = {
      routes: splatRoutes,
      routeDiscovery: { mode: 'lazy', manifestPath: 'manifest' },
    };
    let build: unknown = initial;
    const select = selector(() => build, matcher);
    expect(await select(request('/manifest'))).toEqual(['page']);
    expect(matcher).toHaveBeenCalledTimes(2);
    build = { ...initial, routeDiscovery: { mode: 'lazy', manifestPath: '/manifest' } };
    expect(await select(request('/manifest'))).toEqual([]);
    expect(matcher).toHaveBeenCalledTimes(2);
    build = { ...initial, basename: '/' };
    expect(await select(request('/manifest'))).toEqual([]);
    expect(matcher).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { routes: null }, { routes: { bad: null } }, { routes: { bad: { id: 1 } } }])(
    'rejects an invalid initial build boundary %j',
    (build) => {
      expect(() =>
        selector(
          () => build,
          () => null,
        ),
      ).toThrow('page policies require');
    },
  );
});
