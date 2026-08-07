import { Form, redirect, useActionData, useLoaderData } from 'react-router';

import type { AppLoadContext } from '~/lib/load-context.ts';
import { getCsrfToken, getSession } from '~/config/services.server.ts';

/**
 * Hands the form its CSRF token.
 *
 * The token comes from the session, placed on the request context by
 * `honoe.config.ts`. A progressive-enhancement `<Form>` cannot set a custom
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
 * middleware runs before this route is ever reached and answers 403 on a
 * missing or mismatched token. So this action only runs for a request that
 * already passed the check — which is what `smoke.ts` step 3 proves, by
 * observing a 302 rather than a 403.
 *
 * The session write is what makes the login stick — the plugin commits the
 * session onto the response after the handler returns, so the redirect below
 * carries the updated cookie.
 */
export async function action({ request, context }: { request: Request; context: AppLoadContext }) {
  const form = await request.formData();
  const email = String(form.get('email') ?? '');

  // Replace with a real credential check — resolve the auth service through a
  // context key, exactly as the database is resolved.
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
    <Form method='post'>
      {actionData?.error ? <p role='alert'>{actionData.error}</p> : null}
      <input type='hidden' name='_csrf' value={csrfToken} />
      <label>
        Email <input type='email' name='email' required />
      </label>
      <label>
        Password <input type='password' name='password' required />
      </label>
      <button type='submit'>Sign in</button>
    </Form>
  );
}
