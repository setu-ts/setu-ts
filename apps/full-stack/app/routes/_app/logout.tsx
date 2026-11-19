import { Form, redirect, useLoaderData } from 'react-router';

import { Button } from '~/components/ui/button.tsx';
import { Card, CardContent } from '~/components/ui/card.tsx';
import type { AppLoadContext } from '~/lib/load-context.ts';
import { getCsrfToken, getSession } from '~/server/session.server.ts';
import { requireUser } from '~/server/require-user.server.ts';

/** Only a signed-in visitor has anything to sign out of; others go to /login. */
export const middleware = [requireUser];

/** Hands the sign-out form its CSRF token. */
export function loader({ context }: { context: AppLoadContext }) {
  return { csrfToken: getCsrfToken(context) };
}

/**
 * Signs out. A POST, so a link or a prefetch cannot sign anyone out, and the
 * session plugin's form-CSRF check has already passed when this runs. It ends
 * the session the way the login action starts it: `clear()` drops the
 * signed-in user, and `regenerate()` gives the browser a new session id and
 * CSRF token. An application on the auth plugin's sign-in calls its session
 * service's `signOut(ctx)` from a request-bound service instead.
 */
export function action({ context }: { context: AppLoadContext }) {
  const session = getSession(context);
  session.clear();
  session.regenerate();
  return redirect('/login', 303);
}

export default function LogoutRoute() {
  const { csrfToken } = useLoaderData<typeof loader>();

  return (
    <Card>
      <CardContent className="grid gap-4">
        <h1 className="text-2xl font-semibold">Sign out</h1>
        <Form method="post" className="flex gap-3">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <Button type="submit">Sign out</Button>
        </Form>
      </CardContent>
    </Card>
  );
}
