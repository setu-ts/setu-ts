# Milestone 130 — The full-stack template: kernel modules behind the pages (`@setu-ts/react-router-plugin`, `@setu-ts/common`, `@setu-ts/cli`, `@setu-ts/full-stack-starter`)

> **Status:** Planning. Branch: `feat/m130-full-stack-kernel-modules`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

A full-stack project's business logic moves into kernel modules (`src/modules/<name>/`), and a React
Router loader reaches a module's service with one line, `getService<T>(context, TOKEN)`, bound to
the current request. Today each kernel service a page uses is wired by hand in four places (a
context key, a `context.set` in `populateLoadContext`, an accessor in
`app/config/services.server.ts`, a page-side adapter), and "services" means one thing in `app/` and
another in `src/`. After M130 a module registers a request-bound service factory under a typed
token; the plugin's request bridge exposes a per-request resolver (never the raw kernel context) to
the load context; `app/` imports only types from the kernel (`~kernel/*`), token modules excepted,
and `setu check` refuses value imports. The milestone also closes the template half of smoke group
G5.

- **In scope:**
  - `@setu-ts/common`: `ServiceToken<T>`, `serviceToken()`, `requestService()`,
    `resolveRequestService()`, `RequestServiceUnavailableError` (§3.1).
  - `@setu-ts/react-router-plugin`: `getService()`, `serviceResolverContext`, the bridge populating
    it (§3.2).
  - `@setu-ts/full-stack-starter`: OpenAPI exclusions for page, asset and dev-proxy routes (§3.9).
  - `@setu-ts/cli`:
    - the full-stack template restructure (§3.3–§3.5);
    - `setu g module` in full-stack projects, with `--page` (§3.6);
    - the `setu check` finding for page value imports (§3.7);
    - the generated tests' CSRF handling (§3.8);
    - the folded smoke rows (§3.9–§3.11).
  - Docs: PUBLIC_API (common, react-router-plugin), the react-router-plugin README and agent card,
    `docs/react-router*.md`, the generated README, CHANGELOG, `docs/upgrading.md`.
- **NOT this milestone:**
  - DI-container (`di-plugin`) integration for class-based full-stack modules: the full-stack
    template is functional-only (`--style` is refused for full-stack,
    `templates/choice.ts:161-172`).
  - Removing `servicesContext` (still published; see §3.2).
  - CLI gates and generators outside full-stack (M131c).
  - Documentation-only rows (M131d).

## 1. Contracts verified from SOURCE (not names)

| Reference                                   | Source (file:line)                                                                                          | Verified surface / fact                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IRequestContext.services`                  | `packages/common/src/http.ts:383-384`                                                                       | `readonly services: IServiceRegistry` — "application-scoped plus request-scoped services"; the kernel creates the child registry on first read (`kernel/src/context/request-context.ts`, M125 plan §1)                                                                                                       |
| `IRequestContext.slot`                      | `packages/common/src/http.ts:348-361`                                                                       | optional `slot?<T>(key: object, create: () => T): T` — one value per key per request; the kernel implements it (`request-context.ts:74-76`); `create` must not call `slot` with its own key                                                                                                                  |
| `IServiceRegistry`                          | `packages/common/src/registry.ts:85-187`                                                                    | `register<T extends object>(token, service, options?)` throws on a duplicate token and after `runBootstrap()`; `get<T>` throws `Error("No service registered for capability '…'")` (`kernel/src/registry/service-registry.ts:190`); `has(token)`                                                             |
| Bootstrap timing                            | `packages/kernel/src/application/application.ts:792`                                                        | `runBootstrap()` runs inside `start()`, so `registerModules(app.router, app.services)` in `setu.config.ts` (before `start`) may still `register`                                                                                                                                                             |
| `CapabilityToken` / `createCapabilityToken` | `packages/common/src/tokens.ts:22, 333, 353`                                                                | `CapabilityToken = string`; grammar: lowercase kebab segments joined by `.` (no `:`)                                                                                                                                                                                                                         |
| `servicesContext` / `userContext`           | `packages/react-router-plugin/src/handler/context-keys.ts:40, 53`                                           | keys holding `ctx.services` (the request's `IServiceRegistry`, including `register`) and the principal; set by `applyDefaultLoadContext` (`handler/load-context.ts:22-28`)                                                                                                                                   |
| `contextKeyFor`                             | `packages/react-router-plugin/src/handler/context-keys.ts:96-108`                                           | memoised name→key map inside the ONE external plugin instance; identity survives the SSR bundle because `@setu-ts/*` stay external (`cli/src/templates/full-stack-build-files.ts:70-73, 185-193`; `FULL_STACK_APP_FRAMEWORK_PACKAGES`, `full-stack.ts:48`)                                                   |
| Request bridge                              | `packages/react-router-plugin/src/handler/request-bridge.ts:34-41`                                          | per request: fresh provider → `applyDefaultLoadContext(ctx, …)` → app `populateLoadContext(ctx, …)` → RR handler                                                                                                                                                                                             |
| RR v8 `handleError`                         | `react-router@8.5.0` `dist/development/index.d.ts:1463-1467`                                                | `(error, { request, context, params })` — the load `context` is available; template pins `^8.0.0` (`full-stack-build-files.ts:25`)                                                                                                                                                                           |
| Template file set                           | `cli/src/templates/full-stack-app-files.ts:779-799`; `full-stack-ui-files.ts:216-252`                       | today: `app/{config,features,models,services,middleware}` plus `lib/context-keys.server.ts` (5 keys), `services.server.ts` accessors; `src/` holds only `controllers/`, `middleware/`, `plugins/` barrels (`seam-wiring.test.ts:266-270`)                                                                    |
| `populateLoadContext`                       | `cli/src/templates/full-stack.ts:144-154`                                                                   | sets `sessionContext`, `csrfContext`, `loggerContext`, `secretsContext`                                                                                                                                                                                                                                      |
| Aliases                                     | `full-stack-build-files.ts:181, 276, 286-288`                                                               | only `~/*` → `./app/*` (tsconfig paths, Deno import map, Vite `tsconfigPaths`); no `src/` alias                                                                                                                                                                                                              |
| Generated ESLint                            | `cli/src/templates/npm-tooling.ts:65-88`                                                                    | Node/Bun only; no import-restriction rule; Deno projects use `deno lint` (`root-settings.ts:59-75`)                                                                                                                                                                                                          |
| `setu g module` (functional)                | `cli/src/schematics/module.ts:40-94`, `module-files.ts:39-212`, `seams/modules.ts:38-99`                    | plain exported functions over a `Map`; controller `register<P>Routes(router, services?)` with `router.group('/<n>')` and `void services`; managed `index.ts` and `src/modules/index.ts` (`registerModules`); first module rewrites `setu.config.ts` (`utils/modular-registration.ts`, `generate.ts:541-577`) |
| Full-stack awareness in generators          | `cli/src/commands/generate.ts:460-484`                                                                      | refuses a kernel path that shadows a React Router page                                                                                                                                                                                                                                                       |
| `setu check` ids                            | `cli/src/diagnostics/ids.ts:5-25`                                                                           | E001–E016, W001–W004 taken; no rule reads `app/`; diagnostics use text scanning (TypeScript is a dev dependency only, `cli/package.json:88`)                                                                                                                                                                 |
| Generated module tests                      | `cli/src/schematics/test-harness.ts:182-270`                                                                | POSTs carry no cookie or CSRF token → 403 under full-stack session CSRF (X91-2)                                                                                                                                                                                                                              |
| Session CSRF                                | `session-plugin/src/plugin/session-plugin.ts:133-138`; `options.ts:24-28, 293-299`; `csrf/exclude.ts:83-91` | `csrfFormMiddleware` (priority 325) on every non-GET/HEAD/OPTIONS route; bearer exemption requires `CREDENTIAL_SOURCE_STATE_KEY === 'header'`, set only by auth-plugin's middleware; the full-stack template configures no auth arm                                                                          |
| OpenAPI exclusion                           | `openapi-plugin/src/plugin/openapi-plugin.ts:94-117, 239`; `generators/declared-operation-ids.ts:14-23`     | options `exclude` (exact `route.path`) and `excludeOwners` (default `['health-plugin','metrics-plugin']`); the starter passes options through `openApiOptionsFor` (`rest-starter/src/app.ts:52-67`)                                                                                                          |
| Page routes registered on the kernel        | `react-router-plugin/src/plugin/react-router-plugin.ts:192-229`; `full-stack-build-files.ts:359, 401-414`   | catch-all GET/POST and `/assets/*` owned by `react-router-plugin`; `dev.ts` adds `GET /__vite/*` from app code                                                                                                                                                                                               |
| Generated README                            | `cli/src/templates/full-stack-app-files.ts:808-855`; `full-stack.ts:268-279`                                | "Deploying to Cloudflare Workers" (`:844-853`) is emitted for every runtime (V11-19)                                                                                                                                                                                                                         |
| `components.json`                           | `cli/src/templates/full-stack-ui-files.ts:218-239`                                                          | `iconLibrary: "lucide"` (`:231`); `lucide-react` in no dependency list (X85-1); current `lucide-react` is `1.67.0` (`npm view`, 2026-11-03)                                                                                                                                                                  |
| `entry.server.tsx`                          | `cli/src/templates/full-stack-app-files.ts:111-154`                                                         | exports only `handleRequest`; no `handleError` (X91-7)                                                                                                                                                                                                                                                       |
| Scaffold e2e                                | `cli/test/e2e/scaffold-runs-e2e.test.ts:175, 708-800, 1193-1280`                                            | boots full-stack, signs in through `/login` (scrapes `_csrf`), asserts signed-in `/products`; no test runs `g module` in a full-stack project                                                                                                                                                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                   | Resolution (picked side)                                                                                    | Doc deliverable (same PR)                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| C1  | `docs/react-router-dev.md` says the HMR socket connects to Vite's port; on Node and Deno the client tries the app port first and falls back (X85-3), and on Bun the app port works (X85-2) | the code is corrected to match the doc (§3.11): the HMR client connects to Vite's own port on every runtime | `docs/react-router-dev.md` states the port and `VITE_PORT`    |
| C2  | Gap 4 said "no `common` change"; the one-implementation rule needs the request-bound resolution shared by kernel routes and loaders                                                        | `common` gains the helpers (maintainer decision, 2026-11-03)                                                | PUBLIC_API common section                                     |
| C3  | Gap 4's proposed fix kept "a thin `app/services/<name>.server.ts` adapter"; the 2026-11-01 decision removes `app/services/`                                                                | no page-side adapter: loaders call `getService` directly                                                    | ROADMAP M130 text is consistent; the generated README says it |
| C4  | The generated README's "Deploying to Cloudflare Workers" section appears in Node, Deno and Bun projects and is wrong there (V11-19)                                                        | emitted only for the Workers runtime                                                                        | the template change itself                                    |

## 3. Design decisions

### 3.1 Request-bound services (`@setu-ts/common`, new `src/services/request-service.ts`)

- **Decision:**
  - `type ServiceToken<T> = CapabilityToken & { readonly __service?: T }` — a capability token
    carrying its service type, so `getService(context, PRODUCTS)` infers `T`.
    `serviceToken<T>(name: string): ServiceToken<T>` validates the name with `createCapabilityToken`
    (throws on a bad name) and returns it.
  - `requestService<T extends object>(create: (ctx: IRequestContext) => T): RequestBoundService<T>`
    returns a frozen object branded with `Symbol.for('setu.request-service')` holding `create`.
    `Symbol.for`, so the brand survives a duplicated module copy.
  - `resolveRequestService<T>(ctx: IRequestContext, token: ServiceToken<T> | CapabilityToken): T`:
    1. If `ctx.services.has(token)` is false, it throws `RequestServiceUnavailableError` naming the
       token (a named error; the registry's own `get` message stays for every other caller).
    2. If the entry is a `RequestBoundService`, `create(ctx)` runs at most once per request and
       token. With `ctx.slot` present it is cached through `ctx.slot(keyFor(token), …)`, where
       `keyFor` is a module-level `Map<string, object>`. Without `slot`, it is cached in a
       `WeakMap<IRequestContext, Map<string, unknown>>`. A `create` that returns a non-object throws
       `TypeError` naming the token. A `create` that throws propagates unchanged and is not cached,
       so the next call retries.
    3. Any other entry is returned as registered (a singleton: logger, secrets, any capability).
- **Why:** one implementation for kernel `/api` routes (which hold `ctx`) and loaders (§3.2).
  - The factory receives the kernel context (maintainer decision, 2026-11-03), so a module reads the
    tenant (`tenancy.getRepository(ctx, …)`), the principal and `ctx.signal` with no new type. Pages
    never receive `ctx`, only the factory's result.
  - Strings as tokens keep identity trivial across the SSR bundle copy.
- **Test home:** `packages/common/test/unit/request-service.test.ts`.

### 3.2 `getService` (`@setu-ts/react-router-plugin`, new `src/handler/get-service.ts`)

- **Decision:**
  - `serviceResolverContext = contextKeyFor<ServiceResolver | null>('setu.react-router.service-resolver', null)`,
    where `type ServiceResolver = <T>(token: ServiceToken<T> | CapabilityToken) => T`.
    `applyDefaultLoadContext` sets it to `(token) => resolveRequestService(ctx, token)`. The closure
    is the only thing exposed, never `ctx`.
  - `getService<T>(context: { get<V>(key: RouterContextKey<V>): V }, token: ServiceToken<T> | CapabilityToken): T`
    reads the key. If it is `null` (not served through the plugin's bridge), it throws
    `ServiceResolverUnavailableError` ("getService needs a request served by ReactRouterPlugin; in a
    test, set serviceResolverContext"). Otherwise it calls the resolver.
  - `serviceResolverContext` is exported so a page test sets a fake resolver on a
    `RouterContextProvider`.
  - `servicesContext` stays, documented as superseded by `getService` for module services. Removing
    it is out of scope (§0).
- **Why:**
  - It is the typed-key model React Router already uses (survey: RR `createContext`).
  - The key comes from `contextKeyFor`, so the identity rule holds across the SSR bundle.
  - One resolver per request means a factory's result is shared by every loader of that request, via
    `ctx.slot`.
- **Test home:** `packages/react-router-plugin/test/unit/get-service.test.ts`;
  `test/integration/get-service-kernel.test.ts`.

### 3.3 Template layout — `app/`

- **Decision:** `app/` holds:
  - `routes/`, `components/` (unchanged, plus `ui/`), `root.tsx`, `routes.ts`, `entry.*.tsx`,
    `app.css`;
  - `lib/` (client-safe): `nav-utils.ts`, `theme.ts`, `load-context.ts` (type-only, unchanged);
  - `server/` (server-only page glue):
    - `context-keys.server.ts` (moved from `lib/`) with `sessionContext`, `csrfContext`,
      `currentUserContext` only;
    - `session.server.ts` with `getSession`, `getCsrfToken`, `getCurrentUser` and `requireValue`
      (from the old `config/services.server.ts`, without the logger and secrets accessors);
    - `require-user.server.ts` (from `middleware/`).

  Removed: `app/config/`, `app/features/`, `app/models/`, `app/services/`, `app/middleware/`, and
  the `loggerContext`/`secretsContext` keys. Loaders get the logger and secrets with
  `getService(context, CAPABILITIES.LOGGER)` and the like.

- **Why:** maintainer decision 2 (2026-11-01). Services come only through `getService` (decision 3);
  session, CSRF and current user keep explicit keys.
- **Test home:** `packages/cli/test/unit/full-stack-template.test.ts` (path set, no removed paths).

### 3.4 Template layout — `src/` and `setu.config.ts`

- **Decision:**
  - The template ships the products example as a kernel module:
    - `src/modules/products/products.types.ts` — `Product`;
    - `products.service.ts` — `interface ProductsService { list(): Promise<readonly Product[]> }`
      and `productsService(ctx)`, reading static data and logging through
      `ctx.services.get(LOGGER)`;
    - `products.token.ts` —
      `export const PRODUCTS = serviceToken<ProductsService>('module.products')`; imports only
      `serviceToken` from `@setu-ts/common` and `import type` from its module;
    - `products.controller.ts` — `GET /api/products` returning
      `resolveRequestService(ctx, PRODUCTS).list()`;
    - managed `index.ts` — `registerProductsModule(router, services)` does
      `services.register(PRODUCTS, requestService(productsService))` and registers the routes;
    - managed `src/modules/index.ts` — `registerModules`.
  - **The registration is derived, not hand-written (maintainer decision, 2026-11-03, option A).** A
    module index is regenerated by `setu sync`, `setu g controller --module`, `g sse --module` and
    `setu add`, so a registration line written only by the template or `g module` would be erased by
    the next regeneration. The module scan therefore gains a `module-service` family: in a project
    with `react-router-plugin` installed and in functional mode, `src/modules/<m>/<m>.token.ts`
    exporting `<SCREAMING>` (the module's screaming-case name) is admitted.
    `renderFunctionalModuleIndex` reads that family and, when present, emits the `requestService`
    and token/service imports and the `services.register(...)` line ahead of the route registrars;
    the paired service module must export `<camel>Service`. A missing `services` argument throws a
    named `Error` (the token would otherwise be silently absent). Every index writer reads the same
    scan, so all of them render the line. Not exported from any package (`cli/src/seams/modules.ts`,
    `cli/src/utils/module-scanner.ts`, internal).
  - The template ships modular: the full-stack host drops the `controller` seam (no
    `src/controllers/` barrel, no `registerGeneratedRoutes`), and `setu.config.ts` imports
    `registerModules` from `./src/modules/index.ts` as a template local import.
  - `setu.config.ts` calls `registerModules(app.router, app.services)` (the modular layout from the
    start; no `src/controllers/` barrel). `populateLoadContext` sets only `sessionContext` and
    `csrfContext`.
  - `app/routes/_app/products._index.tsx`'s loader is `getService(context, PRODUCTS).list()` plus
    `getCurrentUser(context)`.
  - Module tokens are named `module.<kebab-name>` (legal under `createCapabilityToken`; no collision
    with `CAPABILITIES` values, which are un-namespaced).
- **Why:** maintainer decision 1. One service feeds the page and `/api/products`. The `/api` prefix
  keeps kernel routes off page paths (maintainer decision, 2026-11-03).
- **Test home:** `full-stack-template.test.ts`; `scaffold-runs-e2e.test.ts` (signed-in `/products`
  renders the module's data; `GET /api/products` returns the same list).

### 3.5 `~kernel/*` alias

- **Decision:** `~kernel/*` → `./src/*` in the template's tsconfig `paths`, and
  `"~kernel/": "./src/"` in the Deno import map. Vite already follows tsconfig paths
  (`resolve.tsconfigPaths: true`). `app/` reaches kernel code only through this alias.
- **Why:** maintainer decision 3. One spelling makes the boundary checkable (§3.7). Type imports are
  erased before bundling, and token modules inline a string constant, so no kernel module enters the
  client bundle.
- **Test home:** `full-stack-template.test.ts` (alias in all three places); the scaffold e2e
  `check`/`build`.

### 3.6 `setu g module <name>` in a full-stack project, and `--page`

- **Decision:**
  - In a project whose manifest has `react-router-plugin` (the detection `generate.ts:460-484`
    already uses), the functional module generator writes the §3.4 shape:
    - `types`, `service` (factory over an in-memory `Map`: `list/get/create/update`);
    - `token` (`module.<name>`);
    - `controller` with `router.group('/api/<name>')`, calling `resolveRequestService`;
    - managed `index.ts` registering token and routes.
  - `--page` (full-stack only; refused elsewhere, naming the template) also writes
    `app/routes/_app/<name>._index.tsx`. Its loader is `getService(context, <TOKEN>).list()` behind
    `requireUser`, with type and token imports through `~kernel/modules/<name>/…`.
  - Non-full-stack projects are unchanged.
- **Why:** the bridge is generated rather than hand-written (Gap 4 item 2). `/api/<name>` avoids the
  page-shadowing refusal for a module and its page of the same name.
- **Test home:** `packages/cli/test/unit/schematics/module-full-stack.test.ts`;
  `generate-module-switch.test.ts` (existing full-stack case updated); the scaffold e2e gate (§7);
  `packages/cli/test/unit/module-service-seam.test.ts` (the `module-service` scan admits only
  `<m>.token.ts` exporting `<SCREAMING>` and only in a full-stack functional project; the rendered
  index registers it; after `setu sync` and after `g controller <x> --module <m>` over a module
  holding a token, the regenerated `index.ts` still contains the `services.register` line).

### 3.7 `setu check` finding `setu.E017` `page-kernel-value-import`

- **Decision:**
  - A new diagnostic (`cli/src/diagnostics/page-imports.ts`) runs when `app/` exists. It scans every
    `app/**/*.{ts,tsx}` for `import`, `export … from` and `import()` whose specifier starts with
    `~kernel/`, or is a relative path resolving under `src/`.
  - Allowed:
    - `import type …` and `export type … from`;
    - any import whose resolved target matches `src/modules/*/*.token.ts`.
  - Refused, one finding each with file:line and the specifier:
    - every other value import, including `import { type A, type B }`: with `verbatimModuleSyntax`
      it survives as a side-effect import, so the message says "use `import type`";
    - a dynamic `import('~kernel/…')`;
    - an `export * from`.
  - The scanner strips comments and ignores string literals that are not import specifiers. Its
    accepted and refused shapes are a data table in the test.
  - **Implementation note (2026-11-03):** a pure text lexer misread JSX text (`It's`) as an
    unterminated string and reported the template's own pages unreadable. The page is therefore
    first transformed by esbuild (`tsx` loader, `verbatimModuleSyntax`), which is already a runtime
    dependency of `@setu-ts/cli` (`setu build`, `utils/import-specifiers.ts`), and the shared lexer
    reads that output: type imports are erased, and `import { type A }` appears as the side-effect
    `import {} from …` it really is. Lines map back to the original source. A page esbuild or the
    lexer cannot read is `setu.E018` `page-unreadable`, never a silent pass.
  - Severity is error, like E015. It can be silenced through `.setu-ts/check.json` like any finding.
- **Why:**
  - It is the one check every runtime runs: `check` scripts call `setu check` on Node, Deno and Bun,
    and Deno projects have no ESLint (maintainer decision, 2026-11-03).
  - It mirrors SvelteKit's `$lib/server` rule, the one surveyed framework documenting that type
    imports pass.
- **Test home:** `packages/cli/test/unit/diagnostics/page-imports.test.ts`; `check-command.test.ts`
  (finding id and render).

### 3.8 CSRF and `/api` (X91-5, X91-2)

- **Decision:**
  - Session CSRF stays on for every unsafe route (maintainer decision, 2026-11-03).
  - The generated README gains "Calling the API": browser code sends `x-csrf-token` (the page has
    the token); non-browser clients authenticate with a bearer token once an `auth` arm is
    configured, which the session CSRF bearer exemption already admits (`exemptBearer`, default on).
    Without an auth arm, a plain POST answers 403 by design.
  - Generated full-stack module tests (`test-harness.ts`) obtain a session and token the way the
    scaffold e2e does. A new helper `signedSession(app)` in the generated `test/support/server.ts`
    GETs `/login`, keeps the cookie and the `_csrf` field, and every unsafe request sends both.
    Non-full-stack harness output is unchanged.
- **Why:** no security relaxation. Tests pass right after generation (X91-2), and the 403 is
  explained where a developer looks (X91-5).
- **Test home:** `packages/cli/test/unit/schematics/test-harness.test.ts` (full-stack shape); the
  scaffold e2e runs the generated module tests.

### 3.9 OpenAPI excludes page, asset and dev-proxy routes (X91-6, V11-7)

- **Decision:**
  - `@setu-ts/full-stack-starter`'s OpenAPI defaults add `react-router-plugin` to `excludeOwners`
    (on top of OpenApiPlugin's defaults) and `/__vite/*` to `exclude`, merged with any
    application-supplied lists, never replacing them.
  - The generated `dev.ts` keeps registering `/__vite/*`. The exclusion matches its exact path, and
    an excluded path that is never registered (production) is harmless
    (`declared-operation-ids.ts:22` is a set membership test).
- **Why:** the starter is the composition owner. No openapi-plugin change, and non-full-stack apps
  are untouched.
- **Test home:** `packages/starters/full-stack-starter/test/unit/openapi-defaults.test.ts`; the
  scaffold e2e asserts `/openapi.json` lists `/api/products` and no `/*`, `/assets/*` or
  `/__vite/*`.

### 3.10 `handleError` in `entry.server.tsx` (X91-7)

- **Decision:**
  - The generated `entry.server.tsx` exports `handleError(error, { request, context })`.
  - It returns early when `request.signal.aborted`, or when `isRouteErrorResponse(error)` with
    status 404.
  - Otherwise it logs once through `getService<ILogger>(context, CAPABILITIES.LOGGER).error(…)` with
    `describeError(error)` and the request path.
- **Why:** an unknown URL is a 404, not a fault; real errors go to the structured log instead of a
  raw stack on stderr.
- **Test home:** `full-stack-template.test.ts` (export present); the scaffold e2e makes 10 unknown
  GETs and asserts no stack trace on stderr and 404 bodies.

### 3.11 Template odds and ends (X85-1, X85-3, X85-2, V11-19)

- **Decision:**
  - **X85-1:** `lucide-react` `1.67.0` (exact pin, read from `npm view` at implementation and
    recorded in the template's dependency table) is added to the full-stack dependencies, so
    `shadcn add` of Dialog, DropdownMenu or Select type-checks.
  - **X85-3, X85-2:** the generated `dev.ts` `vite.createServer` call
    (`full-stack-build-files.ts:368-377`, today `server: { port: vitePort, strictPort: true }`)
    becomes
    `server: { host: '127.0.0.1', port: vitePort, strictPort: true, hmr: { host: 'localhost', port: vitePort, clientPort: vitePort } }`,
    so the HMR client connects to Vite's own port on every runtime and never through the app port.
    - Edits update in place on Node, Deno and Bun (X85-2's intended behaviour: in place).
    - `strictPort` alone did not refuse a second server, because one bound IPv4 and the other IPv6
      (X85-3 evidence). With an explicit `host`, both bind the same address and the second fails
      loudly.
    - `dev.ts`'s `/__vite/*` proxy stays for module requests.
  - **V11-19:** the "Deploying to Cloudflare Workers" README section is emitted only for the Workers
    runtime.
- **Why:** each row's evidence names this exact cause (M130 note).
- **Test home:** `full-stack-template.test.ts`; `full-stack-app-files.test.ts` (README per runtime);
  the X85 probes (§7).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Additive in `common` and `react-router-plugin`.

The generated full-stack template changes shape (removed `app/` folders and keys). It is generated
output, not an API, and no existing users are assumed. The upgrade guide describes the new layout
for anyone porting a 0.11 scaffold.

| Symbol                                      | Kind                             | Consumer                                                                       |
| ------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `ServiceToken<T>`                           | type (common)                    | generated `*.token.ts`; `getService` and `resolveRequestService` signatures    |
| `serviceToken`                              | fn (common)                      | generated `*.token.ts`                                                         |
| `requestService`, `RequestBoundService<T>`  | fn + type (common)               | generated module `index.ts`                                                    |
| `resolveRequestService`                     | fn (common)                      | generated `/api` controllers; react-router-plugin's bridge                     |
| `RequestServiceUnavailableError`            | class (common)                   | thrown by `resolveRequestService`; asserted by users catching a missing module |
| `getService`                                | fn (react-router-plugin)         | generated loaders and `entry.server.tsx`                                       |
| `serviceResolverContext`, `ServiceResolver` | key + type (react-router-plugin) | the bridge (sets it); page tests (fake resolver)                               |
| `ServiceResolverUnavailableError`           | class (react-router-plugin)      | thrown by `getService` outside the bridge                                      |

### 4.1 Options — every option names its consumer

| Option                                              | Consumer                                 | Behaviour                                              |
| --------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `setu g module --page`                              | `schematics/module.ts` (full-stack only) | adds the page route (§3.6); refused outside full-stack |
| full-stack-starter OpenAPI defaults (no new option) | `composeFullStackPlugins`                | merges `excludeOwners`/`exclude` (§3.9)                |
| `VITE_PORT` env (generated `dev.ts`)                | Vite `server.port` / `hmr`               | §3.11                                                  |

## 5. Implementation files

| File                                                                                                                                             | Purpose                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `packages/common/src/services/request-service.ts`                                                                                                | §3.1                          |
| `packages/common/src/index.ts`                                                                                                                   | barrel exports                |
| `packages/react-router-plugin/src/handler/get-service.ts`                                                                                        | §3.2 `getService`, key, error |
| `packages/react-router-plugin/src/handler/load-context.ts`                                                                                       | sets `serviceResolverContext` |
| `packages/react-router-plugin/src/index.ts`                                                                                                      | barrel exports                |
| `packages/starters/full-stack-starter/src/app.ts` (or `openapi-defaults.ts`)                                                                     | §3.9                          |
| `packages/cli/src/templates/full-stack-app-files.ts`, `full-stack.ts`, `full-stack-build-files.ts`, `full-stack-ui-files.ts`, `project-files.ts` | §3.3–§3.5, §3.10, §3.11       |
| `packages/cli/src/schematics/module.ts`, `module-files.ts`, `test-harness.ts`; `commands/generate.ts` (`--page` flag)                            | §3.6, §3.8                    |
| `packages/cli/src/diagnostics/page-imports.ts`, `ids.ts`, `diagnose.ts`, `render.ts`                                                             | §3.7                          |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                  | src covered                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/request-service.test.ts`                        | `request-service.ts`                 | `serviceToken('Bad:Name')` throws; a request-bound factory runs once per request across two `resolveRequestService(ctx, T)` calls (with `slot` and without); two requests get two instances; a plain entry is returned as is; a missing token throws `RequestServiceUnavailableError` naming it; a non-object result throws `TypeError`; a throwing factory is not cached (second call retries); concurrent requests never see each other's instance |
| `packages/common/test/unit/barrel-exports.test.ts`                         | `index.ts`                           | the new values are exported                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/react-router-plugin/test/unit/get-service.test.ts`               | `get-service.ts`, `load-context.ts`  | `getService(provider, T)` with a fake resolver; `null` resolver throws `ServiceResolverUnavailableError`; `applyDefaultLoadContext` sets a resolver, and the provider holds no `IRequestContext` (walk the provider's values); key identity: `contextKeyFor` name returns the exported key                                                                                                                                                           |
| `packages/react-router-plugin/test/integration/get-service-kernel.test.ts` | the bridge path                      | a real kernel app + plugin + a stub server build whose loader calls `getService`: the page and a kernel `/api` route resolve the SAME instance within one request (one-implementation test, both entry points); two requests with different principals get different instances; a missing token answers 500 through the route's error boundary, and `handleError` logs it once                                                                       |
| `packages/react-router-plugin/test/unit/barrel-exports.test.ts`            | `index.ts`                           | new exports                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/starters/full-stack-starter/test/unit/openapi-defaults.test.ts`  | §3.9 source                          | defaults present; application `exclude`/`excludeOwners` are merged, not replaced                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/cli/test/unit/full-stack-template.test.ts` (extended)            | templates                            | path set (new present, removed absent); `~kernel` alias in tsconfig, Deno import map; `populateLoadContext` sets only session/csrf; `handleError` exported; `lucide-react` pinned; HMR config; no Workers README section except on Workers                                                                                                                                                                                                           |
| `packages/cli/test/unit/schematics/module-full-stack.test.ts`              | `module.ts`, `module-files.ts`       | full-stack shape (token name, `/api/<name>` group, `requestService` registration); `--page` writes the route; `--page` refused outside full-stack; non-full-stack output byte-identical to before                                                                                                                                                                                                                                                    |
| `packages/cli/test/unit/generate-module-command.test.ts` (extended)        | `commands/generate.ts`               | `--page` parsed and passed to the schematic; refused outside full-stack with the template named; `--dry-run --page` lists the route file                                                                                                                                                                                                                                                                                                             |
| `packages/cli/test/unit/schematics/test-harness.test.ts` (extended)        | `test-harness.ts`                    | full-stack tests use `signedSession` and send cookie + token on POST                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/cli/test/unit/diagnostics/page-imports.test.ts`                  | `page-imports.ts`                    | data table of accepted (type import, `export type`, token module, `~/` imports) and refused (value import, inline all-type braces, `export *`, dynamic import, relative into `src/`) shapes, each with expected line; comments and strings ignored                                                                                                                                                                                                   |
| `packages/cli/test/unit/check-command.test.ts` (extended)                  | `ids.ts`, `diagnose.ts`, `render.ts` | E017 id, render text, silencing                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (extended)               | end to end                           | §7 gate                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m130-full-stack-kernel-modules
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage common react-router-plugin full-stack-starter cli
pnpm run test:deno-lane
pnpm run check:apps
pnpm run ci:local
pnpm run release:publish --dry-run
pnpm run release:verify 0.11.0
```

**Generated-output gate (CLAUDE.md, M63):** the scaffold e2e, on Node, Deno and Bun:

1. Scaffold a full-stack project, run `setu g module articles --page`, then install, `check`
   (including `setu check` clean), `build`, and the generated `test` and `test:e2e`, which must pass
   with no hand edit (X91-2).
2. Boot it, sign in through `/login`, and GET `/articles`. Assert the page lists data the module's
   service holds: seed it through `POST /api/articles` with the session cookie and CSRF token, then
   read it back on the page.
3. `GET /api/articles` returns the same list.
4. `/openapi.json` lists `/api/articles` and `/api/products`, and no `/*`, `/assets/*` or
   `/__vite/*`.
5. 10 unknown URLs produce 404s and no stack trace on stderr.
6. A template baseline asserts `setu.config.ts` is byte-identical before and after `g module --page`
   apart from the managed registration lines.
7. Add `import { productsService } from '~kernel/modules/products/products.service.ts'` to a route;
   `setu check` fails with `setu.E017`.

**X85 probes**
(`/home/dkpaul91/Projects/hono-enterprise-published-smoke/v0.11.0/part19/x85/probes/`): `ui.mjs` (18
checks), `theme.mjs` (19) and `hmr.mjs`, run against a fresh scaffold on Node, Deno and Bun. Also
the `shadcn add dialog dropdown-menu select` + `check` sequence from X85-1. The probes need the
user's visual OK (memory `user-reviews-visuals-before-recording`) only if they are recorded. Here
they are pass/fail.

## 8. Risks & mitigations

- **A request-bound instance leaks across requests** (cached on the wrong key). → The cache key is
  `(request, token)`: `ctx.slot` is per request, and the fallback `WeakMap` is keyed by `ctx`. The
  concurrency test runs 50 interleaved requests with distinct principals and asserts each sees its
  own.
- **A token module grows a value import from the service**, pulling kernel code into the client
  bundle. → The generated token imports only `serviceToken` and `import type`. E017 checks `app/`,
  not token modules, so the template test pins the token file's imports, and the README says token
  files hold nothing else.
- **`registerModules` registers after bootstrap in some composition** (`register` throws). →
  `setu.config.ts` calls it before `start()` (§1 bootstrap timing); the scaffold e2e boots it.
- **The first-module switch** (`modular-registration.ts`) mis-handles a project that is already
  modular. → `generate-module-switch.test.ts`'s full-stack case is updated to the new template,
  which is modular from the start.
- **The HMR client cannot connect cross-port** (the page is served from the app port; Vite's
  WebSocket host and origin checks may refuse it), **or `strictPort` breaks a user running two
  apps.** → `hmr.mjs` on all three runtimes is the deciding probe, run at implementation BEFORE the
  template change lands. If Vite refuses the cross-port socket, implementation stops and returns
  here; the fallback (keep the app-port socket and fix its upgrade path) is a design change, not an
  improvisation. `VITE_PORT` is documented in the README and `docs/react-router-dev.md`.
- **The E017 text scanner misreads exotic syntax** (multi-line imports, `import x, { type Y }`). →
  The data-table test includes multi-line and mixed forms; a misread is an error the user can
  silence, never a silent pass.

## 8a. Design security review

- **Flows:**
  - F1: a loader resolves a request-bound service with the request's principal and tenant.
  - F2: a kernel `/api` route resolves the same service.
  - F3: an unsafe `/api` request under session CSRF.
  - F4: a page module importing kernel code.
- **Threats:**
  - **T1, cross-request instance reuse** (one user's service, holding their principal, serves
    another). Resolution: §3.1 cache keyed per request; the concurrency test.
  - **T2, kernel context exposed to pages** (`ctx.response`, state). Resolution: only a resolver
    closure is placed in the load context; the unit test walks the provider's values.
  - **T3, CSRF weakened for `/api`.** Resolution: unchanged; the bearer exemption still needs
    auth-plugin's header credential source.
  - **T4, server code in the client bundle via a value import.** Resolution: E017. Vite's own graph
    is not changed.
  - **T5, `getService` used for a capability the page should not reach** (`DATABASE`). Accepted:
    pages run server-side with the same trust as kernel routes, and `servicesContext` already
    exposed the registry.
- **Obligations the committed-tree audit probes:**
  - O1: T1 with 50 concurrent principals.
  - O2: T2 (no `IRequestContext` reachable from the load context).
  - O3: a cookie POST to `/api/*` without a token is 403, with one is 201, and a bearer without an
    auth arm is 403.
  - O4: E017 refuses each refused shape, with a negative control that removes the scanner.
- **Audit:** `.roo/skills/security-audit/SKILL.md` on the PR's head commit, by a fresh agent (never
  Codex, never the implementing context).

## 9. Out of scope

- Class-based (DI, decorators) full-stack modules, because full-stack is functional-only. A future
  milestone would bind `@Injectable({ scope: 'scoped' })` through `forRequest`.
- Removing `servicesContext`.
- An ESLint rule for editor feedback. `setu check` is the single enforcement (maintainer decision,
  2026-11-03).
- Workers-specific full-stack changes beyond the README condition.
- The `components.json` `utils` alias pointing at a file the template does not emit. It is not in a
  folded row and is recorded for M131c.
