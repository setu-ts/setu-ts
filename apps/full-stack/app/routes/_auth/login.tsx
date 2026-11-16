import { Form, redirect, useActionData, useLoaderData } from 'react-router';

import { Button } from '~/components/ui/button.tsx';
import type { AppLoadContext } from '~/lib/load-context.ts';
import { getCsrfToken, getSession } from '~/server/session.server.ts';

/**
 * Hands the form its CSRF token.
 *
 * The token comes from the session, placed on the request context by
 * `setu.config.ts`. A progressive-enhancement `<Form>` cannot set a custom
 * header, which is why the synchronizer-token strategy — not the stateless
 * Origin check — is what guards this action.
 */
export function loader({ context }: { context: AppLoadContext }) {
  // Not `?? ''`: an absent token means the wiring is broken, and a form posting
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

  // Replace with a real credential check through a request-bound module service:
  // getService(context, <TOKEN>). See auth-plugin's README, "In the full-stack template".
  if (email === '') {
    return { error: 'Email is required.' };
  }

  const session = getSession(context);
  // Rotate against session fixation before recording the signed-in user.
  session.regenerate();
  session.set('userEmail', email);

  return redirect('/products');
}

export default function LoginRoute() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <Form method="post" className="grid gap-4">
      {actionData?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {actionData.error}
        </p>
      ) : null}
      <input type="hidden" name="_csrf" value={csrfToken} />
      <label className="grid gap-2 text-sm font-medium">
        Email
        <input
          type="email"
          name="email"
          required
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 shadow-xs"
        />
      </label>
      <label className="grid gap-2 text-sm font-medium">
        Password
        <input
          type="password"
          name="password"
          required
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 shadow-xs"
        />
      </label>
      <Button type="submit">Sign in</Button>
    </Form>
  );
}
