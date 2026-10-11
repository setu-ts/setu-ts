# Milestone 111a — A Node Build for Every Package (all 51 workspace members)

> **Status:** Planning. Branch: `feat/m111a-node-build`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Every one of the 51 workspace members (48 under `packages/`, 3 under `packages/starters/`) builds to
`dist/` with `tsc -b`, packs with `pnpm pack`, and installs and imports on Node from the packed
tarball, while the four Deno gates (`fmt:check`, `lint`, `check`, `test`) still pass on the SAME
sources. Deno stays the test runner and the publisher of record until 111b/111c replace them; this
letter makes the sources buildable by both toolchains from one set of manifests.

- **In scope:** `pnpm-workspace.yaml`, a root `package.json`, one `package.json` + one
  `tsconfig.json` per member, a root `tsconfig.base.json` + solution `tsconfig.json`; rewriting
  every `npm:` / `jsr:` specifier in `src/` to a bare specifier; `@hono/hono` → `hono` (npm); the
  per-package version constant that replaces the `deno.json` JSON import; the 48 explicit
  annotations `isolatedDeclarations` requires; the `Symbol.metadata` polyfill decorators need on
  Node; the manifest generator/drift gate; the rewritten `npm-specifier-audit.ts`; a Node
  pack-and-boot gate wired into CI; `release:bump` / `release:verify` version agreement extended to
  the two new version sites.
- **NOT this milestone:** the test suite on Node/Vitest (111b); the first npm publish, `files`
  hardening, per-package LICENSE copies, provenance, `compat/` repointing (111c); the CLI `bin` and
  Node-default generated target (111d); ESLint/Prettier, porting scripts, removing `deno.json`
  (111e); documentation rewrite and JSR sunset (111f). `sideEffects` is deferred (C2).

## 1. Contracts verified from SOURCE (not names)

Every row below was established by reading the source or by a probe run on 2026-10-11 against
`develop` at `2d926ddf` (Node 24.18.0, Deno 2.9.6, TypeScript 5.9.3 / 6.0.3 / 7.0.2). Probe scratch
lived in the session scratchpad and is not committed.

| Reference                             | Source (file:line)                                                                                                                                                                                                                                    | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace member list                 | `deno.json:2-53`                                                                                                                                                                                                                                      | 51 members; 3 have subpath exports: `cli` (`./main`), `localization-plugin` (`./format`), `runtime` (`./worker`); `static-plugin`/`view-plugin` use the object form with `.` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Root strictness options               | `deno.json` `compilerOptions`                                                                                                                                                                                                                         | `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables` — carried verbatim into `tsconfig.base.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `npm:` dynamic-import sites           | `grep -rhoE "import\(\s*'npm:" packages/*/src`                                                                                                                                                                                                        | 90 literal `import('npm:<pkg>@<range>')` sites (multi-line calls included) across 45 distinct specifiers incl. subpaths, plus string constants feeding loader seams (`auth-plugin/src/saml/loader.ts:19`, `grpc-plugin/src/transports/connect-loader.ts:34-37`, `telemetry-plugin/src/instrumentation/*`, `telemetry-plugin/src/tracing/context-manager.ts:33`).                                                                                                                                                                                                                                                                                                     |
| `jsr:` in `src`                       | `packages/sdk/src/**` (6 sites)                                                                                                                                                                                                                       | `jsr:@setu-ts/common@^0.8.0`, mapped in `packages/sdk/deno.json` `imports`. No other package source imports a `jsr:` specifier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@std/jsonc` in `cli`                 | `packages/cli/src/workspace/compose.ts:169`                                                                                                                                                                                                           | Appears ONLY inside an emitted Dockerfile string for GENERATED Deno projects. `cli` source imports no `@std/*` module. See C1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@hono/hono` imports                  | src: `kernel/src/router/router.ts`, `view-plugin/src/{html,render/normalize}.ts`; tests: `common`, `kernel`, `localization-plugin`, `mail-plugin`, `view-plugin` (incl. 12 `.tsx` files); `view-plugin/deno.json` `jsxImportSource: "@hono/hono/jsx"` | src subpaths: `.`, `/html`, `/router/linear-router`, `/utils/html` — all exported by npm `hono@4.13.13`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Version JSON imports                  | 45 files in 44 members `import denoJson from '…/deno.json' with { type: 'json' }`                                                                                                                                                                     | Only `denoJson.version` is read (44 reads + `cli/src/constants.ts:16`). 7 members read no version. Outside `rootDir: src`, and `deno.json` would not ship in an npm tarball.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Deno` global in `src`                | `runtime/src/adapters/deno/*.ts`, `cli/src/main.ts`                                                                                                                                                                                                   | The only non-comment, non-template-string uses. `Bun.` appears only in comments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| TC39 decorator emit (tsc 5.9/6.0/7.0) | probe: emitted `__esDecorate` helper                                                                                                                                                                                                                  | `const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;` — on Node 24 `Symbol.metadata` is `undefined`, so `context.metadata` is `undefined` and a member decorator writing to it throws `TypeError`. With `Symbol.metadata ??= Symbol.for('Symbol.metadata')` evaluated first, the probe's class and member decorators share one carrier, readable as `Class[Symbol.for('Symbol.metadata')]`.                                                                                                                                                                                                                            |
| TC39 decorator metadata on Bun 1.4.2  | probe                                                                                                                                                                                                                                                 | No native `Symbol.metadata`. Bun compiling `.ts` itself, and `bun build` output (also run on Node), store metadata under `Symbol.for('Symbol.metadata')`. `tsc` output on Bun crashes exactly as on Node without the polyfill and works with it; with the polyfill installed, Bun's own compiler uses the same key.                                                                                                                                                                                                                                                                                                                                                  |
| decorator-plugin metadata read        | `packages/decorator-plugin/src/metadata/context-bridge.ts:109,127,152,157`                                                                                                                                                                            | Reads `context.metadata`; the M76 fallback reads `Symbol.metadata ?? Symbol.for('Symbol.metadata')`, so the polyfill key agrees with the existing read side.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `rewriteRelativeImportExtensions`     | probe                                                                                                                                                                                                                                                 | Rewrites static and literal dynamic `./x.ts` → `./x.js`; a non-literal `import(p)` is wrapped in `__rewriteRelativeImportExtension(p)` (rewrites only `./`/`../` strings). `.d.ts` output keeps `./x.ts`, and a consumer resolves it (verified with TS 5.9 and TS 7.0.2).                                                                                                                                                                                                                                                                                                                                                                                            |
| Non-literal `import()` sites          | the 3 `computed-specifier` sites: `cli/src/schematics/custom.ts:34`, `decorator-plugin/src/discovery/controller-discovery.ts:167`, `react-router-plugin/src/handler/server-build.ts:154`                                                              | All three are wrapped by the helper. `custom.ts` passes a `file:` URL and discovery passes `toFileUrl(file)` (line 205) — neither starts `./`/`../`, so untouched. `server-build.ts` imports the application's `serverBuildPath`; see §3.9.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| tsc error census                      | probe, TS 6.0.3, after the planned rewrites + config                                                                                                                                                                                                  | 0 semantic errors; exactly 48 `isolatedDeclarations` errors (TS9010 ×21, TS9013 ×11, TS9025 ×5, TS9038 ×5, TS9011 ×4, TS9016 ×2) across 33 files. Before `@types/deno` was added, 11 `Deno` errors MASKED all 48: TS skips declaration diagnostics while semantic errors exist.                                                                                                                                                                                                                                                                                                                                                                                      |
| `@types/deno@2.7.0`                   | probe                                                                                                                                                                                                                                                 | Coexists with `@types/node@24` and `lib: dom`; clears every `Deno` error in `runtime` and `cli`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Deno + member `package.json`          | probe, Deno 2.9.6, mini workspace                                                                                                                                                                                                                     | (a) Deno reads a member `package.json`'s `dependencies` AND `devDependencies` (`workspace:^` resolves to the member). (b) It does NOT read `peerDependencies`: an import of a peer-only package is an unresolved dynamic import and `deno check` types it as `any` — a deliberate type error passed. (c) With a `package.json` present, Deno requires `node_modules` unless root `nodeModulesDir` is `"none"`, under which it resolves from its global cache. (d) The first Deno command beside `pnpm-workspace.yaml` REWRITES the root `package.json`, adding `"workspaces"`. (e) A member's `deno.json` `exports` wins over its `package.json` `exports` for Deno. |
| Test-only workspace imports           | probe + `grep` over `packages/*/test`                                                                                                                                                                                                                 | 40 of 51 members' tests import `@setu-ts/*` packages their `src` does not (e.g. `kernel` tests import `exceptions`, `logger-plugin`, `runtime`, `testing`). Deno resolves workspace members by name even when a member's `package.json` does not declare them (probed), so those tests keep working — and Deno therefore cannot catch a missing `src` dependency; only the pnpm/tsc build can.                                                                                                                                                                                                                                                                       |
| JSDoc imports                         | `grep` over `kernel`/`runtime`/`decorator-plugin` src                                                                                                                                                                                                 | `@example` blocks contain `from '@setu-ts/config-plugin'` etc. A scanner that reads comments invents dependency edges (and could close a reference cycle).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| npm install of co-located tarballs    | probe, npm 11                                                                                                                                                                                                                                         | `npm install b.tgz` where `b` depends on unpublished `a` fails with 404; `npm install b.tgz a.tgz` succeeds and resolves `a` from the co-installed tarball.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@hono/node-server` on Node           | `runtime/src/adapters/node/node-http-adapter.ts:86`                                                                                                                                                                                                   | The Node HTTP adapter's ONLY serve path loads it. Classified as an optional peer, a bare `npm install @setu-ts/runtime` could not serve on Node — the 111c exit criterion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Untyped optional peers                | probe, TS 6.0.3, `@types/*` removed                                                                                                                                                                                                                   | Only `ws` fails (`TS7016` at `runtime/src/adapters/node/node-ws-upgrader.ts:169`); `amqplib`/`nodemailer` sites type-check without `@types`. One semantic error also re-masks all 48 declaration errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Test-only import-map aliases          | `grep` over member `deno.json` `imports`                                                                                                                                                                                                              | Non-`@setu-ts` aliases (`@prisma/client`, `mongodb`, `npm:zod@^3.24.0`, `npm:zod@^4.4.0`, …) are read by tests only (`database-plugin/test/integration`, `openapi-plugin/test`); `openapi-plugin` tests import zod 3 AND zod 4, which one `package.json` name cannot express.                                                                                                                                                                                                                                                                                                                                                                                        |
| typescript-eslint peer range          | `npm view typescript-eslint peerDependencies`                                                                                                                                                                                                         | `typescript >=4.8.4 <6.1.0` — TS 7 is unsupported by the 111e linter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `scripts/npm-specifier-audit.ts`      | `scripts/npm-specifier-audit.ts:1-30`                                                                                                                                                                                                                 | Refuses a non-literal `import()` unless marked `computed-specifier: <reason>`; 3 marked sites today. It does not inspect the literal's contents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `release:bump` version sites          | `scripts/bump-version.ts:78,287,541`                                                                                                                                                                                                                  | Reads/writes each member's `deno.json`; knows nothing of `package.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                  | Resolution (picked side)                                                                                                                                                                                                   | Doc deliverable (same PR)                                                                                                  |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP 111a: "`jsr:@std/jsonc` in `cli` is replaced". Source: `cli` imports no `@std/jsonc`; the string is part of an emitted Dockerfile for generated Deno projects.                    | Source. Nothing to replace in 111a; the emitted Dockerfile belongs to the generated-Deno-target surface 111d owns.                                                                                                         | ROADMAP 111a bullet corrected; 111d bullet gains "the emitted Deno Dockerfile's `jsr:@std/jsonc` step".                    |
| C2 | ROADMAP 111a lists `sideEffects` in every manifest. A wrong `"sideEffects": false` makes a consumer's bundler silently drop module code, and no audit of top-level side effects exists.   | Omit `sideEffects` in 111a (npm's default: has side effects — correct, merely less tree-shakeable). Decided with an audit in 111c, before the first publish.                                                               | ROADMAP 111a bullet drops `sideEffects`; 111c gains "decide `sideEffects` per package behind a top-level-statement audit". |
| C3 | AI_GUIDELINES §11.5 ("no code at module top level that modifies global state") vs. the decorator polyfill (§3.4), which tsc-compiled decorators on Node require at class-definition time. | **Approved by the maintainer 2026-10-11 (§10.2), route 1 with two safeguards (§3.4).** A named, single-module exception for installing a spec-defined well-known symbol the runtime has not shipped, write-if-absent only. | AI_GUIDELINES §11.5 gains the exception paragraph naming `decorator-plugin/src/metadata/symbol-metadata.ts`.               |
| C4 | AI_GUIDELINES §12.2: "JSR has no peer-dependency concept, so the npm 'peer dependency' pattern does not apply" and "lazily load … via dynamic `import()` of an `npm:` specifier".         | The pattern becomes optional `peerDependencies` + bare literal `import()` (ROADMAP 111a). §12.2 rewording is a 111f deliverable, but the two sentences are false the moment this merges.                                   | §12.2's two sentences corrected in THIS PR (minimal wording); the full §12.2 rewrite stays in 111f.                        |

## 3. Design decisions

### 3.1 Manifests are generated from source and drift-checked

- **Decision:** a committed generator, `scripts/node-manifests.ts`, writes every member's
  `package.json` and `tsconfig.json`, the root solution `tsconfig.json`, `pnpm-workspace.yaml`, and
  the root `package.json` `workspaces` field, from four inputs: the member's `deno.json` (`name`,
  `version`, `exports`), a scan of its `src/**/*.ts` AND `test/**/*.{ts,tsx}` imports, one committed
  table of external version ranges (`scripts/node-dependency-ranges.ts`, seeded from today's `npm:`
  ranges), and one committed table of classification overrides in the same file. `--check`
  regenerates in memory and fails on any difference; `--write` writes. Comments and template-string
  contents are masked before the scan (reusing `npm-specifier-audit.ts`'s masking), because JSDoc
  `@example` imports would otherwise invent edges (§1). `npm:`/`jsr:` specifiers left in tests are
  ignored (111b converts them). Classification:
  - `src` imports `@setu-ts/<x>` → `dependencies: { "@setu-ts/<x>": "workspace:^" }` and a project
    reference. A `src`-level cycle is refused by name (tsc references must be acyclic).
  - `src` statically imports an external package as a value → `dependencies` (only `hono` today).
  - `src` reaches an external package only by dynamic `import()` or `import type` → optional
    `peerDependencies` (`peerDependenciesMeta: { optional: true }`) AND an identical-range
    `devDependencies` entry.
  - imported by tests only (workspace or external) → `devDependencies` (`workspace:^` or the table's
    range). Dev-only workspace edges may be cyclic (pnpm allows it); they create no project
    reference.
  - Overrides (each with its reason in the table): `@hono/node-server` is a regular `dependency` of
    `runtime`, because the Node adapter's only serve path loads it (§1) and a bare
    `npm install @setu-ts/runtime` must serve on Node; `ws` adds `@types/ws` to `runtime`'s
    `devDependencies`, the one untyped peer the build needs (§1).
  - Safeguard 2 of §3.4 (the `decorator-plugin` `sideEffects` rule) is enforced here.
- **Why:** 51 hand-written manifests with ~200 dependency edges drift on the first edit; a missing
  dependency builds in the workspace and fails only for the consumer, and Deno cannot see it at all
  (§1, test-only workspace imports). The devDependency mirror is required, not cosmetic: Deno
  ignores `peerDependencies` and silently types an unresolved optional peer as `any`. Scanning tests
  is what keeps a `package.json`-only setup from losing the externals tests import bare.
- **Test home:** `scripts/test/node-manifests.test.ts` (classification table incl. both overrides,
  comment and template masking, test-only edges, cycle refusal, `workspaces` agreement, drift);
  negative control: delete one `peerDependencies` entry → `--check` fails naming package and import.

### 3.2 One dependency source for both toolchains

- **Decision:** each member's `deno.json` keeps `name`/`version`/`exports`/`test`/`lint` and loses
  every `imports` entry keyed by a bare name (`@setu-ts/*` and external packages); both toolchains
  read dependencies from `package.json`. Entries keyed by an `npm:` specifier (`openapi-plugin`'s
  `npm:zod@^3.24.0`/`npm:zod@^4.4.0`, which pin two versions of one package for tests) stay until
  111b, since one `package.json` name cannot express both; `--check` refuses a bare-keyed alias.
  Root `deno.json` gains `"nodeModulesDir": "none"`, so Deno resolves npm packages from its global
  cache and never reads `node_modules`. The root `package.json` is committed already carrying
  `"workspaces"` equal to `pnpm-workspace.yaml`'s `packages`, so Deno's one-time migration (§1 (d))
  has nothing to write; `--check` asserts the two agree. Root-level `@std/testing`/`@std/expect`
  stay in root `deno.json` `imports` (test-only, removed in 111b).
- **Why:** an import map beside `package.json` is a second range table per package that can disagree
  with what Node installs; with `nodeModulesDir: "none"` Deno needs no `pnpm install` to run its
  gates, so CI's Deno jobs are unchanged.
- **Test home:** the four Deno gates on the branch, plus `check:apps` (apps resolve `packages/`
  sources through the root workspace — §8 risk 2).

### 3.3 Specifier rewrite

- **Decision:** every `npm:<pkg>@<range>[/sub]` string in `src/` (import arguments AND the loader
  seams' specifier constants) becomes `<pkg>[/sub]`; `sdk`'s six `jsr:@setu-ts/common@^0.8.0` become
  `@setu-ts/common`; `@hono/hono[/sub]` becomes `hono[/sub]`, resolved from npm for BOTH toolchains
  — in `src` AND in tests (12 `.tsx` files included), with `view-plugin/deno.json`'s
  `jsxImportSource` moving to `hono/jsx`, so no test renders through a second hono copy that
  production never loads. `test/fixtures/snippets` (doc fences) stays on `@hono/hono` until 111f
  rewrites the docs it compiles. Error messages that quoted the old specifier now quote the bare
  package name. The rewrite is done by a one-shot codemod kept in the session scratchpad and NOT
  committed — after merge nothing would run it, so it would be dead code; the change lands as one
  mechanical commit (separate from hand edits) whose message states the rule, and the §3.8 audit is
  what keeps it from regressing.
- **Why:** Node resolves neither `npm:` nor `jsr:`; a bare literal keeps the property M70e's gate
  exists for (static analysis and bundlers see the import). Moving Deno to npm `hono` keeps one hono
  artifact across both toolchains.
- **Test home:** the rewritten audit (§3.8) refuses any remaining `npm:`/`jsr:` literal in an
  `import()`/`from`; existing loader-seam tests assert the new error text.

### 3.4 `Symbol.metadata` on Node and Bun (approved — C3, route 1 with two safeguards)

- **Decision:** new internal module `packages/decorator-plugin/src/metadata/symbol-metadata.ts`
  exporting `installSymbolMetadata(target: { metadata?: symbol }): void` (write-if-absent:
  `target.metadata ??= Symbol.for('Symbol.metadata')`) and calling it once, at module top level, on
  `Symbol`. Every module under `src/decorators/` imports it first (side-effect import), so it has
  run before any class using a framework decorator is evaluated. Not exported from `src/index.ts`.
  On Deno, which defines `Symbol.metadata`, the call is a no-op.
- **Safeguard 1 — a named failure instead of a crash in TypeScript's helper.** Every site in
  `decorator-plugin` that reads `context.metadata` goes through one internal
  `requireDecoratorMetadata(context)` (same module). When the carrier is still `undefined` (a
  bundler dropped the side-effect import, or a decorated class was evaluated before this package),
  it throws `DecoratorMetadataUnavailableError` (`name` set, NOT barrel-exported — no consumer can
  act on the type, only on the message) naming the two remedies: import `@setu-ts/decorator-plugin`
  before the decorated module, or compile with a toolchain that supplies the carrier (tsx, esbuild,
  Bun).
- **Safeguard 2 — bundlers may not drop it.** In 111a no package declares `sideEffects` (C2), which
  npm reads as "every file has side effects", so the import is safe today. The guard is for 111c:
  the manifest drift gate (§3.1) refuses a `decorator-plugin` manifest whose `sideEffects` is
  `false` or a list that omits `./dist/metadata/symbol-metadata.js`.
- **Why:** measured in §1 — without it, a decorated class compiled by `tsc` crashes at definition on
  Node 24 AND on Bun 1.4.2
  (`TypeError: undefined is not an object (evaluating
  'ctx.metadata.m = 1')`); with it, both work.
  `Symbol.for('Symbol.metadata')` is the key tsx, esbuild and Bun's own compiler already use and the
  key `context-bridge.ts` already falls back to (M76), so all of them agree; on Deno the write is a
  no-op. TypeScript's 5.2 release notes give this polyfill (with `Symbol(...)`; `Symbol.for` is used
  here so two copies of the package agree). Rejected with cause: an explicit opt-in import (fails on
  first use for every `tsc` user), a module-level carrier without the global (a method decorator
  never receives its class, so a class with member decorators but no class decorator loses its
  routes), and dropping `tsc` support (excludes it on two of three server runtimes).
- **Test home:** `decorator-plugin/test/unit/symbol-metadata.test.ts` (install on a fresh object; no
  overwrite of an existing symbol; idempotent; `requireDecoratorMetadata` throws the named error for
  an undefined carrier and returns it otherwise); `scripts/test/node-manifests.test.ts` (safeguard
  2); the Node pack-and-boot gate (§3.10) serves a decorated controller compiled by tsc on Node and
  Bun — negative control: remove the side-effect import → that step fails with the named error, not
  the `TypeError`.

### 3.5 Version constant

- **Decision:** each of the 44 members that reads its version gets `src/version.ts` exporting
  `VERSION` (a string literal, explicitly typed `string`) — not the 7 that read none, where it would
  be dead surface. `release:bump` writes `deno.json` and `version.ts`, then runs
  `node-manifests.ts --write` so `package.json` follows; the 45 `deno.json` JSON imports are
  replaced by `import { VERSION } from '…/version.ts'`. `cli/src/constants.ts` re-exports it
  unchanged under its existing public name. `release:verify`'s version-agreement check extends to
  `package.json` and `version.ts`.
- **Why:** the JSON import leaves `rootDir`, and the `deno.json` it reads is not part of an npm
  package. A runtime `package.json` read is a runtime API in a plugin (§4.1).
- **Test home:** `scripts/test/verify-release.test.ts` gains the disagreeing-`version.ts` and
  disagreeing-`package.json` cases; `scripts/test/bump-version.test.ts` asserts both are rewritten.

### 3.6 Compiler pin and configuration

- **Decision:** `typescript@6.0.3` exactly, root devDependency. `tsconfig.base.json`: the eight
  strictness options above, plus `target: es2024`,
  `lib: [es2024, esnext.decorators, dom,
  dom.iterable]`, `module`/`moduleResolution: nodenext`,
  `rewriteRelativeImportExtensions`, `declaration`, `declarationMap`, `sourceMap`,
  `isolatedDeclarations`, `composite`, `verbatimModuleSyntax`, `skipLibCheck`, `types: ["node"]`.
  Member tsconfig: `rootDir: src`, `outDir: dist`, `include: ["src"]`, references from §3.1.
  `runtime` and `cli` add `"deno"` to `types` (`@types/deno@2.7.0` devDependency, those two members
  only).
- **Why:** TS 6.0.3 and 7.0.2 produced identical emit and diagnostics in every probe, but
  typescript-eslint (111e) supports `<6.1`; one compiler for build and lint. `es2024` is required by
  `Promise.withResolvers` / `String.prototype.isWellFormed` used in `auth`, `messaging`, `queue`,
  `scheduler`, `common`. Scoping Deno types to two members keeps every other package honest about
  §4.1 under tsc.
- **Test home:** `pnpm -r build` in CI (§3.10).

### 3.7 The 48 `isolatedDeclarations` sites

- **Decision:** each gets an explicit annotation written by hand (not `as const` removal or
  behaviour change); computed-key class members (TS9038) get an explicit member type. No `@ts-*`
  suppression and no `isolatedDeclarations` opt-out in any member.
- **Why:** explicit public types are the property JSR's slow-type rule enforced (M51); this keeps
  it.
- **Test home:** `deno task check` + `pnpm -r build`; the list in §1 is the acceptance census.

### 3.8 `npm-specifier-audit.ts` rewritten

- **Decision:** the gate keeps the computed-specifier rule and adds: any `import()` / `from` literal
  starting `npm:` or `jsr:` in `packages/*/src` is refused (template-string contents masked, so
  `cli`'s generated-project text is exempt). The file keeps its name; `SCRIPT_TARGETS` entry
  unchanged.
- **Why:** the property is "a bundler can see the import" plus, now, "Node can resolve it".
- **Test home:** `scripts/test/npm-specifier-audit.test.ts` gains the two refusal cases and a
  masked-template case.

### 3.9 Non-literal imports under the rewrite helper

- **Decision:** all three `computed-specifier` sites are compiled through
  `__rewriteRelativeImportExtension`, which rewrites only a string starting `./`/`../` and ending
  `.ts`/`.tsx`/`.mts`/`.cts`. Discovery and custom schematics hand it absolute `file:` URLs, so it
  is a pass-through there — asserted by a test on discovery's importer argument.
  `react-router-plugin` passes the application's `serverBuildPath`, normally an absolute path to a
  built `.js` file (the CLI templates emit one deliberately); a relative `.ts` path would be
  rewritten to `.js`, which the `serverBuildPath` JSDoc now states, rather than leaving the helper's
  effect undocumented.
- **Why:** the helper changes which file loads for exactly one input shape; each site's input is
  provably outside it, or its effect is documented.
- **Test home:** `decorator-plugin/test/unit/controller-discovery.test.ts` (absolute `file:`
  specifier); the `serverBuildPath` claim is a doc change only.

### 3.10 Node pack-and-boot gate

- **Decision:** `scripts/check-node-build.ts` (Deno script,
  `--allow-run=pnpm,npm,node,npx,bun --allow-read --allow-write=.tmp`) runs:
  `pnpm install --frozen-lockfile`; `pnpm -r build`; `pnpm pack` for every member into
  `.tmp/node-pack/`; fails if any packed `package.json` still contains `workspace:`; then in an
  empty temp project, `npm install` of the `kernel`, `runtime` and `decorator-plugin` tarballs PLUS
  their transitive `@setu-ts` closure, computed from the generated manifests (an unpublished
  dependency 404s unless its tarball is in the same install, §1) — plain npm, deliberately not pnpm
  — and runs a committed fixture (`scripts/fixtures/node-boot/`) on Node 24, on Node 22
  (`npx -y node@22`) and on Bun: (1) boots `kernel` + `runtime`, `app.start({ port })`, `fetch`
  returns 200 with the expected JSON; (2) compiles a decorated controller with the repo's tsc and
  serves it (proves §3.4). A new `node-build` job in `ci.yml` runs it on `actions/setup-node@v4`
  (Node 24) + corepack pnpm + `oven-sh/setup-bun` for the Bun leg. `packageManager` is pinned to
  `pnpm@12.11.2` (the version corepack resolved).
- **Why:** the exit criterion in ROADMAP 111a; without a CI job the Node build rots before 111b. A
  leg whose runtime binary is absent is reported and the script exits 77 (the `check:apps`
  convention); `--require-all`, passed by CI, turns any skip into a failure.
- **Test home:** the CI job itself; its decidable half (tarball scan for `workspace:`, closure
  computation, skip/`--require-all` outcome) is pure and unit-tested in
  `scripts/test/check-node-build.test.ts`.

### 3.11 Engines and module format

- **Decision:** every manifest: `"type": "module"`, `"engines": { "node": ">=22" }`, `exports` with
  `types` + `default` conditions per subpath, `files: ["dist", "README.md"]`, `license: "MIT"`. ESM
  only; no CommonJS build.
- **Why:** `es2024` output runs on Node 22+, and §3.10 verifies 22 and 24.
- **Test home:** §3.10 runs on both.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. No `src/index.ts` barrel changes. Observable changes for
consumers: error messages that quoted an `npm:` specifier now quote the bare package name; importing
`@setu-ts/decorator-plugin` installs `Symbol.metadata` when the runtime lacks it.

| Exported symbol                                  | Kind     | Consumer / real code path that READS it                                                                                       |
| ------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| (no barrel change)                               | —        | —                                                                                                                             |
| `VERSION` in each `src/version.ts` (internal)    | const    | the member's plugin factory's `version` field; `cli/src/constants.ts` re-export (already public); `release:verify` agreement. |
| `installSymbolMetadata` (internal, not exported) | function | its own module's top-level call, imported by every `src/decorators/*.ts`.                                                     |

### 4.1 Options — every option names its consumer

| Option                              | Consumer                        | Behavior (per implementation)                                      |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `node-manifests.ts --check`         | CI `node-build` job, local gate | Regenerates in memory; exit 1 listing each differing file.         |
| `node-manifests.ts --write`         | developers; `release:bump`      | Writes every generated file.                                       |
| `check-node-build.ts --require-all` | CI `node-build` job             | A leg whose runtime is absent fails the run instead of exiting 77. |

## 5. Implementation files

| File                                                             | Purpose                                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`          | root workspace (`private`, `packageManager`, `workspaces`, devDeps: typescript, @types/node, @types/deno) |
| `tsconfig.base.json`, `tsconfig.json`                            | shared options; solution file referencing all 51 members                                                  |
| `packages/**/package.json`, `packages/**/tsconfig.json`          | generated (§3.1)                                                                                          |
| `packages/**/src/version.ts`                                     | §3.5                                                                                                      |
| `packages/decorator-plugin/src/metadata/symbol-metadata.ts`      | §3.4                                                                                                      |
| `packages/**/deno.json`                                          | drop `imports` (§3.2)                                                                                     |
| `deno.json`, `deno.lock`, `.gitignore`                           | `nodeModulesDir: "none"`; lock refresh; ignore `dist/`, `*.tsbuildinfo`                                   |
| `scripts/node-manifests.ts`, `scripts/node-dependency-ranges.ts` | §3.1                                                                                                      |
| `scripts/npm-specifier-audit.ts`                                 | §3.8                                                                                                      |
| `scripts/bump-version.ts`, `scripts/verify-release.ts`           | §3.5                                                                                                      |
| `scripts/check-node-build.ts`, `scripts/fixtures/node-boot/**`   | §3.10                                                                                                     |
| `scripts/script-coverage.ts`                                     | add `node-manifests.ts` and `check-node-build.ts` pure cores to `SCRIPT_TARGETS`                          |
| `.github/workflows/ci.yml`                                       | `node-build` job                                                                                          |
| 33 files with `isolatedDeclarations` sites                       | §3.7                                                                                                      |
| `ROADMAP.md`, `AI_GUIDELINES.md`, `CHANGELOG.md`, `CLAUDE.md`    | C1–C4, Unreleased entry, status flip                                                                      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                | src covered                             | Key assertions                                                                                             |
| ------------------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `decorator-plugin/test/unit/symbol-metadata.test.ts`                     | `src/metadata/symbol-metadata.ts`       | installs on `{}`; keeps an existing symbol; idempotent; installed key `=== Symbol.for('Symbol.metadata')`. |
| `decorator-plugin/test/unit/controller-discovery.test.ts` (extended)     | `src/discovery/controller-discovery.ts` | importer receives only absolute `file:` specifiers.                                                        |
| existing package suites                                                  | every edited `src` file                 | unchanged behaviour; loader-seam tests updated to the bare-specifier error text.                           |
| `scripts/test/node-manifests.test.ts`                                    | `scripts/node-manifests.ts` pure core   | classification table (§3.1), template masking, `workspaces` agreement, drift detection.                    |
| `scripts/test/npm-specifier-audit.test.ts` (extended)                    | `scripts/npm-specifier-audit.ts`        | refuses `npm:`/`jsr:` literal; exempts masked template text; computed-specifier rule unchanged.            |
| `scripts/test/check-node-build.test.ts`                                  | `scripts/check-node-build.ts` pure core | `workspace:` detection in a packed manifest; closure computation; exit 77 vs `--require-all` failure.      |
| `scripts/test/verify-release.test.ts`, `bump-version.test.ts` (extended) | version agreement / bump                | disagreeing `version.ts` or `package.json` refused; bump rewrites all three sites.                         |
| `test/version-constant.test.ts`                                          | every `src/version.ts`                  | each `VERSION` equals its member's `deno.json` and `package.json` version (one table over the 44 members). |

Each new `version.ts` is a single export and is covered by the plugin-factory tests that already
read `version`; `version-constant.test.ts` is the guard that it is the right value.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m111a-node-build
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:apps
deno run -A scripts/node-manifests.ts --check
deno run --allow-run=pnpm,npm,node,npx,bun --allow-read --allow-write=.tmp --allow-env scripts/check-node-build.ts --require-all
deno task publish:check     # on the committed tree
deno task release:verify 0.8.0
```

## 8. Risks & mitigations

1. **Deno resolution changes under `nodeModulesDir: "none"` + member `package.json`** (lockfile
   churn, a package resolving to a different version than Node installs) → `deno.lock` diff
   reviewed; `deno info` on `kernel` and `database-plugin` compared before/after; the range table is
   the single source for both.
2. **`apps/*` resolve `packages/` sources through the root workspace**, and `apps/full-stack` has
   its own `nodeModulesDir: "auto"` → `check:apps` is a mandatory gate for this letter.
3. **`deno publish --dry-run` with member `package.json` files** may warn or refuse on JSR-only
   rules → run on the committed tree; any refusal is reported to the maintainer before the PR, not
   worked around (JSR publishing is retired by the M111 decision, but 111c owns retiring the gate).
4. **Consumer TypeScript floor**: `.d.ts` files keep `./x.ts` specifiers → §3.10 fixture compiles
   against the packed tarballs with the pinned TS; a consumer floor is measured and recorded in
   111c.
5. **Workers lacks the §3.4 verification here** (Bun was probed: same as Node) → Workers bundles
   with esbuild, which supplies its own metadata carrier; 111c's `compat/` repointing re-checks.
6. **Codemod over-rewrites a string** (e.g. inside `cli` template text that must keep `npm:` for
   generated Deno projects) → the codemod uses the audit's masking and touches only import arguments
   and the listed loader-seam constants; the diff is reviewed file by file.
7. **Doc fences still compile against jsr `@hono/hono`** while `view-plugin` renders through npm
   `hono` → the snippet gate (`check:docs`) is run on this branch; a fence that breaks across the
   two copies is fixed here, and the switch of `test/fixtures/snippets` is 111f's.
8. **JSDoc and comment prose quoting `npm:<pkg>@<range>`** (about 30 sites, e.g. `pino-logger.ts:3`)
   becomes stale the moment the code changes → corrected in the same commit as the code they
   describe (docs-must-match-behavior), not deferred to 111f.

## 9. Out of scope

- Converting tests off `@std/testing` / `Deno.*` — 111b.
- npm publishing, provenance, LICENSE copies in tarballs, `sideEffects` (C2) — 111c.
- Node `bin` for `setu`, Node-default generated projects, the emitted Deno Dockerfile (C1) — 111d.
- Removing `deno.json`/`deno.lock`, ESLint/Prettier, porting scripts to Node — 111e.
- Full AI_GUIDELINES §12.2 / CLAUDE.md / README rewrite — 111f (only C3/C4's sentences ship here).

## 10. Corrections recorded during implementation

Each deviation from the sections above, with the reason; the sections themselves are left as planned
so the record shows what changed.

1. **Script tests live in `test/unit/`**, not `scripts/test/` (§6): that is where every existing
   script test sits (`npm-specifier-audit.test.ts`, `bump-version.test.ts`).
2. **One `tsc -b` over the solution `tsconfig.json`** instead of `pnpm -r build` (§3.10): the test
   edges are cyclic, so pnpm needs `ignoreWorkspaceCycles` and then orders nothing, and parallel
   member builds race on shared references. One process orders every reference.
3. **The gate is split** into `node-build-gate.ts` (pure, in `SCRIPT_TARGETS`) and
   `check-node-build.ts` (spawns only, not a target) — the M39 `check-deploy.ts` precedent, so the
   orchestration does not sit under the per-file bar.
4. **The import scanner moved into `npm-specifier-audit.ts`** (§3.1, §3.8): the generator imported
   the audit's masker, so the audit could not import the generator's scanner without a cycle. One
   scanner now serves both, and §3.8's `npm:`/`jsr:` refusal is `findPrefixedSpecifiers` over it.
   Its specifier character class gained the semver range characters: without them `npm:zod@^3.24.0`
   read as a misread regex and the refusal missed exactly the caret-range form.
5. **`allowBuilds` denies `protobufjs` and `sse4_crc32`** in the generated `pnpm-workspace.yaml`:
   pnpm 12 fails `install --frozen-lockfile` while an install script is undecided.
6. **The generator reconciles value-over-peer after the `src` scan**, and **skips a member's own
   name in test edges**: the first let a package imported by type in one file and by value in
   another land in both `dependencies` and `peerDependencies`, depending on file order; the second
   made every member whose tests import itself dev-depend on itself.
7. **No CLI template change.** Generated projects install the published packages and need no
   mapping, so `project-files.ts` is unchanged (111d owns it).
8. **The root `deno.json` excludes `packages/*/dist` and `packages/starters/*/dist`**: a bare
   `"dist"` matches only a root directory, so `deno check` read the emitted declarations.
9. **`release:verify` check 6 also reports `npm:`/`jsr:` specifiers**, and `release:bump` treats
   `src/version.ts` as optional — the seven members without one were refused as untracked.
10. **Members keep a GENERATED import map (maintainer decision, 2026-10-11)**, reversing §3.2's
    "bare-keyed `deno.json` imports are removed". Deno honours a member's `package.json` only for a
    program rooted inside the workspace; the 15 examples and the CLI e2e projects type-check
    framework source from outside it, where only the member's import map applies, so `check:apps`
    failed on bare `hono`. The generator now writes each member's `imports` from the same range
    table as its `package.json` (`externalAliases` / `renderDenoJson`, splicing only that block and
    keeping `npm:`-keyed pins), so there is still one source and `--check` refuses drift. This
    replaced two per-consumer workarounds — a derived map in the CLI fixture and hand-written `hono`
    entries in `test/fixtures/snippets/deno.json` — both reverted. `checkDenoAliases` was deleted
    with the rule it enforced.
11. **`hono` stays at `^4.12.30` and `@types/node` is `^24`**: the range table first raised `hono`
    to `^4.13.13`, narrowing what consumers were promised and moving the locked version; the plan
    probed `@types/node@24`. The `deno.lock` was rebuilt from `develop`'s, so no existing
    third-party resolution moved (a full re-resolve had moved 30 packages, Prisma `7.10.0` → `7.8.0`
    among them).
