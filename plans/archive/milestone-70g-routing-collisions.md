# Milestone 70g — Routing collisions (`kernel`, `cli`)

> **Status:** Planning. Branch: `feat/m70g-routing-collisions`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Four register rows share one shape: **two claimants for one name, resolved by an accident of
ordering rather than by specificity, and reported by a diagnostic that names the wrong party.** A
catch-all silently owns every single-segment path registered after it, so a full-stack application
loses `/openapi.json` and `/docs` with no user error at all (X5-1/F1); when the collision is loud
instead, the message names the pattern and the second claimant but never the plugin that already
owns it (X5-6); the CLI's seam scanner claims a hand-written file that merely matches its naming
convention, which since M68's duplicate-route refusal stops the application booting (X4-4/F2); and
`setu generate health-indicator database` writes a file whose name is already taken by an installed
plugin, so the project type-checks and dies at `app.start()` (A1). The milestone makes route
resolution decide by **specificity**, makes both duplicate diagnostics name the **owning** party,
and makes the CLI refuse or report a claim it cannot honour — before it writes.

- **In scope:** register rows **X5-1 + F1** (a wildcard ties with an exact single-segment path, so
  registration order alone decides), **X5-6** (the duplicate-route error names neither the owning
  plugin nor an alternative), **X4-4 + F2** (the seam scanner adopts hand-written files, and the
  boot failure names files the developer did not touch), **A1** (a generated health-indicator name
  collides with the installed plugin set).
- **NOT this milestone:** a `405` for a method mismatch on an existing path — deferred **to** this
  row by M70f §9, and declined here in §9 with its reason, so it stays with M70f's successor rather
  than being silently dropped. Generated-artifact SHAPE rows (A2, A3) shipped in **M70h**. The
  config callback's missing excess-property check (X5-2) is **M70n**. `StaticPlugin` having no
  supported way to serve a root-path file **alongside** SSR (X5-5) is a `static-plugin` capability
  question, not a collision: this milestone makes the refusal legible, and **M70k** owns storage and
  static operability.

## 1. Contracts verified from SOURCE (not names)

| Reference                         | Source (file:line)                                                         | Verified surface / fact                                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parsePattern`                    | `packages/kernel/src/router/route-matcher.ts:44-53`                        | Splits on `/` and classifies a segment as `param` only when it starts with `:`. A `*` segment therefore parses as **`{ type: 'static', value: '*' }`** — this is the whole defect                                            |
| `staticSegmentCount`              | `packages/kernel/src/router/route-matcher.ts:61-69`                        | Counts every `type === 'static'` segment, so `/*` scores **1** and ties with `/openapi.json`                                                                                                                                 |
| `Router.match` tie-break          | `packages/kernel/src/router/router.ts:229-236`                             | `statics` descending, then `index` ascending. Nothing else participates; a tie on `statics` is decided by registration order alone                                                                                           |
| `RouteEntry`                      | `packages/kernel/src/router/router.ts:22-37`                               | `pattern`, `method`, `definition`, `index`, `statics`, `owner?` — `statics` is hoisted at registration (§14) and `owner` already carries the registering plugin                                                              |
| Duplicate-route refusal           | `packages/kernel/src/router/router.ts:67-70`                               | `throw new Error(\`Route '${key}' is already registered.\`)`, thrown BEFORE`#entryMap.set`, so the existing entry (and its`owner`) is in hand at the throw site                                                              |
| Route ownership                   | `packages/kernel/src/application/application.ts:110-111,300-305`           | `#registeringPlugin` is set around each plugin's `register()` and read through the closure passed to `new Router(...)`, so `owner` is the plugin name during plugin registration and `undefined` for application routes      |
| `RouteInfo.owner`                 | `packages/common/src/plugin.ts:68`                                         | `readonly owner?: string` — committed since M68 (S7); no `common` change is needed to name an owner                                                                                                                          |
| `PLUGIN_PRIORITY`                 | `packages/common/src/types.ts:82-92`                                       | `HIGHEST: 0`, `HIGH: 100`, `NORMAL: 500`, `OPENAPI: 700`, `LOWEST: 1000`. Ascending sort, so `OPENAPI` registers **after** `NORMAL` by design                                                                                |
| SSR catch-all pattern             | `packages/react-router-plugin/src/plugin/react-router-plugin.ts:55-57,113` | `joinWildcard(basename)` yields `` `${prefix}/*` ``, so a default basename mounts `GET /*` at `NORMAL` (500) on all seven verbs                                                                                              |
| Static root pattern               | `packages/static-plugin/src/plugin/static-plugin.ts:79-82`                 | `normalizedPrefix === '/' ? '/*' : \`${prefix}/*\``, registered on`get`and`head`. The plugin declares no priority, so it takes the kernel default                                                                            |
| OpenAPI endpoints                 | `packages/openapi-plugin/src/plugin/openapi-plugin.ts:163,178`             | Two single-segment `router.get` registrations (`/openapi.json`, `/docs`) — exactly the shape a `/*` ties with                                                                                                                |
| `readArtifactNames`               | `packages/cli/src/utils/artifact-scanner.ts:78-128`                        | Admits a directory entry on three conditions: suffix match, `stat().isFile`, and `exportsSymbol` for every `spec.importSymbols`. **Nothing distinguishes a CLI-generated file from a conventionally-named hand-written one** |
| Generated artifact bodies         | `packages/cli/src/schematics/http-module.ts:37-70`                         | The emitted module opens with `import type …` — no provenance sentinel of any kind. Only BARRELS carry one (`seamHeader`, `seam-spec.ts:213-231`)                                                                            |
| `findNameConflict`                | `packages/cli/src/utils/name-conflicts.ts:120-155`                         | Compares the requested name against OTHER GENERATED artifacts only; `plugins` is read solely to gate the DI-token group. It cannot see a name an installed plugin claims                                                     |
| `generate` refusal path           | `packages/cli/src/commands/generate.ts:293-308`                            | The conflict check runs before the schematic and before `--dry-run` prints, and returns `EXIT_ERROR` — the shape A1's refusal reuses                                                                                         |
| `HealthService.registerIndicator` | `packages/health-plugin/src/services/health-service.ts:57-62`              | `throw new Error(\`Duplicate health indicator name: "${name}"\`)` — a startup throw, which is why A1 is a boot failure rather than a warning                                                                                 |
| `detectPlugins`                   | `packages/cli/src/utils/plugin-detector.ts:39-53`                          | Returns bare package names (`database-plugin`), collected from `deno.json` `imports` then `package.json` deps — the key A1's claim table is keyed on                                                                         |
| Plugin indicator names            | 24 `ctx.health.register(...)` sites across `packages/*/src`                | Verified by grep; §3.4 records the literal-name subset the claim table carries and the dynamic-name subset it deliberately excludes                                                                                          |
| `apps/full-stack/smoke.ts`        | `apps/full-stack/smoke.ts:56,88,104,113`                                   | Requests `/products`, `/`, `/login` and the login POST — and **nothing else**, which is why no gate saw X5-1                                                                                                                 |

**Probed, not inferred.** A throwaway probe against the real `Router` (deleted; not committed)
established every ordering fact this plan turns on, and two of them are not in the register:

```
/*            statics=1   [{"type":"static","value":"*"}]
/openapi.json statics=1   [{"type":"static","value":"openapi.json"}]
/a/*          statics=2   /a/:id  statics=1

catch-all first, exact later  ->  catch-all      (the real composition)
exact first, catch-all later  ->  exact
param first, exact later      ->  exact          (control: the tie-break IS live)
/a/* vs /a/:id, either order  ->  /a/*           (NEW: a wildcard outranks a param)
/* vs /, catch-all first      ->  /*             (NEW: an exact `/` loses too)
/* vs /a/b, catch-all first   ->  /a/b           (deep exact paths already survive)
```

The fourth line is a second manifestation the register did not record: because `*` counts as a
static segment, `/a/*` scores **higher** than `/a/:id` and wins in **both** registration orders — so
the defect is not only a tie, it is an inversion. The fifth explains why the full-stack template
ships no index route (§2, C2).

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                  | Resolution (picked side)                                                                                                                            | Doc deliverable (same PR)                                                                                                                                                                                    |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `PUBLIC_API.md:2380-2384` documents the defect as intended behaviour: "Single-segment routes … tie with `/*` (both have 1 static segment) and are silently shadowed by SSR. Register single-segment routes BEFORE ReactRouterPlugin". The register calls the same behaviour a High defect | The behaviour is wrong; the doc is an accurate description of a defect. Fix the code                                                                | Rewrite that block to state the specificity rule that ships here: any route with a static segment beats a wildcard regardless of registration order, and a wildcard loses to a `:param` at the same position |
| C2 | `PUBLIC_API.md:5888` claims "An exact `/` handler would take precedence over the SSR catch-all and shadow the application's own index route" — probed FALSE today (the catch-all registers first at `NORMAL` and wins the tie)                                                            | The claim is false before this milestone and TRUE after it. Keep the template's decision (no hello-world route) and make the stated reason accurate | Amend the note to say the precedence it relies on is the M70g specificity rule, so a future reader does not "correct" it back                                                                                |
| C3 | `ARCHITECTURE.md:127` describes the tie-break as "(statics-count + registration order)", which will no longer be the whole rule                                                                                                                                                           | Extend the description                                                                                                                              | Update §Why It Uses Hono to name the three-key rule, and add the wildcard row to the routing section                                                                                                         |
| C4 | The M70 workstream row lists five packages (`kernel`, `react-router-plugin`, `openapi-plugin`, `static-plugin`, `cli`). The chosen fix is in the kernel, so the three plugins need **no `src` change** — only docs                                                                        | Correct the row rather than inventing plugin-side changes to match it                                                                               | ROADMAP M70g row records the corrected package list (`kernel`, `cli`; docs in the three plugins; the gate in `apps/full-stack`), mirroring the M70b and M70h corrections                                     |
| C5 | `static-plugin`'s README and `PUBLIC_API.md` document `urlPrefix: '/'` as ordinary configuration and say nothing about SSR coexistence, while the kernel refuses the second `GET /*` outright                                                                                             | Document the constraint where a reader configuring the option will meet it                                                                          | Add a note to the Static Files section and the package README: a root prefix claims `GET /*` and `HEAD /*`, which no second plugin can share; mount under a sub-prefix when SSR owns the root                |

## 3. Design decisions

### 3.1 Wildcard specificity — a third sort key, not a special case

- **Decision:** `parsePattern` gains a third segment kind, `{ type: 'wildcard' }`, for a segment
  whose text is exactly `*`. `staticSegmentCount` stops counting it, a new `wildcardSegmentCount`
  counts it, `RouteEntry` gains `wildcards: number` hoisted at registration beside `statics`, and
  `Router.match` sorts by **`statics` descending, then `wildcards` ascending, then `index`
  ascending**.
- **Why:** the register's preferred fix is "a route with zero static segments should sort last among
  candidates regardless of registration index", and this is the smallest rule that delivers it while
  also correcting the inversion the probe found. `statics` alone would leave `/a/*` (1 static) tied
  with `/a/:id` (1 static) and decided by order; the `wildcards` key breaks that tie toward the
  param, which is the conventional static > param > wildcard precedence. A full per-segment
  lexicographic comparison was rejected: it changes strictly more existing behaviour (`/a/*` vs
  `/:x/b` flips) for a case no first-party plugin registers, and this milestone's job is to stop a
  wildcard eating exact paths, not to re-specify matching.
- **Test home:** `packages/kernel/test/unit/router-wildcard-precedence.test.ts` (both registration
  orders for each pair) and `packages/kernel/test/integration/catchall-vs-plugin-routes.test.ts` (a
  real two-plugin application at 500 and 700).

### 3.2 The known limit of the counting rule is stated, not hidden

- **Decision:** the rule compares COUNTS, so `/a/*` (1 static, 1 wildcard) loses to `/:x/b` (1
  static, 0 wildcards) on a request for `/a/b`, where a per-segment rule would prefer `/a/*`. This
  is recorded in `Router.match`'s JSDoc and in the `PUBLIC_API.md` block C1 rewrites, as a limit
  rather than as an accident.
- **Why:** an undocumented ranking is how the current defect became a documented feature. Stating
  the one case where counting and per-segment ranking disagree is what lets a future milestone
  change it deliberately.
- **Test home:** `router-wildcard-precedence.test.ts` pins this case explicitly, so a later change
  to per-segment ranking fails a test that names the trade-off.

### 3.3 The duplicate-route error names the existing owner

- **Decision:** `#registerMethod` reads the existing entry before throwing and reports it:
  `Route 'GET /*' is already registered by plugin 'react-router'.` when `owner` is set, and
  `… is already registered by the application.` when it is not. The message is built by an internal
  `describeRouteOwner(entry)` helper so the two arms have one home.
- **Why:** X5-6's error named the pattern and the second claimant, which is the half the stack trace
  already gives; the missing half is who got there first, and `RouteEntry.owner` has carried it
  since M68. The kernel deliberately offers no ALTERNATIVE (the second half of X5-6's ask): it
  cannot know that `static-plugin`'s alternative is a sub-prefix while a hand-written route's is a
  different path. That belongs to the plugin's own docs, which is C5.
- **Test home:** `packages/kernel/test/unit/router.test.ts` (both arms) and
  `packages/kernel/test/integration/catchall-vs-plugin-routes.test.ts` (a real plugin-registered
  route colliding, asserting the plugin NAME appears).

### 3.4 A1 — a claim table of plugin-owned indicator names, with a drift gate

- **Decision:** `packages/cli/src/utils/plugin-claims.ts` exports an internal
  `PLUGIN_HEALTH_INDICATORS: ReadonlyMap<string, readonly string[]>` keyed by bare package name
  (`database-plugin` → `['database']`). `findNameConflict` gains a second check consulted only for
  `schematic === 'health-indicator'`: when an INSTALLED plugin claims the requested kebab name, the
  command refuses before writing, naming the plugin and the `app.start()` failure it prevents. Names
  a plugin computes at runtime (`cache.<name>`, `queue.<name>`, a capability token supplied through
  options) carry their DEFAULT spelling only, and the table records which entries are dynamic.
- **Why:** the failure is a startup throw from `HealthService.registerIndicator`, so refusing at
  generate time converts a boot failure into a message at the moment the name is chosen — the shape
  `findNameConflict` already ships for routes and DI tokens. A runtime probe of the installed
  plugins was rejected: `generate` must not boot the target project (the M34b rule that built-in
  verbs never boot), and the CLI cannot import a plugin to ask it.
- **Test home:** `packages/cli/test/unit/plugin-claims.test.ts` (the refusal fires only when the
  plugin is installed, and never for a name no plugin claims) and `test/plugin-claims-gate.test.ts`
  at the repository root — a drift gate that greps every `packages/*/src` for
  `ctx.health.register('<literal>')` and fails when a literal is absent from the table, with the
  dynamic sites listed explicitly so the gate cannot pass vacuously.

### 3.5 The scanner reports what it CLAIMS, and skips what is already wired by hand

- **Decision:** two additions at the command layer, neither of which changes what a generated
  artifact looks like:
  1. **Manual-wiring skip.** Before admitting a candidate, the command reads the project's
     `setu.config.ts` once and skips any candidate whose imported symbol already appears there,
     reporting
     `Skipped src/controllers/admin.routes.ts: registerAdminRoutes is already registered
     by hand in setu.config.ts …`.
     The developer's wiring keeps working and the barrel does not double-register it.
  2. **Adoption report.** A candidate admitted into the barrel that the EXISTING barrel on disk does
     not already name is reported as adopted, naming the file and the barrel that just claimed it.
- **Why:** requiring a provenance sentinel in the artifact itself was rejected: no artifact the CLI
  has ever emitted carries one (`http-module.ts` verified above), so a sentinel requirement would
  un-wire every artifact in every existing project — a worse defect than the one being fixed. Barrel
  membership is the signal that needs no migration, and it reports **exactly once**, at the moment
  of claiming, which is what F2 asks for. The manual-wiring skip is the precise detector for the
  case that actually breaks the boot: `setu.config.ts` is the one wiring home the CLI's own
  architecture defines (M34b), and a generated artifact's symbol never appears there, so a match
  means a hand registration and nothing else.
- **Test home:** `packages/cli/test/unit/artifact-scanner-adoption.test.ts` and
  `packages/cli/test/e2e/adopted-route-boots.test.ts`, which reproduces X4-4 end to end: hand-write
  a wired `admin.routes.ts`, run `setu generate route report`, and BOOT the project.

### 3.6 The end-to-end gate is the request no gate ever made

- **Decision:** `apps/full-stack/smoke.ts` gains assertions that `/openapi.json` answers `200` with
  `application/json` and a parseable OpenAPI document, and that `/docs` answers `200` with
  `text/html`. `apps/full-stack` is already outside `ALLOW_SKIP`, so this runs on every CI run.
- **Why:** the kernel unit test proves the sort; only the real composition proves that the SSR
  catch-all, the starter's plugin order and the OpenAPI priority together produce a reachable
  endpoint. The register's own account of why this shipped is that the smoke requested three paths
  and never this one.
- **Test home:** `apps/full-stack/smoke.ts`, run by `deno task check:apps`.

## 4. Exported surface — every symbol names its consumer

**No package's `src/index.ts` changes.** Every symbol below is internal to its package; the barrels
of `kernel` and `cli` are byte-identical after this milestone, which a barrel-exports test pins (the
M56 defect class).

| Exported symbol                             | Kind                                                       | Consumer / real code path that READS it                                                                       |
| ------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Segment` (widened with the `wildcard` arm) | type, `route-matcher.ts` (internal; not in `src/index.ts`) | `staticSegmentCount` and `wildcardSegmentCount` branch on the arm; `Router.#registerMethod` reads both counts |
| `wildcardSegmentCount`                      | function, `route-matcher.ts` (internal)                    | `Router.#registerMethod` — hoisted to registration time beside `staticSegmentCount`                           |
| `RouteEntry.wildcards`                      | field, `router.ts` (internal)                              | `Router.match`'s second sort key; also surfaced by `getAll()`, which the router tests read                    |
| `describeRouteOwner`                        | function, `router.ts` (internal, module-private)           | `#registerMethod`'s throw — the only caller, by design                                                        |
| `PLUGIN_HEALTH_INDICATORS`                  | const map, `cli/src/utils/plugin-claims.ts` (internal)     | `findNameConflict`'s plugin-claim arm, and the root drift gate                                                |
| `findPluginClaim`                           | function, `cli/src/utils/plugin-claims.ts` (internal)      | `findNameConflict`; kept separate so the table and the lookup have one home                                   |
| `ArtifactScan.adopted`                      | field, `cli/src/utils/artifact-scanner.ts` (internal)      | `runGenerateCommand`'s adoption report                                                                        |
| `readManualWiring`                          | function, `cli/src/utils/artifact-scanner.ts` (internal)   | `scanArtifacts`, which passes the symbol set into `readArtifactNames`                                         |

### 4.1 Options — every option names its consumer

None (checked). This milestone adds no plugin option, no CLI flag and no capability token: every
change is one of three kinds — a ranking rule, a diagnostic, a refusal — and each is unconditional.
An option to restore the old ordering was considered and rejected — it would preserve a defect
behind a flag and give the next plugin that mounts a catch-all two behaviours to reason about.

## 5. Implementation files

| File                                                                                                 | Purpose                                                                                      |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/kernel/src/index.ts`                                                                       | Unchanged (pinned by a barrel-exports test)                                                  |
| `packages/kernel/src/router/route-matcher.ts`                                                        | `wildcard` segment arm, `wildcardSegmentCount`, `staticSegmentCount` no longer counts `*`    |
| `packages/kernel/src/router/router.ts`                                                               | `RouteEntry.wildcards`; three-key tie-break; `describeRouteOwner` and the owner-naming throw |
| `packages/cli/src/index.ts`                                                                          | Unchanged (pinned by a barrel-exports test)                                                  |
| `packages/cli/src/utils/plugin-claims.ts`                                                            | The plugin-owned indicator-name table and its lookup (new)                                   |
| `packages/cli/src/utils/name-conflicts.ts`                                                           | Plugin-claim arm for `health-indicator`                                                      |
| `packages/cli/src/utils/artifact-scanner.ts`                                                         | Adoption classification and the manual-wiring skip                                           |
| `packages/cli/src/commands/generate.ts`                                                              | Reports adoptions and manual-wiring skips; refuses a claimed indicator name                  |
| `apps/full-stack/smoke.ts`                                                                           | Requests `/openapi.json` and `/docs` (the end-to-end gate)                                   |
| `ARCHITECTURE.md`, `PUBLIC_API.md`, `ROADMAP.md`, `CHANGELOG.md`, `packages/static-plugin/README.md` | Doc deliverables C1–C5 and the breaking-change entry                                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                  | src covered                             | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel/test/unit/route-matcher.test.ts` (extended)               | `route-matcher.ts`                      | `parsePattern('/*')` yields one `wildcard` segment; `staticSegmentCount` returns `0` for `/*` and `1` for `/a/*`; `wildcardSegmentCount` returns `1` for both and `0` for `/a/:id`. Calls type-check against `parsePattern(pattern: string): readonly Segment[]`                                    |
| `packages/kernel/test/unit/router-wildcard-precedence.test.ts` (new)       | `router.ts`                             | For each pair — `/*` vs `/openapi.json`, `/*` vs `/`, `/a/*` vs `/a/:id`, `/assets/*` vs `/*` — the more specific route wins in BOTH registration orders. Plus §3.2's documented limit (`/a/*` vs `/:x/b`) pinned explicitly. Calls type-check against `match(method: HttpMethod, path: string)`    |
| `packages/kernel/test/unit/router.test.ts` (extended)                      | `router.ts`                             | The duplicate-route throw names a plugin owner, and names "the application" when `owner` is absent; `getAll()` reports `wildcards`                                                                                                                                                                  |
| `packages/kernel/test/integration/catchall-vs-plugin-routes.test.ts` (new) | `router.ts`, `application.ts`           | A real `createApplication` with a catch-all plugin at `NORMAL` and a route plugin at `OPENAPI`: the later plugin's `/openapi.json` answers `200` through `app.fetch`, and the catch-all still serves an unmatched path. A second case asserts the duplicate-`GET /*` refusal names the first plugin |
| `packages/kernel/test/unit/barrel-exports.test.ts` (new)                   | `src/index.ts`                          | The kernel's published surface is unchanged by this milestone                                                                                                                                                                                                                                       |
| `packages/cli/test/unit/plugin-claims.test.ts` (new)                       | `plugin-claims.ts`, `name-conflicts.ts` | `findPluginClaim('database', new Set(['database-plugin']))` reports the plugin; the same call with an empty set reports nothing; a name no plugin claims is free. Calls type-check against `findNameConflict(schematic, kebab, plugins, artifacts, modules)`                                        |
| `packages/cli/test/unit/artifact-scanner-adoption.test.ts` (new)           | `artifact-scanner.ts`                   | A candidate absent from the existing barrel is reported adopted; one already named by the barrel is not; a candidate whose symbol appears in `setu.config.ts` is skipped with the manual-wiring reason. Calls type-check against `readArtifactNames(fs, dir, spec)` and its widened result          |
| `packages/cli/test/unit/generate.test.ts` (extended)                       | `generate.ts`                           | `setu g health-indicator database` in a project with `database-plugin` exits `EXIT_ERROR`, writes nothing, and names the plugin; the same command in a project without it succeeds                                                                                                                  |
| `packages/cli/test/e2e/adopted-route-boots.test.ts` (new)                  | `artifact-scanner.ts`, `generate.ts`    | X4-4 end to end: scaffold, hand-write a wired `admin.routes.ts`, run `setu generate route report`, type-check and BOOT — the application serves both the hand-written and the generated route                                                                                                       |
| `packages/cli/test/unit/barrel-exports.test.ts` (extended, if present)     | `src/index.ts`                          | The CLI's published surface is unchanged                                                                                                                                                                                                                                                            |
| `test/plugin-claims-gate.test.ts` (new, repository root)                   | `plugin-claims.ts`                      | Every literal `ctx.health.register('<name>')` in `packages/*/src` is in the table; every dynamic site is in the gate's explicit exclusion list, so a new plugin cannot be silently missed                                                                                                           |
| `apps/full-stack/smoke.ts` (extended)                                      | end-to-end                              | `/openapi.json` → `200` + `application/json` + a parseable document; `/docs` → `200` + `text/html`; `/` and `/products` still render SSR                                                                                                                                                            |

No external dependency is added, so no guarded real-import test applies (checked).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70g-routing-collisions, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:apps        # apps/full-stack now requests /openapi.json and /docs
deno task check:docs
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.8
```

**Negative controls to run and revert** (each must be observed FAILING):

1. Revert the `wildcards` sort key → `router-wildcard-precedence.test.ts` fails on the
   wildcard-vs-param pairs, and the full-stack smoke returns `404` for `/openapi.json`.
2. Revert `staticSegmentCount`'s wildcard exclusion → the catch-all-first cases fail.
3. Drop the owner from the duplicate-route throw → the integration collision assertion fails.
4. Drop the manual-wiring skip → `adopted-route-boots.test.ts` reproduces the exact X4-4 boot
   failure.
5. Remove one plugin from `PLUGIN_HEALTH_INDICATORS` → the root drift gate names that package.
6. Delete an `/openapi.json` assertion from the smoke → `check:apps` must still fail for the OTHER
   assertion, proving the gate is not carried by one line.

## 8. Risks & mitigations

- **The ranking change is a breaking behaviour change.** An application relying on a catch-all
  registered first to shadow a later single-segment route changes outcome. Mitigation: a CHANGELOG
  entry with migration text, stated as a behaviour change rather than folded into a release note;
  the shadowed route was unreachable by accident, so the direction of the change is toward what the
  developer wrote. `apps/*` are all re-run through `check:apps` to surface any in-repo reliance.
- **A previously-shadowed route becoming reachable can change an application's responses.** A
  full-stack application whose SSR handled `/login` while a plugin also registered `/login` now
  serves the plugin. Mitigation: the integration test pins the direction, and the smoke asserts SSR
  paths still render, so a regression in the other direction is caught in the same run.
- **The manual-wiring skip is a text search, not a parse.** A hand registration reached from a
  module other than `setu.config.ts` is not seen. Mitigation: the adoption report (§3.5.2) still
  fires for that file, so the claim is visible even when the skip does not apply; the limit is
  stated in the scanner's JSDoc.
- **The indicator claim table can drift as plugins change their names.** Mitigation: the root drift
  gate is the deliverable that keeps it honest, and it fails on an unknown literal rather than
  ignoring it.
- **`apps/full-stack` runs a real Vite build, so the new assertions lengthen an already-slow gate.**
  Mitigation: the assertions reuse the app instance the smoke already boots; no second build.

## 8b. Corrections found during implementation

Recorded rather than quietly dropped, per the M70a and M70h precedent.

- **Two negative controls did not hold as written.** Control 2 ("revert `staticSegmentCount`'s
  wildcard exclusion") cannot be run in the obvious form: with the `wildcard` arm still in the
  `Segment` union, a counter that also counts wildcards fails `deno check` rather than the tests, so
  it measures the type-checker instead of the ranking. The equivalent control — reverting
  `parsePattern`'s wildcard arm to `{ type: 'static', value: '*' }` — was run against the REAL
  `apps/full-stack` smoke, which is the stronger site: `/openapi.json` answered **404** with the SSR
  catch-all serving it, exactly as X5-1 reported, and `200` with the arm restored. Control 6 was
  replaced for the same reason: pointing the smoke's request at a path that does not exist proves
  the assertion discriminates, and the kernel-revert above proves the assertion measures the
  milestone's own fix rather than an unrelated invariant.
- **Two names moved.** `findPluginClaim` shipped as `findPluginIndicatorClaim` (the table is
  indicator-specific and a bare `findPluginClaim` would invite a second, unrelated claim kind), and
  `adopted-route-boots.test.ts` shipped as `adopted-route-e2e.test.ts`, matching the `*-e2e.test.ts`
  convention every other file in that directory follows.
- **`NameConflict` was reshaped rather than extended.** §3.4 planned to reuse the existing
  `schematic` field for the plugin arm, which would have rendered "claimed by the
  @setu-ts/database-plugin of the same name". The interface now carries `claimedBy` and `remedy` as
  rendered phrases, so the command has one message for both kinds of claimant and neither reads as
  the other.
- **The claim table tripped the M70c indicator audit.** `test/health-indicator-audit.test.ts`
  matches the registration call's literal text anywhere under a package's `src`, and this
  milestone's JSDoc quoted it in prose — inside `packages/cli`, which holds no plugin context and
  can register nothing. The full suite went red on it; the comment now names the concept instead and
  says why. Recorded because the same trap catches the next milestone that writes about health
  indicators in package source.

## 9. Out of scope

- **A `405` for a method mismatch on an existing path.** M70f §9 deferred it here on the reasoning
  that `match()` cannot distinguish "no such path" from "no such method", which is a router change.
  It is declined for this milestone with a stated reason rather than absorbed: answering `405`
  requires a per-path method index and a decision about `Allow` header contents on wildcard and
  param routes, and it must emit through M70f's `respondWithError` seam, which is not on `main` yet.
  Recorded in the ROADMAP M70f row as still-open so it cannot fall between the two.
- **Per-segment lexicographic route ranking** (§3.2's documented limit) — a deliberate future
  change, not a gap.
- **`StaticPlugin` serving a root-path file alongside SSR** (X5-5) — a capability question owned by
  **M70k**; this milestone only makes the refusal name the owner and documents the constraint (C5).
- **A provenance sentinel in generated artifacts** — rejected in §3.5 with cause, not deferred.
- **The config callback's missing excess-property check** (X5-2) — **M70n**.
