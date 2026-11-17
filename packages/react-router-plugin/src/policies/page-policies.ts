import type { MiddlewareFunction, RouteMiddlewareGroups } from '@setu-ts/common';
import type { PagePolicy, SsrRuntime } from '../interfaces/index.ts';
import { createPageRouteMatcher, pageBuildOf } from './page-route-matcher.ts';

/** Registration-only error; no caller outside this plugin branches on it. */
class PagePolicyConfigurationError extends Error {
  constructor(problems: readonly string[]) {
    super(`react-router pagePolicies: ${problems.join('; ')}`);
    this.name = 'PagePolicyConfigurationError';
  }
}

/** Validates once and compiles the declared groups and per-request selection. Internal only. */
export async function createPagePolicies(
  policies: Readonly<Record<string, PagePolicy>> | undefined,
  runtime: SsrRuntime,
): Promise<RouteMiddlewareGroups | undefined> {
  const entries = Object.entries(policies ?? {});
  if (entries.length === 0) return undefined;
  const problems: string[] = [];
  const source = runtime.pageRoutes;
  let known: readonly string[] = [];
  if (source === undefined) {
    problems.push('loadRequestHandler must supply pageRoutes; see docs/react-router-dev.md');
  } else {
    known = Object.values(pageBuildOf(await source.build()).routes)
      .filter((route) => route !== undefined)
      .map((route) => route.id);
  }
  const knownIds = new Set(known);
  const groups: Record<string, readonly MiddlewareFunction[]> = Object.create(null);
  // A listed GET also selects HEAD: React Router answers HEAD by running the
  // same loaders as GET, so a GET-only guard must not let HEAD through.
  const methods = new Map(
    entries.map(([id, policy]) => [
      id,
      policy.methods === undefined
        ? undefined
        : new Set<string>(
            policy.methods.includes('GET') ? [...policy.methods, 'HEAD'] : policy.methods,
          ),
    ]),
  );
  for (const [id, policy] of entries) {
    if (source !== undefined && !knownIds.has(id)) {
      problems.push(`unknown route id '${id}' (known ids: ${known.slice(0, 10).join(', ')})`);
    }
    if (policy.middleware.length === 0) problems.push(`'${id}' has empty middleware`);
    if (policy.middleware.some((middleware) => typeof middleware !== 'function')) {
      problems.push(`'${id}' has non-function middleware`);
    }
    if (policy.methods?.length === 0) problems.push(`'${id}' has empty methods`);
    groups[id] = policy.middleware;
  }
  if (problems.length > 0) throw new PagePolicyConfigurationError(problems);
  const pageRoutes = source!;
  const match = createPageRouteMatcher(pageRoutes.matchRoutes);
  return {
    groups,
    select: async (ctx) =>
      match(await pageRoutes.build(), new URL(ctx.request.url).pathname).filter(
        (id) =>
          Object.hasOwn(groups, id) &&
          (methods.get(id) === undefined || methods.get(id)!.has(ctx.request.method)),
      ),
  };
}
