import type { MiddlewareFunction, RouteMiddlewareGroups } from '@setu-ts/common';
import type { PagePolicy, SsrRuntime } from '../interfaces/index.ts';
import { createPageRouteSelector, pageBuildOf } from './page-route-matcher.ts';

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
  let initialBuild: unknown;
  let known: readonly string[] = [];
  if (source === undefined) {
    problems.push('loadRequestHandler must supply pageRoutes; see docs/react-router-dev.md');
  } else {
    initialBuild = await source.build();
    known = Object.values(pageBuildOf(initialBuild).routes)
      .filter((route) => route !== undefined)
      .map((route) => route.id);
  }
  const knownIds = new Set(known);
  const groups: Record<string, readonly MiddlewareFunction[]> = Object.create(null);
  const applicability = new Map<string, 'action' | 'all'>();
  for (const [id, policy] of entries) {
    if (source !== undefined && !knownIds.has(id)) {
      problems.push(`unknown route id '${id}' (known ids: ${known.slice(0, 10).join(', ')})`);
    }
    if (policy.middleware.length === 0) problems.push(`'${id}' has empty middleware`);
    if (policy.middleware.some((middleware) => typeof middleware !== 'function')) {
      problems.push(`'${id}' has non-function middleware`);
    }
    const on = policy.on;
    if (on !== undefined && on !== 'action' && on !== 'all') {
      problems.push(`'${id}' has invalid on value (expected 'action' or 'all')`);
    }
    applicability.set(id, on === 'action' ? 'action' : 'all');
    groups[id] = policy.middleware;
  }
  if (problems.length > 0) throw new PagePolicyConfigurationError(problems);
  return {
    groups,
    select: createPageRouteSelector(source!, applicability, initialBuild),
  };
}
