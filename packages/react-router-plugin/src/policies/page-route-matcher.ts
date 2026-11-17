import type { RouteMiddlewareGroups } from '@setu-ts/common';
import type { PageRouteSource } from '../interfaces/index.ts';

const PAGE_MATCH_CACHE_LIMIT = 1_000;
const PAGE_MATCH_CACHE_PATH_BYTES = 512;
const ACTION_VERBS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
type MethodClass = 'view' | 'action';

interface PageRoute {
  readonly id: string;
  readonly parentId?: string;
  readonly index?: boolean;
  readonly path?: string;
  readonly caseSensitive?: boolean;
}

interface PageBuild {
  readonly routes: Readonly<Record<string, PageRoute | undefined>>;
  readonly future?: { readonly unstable_routePatternMatching?: unknown };
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

interface SelectionPlan {
  readonly ids: ReadonlySet<string>;
  readonly roots: readonly string[];
  readonly tree: readonly MatchRoute[] | undefined;
}

interface PreparedBuild {
  readonly build: PageBuild;
  readonly tree: readonly MatchRoute[];
  readonly manifestPath: string | undefined;
  readonly plans: ReadonlyMap<MethodClass, SelectionPlan>;
  readonly matches: Map<string, readonly string[]>;
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

/** The same grouping and route shape is used for both full and reduced trees. */
function routeTree(
  byParent: ReadonlyMap<string, readonly PageRoute[]>,
  parent = '',
  included?: ReadonlySet<string>,
): readonly MatchRoute[] {
  return (byParent.get(parent) ?? [])
    .filter((route) => included === undefined || included.has(route.id))
    .map((route) => {
      const commonRoute = {
        id: route.id,
        ...(route.path === undefined ? {} : { path: route.path }),
      };
      return route.index
        ? { ...commonRoute, index: true }
        : {
            ...commonRoute,
            ...(route.caseSensitive === undefined ? {} : { caseSensitive: route.caseSensitive }),
            children: routeTree(byParent, route.id, included),
          };
    });
}

function selectionPlan(
  ids: ReadonlySet<string>,
  byId: ReadonlyMap<string, PageRoute>,
  byParent: ReadonlyMap<string, readonly PageRoute[]>,
): SelectionPlan {
  const roots: string[] = [];
  const matched = new Set<string>();
  const included = new Set<string>();
  const expanded = new Set<string>();
  const descendants = (id: string): void => {
    if (expanded.has(id)) return;
    expanded.add(id);
    included.add(id);
    for (const child of byParent.get(id) ?? []) descendants(child.id);
  };
  for (const id of ids) {
    let route: PageRoute | undefined = byId.get(id)!;
    if (!route.parentId) {
      roots.push(id);
      continue;
    }
    matched.add(id);
    descendants(id);
    while (route.parentId) {
      included.add(route.parentId);
      route = byId.get(route.parentId);
      if (route === undefined) break;
    }
  }
  return {
    ids: matched,
    roots,
    // A reduced tree holding half the routes or more saves little and would be
    // ranked again by the full match: skip the prefilter, so a request ranks
    // at most one whole tree plus a prefilter over fewer than half the routes.
    tree: included.size * 2 >= byId.size ? undefined : routeTree(byParent, '', included),
  };
}

function buildReader(classes: ReadonlyMap<MethodClass, ReadonlySet<string>>) {
  const builds = new WeakMap<object, PreparedBuild>();
  return (value: unknown): PreparedBuild => {
    const cached = typeof value === 'object' && value !== null ? builds.get(value) : undefined;
    const build = cached?.build ?? pageBuildOf(value);
    if (build.future?.unstable_routePatternMatching) {
      throw new Error('page policies do not support future.unstable_routePatternMatching');
    }
    if (cached !== undefined) return cached;
    const byParent = new Map<string, PageRoute[]>();
    const byId = new Map<string, PageRoute>();
    for (const route of Object.values(build.routes)) {
      if (route === undefined) continue;
      byId.set(route.id, route);
      const parent = route.parentId || '';
      const siblings = byParent.get(parent) ?? [];
      siblings.push(route);
      byParent.set(parent, siblings);
    }
    for (const id of classes.get('action')!) {
      if (!byId.has(id))
        throw new Error(`page policy route '${id}' is missing from the server build`);
    }
    const discovery = build.routeDiscovery;
    const manifest = discovery?.manifestPath || '/__manifest';
    const prepared: PreparedBuild = {
      build,
      tree: routeTree(byParent),
      manifestPath:
        discovery?.mode !== 'lazy'
          ? undefined
          : build.basename == null
            ? manifest
            : [build.basename, manifest].join('/').replace(/\/+/g, '/'),
      plans: new Map(
        Array.from(classes, ([key, ids]) => [key, selectionPlan(ids, byId, byParent)]),
      ),
      matches: new Map(),
    };
    builds.set(build, prepared);
    return prepared;
  };
}

function normalizedPath(pathname: string): string {
  return pathname.endsWith('/_.data')
    ? pathname.replace(/_\.data$/, '')
    : pathname.replace(/\.data$/, '');
}

function matchedIds(matches: ReturnType<PageRouteSource['matchRoutes']>): readonly string[] {
  return (
    matches?.map((match) => {
      const id = match.route.id;
      if (typeof id !== 'string') throw new Error('page route match must have a string route id');
      return id;
    }) ?? []
  );
}

/** Compiles policy selection and a bounded LRU separately for each build object. Internal only. */
export function createPageRouteSelector(
  source: PageRouteSource,
  applicability: ReadonlyMap<string, 'action' | 'all'>,
  initialBuild: unknown,
): RouteMiddlewareGroups['select'] {
  const classes = new Map<MethodClass, ReadonlySet<string>>([
    [
      'view',
      new Set(
        Array.from(applicability)
          .filter(([, on]) => on === 'all')
          .map(([id]) => id),
      ),
    ],
    ['action', new Set(applicability.keys())],
  ]);
  const read = buildReader(classes);
  read(initialBuild);
  const encoder = new TextEncoder();
  return async (ctx) => {
    const methodClass = ACTION_VERBS.has(ctx.request.method.toUpperCase()) ? 'action' : 'view';
    if (classes.get(methodClass)!.size === 0) return [];
    const prepared = read(await source.build());
    const pathname = new URL(ctx.request.url).pathname;
    if (pathname === prepared.manifestPath) return [];
    const plan = prepared.plans.get(methodClass)!;
    if (plan.ids.size === 0) return plan.roots;
    const normalized = normalizedPath(pathname);
    const cacheable =
      normalized.length <= PAGE_MATCH_CACHE_PATH_BYTES &&
      encoder.encode(normalized).byteLength <= PAGE_MATCH_CACHE_PATH_BYTES;
    const key = `${methodClass}:${normalized}`;
    const cached = cacheable ? prepared.matches.get(key) : undefined;
    if (cached !== undefined) {
      prepared.matches.delete(key);
      prepared.matches.set(key, cached);
      return cached;
    }
    if (plan.tree !== undefined) {
      const prefilter = matchedIds(
        source.matchRoutes(plan.tree, normalized, prepared.build.basename),
      );
      if (prefilter.length === 0) return plan.roots;
    }
    const selected = [
      ...plan.roots,
      ...matchedIds(source.matchRoutes(prepared.tree, normalized, prepared.build.basename)).filter(
        (id) => plan.ids.has(id),
      ),
    ];
    if (cacheable) {
      if (prepared.matches.size >= PAGE_MATCH_CACHE_LIMIT) {
        prepared.matches.delete(prepared.matches.keys().next().value!);
      }
      prepared.matches.set(key, selected);
    }
    return selected;
  };
}
