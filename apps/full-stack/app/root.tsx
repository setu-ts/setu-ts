import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from 'react-router';

import './app.css';

/**
 * The document shell. Everything the browser needs before hydration.
 */
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang='en'>
      <head>
        <meta charSet='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
        {
          /*
          An inline icon, so the browser never requests /favicon.ico. That path
          would reach the SSR catch-all, match no route, and answer 404 — the
          framework's asset handler serves /assets/ only. Harmless, but it puts
          an error in the console of an example meant to be read and run.
        */
        }
        <link
          rel='icon'
          href='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Ctext y=%2214%22 font-size=%2214%22%3E%F0%9F%94%B7%3C/text%3E%3C/svg%3E'
        />
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
 * Renders the status a thrown `Response` carries; anything else is an
 * unexpected failure. The framework's error-handler middleware still formats
 * errors for non-SSR routes — this covers what React Router throws.
 */
export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <main className='error'>
        <h1>{error.status}</h1>
        <p>{error.statusText}</p>
      </main>
    );
  }

  return (
    <main className='error'>
      <h1>Something went wrong</h1>
    </main>
  );
}
