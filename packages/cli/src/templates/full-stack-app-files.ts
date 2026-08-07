/**
 * The `app/` tree emitted by the `full-stack` template.
 *
 * The layering — `routes → features → services → models`, with `lib/` for glue
 * and `.server.ts` marking server-only modules — is the deliverable. It is
 * adapted from a production React Router 8 application, with one difference
 * that matters more than the layout: every cross-cutting concern that a
 * framework plugin already owns is REMOVED rather than reimplemented.
 *
 * A conventional React Router app grows a `lib/session.server.ts`,
 * `lib/csrf.server.ts`, `lib/sse.server.ts`, `lib/kv.server.ts`,
 * `lib/service-logger.server.ts` and a `config/services.server.ts` holding
 * module-level caches. Here those are the session, SSE, secrets and logger
 * capabilities, reached through the service registry the SSR plugin puts on
 * every request — so the skeleton ships the layering and NOT a second copy of
 * the framework.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';

const routesModule = `import { layout, type RouteConfig } from '@react-router/dev/routes';
import { flatRoutes } from '@react-router/fs-routes';

/**
 * Route configuration.
 *
 * Two layout groups, each with its own chrome: \`_auth\` for unauthenticated
 * pages and \`_app\` for the signed-in application. Within a group, routing is
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
`;

const rootModule =
  `import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError } from 'react-router';

import './app.css';

/**
 * The document shell. Everything the browser needs before hydration.
 */
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Root error boundary.
 *
 * Renders the status a thrown \`Response\` carries; anything else is an
 * unexpected failure. The framework's error-handler middleware still formats
 * errors for non-SSR routes — this covers what React Router throws.
 */
export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <main className="error">
        <h1>{error.status}</h1>
        <p>{error.statusText}</p>
      </main>
    );
  }

  return (
    <main className="error">
      <h1>Something went wrong</h1>
    </main>
  );
}
`;

const entryServerModule = `import { renderToReadableStream } from 'react-dom/server';
import { ServerRouter, type EntryContext } from 'react-router';

/**
 * Server entry.
 *
 * The response body is a ReadableStream, which the framework passes through
 * untouched — the kernel's IResponse.stream() carries it all the way to the
 * platform on every supported runtime.
 *
 * \`await stream.allReady\` then waits for every Suspense boundary before the
 * response is returned, so the HTML is complete and the status can still be
 * corrected to 500 if rendering failed late. That is the safe default, and it
 * means the document is NOT delivered incrementally. To stream shell-first,
 * drop the await for browser requests and keep it for crawlers, which need the
 * finished markup.
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
): Promise<Response> {
  let didError = false;

  const stream = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: request.signal,
      onError() {
        didError = true;
      },
    },
  );

  await stream.allReady;

  responseHeaders.set('Content-Type', 'text/html');
  return new Response(stream, {
    status: didError ? 500 : responseStatusCode,
    headers: responseHeaders,
  });
}
`;

const entryClientModule = `import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
`;

const appCss = `:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
}

body {
  margin: 0;
  padding: 0;
}

.error {
  padding: 2rem;
}
`;

const loadContextModule = `import type { RouterContextKey } from '@setu-ts/react-router-plugin';

/**
 * The part of React Router's request context this application reads.
 *
 * Declared structurally so a route can type its loader without importing
 * \`react-router\`, and so a test can call a server module with a plain object.
 *
 * This module is safe for client code: its only import is a TYPE, which is
 * erased at build time. The keys themselves live in \`context-keys.server.ts\`,
 * which is server-only.
 */
export interface AppLoadContext {
  /** Reads a context value by key. */
  get<T>(key: RouterContextKey<T>): T;
}
`;

const contextKeysModule = `import { contextKeyFor } from '@setu-ts/react-router-plugin';
import type { ILogger, ISecretManager, ISession } from '@setu-ts/common';

/**
 * Context keys this application adds to every SSR request.
 *
 * \`setu.config.ts\` sets them; loaders and actions read them. Two things make
 * that work, and both are easy to break:
 *
 * 1. **Keys come from \`contextKeyFor\`, never from a \`{ defaultValue }\`
 *    literal.** Vite INLINES application modules into the server build, while
 *    the runtime loads \`setu.config.ts\` from source — so this module exists
 *    twice, and two hand-written key objects would look identical and match
 *    nothing. Resolving each key by NAME through the plugin gives both copies
 *    the same object.
 * 2. **This module is \`.server.ts\`.** It imports a framework package by value,
 *    which only the server build may do: framework packages are external there
 *    (see \`vite.config.ts\`) and resolve at runtime, whereas the client bundle
 *    would have to inline them.
 *
 * The session key is the clearest case for why the bridge lives in app code at
 * all: \`getSession\` needs the kernel request context, which a loader never
 * sees, while \`populateLoadContext\` receives exactly that — and doing it here
 * keeps the SSR plugin from importing the session plugin.
 */

/** The session for the current request. */
export const sessionContext = contextKeyFor<ISession | null>('app.session', null);

/**
 * The CSRF token for the current request, for embedding in a form.
 *
 * The synchronizer-token check lives in the session plugin's middleware; the
 * form only has to echo this value back.
 */
export const csrfContext = contextKeyFor<string | null>('app.csrf', null);

/** The application logger. */
export const loggerContext = contextKeyFor<ILogger | null>('app.logger', null);

/**
 * The secret manager.
 *
 * Replaces a hand-rolled key-vault module: the provider (env, AWS, GCP, Azure,
 * Vault) is chosen once in \`setu.config.ts\`, and reads are cached by the
 * plugin rather than by a module-level map here.
 */
export const secretsContext = contextKeyFor<ISecretManager | null>('app.secrets', null);
`;

const servicesAccessModule =
  `import type { ILogger, ISecretManager, ISession } from '@setu-ts/common';
import type { AppLoadContext } from '~/lib/load-context.ts';
import {
  csrfContext,
  loggerContext,
  secretsContext,
  sessionContext,
} from '~/lib/context-keys.server.ts';

/**
 * Typed access to the framework services available on an SSR request.
 *
 * A conventional React Router app keeps a module-level \`Map\` here, caching one
 * HTTP client and one secret lookup per service for the life of the process.
 * That cache is exactly what the kernel's service registry already is, so this
 * module holds NO state: every value comes from the request context that
 * \`setu.config.ts\` populated, and nothing is memoised here.
 *
 * @param value - The value read from the request context
 * @param name - The service name, for the error message
 * @returns The value, once known to be present
 * @throws {Error} If the value is absent, which means either that the plugin
 * is not registered, that its context key is not set in populateLoadContext,
 * or that this ran outside a loader or action
 */
function requireValue<T>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(
      \`No \${name} on this request. Register its plugin in setu.config.ts and set its \` +
        'context key in populateLoadContext, and call this only from a loader or action.',
    );
  }
  return value;
}

/** Resolves the application logger. */
export function getLogger(context: AppLoadContext): ILogger {
  return requireValue(context.get(loggerContext), 'logger');
}

/** Resolves the secret manager. */
export function getSecrets(context: AppLoadContext): ISecretManager {
  return requireValue(context.get(secretsContext), 'secret manager');
}

/** Resolves the session for the current request. */
export function getSession(context: AppLoadContext): ISession {
  return requireValue(context.get(sessionContext), 'session');
}

/**
 * Resolves the CSRF token to embed in a form.
 *
 * Read through this accessor rather than the key directly, so route components
 * — which ship to the browser — never import a server-only module.
 */
export function getCsrfToken(context: AppLoadContext): string {
  return requireValue(context.get(csrfContext), 'CSRF token');
}
`;

const utilsModule = `/**
 * App-specific glue. Deliberately small: anything cross-cutting belongs to a
 * plugin, not to this directory.
 */

/** Joins conditional class names. */
export function classNames(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');
}
`;

const navUtilsModule = `/** Navigation helpers shared by the layouts. */

/** One entry in the application navigation. */
export interface NavItem {
  /** Link target. */
  readonly to: string;
  /** Visible label. */
  readonly label: string;
}

/** The signed-in application navigation. */
export const APP_NAV: readonly NavItem[] = [
  { to: '/products', label: 'Products' },
];

/** Reports whether a nav entry matches the current path. */
export function isActive(item: NavItem, pathname: string): boolean {
  return pathname === item.to || pathname.startsWith(\`\${item.to}/\`);
}
`;

const productModel = `/**
 * Domain model. Plain data, shared by server modules and components — so it
 * must not import anything server-only.
 */

/** A product in the catalogue. */
export interface Product {
  /** Stable identifier. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Price in minor units. */
  readonly priceCents: number;
}

/** Formats a price for display. */
export function formatPrice(product: Product): string {
  return \`$\${(product.priceCents / 100).toFixed(2)}\`;
}
`;

const productsService = `import type { AppLoadContext } from '~/lib/load-context.ts';
import type { Product } from '~/models/product.ts';
import { getLogger } from '~/config/services.server.ts';

/**
 * Data access for products.
 *
 * The service layer owns talking to the outside world — a database, or another
 * service through the SDK client. It is given the request context rather than
 * reaching for a module-level singleton, so a test can drive it with a plain
 * object.
 */
export async function listProducts(context: AppLoadContext): Promise<readonly Product[]> {
  getLogger(context).debug('products: listing');

  // Replace with a repository read, or an SDK client pointed at another
  // service — adding its context key alongside the logger's. Static data keeps
  // the skeleton runnable out of the box.
  return await Promise.resolve([
    { id: 'p-1', name: 'Standard plan', priceCents: 4900 },
    { id: 'p-2', name: 'Premium plan', priceCents: 9900 },
  ]);
}
`;

const productsFeature = `import type { AppLoadContext } from '~/lib/load-context.ts';
import type { Product } from '~/models/product.ts';
import { listProducts } from '~/services/products.server.ts';

/** What the products route renders. */
export interface ProductsView {
  /** The catalogue, ordered for display. */
  readonly products: readonly Product[];
  /** Total number of products, for the header. */
  readonly total: number;
}

/**
 * The feature layer: use-case logic a route can call in one line.
 *
 * Routes stay thin (parse the request, call this, render), services stay
 * ignorant of presentation, and this is where the two meet.
 */
export async function buildProductsView(context: AppLoadContext): Promise<ProductsView> {
  const products = await listProducts(context);
  return {
    products: [...products].sort((left, right) => left.name.localeCompare(right.name)),
    total: products.length,
  };
}
`;

const appLayout = `import { NavLink, Outlet, useLocation } from 'react-router';

import { APP_NAV, isActive } from '~/lib/nav-utils.ts';
import { classNames } from '~/lib/utils.ts';

/** Chrome for the signed-in application. */
export default function AppLayout() {
  const { pathname } = useLocation();

  return (
    <div className="app-shell">
      <nav>
        {APP_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={classNames('nav-link', isActive(item, pathname) && 'is-active')}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
`;

const loginLayout = `import { Outlet } from 'react-router';

/** Chrome for unauthenticated pages. */
export default function LoginLayout() {
  return (
    <div className="auth-shell">
      <main>
        <Outlet />
      </main>
    </div>
  );
}
`;

const productsRoute = `import { useLoaderData } from 'react-router';

import type { AppLoadContext } from '~/lib/load-context.ts';
import { buildProductsView } from '~/features/products/products.server.ts';
import { formatPrice } from '~/models/product.ts';

/**
 * Loads the view on the server.
 *
 * The request context carries the framework services \`setu.config.ts\` put
 * there, so the logger, database, cache and secrets are all reachable without a
 * module-level singleton or a second DI container — and without importing a
 * framework package into a module that also ships to the browser.
 */
export async function loader({ context }: { context: AppLoadContext }) {
  return await buildProductsView(context);
}

export default function ProductsRoute() {
  const { products, total } = useLoaderData<typeof loader>();

  return (
    <section>
      <h1>Products ({total})</h1>
      <ul>
        {products.map((product) => (
          <li key={product.id}>
            {product.name} — {formatPrice(product)}
          </li>
        ))}
      </ul>
    </section>
  );
}
`;

const loginRoute = `import { Form, redirect, useActionData, useLoaderData } from 'react-router';

import type { AppLoadContext } from '~/lib/load-context.ts';
import { getCsrfToken, getSession } from '~/config/services.server.ts';

/**
 * Hands the form its CSRF token.
 *
 * The token comes from the session, placed on the request context by
 * \`setu.config.ts\`. A progressive-enhancement \`<Form>\` cannot set a custom
 * header, which is why the synchronizer-token strategy — not the stateless
 * Origin check — is what guards this action.
 */
export function loader({ context }: { context: AppLoadContext }) {
  // Not \`?? ''\`: an absent token means the wiring is broken, and a form posting
  // an empty token would fail the check at submit time instead of here.
  return { csrfToken: getCsrfToken(context) };
}

/**
 * Handles the sign-in post.
 *
 * The CSRF token is NOT checked here: the session plugin's form-CSRF
 * middleware runs at priority 275, before this route is ever reached, and
 * answers 403 on a missing or mismatched token. So this action only runs for a
 * request that already passed the check.
 *
 * The session write is what makes the login stick — the plugin commits the
 * session onto the response after the handler returns, so the redirect below
 * carries the updated cookie.
 */
export async function action({ request, context }: { request: Request; context: AppLoadContext }) {
  const form = await request.formData();
  const email = String(form.get('email') ?? '');

  // Replace with a real credential check — resolve the auth service through a
  // context key, exactly as the logger is resolved.
  if (email === '') {
    return { error: 'Email is required.' };
  }

  const session = getSession(context);
  session.set('userEmail', email);

  return redirect('/products');
}

export default function LoginRoute() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <Form method="post">
      {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
      <input type="hidden" name="_csrf" value={csrfToken} />
      <label>
        Email <input type="email" name="email" required />
      </label>
      <label>
        Password <input type="password" name="password" required />
      </label>
      <button type="submit">Sign in</button>
    </Form>
  );
}
`;

/**
 * Every file under `app/`, in the order they are written.
 *
 * Exported as data so the template stays declarative and a test can assert the
 * emitted path set — including the modules that must NOT be here, because a
 * plugin owns them.
 */
export const FULL_STACK_APP_FILES: readonly GeneratedFile[] = [
  { path: 'app/routes.ts', contents: routesModule },
  { path: 'app/root.tsx', contents: rootModule },
  { path: 'app/entry.server.tsx', contents: entryServerModule },
  { path: 'app/entry.client.tsx', contents: entryClientModule },
  { path: 'app/app.css', contents: appCss },
  { path: 'app/lib/load-context.ts', contents: loadContextModule },
  { path: 'app/lib/context-keys.server.ts', contents: contextKeysModule },
  { path: 'app/lib/utils.ts', contents: utilsModule },
  { path: 'app/lib/nav-utils.ts', contents: navUtilsModule },
  { path: 'app/config/services.server.ts', contents: servicesAccessModule },
  { path: 'app/models/product.ts', contents: productModel },
  { path: 'app/services/products.server.ts', contents: productsService },
  { path: 'app/features/products/products.server.ts', contents: productsFeature },
  { path: 'app/components/layouts/AppLayout.tsx', contents: appLayout },
  { path: 'app/components/layouts/LoginLayout.tsx', contents: loginLayout },
  { path: 'app/routes/_app/products._index.tsx', contents: productsRoute },
  { path: 'app/routes/_auth/login.tsx', contents: loginRoute },
];
