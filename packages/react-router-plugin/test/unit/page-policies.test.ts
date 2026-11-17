import { describe, expect, it } from 'vitest';
import { matchRoutes } from 'react-router';
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import type { PagePolicy, PageRouteSource, SsrRuntime } from '../../src/interfaces/index.ts';
import { createPagePolicies } from '../../src/policies/page-policies.ts';
import { createFakeLoadContextFactory } from '../fixtures/fake-handler.ts';

const middleware: MiddlewareFunction = (_ctx, next) => next();
const runtime: SsrRuntime = {
  handler: () => Promise.resolve(new Response('page')),
  createLoadContext: createFakeLoadContextFactory(),
  pageRoutes: {
    build: () => ({
      routes: { root: { id: 'root' }, layout: { id: 'layout' }, page: { id: 'page' } },
    }),
    matchRoutes: () => ['root', 'layout', 'page', 'constructor'].map((id) => ({ route: { id } })),
  },
};

describe('page policies', () => {
  it('accepts the real React Router matcher without a cast', () => {
    const build = () => ({ routes: {} });
    const source: PageRouteSource = { build, matchRoutes };
    expect(source.matchRoutes).toBe(matchRoutes);
    expect(source.build()).toEqual({ routes: {} });
  });
  it('omitted or empty policies install nothing and do not require a source', async () => {
    const { pageRoutes, ...withoutSource } = runtime;
    expect(pageRoutes).toBeDefined();
    expect(await createPagePolicies(undefined, withoutSource)).toBeUndefined();
    expect(await createPagePolicies({}, withoutSource)).toBeUndefined();
  });

  it('collects unknown ids, empty arrays and non-function middleware in one error', async () => {
    const policies = {
      typo: { middleware: [], methods: [] },
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
      'known ids: root, layout, page',
      "'typo' has empty middleware",
      "'typo' has empty methods",
      "'other' has non-function middleware",
    ]) {
      expect((thrown as Error).message).toContain(problem);
    }
  });

  it('collects missing source and policy errors together with development guidance', async () => {
    await expect(
      createPagePolicies(
        { page: { middleware: [], methods: [] } },
        {
          handler: runtime.handler,
          createLoadContext: runtime.createLoadContext,
        },
      ),
    ).rejects.toThrow(
      "pageRoutes; see docs/react-router-dev.md; 'page' has empty middleware; 'page' has empty methods",
    );
  });

  it('limits known ids in the refusal to ten', async () => {
    await expect(
      createPagePolicies(
        { typo: { middleware: [middleware] } },
        {
          ...runtime,
          pageRoutes: {
            matchRoutes: () => null,
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

  it('selects ancestors root first, all methods when omitted, and filters explicit methods', async () => {
    const groups = (await createPagePolicies(
      {
        page: { middleware: [middleware], methods: ['POST'] },
        root: { middleware: [middleware] },
        layout: { middleware: [middleware], methods: ['GET', 'POST'] },
      },
      runtime,
    ))!;
    for (const [method, ids] of [
      ['POST', ['root', 'layout', 'page']],
      ['GET', ['root', 'layout']],
      ['HEAD', ['root', 'layout']],
      ['DELETE', ['root']],
    ] as const) {
      expect(
        await groups.select({
          request: { method, url: 'http://local/app?index' },
        } as IRequestContext),
      ).toEqual(ids);
    }
    expect(Object.keys(groups.groups)).toEqual(['page', 'root', 'layout']);
  });

  it('registration propagates a rejected build', async () => {
    await expect(
      createPagePolicies(
        { root: { middleware: [middleware] } },
        {
          ...runtime,
          pageRoutes: {
            matchRoutes: () => null,
            build: () => Promise.reject(new Error('build unavailable')),
          },
        },
      ),
    ).rejects.toThrow('build unavailable');
  });
});
