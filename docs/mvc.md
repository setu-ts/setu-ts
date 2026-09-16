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
`@hono/hono/jsx`, escaped by the JSX runtime, zero client JavaScript.
`ViewPlugin({ engine: 'hono-html' })` selects the `html` tagged-template arm, which needs no
`jsxImportSource` and works in a plain `.ts` file. **Both arms require `@hono/hono` as a direct
dependency** — `deno add jsr:@hono/hono` — because neither `@hono/hono/jsx/jsx-runtime` nor
`@hono/hono/html` resolves through a transitive one; see the
[view-plugin README](https://github.com/setu-ts/setu-ts/blob/main/packages/view-plugin/README.md#installation).
The `'custom'` arm registers an application-supplied `IViewEngine` verbatim.

## The functional entry point

```tsx
import type { IRequestContext } from '@setu-ts/common';
import { renderView } from '@setu-ts/view-plugin';

const UserList = (props: { readonly users: readonly string[] }) => (
  <ul>{props.users.map((user) => <li>{user}</li>)}</ul>
);

export function usersRoute(ctx: IRequestContext) {
  return renderView(ctx, UserList, { users: ['ada', 'grace'] });
}
```

## The class-based entry point

```tsx
import { Controller, Get, Render } from '@setu-ts/decorator-plugin';
import { ViewPlugin } from '@setu-ts/view-plugin';

// JSX escapes every interpolation. A plain
// `(props) => \`<li>${user}</li>\`` template would NOT — see Escaping below.
const UserList = (props: { readonly users: readonly string[] }) => (
  <ul>{props.users.map((user) => <li>{user}</li>)}</ul>
);

@Controller('/pages')
class PagesController {
  @Render(UserList)
  @Get('/users')
  users() {
    return { users: ['ada', 'grace'] }; // the props bag — the framework answers HTML
  }
}
```

`ViewPlugin()` is already registered by the application setup above — registering it a second time
throws `Duplicate plugin name 'view-plugin'` at `start()`.

Both entry points resolve the SAME engine under `CAPABILITIES.VIEW` and answer through the same
`IResponse.html(...)` write. `@Render` type-checks the handler's return against the component's
props; a route decorated with no provider registered fails at `register()` naming the controller,
the handler and both remedies. A status code alongside a rendered body goes through `@Params(Ctx())`
— the return value IS the props bag, so `@Render` carries no `status` argument.

## Forms

A form is the reason server-rendered HTML exists, and three things about it are not obvious.

**Read forms through `formData()` — with its compatibility fallback.** `IRequest.formData?()` parses
both `application/x-www-form-urlencoded` and `multipart/form-data` into the framework's read-only
`FormBody`. All built-in request producers provide and memoize it. The accessor remains optional so
custom `IRequest` implementations do not break; when it is absent, parse the replayable bytes with
the same `parseFormBody` function and the request's public `content-type` header. That preserves the
same form semantics instead of silently treating a submitted form as empty.

**Validate with the service, not the middleware.** `validateBody(schema)` short-circuits with a
Problem Details JSON body — correct for an API, useless for a form, which needs its own page back
with the fields still filled in. `IValidationService.validate()` returns a `Result` instead of
short-circuiting, so the handler decides what to render.

**Re-render the same component, then redirect.** The rejected submission renders the form it came
from — one template, so the empty state and the error state cannot drift — and a successful one
answers `303`, so a refresh does not resubmit.

```tsx
import { CAPABILITIES, parseFormBody } from '@setu-ts/common';
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

// JSX escapes every interpolation. This component redisplays a REJECTED
// submission, so `props.values.title` is attacker-controlled by definition.
const TaskForm = (props: TaskFormProps) => (
  <form method='post' action='/tasks'>
    <input name='title' value={props.values.title} />
    {String(props.errors.title ?? '')}
  </form>
);

/** Reads both form encodings, including custom requests without `formData()`. */
async function readForm(ctx: IRequestContext): Promise<Record<string, string>> {
  const form = ctx.request.formData === undefined
    ? parseFormBody(
      await ctx.request.bytes(),
      ctx.request.headers.get('content-type'),
    )
    : await ctx.request.formData();
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
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

```tsx
import { Controller, Ctx, Get, Params, Post, Render } from '@setu-ts/decorator-plugin';
import type { HandlerResult, IRequestContext } from '@setu-ts/common';

interface TaskFormProps {
  readonly values: { readonly title: string };
  readonly errors: Readonly<Record<string, string>>;
}

const TaskForm = (props: TaskFormProps) => <form>{props.values.title}</form>;

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

function Layout(props: { readonly title: string; readonly children: Child }) {
  return (
    <html>
      <head>
        <title>{props.title}</title>
      </head>
      <body>{props.children}</body>
    </html>
  );
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

**The escaping belongs to the runtime, not to the plugin — and a plain string component therefore
gets none.** `Component<P>` is structural, so `(props) => string` is a valid component: it is the
shape a by-name engine adapts a compiled template to, and the plugin returns whatever it produced
**unchanged**. That is correct for a Handlebars or Eta template, which has already escaped its own
interpolations, and it is an **XSS hole** for a hand-written template literal:

```typescript
import { html } from '@hono/hono/html';

// UNSAFE: `name` is interpolated raw. With name = '<script>alert(1)</script>'
// this serves the script tag verbatim.
const Unsafe = (props: { readonly name: string }) => `<p>Hello, ${props.name}</p>`;

// Safe: the tag escapes the interpolation.
const Safe = (props: { readonly name: string }) => html`<p>Hello, ${props.name}</p>`;
```

Write views with JSX or the `html` tag. Reach for a plain string only when the value is already
escaped by the engine that produced it.

### Escaping protects HTML structure, not URL schemes

The one class escaping does not cover is the one that carries none of the characters the escape pass
rewrites. A `javascript:` URL needs neither `<` nor `&` nor a quote, so it survives both arms — and
the browser executes it when the link is clicked:

```typescript
// The stored value, attacker-controlled — a note's user-editable link field:
const link = 'javascript:alert(1)';

// Rendered the documented way, in either arm — <a href={link}>open</a> — the
// attribute carries the scheme verbatim, because there is nothing to escape:
//
//   <a href="javascript:alert(1)">open</a>    clicking the link executes it.
```

Escaping neutralises `<script>alert(1)</script>` in the same position because that payload is made
OF metacharacters; the scheme payload is not. The remedy therefore lives in the application, not the
view: **validate the scheme of a user-supplied URL before it reaches the view** — an allowlist as
small as `http:` and `https:` where the value enters the application — and treat every rendered URL
attribute (`href`, `src`, `action`) as untrusted until then.

This is a difference BETWEEN rendering runtimes, not a property of JSX. React's server renderer
rewrites the same attribute to
`href="javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')"`
— it neutralises the value; hono's runtime, which both arms here render through, passes it through.
A reader arriving with a correct-for-React mental model is wrong here, and nothing in this framework
will correct it for them.

**This is checked, not just asserted.** `deno task check:docs` runs
[`scripts/check-example-behaviour.ts`](../scripts/check-example-behaviour.ts), which renders every
component this repository documents — including the two above — through the framework's own renderer
twice: once with `<script>alert(1)</script>` substituted into its props, which escaping must
neutralise, and once with `javascript:alert(1)`, which must not survive into a rendered `href`,
`src` or `action`. A component whose own source routes a value through `raw()` — or spreads
`{...props}` into an element — is reported `unchecked` and fails the gate unless its own comment
carries an `UNCHECKED-EXEMPT` label naming the reason: the gate does not claim a pass for markup it
could not have delivered a payload into. A component a comment labels `UNSAFE` or `DO NOT USE` is
checked in the other direction, so the warning above fails the gate if it ever stops being true.

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

// UNCHECKED-EXEMPT: raw() wraps the module-level CLIENT constant, not a prop —
// nothing user-controlled reaches raw(), so the probe's stub hides nothing.
export const Page = () =>
  html`
    <div id="log"></div>
    <script>${raw(CLIENT)}</script>
  `;
```

The JSX arm has the identical trap in its own spelling — `<script>{CLIENT}</script>` escapes the
same way and needs the same `raw(CLIENT)`.

Take the CSP this section implies deliberately, and separately from the URL hazard above. An inline
`<script>` needs `script-src 'unsafe-inline'` — and `'unsafe-inline'` is exactly the CSP that does
NOT block a `javascript:` URL. An application that followed both pieces of advice casually would
hold the door open for the one payload a CSP with `'unsafe-inline'` cannot stop. Prefer an external
script (or a nonce- or hash-based `script-src`) when the client script can move, and keep
`script-src 'self'` — no `'unsafe-inline'` — as the defence in depth: it blocks a `javascript:`
navigation even when a value slips past validation.

## Error pages

`respond` covers what `errorHandler` catches; every responder terminal is outside it. That is the
whole rule, and `@setu-ts/exceptions`' own contract pins it — what the rule leaves uncovered in a
browser-facing application is the part worth spelling out. A mistyped URL (`404`), a logged-out user
(`401`), an authorization service that is not configured (`501`), a stale form (`403`) and a
throttled client (`429`) are all emitted by responder terminals, so each answers as Problem Details
JSON no matter what `respond` renders for the errors your own handlers throw.

The worked example — the page IS the error report, and the callback owns its status:

```tsx
import { errorHandler, statusTitle } from '@setu-ts/exceptions';
import type { HandlerResult, IRequestContext } from '@setu-ts/common';
import { renderView } from '@setu-ts/view-plugin';

interface ErrorPageProps {
  readonly status: number;
  readonly title: string;
}

const ErrorPage = (props: ErrorPageProps) => (
  <main>
    <h1>{props.status}</h1>
    <p>{props.title}</p>
  </main>
);

function wantsHtml(ctx: IRequestContext): boolean {
  return (ctx.request.headers.get('accept') ?? '').includes('text/html');
}

app.middleware.add(
  errorHandler({
    format: 'rfc9457',
    async respond(error, ctx): Promise<HandlerResult | undefined> {
      if (!wantsHtml(ctx)) return undefined; // API clients keep Problem Details
      // The callback owns the result's status, and renderView takes none —
      // without this line every branded error answers 200.
      ctx.response.status(error.statusCode);
      return await renderView(ctx, ErrorPage, {
        status: error.statusCode,
        title: statusTitle(error.statusCode),
      });
    },
  }),
  { priority: 0, name: 'error-handler' },
);
```

The hook's full contract — masking, logging, and the `undefined` fallback — is documented in
[`@setu-ts/exceptions`](../packages/exceptions/README.md).

## Health

The plugin registers a `view` health indicator reporting the selected engine. It is always `up`:
rendering is stateless and touches no backend, and a probe must not fabricate reachability it cannot
observe.

## More

- [`@setu-ts/view-plugin`](../packages/view-plugin/README.md) — options, exports and examples
- [`@setu-ts/decorator-plugin`](../packages/decorator-plugin/README.md) — the decorator surface
- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md) — the full contract
