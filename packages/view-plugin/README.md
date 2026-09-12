# @setu-ts/view-plugin

Server-rendered HTML as a capability: register a view engine, name a component, answer with markup
the application did not concatenate by hand.

## Overview

- Views are named **by reference** — a component the application already has, never a path. There is
  no view resolver, no views directory, and no filesystem lookup, which is what makes the capability
  Workers-portable by construction.
- Two zero-new-dependency arms: `'hono-jsx'` (default, JSX components) and `'hono-html'` (the `html`
  tagged template, usable in a plain `.ts` file), plus a `'custom'` arm for any engine that adapts
  its templates to `Component<P>` functions.
- Two entry points, one implementation: `@Render(Component)` for the class-based style, the free
  `renderView(ctx, Component, props)` for the functional default. Both resolve the SAME engine under
  `CAPABILITIES.VIEW` and answer through `IResponse.html(...)` (`text/html; charset=utf-8`).

## Installation

```bash
deno add jsr:@setu-ts/view-plugin
```

## Usage

Register the plugin, then render from a route:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ViewPlugin } from '@setu-ts/view-plugin';

const app = createApplication({
  plugins: [RuntimePlugin(), ViewPlugin()],
});

await app.start({ port: 3000 });
```

A functional route renders a component and answers HTML:

```tsx
import type { IRequestContext } from '@setu-ts/common';
import { html } from '@hono/hono/html';
import { renderView } from '@setu-ts/view-plugin';

const UserList = (props: { readonly users: readonly string[] }) =>
  html`<ul>${props.users.map((user) => html`<li>${user}</li>`)}</ul>`;

export function usersRoute(ctx: IRequestContext) {
  return renderView(ctx, UserList, { users: ['ada', 'grace'] });
}
```

The class-based style attaches the component to the route; the handler returns the component's
PROPS, and the framework answers with the rendered markup — never JSON:

```typescript
import { Controller, Get, Render } from '@setu-ts/decorator-plugin';

const UserList = (props: { readonly users: readonly string[] }) =>
  `<ul>${props.users.map((user) => `<li>${user}</li>`).join('')}</ul>`;

@Controller('/pages')
class PagesController {
  @Render(UserList)
  @Get('/users')
  users() {
    return { users: ['ada', 'grace'] };
  }
}
```

`@Render` type-checks the handler's return against the component's props: a wrong props bag is a
compile error naming the mismatch — strictly stronger than a by-name template checked against
nothing. A rendered route whose application registers no `CAPABILITIES.VIEW` provider fails at
`register()`, naming the controller, the handler and both remedies. The check is per route, so an
application with no rendered route needs no view plugin.

## Options

`ViewPluginOptions` is a union discriminated on `engine`, so a missing per-arm field is a compile
error rather than a startup throw:

| Option   | Type          | Default      | Description                                                                               |
| -------- | ------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `engine` | `'hono-jsx'`  | `'hono-jsx'` | Components are JSX functions. The application manifest declares `jsx` / `jsxImportSource` |
| `engine` | `'hono-html'` | —            | Components return an `html` tagged template; works in a plain `.ts` file                  |
| `engine` | `'custom'`    | —            | Requires `view`; the supplied engine is registered verbatim                               |
| `view`   | `IViewEngine` | —            | `'custom'` arm only — the application's own engine                                        |

## Escaping

Escaping is ON by default through both arms, and no escaping logic lives in this package — the JSX
runtime and the `html` tagged template do it. The documented opt-out is hono's own `raw()`,
re-exported from this package's barrel so an application does not import hono directly:

```typescript
import { html } from '@hono/hono/html';
import { raw } from '@setu-ts/view-plugin';

const Snippet = (props: { readonly markup: string }) => html`<div>${raw(props.markup)}</div>`;
```

## Suspense is refused, not served as a fallback

Rendering buffers to a string. A tree holding a pending `<Suspense>` boundary would silently serve
only the fallback — with a `200` and no error — so the engine refuses it by name with
`UnresolvedSuspenseError`, pointing at the deferred streaming milestone. An async component WITHOUT
`Suspense` renders clean; only the boundary is refused. The remedy today is to move the boundary out
of the rendered tree.

## Layouts are components

A layout is an ordinary component taking `children`. There is deliberately no plugin-level `layout`
option: it would wrap every render, including the HTMX-style fragments and partial responses
`IResponse.html` already serves, where a full document is the wrong answer.

## Health Indicator

The plugin registers a `view` indicator reporting the selected engine. It is always `up` — rendering
is stateless and touches no backend, and a probe must not fabricate reachability it cannot observe.

## Exports

| Export                    | Kind     |
| ------------------------- | -------- |
| `raw`                     | function |
| `renderView`              | function |
| `ViewPlugin`              | function |
| `UnresolvedSuspenseError` | class    |
| `ViewRenderError`         | class    |
| `ViewPluginOptions`       | type     |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#view-plugin-setu-tsview-plugin).
