# Milestone 131c — CLI gates, generators and workspace deploy (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m131c-cli-gates-generators-deploy`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR into `develop`.

## 0. Objective & scope

The `0.11.0` smoke programme left seventeen CLI rows in which a gate passes over a broken project, a
generator refuses the thing it was asked to do, a workspace member collides with its siblings in
development, or generated text says something false. This milestone makes `setu check` see a deleted
registration call and stop asserting what it could not read, lets `g module --adopt-controllers`
adopt a same-named controller, gives every workspace member its own Vite and inspector ports, ships
no development tooling in the Deno runtime image, lets `setu workspace deploy` pull from an
authenticated registry, and corrects four pieces of generated text. All seventeen rows were
re-checked against `develop` at `8ac6595e5` on 2026-11-05: sixteen still reproduce; V10-50's OTLP
half was fixed by M131a (§1), so only its test gap remains here.

- **In scope:** X91-3, V11-8 (= X89-2), X93-10, X91-1, X87-1, V11-15, V10-27 remainder (gates and
  generators); X87-2, X87-4, X87-5, X87-6, V10-50 remainder (workspaces, images, deploy); V11-3,
  V11-4, V11-9, X93-8 (generated text and briefs); X91-4 is decided as "stays documented" (§3.8).
  Package: `packages/cli` only, plus the docs pages that describe the changed behaviour.
- **NOT this milestone:** closing the `smoke/DEFECTS.md` rows (needs a re-run on the next published
  version, memory `defect-closure-needs-published-reverify`); X87-5's deployment-guide walkthrough
  and V10-50's nested-peer documentation (M131d, docs); a boot-time page/route shadow warning in
  `react-router-plugin` (no milestone yet — X91-4, §3.8); X91-2 (M130, merged); X87-3 (M131b,
  merged); X91-9 (`fix/add-broker-env-url`, outside the letters).

## 1. Contracts verified from SOURCE (not names)

All lines are on `develop` at `8ac6595e5`, paths under `packages/cli/src/` unless stated.

| Reference                               | Source (file:line)                                                                                                                                                                                 | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classifyWiring`                        | `diagnostics/wiring.ts:8-19`                                                                                                                                                                       | Tests `\bsymbol\b` against `maskSourceCode(config)`, which still holds the import line, so an imported-but-never-used barrel symbol is `wired`. JSDoc: "Imported bindings count … the project's lint checks their use" — the generated `check` script runs no lint. `test/unit/check-wiring.test.ts:7-9` pins the import-only = wired behaviour.                                                                                                                                                                                                                          |
| `moduleActive`                          | `diagnostics/modules.ts:59-65`, `withoutImports` `:17`                                                                                                                                             | The module-activation check already strips imports and requires a call (`\bsym\s*\(`), so a deleted activation call is E009 today. The rule X91-3 needs exists; `classifyWiring` does not use it.                                                                                                                                                                                                                                                                                                                                                                         |
| Module index drift                      | `diagnostics/barrel-drift.ts:141-198`, `seams/modules.ts:99-128`                                                                                                                                   | A module's `index.ts` is compared as SETS of imported specifiers; a registrar imported but no longer called is not drift. `setu sync` rewrites the index (`commands/sync.ts:100-105`).                                                                                                                                                                                                                                                                                                                                                                                    |
| Config lexer                            | `devtool/sources.ts:141-163`, `:233-239`, `:427-448`, `:467-481`, `:535-604`                                                                                                                       | `maskSource` returns `undefined` on `globalThis`/`self`/`window`, a non-relative non-`@setu-ts/*` import (`node:process`), or computed `obj[k]`; bracket access by literal name is accepted since `namedMemberAccess`. Returning `undefined` carries no reason or offset. It is the security-audited lexer (devtool audit rounds 5–7).                                                                                                                                                                                                                                    |
| W001 text                               | `diagnostics/render.ts:69`, `:223`; `diagnostics/ids.ts:11`                                                                                                                                        | `unwired.unclassifiable` → `setu.W001`, one finding per BARREL with its symbols joined (`wiring.ts:52-61`), rendered "setu.config.ts does not reference X …; config is unclassifiable" with no line number; three sites emit them (`diagnose.ts:217-221` generate, `:223-241` host barrels and class-based `registerModules`, `:257-269` `moduleWiring`). `findingPath` (`ids.ts:37-39`) returns the barrel, which sorting and path-scoped silencing (`silence.ts`) key on. `render.ts:49-54` prints "does not reference" for `registerModules` even when unclassifiable. |
| Finding ids                             | `diagnostics/ids.ts:5-27`                                                                                                                                                                          | Append-only map; highest warning `W004` (`silence-unmatched`), highest error `E018`. `test/unit/finding-ids.test.ts` pins the table.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Functional service seam                 | `seams/services.ts:109-111`, `:175-184`; skip record `utils/artifact-scanner.ts:86-90`, built `:307-314`; `diagnostics/diagnose.ts:176-182`; `render.ts:25-27`, generate pre-write list `:170-180` | The functional services seam has `exports: []` but still requires `describe<Pascal>` via `importSymbols`; a file without it becomes `artifact-skipped` = `setu.E001`, rendered "nothing registers it" — false: the barrel's own header says it is "not a registration".                                                                                                                                                                                                                                                                                                   |
| Name conflict before adoption           | `commands/generate.ts:448-465`, `:582-612`; `utils/name-conflicts.ts:44-62`; `utils/module-switch.ts:289-308`                                                                                      | `findNameConflict` runs before `planModuleSwitch` and knows nothing of `--adopt-controllers`; skipping it alone is not enough, since `planModuleSwitch` then refuses the clash between the moved `src/controllers/orders.controller.ts` and the module's own generated `src/modules/orders/orders.controller.ts`.                                                                                                                                                                                                                                                         |
| Page-collision read                     | `utils/react-router-routes.ts:70-85`; caller `commands/generate.ts:492-496`                                                                                                                        | `readPagePaths(dir, runCommand)` runs only `<dir>/node_modules/.bin/react-router`; npm hoists that bin to the workspace root, so in an npm workspace member the check falls to the "could not run" notice.                                                                                                                                                                                                                                                                                                                                                                |
| Workspace marker                        | `utils/project-detector.ts:26`                                                                                                                                                                     | `findWorkspaceMarker(fs, dir)` (async) checks ONE directory (`setu.workspace.json`, or `deno.json`/`deno.jsonc` `workspace`, or `package.json` `workspaces`); it does not walk. X87-1 walks up calling it per directory.                                                                                                                                                                                                                                                                                                                                                  |
| Flat controllers barrel                 | `seams/http.ts:164-176`                                                                                                                                                                            | The default FLAT functional scaffold's `src/controllers/index.ts` also imports each registrar and calls it inside `registerGeneratedRoutes`; deleting a call there is the same invisible defect as X91-3 (2b). `diagnoseBarrels` is generic over families. `barrel-drift` findings are `{ barrel, unlisted, stale }` (`diagnose.ts:48-53`) — no field for an uncalled import.                                                                                                                                                                                             |
| Module generated files                  | `schematics/module.ts:86-98`; `schematics/module-files.ts:160-165`; `schematics/test-harness.ts:182-244`, `:259-271`; `seams/modules.ts:55-64`                                                     | `g module` writes `<m>.controller.ts`, `<m>.service.ts`, `<m>.test.ts`, `<m>.e2e.test.ts`. The generated controller imports `list/get/create/update<P>` from `./<m>.service.ts`; both tests assert the generated CRUD routes. A full-stack module index imports `<camel>Service` and the token by name.                                                                                                                                                                                                                                                                   |
| Manifest member parse                   | `workspace/manifest.ts:303-314`, `:432-441`, `:478-480`; `workspace/dev-runner.ts:43`                                                                                                              | `toMember` copies only known fields (unknown ones vanish on the next write); range checks cover `port`/`devtoolPort`; the serializer special-cases `devtoolBasePort`. The dev runner's `Member` type lists `name, port, dependsOn, devtoolPort`.                                                                                                                                                                                                                                                                                                                          |
| Deploy flags                            | `args.ts:23` `REPEATABLE_FLAGS`; `constants.ts` `VALUE_FLAGS`; `flags.ts:286-291` `WORKSPACE_DEPLOY`; `workspace-ops.ts:~770` namespace apply                                                      | A flag not in `REPEATABLE_FLAGS` keeps only its last value, silently. Deploy creates the Namespace itself after its pre-checks. `adopt` rewrites only `main.ts` (`commands/adopt.ts:408-415`).                                                                                                                                                                                                                                                                                                                                                                            |
| Plugin commands                         | `commands/plugin-commands.ts:125-160`, `:230-235`; `cli.ts:~245-330` (`case 'agents':` `:294`)                                                                                                     | `withPluginCommands` refuses only plugin-vs-plugin duplicates; built-in verbs (with aliases `n`, `g`, and `help`) exist only as `switch` arms in `cli.ts:246-333` and specs in `flags.ts`; built-ins already win dispatch (`cli.ts:336-341`); there is no exported built-in name set.                                                                                                                                                                                                                                                                                     |
| Symlink remedy                          | `utils/agent-workspace-ownership.ts:13-27`                                                                                                                                                         | `remedyFor('symlink')` says "replace the link …, or run setu agents from its real path (<real>)"; the second remedy writes a standalone brief with wrong card paths into the link target (g6 FINDINGS l.72–94). `docs/cli.md:893-894` repeats it.                                                                                                                                                                                                                                                                                                                         |
| Full-stack dev entry                    | `templates/full-stack-build-files.ts:369-370`; emitted `templates/project-files.ts:2441-2443`                                                                                                      | `FULL_STACK_DEV_ENTRY` is a constant: `Number(runtime.env.PORT ?? '3000')`, `VITE_PORT ?? '5173'`. `projectFiles` receives `port: EntryPort` but does not pass it here. Other members bind `SERVICE_PORT` from the generated discovery module (`serveEntry`, `project-files.ts:693`; `workspace/discovery-module.ts:163`).                                                                                                                                                                                                                                                |
| Port allocation                         | `workspace/manifest.ts:143`, `:511-545`; `commands/workspace.ts:63-120`                                                                                                                            | `allocatePort` (app, from `basePort`) and `allocateDevtoolPort` (from `devtoolBasePort ?? basePort+1000`) each skip the other's recorded numbers; `ports --reallocate` re-allocates both and rewrites `managedFiles`. Member scripts (`package.json`/`deno.json`) are not in `managedFiles`.                                                                                                                                                                                                                                                                              |
| Dev runner                              | `workspace/dev-runner.ts:43`, `:215-252`                                                                                                                                                           | Runs each member's `start:dev`, adds only devtool variables to its env, and polls `member.port` for readiness — so a full-stack member binding 3000 never becomes ready at its allocated port.                                                                                                                                                                                                                                                                                                                                                                            |
| Inspector                               | `templates/project-files.ts:1277`, `:1306`, `:1718-1720`                                                                                                                                           | `start:debug` is a bare `--inspect` on Node, Bun and Deno — every Node/Deno member on 9229, every Bun member on Bun's default 6499; members of one runtime always collide. Probed (scratch): `--inspect=127.0.0.1:<port>` is accepted by node 24, bun 1.4 and deno 2.9.                                                                                                                                                                                                                                                                                                   |
| Deno CLI invocation (`--no-lock` sites) | `templates/project-files.ts:1336-1340`; users `:1287`, `:1321`, `:1380`, `commands/devtool.ts:564`, `:863`, `workspace/root-files.ts:84-85`                                                        | `cliCommand('deno', …)` = `deno run -A npm:@setu-ts/cli@<range> …` with no `--no-lock`, so the first `deno task check` writes the CLI tree (esbuild, prettier) into `deno.lock`. Also without it: `cliInvocation('deno')` (`project-files.ts:70-73`, used by the Deno agent brief `agents/render.ts:64`, `:74-75`, `:105` and every printed next step), the devtool dev-entry pinned form (`devtool/dev-entry.ts:205`, `:223-232`), buf (`workspace/proto-toolchain.ts:49`) and the Tailwind CLI (`commands/add-view.ts:132`).                                            |
| Deno image install                      | `workspace/compose.ts:214`, `:229`                                                                                                                                                                 | Step 1 deletes `@setu-ts/diagnostics-plugin` from the import map; step 2 runs `deno cache main.ts && deno install && deno install --frozen && …`. `@setu-ts/testing` stays in the import map.                                                                                                                                                                                                                                                                                                                                                                             |
| Deno lock semantics (probed)            | scratch `deno-lock-probe`, deno 2.9.6                                                                                                                                                              | (a) An import-map entry removed from `deno.json` is DROPPED from `deno.lock` and not installed by a bare `deno install`. (b) A lock entry added from outside the import map (`deno cache npm:x`, the same path `deno run npm:…` takes) SURVIVES `deno install`, `--frozen` and the image's exact sequence, and is installed. (c) `--no-lock` leaves `deno.lock` byte-identical.                                                                                                                                                                                           |
| Node/Bun image install                  | `workspace/compose.ts:372`                                                                                                                                                                         | `npm ci --omit=dev` / `bun install --production` — dev tooling never reaches those images; Deno has no `devDependencies` for a `deno.json` import map.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Deploy manifest                         | `commands/workspace-ops.ts:636`, `:711-779`; `workspace/deploy-manifest.ts:43-74`; `workspace/k8s.ts:194-202`                                                                                      | All deploy settings are flags; `prepareDeployManifest` fills `image:` lines in `k8s/members.yaml` at deploy time; the container renders `image` + `imagePullPolicy` only — no `imagePullSecrets`. `members.yaml` is regenerated by `generate app`, `adopt` and `ports --reallocate`, so a hand edit is not durable.                                                                                                                                                                                                                                                       |
| OTLP peer (V10-50)                      | `commands/add.ts:789-807`, `:1706-1710`, `:1799-1843`; `telemetry-plugin/src/exporters/otlp-exporter.ts:34`                                                                                        | FIXED by M131a (X88-10): `telemetryPackagesFor` adds `@opentelemetry/exporter-trace-otlp-http` on node/bun/deno; it joins `peerPackages`, which feeds the workspace-root recording. `test/unit/add-telemetry.test.ts` covers standalone only.                                                                                                                                                                                                                                                                                                                             |
| Workers config comment                  | `templates/project-files.ts:614-615`, `:881-885`; `test/unit/templates/project-files.test.ts:553`                                                                                                  | Emitted JSDoc says "`setu` loads this module under Deno"; since M111d it loads on Node through tsx, which refuses `cloudflare:workers` with `ERR_UNSUPPORTED_ESM_URL_SCHEME` (probed). The reasoning holds; the runtime named is wrong.                                                                                                                                                                                                                                                                                                                                   |
| `.dev.vars` ignore                      | `templates/project-files.ts:2105-2114`, `:2338-2348`                                                                                                                                               | `.dev.vars` is gitignored only when `envVariables.length > 0`; `.dev.vars` and `.dev.vars.example` are emitted under the same condition.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Brief commands                          | `agents/facts.ts:64-76`; `templates/npm-tooling.ts:33-35`                                                                                                                                          | A fixed list filtered by the scripts present; it has no `lint`, `format`, `format:check`, though every npm-manifest project defines them. Deno projects define none (built-in `deno lint`/`deno fmt`).                                                                                                                                                                                                                                                                                                                                                                    |
| `new --agents` warnings                 | `commands/new.ts:826-829`, `:856-859`; `commands/agents.ts:293-301`; `agents/card-presence.ts:93`; `examples/new.ts:162`                                                                           | `setu new` never installs; it runs agents after writing and prints "Next: <pm> install". Agents warns once per card not found in `node_modules` — 12 lines on every fresh scaffold.                                                                                                                                                                                                                                                                                                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                        | Resolution (picked side)         | Doc deliverable (same PR)                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `docs/cli.md:1005` says barrels are "compared as **sets of names**"; X91-3 adds a called-registrar rule.                        | The code (§3.1).                 | `docs/cli.md` `setu check` section: an imported registrar must be called; import-only config wiring is `E006`.                         |
| C2  | `docs/cli.md:893-894` documents the symlink remedy's second alternative.                                                        | Drop it (§3.7).                  | `docs/cli.md` remedy text.                                                                                                             |
| C3  | `docs/cli.md` finding table lists `W001` as "does not reference"; `E001` for any skipped artifact.                              | §3.2 and §3.3.                   | `docs/cli.md` finding table: W001 wording, new `W005`.                                                                                 |
| C4  | Emitted Workers `setu.config.ts` JSDoc and two source/test comments say the CLI loads the config under Deno.                    | Node through tsx (V11-3, §3.13). | The template text itself; no page repeats it (checked `docs/`).                                                                        |
| C5  | `docs/deployment.md` workspace-deploy section has no authenticated-registry path; `setu.workspace.json` docs list no dev ports. | §3.11 and §3.9.                  | `docs/deployment.md`: one paragraph on `--pull-secret` (the walkthrough is M131d); workspace manifest docs: `inspectPort`, `vitePort`. |

## 3. Design decisions

Maintainer decisions of 2026-11-05: allocated dev-port range (X87-2/X87-6), `--pull-secret` flag
(X87-5), X91-4 stays documented, X91-1 adopts the same-named file as the module's own.

### 3.1 X91-3 — a registration must be called, not only imported

- **Decision:** one helper, `referencedOutsideImports(config, symbol)`, tests the symbol against
  `withoutImports(maskSourceCode(config))`; `classifyWiring` uses it, so a symbol named only on an
  import line is `unwired` (E006). Every `registerModules` check — the `registerModules` site
  (`wiring.ts:36-40`, functional and class-based), `diagnose.ts:232-241` and `moduleWiring`
  `:257-269` — goes through one `calledOutsideImports(config, 'registerModules')` rule
  (`\bsym\s*\(`, the rule `moduleActive` uses). In barrels, every family whose import symbols are
  route registrars (`routeRegistrarSymbol`) — the flat `src/controllers/index.ts` and every
  `src/modules/<m>/index.ts`, functional and class-based — must call each registrar it imports; one
  imported but not called is `barrel-drift` (`setu.E003`) through a new finding field
  `uncalled: readonly string[]`, rendered "imports <sym> but never calls it; run setu sync" (the
  existing rewrite repairs it). For an import-only symbol, the E006 text says "imports <sym> but
  never uses it" instead of "does not reference" (`render.ts:49-54`). The `wiring.ts:8` JSDoc is
  replaced with the real rule. `generate` shares `wiringSites`/`wiringFinding`, so its notice
  follows.
- **Why:** the `0.11.0` project lost every route with all four gates green; the rule already exists
  for module activation (E009) and is applied to every site that lacked it.
- **Test home:** `check-wiring.test.ts` (import-only → `unwired`; a value use outside imports such
  as `[...GENERATED_PLUGINS]` → `wired`; `registerModules` named but not called → `unwired`),
  `barrel-drift.test.ts` (uncalled registrar in a flat barrel, a functional module index and a
  class-based module index → drift with `uncalled`; called → none), `check-command.test.ts`
  (end-to-end exit 1 and the wording for both X91-3 repros plus the flat-barrel case),
  `generate-unwired-seam.test.ts`, and the scaffold e2e running `check` on every template (no
  template trips the stricter rule).

### 3.2 V11-8 — say the config could not be read, and where

- **Decision:** the audited state machine moves into `maskSourceDiagnosis(source)` returning
  `{ code } | { stop: { reason, offset } }`; `maskSource`/`maskSourceCode` become thin wrappers that
  return `undefined` on a stop, so the accept set is the same code, not a copy (no `node:`
  specifiers, no `globalThis`). `diagnose.ts` runs a post-pass: when the config is unclassifiable,
  every `unwired` finding with outcome `unclassifiable` from the three sites is replaced by ONE
  finding, kind `unwired`, outcome `unclassifiable`, path `setu.config.ts`, carrying the union of
  symbols and the stop; it renders "could not classify setu.config.ts at line N (`<construct>`);
  setu check cannot tell whether it registers <symbols>". Silencing by id keeps working; a
  path-scoped silence names `setu.config.ts`. `generate` prints the same single line. Every stop
  reason in `sources.ts:141-163` and `:553-603` (template literals, `/`, `#`, `\`, non-ASCII,
  unterminated strings, `globalThis`/`self`/`window`, `Object`/`Reflect`/`require`/`eval`, dynamic
  `import(`, non-relative non-`@setu-ts/*` specifiers, computed member access) maps to a construct
  label.
- **Why:** the false claim is the defect, not the lexer's caution; widening the audited lexer would
  reopen its security review for a Low row; one implementation keeps the audited code single.
- **Test home:** `devtool-sources.test.ts` (a table over every stop reason: label and offset; the
  wrappers return `undefined` for exactly the same inputs), `check-wiring.test.ts` and
  `check-command.test.ts` (one W001 with the line number for the three `0.11.0` repros; a
  path-scoped silence on `setu.config.ts` silences it).

### 3.3 X93-10 — an unlisted plain-function service is a warning

- **Decision:** `SkippedArtifact` (`utils/artifact-scanner.ts:86-90`) carries the seam's
  `exports.length === 0` as `listingOnly: true`; such a skip (the functional services seam) is a new
  append-only finding `artifact-unlisted` → `setu.W005`: "<file> is not re-exported from
  src/services/index.ts: it does not export describe<Name>". `generate`'s pre-write list
  (`render.ts:170-180`) prints the same warning line. Every other skip stays `E001`.
- **Why:** the barrel is a convenience re-export, not a registration; a consumer importing the
  missing name from it still fails type-check. Admitting any export (`export *`) risks `TS2308` when
  two services export the same name.
- **Test home:** `utils/artifact-scanner.test.ts` (the flag set only for listing-only seams),
  `diagnose.test.ts` (functional seam → W005; a registering seam → E001), `finding-ids.test.ts`
  (W005 appended), `check-command.test.ts` (`check` exits 0 with the warning),
  `generate-command.test.ts` (pre-write line).

### 3.4 X91-1 — adopting a same-named controller

- **Decision:** with `--adopt-controllers` on the first module, the flat files being adopted are
  left out of `findNameConflict`, and `planModuleSwitch` resolves a same-named landing per case:
  - **Controller adopted** (`src/controllers/<m>.controller.ts` → the module's controller path): it
    becomes the module's controller; the generated controller, `<m>.test.ts` and `<m>.e2e.test.ts`
    are not written (they assert generated CRUD routes the adopted file does not have). The module's
    service is still generated. Routes stay as the adopted file declares them.
  - **Service adopted with the controller:** both adopted files become the module's; no generated
    controller, service or module tests.
  - **Service adopted WITHOUT a same-named controller:** refused — the generated controller imports
    `list/get/create/update<P>` from it — with the remedy "adopt it with its controller, or name the
    module something else".
  - **Full-stack project:** a same-named adoption is refused with that reason (its module index
    imports `<camel>Service` and the token by name).
  - Any other clash still refuses as today.
- **Why:** maintainer decision; the refusal told the user to delete what they asked to adopt, and
  each case above is the one where the project still type-checks and its tests still pass.
- **Test home:** `generate-module-switch.test.ts` (each case: files planned, files not written,
  refusals and their text), `generate-module-command.test.ts` (the x91 repro end to end, then the
  project's `check` and type-check pass), `utils/name-conflicts.test.ts`.

### 3.5 X87-1 — find a hoisted `react-router`

- **Decision:** `readPagePaths(dir, runCommand, fs)` first finds the workspace root by calling
  `findWorkspaceMarker` on each ancestor of `dir`; it then looks for
  `node_modules/.bin/react-router` from `dir` up to that root, using the first that exists. Outside
  a workspace only `dir` is searched. The process still runs with `cwd: dir`. No `PATH` lookup.
- **Why:** npm hoists the bin; bounding the search by the marker keeps it inside the workspace, so
  no binary above a standalone project is ever run.
- **Test home:** `utils/react-router-routes.test.ts` (member bin wins; root bin used when the member
  has none; a standalone project never consults its parent; neither → the advisory notice),
  `generate-page-collisions.test.ts` (npm-workspace member refuses the shadowing route).

### 3.6 V11-15 — a plugin command named like a built-in

- **Decision:** `flags.ts` exports `BUILT_IN_COMMANDS`, every name `cli.ts` dispatches including the
  aliases `n`, `g` and `help`. `setu commands` leaves a shadowed plugin command out of its list and
  prints one warning per name: "plugin command 'agents' is shadowed by the built-in `setu agents`;
  rename it". Dispatch is unchanged (built-ins already win). Running any other plugin command prints
  no warning. Plugin-vs-plugin duplicates still refuse.
- **Why:** the command is unreachable; refusing would let one plugin block every other plugin
  command, unlike a duplicate, which is genuinely ambiguous.
- **Test home:** `plugin-commands.test.ts` (shadowed name omitted with the warning, siblings listed,
  no warning when another command runs), `flags.test.ts` (drift: every dispatched name is in the set
  and every member has a spec).

### 3.7 V10-27 remainder — one remedy for a symlinked member

- **Decision:** `remedyFor('symlink')` returns only "replace the link with the directory it points
  at"; the `realPath` lookup and the then-unused `fs` and `directory` parameters are removed, so
  `remedyFor` becomes synchronous.
- **Why:** the second remedy writes a brief with wrong card paths into the link target.
- **Test home:** `commands/agents-ownership.test.ts` (text; the "real path cannot be resolved" case
  is deleted with the branch), `test/integration/agents-ownership.test.ts`.

### 3.8 X91-4 — page/route shadowing stays documented

- **Decision:** no code. `docs/cli.md:420-421` already states `setu check` does not run React
  Router; it gains one sentence naming the consequence (the kernel route answers document requests
  on a shared path). A complete check needs the router table and the React Router manifest together,
  which only `react-router-plugin` has at boot — recorded in §9.
- **Why:** maintainer decision; a `check`-side finding could see generated routes only.
- **Test home:** none (documentation only).

### 3.9 X87-2 and X87-6 — every member gets its own development ports

- **Decision:** two optional `WorkspaceMember` fields, `inspectPort` (every member) and `vitePort`
  (full-stack members), and an optional manifest `devBasePort`. `toMember` parses and range-checks
  both fields like `devtoolPort`; the serializer writes `devBasePort` like `devtoolBasePort`; the
  dev runner's `Member` type gains them. `allocateDevPort(manifest)` allocates from
  `devBasePort ?? basePort + 2000`. All three allocators skip every port recorded anywhere in the
  manifest (app, devtool, inspect, vite) through one shared `recordedPorts(manifest)`.
  `generate app` and `adopt` record them; `ports --reallocate` first deletes each member's old dev
  ports (as it does `devtoolPort`), then re-allocates them.
  - **Vite and app port (X87-2):** the full-stack dev entry becomes a render function taking the
    entry port. In a member it imports `SERVICE_PORT` and `VITE_PORT` from the generated discovery
    module (which exports `VITE_PORT` for a member with `vitePort`); standalone keeps
    `PORT ?? '3000'` and `VITE_PORT ?? '5173'`, and so does its README; the member README says the
    ports come from `setu.workspace.json` (`full-stack-app-files.ts:707-715`,
    `project-files.ts:2062`). The dev runner then finds the member ready at its allocated port.
  - **Inspector (X87-6):** a member's `start:debug` renders `--inspect=127.0.0.1:<inspectPort>`
    (Node, Bun, Deno; full-stack `start:debug` too). Standalone keeps bare `--inspect`.
  - **Rewrites:** `ports --reallocate` and `adopt` change a member's `start:debug` (in
    `package.json` `scripts` or `deno.json` `tasks`) only by replacing the token
    `--inspect=127.0.0.1:<old>` (reallocate) or the bare `--inspect` token (adopt) when it occurs
    exactly once; otherwise they leave the script and print the line to change. `adopt` of a
    full-stack project rewrites `dev.ts` only when it equals the standalone render; otherwise it
    prints the two lines to change.
- **Why:** maintainer decision; one datum per port, read from the manifest, as for `devtoolPort`.
  Port `0` cannot work for Vite's HMR `clientPort`. A token rewrite needs no knowledge of how the
  rest of the script was rendered (permissions, env file, preload).
- **Test home:** `workspace-manifest.test.ts` (parse, range-check, round-trip of the three fields),
  `allocate-port.test.ts` (dev range, mutual skipping across all four kinds, range exhaustion →
  `undefined`), `workspace/discovery-module.test.ts` (`VITE_PORT` only for a member with
  `vitePort`), `full-stack-template.test.ts` (member vs standalone dev entry and README),
  `project-files-scripts.test.ts` + `deno-tasks.test.ts` (member `start:debug` per runtime),
  `reallocate.test.ts` (token rewrite; stale dev ports dropped before allocation; note on a
  hand-edited script), `adopt-command.test.ts` (token and `dev.ts` rewrite, note otherwise),
  `workspace/dev-runner.test.ts`, and the dev-runner e2e boots two full-stack members and gets both
  `/health` answers (§7).

### 3.10 X87-4 — the Deno image carries no development tooling

- **Decision:** (1) every `deno run … npm:<tool>` the CLI generates or prints gets `--no-lock`:
  `cliCommand('deno', …)`, `cliInvocation('deno')` (so the agent brief and printed next steps
  match), the devtool dev-entry pinned form and its normalization, buf and the Tailwind CLI. A test
  greps `src/` for `deno run` followed by `npm:` and fails on any hit without `--no-lock`. (2) The
  image's import-map strip step also deletes `@setu-ts/testing`.
- **Why:** probed: a lock entry added from outside the import map survives the image's exact install
  sequence, `--no-lock` leaves the lock untouched, and a removed import-map entry is not installed.
  The tools floating within their `^range` at run time is the contract the Node `setu` binary has.
- **Test home:** `project-files-scripts.test.ts`, `deno-tasks.test.ts`, `workspace/root-files`
  tests, `agents/render-brief.test.ts`, `dev-entry.test.ts`, and the source-scan test above;
  `dockerfile.test.ts` (strip list includes testing); the proof is `check:deploy --generated` on
  Deno with the image's `node_modules/.deno` listed: no `@setu-ts+cli`, `esbuild`, `prettier`,
  `@setu-ts+testing` (§7).

### 3.11 X87-5 — pulling from an authenticated registry

- **Decision:** `setu workspace deploy --pull-secret <name>`, repeatable (added to
  `REPEATABLE_FLAGS`, `VALUE_FLAGS` and the `WORKSPACE_DEPLOY` spec). Each name must be a DNS-1123
  subdomain, else refused before anything runs. `prepareDeployManifest` inserts
  `imagePullSecrets: [{ name }…]` into each member's pod spec, BEFORE the `image:` fill, anchored
  per member on the two-line form `containers:` followed by `- name: <member>`, which must occur
  exactly once per member; it refuses a file that already declares `imagePullSecrets`. Before
  building it runs `kubectl get secret <name> -n <ns> -o name` (no data fetched); when the namespace
  or Secret is missing it refuses with the recipe `kubectl create namespace <ns>` (when absent) then
  `kubectl create secret docker-registry <name> -n <ns> …`. Under `--dry-run` the pre-check runs and
  reports, and the plan lists the secrets. Without the flag, a deploy to a non-`kind-*` context
  prints one line naming `--pull-secret`. `DEPLOY_HELP` lists the option. The CLI never creates a
  Secret or reads its data.
- **Why:** maintainer decision; per-Deployment scope touches no other workload, and the deploy-time
  fill survives regeneration because nothing is written durably.
- **Test home:** `workspace/deploy-manifest.test.ts` (two-member manifest: one insertion per member;
  refusal on an existing field, on a missing or duplicated anchor), `commands/workspace-ops.test.ts`
  (repeated flag keeps every name; invalid name refused; missing Secret and missing namespace
  refusals with the recipe; `-o name` in the recorded kubectl call; hint line without the flag;
  dry-run plan line), `flags.test.ts`/`args.test.ts` (repeatable), `k8s-manifest.test.ts` (rendered
  anchor unchanged).

### 3.12 V10-50 remainder — test the fixed half, document the other

- **Decision:** add a workspace-member case proving `setu add telemetry` records
  `@opentelemetry/exporter-trace-otlp-http` in the ROOT `package.json`. The nested-peer half is Node
  module resolution (a root-hoisted package cannot see `apps/x/node_modules`); `setu add` already
  writes the root entry on the CLI path. Its documentation goes to M131d.
- **Why:** M131a fixed the code; the test pins it.
- **Test home:** `add-telemetry.test.ts`.

### 3.13 V11-3, V11-4, V11-9, X93-8 — generated text and briefs

- **V11-3 decision:** the emitted Workers `setu.config.ts` JSDoc and the two source/test comments
  say the CLI loads the config on Node through tsx, which refuses `cloudflare:workers`. **Test
  home:** `templates/project-files.test.ts` (text names Node, not Deno).
- **V11-4 decision:** every Workers project gitignores `.dev.vars`, unconditionally; the file and
  its `.dev.vars.example` stay conditional. Per-environment variants are not added: their naming was
  not verified against Wrangler. **Test home:** `templates/project-files.test.ts` (Workers
  rest/microservice/full-stack table).
- **V11-9 decision:** `facts.ts` adds `lint`, `format`, `format:check` to the commands list (still
  filtered by presence), with glosses; Deno projects get the literal `deno lint` and
  `deno fmt --check`; a rule block, rendered per runtime, says to run check, lint, the format check
  (`format:check`, or `deno fmt --check` on Deno) and test before reporting done. **Test home:**
  `agents/gather-facts.test.ts`, `render-brief.test.ts`, `rule-blocks.test.ts`, `budget.test.ts`
  (brief stays inside its budget); the template baseline is recaptured.
- **X93-8 decision:** `IAgentsDependencies` (`commands/agents.ts:33`) gains an optional
  `installPending?: true`, set by both `new` callers; when set, the per-card warnings are replaced
  by one line: "agent cards resolve after `<pm> install`; then run `setu agents --check`".
  `--check --strict` is unchanged. **Test home:** `commands/agents-warning.test.ts`,
  `new-command.test.ts`, `examples.test.ts`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. The `packages/cli` barrel (`src/index.ts`) does not change.
User-visible contract changes, each a CHANGELOG entry: `setu check` now fails an import-only
registration (E006/E003); W001 wording and count; new `setu.W005`; new `setu.workspace.json` fields;
new `workspace deploy --pull-secret`; generated `start:debug`, dev entry, Deno CLI tasks and
`.gitignore` text. No existing users (memory `no-existing-users`), so no migration path for older
workspaces beyond `ports --reallocate`.

| Exported symbol                                         | Kind                | Consumer / real code path that READS it                                              |
| ------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `BUILT_IN_COMMANDS` (`flags.ts`)                        | const (internal)    | `withPluginCommands` filter; `flags.test.ts` drift test                              |
| `allocateDevPort` (`manifest.ts`)                       | function (internal) | `generate app`, `adopt`, `ports --reallocate`                                        |
| `recordedPorts` (`manifest.ts`)                         | function (internal) | all three allocators                                                                 |
| `maskSourceDiagnosis` (`sources.ts`)                    | function (internal) | `diagnose.ts` unclassifiable path → W001 text                                        |
| `artifact-unlisted` → `setu.W005`                       | finding id          | `diagnose.ts`, `render.ts`, `.setu-ts/check.json` silencing                          |
| `WorkspaceMember.inspectPort`/`vitePort`, `devBasePort` | manifest fields     | `start:debug` render, discovery module `VITE_PORT`, full-stack dev entry, reallocate |
| `VITE_PORT` (generated discovery module)                | generated const     | the member's generated full-stack dev entry                                          |

### 4.1 Options — every option names its consumer

| Option                               | Consumer                                  | Behavior (per implementation)                                                     |
| ------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `workspace deploy --pull-secret`     | `prepareDeployManifest`, secret pre-check | inserts `imagePullSecrets`; refuses a missing Secret or an existing field (§3.11) |
| `IAgentsDependencies.installPending` | `runAgentsCommand` card-warning step      | one summary line instead of per-card warnings (§3.13)                             |
| `readPagePaths` `fs` parameter       | the marker search and bin lookup          | production passes the CLI filesystem; tests pass a fake tree (§3.5)               |

## 5. Implementation files

| File                                                                                                     | Purpose                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/index.ts`                                                                                           | unchanged barrel                                                                           |
| `src/diagnostics/wiring.ts`                                                                              | X91-3 config rule                                                                          |
| `src/diagnostics/barrel-drift.ts`                                                                        | X91-3 called-registrar rule                                                                |
| `src/diagnostics/diagnose.ts`, `render.ts`, `ids.ts`                                                     | X91-3 detail, V11-8 single W001 text, X93-10 W005                                          |
| `src/devtool/sources.ts`                                                                                 | V11-8 `maskSourceDiagnosis`                                                                |
| `src/utils/artifact-scanner.ts`                                                                          | X93-10 `listingOnly` on the skip record                                                    |
| `src/args.ts`, `src/constants.ts`                                                                        | X87-5 repeatable `--pull-secret`                                                           |
| `src/devtool/dev-entry.ts`, `src/workspace/proto-toolchain.ts`, `src/commands/add-view.ts`               | X87-4 `--no-lock`                                                                          |
| `src/templates/full-stack-app-files.ts`, `src/workspace/dev-runner.ts`                                   | X87-2 member README, `Member` type                                                         |
| `src/commands/generate.ts`, `src/utils/module-switch.ts`, `src/utils/name-conflicts.ts`                  | X91-1                                                                                      |
| `src/utils/react-router-routes.ts`                                                                       | X87-1                                                                                      |
| `src/flags.ts`, `src/commands/plugin-commands.ts`                                                        | V11-15                                                                                     |
| `src/utils/agent-workspace-ownership.ts`                                                                 | V10-27 remainder                                                                           |
| `src/workspace/manifest.ts`, `src/commands/workspace.ts`, `src/commands/app.ts`, `src/commands/adopt.ts` | X87-2/X87-6 allocation and reallocate                                                      |
| `src/workspace/discovery-module.ts`                                                                      | `VITE_PORT`                                                                                |
| `src/templates/full-stack-build-files.ts`, `src/templates/project-files.ts`                              | dev entry render, `start:debug`, `cliCommand --no-lock`, Workers JSDoc, `.dev.vars` ignore |
| `src/workspace/compose.ts`                                                                               | X87-4 strip `@setu-ts/testing`                                                             |
| `src/commands/workspace-ops.ts`, `src/workspace/deploy-manifest.ts`                                      | X87-5                                                                                      |
| `src/agents/facts.ts`, `src/agents/render.ts`, rule blocks                                               | V11-9                                                                                      |
| `src/commands/agents.ts`, `src/commands/new.ts`, `src/examples/new.ts`                                   | X93-8                                                                                      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file (under `packages/cli/test/`)                                                                                                                                                                                                                                       | src covered                                                                                                                                       | Key assertions                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `unit/check-wiring.test.ts`, `unit/check-command.test.ts`                                                                                                                                                                                                                    | `wiring.ts`, `diagnose.ts`, `render.ts`                                                                                                           | §3.1, §3.2 — both X91-3 repros exit 1; one W001 with its line                                 |
| `unit/barrel-drift.test.ts`                                                                                                                                                                                                                                                  | `barrel-drift.ts`                                                                                                                                 | §3.1 imported-not-called registrar                                                            |
| `unit/devtool-sources.test.ts`                                                                                                                                                                                                                                               | `sources.ts`                                                                                                                                      | §3.2 table of stop reasons and offsets; exported results unchanged                            |
| `unit/diagnose.test.ts`, `unit/finding-ids.test.ts`                                                                                                                                                                                                                          | `diagnose.ts`, `ids.ts`, `artifact-scanner.ts`                                                                                                    | §3.3 W005 vs E001                                                                             |
| `unit/generate-module-switch.test.ts`, `unit/generate-module-command.test.ts`, `unit/utils/name-conflicts.test.ts`                                                                                                                                                           | `generate.ts`, `module-switch.ts`, `name-conflicts.ts`                                                                                            | §3.4                                                                                          |
| `unit/utils/react-router-routes.test.ts`, `unit/generate-page-collisions.test.ts`                                                                                                                                                                                            | `react-router-routes.ts`                                                                                                                          | §3.5                                                                                          |
| `unit/plugin-commands.test.ts`, `unit/flags.test.ts`                                                                                                                                                                                                                         | `plugin-commands.ts`, `flags.ts`                                                                                                                  | §3.6                                                                                          |
| `unit/commands/agents-ownership.test.ts`, `integration/agents-ownership.test.ts`                                                                                                                                                                                             | `agent-workspace-ownership.ts`                                                                                                                    | §3.7                                                                                          |
| `unit/allocate-port.test.ts`, `unit/reallocate.test.ts`, `unit/workspace/discovery-module.test.ts`, `unit/app-command.test.ts`, `unit/adopt-command.test.ts`                                                                                                                 | `manifest.ts`, `workspace.ts`, `discovery-module.ts`, `app.ts`, `adopt.ts`                                                                        | §3.9                                                                                          |
| `unit/full-stack-template.test.ts`, `unit/project-files-scripts.test.ts`, `unit/deno-tasks.test.ts`, `unit/templates/project-files.test.ts`                                                                                                                                  | `full-stack-build-files.ts`, `project-files.ts`                                                                                                   | §3.9, §3.10, §3.13                                                                            |
| `unit/dockerfile.test.ts`, `unit/workspace/compose.test.ts`                                                                                                                                                                                                                  | `compose.ts`                                                                                                                                      | §3.10 strip list                                                                              |
| `unit/workspace/deploy-manifest.test.ts`, `unit/commands/workspace-ops.test.ts`, `unit/k8s-manifest.test.ts`                                                                                                                                                                 | `deploy-manifest.ts`, `workspace-ops.ts`                                                                                                          | §3.11                                                                                         |
| `unit/utils/artifact-scanner.test.ts`, `unit/args.test.ts`, `unit/dev-entry.test.ts`, `unit/workspace/proto-toolchain.test.ts`, `unit/add-view.test.ts`, `unit/workspace-manifest.test.ts`, `unit/workspace/dev-runner.test.ts`, `unit/full-stack-template.test.ts` (README) | `artifact-scanner.ts`, `args.ts`, `constants.ts`, `dev-entry.ts`, `proto-toolchain.ts`, `add-view.ts`, `full-stack-app-files.ts`, `dev-runner.ts` | §3.3 `listingOnly`; §3.11 repeatable flag; §3.10 `--no-lock` per site; §3.9 fields and README |
| `unit/add-telemetry.test.ts`                                                                                                                                                                                                                                                 | `add.ts` (unchanged)                                                                                                                              | §3.12 workspace-root OTLP entry                                                               |
| `unit/agents/*` (gather-facts, render-brief, rule-blocks, budget), `unit/commands/agents-warning.test.ts`, `unit/new-command.test.ts`, `unit/examples.test.ts`                                                                                                               | `facts.ts`, `render.ts`, `agents.ts`, `new.ts`, `examples/new.ts`                                                                                 | §3.13                                                                                         |
| `unit/templates/style-baseline.test.ts` (fixture recapture)                                                                                                                                                                                                                  | generated output                                                                                                                                  | baseline recaptured once, diff read file by file                                              |
| `e2e/scaffold-runs-e2e.test.ts`, workspace e2e                                                                                                                                                                                                                               | generated projects                                                                                                                                | changed templates boot; two full-stack members ready in dev                                   |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m131c-cli-gates-generators-deploy
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check && pnpm exec tsc -b
pnpm run test:tooling
pnpm test:coverage packages/cli   # ANSI-stripped per-file table; ≥90% every touched src file
pnpm run ci:local --shard cli     # parallelism ≥2, on the final commit
pnpm run release:publish --dry-run && pnpm run release:verify <version>
```

Behavioural proofs, each run once on the final commit and recorded in the PR: the two X91-3 repros
and the three V11-8 repros through `setu check` on a fresh scaffold; the x91 `--adopt-controllers`
repro; an npm-workspace page collision; a two-member full-stack npm workspace under the root `dev`
script (both members answer at their allocated ports, both `start:debug` inspectors bind);
`check:deploy --generated` on Deno with the image's `node_modules/.deno` listed; a deploy dry run
with `--pull-secret` showing the plan line and the rendered `imagePullSecrets` (a real
authenticated-registry rollout needs a non-kind cluster and is not available locally — stated in the
PR).

## 8. Risks & mitigations

- X91-3 makes `check` fail projects that pass today → intended; every generated template calls its
  registrars, proven by the scaffold e2e running `check` on each template.
- Rewriting member `start:debug` on reallocate writes a user-owned manifest → exact-match only,
  otherwise a printed note (memory `cli-manifest-write-checklist`: never rewrite a shape we did not
  generate).
- `--no-lock` lets the CLI float within its range at check time → same contract as the Node `setu`
  binary; the project's runtime dependencies stay lock-pinned.
- The template baseline and stored briefs move → recapture once, read the diff per file, as M131b's
  CI failure taught (memory `m131b-state`).
- Security: §3.2 leaves the audited lexer's accept set unchanged (it only reports why it stopped);
  §3.11 handles a Secret NAME and never its data. No trust boundary is crossed, so no committed-tree
  security audit is planned; the maintainer may require one.

## 9. Out of scope

- A boot-time warning in `react-router-plugin` when a kernel route shadows a page (X91-4's complete
  fix) — no milestone yet.
- The deployment-guide walkthrough for an authenticated registry and the nested-peer explanation
  (M131d).
- Admitting `node:` imports or `globalThis` in the config lexer (would reopen its audit).
- Closing the DEFECTS rows (after the next published version).
