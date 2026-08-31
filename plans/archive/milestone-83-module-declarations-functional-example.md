# Milestone 83 — Module Declarations and a Worked Functional Example (`@setu-ts/decorator-plugin`, `@setu-ts/cli`)

> **Status:** Complete (PR #213). Archived on completion. Branch:
> `feat/m83-module-declarations-functional-example`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Ship a `@Module` declaration that lets decorated applications group controllers and providers in
application-owned code, then flatten explicitly activated module trees through `DecoratorPlugin`.
Update the module schematic to generate and activate module classes, and make the default functional
`rest` scaffold demonstrate the same controller/service seam used by later generation. The work is
limited to `decorator-plugin`, `cli`, and the documents that describe their published and generated
surfaces.

- **In scope:** `ModuleOptions` and `@Module`; `DecoratorPluginOptions.modules`; concrete module
  metadata and deterministic module flattening; startup refusal for a required constructor arity
  with no `@Inject`; class-based module generation, its aggregate activation barrel, and its
  migration diagnostic; a seeded functional REST greeting example; package READMEs, public API, Nest
  migration guide, changelog, and milestone tracking.
- **NOT this milestone:** Per-module DI scope, a provider visibility boundary, and module `exports`
  remain a future `di-plugin` design; automatic filesystem discovery of modules remains excluded by
  M64; the functional mode remains decorator-free; service symbol convention changes are not
  necessary because the showcase deliberately exports the committed `describeGreeting` symbol.

## 1. Contracts verified from SOURCE (not names)

| Reference                      | Source (file:line)                                                                         | Verified surface / fact                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMetadataStore`               | `packages/common/src/plugin.ts:406-413`                                                    | The published common port exposes only readonly `controllers`, `services`, and `routes` maps. Module metadata belongs on concrete `MetadataStore`, avoiding a common widening with no external consumer. |
| Standard decorator bridge      | `packages/decorator-plugin/src/metadata/context-bridge.ts:94-112`                          | `classDecorator` receives the constructor and writes through the process-wide concrete store, so `@Module` can use the established TC39 class-decorator mechanism.                                       |
| `MetadataStore`                | `packages/decorator-plugin/src/metadata/metadata-store.ts:253-258,445-447,589-595`         | The store owns concrete controller and service metadata plus targeted reads and reset logic. A parallel private module map, targeted accessor, and `clear()` reset are the fitting extension.            |
| `DecoratorPluginOptions`       | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:48-72`                           | Explicit controllers and services are existing additive input lists; `modules?: readonly Constructor[]` can join them without changing existing calls.                                                   |
| Registration order             | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:218-257,734-742`                 | Services are registered before controllers. Constructor instantiation currently falls through to a zero-argument call when no injection list exists.                                                     |
| `Constructor`                  | `packages/common/src/plugin.ts`                                                            | Decorator lists are class constructors; both the existing options and aggregate barrels already type their lists as `Constructor[]`.                                                                     |
| Module schematic               | `packages/cli/src/schematics/module.ts:74-113,170-180`                                     | Class-based modules currently emit service, controller, test, per-module barrel, and managed aggregate barrel; the functional arm is separate and must remain unchanged.                                 |
| Aggregate module barrel        | `packages/cli/src/schematics/module-barrel.ts:17-64`                                       | The generated barrel currently owns controller and service arrays. It can instead import one `<Pascal>Module` class per valid module and expose a `MODULES` activation list.                             |
| Module scan                    | `packages/cli/src/utils/module-scanner.ts:35-60,88-97`                                     | Admission currently verifies controller and service files. The barrel's new import adds `<name>.module.ts` as a necessary precondition.                                                                  |
| Generation diagnostics         | `packages/cli/src/commands/generate.ts:238-291`                                            | Command-level scans are deliberately reported instead of silently omitting files; module migration reporting follows this existing diagnostic policy.                                                    |
| Functional service seam        | `packages/cli/src/seams/services.ts:95-108,172-182`                                        | Functional service files must export `describe<Pascal>`, and this same definition drives scan admission and barrel rendering.                                                                            |
| Functional controller seam     | `packages/cli/src/seams/http.ts`                                                           | A functional controller exports its registered route function and is collected through the controller seam; the REST showcase must emit that exact seam symbol.                                          |
| REST template                  | `packages/cli/src/templates/rest.ts:89-111` and `packages/cli/src/templates/seam.ts:45-71` | The default REST template has all eligible seam barrels but seeds no artifacts. `seamFiles` accepts seeded artifact names, which is the real registration path for the showcase.                         |
| Class-based showcase precedent | `packages/cli/src/templates/class-based.ts:43-110`                                         | The opt-in template emits a service and controller inside their seam directories and seeds the corresponding barrels; M83 mirrors the registration principle, not the decorator style.                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                              | Resolution (picked side)                                                                                                                        | Doc deliverable (same PR)                                                                            |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| C1 | `docs/migration-nestjs.md:185-227` says a Nest `@Module` maps only to a Setu plugin, while the milestone adds a decorator module for domain grouping. | Keep plugin composition as the migration for a self-contained capability; document `@Module` as the distinct in-application grouping mechanism. | Correct the migration guide's modules comparison with both valid mappings and an activation example. |
| C2 | CLI docs describe the generated aggregate barrel as `MODULE_CONTROLLERS` plus `MODULE_SERVICES`, while the new generated output uses module classes.  | The generated source is authoritative: replace those exported arrays with `MODULES` and describe it as the active-module list.                  | Update `packages/cli/README.md`, `PUBLIC_API.md`, and generated-barrel explanatory text.             |
| C3 | Public decorator docs list the old `DecoratorPluginOptions` members and no module surface.                                                            | Publish `Module`, `ModuleOptions`, and the additive `modules?` option exactly as implemented.                                                   | Update `packages/decorator-plugin/README.md` and `PUBLIC_API.md`.                                    |

## 3. Design decisions

### 3.1 Module metadata and declaration

- **Decision:** Export `Module(options: ModuleOptions): SetuClassDecorator`. `ModuleOptions` has
  optional readonly `controllers`, `providers`, and `imports` constructor arrays. It writes
  normalized empty arrays into a private `MetadataStore` module map through `classDecorator`; the
  concrete `ModuleMetadata` type remains internal.
- **Why:** `IMetadataStore` intentionally hides concrete values and no other package consumes module
  metadata. `exports` is omitted because the application has one service registry and optional one
  DI container, not a per-module visibility boundary.
- **Test home:** `packages/decorator-plugin/test/unit/module-decorator.test.ts`, metadata-store
  tests, barrel-export test, and the decorator application integration test.

### 3.2 Module activation and flattening

- **Decision:** `DecoratorPlugin({ modules })` visits activated module classes depth-first with one
  identity `seen` set. It visits imports before the importer, appends the importer's providers
  before its controllers, then deduplicates the collected classes together with explicit and
  discovered registrations before the existing registration loops. A class supplied in `modules`
  without metadata logs one warning with its class name and contributes no classes. Diamonds and
  cycles visit each module exactly once.
- **Why:** Imported providers exist before an importing controller is instantiated; identity
  deduplication terminates cycles and prevents duplicate kernel registration. A missing module
  declaration is normally a duplicate package copy, which deserves an actionable diagnostic without
  taking an unrelated application down.
- **Test home:** `packages/decorator-plugin/test/integration/decorator-plugin.test.ts` and
  `packages/decorator-plugin/test/integration/startup-warnings.test.ts` drive ordering, nesting,
  deduplication, cycles, mixed explicit lists, and the warning through a real plugin context.

### 3.3 Constructor arity refusal

- **Decision:** During service registration, a class whose constructor has `length > 0` and has no
  `@Inject(...)` token list throws a startup error naming the class and explaining the required
  explicit tokens. A class with no constructor, an empty constructor, or only defaulted parameters
  remains constructible. The check applies on both registry and container paths before construction
  or provider registration.
- **Why:** Without decorator metadata, no token can be inferred. `Function.length` is a safe lower
  bound: it can miss a defaulted required-at-runtime shape, but it cannot reject the zero-argument
  classes the framework can honestly construct.
- **Test home:** `packages/decorator-plugin/test/integration/decorator-plugin.test.ts` and
  `packages/decorator-plugin/test/integration/di-interop.test.ts` prove failure on both paths and
  preserve zero-arity behavior.

### 3.4 Generated module activation and migration

- **Decision:** In class-based projects the module schematic emits `<name>.module.ts` with
  `@Module({ controllers: [<Pascal>Controller], providers: [<Pascal>Service] })`; its per-module
  barrel re-exports that class. The managed aggregate barrel exports `MODULES`, and template config
  passes `modules: [...MODULES]` to `DecoratorPlugin`. Existing module directories missing the new
  module file are excluded and reported by the command as a breaking generated-output migration; the
  CLI does not synthesize developer-owned files during an unrelated generation.
- **Why:** The CLI may own activation via its managed barrel but must never invent or overwrite the
  contents of a developer-owned domain declaration. Reporting prevents an old module disappearing
  from registration silently.
- **Test home:** module schematic, module-barrel, module-scanner, module command, module-seam, and
  template e2e tests verify emitted files, regeneration, deterministic ordering, output diagnostic,
  and generated-project typechecking.

### 3.5 Worked functional REST example

- **Decision:** The `rest` template emits a plain `describeGreeting(name)` service and a functional
  greeting controller with `GET /greetings` and `GET /greetings/:name`. It seeds their artifact
  names through the existing service and controller seams; it continues to leave the inline root
  hello route intact.
- **Why:** This is the default mode's direct answer to where service code lives and how a route
  consumes it. The fixed `describeGreeting` name follows the existing scanner/barrel contract rather
  than creating a second functional service convention.
- **Test home:** REST template tests, seam wiring tests, template e2e tests, and scaffold-runs e2e
  tests assert emitted registration, formatted generated output, and live responses.

### 3.6 Documentation and release state

- **Decision:** Document both generated `MODULES` activation and an application-owned root
  `@Module({ imports })` option. Mark M83 complete only after implementation and all verification
  gates pass; record the changed generated module structure and migration action under the
  Unreleased changelog.
- **Why:** The root form is fully supported by `imports`, while the generated barrel remains the
  only shape that lets `setu generate module` auto-wire a later module without modifying a developer
  file.
- **Test home:** documentation checks, package export generation checks, and the plan/gate suite.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                  | Kind          | Consumer / real code path that READS it                                                              |
| -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `Module`                         | function      | Application classes call it; it records module metadata that `DecoratorPlugin` reads from `modules`. |
| `ModuleOptions`                  | interface     | Application code passes it to `Module`; `Module` reads all three arrays into concrete metadata.      |
| `DecoratorPluginOptions.modules` | option member | `DecoratorPlugin.register()` passes it to module flattening before registration.                     |

### 4.1 Options — every option names its consumer

| Option                           | Consumer                     | Behavior (per implementation)                                                            |
| -------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `ModuleOptions.controllers`      | Module flattener             | Appends these controller constructors after imported modules' contributions.             |
| `ModuleOptions.providers`        | Module flattener             | Appends these service constructors before the same module's controllers.                 |
| `ModuleOptions.imports`          | Module flattener             | Recurses depth-first, deduplicating and cycle-terminating by constructor identity.       |
| `DecoratorPluginOptions.modules` | `DecoratorPlugin.register()` | Selects root module classes to flatten alongside existing explicit and discovered lists. |

## 5. Implementation files

| File                                                       | Purpose                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/decorator-plugin/src/decorators/module.ts`       | Public TC39 `@Module` decorator and options contract.                                     |
| `packages/decorator-plugin/src/metadata/metadata-store.ts` | Private module metadata map, targeted read/write methods, and reset support.              |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts` | Modules option, flattening, registration composition, and required-arity startup refusal. |
| `packages/decorator-plugin/src/index.ts`                   | Documented public `Module` and `ModuleOptions` exports.                                   |
| `packages/cli/src/schematics/module.ts`                    | Class-based module declaration source and per-module re-export.                           |
| `packages/cli/src/schematics/module-barrel.ts`             | `MODULES` aggregate activation barrel.                                                    |
| `packages/cli/src/templates/module-seam.ts`                | `MODULES` config import and decorator-plugin `modules` wiring.                            |
| `packages/cli/src/utils/module-scanner.ts`                 | Module-file admission requirement and structured migration skips.                         |
| `packages/cli/src/commands/generate.ts`                    | Reports old module directories excluded by the changed barrel precondition.               |
| `packages/cli/src/templates/rest-showcase.ts`              | Functional greeting service/controller source, derived seam symbols, and files.           |
| `packages/cli/src/templates/rest.ts`                       | Adds showcase files and seeded service/controller barrels to the default REST template.   |
| `packages/decorator-plugin/README.md`                      | Module usage, option, export, and arity diagnostic documentation.                         |
| `packages/cli/README.md`                                   | Module generation and activation-barrel migration documentation.                          |
| `docs/migration-nestjs.md`                                 | Distinguishes plugin capability composition from in-app `@Module` grouping.               |
| `PUBLIC_API.md`                                            | Decorator and CLI public-surface descriptions.                                            |
| `CHANGELOG.md`                                             | Unreleased breaking generated-output migration and new decorator feature.                 |
| `ROADMAP.md`                                               | Marks Milestone 83 complete once the milestone is verified.                               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                             | src covered                                                                   | Key assertions (and the signature each call type-checks against)                                                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/decorator-plugin/test/unit/module-decorator.test.ts`        | `decorators/module.ts`                                                        | `Module({ controllers, providers, imports })` writes exact constructor arrays through `ModuleOptions`; omitted members become empty arrays.                                   |
| `packages/decorator-plugin/test/unit/metadata-store.test.ts`          | `metadata/metadata-store.ts`                                                  | `mergeModule`, targeted reads, metadata isolation, and `clear()` behavior.                                                                                                    |
| `packages/decorator-plugin/test/integration/decorator-plugin.test.ts` | `plugin/decorator-plugin.ts`                                                  | `DecoratorPlugin({ modules: [RootModule] })` registers nested providers/controllers in the chosen order, dedups diamonds/cycles, and rejects required arity with no `Inject`. |
| `packages/decorator-plugin/test/integration/di-interop.test.ts`       | `plugin/decorator-plugin.ts`                                                  | Container registration also rejects unannotated required constructors and preserves explicit injection.                                                                       |
| `packages/decorator-plugin/test/integration/startup-warnings.test.ts` | `plugin/decorator-plugin.ts`                                                  | `DecoratorPlugin({ modules: [Undecorated] })` logs a class-named warning and starts.                                                                                          |
| `packages/decorator-plugin/test/unit/barrel-exports.test.ts`          | `index.ts`                                                                    | Value and type imports prove `Module` and `ModuleOptions` are published; expected barrel list stays exact.                                                                    |
| `packages/cli/test/unit/schematics/module.test.ts`                    | `schematics/module.ts`                                                        | Class generation emits `UserModule`, names its controller/provider, and per-module barrel re-exports it; functional output does not change.                                   |
| `packages/cli/test/unit/schematics/module-barrel.test.ts`             | `schematics/module-barrel.ts`                                                 | Empty and populated `MODULES` arrays, module imports, sort/dedup, and generated explanatory text.                                                                             |
| `packages/cli/test/unit/utils/module-scanner.test.ts`                 | `utils/module-scanner.ts`                                                     | Requires controller, service, and module files; records a skipped legacy module with the missing module path.                                                                 |
| `packages/cli/test/unit/generate-module-command.test.ts`              | `commands/generate.ts`                                                        | Emits six class-based files, preserves earlier valid modules, and reports a legacy module excluded at regeneration.                                                           |
| `packages/cli/test/unit/module-seam.test.ts`                          | `templates/module-seam.ts`                                                    | Config imports `MODULES` and passes `modules: [...MODULES]`, while extra standalone class seams remain valid.                                                                 |
| `packages/cli/test/unit/templates.test.ts`                            | `templates/rest.ts`, `templates/rest-showcase.ts`                             | Default REST output contains greeting files, expected derived seam exports, and seeded barrels.                                                                               |
| `packages/cli/test/e2e/template-e2e.test.ts`                          | `templates/rest.ts`, `templates/rest-showcase.ts`, `templates/module-seam.ts` | A generated REST project formats and typechecks; a class-based project compiles generated module declarations.                                                                |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`                     | `templates/rest-showcase.ts`                                                  | A scaffolded REST application answers the greeting endpoints using the service import and seam registration.                                                                  |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m83-module-declarations-functional-example, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check
deno task release:verify <version>
```

The final evidence also includes a forbidden-construct scan for each touched package source, a real
generated REST exercise, the coverage table, and the committed-tree publish checks.

## 8. Risks & mitigations

- A legacy module could disappear from a regenerated barrel without explanation → carry structured
  skips from module scanning to command output, naming the required module file and remediation.
- Flattening can register a class twice or recurse indefinitely → use a constructor-identity seen
  set and integration tests for diamond and cyclic imports.
- A template emitter can format while its emitted source does not → typecheck and run
  `deno fmt --check` against actual scaffold output; keep derived symbols in short local constants
  rather than reflow-prone template interpolation.
- The arity guard could reject constructible classes → only reject a positive `Function.length`;
  test empty and default-only constructors explicitly.

## 9. Out of scope

- A module provider visibility boundary, `exports`, or scoped module container is deferred to a
  dedicated `di-plugin` contract milestone.
- Filesystem module auto-discovery remains excluded; applications activate only the generated
  `MODULES` barrel or an explicit root module.
- Changing the established functional service export convention is excluded; the new example follows
  `describeGreeting`.
