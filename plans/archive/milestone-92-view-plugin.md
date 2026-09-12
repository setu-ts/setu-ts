# Milestone 92 — View Plugin (`@setu-ts/view-plugin`)

> **Status:** Planning. Branch: `feat/m92-view-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Give a controller a way to answer with HTML it did not concatenate by hand. The framework can serve
a React SPA with SSR (`react-router-plugin`, M44) and can return a string (`IResponse.html`, M70n),
and has nothing in between — so `@Render('index')` with a view engine, the chapter every server-side
MVC framework has, has no answer here. `CAPABILITIES` declares no `VIEW` token, no package ships a
view engine, and `static-plugin`'s own scope note disclaims one (`ROADMAP.md:6048`). This milestone
adds the port, one plugin serving it over two zero-new-dependency backends, and the two entry points
that reach it — a decorator for the class-based world and a free function for the functional one,
which has been the generator default since M65.

- **In scope:** `CAPABILITIES.VIEW` + `IViewEngine` + `Component<P>` in `common`; a new
  `packages/view-plugin` with `'hono-jsx'`, `'hono-html'` and `'custom'` arms, a `view` health
  indicator and no `onClose`; `@Render(Component)` in `decorator-plugin` with its
  `optionalDependencies` edge; the free `renderView(ctx, Component, props)`; the release-list entry
  taking `release:verify` from 47 publishable packages to 48; `docs/mvc.md`, a
  `docs/migration-nestjs.md` section, and the snippet-harness enablement without which no JSX
  example in the repository can be gated.
- **NOT this milestone:** a Handlebars arm and an HTMX integration (deferred past 1.0 by maintainer
  decision, recorded in the ROADMAP section); streaming `Suspense` resolution (§3.5, owner named in
  §9); a `setu g view` schematic (§9); template-file loading from disk (§9).

## 1. Contracts verified from SOURCE (not names)

Every row was opened and read on this branch. The four probe rows re-establish ROADMAP claims rather
than inheriting them, per CLAUDE.md; two of the probes changed the design (§3.2, §3.3).

| Reference                                           | Source (file:line)                                                 | Verified surface / fact                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES` has no view token                    | `packages/common/src/tokens.ts:140`                                | Last entry is `STATIC_FILES: 'static-files'`; no `VIEW`, no `TEMPLATE`. The gap is real.                                                                                                                                                                                                                        |
| Token grammar admits `'view'`                       | `packages/common/src/tokens.ts:161`                                | `TOKEN_SEGMENT = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*'`; `'view'` matches. Colons illegal, not used.                                                                                                                                                                                                                  |
| `IResponse.html(body: string)`                      | `packages/common/src/http.ts:206`                                  | Takes a primitive `string`, sets `text/html; charset=utf-8` explicitly. Returns `HandlerResult`.                                                                                                                                                                                                                |
| `IRequestContext.services`                          | `packages/common/src/http.ts:277`                                  | An `IServiceRegistry` is on the request context, so the free entry point can resolve per request.                                                                                                                                                                                                               |
| `createHandler` result branch                       | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:325-342` | `isHandlerResult(result)` passes through at :338; otherwise `ctx.response.json(result)` at :341. Render is a third branch, not a rewrite.                                                                                                                                                                       |
| `optionalDependencies` today                        | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:801`     | `[CAPABILITIES.VALIDATION, CAPABILITIES.AUTHORIZATION]`, with the comment at :798-800 stating the edge is what makes register-time resolution a contract rather than priority luck.                                                                                                                             |
| Register-time capability read                       | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:814-816` | `ctx.services.has(...)` then `ctx.services.get<T>(...)`, resolved once per application start. `@Render` follows this shape.                                                                                                                                                                                     |
| `@ValidateBody` absent-provider policy              | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:542-570` | It **warns**, and its JSDoc names the reason (M64 precedent: a released inert decorator). `@Render` diverges deliberately — see §3.8.                                                                                                                                                                           |
| `RouteMetadata` / `MethodMeta`                      | `packages/decorator-plugin/src/metadata/metadata-store.ts:156-220` | Optional per-route fields (`isPublic?`, `roles?`, `permissions?`) on the readonly view and mutable twins on the accumulator. `view?` follows exactly.                                                                                                                                                           |
| `methodDecorator` helper                            | `packages/decorator-plugin/src/metadata/context-bridge.ts:113-130` | Standard-decorator deferral: writes are deferred onto `context.metadata` and drained by the class decorator. Returns `SetuMethodDecorator = (value: unknown, ctx) => void`.                                                                                                                                     |
| `decorator-plugin` dependencies                     | `packages/decorator-plugin/deno.json`                              | `imports` is exactly `{"@setu-ts/common": "jsr:@setu-ts/common@^0.5.0"}`. It must not gain `@hono/hono` (§3.12).                                                                                                                                                                                                |
| Plugin dependency edges                             | `packages/kernel/src/registry/plugin-resolver.ts:38-55`            | Both `dependencies` and `optionalDependencies` create real graph edges fed to `topologicalSort`. A cycle throws. Acyclicity re-established in §3.9.                                                                                                                                                             |
| `consumes` is not an ordering edge                  | `packages/kernel/src/registry/plugin-resolver.ts:78-105`           | `findUnsatisfiedConsumers` produces a startup diagnostic only. Ordering needs `optionalDependencies`, which is why §3.9 uses it.                                                                                                                                                                                |
| Hono already resolved                               | `packages/kernel/deno.json:8`, `deno.lock:4-5`                     | `jsr:@hono/hono@^4.12.30` resolves to `4.13.0`. Both default arms add no new third-party package to the resolution set.                                                                                                                                                                                         |
| Root manifest shape                                 | `deno.json`                                                        | `imports` carries only `@std/*`, so a member does not inherit `@hono/hono`; `workspace` is an explicit 47-entry list, so it gains an entry. Both are plan work, not free.                                                                                                                                       |
| Release tiers                                       | `scripts/release-packages.ts:33-69`                                | Tier 4 is alphabetical; `view-plugin` sits between `validation-plugin` and `websocket-plugin`. `scripts/verify-release.ts:128` fails any member in neither list.                                                                                                                                                |
| README fence gate                                   | `test/package-readme-fence-compiler.test.ts:55-84`                 | An explicit allowlist of README paths with pinned fence counts. `decorator-plugin/README.md` is pinned at 3 and will change.                                                                                                                                                                                    |
| Snippet harness                                     | `test/fixtures/snippets/deno.json`                                 | No `jsx` key and no `@hono/hono` import. See the probe row below.                                                                                                                                                                                                                                               |
| `mail-plugin` template engine                       | `packages/mail-plugin/src/templates/template-engine.ts` (94 lines) | `{{ variable }}` substitution for email bodies; not a capability, not reachable from a handler. It is not a candidate backend.                                                                                                                                                                                  |
| **Probe** — JSX renders escaped                     | measured, `@hono/hono@4.13.0`                                      | `<ul>{users.map(u => <li>{u}</li>)}</ul>` with `'Ada <script>'` gives `<li>Ada &lt;script&gt;</li>`. Escaped by default, zero client JS, no `new Function`.                                                                                                                                                     |
| **Probe** — `toString()`'s type lies                | measured                                                           | `JSXNode.toString()` is statically typed `string`, and returns a **`Promise`** at runtime whenever the tree holds an async component. `const s: string = node.toString()` type-checks and is a Promise. Drives §3.2.                                                                                            |
| **Probe** — awaited shape diverges                  | measured                                                           | Sync tree awaits to a primitive `string`; async tree awaits to a **boxed `String` object** (`typeof === 'object'`, `constructor.name === 'String'`). Drives §3.2.                                                                                                                                               |
| **Probe** — buffered `Suspense` serves the fallback | measured                                                           | `<Suspense fallback={<p>wait</p>}>` buffered gives `<template id="H:0"></template><p>wait</p><!--/$-->`; the real content never appears. Drives §3.3.                                                                                                                                                           |
| **Probe** — the refusal signal is typed and exact   | measured                                                           | `HtmlEscapedString` from `@hono/hono/utils/html` declares `callbacks` and `isEscaped` (`deno check` clean). Sync tree: no `callbacks`. Async without `Suspense`: `callbacks.length === 0`. Pending `Suspense`: `callbacks.length === 1`. `html` with an async interpolation: `length === 0`. No false positive. |
| **Probe** — `@Render` checks props                  | measured                                                           | A `void`-returning decorator whose `value` parameter is `(...args: never[]) => P \| Promise<P>` accepts correct sync, async and parameterised handlers, and rejects wrong props with `TS1241` naming the exact mismatch. `methodDecorator()`'s return assigns to it with **no cast**.                           |
| **Probe** — member `compilerOptions` merge          | measured                                                           | A member declaring only `{jsx, jsxImportSource}` still fails on the root's `exactOptionalPropertyTypes`. Root options are **not** replaced. This settles the M63-D3 mechanism question (as corrected by M90h) for the JSX case.                                                                                 |
| **Probe** — `.tsx` is under the gates               | measured                                                           | `deno check packages` walks the **directory** and reports an error in an unimported `.tsx`; `deno fmt --check` and `deno lint` both cover `.tsx` with no config change. JSR slow-type linting fires on an exported component with no explicit return type.                                                      |
| **Probe** — no `tsx` fence exists yet               | measured                                                           | ``grep -rln '```tsx'`` over every package README, every guide and the root README returns nothing, and a `.tsx` file in the snippet harness fails `TS7026` + `TS2874` ("requires 'React' to be in scope"). Drives §3.16.                                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                         | Resolution (picked side)                                                                                                                                                                                                        | Doc deliverable (same PR)                                                                                       |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| C1 | The ROADMAP section names the free entry point `render(ctx, Component, props)`. `render` is the single most collided identifier in this space (`react-dom`, `hono/jsx/dom`, testing libraries), and a full-stack application may register `react-router-plugin` and `view-plugin` together and import from both. | Ship it as **`renderView`**. A deliberate, narrow deviation from the committed section, taken for import-site clarity; the signature and the shared implementation are exactly as the section specifies.                        | ROADMAP M92 deliverable bullet updated to `renderView`, with the reason in one clause.                          |
| C2 | The ROADMAP's open question 3 leaves streaming open between "may return a `ReadableStream`" and "buffers to a string and says so". §1's probes show buffering a `Suspense` tree silently serves the fallback, so "buffer and say so" alone ships a silent wrong answer.                                          | Buffer, **and refuse** a tree with pending `Suspense` by name (§3.3). Streaming is deferred with an owner.                                                                                                                      | ROADMAP open question 3 replaced by the resolved decision; `docs/mvc.md` states the refusal and the reason.     |
| C3 | The ROADMAP's open question 1 asks whether a by-name engine needs a second port method. `Component<P>` is structurally `(props: P) => unknown`, and a compiled template `(props) => string` satisfies it (probed in §1). A second method would have no reader on merge.                                          | The port stays **by reference only**; a by-name engine adapts each template to a `Component<P>`. No second method, which §4's dead-surface rule forbids anyway.                                                                 | ROADMAP open question 1 replaced by the resolved decision; `docs/mvc.md` shows the adapter shape in four lines. |
| C4 | The ROADMAP's open question 2 prefers layouts-as-components but does not refuse the plugin-level `layout` option.                                                                                                                                                                                                | Layouts are components taking `children` (probed working, escaping preserved). A plugin-level `layout` option is **refused**: it would wrap every render including HTMX fragments and partials, where a full document is wrong. | ROADMAP open question 2 replaced by the resolved decision plus the explicit refusal.                            |
| C5 | `docs/migration-nestjs.md` mentions views nowhere, so a migrating reader discovers the absence by writing a controller. Half the finding is the missing chapter.                                                                                                                                                 | Add a Views section covering `@Render`, the by-reference divergence, and the `@Ctx()` route to a status code.                                                                                                                   | `docs/migration-nestjs.md` Views section; new `docs/mvc.md`.                                                    |

## 3. Design decisions

### 3.1 The port shape

- **Decision:**
  `IViewEngine.render<P>(component: Component<P>, props: P): string | Promise<string>`, with
  `Component<P> = (props: P) => unknown` — both in `packages/common/src/services/view.ts`,
  re-exported from the barrel, under `CAPABILITIES.VIEW = 'view'`.
- **Why:** By reference, so there is no view resolver, no views directory and no filesystem lookup —
  which is what makes the capability Workers-portable by construction. `Component<P>` lands in
  `common` because `decorator-plugin` must name it to type `@Render`'s parameter and §2.2 forbids it
  importing `view-plugin`; a copy on each side would be two declarations of one public contract,
  free to drift. The return is a union because §1 proves an async component's render genuinely is a
  promise — the async arm is required, not speculative. `unknown` as the component's return keeps
  one type covering a `JSXNode`, an `HtmlEscapedString` and a plain `(props) => string`.
- **Test home:** `packages/common/test/unit/view-contract.test.ts` (type-level assignability of all
  three component shapes); `packages/view-plugin/test/unit/view-engine-jsx.test.ts`.

### 3.2 Rendered-value normalization — the static type lies

- **Decision:** One internal `normalizeRendered(value: unknown): Promise<string>` owns the whole
  conversion, and every arm funnels through it. It awaits the component's own return, awaits the
  node's `toString()`, and returns `String(...)` of the result. The `await` and the `String(...)`
  are both load-bearing and each gets its own test.
- **Why:** §1 measured that `JSXNode.toString()` is typed `string` and returns a `Promise` at
  runtime for any tree holding an async component, and that the awaited value is a **boxed `String`
  object** rather than a primitive. So the obvious implementation — the one the type invites,
  `ctx.response.html(node.toString())` — type-checks, passes every test written with sync
  components, and emits the literal text `[object Promise]` to the browser for exactly the case the
  port's `Promise<string>` arm exists to serve. Dropping the `String(...)` instead hands
  `IResponse.html(body: string)` (`common/src/http.ts:206`) an object, and any consumer testing
  `typeof x === 'string'` gets `false` for async renders only. This is the milestone's likeliest
  silent defect and it is invisible to the type-checker.
- **Test home:** `packages/view-plugin/test/unit/normalize.test.ts` — a sync component, an async
  component, and a component whose tree nests an async child, each asserting the result is a
  **primitive** string (`typeof === 'string'`) and that the text never contains `object Promise`.

**Correction (post-review).** As first written this decision covered only the promise and
boxed-String traps, and handed every non-nullish value to `String(...)` — so a component whose
top-level return was `false` served the four-character body `false` under a `200`. That is the most
common conditional idiom in JSX (`(p) => p.show && <Banner/>`), and the same component nested inside
a parent rendered as nothing, so the framework contradicted its own rendering runtime at the top
level and did so inconsistently (`null` threw while `false` printed). Measured against
`@hono/hono@4.13.0`: as a CHILD, `false` / `true` / `null` / `undefined` / `''` all render as
nothing while `0` and `NaN` render their text. `normalizeRendered` now answers `''` for `null`,
`false` and `true`, with `undefined` the one deliberate exception — it is almost always a missing
`return`, so keeping it a named refusal preserves the mistake-catcher §3.18 was reaching for. Pinned
by `falsy-returns.test.ts`, whose negative control fails 5 of 8 steps with the rule removed while
the three deliberate controls (truthy branch, `0`, `undefined`) still pass.

### 3.3 Pending `Suspense` is refused by name, never served as the fallback

- **Decision:** After normalization, if the awaited value carries `callbacks` with `length > 0`, the
  engine throws the exported `UnresolvedSuspenseError`, naming the component and pointing at the
  deferred streaming milestone. Detection reads the declared `HtmlEscapedString.callbacks` from
  `@hono/hono/utils/html`, not an internal.
- **Why:** §1 measured that a buffered `Suspense` boundary renders the **fallback** and drops the
  real content, with no error and a 200 — a loading placeholder served forever. Streaming does
  resolve it, but via an injected client `<script>` that swaps the template, which forfeits the
  zero-client-JS property the default arm is built on; that trade belongs to its own milestone, not
  to a silent default here. The signal discriminates exactly: a sync tree has no `callbacks` at all,
  an async tree without `Suspense` has `length === 0`, and `html` with an async interpolation also
  has `length === 0` — so there is no false positive, which is what makes refusing safe.
- **Test home:** `packages/view-plugin/test/unit/suspense-refusal.test.ts` — a pending `Suspense`
  tree throws; and the three measured non-`Suspense` shapes each render clean, which is the negative
  control that stops the refusal over-firing.

### 3.4 Layouts are components taking children

- **Decision:** A layout is an ordinary component accepting `children`. No plugin-level `layout`
  option; the refusal is explicit in `docs/mvc.md` and in `ViewPluginOptions`' JSDoc.
- **Why:** Zero new surface, and §1 measured it working with escaping preserved. A plugin-level
  option would wrap **every** render, including the HTMX fragments and partial responses that
  `IResponse.html` already serves today, where a full document is the wrong answer — and a page that
  wants no layout would then need an opt-out, which is more surface than the composition it
  replaces.
- **Test home:** `packages/view-plugin/test/unit/view-engine-jsx.test.ts` — a page composing a
  layout renders one document with the child's content escaped.

### 3.5 The first cut buffers; `render` does not return a stream

- **Decision:** `IViewEngine.render` returns `string | Promise<string>` and nothing else. Wiring
  `IResponse.stream()` (M42) is deferred, with the owner named in §9.
- **Why:** Streaming is only worth having for `Suspense`, which §3.3 refuses for a stated reason, so
  adding a stream arm now would be a return type no arm produces — dead surface under §4. Widening
  the union later is source-compatible for callers.
- **Test home:** `packages/common/test/unit/view-contract.test.ts` pins the union, so widening it
  later is a deliberate edit.

### 3.6 A by-name engine adapts to `Component<P>`; the port gains no second method

- **Decision:** The deferred Handlebars-style arm wraps each compiled template as a
  `(props) => string`, which is already a `Component<P>`. The port keeps one method.
- **Why:** §1 probed that a plain `(props) => string` satisfies `Component<P>` and renders through
  the same path, so the second method would have no reader the day it merged. Answering the
  ROADMAP's open question here, rather than leaving it to whoever writes the first `'custom'`
  adapter, is the point of the question.
- **Test home:** `packages/view-plugin/test/unit/custom-engine.test.ts` — a `'custom'` engine whose
  components are plain `(props) => string` functions renders through the identical path.

### 3.7 `@Render`'s decorator shape

- **Decision:** `Render<P>(component: Component<P>): RenderDecorator<P>`, where
  `RenderDecorator<P> = (value: (...args: never[]) => P | Promise<P>, context: ClassMethodDecoratorContext) => void`.
  The body is `methodDecorator(...)`, assigned to that type with **no cast**, recording the
  component onto `MethodMeta.view`.
- **Why:** §1 probed this exact shape: correct sync, async and parameterised handlers check clean,
  and a wrong props bag fails `TS1241` naming the mismatch. It is method-position only — a
  class-level render has no meaning — so it does not use `classOrMethodDecorator`. Reusing
  `methodDecorator` keeps one deferral mechanism; declaring the narrowed `value` parameter is what
  adds the checking that `SetuMethodDecorator`'s `value: unknown` cannot do. This is strictly
  stronger than the surface it is modelled on: NestJS's `@Render('users/index')` is a string checked
  against nothing.
- **Test home:** `packages/decorator-plugin/test/unit/render-decorator.test.ts` for the metadata
  write; `packages/decorator-plugin/test/types/render-props.tsx` as a compile-time control carrying
  a `@ts-expect-error` on the wrong-props case, which is self-validating — an unused directive is
  itself a compile error.

### 3.8 A rendered route with no provider fails at `register()`

- **Decision:** `DecoratorPlugin.register()` throws, naming the controller, the handler, and both
  remedies (register `ViewPlugin`, or register any `CAPABILITIES.VIEW` provider). The check is **per
  route**, so an application with no rendered route needs no view plugin.
- **Why:** This deliberately diverges from the `@ValidateBody` arm three functions away
  (`decorator-plugin.ts:542-570`), which warns — and the divergence has a reason the JSDoc will
  carry, because a reviewer will otherwise read it as an inconsistency. That arm warns because those
  decorators shipped inert in M9 and §9.4 forbids turning a released no-op into a startup crash, and
  because an application may legitimately want only the OpenAPI description. Neither applies here:
  `@Render` is new surface with no released behaviour to preserve, and its failure mode is serving
  **JSON where the author asked for HTML** — a silently wrong content type rather than a missing
  enforcement.
- **Test home:** `packages/decorator-plugin/test/integration/render-missing-provider.test.ts` — a
  real kernel application whose `start()` rejects with a message naming both remedies, plus the
  control that an application with a controller carrying no `@Render` starts clean with no view
  plugin.

### 3.9 The `optionalDependencies` edge, and why it is acyclic

- **Decision:** `CAPABILITIES.VIEW` joins `decorator-plugin`'s `optionalDependencies`, giving
  `[VALIDATION, AUTHORIZATION, VIEW]`. `view-plugin` declares `provides: [CAPABILITIES.VIEW]` and
  **no `dependencies` and no `optionalDependencies` at all**.
- **Why:** `plugin-resolver.ts:38-55` makes both arrays real graph edges, so without the edge the
  register-time resolution is decided by plugin order rather than by contract — which is precisely
  the reason the validation arm carries one (its comment at :798-800 says so). The direction is
  decorator → view, and M90i's P1 is the reason this is stated rather than assumed: adding an edge
  in the opposite direction there made **every** application registering both plugins throw
  `Circular plugin dependency detected` at `start()`. Re-established here: `view-plugin` renders
  pure functions, needs no metadata store, and declares nothing, so no back-edge exists and no cycle
  is possible. The implicit runtime-provider edge every plugin carries (`plugin-resolver.ts:35-37`)
  is shared by both and introduces none.
- **Test home:** `packages/view-plugin/test/unit/view-plugin.test.ts` asserts the empty dependency
  arrays; `packages/decorator-plugin/test/integration/render-e2e.test.ts` boots a real application
  with both plugins registered in **both orders** and serves a rendered route from each — the
  assertion that would have caught M90i's P1.

### 3.10 Two entry points, one implementation

- **Decision:** An internal `renderToResponse(engine, ctx, component, props)` performs the render
  and the `ctx.response.html(...)` write. The `@Render` branch in `createHandler` calls it with the
  engine resolved once at `register()`; the free `renderView(ctx, component, props)` resolves
  `CAPABILITIES.VIEW` from `ctx.services` per request and calls the same function.
- **Why:** "One capability, one implementation, every entry point honors the same config" is a
  standing rule here, and a helper that hardcodes a default while the service honors configured
  options is a split that passes every gate. The resolution timing differs by necessity — the
  decorator has a registration hook and the free function does not — which mirrors the authorization
  arm, where register time decides the warning and request time decides enforcement.
- **Test home:** `packages/view-plugin/test/integration/both-entry-points.test.ts` — one application
  under a **non-default** configuration (`engine: 'hono-html'`) drives a decorated route and a
  functional route and asserts byte-identical bodies and headers.

**Correction (post-review).** `renderToResponse` was specified as the shared function BOTH entry
points call. That is unimplementable: `decorator-plugin` cannot import `@setu-ts/view-plugin`
(AI_GUIDELINES §2.2), so the `@Render` branch can never reach a helper in this package and performs
the two-line sequence inline. The extracted function therefore had no caller outside its own module
while its JSDoc claimed a sharing that cannot happen, so it is removed and `renderView` inlines the
same two lines. The genuinely shared implementation is `IViewEngine.render`, which both entry points
reach on the SAME resolved engine — which is what `both-entry-points.test.ts` pins byte-identically,
and what the rule was actually protecting.

### 3.11 The new package's manifest carries the JSX configuration

- **Decision:** `packages/view-plugin/deno.json` declares
  `imports: {"@hono/hono": "jsr:@hono/hono@^4.12.30"}` and
  `compilerOptions: {"jsx": "react-jsx", "jsxImportSource": "@hono/hono/jsx"}`. The root manifest's
  `workspace` array gains `./packages/view-plugin`. The root `compilerOptions` are not touched.
- **Why:** §1 measured that a member's `compilerOptions` **merge** with the root's rather than
  replacing them, so declaring `jsx` does not weaken `strict`, `exactOptionalPropertyTypes` or any
  other root option for this package — the question had to be settled by probe, because the opposite
  answer would have been a silently weakened gate for a whole package. It also measured that the
  member config works with **no per-file pragma**, and that `deno check packages` walks the
  directory so an unimported `.tsx` is still checked. Pinning the same range the kernel pins keeps
  one resolved hono in the lockfile.
- **Test home:** the four gates themselves; `packages/view-plugin/test/unit/view-engine-jsx.test.ts`
  renders from a `.tsx` fixture carrying no pragma, which fails if the manifest is wrong.

### 3.12 `decorator-plugin` gains no hono dependency

- **Decision:** `decorator-plugin`'s manifest stays
  `{"@setu-ts/common": "jsr:@setu-ts/common@^0.5.0"}`. Its `@Render` tests use plain
  `(props) => string` components, never JSX.
- **Why:** `Component<P>` is structural, so nothing in `decorator-plugin` needs a JSX runtime to
  type or to test `@Render`. Adding `@hono/hono` there to write a fixture would put a rendering
  dependency into the graph of a package that does no rendering, and would then need `jsx` config in
  a second manifest for no gain.
- **Test home:** `packages/decorator-plugin/test/unit/barrel-exports.test.ts` extended, plus the
  manifest diff itself — the plan's verification step greps the manifest.

### 3.13 Options are a union discriminated on `engine`

- **Decision:** `ViewPluginOptions` is
  `{engine?: 'hono-jsx'} | {engine: 'hono-html'} | {engine: 'custom'; view: IViewEngine}`,
  defaulting to `'hono-jsx'`.
- **Why:** The M30 `ChannelConfig` / M50 / M52c precedent — a missing per-arm field is a compile
  error rather than a startup throw. `'custom'` is the arm name used by M31 and M50, not
  `'external'`.
- **Test home:** `packages/view-plugin/test/types/options.ts` — `@ts-expect-error` on a `'custom'`
  arm with no `view`.

**Correction (post-review).** The two built-in arms were implemented as two engine classes whose
`render` bodies were byte-identical — the M14d shape, where a seam every arm passes identically
hides that the seam does nothing. It follows directly from §3.15: once escaping belongs to the
rendering runtime, nothing is left to configure per mode. There is now ONE `ViewEngine`, and
`'hono-jsx'` / `'hono-html'` name the **authoring mode** (which import an application's components
use), reported by the `view` health indicator. The §4.1 table's per-arm behaviour column is
corrected to say so rather than implying a rendering difference that does not exist.

### 3.14 Health indicator and lifecycle

- **Decision:** A `view` indicator reporting `{ engine }` and always `up`; **no** `onClose`.
- **Why:** Rendering is stateless and touches no backend, so there is nothing to probe and nothing
  to release. M90b's rule is that a probe must not fabricate reachability it cannot observe;
  reporting the selected engine is a real fact, and an invented round trip would be the opposite.
- **Test home:** `packages/view-plugin/test/unit/view-plugin.test.ts`.

### 3.15 Escaping is on, and the opt-out is hono's own

- **Decision:** No escaping logic is written in this package. The `'hono-jsx'` arm escapes
  interpolations by default; the `'hono-html'` arm's `raw()` is the documented opt-out, re-exported
  from the barrel so an application does not import hono directly.
- **Why:** §1 measured both. Writing an escaper here would be a second implementation of something
  the dependency already does correctly, and the one place framework-authored escaping goes wrong is
  the identity-replacement bug this repository's own checklist calls out.
- **Test home:** `packages/view-plugin/test/unit/escaping.test.ts` — `'Ada <script>'` renders as
  `Ada &lt;script&gt;` through both arms, with entities written literally in the expectation;
  `raw()` passes markup through.

### 3.16 The snippet harness gains JSX, without which no example is gated

- **Decision:** `test/fixtures/snippets/deno.json` gains `jsx`/`jsxImportSource`, `@hono/hono`, and
  `@setu-ts/view-plugin`. `packages/view-plugin/README.md` joins the fence allowlist in
  `test/package-readme-fence-compiler.test.ts`, and `decorator-plugin`'s pinned count is updated.
- **Why:** §1 measured that `tsx` **is** in `TS_ALIASES`, that the corpus contains **no** `tsx`
  fence today, and that one fails `TS7026` + `TS2874` under the harness as it stands. So every JSX
  example this milestone writes would be ungated on merge — the M70k X8-8 defect, where a headline
  README example shipped broken three ways because no gate compiled it.
- **Test home:** `test/package-readme-fence-compiler.test.ts` and
  `test/guide-fence-compiler.test.ts`, which compile the new fences once the harness can.

### 3.17 A status code or header alongside a rendered body goes through `@Ctx()`

- **Decision:** `@Render` takes no `status` argument. A handler needing one injects `@Ctx()` and
  sets it on the context before returning its props.
- **Why:** A decorated handler's return value is the props bag, so it cannot also carry a status —
  the M58 constraint, unchanged here. A `status` argument would be a second way to say what `@Ctx()`
  already says, and would then need companions for headers and cookies.
- **Test home:** `packages/decorator-plugin/test/integration/render-e2e.test.ts` — a route answering
  `201` with a rendered body.

### 3.18 Errors are exported classes

- **Decision:** `view-plugin` exports `ViewRenderError` (the component threw, or returned a value
  with no string form) and `UnresolvedSuspenseError` (§3.3). A `ViewRenderError` raised from a
  throwing component carries the original as `cause` and names the component, so the underlying
  failure is never swallowed. The absent-provider failure in `decorator-plugin` is a plain `Error`,
  matching that package's existing startup throws (`decorator-plugin.ts:302`).
- **Why:** A consumer catching a render failure needs an `instanceof`, and this package owns both
  conditions. `decorator-plugin` has no error classes today and adding one for a single startup
  message would be surface with one reader.
- **Test home:** `packages/view-plugin/test/unit/errors.test.ts`.

## 4. Exported surface — every symbol names its consumer

**`packages/common` (barrel additions):**

| Exported symbol     | Kind      | Consumer / real code path that READS it                                                                                              |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `CAPABILITIES.VIEW` | token     | `ViewPlugin.register()` registers under it; `decorator-plugin.register()` resolves it; `renderView` resolves it from `ctx.services`. |
| `IViewEngine`       | interface | Implemented by all three arms; named by `decorator-plugin`'s register-time `services.get<IViewEngine>`.                              |
| `Component<P>`      | type      | `@Render`'s parameter type in `decorator-plugin`; `IViewEngine.render`'s parameter; `renderView`'s parameter.                        |

**`packages/view-plugin` (`src/index.ts`):**

| Exported symbol           | Kind       | Consumer / real code path that READS it                                                                                                                    |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ViewPlugin`              | factory fn | An application's plugin list; `docs/mvc.md`; the CLI-independent starter composition in the integration tests.                                             |
| `ViewPluginOptions`       | type       | The `ViewPlugin` parameter; named by an application annotating its configuration.                                                                          |
| `renderView`              | fn         | The functional entry point — the generator default since M65. Read by the functional route in the both-entry-points integration test and by `docs/mvc.md`. |
| `raw`                     | re-export  | The documented escaping opt-out (§3.15), so an application does not import hono directly. Read by the escaping test and the README.                        |
| `ViewRenderError`         | class      | A consumer's `instanceof` in an error filter; thrown by `normalizeRendered` and both arms.                                                                 |
| `UnresolvedSuspenseError` | class      | Thrown by the `Suspense` refusal (§3.3); named in `docs/mvc.md` as the signal to move the boundary out.                                                    |

No component, layout or JSX helper is exported: components are application code, and an exported one
would need an explicit return type to clear the JSR slow-type lint (§1) for no consumer. `Child` and
`JSXNode` are not re-exported — an application writing JSX already imports the runtime its own
manifest configures.

### 4.1 Options — every option names its consumer

| Option                | Consumer                                                                                 | Behavior (per implementation)                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine?: 'hono-jsx'` | `ViewPlugin.register()` selects `HonoJsxEngine`; the `view` health indicator reports it. | Default. Components are JSX functions returning a `JSXNode`; escaped by default.                                                                          |
| `engine: 'hono-html'` | Same.                                                                                    | Components are functions returning an `HtmlEscapedString` from the `html` tagged template; needs no `jsxImportSource`, so it works in a plain `.ts` file. |
| `engine: 'custom'`    | Same.                                                                                    | Requires `view`; the supplied engine is registered verbatim.                                                                                              |
| `view: IViewEngine`   | Read by the `'custom'` arm only; a compile error on the other two (§3.13).               | The application's own engine.                                                                                                                             |

## 5. Implementation files

| File                                                                                                       | Purpose                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/view.ts`                                                                     | `IViewEngine`, `Component<P>`.                                                                                                                            |
| `packages/common/src/tokens.ts`                                                                            | `VIEW: 'view'` added to `CAPABILITIES`.                                                                                                                   |
| `packages/common/src/index.ts`                                                                             | Barrel re-export of the two new types.                                                                                                                    |
| `packages/view-plugin/deno.json`                                                                           | Manifest: name, version `0.5.0`, exports, hono import, JSX compiler options (§3.11).                                                                      |
| `packages/view-plugin/src/index.ts`                                                                        | Barrel; module JSDoc opening with `@module` (`release:verify` check 5).                                                                                   |
| `packages/view-plugin/src/plugin/view-plugin.ts`                                                           | `ViewPlugin` factory, arm selection, `view` health indicator, empty dependency arrays (§3.9).                                                             |
| `packages/view-plugin/src/plugin/options.ts`                                                               | `ViewPluginOptions` discriminated union.                                                                                                                  |
| `packages/view-plugin/src/engines/view-engine.ts`                                                          | The one built-in engine, serving both authoring modes (§3.13 correction).                                                                                 |
| `packages/view-plugin/src/html.ts`                                                                         | Re-exports `raw`, the escaping opt-out.                                                                                                                   |
| `packages/view-plugin/src/render/normalize.ts`                                                             | `normalizeRendered` (§3.2) and the `Suspense` refusal (§3.3).                                                                                             |
| `packages/view-plugin/src/render/render-view.ts`                                                           | `renderView` (§3.10 correction — no extracted `renderToResponse`).                                                                                        |
| `packages/view-plugin/src/errors.ts`                                                                       | `ViewRenderError`, `UnresolvedSuspenseError`.                                                                                                             |
| `packages/view-plugin/README.md`                                                                           | Package README with a `PUBLIC_API.md` anchor link (absolute GitHub URL, per the JSR relative-link rule).                                                  |
| `packages/decorator-plugin/src/decorators/view.ts`                                                         | `Render` (§3.7).                                                                                                                                          |
| `packages/decorator-plugin/src/metadata/metadata-store.ts`                                                 | `view?` on `RouteMetadata` and `MethodMeta`.                                                                                                              |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts`                                                 | The `optionalDependencies` entry, the register-time resolve, the per-route refusal (§3.8), and the third `createHandler` branch.                          |
| `packages/decorator-plugin/src/index.ts`                                                                   | `Render` export.                                                                                                                                          |
| `deno.json`                                                                                                | `workspace` gains `./packages/view-plugin`.                                                                                                               |
| `scripts/release-packages.ts`                                                                              | Tier 4 entry between `validation-plugin` and `websocket-plugin`.                                                                                          |
| `test/fixtures/snippets/deno.json`                                                                         | JSX enablement and the two imports (§3.16).                                                                                                               |
| `docs/releasing.md`                                                                                        | First-publish note: `view-plugin` has never been published, so it needs `release:create-packages` and `release:link-repos` before its first release (§8). |
| `docs/mvc.md`, `docs/migration-nestjs.md`, `PUBLIC_API.md`, `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md` | Doc deliverables, including C1–C5.                                                                                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                    | src covered                                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/view-contract.test.ts`                            | `common/src/services/view.ts`, `tokens.ts`           | A JSX component, an `html`-tag component and a plain `(props) => string` are all assignable to `Component<P>`; `CAPABILITIES.VIEW === 'view'` and matches the token grammar; the `render` return union is pinned (§3.5).                 |
| `packages/view-plugin/test/unit/normalize.test.ts`                           | `src/render/normalize.ts`                            | Sync, async, and nested-async components each yield a **primitive** string (`typeof === 'string'`) whose text never contains `object Promise`. Calls `normalizeRendered(value: unknown): Promise<string>`.                               |
| `packages/view-plugin/test/unit/suspense-refusal.test.ts`                    | `src/render/normalize.ts`, `src/errors.ts`           | A pending `Suspense` tree throws `UnresolvedSuspenseError` naming the component; the three measured non-`Suspense` shapes render clean (the over-firing control).                                                                        |
| `packages/view-plugin/test/unit/view-engine-jsx.test.ts`                     | `src/engines/view-engine.ts`                         | Renders a `.tsx` fixture carrying **no** pragma (which also proves §3.11's manifest); a layout composing `children` produces one document.                                                                                               |
| `packages/view-plugin/test/unit/view-engine-html.test.ts`                    | `src/engines/view-engine.ts`                         | Renders from a plain `.ts` file with no `jsxImportSource`.                                                                                                                                                                               |
| `packages/view-plugin/test/unit/falsy-returns.test.ts`                       | `src/render/normalize.ts`                            | A `false` top-level return renders `''`, never the text `false`, and agrees with the same component rendered as a CHILD; `null`/`true` likewise; `0` still renders `0`; `undefined` still refused by name (§3.2 correction).             |
| `packages/view-plugin/test/unit/escaping.test.ts`                            | both engines                                         | `'Ada <script>'` → `Ada &lt;script&gt;` through both arms, entities written literally; `raw()` passes markup through.                                                                                                                    |
| `packages/view-plugin/test/unit/custom-engine.test.ts`                       | `src/plugin/view-plugin.ts`, `src/plugin/options.ts` | A `'custom'` engine of plain `(props) => string` components renders through the identical path (§3.6).                                                                                                                                   |
| `packages/view-plugin/test/unit/view-plugin.test.ts`                         | `src/plugin/view-plugin.ts`                          | Registers under `CAPABILITIES.VIEW`; `dependencies` and `optionalDependencies` are both absent (§3.9); the `view` indicator reports the selected engine; no `onClose`.                                                                   |
| `packages/view-plugin/test/unit/errors.test.ts`                              | `src/errors.ts`                                      | A throwing component surfaces `ViewRenderError` with the original as `cause`; a component returning `null` is refused by name.                                                                                                           |
| `packages/view-plugin/test/types/options.ts`                                 | `src/plugin/options.ts`                              | `@ts-expect-error` on `{engine: 'custom'}` with no `view`; the two control arms check clean. Self-validating — an unused directive is a compile error.                                                                                   |
| `packages/view-plugin/test/unit/barrel-exports.test.ts`                      | `src/index.ts`                                       | Compile-time assertions declared against the **barrel**, not the concrete modules — the M56/M70m defect class, where dropping an export left every runtime assertion green.                                                              |
| `packages/view-plugin/test/integration/both-entry-points.test.ts`            | `src/render/render-view.ts`                          | One real kernel application under the **non-default** `engine: 'hono-html'` serves a decorated route and a functional route with byte-identical bodies and `content-type` (§3.10).                                                       |
| `packages/decorator-plugin/test/unit/render-decorator.test.ts`               | `decorators/view.ts`, `metadata-store.ts`            | `@Render(View)` records the component on the route metadata; components are plain `(props) => string`, so no hono dependency (§3.12).                                                                                                    |
| `packages/decorator-plugin/test/types/render-props.tsx`                      | `decorators/view.ts`                                 | `@ts-expect-error` on a wrong props bag; correct **sync**, **async** and **parameterised** handlers check clean — the exact shapes probed in §1.                                                                                         |
| `packages/decorator-plugin/test/integration/render-missing-provider.test.ts` | `plugin/decorator-plugin.ts`                         | `start()` rejects naming controller, handler and both remedies; the control — a controller with no `@Render` — starts clean with no view plugin (§3.8).                                                                                  |
| `packages/decorator-plugin/test/integration/render-e2e.test.ts`              | `plugin/decorator-plugin.ts`                         | A real application with both plugins in **both registration orders** serves a rendered route (§3.9's cycle/order assertion); the body is HTML under `text/html; charset=utf-8`, never JSON; a route sets `201` through `@Ctx()` (§3.17). |
| `packages/common/test/unit/barrel-exports.test.ts`                           | `common/src/index.ts`                                | Extended: `IViewEngine` and `Component` asserted **from the barrel**, so dropping a re-export fails here rather than silently (both packages already carry this test).                                                                   |
| `packages/decorator-plugin/test/unit/barrel-exports.test.ts`                 | `decorator-plugin/src/index.ts`                      | Extended with `Render`, asserted from the barrel for the same reason.                                                                                                                                                                    |
| `test/package-readme-fence-compiler.test.ts`                                 | —                                                    | `view-plugin/README.md` added with a pinned count; `decorator-plugin`'s count updated.                                                                                                                                                   |

No external-dependency guarded real-import test is needed: `@hono/hono` is already a resolved,
non-optional dependency of the workspace (§1) and both default arms import it statically, so every
test above exercises the real library rather than a fake. There is no lazy-import branch to seam.

**Negative controls to run and revert, each observed failing:** (1) drop the `await` in
`normalizeRendered` — the async cases must emit `object Promise`; (2) drop the `String(...)` — the
async cases must report `typeof === 'object'`; (3) remove the `Suspense` refusal — the buffered
fallback must be served with a 200; (4) drop the `optionalDependencies` edge from the shipped
replacement-`VIEW` control — a provider at `PLUGIN_PRIORITY.LOWEST` registered after
`DecoratorPlugin`, which only the edge orders before the decorator (priority alone would not: the
M45b finding) — and `start()` must refuse the application; (5) revert the snippet-harness `jsx` keys
— the new README fences must fail `TS2874`; (6) drop `renderView` from the barrel — the
barrel-exports assertion must fail while every runtime test still passes, which is what proves the
assertion is the thing catching it.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m92-view-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task check:docs        # docs gate, prose assertions, generated API links
deno task publish:check     # on a COMMITTED tree — catches slow types in the new barrel
deno task release:verify 0.5.0   # must report 48 publishable packages, up from 47
grep -n '@hono/hono' packages/decorator-plugin/deno.json   # MUST be empty (§3.12)
```

**Not run on this branch, but required before the release that first ships this package**
(`docs/releasing.md:28-42,290`): `release:create-packages`, then `release:link-repos`. A JSR package
must exist before it can be published, and tokenless OIDC publishing requires the repo link — M35
recorded exactly this for `packages/sdk`, the last first-time publisher. Neither is a code gate, so
nothing on this branch fails if they are forgotten; the plan names them and §5 adds the runbook
note, so the release carrying M92 does not discover it at tag time.

## 8. Risks & mitigations

- **The type-checker actively hides §3.2's defect.** `toString()` is typed `string`, so the wrong
  implementation compiles and passes any test written with sync components. Mitigation: the three
  normalization cases assert the **runtime** shape (`typeof === 'string'`) rather than only the
  text, and negative controls 1 and 2 are run and observed failing.
- **`Suspense` is the feature a JSX user reaches for next**, and refusing it may read as a bug
  rather than a decision. Mitigation: the error names the reason and the deferred owner, and
  `docs/mvc.md` states it in the engine's own section rather than a footnote.
- **A JSX example that is never compiled.** The corpus has no `tsx` fence today, so the gate has
  never run on one. Mitigation: §3.16 enables the harness first, and negative control 5 proves the
  gate discriminates before the examples are written.
- **The new package's `.tsx` fixtures could drift out from under the gates** if a future manifest
  edit drops the JSX keys. Mitigation: the engine test renders a fixture with **no pragma**, so it
  fails loudly if the manifest is wrong, rather than silently falling back to a per-file setting.
- **Release-list omission.** M51 shipped a member in neither list, which every gate passed over.
  Mitigation: `release:verify` is in §7 with the expected count stated, so an unchanged 47 is a
  failure.
- **First-time publication.** A member present in the release list can still fail to publish if the
  JSR package was never created and the repo never linked — a failure that surfaces only in the
  release workflow, long after this branch merges. Mitigation: both commands are named in §7 and the
  runbook note is a §5 deliverable.

## 9. Out of scope

- **Streaming `Suspense` resolution** over `IResponse.stream()` (M42). Deferred with cause in §3.5
  and §3.3 — it needs the injected client `<script>` measured in §1, which forfeits the
  zero-client-JS property. Owner: a follow-up `M92b` to be opened in the ROADMAP if the maintainer
  wants it before 1.0.
- **A first-party Handlebars arm and an HTMX integration.** Deferred past 1.0 by maintainer
  decision, recorded in the ROADMAP section; Handlebars additionally needs a precompiled-template
  story because its runtime `compile()` builds via `new Function`, banned by AI_GUIDELINES §13.5 and
  blocked by the Workers CSP. The `'custom'` arm reaches both today (§3.6).
- **A `setu g view` schematic and any CLI template wiring.** The ROADMAP defers it pending an answer
  on where a component file sits relative to the `controllers`/`services` seams; that answer belongs
  with the seam registry in `packages/cli`, not here. Owner: a follow-up CLI milestone.
- **Loading templates from disk by name.** Removed by design, not omitted: §3.1 names the view by
  reference, which is what makes the capability Workers-portable with no precompile step.
- **Replacing or competing with `react-router-plugin`.** Both plugins claim different tokens and
  different routes and can coexist; neither substitutes for the other, for the reasons the ROADMAP
  section sets out.
