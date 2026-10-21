# @setu-ts/view-plugin — server-rendered HTML as a capability

`setu add view` adds the dependency and inserts `ViewPlugin()` — the default `'hono-jsx'` arm. It
registers `CAPABILITIES.VIEW`. Declare `hono` directly; for JSX also set `jsx: 'react-jsx'` and
`jsxImportSource: 'hono/jsx'` in the application manifest.

```ts
import { ViewPlugin } from '@setu-ts/view-plugin';

export const views = ViewPlugin({ engine: 'hono-html' });
```

```ts
import { html } from 'hono/html';
import type { IRequestContext } from '@setu-ts/common';
import { renderView } from '@setu-ts/view-plugin';

const UserList = (props: { readonly users: readonly string[] }) =>
  html`<ul>${props.users.map((user) => html`<li>${user}</li>`)}</ul>`;

export function usersRoute(context: IRequestContext) {
  return renderView(context, UserList, { users: ['ada', 'grace'] });
}
```

- `engine` is `'hono-jsx'` (default), `'hono-html'` (the `html` tagged template, usable in a plain
  `.ts` file) or `'custom'` with a `view` engine implementing `IViewEngine`. The arm names the
  authoring mode, not the renderer — both default arms escape through hono.
- `renderView(ctx, Component, props)` answers `text/html; charset=utf-8`. In the class-based style,
  `@Render` from `@setu-ts/decorator-plugin` puts the component on a route and type-checks the props
  bag a handler returns.
- Escaping is the runtime's: JSX and the `html` tag escape, a plain string component is returned
  unchanged. `raw(markup)` is the explicit opt-out — never build markup by concatenation.
- `null`, `false`, `true` and `''` render empty; `undefined` throws `ViewRenderError`, usually a
  missing return. A pending Suspense boundary throws `UnresolvedSuspenseError`.
- Layouts are ordinary components taking `children`; there is no plugin-level `layout` option.
