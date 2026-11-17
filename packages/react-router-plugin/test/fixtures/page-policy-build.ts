import type { ServerBuild } from 'react-router';

/** Values recorded by actual React Router route modules, never by the selector. */
export interface PageProbe {
  readonly middleware: string[];
  readonly actions: string[];
  readonly errors: unknown[];
  readonly onAction?: (request: Request) => Promise<unknown>;
  readonly emptyDocument?: boolean;
}

/** Route shapes include a pathless root, nested index and an index with its own path. */
export function pagePolicyBuild(basename: string, probe: PageProbe): ServerBuild {
  const definitions = [
    { id: 'root', path: '' },
    { id: 'routes/login', parentId: 'root', path: 'login' },
    { id: 'routes/app', parentId: 'root', path: 'app' },
    { id: 'routes/app-index', parentId: 'routes/app', index: true },
    { id: 'routes/app.settings._index', parentId: 'root', path: 'app/settings', index: true },
    { id: 'routes/param', parentId: 'routes/app', path: ':id' },
    { id: 'routes/index', parentId: 'root', index: true },
    { id: 'routes/splat', parentId: 'root', path: 'files/*' },
  ];
  return {
    basename,
    ssr: true,
    publicPath: '/',
    assetsBuildDirectory: 'build/client',
    future: {},
    prerender: [],
    isSpaMode: false,
    routeDiscovery: { mode: 'lazy', manifestPath: '/__manifest' },
    entry: {
      module: {
        default: (_request: Request, status: number, headers: Headers) =>
          new Response(probe.emptyDocument ? null : 'rendered page', { status, headers }),
        handleError: (error: unknown) => {
          probe.errors.push(error);
        },
      },
    },
    routes: Object.fromEntries(
      definitions.map((definition) => [
        definition.id,
        {
          ...definition,
          module: {
            default: () => null,
            loader: () => ({ loaded: definition.id }),
            action: async ({ request }: { request: Request }) => {
              probe.actions.push(definition.id);
              return probe.onAction ? await probe.onAction(request) : { action: definition.id };
            },
            middleware: [
              async (_args: unknown, next: () => Promise<unknown>) => {
                probe.middleware.push(definition.id);
                await next();
              },
            ],
          },
        },
      ]),
    ),
    assets: {
      entry: { module: '/entry.js', imports: [] },
      routes: Object.fromEntries(
        definitions.map((definition) => [
          definition.id,
          {
            ...definition,
            module: `/${definition.id}.js`,
            imports: [],
            hasAction: true,
            hasLoader: true,
            hasClientAction: false,
            hasClientLoader: false,
            hasClientMiddleware: false,
            hasErrorBoundary: false,
          },
        ]),
      ),
      url: '/manifest.js',
      version: '1',
    },
  } as unknown as ServerBuild;
}
