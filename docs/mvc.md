# Server-Side MVC — Controllers, Views, and Rendering

Setu-TS serves server-rendered HTML as a capability, not as a framework-wide template system. A
controller answers data; a **view** is a component the application already has — a function from a
props bag to HTML — and an engine renders it to a string the framework sends with
`text/html; charset=utf-8`.

The view is named **by reference**: `@Render(UserList)`, never `@Render('users/index')`. There is no
view resolver, no views directory and no filesystem lookup, which is what makes the capability
portable to Cloudflare Workers by construction. It also makes a wrong view a compile error instead
of a runtime 500 — the property the framework's decorator surface is built on.

## Registering the engine

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ViewPlugin } from '@setu-ts/view-plugin';

const app = createApplication({
  plugins: [RuntimePlugin(), ViewPlugin()],
});

await app.start({ port: 3000 });
```

Both arm names describe the **authoring mode** — which import your components use — rather than a
rendering strategy; one engine serves both, and the selected mode is reported by the `view` health
indicator. `ViewPlugin()` defaults to the `'hono-jsx'` arm — components authored with
`@hono/hono/jsx`, escaped by default, zero client JavaScript. `ViewPlugin({ engine: 'hono-html' })`
selects the `html` tagged-template arm, which needs no `jsxImportSource` and works in a plain `.ts`
file. The `'custom'` arm registers an application-supplied `IViewEngine` verbatim.

## The functional entry point

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

## The class-based entry point

```typescript
import { Controller, Get, Render } from '@setu-ts/decorator-plugin';
import { ViewPlugin } from '@setu-ts/view-plugin';

const UserList = (props: { readonly users: readonly string[] }) =>
  `<ul>${props.users.map((user) => `<li>${user}</li>`).join('')}</ul>`;

@Controller('/pages')
class PagesController {
  @Render(UserList)
  @Get('/users')
  users() {
    return { users: ['ada', 'grace'] }; // the props bag — the framework answers HTML
  }
}

app.register(ViewPlugin());
```

Both entry points resolve the SAME engine under `CAPABILITIES.VIEW` and answer through the same
`IResponse.html(...)` write. `@Render` type-checks the handler's return against the component's
props; a route decorated with no provider registered fails at `register()` naming the controller,
the handler and both remedies. A status code alongside a rendered body goes through `@Params(Ctx())`
— the return value IS the props bag, so `@Render` carries no `status` argument.

## Rendered output is buffered

`IViewEngine.render` answers `string | Promise<string>` — rendering buffers before send and never
returns a stream. That is a decision, not an omission, and it is why a pending `<Suspense>` boundary
is **refused by name** (`UnresolvedSuspenseError`) instead of served: buffered rendering of a
`<Suspense>` tree emits only the fallback, with a `200` and no error — a loading placeholder served
forever. Streaming resolution needs an injected client script that swaps the content in, which
forfeits the zero-client-JS property the default arm is built on; it is deferred to a follow-up
milestone rather than shipped as a silent default. An async component WITHOUT `<Suspense>` renders
clean — only the boundary is refused.

## Layouts are components taking `children`

A layout is an ordinary component that accepts `children`:

```tsx
import type { Child } from '@hono/hono/jsx';
import { html } from '@hono/hono/html';

function Layout(props: { readonly title: string; readonly children: Child }) {
  return html`
    <html>
      <head>
        <title>${props.title}</title>
      </head>
      <body>${props.children}</body>
    </html>
  `;
}

export { Layout };
```

There is deliberately no plugin-level `layout` option. Such an option would wrap EVERY render —
including the fragments and partial responses `IResponse.html` already serves to HTMX-style callers,
where a full document is the wrong answer — and a page wanting no layout would then need an opt-out,
which is more surface than the composition it replaces. Compose explicitly instead: wrap the child
component in the layout at the call site.

## A by-name engine adapts; the port stays by reference

The port carries exactly one method. A string-named engine (Handlebars, Eta) participates through
the `'custom'` arm by adapting each compiled template to a `(props) => string` function — which is
already a `Component<P>`:

```typescript
import type { IViewEngine } from '@setu-ts/common';
import { ViewPlugin } from '@setu-ts/view-plugin';

const engine: IViewEngine = {
  render: (component, props) => String(component(props)), // component(props) → template output
};

app.register(ViewPlugin({ engine: 'custom', view: engine }));
```

## Escaping

Interpolations are escaped by the rendering runtime in both default arms; the one opt-out is hono's
own `raw()`, re-exported from `@setu-ts/view-plugin` so an application does not import hono
directly. No escaping logic lives in the plugin, so the two arms cannot disagree about it.

## Health

The plugin registers a `view` health indicator reporting the selected engine. It is always `up`:
rendering is stateless and touches no backend, and a probe must not fabricate reachability it cannot
observe.

## More

- [`@setu-ts/view-plugin`](../packages/view-plugin/README.md) — options, exports and examples
- [`@setu-ts/decorator-plugin`](../packages/decorator-plugin/README.md) — the decorator surface
- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md) — the full contract
