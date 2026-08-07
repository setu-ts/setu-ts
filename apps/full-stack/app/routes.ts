import { layout, type RouteConfig } from '@react-router/dev/routes';
import { flatRoutes } from '@react-router/fs-routes';

/**
 * Route configuration.
 *
 * Two layout groups, each with its own chrome: `_auth` for unauthenticated
 * pages and `_app` for the signed-in application. Within a group, routing is
 * file-based — adding a route is adding a file, and the group's layout wraps it
 * automatically.
 */
export default [
  layout('./components/layouts/LoginLayout.tsx', [
    ...(await flatRoutes({ rootDirectory: 'routes/_auth' })),
  ]),
  layout('./components/layouts/AppLayout.tsx', [
    ...(await flatRoutes({ rootDirectory: 'routes/_app' })),
  ]),
] satisfies RouteConfig;
