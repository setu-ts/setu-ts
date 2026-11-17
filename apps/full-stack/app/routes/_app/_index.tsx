import { Link, useLoaderData } from 'react-router';

import { Card, CardContent } from '~/components/ui/card.tsx';
import type { AppLoadContext } from '~/lib/load-context.ts';
import { getSession } from '~/server/session.server.ts';

/** Reads the session on the server, so the greeting reflects the cookie. */
export function loader({ context }: { context: AppLoadContext }) {
  const session = getSession(context);
  return { signedInAs: session.get<string>('userEmail') ?? null };
}

export default function IndexRoute() {
  const { signedInAs } = useLoaderData<typeof loader>();

  return (
    <Card>
      <CardContent className="grid gap-4">
        <h1 className="text-2xl font-semibold">Welcome</h1>
        <p>
          A React Router application server-rendered by the kernel through{' '}
          <code className="rounded bg-muted px-1 font-mono text-sm">react-router-plugin</code>.
        </p>
        <p>
          {signedInAs === null ? (
            <>You are not signed in.</>
          ) : (
            <>
              Signed in as <strong>{signedInAs}</strong> — the session is server-authoritative and
              the cookie is HttpOnly.
            </>
          )}
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <Link to="/products" className="font-medium underline underline-offset-4">
              Products
            </Link>{' '}
            — rows read by a loader, behind a route middleware that sends you to sign in first.
          </li>
          <li>
            <Link to="/login" className="font-medium underline underline-offset-4">
              Sign in
            </Link>{' '}
            — a form guarded by the session's synchronizer CSRF token.
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}
