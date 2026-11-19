/**
 * `serviceCall` through React Router's REAL `createRequestHandler`: a refusal
 * keeps its status in a resource route and in a page loader, and neither
 * reaches the server entry's `handleError`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { notFound } from '@setu-ts/exceptions';
import { serviceCall } from '../../src/index.ts';

let rrModule: Record<string, unknown> | null = null;
try {
  rrModule = (await import('react-router')) as unknown as Record<string, unknown>;
} catch {
  rrModule = null;
}

type Handler = (request: Request) => Promise<Response>;

/** A route's assets-manifest entry. */
function assetRoute(
  id: string,
  path: string,
  parentId: string | undefined,
  hasDefault: boolean,
): Record<string, unknown> {
  return {
    id,
    path,
    ...(parentId === undefined ? {} : { parentId }),
    hasAction: false,
    hasLoader: true,
    hasClientAction: false,
    hasClientLoader: false,
    hasClientMiddleware: false,
    hasErrorBoundary: hasDefault,
    hasDefaultExport: hasDefault,
    module: `/${id}.js`,
    imports: [],
  };
}

/** A server build whose page and resource route both refuse through `serviceCall`. */
function build(handled: unknown[], rendered: { status: number; errors: unknown }[]): unknown {
  const refuse = ({ request }: { request: Request }): Promise<unknown> =>
    serviceCall(request, () => Promise.reject(notFound('Order 7 does not exist.')));
  return {
    ssr: true,
    basename: '/',
    publicPath: '/',
    assetsBuildDirectory: 'build/client',
    future: {},
    prerender: [],
    routeDiscovery: { mode: 'initial' },
    isSpaMode: false,
    entry: {
      module: {
        default: (
          _request: Request,
          status: number,
          headers: Headers,
          context: { errors: unknown },
        ) => {
          rendered.push({
            status,
            errors: (context as unknown as { staticHandlerContext: { errors: unknown } })
              .staticHandlerContext.errors,
          });
          return new Response('<html>page</html>', { status, headers });
        },
        handleError: (error: unknown) => {
          handled.push(error);
        },
      },
    },
    routes: {
      root: {
        id: 'root',
        parentId: undefined,
        path: '',
        module: { default: () => null, ErrorBoundary: () => null },
      },
      'routes/orders': {
        id: 'routes/orders',
        parentId: 'root',
        path: 'orders/:id',
        module: { default: () => null, ErrorBoundary: () => null, loader: refuse },
      },
      'routes/orders.export': {
        id: 'routes/orders.export',
        parentId: 'root',
        path: 'export/:id',
        module: { loader: refuse },
      },
    },
    assets: {
      entry: { module: '/entry.client.js', imports: [] },
      routes: {
        root: assetRoute('root', '', undefined, true),
        'routes/orders': assetRoute('routes/orders', 'orders/:id', 'root', true),
        'routes/orders.export': assetRoute('routes/orders.export', 'export/:id', 'root', false),
      },
      url: '/manifest.js',
      version: '1',
    },
  };
}

describe('serviceCall through the real request handler', { skip: rrModule === null }, () => {
  function handler(handled: unknown[], rendered: { status: number; errors: unknown }[]): Handler {
    const create = rrModule!.createRequestHandler as (b: unknown, mode: string) => Handler;
    return create(build(handled, rendered), 'production');
  }

  it('a resource route answers the refusal as Problem Details, unlogged', async () => {
    const handled: unknown[] = [];
    const response = await handler(handled, [])(new Request('http://localhost/export/7'));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await response.json()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Order 7 does not exist.',
      instance: '/export/7',
    });
    expect(handled).toEqual([]);
  });

  it("a page loader's refusal reaches the error boundary with its status, unlogged", async () => {
    const handled: unknown[] = [];
    const rendered: { status: number; errors: unknown }[] = [];
    const response = await handler(handled, rendered)(new Request('http://localhost/orders/7'));
    await response.text();
    expect(response.status).toBe(404);
    const isRouteErrorResponse = rrModule!.isRouteErrorResponse as (value: unknown) => boolean;
    const errors = rendered[0]?.errors as Record<string, { status: number; data: unknown }>;
    const error = errors['routes/orders']!;
    expect(isRouteErrorResponse(error)).toBe(true);
    expect(error.status).toBe(404);
    // React Router parses only `application/json`; a Problem Details body arrives as its text.
    expect(typeof error.data).toBe('string');
    expect(JSON.parse(error.data as string)).toMatchObject({
      status: 404,
      detail: 'Order 7 does not exist.',
    });
    expect(handled).toEqual([]);
  });

  it('a plain throw in the same loader is a logged 500, for contrast', async () => {
    const handled: unknown[] = [];
    const create = rrModule!.createRequestHandler as (b: unknown, mode: string) => Handler;
    const faulty = build(handled, []) as {
      routes: Record<string, { module: Record<string, unknown> }>;
    };
    faulty.routes['routes/orders.export']!.module['loader'] = () => {
      throw new Error('boom');
    };
    const response = await create(faulty, 'production')(new Request('http://localhost/export/7'));
    await response.text();
    expect(response.status).toBe(500);
    expect(handled).toHaveLength(1);
  });
});
