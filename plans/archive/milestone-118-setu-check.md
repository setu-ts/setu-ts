# Milestone 118 — `setu check` and `setu sync`: a wiring gate for generated projects (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m118-setu-check`. `main` and `develop` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A scaffolded project gets a read-only command, `setu check`, that exits `1` when code in a CLI-owned
seam directory is not registered: an artifact a barrel does not list, a barrel `setu.config.ts` does
not reference, an artifact registered both by its barrel and by hand, a candidate the scan refuses,
or a legacy layout still in use. This is the M60/M65 defect class (code that compiles and never
runs), which `tsc` cannot see. The detection `setu generate` already runs is extracted into one
owner, `diagnoseProject`, which both commands render. Generated projects run the command from their
`check` script. Its write-side partner, `setu sync`, re-renders every CLI-managed barrel from the
directory scan, so drift has a command that fixes it rather than a hand edit to a file the CLI owns.
Every finding carries a stable id, and a project can silence an id, optionally for one file, in
`.setu-ts/check.json`.

The three additions beyond the ROADMAP text (`setu sync`, finding ids, silencing) come from a
comparison with established tools, made at plan time on 2026-10-26 and adopted by the maintainer the
same day:

| Tool (docs read 2026-10-26)      | What it does                                                                                                                                         | What M118 takes from it                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Django `manage.py check`         | System checks; fails at `ERROR` by default, `--fail-level` lowers it; every message has an id (`models.W042`) and `SILENCED_SYSTEM_CHECKS` drops ids | Default fails on errors only, `--strict`; stable ids; silence |
| ESLint CLI                       | Exit `0` clean, `1` findings, `2` usage or config failure; `--max-warnings`; rule ids; `--fix`                                                       | The `0`/`1`/`2` exit codes                                    |
| Nx `nx sync:check` / `nx sync`   | `sync:check` runs sync generators in dry-run and fails CI on drift in generated files; `nx sync` applies the fix                                     | Read-only `check` paired with a writer, `sync`                |
| Rails `bin/rails zeitwerk:check` | Fails when a file's name does not match the constant it defines                                                                                      | A file breaking the seam convention is an error (§2 C1)       |

- **In scope:** `packages/cli` — `diagnoseProject` extracted from `runGenerateCommand`;
  `setu check [--dir <path>] [--strict]` for standalone projects, workspace members and workspace
  roots; barrel drift detection that compares name sets; config wiring for every barrel on disk,
  with three outcomes; stable finding ids and `.setu-ts/check.json` silencing;
  `setu sync [--dir <path>] [--dry-run]`; `@setu-ts/cli` as a generated devDependency (npm
  manifests) and in every generated `check` script or task (Node, Bun, Deno, Workers, every
  template, workspace members); `setu devtool enable` accepting the new scaffold `check` task; docs
  (`docs/cli.md`, `packages/cli/README.md`, the `PUBLIC_API.md` CLI commands section,
  `CHANGELOG.md`, `docs/upgrading.md`); ROADMAP and CLAUDE.md status.
- **NOT this milestone:**
  - Running `setu check` from a production `build` script and the Docker build stage — **M120**.
  - DI graph validation (missing provider, cycle, captive scoped dependency) — it stays at boot,
    inside `di-plugin`, where **M125** put it (`DiContainer.close()` from `DiPlugin`'s `onBootstrap`
    hook). `setu check` neither boots the application nor re-implements that graph (maintainer
    decision, 2026-10-26). Typed tokens from M125 are already enforced by the `tsc --noEmit` /
    `deno check` half of the same `check` script.
  - The M116 agent brief (`setu agents --check`) — stays its own command (§3.11).
  - Custom schematics and code outside seam directories (ROADMAP "Scope").

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                             | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runGenerateCommand` scan-and-report block | `packages/cli/src/commands/generate.ts:378-495`, `:631-641`                    | Module scan + rejected/skipped reports (`:398-415`), `scanArtifacts(deps.fs, dir, scanSeamSpecs(installed))` or `scanModuleArtifacts` under functional `--module` (`:422-425`), skipped (`:432-462`), manual (`:468-478`), legacy layout (`:486-488`), legacy registrar (`:493-495`), adoptions and unwired after write (`:631-641`). All via `deps.error`; exit code untouched. |
| `reportUnwiredSeams`                       | `generate.ts:791-845`                                                          | Filters to barrels written THIS run (`:798`, `:804`); symbol per barrel from `decoratorExportFor`/`decoratorKeyFor` or `QUEUE_PROCESSORS`; plus functional `registerModules`. Masked config, imports NOT stripped; `maskSourceCode` `undefined` → reported (fails toward reporting). Empty config → silent.                                                                      |
| `reportInactiveModule`                     | `generate.ts:718-769`                                                          | Activation read from `src/modules/index.ts` via `activatesModule` over masked, import-stripped code; then config references `MODULES` / `registerModules`. Only on a `--module` run.                                                                                                                                                                                             |
| `scanArtifacts` / `readArtifactNames`      | `packages/cli/src/utils/artifact-scanner.ts:210-332`                           | Returns `{ artifacts, skipped, adopted, manual }`. Admission: suffix, regular file ≤ `MAX_EXISTING_FILE_BYTES`, exports every `importSymbols`. `manual` and `adopted` only for specs with non-empty `exports`. `adopted` = admitted and no import symbol mentioned anywhere in the barrel text.                                                                                  |
| `MAX_EXISTING_FILE_BYTES`                  | `packages/cli/src/utils/file-writer.ts:425`                                    | `1024 * 1024`.                                                                                                                                                                                                                                                                                                                                                                   |
| `readConfigModule`                         | `packages/cli/src/utils/legacy-layout.ts:90-96`                                | Reads `setu.config.ts` with NO stat and NO size cap; `''` on failure. `readProjectWiring` (`artifact-scanner.ts:150-156`) reads the same file capped.                                                                                                                                                                                                                            |
| `SeamSpec`                                 | `packages/cli/src/seams/seam-spec.ts`                                          | `schematic`, `dir`, `suffix`, `importSymbols(names)`, `barrel`, `exports`, `requiresPlugin?`, `renderBarrel`. Barrel imports are `renderImport(symbols, './<kebab><suffix>')` (`renderSeamImports`, `:289-296`); the functional services barrel uses `export { … } from './<kebab>.service.ts'` (`seams/services.ts:151`). Two specs share `src/cqrs/index.ts`.                  |
| `scanSeamSpecs` / `hostSeamSpecs`          | `packages/cli/src/seams/registry.ts:131-185`                                   | Scan: mode-shaped, jobs only when functional and `queue-plugin` installed. Host: drops cqrs/events/jobs in class-based and any spec whose `requiresPlugin` is absent. `templates/seam.ts` `seamLocalImports` imports every `spec.exports` symbol of each host barrel into `setu.config.ts`.                                                                                      |
| Workers jobs                               | `packages/cli/src/templates/microservice.ts:113-114`                           | `WORKERS_SWAP.removePackages` includes `queue-plugin`, so `scanSeamSpecs` already excludes the jobs family on Workers. No new branch needed.                                                                                                                                                                                                                                     |
| `scanModules` / `scanModuleArtifacts`      | `packages/cli/src/utils/module-scanner.ts:104-215`                             | `{ names, skipped (legacy, missing-export), rejected }`; module-internal functional controllers/routes barrel at `src/modules/<m>/index.ts`.                                                                                                                                                                                                                                     |
| `maskSourceCode` / `maskComments`          | `packages/cli/src/devtool/sources.ts:110`, `:122`                              | Both `undefined` for source outside the restricted lexer language; `maskComments` keeps string literals.                                                                                                                                                                                                                                                                         |
| `composingStarter`                         | `packages/cli/src/utils/starter-arms.ts:86-89`                                 | Returns the starter arm a config imports, for the "merge into its decorators arm" remedy.                                                                                                                                                                                                                                                                                        |
| Dispatcher                                 | `packages/cli/src/cli.ts:159-310`                                              | Built-ins match first in a `switch`; `default` → `dispatchPluginCommand`. Flag/positional refusal via `builtInFlagRefusal`/`builtInPositionalRefusal` from `commandFlagsFor` (`flags.ts:280-310`); help inventory `DOCUMENTED_FLAGS` (`flags.ts:317`).                                                                                                                           |
| `setu agents --check` workspace walk       | `packages/cli/src/commands/agents.ts`                                          | Walks up for a workspace manifest; checks root + every `apps/<member>`. `detectProject` (`utils/project-detector.ts:16-65`) returns `project` / `workspace-root` / `none` / `unreadable`.                                                                                                                                                                                        |
| Plugin commands named `check`              | `grep -rn "cli.register" packages/*/src`                                       | No first-party plugin registers any CLI command; the documented convention is `plugin:command` (`common/src/plugin.ts:301`).                                                                                                                                                                                                                                                     |
| Framework pin                              | `packages/cli/src/templates/framework-specifier.ts`                            | `FRAMEWORK_RANGE = ^${VERSION}`; `frameworkSpecifier(pkg, 'npm')` → `^V`, `'deno'` → `npm:@setu-ts/<pkg>@^V`.                                                                                                                                                                                                                                                                    |
| npm `check` scripts                        | `templates/npm-tooling.ts:31-36`; `templates/project-files.ts:1771-1786`       | `NPM_TOOLING_SCRIPTS.check = 'tsc --noEmit'` (Node, Bun and Workers). Workers with an npm build overrides `check: 'npm run build && tsc --noEmit'`. Node/Bun devDependencies at `project-files.ts:2140-2146`; Workers at `:1763-1769`.                                                                                                                                           |
| Deno tasks                                 | `templates/project-files.ts:1227-1287`, `:1309-1316`                           | `denoTasks` emits NO `check` task. Only `devtoolTasks().check = deno check main.ts setu.config.ts main.dev.ts`. Full-stack adds `check:app` (`full-stack-build-files.ts:321`).                                                                                                                                                                                                   |
| `setu devtool enable` task merge           | `packages/cli/src/commands/devtool.ts:239-252`, `:530`, `:822`                 | `mergeTask`: absent → add; byte-identical → no-op; different → REFUSE by name.                                                                                                                                                                                                                                                                                                   |
| CLI bin                                    | `packages/cli/package.json` `"bin": { "setu": "./dist/bin.js" }`               | npm scripts reach it as `setu` from `node_modules/.bin`. Dependencies: `@setu-ts/common`, `@setu-ts/runtime`, `prettier`, `tsx`.                                                                                                                                                                                                                                                 |
| Generated CI workflow                      | `grep -rn workflows packages/cli/src` (empty)                                  | The CLI generates no CI workflow, so the ROADMAP's "and CI, where generated" has no site.                                                                                                                                                                                                                                                                                        |
| Scaffold e2e registry                      | `packages/cli/test/fixtures/node-project.ts:31`; `scripts/pack-members.ts:191` | The overlay serves every `PUBLISHED_PACKAGES` pack, `packages/cli` included, so a scaffold depending on `@setu-ts/cli@^V` installs the tree's own CLI.                                                                                                                                                                                                                           |
| `node-scaffold-e2e` hosts                  | `packages/cli/test/e2e/node-scaffold-e2e.test.ts:42-50`, `:182-190`            | Every host (no-template, rest, microservice, class-based, full-stack, microservice class-based, rest on Workers) runs `npm run check` after install, so every fresh scaffold exercises the new script.                                                                                                                                                                           |
| External: Deno running a pinned CLI        | probe, 2026-10-26, Deno 2.9.6, published `0.10.0`                              | `deno run -A npm:@setu-ts/cli@^0.10.0 --version` from a task prints `setu 0.10.0` and records the resolution in `deno.lock`.                                                                                                                                                                                                                                                     |
| External: Bun without Node                 | probe, 2026-10-26, Bun 1.4.2, `PATH` holding only `bun`                        | `bun run c` with `"c": "setu --version"` and `@setu-ts/cli` in devDependencies prints `setu 0.10.0`; the `#!/usr/bin/env node` bin runs under Bun.                                                                                                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                                                                                                                                                                                                               | Doc deliverable (same PR)                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| C1  | ROADMAP "Severity" makes "adoption of a hand-written file that matches a family's naming convention" a WARNING, while its gap 2 and its e2e deliverable make the same hand-copied file an ERROR (exit `1`). | `check` writes nothing, so it adopts nothing: a file the scan admits and the barrel does not import is **drift, an error**. "Adopted" stays a `generate`-only notice, printed when a write actually adopts. The warning row is read as `generate`'s report, unchanged.                                                                 | ROADMAP M118 "Severity" bullet corrected in this PR.                         |
| C2  | ROADMAP: "Adopted projects … get the script through `setu add` or an upgrade-guide entry". `setu add` installs a package and has no script-editing path.                                                    | Upgrade-guide entry only; `setu add` is unchanged. "Nothing rewrites a developer's existing script" is kept exactly.                                                                                                                                                                                                                   | ROADMAP M118 "Adopted projects" bullet corrected; `docs/upgrading.md` entry. |
| C3  | ROADMAP: "a generated CI workflow (if one exists) runs that script". The CLI generates none (§1).                                                                                                           | No CI deliverable. The docs show the one line a project's own CI adds (`npm run check` / `deno task check`).                                                                                                                                                                                                                           | ROADMAP M118 deliverable reworded; `docs/cli.md`.                            |
| C5  | The ROADMAP M118 section has no `setu sync`, no finding ids and no silencing.                                                                                                                               | Added by maintainer decision, 2026-10-26, after the framework comparison in §0. `check` stays read-only; `sync` is a separate verb.                                                                                                                                                                                                    | ROADMAP M118 section and deliverables updated in this PR.                    |
| C4  | ROADMAP "Read-only, with the scanner's existing read limits", while `readConfigModule` reads `setu.config.ts` uncapped (§1).                                                                                | `diagnoseProject` reads the config once through the capped reader (`readProjectWiring`). A config over 1 MiB, or not a regular file, is treated as unreadable; `generate` then prints nothing for it, where before it read the whole file. This is the only intended change to `generate`'s output, and it applies only to that input. | CHANGELOG line.                                                              |

## 3. Design decisions

### 3.1 One owner: `diagnoseProject`

- **Decision:** New internal module `packages/cli/src/diagnostics/diagnose.ts` exporting
  `diagnoseProject(fs, dir, installed, options?: { module?: string }): Promise<ProjectDiagnosis>`.
  It performs every READ the scan-and-report block performs today — `generatorMode`, `scanModules`,
  `scanArtifacts(scanSeamSpecs(installed))` (or `scanModuleArtifacts` for a functional `--module`,
  exactly as `generate.ts:422-425`), `readLegacyHttpFiles`, the capped config read (§2 C4), every
  barrel on disk — and returns typed findings. It writes nothing and prints nothing.
  `ProjectDiagnosis` carries the raw scan values `generate` still needs (`artifacts`, `modules`,
  `legacyModules`, `adopted`), plus `findings: readonly Finding[]`. `Finding` is a discriminated
  union keyed by `kind`:

  | `kind`                 | Fields                                                                            | Produced from                                     |
  | ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
  | `module-rejected`      | `path`                                                                            | `moduleScan.rejected`                             |
  | `module-skipped`       | `path`, `missing`, `legacy: boolean`, `mode`                                      | `moduleScan.skipped`                              |
  | `artifact-invalid`     | `path`                                                                            | `scan.skipped` with `invalidName`                 |
  | `artifact-skipped`     | `path`, `missing`                                                                 | `scan.skipped`                                    |
  | `manual-registration`  | `path`, `symbol`, `wiredIn`                                                       | `scan.manual`                                     |
  | `legacy-layout`        | `files`                                                                           | `readLegacyHttpFiles`                             |
  | `legacy-registrar`     | (none)                                                                            | `legacyRegistrarNotice`                           |
  | `barrel-drift`         | `barrel`, `unlisted: string[]`, `stale: string[]`                                 | §3.3                                              |
  | `barrel-unreadable`    | `barrel`, `reason: 'not-a-file' \| 'too-large' \| 'unclassifiable'`               | §3.3                                              |
  | `unwired`              | `barrel`, `symbols`, `site`, `outcome: 'unwired' \| 'unclassifiable'`, `starter?` | §3.4                                              |
  | `module-inactive`      | `module`, `symbol`, `mode`                                                        | §3.5                                              |
  | `no-config`            | `barrels`                                                                         | §3.4                                              |
  | `check-config-invalid` | `path`, `entry`                                                                   | §3.16 (from `readSilence`, not `diagnoseProject`) |
  | `silence-unmatched`    | `entry`                                                                           | §3.16 (from `readSilence`, not `diagnoseProject`) |

  `generate.ts` calls `diagnoseProject` once where it scans today and renders findings through
  `renderGenerateFindings` (same module), which emits the exact lines and order `generate` prints
  today. It renders `barrel-drift`, `barrel-unreadable`, `no-config` and the all-barrel `unwired`
  findings only where today's code would (`unwired` only for barrels written this run and only for
  today's three sites, `module-inactive` only on a `--module` run). Adoptions keep their current
  path (`scan.adopted` filtered by the plan, `generate.ts:578-580`). `check` renders every finding
  through `renderCheckFindings` (§3.8).

- **Why:** ROADMAP "One owner". Two copies would drift, which is how M65's regenerate loop happened.
- **Test home:** `test/unit/generate-stderr-golden.test.ts` (written and run green against the
  UNCHANGED `generate.ts` before the refactor, then kept green: the pin);
  `test/unit/diagnose.test.ts`.

### 3.2 Finding ids — one table, which also decides severity

- **Decision:** `diagnostics/ids.ts` exports `FINDING_IDS`, mapping each finding to a stable id
  whose letter IS its severity (Django's form, `<namespace>.<E|W><nnn>`). The table is the single
  source: the renderer prints the id, the exit code reads the letter, and the test iterates it.

  | Id          | Finding                                          | Why this severity                                                         |
  | ----------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
  | `setu.E001` | `artifact-skipped` (missing export)              | Nothing registers the file                                                |
  | `setu.E002` | `artifact-invalid` (name not a kebab identifier) | Nothing registers the file                                                |
  | `setu.E003` | `barrel-drift`                                   | §2 C1                                                                     |
  | `setu.E004` | `barrel-unreadable`                              | The barrel cannot be checked, so the gate cannot pass it                  |
  | `setu.E005` | `manual-registration`                            | The kernel refuses the duplicate at boot (M68)                            |
  | `setu.E006` | `unwired`, `outcome: 'unwired'`                  | Gap 3                                                                     |
  | `setu.E007` | `module-skipped`                                 | Nothing activates the module                                              |
  | `setu.E008` | `module-rejected`                                | Nothing activates the module                                              |
  | `setu.E009` | `module-inactive`                                | Its routes are unreachable                                                |
  | `setu.E010` | `legacy-layout`                                  | ROADMAP "a legacy layout still in use"                                    |
  | `setu.E011` | `check-config-invalid` (§3.16)                   | A broken silence file must not quietly silence nothing or everything      |
  | `setu.W001` | `unwired`, `outcome: 'unclassifiable'`           | ROADMAP "Three outcomes"                                                  |
  | `setu.W002` | `no-config`                                      | `setu adopt` projects can wire elsewhere                                  |
  | `setu.W003` | `legacy-registrar`                               | The pre-M84 call compiles; only an SSE controller fails, at startup       |
  | `setu.W004` | `silence-unmatched` (§3.16)                      | A stale silence entry hides nothing today but would hide a future finding |

  Ids are append-only: a retired check keeps its number unused, so a silence list never starts
  matching a different check. `--strict` treats every `W` as an `E` for the exit code and summary.

- **Why:** ROADMAP "Severity", with C1 applied; ids per the §0 comparison. A table the test iterates
  cannot drift from the renderer (the CLAUDE.md "a set belongs in the test as data" rule).
- **Test home:** `test/unit/check-command.test.ts` iterates `FINDING_IDS` with one fixture per id
  and asserts the printed id and the exit code, with and without `--strict`;
  `test/unit/finding-ids.test.ts` asserts every `Finding` kind and outcome has exactly one id, ids
  are unique, and the letter matches the documented severity.

### 3.3 Barrel drift compares name sets parsed from import declarations

- **Decision:** For each distinct `barrel` among `scanSeamSpecs(installed)` whose specs have
  non-empty `exports` (registration barrels only — the functional services barrel registers nothing,
  and `artifact-scanner.ts` applies the same rule to `manual`/`adopted`), and for each functional
  feature module's internal barrel:
  1. Absent barrel: if the scan admitted any artifact for its specs →
     `barrel-drift { unlisted: <all>, stale: [] }`; otherwise no finding.
  2. Not a regular file → `barrel-unreadable 'not-a-file'`; over `MAX_EXISTING_FILE_BYTES` →
     `'too-large'`; `maskComments` returns `undefined` → `'unclassifiable'`.
  3. Otherwise collect every `import … from '<spec>'` and `export … from '<spec>'` declaration in
     the comment-masked text, in single or double quotes, with a specifier list that may span lines.
     A specifier `./<base>` names an artifact of spec S when `<base>` ends with `S.suffix` and the
     remainder is non-empty. `listed(S)` = those remainders.
  4. `unlisted` = `admitted(S) − listed(S)`; `stale` = `listed(S) − admitted(S)` (a listed artifact
     the scan did not admit, whether deleted or skipped). A non-empty side → `barrel-drift`, the two
     specs of a shared barrel merged into one finding, names sorted.

  Byte layout, import order, wrapping and quote style never matter: only the sets are compared. A
  `stale` name that also has an `artifact-skipped` finding is still listed: the barrel is wrong in
  both cases, and naming both is how a reader sees why.

- **Why:** ROADMAP "Compare name sets, not bytes". Barrels are formatted with the project's own
  Prettier config (M111d).
- **Test home:** `test/unit/barrel-drift.test.ts` (reformatted barrel — double quotes, one specifier
  per line, reordered — passes; a hand-copied artifact → `unlisted`; a removed import → `unlisted`;
  a deleted artifact → `stale`; the shared CQRS barrel; an absent barrel with and without artifacts;
  each `barrel-unreadable` reason; the functional services barrel never reports).

### 3.4 Config wiring for every barrel on disk, with three outcomes

- **Decision:** One classifier
  `classifyWiring(config: string, symbol): 'wired' | 'unwired' | 'unclassifiable'` in
  `diagnostics/wiring.ts`, over `maskSourceCode(config)` with imports NOT stripped — today's
  `reportUnwiredSeams` rule, so `generate` stays byte-identical (an imported but unused binding is
  caught by the project's own lint). For `check`, the barrels considered are those of
  `hostSeamSpecs(installed)` that exist on disk, and the symbols are each spec's `exports` — the set
  `seamLocalImports` writes into a scaffolded config. Plus `registerModules` (functional) or
  `MODULES` (class-based) when `src/modules/index.ts` exists. Per barrel: every symbol `wired` → no
  finding; any `unwired` with a classifiable config → `unwired { outcome: 'unwired' }` (error);
  `maskSourceCode` `undefined` → `unwired { outcome: 'unclassifiable' }` (warning), naming the
  import line to check. An absent or unreadable config with barrels on disk → one `no-config`
  warning (`setu adopt` projects can wire elsewhere). `generate` keeps its narrower set (barrels
  written this run, today's three symbol sites) by filtering in `renderGenerateFindings`.
- **Why:** ROADMAP "Three outcomes for config wiring" and gap 3. A gate that fails on hand-edited
  configs it cannot classify gets switched off.
- **Test home:** `test/unit/check-wiring.test.ts` (each outcome; a starter-composed config prints
  the decorators-arm remedy; absent config).

### 3.5 Feature modules

- **Decision:** For every admitted module, `diagnoseProject` applies `reportInactiveModule`'s
  activation rule (`activatesModule` over masked, import-stripped `src/modules/index.ts`), moved
  verbatim into `diagnostics/modules.ts`. A module not activated → `module-inactive` (error). The
  config half of that function is the `registerModules` / `MODULES` wiring in §3.4. `generate`
  renders `module-inactive` only for its `--module` target, with today's text.
- **Why:** An inactive module's routes are unreachable — the same defect class.
- **Test home:** `test/unit/diagnose.test.ts` (inactive in each mode); the existing
  `generate-inactive-module.test.ts` stays green unchanged.

### 3.6 Scope: project, workspace member, workspace root

- **Decision:** `setu check` resolves `--dir` (default CWD) through `detectProject`:
  - `project` → check that directory only;
  - `workspace-root` → read the workspace manifest and check every `apps/<member>` in manifest
    order, prefixing each output line with `<member>: `. The exit code is the worst across members.
    A member directory that is missing or not a project is an error naming it;
  - `none` → the exact `generate` message (`generate.ts:296-300`), exit `1`;
  - `unreadable` → `Cannot read <path>: <reason>`, exit `1`.

  A member directory checked directly does NOT walk up to its workspace (unlike `setu agents`): the
  member is the project, and its own `check` script runs it there. When no barrel exists, no seam
  directory exists and `src/modules/` is absent (full-stack, or a project that has never generated
  anything), it logs `No CLI-owned seams in <dir>; nothing to check.` and exits `0`.

- **Why:** ROADMAP "Scope"; full-stack passes and says so rather than printing an empty success.
- **Test home:** `test/unit/check-command.test.ts`; `test/e2e/check-e2e.test.ts` (workspace).

### 3.7 Read-only

- **Decision:** `check` reads only through `diagnoseProject`, whose every file read goes through a
  stat-first, regular-file, `MAX_EXISTING_FILE_BYTES`-capped reader. It never calls `writeFiles`,
  `formatForTarget` or the ownership/symlink write refusals.
- **Why:** ROADMAP "Read-only".
- **Test home:** `check-command.test.ts` drives a recording fake filesystem and asserts no
  `writeFile`/`mkdir`/`remove` call; a `/dev/zero`-style non-regular barrel reports `not-a-file` and
  returns.

### 3.8 Output and exit codes

- **Decision:** Each finding prints to the error sink as `error setu.E003: <message>` or
  `warning setu.W001: <message>`, followed by its remedy lines indented two spaces — the same remedy
  wording `generate` uses, where it has one. A `barrel-drift` finding's remedy is `Run \`setu sync\`
  to rewrite <barrel> from
  <dir>.`followed by the unlisted and stale names. Order: sorted by the finding's primary path, then by kind. The final line goes to the log sink:`setu
  check: <E> error(s), <W> warning(s), <S> silenced in
  <dir>.`(with`--strict`the warnings are counted as errors). Exit`0`with no errors,`1`with any error,`2`
  on a usage error. Plain lines only (§3.12).
- **Why:** ROADMAP "Severity"; a CI log reader needs the file name on the failing line.
- **Test home:** `check-command.test.ts` (exact lines for one fixture of each kind).

### 3.9 The `check` and `sync` verbs

- **Decision:** `check` and `sync` are built-in verbs (`case 'check'`, `case 'sync'` in `cli.ts`),
  flag specs `spec('check', ['dir', 'strict'], [], { fixed: 1, taken: 0, noun: 'no arguments' })`
  and `spec('sync', ['dir', 'dry-run'], [], { fixed: 1, taken: 0, noun: 'no arguments' })` in
  `flags.ts`, both added to `DOCUMENTED_FLAGS`, `--help` text and the top-level help. A plugin that
  registers a `check` or `sync` command loses it to the built-in; this is accepted with a CHANGELOG
  note. No first-party plugin registers commands, and the documented convention is `plugin:command`.
- **Why:** ROADMAP "The `check` verb shadows a plugin command".
- **Test home:** `test/unit/flags.test.ts` (inventory), `help.test.ts`,
  `positional-refusal.test.ts`.

### 3.10 Generated projects run it

- **Decision:**
  - **npm manifests (Node, Bun, Workers, every template, workspace members):** devDependency
    `"@setu-ts/cli": frameworkSpecifier('cli', 'npm')` (`^V`, the framework pin), added beside
    `NPM_TOOLING_DEV_DEPENDENCIES` on both the Node/Bun and the Workers branches.
    `NPM_TOOLING_SCRIPTS.check` becomes `tsc --noEmit && setu check`; the Workers-with-build
    override becomes `npm run build && tsc --noEmit && setu check`.
  - **Deno (`--runtime deno` only):** `denoTasks` emits
    `check: deno check main.ts setu.config.ts && deno run -A npm:@setu-ts/cli@^V check`. A Workers
    project's `deno.json` gets no `check` task: its gate is the `package.json` `check` script above,
    which is what its tooling already runs. `devtoolTasks().check` becomes
    `deno check main.ts setu.config.ts main.dev.ts && deno run -A npm:@setu-ts/cli@^V check`. The
    `npm:` specifier pinned in the task, resolved into `deno.lock` on first run, is the Deno form of
    the pin. It needs no import-map entry, so a pre-M118 project that later runs
    `setu devtool enable` gets a working task without an import merge. One helper,
    `cliCheckCommand(runtime)` in `templates/project-files.ts`, renders the setu half for both.
  - **`setu devtool enable`:** `mergeTask` for `check` treats the exact scaffold `check` string
    (`denoTasks`'s, for the project's entry) as a known CLI-written predecessor and replaces it with
    the devtool form. Any other existing value is refused, as today.
  - `dev`, `debug` and `start` are untouched.
- **Why:** ROADMAP "Generated projects run it". Without the predecessor rule, a fresh Deno scaffold
  could no longer `setu devtool enable`, because `mergeTask` refuses a differing `check`.
- **Test home:** `test/unit/project-files-check.test.ts` (every runtime × template manifest carries
  the pin and the script); `devtool-manifest-merge.test.ts` (predecessor replaced; foreign task
  still refused); e2e in §6.

### 3.11 `setu agents --check` is not folded in (ROADMAP open question 1)

- **Decision:** `setu check` checks wiring only.
- **Why:** The brief is opt-in. A project that never ran `setu agents` would fail a check it did not
  ask for, and `setu agents --check` already exists for CI.
- **Test home:** none needed beyond §3.6: a project with no `AGENTS.md` passes `setu check`
  (asserted in `check-command.test.ts`).

### 3.12 No `--json` (ROADMAP open question 2)

- **Decision:** Plain lines only.
- **Why:** No reader exists. A JSON shape with no consumer is dead surface; the line format names
  the file, which is what CI annotations need.
- **Test home:** `flags.test.ts` (`--json` is refused as an unknown flag).

### 3.13 No write into an existing manifest

- **Decision:** The devDependency and script are written only into manifests the CLI creates
  (`setu new`, `setu generate app`). Existing projects get them from the upgrade guide (§2 C2). So
  the M119f manifest-write shapes (overrides, dev/peer placement, BOM, root entries) do not arise:
  no code path merges into a user-owned `package.json`.
- **Why:** ROADMAP "nothing rewrites a developer's existing script".
- **Test home:** `project-files-check.test.ts` (created manifests only); no `setu add` test changes.

### 3.14 `setu sync` re-renders the CLI-managed barrels

- **Decision:** `commands/sync.ts` `runSyncCommand` resolves scope exactly as §3.6 (project, member,
  workspace root → every member). Per project it runs `diagnoseProject`, then plans one
  `GeneratedFile` with `managed: true` per barrel, rendered by the SAME pure renderer the schematic
  that owns it uses, from the scan:
  - each distinct `barrel` of `scanSeamSpecs(installed)`, rendered with that spec's
    `renderBarrel(diagnosis.artifacts)` — the functional services re-export barrel included, since
    it is managed too;
  - `src/modules/index.ts`, rendered with `renderModuleBarrel(modules, legacyModules)` (class-based)
    or `renderFunctionalModuleBarrel(modules)` (functional), as `schematics/module.ts:70-75` does;
  - each functional module's `src/modules/<m>/index.ts`, rendered with
    `renderFunctionalModuleIndex(names, { controller, route })` from `scanModuleArtifacts`, as
    `schematics/controller.ts:131-137` does. A class-based module's `index.ts` is not managed
    (`module.ts:70`) and is never written.

  A barrel is planned only when it exists on disk or its family admitted at least one artifact, so
  `sync` never adds a barrel a project never had and has nothing to list. The plan goes through
  `formatForTarget` (runtime from `detectTargetRuntime`) and `writeFiles` with the interrupt signal,
  exactly as `generate.ts:592-605` — the same symlink and ownership refusals, and an interrupted run
  removes what it wrote. Each outcome prints as `created`, `updated` or `unchanged <path>`.
  `--dry-run` prints the plan through `reportDryRunPlan` and writes nothing.

  `sync` cannot fix what is not a barrel: a skipped artifact, a manual registration, an unwired
  config, an inactive module, a legacy layout. After writing, it runs `diagnoseProject` again and
  prints whatever remains through `renderCheckFindings` (silencing applied), exiting `1` when an
  error remains and `0` otherwise. A run on a clean project prints only `unchanged` lines and exits
  `0`. `sync` never touches `setu.config.ts`, a manifest or an artifact file (§3.13).

- **Why:** Nx pairs `sync:check` with `nx sync` (§0). Without a writer, the drift remedy told the
  developer to hand-edit a file whose header says edits there are lost. Reusing each schematic's own
  renderer means a synced barrel is byte-identical to the one the next `generate` would write.
- **Test home:** `test/unit/sync-command.test.ts`; `test/e2e/check-e2e.test.ts` (each drift case:
  `check` exits `1`, `sync` fixes it, `check` exits `0`, and the synced barrel equals what
  `generate` writes for the same directory).

### 3.15 Finding ids are printed, never parsed back from prose

- **Decision:** A finding's id comes from `FINDING_IDS` keyed by kind (and `outcome` for `unwired`).
  `renderGenerateFindings` does NOT print ids, so `generate`'s stderr stays byte-identical (§3.1);
  only `check` and `sync` print them.
- **Why:** The golden pin in §3.1 is the guarantee that the refactor changed nothing in `generate`.
- **Test home:** `generate-stderr-golden.test.ts`; `check-command.test.ts`.

### 3.16 Silencing: `.setu-ts/check.json`, an id with an optional path

- **Decision:** `diagnostics/silence.ts` reads `<project>/.setu-ts/check.json` through the capped
  reader (§3.7), beside the existing `.setu-ts/schematics/` directory (`CUSTOM_SCHEMATIC_DIR`). Its
  only key is `silence`, an array whose entries are each an id string (`"setu.W001"`, every
  instance, as in Django) or `{ "id": "setu.E003", "path": "src/controllers/admin.controller.ts" }`
  (only findings whose primary path equals that project-relative path). Rules:
  - absent file → nothing silenced;
  - present but not a regular file, over the cap, invalid JSON, a top-level key other than
    `silence`, an entry of another shape, or an id not in `FINDING_IDS` → one `setu.E011` error
    naming the file and the offending entry, and NOTHING is silenced for that project, so a typo
    cannot switch the gate off;
  - `setu.E011` and `setu.W004` cannot themselves be silenced;
  - an entry that matched no finding → `setu.W004` naming the entry.

  Silenced findings are not printed and do not affect the exit code; the summary counts them. In a
  workspace each member reads its own file; a root-level file is not read. `generate` ignores the
  file (§3.15). Nothing writes the file — it is the developer's.

- **Why:** Django's `SILENCED_SYSTEM_CHECKS` model (§0). The optional path keeps one accepted
  exception from disabling a whole class of check, and a file under `.setu-ts/` reads the same on
  every runtime with no manifest edit (§3.13).
- **Test home:** `test/unit/silence.test.ts` (each rule above, including every `E011` shape and the
  unsilenceable ids); `check-command.test.ts` (summary count; silenced `E` no longer fails);
  `check-e2e.test.ts` (an unclassifiable config under `--strict` passes once `setu.W001` is
  silenced).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. The `src/index.ts` barrel is unchanged. Generated projects gain
a devDependency and a longer `check` script; that is a generated-output change carried in `0.11.0`,
with an upgrade-guide entry, not an API break.

| Exported symbol                             | Kind     | Consumer / real code path that READS it                                     |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| (no change to `packages/cli/src/index.ts`)  | —        | —                                                                           |
| `setu check` (command, not a module export) | CLI verb | generated `check` scripts and tasks; CI                                     |
| `diagnoseProject` (internal)                | function | `commands/generate.ts`, `commands/check.ts`                                 |
| `renderGenerateFindings` (internal)         | function | `commands/generate.ts`                                                      |
| `renderCheckFindings` (internal)            | function | `commands/check.ts`                                                         |
| `FINDING_IDS` (internal)                    | const    | `renderCheckFindings`, `commands/check.ts` and `commands/sync.ts` exit code |
| `readSilence` (internal)                    | function | `commands/check.ts`, `commands/sync.ts`                                     |
| `runSyncCommand` (internal)                 | function | `cli.ts` `case 'sync'`                                                      |
| `setu sync` (command)                       | CLI verb | developers; the `setu.E003` remedy                                          |
| `classifyWiring` (internal)                 | function | `diagnoseProject`                                                           |
| `cliCheckCommand` (internal)                | function | `denoTasks`, `devtoolTasks`, devtool predecessor rule                       |

### 4.1 Options — every option names its consumer

| Option                                | Consumer                                  | Behavior (per implementation)                                                                   |
| ------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--dir`                               | `runCheckCommand` → `resolveDir`          | Directory to check; default CWD.                                                                |
| `--strict`                            | `runCheckCommand` → exit code and summary | Warnings count as errors.                                                                       |
| `--help`                              | `runCheckCommand`, `runSyncCommand`       | Usage, exit `0`.                                                                                |
| `sync --dir`                          | `runSyncCommand` → `resolveDir`           | Directory to sync; default CWD.                                                                 |
| `sync --dry-run`                      | `runSyncCommand` → `reportDryRunPlan`     | Prints the plan, writes nothing.                                                                |
| `.setu-ts/check.json` `silence`       | `readSilence` → `check`, `sync`           | §3.16.                                                                                          |
| `options.module` of `diagnoseProject` | `generate.ts` functional `--module`       | Scans the module's internal families instead of the top-level ones (today's `:422-425` branch). |

## 5. Implementation files

| File                                           | Purpose                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/index.ts`                    | Unchanged barrel.                                                                                                      |
| `packages/cli/src/diagnostics/diagnose.ts`     | `diagnoseProject`, `Finding`, `ProjectDiagnosis`.                                                                      |
| `packages/cli/src/diagnostics/barrel-drift.ts` | §3.3 parser and set comparison.                                                                                        |
| `packages/cli/src/diagnostics/wiring.ts`       | `classifyWiring`, §3.4 barrel set.                                                                                     |
| `packages/cli/src/diagnostics/modules.ts`      | `activatesModule`, `withoutImports` moved from `generate.ts`; §3.5.                                                    |
| `packages/cli/src/diagnostics/ids.ts`          | `FINDING_IDS`.                                                                                                         |
| `packages/cli/src/diagnostics/silence.ts`      | `readSilence` and matching (§3.16).                                                                                    |
| `packages/cli/src/commands/sync.ts`            | `runSyncCommand` (§3.14).                                                                                              |
| `packages/cli/src/diagnostics/render.ts`       | `renderGenerateFindings`, `renderCheckFindings`.                                                                       |
| `packages/cli/src/commands/check.ts`           | `runCheckCommand`: §3.6–§3.8.                                                                                          |
| `packages/cli/src/commands/generate.ts`        | Scan-and-report block replaced by `diagnoseProject` + `renderGenerateFindings`.                                        |
| `packages/cli/src/cli.ts`                      | `case 'check'`, `case 'sync'`; top-level help lines.                                                                   |
| `packages/cli/src/flags.ts`                    | `CHECK` and `SYNC` specs, `commandFlagsFor`, `DOCUMENTED_FLAGS`.                                                       |
| `packages/cli/src/utils/legacy-layout.ts`      | `readConfigModule` routed through the capped reader (§2 C4).                                                           |
| `packages/cli/src/templates/npm-tooling.ts`    | `check` script; CLI devDependency export.                                                                              |
| `packages/cli/src/templates/project-files.ts`  | CLI devDependency on both npm branches; Workers build `check`; `denoTasks` `check`; `devtoolTasks`; `cliCheckCommand`. |
| `packages/cli/src/commands/devtool.ts`         | `check` predecessor rule in `mergeTask`'s caller.                                                                      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                          | src covered                                              | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/generate-stderr-golden.test.ts` (new, FIRST)                                                            | `commands/generate.ts`, `diagnostics/render.ts`          | `runCli(['generate', …])` over a fixture matrix (skipped, invalid name, manual, legacy layout, legacy registrar, module skipped/rejected, unwired class-based/jobs/modules, inactive module, adoption, functional `--module`) → stderr lines equal a literal golden captured on the unchanged code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/unit/diagnose.test.ts` (new)                                                                                 | `diagnostics/diagnose.ts`, `diagnostics/modules.ts`      | `diagnoseProject(fs, dir, installed, options?)` returns each `Finding` kind; functional `--module` path; module inactive in both modes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/unit/barrel-drift.test.ts` (new)                                                                             | `diagnostics/barrel-drift.ts`                            | §3.3 cases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/unit/check-wiring.test.ts` (new)                                                                             | `diagnostics/wiring.ts`                                  | `classifyWiring(config, symbol)` three outcomes; host barrel set; starter remedy; `no-config`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/unit/check-command.test.ts` (new)                                                                            | `commands/check.ts`, `diagnostics/render.ts`             | Table over `FINDING_IDS`: one fixture per kind → exit `0`/`1`, `--strict`; exact output lines; workspace root per-member prefix and worst exit; `none` / `unreadable` refusals; "nothing to check" line; recording fs shows no writes; no `AGENTS.md` still passes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/unit/project-files-check.test.ts` (new)                                                                      | `templates/npm-tooling.ts`, `templates/project-files.ts` | Every runtime × template: npm manifests carry `@setu-ts/cli: ^V` and the `check` script; Deno manifests carry the `check` task; Workers-with-build form; devtool form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Existing pins of the old strings (`deno-tasks.test.ts`, `new-command.test.ts`, devtool tests, any manifest golden) | `templates/*`, `commands/devtool.ts`                     | Updated to the new `check` script, task and devDependency; each update is a reviewed diff, never a regenerated snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `test/unit/devtool-manifest-merge.test.ts` (extend)                                                                | `commands/devtool.ts`                                    | Scaffold `check` replaced by the devtool form; a foreign `check` still refused by name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/unit/flags.test.ts`, `help.test.ts`, `positional-refusal.test.ts` (extend)                                   | `flags.ts`, `cli.ts`                                     | `check` and `sync` inventories, help text, `setu check extra` and `setu sync extra` refused, `--json` refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/unit/finding-ids.test.ts` (new)                                                                              | `diagnostics/ids.ts`                                     | §3.2: one id per kind/outcome, unique, letter matches severity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/unit/silence.test.ts` (new)                                                                                  | `diagnostics/silence.ts`                                 | §3.16 rules, each `E011` shape, unsilenceable ids, `W004`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/sync-command.test.ts` (new)                                                                             | `commands/sync.ts`                                       | Every barrel kind rendered by its schematic's renderer; absent barrel with no artifacts not planned; `--dry-run` writes nothing; remaining findings printed and exit `1`; clean project → all `unchanged`, exit `0`; workspace root per member; interrupted write rolled back (fake signal).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/legacy-layout.test.ts` (extend or new)                                                                  | `utils/legacy-layout.ts`                                 | Over-cap and non-regular config read as `''`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/e2e/check-e2e.test.ts` (new)                                                                                 | end to end through `runCli` on a real temp fs            | Scaffold `rest`, `class-based`, `microservice`: `check` exits `0`. Then, one break at a time per family present (controller, service, route, middleware, plugin, health, metric, command/query handler, event handler, ingress, job, module): a hand-copied artifact, a removed barrel import, a duplicate hand registration, a missing export → exit `1` and the output names the file (a feature module has no hand-registration detector, §3.5, so its breaks are a missing export and an inactive module). A reformatted barrel and an unclassifiable config (a template literal in `setu.config.ts`) → exit `0`. Workspace root with two members, one broken → exit `1` naming that member. Each drift case: `sync` fixes it, `check` then exits `0`, and the synced barrel equals the one `generate` writes. An unclassifiable config under `--strict` passes once `setu.W001` is silenced. |
| `test/e2e/node-scaffold-e2e.test.ts` (extend)                                                                      | generated output                                         | Existing per-host `npm run check` now runs `setu check` (fresh scaffold passes on every host). New: rest host, after install, copy an unregistered controller in → `npm run check` exits non-zero and names the file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test/e2e/scaffold-runs-e2e.test.ts` (extend)                                                                      | generated output                                         | Deno rest scaffold through the overlay: `deno task check` passes fresh, fails after a removed barrel import. Bun rest scaffold: `bun run check` the same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m118-setu-check, never main or develop
pnpm run check:plan        # this plan lints clean
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run test
pnpm run test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every src file
pnpm run test:deno-lane
pnpm run ci:local          # on the final commit
pnpm run release:publish --dry-run
pnpm run release:verify 0.11.0
```

## 8. Risks & mitigations

- **The refactor changes `generate`'s stderr silently.** → The golden test is written and green on
  the unchanged code first, and the implementer reports that run before touching `generate.ts`.
- **A false error on a project the CLI did generate.** → `check-e2e` and every `node-scaffold-e2e`
  host run `check` on fresh scaffolds of every template, class-based included.
- **The barrel parser misreads a hand-formatted barrel.** → The parser reads only import and export
  declarations from comment-masked text, compares sets, and an unclassifiable barrel is a named
  finding rather than a guess.
- **Adding the CLI as a devDependency makes installs larger.** → It is a devDependency, out of the
  runtime image (M120). Its own dependencies are `common`, `runtime`, `prettier` and `tsx`, and
  `prettier` and `tsx` are already in npm projects' tooling.
- **`sync` overwrites a barrel a developer edited by hand.** → The barrel header already says the
  CLI owns it and edits are lost; `--dry-run` shows the plan first; only managed barrels are ever
  planned, never an artifact, a config or a manifest.
- **A silence list hides a real defect.** → A malformed file silences nothing (`setu.E011`), a stale
  entry is reported (`setu.W004`), and the path form keeps an exception to one file.
- **Deno's `deno check` task runs the CLI through `-A`.** → The same grant `cliInvocation` already
  documents for every Deno `setu` command; `check` reads only.

## 8a. Design security review

**Written after the committed-tree audit failed M118, from the design — not before the code.** The
plan as first approved had no security review: it treated `setu check` as a local developer tool,
and the verification report repeated that the diff "crosses no trust boundary". It does. The
milestone's purpose is a CI gate, and CI runs it on pull requests from anyone, so every file it
reads is attacker-controlled. The audit of `5322c3f7` found this (F0) together with F1–F6; the
decisions below are what the fixes implement, and the obligations bind the re-audit to them.

- **Reviewed flows:**
  1. `setu check` in CI on a checkout of an untrusted pull request, standalone and from a workspace
     root.
  2. `setu sync`, with and without `--dry-run`, run by a developer on a checkout they did not write.
  3. `setu generate`, which shares `diagnoseProject` and now runs the same parsers.
  4. A generated project's `check` script or task (`npm run check`, `deno task check`).
- **Assets:** the CI runner's availability (a gate that hangs is switched off, or blocks merges);
  the developer's and runner's filesystem outside the project; the integrity of the gate's verdict
  (a finding must not be dropped by a malformed input); the terminal and CI log the output reaches.
- **Attackers:** a pull-request author who controls every file in the checkout — seam barrels,
  artifacts, `setu.config.ts`, `.setu-ts/check.json`, `setu.workspace.json`, directory and file
  names, and symbolic links — but not the CLI, its dependencies or the runner. Out of scope: a
  maintainer who merges that code (it then runs as the application anyway).
- **Decisions:**
  - **D-S1 Linear parsing (F1, F3).** Every parser on the `check` path runs in time linear in its
    input. The barrel parser (`declarationSpecifiers`), `withoutImports`, class-based `moduleActive`
    and `exportsSymbol`'s clause scan are rewritten without backtracking; each keeps the semantics
    of the expression it replaces, except that a barrel brace list may not contain `{` or `;`.
    Budget: under 1 s per 1 MiB file, against a measured tens of milliseconds.
  - **D-S2 No reads or writes through a linked member (F2).** `check` and `sync` refuse an
    `apps/<member>` that does not resolve to its own place under the workspace root, with the
    `setu agents` refusal wording; the member is skipped and the run fails.
  - **D-S3 An unreadable config fails (F4).** A `setu.config.ts` that exists but is a directory, a
    special file, over 1 MiB or unreadable is `setu.E012`, an error; `setu.W002` stays for an absent
    one.
  - **D-S4 `check` executes nothing; `sync` and `generate` load the formatter (F5).** `check`
    neither imports project code nor loads its Prettier configuration. `sync` and `generate`,
    `--dry-run` included, format through the project's Prettier configuration, which runs project
    code; that is documented as "do not run on unreviewed code", matching `generate`'s existing
    behaviour, rather than changed in one of the two.
  - **D-S5 The Deno task keeps `-A` (F6, accepted risk, maintainer decision 2026-10-26).** The
    measured minimum is `--allow-read=. --allow-sys=hostname,uid --allow-env=PWD`; `-A` is kept for
    consistency with every documented Deno `setu` invocation. The CLI is first-party with no install
    scripts, and the task runs only the CLI.
  - **D-S6 An unreadable artifact fails closed (re-audit F7).** The scanner reports an artifact it
    cannot read (special file, over 1 MiB, read error other than a vanished path) as `setu.E013`
    instead of skipping it silently; `sync` leaves that family's barrel unchanged rather than drop
    an import it cannot verify. `generate` keeps its behaviour, so its pinned output is unchanged.
  - **D-S7 The CI guidance is exact (re-audit O3, O7).** The docs say which links each command
    refuses, and that on an unreviewed pull request CI must run a pinned CLI installed outside the
    checkout, before its dependencies, with `--strict`.
- **Audit obligations (re-audit):**
  1. Each F1/F3 shape at 1 MiB, through the real CLI and per function, under 1 s; positive control:
     the pre-fix code exceeds it (the regression tests record both).
  2. A symlinked member and a symlinked `apps` directory: `sync` writes nothing outside the
     workspace (sentinel unchanged) and both commands exit `1` naming the member; positive control:
     a real member still checks and syncs.
  3. `setu.config.ts` as a directory, FIFO, link to `/dev/zero`, over 1 MiB, mode 000: `E012`, exit
     `1`; absent: `W002`, exit `0`.
  4. The rewritten functions return what the replaced expressions returned on a table of inputs.
  5. Re-confirm the passed areas against the fixed tree: read limits, silencing, output escaping,
     read-only `check`.

## 9. Out of scope

- DI container graph validation (missing, cycle, captive) inside `setu check` — it stays at boot in
  `di-plugin` (M125's boundary; maintainer decision 2026-10-26).
- `setu check` in a production `build` script and the Docker build stage — M120.
- Folding `setu agents --check` in, and a `--json` format (§3.11, §3.12).
- A `--fix` flag on `check` — fixing is `setu sync`'s job, and `check` stays read-only.
- `sync` editing `setu.config.ts`, a manifest or an artifact — it writes managed barrels only.
- A workspace-root silence file — each member owns its own `.setu-ts/check.json`.
- Placement of code outside seam directories, and custom schematics (ROADMAP "Scope").
