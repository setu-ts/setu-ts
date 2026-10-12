# Milestone 111d — The CLI Goes Node-First (`@setu-ts/cli`, new `@setu-ts/create`)

> **Status:** Planning. Branch: `feat/m111d-node-first-cli`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

After this milestone the documented first run is Node: `npx @setu-ts/cli new <name>` or
`npm create @setu-ts <name>` scaffolds a project that installs every `@setu-ts/*` package from npm
under its real name, type-checks, lints and boots on Node, and `setu` itself ships as an npm
executable with a Node process boundary. The default `--runtime` becomes `node`. Deno, Bun and
Workers stay supported targets and take the framework from npm too (`npm:@setu-ts/*` in a Deno
import map, plain `@setu-ts/*` in every `package.json`); no `jsr:@setu-ts`, `@jsr/` alias or
`.npmrc` is emitted. Nothing is on npm until the `v0.9.0` cut, so every gate that installs a
scaffold resolves `@setu-ts/*` from a test-only local registry overlay serving this tree's own
packs.

The maintainer chose, on 2026-10-12: the scoped `@setu-ts/create` package; `tsx` as a regular CLI
dependency for loading a project's TypeScript; ESLint and Prettier inside generated npm-manifest
projects now rather than in 111e; and one milestone, one PR.

- **In scope:** the Node process boundary and npm `bin`; `@setu-ts/create`; `tsx` loading with the
  target project's own configuration; the `node` default everywhere a default is chosen; every
  emitted framework pin moved to npm; broker and queue client dependencies emitted for the selected
  arms; `typescript`, `eslint`, `typescript-eslint` and `prettier` with `check`, `lint` and `format`
  scripts in npm-manifest projects; `nodeModulesDir: "auto"` in Deno projects so the Node CLI can
  load them; runtime-aware migration runners and gRPC toolchains; adoption of a pre-0.9 project's
  `.npmrc`; the devtool pin check and source classifier taught the npm forms; `bin` support and
  executable-package validation in the release tooling; the registry overlay; the e2e gates moved to
  Node first; `check:deploy --generated` moved to the overlay; the first-run install lines.
- **NOT this milestone:** bumping to `0.9.0`, the placeholders, trusted publishing and the live exit
  proof (the `v0.9.0` cut); porting `scripts/` and root `test/` to Node and the repository's own
  Prettier/ESLint (111e); every other install line, the JSR → npm `docs/upgrading.md` entry and the
  JSR README sunset (111f); loading a pre-0.9 Deno project (JSR pins, no `node_modules`) from the
  Node CLI (it is refused by name, §3.4; the upgrade path is 111f's).

## 1. Contracts verified from SOURCE (not names)

Read on 2026-10-12 against `develop` at `57d37d4e`, plus an independent read-only review of this
plan's first draft. External facts carry the date they were probed.

| Reference                       | Source (file:line)                                                                                                                                                                                                                                                                                 | Verified surface / fact                                                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Defaults to Deno                | `cli/src/commands/new.ts:669`, `commands/new-interactive.ts:177`, `workspace/root-files.ts:59`, `workspace/member-host.ts:43`, `workspace/library.ts:71`, `workspace/discovery-module.ts:102`, `workspace/compose.ts:401`, `utils/runtime-detector.ts:114-116`, `workspace/runtime-profile.ts:304` | Each falls back to `'deno'`. `workspace/manifest.ts:386-391` is a deliberately historical fallback for manifests written before the runtime was recorded and stays.                                                                           |
| Framework pins                  | `cli/src/templates/project-files.ts:44`, `:1035-1085`; `commands/add.ts:599-606`; `commands/devtool.ts:87`                                                                                                                                                                                         | `RANGE = ^${VERSION}` feeds the template emitters; `add` and `devtool` build their own ranges. Deno emits `jsr:@setu-ts/<pkg>@^V`; npm manifests emit `npm:@jsr/setu-ts__<pkg>@^V`.                                                           |
| `.npmrc`                        | `project-files.ts:1573`, `:1856`; `workspace/root-files.ts:184-189`; `commands/add.ts:806-834`; `workspace/adopt.ts:41`, `:153`                                                                                                                                                                    | Emitted for Workers, standalone npm targets and npm workspaces; `add` advises the `@jsr` line; adoption MOVES a project's `.npmrc` into the member.                                                                                           |
| npm Dockerfile                  | `cli/src/workspace/compose.ts:268-272`                                                                                                                                                                                                                                                             | `COPY package.json <lock>* .npmrc ./` — a literal, so an image build fails once `.npmrc` is not emitted.                                                                                                                                      |
| npm-target scripts and tsconfig | `project-files.ts:1324-1333`, `:1395-1415`, `:1433`, `:1454`                                                                                                                                                                                                                                       | `moduleResolution: 'bundler'` without `allowImportingTsExtensions` while emitted imports end in `.ts`; scripts are `start`/`test` (+ `build`/`dev`), no `check`, no lint; devDependencies are `@types/node` and `tsx` only.                   |
| Broker selection                | `cli/src/templates/broker.ts:42-54`; `workspace/transport.ts:270-…`                                                                                                                                                                                                                                | Rewrites `MessagingPlugin`/`QueuePlugin` arguments only; adds no client dependency, while every client is an OPTIONAL peer (`messaging-plugin/package.json` `peerDependenciesMeta`) that npm does not install.                                |
| Migration runner                | `cli/src/schematics/migration.ts:150-151`, `:189-190`                                                                                                                                                                                                                                              | Emits Deno commands and reads `Deno.args`.                                                                                                                                                                                                    |
| gRPC toolchain                  | `cli/src/workspace/proto-toolchain.ts:49`, `:118`; `workspace/member-host.ts:135-137`                                                                                                                                                                                                              | `deno run -A npm:@bufbuild/buf…` and Deno tasks only.                                                                                                                                                                                         |
| Devtool                         | `cli/src/devtool/planner.ts:254`; `commands/devtool.ts:958-971`; `devtool/sources.ts:250-262`                                                                                                                                                                                                      | Deno-target only; pin check accepts only `jsr:@setu-ts/<pkg>@^V`; classifier accepts `jsr:`, `jsr:/`, `npm:@jsr/` and workspace paths, refusing anything else (audit rounds 6–7).                                                             |
| Process boundary                | `cli/src/main.ts:37`, `:62-88`; `cli/src/prompt.ts:55`, `:83`                                                                                                                                                                                                                                      | `denoProcess()` over `Deno.args`/`cwd`/global `prompt()`/`Deno.listen`, under `import.meta.main`. `Prompter.select` returns a Promise; only the internal `promptFn` seam is synchronous. SIGINT reaches `runMain` through `runtime.onSignal`. |
| Node runtime services           | `runtime/src/index.ts:33`; `adapters/node/node-runtime.ts:197-240`                                                                                                                                                                                                                                 | `createNodeRuntimeServices()` supplies `fs`, `now`, `onSignal` — every member `MainRuntime` reads.                                                                                                                                            |
| Project TS loading              | `cli/src/app-loader.ts:145`, `:154-160`; `schematics/custom.ts:34`                                                                                                                                                                                                                                 | A bare `import(url)`; config resolves bare framework imports from the project.                                                                                                                                                                |
| Manifest generation             | `scripts/node-manifests.ts:253-257`, `:397-430`; `scripts/node-dependency-ranges.ts:26-81`                                                                                                                                                                                                         | No `bin`; a dynamic import is classified as an optional peer; no `tsx` range exists.                                                                                                                                                          |
| `sideEffects` audit             | `scripts/side-effects.ts:7-10`, `:40-55`                                                                                                                                                                                                                                                           | A top-level expression statement is a finding unless its module is in `SIDE_EFFECT_MODULES`.                                                                                                                                                  |
| Executable packages             | `scripts/verify-release.ts:153-158`; `scripts/fixtures/node-boot/boot.mjs:14-19`; `compat/compat.test.mjs:134`; `test/apps-gate.test.ts:1042-1043`                                                                                                                                                 | Each refuses a package with empty exports; the boot fixture requires exactly 51 packages.                                                                                                                                                     |
| Coverage lanes                  | `scripts/test-lanes.ts:86`                                                                                                                                                                                                                                                                         | `packages/cli/src/main.ts` is Deno-lane only.                                                                                                                                                                                                 |
| Deploy gate                     | `scripts/check-deploy.ts:555`, `:567-650`, `:737`, `:804-812`, `:869`; `deno.json:71`                                                                                                                                                                                                              | Runs `main.ts` as the CLI, substitutes the latest JSR version, hardens only `lock.jsr` and refuses a zero strip count; its task's `--allow-net` names `jsr.io` alone.                                                                         |
| e2e helpers                     | `cli/test/fixtures/generated-project.ts:78-99`, `:117-132`, `:211-308`, `:339-440`                                                                                                                                                                                                                 | `useWorkspacePackages` rewrites `deno.json`; `denoCheck`, `bootAndSignal`, `bootAndProbe`, `withGeneratedServer` spawn `deno`.                                                                                                                |
| `npm create` (external)         | npm docs, `npm init` (2026-10-12)                                                                                                                                                                                                                                                                  | `npm create @setu-ts <args>` runs `npm exec @setu-ts/create`.                                                                                                                                                                                 |
| Overlay installers (probe)      | 2026-10-12: npm 11.16.0, Deno 2.9.6, Bun 1.4                                                                                                                                                                                                                                                       | Each resolved `@setu-ts/probe` from a `127.0.0.1` registry through `NPM_CONFIG_REGISTRY` alone and proxied a third-party package through it; Deno's `minimumDependencyAge: P7D` admitted a packument whose `time` is 2020.                    |
| Deno `node_modules` (probe)     | 2026-10-12, Deno 2.9.6                                                                                                                                                                                                                                                                             | With `nodeModulesDir: "auto"` and `"@setu-ts/probe": "npm:@setu-ts/probe@^0.8.0"`, `deno install` links `node_modules/@setu-ts/probe`, and Node + `tsx` load a `.ts` file importing it.                                                       |
| `tsx` (probe)                   | 2026-10-12, tsx 4.23.15, Node 24                                                                                                                                                                                                                                                                   | `tsImport` loads a TC39-decorated module; `context.metadata` is readable after import. It discovers configuration from the process, not the imported file, unless one is passed.                                                              |
| Lint toolchain (registry)       | 2026-10-12                                                                                                                                                                                                                                                                                         | eslint 10.12.0 (engines `^20.19 \|\| ^22.13 \|\| >=24`); typescript-eslint 8.71.1 peers `typescript >=4.8.4 <6.1.0`; prettier 3.9.10; typescript latest is 7.0.2, so generated projects pin `~6.0.3`.                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                             | Resolution (picked side)                                                                                 | Doc deliverable (same PR)                              |
| -- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| C1 | ROADMAP names `npm create setu` (unscoped); the maintainer chose scoped `@setu-ts/create`.           | `npm create @setu-ts`.                                                                                   | ROADMAP M111d bullet; the cut's package count 51 → 52. |
| C2 | `runtime-profile.ts:21` and `root-files.ts:184-187` say members need a root `.npmrc`.                | False once packages are on npm under their own names.                                                    | Source comments rewritten in this PR.                  |
| C3 | `compose.ts:269-271` says `.npmrc` "is not optional".                                                | Same; the `COPY` drops it.                                                                               | Source comment.                                        |
| C4 | `docs/releasing.md`, the ROADMAP cut section, `boot.mjs` and the compat inventory count 51 packages. | 52.                                                                                                      | Those four sites.                                      |
| C5 | AI_GUIDELINES §11.5 names one module-top-level exception; two `bin` entries execute at load.         | Executable entries reached only through `bin` are a second named class (maintainer-approved 2026-10-12). | §11.5 amended in this PR.                              |

## 3. Design decisions

### 3.1 The Node process boundary

- **Decision:** `src/main.ts` keeps `runMain(runtime, process)` and replaces `denoProcess()` with
  `nodeProcess()`: `process.argv.slice(2)`, `process.cwd`, `process.stdin.isTTY`, `console.log` /
  `console.error`, and `portAvailable` through a `node:net` listen-and-close on `127.0.0.1`.
  `MainProcess.prompt` becomes `(message, signal) => Promise<string | null>` (approved 2026-10-12):
  one `node:readline/promises` interface per question, created and `close()`d in a `finally`; its
  `'SIGINT'` event (a terminal Ctrl+C in raw mode never reaches `process.on('SIGINT')`) and the
  passed `signal` both cancel the question, which resolves `null` with the run's interrupt
  controller aborted; EOF (`'close'` before an answer) resolves `null`; a rejected `AbortError` maps
  to `null`. `createTerminalPrompter`'s internal `promptFn` becomes asynchronous; `Prompter.select`
  was already a Promise, so its contract is unchanged. The `import.meta.main` block is removed.
- **Why:** a blocking read cannot dispatch the SIGINT callback `main.ts:37` registers, and readline
  swallows a TTY Ctrl+C unless it is translated; an interface left open keeps the process alive past
  `exitCode`.
- **Test home:** `process-boundary.test.ts` (no host `Deno.` call in the CLI's own process code,
  §3.12); `node-process.test.ts` (line read, EOF → `null`, external abort during a pending question,
  the interface's `'SIGINT'` event, interface closed in every outcome, `portAvailable` both ways);
  `sigint-scaffold` drives a real pty Ctrl+C at a pending prompt (exit 130, nothing written).

### 3.2 The executable entries

- **Decision:** `src/bin.ts` (`#!/usr/bin/env node`) sets `process.exitCode` to
  `await runMain(createNodeRuntimeServices(), nodeProcess())` and returns; it never calls
  `process.exit`. It is not in `exports`. `scripts/node-manifests.ts` gains a `BIN_ENTRIES` table
  (`packages/cli` → `{ setu: './dist/bin.js' }`, `packages/create` → `{ create: './dist/bin.js' }`)
  read by `renderPackageJson`, so `--check` compares it like every other field. Both bin modules
  join `SIDE_EFFECT_MODULES` with the reason "an executable entry, reached only through `bin`".
- **Why:** an executable must run when invoked; `import.meta.main` is absent on Node 22. Setting
  `exitCode` lets piped output drain (Node documents the truncation `process.exit` causes).
  AI_GUIDELINES §11.5 is amended (C5), approved by the maintainer on 2026-10-12.
- **Test home:** `bin.test.ts` (in-process: importing the module with injected seams sets
  `exitCode`; a nonzero code propagates); `bin-e2e.test.ts` (packed and installed: `setu --version`,
  complete output through a pipe, exit code 2 on a usage error); `node-manifests.test.ts` (`bin`
  field rendered and checked).

### 3.3 Loading a project's TypeScript

- **Decision:** the default loaders in `app-loader.ts` and `schematics/custom.ts` call
  `tsImport(url, { parentURL, tsconfig })` from `tsx/esm/api`, reached through a literal lazy
  `import('tsx/esm/api')`. `tsconfig` is the target project's `tsconfig.json` when it exists, else
  `false` (no ambient discovery), so `--dir` never loads the caller's configuration. `tsx` is a
  REGULAR dependency of `@setu-ts/cli`: `node-dependency-ranges.ts` gains `tsx: '^4.23.0'` and a
  `regular-dependency` override for `packages/cli`, because the generator otherwise classifies a
  dynamic import as an optional peer.
- **Why:** the maintainer's choice; it handles decorators, which Node's type stripping rejects.
- **Test home:** `app-loader-real-import.test.ts`, `custom-schematic-real-import.test.ts` (real
  loader, a decorated module, invoked with `--dir` from another directory holding a conflicting
  `tsconfig.json`); `node-manifests.test.ts` (packed `@setu-ts/cli` lists `tsx` under
  `dependencies`).

### 3.4 Which projects the Node CLI can load

- **Decision:** npm-manifest projects resolve through their own `node_modules`. Deno projects emit
  `"nodeModulesDir": "auto"` at the project or workspace root (a member may not carry it — M62), so
  `deno install` links `node_modules/@setu-ts/*` and the same loader resolves them (probed, §1). A
  Deno workspace library is declared only in its `deno.json` (`workspace/library.ts:83`), which Node
  cannot read, so each generated Deno library also emits a minimal `package.json` (`name`, `type`,
  `exports` mirroring its `deno.json`); and Deno links it into the root `node_modules` (probed
  2026-10-12: a workspace with `nodeModulesDir: "auto"`, a library carrying both manifests and an
  app member depending on `npm:ms` produced `node_modules/@acme/shared` and a hoisted
  `node_modules/ms`, and Node + `tsx` loaded the member's config importing both). A Deno project
  with no `node_modules/@setu-ts/kernel` is refused by name before any import, naming
  `deno install`, and naming the upgrade guide for a pre-0.9 project still pinned to `jsr:`.
- **Why:** `tsImport` cannot read a Deno import map; linked `node_modules` makes the import map and
  Node resolution agree on the names both use.
- **Test home:** `app-loader.test.ts` (both refusals); `plugin-commands-e2e.test.ts` (a plugin
  command against a freshly installed Node project, a standalone Deno project, and a Deno workspace
  member whose config imports a workspace library).

### 3.5 Default target is Node

- **Decision:** the explicit defaults in §1's first row become `'node'` (`new.ts`, the interactive
  fallback, `root-files.ts`, `member-host.ts`, `library.ts`, `discovery-module.ts`, `compose.ts`,
  `runtime-profile.ts`). The detector is reordered rather than flipped: a `deno.json`/`deno.jsonc`
  means Deno, then a `package.json` decides Node or Bun as today, and only a directory with neither
  falls back to `node` — flipping the bare fallback would misread a Deno-only project.
  `workspace/manifest.ts:386-391` keeps `'deno'` for manifests written before the runtime was
  recorded. Help text and the prompt list `node` first.
- **Test home:** `new-command.test.ts`, `new-interactive.test.ts`, `help.test.ts`,
  `runtime-detector.test.ts` (Deno-only, Node, Bun and empty directories),
  `workspace-manifest.test.ts` (the historical fallback pinned).

### 3.6 Every framework pin comes from npm

- **Decision:** one internal `frameworkSpecifier(pkg, kind)` in `templates/framework-specifier.ts`
  returns `npm:@setu-ts/<pkg>@^V` for a Deno import map and `^V` for a `package.json`; the template
  emitters, `add.ts` and `devtool.ts` all call it. `.npmrc` is no longer emitted; `add.ts`'s JSR
  advice is deleted; the npm Dockerfile's `COPY` drops `.npmrc`.
- **Why:** one owner, so four emitters cannot drift (§11.1).
- **Test home:** `framework-specifier.test.ts`; `add-command.test.ts`; `dockerfile.test.ts`;
  `generated-manifests.test.ts` renders every template × target and asserts no emitted file contains
  `jsr:@setu-ts`, `@jsr/setu-ts__` or `npm.jsr.io` and no `.npmrc` is planned.

### 3.7 Generated npm projects type-check, lint and format

- **Decision:** every npm-manifest target (Node, Bun, Workers) gains devDependencies
  `typescript: ~6.0.3`, `eslint: ^10.12.0`, `@eslint/js: ^10.0.1`, `typescript-eslint: ^8.71.1`,
  `prettier: ^3.9.10`, and scripts `check` (`tsc --noEmit`), `lint` (`eslint .`), `format`
  (`prettier --write .`) and `format:check`. `eslint.config.js` is the NON-type-aware
  `tseslint.config(js.configs.recommended, ...tseslint.configs.recommended)` scoped to `**/*.ts` and
  `**/*.tsx`, with `consistent-type-imports` and `no-explicit-any` as errors,
  `@typescript-eslint/no-unused-vars` with `argsIgnorePattern: '^_'` (the factories emit `_devtool`
  and `_env`, `project-files.ts:441`), and `ignores` for build output and the config file itself.
  Type-aware presets are not used: they need parser project configuration per template for no rule
  this project relies on. `.prettierrc.json` (single quotes, width 100, two spaces) and
  `.prettierignore` (build output, lockfiles) are emitted. The generated tsconfig gains
  `allowImportingTsExtensions` and `noEmit`. Deno projects keep `deno fmt`/`deno lint`.
- **Why:** the maintainer's choice; the exit criterion says every template lints. TypeScript is
  pinned to 6.0 because typescript-eslint 8.71 refuses 6.1 and above.
- **Formatting is proved, not assumed:** the renderers are shared by Deno and npm targets, so the
  e2e formats every template with BOTH `deno fmt --check` and `prettier --check`. Implementation
  first measures their disagreements on a full scaffold; a renderer change that satisfies both is
  preferred, and a remaining genuine conflict is settled by a `.prettierrc.json` option, recorded
  here before the gate is written.
- **Test home:** `npm-tooling.test.ts` (manifest, configs and tsconfig per target);
  `scaffold-runs-e2e` runs `npm run check`, `npm run lint` and `npm run format:check` on every
  template with no repository tool on the path.

### 3.8 Broker and queue client dependencies

- **Decision:** `TransportSpec` gains `clientDependencies` (`redis` → `ioredis`, `rabbitmq` →
  `amqplib`, `kafka` → `kafkajs`, `nats` → `nats`, and the cloud arms → their SDK), each range read
  from one table that a test checks against `node-dependency-ranges.ts`. The renderer adds them to
  `dependencies` (npm targets) or the import map (Deno) for the selected `--broker`/`--queue`/
  `--transport` arms.
- **Why:** optional peers are never installed for the consumer; without this a selected broker fails
  at its lazy import on first boot.
- **Test home:** `broker-flags.test.ts`; `broker-scaffold-e2e` boots the Redis arm from an overlay
  install with no repository `node_modules` reachable.

### 3.9 Runtime-aware generated workflows

- **Decision:** on npm targets the migration schematic emits a runner whose entry guard is
  `import.meta.url === pathToFileURL(process.argv[1] ?? '').href` (Node has no `import.meta.main`
  before 24.2 and the `engines` floor is 22), reading `process.argv`, run by `tsx` through
  `db:migrate` / `db:migrate:down` scripts; Deno keeps `import.meta.main` and `Deno.args`. The gRPC
  toolchain on npm targets emits `buf.gen.yaml` with `local: protoc-gen-es`, devDependencies
  `@bufbuild/buf` and `@bufbuild/protoc-gen-es`, and a `proto:gen` script `buf generate` (both
  binaries resolve from `node_modules/.bin`); Deno keeps its current file.
- **Test home:** `migration.test.ts`, `proto-toolchain.test.ts` (both targets' emitted text);
  `generate-e2e` applies and reverts a migration on Node, and `workspace-e2e` runs
  `npm run proto:gen` and type-checks the descriptors, each with `deno` absent from `PATH`.

### 3.10 Adoption of a pre-0.9 project

- **Decision:** `adopt` keeps moving a project's `.npmrc` into the member (a user's registry setting
  is theirs), and after adoption rewrites any `npm:@jsr/setu-ts__<pkg>` dependency to
  `@setu-ts/<pkg>: ^V`, reporting each rewrite. It never writes a root `.npmrc`.
- **Test home:** `adopt-command.test.ts` (legacy alias rewritten and reported; `.npmrc` preserved).

### 3.11 Devtool recognises the npm forms

- **Decision:** `frameworkPinRefusal` accepts `npm:@setu-ts/<pkg>@^V` with an optional subpath and
  names the `jsr:` form as an older project needing the upgrade; `namesFrameworkPackage` adds
  `npm:@setu-ts/<pkg>` and `npm:/@setu-ts/<pkg>` with the same `'' | '@' | '/'` boundary.
- **Test home:** `devtool-sources.test.ts`, `devtool-refusals.test.ts` (each with a
  `npm:@setu-ts/kernelx` near-miss).

### 3.12 Scans assert what is emitted, not what is read

- **Decision:** the no-JSR guarantee is asserted over RENDERED output (§3.6), not by banning
  literals in `src` — `devtool/sources.ts` keeps reading legacy `jsr:` forms on purpose. The
  no-`Deno.` scan in `process-boundary.test.ts` covers the CLI's own process code and excludes the
  modules that emit Deno source text (`workspace/dev-runner.ts`, `devtool/dev-entry.ts`,
  `schematics/migration.ts`).
- **Test home:** the two tests named.

### 3.13 `@setu-ts/create`

- **Decision:** a new member `packages/create` (Tier 5, after `cli`), depending on `@setu-ts/cli`
  (`workspace:^`). `src/bin.ts` sets `process.exitCode` from `runMain(..., ['new', ...argv])`.
  `src/index.ts` exports `createArgs(argv)` — the pure argv mapping `bin.ts` uses — so the package
  has a real, tested export. Added to `PUBLISHED_PACKAGES`, `pnpm-workspace.yaml`, root
  `package.json` `workspaces`, the root `deno.json` workspace, the metadata table, and the
  placeholder list (derived from `PUBLISHED_PACKAGES`). `verify-release.ts`, `boot.mjs` and the
  compat suite learn an executable package: one with a `bin` is validated by its packed `bin` target
  existing and starting; a package with neither exports nor `bin` is still refused.
- **Why:** a wrapper rather than a copy, so `create` cannot scaffold differently from `setu new`.
- **Test home:** `packages/create/test/unit/create-args.test.ts`, `bin.test.ts`; `bin-e2e` runs
  `npm create @setu-ts` against the overlay; root `test/unit/verify-release-executable.test.ts`
  (new) and `apps-gate.test.ts` for the executable-package rule and count.

### 3.14 A local registry overlay

- **Decision:** `scripts/registry-overlay.ts` (root, imported by the CLI e2e fixtures and by
  `check-deploy.ts`): on start it runs `pnpm install --frozen-lockfile` and `pnpm exec tsc -b`,
  packs every published member with `pnpm pack --ignore-scripts` (the step extracted from
  `check-node-build.ts` into `scripts/pack-members.ts`, which both then call), validates each packed
  manifest's entrypoints exist, and caches the packs under `.tmp/overlay/<tree-hash>` keyed by a
  hash of every member's `src/`, `package.json` and `tsconfig.json` plus the root inputs every build
  inherits — `tsconfig.base.json`, the root `package.json`, `pnpm-lock.yaml`, and
  `scripts/pack-members.ts` itself. It serves `@setu-ts/*` packuments and tarballs on
  `127.0.0.1:<ephemeral>` and proxies everything else to `https://registry.npmjs.org`. Packument
  `time` defaults to `2020-01-01`; `publishedAt: 'now'` serves the current time. Installers are
  pointed at it through the environment only.
- **Why:** one mechanism serves npm, pnpm, Bun, Deno's `npm:` resolution and a Docker build, and
  always serves the tree's own version, so a version bump cannot deadlock the gates (M34b).
  Rewriting generated manifests to `file:` tarballs serves npm alone and edits the file under test.
- **Test home:** `test/unit/registry-overlay.test.ts` (serve, proxy, path refusal, `time` both ways,
  cache invalidated by a source edit, refusal when a packed entrypoint is missing).

### 3.15 Which gates run which target

Measured inventory: 78 scaffold call sites omit `--runtime` and silently become Node; every install,
check and boot helper in `generated-project.ts` is Deno-only (`useWorkspacePackages` rewrites
`deno.json`; the others spawn `deno`); `template-e2e.test.ts:777-806` duplicates `bootAndProbe`; six
assertions name `jsr:` pins (`generate-e2e.test.ts:153,194,245,303`, `devtool-e2e.test.ts:588`,
`scaffold-runs-e2e.test.ts:728`); no e2e installs or runs a Node, Bun or Workers project.

- **Decision:** a Node fixture family beside the Deno one: `installFromOverlay(root)`,
  `nodeCheck(root)` (`npm run check`), and `nodeBootAndProbe` / `nodeBootAndSignal` /
  `withNodeGeneratedServer`, which run the generated `start` script itself (so a full-stack build
  runs from an unbuilt scaffold). Deno install-and-boot cases install through the overlay too. The
  duplicate `bootAndProbe` is deleted. Per file:
  - `scaffold-runs-e2e`: every `BOOTABLE` template and the styled host on Node — install, check,
    lint, format check, generated test, boot, advertised endpoints; dotenv, Problem Details,
    middleware and full-stack cases on Node first. One Deno boot (`--template rest --runtime deno`)
    and the Deno-only cases, each with explicit `--runtime deno`. The dependency-age case stays on
    Deno and uses `publishedAt: 'now'`: install refuses with the generated setting removed and
    succeeds with it.
  - `template-e2e`, `generate-e2e`, `seam-probe`, `adopted-route-e2e`, `broker-scaffold-e2e`,
    `shutdown-e2e`, `workspace-e2e`, `workspace-mesh-e2e`: Node by default; workspace members
    install once at the root; the six `jsr:` assertions become npm forms; the class-based matrix
    visits Node first.
  - `devtool-e2e`: explicit `--runtime deno` throughout.
  - `dev-runner-e2e`: the Deno profile plus a Node-profile case for the npm runner.
  - `sigint-scaffold`: the subprocess runs the CLI's Node boundary through `tsx`, including an
    interrupt delivered while a prompt is pending.
  - `scaffold-interrupted`: fixtures follow the new default.
  - `workers-install-e2e`: unchanged.
  - new `bin-e2e` and `plugin-commands-e2e` (§3.2, §3.4, §3.13).
- **Test home:** the files named.

### 3.16 `check:deploy --generated`

- **Decision:** the gate runs the CLI through `node` + `tsx` on `src/bin.ts`, scaffolds the
  workspace with explicit `--runtime deno`, starts the overlay, and builds with `--network host` and
  `NPM_CONFIG_REGISTRY` as a build argument the generated Dockerfile's install step consumes only
  when set. The published-version substitution is deleted. The `lock.jsr` hardening
  (`check-deploy.ts:737`, `:804-812`) exists because Deno recorded a JSR package's npm edge list
  nondeterministically; implementation re-measures that on the npm-pinned lockfile (two installs,
  diff the `npm` section). If the npm section is deterministic, the hardening and its zero-count
  refusal are deleted with the measurement recorded here; if not, it is rewritten against the real
  `npm` entry shape with a negative control, and recorded here. The task's `--allow-net` adds
  `127.0.0.1` and `registry.npmjs.org`.
- **Why:** after this milestone no scaffold resolves its pinned version from any public registry
  until the cut. Deno keeps M95a's air-gapped `--frozen` proof, which is Deno-specific.
- **Test home:** `test/deploy-gate.test.ts`, plus the gate run itself.

### 3.17 Corrections made during implementation

Each item below replaced a plan claim that did not survive measurement or review; the design
sections above are left as written, and this list is what shipped.

- **§3.1 — one reader, not one interface per question.** A per-question `readline` interface lost a
  line typed ahead (both answers arrive while the first question is pending, and closing the first
  interface discards the second). `createLineReader` opens one interface for the run, queues lines
  that arrive while no question is pending, and closes in `MainProcess.dispose`, which `runMain`
  calls in a `finally`. A terminal Ctrl+C is delivered as the `SIGINT` EVENT (`emitInterrupt`),
  never `process.kill`, which terminates the process outright on Windows.
- **§3.7 — the CLI formats npm-target output with Prettier** (maintainer decision, 2026-10-12).
  Measured: `deno fmt` and Prettier disagree on 3–13 files per template (long calls, wrapped
  signatures, JSON arrays, JSX), and no renderer change satisfies both. Everything written into an
  npm-target project — `new`, `generate`, `add`, `app`, `library`, `adopt` — passes through
  `formatForTarget`, which resolves the project's Prettier config per destination file. TypeScript 6
  includes no `@types` package unless `types` names it, so the generated tsconfig names `node` or
  `bun`. `src/gen/` is ignored by both tools (a gRPC member's compiler output).
- **§3.9 — no `db:migrate` task.** The generated runner is run directly (`npx tsx`, `bun run` or
  `deno run -A src/migrations/run.ts`); the comment in the runner names the command.
- **§3.13 — `createArgs` is a real export**, so `@setu-ts/create` is validated like every other
  package; no executable-package rule was needed in `verify-release.ts`.
- **§3.14 — the overlay advertises canonical tarball routes** (`/@scope/name/-/name-V.tgz`), so a
  lockfile written against it names the same path npm uses; another version of a framework package
  is proxied upstream. `packMembers` requires an installed workspace rather than installing, takes
  ONE repository-wide build lock that records its owner and is reclaimed when that owner is dead,
  cleans staging on every failure, and hashes every member's README and licence and the solution
  `tsconfig.json`, `pnpm-workspace.yaml` and root licence (Codex review). Both scripts are tested on
  Node in the root `tooling` Vitest target, which measures their coverage, rather than in
  `SCRIPT_TARGETS`: the overlay binds a real socket, which the root Deno lane grants no permission
  for.
- **§3.15 — where Node coverage lives.** The type-drift e2e files (`template`, `generate`,
  `seam-probe`, `workspace`, `workspace-mesh`, `broker-scaffold`, `adopted-route`, `shutdown`)
  scaffold with an explicit `--runtime deno` and keep their Deno checks against workspace source:
  their assertions are about generated wiring, and running each as an npm install would multiply the
  suite's install count without asserting anything new. Node is proved end to end by a new
  `node-scaffold-e2e` (every host installed from the overlay and run through its own `check`,
  `lint`, `format:check`, `test` and `start`; generated code on both styles; a broker client; a
  graceful SIGTERM), `bin-e2e`, `plugin-commands-e2e` (installed Node and Deno projects, and the
  uninstalled-Deno refusal) and the npm-profile `dev-runner` cases. Workers hosts in
  `scaffold-runs-e2e` format-check with Prettier, not `deno fmt`. The dependency-age case runs
  against the overlay with `publishedAt: 'now'`, replacing the pin relaxation.
- **The workspace SSR negative control no longer discriminates.** With `nodeModulesDir: "auto"`, a
  Deno workspace links its libraries into `node_modules`, so Vite resolves and externalizes a
  library with or without the generated externals rule (measured both ways). The control is removed
  and the externalized import asserted positively; the rule stays for an unlinked layout.
- **`setu add` recognises an inline plugin-array anchor** (Prettier puts a short array on one line),
  and `importMapRetargets` reads an npm dependency's version range as naming the key's own package —
  the CLI's own plain-range pins had made every npm project count as retargeted (Codex review).
- **`devtool enable` reads the Deno manifest first**, so a directory with no manifest reports "not a
  project" and an npm project reports its runtime, instead of the Node default naming the wrong
  problem.
- **§3.16 — the `lock.jsr` hardening is deleted.** Measured: a Deno workspace with a Redis
  microservice member, installed and cached three times against the overlay with a fresh `DENO_DIR`
  each run, wrote byte-identical `npm` lockfile sections (30 entries, the same integrity hashes and
  edges, `@setu-ts/messaging-plugin` recording `ioredis` as an edge and optional peer) and no
  `@setu-ts` entry under `jsr`. The nondeterminism the strip existed for does not occur on the npm
  path, and there is nothing under `jsr` to strip, so `stripFrameworkNpmEdges`, `hardenScaffoldLock`
  and the zero-count refusal are removed; the generated image's `--frozen` boot under the gate is
  what proves the lockfile complete. The gate's devtool-exclusion probe also changed: it grepped
  `/deno-dir` file CONTENTS for `diagnostics-plugin`, and npm tarballs carry each package's README,
  whose Diagnostics sections in `events-plugin` and `queue-plugin` name the connector — so it failed
  a correct image. It now matches package PATHS in the cache and in `/srv/node_modules`, behind a
  positive control that the cache holds `@setu-ts/kernel`, and prints what it matched on failure.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** (maintainer-approved 2026-10-12) `MainProcess.prompt` changes from
synchronous to `(message, signal) => Promise<string | null>`; `denoProcess` is removed from
`@setu-ts/cli/main` and replaced by `nodeProcess`. Behaviour changes, CHANGELOG'd for users: the
default target is `node`; generated projects take the framework from npm; Deno projects create
`node_modules`. Ships in minor `0.9.0`.

| Exported symbol                        | Kind     | Consumer / real code path that READS it                 |
| -------------------------------------- | -------- | ------------------------------------------------------- |
| `runMain` (`@setu-ts/cli/main`)        | function | `packages/cli/src/bin.ts`, `packages/create/src/bin.ts` |
| `nodeProcess` (`@setu-ts/cli/main`)    | function | both `bin.ts` files                                     |
| `MainRuntime`, `MainProcess` (`/main`) | types    | `runMain`'s signature; `packages/create/src/bin.ts`     |
| `createArgs` (`@setu-ts/create`)       | function | `packages/create/src/bin.ts`                            |

### 4.1 Options — every option names its consumer

| Option                                   | Consumer                           | Behavior                                          |
| ---------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| `--runtime` default                      | `runNewCommand`, `runAppCommand`   | `node` when omitted                               |
| `NPM_CONFIG_REGISTRY` (Docker build arg) | generated npm and Deno Dockerfiles | install step only; absent → the public registry   |
| overlay `publishedAt`                    | `test/registry-overlay.ts`         | packument `time`: `2020-01-01` by default, or now |

## 5. Implementation files

| File                                                                                                                                                                                              | Purpose                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `packages/cli/src/main.ts`, `src/prompt.ts`, `src/bin.ts`                                                                                                                                         | Node boundary, async prompt, executable (§3.1–3.2) |
| `packages/cli/src/app-loader.ts`, `src/schematics/custom.ts`                                                                                                                                      | `tsx` loading and the Deno refusal (§3.3–3.4)      |
| the nine default sites in §1                                                                                                                                                                      | `node` default (§3.5)                              |
| `packages/cli/src/templates/framework-specifier.ts`, `project-files.ts`, `commands/add.ts`, `commands/devtool.ts`                                                                                 | npm pins (§3.6)                                    |
| `project-files.ts` (npm tooling), `templates/npm-tooling.ts`                                                                                                                                      | check/lint/format (§3.7)                           |
| `workspace/transport.ts`, `templates/broker.ts`                                                                                                                                                   | client dependencies (§3.8)                         |
| `schematics/migration.ts`, `workspace/proto-toolchain.ts`, `workspace/member-host.ts`                                                                                                             | runtime-aware workflows (§3.9)                     |
| `workspace/adopt.ts`, `workspace/root-files.ts`, `workspace/compose.ts`, `workspace/runtime-profile.ts`                                                                                           | adoption, no `.npmrc` (§3.6, §3.10)                |
| `devtool/sources.ts`                                                                                                                                                                              | npm forms (§3.11)                                  |
| `packages/create/*`                                                                                                                                                                               | new member (§3.13)                                 |
| `scripts/node-manifests.ts`, `node-dependency-ranges.ts`, `side-effects.ts`, `release-packages.ts`, `verify-release.ts`, `test-lanes.ts`, `fixtures/node-boot/boot.mjs`, `compat/compat.test.mjs` | release tooling (§3.2–3.3, §3.13)                  |
| `scripts/pack-members.ts`, `scripts/registry-overlay.ts`, `scripts/check-node-build.ts`                                                                                                           | overlay (§3.14)                                    |
| `scripts/check-deploy.ts`, `deno.json`                                                                                                                                                            | deploy gate (§3.16)                                |
| `AI_GUIDELINES.md` §11.5, `packages/cli/README.md`, `docs/getting-started.md`, `README.md`, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md` (Unreleased), `docs/releasing.md`, `ROADMAP.md`  | records and first-run lines                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                                  | src covered                                                                             | Key assertions                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cli/test/unit/process-boundary.test.ts`, `node-process.test.ts`                                                                                                           | `main.ts`, `prompt.ts`                                                                  | §3.1; `main.ts` moves from the Deno lane to the Node coverage target (`test-lanes.ts:86`)                                                                                                                                                                                                                                                                    |
| `cli/test/unit/bin.test.ts`; `cli/test/e2e/bin-e2e.test.ts`                                                                                                                | `bin.ts`                                                                                | §3.2 — `exitCode` set, never `process.exit`; piped output complete                                                                                                                                                                                                                                                                                           |
| `cli/test/unit/app-loader.test.ts`; `integration/*-real-import.test.ts`; `e2e/plugin-commands-e2e.test.ts`                                                                 | `app-loader.ts`, `schematics/custom.ts`                                                 | §3.3–3.4                                                                                                                                                                                                                                                                                                                                                     |
| `new-command`, `new-interactive`, `help`, `runtime-detector`, `workspace-manifest` tests                                                                                   | the default sites                                                                       | §3.5, historical fallback pinned                                                                                                                                                                                                                                                                                                                             |
| `framework-specifier`, `add-command`, `dockerfile`, `generated-manifests` tests                                                                                            | `framework-specifier.ts`, `add.ts`, `compose.ts`, `root-files.ts`, `runtime-profile.ts` | §3.6                                                                                                                                                                                                                                                                                                                                                         |
| `npm-tooling.test.ts`                                                                                                                                                      | `npm-tooling.ts`, `project-files.ts`                                                    | §3.7                                                                                                                                                                                                                                                                                                                                                         |
| `broker-flags.test.ts`                                                                                                                                                     | `transport.ts`, `broker.ts`                                                             | §3.8; ranges match `node-dependency-ranges.ts`                                                                                                                                                                                                                                                                                                               |
| `migration.test.ts`, `proto-toolchain.test.ts`                                                                                                                             | `migration.ts`, `proto-toolchain.ts`, `member-host.ts`                                  | §3.9                                                                                                                                                                                                                                                                                                                                                         |
| `adopt-command.test.ts`                                                                                                                                                    | `adopt.ts`                                                                              | §3.10                                                                                                                                                                                                                                                                                                                                                        |
| `devtool-sources`, `devtool-refusals` tests                                                                                                                                | `sources.ts`, `devtool.ts`                                                              | §3.11                                                                                                                                                                                                                                                                                                                                                        |
| `create/test/unit/create-args.test.ts`, `bin.test.ts`                                                                                                                      | `packages/create/src/*`                                                                 | §3.13                                                                                                                                                                                                                                                                                                                                                        |
| root `test/unit/node-manifests.test.ts`, `verify-release-executable.test.ts` (new), `registry-overlay.test.ts` (new), `test/apps-gate.test.ts`, `test/deploy-gate.test.ts` | the scripts named in §5                                                                 | `bin`, `tsx` dependency, executable-package rule, count 52, overlay, deploy gate; `scripts/registry-overlay.ts` and `scripts/pack-members.ts` join `SCRIPT_TARGETS` (`script-coverage.ts:47`); the process-orchestration halves of `check-deploy.ts` and `check-node-build.ts` stay outside it as today, with their decidable logic exported and unit-tested |
| e2e files per §3.15                                                                                                                                                        | template output                                                                         | Node first; one Deno boot; boot list membership asserted (M70h)                                                                                                                                                                                                                                                                                              |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m111d-node-first-cli
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage          # root tooling, per-file bar
pnpm test && pnpm test:coverage  # packages, per-file 90% enforced by the runner
deno task test:deno-lane
deno task check:node-build --require-all
deno task check:deploy --generated
deno task release:publish --dry-run
deno task release:verify 0.8.0
deno task check:docs
```

## 8. Risks & mitigations

- **The overlay's first pack is slow (51 + 1 members)** → packs are cached by tree hash; CI warms
  the cache once per job before the e2e step.
- **The proxy makes e2e depend on registry.npmjs.org** → already true for third-party packages; the
  overlay logs every proxied failure with its URL.
- **A Deno workspace's `nodeModulesDir: "auto"` may not link member dependencies at the root** →
  probed first during implementation; if members' packages are not reachable, the loader resolves
  from the member's own directory and the plan is corrected before proceeding.
- **eslint or prettier releases change a generated project's verdict** → exact-minor ranges plus the
  weekly dependency-drift job, which already exercises generated npm manifests.
- **Existing 0.8 projects** → refused by name with the upgrade path (§3.4); the guide is 111f's.

## 9. Out of scope

- The `v0.9.0` cut and its live proof.
- The repository's own Prettier/ESLint and porting `scripts/`/root `test/` (111e).
- Every other install line and the JSR sunset (111f).
- The Deno target's `jsr:@std/*` dependencies (JSR keeps operating).
