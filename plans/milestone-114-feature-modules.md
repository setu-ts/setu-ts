# Milestone 114 — Self-Contained Feature Modules (`@setu-ts/cli`, `@setu-ts/validation-plugin`, `@setu-ts/common`, `@setu-ts/decorator-plugin`)

> **Status:** Planning. Branch: `feat/m114-feature-modules`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A feature is one folder. In the default (functional) style `setu generate module <name>` today
writes the service into `src/modules/<name>/` and the routes into
`src/controllers/<name>.routes.ts`, so a feature lives in two places, cannot be deleted as a unit,
and its generated test asserts a stub (`list…()` returns `[]`) that stops compiling the moment the
service is real (V9-79: M104's builder deleted all eight). This milestone makes a functional module
self-contained and registered through `src/modules/index.ts`, adds feature-scoped placement
(`--module`), gives request and response shapes a home (`<name>.schemas.ts`) with a typed accessor
that removes the `ctx.state.get(...) as z.infer<…>` cast, moves the `rest` sample into
`src/modules/greeting/`, and emits tests a project can grow: an in-process unit test per module, a
real-socket e2e per module, and an app-level `test/e2e/app.e2e.test.ts` with a separate `test:e2e`
task.

- **In scope:** the functional module shape and its activation barrel on every host; functional and
  class-based module scanning in the name-conflict and barrel paths; `--module` for `service`,
  `route` (functional only), `controller` and `schema`; the `schema` schematic; `src/shared/`
  documented; the `rest` sample move; generated unit + e2e tests and the `test`/`test:e2e` split on
  every socket target; the validator-as-reader (`validateBody(S).value(ctx)`) in
  `validation-plugin`; form-body validation (urlencoded and multipart) through the same
  `validateBody`; a measured performance budget; `zod` declared by every host that installs
  `validation-plugin` and by `setu add validation`; docs, CHANGELOG, upgrade guide, ROADMAP.
- **NOT this milestone:** the browser e2e scaffold (`setu add testing --browser`, ROADMAP item 6
  follow-on, unowned); placing app-wide kinds inside a module; a configurable layout (the parked
  "project layout" proposal); route-schema typing (`schema: { body }` handing the handler typed
  `{ body }`, the Fastify/Hono shape — needs `IRouterApi` generics in `common`/`kernel`; recorded in
  ROADMAP as a later candidate, §3.9); the OpenAPI document describing a form body as anything but
  JSON; editing a developer-owned `@Module` declaration or schemas file (§3.6, §3.8).

## 1. Contracts verified from SOURCE (not names)

| Reference                                                | Source (file:line)                                                                                                                                                                      | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Functional `generateModule`                              | `packages/cli/src/schematics/module.ts:163`                                                                                                                                             | Functional arm writes `src/modules/<n>/{<n>.service.ts,<n>.service.test.ts,index.ts}` plus `src/controllers/<n>.routes.ts` and regenerates `src/controllers/index.ts`; test asserts `list<P>()` equals `[]`                                                                                                                                                                       |
| `scanModules`                                            | `packages/cli/src/utils/module-scanner.ts:80`                                                                                                                                           | Admits a directory only when it holds `<n>.controller.ts`, `<n>.service.ts` AND `<n>.module.ts` (class-based shape); controller+service without module → `skipped`. No functional admission exists                                                                                                                                                                                |
| `findNameConflict` / `CONFLICT_GROUPS`                   | `packages/cli/src/utils/name-conflicts.ts:73,139`                                                                                                                                       | HTTP-path group `['route','controller','module']` in every mode; `module` presence read from the `modules` list, i.e. only class-based modules. The functional `module`↔`route` clash is caught today only by the shared filename                                                                                                                                                 |
| `renderHttpBarrel`, `FUNCTIONAL_ROUTES_SEAM`             | `packages/cli/src/seams/http.ts:102,245`                                                                                                                                                | Reads `src/controllers/` flat; emits `registerGeneratedRoutes(router, services?)` calling each `register<P>Routes`                                                                                                                                                                                                                                                                |
| `readArtifactNames`                                      | `packages/cli/src/utils/artifact-scanner.ts` (`readArtifactNames`)                                                                                                                      | Flat `readdir` of `spec.dir`; admission = suffix + exported `importSymbols`; reports `skipped`/`adopted`/`manual`                                                                                                                                                                                                                                                                 |
| `SchematicOptions`, `GeneratedFile`                      | `packages/cli/src/schematics/registry.ts`, `utils/file-writer.ts:16`                                                                                                                    | `modules?`/`legacyModules?`/`artifacts?`/`migrations?` are optional for custom-schematic compatibility; `GeneratedFile.managed` exempts a path from `findExisting`                                                                                                                                                                                                                |
| `generate` command flow                                  | `packages/cli/src/commands/generate.ts:148`, `flags.ts:148`                                                                                                                             | Flags today: `dir`, `dry-run`, `runtime`; scans modules then artifacts, refuses conflicts BEFORE the schematic runs, `reportUnwiredDecoratorSeams` (`:578`) prints the exact config line when a barrel is unreferenced                                                                                                                                                            |
| `renderModuleBarrel` / `MODULE_SEAM_FILES`               | `packages/cli/src/schematics/module-barrel.ts:34`, `templates/module-seam.ts`                                                                                                           | Class-based activation barrel exporting `MODULES`; scaffolded only by the class-based arm (`withModuleSeam`)                                                                                                                                                                                                                                                                      |
| `REST_SHOWCASE_FILES`                                    | `packages/cli/src/templates/rest-showcase.ts:53`                                                                                                                                        | Emits `src/services/greeting.service.ts` + `src/controllers/greeting.controller.ts` (layered form)                                                                                                                                                                                                                                                                                |
| `FUNCTIONAL_MODULE_MANIFEST`, `TEST_DEPENDENCY_MANIFEST` | `packages/cli/src/templates/module-seam.ts:32`, `test-deps.ts:45`                                                                                                                       | Neither declares `zod`; generated projects carry no Zod dependency today                                                                                                                                                                                                                                                                                                          |
| Generated smoke test + test tasks                        | `packages/cli/src/templates/project-files.ts:1942,1526`                                                                                                                                 | Socket targets emit `test/app.test.ts` (`createTestApp` + `inject`); Workers emits none. Node `test` = `tsx --test` (no glob), Bun `bun test`, Deno `deno test -A`. `@setu-ts/testing` is declared on every socket target (`:1105`)                                                                                                                                               |
| `StartOptions`, ephemeral port                           | `packages/common/src/plugin.ts:421`, `kernel/src/application/application.ts:2223`                                                                                                       | `start({ port: 0 })` binds an ephemeral port but no API exposes the bound port — a generated e2e must pick a free port itself                                                                                                                                                                                                                                                     |
| `validatedStateKey`                                      | `packages/common/src/services/validation.ts:37`                                                                                                                                         | Key `validation-plugin:validated-<target>`; value is the parsed output; read by `decorator-plugin`'s `Body()`/`Query()`/`Params()` resolvers                                                                                                                                                                                                                                      |
| `createValidationMiddleware`, `bindHelper`               | `packages/validation-plugin/src/middleware/validation-middleware.ts:129,290`                                                                                                            | Body extraction is `ctx.request.json()` only; on success `ctx.state.set(validatedStateKey(target), value)`; helpers resolve the service per request and call `service.middleware(schema, target)`                                                                                                                                                                                 |
| `ValidationService.middleware`                           | `packages/validation-plugin/src/services/validation-service.ts:124`                                                                                                                     | Wraps the caller's schema in `applySchemaPolicy(...)` BEFORE building the middleware, and each helper calls it once PER REQUEST (`bindHelper`) — so neither the schema object nor the inner middleware is a stable identity; §3.9 keys `.value(ctx)` on the OUTER helper's instance token instead                                                                                 |
| `RouteDefinition`, `RouteSchema.response`                | `packages/common/src/http.ts:1005,467`                                                                                                                                                  | Imperative routes accept `{ handler, middleware?, schema? }`; `schema.response` is `Record<number, unknown>`; `openapi-generator.ts:746,808` reads it and derives the request body from the validation brand (M70m)                                                                                                                                                               |
| `IRequest.formData?`                                     | `packages/common/src/http.ts:160`                                                                                                                                                       | Optional form accessor exists (M94b); `validateBody` never calls it (§3.12)                                                                                                                                                                                                                                                                                                       |
| `ApiResponse`, `ValidateBody/Query/Params`               | `packages/decorator-plugin/src/decorators/openapi.ts:34,92`, `validation.ts:32,54,76`                                                                                                   | `ApiResponse({ status, description?, schema? })`; `Validate*` record `meta.schema.<target>` which E1 enforces through the validation service                                                                                                                                                                                                                                      |
| Zod output type                                          | probe (zod 3.25.76 and 4.x, `packages/validation-plugin` dev deps)                                                                                                                      | `S extends { readonly _output: infer O } ? O : never` yields the parsed type (coercions, defaults) for BOTH v3 and v4 objects; a wrong annotation is `TS2322` (measured)                                                                                                                                                                                                          |
| NestJS `nest new` / `nest g resource` / `nest g service` | `@nestjs/schematics@12.0.9`: `application/files/ts/test/app.e2e-__specFileSuffix__.ts`, `package.json:21`, `resource/files/ts/`, `utils/module.finder.js`, `service/service.factory.js` | `nest new` emits `test/app.e2e-spec.ts` (supertest over `createNestApplication()`) and a `test:e2e` script; `g resource` writes one folder with `dto/` (one class per file) and updates the module; `g service users/pricing` writes `users/pricing/pricing.service.ts` (non-flat) and declares it in the NEAREST `*.module.ts` walking up; its spec asserts only `toBeDefined()` |
| Unit/e2e test separation per runtime                     | probe (Deno 2.9.6, Bun 1.4.2, Node 24.18 + tsx)                                                                                                                                         | Deno `--ignore='**/*.e2e.test.ts'`; Bun `--path-ignore-patterns='**/*.e2e.test.ts'` and `bun test .e2e.test`; Node `tsx --test '**/!(*.e2e).test.ts'` and `tsx --test '**/*.e2e.test.ts'` — all exclude `node_modules` (measured)                                                                                                                                                 |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                                                                                                                                       | Doc deliverable (same PR)                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| C1  | ROADMAP M114 item 7: `g schema <name> --module <m>` "adds another shape to a module's file" — editing an existing developer file, which M101g restricted to text the CLI can classify                       | The CLI never edits a developer file. `g schema <name> --module <m>` writes a NEW `src/modules/<m>/<name>.schemas.ts` for a sub-resource; the module's own shapes stay in `<m>.schemas.ts` (one file per module, written once by `g module`) — §3.8            | ROADMAP M114 item 7 corrected; `docs/cli.md` shapes section                      |
| C2  | ROADMAP item 2 implies `--module` works the same for all kinds in both styles; a class-based `@Module` is developer-owned ("The CLI never rewrites this declaration", `module.ts` emitted JSDoc)            | Class-based `--module` writes the file and prints the exact `@Module` line to add; it never edits the declaration. `route --module` is functional-only (a class-based module has no imperative registration point) — §3.6                                      | ROADMAP item 2 + `docs/cli.md` rule table                                        |
| C3  | ROADMAP item 6: the per-module unit test "imports the module through its `index.ts`"                                                                                                                        | The unit test drives the module's routes in-process through `createTestApp({ app: await createApp() })`; the module index is the registrar the app calls, so the test exercises it by construction without importing a symbol the developer may rename — §3.10 | ROADMAP item 6 corrected                                                         |
| C4  | `docs/decorators.md:949` `autoDiscover` example uses `controllersPath: './src/controllers'`, which misses module controllers                                                                                | The example names `./src` with a note that `autoDiscover` scans recursively from that root                                                                                                                                                                     | `docs/decorators.md`                                                             |
| C5  | `docs/cli.md:226` describes the functional `module` registration as "a `register…Routes(router)` call"                                                                                                      | Functional modules register through `registerModules(app.router, app.services)` from `src/modules/index.ts`                                                                                                                                                    | `docs/cli.md` schematic table and Domain modules section                         |
| C6  | ROADMAP item 7 names `validated(ctx, Schema)` or a route option as the accessor, and the plan's first draft chose `validated(ctx, target, Schema)`; ROADMAP item 7 also deferred form bodies to a follow-on | The validator is the reader (`validateBody(S).value(ctx)`, §3.9 — maintainer decision 2026-10-20 after comparing Hono, Fastify and tRPC); form bodies are folded in (§3.12, maintainer decision)                                                               | ROADMAP M114 item 7 corrected; route-schema typing recorded as a later candidate |

## 3. Design decisions

### 3.1 The functional module shape

- **Decision:** `setu generate module <n>` in functional mode writes, all inside `src/modules/<n>/`:
  `<n>.service.ts`, `<n>.routes.ts`, `index.ts` (managed), `<n>.test.ts`, `<n>.e2e.test.ts` (socket
  targets only, §3.10), and `<n>.schemas.ts` when `validation-plugin` is installed (§3.7). It
  regenerates `src/modules/index.ts` (managed, §3.2). It writes NOTHING under `src/controllers/`.
  `<n>.routes.ts` exports `register<P>Routes(router, services?)` (the existing
  `routeRegistrarSymbol`) mounting `router.group('/<n>', …)` with `GET /`, `GET /:id`, `POST /`,
  `PATCH /:id`, importing its service and schemas as siblings. The service is an in-memory store
  (`Map` keyed by `crypto.randomUUID()`), exporting `list<P>`, `get<P>`, `create<P>`, `update<P>`,
  with a JSDoc saying to replace the store with a repository — chosen over a throwing stub so the
  generated e2e passes from the first run, and over an empty-array stub because the tests assert a
  CONTRACT (create then read back) that a real repository also satisfies.
- **Why:** one folder per feature, deleted as a unit (ROADMAP §"Why feature folders").
- **Test home:** `test/unit/schematics/module.test.ts`, `test/e2e/feature-module-e2e.test.ts`.

### 3.2 The functional module activation barrel and per-module index

- **Decision:** two managed files.
  - `src/modules/<n>/index.ts` exports exactly one symbol, `register<P>Module(router, services?)`,
    which calls every registrar in the module folder in sorted order: `<n>.routes.ts` plus every
    `*.routes.ts` / `*.controller.ts` placed there by `--module` (§3.5). It re-exports nothing — the
    pre-M114 `export * from './<n>.service.ts'` is gone, because a managed file that re-exports
    developer symbols breaks the moment two services export one name. Header comment: CLI-owned,
    regenerated by `setu generate … --module <n>`.
  - `src/modules/index.ts` in functional mode exports `registerModules(router, services?)` calling
    each admitted module's `register<P>Module`, sorted. Class-based mode keeps `renderModuleBarrel`
    unchanged — the path is shared and the content is chosen by generator mode, the same per-mode
    rule `renderHttpBarrel` already applies.
  - `registerModuleSymbol(names)` (`register<P>Module`) and `REGISTER_MODULES_EXPORT`
    (`'registerModules'`) are owned in ONE new module, `packages/cli/src/seams/modules.ts`, read by
    both the renderers and the scanner (the M60 `importSymbols` rule).
- **Why:** the app-level barrels do not change when a feature grows (ROADMAP item 2), and the
  registration point is the module itself.
- **Test home:** `test/unit/seams/modules.test.ts`, `test/unit/schematics/module.test.ts`.

### 3.3 Functional hosts wire the activation barrel from scaffold time

- **Decision:** every functional host — every template's functional arm, the no-template minimal
  host, `full-stack`, and workspace members — scaffolds `src/modules/index.ts` (empty
  `registerModules`) and its `setu.config.ts` calls `registerModules(app.router, app.services);`
  immediately after `registerGeneratedRoutes(...)`, through the same setup-call path
  (`templates/seam.ts` `seamSetupCalls`) and local-import path the HTTP seam uses. It is NOT a
  `SeamSpec` (a module is a directory, not a suffixed file, so `readArtifactNames` cannot scan it):
  `templates/project-files.ts` adds the barrel file, the local import and the setup call for every
  functional host it resolves (`project-files.ts:222` assembles host setup calls, so standalone
  projects, workspace members, `minimal` and `full-stack` all pass through it). Workers hosts get it
  too (the call is runtime-neutral). Class-based hosts are unchanged (`MODULES` via
  `DecoratorPlugin({ modules })`).
- **Why:** a project that gains the seam only on first `g module` would need its config edited then
  — the write the managed-barrel design exists to avoid (`module-seam.ts` module JSDoc).
- **Test home:** `test/unit/templates.test.ts`, `test/fixtures/template-baseline.json` (regenerated
  and reviewed), `test/e2e/seam-probe.test.ts`.

### 3.4 Scanning: functional modules are first-class in the conflict and barrel paths

- **Decision:** `scanModules(fs, dir, mode)` gains the generator mode. Functional admission: a
  directory holding `<n>.routes.ts` and `index.ts`, where `index.ts` exports `register<P>Module`
  (symbol-based admission, the `readArtifactNames` rule). A directory with `<n>.routes.ts` but an
  index lacking the symbol is `skipped` and reported ("add the export or delete and regenerate"). A
  PRE-M114 functional module (service + index, no `<n>.routes.ts`) is neither admitted nor reported:
  its routes are still wired by `src/controllers/index.ts` (Compatibility). The functional names
  feed BOTH `SchematicOptions.modules` (so the barrel lists them) AND `findNameConflict`'s `modules`
  argument, so `g route invoices` beside module `invoices` is refused before any write. A second
  scan, `scanModuleArtifacts(fs, dir, module)`, lists the registrars inside one module folder for
  the per-module index (§3.5), with the same admission and `skipped` reporting.
- **Why:** after the move the two files no longer share a path, so the overwrite refusal stops
  catching the clash: the project would type-check and fail at boot with a duplicate route (M68).
  That is the ROADMAP's named regression trap.
- **Test home:** `test/unit/utils/module-scanner.test.ts`, `test/unit/utils/name-conflicts.test.ts`
  (fails without the functional names — negative control 1).

### 3.5 Feature-scoped placement: `--module <m>`

- **Decision:** a new value flag `--module` on `generate` (added to `VALUE_FLAGS` and the `generate`
  flag inventory). Accepted only for `service`, `route`, `controller`, `schema`; any other schematic
  given `--module` is refused (exit 2) with: "`--module` places a feature file; `<schematic>` is
  app-wide and lives in `<dir>`." `<m>` must name an ADMITTED module of the project's mode, else
  exit 1 listing the admitted modules. Placement:
  - functional `service x --module m` → `src/modules/m/x.service.ts` (plain functions, sibling
    imports); no barrel change (services register nothing).
  - functional `route x --module m` / `controller x --module m` → `src/modules/m/x.routes.ts` /
    `x.controller.ts`, mounted at `/m/x`, and `src/modules/m/index.ts` regenerated to call it.
  - class-based `service x --module m` / `controller x --module m` → the file under
    `src/modules/m/`, DI token `m-x-service`, controller path `/m/x`; the CLI prints
    `Add X to @Module({ providers | controllers }) in src/modules/m/m.module.ts` and edits nothing
    (C2). `route --module` in class-based mode is refused naming top-level `g route`.
  - `schema x --module m` → §3.8. Module-scoped artifacts are namespaced by the module (path prefix,
    DI token prefix) so they never collide with a top-level artifact of the same name. With
    `--module`, the GLOBAL HTTP-path and DI-token groups of `findNameConflict` are skipped and
    replaced by an in-module check that refuses a `route` and a `controller` of one name (both
    export `register<P>Routes` into one index — `TS2300`). A module-scoped static path (`/m/x`) and
    the module's own `GET /m/:id` coexist — the kernel ranks a static segment over a param (M70g) —
    so an `id` equal to `x` is unreachable through `/:id`; `docs/cli.md` states it. The schematic
    receives the target as a new optional `SchematicOptions.targetModule?: string` (optional for the
    published-interface reason the other scan fields give; not `module`, which would read as one
    entry of the existing `modules` list) plus `SchematicOptions.moduleArtifacts?` (the §3.4
    per-module scan).
- **Why:** mirrors `nest g service users/pricing` (verified, §1) without editing a declaration the
  developer owns.
- **Test home:** `test/unit/generate-module-placement.test.ts`,
  `test/e2e/feature-module-e2e.test.ts`.

### 3.6 App-wide kinds stay top-level; `src/shared/` is documentation only

- **Decision:** `middleware`, `plugin`, `health-indicator`, `metric`, `migration`, `guard`,
  `command-handler`, `query-handler`, `event-handler`, `job`, `ws-route`, `sse` refuse `--module`
  (§3.5). `src/shared/` is documented in `docs/cli.md` (helpers, request-scoped dependency access,
  shared types, `src/shared/schemas/`) and is NOT scaffolded as an empty folder; the scanner already
  ignores a directory that is not an admitted module, which a test pins for both modes.
- **Why:** one stated rule — a file that belongs to one feature goes in the feature.
- **Test home:** `test/unit/generate-module-placement.test.ts`,
  `test/unit/utils/module-scanner.test.ts`.

### 3.7 Request and response shapes: `<n>.schemas.ts`

- **Decision:** when `validation-plugin` is installed, `g module` emits
  `src/modules/<n>/<n>.schemas.ts` importing `{ z } from 'zod'` and exporting, each as a value plus
  a same-named `z.infer` type: `Create<P>Body`, `Update<P>Body` (`Create<P>Body.partial()`),
  `List<P>Query` (`limit`/`offset` with `z.coerce.number()` defaults), `<P>Params` (`{ id }`),
  `<P>Response`, `<P>ListResponse`. Functional routes attach
  `validateBody/validateQuery/validateParams` and `schema: { response: { 200|201: … } }`;
  class-based controllers use `@ValidateBody/@ValidateQuery/@ValidateParams`, `@ApiResponse` and
  `@Params(Body<Create<P>Body>())`. Without `validation-plugin` the module is emitted with no
  schemas file and untyped `Record<string, unknown>` bodies (today's behaviour), and the routes
  import nothing from `validation-plugin`.
- **`zod` is declared**: `FUNCTIONAL_MODULE_MANIFEST` (and therefore every template carrying
  `validation-plugin`) gains `zod: ^4` in `npmDependencies` and `npm:zod@^4` in `denoImports`; `zod`
  joins `CLIENT_RANGES`; `setu add validation` adds it on every runtime through the existing `peers`
  mechanism (`runtimes: ['deno','node','bun','cloudflare-workers']`).
- **A project without `zod`:** a project scaffolded before M114 installs `validation-plugin` but
  declares no `zod` (`detectPlugins` reads only `@setu-ts/*` names, so the gate cannot see it).
  `g module` and `g schema` therefore read the manifest for `zod`; when it is absent they still
  write the files and print the exact install command for the detected runtime (`npm install zod@^4`
  / `bun add zod@^4` / `deno add npm:zod@^4`), the M113h `ws` precedent — they never edit the
  manifest, and never report success silently over an import that cannot resolve.
- **Why:** M104 declared every schema inline and cast every validated value; OpenAPI and the SDK
  client now describe the module from its first commit.
- **Test home:** `test/unit/schematics/module.test.ts`, `test/unit/commands/add.test.ts`,
  `test/e2e/feature-module-e2e.test.ts` (asserts `/openapi.json` paths + component schemas).

### 3.8 The `schema` schematic

- **Decision:** new registry entry `schema`, gated `requiresPlugin: 'validation-plugin'`. Without
  `--module` it writes `src/shared/schemas/<n>.schemas.ts`; with `--module m` it writes
  `src/modules/m/<n>.schemas.ts`. Contents: one `export const <P> = z.object({})` and
  `export type <P> = z.infer<typeof <P>>`. Never edits an existing file (C1); a second run is the
  ordinary overwrite refusal. Generating `schema m --module m` is refused by that same refusal,
  since `g module m` wrote `m.schemas.ts`.
- **Why:** C1.
- **Test home:** `test/unit/schematics/schema.test.ts`.

### 3.9 The typed validated-value accessor: the validator is the reader (maintainer decision 2026-10-20)

- **Decision:** the five helpers and `createValidationMiddleware` return
  `ValidatorMiddleware<ValidatedOutput<S>>`, which is a `MiddlewareFunction` (so every existing call
  site type-checks unchanged) with one added member, `value(ctx: IRequestContext): T`.
  `validateBody<S>(schema: S)` infers `S`, and
  `type ValidatedOutput<S> = S extends { readonly _output: infer O } ? O : unknown` (measured on Zod
  3.25 and 4.x). A generated route declares `const createBody = validateBody(CreateXBody);`, lists
  `createBody` in its `middleware`, and reads `createBody.value(ctx)` in the handler — the schema is
  written once and the type follows it, the Hono `c.req.valid(...)` / Fastify type-provider / tRPC
  `.input()` property. There is no `validated(ctx, target, schema)` function.
- **Which run of the validator `value` reads:** the middleware keeps writing the parsed value under
  `validatedStateKey(target)` (unchanged wire format, still read by `decorator-plugin`) and
  additionally records WHICH validator instance wrote it, under the package-private key
  `validation-plugin:validated-by-<target>`. `value(ctx)` returns the stored value only when that
  record is its own instance, and otherwise throws `TypeError` with a fixed message naming the
  target (a programming error, masked to 500): the validator is not in this route's chain, or a
  later validator for the same target overwrote it. The instance token belongs to the OUTER helper,
  because the helpers resolve the service per request and build an inner middleware each time; the
  helper passes its token through an internal (non-exported) builder that
  `ValidationService.middleware` and `createValidationMiddleware` share, so all entry points still
  funnel through one implementation. `IValidationService.middleware` in `common` is unchanged (it
  keeps returning `MiddlewareFunction`).
- **Why:** every reference framework derives the handler's type from the validator declaration;
  restating the schema in the handler turns a compile-time guarantee into a run-time check.
  Route-schema typing (`schema: { body }` giving the handler typed `{ body }`) is the larger option
  and needs generic changes to `IRouterApi` in `common`/`kernel`; it is recorded in ROADMAP as a
  later candidate, not built here.
- **Test home:** `packages/validation-plugin/test/unit/validator-reader.test.ts` (value returned
  after the middleware runs; coerced/defaulted output; throws when the reader's middleware did not
  run; throws when a second validator for the same target ran after it; a `@ts-expect-error` row
  assigning `createBody.value(ctx)` to a wrong type), `test/integration/validator-reader.test.ts`
  (real kernel app; helper under a NON-default `whitelist: true` policy and `service.middleware`
  both reach one implementation), and the generated-route grep (no `as` cast; uses `.value(ctx)`).

### 3.10 Generated tests: unit, module e2e, app e2e

- **Decision:**
  - `setu new` on every socket target (deno, node, bun) emits `test/support/server.ts` (managed) and
    `test/e2e/app.e2e.test.ts`. `server.ts` exports `startTestServer(): Promise<{ baseUrl; stop }>`:
    picks a free port with `node:net` (`createServer().listen(0)` → read `address().port` → close),
    boots `await createApp()` with `app.start({ port, hostname: '127.0.0.1' })`, and `stop()` calls
    `app.stop()`. `node:net` was chosen because it runs unchanged on all three runtimes; a kernel
    API exposing the bound port would be a `common` widening for test convenience. The app e2e
    requests `/health` and `/ready` when the host installs `health-plugin` (otherwise `/`), plus the
    `greeting` module's routes when the host emits that showcase, over `fetch`, never `inject()`.
  - `g module` adds `src/modules/<n>/<n>.e2e.test.ts` (socket targets) — POST a valid body → 201,
    GET `/<n>/<id>` → the created record, POST an invalid body → 400 (only with schemas), GET
    `/openapi.json` contains `/<n>` (only when `openapi-plugin` is installed) — and re-emits
    `test/support/server.ts` (managed, byte-identical) so a pre-M114 project gains it.
  - `<n>.test.ts` replaces `<n>.service.test.ts`: in-process via
    `createTestApp({ app: await createApp() })` + `inject`, asserting `GET /<n>` answers 200 with an
    `items` array and a POST → GET round trip. No assertion names the stub's contents. It boots the
    WHOLE composition in-process (no socket), so a plugin needing a live backend makes it need one
    too; `docs/cli.md` says so and points at `createTestApp`'s `overrides`/`without` (M91) for
    substituting it.
  - Tasks: `test` excludes `*.e2e.test.ts`, `test:e2e` runs only them — Deno
    `deno test -A --ignore='**/*.e2e.test.ts'` / `deno test -A '**/*.e2e.test.ts'`; Bun
    `bun test --path-ignore-patterns='**/*.e2e.test.ts'` / `bun test .e2e.test`; Node
    `tsx --test '**/!(*.e2e).test.ts'` / `tsx --test '**/*.e2e.test.ts'` (all measured, §1).
    `full-stack` keeps its build-first prefix on both. Workers: no e2e, unchanged README note.
  - The Deno `test` task and the existing `test/app.test.ts` stay; it is not an e2e.
- **Why:** V9-79; NestJS ships `test:e2e` (verified) but no per-feature e2e.
- **Test home:** `test/unit/templates/project-files.test.ts`, `test/e2e/feature-module-e2e.test.ts`,
  `test/e2e/scaffold-runs-e2e.test.ts` (runs `test:e2e` on every bootable template).

### 3.11 The `rest` sample becomes `src/modules/greeting/`

- **Decision:** the functional REST showcase is emitted as a generated module named `greeting`
  through the SAME `generateModule` functional renderer with a showcase body override for the
  service (`greet(name)`), so a new project's first files are exactly what `g module` produces.
  Routes stay `/greetings` and `/greetings/:name` (the documented `GREETING_ROUTES`), so the
  module's route file is the showcase's own source, not the CRUD template; the seeded artifacts move
  from `controller`/`service` to `modules: ['greeting']`. Its `greeting.test.ts` and
  `greeting.e2e.test.ts` are showcase-specific (`GET /greetings` → `Hello, world!`,
  `GET /greetings/ada` → `Hello, ada!`), never the CRUD round trip, and it emits no schemas file (no
  request body to validate). The class-based showcase is unchanged.
- **Why:** ROADMAP item 5.
- **Test home:** `test/unit/templates.test.ts`, baseline fixture, `scaffold-runs-e2e`.

### 3.12a Form bodies are OPT-IN per validator (maintainer decision 2026-10-21, after the security audit)

- **Decision (supersedes the default-on reading of §3.12 below):** the committed-tree audit (L3b)
  measured that default-on form acceptance lets a cross-site HTML `<form>` — which a browser sends
  with no CORS preflight — reach every cookie-authenticated validated route that used to refuse it
  with 400. So `validateBody(S)` stays JSON-only exactly as released, and a validator opts in:
  `validateBody(S, { forms: true })`,
  `createValidationMiddleware(S, 'body', service, formatter, { forms: true })`, and
  `@ValidateBody(S, { forms: true })`. Without the option a form-encoded body takes the JSON path
  and answers the released `400 Invalid JSON in request body`. The option has no effect on any
  target but `body`. The conversion rules of §3.12 apply unchanged to an opted-in validator.
  Generated CRUD routes do NOT opt in (they are JSON APIs); docs pair any form route with
  `csrfFormMiddleware`.
- **The decorator path needs a contract change:** `DecoratorPlugin` enforces `@ValidateBody` by
  calling `IValidationService.middleware(schema, target)` (`decorator-plugin.ts:789`), which has no
  room for an option. `common` gains `ValidationMiddlewareOptions { readonly forms?: boolean }` and
  `IValidationService.middleware(schema, target, options?)` — an OPTIONAL third parameter, so every
  caller and every existing two-parameter implementation stays source-compatible. The decorator
  records the flag on its internal `RouteSchemaMetadata` (`bodyForms`) and passes `{ forms: true }`
  only for a route that set it.
- **Test home:** `form-body-validation` unit and integration tests: a form posted to a plain
  `validateBody(S)` answers 400; the same post to `validateBody(S, { forms: true })` validates; the
  decorator route with and without the option; the third parameter reaches a custom service.

### 3.12 Form bodies validate with the same schema (folded in, maintainer decision 2026-10-20)

- **Decision:** `extractTarget('body')` in `validation-middleware.ts` reads the request's form when
  `formEncodingOf(content-type)` (common, M94b) answers `'urlencoded'` or `'multipart'`, and keeps
  `ctx.request.json()` for every other content type, byte-identical. The form is read through
  `ctx.request.formData?.()`; a producer that omits that optional member answers the same 400 a
  malformed body does (`Unsupported form body`), never a throw. The `FormBody` is converted to a
  null-prototype record: a key seen once maps to its value; a key seen more than once maps to an
  array of its values in wire order; a key ending `[]` always maps to an array (kept under the name
  as written, the Hono convention). Values are `string` or `FormFile`, unchanged. `__proto__`,
  `constructor` and `prototype` are ordinary keys on the null-prototype record, never a prototype
  write. A multipart part that the M94b parser drops is absent, as it is from `FormBody`.
- **Why:** a server-rendered `<form>` post is the other half of the MVC surface (M92/M94), and today
  it answers `400 Invalid JSON in request body` against the same schema a JSON client passes.
- **Stated limits (docs, not code):** the generated OpenAPI document still describes a validated
  body as `application/json`; numeric and boolean form fields arrive as strings, so schemas use
  `z.coerce`; a file field arrives as the framework's `FormFile` (common), NOT a web `File`, so
  `z.instanceof(File)` refuses it and a schema checks the `FormFile` shape instead; a form that
  carries the session plugin's `_csrf` field reaches the schema, where a Zod object strips the
  unknown key by default and `forbidNonWhitelisted` (or the schema's own `.strict()`) refuses it.
- **Test home:** `packages/validation-plugin/test/unit/form-body-validation.test.ts` (conversion
  table: single, repeated, `[]`, file, `__proto__` key, absent `formData`, JSON unchanged) and
  `test/integration/form-body-validation.test.ts` (a real kernel app: urlencoded and multipart posts
  validated by one `validateBody(schema)`, read back through `.value(ctx)`, plus the same schema
  through `@ValidateBody` on a decorated route).

### 3.12b A validated body must declare its media type (maintainer decision 2026-10-21, audit round 2 F1)

- **Defect:** keeping forms off did not keep a cross-site form out. `extractTarget` read the body
  with `ctx.request.json()` whatever its `Content-Type`, and `parseJsonBody` (`common/src/http.ts`)
  does not check it. A `<form enctype="text/plain">` whose field name is `{"name":"Ada","p":"` and
  value `x"}` sends `{"name":"Ada","p":"=x"}`: valid JSON, sent with no preflight and with the
  browser's cookies. The audit drove it to `200` with the handler run on both `validateBody` and
  `@ValidateBody` routes.
- **Rule (one implementation, in `extractTarget`'s body branch, before any read):** classify the
  request's `Content-Type`, case-insensitively and ignoring parameters.
  - `application/json` or any `application/*+json` → the JSON path, unchanged.
  - A form type (`formEncodingOf` recognises it) → the form path when `forms === true`; otherwise
    refused as below. (Today a form type on a JSON-only route answers `400` "Invalid JSON"; it now
    answers `415`, which says what is wrong.)
  - Anything else, **including an absent header** → refused, and the body is not read. Absent is
    refused on purpose: `fetch` with a `Blob` or `ArrayBuffer` body and no type sends no
    `Content-Type`, which is also a no-preflight request.
- **Refusal:** `415 Unsupported Media Type`, written through `respondWithError` from `common`, so it
  answers in the application's configured error format. The detail is a fixed sentence naming the
  accepted types: "Expected a JSON request body (application/json)." on a JSON-only route, and
  "Expected a JSON or form request body." on a `forms: true` route. Never the received value. The
  validation formatters are NOT used: their bodies hardcode `400`, so a formatted `415` would carry
  a body that disagrees with its status line.
- **Scope:** the body target only. Query, params, headers and cookies have no media type. A route
  that reads `ctx.request.json()` itself, without a validator, is unchanged; the docs say that
  media-type enforcement belongs to validated routes, and that cookie-authenticated routes still
  want `csrfMiddleware` or `csrfFormMiddleware`.
- **Breaking (CHANGELOG `Changed` + `docs/upgrading.md`):** a client that posts JSON to a validated
  route without `Content-Type: application/json` (for example `fetch` with a string body and no
  headers, which sends `text/plain`) now gets `415` instead of a validated response. A
  body-validated route hit with no body and no `Content-Type` answers `415`, not `400`. The remedy
  is to send the header.
- **Who enforces it:** the first-party `ValidationService` (`buildValidationMiddleware`), so both
  the helpers and `@ValidateBody` get it. A third-party `IValidationService` reached through the
  helper fallback owns its own media-type handling; the docs say so.
- **Test doubles:** `createFakeContext` (`packages/validation-plugin/test/fixtures/fake-runtime.ts`)
  sets no `Content-Type` even when it carries a body, which no real JSON client sends to a JSON
  route. When a body is given and the caller set no `content-type`, the fixture defaults it to
  `application/json` — the default `inject()` already applies to an object or string body
  (`kernel/src/application/inject-body.ts`). Tests that exercise the refusal set the header
  explicitly.
- **Docs (correct the round-1 overclaim at every site):** `validation-middleware.ts:269-270`,
  `decorator-plugin/src/decorators/validation.ts:30-31`,
  `common/src/services/validation.ts:107-110`, the validation-plugin README, `PUBLIC_API.md`,
  `docs/cli.md`, the CHANGELOG entry and the upgrade guide.
- **Test home:** `packages/validation-plugin/test/unit/body-media-type.test.ts` (the classification
  table: JSON, `+json`, parameters and case, form types with and without `forms`, `text/plain`,
  absent, and no body read on refusal) and `test/integration/body-media-type.test.ts`. The
  integration file drives a real kernel app with `errorHandler({ format: 'rfc9457' })`: the audit's
  exact text/plain payload answers `415` with `application/problem+json` and the handler not run, on
  both a `validateBody` route and an `@ValidateBody` route; `application/json` and
  `application/vnd.api+json` still answer `200`. **Negative control:** remove the check and the
  text/plain case must answer `200` again.

### 3.12c Artifact file names are refused like module names (audit round 2 F2)

- **Defect:** `scanModuleArtifacts` (new in M114) feeds `artifact-scanner.ts`, which admits any file
  matching the family suffix. `src/modules/orders/q'y.routes.ts` exporting `registerQ'yRoutes` was
  "adopted", and the generated `index.ts` gained an import that does not parse. The top-level
  barrels have the same pre-existing behaviour.
- **Rule:** `artifact-scanner.ts` admits a candidate only when its base name passes the L2 rule —
  `deriveNames(name).kebab === name` and `isIdentifierSafe(deriveNames(name))`. The rule lives in
  ONE shared predicate, used by both `module-scanner.ts` and `artifact-scanner.ts`. A refused file
  is reported, escaped, as "not a kebab-case identifier, so it cannot be listed in the barrel.
  Rename the file." It is never imported. This covers the top-level barrels too.
- **Test home:** `packages/cli/test/unit/utils/artifact-scanner.test.ts` (hostile names in a flat
  family and in a module: rejected and reported, never imported) and the command-level report test
  in `generate-module-command.test.ts`. **Negative control:** disable the predicate in
  `artifact-scanner.ts` and the hostile name must reach the barrel again.

### 3.12d Class-based module scan checks exports (audit round 2 observation, folded in by the maintainer)

- **Defect:** in class-based mode `scanModules` admits a directory once `<name>.controller.ts`,
  `<name>.service.ts` and `<name>.module.ts` exist (`module-scanner.ts:143-153`), without reading
  them. `renderModuleBarrel` (`schematics/module-barrel.ts`) imports `<Pascal>Controller`,
  `<Pascal>Service` and, for a full module, `<Pascal>Module` from each. A file that does not export
  its symbol (after a rename, say) produces a barrel that does not compile, from a command that
  reported success.
- **Second defect behind it:** `generate.ts:373` passes EVERY class-based skip as a legacy module,
  and the barrel still imports a legacy module's controller and service. So skipping a module for a
  missing export is not enough on its own; it would still be imported.
- **Rule:** read each of the files the barrel imports from — only when the file is a regular file of
  at most `MAX_EXISTING_FILE_BYTES`, the bound the functional branch already applies — and require
  it to export its symbol (the existing `exportsSymbol`).
  - All three present and exporting: admitted, as today.
  - Controller and service exporting, no `<name>.module.ts`: a legacy module, as today.
  - Any required file present but not exporting its symbol, or unreadable: skipped with the missing
    symbol named, and NOT passed as legacy, so the barrel never imports it.
- **Shape:** `SkippedModule` (internal; not barrel-exported) gains
  `kind: 'legacy' | 'missing-export'`. `generate.ts` passes only `kind === 'legacy'` entries as
  `legacyModules`, and its report names the missing symbol for the other kind.
- **Test home:** `packages/cli/test/unit/utils/module-scanner.test.ts` (each export missing in turn;
  an over-size and a non-regular file; a legacy module still admitted as legacy) and
  `generate-module-command.test.ts` (the regenerated barrel never imports a module missing an
  export, and the report names the symbol). **Negative control:** drop the export check and the
  barrel imports the broken module again.

### 3.12e Oversized `FormData` uploads in in-process tests (audit round 2 observation, folded in)

- **Finding:** a Node 24 / undici bug, reproduced with no framework code. Cancelling the body of a
  `Request` built from a `FormData` that holds a file throws an uncaught
  `ERR_INVALID_STATE: ReadableStream is already closed` inside undici. `Blob` and `ReadableStream`
  bodies are unaffected. `readBounded` (`runtime/src/adapters/shared/fetch-mapping.ts`) cancels an
  over-cap body on purpose, so `app.fetch(new Request(…, { body: formData }))` with a file over
  `maxBodyBytes` crashes an in-process test. Over a real socket the server survives, and the
  kernel's `inject()` never builds a `FormData` request.
- **No code change:** the exception is raised inside undici's own task, where nothing can catch it,
  and draining instead of cancelling would undo the M90a bound.
- **Docs:** a short note in the runtime README's "Bounding the request body" section and in the
  testing README's `inject` section, telling readers to build an oversized upload from a `Blob`, or
  to use `inject()`, and why. Filing the upstream issue is outward-facing and stays the maintainer's
  decision.

### 3.13 Unwired activation barrel in an existing project

- **Decision:** `reportUnwiredDecoratorSeams` is extended (and renamed `reportUnwiredSeams`) to
  cover `src/modules/index.ts` in functional mode: when `g module` writes the barrel and
  `setu.config.ts` does not reference `registerModules`, print the import line and
  `registerModules(app.router, app.services);` — the M101g print-the-line rule.
- **Why:** a pre-M114 functional project's config never imports the barrel; reporting `created`
  without this leaves the module unreachable (the M60 class).
- **Test home:** `test/unit/generate-unwired-seam.test.ts`.

### 3.14 Performance: what touches the request path, and the measured budget

- **What changes per request, by route kind (read from the design, then measured):**

  | Route kind                                      | Added per-request work                                                                                                        | Budget (paired, see method)               |
  | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
  | no validator                                    | none — the validation middleware is not in its chain; `registerModules` runs once at startup                                  | within noise (±1% median, sign test n.s.) |
  | `validateBody` with a JSON body                 | one extra `ctx.state.set` (the instance token, §3.9) and a content-type pre-check before `json()` (§3.12)                     | ≤ 2% median throughput loss               |
  | `validateBody` reader read in the handler       | one `ctx.state.get` + identity compare in `value(ctx)`                                                                        | included in the row above                 |
  | `validateBody` with a urlencoded/multipart body | new path: `formData()` + record conversion — previously a 400 with no handler run, so there is no baseline to regress against | report absolute rps and p50/p99 only      |

- **Decision (JSON path):** the form check must not parse a JSON request's content type. Before
  calling `formEncodingOf`, `extractTarget('body')` tests the raw header with one case-insensitive
  prefix check (`multipart/` or `application/x-www-form-urlencoded`, after leading whitespace); any
  other value — `application/json` included — goes straight to `json()` with no `parseContentType`
  call. A unit test asserts `parseContentType` is not reached for a JSON body (spy), so the cost
  cannot creep back.
- **Generated code is reported, not budgeted:** a `g module` route now runs Zod parses and the
  validator middleware where the old stub ran neither. That is the application's own validation
  cost, stated in `docs/cli.md`; the framework budget above is what this milestone owns.
- **Method:** a scratch harness under `.tmp/m114-bench/` (not committed — no new script enters the
  tooling coverage inventory) boots one app per build on the real Node adapter (`RuntimePlugin`),
  baseline = an `origin/develop` worktree at this branch's merge base, candidate = this branch, both
  run from built `dist/`. Load with `bombardier` (`~/go/bin/bombardier`), 15 s warm-up / 20 s
  window, ALTERNATING baseline/candidate per pass, n ≥ 15 passes per route, server pinned
  `taskset -c 8-15`, load `16-31` (the benchmark-harness traps: cores 0–7 are the desktop's and
  produce a bimodal result that fakes a regression). Read the raw per-pass values sorted before any
  median; spread > 15% is not quotable. Report median delta, paired wins and a sign-test p-value per
  route, plus p50/p99 latency.
- **Owner and timing:** run during verification, after the implementation is final, by the reviewer
  (not by the implementing agent). A budget miss is fixed, or brought to the maintainer with the
  numbers — never waived silently (the M98a/M98m precedent).
- **Test home:** the spy test above; the measurement table goes in this plan's §11 and the PR body.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** `none` (the helpers' return types narrow to a subtype of
`MiddlewareFunction`). Behaviour changes to GENERATED output (functional module layout, module
barrel content, test task globs, removed `export *` in a module index, renamed module test) ship in
minor `0.10.0` with CHANGELOG migration text; existing projects keep working unchanged.

| Exported symbol                                                | Kind            | Consumer / real code path that READS it                                                                                                                                      |
| -------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ValidatorMiddleware<T>` (`@setu-ts/validation-plugin`)        | type            | return type of `validateBody/Query/Params/Headers/Cookies` and `createValidationMiddleware`; every generated functional route reads `.value(ctx)` on it                      |
| `ValidatedOutput<S>` (`@setu-ts/validation-plugin`)            | type            | the inferred `T` of `ValidatorMiddleware`; applications annotate helpers with it                                                                                             |
| `ValidationMiddlewareOptions` (`@setu-ts/common`)              | type            | third parameter of `IValidationService.middleware`; read by `ValidationService.middleware`, `validateBody`, `createValidationMiddleware` and `DecoratorPlugin`'s enforcement |
| `ValidateBody(schema, options?)` (`@setu-ts/decorator-plugin`) | decorator param | `DecoratorPlugin` passes `{ forms: true }` to `IValidationService.middleware` for that route                                                                                 |
| `SchematicOptions.targetModule?` (`@setu-ts/cli`)              | field           | the `service`/`route`/`controller`/`schema` schematics (placement); set by `runGenerateCommand`                                                                              |
| `SchematicOptions.moduleArtifacts?` (`@setu-ts/cli`)           | field           | the per-module index renderer inside `route`/`controller --module`; set by `runGenerateCommand` from `scanModuleArtifacts`                                                   |

`@setu-ts/common` gains `ValidationMiddlewareOptions` and the optional third parameter of
`IValidationService.middleware` (§3.12a); `@setu-ts/decorator-plugin`'s `ValidateBody` gains an
optional second parameter. `cli` internals (`seams/modules.ts`, `scanModuleArtifacts`,
`registerModuleSymbol`, `REGISTER_MODULES_EXPORT`) are NOT barrel-exported.

### 4.1 Options — every option names its consumer

| Option                       | Consumer                                               | Behavior (per implementation)                                                                                                  |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `setu generate --module <m>` | `runGenerateCommand` → `SchematicOptions.targetModule` | functional: placement + module index regeneration; class-based: placement + printed `@Module` line; refused for app-wide kinds |
| `setu generate schema`       | `schematics/schema.ts`                                 | writes `src/shared/schemas/<n>.schemas.ts` or `src/modules/<m>/<n>.schemas.ts`; gated on `validation-plugin`                   |

## 5. Implementation files

| File                                                                                | Purpose                                                                                                           |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/validation-plugin/src/index.ts`                                           | barrel: add the `ValidatorMiddleware` and `ValidatedOutput` types                                                 |
| `packages/validation-plugin/src/middleware/validator-reader.ts`                     | `ValidatorMiddleware`, `ValidatedOutput`, the instance token and its package-private state key, `value(ctx)`      |
| `packages/validation-plugin/src/middleware/form-record.ts`                          | `FormBody` → null-prototype record conversion and the cheap form pre-check (§3.12, §3.14)                         |
| `packages/validation-plugin/src/middleware/validation-middleware.ts`                | internal identity-recording builder; `createValidationMiddleware` delegates                                       |
| `packages/validation-plugin/src/services/validation-service.ts`                     | `middleware()` passes the pre-policy schema as identity                                                           |
| `packages/cli/src/seams/modules.ts`                                                 | `registerModuleSymbol`, `REGISTER_MODULES_EXPORT`, functional module-index + activation-barrel renderers          |
| `packages/cli/src/schematics/module.ts`                                             | functional shape (§3.1), schemas (§3.7), tests (§3.10), class-based schemas + tests                               |
| `packages/cli/src/schematics/module-files.ts`                                       | module body renderers split out of `module.ts` (service, routes, schemas, tests) — reused by the showcase (§3.11) |
| `packages/cli/src/schematics/schema.ts`                                             | `schema` schematic (§3.8)                                                                                         |
| `packages/cli/src/schematics/service.ts`, `route.ts`, `controller.ts`               | `--module` placement (§3.5)                                                                                       |
| `packages/cli/src/schematics/registry.ts`                                           | `schema` entry; `targetModule?`/`moduleArtifacts?` fields                                                         |
| `packages/cli/src/schematics/test-harness.ts`                                       | e2e and unit-test bodies per runtime                                                                              |
| `packages/cli/src/utils/module-scanner.ts`                                          | mode-aware `scanModules`, `scanModuleArtifacts` (§3.4)                                                            |
| `packages/cli/src/utils/name-conflicts.ts`                                          | functional modules in the HTTP group; in-module route/controller clash (§3.5)                                     |
| `packages/cli/src/commands/generate.ts`, `flags.ts`, `constants.ts`                 | `--module` flag, refusals, placement validation, `reportUnwiredSeams` (§3.13)                                     |
| `packages/cli/src/commands/add.ts`, `templates/client-dependencies.ts`              | `zod` peer for `setu add validation`                                                                              |
| `packages/cli/src/templates/module-seam.ts`, `seam.ts`, `style.ts`, `full-stack.ts` | functional activation barrel + setup call on every host (§3.3); `zod` in manifest                                 |
| `packages/cli/src/templates/rest-showcase.ts`, `rest.ts`                            | showcase as `src/modules/greeting/` (§3.11)                                                                       |
| `packages/cli/src/templates/project-files.ts`                                       | `test/support/server.ts`, `test/e2e/app.e2e.test.ts`, `test`/`test:e2e` tasks (§3.10)                             |
| `packages/cli/src/workspace/*` (as needed)                                          | member hosts inherit §3.3 through the host path; discovery overlay untouched                                      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                              | src covered                                     | Key assertions                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validation-plugin/test/unit/validator-reader.test.ts`                                                                 | `validator-reader.ts`                           | `value` after the middleware ran (coerced/defaulted output); throws when its middleware did not run; throws when a later validator for the same target overwrote it; `@ts-expect-error` assigning `value(ctx)` to a wrong type                                                                                                                                                                   |
| `validation-plugin/test/unit/form-body-validation.test.ts`                                                             | `form-record.ts`, `validation-middleware.ts`    | single / repeated / `[]` keys, a file value, a `__proto__` key on a null-prototype record, absent `formData` → 400, JSON unchanged, and a spy proving `parseContentType` is never reached for `application/json`                                                                                                                                                                                 |
| `validation-plugin/test/integration/validator-reader.test.ts`                                                          | middleware + service                            | real kernel app: helper under `whitelist: true` and `service.middleware` reach one implementation; `.value(ctx)` returns the parsed body                                                                                                                                                                                                                                                         |
| `validation-plugin/test/integration/form-body-validation.test.ts`                                                      | middleware                                      | real kernel app: urlencoded and multipart posts validated by one `validateBody(S)` and read through `.value(ctx)`; the same schema through `@ValidateBody` on a decorated route                                                                                                                                                                                                                  |
| `validation-plugin/test/unit/barrel-exports.test.ts` (extend)                                                          | `index.ts`                                      | `ValidatorMiddleware` and `ValidatedOutput` reachable from the barrel (compile-time rows)                                                                                                                                                                                                                                                                                                        |
| `cli/test/unit/seams/modules.test.ts`                                                                                  | `seams/modules.ts`                              | index calls every registrar sorted; empty index uses its parameters; activation barrel sorted and byte-identical across input order (≥2 unsorted names — the M60 vacuity rule)                                                                                                                                                                                                                   |
| `cli/test/unit/schematics/module.test.ts` (update)                                                                     | `module.ts`, `module-files.ts`                  | functional: no path under `src/controllers/`; files listed in §3.1; schemas only with `validation-plugin`; routes call `.value(ctx)` on their validators and contain no `as` cast; e2e omitted on Workers; class-based arm emits schemas + decorators                                                                                                                                            |
| `cli/test/unit/schematics/schema.test.ts`                                                                              | `schema.ts`                                     | shared vs module path; contents; gate                                                                                                                                                                                                                                                                                                                                                            |
| `cli/test/unit/utils/module-scanner.test.ts` (update)                                                                  | `module-scanner.ts`                             | functional admission by exported symbol; pre-M114 functional module neither admitted nor reported; `shared/` ignored in both modes; `skipped` reporting; `scanModuleArtifacts`                                                                                                                                                                                                                   |
| `cli/test/unit/utils/name-conflicts.test.ts` (update)                                                                  | `name-conflicts.ts`                             | `g route invoices` refused beside functional module `invoices`; in-module route/controller clash; module-scoped names do not collide with top-level                                                                                                                                                                                                                                              |
| `cli/test/unit/generate-module-placement.test.ts`                                                                      | `generate.ts`, `flags.ts`, placement schematics | each refusal (app-wide kind, unknown module, class-based route); functional index regenerated; class-based prints the `@Module` line and writes no declaration                                                                                                                                                                                                                                   |
| `cli/test/unit/generate-module-command.test.ts` (update)                                                               | `generate.ts`                                   | new layout through the command; managed index/barrel overwrite allowed                                                                                                                                                                                                                                                                                                                           |
| `cli/test/unit/generate-unwired-seam.test.ts` (extend)                                                                 | `reportUnwiredSeams`                            | functional pre-M114 config gets the two printed lines                                                                                                                                                                                                                                                                                                                                            |
| `cli/test/unit/commands/add.test.ts` (extend)                                                                          | `add.ts`, `client-dependencies.ts`              | `setu add validation` adds `zod` on deno/node/bun/workers                                                                                                                                                                                                                                                                                                                                        |
| `cli/test/unit/templates.test.ts`, `templates/project-files.test.ts`, `template-baseline.json`                         | templates                                       | every functional host scaffolds the activation barrel and calls it; `test`/`test:e2e` per runtime; `server.ts`/`app.e2e.test.ts` on socket targets only; showcase in `src/modules/greeting/`                                                                                                                                                                                                     |
| `cli/test/e2e/feature-module-e2e.test.ts` (new)                                                                        | end to end                                      | Deno, Node, Bun: scaffold `rest` → `g module invoices` → `g service pricing --module invoices` → `g route summary --module invoices` → implement the service with real logic (rewrite the file) → run `test` AND `test:e2e` green → assert `/openapi.json` lists `/invoices` with component schemas → delete `src/modules/invoices/` → regenerate the barrel (`g module other`) → boot again 200 |
| `scaffold-runs-e2e`, `template-e2e`, `seam-probe`, `workspace-e2e`, `workspace-mesh-e2e`, `node-scaffold-e2e` (update) | —                                               | request module routes at their new location; run `test:e2e` where the suite already boots a template                                                                                                                                                                                                                                                                                             |
| `workers-bundle-e2e` (update)                                                                                          | —                                               | a Workers scaffold with a generated module (no tests emitted) still bundles and type-checks; the activation barrel call is present                                                                                                                                                                                                                                                               |
| `cli/test/unit/generate-module-zod.test.ts`                                                                            | `generate.ts`                                   | a project manifest without `zod`: files written AND the runtime's exact install command printed; with `zod`: nothing printed                                                                                                                                                                                                                                                                     |

**Negative controls (each observed failing, then reverted):** (1) drop the functional names from
`findNameConflict`'s `modules` → the duplicate-route test fails; (2) render the activation barrel
without the setup call in `setu.config.ts` → feature-module e2e answers 404; (3) emit the old
stub-asserting test → the e2e's "implement the service" step fails `test`; (4) restore a
`ctx.state.get(...) as` cast in the generated routes → the module schematic test's no-cast grep
fails; (5) record the token from the INNER per-request middleware instead of the outer helper →
`.value(ctx)` throws through every helper and the integration test fails; (6) drop the
`--ignore`/`--path-ignore-patterns`/glob from the unit task → `test` runs the e2e and the
project-files assertion fails; (7) drop the `[]`/repeat handling → the form conversion table fails;
(8) call `formEncodingOf` unconditionally → the `parseContentType` spy test fails; (9) build the
form record on an ordinary object with `record[key] = value` → the `__proto__` row fails; (10) run
the global HTTP-path conflict check for a `--module` placement → `g route x --module m` beside a
top-level CONTROLLER `x` is refused and the placement test fails (the global check never compares a
schematic with itself, `name-conflicts.ts:185`, so a top-level route `x` would not discriminate).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m114-feature-modules
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% branch/function/line every changed src file
pnpm run test:deno-lane
pnpm run test:tooling
pnpm run check:docs
pnpm run release:publish --dry-run
pnpm run release:verify 0.9.0
```

## 8. Risks & mitigations

- Free-port race in `startTestServer` (port taken between probe close and bind) → the helper retries
  the probe-and-bind up to 3 times on `EADDRINUSE` and reports the last error.
- `**/!(*.e2e).test.ts` depends on Node's `fs.glob` extglob support (measured on Node 24.18) → the
  generated `engines` already require Node ≥ 24; `node-scaffold-e2e` runs the task.
- The glob arguments in the generated `test`/`test:e2e` tasks were measured from an interactive
  shell; a `deno task` runs its own shell and `npm run` runs `sh`, whose quoting could differ → the
  feature-module e2e runs the GENERATED tasks through their own runners on all three runtimes, which
  is the measurement that counts.
- Template baseline churn hides an unintended change → regenerate the fixture once, review its diff
  file by file in the PR.
- A pre-M114 functional module and a new one coexist; their routes come from two barrels → the
  scanner rule (§3.4) and the existing HTTP-path conflict cover both; a test seeds both layouts.
- Workers modules ship with no tests → stated in the generated README and `docs/cli.md`, as today.

## 9. Out of scope

- Browser e2e scaffold — ROADMAP item 6 follow-on, unowned.
- Route-schema typing (Fastify/Hono shape) — a later candidate recorded in ROADMAP (§3.9).
- OpenAPI describing form bodies with a form media type — not owned; stated as a limit (§3.12).
- Editing `@Module` declarations or schemas files — never (C1, C2).
- A configurable layout (`setu.json`) — the parked project-layout proposal.
- A kernel API exposing the bound port — not needed (§3.10).

## 10. Security design review (the committed-tree audit is REQUIRED)

**Round-1 audit (commit `2cbeb39a`) found four Lows; dispositions:** L1 (a reader returned another
validator's value when a validator or middleware wrote only the common key) — fixed: the private
record stores `{ token, value }` and `value(ctx)` also requires the common key to still hold that
exact value. L2 (the functional scanner admitted non-identifier directory names, breaking the barrel
and forging a stderr line through LF) — fixed: such entries are skipped and reported through
`escapeName`, and the admitted list is escaped. L3a (generated sample store unbounded, routes
public) — fixed: the generated service and routes say so. L3b (forms default-on widened CSRF reach)
— fixed by §3.12a. L4 (this review omitted the CLI half) — the rows below are added.

| Threat (CLI and generated code)                                          | Control                                                                                                 | Probe                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `--module` value escaping `src/modules/<m>/`                             | refuses `/`, `\` and non-identifier names; must name an admitted module                                 | `../x`, `..`, `a/b`, `.`, NUL → exit 2, no write                    |
| A directory name under `src/modules/` injecting source or terminal lines | non-identifier-safe or non-kebab entries are skipped and reported escaped                               | `q'y` and a name with LF → skipped, barrel compiles, no forged line |
| An oversized or device-linked `index.ts` hanging or exhausting the scan  | `stat.isFile` and `size <= MAX_EXISTING_FILE_BYTES`                                                     | over-limit index skipped, never read                                |
| Generated code a developer copies being unsafe by default                | JSON-only validators; documented public/unbounded sample store; generated test server binds `127.0.0.1` | read the generated output                                           |

Form-body validation (§3.12) turns untrusted urlencoded and multipart input into an object handed to
an application schema, so this milestone crosses a trust boundary and is audited per
`.roo/skills/security-audit/SKILL.md` before merge, by a fresh Claude agent (never Codex).

| Threat                                                                              | Control                                                                                                                                                                                                                                                                                                                       | Probe the audit runs                                                                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Prototype pollution through a field named `__proto__`, `constructor` or `prototype` | null-prototype record built with own-property definition, never `obj[key] = v` on an ordinary object                                                                                                                                                                                                                          | post `__proto__[x]=1`, `__proto__=1`, `constructor.prototype.x=1`; assert `({}).x === undefined` and the record's own keys |
| Memory growth from many repeated keys or many parts                                 | `formData()` reads through the same `bytes()` a JSON body does (`fetch-mapping.ts:208`), so it is capped exactly when `RuntimePlugin({ maxBodyBytes })` is set and as unbounded as JSON is when it is not — no new exposure; the record adds at most one array entry per part                                                 | a body at the cap with 100 000 repeated keys answers within the existing bound                                             |
| A file part reaching a schema expecting text                                        | values keep their `string`/`FormFile` type; a `z.string()` schema refuses a `FormFile` with a 400, never a coercion                                                                                                                                                                                                           | multipart with a file under a string field → 400                                                                           |
| Content-type confusion (a JSON body labelled as a form, or the reverse)             | the encoding comes only from the header via `formEncodingOf`. A JSON body labelled urlencoded does NOT fail its parse — `URLSearchParams` turns it into odd keys — and a broken multipart body yields an empty form (M94b); in both cases the SCHEMA is what refuses it, so the handler runs only on input the schema accepts | both mislabels against a schema with a required field → 400, handler not run                                               |
| `.value(ctx)` reading another validator's value                                     | instance token check (§3.9)                                                                                                                                                                                                                                                                                                   | two validators for one target; the first reader throws                                                                     |

## 11. Measurements (filled during verification)

The §3.14 table lands here, with the raw sorted per-pass values, the spread, and the machine load.
