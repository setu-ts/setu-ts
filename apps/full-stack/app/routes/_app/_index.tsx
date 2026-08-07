import { Link, useLoaderData } from 'react-router';

import type { AppLoadContext } from '~/lib/load-context.ts';
import { getSession } from '~/config/services.server.ts';

/**
 * The landing page.
 *
 * This route exists because without it `/` matches a `layout()` with no child:
 * `<Outlet />` renders nothing, and the server answers 200 with an empty
 * document — a blank page, which is what the first person to open this example
 * actually saw. `smoke.ts` now requests `/` for that reason.
 *
 * It also reads the session, so the landing page demonstrates a second
 * capability rather than being decoration: sign in on /login and the greeting
 * changes, because the session cookie survives the redirect.
 */
export function loader({ context }: { context: AppLoadContext }) {
  const session = getSession(context);
  return { signedInAs: session.get<string>('userEmail') ?? null };
}

export default function IndexRoute() {
  const { signedInAs } = useLoaderData<typeof loader>();

  return (
    <section>
      <h1>Setu-TS — full-stack example</h1>
      <p>
        A React Router 8 application server-rendered by the kernel through{' '}
        <code>react-router-plugin</code>, composed with <code>createFullStackAppFromConfig</code>.
      </p>
      <p>
        {signedInAs === null ? <>You are not signed in.</> : (
          <>
            Signed in as <strong>{signedInAs}</strong>{' '}
            — the session is server-authoritative and the cookie is HttpOnly.
          </>
        )}
      </p>
      <ul>
        <li>
          <Link to='/products'>Products</Link>{' '}
          — rows written through the database capability and read back by a loader, so the page is
          evidence the load-context bridge works.
        </li>
        <li>
          <Link to='/login'>Sign in</Link>{' '}
          — a progressive-enhancement form guarded by the session's synchronizer CSRF token.
        </li>
      </ul>
    </section>
  );
}
