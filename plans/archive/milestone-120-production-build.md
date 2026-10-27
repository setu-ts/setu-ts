# Milestone 120 — A production build for generated services (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m120-production-build`. `main` and `develop` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Generated Node services stop running TypeScript through `tsx` in production. The `build` script
type-checks with `tsc --noEmit`, then a new `setu build` runs `setu check` (M118) and bundles the
service with esbuild into `dist/`, inlining workspace libraries and keeping every npm package
external. `npm start` runs the compiled output, and `start:dev` / `start:debug` run the source.
Every project gets a multi-stage image that ships production dependencies only and serves with a
read-only root and no network. Bun and Deno keep running their source natively, with production-only
images and the same `start:dev` / `start:debug` scripts. Closes **V10-54**, **V10-53** and
**V10-55**.

Decisions taken with the maintainer on 2026-10-27, after comparing current starters:

| Project (read 2026-10-27) | `start`                             | dev / debug                | build                                               |
| ------------------------- | ----------------------------------- | -------------------------- | --------------------------------------------------- |
| Hono Node starter         | `node dist/index.js`                | `dev: tsx watch`           | `tsc`                                               |
| AdonisJS web starter kit  | `node bin/server.js` (build output) | `dev: ace serve --hmr`     | `ace build` (framework CLI)                         |
| NestJS TypeScript starter | `nest start`, `start:prod: node …`  | `start:dev`, `start:debug` | `nest build` (framework CLI)                        |
| Nx `@nx/esbuild` executor | —                                   | —                          | bundles local code; third-party external by default |

Taken: the build is framework-owned (`setu build`, like `nest build` / `ace build`, Nx's bundling
rule); `start` is the compiled command (Hono, AdonisJS); the watch and debug scripts are `start:dev`
and `start:debug` (NestJS's names — `dev` is already a generated script on full-stack and devtool
projects).

- **In scope:** `packages/cli` — the `setu build` command; generated scripts and tasks for every
  Node, Bun and Deno template and workspace member; the workspace dev runner; the workspace and new
  standalone Dockerfiles and `.dockerignore`; `.gitignore` for `dist/` and `build/`; the migration
  runner's production command; next-step hints and READMEs; `scripts/check-deploy.ts`'s generated
  image gate; docs (`docs/deployment.md`, `docs/cli.md`, `docs/upgrading.md`, CLI README,
  `PUBLIC_API.md` commands, CHANGELOG); ROADMAP and CLAUDE.md status.
- **NOT this milestone:**
  - Building or deploying a whole workspace from its root — **M122** (`setu build` at a workspace
    root refuses and names the member form).
  - CSS builds — **M123** joins `build` and the image.
  - Workers — wrangler already bundles at deploy; unchanged.
  - `bun build` and `deno compile` — documented, not emitted (maintainer decision).

## 1. Contracts verified from SOURCE (not names)

| Reference                                              | Source (file:line)                                                                                       | Verified surface / fact                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm scripts                                            | `packages/cli/src/templates/project-files.ts:1615-1639`                                                  | `start: tsx main.ts` (Bun `bun run main.ts`); with an npm build `build: <manifest.npmBuild.script>`, `start: npm run build && tsx main.ts`, `dev` from `npmBuild.devEntry` (`tsx dev.ts`).                                                                         |
| Test scripts                                           | `project-files.ts:1585-1601`                                                                             | `test`/`test:e2e` under `tsx --test` (Bun `bun test`); with an npm build they run the build first. Unchanged by this milestone.                                                                                                                                    |
| `NODE_RUNNER`                                          | `project-files.ts:1658`                                                                                  | `'tsx'`; its JSDoc records why strip-types cannot run decorators or parameter properties.                                                                                                                                                                          |
| Standalone `.gitignore`                                | `project-files.ts:1986-2008`                                                                             | `node_modules/` (non-Deno), `coverage/`, `.wrangler/` (Workers), each `generatedOutputDirs` entry (`build/`, `.react-router/` on full-stack), the env file. No `dist/`.                                                                                            |
| Workspace root `.gitignore`                            | `packages/cli/src/workspace/root-files.ts:207-217`                                                       | npm/Bun: `node_modules/ apps/*/node_modules/ libs/*/node_modules/ coverage/ .react-router/ .env …`. No `build/` or `dist/` (V10-55).                                                                                                                               |
| Workspace npm/Bun Dockerfile                           | `packages/cli/src/workspace/compose.ts:262-321`                                                          | One stage on `node:24-alpine` / `oven/bun:1-alpine` (`:80`, `:86`); copies root manifest + lockfile, member manifest, `lib[s]`, installs everything, copies the member, `USER uid:uid`, `CMD ["sh","-c","npx tsx main.ts"]` (Bun `bun run main.ts`).               |
| Workspace Deno Dockerfile                              | `compose.ts:101-194`                                                                                     | Pinned Deno image, `deno cache`, `CMD ["run","--frozen",…,"main.ts"]` with scoped permissions.                                                                                                                                                                     |
| Kubernetes `/tmp`                                      | `packages/cli/src/workspace/k8s.ts:199-218`                                                              | `readOnlyRootFilesystem: true` plus an `emptyDir` at `/tmp` (for `tsx`'s cache).                                                                                                                                                                                   |
| Workspace dev runner                                   | `packages/cli/src/workspace/dev-runner.ts:243`                                                           | npm/Bun runner spawns `<pm> run start` per member; Deno runner `:125-128` runs `start` (or `dev` for the devtool member).                                                                                                                                          |
| Workspace library                                      | `packages/cli/src/workspace/library.ts:91`, `:114-115`                                                   | `exports: { '.': './src/index.ts' }` (and `main`): libraries ship source, which plain `node` will not load from `node_modules`.                                                                                                                                    |
| Migration runner                                       | `packages/cli/src/schematics/migration.ts:149-157`                                                       | Run as `npx tsx src/migrations/run.ts` (Node), `bun run …`, `deno run …`; its guard compares `import.meta.url` with `process.argv[1]`, so it works as its own bundle entry.                                                                                        |
| Full-stack server build path                           | `packages/cli/src/templates/full-stack.ts:109-123`                                                       | Non-Workers arm passes `serverBuildPath: new URL('./build/server/index.js', import.meta.url).href`; the Workers arm passes `serverBuild` (a module) when `createApp`'s third argument carries one. `createApp(env?, devtool?, ssr?)`.                              |
| `ReactRouterPlugin` build loading                      | `packages/react-router-plugin/src/handler/server-build.ts:141-170`                                       | `serverBuild` (module) skips the path import entirely; otherwise `await import(serverBuildPath)`.                                                                                                                                                                  |
| Next-step hint / README                                | `packages/cli/src/commands/new.ts:851-852`; `project-files.ts:1964-1965`                                 | Print `npm install && npm start` / `bun run start`.                                                                                                                                                                                                                |
| Deploy gate                                            | `scripts/check-deploy.ts:652-913`; `.github/workflows/ci.yml` (`check:deploy` step)                      | `--generated` scaffolds a **Deno** workspace, builds `docker/Dockerfile` with `MEMBER`, runs it `--read-only` with no external network until `/health` serves. Runs in CI.                                                                                         |
| `setu check`                                           | `packages/cli/src/commands/check.ts`, `diagnostics/*` (M118)                                             | `forEachProject`, `diagnoseProject`, `readSilence`, `renderCheckFindings`; ids, `setu.E0xx` errors exit 1.                                                                                                                                                         |
| CLI dependencies                                       | `packages/cli/package.json`                                                                              | `@setu-ts/common`, `@setu-ts/runtime`, `prettier`, `tsx` (which itself depends on `esbuild ~0.28.0`).                                                                                                                                                              |
| External: esbuild on a class-based scaffold            | probe 2026-10-27, esbuild 0.28.2, published `0.10.0`                                                     | `esbuild main.ts --bundle --platform=node --format=esm --packages=external --sourcemap` built in 2 ms; `node --enable-source-maps dist/main.js` served `/health` and `/greetings/ada` (TC39 decorators included).                                                  |
| External: full-stack server build as a module          | probe 2026-10-27                                                                                         | An entry that `import * as serverBuild from './build/server/index.js'` and calls `createApp(undefined, undefined, { serverBuild })`, bundled the same way, served SSR HTML (`<!DOCTYPE html>…app-shell`) and `/health` 200; react-router stays external.           |
| Members do not declare libraries                       | `packages/cli/src/workspace/library.ts:125-138`                                                          | A library is imported by name and "no member needs an entry for it"; a library declares its own dependencies in `libs/<name>/package.json`, which "do not extend" from the member.                                                                                 |
| External: npm installs a library's dependencies        | probe, npm 11.19.1                                                                                       | `npm ci --omit=dev --workspace apps/a --workspace libs` installed `a`, its dependency, the library and the library's production dependency — not the library's devDependency, not another member's dependency. With no `libs/` directory the same command exits 0. |
| External: Bun filtered install does not link libraries | probe, Bun 1.4.2                                                                                         | `bun install --production --frozen-lockfile --filter './apps/a' --filter './libs/*'` installed each package's own dependencies but linked no workspace package where the member could import it (`node_modules/` holds only `.bun/`).                              |
| DI boot validation (M125)                              | `packages/di-plugin/src/plugin/di-plugin.ts:107-116`; `packages/di-plugin/src/container/errors.ts:39-58` | `DiPlugin` calls `DiContainer.close()` from a bootstrap hook; it throws `ContainerValidationError` listing each `missing`, `cycle` and `captive` path. It needs a running bootstrap.                                                                               |
| The generated smoke test boots the app                 | `packages/testing/src/test-app.ts:156-190`; `packages/cli/src/templates/project-files.ts:2070-2085`      | `createTestApp` calls `app.start()`; the generated `test/app.test.ts` calls `createTestApp({ app: await createApp() })`, so `npm test` runs bootstrap and therefore DI validation.                                                                                 |
| External: npm per-member production install            | probe, npm 11.19.1                                                                                       | `npm ci --omit=dev --workspace apps/a` installed only `a` and its production dependency — not its devDependency, not another member's dependency.                                                                                                                  |
| External: Bun per-member production install            | probe, Bun 1.4.2                                                                                         | `bun install --production --frozen-lockfile --filter a` installed only `a`'s production dependency, into `apps/a/node_modules`.                                                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                               | Resolution (picked side)                                                                                                                                                                                                                                                                                                          | Doc deliverable (same PR)                            |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| C1  | ROADMAP decision 2 offers `start` with `start:prod`, or NestJS's `start`/`start:dev`, and names `dev`/`debug` scripts. | `start` = compiled; `start:dev` (watch) and `start:debug` (maintainer decision, §0). There is no `dev` or `debug` script on a non-full-stack project; on full-stack, the Vite `dev` entry is renamed `start:dev`.                                                                                                                 | ROADMAP M120 section corrected; upgrade-guide entry. |
| C2  | ROADMAP decision 1 leaves the workspace-library build open (tsc project references or an esbuild bundle).              | `setu build` bundles with esbuild and inlines libraries; libraries keep exporting source.                                                                                                                                                                                                                                         | ROADMAP M120 deliverable reworded.                   |
| C3  | ROADMAP decision 6 (interim `node --import tsx`) applies only "if this milestone is not soon".                         | Superseded: the milestone ships the compiled command. Bun and Deno already run source natively.                                                                                                                                                                                                                                   | ROADMAP M120 section notes it.                       |
| C4  | ROADMAP gate: images run read-only with no network "for every template × runtime".                                     | The deploy gate runs a Node workspace member (with a library), a Node standalone project and the existing Deno workspace. Bun images and the Deno standalone image are checked as rendered Dockerfiles in unit tests, and Bun is added to the gate if `oven/bun:1-alpine` builds within its time budget. The PR states which ran. | ROADMAP M120 gate line amended.                      |

## 3. Design decisions

### 3.1 `setu build`

- **Decision:** `commands/build.ts`, built-in verb `build`, flags `--dir`, `--dry-run`
  (`spec('build', ['dir', 'dry-run'], [], { fixed: 1, taken: 0, noun: 'no arguments' })`).
  1. Scope: a standalone project or a workspace member. At a workspace root it refuses with exit
     `2`, naming `--dir apps/<member>` (M122 owns root builds). Not a project: the
     `generate`/`check` message, exit `1`.
  2. Runtime: Node only (detected with `detectTargetRuntime`). Bun, Deno and Workers refuse with
     exit `2`, naming what runs instead (`bun run main.ts`, `deno task start`, `wrangler deploy`).
  3. Gate: runs the same diagnosis `setu check` runs (`diagnoseProject` + `readSilence`, rendered by
     `renderCheckFindings`). An error finding prints, nothing is built, exit `1`. Warnings print and
     the build continues.
  4. Entries: `main.ts`, plus `src/migrations/run.ts` when it exists. `main.dev.ts` is never an
     entry (M101f).
  5. Bundle (esbuild JS API): `bundle: true`, `platform: 'node'`, `format: 'esm'`,
     `target: 'node22'` (the CLI's own engine floor), `sourcemap: true`, `outdir: 'dist'`,
     `outbase: '.'` (so `dist/main.js` and `dist/src/migrations/run.js`), `logLevel: 'silent'`
     (errors are rendered by the command).
  6. External: every dependency name in the project manifest (`dependencies`, `devDependencies`,
     `peerDependencies`, `optionalDependencies`) and, for a workspace member, in every library
     manifest under the workspace's `libs/`, minus the libraries' own package names. Members never
     declare libraries (§1), so a library is bundled because it is not on the list, and its own
     third-party and framework dependencies stay external rather than being inlined twice. Node
     builtins are external under `platform: 'node'`. Optional peers stay external, so M113d's
     guarded `await import()` calls inside framework packages still run.
  7. Output: `dist/` is removed first only when it is a real directory inside the project
     (`assertInsideProject`); a symlinked `dist` is refused by name. Prints `built dist/main.js`
     (and the runner) and exits `0`. A bundle error prints esbuild's messages (file, line, text) and
     exits `1`.
  8. `--dry-run` runs the gate and prints the entries, the output paths and the externals, without
     bundling or writing.
  9. A runtime import of a development dependency fails the build. From esbuild's metafile, any
     external import whose package is declared only in `devDependencies` (of the project, or of the
     library that imports it) is an error naming the package and the importing file, with exit `1`.
     The production image installs no development dependencies, so this import would otherwise fail
     only when the container starts.
- **Why:** framework-owned builds (NestJS, AdonisJS). The externals list must follow the manifest as
  dependencies change, which a static script line cannot do (§0). A bundle removes the
  second-tsconfig problem (`nodenext`, `rewriteRelativeImportExtensions`).
- **Test home:** `test/unit/build-command.test.ts` (scope and runtime refusals, gate on and off,
  externals computation including libraries and their dependencies, a runtime devDependency import,
  `--dry-run` writes nothing, symlinked `dist`, esbuild error rendering through an injected
  bundler); `test/e2e/build-e2e.test.ts` (real esbuild over real scaffolds).

### 3.2 esbuild is a direct `@setu-ts/cli` dependency

- **Decision:** `esbuild` is added to `packages/cli` `dependencies` at the range `tsx` already
  resolves (`~0.28.0`), imported statically by `commands/build.ts`. It is not lazily loaded: `tsx`
  already requires it, so every install of the CLI already has it.
- **Why:** dependency approval is in this plan (maintainer choice, 2026-10-27). A transitive
  dependency is not a contract.
- **Test home:** `build-e2e.test.ts` uses the real package; `release:publish --dry-run` checks the
  packed manifest.

### 3.3 Generated scripts — Node

- **Decision:** for every Node template and workspace member:
  - `build: tsc --noEmit && setu build`; full-stack:
    `react-router build && tsc --noEmit && setu build`. esbuild strips types without checking them,
    so the type check runs first, in the script, where it is visible (maintainer decision,
    2026-10-27). `setu build` itself never runs `tsc`.
  - `start: node --enable-source-maps dist/main.js`. It no longer builds first, so full-stack does
    not rebuild on every start (V10-53's second half).
  - `start:dev: tsx watch main.ts`; full-stack: `tsx dev.ts` (the existing Vite dev entry, renamed
    from `dev`).
  - `start:debug: node --inspect --import tsx main.ts`; full-stack:
    `node --inspect --import tsx dev.ts`.
  - `lint`, `format`, `format:check` are unchanged; `check` is unchanged except on full-stack
    (§3.5). `test` and `test:e2e` are unchanged except on full-stack, where their build prefix
    becomes `react-router build` instead of `npm run build`: a test run needs the server build, not
    the bundle, and must not depend on `setu check`.
- **Why:** §0.
- **Test home:** `test/unit/project-files-scripts.test.ts` (each template × Node: exact scripts);
  node-scaffold e2e (§3.11).

### 3.4 Generated scripts — Bun and Deno

- **Decision:** production keeps running source.
  - Bun: `start: bun run main.ts` (unchanged), `start:dev: bun --watch main.ts`,
    `start:debug: bun --inspect main.ts`. Full-stack keeps `build: react-router build`, `start`
    stops building first, and `dev` is renamed `start:dev`.
  - Deno: `start` unchanged; new tasks `start:dev` (`deno run --watch <same permissions> main.ts`)
    and `start:debug` (`deno run --inspect <same permissions> main.ts`). The devtool's `dev` task
    and Deno full-stack's `dev` task are unchanged (Deno tasks are a separate namespace).
  - Deno full-stack is the exception, mirroring Node's full-stack rule (§3.3): its `main.ts` imports
    `build/server/index.js` (§3.5), which a fresh project does not have, so `start:dev` is
    `deno task install && deno run -A --watch dev.ts` and `start:debug` is
    `deno task install && deno run -A --inspect dev.ts` — the existing Vite development entry, which
    serves route modules itself and needs no production build. `-A` because the existing `dev` task
    already runs that entry with `-A` (`project-files.ts`, the `devEntry` arm).
- **Why:** maintainer decision (§0).
- **Test home:** `project-files-scripts.test.ts`; `deno-tasks.test.ts`.

### 3.5 Full-stack hands its server build to `createApp` as a module

- **Decision:** the full-stack `main.ts` imports `./build/server/index.js` statically and calls
  `createApp(undefined, undefined, { serverBuild })`, the Workers arm's existing shape. On the
  socket targets that arm also sets `assetsDir: './build/client/assets'` — the server serves the
  client bundle the page loads; on Workers the platform's asset binding does, so its arm sets none.
  (Review found the socket arm without it: HTML 200, every `/assets/*.js` 404.) This applies on
  Node, Bun and Deno, so `main.ts` stays byte-identical across the three, as `docs/cli.md` promises.
  `setu.config.ts` is unchanged and keeps `serverBuildPath` for callers that pass no module (the
  generated smoke test). Because `main.ts` now imports build output, each runtime's full-stack
  `check` builds the frontend first:
  - Node and Bun: `react-router build && tsc --noEmit && setu check`.
  - Deno:
    `deno task build && deno check main.ts setu.config.ts && deno run -A npm:@setu-ts/cli@^<version> check`.

  This is the Workers precedent from M118.

- **Why:** a bundle moves `import.meta.url` to `dist/main.js`, so the path form would resolve
  `dist/build/server/index.js`. The probe in §1 shows the module form serves SSR from the bundle.
- **Test home:** `full-stack-template.test.ts` (one `main.ts` across Node, Bun and Deno);
  node-scaffold e2e full-stack host builds, starts the compiled output and asserts rendered HTML
  (the M37c rule: visible content, not a status); the Deno full-stack `check` e2e (M118) still
  passes.

### 3.6 The workspace dev runner runs `start:dev`

- **Decision:** the npm/Bun runner spawns `<pm> run start:dev`. The Deno runner keeps `start` (Deno
  `start` still runs source).
- **Why:** `start` now needs a build, and the root `dev` command is for development.
- **Test home:** `test/unit/workspace/dev-runner.test.ts`; `dev-runner-e2e.test.ts`.

### 3.7 Images

- **Decision:**
  - **Node (workspace member and standalone):**
    - Stage `build`: the pinned Node image; copies manifests and lockfile, the member, and `lib[s]`;
      `npm ci`; `npm run build` (in a workspace, `--workspace apps/${MEMBER}`). The type check and
      `setu check` therefore both gate the image.
    - Stage `runtime`: the same base; copies the root manifest and lockfile, the member manifest and
      `lib[s]`; `npm ci --omit=dev` (in a workspace, `--workspace apps/${MEMBER} --workspace libs`,
      so the libraries' own production dependencies are installed — §1); copies `dist/` (and
      full-stack `build/`) from the build stage; `USER` uid:uid;
      `CMD ["node","--enable-source-maps","dist/main.js"]`.
  - **Bun:** stage `build` only for full-stack (`react-router build`). Runtime keeps today's file
    set and install command with `--production` added, copies the source (and full-stack `build/`),
    and runs `CMD ["bun","run","main.ts"]`. It does not use `--filter`: a filtered install links no
    library (§1), so the image would resolve imports differently from development.
  - **Deno:** the existing workspace Dockerfile shape (`deno cache` at build, `--frozen` scoped
    run), plus a `frontend` stage on `denoland/deno:debian-2.9.5` (the same Deno version, glibc).
    When the member's manifest declares a `build` task (full-stack) that stage runs
    `deno task build`; otherwise it creates an empty `build/`. The Alpine stage copies `buil[d]`
    from it before `deno cache main.ts`, which needs the static `build/server/index.js` import
    (§3.5); `.dockerignore` keeps a host `build/` out. Detect the task by parsing the manifest with
    the file's pinned `@std/jsonc`, not by grepping text. Why glibc: probed 2026-10-27,
    `deno task build` on the Alpine image fails — Vite's `rolldown` finds no musl native binding
    (`rolldown-binding.linux-x64-musl.node`); the Debian stage builds it.
  - **The single parameterized workspace file and full-stack.** `WorkspaceMember` carries no
    template, so each Dockerfile decides per member at build time: Node always runs
    `npm run build --workspace apps/${MEMBER}` (every Node member has `build`) and copies `build/`
    with the `buil[d]` bracket glob, the same absent-tolerant trick as `lib[s]`; Bun runs its build
    only when the member's `package.json` declares a `build` script, detected the same way. The
    implementation probes that a bracket glob in `COPY --from=build` tolerates an absent directory
    before relying on it; if it does not, the build stage creates an empty `build/` first.
  - **Standalone projects** (Node, Bun, Deno) get a root `Dockerfile` and `.dockerignore` in the
    same shapes, with the context at the project root and no `MEMBER` argument. Workers gets none.
  - `.dockerignore` (standalone and workspace root) excludes `node_modules/`, `dist/`, `build/`,
    `coverage/`, `.git/`, `.env` and `.env.*` (keeping `.env.example`), so neither a local install
    nor a secret file reaches the image.
  - The `NPM_CONFIG_REGISTRY` build argument and the M95a / V9-78 properties are kept: numeric user,
    read-only root, no network at runtime. The Kubernetes `/tmp` `emptyDir` stays: harmless, and Bun
    and Deno may still use `/tmp`.
- **Why:** ROADMAP decision 3; the per-member install probes in §1.
- **Test home:** `test/unit/workspace/compose.test.ts` / `test/unit/dockerfile.test.ts` (rendered
  shapes for each runtime, workspace and standalone); the deploy gate (§3.11).

### 3.8 `.gitignore`

- **Decision:** a standalone Node project ignores `dist/`; the workspace root template adds
  `apps/*/dist/` and `apps/*/build/` (npm/Bun) and `apps/*/build/` (Deno). Existing projects get the
  lines from the upgrade guide; nothing rewrites an existing `.gitignore`.
- **Why:** V10-55; the M118 rule that nothing rewrites a developer's file.
- **Test home:** `project-files-scripts.test.ts`; `test/unit/workspace/root-files.test.ts`.

### 3.9 Migration runner

- **Decision:** the Node runner prints and documents `node dist/src/migrations/run.js` for a built
  project and `npx tsx src/migrations/run.ts` in development. Bun and Deno are unchanged. Its guard
  already works as a bundle entry (§1).
- **Why:** ROADMAP decision 4.
- **Test home:** `schematics/migration.test.ts`; `build-e2e.test.ts` builds a project with a
  migration and runs the compiled runner's `--help` path (or its no-op path), exit 0.

### 3.10 Hints and READMEs

- **Decision:** the next-step hint becomes `npm install && npm run start:dev` (Bun:
  `bun install && bun run start:dev`; Deno: `deno task start:dev`). The README lists `start:dev`,
  `build` then `start`, and the image commands.
- **Test home:** `new-command.test.ts`; `project-files.test.ts`.

### 3.11 Gates

- **Decision:**
  - **Node scaffold e2e:** every Node host runs `npm run build`, then `npm start` (compiled), and
    requests its advertised endpoints. A workspace with a library: the member imports a runtime
    value from the library, builds, and serves it. A broken seam (an unlisted artifact) makes
    `npm run build` exit non-zero, name the file, and write no `dist/`; so does a type error, which
    `tsc --noEmit` reports before `setu build` runs.
  - **Deploy gate:** `check:deploy --generated` also builds a Node workspace member (with a library)
    and a standalone Node project with their Dockerfiles, and runs each `--read-only` with no
    external network until `/health` serves. The existing Deno case stays and gains a library under
    a root `nodeModulesDir: "auto"` (§3.15). A Bun workspace member with a library is added:
    measured 2026-10-27, `oven/bun:1-alpine` builds in about 33 s. Every full-stack image built by
    hand during review also requests one `/assets/*.js` the page references (the compiled e2e
    asserts it too).
- **Why:** the ROADMAP gate; the M63/M95a lesson that generated output is proven only by running it.

### 3.12 What the build checks for DI, and what it does not

- **Decision:** the build checks M125's typed tokens and nothing more. `tsc --noEmit` (§3.3) fails
  on an `InjectionToken<T>` / `ContainerToken<T>` misuse or a mistyped `resolve`. The container's
  graph validation (missing provider, cycle, captive dependency) runs only at boot (§1), and
  `setu build` never boots the app (the M118/M125 boundary). The generated smoke test does boot it,
  so `npm test` is where a graph error is caught before an image is built. The docs say so in those
  words: `docs/deployment.md` (before building an image) and `docs/cli.md` (the `setu build`
  section): "`build` type-checks DI tokens; graph validation happens at boot, so run `npm test`
  before building an image."
- **Why:** the maintainer asked whether the build covers M125's checks (2026-10-27). The answer must
  be in the docs and proven, not assumed.
- **Test home:** node-scaffold e2e, `class-based` host: after the existing passing `npm test`, add a
  service `@Injectable()` with `@Inject('m120-missing-token')` to `src/services/`. `npm run build`
  still succeeds (the type checker cannot see the graph), and `npm test` then exits non-zero with
  output containing `ContainerValidationError` and `missing:` naming the token. The fresh run is the
  positive control.

### 3.13 Upgrade path

- **Decision:** `docs/upgrading.md` gives the script, Dockerfile and `.gitignore` changes for
  existing Node, Bun and Deno projects and workspaces. Nothing rewrites existing scripts.
- **Test home:** docs gates.

### 3.14 A Bun workspace member resolves its libraries (merged-code defect, folded in)

- **Decision:** a Bun workspace root carries `bunfig.toml` with `[install]` `linker = "hoisted"`.
  - `setu new --workspace --runtime bun` writes it (`workspace/root-files.ts`).
  - `setu generate library` in a Bun workspace without it plans it (`workspace/library.ts`, written
    like the existing root edits: `managed`, reported): absent file → create it; a file already
    setting `linker = "hoisted"` → unchanged; a file setting any other `linker` → refused with a
    message naming the setting and why the library needs `hoisted`; a file without a `linker` key →
    refused rather than rewritten (TOML is not parsed here, so a merge could discard content), with
    the line to add.
  - The Bun workspace Dockerfile copies `bunfig.toml` (bracket glob, absent-tolerant) before its
    install, so the image links libraries exactly as development does (§3.7).
  - The `generate library` next-step text stays "run `bun install`", now true.
- **Why:** probed 2026-10-27 on Bun 1.4.2 (§8): a new workspace lockfile (`configVersion: 1`)
  installs with Bun's isolated linker, which links a workspace package only into packages that
  declare it, and members never declare libraries (`library.ts:125-138`). From clean installs:
  default → `Cannot find module '@m120/shared'`, exit 1; with the `bunfig.toml` above →
  `bun install` and `bun install --production` both resolve it, exit 0. `hoisted` is npm's layout,
  which the npm arm already relies on.
- **Test home:** `test/unit/workspace/root-files.test.ts` (Bun root has the file; npm and Deno do
  not); `test/unit/workspace/library.test.ts` (the four `bunfig.toml` cases); the compose test (Bun
  Dockerfile copies it); an e2e scaffolding a Bun workspace with a library, running `bun install`
  and importing the library from a member (guarded on `bun` being present, like the existing Bun e2e
  tests).

### 3.15 A Deno workspace image starts read-only when the root enables `node_modules` (merged-code defect, folded in)

- **Decision:** after its installs, the Deno image rewrites a root `nodeModulesDir: "auto"` to
  `"manual"` (the root manifest is plain JSON by then; parsed, never text-matched). Workspaces and
  standalone projects without the key are unchanged.
- **Why:** probed 2026-10-27 with the `develop` CLI (so not caused by M120) against the public
  registry: a Deno workspace with a full-stack member (which sets the root's
  `nodeModulesDir: "auto"`, M36c) and a library builds, but EVERY member's container — REST included
  — exits under `--read-only` with
  `File exists (os error 17), symlink '../../libs/shared' -> '/srv/node_modules/@rv/shared'`: under
  `"auto"` each `deno run` re-syncs `node_modules`. With `"manual"` (flag or config) the same image
  serves `/health` read-only with no network.
- **Test home:** `test/unit/workspace/compose.test.ts` (the rewrite step is present and runs after
  the installs, before `chown`); the deploy gate's Deno case gains a library and sets the root's
  `nodeModulesDir: "auto"` (its redis workspace refuses a full-stack member, which is what sets it
  in practice), so its REST member image runs against that root (§3.11).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none in `src/index.ts`. Generated output changes: `npm start` now
needs a build. Ships in minor 0.11.0, with an upgrade-guide entry.

| Exported symbol                            | Kind      | Consumer / real code path that READS it               |
| ------------------------------------------ | --------- | ----------------------------------------------------- |
| (no change to `packages/cli/src/index.ts`) | —         | —                                                     |
| `setu build` (command)                     | CLI verb  | generated `build` scripts; the images' build stage    |
| `runBuildCommand` (internal)               | function  | `cli.ts` `case 'build'`                               |
| `bundleExternals` (internal)               | function  | `runBuildCommand`; unit-tested directly               |
| `renderDockerfile` variants (internal)     | functions | `workspace/compose.ts`, standalone `project-files.ts` |

### 4.1 Options — every option names its consumer

| Option            | Consumer                         | Behavior (per implementation)            |
| ----------------- | -------------------------------- | ---------------------------------------- |
| `build --dir`     | `runBuildCommand` → `resolveDir` | Project to build; default CWD.           |
| `build --dry-run` | `runBuildCommand`                | Gate and plan only; no bundle, no write. |
| `build --help`    | `runBuildCommand`                | Usage, exit `0`.                         |

## 5. Implementation files

| File                                          | Purpose                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/index.ts`                   | Unchanged barrel.                                                                                                             |
| `packages/cli/src/commands/build.ts`          | `runBuildCommand`, `bundleExternals` (§3.1).                                                                                  |
| `packages/cli/src/cli.ts`, `src/flags.ts`     | `case 'build'`, `BUILD` spec, help.                                                                                           |
| `packages/cli/package.json`                   | `esbuild` dependency (§3.2).                                                                                                  |
| `packages/cli/src/templates/project-files.ts` | Node/Bun scripts, Deno tasks, standalone `.gitignore`, standalone Dockerfile and `.dockerignore`, README, full-stack `check`. |
| `packages/cli/src/templates/full-stack.ts`    | Full-stack comments and `dev` → `start:dev`; the `main.ts` itself is emitted by `project-files.ts` (§3.5).                    |
| `packages/cli/src/workspace/compose.ts`       | Multi-stage npm, Bun and Deno Dockerfiles (§3.7).                                                                             |
| `packages/cli/src/workspace/root-files.ts`    | Root `.gitignore` (§3.8), README commands.                                                                                    |
| `packages/cli/src/workspace/dev-runner.ts`    | `start:dev` (§3.6).                                                                                                           |
| `packages/cli/src/schematics/migration.ts`    | Production runner command (§3.9).                                                                                             |
| `packages/cli/src/commands/new.ts`            | Next-step hint (§3.10).                                                                                                       |
| `scripts/check-deploy.ts`                     | Node workspace and standalone image cases (§3.11).                                                                            |
| `packages/cli/src/workspace/library.ts`       | Bun `bunfig.toml` root edit for older workspaces (§3.14).                                                                     |
| `scripts/toolchain-prose.ts`                  | Allowlist entries for the legitimate Deno-target `deno task start` guidance in `commands/build.ts` and its unit test.         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                      | src covered                                             | Key assertions                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/build-command.test.ts` (new)                                        | `commands/build.ts`                                     | §3.1 items 1–8 through an injected bundler and fake fs; externals exclude libraries and include optional peers.                                                                                                                                                                                     |
| `test/e2e/build-e2e.test.ts` (new)                                             | `commands/build.ts` with real esbuild                   | rest, class-based and full-stack scaffolds build; the compiled output serves; a workspace member inlines a library that has its own third-party dependency, and that dependency stays external; an unlisted artifact fails the build with `setu.E003` and no `dist/`; migration runner entry built. |
| `test/unit/project-files-scripts.test.ts` (new)                                | `templates/project-files.ts`, `templates/full-stack.ts` | Exact scripts and tasks per template × runtime; `.gitignore` lines; standalone Dockerfile and `.dockerignore` presence and shape.                                                                                                                                                                   |
| `test/unit/dockerfile.test.ts`, `test/unit/workspace/compose.test.ts` (extend) | `workspace/compose.ts`                                  | Node multi-stage (two `FROM`, `npm ci --omit=dev --workspace`, `CMD node --enable-source-maps dist/main.js`, numeric `USER`); Bun `--production` and no `--filter` (§3.7); Deno runs `deno task build` before `deno cache` only for a member declaring `build`; Node copies `buil[d]`.              |
| `test/unit/workspace/root-files.test.ts` (extend)                              | `workspace/root-files.ts`                               | Root `.gitignore` gains `apps/*/dist/`, `apps/*/build/`.                                                                                                                                                                                                                                            |
| `test/unit/workspace/library.test.ts` (extend)                                 | `workspace/library.ts`                                  | The four Bun `bunfig.toml` cases (§3.14); npm and Deno libraries write no `bunfig.toml`.                                                                                                                                                                                                            |
| `test/unit/workspace/dev-runner.test.ts` (extend)                              | `workspace/dev-runner.ts`                               | npm/Bun spawn `run start:dev`; Deno unchanged.                                                                                                                                                                                                                                                      |
| `test/unit/schematics/migration.test.ts` (extend)                              | `schematics/migration.ts`                               | Node prints both commands.                                                                                                                                                                                                                                                                          |
| `flags.test.ts`, `help.test.ts`, `positional-refusal.test.ts` (extend)         | `flags.ts`, `cli.ts`                                    | `build` inventory, help, `setu build extra` refused.                                                                                                                                                                                                                                                |
| Existing pins of scripts, Dockerfiles and the template baseline (extend)       | templates                                               | Reviewed edits, never regenerated snapshots.                                                                                                                                                                                                                                                        |
| `test/e2e/node-scaffold-e2e.test.ts` (extend)                                  | generated output                                        | §3.11 first bullet; §3.12 (a broken DI graph builds, then fails `npm test` naming the token).                                                                                                                                                                                                       |
| `test/deploy-gate.test.ts` (extend, root tooling)                              | `scripts/check-deploy.ts`                               | New generated cases' command construction; the run itself is CI's `check:deploy`.                                                                                                                                                                                                                   |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m120-production-build
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run ci:local          # on the final commit, alone (check for other suites first)
pnpm run check:deploy      # generated images, read-only, no network
pnpm run release:publish --dry-run
pnpm run release:verify 0.10.0
```

## 8. Risks & mitigations

- **A dependency the code imports is not in the manifest.** esbuild would inline it, or fail to
  resolve it. → esbuild's resolution error names the specifier, and the image proves the runtime
  install has it.
- **CommonJS-only packages imported from ESM output.** They stay external, so Node's own ESM/CJS
  interop applies, exactly as under `tsx`. → The e2e runs every template compiled.
- **A user's own `import.meta.url` relative path moves with bundling.** → Documented in
  `docs/deployment.md` (resolve from `process.cwd()` or pass modules in, as §3.5 does). The
  generated templates have none left (§1).
- **A Bun member's library imports.** Bun's default install links a workspace package only into
  packages that declare it, and members do not declare libraries (§1). Whether a Bun member resolves
  a library in development today is unverified. → The implementation probes it first. If it does not
  resolve, that is a defect in merged code outside M120, raised to the maintainer; the Bun image
  keeps development's resolution in both cases (§3.7). **Probed 2026-10-27 (Bun 1.4.2): it does not
  resolve.** A Bun workspace with `libs/*` in its root `workspaces`, after `bun install`, fails
  `import '@m120/shared'` from `apps/api` with `Cannot find module`; nothing is linked under
  `node_modules/@m120`. Raised to the maintainer as a merged-code defect; the maintainer folded the
  fix into M120 (§3.14).
- **`npm start` habits.** → The next-step hint, README and upgrade guide all name `start:dev`.

## 8a. Design security review

**Written before the committed-tree audit, from the design (maintainer direction, 2026-10-27).**
M120 crosses three trust boundaries: `setu build` runs in CI on a checkout an outsider controls
(M118's flow, now with a bundler and filesystem writes); the generated images are what a deployment
exposes to the network; and the generated scripts open a debugger port. The audit holds the
committed tree to the decisions and obligations below.

- **Reviewed flows:**
  1. `setu build` (with and without `--dry-run`) in CI on an untrusted pull-request checkout,
     standalone and as a workspace member, through the generated `npm run build`.
  2. A generated image (Node, Bun, Deno; workspace member and standalone; full-stack and not)
     serving network clients under `--read-only` with no external network.
  3. A generated image's build: what enters the build context and what reaches the final stage.
  4. `setu generate library` writing a Bun root `bunfig.toml` (§3.14).
  5. The generated `start:debug` / `start:dev` scripts on a developer machine.
- **Assets:** the filesystem outside the project (CI runner, developer machine); the CI runner's
  availability; the integrity of the build's refusals (the `setu check` gate and the devDependency
  gate must not be bypassable by a malformed input); the deployed server's files that are not public
  (the server build, source, `.env`, manifests); the image's secrets and the terminal/CI log.
- **Attackers:** (a) a pull-request author controlling every file in the checkout — sources,
  `package.json` of the member and of every `libs/*`, directory and file names, symbolic links
  (`dist`, `libs/<name>`, `bunfig.toml`, `src/migrations/run.ts`) — but not the CLI, esbuild or the
  runner; (b) any network client of a deployed image; (c) another local user or process on the
  developer's machine, or a web page in their browser. Out of scope: a maintainer who merges the
  code (it then runs as the application), and the project's own `scripts` (CI running
  `npm run build` already runs whatever the PR puts there; `setu build` is what the gate trusts).
- **Decisions:**
  - **D-S1 `setu build` executes no project code.** esbuild resolves and transforms; no esbuild
    plugin, no `tsconfig` `paths` plugin, no loader that runs code. `setu check` runs first and is
    read-only (M118 D-S4). Type checking stays in the script (`tsc --noEmit`), outside `setu build`.
  - **D-S2 Writes stay inside the project.** `dist/` is removed only when it is a real directory
    inside the project (`assertInsideProject`; a link is refused by name); every esbuild output path
    is checked the same way before it is written; nothing is written on a refusal or a bundle error,
    and `--dry-run` writes nothing.
  - **D-S3 Bounded, link-checked reads.** Manifests are read through `readExistingText` (the CLI's
    bounded regular-file read); every `libs/<name>` is checked with `assertInsideProject` before its
    manifest is read; the wiring gate keeps M118's bounds (D-S1–D-S6 there).
  - **D-S4 Output is escaped.** Every message carrying a path, a package name or esbuild text passes
    `escapeTerminalControls`.
  - **D-S5 The image ships production only.** The Node final stage has `dist/`, `build/` and a
    `--omit=dev` install; Bun installs `--production`; the Deno final stage carries no build output
    beyond `build/`, but its full-map install keeps frontend tooling in `node_modules` (accepted,
    §8b F4). `.dockerignore` keeps `.env` / `.env.*` (except `.env.example`), `.npmrc` (§8b F2),
    `.git`, host `node_modules`, `dist` and `build` out of every context. Source maps ship in
    `dist/` (they map to code already in the image; accepted, used by `--enable-source-maps`).
  - **D-S6 The image keeps M95a/V9-78's posture.** Numeric non-root `USER`, read-only root, no
    network at runtime; Deno keeps `--frozen` and its explicit permission set. The `"manual"`
    rewrite (§3.15) runs with read/write limited to the root manifest.
  - **D-S7 Assets serve only the client build.** The socket full-stack server serves
    `build/client/assets` (and the client-build root, `publicFiles`) through the plugin's existing
    static handler and its traversal check; `build/server/` and anything above the client build are
    never reachable by URL.
  - **D-S8 The debugger listens on loopback only.** `start:debug` uses each runtime's default
    inspector address; it ships only in the development scripts, never in an image `CMD`.
  - **D-S9 `bunfig.toml` writes are managed writes.** Created only when absent, through the CLI's
    write path (link refusal, overwrite check); an existing file is never rewritten.
- **Audit obligations:**
  1. `dist` as a symlink to a directory outside the project, and as a regular file: `setu build`
     exits `1`, the target is untouched (sentinel), nothing is written. Positive control: a real
     `dist/` is replaced.
  2. A `libs/<name>` symlinked outside the workspace and a `package.json` over the read bound:
     refused, exit non-zero, nothing written.
  3. A `src/migrations/run.ts` symlinked outside the project: no output written outside `dist/`.
  4. An entry whose import is a devDependency — through a library, a re-export and a dynamic
     `import()` with a literal: each refused (or, if esbuild leaves the dynamic form unresolved, the
     behaviour recorded). Positive control: a `dependencies` import builds.
  5. esbuild error text and a package name carrying terminal control sequences: escaped in output.
  6. No esbuild plugin and no project code execution during `setu build` (a `postinstall`-free
     fixture whose sources would write a sentinel if executed: sentinel absent).
  7. Each built image: `/assets/../server/index.js`, its percent-encoded forms (`%2e%2e%2f`,
     `%2e%2e/`, double-encoded) and `/../build/server/index.js` return 404, never the server bundle;
     `/.env` and `/package.json` return 404. Positive control: a referenced `/assets/*.js`
     returns 200.
  8. Each final image (Node, Bun, Deno; workspace and standalone): no `.env` file, no `.git`, no
     devDependency package (Node: none of the member's `devDependencies` under `node_modules`),
     process user is uid 1000, root filesystem read-only. Positive control: a `.env.example` is
     present when the project has one.
  9. `start:debug` on Node, Bun and Deno: the inspector's listening address is loopback (measured
     with `ss`/`lsof`, not assumed); no image `CMD` contains `--inspect`.
  10. `bunfig.toml` as a symlink to a file outside the workspace: `setu generate library` refuses
      and writes nothing through it.
  11. Re-confirm M118's passed areas on the `setu build` path: bounded reads, linear parsers,
      symlinked members refused.

### 8b. Audit round 1 (commit `87038ce0`) — dispositions

Round 2 (fresh agent, `e645a483`): **passed with accepted risks**, no new security finding. Its
non-security items were fixed (N1 clean refusal for an unreadable `bunfig.toml`, N2 docs for a
build-secret `.npmrc`, N3 this D-S5 wording, the doubled path in read errors) or recorded (N4).

The fresh-agent audit failed only for want of dispositions: 1 Medium, 6 Low, no Critical/High; all
eleven obligations ran with positive controls and nine reverted controls each failed their probe.
Maintainer dispositions (2026-10-27), each checked against established tools:

| #   | Finding                                                                                                                            | Disposition                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2  | `.npmrc` ships in Bun/Deno images                                                                                                  | **Fixed:** `**/.npmrc` in every generated `.dockerignore`. Docker's own `docker init` list omits it; Docker's guidance for a registry token is a `--mount=type=secret` build secret, which the docs now name. `bunfig.toml` is still copied (the linker needs it), so it must name tokens via environment variables.                          |
| F1  | Manifest reads follow a link out of the project (library `package.json`, `bunfig.toml`, and the pre-existing `detectProject` read) | **Fixed, folded in:** the CLI's bounded reader opens with `O_NOFOLLOW`, as its writer already did, so every manifest read refuses a link as the file itself and names it; linked directories stay `assertInsideProject`'s. This repo's M118 rule (no reads through links), not an industry norm — bundlers and package managers follow links. |
| F7  | A package in `devDependencies` and `peerDependencies` passes the gate; `npm ci --omit=dev` omits it                                | **Fixed:** only `dependencies` and `optionalDependencies` count as production (npm's documented `--omit` behaviour, measured on npm 11.19.1).                                                                                                                                                                                                 |
| F5  | A refused or failed build had already deleted the previous `dist/`                                                                 | **Fixed, Vite's way:** the bundle is produced in memory and gated before `dist/` is replaced (Vite's `emptyOutDir` empties on write; NestJS's opt-in `deleteOutDir` deletes first). D-S2 now holds as written.                                                                                                                                |
| F4  | The Deno full-stack final image carries Vite and TypeScript                                                                        | **Accepted risk:** the final stage's full-map install is what completes broker npm edges (M101f, measured); the tools are not network-reachable and the image is read-only. Revisit with a `deno install --entrypoint` probe against every broker.                                                                                            |
| F6  | `setu build` inlines any host file the sources import                                                                              | **Accepted risk:** esbuild, Vite, webpack and `tsc` all follow imports anywhere on disk; reaching a host file needs pull-request code, which CI already executes through `npm test`. D-S3 bounds manifest reads only.                                                                                                                         |
| F3  | A member's own `.git` reaches Bun/Deno workspace images                                                                            | **Not changed:** the generated root-only `.git` matches `docker init`; a member with its own repository is a submodule layout the generator does not create.                                                                                                                                                                                  |
| N4  | Re-audit: where `O_NOFOLLOW` is undefined (Windows) the reader follows links                                                       | **Accepted limitation:** the same `?? 0` fallback the writer has always used; Setu's CI and generated images are Linux.                                                                                                                                                                                                                       |

## 9. Out of scope

- Root-level workspace build, test and deploy — M122.
- CSS and asset builds — M123.
- `bun build`, `deno compile`, single-executable images — documented only.
- Minification or comment removal — not wanted (the build-step review, §4).
- A `--mount=type=secret,id=npmrc` line in the generated Node/Bun install steps (§8b F2/N2) — a
  follow-up, maintainer decision 2026-10-27: it needs BuildKit, Compose `build.secrets` and probes
  of the optional-secret, Bun and builder behaviour first. M120 documents the pattern instead.
