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

import { renderTokenCss } from './ui-tokens.ts';
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

const rootModule = `import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from 'react-router';

import { THEME_SCRIPT } from '~/lib/theme.ts';
import './app.css';

/**
 * The document shell. Everything the browser needs before hydration.
 */
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang='en' suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <meta charSet='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
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
      <main className='p-8'>
        <h1 className='text-2xl font-semibold'>{error.status}</h1>
        <p>{error.statusText}</p>
      </main>
    );
  }

  return (
    <main className='p-8'>
      <h1 className='text-2xl font-semibold'>Something went wrong</h1>
    </main>
  );
}
`;

const entryServerModule = `import { renderToReadableStream } from 'react-dom/server';
import { type EntryContext, ServerRouter } from 'react-router';

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

const appCss = `@import "tailwindcss";

${renderTokenCss()}`;

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
import type { CurrentUser } from '~/models/user.ts';

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

/**
 * The signed-in user, on the routes the \`requireUser\` route middleware guards.
 *
 * Unlike the keys above, \`setu.config.ts\` does not set this one: React Router
 * route middleware does, after reading the session — see
 * \`app/middleware/require-user.server.ts\`. It stays \`null\` on every route that
 * middleware does not guard.
 */
export const currentUserContext = contextKeyFor<CurrentUser | null>('app.current-user', null);
`;

const servicesAccessModule = `import type { ILogger, ISecretManager, ISession } from '@setu-ts/common';
import type { AppLoadContext } from '~/lib/load-context.ts';
import type { CurrentUser } from '~/models/user.ts';
import {
  csrfContext,
  currentUserContext,
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

/**
 * Resolves the signed-in user the \`requireUser\` route middleware put on the context.
 *
 * Throws on a route that middleware does not guard. That is deliberate: a loader
 * that needs a user should be unreachable without one, and a missing
 * \`export const middleware\` is a wiring mistake worth failing loudly on.
 */
export function getCurrentUser(context: AppLoadContext): CurrentUser {
  const user = context.get(currentUserContext);
  if (user === null) {
    throw new Error(
      'No signed-in user on this request. Guard the route with ' +
        '\`export const middleware = [requireUser];\` from ~/middleware/require-user.server.ts.',
    );
  }
  return user;
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

const userModel = `/** The signed-in user, as the application sees it. Plain data, safe for client code. */
export interface CurrentUser {
  /** The address the user signed in with. */
  readonly email: string;
}
`;

/**
 * The worked React Router route middleware.
 *
 * The scaffold has TWO middleware layers and a new reader has no way to tell them
 * apart: `setu generate middleware` writes the kernel layer, which runs for every
 * request the application serves, while React Router's own `middleware` export
 * runs only for the SSR routes it is attached to and sees the loader context —
 * which is where the session-derived user lives. Before this module the scaffold
 * shipped no example of the second layer at all, so where to put one, and how to
 * hand a value to a loader through it, had to be learned from React Router's docs.
 */
const requireUserMiddleware = `import { type MiddlewareFunction, redirect } from 'react-router';

import { currentUserContext, sessionContext } from '~/lib/context-keys.server.ts';

/**
 * React Router route middleware: only a signed-in user gets past it.
 *
 * This project has two middleware layers, and this is the second one:
 *
 * - **Kernel middleware** (\`{{cliInvocation}} generate middleware <name>\`,
 *   in \`src/middleware/\`)
 *   runs for EVERY request the application serves — health probes, API routes,
 *   static files and SSR pages alike — and works on the kernel request context.
 *   Use it for cross-cutting concerns: headers, auditing, rate limits.
 * - **Route middleware** (this module) runs only for the SSR routes it is attached
 *   to, for both the document request and the client-side navigation's data
 *   request. It reads and writes React Router's context, so it can read the
 *   session and hand a loader a value. Use it for page-level rules.
 *
 * Attach it by exporting a \`middleware\` array from a route module:
 *
 * \`\`\`ts
 * export const middleware = [requireUser];
 * \`\`\`
 *
 * Exported from a LAYOUT module (\`app/components/layouts/AppLayout.tsx\`) it guards
 * every route in that group. This scaffold attaches it to \`/products\` alone,
 * because the same layout also serves the public landing page at \`/\`.
 *
 * The \`.server.ts\` suffix is safe here: React Router strips the \`middleware\`
 * export — and the imports only it uses — from the browser bundle.
 *
 * A refusal from this layer is rendered by React Router's route error boundary,
 * not by the kernel error responder. Throw \`redirect()\` for anonymous document
 * requests or \`data(..., { status: 403 })\` for a forbidden page; API callers
 * that require Problem Details should call a kernel API route.
 */
export const requireUser: MiddlewareFunction<Response> = ({ context }, next) => {
  const email = context.get(sessionContext)?.get<string>('userEmail');
  if (email === undefined || email === '') {
    // A thrown redirect ends the chain: no loader and no later middleware runs.
    throw redirect('/login');
  }
  // Loaders below this middleware read it with getCurrentUser(context).
  context.set(currentUserContext, { email });
  return next();
};
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

const appLayout = `import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { ThemeToggle } from '~/components/theme-toggle.tsx';
import { APP_NAV, isActive } from '~/lib/nav-utils.ts';
import { cn } from 'cn';

/** Chrome for the signed-in application, with one scrolling content region. */
export default function AppLayout() {
  const { pathname } = useLocation();
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [pathname]);

  const navigation = APP_NAV.map((item) => (
    <NavLink
      key={item.to}
      to={item.to}
      className={cn(
        'block shrink-0 rounded-md px-3 py-2 text-sm',
        isActive(item, pathname) && 'bg-accent text-accent-foreground',
      )}
    >
      {item.label}
    </NavLink>
  ));

  return (
    <div data-shell='frame' className='flex h-dvh flex-col overflow-hidden'>
      <header
        data-shell='header'
        className='flex h-14 shrink-0 items-center justify-between border-b px-6'
      >
        <span className='font-semibold'>Setu-TS</span>
        <ThemeToggle />
      </header>
      <nav
        aria-label='Mobile navigation'
        className='flex shrink-0 overflow-x-auto border-b p-2 md:hidden'
      >
        {navigation}
      </nav>
      <div className='flex min-h-0 flex-1'>
        <aside
          data-shell='sidebar'
          className='hidden w-56 shrink-0 overflow-y-auto border-r p-3 md:block'
        >
          <nav aria-label='Application navigation'>{navigation}</nav>
        </aside>
        <main ref={content} data-shell='content' className='min-w-0 flex-1 overflow-y-auto p-6'>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
`;
const loginLayout = `import { Outlet } from 'react-router';
import { Card, CardContent } from '~/components/ui/card.tsx';

/** Chrome for unauthenticated pages. */
export default function LoginLayout() {
  return (
    <div className='grid min-h-dvh place-items-center p-6'>
      <main className='w-full max-w-sm'>
        <Card>
          <CardContent>
            <Outlet />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
`;
/**
 * The landing page — the route whose ABSENCE made every scaffolded full-stack
 * project serve a blank home page.
 *
 * `app/routes.ts` wraps two `flatRoutes` groups in `layout()` calls, and neither
 * group had an `_index` file. So `/` matched a layout with no child, `<Outlet />`
 * rendered nothing, and the server answered **200 with an empty `<body>`** — not
 * a 404, not an error, a blank document. Measured on a scaffolded project:
 * `/products` and `/login` rendered while `/` returned 2761 bytes of shell and no
 * visible text. M37c found and fixed exactly this in `apps/full-stack`; the
 * generator kept emitting it, because both that example's smoke check and its
 * browser run requested `/products` and `/login` explicitly and nothing ever
 * requested `/`.
 *
 * It reads the session rather than being decoration, so the first page a reader
 * opens demonstrates a capability: sign in on `/login` and the greeting changes,
 * because the cookie survives the redirect.
 */
const indexRoute = `import { Link, useLoaderData } from 'react-router';

import { Card, CardContent } from '~/components/ui/card.tsx';
import type { AppLoadContext } from '~/lib/load-context.ts';
import { getSession } from '~/config/services.server.ts';

/** Reads the session on the server, so the greeting reflects the cookie. */
export function loader({ context }: { context: AppLoadContext }) {
  const session = getSession(context);
  return { signedInAs: session.get<string>('userEmail') ?? null };
}

export default function IndexRoute() {
  const { signedInAs } = useLoaderData<typeof loader>();

  return (
    <Card>
      <CardContent className='grid gap-4'>
        <h1 className='text-2xl font-semibold'>Welcome</h1>
        <p>
          A React Router application server-rendered by the kernel through{' '}
          <code className='rounded bg-muted px-1 font-mono text-sm'>react-router-plugin</code>.
        </p>
        <p>
          {signedInAs === null ? <>You are not signed in.</> : (
            <>
              Signed in as <strong>{signedInAs}</strong>{' '}
              — the session is server-authoritative and the cookie is HttpOnly.
            </>
          )}
        </p>
        <ul className='list-disc space-y-2 pl-5'>
          <li>
            <Link to='/products' className='font-medium underline underline-offset-4'>
              Products
            </Link>{' '}
            — rows read by a loader, behind a route middleware that sends you to sign in first.
          </li>
          <li>
            <Link to='/login' className='font-medium underline underline-offset-4'>
              Sign in
            </Link>{' '}
            — a form guarded by the session's synchronizer CSRF token.
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}
`;
const productsRoute = `import { useLoaderData } from 'react-router';

import { Card, CardContent } from '~/components/ui/card.tsx';
import type { AppLoadContext } from '~/lib/load-context.ts';
import { getCurrentUser } from '~/config/services.server.ts';
import { buildProductsView } from '~/features/products/products.server.ts';
import { requireUser } from '~/middleware/require-user.server.ts';
import { formatPrice } from '~/models/product.ts';

/**
 * Route middleware: runs before the loader, and sends a visitor who is not
 * signed in to /login. See \`app/middleware/require-user.server.ts\` for how this
 * layer differs from the kernel middleware \`setu generate middleware\` writes.
 */
export const middleware = [requireUser];

/**
 * Loads the view on the server.
 *
 * The request context carries the framework services \`setu.config.ts\` put
 * there, so the logger, database, cache and secrets are all reachable without a
 * module-level singleton or a second DI container — and without importing a
 * framework package into a module that also ships to the browser.
 */
export async function loader({ context }: { context: AppLoadContext }) {
  // Set by the route middleware above; never null here, because the middleware
  // redirects before the loader runs when there is no user.
  const user = getCurrentUser(context);
  return { ...(await buildProductsView(context)), signedInAs: user.email };
}

export default function ProductsRoute() {
  const { products, total, signedInAs } = useLoaderData<typeof loader>();

  return (
    <Card>
      <CardContent className='grid gap-4'>
        <h1 className='text-2xl font-semibold'>Products ({total})</h1>
        <p className='text-muted-foreground'>Signed in as {signedInAs}</p>
        <ul className='list-disc space-y-1 pl-5'>
          {products.map((product) => (
            <li key={product.id}>
              {product.name} — {formatPrice(product)}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
`;
const loginRoute = `import { Form, redirect, useActionData, useLoaderData } from 'react-router';

import { Button } from '~/components/ui/button.tsx';
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
 * middleware runs at priority 325, before this route is ever reached, and
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
    <Form method='post' className='grid gap-4'>
      {actionData?.error
        ? <p role='alert' className='text-sm text-destructive'>{actionData.error}</p>
        : null}
      <input type='hidden' name='_csrf' value={csrfToken} />
      <label className='grid gap-2 text-sm font-medium'>
        Email
        <input
          type='email'
          name='email'
          required
          className='h-9 w-full rounded-md border border-input bg-transparent px-3 shadow-xs'
        />
      </label>
      <label className='grid gap-2 text-sm font-medium'>
        Password
        <input
          type='password'
          name='password'
          required
          className='h-9 w-full rounded-md border border-input bg-transparent px-3 shadow-xs'
        />
      </label>
      <Button type='submit'>Sign in</Button>
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
  { path: 'app/lib/nav-utils.ts', contents: navUtilsModule },
  { path: 'app/config/services.server.ts', contents: servicesAccessModule },
  { path: 'app/models/product.ts', contents: productModel },
  { path: 'app/models/user.ts', contents: userModel },
  { path: 'app/middleware/require-user.server.ts', contents: requireUserMiddleware },
  { path: 'app/services/products.server.ts', contents: productsService },
  { path: 'app/features/products/products.server.ts', contents: productsFeature },
  { path: 'app/components/layouts/AppLayout.tsx', contents: appLayout },
  { path: 'app/components/layouts/LoginLayout.tsx', contents: loginLayout },
  { path: 'app/routes/_app/_index.tsx', contents: indexRoute },
  { path: 'app/routes/_app/products._index.tsx', contents: productsRoute },
  { path: 'app/routes/_auth/login.tsx', contents: loginRoute },
];

/**
 * The full-stack README section on where middleware goes.
 *
 * A generated project has two middleware layers that look alike and are not
 * interchangeable, and the generic README said nothing about either. Formatted as
 * `deno fmt` formats it, since the scaffold must pass its own `fmt --check`.
 */
export const FULL_STACK_README_SECTION = (invocation: string): string => {
  const command = `\`${invocation} generate middleware <name>\` (\`src/middleware/\`)`;
  const width = command.length;
  return `## Styling and theme

Tailwind 4 runs through Vite. The neutral shadcn theme lives in \`app/app.css\`; \`app/components/ui/\`
contains the copied MIT Button and Card components. Add more with \`npx shadcn add <component>\` —
\`components.json\` already points at the app aliases. Combine Tailwind classes with \`cn\` from
shadcn's \`cn\` package, which the components import too.

The app shell has a fixed header and sidebar and one scrolling content region; navigation resets
that region. Below the medium breakpoint the sidebar becomes a horizontal navigation row. The header
toggle cycles system, light and dark and stores the preference locally. A static script is the first
child of the document head so the theme is applied before paint. If adding a CSP, allow the inline
theme script by hash or nonce. With JavaScript disabled the page renders light.

## Middleware

This project has two middleware layers. Pick by what the code needs to see.

| Layer              | Runs for                                                          | Sees                                          | ${'Add it with'.padEnd(width)} |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------------- | ${'-'.repeat(width)} |
| Kernel             | every request: health probes, API routes, static files, SSR pages | the kernel request context (\`ctx\`)            | ${command} |
| React Router route | only the SSR routes it is attached to                             | React Router's context, including the session | ${'`export const middleware = [...]` in a route module'.padEnd(width)} |

Use kernel middleware for cross-cutting concerns such as headers, auditing and rate limits. Use
route middleware for page-level rules: \`app/middleware/require-user.server.ts\` redirects a visitor
who is not signed in to \`/login\`, and puts the signed-in user on the context for the loader.
\`/products\` attaches it; export it from a layout module to guard every route in that group.

## Workspace libraries

Import workspace libraries from \`.server.ts\` modules and \`setu.config.ts\`. The SSR build leaves
their declared package names external so the server runtime resolves them through the workspace.
Client modules cannot import a Deno workspace library: the browser bundle has no Deno workspace.

## Deploying to Cloudflare Workers

\`npx wrangler deploy\` builds the client and server, then bundles the Worker. The session secret is a
Cloudflare secret, not a file: run \`npx wrangler secret put SESSION_SECRET\` once per environment
before the first deploy. Local development reads \`.dev.vars\` instead, which the scaffold creates
with a labelled-insecure development value.

Everything in \`build/client\` is served by the platform before the Worker runs, so those requests
skip the application's middleware: no security headers and no authentication apply to them. Put only
public files in \`public/\`.
`;
};
