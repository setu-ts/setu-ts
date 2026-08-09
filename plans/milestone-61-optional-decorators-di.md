# Milestone 61 — Decorators and DI as Real Choices in the Generator (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m61-optional-decorators-di`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

AI_GUIDELINES' "5 Optional Rules" state that decorators are optional, DI is optional, and
**"Everything has a programmatic API. No feature requires decorators or reflection."** The generator
contradicts all three and the contradiction is mechanically checkable: `VALUE_FLAGS`
(`constants.ts:66`) declares no `--di`; `DiPlugin` appears in exactly one template module
(`templates/nest.ts:128`); and `controller`/`module` are gated on `decorator-plugin`
(`schematics/registry.ts:122,125`), so the only opt-in is the template and it is coarse — no
template gives neither and refuses the decorated schematics, `rest`/`microservice` give decorators
without DI, `nest` gives both. This milestone makes each axis independently selectable and makes the
decorator-free path a real, wired path rather than a documented manual edit.

- **In scope:** a `--di` boolean flag on `setu new`, threaded through every template including the
  starter-composed `full-stack`; a `controller`/`module` gate refusal that names `g route` as the
  decorator-free alternative; making the no-template (minimal) path a **seam host** for the three
  ungated seams (`route`, `middleware`, `plugin`), so a decorator-free artifact reaches a
  registration site with no edit to a file the developer owns; and the doc deliverables below.
- **NOT this milestone:** `setu g app` / monorepo support — **M62**. Removing the `decorator-plugin`
  gate from `controller`/`module` — deliberately never (see §9). A `--no-decorators` variant of the
  resource generators — rejected with cause in §3.6, not deferred. Seams on `full-stack` — still
  unowned, for M58's and M60's stated reason (§3.5).

## 1. Contracts verified from SOURCE (not names)

| Reference                              | Source (file:line)                                                                          | Verified surface / fact                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DiPlugin`                             | `packages/di-plugin/src/plugin/di-plugin.ts:66`                                             | `export function DiPlugin(options?: DiPluginOptions): IPlugin` — options are OPTIONAL, so `DiPlugin()` type-checks and the wiring needs no `args` string.                                                                                            |
| `DiPlugin` barrel export               | `packages/di-plugin/src/index.ts:17-18`                                                     | `DiPlugin` value + `DiPluginOptions` type. The bare package name is `di-plugin`, which is what `Wiring.pkg` must carry.                                                                                                                              |
| Kernel duplicate-plugin refusal        | `packages/kernel/src/registry/plugin-resolver.ts:106-118`                                   | `assertUniqueNames` **throws** `Duplicate plugin name '<name>'` at startup. `--di --template nest` MUST therefore dedupe — this is the milestone's likeliest green-shipping defect (§3.2, §8).                                                       |
| `TemplateDefinition.plugins` invariant | `packages/cli/src/templates/registry.ts:196-203`                                            | "Must be empty when `appFactory` is set… A unit test enforces it across the registry." So `--di` CANNOT append a wiring on `full-stack`; it must go through the factory's own options (§3.3).                                                        |
| `nest`'s existing DI wiring            | `packages/cli/src/templates/nest.ts:118-128`                                                | `NEST_PLUGINS` = `withPluginOptionSeams(...).concat([{ pkg: 'di-plugin', symbol: 'DiPlugin' }])` — an inline literal, today's only `DiPlugin` reference in the CLI.                                                                                  |
| Starter `di` arm                       | `packages/starters/rest-starter/src/options.ts:160`, `src/app.ts:59`                        | `di?: DiPluginOptions`, consumed as `...(options.di ? [DiPlugin(options.di)] : [])` — GATED and inherited by the microservice and full-stack tiers. M36b built it; nothing in the CLI reaches it. This is the arm `--di --template full-stack` uses. |
| `seamsFor` on an empty package set     | `packages/cli/src/templates/seam.ts:41-45`, pinned by `test/unit/seam-wiring.test.ts:43-44` | `seamsFor(new Set())` yields exactly `['middleware', 'plugin', 'route']`. The existing filter already selects the three ungated seams, so a minimal host carries three seams and **none is inert** (§2 C1).                                          |
| Ungated seams                          | `packages/cli/src/seams/{routes,middleware,plugins}.ts`                                     | Only `controllers`, `services`, `cqrs` (×2), `events`, `health`, `metrics` declare `requiresPlugin` (grep over `src/seams/`). `ROUTES_SEAM` (`routes.ts:65-73`) has none.                                                                            |
| Route seam registration site           | `packages/cli/src/seams/routes.ts:17`, `templates/seam.ts:93-95`                            | `REGISTER_ROUTES_EXPORT = 'registerGeneratedRoutes'`, emitted as the setup call `registerGeneratedRoutes(app.router);`. This is the decorator-free HTTP handler's wiring.                                                                            |
| Minimal path is unwired **today**      | `packages/cli/src/commands/new.ts:721,736-742`                                              | `template?.files ?? []`, `template?.setupCalls ?? []` etc. — with no `--template` every seam contribution defaults to empty. Confirmed by probe: `setu new bare` then `setu g route widget` writes the barrel while `setu.config.ts` never calls it. |
| Current gate refusal text              | `packages/cli/src/commands/generate.ts:160-167`                                             | Two lines: `The "<x>" schematic requires @setu-ts/<pkg>, which is not installed in <dir>.` then `Install it, then run this command again.` No alternative is named. Confirmed by probe.                                                              |
| `SchematicMetadata` is INTERNAL        | `packages/cli/src/index.ts` (whole file)                                                    | The barrel exports `Schematic`/`SchematicOptions` but NOT `SchematicMetadata`, `TemplateDefinition` or `MINIMAL_PLUGINS`. So §3.4's and §3.5's added fields are not public-API additions.                                                            |
| `--di` is not a value flag             | `packages/cli/src/args.ts:73-79`                                                            | A flag absent from `VALUE_FLAGS` records as boolean `true`. `--di` therefore needs NO `constants.ts` change, unlike `--runtime`/`--template`.                                                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                     | Doc deliverable (same PR)                                                                                                                                    |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | The archived M60 plan (§3.10, and its out-of-scope list) declares minimal-path seams **Unowned**, reasoning that it "means inventing a fourth `TemplateDefinition` for a project that registers the runtime plugin alone, where six of the ten seams would be inert." | **M61 claims it.** The premise no longer holds: `seamsFor(new Set())` already returns exactly the three ungated seams, so a minimal host carries three and none is inert. The "fourth `TemplateDefinition`" is avoided by extracting the shared shape as `TemplateHost` (§3.5) rather than adding a template — `TEMPLATES` and `TemplateName` are untouched. | ROADMAP M61 deliverables gain this item; the archived M60 plan is NOT edited (history), but ROADMAP M60's "Out of scope" line is annotated "claimed by M61". |
| C2 | `PUBLIC_API.md:5060-5061` states "`--template full-stack` and the no-template path are deliberately not hosts." After §3.5 the no-template path IS a host.                                                                                                            | Correct the sentence: `full-stack` alone is deliberately not a host; the no-template path carries the three seams that need no plugin.                                                                                                                                                                                                                       | `PUBLIC_API.md` "Generated code is wired" — that sentence, plus the "Which seams a host carries" paragraph (`:5084-5086`) gaining the minimal row.           |
| C3 | ROADMAP M61 says `VALUE_FLAGS` is "`dir`, `runtime`, `template`"; the committed set (`constants.ts:66-71`) also carries `config`.                                                                                                                                     | The source is right; the ROADMAP sentence is stale. `--di` is boolean and joins neither set.                                                                                                                                                                                                                                                                 | ROADMAP M61 prose corrected to name the committed four.                                                                                                      |
| C4 | ROADMAP M61's Deliverables list names only the refusal, while its prose offers a `--no-decorators` variant as the "fuller" option and leaves the choice to the plan.                                                                                                  | Ship the refusal AND §3.5's wiring; **reject** `--no-decorators` with cause (§3.6) rather than deferring it, so a later reader does not re-raise it.                                                                                                                                                                                                         | ROADMAP M61 "Out of scope" gains the rejection and its reason.                                                                                               |

## 3. Design decisions

### 3.1 `--di` is a boolean flag on `setu new`, read once in `runNewCommand`

- **Decision:** `args.flags['di'] === true` is read exactly once, in `runNewCommand`, and passed
  down as a single `TemplateFeatures { readonly di: boolean }` value. No `constants.ts` change: a
  flag absent from `VALUE_FLAGS` already parses as boolean (`args.ts:73-79`). It is added to
  `new --help` under Options. `setu generate` does NOT accept it — generation reads the project's
  manifest to learn what is installed, and a flag there would be a second, contradictable source.
- **Why:** one read site means the flag cannot be honored on one path and ignored on another (the
  "one capability, one implementation" rule). A `TemplateFeatures` object rather than a bare boolean
  because §3.3 needs to hand it to a factory-args callback, and a positional boolean there would be
  unreadable at the call site.
- **Test home:** `test/unit/new-command.test.ts` — `--di` accepted, absent by default; and
  `test/unit/help.test.ts` — the Options list names it.

### 3.2 `--di` on a plugin-list template appends ONE deduplicated `DI_WIRING`

- **Decision:** a single `DI_WIRING: Wiring = { pkg: 'di-plugin', symbol: 'DiPlugin' }` lives in a
  new `templates/di.ts`. `templates/nest.ts` stops declaring its own literal and imports it. A pure
  `withDiPlugin(wirings, features)` appends `DI_WIRING` under exactly one condition: `features.di`
  is true and no wiring with `pkg === 'di-plugin'` is already present. In every other case it
  returns the list unchanged.
- **Why:** dedupe is not defensive tidiness — the kernel THROWS on a duplicate plugin name
  (`plugin-resolver.ts:106-118`), so `setu new x --template nest --di` would otherwise scaffold a
  project that cannot boot. Deduplicating on `pkg` rather than on object identity is what makes it
  robust to a template that constructs its own equivalent wiring. Appending rather than inserting
  keeps `--template rest --di` differing from `rest` by exactly one trailing entry, which is what
  the ROADMAP's required test asserts; array position does not affect registration order, which the
  kernel resolves by declared `dependencies` (`registry.ts:252-254`).
- **Test home:** `test/unit/templates/di.test.ts` — the three branches of `withDiPlugin`; and
  `test/unit/new-command.test.ts` — `nest` byte-identical with and without `--di`, and `rest --di`
  differing from `rest` by exactly one wiring.

### 3.3 `--di` on `full-stack` goes through the starter's own `di` arm

- **Decision:** `AppFactoryWiring.args` widens from `(runtime: TargetRuntime) => string` to
  `(runtime: TargetRuntime, features: TemplateFeatures) => string` — an additive parameter.
  `fullStackArgs` emits `\n    di: {},` into the options object it already returns when
  `features.di` is true, and emits nothing when false, so the default output is byte-identical.
- **Why:** `TemplateDefinition.plugins` must stay empty when `appFactory` is set
  (`registry.ts:196-203`), so appending a wiring is not available on this template. The starter's
  `di?: DiPluginOptions` arm (`rest-starter/src/options.ts:160`) is inherited by the full-stack tier
  and is consumed as `...(options.di ? [DiPlugin(options.di)] : [])` (`app.ts:59`) — M36b built it
  and observed that "templates emit INLINE wiring and never import a starter, so the arm is
  unreachable from `setu new`". Reaching it is precisely this deliverable, so no new mechanism is
  invented. `{}` rather than an omitted value because the arm is truthiness-gated: `di: undefined`
  would register nothing while reading as opted-in.
- **Test home:** `test/unit/full-stack-template.test.ts` — the rendered args contain `di: {}` only
  under `--di`, and the no-`--di` render is byte-identical to the committed one; plus the
  `template-e2e.test.ts` type-check below, which is the only thing that can catch a malformed
  options object (the M50b trap: `args` is a rendered string the CLI's own `deno check` cannot see).

### 3.4 The gate refusal names its decorator-free alternative, as registry DATA

- **Decision:** `SchematicMetadata` gains an optional
  `alternative?: { readonly schematic: string; readonly why: string }`. Only `controller` and
  `module` declare it, both naming `route`. `runGenerateCommand` prints a third line when present:
  `Or run \`setu generate route <name>\` —
  <why>.`The gate itself is unchanged: the schematic is
  still refused with exit`1`.
- **Why:** the alternative belongs beside the gate it qualifies, in the one registry that already
  owns schematic names and their plugin gates — a string built inside `generate.ts` would be a
  second place schematic knowledge lives, and would silently rot when a schematic is renamed. The
  gate is NOT removed: those schematics emit `@Controller`, and an ungated project would get source
  whose own import cannot resolve (the M34b defect). `SchematicMetadata` is internal (`src/index.ts`
  does not export it), so this is not a public-API addition.
- **Test home:** `test/unit/generate-command.test.ts` — refusing `controller` and `module` in a bare
  project prints the `g route` line and still exits `1`; refusing `guard` (which has no alternative)
  prints exactly the two lines it prints today.

### 3.5 The no-template path becomes a seam host, via a shared `TemplateHost` shape

- **Decision:** the members `runNewCommand` currently reads with `template?.x ?? <empty>` are
  extracted into an exported `TemplateHost` interface in `templates/registry.ts`, and
  `TemplateDefinition extends TemplateHost` adds `name`, `description` and `unsupported`. A new
  `templates/minimal.ts` exports `MINIMAL_HOST: TemplateHost`, built from
  `seamsFor(new Set([RUNTIME_WIRING.pkg]))` through the SAME `seamFiles` / `seamLocalImports` /
  `seamPluginSpreads` / `seamSetupCalls` helpers the three templates use. `runNewCommand` reads
  `const host: TemplateHost = template ?? MINIMAL_HOST;` and the six `?? []` defaults disappear.
  `MINIMAL_PLUGINS` is superseded by `MINIMAL_HOST.plugins` and removed (it is internal — the barrel
  does not export it).
- **Why:** this is the deliverable, not a refactor for its own sake. A bare project's `g route` —
  the ONLY HTTP handler a decorator-free project can generate, and the thing §3.4's refusal now
  points at — currently writes an artifact and a barrel that nothing imports, which makes the
  guidelines' "everything has a programmatic API" true only after a manual two-line edit. Deriving
  the host from `seamsFor` rather than listing seams means the minimal path can never carry a seam
  whose plugin it lacks, and `TemplateHost` answers M60's stated objection directly: there is no
  fourth `TemplateDefinition`, no fourth `--template` value, and `listTemplates()` — which feeds
  `new --help` — is untouched, so the help text does not grow a template that does not exist.
- **Test home:** `test/unit/seam-wiring.test.ts` — the minimal host carries exactly
  `route`/`middleware`/`plugin` and their three barrels, carries NO gated seam's barrel, and its
  rendered `setu.config.ts` contains `registerGeneratedRoutes(app.router)`; `full-stack` still
  carries none. Plus the e2e in §6, which boots it.

### 3.6 `--no-decorators` is rejected, not deferred

- **Decision:** no `--no-decorators` flag on any schematic.
- **Why:** `g controller --no-decorators` would have to emit a router-registered handler module —
  which is exactly what `g route` already emits, wired through `ROUTES_SEAM`. Only two
  implementations exist and both are defects by this repo's own rules: a second copy of the route
  schematic violates §11.1 (no duplicated logic), and a bare alias whose only effect is to dispatch
  to `generateRoute` is dead surface by the rule that every declared symbol must be read on a real
  code path. The honest fix for discoverability is §3.4's refusal plus §3.5's wiring, both of which
  point a developer at the generator that already exists.
- **Test home:** none — a rejected mechanism has no behavior to assert. Recorded in ROADMAP M61's
  "Out of scope" (§2 C4) so a reader does not re-raise it.

### 3.7 Nothing about the emitted classes changes

- **Decision:** `--di` changes only the plugin list (or the starter's options object). No
  schematic's output shape changes, and no default composition of any template moves.
- **Why:** `DecoratorPlugin` branches on the container's presence at construction time
  (`nest.ts:110-117` records this, and M36b's `instantiate()` fix made it real), so the SAME
  `@Injectable` class works with and without `DiPlugin` — what changes is the lifecycle it gets, not
  its source. Emitting different source under `--di` would make the flag a fork in the generated
  code rather than a fork in the composition, and would strand every project scaffolded before it.
- **Test home:** `test/unit/new-command.test.ts` — `rest` and `rest --di` emit byte-identical files
  for every path except `setu.config.ts`.

## 4. Exported surface — every symbol names its consumer

No `packages/cli/src/index.ts` export is added, removed or changed. The barrel's five value exports
and six type exports are exactly as committed; a `barrel-exports.test.ts` already pins them
(`test/unit/barrel-exports.test.ts`), and it is re-run rather than edited.

| Exported symbol | Kind | Consumer / real code path that READS it                                                                                                                                                                                             |
| --------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none added)_  | —    | None (checked). `--di` is a CLI flag, not a symbol; `TemplateHost`, `MINIMAL_HOST`, `DI_WIRING`, `withDiPlugin` and `SchematicMetadata.alternative` are all INTERNAL — `src/index.ts` exports none of their modules (verified, §1). |

Internal symbols added, each with its reader:

| Internal symbol                 | Kind      | Consumer / real code path that READS it                                                        |
| ------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `TemplateFeatures`              | interface | `runNewCommand` builds it; `withDiPlugin` and `AppFactoryWiring.args` read `.di`.              |
| `DI_WIRING`                     | const     | `withDiPlugin` appends it; `templates/nest.ts` imports it in place of its own literal.         |
| `withDiPlugin`                  | function  | `runNewCommand`, on the plugin-list path, before `projectFiles`.                               |
| `TemplateHost`                  | interface | `runNewCommand`'s `host` local; `TemplateDefinition` extends it; `MINIMAL_HOST` implements it. |
| `MINIMAL_HOST`                  | const     | `runNewCommand`, as the `template ?? MINIMAL_HOST` default.                                    |
| `SchematicMetadata.alternative` | field     | `runGenerateCommand`'s gate-refusal branch prints it.                                          |

### 4.1 Options — every option names its consumer

| Option                          | Consumer                                                                                          | Behavior (per implementation)                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--di` (boolean, `setu new`)    | `runNewCommand` → `withDiPlugin` (plugin-list templates) / `AppFactoryWiring.args` (`full-stack`) | **no template / `rest` / `microservice`:** appends `DiPlugin()` to the plugin list. **`nest`:** no-op — `DiPlugin` is already present, and appending would throw at startup. **`full-stack`:** emits `di: {}` into the starter's options object. Absent → every template's output is byte-identical to today's. |
| `SchematicMetadata.alternative` | `runGenerateCommand`                                                                              | Present (`controller`, `module`) → a third refusal line naming `setu generate route`. Absent (every other gated schematic) → today's two lines, unchanged.                                                                                                                                                      |

## 5. Implementation files

| File                          | Purpose                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                | **Unchanged** — no export added (§4).                                                                                                                   |
| `src/templates/di.ts`         | NEW. `TemplateFeatures`, `DI_WIRING`, `withDiPlugin`. The one home for the DI wiring.                                                                   |
| `src/templates/minimal.ts`    | NEW. `MINIMAL_HOST` — the no-template host, derived from `seamsFor(new Set(['runtime']))`.                                                              |
| `src/templates/registry.ts`   | `TemplateHost` extracted; `TemplateDefinition extends TemplateHost`; `AppFactoryWiring.args` gains the `features` parameter; `MINIMAL_PLUGINS` removed. |
| `src/templates/nest.ts`       | Imports `DI_WIRING` instead of declaring the literal. No output change.                                                                                 |
| `src/templates/full-stack.ts` | `fullStackArgs(runtime, features)` emits `di: {}` under `--di`.                                                                                         |
| `src/commands/new.ts`         | Reads `--di` once, resolves `host`, applies `withDiPlugin`, threads `features` into `projectFiles`/`configModule`; `--help` gains the flag.             |
| `src/commands/generate.ts`    | Gate-refusal branch prints `alternative` when present.                                                                                                  |
| `src/schematics/registry.ts`  | `SchematicMetadata.alternative`; `controller` and `module` declare it.                                                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                          | src covered                                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/templates/di.test.ts` (NEW)             | `templates/di.ts`                                | `withDiPlugin(wirings, { di: false })` returns the input; `{ di: true }` appends exactly `DI_WIRING`; `{ di: true }` over a list already containing a `di-plugin` wiring returns the input unchanged (the dedupe branch). All three against `(readonly Wiring[], TemplateFeatures) => readonly Wiring[]`.                                                    |
| `test/unit/templates/minimal.test.ts` (NEW)        | `templates/minimal.ts`                           | `MINIMAL_HOST.plugins` is `[RUNTIME_WIRING]`; its `files` are exactly the three ungated barrels; its `setupCalls` contain `registerGeneratedRoutes(app.router);`; it carries no `src/controllers/` or `src/cqrs/` barrel.                                                                                                                                    |
| `test/unit/seam-wiring.test.ts` (extended)         | `templates/seam.ts`, `templates/minimal.ts`      | The existing three-host assertions keep passing; the bare-project assertion at `:43-44` is **deliberately updated** from "byte-identical to today's config" to "carries the three ungated seams" (C1/C2), and a new case pins that `full-stack` still carries none.                                                                                          |
| `test/unit/new-command.test.ts` (extended)         | `commands/new.ts`, `templates/registry.ts`       | `--template nest --di` is **byte-identical** to `--template nest` (the ROADMAP's required test, and the duplicate-plugin guard); `--template rest --di` differs from `rest` by exactly one wiring and in `setu.config.ts` only; a no-template project's `setu.config.ts` now contains the route setup call; every non-config file is unchanged under `--di`. |
| `test/unit/full-stack-template.test.ts` (extended) | `templates/full-stack.ts`                        | `fullStackArgs(runtime, { di: false })` is byte-identical to the committed render; `{ di: true }` inserts `di: {},` inside the returned options object and nowhere else. Against `(TargetRuntime, TemplateFeatures) => string`.                                                                                                                              |
| `test/unit/generate-command.test.ts` (extended)    | `commands/generate.ts`, `schematics/registry.ts` | `g controller` and `g module` in a bare project exit `1` AND print the `setu generate route` line; `g guard` in the same project prints exactly its committed two lines (the no-alternative branch); the alternative never appears when the plugin IS installed.                                                                                             |
| `test/unit/help.test.ts` (extended)                | `commands/new.ts` help branch                    | `new --help` lists `--di`, exits `0`.                                                                                                                                                                                                                                                                                                                        |
| `test/unit/templates.test.ts` (extended)           | `templates/registry.ts`                          | The existing "plugins empty when `appFactory` set" invariant still holds after the `TemplateHost` extraction, for every registry entry AND for `MINIMAL_HOST`.                                                                                                                                                                                               |
| `test/e2e/template-e2e.test.ts` (extended)         | the whole `new` path, end to end                 | Scaffold `rest --di` and `full-stack --di`, repoint at this workspace, `deno check` — the only gate that can see a malformed `args` string (M50b). **Proven to discriminate** by breaking `di: {}` to `diz: {}` and watching it fail, then restoring.                                                                                                        |
| `test/e2e/generate-e2e.test.ts` (extended)         | minimal host + `g route`, end to end             | Scaffold with NO template, `setu g route widget`, `deno check`, then BOOT the app and `GET /widget` expecting `200` — the functional bar M60 established. **Proven to discriminate** by removing the minimal setup call and watching the route 404.                                                                                                          |

Every `src/` file this milestone adds or changes appears above. `templates/di.ts` and
`templates/minimal.ts` are pure data-and-transform modules with no I/O, so 100% branch/function/line
is expected rather than merely 90%; the two command files are already covered and gain one branch
each, both asserted above.

No external dependency is added, so no guarded real-import test is required (this package has none:
its only `import()` is the custom-schematic loader, already covered by
`test/integration/custom-schematic-real-import.test.ts`).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m61-optional-decorators-di, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check              # on a COMMITTED tree
deno task release:verify <version>   # version agreement, specifiers, coverage, @module-first
```

## 8. Risks & mitigations

- **`--di --template nest` scaffolds an unbootable project.** The kernel throws
  `Duplicate plugin name 'di'` at `start()` (§1), and a scaffolded project that type-checks but
  cannot boot passes `deno check` and every unit test. → §3.2's dedupe, plus the byte-identical
  `nest`/`nest --di` assertion, plus the e2e that actually BOOTS a `--di` project.
- **The `full-stack` `di: {}` string is invisible to the CLI's own type-checker, AND — measured — to
  the generated project's.** `args` is rendered text, which is the M50b trap; but M50b's mitigation
  ("a misspelled field is a compile error in the GENERATED project") turns out NOT to hold for an
  `appFactory`. The emitted call is `createFullStackAppFromConfig((config) => ({ … }))`, and
  TypeScript does not apply excess-property checking to an object literal returned from a
  contextually-typed callback: probed against the real `FullStackStarterOptions`,
  `{ session: {…}, totallyBogusKey: {} }` in that position type-checks CLEANLY (exit 0), while the
  identical literal assigned to an annotated variable raises `TS2353`. Type-checking
  `setu.config.ts` alone would therefore have passed whatever key this template emitted. → the e2e
  writes an extra probe module putting the arm in an ANNOTATED position, where the check does fire;
  verified to discriminate by renaming the starter's `di` arm and watching the test fail, then
  restoring it. The pre-existing `reactRouter`/`session` keys in the same call have the same
  exposure and no such guard — flagged in §9 rather than fixed here.
- **Extracting `TemplateHost` silently drops a member on one path.** The six `?? []` defaults are
  replaced by object members; missing one would make a template stop emitting a seam with no
  diagnostic. → `test/unit/new-command.test.ts` asserts every existing template's full file list is
  unchanged, and `templates.test.ts` re-runs the registry-wide invariants.
- **The minimal host regresses a project that already exists.** A project scaffolded before this
  milestone has no seam imports; nothing here rewrites it. → the barrel header already states the
  lines to add (`seam-spec.ts:139-156`), and PUBLIC_API's "scaffolded before a seam existed"
  paragraph is extended to name the minimal path rather than exclude it.
- **Coverage regression in `commands/new.ts` from the removed `??` branches.** Deleting branches
  changes the denominator and can move an unrelated file. → per-file table read ANSI-stripped after
  the change, not just the aggregate, per the self-review checklist.

## 9. Out of scope

- **`setu g app` / monorepo support** — M62 owns it.
- **Removing the `decorator-plugin` gate from `controller`/`module`** — deliberately never. Those
  schematics emit `@Controller`, so an ungated project would get source whose own import cannot
  resolve; the fix is a better refusal (§3.4), not a removed one.
- **A `--no-decorators` variant of the resource generators** — rejected with cause in §3.6, not
  deferred: it would duplicate `g route` or alias it, and both are defects by this repo's own rules.
- **Seams on `full-stack`** — still unowned. Its layering is `routes → features → services`, it
  composes through a starter factory, and its `createApp` has no plugin array to spread into (M58's
  reason, restated by M60 §3.10). Unchanged here.
- **A `--decorators` flag** — not added. Decorators arrive with `DecoratorPlugin`, which the `rest`,
  `microservice` and `nest` templates already register and the minimal path deliberately does not;
  the axis is already selectable by template, and a second control over the same plugin would be a
  contradictable source.
- **Changing any schematic's emitted shape** — §3.7. `--di` forks the composition, never the
  generated source.
- **Guarding the `full-stack` template's OTHER `appFactory` option keys** (`reactRouter`, `session`,
  and every field inside them). §8 establishes by measurement that a misspelled key there is caught
  by nothing — not the CLI's `deno check`, not the generated project's, because excess-property
  checking does not reach a callback's returned object literal. This milestone adds an
  annotated-position probe for the ONE arm it introduces; extending the same technique to the
  pre-existing keys is a real gap but belongs to whoever next touches that template, since it is
  neither caused by nor specific to `--di`. Recorded here so it is not rediscovered as new.
