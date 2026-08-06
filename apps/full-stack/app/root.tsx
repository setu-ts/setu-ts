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
