# Milestone 91 — Test app composition (`@setu-ts/testing`, `@setu-ts/kernel`)

> **Status:** Planning. Branch: `feat/m91-test-app-composition`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Close [X11](../smoke/X11-FINDINGS.md)'s watch-item by making a test application buildable from the
project's own composition root rather than from a hand-assembled plugin array. `@setu-ts/testing`
gains a `{ app, without?, overrides? }` arm on `createTestApp` and an `overrideCapability` helper
that emits the replacement-plugin shape AI_GUIDELINES §3.4 already blesses; `@setu-ts/kernel` gains
`IKernelApplication.unregister(name)`, the one operation an override cannot express — dropping a
plugin before its `register()` runs, so its eager side effects (a real `adapter.connect()`) never
happen. The boundary is composition: this milestone changes how a test app is _assembled_, and
changes nothing about how a request is served.

- **In scope:** `IKernelApplication.unregister`; `overrideCapability`; the `createTestApp`
  composition-root arm; the doc corrections those require in `packages/testing/README.md`,
  `PUBLIC_API.md`, `AI_GUIDELINES.md` §6.4 and `CHANGELOG.md`.
- **NOT this milestone:** installing an error responder in `createTestApp` (decided against in §3.6
  — the `app:` arm dissolves the question and a second RFC 9457 formatter is the M56 defect class);
  any change to `createMockPlugin`'s behaviour (§3.5 — JSDoc only); a `common` widening (§3.1
  establishes none is needed); and request-path behaviour of any kind.

## 1. Contracts verified from SOURCE (not names)

| Reference                                                        | Source (file:line)                                                                                                       | Verified surface / fact                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IApplication`                                                   | `packages/common/src/plugin.ts:433-469`                                                                                  | `router`, `middleware`, `services`, `register(plugin): IApplication`, `start`, `stop`, `fetch`. **No plugin list and no removal member** — exclusion is not expressible against it today.                                                                     |
| `IKernelApplication`                                             | `packages/kernel/src/application/application.ts:101-110`                                                                 | `extends IApplication` and adds exactly `inject(request)`. This is the interface every composition root returns, so the widening needs no `common` change.                                                                                                    |
| `createApplication`                                              | `packages/kernel/src/application/application.ts:1506-1513`                                                               | Returns `IKernelApplication`; loops `app.register(plugin)` over `options.plugins`.                                                                                                                                                                            |
| `createRestApp` / `createMicroserviceApp` / `createFullStackApp` | `packages/starters/rest-starter/src/app.ts:93`, `microservice-starter/src/app.ts:57`, `full-stack-starter/src/app.ts:78` | All three return `IKernelApplication`. Confirms §3.1's placement.                                                                                                                                                                                             |
| `Application.#plugins` / `register`                              | `packages/kernel/src/application/application.ts:123,160-166`                                                             | Private `IPlugin[]`; `register` throws `Cannot register plugins after the application has started.` when `#started`, else pushes and returns `this`.                                                                                                          |
| `Application.#runStartup`                                        | `packages/kernel/src/application/application.ts:197-199`                                                                 | Calls `resolvePluginOrder(this.#plugins)` — the array is read once, at `start()`, so a removal before `start()` is sufficient and needs no other hook.                                                                                                        |
| `assertUniqueNames`                                              | `packages/kernel/src/registry/plugin-resolver.ts:107-118`                                                                | Duplicate plugin **name** throws, message advising `{ override: true }` at the service level.                                                                                                                                                                 |
| `buildProviderIndex`                                             | `packages/kernel/src/registry/plugin-resolver.ts:123-139`                                                                | Two plugins declaring one token in `provides` throws `Capability '<t>' is provided by both '<a>' and '<b>'`. **This is why `createMockPlugin` cannot override.**                                                                                              |
| `DEFAULT_PRIORITY`                                               | `packages/kernel/src/registry/plugin-resolver.ts:150`                                                                    | `500`. Ties break on registration order.                                                                                                                                                                                                                      |
| `PLUGIN_PRIORITY`                                                | `packages/common/src/types.ts:80-93`                                                                                     | `HIGHEST 0`, `HIGH 100`, `NORMAL 500`, `OPENAPI 700`, `LOW 900`, `LOWEST 1000`. A sentinel above `LOWEST` is what makes an override run last.                                                                                                                 |
| `ServiceRegistry.register`                                       | `packages/kernel/src/registry/service-registry.ts:125-143`                                                               | Without `override` a second registration of a present token throws; with `override` it notifies `#observer('override', token)` and replaces. Registering an **absent** token with `override: true` succeeds silently — the reason §3.4 adds a presence check. |
| `ServiceRegistry.seal` / `#assertMutable`                        | `packages/kernel/src/registry/service-registry.ts:36,49,145-153`                                                         | Sealed at `application.ts:376` after `runBootstrap()`; any later `register`/`unregister` throws. Confirms an override must be a plugin, not a post-`start()` call.                                                                                            |
| `IServiceRegistry.has` / `unregister`                            | `packages/common/src/registry.ts:148,161`                                                                                | `has(token): boolean` exists (used by §3.4's presence check); `unregister(token): boolean` is the naming and return-type precedent for §3.2.                                                                                                                  |
| `createTestApp`                                                  | `packages/testing/src/test-app.ts:70-81`                                                                                 | `createApplication({ plugins: opts.plugins ?? [] })` then optional `await app.start()`. Nothing else.                                                                                                                                                         |
| `createMockPlugin`                                               | `packages/testing/src/mock-plugin.ts:55-74`                                                                              | Sets `provides: [options.provides ?? options.name]` and calls `ctx.services.register(provides, service)` with **no** `override`. Both are why it collides.                                                                                                    |
| `DatabasePlugin.register`                                        | `packages/database-plugin/src/plugin/database-plugin.ts:111-115`                                                         | `await adapter.connect()` inside `register()` — the eager side effect that proves override is post-hoc and exclusion is needed.                                                                                                                               |
| `@setu-ts/testing` manifest                                      | `packages/testing/deno.json:6-9`                                                                                         | Depends on `@setu-ts/common` and `@setu-ts/kernel` only. Constrains §3.6: no `exceptions` dependency is available.                                                                                                                                            |
| AI_GUIDELINES §3.4                                               | `AI_GUIDELINES.md:190-194`                                                                                               | "A replacement plugin registers the same capability token with `override: true`." The mechanism §3.4 of this plan ships is the one already mandated; only the helper is new.                                                                                  |
| AI_GUIDELINES §6.4                                               | `AI_GUIDELINES.md:378-385`                                                                                               | Names `createMockPlugin()` as _the_ mocking utility. Must gain `overrideCapability` — see C2.                                                                                                                                                                 |
| `packages/testing/README.md` X11-2 note                          | `packages/testing/README.md:43-71`                                                                                       | The `errorHandler` note already exists and is accurate. §3.6 extends rather than writes it.                                                                                                                                                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                | Resolution (picked side)                                                 | Doc deliverable (same PR)                                                                                                      |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| C1 | The ROADMAP section scoped this milestone as `common` + `kernel` + `testing`; source-checking (§1, rows 2–4) shows every composition root returns `IKernelApplication`, so no `common` change is needed.                | `kernel`. `common` is untouched.                                         | The ROADMAP section already carries the correction paragraph and the corrected **Package(s)** line (shipped with the section). |
| C2 | AI_GUIDELINES §6.4 tells every agent to "use `createMockPlugin()` for mocking plugin services", which is unachievable against a real plugin (§1, `buildProviderIndex`). Followed literally in a composed app it throws. | Both are true of their own arm. §6.4 names both and says which is which. | `AI_GUIDELINES.md` §6.4 gains the `overrideCapability` line and the one-clause boundary.                                       |
| C3 | `PUBLIC_API.md`'s Testing section documents `TestAppOptions` as a single interface with `plugins` + `autoStart`; §3.3 makes it a union.                                                                                 | The union.                                                               | `PUBLIC_API.md` Testing section rewritten for both arms; Kernel section gains the `unregister` row.                            |

## 3. Design decisions

### 3.1 Where the exclusion member lives

- **Decision:** `IKernelApplication` in `packages/kernel`. No `common` change.
- **Why:** `createApplication` and all three starters return `IKernelApplication` (§1 rows 3–4), and
  it is already the interface carrying `inject()`, so every app a test can drive has it. Putting it
  on `IApplication` would widen a `common` contract to reach implementors that do not exist.
- **Test home:** `packages/kernel/test/unit/application-unregister.test.ts`;
  `packages/testing/test/integration/composition-root.test.ts` drives it through a starter-shaped
  root.

### 3.2 The exclusion member's shape

- **Decision:** `unregister(name: string): boolean` — removes the pending plugin with that `name`,
  returns `true` if one was removed and `false` otherwise, and throws
  `Cannot unregister plugins after the application has started.` when `#started`. **Required**, not
  optional.
- **Why:** Symmetric with `register(plugin)`, and `boolean` matches `IServiceRegistry.unregister`
  (§1). Required because the kernel's `Application` is the only implementor and an optional member
  cannot distinguish "this app cannot exclude" from "no such plugin" — the ambiguity M70k had to
  invent `IWorkerHost.reportsExit?` to resolve. Throwing after `start()` rather than returning
  `false` mirrors `register()`: the array has already been read by `#runStartup` (§1), so a silent
  `false` would report success for an operation that cannot have had any effect.
- **Test home:** `packages/kernel/test/unit/application-unregister.test.ts` (removal, unknown name,
  post-`start()` throw, and that the removed plugin's `register()` never runs).

### 3.3 `createTestApp`'s two arms

- **Decision:** `TestAppOptions` becomes a union of `TestAppFromPlugins` (`plugins?`, `autoStart?`)
  and `TestAppFromApp` (`app`, `without?`, `overrides?`, `autoStart?`), each declaring the other
  arm's fields as `?: never`, so supplying both is a compile error. Order inside the `app:` arm is
  `without` first, then `overrides`, then `start()`.
- **Why:** The M30 `ChannelConfig` / M50 / M52c precedent — a misconfiguration that the type system
  can refuse should not be a runtime throw. `without` before `overrides` because removing a plugin
  that an override then replaces is the coherent order, and because an override whose token is
  removed must fail §3.4's presence check rather than silently registering.
- **Test home:** `packages/testing/test/unit/test-app-arms.test.ts` (including a `@ts-expect-error`
  case for both-arms, which is self-validating — an unused directive is a compile error).

### 3.4 `overrideCapability`

- **Decision:** `overrideCapability(token: CapabilityToken, service: object): IPlugin`, returning a
  plugin that (a) declares **no** `provides`, (b) carries priority `OVERRIDE_PRIORITY`
  (`PLUGIN_PRIORITY.LOWEST + 1`), (c) is named `test-override.<token>`, and (d) in `register(ctx)`
  **throws when `ctx.services.has(token)` is false**, otherwise calls
  `ctx.services.register(token, service, { override: true })`.
- **Why:** (a) avoids `buildProviderIndex`'s collision (§1); (b) makes it run after every claimant,
  including a `PLUGIN_PRIORITY.LOW` plugin, which is the ordering hazard the ROADMAP section
  measured; (c) gives two overrides of one token a loud `assertUniqueNames` failure, which is the
  right answer; (d) is the load-bearing half — `{ override: true }` on an absent token succeeds
  silently (§1, `ServiceRegistry.register`), so a mistyped token would leave the real service
  serving while the test reported success. The refusal also enforces the semantic split against
  `createMockPlugin`: provide versus replace.
- **Test home:** `packages/testing/test/unit/override-capability.test.ts` (shape, priority, absent
  token refusal, duplicate-token name collision) and
  `packages/testing/test/integration/composition-root.test.ts` (it actually replaces a real plugin's
  service, including against a `PLUGIN_PRIORITY.LOW` provider).

### 3.5 `createMockPlugin` is unchanged

- **Decision:** No behaviour change. Its JSDoc gains one paragraph naming the boundary — it
  _provides_ a capability the app lacks and cannot _replace_ one a plugin already claims — and
  points at `overrideCapability`.
- **Why:** Its `provides` is what satisfies a dependent plugin's `dependencies` check, so removing
  it would break the arm it correctly serves; and changing a published export's behaviour needs a
  reason better than symmetry (§9.4). The defect is the missing sibling and the missing sentence,
  not the function.
- **Test home:** `packages/testing/test/unit/override-capability.test.ts` pins the collision as
  documented behaviour, so a later "fix" fails a test that names why.

### 3.6 The `errorHandler` / response-shape question

- **Decision:** Documentation only. `createTestApp` installs no responder on both arms. The
  `packages/testing/README.md` note added for X11-2 is extended with one sentence: the `app:` arm
  inherits whatever the composition root registered, and is therefore the answer for response-shape
  fidelity.
- **Why:** `packages/testing` depends on `common` + `kernel` only (§1), so a default responder means
  hand-rolling RFC 9457 from the `common` seam — a second formatter that `@setu-ts/exceptions`' own
  tests do not drive, which is the M56 media-type defect class (§11.1). The `app:` arm dissolves the
  question for every real composition, and the `plugins` arm is unit scope where the kernel fallback
  is the honest answer.
- **Test home:** `packages/testing/test/integration/composition-root.test.ts` asserts that an app
  built from a root that registered `errorHandler`-shaped responder middleware answers in that shape
  through the `app:` arm, and that the `plugins` arm answers the kernel fallback — the two
  behaviours the doc claims.

### 3.7 Refusing an unknown `without` name

- **Decision:** `createTestApp({ app, without })` throws naming the unmatched name (and listing the
  names the app does hold) when `app.unregister(name)` returns `false`.
- **Why:** A silently ignored `without: ['databse']` runs the whole test against the real plugin
  while reporting success — this repository's own silent-pass failure class, and the reason
  `unregister` returns a `boolean` at all rather than `void`.
- **Test home:** `packages/testing/test/unit/test-app-arms.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                     | Kind             | Consumer / real code path that READS it                                                                                                                       |
| --------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IKernelApplication.unregister` (`packages/kernel`) | interface member | `createTestApp`'s `app:` arm calls it for every `without` entry; `Application` implements it.                                                                 |
| `overrideCapability` (`packages/testing`)           | function         | `createTestApp`'s `overrides` array; the integration suite registers one against a real plugin; documented in README, `PUBLIC_API.md` and AI_GUIDELINES §6.4. |
| `TestAppFromPlugins` (`packages/testing`)           | interface        | The existing arm's public type; named in `PUBLIC_API.md` so a caller can annotate an options object.                                                          |
| `TestAppFromApp` (`packages/testing`)               | interface        | The new arm's public type; same.                                                                                                                              |
| `TestAppOptions` (`packages/testing`)               | type alias       | Unchanged name, now the union of the two above — every existing `TestAppOptions` annotation carrying `plugins` still compiles.                                |

### 4.1 Options — every option names its consumer

| Option                 | Consumer                                                   | Behavior (per implementation)                                                                                                                                |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plugins` (existing)   | `createApplication({ plugins })`                           | Unchanged. Hand-assembled arm; must include a runtime provider.                                                                                              |
| `autoStart` (existing) | `createTestApp`                                            | Unchanged; applies to both arms.                                                                                                                             |
| `app`                  | `createTestApp`                                            | The already-constructed, not-yet-started composition root. Discriminates the arm.                                                                            |
| `without`              | `app.unregister(name)`, once per entry, before `overrides` | Drops each named plugin so its `register()` never runs. Throws (§3.7) on a name the app does not hold.                                                       |
| `overrides`            | `app.register(plugin)`, once per entry, after `without`    | Appends replacement plugins. Typically `overrideCapability(...)`, but any `IPlugin` is accepted — a test may append a route-registering plugin the same way. |

## 5. Implementation files

| File                                             | Purpose                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `packages/kernel/src/application/application.ts` | `IKernelApplication.unregister` declaration + `Application.unregister` implementation. |
| `packages/testing/src/index.ts`                  | Barrel: add `overrideCapability`, `TestAppFromApp`, `TestAppFromPlugins`.              |
| `packages/testing/src/test-app.ts`               | The options union and the `app:` arm.                                                  |
| `packages/testing/src/override-capability.ts`    | `overrideCapability` and its internal `OVERRIDE_PRIORITY`.                             |
| `packages/testing/src/mock-plugin.ts`            | JSDoc only (§3.5).                                                                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                       | src covered                                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel/test/unit/application-unregister.test.ts`                      | `application.ts` (`unregister`)                              | Against `unregister(name: string): boolean`: removes a pending plugin and its `register()` never runs; returns `false` for an unknown name; throws after `start()`; removing a plugin another `dependencies` on still fails `start()` loudly.                                                                                                                                                                                                   |
| `packages/testing/test/unit/override-capability.test.ts`                        | `override-capability.ts`, `mock-plugin.ts`                   | Against `overrideCapability(token, service): IPlugin`: `provides` is absent; priority exceeds `PLUGIN_PRIORITY.LOWEST`; `register` throws naming the token when `has()` is false; two overrides of one token collide on name; and `createMockPlugin` beside a real provider still throws `provided by both` (§3.5's pin).                                                                                                                       |
| `packages/testing/test/unit/test-app-arms.test.ts`                              | `test-app.ts`                                                | Against the union: the `plugins` arm is byte-identical to today; the `app:` arm starts the supplied app; `without` an unknown name throws naming it (§3.7); `@ts-expect-error` on `{ app, plugins }` (self-validating).                                                                                                                                                                                                                         |
| `packages/testing/test/integration/composition-root.test.ts`                    | `test-app.ts`, `override-capability.ts`, kernel `unregister` | A starter-shaped `createApp()` whose "database" plugin connects eagerly: `without: ['database']` means `connect()` never runs; `overrides: [overrideCapability(DATABASE, mock)]` replaces the service and a route reads the mock; the same override wins against a `PLUGIN_PRIORITY.LOW` provider; a responder registered by the root governs the error body through the `app:` arm while the `plugins` arm answers the kernel fallback (§3.6). |
| `packages/testing/test/unit/barrel-exports.test.ts` (extend existing, else add) | `index.ts`                                                   | Compile-time assertion declared against the barrel that the three new symbols are exported — the M56 defect class, where dropping a re-export leaves every runtime test green.                                                                                                                                                                                                                                                                  |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m91-test-app-composition, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree — both changed packages publish
deno task release:verify 0.5.0
```

## 8. Risks & mitigations

- **`unregister` is a new required member on `IKernelApplication`.** Any out-of-repo implementor of
  that interface breaks. → Mitigation: the interface exists to type a return value rather than to be
  implemented. **Corrected during implementation:** `grep -rn "implements IKernelApplication"` finds
  one hit, but that is the wrong probe for a structurally typed language — a stand-in built as an
  object literal implements the interface without the keyword, and the suite held exactly one
  (`test/worker-startup-behavior.test.ts:26`), which the full `deno task test` run caught and the
  targeted per-package runs could not. It is a breaking change regardless, so it ships with
  CHANGELOG migration text and a `docs/upgrading.md` entry naming the member and the one-line
  implementation a stand-in needs — guidance the in-repo fix is itself the worked example of.
- **`OVERRIDE_PRIORITY` above `PLUGIN_PRIORITY.LOWEST` is a convention, not an enforced ceiling.** A
  third-party plugin could declare a higher number and win. → Mitigation: documented in
  `overrideCapability`'s JSDoc; the integration test pins the `LOW` (900) case, which is the highest
  band any first-party plugin uses.
- **A test could `without` a plugin others depend on and get a confusing startup failure.** →
  Mitigation: this is correct behaviour — the resolver's unsatisfied-dependency error names both
  plugins — and `application-unregister.test.ts` pins it so the message is not mistaken for a bug.
- **The union could break an existing `TestAppOptions` annotation.** → Mitigation:
  `TestAppFromPlugins` carries exactly today's fields, so a `{ plugins, autoStart }` object still
  satisfies the union; a test asserts an annotated variable of the old shape still compiles.

## 9. Out of scope

- **A responder default in `createTestApp`** — decided against in §3.6; the `app:` arm is the fix.
- **Any `createMockPlugin` behaviour change** — §3.5; JSDoc only.
- **Overriding a plugin's routes, middleware or lifecycle hooks.** `overrideCapability` replaces a
  _service_; a plugin's other registrations survive. Excluding the plugin is the only way to remove
  those, which is why §3.2 exists. A finer-grained mechanism is not proposed and is owned by no
  milestone — it would need a plugin-level interception seam in the kernel.
- **A `@setu-ts/testing` dependency on any plugin package**, including `exceptions` — §2.2 and the
  M33 boundary stand.
