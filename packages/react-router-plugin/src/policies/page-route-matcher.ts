import type { PageRouteSource } from '../interfaces/index.ts';

interface PageRoute {
  readonly id: string;
  readonly parentId?: string;
  readonly index?: boolean;
  readonly path?: string;
  readonly caseSensitive?: boolean;
}

interface PageBuild {
  readonly routes: Readonly<Record<string, PageRoute | undefined>>;
  readonly basename?: string;
  readonly routeDiscovery?: { readonly mode?: string; readonly manifestPath?: string };
}

interface MatchRoute {
  readonly id: string;
  readonly index?: true;
  readonly path?: string;
  readonly caseSensitive?: boolean;
  readonly children?: readonly MatchRoute[];
}

/** Narrow the build boundary before reading its route manifest. Internal only. */
export function pageBuildOf(build: unknown): PageBuild {
  if (
    typeof build !== 'object' ||
    build === null ||
    !('routes' in build) ||
    typeof build.routes !== 'object' ||
    build.routes === null
  ) {
    throw new Error('page policies require a server build with a routes manifest');
  }
  for (const route of Object.values(build.routes)) {
    if (
      route !== undefined &&
      (typeof route !== 'object' ||
        route === null ||
        !('id' in route) ||
        typeof route.id !== 'string')
    ) {
      throw new Error('page policies require route manifest entries with string ids');
    }
  }
  return build as PageBuild;
}

/** Creates a matcher with one tree per build object; fresh development builds rebuild it. */
export function createPageRouteMatcher(
  matchRoutes: PageRouteSource['matchRoutes'],
): (build: unknown, pathname: string) => readonly string[] {
  const trees = new WeakMap<
    object,
    { readonly build: PageBuild; readonly tree: readonly MatchRoute[] }
  >();
  return (value, pathname) => {
    const cached = typeof value === 'object' && value !== null ? trees.get(value) : undefined;
    const build = cached?.build ?? pageBuildOf(value);
    const discovery = build.routeDiscovery;
    if (
      discovery?.mode === 'lazy' &&
      pathname ===
        [build.basename ?? '/', discovery.manifestPath || '/__manifest']
          .join('/')
          .replace(/\/+/g, '/')
    ) {
      return [];
    }
    let tree = cached?.tree;
    if (tree === undefined) {
      const byParent = new Map<string, PageRoute[]>();
      for (const route of Object.values(build.routes)) {
        if (route === undefined) continue;
        const parent = route.parentId || '';
        const siblings = byParent.get(parent) ?? [];
        siblings.push(route);
        byParent.set(parent, siblings);
      }
      const childrenOf = (parent: string): readonly MatchRoute[] =>
        (byParent.get(parent) ?? []).map((route) => {
          const commonRoute = {
            id: route.id,
            ...(route.path === undefined ? {} : { path: route.path }),
          };
          return route.index
            ? { ...commonRoute, index: true }
            : {
                ...commonRoute,
                ...(route.caseSensitive === undefined
                  ? {}
                  : { caseSensitive: route.caseSensitive }),
                children: childrenOf(route.id),
              };
        });
      tree = childrenOf('');
      trees.set(build, { build, tree });
    }
    const normalized = pathname.endsWith('/_.data')
      ? pathname.replace(/_\.data$/, '')
      : pathname.replace(/\.data$/, '');
    return (
      matchRoutes(tree, normalized, build.basename)?.map((match) => {
        const id = match.route.id;
        if (typeof id !== 'string') {
          throw new Error('page route match must have a string route id');
        }
        return id;
      }) ?? []
    );
  };
}
