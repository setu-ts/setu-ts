/**
 * A real kernel application for the scoped RBAC integration tests.
 *
 * The principal comes from an `x-user` header (and optional `x-claims` JSON)
 * through AuthPlugin's caller-supplied strategy hatch, so a test chooses who
 * is signed in per request; the tenant, when multi-tenancy is on, from the
 * `x-tenant-id` header. Driven with `app.fetch`, through the real response
 * mapper.
 *
 * @module
 */
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IAuthStrategy,
  ILogger,
  IPlugin,
  IPrincipal,
  MiddlewareFunction,
} from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { DatabasePlugin } from '@setu-ts/database-plugin';
import { AuthPlugin } from '../../src/index.ts';
import type { AuthPluginOptions } from '../../src/index.ts';
import { CATALOGUE } from './scoped.ts';

/** Reads the principal from `x-user` / `x-claims`. */
export const headerStrategy: IAuthStrategy = {
  name: 'test-header',
  authenticate(request): Promise<IPrincipal | null> {
    const id = request.headers.get('x-user');
    if (id === null) {
      return Promise.resolve(null);
    }
    const claims = request.headers.get('x-claims');
    return Promise.resolve(claims === null ? { id } : { id, claims: JSON.parse(claims) });
  },
};

/** One guarded route. */
export interface GuardedRoute {
  readonly method: 'get' | 'post';
  readonly path: string;
  readonly guard: MiddlewareFunction;
}

/** Options of {@linkcode startScopedApp}. */
export interface ScopedAppOptions {
  readonly auth: Omit<AuthPluginOptions, 'strategies'>;
  readonly routes: readonly GuardedRoute[];
  readonly tenancy?: boolean;
  readonly database?: boolean;
  readonly extra?: readonly IPlugin[];
  readonly logger?: ILogger;
}

/**
 * Builds and starts an application: each route answers `200 { ok: true }`
 * behind its guard.
 *
 * @param options - The AuthPlugin options, routes and optional plugins
 * @returns The started application
 */
export async function startScopedApp(options: ScopedAppOptions): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ...(options.tenancy === true ? [MultiTenancyPlugin({ resolver: 'header' })] : []),
      ...(options.database === true ? [DatabasePlugin({ type: 'memory' })] : []),
      ...(options.extra ?? []),
      AuthPlugin({ rbac: CATALOGUE, ...options.auth, strategies: [headerStrategy] }),
    ],
  });
  if (options.logger !== undefined) {
    app.services.register(CAPABILITIES.LOGGER, options.logger);
  }
  for (const route of options.routes) {
    app.router[route.method](route.path, {
      middleware: [route.guard],
      handler: (ctx) => ctx.response.json({ ok: true }),
    });
  }
  await app.start();
  return app;
}

/**
 * Requests `path` and answers the status.
 *
 * @param app - The application
 * @param path - The request path
 * @param headers - The request headers (`x-user`, `x-tenant-id`, `x-claims`)
 * @param method - The method (default GET)
 * @returns The response status
 */
export async function status(
  app: IKernelApplication,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<number> {
  const response = await app.fetch(new Request(`http://localhost${path}`, { method, headers }));
  await response.body?.cancel();
  return response.status;
}
