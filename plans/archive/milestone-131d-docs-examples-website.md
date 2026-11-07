# Milestone 131d — Documentation, Examples and the Website (docs, `apps/`, READMEs, website, `cli` text)

> **Status:** Complete (PR #564). Implemented by opencode (DeepSeek) and Claude after the maintainer
> ruled out Codex; reviewed by a fresh-agent code review and doc fact-check. Branch:
> `docs/m131d-docs-examples-website` (a **docs** letter of M131, so one `docs/…` branch, as M119i,
> which also carried `packages/cli/src` and `scripts/` changes; a `docs/` PR gets no CodeRabbit
> review, so §7 adds a fresh-agent code review). `develop` and `main` are protected — all work stays
> on this branch until it merges via a single PR.

## 0. Objective & scope

The last `0.11.0` smoke letter: rows where a reader following the documentation, an example or a
generated README ends up wrong, plus what M131a–M131c left to the documentation batch. Sources: the
ROADMAP M131d section, `~/Projects/hono-enterprise-plans/0120/M131d.md`, `smoke/OPEN-AFTER-0110.md`
G10, the Part 20 reports under `~/Projects/hono-enterprise-published-smoke/v0.11.0/part20/`, and the
regression run's `g5`, `g7` and `g8` findings. Each row was re-checked against `develop` at
`ca9a66f50` on 2026-11-06; §1 cites where it still holds.

- **In scope:**
  - **Upgrade guide:** X90-1 (the #526 controllers break), V11-18 (`setu agents --check` after an
    upgrade, recurring in 0.12.0), V10-16 remainder (`@types/node` and `waitUntil`), V11-16 (the
    Deno import-map startup claim), and a 0.12.0 subsection for M131c's generated-output changes
    (§3.3, no row).
  - **Release bookkeeping:** X93-4 (the CHANGELOG `[0.11.0]` link definition, and a bump step and
    release check so the next cut cannot miss it), X93-5 (the versioning policy on the website, and
    cross-page anchors checked).
  - **Examples:** X93-1 (`ws` in `graphql-demo`, with a WebSocket smoke), X93-6 (repository-only
    README text; the rest-api port).
  - **Deployment:** X93-2 (the collector config inlined; scaffolded deployment first, `setu build`
    named), the authenticated-registry walkthrough M131c deferred (X87-5's doc half), a
    `setu workspace build|deploy` section in `docs/cli.md`, and the wrong "A standalone project"
    paragraph found while planning (§3.10).
  - **READMEs and guides:** X89-3 (full-stack login through password-only `signIn`), V11-17 (logger
    records), X91-8 (E014–E016 and the full-stack seam wording), V11-2 (CSRF `headerName` JSDoc),
    X93-9 (`setu add` in Getting Started), the V10-50 nested-peer remainder M131c deferred.
  - **CLI text (code):** X93-3 (the example-download refusal), X93-7 (generated READMEs link the
    site), the `setu add auth` full-stack hint (§3.15).
- **Dropped, already fixed (checked):** V11-14 (PR #537, `docs/cli.md:289`), X88-6 and X88-10 doc
  halves (M131a: `messaging-plugin/README.md:519-523`, `telemetry-plugin/AGENT_CARD.md:56`), X91-8's
  "never generated anything" half (`docs/cli.md:1009`); G10's X93-8, V11-3, V11-4 and V11-9 (M131c,
  CHANGELOG.md:363-372); X93-6's "paste a token" half (`apps/rest-api/README.md:18-19`,
  `run token`); the first half of the V10-50 remainder (`docs/plugins.md:53-54` already says a
  hoisted package resolves from its own location).
- **NOT this milestone:** any runtime behaviour change; closing `smoke/DEFECTS.md` rows (needs a
  re-run on a published version); wiring password sign-in into the generated full-stack template
  itself (the template keeps its placeholder login, §3.15); stripping marked README blocks in
  `rewrite.ts` (§3.9); V11-19 (generated Workers README text, M130's).

## 1. Contracts verified from SOURCE (not names)

| Reference                       | Source (file:line)                                                                                                                                                                                                                                  | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #526 migration path             | `cli/src/commands/generate.ts:592,622-626`; `utils/module-switch.ts:264-265,298-326`                                                                                                                                                                | `--adopt-controllers` plans a switch only when `modules.length === 0`; otherwise usage refusal. M131c's same-named adoption is also first-module only and refused for full-stack. The refusal text names "move them into a module by hand and run `setu sync`".                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| E006 text / modular config      | `docs/cli.md:536`; `diagnostics/render.ts`                                                                                                                                                                                                          | A modular config imports `registerModules` from `./src/modules/index.ts` and calls `registerModules(app.router, app.services)`; class-based also lists `MODULES`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Finding ids                     | `cli/src/diagnostics/ids.ts:5-28`; `render.ts:131-157`                                                                                                                                                                                              | E014 mixed-layout, E015 unresolved-import, E016 duplicate-name exist; `docs/cli.md:1014-1033` lists E001–E013, E017, E018, W001–W005 only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Brief verify rule               | `cli/src/agents/rules.ts` (`id: 'verify'`)                                                                                                                                                                                                          | New in M131c; every scaffold has one of check/lint/format:check/test or is Deno, so every pre-0.12.0 brief reads stale. CHANGELOG.md:367-369 does not say to re-run `setu agents`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Workers tsconfig                | `cli/src/templates/project-files.ts:1520-1527,1538,1762,893`                                                                                                                                                                                        | Generated Workers `types` include `'node'`; `NODE_TYPES_RANGE = '^24.0.0'`; the entry imports `waitUntil` from `cloudflare:workers`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Deno `nodeModulesDir`           | `project-files.ts:2228-2240`                                                                                                                                                                                                                        | `"auto"` on every non-member Deno project and npm-build project; members inherit the root's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Startup claim                   | `docs/upgrading.md:651-655,1087-1093`; `openapi-plugin/README.md:97-102`                                                                                                                                                                            | Each says an entry with no install fails at startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Release link defs               | `CHANGELOG.md:10425-10426`; `scripts/bump-version.ts:416-436`; `scripts/verify-release.ts:208-226`                                                                                                                                                  | `[unreleased]` compares `v0.10.0...HEAD`; 21 `## [x]` headings, 20 definitions — only `[0.11.0]` missing. Bump step 4 renames the heading only; check 7 checks the section is non-empty.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Versioning policy               | `README.md:247-275`; `website/src/content.config.ts:21,27-41`; `website/src/lib/docs-links.ts:52`                                                                                                                                                   | Policy only in the root README, which is not a site source; `README.md#versioning` maps to `/#versioning`, which has no id. CHANGELOG.md:6201, 6445, 6608 link it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Site link check                 | `website/scripts/check-links.mjs:22-28,35-49`                                                                                                                                                                                                       | Same-page fragments checked; cross-page links stat the file and ignore the fragment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Site pages                      | `content.config.ts:21`; `website/src/lib/docs-nav.ts`; `pages/docs/[...slug].astro:27`                                                                                                                                                              | Every `docs/*.md` but `releasing.md` is a page; a page shows in the sidebar only through a `docs-nav.ts` entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ws` peer                       | `runtime/package.json:47-53,65`; `pnpm-lock.yaml:516,6656`                                                                                                                                                                                          | Optional peer `^8.18.0`, devDependency of runtime; `apps/graphql-demo/package.json` has none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Example gates                   | `scripts/check-apps.ts`; `cli/test/e2e/examples-e2e.test.ts:32-63`                                                                                                                                                                                  | `check:apps` resolves `ws` through runtime's devDependency (cannot see X93-1); the examples e2e installs each example outside the workspace with npm and runs `npm run smoke`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| graphql-demo WS                 | `apps/graphql-demo/main.ts:13`; `interop.ts:54-73`; `smoke.ts`; `apps/smoke-helpers.ts:41`                                                                                                                                                          | WS at `/graphql/ws`, `graphql-transport-ws`; the smoke is one `inject` HTTP test; `freePort()` exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| README rewrite                  | `cli/src/examples/rewrite.ts:157-171`; `website/src/lib/example-start.ts`                                                                                                                                                                           | Three rewrites (pnpm `--dir`, "repository root", `../../docs` links); the site renders the README unrewritten.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| rest-api port                   | `apps/rest-api/main.ts:6`                                                                                                                                                                                                                           | `process.argv[2] ?? 3000`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Collector config                | `docs/telemetry-collector-fanout.md:15-17,80,90`; `docker/otel-collector/collector-config.yaml`                                                                                                                                                     | Page links a 60-line repository file and runs commands against its path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Standalone image                | `project-files.ts:2125-2131`                                                                                                                                                                                                                        | A non-Workers single project without `--port` gets `Dockerfile` and `.dockerignore`; `docs/deployment.md:685-693` says it emits none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--pull-secret`                 | `cli/src/commands/workspace-ops.ts:113-125,764-766,778-830`; `workspace/deploy-manifest.ts:54-74`                                                                                                                                                   | Namespace via `get namespace -o name`; Secret via `-o jsonpath={.type}`, types `kubernetes.io/dockerconfigjson`/`dockercfg`; DNS-1123, each once, repeatable; existing `imagePullSecrets` in `k8s/members.yaml` refused; inserted at deploy time; non-kind hint. `docs/cli.md` has no `workspace build` or `workspace deploy` section.                                                                                                                                                                                                                                                                                                                                                                                       |
| Repo links in generated text    | `project-files.ts:2035`; `workspace/root-files.ts:129`; `utils/repository-links.ts:20`                                                                                                                                                              | Both READMEs link `github.com/setu-ts/setu-ts`; no site-URL helper exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Download refusal                | `cli/src/examples/new.ts:151`; `packages/create/src/index.ts` (`createArgs`)                                                                                                                                                                        | Prints `cause.message` and `setu new <name> --template <t>`; `npm create` passes `['new', ...argv]` with no entry-point signal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Password sign-in from an action | `common/src/services/request-service.ts:80`; `react-router-plugin/src/handler/load-context.ts:30`, `request-bridge.ts:78-82`; `auth-plugin/src/plugin/auth-plugin.ts:361-363,435,508,515-518,531-534`; `common/src/services/auth-session.ts:96-123` | A `requestService` factory gets the kernel `IRequestContext`; an action reaches it with `getService(context, TOKEN)`; `signIn` alone satisfies the passive-strategy rule and needs the session capability; `verifyCredentials` is null without `local.verify`; the bridge copies the React Router response's headers onto `ctx.response` (`request-bridge.ts:78-99`) and the session middleware appends its cookie after `next()` returns (`session-plugin/src/session-middleware.ts:27-31,134`); `requireUser` reads the session's `userEmail` (`full-stack-app-files.ts:384-392`), which a principal sign-in never writes, while `userContext` (`react-router-plugin`, set at `load-context.ts:34`) carries the principal. |
| Form CSRF                       | `session-plugin/src/options.ts:24,26,62-63`; `csrf/verify.ts:108-127`; `common/src/form/form-body.ts:166-178`                                                                                                                                       | Field `_csrf`, header `x-csrf-token`; header read first, then urlencoded or multipart (with `boundary`) string fields. The `headerName` JSDoc says multipart is not parsed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Request logger                  | `logger-plugin/src/middleware/request-logger.ts:77,99,106`                                                                                                                                                                                          | `request received` (debug), `request completed` (info, status + duration), `slow request` (warn, not on throw); each carries method and path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Optional peers                  | `docs/plugins.md:46-57`; `telemetry-plugin/README.md:15-19`; `cli/src/commands/add.ts:795-810`; `templates/client-dependencies.ts:35-38`                                                                                                            | The nested-peer text exists; the README's "four console-exporter peers" omits the OTLP exporter and Node instrumentation peers M131a added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `setu add auth` hint            | `cli/src/commands/add.ts:562`; `templates/full-stack-app-files.ts:598-645`                                                                                                                                                                          | Full-stack prints "configure its auth arm in setu.config.ts"; the template's login writes `userEmail` to the session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                       | Resolution (picked side)                | Doc deliverable (same PR)                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| C1  | `docs/deployment.md` "A standalone project" says no Dockerfile; the CLI writes one (M120)                                                                      | The code                                | §3.10 rewrite of that subsection                                       |
| C2  | The archived M131c plan §3.11 says the Secret check uses `-o name`; the code uses `-o jsonpath={.type}`                                                        | The code; archived plans are not edited | §3.11 walkthrough written from `workspace-ops.ts`                      |
| C3  | `docs/upgrading.md` (2 places) and the openapi README say a missing Deno install fails at startup; generated projects install on first run                     | The code                                | §3.5                                                                   |
| C4  | CHANGELOG.md #526 entry says "There is no migration for existing projects"; a flat project has one (`--adopt-controllers`)                                     | The code, for flat projects             | §3.1 guide subsection; the 0.11.0 CHANGELOG entry is history and stays |
| C5  | `CsrfFormOptions.headerName` JSDoc vs `verify.ts`                                                                                                              | The code                                | §3.18                                                                  |
| C6  | `docs/cli.md:160` and `templates/choice.ts:161-172` say full-stack has "no controller or ingress seam"; it ships `src/modules/products/products.controller.ts` | The code                                | §3.17                                                                  |

## 3. Design decisions

### 3.1 X90-1 — the #526 controllers break in the 0.11.0 section

- **Decision:** add `### One place for routes: controllers (#526, @setu-ts/cli, breaking)` under
  `## 0.11.0` in `docs/upgrading.md`, with what fails after a guide-only upgrade (E014, E006, E003)
  and two paths: a **flat** project runs `setu g module <name> --adopt-controllers` once, which
  moves every file under `src/controllers/` and `src/services/` (an untouched greeting example moves
  without the flag); a project that **already has modules** moves by hand — `git mv` the files into
  `src/modules/<name>/`, add the module declaration, import and call `registerModules` in
  `setu.config.ts` (class-based: also `MODULES`), then `setu sync`. It states that `.routes.ts`
  became `<name>.controller.ts` and that `controller`, `route`, `service`, `sse` and `setu add view`
  take `--module` once modules exist (so does `schema`, `generate.ts:146`, which the #526 entry
  omits; the guide names it). The subsection's historical claims sit inside
  `<!-- version:history -->` as the neighbouring sections do. Each claim is read from `generate.ts`,
  `module-switch.ts` and the #526 CHANGELOG entry; the hand move is the one X90 performed
  (`x90/out/`).
- **Why:** the guide is per-version; this belongs to 0.11.0. The 0.12.0 section adds nothing for it:
  M131c's adoption does not change the with-modules case.
- **Test home:** `check:docs` (fences, anchors, Contents); review against X90's evidence.

### 3.2 V11-18 — briefs read stale after an upgrade

- **Decision:** one sentence in the 0.11.0 M119h subsection, and the same in §3.3's 0.12.0
  subsection: after upgrading, run `setu agents` and commit the briefs, because
  `setu agents --check` reports every brief written by an older CLI as stale (a CI job running it
  fails on the bump). The 0.12.0 CHANGELOG entry for V11-9 (CHANGELOG.md:367) gains the same
  instruction.
- **Test home:** `check:docs`.

### 3.3 0.12.0 — M131c's generated-output changes (folded, no row)

- **Decision:** a `### CLI gates, generators and workspace deploy (M131c)` subsection under
  `## Unreleased`. One bullet per M131c CHANGELOG entry that changes what an EXISTING project must
  do, each with the command that applies it or "new projects only", read from
  `git diff 361f36350^1 361f36350 -- CHANGELOG.md` and the code. At least: briefs (§3.2); the dev
  ports (`inspectPort`/`vitePort` via `setu workspace ports --reallocate` and the `dev.ts`
  `VITE_PORT` note it prints); `--no-lock` on generated `deno run npm:` scripts and the runtime
  image dropping `@setu-ts/testing` (X87-4, with the command that regenerates `docker/Dockerfile`);
  `setu check` now failing an imported-but-unused registration (E006/E003); W005 replacing E001 for
  an unlisted service (a relaxation); V11-4, an existing Workers project adds `.dev.vars` to
  `.gitignore` by hand; V11-15, `setu commands` omits a plugin command a built-in name reserves;
  V11-8, whether an existing `.setu-ts/check.json` W001 silence still matches the new line-naming
  W001 or now raises W004 (checked by running it; the guide says which). M129, M134, M135 and #561
  add only new surface and get no subsection (checked against the `[Unreleased]` Changed/Fixed
  lists); the PR report restates that check.
- **Test home:** `check:docs`; review against `git show 361f36350 -- CHANGELOG.md`.

### 3.4 V10-16 remainder — the Workers full-stack repair

- **Decision:** in `docs/upgrading.md` "Full-stack Workers projects: pass `serverBuild` as a
  module", the tsconfig bullet also adds `"node"` to `compilerOptions.types` and `@types/node`
  `^24.0.0` to devDependencies; the entry bullet shows
  `import { waitUntil } from 'cloudflare:workers'`.
- **Test home:** `check:docs`.

### 3.5 V11-16 — the Deno startup claim

- **Decision:** the three places say: with `nodeModulesDir: "auto"` (every generated Deno project;
  in a workspace it is on the root) Deno installs the entry on first run; with `"manual"` or none,
  an entry that was never installed fails at startup with `OptionalDependencyUnavailableError`.
  `swagger-ui-dist` `^5` stays as the supported peer range (`openapi-plugin/package.json:43,60`);
  where the text gives an install command it uses the CLI's exact pin (`swagger-version.ts:20`).
- **Test home:** `check:docs` (version claims).

### 3.6 X93-4 — CHANGELOG link definitions

- **Decision:** add `[0.11.0]: https://github.com/setu-ts/setu-ts/releases/tag/v0.11.0` and change
  `[unreleased]` to compare `v0.11.0...HEAD`. `scripts/bump-version.ts` step 4 also inserts
  `[<to>]: …/releases/tag/v<to>` above the previous definition and rewrites the `[unreleased]`
  compare base; an existing `[<to>]:` definition is not duplicated. The check is a pure function in
  a new measured module `scripts/lib/changelog-links.ts`: every `## [x]` heading has a definition
  (labels matched case-insensitively, `[Unreleased]` ↔ `[unreleased]`), and `[unreleased]` compares
  from the newest `## [x]` heading below `[Unreleased]` — not a git tag, because `release:verify`
  runs after the bump and before the tag exists. `scripts/verify-release.ts` calls it as a thin new
  check after the existing last one (the pattern check 6 uses, `verify-release.ts:176`), and the
  `release:verify` paragraph of `docs/releasing.md` (:224-226) names it.
- **Why:** both were hand edits; a check is what stops the next miss.
- **Test home:** `test/unit/bump-version.test.ts` (insertion and rebase; an existing definition is
  not duplicated) and new `test/unit/changelog-links.test.ts` (a heading with no definition fails
  naming the version; a stale `[unreleased]` base fails; mixed-case labels match; the repo CHANGELOG
  passes after §3.6's edit and fails on `develop`'s).

### 3.7 X93-5 — the versioning policy on the site

- **Decision:** move the policy to a new `docs/versioning.md` (a site page with a `docs-nav.ts`
  entry, and a row in the hub `docs/README.md`); `README.md ## Versioning` keeps a two-line summary
  linking it; the three CHANGELOG links point at `docs/versioning.md`.
  `website/scripts/check-links.mjs` checks a cross-page fragment against the target page's ids in
  the built output, and fails on a missing one.
- **Why:** the site must carry everything (GitHub is blocked for some readers); the cross-page gap
  is how `/#versioning` shipped.
- **Test home:** `website/test/link-gate.test.ts` (a cross-page missing fragment fails, a present
  one passes); `pnpm --dir website run build`. Every existing broken cross-page anchor it reports is
  fixed in this PR, not exempted.

### 3.8 X93-1 — `ws` in graphql-demo

- **Decision:** `"ws": "^8.18.0"` (the runtime peer's range) in `apps/graphql-demo/package.json`
  dependencies, the `pnpm-lock.yaml` importer updated with `pnpm install`, and a second smoke case
  that starts the app on `freePort()`, opens `ws://127.0.0.1:<port>/graphql/ws` with the
  `graphql-transport-ws` subprotocol using Node's global `WebSocket`, sends `connection_init` and
  asserts `connection_ack`, then closes and stops the app.
- **Why:** the examples e2e (`examples-e2e.test.ts`) installs outside the workspace, so with the new
  case it fails without the dependency.
- **Test home:** `apps/graphql-demo/smoke.ts`; negative control: the examples e2e for graphql-demo
  fails with `ws` removed.

### 3.9 X93-6 — example READMEs

- **Decision:** rewrite the repository-only paragraphs in neutral wording that is true both
  downloaded and on the site: `graphql-demo/README.md:6-8,74-77` and the `interop.ts:23` comment,
  `mcp-tools/README.md:20-26`, `semantic-search/README.md:19-23`, `worker-pool/README.md:3`. Where a
  repository-only fact matters it stays as one sentence starting "In this repository". The rest-api
  README says `npm start -- <port>` (default 3000). No change to `rewrite.ts`.
- **Test home:** `check:docs` (apps-README coverage); `pnpm run check:apps`.

### 3.10 X93-2 — deployment and collector pages stand alone

- **Decision:** `docs/telemetry-collector-fanout.md` inlines the collector YAML (copied from
  `docker/otel-collector/collector-config.yaml`) with a "save as `collector-config.yaml`" step, and
  its validate/run commands use that local file; the telemetry README link points at the site page.
  `docs/deployment.md` gains a first section, "Deploy a scaffolded project", listed first in
  Contents: a single project (`npm run build` → `setu build`, the generated `Dockerfile`,
  `docker build`/`docker run`) and a workspace (link to "Deploying a project the CLI scaffolded").
  The repository-image sections keep their headings and anchors and each opens with one sentence
  saying it describes the images in this repository. "A standalone project" (C1) is rewritten to the
  generated Dockerfile.
- **Why:** no section is moved, so existing anchors into `deployment.md` keep working.
- **Test home:** `check:docs` (Contents vs `##`, anchors, fences).

### 3.11 The authenticated-registry walkthrough (X87-5 doc half)

- **Decision:** a `#### An authenticated registry` walkthrough under "Build, test and deploy from
  the root": create the namespace,
  `kubectl create secret docker-registry <name> -n <ns> --docker-server … --docker-username … --docker-password …`,
  `setu workspace deploy --registry <prefix> --pull-secret <name> --dry-run` (what it checks, the
  `would use imagePullSecrets` line), then without `--dry-run`; the rules of §1's `--pull-secret`
  row. `docs/cli.md` gains a `setu workspace build` / `setu workspace deploy` section mirroring
  `DEPLOY_HELP`, linking it.
- **Test home:** `check:docs`; every flag grepped against `workspace-ops.ts`.

### 3.12 X93-7 — generated READMEs link the site

- **Decision:** a `siteUrl(path)` helper beside `repositoryFileUrl` in
  `cli/src/utils/repository-links.ts` returning `https://setu-ts.dev/<path>`; the project README
  (`project-files.ts:2035`) and workspace README (`root-files.ts:129`) link `siteUrl('')`, and
  `examples/rewrite.ts:120-122`'s hard-coded site URLs go through it (one implementation). The two
  printed GitHub links (`add.ts:571`, `generate.ts:740`) stay: they pin the version's README.
- **Test home:** `packages/cli/test/unit/utils/repository-links.test.ts`, the template tests that
  pin the README text, `packages/cli/test/fixtures/redis-develop-outputs.json` (contains the GitHub
  link), and the scaffold baselines if they capture README.

### 3.13 X93-9 — `setu add` in Getting Started

- **Decision:** "Adding Plugins" (`docs/getting-started.md:256`) opens with
  `npx @setu-ts/cli add <name>` for a scaffolded project, linking `cli.md#scaffolding-and-setu-add`,
  before the manual registration it shows now.
- **Test home:** `check:docs`.

### 3.14 X93-3 — the example-download refusal

- **Decision:** the refusal names `npx @setu-ts/cli new <name> --template <t>` (works from both
  entry points) and appends the nested cause's message and `code` when `cause.cause` is an `Error`,
  each through `escapeName` as line 151 already does for `cause.message`.
- **Test home:** `packages/cli/test/unit/examples.test.ts` (the existing refusal case updated; a new
  nested-cause case). Negative control: the nested-cause case fails on `develop`.

### 3.15 X89-3 — full-stack login with password-only `signIn`

- **Decision:** `auth-plugin/README.md` gains "In the full-stack template" under "Signing in without
  a provider": the arm `auth: { signIn: { providers: [] }, local: { verify } }`, an `account` module
  whose `requestService` factory signs in through `verifyCredentials` then
  `IAuthSessionService.signIn(ctx, principal, …)`, the action calling it via
  `getService(context, ACCOUNT)` with the `_csrf` field kept, and an explicit rewrite of the
  template's `requireUser` to read `userContext` from `@setu-ts/react-router-plugin` instead of the
  session's `userEmail`. The JSON recipe gains the CSRF sentence (`x-csrf-token`, or a form with
  `_csrf`). `full-stack-starter/README.md` notes that `signIn` alone satisfies the passive-strategy
  rule. The `setu add auth` hint (`add.ts:562`, printed for every starter-owned arm) adds the
  recipe's site URL (§3.12 helper) only when the arm is `auth` and the starter is full-stack. The
  fences compile under `check:docs`. The template keeps its placeholder login.
- **Why:** the docs gap is the row; changing the template's login is a generator change with its own
  e2e cost, not a documentation fix.
- **Test home:** `check:docs` (README fence compiler); the `add` unit test asserts the URL for
  `auth` on full-stack and its absence for another arm and another starter. Manual proof: the recipe
  applied to a scaffolded full-stack project signs in and reaches a protected page (report).

### 3.16 V11-17 — logger records

- **Decision:** `logger-plugin/README.md:121-122` lists the three records with level and fields per
  §1.
- **Test home:** `check:docs`.

### 3.17 X91-8 — finding table and full-stack seams

- **Decision:** E014–E016 rows in `docs/cli.md`'s table with their remedies from `render.ts`;
  `docs/cli.md:160` and `templates/choice.ts:161-172` say full-stack is functional-only with no seam
  for decorated classes.
- **Test home:** `check:docs`; the choice-text unit test if it pins the wording.

### 3.18 V11-2 — `headerName` JSDoc

- **Decision:** the JSDoc says the header is for `fetch` posts and non-form bodies and is read
  before the body; urlencoded and multipart (with `boundary`) string fields are read too.
  PUBLIC_API.md and the README are already correct (checked).
- **Test home:** `check:docs` (`generate-api-docs --check`).

### 3.19 V10-50 remainder — nested optional peers

- **Decision:** `docs/plugins.md` "Optional peers in a workspace" adds only that no framework option
  changes this; the peer goes in the root (the resolution sentence is already there).
  `telemetry-plugin/README.md:15-19` lists the peers `setu add telemetry` records (from `add.ts` and
  `client-dependencies.ts`) and links the site page instead of `github.com/…/main/docs/plugins.md`;
  the other package READMEs with that link change too. Site URLs leave `check:docs` rule 1
  (`check-docs.ts:938-950` skips other `https:` links), so the site build's link check is what
  covers them.
- **Test home:** `check:docs`.

### 3.20 CHANGELOG

- **Decision:** `[Unreleased]` entries tagged `M131d` for each user-visible change: the code ones
  (§3.6, §3.7, §3.12, §3.14, §3.15 hint, §3.17 text) under Fixed/Changed, and one Documentation
  entry listing the rows. The PR number is added after `gh pr create`.
- **Test home:** `check:docs` (`check-changelog-coverage`).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none.

| Exported symbol                        | Kind | Consumer / real code path that READS it                                                            |
| -------------------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| None from any `src/index.ts` (checked) | —    | `siteUrl` is internal to `packages/cli` (consumers: `project-files.ts`, `root-files.ts`, `add.ts`) |

### 4.1 Options — every option names its consumer

| Option                          | Consumer | Behavior (per implementation) |
| ------------------------------- | -------- | ----------------------------- |
| None (checked: no option added) | —        | —                             |

## 5. Implementation files

| File                                                                                                                     | Purpose                                  |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `docs/upgrading.md`                                                                                                      | §3.1–§3.5                                |
| `docs/versioning.md` (new), `README.md`, `website/src/lib/docs-nav.ts`                                                   | §3.7                                     |
| `website/scripts/check-links.mjs`                                                                                        | §3.7 cross-page fragments                |
| `CHANGELOG.md`                                                                                                           | §3.6 link definitions, §3.7 links, §3.20 |
| `scripts/bump-version.ts`, new `scripts/lib/changelog-links.ts`, `scripts/verify-release.ts`, `docs/releasing.md`        | §3.6                                     |
| `apps/graphql-demo/{package.json,smoke.ts,README.md,interop.ts}`, `pnpm-lock.yaml`                                       | §3.8, §3.9                               |
| `apps/{mcp-tools,semantic-search,worker-pool,rest-api}/README.md`                                                        | §3.9                                     |
| `docs/telemetry-collector-fanout.md`, `docs/deployment.md`, `docs/cli.md`                                                | §3.10, §3.11, §3.17                      |
| `packages/cli/src/utils/repository-links.ts`, `templates/project-files.ts`, `workspace/root-files.ts`, `commands/add.ts` | §3.12, §3.15                             |
| `packages/cli/src/examples/new.ts`                                                                                       | §3.14                                    |
| `packages/cli/src/templates/choice.ts`                                                                                   | §3.17                                    |
| `docs/getting-started.md`                                                                                                | §3.13                                    |
| `packages/auth-plugin/README.md`, `packages/starters/full-stack-starter/README.md`                                       | §3.15                                    |
| `packages/logger-plugin/README.md`                                                                                       | §3.16                                    |
| `packages/session-plugin/src/options.ts`                                                                                 | §3.18                                    |
| `docs/plugins.md`, `packages/telemetry-plugin/README.md`, other READMEs linking `main/docs/plugins.md`                   | §3.19                                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                          | src covered                                                | Key assertions (and the signature each call type-checks against)                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/bump-version.test.ts`                                   | `scripts/bump-version.ts`                                  | Link definition inserted and `[unreleased]` rebased; an existing definition not duplicated                                   |
| `test/unit/changelog-links.test.ts` (new)                          | `scripts/lib/changelog-links.ts`                           | Missing definition fails naming the version; stale `[unreleased]` base fails; case-insensitive labels; repo CHANGELOG passes |
| `website/test/link-gate.test.ts`                                   | `website/scripts/check-links.mjs`                          | Cross-page missing fragment fails; present passes; same-page behaviour unchanged                                             |
| `apps/graphql-demo/smoke.ts`                                       | the example                                                | `connection_ack` over `graphql-transport-ws`                                                                                 |
| `packages/cli/test/e2e/examples-e2e.test.ts`                       | the example install                                        | graphql-demo smoke passes outside the workspace; fails without `ws` (negative control)                                       |
| `packages/cli/test/unit/examples.test.ts`                          | `examples/new.ts`                                          | New command text; nested cause message and code shown                                                                        |
| `packages/cli/test/unit/utils/repository-links.test.ts`            | `utils/repository-links.ts`                                | `siteUrl('')`, `siteUrl('docs/x/')`; `rewrite.ts` output unchanged                                                           |
| template / workspace / add unit tests that pin README or hint text | `project-files.ts`, `root-files.ts`, `add.ts`, `choice.ts` | The site link; the auth hint URL; the full-stack choice text                                                                 |
| `pnpm run check:docs`                                              | docs, READMEs, JSDoc                                       | Fences (README recipe compiles), anchors, Contents, version claims, changelog coverage, API docs                             |

Every touched `src` and `scripts` file stays ≥ 90% branch/function/line.

## 7. Verification gates

```bash
git branch --show-current   # MUST be docs/m131d-docs-examples-website
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run test:tooling:coverage      # bump-version.ts and scripts/lib/changelog-links.ts ≥ 90% (verify-release.ts is not a measured target)
pnpm test:coverage cli               # touched cli src ≥ 90%
pnpm --dir website install --frozen-lockfile && pnpm --dir website run build && pnpm --dir website test
pnpm run check:apps
pnpm run release:verify 0.11.0
```

- `examples-e2e.test.ts` for graphql-demo, with the negative control; `scaffold-runs-e2e.test.ts`
  (generated README text changes).
- Manual proofs (report): the §3.15 recipe on a scaffolded full-stack project; the §3.11 walkthrough
  as a `--dry-run` against the local kind cluster; the collector YAML validated with
  `otelcol-contrib validate` from the page's own commands.
- A fresh-agent code review of the `packages/cli/src`, `scripts/` and `website/scripts` changes,
  since a `docs/` PR gets no CodeRabbit review.
- Final commit: `pnpm run ci:local` (cli and tooling shards at least), and both publish gates.

## 8. Risks & mitigations

- The cross-page anchor check may report existing broken links → each is fixed in this PR; the count
  is in the report.
- Node's global `WebSocket` may not send the headers the #562 Origin check expects → the smoke sends
  no `Origin` (a non-browser client), which the check admits; if it refuses, the smoke uses `ws`'s
  client with an explicit same-origin header and the report says why.
- A doc batch can invent option names or flags → every flag and option in new text is grepped
  against source or a `.d.ts` before review.
- The link check fails on a historical CHANGELOG shape → the repo CHANGELOG is one of the test's
  inputs.
- The V11-8 W001 silence question (§3.3) may show an existing silence stops matching → the guide
  says so with the replacement entry; no code change here.
- README text the site renders unrewritten → §3.9's wording must read right in both places; review
  checks both.

## 9. Out of scope

- Wiring password sign-in into the generated full-stack template (§3.15) — a future CLI milestone if
  the maintainer wants it.
- A marked-block strip in `rewrite.ts` (§3.9).
- Closing the `smoke/DEFECTS.md` rows — after the next published re-run.
- V11-19 (generated Workers README) — M130's generated text.
