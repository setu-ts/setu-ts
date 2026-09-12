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

## Forms

A form is the reason server-rendered HTML exists, and three things about it are not obvious.

**There is no `formData()`.** `IRequest` exposes `json()`, `text()` and `bytes()`, so an
`application/x-www-form-urlencoded` body is read as text and parsed with the web-standard
`URLSearchParams` — the same route `session-plugin`'s CSRF verifier takes. The runtime pre-reads the
body into a buffer, so `text()` is replayable and a later reader still sees it.

**Validate with the service, not the middleware.** `validateBody(schema)` short-circuits with a
Problem Details JSON body — correct for an API, useless for a form, which needs its own page back
with the fields still filled in. `IValidationService.validate()` returns a `Result` instead of
short-circuiting, so the handler decides what to render.

**Re-render the same component, then redirect.** The rejected submission renders the form it came
from — one template, so the empty state and the error state cannot drift — and a successful one
answers `303`, so a refresh does not resubmit.

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IRequestContext, IValidationService, ValidationIssue } from '@setu-ts/common';
import { renderView } from '@setu-ts/view-plugin';
import { z } from 'zod';

const TaskSchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters'),
});

interface TaskFormProps {
  readonly values: { readonly title: string };
  readonly errors: Readonly<Record<string, string>>;
}

const TaskForm = (props: TaskFormProps) =>
  `<form method="post" action="/tasks">
     <input name="title" value="${props.values.title}" />
     ${props.errors.title ?? ''}
   </form>`;

/** `IRequest` has no `formData()` — read the body as text and parse it. */
async function readForm(ctx: IRequestContext): Promise<Record<string, string>> {
  const params = new URLSearchParams(await ctx.request.text());
  const out: Record<string, string> = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

function firstMessagePerField(issues: readonly ValidationIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) if (out[issue.path] === undefined) out[issue.path] = issue.message;
  return out;
}

export async function submit(ctx: IRequestContext) {
  const form = await readForm(ctx);
  const validation = ctx.services.get<IValidationService>(CAPABILITIES.VALIDATION);
  const result = validation.validate<{ title: string }>(TaskSchema, form);

  if (!result.success) {
    ctx.response.status(422); // unprocessable — and the page IS the error report
    return await renderView(ctx, TaskForm, {
      values: { title: form.title ?? '' },
      errors: firstMessagePerField(result.error),
    });
  }

  return ctx.response.redirect('/tasks', 303); // POST-redirect-GET
}
```

### A rendered route may redirect

A `@Render` handler returns its props bag — but it may also return a `HandlerResult` from
`ctx.response`, which is what makes POST-redirect-GET expressible on a decorated route. The redirect
short-circuits before the view runs, so no HTML body is produced. `HandlerResult` is branded, so
widening the return union costs no type safety: a props bag of the wrong shape is still a compile
error.

```typescript
import { Controller, Ctx, Get, Params, Post, Render } from '@setu-ts/decorator-plugin';
import type { HandlerResult, IRequestContext } from '@setu-ts/common';

interface TaskFormProps {
  readonly values: { readonly title: string };
  readonly errors: Readonly<Record<string, string>>;
}

const TaskForm = (props: TaskFormProps) => `<form>${props.values.title}</form>`;

@Controller('/tasks')
class TasksController {
  @Render(TaskForm)
  @Get('/new')
  blank(): TaskFormProps {
    return { values: { title: '' }, errors: {} };
  }

  @Render(TaskForm)
  @Params(Ctx())
  @Post('/')
  create(ctx: IRequestContext): TaskFormProps | HandlerResult {
    const accepted = ctx.request.method === 'POST';
    return accepted
      ? ctx.response.redirect('/tasks', 303)
      : { values: { title: '' }, errors: { title: 'Title must be at least 3 characters' } };
  }
}

export { TasksController };
```

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

### An inline `<script>` must use `raw()`

Escaping applies to every interpolation, including the body of a `<script>` element. A client script
interpolated plainly is emitted with `&#39;` for each quote and `&lt;` for each `<` — valid HTML,
and a `SyntaxError` in the browser. The script never runs and nothing reports why, so any page that
opens an `EventSource` or a `WebSocket` needs the opt-out:

```typescript
import { html } from '@hono/hono/html';
import { raw } from '@setu-ts/view-plugin';

const CLIENT = `const es = new EventSource('/events');
es.onmessage = (e) => { if (e.data < '9') console.log(e.data); };`;

export const Page = () =>
  html`
    <div id="log"></div>
    <script>${raw(CLIENT)}</script>
  `;
```

The JSX arm has the identical trap in its own spelling — `<script>{CLIENT}</script>` escapes the
same way and needs the same `raw(CLIENT)`.

## Health

The plugin registers a `view` health indicator reporting the selected engine. It is always `up`:
rendering is stateless and touches no backend, and a probe must not fabricate reachability it cannot
observe.

## More

- [`@setu-ts/view-plugin`](../packages/view-plugin/README.md) — options, exports and examples
- [`@setu-ts/decorator-plugin`](../packages/decorator-plugin/README.md) — the decorator surface
- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md) — the full contract
