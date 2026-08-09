# Milestone 58 — CLI domain module scaffolding (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m58-domain-module-scaffolding`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

`setu generate` ships 13 single-artifact schematics and no aggregate, so creating a domain module
means `g controller` + `g service` plus a hand edit of `setu.config.ts` to reach
`DecoratorPlugin({ controllers, services })`. This milestone adds `setu g module <name>`, which
emits the controller, the service, their tests, and a per-module barrel under `src/modules/<name>/`,
and regenerates one CLI-owned aggregate barrel at `src/modules/index.ts` that the scaffolded
`setu.config.ts` already imports — so a generated module is wired with no edit to a file the
developer owns. Schematics stay pure: the command layer reads the module directory and hands the
result in, exactly as it already hands in the detected plugin set.

- **In scope:** the `module` schematic (gated on `decorator-plugin`); a `managed` flag on
  `GeneratedFile` so the overwrite check can skip files the CLI declares it owns; a
  `modules: readonly string[]` member on `SchematicOptions`; the `src/modules/index.ts` seam emitted
  by the `rest`, `microservice` and `nest` templates and referenced from their `DecoratorPlugin`
  wiring; e2e coverage that scaffolds a project, generates two modules, and `deno check`s it against
  this workspace; the PUBLIC_API correction the `managed` flag requires.
- **NOT this milestone:** editing `setu.config.ts` in place (rejected in §3.2, not deferred);
  `g module` on the `full-stack` template, whose layering is `routes → features → services` and has
  no `src/modules/` concept — unowned; a `--starter` flag for the other templates, still deferred
  per PUBLIC_API "Not in this release"; removing or changing any of the 13 existing schematics.

## 1. Contracts verified from SOURCE (not names)

| Reference                                    | Source (file:line)                                            | Verified surface / fact                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Schematic`                                  | `packages/cli/src/schematics/registry.ts:55`                  | `(names: DerivedNames, options: SchematicOptions) => readonly GeneratedFile[]` — synchronous, pure, no I/O. An aggregate must therefore return ALL its files from one call. |
| `SchematicOptions`                           | `packages/cli/src/schematics/registry.ts:35`                  | Exactly three members: `runtime`, `plugins: ReadonlySet<string>`, `now: () => number`. `plugins` is the precedent for command-layer-gathered project state.                 |
| `SchematicMetadata`                          | `packages/cli/src/schematics/registry.ts:63`                  | `{ factory, requiresPlugin? }`. Gate is a single package name, checked against the detected set.                                                                            |
| `controller` gate                            | `packages/cli/src/schematics/registry.ts:81`                  | `requiresPlugin: 'decorator-plugin'` — the emitted class imports `@Controller`, so an ungated project gets unresolvable source (the M34b defect).                           |
| `GeneratedFile`                              | `packages/cli/src/utils/file-writer.ts:12`                    | Exactly `{ path, contents }`, both `readonly`. No existing flag of any kind — `managed` is a new field.                                                                     |
| `findExisting`                               | `packages/cli/src/utils/file-writer.ts:93`                    | `stat`s every planned path and returns those that exist. This is the ONLY overwrite check; it takes `readonly GeneratedFile[]`, so it can read a new flag.                  |
| `writeFiles`                                 | `packages/cli/src/utils/file-writer.ts:119`                   | Writes unconditionally, `mkdir -p` per parent. JSDoc states the caller owns the overwrite check — so skipping a file must happen in `findExisting`, not here.               |
| generate overwrite order                     | `packages/cli/src/commands/generate.ts:209`                   | `findExisting` → refuse if non-empty → `writeFiles`. Check-all-then-write-all, one place.                                                                                   |
| generate `--dry-run`                         | `packages/cli/src/commands/generate.ts:204`                   | Prints `would create <path>` from the SAME `files` array the write path uses, before any `stat`. Barrel content must therefore be computed inside the pure call.            |
| `IFileSystem.readdir`                        | `packages/common/src/runtime.ts:91`                           | `readdir(path): Promise<readonly string[]>` — **required**, not optional. Returns entry NAMES only (no file/dir discriminator), so a dir test needs `stat`.                 |
| `IFileSystem.stat` / `StatResult`            | `packages/common/src/runtime.ts:84`, `:31`                    | `StatResult` has `isFile`/`isDirectory`/`size`/`mtime?` — `isDirectory` is how a module dir is told from a stray file.                                                      |
| `DecoratorPluginOptions.controllers`         | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:55` | `readonly controllers?: readonly Constructor[]` — an explicit class list, which is what a barrel can supply.                                                                |
| `DecoratorPluginOptions.services`            | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:57` | `readonly services?: readonly Constructor[]` — same shape, so one barrel exports two arrays.                                                                                |
| `Wiring.args`                                | `packages/cli/src/templates/registry.ts:44`                   | A string rendered verbatim as the argument list. Any identifier it names must be brought into scope by `localImports`; the e2e gate type-checks the result.                 |
| `LocalImport`                                | `packages/cli/src/templates/registry.ts:66`                   | `{ symbols: readonly string[], from: string }`, `from` relative to project root — exactly what importing `./src/modules/index.ts` needs.                                    |
| `TemplateDefinition.localImports` / `.files` | `packages/cli/src/templates/registry.ts:218`, `:225`          | Both optional and already consumed by `nest`; `files` paths must not collide with the fixed set. No contract widening needed for the barrel seam.                           |
| `NEST_PLUGINS` args precedent                | `packages/cli/src/templates/nest.ts:94`                       | Rewrites the `decorator-plugin` wiring's `args` by mapping over `REST_PLUGINS`. The barrel seam uses the identical technique for `rest`/`microservice`.                     |
| `DerivedNames` / `isIdentifierSafe`          | `packages/cli/src/utils/names.ts:10`, `:87`                   | Five casings; `isIdentifierSafe` rejects empty-after-normalization and digit-leading. Applied in `generate` BEFORE the schematic runs, so `module` inherits it.             |
| PUBLIC_API overwrite guarantee               | `PUBLIC_API.md:4936`                                          | States a generate touching ANY existing file writes NOTHING. Literally true today; the `managed` flag narrows it, so this text is a named deliverable (C1).                 |
| `test/e2e/template-e2e.test.ts` hostile set  | `packages/cli/test/e2e/template-e2e.test.ts:37`               | `HOSTILE_NAMES` with an `accepted` flag, swept over ungated schematics at `:204`. `module` is gated, so it needs the scaffold-then-generate path, not this sweep.           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                       | Resolution (picked side)                                                                                                                                                                                  | Doc deliverable (same PR)                                                                                               |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md:4936` promises a generate that would overwrite ANY existing file writes nothing. `g module` must rewrite `src/modules/index.ts` on every run.                                   | Narrow the guarantee to files the schematic does NOT mark `managed`, and state that the CLI owns `src/modules/index.ts`. Chosen over a blanket `--force`, which would weaken it for all 14 schematics.    | Rewrite the PUBLIC_API "Overwrite protection" section; add `module` to the command list and a `Managed files` note.     |
| C2 | The ROADMAP M58 section says "adding a module appends to a generated barrel" without naming who appends — read literally it implies the schematic mutates a file, which `Schematic` cannot do. | The command layer reads `src/modules/`; the schematic receives the names via `SchematicOptions.modules` and returns the whole barrel. Purity is preserved, which is what that section set out to protect. | Correct the ROADMAP M58 paragraph to name the mechanism, and add `SchematicOptions.modules` to its deliverable list.    |
| C3 | `ARCHITECTURE.md:1484` lists the CLI's public API as `runCli, deriveNames, detectPlugins, PROGRAM_NAME` and its Rules row says "schematics are pure functions returning files".                | Both stay true — no new barrel export, and purity is preserved. The Rules row gains the managed-file exception so it does not read as an absolute.                                                        | Amend the `@setu-ts/cli` Rules row with the managed-file exception; Public API row unchanged (verified: no new export). |

## 3. Design decisions

### 3.1 Aggregate shape — one schematic returning every file

- **Decision:** `generateModule` is a single `Schematic` returning five files:
  `src/modules/<kebab>/<kebab>.controller.ts`, `<kebab>.service.ts`, `<kebab>.service.test.ts`,
  `index.ts` (per-module re-export), and `src/modules/index.ts` (the aggregate barrel, `managed`).
  No new phase, no post-write hook, no command-layer special case on the schematic name.
- **Why:** `Schematic` is synchronous and returns the complete file list
  (`schematics/registry.ts:55`), and `--dry-run` prints from that same array before any `stat`
  (`commands/generate.ts:204`). Computing the barrel anywhere else would make the dry run a
  prediction rather than the truth — the exact property M34 built purity to get.
- **Test home:** `test/unit/schematics/module.test.ts` (file set and paths);
  `test/unit/commands/generate-module.test.ts` (dry run prints all five and writes zero).

### 3.2 Wiring mechanism — a CLI-owned aggregate barrel, never an edit to `setu.config.ts`

- **Decision:** `src/modules/index.ts` exports `MODULE_CONTROLLERS` and `MODULE_SERVICES`. The
  `rest`, `microservice` and `nest` templates import both via `localImports` and pass them in the
  `decorator-plugin` wiring's `args`. `setu.config.ts` is never read and never written by
  `generate`.
- **Why:** an AST edit of the developer's config needs a TypeScript parser in a zero-dependency
  package, cannot preserve their formatting or comments, and reintroduces the dry-run problem. The
  barrel is a file the CLI generated in the first place, so rewriting it destroys nothing authored
  by hand. `Wiring.args` + `LocalImport` already express this (`templates/registry.ts:44`, `:66`) —
  the `nest` template does the same thing today for `GreetingController`, so no contract widens.
- **Test home:** `test/unit/templates/module-seam.test.ts` asserts all three templates emit the
  barrel and reference both identifiers; `test/e2e/generate-e2e.test.ts` type-checks the result.

### 3.3 Overwrite exemption — a `managed` flag on `GeneratedFile`, read only by `findExisting`

- **Decision:** `GeneratedFile` gains `readonly managed?: boolean`. `findExisting` skips a file
  whose `managed === true`; every other path keeps the current refusal. `writeFiles` is unchanged.
  The emitted barrel carries a header comment stating the CLI regenerates it.
- **Why:** the alternative — a `--force` flag — would lift the check for all 14 schematics, so a
  mistyped `g service user` could clobber real work. A per-file declaration keeps the blast radius
  to files the CLI names, and `findExisting` is the single existing chokepoint
  (`utils/file-writer.ts:93`), so the exemption cannot be bypassed by a second write path.
- **Test home:** `test/unit/utils/file-writer.test.ts` — an existing managed path is NOT reported
  while an existing unmanaged path beside it IS; `test/unit/commands/generate-module.test.ts` — a
  second `g module` over an existing module refuses on the controller and never reaches the barrel.

### 3.4 How the schematic learns the existing modules — `SchematicOptions.modules`

- **Decision:** `SchematicOptions` gains `readonly modules: readonly string[]` — the kebab names of
  directories directly under `src/modules/`, sorted, gathered by the command layer via
  `fs.readdir` + `fs.stat` (`isDirectory`) before the schematic is called. A missing `src/modules/`
  yields `[]`. `generateModule` unions this with the new name, dedupes, and sorts, so the barrel is
  a deterministic function of its inputs.
- **Why:** it keeps the schematic pure while giving it the project state it needs, which is
  precisely what `plugins: ReadonlySet<string>` already does for gating
  (`schematics/registry.ts:39`). Sorting makes the emitted barrel stable across filesystem
  enumeration order, so a re-run produces a byte-identical file and the diff is empty rather than
  reordered.
- **Test home:** `test/unit/schematics/module.test.ts` — a non-empty `modules` yields a barrel
  listing every module in sorted order and the new one exactly once even when already present;
  `test/unit/commands/generate-module.test.ts` — a `readdir` that throws yields `[]` rather than
  failing the command.

### 3.5 Gate — `requiresPlugin: 'decorator-plugin'`

- **Decision:** `module` is registered with `requiresPlugin: 'decorator-plugin'`.
- **Why:** the emitted controller imports `@Controller`/`@Get`/`@Post`, the identical reason the
  `controller` schematic is gated (`schematics/registry.ts:81`). Ungated, a fresh project would get
  source whose own import cannot resolve — the M34b defect. The `rest` template installs
  `DecoratorPlugin`, so every template that emits the barrel seam satisfies the gate.
- **Test home:** `test/unit/commands/generate-module.test.ts` — exit `1` naming the package when
  `decorator-plugin` is absent, and no file written.

### 3.6 Service registration — `DecoratorPlugin({ services })`, not a DI-container call

- **Decision:** the module's service is an `@Injectable` class listed in `MODULE_SERVICES`, and the
  controller declares its dependency with parameter-level `@Inject('<kebab>-service')`.
- **Why:** it works with AND without `DiPlugin`. `DecoratorPlugin` registers a listed service under
  its `@Injectable` token, falling back to the ServiceRegistry when no container exists (M36b), so
  the same emitted source is correct for `rest` (no DI) and `nest` (DI). An explicit token is
  mandatory because `emitDecoratorMetadata` is absent repo-wide, so the parameter type cannot be
  read — the `nest` template's own comment records this (`templates/nest.ts:50-54`).
- **Test home:** `test/e2e/generate-e2e.test.ts` type-checks a scaffolded `rest` project carrying
  two generated modules, which is the only place the no-DI path is proven to compile.

### 3.7 Emitted test file — one per module, asserting the service

- **Decision:** the module emits `<kebab>.service.test.ts` using `describe`/`it` from
  `@std/testing/bdd` and `expect` from `@std/expect`, asserting the service's one seeded method.
- **Why:** `Deno.test` is banned repo-wide, and a scaffolded project that teaches the banned form
  would propagate it into every consumer. A controller test is deliberately NOT emitted: it would
  need a booted app or a hand-built `IRequestContext`, and a generated test that asserts nothing is
  worse than no test (the M51 `expect(true).toBe(true)` finding).
- **Test home:** `test/unit/schematics/module.test.ts` asserts the emitted source imports
  `@std/testing/bdd` and contains no `Deno.test`.

## 4. Exported surface — every symbol names its consumer

No symbol is added to `packages/cli/src/index.ts`. The milestone's surface is the `module` schematic
name (data in the registry `Map`) plus two widened internal types.

| Exported symbol                  | Kind     | Consumer / real code path that READS it                                                                                                                       |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none added to `src/index.ts`)_ | —        | Verified: `runCli`, `deriveNames`, `detectPlugins`, `PROGRAM_NAME` remain the whole barrel, so `ARCHITECTURE.md:1484` stays correct and no JSR surface moves. |
| `generateModule`                 | function | `REGISTRY` in `schematics/registry.ts` (internal, not barrel-exported — the other 13 factories are the same).                                                 |
| `GeneratedFile.managed`          | field    | `findExisting` (`utils/file-writer.ts`) — the only reader, and the only place the overwrite decision is made.                                                 |
| `SchematicOptions.modules`       | field    | `generateModule` builds the barrel from it; `runGenerateCommand` populates it. Two real readers, neither a test.                                              |
| `renderModuleBarrel`             | function | `generateModule` (internal to `schematics/module-barrel.ts`) — extracted so the barrel text is unit-testable apart from the five-file assembly.               |
| `readModuleNames`                | function | `runGenerateCommand` (internal to `utils/module-scanner.ts`) — the `readdir`+`stat` seam, extracted so its throw/empty branches are unit-testable.            |

### 4.1 Options — every option names its consumer

| Option                     | Consumer                         | Behavior (per implementation)                                                                                                                                                            |
| -------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SchematicOptions.modules` | `generateModule` only            | Existing module names. Read by `generateModule` to render the aggregate barrel; ignored by the other 13, exactly as `now` is read only by `migration` and `plugins` only by gated ones.  |
| `GeneratedFile.managed`    | `findExisting`                   | `true` → the path is exempt from the overwrite refusal and will be rewritten. Omitted/`false` → current behavior, byte-identical.                                                        |
| `--dry-run` (existing)     | `runGenerateCommand`             | Unchanged: prints all five planned paths including the barrel, and performs zero reads-for-write and zero writes. The `readdir` scan still runs, since the barrel content depends on it. |
| `--dir` (existing)         | `resolveDir` → `readModuleNames` | The module scan is rooted at the resolved dir, so `--dir` cannot make the scan and the write disagree (the M34 relative-`--dir` defect class).                                           |

## 5. Implementation files

| File                              | Purpose                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                    | Unchanged — no new export (see §4).                                                                               |
| `src/schematics/module.ts`        | `generateModule`: assembles the five files from `names` + `options.modules`.                                      |
| `src/schematics/module-barrel.ts` | `renderModuleBarrel(moduleNames)`: the pure barrel text, including the CLI-owns-this header.                      |
| `src/schematics/registry.ts`      | Register `module` with its gate; add `modules` to `SchematicOptions`.                                             |
| `src/utils/module-scanner.ts`     | `readModuleNames(fs, dir)`: `readdir` + `stat` filter to directory names, sorted; `[]` when absent or unreadable. |
| `src/utils/file-writer.ts`        | Add `GeneratedFile.managed`; `findExisting` skips managed paths.                                                  |
| `src/commands/generate.ts`        | Call `readModuleNames` and pass `modules` in `SchematicOptions`.                                                  |
| `src/templates/module-seam.ts`    | The shared barrel seam: the initial empty `src/modules/index.ts` file plus the `LocalImport` the templates reuse. |
| `src/templates/rest.ts`           | `decorator-plugin` wiring gains `args` naming both barrel arrays; `localImports` + `files` gain the seam.         |
| `src/templates/nest.ts`           | Its existing `args` extended to spread both barrel arrays alongside `GreetingController`/`GreetingService`.       |
| `src/templates/microservice.ts`   | Inherits the seam through `REST_PLUGINS`/`REST_MIDDLEWARE` — verified no local override of the decorator wiring.  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                      | src covered                                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/schematics/module.test.ts`          | `schematics/module.ts`                           | `generateModule(deriveNames('user-profile'), opts)` → exactly five paths as in §3.1; the new name appears once when already in `opts.modules`; emitted test imports `@std/testing/bdd` and contains no `Deno.test`; only `src/modules/index.ts` is `managed`. Typed against `Schematic` (`registry.ts:55`). |
| `test/unit/schematics/module-barrel.test.ts`   | `schematics/module-barrel.ts`                    | `renderModuleBarrel(['order','user'])` emits both imports and both arrays in sorted order; `renderModuleBarrel([])` emits two empty arrays that still type-check; output is byte-identical across two calls with reordered input.                                                                           |
| `test/unit/utils/module-scanner.test.ts`       | `utils/module-scanner.ts`                        | Directories returned sorted; a FILE under `src/modules/` excluded (drives the `isDirectory` branch); `readdir` rejecting → `[]`; `stat` rejecting for one entry → that entry excluded, others kept.                                                                                                         |
| `test/unit/utils/file-writer.test.ts` (extend) | `utils/file-writer.ts`                           | Existing-managed path NOT reported by `findExisting` while an existing unmanaged path in the same array IS; `writeFiles` still writes both. Verified to fail without the `managed` skip.                                                                                                                    |
| `test/unit/commands/generate-module.test.ts`   | `commands/generate.ts` (module path)             | `--dry-run` prints five `would create` lines and performs zero writes; absent `decorator-plugin` → exit `1` naming the package, zero writes; a second `g module user` refuses on the controller; `readdir` throwing still succeeds; `--dir` roots the scan.                                                 |
| `test/unit/templates/module-seam.test.ts`      | `templates/module-seam.ts`, `rest.ts`, `nest.ts` | All three of `rest`/`microservice`/`nest` carry the seam file and a `LocalImport` for it, and their `decorator-plugin` `args` name both arrays; `full-stack` carries NEITHER (pins §0's exclusion); `nest` still names `GreetingController`.                                                                |
| `test/e2e/generate-e2e.test.ts` (extend)       | the whole path, against a real `deno check`      | Scaffold `--template rest`, repoint imports at THIS workspace, `g module user` then `g module order-item`, `deno check` the project: the barrel lists both, `setu.config.ts` resolves both identifiers, and the controllers compile with no DI. Then the same on `--template nest` (DI present).            |

Negative controls to run and report (each observed failing, then reverted): remove the `managed`
skip in `findExisting` → the second `g module` must fail; break one identifier in the `rest` `args`
string → the e2e `deno check` must fail (the M50b trap: `args` is a rendered string invisible to the
CLI's own type-check); drop the sort in `renderModuleBarrel` → the byte-identical assertion must
fail.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m58-domain-module-scaffolding, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on a COMMITTED tree — packages/cli changes, so both publish gates run
deno task release:verify 0.1.0-alpha.4
```

## 8. Risks & mitigations

- **The `args` string is invisible to the CLI's own `deno check`** (the M50b finding) → a wrong
  identifier in the `rest`/`nest` wiring is a compile error only in the GENERATED project. Mitigated
  by the e2e gate type-checking a scaffolded project, and by the negative control above that breaks
  the string deliberately and confirms the gate fails.
- **A pre-M58 project has no barrel import in its `setu.config.ts`**, so a generated module would
  sit unwired with no diagnostic → the emitted barrel header states what to add, the PUBLIC_API
  "Managed files" note documents the two lines, and the templates emit the seam from scaffold time
  so every NEW project is wired. Detecting it by reading the developer's config is deliberately not
  done: that is the read §3.2 exists to avoid.
- **`readdir` on `src/modules/` runs for every `generate` invocation**, including the 13 that ignore
  `modules` → one extra syscall on a path that usually does not exist; `detectPlugins` already reads
  the manifest unconditionally at `commands/generate.ts:100`, so this matches existing cost and is
  covered by the throwing-`readdir` test rather than guarded by a schematic-name special case.
- **The barrel becomes a merge-conflict hotspot** on a team generating modules in parallel → sorted,
  one import pair and one array entry per module, so conflicts are line-local and resolvable by
  taking both sides; a re-run of `g module` on any existing module regenerates it correctly.

## 9. Out of scope

- **Editing `setu.config.ts`** — rejected in §3.2 with cause, not deferred. Unowned by design.
- **`g module` for `--template full-stack`** — its `routes → features → services` layering (M36c)
  has no `src/modules/`; a modules barrel there would contradict the skeleton the CLI already emits.
  Unowned.
- **A `--starter` flag for `rest`/`microservice`/`nest`** — still deferred per PUBLIC_API "Not in
  this release"; unrelated to this seam.
- **Removing `g controller` / `g service`** — `g module` composes their output shape; both remain,
  and §0 pins that no existing schematic changes.
- **Runtime filesystem discovery of controllers** (`autoDiscover` + `controllersPath`) as the wiring
  mechanism — rejected: `DecoratorPluginOptions.autoDiscover` logs discovery failures as warnings
  and never crashes (`decorator-plugin.ts:47-50`), and Workers has no `runtime.fs`, so modules would
  silently fail to register on one of the four supported targets. Unowned.
