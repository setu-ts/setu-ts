# Milestone 111e2 — repository scripts and root tests on Node (repository tooling)

> **Status:** Planning. Branch: `feat/m111e2-node-scripts`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

M111e moves the repository's own tooling off the `deno` binary in three PRs. 111e1 (PR #455)
replaced the formatter and the linter. **111e2** (this plan) makes the repository's scripts run on
Node 24 and its root tests run under Vitest, and re-points the gates that were built on
`deno check`, `deno doc`, `deno test` and `deno coverage`. 111e3 rewrites CI, moves `apps/*` and the
website to pnpm, and removes the root `deno.json`/`deno.lock`. After 111e2, a repository gate needs
`deno` only where its SUBJECT is Deno: the Deno runtime adapter's proofs, the Deno-target scaffold
gate, the apps that still run on Deno, and the API HTML the website grafts in (both until 111e3).

The maintainer kept this as one milestone rather than splitting it (2026-10-15), with the API HTML
generator left for 111e3 and the doc-gate sandbox moved to a compensated Node subprocess.

- **In scope:**
  - Every `scripts/**/*.ts` that runs under `deno run` today runs under plain `node` (§3.1), with
    `Deno.*` replaced by `node:` modules through one shared subprocess helper (§3.3).
  - Root `package.json` scripts become the task surface. Every root `deno.json` task keeps its name
    and is re-pointed at `pnpm run <name>`, so no workflow, test pin or document changes (§3.2).
  - Root `test/` and `scripts/**/*.test.ts` move to Vitest (the 61 `@std/testing/bdd` files through
    the existing `scripts/codemods/std-to-vitest.ts`), joining the existing `tooling` Vitest member
    (§3.6).
  - Root script coverage moves to that member's Vitest per-file thresholds over the SAME measured
    set as today (§3.7). `script-coverage.ts`, `test-partition.ts`, `test-root-coverage.ts`,
    `coverage.ts` and the unreferenced `coverage-targeted.ts` are retired.
  - `deno task check` becomes `tsc` over package sources, package tests, `scripts/` and root
    `test/`, excluding the Deno-lane files, which `test:deno-lane` still type-checks (§3.8).
  - The JSDoc ratchet moves from `deno doc --lint` to typedoc validation, with its baseline
    re-measured (§3.9).
  - The README export tables move from `deno doc --json` to the TypeScript compiler API (§3.10).
  - The fence compilers move from `deno check` to the TypeScript compiler API (§3.11).
  - The prose-assertion and example-behaviour sandboxes move to a compensated `node --permission`
    subprocess (§3.5).
- **NOT this milestone:**
  - **111e3:** the workflows (`ci.yml`, `release.yml`, `drift.yml`, `website.yml`) and their
    `setup-deno` steps; removing the root `deno.json` and `deno.lock`; `apps/*` on pnpm and what
    `check:apps` spawns for them; `check:deploy`'s Deno images; `apps/compiled-binary`; the website
    and the API HTML generation it consumes (`docs:api` keeps calling `deno doc --html`, §3.9);
    `audit`/`audit:ci`, which audit `deno.lock` (§3.12).
  - **111f:** governing-document rewrites beyond the rules this change falsifies (C1, C2).
  - **Unchanged by design:** what the CLI generates; the Deno lane's tests and their runner's use of
    `deno test`/`deno coverage` (only the runner's own process moves to Node).

## 1. Contracts verified from SOURCE (not names)

| Reference                           | Source (file:line)                                                                                                                                        | Verified surface / fact                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node runs `.ts` scripts unflagged   | measured, Node v24.18.0                                                                                                                                   | `node m.ts` strips types with no flag; `import.meta.main` is `true` for the entry and `false` when imported; `import.meta.dirname` is set. No script under `scripts/` or `test/` uses non-erasable syntax (`enum`, parameter properties) — the grep hits are a string literal and comments                                                                |
| Node permission model               | measured, Node v24.18.0                                                                                                                                   | `node --permission` denies `node:fs` (`ERR_ACCESS_DENIED`) and `node:child_process` (`ERR_ACCESS_DENIED`). It does NOT gate network (`fetch` to a listening loopback port returned `200`) or environment (`process.env.HOME` readable); `--allow-net` is a bad option. TypeScript on stdin works: `--input-type=module-typescript -`                      |
| Deno usage inventory                | `grep` over `scripts/` and `test/`, 2026-10-15                                                                                                            | 66 `.ts` files under `scripts/`, 81 root test files. Top `Deno.*` uses: `readTextFile` 187, `exit` 73, `readDir` 56, `writeTextFile` 55, `Command` 55, `stat` 39, `mkdir` 37, `args` 31, `remove` 29, `env` 18, `execPath` 15, `errors` 14. 61 test files import `@std/testing/bdd`; 12 already import `vitest`                                           |
| Root task surface                   | `deno.json` `tasks`                                                                                                                                       | 38 tasks. 27 run `deno run scripts/*.ts`; `check` is `deno check packages`; `audit` is `deno audit`; `lint`, `fmt`, `fmt:check`, `check:compat` already run pnpm tools (111e1)                                                                                                                                                                            |
| Root `package.json` scripts         | `package.json:scripts`                                                                                                                                    | `test` and `test:coverage` run `deno run … scripts/test-node.ts`; `format`, `format:check`, `lint` run Prettier/ESLint                                                                                                                                                                                                                                    |
| Tooling Vitest member               | `scripts/codemods/node-test-config.ts:19-24,46-60`                                                                                                        | Member `tooling` already exists: tests = `test/node/**` + `scripts/codemods/**`; coverage include = `scripts/codemods/*.ts`, `test/node-helpers.ts`, `test/node-source-hooks.ts`, `scripts/pack-members.ts`, `scripts/registry-overlay.ts`; per-file 90% thresholds                                                                                       |
| Root script coverage set            | `scripts/script-coverage.ts` `SCRIPT_TARGETS`                                                                                                             | An explicit list of measured scripts (`side-effects`, `npm-release-gate`, `npm-placeholders`, `tar-read`, `check-docs`, `check-prose-assertions`, `check-example-behaviour`, `generate-api-docs`, `package-exports`, `npm-specifier-audit`, `version-sweep`, `check-since-tags`, …); the I/O seams beside them are deliberately absent                    |
| Deno lane runner                    | `scripts/test-deno-lane.ts`                                                                                                                               | Spawns `deno test` over `DENO_LANE_TESTS` and `deno coverage` over `DENO_ONLY_SOURCES`, and parses the table with `parseCoverageTable`/`validateTargetSet`/`belowThreshold` imported from `script-coverage.ts`                                                                                                                                            |
| Unreferenced script                 | `grep` for `coverage-targeted`                                                                                                                            | Referenced only by its own test (`test/unit/coverage-targeted.test.ts`); no task, workflow or document runs it                                                                                                                                                                                                                                            |
| `deno doc` consumers                | `scripts/generate-api-docs.ts:5-7,534-537`; `scripts/package-export-collection.ts:67-68`                                                                  | `generate-api-docs.ts` runs `deno doc --html` (generate mode) and `deno doc --lint` (`--check`, the ratchet: `DOC_LINT_BASELINE = 496` at line 95, `DOC_LINT_BASELINE_DENO = '2.9.6'` at 127, `CLEAN_PACKAGES` at 29). `package-export-collection.ts` runs ONE `deno doc --json` over every barrel for the README tables                                  |
| API HTML consumer                   | `website/package.json:12`; `website/scripts/graft.mjs:8-12`                                                                                               | The website build runs `deno task docs:api` and grafts the `deno doc` HTML into the site                                                                                                                                                                                                                                                                  |
| typedoc compatibility               | `npm view typedoc@0.28.20 peerDependencies`                                                                                                               | `typescript: 5.0.x … 5.9.x \|\| 6.0.x`; the repository's TypeScript is 6.0.3                                                                                                                                                                                                                                                                              |
| typedoc vs `deno doc --lint`        | measured per package, `--validation.notExported --validation.notDocumented`                                                                               | `realtime-backplane-plugin`: deno 0, typedoc 0. `graphql-plugin`: deno 0, typedoc 44. `common`: deno 0, typedoc 90 — typedoc also reports undocumented members of union arms (`FilterComparison.__type.field`). The counts are not comparable, so the baseline is re-measured, as ROADMAP §111e requires                                                  |
| Fence compiler                      | `test/fixtures/snippets/fence-engine.ts:1093-1094`; `test/fixtures/snippets/deno.json`                                                                    | `deno check --config test/fixtures/snippets/deno.json <file>`; that config sets `strict`, `exactOptionalPropertyTypes`, `jsx: react-jsx`, `jsxImportSource: hono/jsx`, and maps every `@setu-ts/*` to `packages/*/src/index.ts`                                                                                                                           |
| Sandboxed gates                     | `scripts/check-prose-assertions.ts:233-234`; `scripts/check-example-behaviour.ts:1010-1011`                                                               | Prose assertions: `deno run --no-prompt --ext=ts -` (no permissions). Example behaviour: `deno run --config … --allow-read --no-prompt <probe>`                                                                                                                                                                                                           |
| Type-checking package tests         | measured: `tsc --noEmit` over `packages/*/test/**/*.ts` with the base options                                                                             | 118 errors: 86 in `DENO_LANE_TESTS` files (`Deno` is undefined to `tsc`), 32 in 19 other files (`common` ×3, `database-plugin` ×5, `telemetry-plugin` ×3, `decorator-plugin`, `exceptions`, `grpc-plugin`, `idempotency-plugin`, `runtime`, `sdk`, `websocket-plugin`, and `apps/realtime-clients/src/app.ts` reached from a test)                        |
| Deno lane type-checks itself        | `scripts/test-deno-lane.ts`                                                                                                                               | `deno test` type-checks every file it runs and their imports; the runner passes no `--no-check`                                                                                                                                                                                                                                                           |
| Example-behaviour probe             | `scripts/check-example-behaviour.ts:665-667,935-937`                                                                                                      | The probe is `.tmp/example-behaviour/probe.tsx` with `@jsxImportSource @hono/hono/jsx`, importing `@hono/hono/html` and the view plugin's source; its config is `test/fixtures/snippets/deno.json`. Node's type stripping does not accept JSX                                                                                                             |
| Fence imports outside the workspace | `test/fixtures/snippets/deno.json` `imports`; `grep` of docs and READMEs                                                                                  | The import map maps `hono`, `hono/`, `@hono/hono` (JSR), `zod` (`^3.23.8`), `@std/testing/bdd` and `@std/expect`. Fences in `docs/migration-nestjs.md`, `docs/getting-started.md`, `PUBLIC_API.md` and the config/graphql/messaging READMEs import `npm:zod@^3.24.0`, `npm:graphql@^16`, `npm:drizzle-orm@^0.45.2/pg-core`; one imports `@hono/hono/html` |
| Root `node_modules`                 | measured                                                                                                                                                  | Only `@hono/node-server` among those is installed at the root; `hono`, `zod`, `graphql`, `drizzle-orm` are installed under members only (pnpm does not hoist them)                                                                                                                                                                                        |
| Range table                         | `scripts/node-dependency-ranges.ts:30-31,36,72-73,82`                                                                                                     | `hono: '^4.12.30'`, `drizzle-orm: '0.45.2'`, `graphql: '^16'`, `zod: '^4.4.0'`, plus `zod-v3: 'npm:zod@^3.24.0'`                                                                                                                                                                                                                                          |
| Fence compile assertions            | `test/fixtures/snippets/fence-engine.ts:1090-1101`; `test/decorator-fence-compiler.test.ts:101-136`; `test/package-readme-fence-compiler.test.ts:264-268` | Three separate `denoCheck` copies. Every assertion reads the exit code; stderr is only printed into the failure message                                                                                                                                                                                                                                   |
| Workspace imports from scripts      | `grep` of bare specifiers in `scripts/` and `test/`                                                                                                       | `@setu-ts/*` (resolved to source by the Vitest `sourceExport` plugin and by `test/node-source-register.ts` for code Node loads directly), `@std/testing/bdd`, `@std/expect`, `@std/jsonc` (one test), `typescript`, `esbuild`, `node:*`                                                                                                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                      | Resolution (picked side)                                                                   | Doc deliverable (same PR)                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| C1  | `AI_GUIDELINES.md:373` and CLAUDE.md "Key conventions" say root tests use `@std/testing/bdd` and run through `deno task test` until M111e; this PR moves them | The code (Vitest) wins; the rule is falsified by this PR                                   | Both sites rewritten to say root tests use `vitest` and run in the `tooling` member                    |
| C2  | CLAUDE.md "Verification" says `deno task test:coverage` measures root tooling through Deno, with a separate root-script gate (`scripts/script-coverage.ts`)   | The Vitest per-file thresholds replace it                                                  | The Verification paragraph rewritten: one `tooling` coverage report, enforced by Vitest's nonzero exit |
| C3  | `generate-api-docs.ts` JSDoc ties the ratchet to `DOC_LINT_BASELINE_DENO` and the CI `deno-version` pin                                                       | The baseline is re-measured on a pinned typedoc version; the Deno pin no longer governs it | Module JSDoc and `docs/releasing.md`'s `check:api-docs` paragraph name the typedoc pin                 |
| C4  | `test/deno-lane/` and `DENO_LANE_TESTS` define the Deno-only suites; `test/inspect-local-diagnostics.test.ts` also needs Deno but is not listed               | A suite whose subject needs the Deno runtime joins the lane                                | `scripts/test-lanes.ts` gains it; the lane comment says why                                            |

## 3. Design decisions

### 3.1 Script runtime: plain `node` with native type stripping

- **Decision:** every script runs as `node scripts/<name>.ts`, relying on Node 24's built-in type
  stripping (measured, §1). No `tsx`, no compile step. The `#!/usr/bin/env -S deno run …` shebangs
  become `#!/usr/bin/env node`. `import.meta.main` keeps guarding the entry point. A script that
  imports a workspace package by name runs with `--import ./test/node-source-register.ts`, the hook
  that already maps `@setu-ts/*` to source.
- **Why:** it adds no dependency, and `tsx` would hide a non-erasable construct that the published
  build's `isolatedDeclarations` configuration would also refuse.
- **Test home:** `test/node/script-entrypoints.test.ts` runs every script that has a `--help` or
  argument-free mode with `node`, asserting a zero exit and no `Deno is not defined`.

### 3.2 Task surface: root `package.json` scripts, `deno.json` tasks re-pointed

- **Decision:** each runnable task becomes a root `package.json` script under its EXISTING name
  (`check:docs`, `release:verify`, …), written by `scripts/node-manifests.ts` like the scripts 111e1
  added. Each `deno.json` task of the same name becomes `pnpm run <name>`, the 111e1 precedent, so
  every workflow, test pin and document that says `deno task <name>` keeps working until 111e3
  deletes `deno.json`. A task's arguments are forwarded (`pnpm run x -- args`).
- **The one exception is the test pair, because the two manifests already disagree on its meaning.**
  `deno task test`/`test:coverage` mean the ROOT tooling suite; `pnpm test`/ `pnpm test:coverage`
  mean every member plus tooling, through `node scripts/test-node.ts`. Re-pointing the Deno names at
  the same pnpm names would silently widen two gates. So the `package.json` scripts `test:tooling`
  and `test:tooling:coverage` run the tooling member alone, and `deno task test`/`test:coverage`
  point at those. `pnpm test`/`pnpm test:coverage` keep their meaning and change only from
  `deno run` to `node`.
- **Why:** 111e3 rewrites the workflows. Changing every caller now would duplicate that work and
  cause two rounds of churn in the same files.
- **Test home:** `test/node/task-surface.test.ts` asserts, from the two manifests, that every
  `deno.json` task except the 111e3 set (§3.12) and the test pair is exactly `pnpm run <same name>`,
  that the named `package.json` script exists, and that the test pair maps to
  `test:tooling`/`test:tooling:coverage`.

### 3.3 One subprocess and filesystem idiom

- **Decision:**
  - `Deno.Command` becomes one internal helper, `scripts/lib/run.ts`, exporting
    `run(command, args, { cwd?, env?, stdin?, timeoutMs?, inherit? })`. It returns
    `{ code, stdout, stderr }`, and when `timeoutMs` elapses it kills the child's process group.
  - File access uses `node:fs/promises`. `Deno.errors.NotFound` checks become `code === 'ENOENT'`
    through one `isNotFound(error)` helper in the same module.
  - `Deno.args` becomes `process.argv.slice(2)`. `Deno.exit(n)` becomes `process.exitCode = n`
    followed by a return at the entry point; a library function never exits.
- **Why:** 55 `Deno.Command` sites each hand-rolled their own decoding. One helper gives one
  behaviour for stderr capture and timeouts, rather than 55 slightly different ones.
- **Test home:** `test/unit/run.test.ts` covers inherit and capture, a nonzero exit, `ENOENT` for a
  missing binary, and that a timeout kills the child (a `node -e 'setInterval(()=>{},1e3)'` child is
  gone after the timeout).

### 3.4 Permissions for trusted scripts are dropped

- **Decision:** scripts that ran with `--allow-*` flags run with none under Node. The exceptions are
  the two gates that evaluate document-supplied code (§3.5).
- **Why:** these scripts are the repository's own reviewed code. The flags were defence in depth,
  and the Node permission model cannot express their network scoping anyway (§1).
- **Test home:** none. This is the absence of a mechanism, recorded in the plan's design security
  review (§10).

### 3.5 Sandboxed evaluation: compensated `node --permission`

- **Decision:**
  - **Prose assertions** evaluate each document's expression batch in
    `node --permission --input-type=module-typescript -` with `env: {}` and a wall-clock timeout.
    The child grants itself nothing; with no `--allow-fs-read` it cannot read the repository. The
    expressions run inside a `node:vm` context whose globals are `JSON`, `Math`, `Number`, `String`,
    `Array`, `Object` and `Boolean` — no `fetch`, no `process`, no `require`.
  - **Example behaviour** keeps generating `probe.tsx`, now with `@jsxImportSource hono/jsx` and
    `import { html } from 'hono/html'`. Node cannot strip JSX, so esbuild (already a root dev
    dependency) transforms it to `probe.mjs` (`jsx: automatic`, `jsxImportSource: hono/jsx`, no
    bundling), in the same scratch directory. The probe runs as
    `node --permission --allow-fs-read=<repository> --import ./test/node-source-register.ts probe.mjs`
    with `env: {}`. `hono` resolves from the root dev dependency added in §3.11.
  - Both keep their existing fail-closed rules: a timeout, a nonzero exit or a short result batch is
    a failure.
- **Why:** Deno denied network and environment by default; Node 24 gates neither (§1). The empty
  environment closes the environment half. The `vm` context removes `fetch` from the expressions'
  reach; a `vm` escape could still reach the host's `fetch`, which is accepted because the inputs
  are reviewed Markdown committed to this repository (maintainer decision, 2026-10-15).
- **Test home:**
  - `test/prose-assertion-gate.test.ts` (existing, converted) plus new cases: an expression reading
    `process.env.HOME` fails; one calling `fetch` fails as undefined; one reading a file fails with
    `ERR_ACCESS_DENIED`; one that never ends fails on the timeout.
  - `test/example-behaviour-gate.test.ts` gains the same file-write and environment cases.

### 3.6 Root tests run in the `tooling` Vitest member

- **Decision:**
  - The 61 `@std/testing/bdd` files are converted by `scripts/codemods/std-to-vitest.ts`, the M111b
    codemod; its `--check` mode still refuses an unawaited async assertion. Hand conversion is only
    for what the codemod reports it cannot convert.
  - `projectsFor('tooling')` widens to every `*.test.ts` under `test/` (except `test/deno-lane/`)
    and under `scripts/`.
  - A test that spawned `deno run scripts/x.ts` spawns `node scripts/x.ts`. A test whose subject is
    the Deno runtime moves to `DENO_LANE_TESTS` (C4).
  - The one `@std/jsonc` use (`test/unit/node-manifests.test.ts`) parses JSONC with TypeScript's
    `ts.parseConfigFileTextToJson`.
  - `vitest.config.ts`'s `SETU_TEST_MEMBER=tooling` run is the root suite; `deno task test` runs it
    through `pnpm run test:tooling`.
- **Why:** the member already exists, with the isolation partition and the per-file thresholds; a
  second Vitest configuration would be a second partition rule.
- **Test home:**
  - `test/node/vitest-config.test.ts` (existing): the widened member includes a known root test and
    a `scripts/**` test, and excludes `test/deno-lane/`.
  - A swap report in the PR (the M111b `swap-report` precedent) compares leaf counts per file before
    and after the conversion, and must show no lost leaf.

### 3.7 Coverage: Vitest thresholds over the same measured set

- **Decision:**
  - The `tooling` member's coverage `include` becomes today's include plus every `SCRIPT_TARGETS`
    entry. The set is kept, not widened; a test asserts set equality against a frozen copy of
    `SCRIPT_TARGETS` taken before deletion.
  - Per-file 90% branch, function and line, enforced by Vitest's nonzero exit.
  - `script-coverage.ts`, `test-partition.ts`, `test-root-coverage.ts`, `coverage.ts` and
    `coverage-targeted.ts` (with its test) are deleted.
  - `parseCoverageTable`, `validateTargetSet` and `belowThreshold`, which the Deno-lane runner still
    needs for `deno coverage` output, move to `scripts/deno-lane-coverage.ts`.
  - `test-partition-rules.ts` stays, because `node-test-config.ts` reads it.
- **Why:** M111b made the package gate a failing exit code; the root gate gets the same instead of a
  parsed table. Keeping the set fixed means this PR changes the gate's mechanism and nothing else.
- **Test home:**
  - `test/node/vitest-config.test.ts` asserts the `tooling` coverage include equals the frozen set.
  - `test/unit/deno-lane-coverage.test.ts` takes over the moved helpers' cases from
    `test/script-coverage.test.ts`.

### 3.8 `check` is `tsc`

- **Decision:**
  - `deno task check` and the new `package.json` `check` script run
    `tsc -p tsconfig.check.json --noEmit`.
  - `tsconfig.check.json` extends `tsconfig.base.json` (non-composite, no declarations,
    `allowImportingTsExtensions`, the snippets' `jsx` settings) and includes `packages/*/src`,
    `packages/*/test`, `packages/starters/*/{src,test}`, `scripts/` and root `test/`.
  - It excludes `DENO_LANE_TESTS`, `DENO_ONLY_SOURCES`, `test/deno-lane/` and the
    `test/fixtures/snippets/` fence files (those are compiled by the fence compiler, §3.11). The
    lists are imported from `scripts/test-lanes.ts`, never retyped, through a generated
    `tsconfig.check.json`.
  - The excluded files stay type-checked by the Deno lane: `deno test` checks every file it runs and
    their imports (§1), so the lane runner must never pass `--no-check`.
  - The 32 non-lane errors in 19 files measured in §1 are fixed in source.
- **Why:** `deno check packages` is the gate that caught test-file type errors Vitest never checks
  (M111d). Dropping it would remove that, and `tsc -b` covers only `src`.
- **Test home:** `test/node/check-config.test.ts` asserts the generated exclude list equals
  `DENO_LANE_TESTS ∪ DENO_ONLY_SOURCES` (plus the two directories), and that the deno-lane runner's
  arguments never contain `--no-check`.

### 3.9 JSDoc ratchet: typedoc validation, baseline re-measured; HTML stays on `deno doc`

- **Decision:**
  - `check:api-docs` runs typedoc 0.28.20, pinned exactly as a root dev dependency, once over every
    published entry point's SOURCE file, through a dedicated `typedoc.check.json`. That config uses
    a tsconfig whose `paths` map `@setu-ts/*` to `packages/*/src` so cross-package public types
    resolve, with `--emit none` and `validation.notExported` + `validation.notDocumented` (and
    `invalidLink` off).
  - The diagnostic count is compared with a new `DOC_LINT_BASELINE`, measured on this branch.
    `DOC_LINT_BASELINE_TYPEDOC` records `0.28.20` and replaces `DOC_LINT_BASELINE_DENO`.
  - `CLEAN_PACKAGES` is re-derived as the packages with zero typedoc diagnostics; any package in
    today's set that typedoc reports is listed in the PR, not silently dropped. A below-baseline run
    still fails with "lower the constant".
  - **Generate mode (`docs:api`) keeps spawning `deno doc --html`** until 111e3 moves the website.
- **Why:** typedoc supports TypeScript 6.0 and reports both rules the ratchet enforced
  (`private-type-ref` ≈ `notExported`, `missing-jsdoc` ≈ `notDocumented`); `isolatedDeclarations`
  already enforces return types. Its counts differ from Deno's (§1), so the number is measured, not
  carried. Moving the HTML now would change the website's input, which belongs to 111e3 (maintainer
  decision).
- **Test home:** `test/api-docs-generation.test.ts` (converted) feeds the parser recorded typedoc
  output; a new case fails when the count exceeds the baseline, when it is lower, and when the
  typedoc version differs. A negative control in the PR deletes one JSDoc from a `CLEAN_PACKAGES`
  export and shows the gate fail.

### 3.10 README export tables: the TypeScript compiler API

- **Decision:**
  - `package-export-collection.ts` builds one `ts.Program` over every barrel, with the same `paths`
    mapping as §3.9, and lists each barrel's exports with `checker.getExportsOfModule`, following
    aliases to the declaring symbol.
  - Declaration kinds map from `ts.SymbolFlags` onto the existing table words in
    `package-exports.ts`.
  - The pure table renderer in `package-exports.ts` is unchanged except for its input type.
- **Why:** `typescript` is already a dependency, and the compiler API resolves re-exports
  deterministically. typedoc's JSON would add a second model of the same program.
- **Test home:**
  - The acceptance test is `pnpm run docs:exports` on the unmodified tree producing **no README
    diff**, recorded in the PR.
  - `test/unit/package-export-collection.test.ts` (new) covers kind mapping for each table word, a
    re-export through two barrels, a type-only export, and a namespace export, over a fixture
    program.

### 3.11 Fence compilers: the TypeScript compiler API

- **Decision:**
  - **One compiler.** `fence-engine.ts`'s `denoCheck` becomes `compileFence(file)`, built on
    `ts.createProgram`, and the two other copies (in `decorator-fence-compiler.test.ts` and
    `package-readme-fence-compiler.test.ts`) are deleted in favour of it.
  - **Options** come from `test/fixtures/snippets/tsconfig.json`, which replaces `deno.json` there.
    It carries the same strictness and JSX options (`jsxImportSource: hono/jsx`) plus `paths` for
    every `@setu-ts/*` entry the old import map had.
  - **Specifier normalisation.** A fence is compiled as written except for one rewrite applied by
    `compileFence` before compiling: `npm:<name>@<range>[/<sub>]` becomes `<name>[/<sub>]`, and
    `@hono/hono[/<sub>]` becomes `hono[/<sub>]`. These are the Deno spellings the docs still use
    until 111f rewrites them; the docs are not edited here.
  - **Third-party resolution.** `hono`, `zod`, `graphql` and `drizzle-orm` become root dev
    dependencies, written by `node-manifests.ts`. Their versions come from the range table, except
    `zod`, which takes the `zod-v3` range (`^3.24.0`) that the fences and the old import map pin.
  - **Results.** A compile passes when the program has no error diagnostics. The failure message
    carries `ts.formatDiagnostics` output, keeping the current "exit code decides, text explains"
    behaviour (§1).
  - **Negative controls.** The existing ones (the banned `app.get()` family and B9) must still fail.
  - **Apps.** `scripts/check-apps.ts` keeps `deno check` until 111e3, because that is the apps'
    runtime.
- **Why:** one in-process program per fence replaces a subprocess per fence and three copies of the
  same call. Normalising specifiers rather than editing the documents keeps 111e2 a tooling change;
  root dev dependencies are the only way a scratch file in `.tmp/` resolves them under pnpm (§1).
- **Test home:**
  - The five fence test files (`guide-fence-compiler`, `decorator-fence-compiler`,
    `package-readme-fence-compiler`, `snippet-validation`, `fence-engine-imports`) keep every
    expected fence count and outcome, and every existing negative control still fails. The
    fail-then-pass pair is shown in the PR.
  - `test/unit/fence-specifiers.test.ts` (new) covers the rewrite: `npm:zod@^3.24.0`,
    `npm:drizzle-orm@^0.45.2/pg-core`, `@hono/hono/html`, a relative import left alone, and an
    `npm:` string inside a comment left alone.

### 3.12 What still spawns `deno` after this PR

- **Decision:** exactly these, each named in `test/node/task-surface.test.ts` as the 111e3 set:
  - `docs:api` / `release:docs` (`deno doc --html`);
  - `check:apps` (`deno check` / `deno task` per app);
  - `check:deploy` / `deploy:render` (Deno images);
  - `audit` / `audit:ci` (`deno audit` over `deno.lock`);
  - `test:deno-lane` (`deno check`, `deno test`, `deno coverage`);
  - `fmt` / `fmt:check`'s SDK fixture step (`deno fmt`, the generator's target, 111e1 §3.4);
  - `scripts/inspect-local-diagnostics.ts`, whose subject is the Deno-only diagnostics listener.

  Each script's own process is `node`; only the child it spawns is `deno`.

- **Why:** each one's subject is Deno or a Deno-built artifact that 111e3 owns.
- **Test home:** `test/node/task-surface.test.ts` asserts the list, so a new `deno` dependency fails
  the test rather than accumulating.

### 3.13 JSR scripts are ported, not retired

- **Decision:** `create-jsr-packages.ts`, `link-jsr-repos.ts`, `set-jsr-metadata.ts`,
  `verify-jsr-repos.ts`, `archive-old-scope.ts` and `jsr-metadata.ts` are ported like every other
  script.
- **Why:** 111f's JSR sunset rewrites each JSR package's README and description through them.
- **Test home:** their existing tests, converted (§3.6).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. No published package's `src/index.ts`, manifest export or type
changes; this PR touches repository tooling and the 32 test-file type errors found by §3.8.

| Exported symbol                                                     | Kind            | Consumer / real code path that READS it                                    |
| ------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------- |
| `run`, `isNotFound` (`scripts/lib/run.ts`)                          | internal fn     | every ported script that spawns a process or reads an optional file (§3.3) |
| `parseCoverageTable`, `validateTargetSet`, `belowThreshold` (moved) | internal fn     | `scripts/test-deno-lane.ts` (§3.7)                                         |
| `DOC_LINT_BASELINE`, `DOC_LINT_BASELINE_TYPEDOC`, `CLEAN_PACKAGES`  | internal const  | `generate-api-docs.ts --check` (§3.9)                                      |
| `compileFence`, `normaliseFenceSpecifiers` (`fence-engine.ts`)      | test-fixture fn | the five fence test files (§3.11); the normaliser also by `compileFence`   |

### 4.1 Options — every option names its consumer

| Option                      | Consumer                        | Behavior (per implementation)                                      |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `run(…, { timeoutMs })`     | sandboxed gates, `check-apps`   | kills the child's process group at the deadline; result `code` 124 |
| `run(…, { inherit: true })` | test and gate runners           | child stdio inherited; `stdout`/`stderr` returned empty            |
| `run(…, { env })`           | sandboxed gates, `test-node.ts` | replaces the child's environment entirely (never merged)           |

## 5. Implementation files

| File                                                                                                                                | Purpose                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/lib/run.ts`                                                                                                                | the one subprocess helper and `isNotFound` (§3.3)                                                                                                                          |
| every `scripts/*.ts` listed in §1 that uses `Deno.*`                                                                                | ported to `node:` modules and `run` (§3.1, §3.3)                                                                                                                           |
| `scripts/check-prose-assertions.ts`, `scripts/check-example-behaviour.ts`                                                           | compensated Node sandbox (§3.5)                                                                                                                                            |
| `scripts/generate-api-docs.ts`, `typedoc.check.json`, `tsconfig.docs.json`                                                          | typedoc ratchet; HTML generation unchanged (§3.9)                                                                                                                          |
| `scripts/package-export-collection.ts`, `scripts/package-exports.ts`                                                                | TS compiler API exports (§3.10)                                                                                                                                            |
| `test/fixtures/snippets/fence-engine.ts`, `test/fixtures/snippets/tsconfig.json`                                                    | one TS compiler API fence compiler with specifier normalisation; `deno.json` there removed; the two test-local `denoCheck` copies deleted (§3.11)                          |
| `tsconfig.check.json` (generated), `scripts/node-manifests.ts`                                                                      | `check` on tsc; manifest generator writes the new scripts and the check config (§3.2, §3.8)                                                                                |
| `scripts/codemods/node-test-config.ts`                                                                                              | `tooling` member widened; coverage include + frozen set (§3.6, §3.7)                                                                                                       |
| `scripts/deno-lane-coverage.ts`, `scripts/test-deno-lane.ts`, `scripts/test-lanes.ts`                                               | moved helpers, Node runner, lane gains `deno check` and C4's suite                                                                                                         |
| deleted: `scripts/script-coverage.ts`, `test-partition.ts`, `test-root-coverage.ts`, `coverage.ts`, `coverage-targeted.ts` (+ test) | replaced by Vitest thresholds (§3.7)                                                                                                                                       |
| `deno.json`, `package.json`                                                                                                         | tasks re-pointed / scripts added (§3.2); dev dependencies `typedoc` (exact `0.28.20`), `hono`, `zod` (`^3.24.0`), `graphql`, `drizzle-orm`, written by `node-manifests.ts` |
| the 19 files carrying the 32 type errors                                                                                            | fixed in source (§3.8)                                                                                                                                                     |
| `AI_GUIDELINES.md`, `CLAUDE.md`, `docs/releasing.md`, `ROADMAP.md`, `CHANGELOG.md`                                                  | C1–C3; ROADMAP 111e2 row and status; CHANGELOG `Unreleased` entry (repository tooling only)                                                                                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                         | src covered                     | Key assertions                                                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `test/unit/run.test.ts` (new)                                                                     | `scripts/lib/run.ts`            | capture vs inherit; nonzero exit; `ENOENT`; timeout kills the group; `env` replaces                        |
| `test/node/script-entrypoints.test.ts` (new)                                                      | every ported entry point        | `node <script> --help` (or argument-free) exits 0; no `Deno is not defined`                                |
| `test/node/task-surface.test.ts` (new)                                                            | `deno.json`, `package.json`     | every re-pointed task is `pnpm run <name>` with a matching script; the §3.12 deno set is exact             |
| `test/node/check-config.test.ts` (new)                                                            | generated `tsconfig.check.json` | exclude list equals the lane lists; deno-lane runner runs `deno check`                                     |
| `test/node/vitest-config.test.ts` (extended)                                                      | `node-test-config.ts`           | widened test globs; coverage include equals the frozen pre-deletion set                                    |
| `test/unit/deno-lane-coverage.test.ts` (moved cases)                                              | `scripts/deno-lane-coverage.ts` | table parsing, target-set validation, threshold rows                                                       |
| `test/prose-assertion-gate.test.ts`, `test/example-behaviour-gate.test.ts` (converted + extended) | the two sandboxed gates         | existing cases; env, fetch, file read and timeout each fail closed                                         |
| `test/api-docs-generation.test.ts` (converted + extended)                                         | `generate-api-docs.ts`          | typedoc output parsing; above/below baseline; version mismatch; clean-package violation                    |
| `test/unit/package-export-collection.test.ts` (new)                                               | `package-export-collection.ts`  | kind mapping per table word; double re-export; type-only; namespace                                        |
| the five fence test files (converted)                                                             | `fence-engine.ts`               | every expected fence count and outcome kept; every existing negative control still fails                   |
| `test/unit/fence-specifiers.test.ts` (new)                                                        | `normaliseFenceSpecifiers`      | `npm:` with range and subpath, `@hono/hono/html`, relative import untouched, `npm:` in a comment untouched |
| `test/unit/check-since-tags.test.ts` (converted + extended)                                       | `check-since-tags.ts`           | the injected fetch is called only for `jsr.io` and `registry.npmjs.org` hosts; decompression cap kept      |
| every other root test (converted by codemod)                                                      | the script it already covers    | unchanged assertions; swap report shows no lost leaf                                                       |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m111e2-node-scripts
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check             # now tsc (§3.8)
deno task test              # now the tooling Vitest member
pnpm test && pnpm test:coverage
deno task test:deno-lane
deno task check:docs && deno task check:api-docs
pnpm run docs:exports && git diff --exit-code -- '*.md'   # §3.10 acceptance: no README diff
deno task release:publish --dry-run && deno task release:verify 0.9.0
```

Plus, recorded in the PR: the swap report (§3.6); the frozen coverage-set equality (§3.7); the
re-measured typedoc baseline and clean set with any package that left the set named (§3.9); and
these negative controls, each observed failing and then reverted:

1. Remove one JSDoc from a `CLEAN_PACKAGES` export → `check:api-docs` fails.
2. Restore a `Deno.exit` call in a ported script → `script-entrypoints` fails.
3. Point a fence at the banned `app.get()` → the fence compiler fails.
4. Give a prose expression `process.env.HOME` → the gate fails.
5. Add a script to the coverage include → the frozen-set test fails.
6. Introduce a type error in a package test → `check` fails.

## 8. Risks & mitigations

- **The codemod loses a test.** Mitigated by the swap report's leaf-count comparison per file; any
  lost leaf blocks the PR, as in M111b.
- **typedoc's count is unstable across versions.** Mitigated by pinning `0.28.20` exactly and
  failing on a version mismatch, which `deno doc` already required.
- **A fence that `deno check` accepted fails under `tsc`, or the reverse.** The two compilers
  resolve modules differently. Mitigated by keeping every fence's outcome as acceptance: a
  disagreement is investigated and the fence or the option fixed, never the expectation.
- **A ported script silently changes behaviour** (an error path through `process.exitCode`).
  Mitigated by the existing tests plus the entry-point test, and by running every release and doc
  task once by hand on the branch, with the outputs compared to `develop`'s.
- **The fences pin zod 3 while the packages use zod 4.** The old import map already did this, so
  parity is kept rather than changed; a fence that only compiled because of a version mismatch is
  out of scope and recorded in the PR if found.
- **Concurrent runs.** The suite and the gates bind ports. A smoke-exercise session may run on this
  machine at the same time, so no suite runs while one does.

## 9. Out of scope

- Workflows, the root `deno.json`/`deno.lock` removal, `apps/*`, `apps/compiled-binary`,
  `check:deploy`'s images, the website and its API HTML, and `audit` — **111e3**.
- Governing-document rewrites beyond C1–C3, and the JSR sunset itself — **111f**.
- Widening the measured script-coverage set (§3.7) — a separate decision.
- Anything a generated project contains — unchanged.

## 10. Design security review

| Boundary                               | Before                                      | After                                                                            | Residual risk / decision                                                                                                                |
| -------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Prose-assertion expressions (Markdown) | `deno run` with no permissions              | `node --permission`, no grants, `env: {}`, timeout, `vm` context with no `fetch` | network reachable through a `vm` escape; accepted, because the inputs are reviewed Markdown in this repository (maintainer, 2026-10-15) |
| Example-behaviour probe                | `deno run --allow-read`                     | `node --permission --allow-fs-read=<repo>`, `env: {}`, timeout                   | network not gated; accepted on the same basis; no write and no child process                                                            |
| Trusted repository scripts             | scoped `--allow-*` flags                    | unrestricted `node`                                                              | loss of defence in depth for the repository's own code; release scripts touching npm/JSR are unchanged in what they call                |
| Registry tarball reads (`@since` gate) | Deno with `--allow-net` scoped to two hosts | Node `fetch`, hosts fixed in code; the 64 MiB decompression cap kept             | host scoping is now by code rather than by flag; `test/unit/check-since-tags.test.ts` asserts only the two hosts are fetched            |

A committed-tree security audit runs before merge, per CLAUDE.md, because the two sandboxed gates
cross a trust boundary.
