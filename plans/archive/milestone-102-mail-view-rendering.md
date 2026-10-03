# Milestone 102 — Mail bodies rendered through the view engine (`@setu-ts/mail-plugin`)

> **Status:** Complete (PR pending). Branch: `feat/m102-mail-view-rendering`. `develop` and `main`
> are protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

Let an application author an email body as a component the view engine renders — a JSX function, an
`html` tagged template, or a plain `(props) => string` function — instead of a `{{ variable }}`
string, through the committed `IMailer.sendTemplate` entry point and with no second rendering
mechanism. The bridge lives in `mail-plugin`: `MailPluginOptions.templates` gains a component arm,
the plugin resolves `CAPABILITIES.VIEW` as an optional capability once at `register()`, and a
component template configured with no provider fails at startup naming both remedies.

- **In scope:** the `MailTemplate` union (string arm unchanged, new component arm); `TemplateEngine`
  rendering the component arm through an injected `IViewEngine`, and becoming asynchronous;
  `MailPlugin` declaring `CAPABILITIES.VIEW` in `optionalDependencies`, resolving the engine at
  `register()`, and refusing a component template with no provider; `MailService` awaiting the
  render; README, `PUBLIC_API.md`, ARCHITECTURE row, CHANGELOG and `docs/upgrading.md`.
- **NOT this milestone:** any `common` change or new token (every contract is committed — §1); a
  typed free function in `view-plugin` (rejected as dead surface, ROADMAP M102); subject templating
  (the committed `sendTemplate` signature keeps `subject` on the envelope); layouts (a component
  taking `children`, M92's rule); CSS inlining, MJML or `react-email` (reachable today as a
  string-returning component or the `'custom'` engine arm); localization of mail bodies (M103);
  consulting a container-supplied engine (§9).

## 1. Contracts verified from SOURCE (not names)

| Reference                                     | Source (file:line)                                                 | Verified surface / fact                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IMailer.sendTemplate`                        | `packages/common/src/services/mail.ts:56-60`                       | `sendTemplate(template: string, message: Omit<MailMessage, 'html' \| 'text'>, data: Readonly<Record<string, unknown>>): Promise<void>`. `data` is an untyped record — the component arm cannot check props at this boundary (§3.4).                                      |
| `MailMessage`                                 | `packages/common/src/services/mail.ts:13-27`                       | `html?: string`, `text?: string` — both optional strings; a rendered body lands in these two fields.                                                                                                                                                                     |
| `IViewEngine.render`                          | `packages/common/src/services/view.ts:76`                          | `render<P>(component: Component<P>, props: P): string \| Promise<string>` — the async arm is real, which is why `TemplateEngine.render` must become async (§3.3). Escaping is the runtime's, not the port's (JSDoc at `:55-66`).                                         |
| `Component<P>`                                | `packages/common/src/services/view.ts:29`                          | `(props: P) => unknown`, structural; a plain `(p) => string` is one, and its output is returned unchanged by the engine (`view-plugin/src/render/normalize.ts:85`).                                                                                                      |
| `CAPABILITIES.VIEW` / `MAIL` / `LOGGER`       | `packages/common/src/tokens.ts:262` / `:91` / `:43`                | `'view'`, `'mail'`, `'logger'`. The plugin today spells its logger edge as the literal `'logger'` (`mail-plugin.ts:95`); the new edge uses the constant.                                                                                                                 |
| `IServiceRegistry.has`                        | `packages/common/src/registry.ts:148`                              | `has(token): boolean` — the non-throwing presence test the `register()`-time lookup uses.                                                                                                                                                                                |
| `@Render` engine resolution precedent         | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:422-431` | `ctx.services.has(VIEW)` then `get`, else a swallowed `ctx.container?.resolve`. The container arm exists because `DecoratorPlugin({ services })` registers `@Injectable` into the container during its OWN `register()` — a composition unavailable to this plugin (§9). |
| `@Render` absent-provider refusal             | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:471-485` | Throws at `register()`, names both remedies ("Register ViewPlugin … or any other provider of CAPABILITIES.VIEW"); the wording this milestone's refusal mirrors.                                                                                                          |
| `optionalDependencies` ordering               | `packages/kernel/src/registry/plugin-resolver.ts:49`               | An optional dependency is a real graph edge the resolver orders by, so a declared edge guarantees the view plugin registers first; `decorator-plugin.ts:1011-1015` relies on the same fact for `CAPABILITIES.VIEW`.                                                      |
| `view-plugin` declares no edges               | `packages/view-plugin/src/plugin/view-plugin.ts:70-72`             | No `dependencies`, no `optionalDependencies`, default priority — so `mail → view` cannot form a cycle (the M90i P1 class, re-established rather than inherited).                                                                                                         |
| `MailTemplate` today                          | `packages/mail-plugin/src/interfaces/index.ts:106-111`             | `{ html?: string; text?: string }` — becomes the string arm of the union, byte-identical in shape.                                                                                                                                                                       |
| `MailPluginOptions.templates`                 | `packages/mail-plugin/src/interfaces/index.ts:169`                 | `Record<string, MailTemplate>` — unchanged; the union widens what a value may be.                                                                                                                                                                                        |
| `TemplateEngine`                              | `packages/mail-plugin/src/templates/template-engine.ts:46,64`      | `constructor(templates?)`, `render(name, data): RenderedTemplate` (sync), throws on unknown template and on a missing placeholder key. Exported from the barrel (`src/index.ts:33`) — so the async change is a public signature change (§3.3).                           |
| `MailService.sendTemplate`                    | `packages/mail-plugin/src/services/mail-service.ts:90-97`          | Calls `this.#templates.render(...)` synchronously, then awaits `provider.send`; gains one `await`.                                                                                                                                                                       |
| `MailPlugin` construction site                | `packages/mail-plugin/src/plugin/mail-plugin.ts:95,103`            | `optionalDependencies: ['logger']`; `new TemplateEngine(options?.templates)` inside `register()` — where the resolved engine is threaded in.                                                                                                                             |
| `ViewRenderError` / `UnresolvedSuspenseError` | `packages/view-plugin/src/errors.ts:46,71`                         | Thrown by the engine for a throwing/`undefined`-returning component and a pending `<Suspense>`; this package propagates them unwrapped and never reaches the provider (§3.6).                                                                                            |
| `notification-plugin` email channel           | `packages/notification-plugin/src/channels/email-channel.ts:37`    | Calls `mailer.send(...)`, never `sendTemplate` — so it is unaffected; the ROADMAP's "every holder of `IMailer` that calls `sendTemplate`" is scoped accordingly.                                                                                                         |
| README fence gate                             | `test/package-readme-fence-compiler.test.ts:123`                   | Pins `packages/mail-plugin/README.md` at 2 compilable fences; adding the component-arm example moves the pinned count (§6).                                                                                                                                              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                | Resolution (picked side)                                                                                                                               | Doc deliverable (same PR)                                                                     |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| C1 | `ARCHITECTURE.md:1489-1497` lists `@setu-ts/mail-plugin` dependencies as `common`, `kernel` and extension points as "custom template engine"; after this milestone it also consumes `view` optionally.  | The row gains the optional `view` capability under Dependencies; the extension point is reworded to "component templates through `CAPABILITIES.VIEW`". | ARCHITECTURE `@setu-ts/mail-plugin` row.                                                      |
| C2 | `PUBLIC_API.md` Mail section (`:6659+`) documents `templates` as "Named `{ html?, text? }` body templates" and the Notes say a missing variable throws — true of the string arm only after this change. | The options row and the Notes name both arms and state the no-missing-key behaviour of the component arm explicitly.                                   | `PUBLIC_API.md` Mail section: options row, Notes, and the `TemplateEngine` export line.       |
| C3 | `packages/mail-plugin/README.md:54-58` ("Templates") describes only `{{ variable }}` substitution.                                                                                                      | A second paragraph and a compilable example for the component arm; options table row updated.                                                          | README Options + Templates; fence-gate count in `test/package-readme-fence-compiler.test.ts`. |

## 3. Design decisions

### 3.1 Where the bridge lives

- **Decision:** `mail-plugin` owns it. `MailPluginOptions.templates` gains a component arm and
  `sendTemplate` renders it through the resolved `IViewEngine`. No change to `view-plugin`, no free
  function, no `common` change.
- **Why:** The committed `IMailer.sendTemplate` is already the named-template entry point every
  holder of the capability has; widening what a template may BE reaches all of them with no new
  surface. A free function in `view-plugin` would be three lines an application already writes and
  would have no in-repo reader (dead surface). Decided with the maintainer on 2026-10-04.
- **Test home:** `mail-view-rendering.test.ts` (integration), `template-engine.test.ts`.

### 3.2 The `MailTemplate` union

- **Decision:** `MailTemplate = MailStringTemplate | MailComponentTemplate` where
  `MailStringTemplate = { html?: string; text?: string; view?: never }` and
  `MailComponentTemplate = { view: Component<never>; text?: Component<never>; html?: never }`. Arm
  detection at runtime is `'view' in template`. Both arm types are exported beside the union.
- **Why:** `never`-typed cross-arm members make a template mixing `view` with `html` a compile error
  under `exactOptionalPropertyTypes` instead of a silent precedence rule (the M30 `ChannelConfig`
  discriminated-union precedent). `Component<never>` is the one type every component is assignable
  to — a `Component<{ name: string }>` is NOT assignable to `Component<Record<string, unknown>>`
  (parameter contravariance; probed in §3.4's test) — and it is the spelling
  `view-plugin/src/errors.ts:27` already uses for "any component". The arm types are exported
  because an application typing its own template map needs to name them; both are read by the
  plugin's arm detection and by the README example.
- **Test home:** `template-shape.test.ts` (compile-time `@ts-expect-error` rows for the mixed
  literal, plus a positive control that a typed component is assignable).

### 3.3 `TemplateEngine.render` becomes asynchronous — the one breaking change

- **Decision:** `render(name, data): Promise<RenderedTemplate>`; the constructor gains an optional
  second parameter `viewEngine?: IViewEngine`. The string arm's behaviour (escaping, missing-key
  throw, unknown-template throw) is unchanged except that the throws become rejections.
- **Why:** `IViewEngine.render` answers `string | Promise<string>` and an async component's render
  genuinely is a promise (`view.ts:76` JSDoc). One registry, one lookup, one unknown-template error
  for both arms is worth more than keeping the sync signature for direct callers of the exported
  class, of whom there are none in-repo (`grep -rn "new TemplateEngine" packages/*/src` finds only
  `mail-plugin.ts:103`). Prerelease: a signature change is announced, not deprecated (AI_GUIDELINES
  §9 scope note). A throw inside an `async` method is a rejection, so the M52b "typed `Promise`,
  threw synchronously" class is closed by construction.
- **Test home:** `template-engine.test.ts` (every existing case awaits; a `.catch()` observes each
  refusal), `mail-service.test.ts`, CHANGELOG `Changed` + `docs/upgrading.md` entry.

### 3.4 `data` is the props bag, passed verbatim, with no missing-key check

- **Decision:** For a component template, `engine.render(template.view, data as never)` and, when
  present, `engine.render(template.text, data as never)`. No key check of any kind.
- **Why:** A component reads whatever it reads; there is no placeholder list to check against. The
  committed signature types `data` as `Readonly<Record<string, unknown>>`, so the cast to `never` is
  the only way to call a `Component<never>` and is internal to one line. The documentation states
  the asymmetry rather than implying parity, and names the compile-time route (call
  `engine.render(Component, props)` and `mailer.send` by hand).
- **Test home:** `template-engine.test.ts` (a component reading a key absent from `data` renders
  `undefined` into its output and does NOT throw — pinned, so the asymmetry is deliberate).

### 3.5 The engine is resolved once at `register()`, from the registry, with a named refusal

- **Decision:** `MailPlugin` declares
  `optionalDependencies: [CAPABILITIES.LOGGER, CAPABILITIES.VIEW]`. In `register()`, when at least
  one configured template is a component template: `ctx.services.has(CAPABILITIES.VIEW)` → `get` and
  pass the engine to `TemplateEngine`; otherwise throw `Error` naming the first offending template
  and both remedies ("Register ViewPlugin from @setu-ts/view-plugin (or any other provider of
  CAPABILITIES.VIEW), or remove the component templates"). The refusal is performed by the
  `TemplateEngine` constructor (it receives the templates and the engine-or-`undefined`), so it is
  unit-testable without a plugin context; the plugin passes what it resolved. An application with
  only string templates performs no lookup.
- **Why:** The `@Render` precedent (`decorator-plugin.ts:471-485`): a provider missing at startup
  must fail at startup, never at the first `sendTemplate` on a path the application has already
  shipped. The `optionalDependencies` edge is what makes the lookup a contract — the resolver orders
  the view plugin first (`plugin-resolver.ts:49`) — and it is acyclic because `view-plugin` declares
  no edge of its own (`view-plugin.ts:70-72`). The container is deliberately NOT consulted (§9).
- **Test home:** `mail-plugin.test.ts` (metadata pins the edge; `register()` with a component
  template and no provider rejects naming both remedies; with a provider, resolves),
  `template-engine.test.ts` (constructor refusal), `mail-view-rendering.test.ts` (plugin order:
  `MailPlugin` listed BEFORE `ViewPlugin` still works — the edge, not the array order, decides).

### 3.6 Render errors propagate unwrapped and never reach the provider

- **Decision:** `ViewRenderError` and `UnresolvedSuspenseError` thrown by the engine propagate out
  of `sendTemplate` as-is; the provider's `send` is not called.
- **Why:** Wrapping would hide the `instanceof` surface M92 exports for exactly this purpose, and
  the string arm already short-circuits before the provider on a render failure
  (`mail-integration.test.ts` pins it); the component arm must match.
- **Test home:** `mail-view-rendering.test.ts`.

### 3.7 Escaping is the rendering runtime's, verbatim text

- **Decision:** The HTML body is whatever the engine returns; the text body is whatever the engine
  returns. No escaping, stripping or re-encoding in this package for the component arm.
- **Why:** M92 §3.15 — escaping belongs to the rendering runtime and `raw()` is the opt-out; a
  second escaping pass here would double-encode an `html` template's output. The string arm's raw
  text substitution is the precedent for a verbatim text body.
- **Test home:** `mail-view-rendering.test.ts` (an `html` tagged template with `<script>` in a prop
  arrives escaped; a plain-string text component arrives raw).

### 3.8 Health indicator and `onClose` are unchanged

- **Decision:** No change to the `mail` indicator payload and no new lifecycle hook.
- **Why:** Rendering is stateless (M92's own reasoning for `view-plugin` declaring no `onClose`),
  and the indicator reports transport reachability, which a component template does not touch.
- **Test home:** existing `mail-plugin.test.ts` health cases (unchanged, must stay green).

## 4. Exported surface — every symbol names its consumer

`src/index.ts` gains two type exports and changes no runtime export; `barrel-exports.test.ts` is
unchanged for runtime symbols and gains a compile-time pin for the two types.

| Exported symbol         | Kind                  | Consumer / real code path that READS it                                                                            |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `MailTemplate`          | type (now a union)    | `MailPluginOptions.templates` values; `TemplateEngine` constructor; arm detection in `TemplateEngine.render`.      |
| `MailStringTemplate`    | type (new)            | The string arm; read by `TemplateEngine.#renderString` and by an application typing its own template map (README). |
| `MailComponentTemplate` | type (new)            | The component arm; read by `TemplateEngine.#renderComponent`, the constructor refusal, and the README example.     |
| `TemplateEngine`        | class (signature chg) | `MailPlugin.register()` constructs it with the resolved engine; `MailService.sendTemplate` awaits `render`.        |
| `RenderedTemplate`      | type (unchanged)      | `MailService.sendTemplate` spreads it into the outgoing message.                                                   |

### 4.1 Options — every option names its consumer

| Option                                        | Consumer                                               | Behavior (per implementation)                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `templates[name].view`                        | `TemplateEngine.#renderComponent`, constructor refusal | Rendered through `IViewEngine.render(view, data)` into `html`. Requires a `CAPABILITIES.VIEW` provider at `register()`, else the plugin refuses. |
| `templates[name].text` (component arm)        | `TemplateEngine.#renderComponent`                      | Rendered through the same engine into `text`, verbatim. Omitted → no `text` body.                                                                |
| `templates[name].html` / `.text` (string arm) | `TemplateEngine.#renderString`                         | Unchanged M29 behaviour: `{{ key }}` substitution, HTML escaping on `html`, missing key throws.                                                  |

## 5. Implementation files

| File                                                    | Purpose                                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/mail-plugin/src/index.ts`                     | Adds the two arm type exports; the JSDoc on `TemplateEngine`'s export line names both arms.                                                                |
| `packages/mail-plugin/src/interfaces/index.ts`          | `MailTemplate` union, `MailStringTemplate`, `MailComponentTemplate`; `MailPluginOptions.templates` JSDoc names both arms.                                  |
| `packages/mail-plugin/src/templates/template-engine.ts` | Optional `viewEngine` constructor parameter, constructor refusal, async `render` dispatching per arm, `#renderComponent`.                                  |
| `packages/mail-plugin/src/services/mail-service.ts`     | `await this.#templates.render(...)`.                                                                                                                       |
| `packages/mail-plugin/src/plugin/mail-plugin.ts`        | `optionalDependencies` gains `CAPABILITIES.VIEW` (and spells `LOGGER` from the constant); `resolveViewEngine(ctx, templates)` threaded into the engine.    |
| `packages/mail-plugin/deno.json`                        | Test-only `imports` for `@hono/hono` (the `html` tag the integration test authors components with); `@setu-ts/view-plugin` resolves as a workspace member. |
| `packages/mail-plugin/README.md`                        | C3.                                                                                                                                                        |
| `PUBLIC_API.md`                                         | C2.                                                                                                                                                        |
| `ARCHITECTURE.md`                                       | C1.                                                                                                                                                        |
| `CHANGELOG.md`                                          | `Unreleased`: Added (component arm, refusal) + Changed/breaking (`TemplateEngine.render` async).                                                           |
| `docs/upgrading.md`                                     | `Unreleased`: "await `TemplateEngine.render`" for a direct caller of the exported class.                                                                   |
| `test/package-readme-fence-compiler.test.ts`            | Pinned fence count for the mail README moves with the new example.                                                                                         |
| `ROADMAP.md`, `CLAUDE.md`                               | Status flip on completion; plan archived to `plans/archive/` in the same PR.                                                                               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                              | src covered                                                                         | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/template-engine.test.ts` (extended)         | `templates/template-engine.ts`                                                      | Every existing string-arm case now `await`s `render(name, data): Promise<RenderedTemplate>`; a component template renders `view` → `html` and `text` → `text` through a fake `IViewEngine` (`render<P>(c, p)` recorded, called with `data`); `text` omitted → no `text` key; sync and async engine returns both yield primitive strings; a component reading an absent key does NOT throw (§3.4); the constructor throws naming the template and both remedies when a component template is configured and `viewEngine` is `undefined`; string-only templates with no engine construct fine; unknown template and missing placeholder REJECT (observed via `.catch`, never a sync throw). |
| `test/unit/template-shape.test.ts` (new)               | `interfaces/index.ts`                                                               | Compile-time: `const ok: MailTemplate = { view: Typed }` where `Typed: Component<{ name: string }>` (positive control); `// @ts-expect-error` on `{ view, html: '' }` and on `{ html: '', view }`; `MailStringTemplate` / `MailComponentTemplate` named from the barrel. Runtime: a trivial assertion so the file executes.                                                                                                                                                                                                                                                                                                                                                               |
| `test/unit/mail-service.test.ts` (extended)            | `services/mail-service.ts`                                                          | `sendTemplate` with a component template through a fake engine reaches the provider with the rendered `html`/`text` and the envelope's `subject`; a rejecting engine never reaches the provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `test/unit/mail-plugin.test.ts` (extended)             | `plugin/mail-plugin.ts`                                                             | Metadata: `optionalDependencies` equals `[CAPABILITIES.LOGGER, CAPABILITIES.VIEW]`; `register()` with a component template and a context whose registry lacks `VIEW` rejects with a message naming the template, `ViewPlugin`, `CAPABILITIES.VIEW` and the drop-the-templates remedy; with `VIEW` registered it resolves and `sendTemplate` works; with only string templates and no `VIEW` it registers (no lookup).                                                                                                                                                                                                                                                                     |
| `test/integration/mail-view-rendering.test.ts` (new)   | `plugin/mail-plugin.ts`, `templates/template-engine.ts`, `services/mail-service.ts` | A REAL kernel app with the REAL `ViewPlugin({ engine: 'hono-html' })` (the non-default arm) listed AFTER `MailPlugin` in `plugins`: `sendTemplate` on an `html`-tag component with `<script>` in a prop reaches the `log` sink with the HTML escaped and a plain-string text component verbatim; a string template in the same map still renders (both arms side by side); a component that throws rejects with `ViewRenderError` and the sink stays empty; a tree with a pending `<Suspense>` rejects with `UnresolvedSuspenseError`; the `mail` health indicator is unchanged (`up`).                                                                                                   |
| `test/unit/barrel-exports.test.ts` (extended)          | `src/index.ts`                                                                      | Runtime list unchanged; a compile-time pin that `MailStringTemplate` and `MailComponentTemplate` are importable from the barrel (the M56 defect class).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/integration/mail-integration.test.ts` (existing) | regression                                                                          | Unchanged and green — the string arm's behaviour is byte-identical.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Negative controls to run and revert before hand-off: (1) drop `CAPABILITIES.VIEW` from
`optionalDependencies` — the plugin-order integration case must fail; (2) make the constructor
refusal a warning — the `register()` refusal unit case and the plan-mandated message assertion must
fail; (3) remove the `await` on the engine in `#renderComponent` — the async-engine case must fail
with `[object Promise]` in the body; (4) re-escape the component arm's output in this package — the
`html`-tag escaping case must fail on double encoding.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m102-mail-view-rendering, never develop or main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on the committed tree
deno task release:verify 0.8.0
```

## 8. Risks & mitigations

- `exactOptionalPropertyTypes` and the `never`-typed cross-arm members: if `{ view?: never }` on the
  string arm rejects a plain `{ html: '…' }` literal for any reason, the discriminant falls back to
  the absence of `view` with a documented runtime precedence — probed in `template-shape.test.ts`
  before any other file is touched.
- The mail README gains a fence that must compile under the fence gate, including a `Component`
  import from `@setu-ts/common` and `html` from `@hono/hono/html` — written against the real gate,
  and the pinned count updated in the same change.
- A reader expecting the string arm's missing-key throw on the component arm: §3.4 is stated in
  three doc sites (README, `PUBLIC_API.md`, the `MailComponentTemplate` JSDoc) and pinned by a test,
  so the asymmetry cannot be mistaken for an oversight.

## 9. Out of scope

- A container-supplied engine (`@Injectable({ token: CAPABILITIES.VIEW })` under `DiPlugin`):
  `DecoratorPlugin` registers it into `ctx.container` during its OWN `register()`, which runs after
  this plugin's, so there is nothing for this plugin to find; the refusal names the registry remedy.
  Lazy per-send resolution was rejected because it moves the failure to request time.
- Subject templating, layouts, CSS inlining, MJML, `react-email`, mail-body localization (M103), a
  typed free function in `view-plugin`, and any `common` change — see §0.
