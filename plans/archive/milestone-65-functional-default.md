# Milestone 65 — Functional Default (`@setu-ts/cli`)

> **Status:** Complete and verified. Branch: `feat/m65-functional-default`. Archived on completion;
> the verification pass and its fixes are recorded in the CLAUDE.md milestone entry.

## 0. Objective & scope

Make the CLI generate one of two complete, persistent application styles. The default REST and
microservice scaffolds are functional: they register `ctx`-first routes, use plain exported
functions for application services, and omit both `DecoratorPlugin` and `DiPlugin`. The class-based
position is selected by `--template class-based`; it installs both plugins and causes subsequent
generation to emit decorated controllers, injectable services, constructor injection, and
class-oriented modules. The selection persists in the generated manifest and `generate` derives its
mode from the installed package set, so later invocations cannot silently revert to a different
style.

- **In scope:** CLI template composition, one coherent generator-mode detector, functional
  `generate module`, mode-aware service and controller output, `@Ctx()` in generated decorated write
  handlers, regression coverage that boots both worlds, and documentation for the revised CLI
  behavior.
- **NOT this milestone:** `@Ctx()` implementation and decorator-plugin exports, which M64 completed;
  database adapter execution, which M66 owns; scaffold environment and port ergonomics, which M67
  owns; and common or kernel contract changes, which M68 owns.

## 1. Contracts verified from SOURCE (not names)

| Reference                     | Source (file:line)                                                                                          | Verified surface / fact                                                                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template selection            | `packages/cli/src/templates/choice.ts`; `packages/cli/src/templates/registry.ts`                            | Both `new` and workspace-member generation resolve one named `TemplateDefinition` in one call site.                                                                                                                         |
| Retired independent DI option | `packages/cli/src/templates/choice.ts`; `packages/cli/src/templates/di.ts`                                  | `--di` is refused with a migration diagnostic; `DI_WIRING` remains solely for class-based template composition.                                                                                                             |
| REST composition              | `packages/cli/src/templates/rest.ts`                                                                        | `REST_PLUGINS` is functional, and its seams and generated config artifacts derive from that package set.                                                                                                                    |
| Class-based composition       | `packages/cli/src/templates/class-based.ts`                                                                 | The `class-based` template is built from the REST set and appends both decorator and DI wiring.                                                                                                                             |
| Persistent generation input   | `packages/cli/src/utils/plugin-detector.ts:78-107`; `packages/cli/src/commands/generate.ts:136-140,244-250` | `generate` reads the target's `deno.json` imports or npm dependencies before choosing a schematic and passes the resulting set to every `SchematicOptions` instance.                                                        |
| Schematic contract            | `packages/cli/src/schematics/registry.ts:31-84`                                                             | Every built-in schematic is a pure `(DerivedNames, SchematicOptions) => readonly GeneratedFile[]` function; `plugins` is already available without a public-interface widening.                                             |
| Service output                | `packages/cli/src/schematics/service.ts:30-113`                                                             | The existing service schematic already branches on decorator-plugin presence, but its non-decorator output is a class and decorator-only presence selects the injectable class.                                             |
| Domain aggregate output       | `packages/cli/src/schematics/module.ts`; `packages/cli/src/utils/module-scanner.ts`                         | Functional modules emit their service under `src/modules` and their registration function under `src/routes`; the existing route seam owns functional registration, while the scanner and module barrel remain class-based. |
| Route registration            | `packages/common/src/plugin.ts:69-145`; `packages/cli/src/schematics/route.ts:24-59`                        | `IRouterApi` supplies verb methods and `group`; the functional route schematic registers `ctx`-first handlers through that committed surface.                                                                               |
| Request context               | `packages/common/src/http.ts:278-322`                                                                       | `IRequestContext` exposes `response`, `services`, `params`, `query`, and request-scoped state; it is the functional world's explicit injector.                                                                              |
| Decorator context parameter   | `packages/decorator-plugin/src/index.ts:1-220`; `packages/decorator-plugin/src/decorators/ctx.ts:1-120`     | M64 exports the built-in `Ctx()` parameter decorator, which resolves the committed request context; M65 may emit it but does not alter its implementation.                                                                  |
| Generated-artifact seams      | `packages/cli/src/templates/seam.ts:30-124,142-189`; `packages/cli/src/seams/registry.ts:1-260`             | Host templates derive files, local imports, setup calls, and plugin options from seam metadata. Functional registration must reuse those seams rather than add an unwired barrel.                                           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                   | Resolution (picked side)                                                                                                                                                              | Doc deliverable (same PR)                                                                                                      |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `PUBLIC_API.md` describes independent decorator and DI axes and documents `--di`, while ROADMAP M65 specifies two coherent worlds and one opt-in that brings both plugins. | M65's later milestone contract wins: `--template class-based` is the sole class-oriented opt-in; the default templates install neither plugin and no independent `--di` mode remains. | Rewrite the CLI options and style-selection section in `PUBLIC_API.md`; update CLI README command examples and migration note. |
| C2 | `REST_PLUGINS` documents and implements `DecoratorPlugin` as unconditional, contrary to AI_GUIDELINES' optional-decorator rule and ROADMAP M65.                            | Functional REST is the default. `DecoratorPlugin` is removed from REST and inherited microservice composition, while `class-based` adds the decorator and DI pair.                    | Correct the REST and CLI template descriptions in `PUBLIC_API.md` and `packages/cli/README.md`.                                |
| C3 | Existing schematic JSDoc says a decorated handler cannot receive request context, but M64 now ships `@Ctx()` and M65 owns emitted controller shape.                        | Decorated generated write handlers use `@Ctx()` whenever they must set response status or headers; functional handlers continue taking `ctx` directly.                                | Update generated-source JSDoc snapshots and the CLI documentation's generated-controller examples.                             |

## 3. Design decisions

### 3.1 One persisted style selector

- **Decision:** Treat the generated manifest's package imports as the persisted selector. A project
  containing `decorator-plugin` is class-based; otherwise it is functional. New projects select the
  coherent decorator-and-DI pair only through `--template class-based`, and the independent `--di`
  flag is refused by new-project and workspace-member template choice. This preserves generation for
  projects created before the paired template existed.
- **Why:** `detectPlugins` already reads exactly the persisted data used for gating and never boots
  user code. Adding a second generated state file would duplicate the manifest's source of truth;
  retaining a decorator-only legacy project is less disruptive than making its existing generation
  commands fail, while new projects still have one explicit class-based selector.
- **Test home:** `test/unit/templates/choice.test.ts`, `test/unit/generator-mode.test.ts`,
  `test/unit/generate-command.test.ts`, and `test/e2e/template-e2e.test.ts`.

### 3.2 Functional template composition

- **Decision:** Remove `DecoratorPlugin` from `REST_PLUGINS`, recompute REST seams from that
  functional set, and let `MICROSERVICE_TEMPLATE` inherit it unchanged. Keep the existing
  no-template host functional. Build the `class-based` template from the functional REST list plus
  exactly one decorator wiring and exactly one DI wiring; its explicit example classes and decorator
  seam inputs remain there.
- **Why:** The template list is the source from which dependency manifests and seam selection are
  derived. Editing only emitted config would leave manifests and generated barrels disagreeing.
- **Test home:** `test/unit/templates.test.ts`, `test/unit/templates/di.test.ts`, and
  `test/e2e/scaffold-runs-e2e.test.ts`.

### 3.3 Mode-aware schematics without a public contract change

- **Decision:** Add an internal generator-mode classifier fed by `SchematicOptions.plugins`; do not
  add a field to the exported `SchematicOptions` interface. Mode-sensitive factories call the
  classifier themselves. Functional `service` emits an exported service function and no decorator
  seam barrel. Class-based `service` emits the existing `@Injectable` class and barrel. The
  controller schematic remains available only in class-based mode and its generated create method
  accepts `@Ctx()` to return a true `201` response.
- **Why:** The existing published schematic contract already carries the source of truth. Widening
  it would expose a duplicate field that custom schematics could omit or contradict.
- **Test home:** `test/unit/generator-mode.test.ts`, `test/unit/schematics/service.test.ts`,
  `test/unit/schematics/controller.test.ts`, and `test/e2e/generate-e2e.test.ts`.

### 3.4 A functional domain aggregate

- **Decision:** Make `generate module` ungated and branch it by generator mode. Functional output is
  a module directory containing a plain data-access function module, a focused function test, and an
  index file, plus a `src/routes/<name>.routes.ts` module that exports `register<Name>Routes`. The
  existing managed routes barrel is regenerated through the route seam, so the new registration
  function is live at application startup. Class-based output preserves the existing
  controller/service classes, `@Inject` constructor seam, and controller/service aggregate arrays.
  The module scanner and module barrel remain the class-based aggregate mechanism; functional
  modules deliberately use the established routes seam instead.
- **Why:** Removing `DecoratorPlugin` without this aggregate would leave the default world unable to
  generate a domain unit. Reusing the route setup call means every functional module is live at
  application startup rather than merely written to disk.
- **Test home:** `test/unit/schematics/module.test.ts`, `test/unit/module-seam.test.ts`,
  `test/unit/utils/module-scanner.test.ts`, `test/unit/generate-module-command.test.ts`, and
  `test/e2e/seam-probe.test.ts`.

### 3.5 Keep contract-shaped artifacts honest

- **Decision:** Preserve the existing representation of schematics whose emitted form is fixed by a
  committed plugin contract: handlers remain implementations of their handler interfaces, health
  indicators remain `IHealthIndicator` implementations, guards and middleware remain
  `MiddlewareFunction` factories, and metrics remain registry helpers. Only application-component
  shapes that have both a functional and an injectable form change by generator mode. Each emitted
  JSDoc block will describe the selected style and no longer advise users to resolve a decorated
  service through the registry when the container owns it.
- **Why:** A class wrapper around a contract that calls for a function would add dead surface rather
  than provide a useful NestJS analogue. The decision preserves substitutability and avoids changing
  package contracts outside M65's scope.
- **Test home:** Existing per-schematic unit suites plus `test/e2e/generate-e2e.test.ts`, which
  type-checks and boots generated artifacts through their real registration paths.

### 3.6 Behavioral proof across both worlds

- **Decision:** Extend the existing real-project test harness to scaffold a functional REST project
  and a `class-based` project, generate the relevant service, route or module artifacts, repoint
  imports at this workspace, type-check them, boot each application, and request its generated
  endpoints. Assert the functional module's `POST` response is `201`; assert the decorated
  controller's `@Ctx()` path also produces `201`.
- **Why:** A source-string assertion cannot prove that seams registered the functional aggregate or
  that a decorator parameter resolver supplied the context at dispatch time.
- **Test home:** `test/e2e/generate-e2e.test.ts`, `test/e2e/seam-probe.test.ts`, and
  `test/e2e/scaffold-runs-e2e.test.ts`.

## 4. Exported surface — every symbol names its consumer

No symbol is added to `packages/cli/src/index.ts`. The style classifier is internal; generated
source and CLI behavior change, and their user-facing contract is documented in `PUBLIC_API.md`.

| Exported symbol | Kind | Consumer / real code path that READS it                                                                                                                           |
| --------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None (checked)  | —    | `packages/cli/src/index.ts` remains unchanged. Existing exported `SchematicOptions.plugins` is read by mode-sensitive schematics through the internal classifier. |

### 4.1 Options — every option names its consumer

| Option                                                            | Consumer                                                              | Behavior (per implementation)                                                                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated manifest imports for `decorator-plugin` and `di-plugin` | `detectPlugins()` in `generate`, then the internal mode classifier    | `decorator-plugin` selects class-based output; without it generation is functional. New scaffolds write the decorator and DI pair only through `class-based`. |
| `--template class-based`                                          | `resolveTemplateChoice()`, `resolveHost()`, and project-file renderer | Adds the decorator and DI pair, the decorator seam inputs, and example classes; makes later generation select the class-oriented mode.                        |
| `SchematicOptions.plugins` (existing)                             | Internal generator-mode classifier                                    | Sole input used by mode-aware service, module, and controller output.                                                                                         |

## 5. Implementation files

| File                             | Purpose                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/templates/choice.ts`        | Remove independent DI selection and describe `class-based` as the single class-style selection.                                                  |
| `src/templates/di.ts`            | Retain one DI wiring constant for class-based composition; remove the feature-appending function that creates a third state.                     |
| `src/templates/registry.ts`      | Simplify template feature data to the one coherent style representation required by rendering.                                                   |
| `src/templates/project-files.ts` | Render the resolved two-world host without the obsolete independent-DI path.                                                                     |
| `src/templates/rest.ts`          | Make REST composition functional and derive only functional seams from it.                                                                       |
| `src/templates/microservice.ts`  | Inherit functional REST composition without reintroducing decorators.                                                                            |
| `src/templates/minimal.ts`       | Keep the no-template host explicitly functional and remove decorator-only compiler assumptions if no emitted file needs them.                    |
| `src/templates/class-based.ts`   | Framework-neutral class-style template; adds the decorator and DI pair to functional REST, retains showcase files, and carries class-mode seams. |
| `src/utils/generator-mode.ts`    | Internal, pure classifier for functional and class-based generation from installed plugins.                                                      |
| `src/commands/generate.ts`       | Pass detected package imports to mode-aware schematics.                                                                                          |
| `src/schematics/registry.ts`     | Remove the decorator-only module gate and centralize which schematic is style-sensitive.                                                         |
| `src/schematics/service.ts`      | Emit exported functions in functional mode and `@Injectable` classes only in class-based mode.                                                   |
| `src/schematics/controller.ts`   | Emit only in class mode and use the committed `@Ctx()` decorator for status-sensitive handlers.                                                  |
| `src/schematics/module.ts`       | Render functional service-and-route files through the established routes seam, or the existing decorated aggregate according to the classifier.  |
| `src/templates/module-seam.ts`   | Keep the class-based decorator aggregate registration coherent with its controller and service barrels.                                          |
| `PUBLIC_API.md`                  | Replace independent decorator and DI guidance with the two-world CLI contract and corrected examples.                                            |
| `packages/cli/README.md`         | Update installation-time guidance, command examples, and style migration notes.                                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                   | src covered                                                                                                                        | Key assertions (and the signature each call type-checks against)                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/templates/choice.test.ts`        | `templates/choice.ts`, `templates/registry.ts`                                                                                     | Default and each named template select one coherent mode; obsolete `--di` is refused or absent from the supported option set.                                                         |
| `test/unit/templates/di.test.ts`            | `templates/di.ts`                                                                                                                  | Class-based composition uses exactly one `DI_WIRING`; no helper can append DI independently.                                                                                          |
| `test/unit/templates.test.ts`               | `templates/rest.ts`, `templates/microservice.ts`, `templates/minimal.ts`, `templates/class-based.ts`, `templates/project-files.ts` | REST, microservice, and minimal contain neither opt-in plugin; `class-based` contains both exactly once; generated manifests match their config imports.                              |
| `test/unit/generator-mode.test.ts`          | `utils/generator-mode.ts`                                                                                                          | The decorator package selects class-based mode; no decorator package, including legacy DI-only configuration, selects functional mode.                                                |
| `test/unit/generate-command.test.ts`        | `commands/generate.ts`, `schematics/registry.ts`                                                                                   | Detected imports are passed through mode-aware schematics and functional modules are no longer plugin-gated.                                                                          |
| `test/unit/schematics/service.test.ts`      | `schematics/service.ts`                                                                                                            | Functional output exports and calls a plain function without decorator imports; class mode emits `@Injectable` and the managed service barrel.                                        |
| `test/unit/schematics/controller.test.ts`   | `schematics/controller.ts`                                                                                                         | Class-mode controller imports `Ctx`, accepts `IRequestContext`, and its create method invokes `ctx.response.status(201)`; functional mode is not admitted as a decorated controller.  |
| `test/unit/schematics/module.test.ts`       | `schematics/module.ts`, `schematics/module-barrel.ts`                                                                              | Functional output contains a function data seam and a route-registration file; class mode retains constructor injection; both output sets match their stated `GeneratedFile[]` paths. |
| `test/unit/module-seam.test.ts`             | `templates/module-seam.ts`                                                                                                         | Class mode supplies decorator controller and service arrays without changing the base DI wiring.                                                                                      |
| `test/unit/generate-module-command.test.ts` | `commands/generate.ts`, module scanner, module schematic                                                                           | Functional modules regenerate the managed routes barrel while class modules regenerate their aggregate; conflict checks remain before writes.                                         |
| `test/e2e/generate-e2e.test.ts`             | generated output across all changed schematic emitters                                                                             | Scaffolds each mode, generates artifacts, type-checks the actual files, boots the application, and proves registration rather than source presence.                                   |
| `test/e2e/seam-probe.test.ts`               | template seams and generated module wiring                                                                                         | Functional module route and class-based module controller both answer requests; write responses demonstrate real `201` behavior.                                                      |
| `test/e2e/scaffold-runs-e2e.test.ts`        | template manifests and generated project files                                                                                     | Both default REST and `class-based` projects format, lint, type-check, boot with their declared permissions, and answer their advertised endpoints.                                   |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m65-functional-default, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Before reporting completion, commit the implementation and additionally run:

```bash
deno task publish:check
deno task release:verify <release-version>
```

Negative controls to observe and revert during implementation:

1. Restore `DecoratorPlugin` to `REST_PLUGINS`; the functional-template composition test must fail.
2. Remove `DiPlugin` from `class-based`; its template-composition test must fail because class-based
   scaffolds always install the pair.
3. Replace the functional module setup call with no registration; the booted functional-module probe
   must return `404`.
4. Remove `@Ctx()` from the decorated write handler; the class-mode behavioral test must fail to
   demonstrate the required `201` response.

## 8. Risks & mitigations

- Existing projects containing only `decorator-plugin` predate the paired template → retain their
  class-based generation, while new scaffolds cannot create that partial configuration.
- Functional module registration could be emitted but never invoked → use the existing route setup
  seam and prove it through a booted application rather than a source assertion.
- Changing the legacy `--di` option may surprise CLI consumers → document the incompatible semantic
  change in `PUBLIC_API.md` and README, preserve no silent no-op, and include the migration in the
  release notes.
- The output matrix spans four runtimes → retain existing runtime e2e coverage and add mode-specific
  probes only where the generated artifacts are executable on that runtime.

## 9. Out of scope

- Adding a new parameter decorator or changing `@Ctx()` resolution belongs to M64 and is complete.
- Supporting a third, decorator-only or DI-only generated style is deliberately excluded: it would
  reintroduce the incoherent spectrum M65 removes.
- Any common, kernel, decorator-plugin, or DI-plugin API change belongs to its owning milestone; M65
  consumes their committed public surfaces only.
