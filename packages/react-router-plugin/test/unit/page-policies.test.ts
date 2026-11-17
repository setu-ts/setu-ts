import { describe, expect, it, vi } from 'vitest';
import { matchRoutes } from 'react-router';
import type { HttpMethod, IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import type { PagePolicy, PageRouteSource, SsrRuntime } from '../../src/interfaces/index.ts';
import { createPagePolicies } from '../../src/policies/page-policies.ts';
import { createFakeLoadContextFactory } from '../fixtures/fake-handler.ts';

const middleware: MiddlewareFunction = (_ctx, next) => next();
const build = {
  routes: {
    root: { id: 'root', path: '' },
    layout: { id: 'layout', parentId: 'root', path: 'app' },
    page: { id: 'page', parentId: 'layout', path: ':id' },
    sibling: { id: 'sibling', parentId: 'root', path: 'other' },
  },
};
const runtime: SsrRuntime = {
  handler: () => Promise.resolve(new Response('page')),
  createLoadContext: createFakeLoadContextFactory(),
  pageRoutes: { build: () => build, matchRoutes },
};
function context(method: HttpMethod = 'POST', path = '/app/item'): IRequestContext {
  return { request: { method, url: `http://local${path}` } } as IRequestContext;
}
async function counted(policies: Readonly<Record<string, PagePolicy>>) {
  const matcher = vi.fn(matchRoutes);
  const load = vi.fn(() => build);
  const groups = (await createPagePolicies(policies, {
    ...runtime,
    pageRoutes: { build: load, matchRoutes: matcher },
  }))!;
  load.mockClear();
  matcher.mockClear();
  return { groups, matcher, load };
}

describe('page policies', () => {
  it('accepts the real React Router matcher without a cast', () => {
    const source: PageRouteSource = { build: () => build, matchRoutes };
    expect(source.matchRoutes).toBe(matchRoutes);
  });
  it('omitted or empty policies install nothing and do not require a source', async () => {
    const withoutSource = {
      handler: runtime.handler,
      createLoadContext: runtime.createLoadContext,
    };
    expect(await createPagePolicies(undefined, withoutSource)).toBeUndefined();
    expect(await createPagePolicies({}, withoutSource)).toBeUndefined();
  });
  it('reports unknown ids, empty arrays, non-functions and invalid on values together', async () => {
    const policies = {
      typo: { middleware: [], on: 'loader' },
      other: { middleware: [42] },
      constructor: { middleware: [middleware] },
    } as unknown as Record<string, PagePolicy>;
    let thrown: unknown;
    try {
      await createPagePolicies(policies, runtime);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('PagePolicyConfigurationError');
    for (const problem of [
      "unknown route id 'typo'",
      "unknown route id 'other'",
      "unknown route id 'constructor'",
      'known ids: root, layout, page, sibling',
      "'typo' has empty middleware",
      "'typo' has invalid on value",
      "'other' has non-function middleware",
    ]) {
      expect((thrown as Error).message).toContain(problem);
    }
  });
  it.each(['loader', '', null, 42, [], {}])('refuses invalid on %j', async (on) => {
    await expect(
      createPagePolicies(
        { page: { middleware: [middleware], on } } as unknown as Record<string, PagePolicy>,
        runtime,
      ),
    ).rejects.toThrow("'page' has invalid on value");
  });
  it('collects missing source and policy errors with development guidance', async () => {
    await expect(
      createPagePolicies(
        { page: { middleware: [], on: 'bad' } } as unknown as Record<string, PagePolicy>,
        {
          handler: runtime.handler,
          createLoadContext: runtime.createLoadContext,
        },
      ),
    ).rejects.toThrow(
      "pageRoutes; see docs/react-router-dev.md; 'page' has empty middleware; 'page' has invalid on value",
    );
  });
  it('limits known ids in a refusal to ten', async () => {
    await expect(
      createPagePolicies(
        { typo: { middleware: [middleware] } },
        {
          ...runtime,
          pageRoutes: {
            matchRoutes,
            build: () => ({
              routes: Object.fromEntries(
                Array.from({ length: 12 }, (_, index) => [`r${index}`, { id: `r${index}` }]),
              ),
            }),
          },
        },
      ),
    ).rejects.toThrow('known ids: r0, r1, r2, r3, r4, r5, r6, r7, r8, r9)');
  });
  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)(
    'selects action policies for every mutation and all policies for %s',
    async (method) => {
      const groups = (await createPagePolicies(
        {
          page: { middleware: [middleware], on: 'action' },
          layout: { middleware: [middleware], on: 'all' },
          root: { middleware: [middleware] },
        },
        runtime,
      ))!;
      expect(await groups.select(context(method))).toEqual(
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
          ? ['root', 'layout', 'page']
          : ['root', 'layout'],
      );
    },
  );
  it('the method exit reads neither the URL, build nor matcher', async () => {
    const { groups, matcher, load } = await counted({
      page: { middleware: [middleware], on: 'action' },
    });
    for (const method of ['GET', 'HEAD', 'OPTIONS'] as const) {
      const ctx = {
        request: {
          method,
          get url(): string {
            throw new Error('URL parsed');
          },
        },
      } as IRequestContext;
      expect(await groups.select(ctx)).toEqual([]);
    }
    expect(load).not.toHaveBeenCalled();
    expect(matcher).not.toHaveBeenCalled();
  });
  it('a root-only applicable policy skips matching, including unmatched paths', async () => {
    const { groups, matcher, load } = await counted({
      root: { middleware: [middleware] },
      page: { middleware: [middleware], on: 'action' },
    });
    expect(await groups.select(context('GET', '/unmatched/deep'))).toEqual(['root']);
    expect(load).toHaveBeenCalledOnce();
    expect(matcher).not.toHaveBeenCalled();
  });
  it('a prefilter miss never calls the full matcher', async () => {
    const matcher = vi.fn<PageRouteSource['matchRoutes']>(() => null);
    const groups = (await createPagePolicies(
      { page: { middleware: [middleware] } },
      {
        ...runtime,
        pageRoutes: { build: () => build, matchRoutes: matcher },
      },
    ))!;
    expect(await groups.select(context('POST', '/other'))).toEqual([]);
    expect(matcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(matcher.mock.calls[0]![0])).not.toContain('sibling');
  });
  it('uses the full ranking after a reduced splat hit and caches an empty answer', async () => {
    const matcher = vi.fn(matchRoutes);
    const sourceBuild = {
      routes: {
        root: { id: 'root', path: '' },
        wildcard: { id: 'wildcard', parentId: 'root', path: 'files/*' },
        static: { id: 'static', parentId: 'root', path: 'files/readme' },
      },
    };
    const groups = (await createPagePolicies(
      { wildcard: { middleware: [middleware] } },
      {
        ...runtime,
        pageRoutes: { build: () => sourceBuild, matchRoutes: matcher },
      },
    ))!;
    expect(await groups.select(context('GET', '/files/readme'))).toEqual([]);
    expect(matcher).toHaveBeenCalledTimes(2);
    expect(await groups.select(context('HEAD', '/files/readme.data?index'))).toEqual([]);
    expect(matcher).toHaveBeenCalledTimes(2);
  });
  it('retains every descendant when a child policy is declared before its layout', async () => {
    const sourceBuild = {
      routes: { ...build.routes, another: { id: 'another', parentId: 'layout', path: 'fixed' } },
    };
    const groups = (await createPagePolicies(
      { page: { middleware: [middleware] }, layout: { middleware: [middleware] } },
      {
        ...runtime,
        pageRoutes: { build: () => sourceBuild, matchRoutes },
      },
    ))!;
    expect(await groups.select(context('POST', '/app/fixed'))).toEqual(['layout']);
  });
  it('caches normalized paths and separates method classes', async () => {
    const { groups, matcher } = await counted({ page: { middleware: [middleware] } });
    expect(await groups.select(context('GET'))).toEqual(['page']);
    expect(matcher).toHaveBeenCalledTimes(2);
    expect(await groups.select(context('HEAD', '/app/item.data?index'))).toEqual(['page']);
    expect(matcher).toHaveBeenCalledTimes(2);
    expect(await groups.select(context('POST'))).toEqual(['page']);
    expect(matcher).toHaveBeenCalledTimes(4);
    expect(await groups.select(context('PUT'))).toEqual(['page']);
    expect(matcher).toHaveBeenCalledTimes(4);
  });
  it('evicts the least recently used entry at 1,000 and promotes hits', async () => {
    const { groups, matcher } = await counted({ page: { middleware: [middleware] } });
    for (let index = 0; index < 1_000; index++)
      await groups.select(context('POST', `/app/${index}`));
    expect(matcher).toHaveBeenCalledTimes(2_000);
    await groups.select(context('POST', '/app/0'));
    await groups.select(context('POST', '/app/1000'));
    expect(matcher).toHaveBeenCalledTimes(2_002);
    await groups.select(context('POST', '/app/0'));
    expect(matcher).toHaveBeenCalledTimes(2_002);
    await groups.select(context('POST', '/app/1'));
    expect(matcher).toHaveBeenCalledTimes(2_004);
  });
  it('retains only the final 1,000 of 10,000 distinct paths', async () => {
    const { groups, matcher } = await counted({ page: { middleware: [middleware] } });
    for (let index = 0; index < 10_000; index++)
      await groups.select(context('POST', `/app/${index}`));
    expect(matcher).toHaveBeenCalledTimes(20_000);
    for (let index = 9_000; index < 10_000; index++)
      await groups.select(context('POST', `/app/${index}`));
    expect(matcher).toHaveBeenCalledTimes(20_000);
    await groups.select(context('POST', '/app/8999'));
    expect(matcher).toHaveBeenCalledTimes(20_002);
  });
  it.each([512, 513])(
    'only caches a normalized pathname of %i UTF-8 bytes when within the bound',
    async (bytes) => {
      const { groups, matcher } = await counted({ page: { middleware: [middleware] } });
      const path = `/app/${'x'.repeat(bytes - 5)}`;
      expect(new TextEncoder().encode(new URL(`http://local${path}`).pathname).byteLength).toBe(
        bytes,
      );
      await groups.select(context('POST', path));
      await groups.select(context('POST', path));
      expect(matcher).toHaveBeenCalledTimes(bytes === 512 ? 2 : 4);
    },
  );
  it.each(['constructor', '__proto__', 'toString'])(
    'handles route ids and cache paths named %s',
    async (id) => {
      const sourceBuild = {
        routes: { root: { id: 'root', path: '' }, [id]: { id, parentId: 'root', path: id } },
      };
      const groups = (await createPagePolicies(
        { [id]: { middleware: [middleware] } },
        {
          ...runtime,
          pageRoutes: { build: () => sourceBuild, matchRoutes },
        },
      ))!;
      expect(await groups.select(context('POST', `/${id}`))).toEqual([id]);
      expect(await groups.select(context('POST', `/${id}`))).toEqual([id]);
    },
  );
  it('a new build object gets new trees and no cached selections', async () => {
    let current = build;
    const matcher = vi.fn(matchRoutes);
    const groups = (await createPagePolicies(
      { page: { middleware: [middleware] } },
      {
        ...runtime,
        pageRoutes: { build: () => current, matchRoutes: matcher },
      },
    ))!;
    await groups.select(context());
    const first = matcher.mock.calls[0]![0];
    current = { ...build };
    await groups.select(context());
    expect(matcher).toHaveBeenCalledTimes(4);
    expect(matcher.mock.calls[2]![0]).not.toBe(first);
  });
  it('does not retain a removed route in the next development build', async () => {
    let current: unknown = build;
    const groups = (await createPagePolicies(
      { page: { middleware: [middleware] } },
      {
        ...runtime,
        pageRoutes: { build: () => current, matchRoutes },
      },
    ))!;
    expect(await groups.select(context())).toEqual(['page']);
    current = { routes: { root: { id: 'root', path: '' } } };
    expect(await groups.select(context())).toEqual([]);
  });
  it('does not invent an ancestor absent from the manifest', async () => {
    const groups = (await createPagePolicies(
      { page: { middleware: [middleware] } },
      {
        ...runtime,
        pageRoutes: {
          build: () => ({ routes: { page: { id: 'page', parentId: 'missing', path: 'app/:id' } } }),
          matchRoutes,
        },
      },
    ))!;
    expect(await groups.select(context())).toEqual([]);
  });
  it('propagates a rejected build at registration', async () => {
    await expect(
      createPagePolicies(
        { root: { middleware: [middleware] } },
        {
          ...runtime,
          pageRoutes: { matchRoutes, build: () => Promise.reject(new Error('build unavailable')) },
        },
      ),
    ).rejects.toThrow('build unavailable');
  });
});
