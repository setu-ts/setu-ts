/**
 * JSX fixture for the view engine tests. Carries NO `jsx` pragma on purpose:
 * if the package manifest's `jsx` / `jsxImportSource` keys are wrong or
 * dropped, this file fails `deno check` loudly instead of silently falling
 * back to a per-file setting (M92 §3.11).
 *
 * @module
 */
import type { Child } from '@hono/hono/jsx';

/**
 * A layout is an ordinary component taking `children` — no plugin-level
 * layout option exists (M92 §3.4).
 *
 * @param props - Title and the page body
 * @returns The document shell
 */
export function Layout(props: { readonly title: string; readonly children: Child }) {
  return (
    <html>
      <head>
        <title>{props.title}</title>
      </head>
      <body>{props.children}</body>
    </html>
  );
}

/**
 * A list page whose interpolations must arrive escaped.
 *
 * @param props - The users to list
 * @returns The list markup
 */
export function UserList(props: { readonly users: readonly string[] }) {
  return (
    <ul>
      {props.users.map((user) => <li key={user}>{user}</li>)}
    </ul>
  );
}
