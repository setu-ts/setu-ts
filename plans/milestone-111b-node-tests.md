# Milestone 111b — The Test Suite on Node (every member)

> **Status:** In progress. Branch: `feat/m111b-node-tests`. `develop` and `main` are protected — all
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
| Coverage counting drift, Node vs Deno      | probe vs the Deno per-file table from M111a's last full run                      | In the 16 members whose tests ALL pass on Node, 17 of 141 files score more than 2 points lower under Vitest's V8 provider than under `deno coverage`, and 5 fall below 90% (e.g. `logger-plugin.ts` branch 87.8 vs 98.0; `abort.ts` function 85.7 vs 100). Attributed to counting rather than lost tests; §3.7 proves it per file.                             |
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
  keeps running under `deno test` with `@std/testing` until 111e — with one carve-out: the new
  directory `test/node/` holds the tests of NEW Node-side tooling and runs in the **tooling target**
  (§3.6), never under `deno test`. The root `deno.json` `test` task excludes `test/node/`.
- **Why:** converting the root suite now means first porting the scripts it tests, which is 111e's
  whole scope; leaving it on Deno keeps every gate green at every commit, which M111 requires. The
  carve-out exists because a file that tests the Vitest config or a Node helper proves nothing about
  Node when Deno runs it.
- **Test home:** CI runs all three (§3.12); `test/node/vitest-config.test.ts` asserts the Node
  lane's include globs never match a root `test/` file, and `test/test-lanes.test.ts` asserts the
  root `deno.json` `test` task excludes `test/node/`.

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
- **Test home:** `scripts/codemods/std-to-vitest.test.ts` (Vitest, the tooling target of §3.6 — not
  a package member, so the per-member runs would never pick it up) — fixture inputs for each
  rewrite, the scope-aware `it` binding, the zod alias mapping, and `--check` exiting 1 on an
  unawaited `rejects`. `scripts/script-coverage.ts` (Deno) excludes `scripts/codemods/`, so each
  file is measured by exactly one runner.

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
  `test/node/vitest-config.test.ts` asserting the plugin is present and ordered `pre`.

### 3.4 `@setu-ts/*` resolves to source

- **Decision:** a Vite `resolveId` plugin maps `@setu-ts/<member>[/<subpath>]` to the member's `src`
  file, read from each member's `deno.json` `exports` (the same source of truth M111a's generator
  reads). It is deliberately throwaway: 111f, which removes the `deno.json` files, replaces it.
- **Why:** package `exports` point at `dist/`, so without it every cross-package import would need a
  prior `tsc -b` and coverage would attribute to built `.js` rather than `src`. A published
  `"source"` export condition was rejected: it would ship in every tarball for a test-only need.
- **Test home:** `test/node/vitest-config.test.ts` resolves `@setu-ts/common`, a subpath export
  (`@setu-ts/runtime/worker`) and a starter, and asserts each lands under `src/`.

### 3.5 Shared-resource suites run alone

- **Decision:** each package's Vitest run starts from `packages/<member>/test/**/*.test.{ts,tsx}`
  minus `NODE_EXCLUDED_TESTS` (§3.8, imported from `scripts/test-lanes.ts`), then splits what is
  left into two projects: `isolated` (`fileParallelism: false`) holding every file for which
  `isolationReason(path, source)` (`scripts/test-partition-rules.ts:61`) is non-null, and `parallel`
  holding the rest, ordered with `sequence.groupOrder` so the isolated project finishes first. The
  config imports both lists rather than restating them.
- **Why:** the suite partition (AI_GUIDELINES §6.9) exists because real-backend, socket and
  subprocess suites fail intermittently when run concurrently; Vitest runs files in parallel by
  default, so dropping the rule would reintroduce exactly that. One rule, read by both runners,
  cannot drift.
- **Test home:** `test/node/vitest-config.test.ts` — a file carrying `REDIS_URL` lands in
  `isolated`, a pure unit test in `parallel`, the two include lists are disjoint, together they
  cover every package test file except `NODE_EXCLUDED_TESTS`, and no `NODE_EXCLUDED_TESTS` file
  appears in neither project.

### 3.6 Coverage: per package, per file, enforced by the runner

- **Decision:** `pnpm test:coverage` runs Vitest once per workspace member with
  `coverage.provider: 'v8'`, `coverage.include: ['<member>/src/**']`,
  `coverage.reportOnFailure: true`, and
  `coverage.thresholds: { perFile: true, branches: 90, functions: 90, lines: 90 }`. A runner script
  (`scripts/test-node.ts`, Deno until 111e) iterates the members, fails if any run fails, and prints
  one combined per-file table. The bar is applied to Vitest's numbers; a file that drops below it
  because V8-under-Vitest counts differently (§1) gets tests in this milestone, never a lowered bar.
  - **The tooling target.** After the members, the runner makes one more Vitest run over the Node
    tooling this milestone adds: tests `scripts/codemods/**/*.test.ts` and `test/node/**/*.test.ts`,
    coverage over `scripts/codemods/*.ts`, `vitest.config.ts` and `test/node-helpers.ts`, same
    thresholds. Without it those tests are collected by nothing (they are not under any member).
  - **Permissions.** The task is
    `deno run --allow-run=pnpm --allow-read=. --allow-write=coverage-node scripts/test-node.ts`:
    `pnpm exec vitest` is the only process spawned, the per-member reports land under
    `coverage-node/`, and the child inherits the environment without the runner reading it.
    `NODE_OPTIONS=--max-old-space-size=…` is set on the child, which needs no `--allow-env`.
  - **Node version.** The lane gates on Node 24, the version CI's `setup-node` already pins for
    M111a. Node 22 is not run against the suite: the published artifact's Node 22 behaviour is
    already proven by M111a's `check:node-build` boot, and a second 18,000-test run doubles the job
    for little; whether 1.0 gates on a Node 22 suite run is M40's call. Bun stays a recorded smoke
    (§3.12), because the suite's subprocess and socket tests assume Node's `child_process`/`net`.
- **Why:** a single Vitest process exhausts an 8 GB heap on the whole suite and 6 GB per quarter
  shard (§1), while per-member runs complete in about 110 s. Per-member scope is also stricter than
  today: a file can no longer pass only because another package's tests happened to execute it,
  which retires CLAUDE.md's "a targeted FAIL is not authoritative" caveat (C4). `reportOnFailure` is
  mandatory, since without it a member with one failing test writes no summary and escapes the gate.
- **Test home:** `test/node/vitest-config.test.ts` asserts the threshold object and
  `reportOnFailure`; `scripts/codemods/node-runner-core.test.ts` asserts the tooling target is run,
  and pins the task's grants exactly (a widened grant fails it); the before/after table comparison
  (§3.7) proves the swap dropped no file unnoticed.

### 3.7 The swap is proven by counts and tables, not by a green run

- **Decision:** `scripts/codemods/swap-report.ts` compares, per file:
  - LEAF test counts: Deno's sequential module headers and indented step names, and its parallel
    pretty-reporter `./<file> => … ... ok|ignored` lines (leaves are lines with no deeper child)
    against Vitest's JSON `assertionResults`. A file whose suite is wholly ignored on Deno prints no
    `=>` line, so its count is taken from the source's `it(` calls instead. A file with FEWER Vitest
    tests fails the report. A file with MORE is listed too, and each one must carry a classified
    cause in the report: `deno-uncounted` (the Deno log printed no leaf for it — wholly-ignored
    suite, or a leaf the parser could not see), or `added-proof` (a new, independently asserted
    behavioral case added during the conversion), or `registration`. `registration` fails the
    report: it means one test name collected twice, a `describe` callback run twice or a loop
    registering more cases than on Deno, and is a defect in the conversion. The probe's +944 (18,071
    vs 17,127) must be fully attributed before merge; an unclassified gain fails the report;
  - coverage, Deno's table against Vitest's, listing every file that moved down — and, for each, its
    leaf counts on both sides. A file that moved down with EQUAL counts is counting drift (§1) and
    gets tests; one with fewer Vitest tests is a lost test and is restored.
- **When it runs, and what protects parity afterwards.** The comparison needs a Deno run of the
  PACKAGE tests, which exists only before the swap. It is therefore a one-time proof: the report is
  generated from the pre-swap Deno log and the converted run, committed as
  `plans/evidence/m111b-swap-report.md`, and the PR does not merge unless it shows zero failures.
  After merge there is no Deno side to compare against, so parity is not re-checked. The lasting
  guard against a test that silently stops collecting is the per-file coverage bar (§3.6): a file
  whose tests collect nothing covers nothing and fails it.
- **Why:** the ROADMAP's exit criterion is that the converted suite collects as many tests as the
  Deno run; a green run that silently collects fewer is the failure being guarded against, and a run
  that collects MORE can hide duplicate registration. Only a per-file comparison says which side a
  difference is on.
- **Test home:** `scripts/codemods/swap-report.test.ts` (tooling target) — the leaf parser on
  recorded pretty output (nested suites, an ignored suite), a file that lost a test failing, a
  duplicate registration failing, an unclassified gain failing, and a coverage drop listed with its
  counts.

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
  - `NODE_EXCLUDED_TESTS` (a third exported list, a subset of `DENO_LANE_TESTS`): the listener
    suites, and `deno-*` files whose subject is a Deno global. Every other Deno-lane file must also
    pass in the Node lane. The Node lane's include is computed from this list (§3.5), so excluding a
    file is one edit in one place.
  - The shim exports no `vi`. A Deno-lane file therefore may not import `vi` from `vitest`; none
    does today, and the lane test refuses one that does, so the gap cannot open silently.
- **Why:** Deno stays a supported runtime, so the proofs that its adapter and its only listener work
  must keep running on Deno; a shim keeps ONE source per test instead of a forked copy. Splitting
  the coverage gate by an explicit source list keeps each file measured by exactly one runner.
- **Test home:** `test/deno-lane/vitest-shim.test.ts` (Deno) — each translated call form registers
  the right `@std/testing` test (including `skip`); `test/test-lanes.test.ts` (Deno) — the three
  lists exist on disk, `DENO_ONLY_SOURCES` is disjoint from the Node lane's measured set,
  `NODE_EXCLUDED_TESTS` ⊆ `DENO_LANE_TESTS`, and no `DENO_LANE_TESTS` file imports `vi`.

### 3.9 Deno-API conversions in the Node lane

- **Decision:** each `Deno.*` use in a Node-lane test maps to one Node API: `Deno.env` →
  `process.env`; `Deno.Command` → `node:child_process` (`spawn`/`execFile`, keeping the subprocess
  boundary the CLI e2e asserts on); `Deno.makeTempDir`/`remove`/`readTextFile`/`writeTextFile` →
  `node:fs/promises`; `Deno.listen` used to find a free port → `node:net`
  `createServer().listen(0)`; `Deno.connect` → `node:net` `connect` (M73's raw RFC 6455 client and
  the forbidden-header probes need a raw socket; `fetch` strips `Upgrade`/`Connection`);
  `globalThis.addEventListener('unhandledrejection')` → `process.on('unhandledRejection')`;
  `data:application/typescript` module imports → a temp `.ts` file. A shared helper module outside
  any package, `test/node-helpers.ts`, holds `unusedPort`, `tempDir`, `run` and `denoBinary` so the
  191 files do not each restate them.
  - **Tests that spawn `deno` itself.** 18 package test files run the Deno binary through
    `Deno.execPath()`: `cli` (13 — the scaffold, drift and e2e gates run `deno check`/`fmt`/`lint`
    on generated projects), `sdk` (2), `decorator-plugin`, `localization-plugin` and
    `storage-plugin` (1 each). On Node `process.execPath` is `node`, so they call `denoBinary()`,
    which resolves `deno` from `PATH`. The Node lane therefore REQUIRES Deno on `PATH` for as long
    as these tests exist — generated projects can still target Deno, so that is not a 111e/111f
    change. CI installs Deno in every test job already. A missing binary FAILS with an error naming
    `deno` and `PATH`; it is not a skip, because a skipped scaffold gate is exactly the silent hole
    the exit-77 convention exists to prevent.
- **Why:** one mapping per API keeps the hand conversion mechanical and reviewable.
- **Test home:** the converted suites themselves, plus `test/node/node-helpers.test.ts` (tooling
  target, so it runs on Node) — a free port binds, a temp dir is removed, `run` returns code and
  output, `denoBinary` finds `deno` on `PATH` and throws the named error on an empty `PATH`.

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
  `test:coverage` narrow to the root `test/` directory (excluding `test/node/`) plus
  `script-coverage`, and gain `test:deno-lane`. `ci.yml`'s test job runs, in order:
  `node scripts/codemods/std-to-vitest.ts --check`, `pnpm test:coverage` (members plus the tooling
  target), `deno task test:deno-lane`, `deno task test:coverage`; the same four replace
  `release.yml:373` and `drift.yml:453`. `test/apps-gate.test.ts`'s guard pins change from `ignore:`
  to `skip:` in the codemod's commit. One Bun run of the Node lane is recorded in the PR as a smoke,
  not a gate (§3.6).
- **Why:** all four steps are gates; dropping any one would make an unawaited async assertion, a
  converted file, a Deno-only proof, or a script test unverified.
- **Test home:** `test/apps-gate.test.ts` pins the four steps as `run:` lines inside each workflow's
  test job, in order (the v0.2.0 lesson: a workflow-wide substring passes with the step commented
  out); `test/node/vitest-config.test.ts`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — no package's `src/index.ts` changes; this milestone touches
tests, tooling and documentation only.

| Exported symbol | Kind | Consumer / real code path that READS it                                                     |
| --------------- | ---- | ------------------------------------------------------------------------------------------- |
| None (checked)  | —    | No package barrel changes. The new modules are repository tooling under `scripts/`/`test/`. |

### 4.1 Options — every option names its consumer

| Option              | Consumer                                            | Behavior (per implementation)                                    |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `--check` (codemod) | the first step of the CI test job (§3.12)           | Exit 1 listing each unawaited async assertion; exit 0 otherwise. |
| `--write` (codemod) | the one conversion commit, and anyone re-running it | Rewrite files in place; without it, report only.                 |

## 5. Implementation files

| File                                         | Purpose                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `vitest.config.ts`                           | shared config: decorator transform, `@setu-ts` resolution, projects, thresholds |
| `scripts/codemods/std-to-vitest.ts`          | the committed, extended codemod (§3.2)                                          |
| `scripts/codemods/swap-report.ts`            | per-file count and coverage comparison (§3.7)                                   |
| `scripts/test-node.ts`                       | per-member + tooling-target Vitest runner, combined per-file table (§3.6)       |
| `scripts/test-lanes.ts`                      | `DENO_LANE_TESTS`, `NODE_EXCLUDED_TESTS`, `DENO_ONLY_SOURCES` (§3.8)            |
| `test/deno-lane/vitest-shim.ts`, `deno.json` | the Deno lane's `vitest` shim and import map (§3.8)                             |
| `test/node-helpers.ts`                       | `unusedPort`, `tempDir`, `run`, `denoBinary` for converted tests (§3.9)         |
| `plans/evidence/m111b-swap-report.md`        | the one-time parity proof (§3.7)                                                |
| `packages/**/test/**`                        | converted (codemod + hand conversion)                                           |
| `package.json`, `pnpm-workspace.yaml`        | `vitest`, `@vitest/coverage-v8`, `esbuild`, `zod-v3`, `zod-v4`; `allowBuilds`   |
| `deno.json`                                  | narrowed `test` tasks, `test:deno-lane`, `scripts/codemods/` excluded           |
| `.github/workflows/{ci,release,drift}.yml`   | the four test steps (§3.12)                                                     |
| `CONTRIBUTING.md`                            | the Node lane needs Node 24, pnpm and Deno on `PATH` (§3.6, §3.9)               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

No package `src/` file changes. The per-file bar is newly enforced by the runner over every package
`src` file (Node lane) and over `DENO_ONLY_SOURCES` (Deno lane); files that fall below it after the
swap get tests here (§3.6). The new tooling files are tested as follows.

| Test file (runner)                                    | src covered                            | Key assertions                                                                                                                                                        |
| ----------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/codemods/std-to-vitest.test.ts` (tooling)    | `scripts/codemods/std-to-vitest.ts`    | each rewrite; scope-aware `it`; zod aliases; helpers in scope; `--check` exits 1 when it should                                                                       |
| `scripts/codemods/swap-report.test.ts` (tooling)      | `scripts/codemods/swap-report.ts`      | nested, sequential, and ignored suites parsed; existing repeated names preserved; lost test fails; duplicate registration fails; unclassified gain fails; drop listed |
| `test/node/vitest-config.test.ts` (tooling)           | `vitest.config.ts`                     | decorator plugin `pre`; resolution to `src`; projects disjoint and complete; `NODE_EXCLUDED_TESTS` absent; thresholds                                                 |
| `test/node/node-helpers.test.ts` (tooling)            | `test/node-helpers.ts`                 | a free port binds; a temp dir is removed; `run` returns code and output; `denoBinary` found / named error on empty PATH                                               |
| `test/test-lanes.test.ts` (Deno)                      | `scripts/test-lanes.ts`                | lists exist; sources disjoint from the Node lane; excluded ⊆ lane tests; no lane file imports `vi`; `test/node/` excluded from `deno test`                            |
| `test/deno-lane/vitest-shim.test.ts` (Deno lane)      | `test/deno-lane/vitest-shim.ts`        | every call form translates, `skip` included                                                                                                                           |
| `scripts/codemods/node-runner-core.test.ts` (tooling) | `scripts/codemods/node-runner-core.ts` | a failing member fails the run; the tooling target runs; the table lists every file; the task's grants pinned exactly                                                 |
| `test/apps-gate.test.ts` (Deno, existing)             | the three workflows                    | the four test steps present as `run:` lines inside each test job, in order; `skip:` guard pins                                                                        |

## 7. Verification gates

```bash
git branch --show-current          # MUST be feat/m111b-node-tests
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test:deno-lane           # Deno lane: same bar over DENO_ONLY_SOURCES
deno task test:coverage            # root test/ + script coverage
node scripts/codemods/std-to-vitest.ts --check
pnpm test:coverage                 # Node lane + tooling target: non-zero on any file under 90%
deno task publish:check
deno task release:verify 0.8.0
```

Plus the one-time evidence: the committed swap report `plans/evidence/m111b-swap-report.md` (§3.7),
which must show zero failures and every gain classified, and the Bun smoke run recorded in the PR.

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
  nothing) → at the swap, the per-file count comparison fails any file that collects fewer tests
  than Deno did; after merge, a file that collects nothing covers nothing and fails the per-file bar
  (§3.7).
- **A converted test registers twice** (more Vitest tests than Deno leaves) → the swap report
  requires a classified cause for every gain and fails `registration`.
- **The Node lane is run without Deno installed** (a contributor's Node-only machine) → the 18 files
  that spawn `deno` fail with an error naming `deno` and `PATH`, never skip (§3.9);
  `CONTRIBUTING.md` states the requirement.
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

## 10. Approved implementation adjustments and design security review

The maintainer approved four source adjustments during implementation on 2026-10-11 after the
converted tests demonstrated defects. The original tests-only scope now includes these adjustments:

- Node filesystem removal must remove an empty directory without `recursive`, refuse a nonempty
  directory, and remove a symbolic link without removing its target. The existing CLI rollback and
  real SIGINT proofs exercise the application consumer; a real-filesystem regression also exercises
  the runtime adapter directly.
- Framework-owned transport headers must retain own keys such as `__proto__` on Node, as they
  already do on Deno. Header copying must create own data properties and preserve the ordinary
  object prototype, framework-header precedence, and reserved transport-header behavior.

- Cache coalescing cleanup deletes its private in-flight entry unconditionally. The entry cannot be
  replaced before settlement cleanup runs; settlement, sequential reuse, and owner isolation remain
  regression obligations.
- SSE sends and comments share one guarded enqueue operation. Encoding stays behind that guard, so
  closed connections still ignore unserializable messages. A retained timer callback after close
  must not write or repeat cleanup; stream cancellation and backpressure behavior stay covered.
- A fifth adjustment, approved on 2026-10-11 after verification measured it: the Node adapter
  removes the `text/plain; charset=UTF-8` default `@hono/node-server` writes for a byte or stream
  body that sets no `content-type`, so Node sends what the Fetch standard, Deno, Bun and Workers
  send (no type). It predates M111b; the conversion only made it visible.

The manifest generator also follows the converted imports, including npm package aliases, and
preserves the root test commands and esbuild install decision. This is tooling within the approved
scope. Newly added behavioral proofs are classified separately from recovered Deno collection gaps
in the swap report; registration gains remain failures.

### 10.1 Completed design review of the approved fixes

**Reviewed flow:** CLI rollback passes paths and a recursive flag through `IFileSystem.rm` to Node
filesystem operations. An empty directory is removed using the nonrecursive directory operation when
Node's file removal refuses it. Broker publishing merges validated caller headers and framework
headers into a fresh transport record, then serializes its own enumerable entries onto the broker
wire. The review covers these existing flows and their cross-runtime fixes, plus private cache
settlement and SSE stream cleanup.

**Assets:** files outside the requested removal target; contents of a nonempty directory when a
nonrecursive operation was requested; transport-header identity, values, precedence and prototype;
broker payload identity and the existing reserved-header controls.

**Attackers:** a local caller selecting a removal path, including a symbolic link or a nonempty
folder; a transport-header producer supplying hostile property names or a record with inherited
properties. No new network listener, credential, numeric budget, or public plugin option is added.
The original CLI path validation and publish-option validation remain obligations of their callers.

| Threat                                                                                          | Required resolution                                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recursive removal used to emulate empty-directory removal deletes contents                      | Use a nonrecursive directory operation; prove refusal with contents intact.                                                                                       |
| Following a symbolic link removes its target                                                    | Remove the link itself; prove target contents remain.                                                                                                             |
| A malformed-key header changes the result prototype or silently disappears                      | Copy only own enumerable entries as own data properties; preserve the ordinary prototype.                                                                         |
| The framework-header merge changes caller/header precedence or permits reserved-header spoofing | Keep existing precedence and validated reserved transport metadata; exercise the broker consumer.                                                                 |
| Removing node-server's default drops a type the application set                                 | Strip only when the framework response is bytes or a stream and names no `content-type`.                                                                          |
| An untyped body loses `text/plain` and becomes MIME-sniffable as HTML in a browser              | Accepted for runtime parity (Deno, Bun and Workers already send no type); documented in the CHANGELOG: set a type on streamed untrusted bytes, or send `nosniff`. |
| The `writeHead` wrapper leaks into later responses on a kept-alive connection                   | Wrap the one exchange's `outgoing` for one call, restoring the original before delegating.                                                                        |

**Implementation-audit obligations:** exercise empty/nonempty/missing/file/symlink removal with
positive controls and a negative control that restores the original adapter; send ordinary and
hostile own header keys through a real broker facade, inspect the captured wire fields and the
consumer's metadata, and confirm prototype/precedence/reserved-header controls. Restore the original
assignment as a negative control and observe the hostile-key proof fail on Node. Audit the committed
tree independently using `.roo/skills/security-audit/SKILL.md`. Report unavailable live backends as
unexercised. Cache cleanup must remove settled work without crossing owner maps, and SSE must ignore
late heartbeats and writes after close without repeating cleanup or serializing messages.

### 10.2 Test-tooling adjustments

- Vitest automatically excludes its config entrypoint from instrumentation. The entrypoint
  re-exports the implementation in `scripts/codemods/node-test-config.ts`; the tooling target
  measures that implementation and its real decorator transform at the same per-file bar.
- `packages/cli/src/main.ts` contains the Deno process adapter. It is measured in the Deno lane
  through the same converted process-boundary tests, rather than leaving that adapter uncovered in
  Node or installing a Deno global shim.
- The runtime's real Web Worker test remains in the Deno lane. A Node worker with no handler
  explicitly stays alive so the worker-pool startup deadline is still the tested condition.
- WebSocket integration files that prove `app.fetch` upgrades retain their real Deno-host proof in
  the Deno lane. Node's adapter requires an actual incoming HTTP upgrade event. Existing Node socket
  e2e proofs remain in the Node lane. The diagnostics unit suites' exact-bound startup proofs also
  run on Deno; their protocol and refusal cases still run on Node.

- The Deno lane import map scopes its Vitest shim to every retained member’s test directory.
  Member-level generated npm mappings otherwise override a global import-map entry; a root
  lane-boundary proof pins these scopes, and the native lane is rerun after manifest generation.

- `deno task test:coverage:pkg` delegates to the same Node coverage runner. Member basenames and
  workspace paths are accepted; no selection runs all members. The older Deno-only targeted
  implementation remains as root-tested tooling until M111e, rather than running converted Vitest
  registrations outside their runner.

- The exact guard-invocation socket proof uses the installed `ws` client for a refused handshake. A
  standalone Node 24 HTTP upgrade probe confirms that the native client retries a 401, while the
  refusal proof requires one explicit attempt. Successful upgrades still use the native client.

- Running the Node lane against real backends (every earlier run had left the guarded suites
  skipped) found two gaps. `realtime-observations-redis.test.ts` binds the Deno-only diagnostics
  listener, so it joins `DENO_LANE_TESTS` and `NODE_EXCLUDED_TESTS`, with its Deno-lane scope; it
  runs there whenever `REDIS_URL` is set, as in CI. The RabbitMQ dead-letter proof asserted an own
  `__proto__` header on a message read back through amqplib, whose decoder assigns
  `fields[key] = value`: Deno ships without the `__proto__` accessor, so the key arrives, while
  Node's setter discards a string. The broker copies headers with `Object.fromEntries` and is not at
  fault; the assertion now probes that assignment and expects the header exactly when the runtime
  keeps it.
- The swap report's leaf parser matched test names with `.`, which skips U+2028/U+2029, so a name
  carrying a Unicode line separator was dropped from the Deno count. Its patterns now use the `s`
  flag, with a regression in `swap-report.test.ts`.
- `WorkersResponse` (`test/node-helpers.ts`) subclasses the native `Response` and changes only what
  workerd itself does differently: status 101 and a `webSocket` member. The 56 cloudflare-plugin
  files that build Workers responses install it for their own run and restore the native class
  after, so every other `Response` behavior under test is Node's own.

### 10.3 Permission-scoped proofs — dispositions (§3.10)

| File (pre-swap)                                                                   | What it asserted                                             | Disposition on Node                                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `storage-plugin` `local-provider`, `providers/local-health`, `storage-plugin` (3) | a fake filesystem rejecting with a `PermissionDenied` string | Runtime-neutral already (no real permission involved); unchanged, and the Node-specific wording branch is asserted. |
| `telemetry-plugin` five real-import suites                                        | skipped without Deno's `import` permission                   | Node always permits the import, so the guard is removed and every case runs unconditionally.                        |
| `decorator-plugin` `unit/controller-discovery`, `integration/decorator-plugin`    | real `import()` discovery, skipped without the permission    | Runs unconditionally. The integration file's probe returned `false` on Node and skipped it; fixed in verification.  |
| `cli` `fixtures/generated-project.ts`                                             | a scaffold boots under its own generated permissions         | Kept: it still spawns `deno` with the project's own task grants.                                                    |
| `mail-plugin`, `messaging-plugin` `outage-real`                                   | comments only (a `NotCapable` on `::1` reconnects)           | No assertion to move.                                                                                               |

None is retired.

### 10.4 Verification findings fixed on this branch

- `decorator-plugin/test/integration/decorator-plugin.test.ts` gated its real-import discovery case
  on Deno's permission API, which is absent on Node, so the case was skipped on every Node run while
  the file runs nowhere else. It now runs unconditionally; breaking its fixture path fails it.
- `runtime/test/integration/streaming.test.ts` had dropped its "`stream()` sets no content-type"
  assertion. Measured: Deno sends no content-type, while `@hono/node-server` writes
  `text/plain; charset=UTF-8` for any body that lacks one (its default since M23). At the
  maintainer's direction the divergence is fixed here (§10, fifth adjustment) rather than recorded:
  the assertion is `null` on every runtime, `integration/node-content-type.test.ts` drives each body
  kind through a real Node socket, and removing the suppression fails both.
- Five telemetry-plugin files kept a `canImportNpm()` that always returned `true`, leaving dead
  `skip` options and comments describing an `ignore` guard that no longer existed; removed.
- Ten source files measure exactly 90.0 on one metric under V8-on-Node (for example
  `resilience-plugin/src/patterns/retry.ts` branch). They meet the bar with no margin.
