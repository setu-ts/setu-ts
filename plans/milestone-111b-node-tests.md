# Milestone 111b — The Test Suite on Node (every member)

> **Status:** Planning. Branch: `feat/m111b-node-tests`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Every package test suite runs on Node 24 under Vitest, with the per-file 90% branch/function/line
bar enforced by the runner's exit code, while the repository stays green at every commit. Deno stays
a supported RUNTIME (M111 decision), so the tests that prove Deno-only behaviour keep running on
Deno through a second, named lane over the SAME converted files. The boundary: package tests move;
the root `test/` directory and the `scripts/` it tests stay on Deno until 111e moves the scripts.

- **In scope:**
  - a committed codemod (`@std/testing/bdd` + `@std/expect` → `vitest`, plus the test-side `npm:` /
    `jsr:` specifiers → bare names) and its run over `packages/**/test`;
  - hand conversion of the 191 package test files that use `Deno.*`;
  - a Vitest configuration with the TC39-decorator transform, `@setu-ts/*` source resolution, the
    shared-resource isolation rule, and per-file coverage thresholds;
  - a Deno lane (an import-map shim over the converted files) for the Deno-only tests and sources;
  - a per-file test-count parity check against the last Deno run, and a per-file coverage
    comparison;
  - the CI, task and governing-document changes that follow.
- **NOT this milestone:**
  - the root `test/` suite and `scripts/*.ts` (111e moves scripts off Deno; their tests move with
    them);
  - npm publishing (111c);
  - Prettier/ESLint replacing `deno fmt`/`deno lint` (111d);
  - removing `deno.json` files and the Deno import maps (111f) — this milestone's resolution plugin
    reads them and is retired with them;
  - a Node implementation of the local diagnostics listener (M98b ships it Deno-only by design; a
    Node transport is a feature, not part of a toolchain move).

## 1. Contracts verified from SOURCE (not names)

Every row below was measured on `develop` at `c7b73db3` (M111a merged), in a probe workspace built
with `git archive` + `pnpm install --frozen-lockfile` + Vitest 5.0.3, `@vitest/coverage-v8` 5.0.3
and esbuild 0.28.2 — not carried over from the pre-111a prep.

| Reference                                  | Source (file:line)                                                               | Verified surface / fact                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vitest's transformer and TC39 decorators   | probe, Vitest 5.0.3 on Vite 8 / rolldown / oxc                                   | oxc implements LEGACY decorators only; a standard decorator reaches Node untransformed and fails with `SyntaxError: Invalid or unexpected token`. The ROADMAP's "esbuild does" premise is stale — Vitest no longer transforms with esbuild. An `enforce: 'pre'` Vite plugin calling esbuild's `transform` (`target: 'es2022'`) lowers them and runs the suite. |
| esbuild under pnpm 12                      | `pnpm-workspace.yaml:61` (`allowBuilds`)                                         | `pnpm add esbuild` fails with `ERR_PNPM_IGNORED_BUILDS` until `allowBuilds` names `esbuild: true`; with it, the postinstall runs and the binary resolves.                                                                                                                                                                                                      |
| `Symbol.metadata` carrier                  | `packages/decorator-plugin/src/metadata/symbol-metadata.ts:61`                   | Installed at import (M111a). esbuild writes decorator metadata under `Symbol.for('Symbol.metadata')`, the same key the carrier installs, so the two agree.                                                                                                                                                                                                     |
| Codemod over the merged tree               | probe of `.tmp/m111b-prep/std-to-vitest.ts`                                      | 1,598 test files (1,549 under `packages/`, 49 under `test/`): 1,595 rewritten, 190 use `Deno.*`; 175 `ignore:` → `skip:`, 13 options-first forms, 7 object forms, 1 `.ignore`; unmapped: `@std/testing/types` (2 files) and `@std/testing/mock` (1 file); 2 unawaited `rejects` (`gcs-provider.test.ts:175,183`). Identical to the pre-111a prep.              |
| Test helpers outside `*.test.ts`           | `git ls-files 'packages/**/test/**'` minus `*.test.ts(x)`                        | 7 helper modules (contract suites, fixtures) import `@std/testing` / `@std/expect` directly; the codemod as prepared touched only `*.test.ts(x)` files, so 34 of the probe's 117 load errors were `Cannot find package '@std/…'` from these.                                                                                                                   |
| Test-side `npm:` / `jsr:` specifiers       | `git ls-files 'packages/**/test/**'`                                             | 114 test files import `npm:`/`jsr:` specifiers (M111a's refusal covers `src` only). Two zod majors are imported side by side: `npm:zod@^3.24.0` (29) and `npm:zod@^4.4.0` (5). Node resolves none of them.                                                                                                                                                     |
| Package test files using `Deno.*`          | `git ls-files 'packages/**/test/**'`                                             | 191 files. By API: `env` 76, `listen` 40, `readTextFile` 40, `Command` 35, `remove` 29, `makeTempDir` 27, `writeTextFile` 26, `connect` 13, `serve` 6, `build` 3, `upgradeWebSocket` 2.                                                                                                                                                                        |
| Local diagnostics listener                 | `packages/runtime/src/diagnostics/local-diagnostics-listener.ts:310`             | `listen` rejects on every platform except `deno`. On Node the diagnostics-plugin e2e and integration suites therefore cannot pass whatever the conversion: 52 of its 63 Node failures are its e2e/integration files.                                                                                                                                           |
| Whole-suite coverage in one Vitest process | probe                                                                            | OOM. The main process ran out of a 4 GB heap, then of an 8 GB heap (`FATAL ERROR: Reached heap limit`), and four quarter-shards (`--shard`) each ran out of a 6 GB heap.                                                                                                                                                                                       |
| Per-package coverage                       | probe, one Vitest run per workspace member, `coverage.include = <member>/src/**` | Every member completes; all 51 together take about 110 s locally with coverage on. 18,071 tests collected across 1,549 files; 17,602 pass, 423 fail, 46 skipped before any hand conversion.                                                                                                                                                                    |
| Vitest skips the report on failure         | probe                                                                            | Without `coverage.reportOnFailure`, a member with any failing test writes NO coverage summary — a per-file gate reading it would silently miss that member.                                                                                                                                                                                                    |
| Coverage counting drift, Node vs Deno      | probe vs the Deno per-file table from M111a's last full run                      | In the 16 members whose tests ALL pass on Node, 17 of 141 files score more than 2 points lower under Vitest's V8 provider than under `deno coverage`, and 5 fall below 90% (e.g. `logger-plugin.ts` branch 87.8 vs 98.0; `abort.ts` function 85.7 vs 100). The cause is counting, not lost tests.                                                              |
| Deno per-file leaf counts                  | M111a's last `deno task test:coverage` log, pretty reporter                      | Each leaf prints as `./<file> => <suite> ... <test> ... ok`; parsing leaves (lines with no deeper child) gives 17,127 leaf tests in 1,361 files. A file whose whole suite is ignored prints no `=>` line, which is why the file count is below 1,549.                                                                                                          |
| Shared-resource isolation rule             | `scripts/test-partition-rules.ts:61` (`isolationReason`)                         | Pure function over `(path, source)`; `ROOTS = ['packages', 'test']` (`:21`). Importable by a TypeScript Vitest config.                                                                                                                                                                                                                                         |
| CI test steps                              | `.github/workflows/ci.yml:443`, `release.yml:373`, `drift.yml:453`               | All three run `deno task test` / `test:coverage` over `packages` AND `test`. `website.yml:74` runs `deno task test` inside the website's own directory and is unaffected.                                                                                                                                                                                      |
| Guarded-suite source pins                  | `test/apps-gate.test.ts:299,568,591,622,667,704,711`                             | Pin source text such as `'ignore: BASE === undefined'`; the codemod rewrites `ignore:` to `skip:`, so these pins change in the same commit.                                                                                                                                                                                                                    |
| Tests asserting Deno permission errors     | 12 files (`NotCapable` / `PermissionDenied` / `Deno.permissions`)                | `storage-plugin` (3), `telemetry-plugin` (5), `decorator-plugin` (1), `mail-plugin` (1), `messaging-plugin` (1), `cli` fixture (1).                                                                                                                                                                                                                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                              | Resolution (picked side)                                                                                  | Doc deliverable (same PR)                                                                                                                                         |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP 111b says Vitest's transformer handles TC39 decorators because "esbuild does"; Vitest 5 transforms with oxc, which does not.                  | Measurement: a pre-transform esbuild plugin is required (§3.3).                                           | ROADMAP 111b "To probe first" bullet replaced with the measured result.                                                                                           |
| C2 | ROADMAP 111b scopes the codemod to "~1,520 import-only files" and implies the whole suite moves; root `test/` exercises Deno scripts.                 | Package tests move here; root `test/` moves with the scripts in 111e (§3.1).                              | ROADMAP 111b and 111e bullets name the split.                                                                                                                     |
| C3 | AI_GUIDELINES §6.4 mandates `deno test` + `@std/testing/bdd` + `@std/expect`; CLAUDE.md "Key conventions → Tests" says the same and bans `Deno.test`. | Vitest (`describe`/`it`/`expect` from `vitest`) for package tests; the root-suite rule stands until 111e. | AI_GUIDELINES §6.4, §6.9, §17.2 coverage row; CLAUDE.md Verification, Key conventions, Common pitfalls (the "exits 0 with a file under the bar" caveat, retired). |
| C4 | CLAUDE.md says a targeted per-package coverage FAIL "is not authoritative — another package's tests may cover those lines".                           | Per-package measurement is now THE gate (§3.6): a file is covered by its own package's tests or it fails. | CLAUDE.md Verification paragraph rewritten.                                                                                                                       |
| C5 | ROADMAP 111b: "the guarded real-backend suites keep their `ignore`/skip guards"; Vitest has no `ignore` option.                                       | The guard stays, spelled `skip:`; the env block and CI pins are unchanged in meaning.                     | `test/apps-gate.test.ts` pins updated; ROADMAP wording.                                                                                                           |

## 3. Design decisions

### 3.1 Two test lanes, and the root suite stays put

- **Decision:** package tests (`packages/**/test`) run in the **Node lane** under Vitest. A named
  subset of the same converted files also runs in the **Deno lane** (§3.8). The root `test/`
  directory (49 files; 30 of them import `scripts/*.ts`, which use `Deno.*`) is not converted and
  keeps running under `deno test` with `@std/testing` until 111e.
- **Why:** converting the root suite now means first porting the scripts it tests, which is 111e's
  whole scope; leaving it on Deno keeps every gate green at every commit, which M111 requires.
- **Test home:** CI runs all three (§3.12); `test/vitest-config.test.ts` asserts the Node lane's
  include globs never match a root `test/` file.

### 3.2 The codemod, committed and extended

- **Decision:** `scripts/codemods/std-to-vitest.ts` (a Node script, run with `node`, which strips
  types) is the prep codemod extended in three ways:
  1. it rewrites every `.ts`/`.tsx` file under `packages/**/test/`, not only `*.test.ts`, so the 7
     helper modules convert with their importers;
  2. it rewrites test-side `npm:<pkg>@<range>[/sub]` and `jsr:` specifiers to bare names, mapping
     the two zod majors to the npm aliases `zod-v3` and `zod-v4` (root `devDependencies`:
     `"zod-v3": "npm:zod@^3.24.0"`, `"zod-v4": "npm:zod@^4.4.0"`), because one package name cannot
     carry two majors;
  3. a `--check` mode reports, and exits non-zero on, every unawaited `expect(…).rejects` /
     `.resolves` in the converted files.

  It still rewrites only 1:1 mappings and REPORTS the rest. The 3 unmapped imports are converted by
  hand: `@std/testing/types` → `expectTypeOf`, `@std/testing/mock` `spy` → `vi.fn`/`vi.spyOn`.
  `scripts/codemods/` is excluded from `deno check` and `deno lint` (it imports `typescript` and
  `vitest`, which the Deno toolchain does not resolve here); 111d's ESLint covers it.
- **Why:** the ROADMAP requires the change to be reproducible; the measured load errors (§1) show
  the prepared scope missed helpers and test-side specifiers.
- **Test home:** `scripts/codemods/std-to-vitest.test.ts` (Vitest, Node lane) — fixture inputs for
  each rewrite, the scope-aware `it` binding, the zod alias mapping, and `--check` exiting 1 on an
  unawaited `rejects`.

### 3.3 TC39 decorators: an esbuild pre-transform

- **Decision:** the Vitest config carries an `enforce: 'pre'` Vite plugin that transforms every
  workspace `.ts`/`.tsx` module (outside `node_modules`) with esbuild's `transform`,
  `target:
  'es2022'`, `jsx: 'automatic'`, `jsxImportSource: 'hono/jsx'`, with source maps.
  `esbuild` becomes a root `devDependency` pinned to `0.28.2`, and `allowBuilds` gains
  `esbuild: true`.
- **Why:** measured (§1): oxc leaves standard decorators untransformed. esbuild writes metadata
  under `Symbol.for('Symbol.metadata')`, the key the M111a carrier installs, so decorator metadata
  is read identically under the test transform and the published `tsc` output.
- **Test home:** the decorator-plugin suite itself (it fails to load without the plugin), plus
  `test/vitest-config.test.ts` asserting the plugin is present and ordered `pre`.

### 3.4 `@setu-ts/*` resolves to source

- **Decision:** a Vite `resolveId` plugin maps `@setu-ts/<member>[/<subpath>]` to the member's `src`
  file, read from each member's `deno.json` `exports` (the same source of truth M111a's generator
  reads). It is deliberately throwaway: 111f, which removes the `deno.json` files, replaces it.
- **Why:** package `exports` point at `dist/`, so without it every cross-package import would need a
  prior `tsc -b` and coverage would attribute to built `.js` rather than `src`. A published
  `"source"` export condition was rejected: it would ship in every tarball for a test-only need.
- **Test home:** `test/vitest-config.test.ts` resolves `@setu-ts/common`, a subpath export
  (`@setu-ts/runtime/worker`) and a starter, and asserts each lands under `src/`.

### 3.5 Shared-resource suites run alone

- **Decision:** each package's Vitest run has two projects: `isolated` (`fileParallelism: false`)
  holding every file for which `isolationReason(path, source)`
  (`scripts/test-partition-rules.ts:61`) is non-null, and `parallel` holding the rest, ordered with
  `sequence.groupOrder` so the isolated project finishes first. The config imports the existing rule
  rather than restating it.
- **Why:** the suite partition (AI_GUIDELINES §6.9) exists because real-backend, socket and
  subprocess suites fail intermittently when run concurrently; Vitest runs files in parallel by
  default, so dropping the rule would reintroduce exactly that. One rule, read by both runners,
  cannot drift.
- **Test home:** `test/vitest-config.test.ts` — a file carrying `REDIS_URL` lands in `isolated`, a
  pure unit test in `parallel`, and the two include lists are disjoint and cover every test file.

### 3.6 Coverage: per package, per file, enforced by the runner

- **Decision:** `pnpm test:coverage` runs Vitest once per workspace member with
  `coverage.provider: 'v8'`, `coverage.include: ['<member>/src/**']`,
  `coverage.reportOnFailure: true`, and
  `coverage.thresholds: { perFile: true, branches: 90, functions: 90, lines: 90 }`. A runner script
  (`scripts/test-node.ts`, Deno until 111e) iterates the members, fails if any run fails, and prints
  one combined per-file table. The bar is applied to Vitest's numbers; a file that drops below it
  because V8-under-Vitest counts differently (§1) gets tests in this milestone, never a lowered bar.
- **Why:** a single Vitest process exhausts an 8 GB heap on the whole suite and 6 GB per quarter
  shard (§1), while per-member runs complete in about 110 s. Per-member scope is also stricter than
  today: a file can no longer pass only because another package's tests happened to execute it,
  which retires CLAUDE.md's "a targeted FAIL is not authoritative" caveat (C4). `reportOnFailure` is
  mandatory, since without it a member with one failing test writes no summary and escapes the gate.
- **Test home:** `test/vitest-config.test.ts` asserts the threshold object and `reportOnFailure`;
  the before/after table comparison (§3.7) proves the swap dropped no file unnoticed.

### 3.7 The swap is proven by counts and tables, not by a green run

- **Decision:** `scripts/codemods/swap-report.ts`, run once and attached to the PR, compares:
  - per-file LEAF test counts: Deno's pretty-reporter `./<file> => … ... ok|ignored` lines (leaves
    are lines with no deeper child) against Vitest's JSON `assertionResults`. A file whose suite is
    wholly ignored on Deno prints no `=>` line, so its count is taken from the source's `it(` calls
    instead. Any file with fewer Vitest tests than Deno leaves fails the report;
  - per-file coverage, Deno's table against Vitest's, listing every file that moved down.
- **Why:** the ROADMAP's exit criterion is that the converted suite collects as many tests as the
  Deno run; a green run that silently collects fewer is the failure being guarded against. The probe
  already shows Deno 17,127 leaves vs Vitest 18,071 tests, and only a per-file comparison says which
  side a difference is on.
- **Test home:** `scripts/codemods/swap-report.test.ts` — the leaf parser on recorded pretty output
  (nested suites, an ignored suite), and the comparison flagging a file that lost a test.

### 3.8 The Deno lane: one shim, the same files

- **Decision:** `test/deno-lane/vitest-shim.ts` re-exports a `vitest`-shaped API (`describe`, `it`,
  `test`, the four hooks, `expect`) over `@std/testing/bdd` and `@std/expect`, translating
  `it(name, { skip, timeout }, fn)` into the `@std/testing` options form; `test/deno-lane/deno.json`
  maps `vitest` to it. `deno task test:deno-lane` runs a committed list, `DENO_LANE_TESTS` in
  `scripts/test-lanes.ts`, under that import map with coverage, and enforces the per-file bar over a
  committed `DENO_ONLY_SOURCES` list. The Node lane's `coverage.exclude` reads the same list.
  - `DENO_ONLY_SOURCES`: `packages/runtime/src/adapters/deno/*.ts` (4 files) and
    `packages/runtime/src/diagnostics/local-diagnostics-listener.ts`.
  - `DENO_LANE_TESTS`: the runtime Deno-adapter and Deno-real tests (`deno-*.test.ts`,
    `integration/deno-http-adapter.test.ts`, the Deno leg of `read-stream-real` and `signal-real`)
    and the diagnostics-plugin e2e/integration suites that drive the Deno-only listener.
  - A file in the Deno lane must still pass in the Node lane unless it is also in `DENO_LANE_TESTS`'
    `nodeExcluded` subset (the listener suites, and `deno-*` files whose subject is a Deno global).
- **Why:** Deno stays a supported runtime, so the proofs that its adapter and its only listener work
  must keep running on Deno; a shim keeps ONE source per test instead of a forked copy. Splitting
  the coverage gate by an explicit source list keeps each file measured by exactly one runner.
- **Test home:** `test/deno-lane/vitest-shim.test.ts` (Deno) — each translated call form registers
  the right `@std/testing` test (including `skip`); `test/test-lanes.test.ts` (Deno) — the two lists
  exist on disk, `DENO_ONLY_SOURCES` is disjoint from the Node lane's measured set, and every
  `nodeExcluded` file is in `DENO_LANE_TESTS`.

### 3.9 Deno-API conversions in the Node lane

- **Decision:** each `Deno.*` use in a Node-lane test maps to one Node API: `Deno.env` →
  `process.env`; `Deno.Command` → `node:child_process` (`spawn`/`execFile`, keeping the subprocess
  boundary the CLI e2e asserts on); `Deno.makeTempDir`/`remove`/`readTextFile`/`writeTextFile` →
  `node:fs/promises`; `Deno.listen` used to find a free port → `node:net`
  `createServer().listen(0)`; `Deno.connect` → `node:net` `connect` (M73's raw RFC 6455 client and
  the forbidden-header probes need a raw socket; `fetch` strips `Upgrade`/`Connection`);
  `globalThis.addEventListener('unhandledrejection')` → `process.on('unhandledRejection')`;
  `data:application/typescript` module imports → a temp `.ts` file. A shared helper module outside
  any package, `test/node-helpers.ts`, holds `unusedPort`, `tempDir` and `run` so the 191 files do
  not each restate them.
- **Why:** one mapping per API keeps the hand conversion mechanical and reviewable.
- **Test home:** the converted suites themselves, plus `test/node-helpers.test.ts`.

### 3.10 Permission-scoped proofs

- **Decision:** each of the 12 files asserting Deno permission errors (§1) gets a Node-side proof of
  the same property, or moves to the Deno lane — none is retired silently. The default per class:
  storage and decorator-plugin read/write refusals → a real read-only temp directory (`chmod 0o555`)
  asserting the provider's named refusal; telemetry lazy-import failures → the existing injected
  importer seam rejecting; the `outage-real` and CLI fixture uses → read in implementation and
  assigned to one of the two, listed in the PR.
- **Why:** the ROADMAP requires each proof to get a replacement or be listed as retired with a
  reason.
- **Test home:** the converted files.

### 3.11 Matcher semantics that differ

- **Decision:** the run is the check: `toStrictEqual` over a null-prototype object and
  `not.toContain` on `null` behave differently under Vitest (§1 of the prep, re-measured); each
  failing site is fixed to assert what was meant. The 2 unawaited `rejects` in
  `gcs-provider.test.ts:175,183` gain `await` (maintainer decision, folded in from the prep).
- **Why:** these are not statically decidable across 72 `toStrictEqual` and 819 `not.toContain`
  sites; only the run finds the ones that differ.
- **Test home:** the converted files; the codemod's `--check` mode gates the unawaited case.

### 3.12 CI and tasks

- **Decision:** root `package.json` gains `test` and `test:coverage`, both invoking
  `scripts/test-node.ts` (run by Deno until 111e; `test` without coverage); `deno.json` `test` and
  `test:coverage` narrow to the root `test/` directory plus `script-coverage`, and gain
  `test:deno-lane`. `ci.yml`'s test job runs, in order: `pnpm test:coverage`,
  `deno task test:deno-lane`, `deno task test:coverage`; the same three replace `release.yml:373`
  and `drift.yml:453`. `test/apps-gate.test.ts`'s guard pins change from `ignore:` to `skip:` in the
  codemod's commit. One Bun run of the Node lane is recorded in the PR as a smoke, not a gate.
- **Why:** all three lanes are gates; dropping any one would make a converted file, a Deno-only
  proof, or a script test unverified.
- **Test home:** `test/apps-gate.test.ts` (the workflow pins), `test/vitest-config.test.ts`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — no package's `src/index.ts` changes; this milestone touches
tests, tooling and documentation only.

| Exported symbol | Kind | Consumer / real code path that READS it                                                     |
| --------------- | ---- | ------------------------------------------------------------------------------------------- |
| None (checked)  | —    | No package barrel changes. The new modules are repository tooling under `scripts/`/`test/`. |

### 4.1 Options — every option names its consumer

| Option              | Consumer                                            | Behavior (per implementation)                                    |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `--check` (codemod) | CI test job                                         | Exit 1 listing each unawaited async assertion; exit 0 otherwise. |
| `--write` (codemod) | the one conversion commit, and anyone re-running it | Rewrite files in place; without it, report only.                 |

## 5. Implementation files

| File                                         | Purpose                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `vitest.config.ts`                           | shared config: decorator transform, `@setu-ts` resolution, projects, thresholds |
| `scripts/codemods/std-to-vitest.ts`          | the committed, extended codemod (§3.2)                                          |
| `scripts/codemods/swap-report.ts`            | per-file count and coverage comparison (§3.7)                                   |
| `scripts/test-node.ts`                       | per-member Vitest runner and combined per-file table (§3.6)                     |
| `scripts/test-lanes.ts`                      | `DENO_LANE_TESTS`, `DENO_ONLY_SOURCES` (§3.8)                                   |
| `test/deno-lane/vitest-shim.ts`, `deno.json` | the Deno lane's `vitest` shim and import map (§3.8)                             |
| `test/node-helpers.ts`                       | `unusedPort`, `tempDir`, `run` for converted tests (§3.9)                       |
| `packages/**/test/**`                        | converted (codemod + hand conversion)                                           |
| `package.json`, `pnpm-workspace.yaml`        | `vitest`, `@vitest/coverage-v8`, `esbuild`, `zod-v3`, `zod-v4`; `allowBuilds`   |
| `deno.json`                                  | narrowed `test` tasks, `test:deno-lane`, `scripts/codemods/` excluded           |
| `.github/workflows/{ci,release,drift}.yml`   | the three test lanes (§3.12)                                                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

No package `src/` file changes. The per-file bar is newly enforced by the runner over every package
`src` file (Node lane) and over `DENO_ONLY_SOURCES` (Deno lane); files that fall below it after the
swap get tests here (§3.6). The new tooling files are tested as follows.

| Test file                                | src covered                         | Key assertions                                                                                  |
| ---------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `scripts/codemods/std-to-vitest.test.ts` | `scripts/codemods/std-to-vitest.ts` | each rewrite; scope-aware `it`; zod aliases; helpers in scope; `--check` exits 1 when it should |
| `scripts/codemods/swap-report.test.ts`   | `scripts/codemods/swap-report.ts`   | leaf parsing of nested and ignored suites; a lost test fails; a coverage drop is listed         |
| `test/vitest-config.test.ts`             | `vitest.config.ts`                  | decorator plugin `pre`; resolution to `src`; projects disjoint and complete; thresholds         |
| `test/test-lanes.test.ts`                | `scripts/test-lanes.ts`             | lists exist; sources disjoint from the Node lane; `nodeExcluded` ⊆ lane tests                   |
| `test/deno-lane/vitest-shim.test.ts`     | `test/deno-lane/vitest-shim.ts`     | every call form translates, `skip` included                                                     |
| `test/node-helpers.test.ts`              | `test/node-helpers.ts`              | a free port binds; a temp dir is removed; `run` returns code and output                         |
| `test/unit/test-node.test.ts`            | `scripts/test-node.ts`              | a failing member fails the run; the combined table lists every member's files                   |

## 7. Verification gates

```bash
git branch --show-current          # MUST be feat/m111b-node-tests
deno task check:plan
deno task fmt:check
deno task lint
deno task check
pnpm test:coverage                 # Node lane: exits non-zero on any file under 90%
deno task test:deno-lane           # Deno lane: same bar over DENO_ONLY_SOURCES
deno task test:coverage            # root test/ + script coverage
node scripts/codemods/std-to-vitest.ts --check
deno task publish:check
deno task release:verify 0.8.0
```

Plus the one-shot evidence attached to the PR: the swap report (§3.7) and the Bun smoke run.

## 8. Risks & mitigations

- **Coverage counting drift costs more tests than estimated** (5 of 141 files in fully-passing
  members fell below the bar; extrapolated, about 35 overall) → the swap report lists every drop
  before the switch, so the work is sized from data, not discovered at the end.
- **CLI e2e under Node exceeds CI time** (142 s under Deno locally, not yet runnable on Node) → it
  stays in the `isolated` project; its time is measured on the first converted run and reported in
  the PR.
- **The Deno-lane shim diverges from Vitest semantics** for a call form the lane uses → the shim's
  own test enumerates every form the lane's files use, and the lane runs in CI on every PR.
- **A converted test passes vacuously** (a `skip` evaluated wrongly, a describe that collects
  nothing) → the per-file count comparison fails any file that collects fewer tests than Deno did.
- **Memory on the 16 GB CI runner** → per-member runs peaked well under the local 6 GB heap; the
  runner sets `--max-old-space-size` explicitly so a regression fails loudly rather than by
  OOM-kill.

## 9. Out of scope

- Converting the root `test/` suite and porting `scripts/*.ts` → 111e.
- Prettier/ESLint for the converted files and the codemod → 111d.
- Removing `deno.json` and the source-resolution plugin that reads it → 111f.
- A Node transport for the local diagnostics listener → not scheduled (a feature, not a toolchain
  move).
- Publishing the converted packages → 111c.
