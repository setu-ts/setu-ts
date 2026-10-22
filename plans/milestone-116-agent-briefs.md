# Milestone 116 — Agent briefs (`setu agents` + a card per package)

> **Status:** Planning. Branch: `feat/m116-agent-briefs`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A coding agent building an application on Setu-TS has no training data for it, and the agent-brief
pilot (ROADMAP M116, 126 runs) showed that its failure is reinvention — hand-rolling a cache, a
queue or JWT handling instead of installing the plugin — not calls to APIs that do not exist. The
pilot's best variant (F) gave the agent a project-specific `AGENTS.md` plus one short card per
installed package, and the one-line npm description of each package not yet installed. This
milestone ships that as product: `setu agents` writes the brief from the project's real state,
`setu agents --check` reports a stale one for CI, and every published library package carries a
hand-written card in its npm tarball that a plain `npm install` delivers. No `common`, kernel or
plugin `src/` changes: a card is documentation shipped in the tarball, and the brief is CLI output.

- **In scope:** the `agents` built-in command and its `--check` mode (standalone and workspace);
  `setu new --agents`; `AGENT_CARD.md` in each of the 50 published library packages; the four card
  gates; the CLI's description and capability-token tables and their drift gates; the scaffold e2e;
  docs (`docs/cli.md`, `packages/cli/README.md`, `PUBLIC_API.md`, CHANGELOG, `docs/upgrading.md` not
  needed — see §4); a measurement run against the pilot harness before the PR merges.
- **NOT this milestone:** an MCP server, `llms.txt`/`llms-full.txt`, `setu explain`/`setu example`
  lookups, and `setu check` for applications (ROADMAP M116 "Not in this milestone"; candidate
  follow-ons with no owner yet). Copying cards into the project for package managers that create no
  `node_modules` (§3.4 declines it). Running `setu agents` automatically from `setu add` or
  `generate app` (§3.9).

## 1. Contracts verified from SOURCE (not names)

| Reference                                   | Source (file:line)                                                                                    | Verified surface / fact                                                                                                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in command dispatch                   | `packages/cli/src/cli.ts:214-292`                                                                     | `switch (command)` over `new`/`generate`/`add`/`devtool`/`adopt`/`workspace`/`commands`/`help`; `default` dispatches a plugin command, so a new built-in is matched first and always wins                                                 |
| Flag / positional contract per command      | `packages/cli/src/flags.ts:100-300` (`spec`, `commandFlagsFor`)                                       | Every built-in has an `ICommandFlagSpec` (`allowed`, `documented`, `positionals`); an unlisted flag is refused by the dispatcher before the body runs, and the help↔inventory gate asserts each documented flag                           |
| Installed `@setu-ts` packages               | `packages/cli/src/utils/plugin-detector.ts:61`                                                        | `detectPlugins(fs, dir): Promise<ReadonlySet<string>>` — bare names from `deno.json`/`deno.jsonc` `imports`, else `package.json` `dependencies` + `devDependencies`; never boots the project                                              |
| Style                                       | `packages/cli/src/utils/generator-mode.ts:8,22`                                                       | `generatorMode(plugins): 'functional' \| 'class-based'`, keyed on `decorator-plugin`                                                                                                                                                      |
| Runtime                                     | `packages/cli/src/utils/runtime-detector.ts:113`                                                      | `detectTargetRuntime(fs, dir): Promise<TargetRuntime>`; throws `RuntimeMarkerUnreadableError` (line 35) for an unreadable marker                                                                                                          |
| Project vs workspace                        | `packages/cli/src/utils/project-detector.ts:26,52`                                                    | `findWorkspaceMarker`, `detectProject(fs, dir): Promise<ProjectDetection>`                                                                                                                                                                |
| Workspace record                            | `packages/cli/src/workspace/manifest.ts:24,27,122-177,178,326`                                        | `setu.workspace.json`; members under `apps/`; `WorkspaceMember` carries `name`, `port`, `devtoolPort?`, `dependsOn?`, `healthProbes?`, `metricsEndpoint?` — **no template field**; manifest carries `transport`, `transportUrl?`, runtime |
| Addable packages                            | `packages/cli/src/commands/add.ts:104-150`                                                            | `ADDABLE: Map<shortName, { pkg, section?, peers? }>` — 43 entries; `RUNTIME_RESTRICTIONS` (`:152`) names `cloudflare-plugin` (Workers only) and `scheduler-plugin` (not Workers)                                                          |
| npm descriptions                            | `scripts/jsr-metadata.ts:83` (`PACKAGE_METADATA`), read by `scripts/node-manifests.ts:426`            | One `description` per package, repository-only; `node-manifests.ts` writes it into each generated `package.json` and refuses a member without one (`:745`)                                                                                |
| Tarball contents                            | `scripts/node-manifests.ts:450`                                                                       | Every member's generated `package.json` has `files: ['dist', 'src', 'README.md', 'LICENSE']` — one list, so adding a file is one edit                                                                                                     |
| Release check                               | `scripts/verify-release.ts:19,147-166`                                                                | Check 5 refuses a published member with a missing or empty `README.md`; the new card check sits beside it                                                                                                                                 |
| Published packages                          | `scripts/release-packages.ts:7`                                                                       | 52 entries: 50 library members plus `packages/cli` and `packages/create`                                                                                                                                                                  |
| Fence engine                                | `test/fixtures/snippets/fence-engine.ts` (used by `test/package-readme-fence-compiler.test.ts:38-47`) | `extractFences`, `classify`, `assembleSource`, `compileFence`, `writeProjectStubs`; the README gate pins a compilable-fence count per file                                                                                                |
| Export inventory                            | `scripts/package-exports.ts:18,26,112` (`symbolsForFile`) via `scripts/package-export-collection.ts`  | The TypeScript-compiler-API export walk the `## Exports` README tables are checked against; reused for the card symbol gate                                                                                                               |
| Pilot inputs (local, not in the repository) | `~/.cache/setu-agents-pilot/variants/batch2/base{,2}/F/AGENTS.md`, `variants/C/**/*.md`               | F brief 8506 B (functional) / 8886 B (class-based); cards 427–2152 B, largest `common` 2152 and `decorator-plugin` 2104                                                                                                                   |

Pilot facts that were true of `0.9.0` and are FALSE on `develop` (the brief and cards must not
inherit them): `setu g job` is now wired to `QueuePlugin({ processors })` (M113i), `setu add`
inserts the bare call for eight zero-configuration packages (M113i), and the `rest` sample moved to
`src/modules/greeting/` (M114). Each card and rule block is written against `develop`, not copied
from the pilot.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                               | Resolution (picked side)                                                                                                                                                                                                                                                | Doc deliverable (same PR)                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| C1  | ROADMAP M116: "the framework section has a byte budget **the command enforces**". The section's size depends only on the installed set, which the user chose                                                                           | The budget is enforced by a test over every reachable composition (§3.5), not at run time: refusing to write a brief because the user installed many packages would punish the user for a limit of ours                                                                 | ROADMAP M116 Design bullet reworded                         |
| C2  | ROADMAP M116 Gates: "`release:verify` refuses a published **plugin** package whose tarball carries no card"; Design bullet says "each published plugin package" while open question 2 asks about `kernel`/`common`/`runtime`/`testing` | Every published LIBRARY member gets a card (50 packages: core, plugins, `sdk`, starters); `cli` and `create` do not (they are run, never imported). The pilot gave `common`, `runtime` and `testing` cards and two of them carried its most-used routing and test facts | ROADMAP M116 Gates and Design bullets say "library package" |
| C3  | ROADMAP open question 1 proposes copying cards into the project (`.setu/docs/`) as the no-`node_modules` fallback                                                                                                                      | Declined (§3.4): it ships a second copy of every card inside the CLI and a second drift gate, for package-manager setups no CLI-generated project uses                                                                                                                  | ROADMAP open question 1 records the decision                |

## 3. Design decisions

### 3.1 The brief's file, location and delimiters

- **Decision:** the brief is `AGENTS.md` in the project directory (standalone) or in the workspace
  root and each `apps/<member>/` (§3.7). The framework section sits between
  `<!-- setu-agents:begin -->` and `<!-- setu-agents:end -->`; the line after `begin` reads
  "Generated by `setu agents` from this project's manifests. Edits between these markers are
  overwritten." Everything outside the markers is never read for content and never modified.
  - no file → the file is created containing only the section;
  - a file with no markers → the section is inserted at the top, followed by one blank line and the
    file's existing bytes unchanged;
  - exactly one `begin` followed by exactly one `end` → the bytes between them are replaced;
  - any other marker arrangement (an `end` before `begin`, two `begin`s, a `begin` with no `end`) →
    refused with exit 1 naming the file and the problem, nothing written.
- **Why:** `AGENTS.md` is the file the agent tools the pilot used read at start-up. `CLAUDE.md` is
  not written or edited; the docs say to add `@AGENTS.md` to it, because a second generated file is
  a second thing to keep fresh.
- **Test home:** `test/unit/agents/brief-file.test.ts` — one case per marker arrangement, including
  that bytes outside the markers survive a rewrite byte-for-byte.

### 3.2 What the brief says, and where each fact comes from

- **Decision:** the section is rendered by ONE pure function, `renderBrief(facts)`, from a
  `ProjectFacts` value gathered once by `gatherFacts(fs, dir)`. Nothing in the render reads the
  filesystem. Contents, in this order (variant F's order):
  1. Title, the framework version (`VERSION`), the not-in-your-training-data warning naming NestJS,
     Express, Fastify and Hono.
  2. **Rule 0**: read the card before using any Setu-TS symbol, option or file pattern not already
     in this file or the project's code; a card is `node_modules/@setu-ts/<package>/AGENT_CARD.md`;
     exact signatures are in that package's `dist/**/*.d.ts`; anything documented in neither does
     not exist.
  3. **Commands** — only the scripts/tasks the project's own manifest defines among `start`,
     `check`, `test`, `test:e2e`, `dev`, `build`, `db:migrate`, rendered in the runtime's form
     (`npm run x` / `bun run x` / `deno task x`), plus the CLI invocation in the pinned form M113i
     uses for that runtime, for `generate` and `add`.
  4. **Schematics in this project** — the names available for the detected plugin set. The gating is
     computed today inline in `commands/generate.ts:114` over `listSchematics()`; it is extracted to
     one internal `availableSchematics(installed)` that both `generate --help` and the brief call,
     so the two lists cannot differ.
  5. **Rules**, numbered, most important first — the rule blocks of §3.3.
  6. **Project map** — one row per seam directory `seamsFor(installed)` reports, plus
     `setu.config.ts`, the entry (`main.ts` or `src/index.ts` on Workers), `test/` and, when
     present, `src/modules/` and `src/shared/`.
  7. **Installed packages** — one row per detected `@setu-ts` package: name, capability token(s)
     from §3.6, description from §3.6, card path.
  8. **Not installed** — one line per `ADDABLE` short name whose package is absent and which
     `RUNTIME_RESTRICTIONS` allows on this runtime:
     `` `<short name>` (`@setu-ts/<package>`) — <description> ``, under a heading telling the agent
     to run `setu add <name>` and install before use. The package name is there because Rule 0's
     card path uses it: measured, a bare `queue` sent all three T8 runs to a nonexistent
     `@setu-ts/queue/AGENT_CARD.md`.
- **Why:** one render function keeps `--check` and a write byte-identical by construction; every
  fact is read from the project rather than from which template created it, because no project
  records its template (`WorkspaceMember` has no such field, §1) and a project changes after
  `setu new`.
- **Test home:** `test/unit/agents/render-brief.test.ts` (each section from a hand-built
  `ProjectFacts`); `test/unit/agents/gather-facts.test.ts` (each fact from a fake filesystem).

### 3.3 Rule set per style, runtime and composition

- **Decision:** rules are a fixed, ordered list of blocks, each a constant string with a predicate
  on `ProjectFacts`; the rendered rule list is the blocks whose predicate holds, numbered in order.
  Blocks (written against `develop`):
  - always: generate-then-edit (the generator wires registrations); never edit CLI-owned barrels; no
    plugin imports another, get services from `ctx.services` with a `CAPABILITIES` token and its
    interface from `@setu-ts/common`; time (`ctx.startTime` is monotonic `hrtime()`); errors
    (`@setu-ts/exceptions` factories, RFC 9457); configuration (handlers read `IConfig`; plugin
    options run before configuration loads); imports (`.ts` suffix where the runtime needs it,
    `import type`).
  - at least one addable package not installed: never hand-write what a listed package provides (a
    cache, queue, event bus, auth) — `setu add` it. Added after measurement: one of three T9 runs
    wrote its own cache instead of adding `cache-plugin`, and the pilot's best hand-made brief
    (variant F) carried the equivalent rule. Omitted when the Not installed list is empty, which
    also keeps the all-packages composition inside the byte budget.
  - `functional`: routes on the router (`router.get`, `RouteDefinition`), middleware shape, modules
    under `src/modules/<name>/` with `<name>.schemas.ts` and `validateBody(S).value(ctx)`.
  - `class-based`: `@Controller`/`@Get`, TC39 decorators with no parameter decorators,
    `@Params(...)` and class-level `@Inject(...)`, `@Injectable({ token })` built by `DiPlugin`.
  - tests, per runtime: `node:test` (Node), `bun:test` (Bun), `@std/testing` (Deno) — the harness
    M70h made each target emit — with `createTestApp({ app: await createApp() })`.
  - `react-router-plugin` installed (full-stack): route modules under `app/routes/`, loaders read
    framework services through the context keys `setu.config.ts` declares, never module-level
    caches; build before start.
  - `messaging-plugin` installed (microservice): publish integration events through the messaging
    capability with versioned topics; consumers are declared in plugin options.
  - runtime `cloudflare-workers`: no file system, no timers outliving a request, bindings come from
    the `fetch` argument, `scheduler-plugin` is unavailable.
- **Why:** the pilot wrote rules for the functional `rest` template and the class-based form only;
  `full-stack`, `microservice` and Workers differ in exactly the dimensions these predicates read.
  Predicates on detected facts, not on a template name, are the only form a project without a
  recorded template can satisfy (§3.2).
- **Test home:** `test/unit/agents/rule-blocks.test.ts` — a table of facts → expected block ids,
  covering each predicate both ways; `test/e2e/agents-e2e.test.ts` asserts the real scaffold of each
  template gets its blocks.

### 3.4 Where cards are read from, and projects without `node_modules`

- **Decision:** the brief always names `node_modules/@setu-ts/<package>/AGENT_CARD.md` for every
  installed package — the path is deterministic from the manifest, so the brief does not depend on
  whether `install` has run. After writing, `setu agents` checks each named card on disk and, for
  every one missing, prints one warning line (`card not found: <path> — run install`), exit status
  unchanged. When the project has no `node_modules` directory at all and the manifest shows Yarn
  Plug'n'Play (`.yarnrc.yml` with `nodeLinker: pnp`, or absent `nodeLinker` with a `.pnp.cjs`) or a
  `deno.json` without `nodeModulesDir`, the warning instead names the setting that creates it
  (`nodeLinker: node-modules`, `"nodeModulesDir": "auto"`). Cards are never copied into the project.
  **In a workspace member** (amended after implementation) the named path is the workspace root's,
  `../../node_modules/@setu-ts/<package>/AGENT_CARD.md`: every workspace toolchain the CLI generates
  (npm, Bun, Deno — `workspace/runtime-profile.ts`) installs at the root, and all members pin the
  CLI's own version, so nothing forces a member-local copy. The presence check resolves the way Node
  does — the member's own `node_modules` first, then the workspace root — and warns only when
  neither holds the card. The first implementation named the member-local path and its real e2e
  found it absent after a successful install.
- **Why:** every project the CLI generates has `node_modules` (npm, pnpm and Bun create it; a
  Workers project is developed against an npm install; generated Deno projects set
  `"nodeModulesDir": "auto"`), and the pilot's agent followed a `node_modules/.../*.d.ts` path. A
  copy into `.setu/docs/` would put a second copy of every card in the CLI tarball (the CLI cannot
  read a card from a package manager that has not unpacked it), a second drift gate, and a stale
  copy after every upgrade — for setups no generated project uses.
- **Test home:** `test/unit/agents/card-presence.test.ts` (missing card, PnP project, Deno project
  without `nodeModulesDir`, all present); the e2e asserts the path the brief names exists after a
  real install.

### 3.5 Byte budgets

- **Decision:** a card is at most **2560 bytes** (the pilot's largest was 2152). The brief's
  framework section is at most **12288 bytes** for a standalone project and a workspace member, and
  **4096 bytes** for a workspace root. The section budget is enforced by a test that renders every
  combination of style × runtime × {each template's default plugin set, every `ADDABLE` package
  installed, none installed} and asserts each is within budget — not by the command (C1).
- **Why:** the pilot's F brief was 8506 bytes (functional) and 8886 (class-based) with 17
  not-installed lines. The real list is longer: `ADDABLE` has 43 entries, a default `rest` project
  installs about 12 of them, so about 31 not-installed lines at roughly 90 bytes each — 14 more than
  the pilot, about 1.3 KB — puts a class-based brief near 10.2 KB before the rule blocks the pilot
  did not have (modules, per-runtime tests). 12 KiB is that plus about 2 KB of margin, which is
  roughly 3k tokens: no concern for a 262k context, and still a ceiling that catches a rule list
  growing without review. A root file carries no package tables (§3.7), so it is far smaller.
- **Test home:** `test/unit/agents/budget.test.ts`; `test/agent-card-gate.test.ts` for cards.

### 3.6 The CLI's package data: descriptions and capability tokens

- **Decision:** `packages/cli/src/agents/package-data.ts` holds one `ReadonlyMap` keyed by bare
  package name for every published library member (the 50 of §3.10 — starters and
  `diagnostics-plugin` can be installed without being in `ADDABLE`): `{ description, tokens }`,
  where `tokens` is the list of `CAPABILITIES` member names the package provides (empty for
  `common`, `exceptions`, `testing`, the starters). Root gates refuse drift: the key set equals the
  published library members; `description` equals `PACKAGE_METADATA[pkg].description`; each token is
  a key of `CAPABILITIES` and `<binding>.<NAME>` occurs in that package's `src`, where `<binding>`
  is `CAPABILITIES` or the local name a file gives it in its own named import
  (`import { CAPABILITIES as CAP }` → `CAP.GRAPHQL`, `graphql-plugin.ts:14`, the one such import in
  the tree), read from that file's import statement — not a general alias resolver. The last rule is
  deliberately not "appears in a `provides` array": `cache-plugin` declares `provides: [token]` with
  a computed token (`packages/cache-plugin/src/plugin/cache-plugin.ts:102`), which a literal match
  would refuse.
- **Why:** `PACKAGE_METADATA` is repository-only and the CLI runs in a user's project, so it needs
  its own copy (ROADMAP M116). Reading an installed package's `package.json` description would cover
  only installed packages, and the not-installed list is the part the pilot found useful.
- **Test home:** `test/agent-package-data.test.ts` (root tooling member).

### 3.7 Workspaces

- **Decision:** `setu agents` run from a workspace root, or from a member's own directory that the
  root's `setu.workspace.json` lists (corrected by the security audit, F3: the walk first adopted
  any ancestor holding a marker, so an unrelated parent workspace could claim a standalone project),
  writes the root `AGENTS.md` and every member's `apps/<name>/AGENTS.md`; `--check` checks all of
  them. The root section covers: the warning and Rule 0, the workspace commands (`dev`, the
  per-member form), the member table (name, port, `dependsOn`, devtool port), the transport and its
  URL variable, and a line telling the agent to read the member's own `AGENTS.md` before working in
  it. Each member's section is the standalone section for that member plus one line pointing at the
  root `AGENTS.md` for workspace layout, ports and transport.
- **Why:** agreed 2026-10-12 (ROADMAP M116). One behaviour from anywhere avoids a root that lists a
  member set older than its members, and an agent started inside a member otherwise never sees the
  root.
- **Test home:** `test/unit/agents/workspace-brief.test.ts`; the e2e's workspace case.

### 3.8 `--check`

- **Decision:** `setu agents --check` renders every brief it would write and compares the bytes
  between the markers with what is on disk. Exit 0 when every file matches; exit 1 naming each file
  that is missing, has no section, or differs (including a version change), writing nothing. A
  malformed marker arrangement is exit 1 with the §3.1 message. Card presence (§3.4) is not part of
  `--check`, so the result does not depend on whether `install` has run.
- **Why:** CI runs `--check` on a checkout before installing; a check that read `node_modules` would
  fail there for a reason unrelated to staleness.
- **Test home:** `test/unit/agents/check-mode.test.ts`.

### 3.9 Command surface

- **Decision:** `setu agents [--check] [--dir <path>] [--dry-run]` — no positionals. `--dry-run`
  prints the paths it would write. The command refuses with exit 2 outside a Setu-TS project
  (`detectProject`, the classification `generate` uses) and refuses `--check` with `--dry-run`. A
  `RuntimeMarkerUnreadableError` from `detectTargetRuntime`, or an unreadable manifest, is exit 1
  naming the file, nothing written — a brief built on a guessed runtime would name the wrong
  commands. `setu new --agents` runs the same writer on the new project after scaffolding (for a
  workspace, on the new root). `setu add` and `setu generate app` do not run it; after a successful
  `setu add` the CLI prints one line: "Run `setu agents` to update AGENTS.md." when the project has
  an `AGENTS.md` containing the begin marker.
- **Why:** a brief is opt-in (ROADMAP M116: `setu new` does not write one by default). Re-running
  silently from `add` would edit a file the developer may not have staged.
- **Test home:** `test/unit/commands/agents.test.ts` (flags, refusals, dry run);
  `test/unit/commands/add.test.ts` (the hint line both ways); `test/unit/commands/new.test.ts`
  (`--agents`).

### 3.10 The card

- **Decision:** each of the 50 library members gets `AGENT_CARD.md` at its package root, listed in
  the generated `files` (`scripts/node-manifests.ts:450`). Shape (the pilot's): one `#` heading
  `@setu-ts/<pkg> — <what it is>`; how it is added and registered (including the `setu add` name and
  what `setu add` already wires); the one or two fences covering common use; options and pitfalls as
  bullets. Hand-written against `develop`, never generated from `PUBLIC_API.md` or the README. Named
  `AGENT_CARD.md`, not `AGENTS.md`, because a nested `AGENTS.md` in this repository would be read as
  instructions for working on the package by agents developing the framework itself.
- **Why:** the pilot's evidence is that compactness is what helps (ROADMAP M116 finding 2).
- **Test home:** `test/agent-card-gate.test.ts`.

### 3.11 The four card gates

- **Decision:** `test/agent-card-gate.test.ts` (root tooling member), iterating the published
  library members from `scripts/release-packages.ts` so a new package without a card fails:
  1. every compilable fence compiles, through the existing fence engine (one engine, as the README
     gate's header requires), with the compilable-fence count pinned per card;
  2. every backticked span whose leading identifier is **shaped like an export** — after an optional
     leading `@` (so an invented `@Decorator` is caught), it starts with an uppercase letter, or it
     is lowercase and immediately followed by `(` or `<` (a function call such as `validateBody(`) —
     must name a symbol that is (a) exported by the card's own package, (b) exported by
     `@setu-ts/common`, (c) exported by any other `@setu-ts/<pkg>` the card names, (d) on a fixed
     list of JavaScript/TypeScript globals, or (e) listed on the card's own
     `<!-- card-allow: a b c -->` comment (project symbols the CLI generates, such as `createApp`).
     A lowercase identifier followed by `.` or nothing (`ctx.params.id`, `router.get`, `processors`,
     `job.data`) is a local, field or option name and is not checked by this rule; fences are
     type-checked by gate 1, which is where such names are verified. Spans that are paths, commands
     or package names (contain `/` or a space, or start with `@setu-ts/`, `npx`, `npm`, `bun`,
     `deno`, `setu`) are skipped. Anything else that fails names card and identifier; exports come
     from `scripts/package-export-collection.ts`. **Amended after implementation:** the first rule
     checked every leading identifier, so `ctx.params.id` and option names failed and the three
     exemplar cards were written around it in vague prose — losing exactly the concrete accessors
     that made the pilot's cards work;
  3. every card is at most 2560 bytes;
  4. `scripts/verify-release.ts` gains a check beside check 5 refusing a published library member
     with a missing or empty `AGENT_CARD.md`, and `packedManifestProblems`
     (`scripts/npm-release-gate.ts:15`, run by `scripts/npm-publish.ts` on each packed tarball)
     refuses a packed library tarball without it.
- **Why:** hand-written cards drift (ROADMAP M116 Gates). Rule 2(e) is a per-card escape hatch so a
  legitimate non-export (a generated function name, a third-party option) is declared where it is
  used rather than in a global list nobody reads.
- **Test home:** the gate file itself; `test/unit/verify-release*.test.ts` for check 4.

### 3.12 Measurement

- **Decision:** before the PR merges, the pilot harness (kept out of the repository) re-runs T7, T8
  and T9 × 3 repetitions with a variant built from this branch: a fresh scaffold, `setu agents`
  output and the packed cards. The bar is at least variant F's result (9/9 hidden tests) and no more
  than 1.2× F's input tokens per run; the numbers go in the PR. After the milestone the run is an
  occasional check, not a release step, because it needs a local model no CI runner has.
- **Why:** the pilot measured hand-made files; this milestone generates them, and a generated brief
  that lost a rule would pass every gate here.
- **Test home:** none in the repository (the harness is local); recorded in the PR body.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none to a published interface. One behaviour change: a plugin that
registers a CLI command named `agents` becomes unreachable, because built-ins are matched first
(`packages/cli/src/cli.ts`, the `default` arm of the command `switch`). No in-repo plugin registers
one; CHANGELOG records it under Changed. Ships in the next patch.

| Exported symbol | Kind | Consumer / real code path that READS it                                                                                                                                              |
| --------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| none            | —    | `packages/cli/src/index.ts` is unchanged: the command is reached through `runCli`, and `renderBrief`/`gatherFacts`/`package-data` are internal. A `barrel-exports` assertion pins it |

### 4.1 Options — every option names its consumer

| Option             | Consumer                            | Behavior (per implementation)                                   |
| ------------------ | ----------------------------------- | --------------------------------------------------------------- |
| `agents --check`   | `runAgentsCommand` → §3.8           | compare, write nothing, exit 0/1                                |
| `agents --dir`     | `runAgentsCommand` via `resolveDir` | project directory, relative to cwd                              |
| `agents --dry-run` | `runAgentsCommand`                  | print the paths it would write; refused together with `--check` |
| `new --agents`     | `runNewCommand` → the agents writer | writes the brief after scaffolding                              |

## 5. Implementation files

| File                                                       | Purpose                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/cli/src/commands/agents.ts`                      | `runAgentsCommand`: classify, gather, render, write or check, warnings |
| `packages/cli/src/agents/facts.ts`                         | `ProjectFacts` and `gatherFacts(fs, dir)`                              |
| `packages/cli/src/agents/render.ts`                        | `renderBrief`, `renderWorkspaceRoot`, `renderMemberPointer`            |
| `packages/cli/src/agents/rules.ts`                         | the ordered rule blocks and predicates (§3.3)                          |
| `packages/cli/src/agents/brief-file.ts`                    | marker parsing and splice (§3.1)                                       |
| `packages/cli/src/agents/card-presence.ts`                 | §3.4 checks and warning text                                           |
| `packages/cli/src/agents/package-data.ts`                  | descriptions and tokens (§3.6)                                         |
| `packages/cli/src/cli.ts`, `flags.ts`, help text           | dispatch `agents`, its `ICommandFlagSpec`, `new --agents`              |
| `packages/cli/src/commands/new.ts`, `add.ts`               | `--agents`; the post-add hint                                          |
| `packages/*/AGENT_CARD.md` (50)                            | the cards                                                              |
| `scripts/node-manifests.ts`                                | `AGENT_CARD.md` in `files`; regenerated manifests                      |
| `scripts/verify-release.ts`, `scripts/npm-release-gate.ts` | the card check; the packed-tarball assertion                           |
| `packages/cli/src/commands/generate.ts`                    | schematic availability extracted to `availableSchematics` (§3.2)       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                               | src covered                 | Key assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/cli/test/unit/agents/brief-file.test.ts`      | `brief-file.ts`             | every §3.1 arrangement; outside bytes preserved                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/cli/test/unit/agents/gather-facts.test.ts`    | `facts.ts`                  | installed set, style, runtime, scripts present, seams, workspace member data from fake fs; unreadable runtime marker surfaces as exit 1                                                                                                                                                                                                                                                                                                                                                                |
| `packages/cli/test/unit/agents/render-brief.test.ts`    | `render.ts`                 | each section; not-installed excludes installed and runtime-restricted; commands only those defined; determinism (same facts → same bytes)                                                                                                                                                                                                                                                                                                                                                              |
| `packages/cli/test/unit/agents/rule-blocks.test.ts`     | `rules.ts`                  | facts → block ids table, each predicate both ways; every block passes the §3.11 identifier rule and its snippets compile (§8)                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/cli/test/unit/agents/workspace-brief.test.ts` | `render.ts` (workspace)     | root lists members/ports/transport and points at members; member points at root                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/cli/test/unit/agents/card-presence.test.ts`   | `card-presence.ts`          | missing card, PnP, Deno without `nodeModulesDir`, all present                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/cli/test/unit/agents/budget.test.ts`          | `render.ts`                 | every composition within §3.5 budgets                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/cli/test/unit/commands/agents.test.ts`        | `commands/agents.ts`        | flags, refusal outside a project, `--check` exit codes, `--dry-run`, interruption leaves no partial file (shared writer)                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/cli/test/unit/commands/{new,add}.test.ts`     | `new.ts`, `add.ts`          | `--agents` writes the brief; the add hint present only when a sectioned `AGENTS.md` exists                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/cli/test/unit/barrel-exports.test.ts`         | `src/index.ts`              | no new export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/cli/test/e2e/agents-e2e.test.ts`              | all, end to end             | `rest`, `class-based`, `microservice` and a two-member workspace (`full-stack` and Workers are covered at unit level — their installs are the slowest in the suite): `setu add cache`, install through the registry overlay, `setu agents`: installed and not-installed sets correct, every card path exists, `--check` exits 0, then 1 after `setu add audit` (absent from all three templates; the first draft used `queue`, which `microservice` already installs, so the check correctly stayed 0) |
| `test/agent-card-gate.test.ts`                          | the 50 cards                | §3.11 gates 1–3; a planted invented symbol and an over-budget card each fail (negative controls, reverted)                                                                                                                                                                                                                                                                                                                                                                                             |
| `test/agent-package-data.test.ts`                       | `package-data.ts`           | §3.6 drift gates; a changed description and a misspelled token each fail                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/cli/test/unit/commands/generate*.test.ts`     | `generate.ts`               | `generate --help` lists exactly `availableSchematics(installed)`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/unit/verify-release*.test.ts`                     | `scripts/verify-release.ts` | a member without a card is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m116-agent-briefs
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% branch/function/line every src file
pnpm run check:docs
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

Plus the scaffold e2e (it boots nothing, but installs through the registry overlay) and the §3.12
measurement.

## 8. Risks & mitigations

- **Cards are 50 hand-written files and will drift** → the four gates (§3.11); a planted invented
  symbol and an over-budget card are run as negative controls before the PR.
- **The pilot's bias**: the person who wrote its tasks wrote its brief and cards (pilot README). →
  The cards are written against `develop` per package rather than per task, and the measurement
  (§3.12) reuses the pilot's tasks, which can only flatter the result; the PR says so.
- **A rule block states something the code no longer does** (the pilot carried three such facts by
  `develop`, §1) → the rule-block strings go through the same two checks as a card: the identifier
  rule of §3.11 gate 2 (against `common` plus the packages each block's predicate requires), and any
  snippet in a block compiled through the fence engine — both asserted in `rule-blocks.test.ts`.
- **Agent tools that skip git-ignored paths** may not find `node_modules/...` by search → Rule 0
  gives the exact path; the pilot's model followed a `node_modules` path. The measurement confirms
  it on the generated brief.

## 9. Out of scope

- An MCP server, `llms.txt`, `setu explain`/`setu example`, `setu check` for applications — ROADMAP
  M116 "Not in this milestone", no owner yet.
- Copying cards into the project for Yarn PnP or Deno without `nodeModulesDir` — declined (§3.4).
- A `CLAUDE.md` writer — the docs tell the developer to add `@AGENTS.md` (§3.1).
- Running the measurement in CI — needs a local model (§3.12).

## 10. Design security review (recorded after implementation)

**Recorded after the committed-tree audit failed it as missing (F0)**, the M101a/M101b precedent.
The flow, assets, attackers and obligations below are the audit's reconstruction, adopted here as
the review; the decisions are this plan's answers to the audit's findings F1–F5.

- **Flow:** `setu agents [--check|--dry-run] [--dir]` → find the workspace the project belongs to →
  read `setu.workspace.json` and the project and member manifests (`package.json`, `deno.json[c]`,
  `.yarnrc.yml`, `.pnp.cjs`, the existing `AGENTS.md`) → render a Markdown section → splice it into
  `AGENTS.md` through `writeFiles`, or compare it (`--check`). `setu new --agents` runs the same
  writer; `setu add` reads `AGENTS.md` for its hint. Release: every library tarball carries its
  card, refused at pack and at `release:verify` otherwise.
- **Assets:** the developer's bytes outside the CLI-owned section; files outside the project; the
  generated section's trustworthiness as agent instructions; terminal output; `--check` as a CI
  gate; the command's availability; release integrity; the guidance in cards, which agents copy.
- **Attackers:** (A1) a repository contributor who controls committed manifests, `.yarnrc.yml` or
  links in the tree; (A2) another local user who can plant files in a shared ancestor such as
  `/tmp`; (A3) an agent or developer copying a card snippet verbatim.
- **Obligations:** O1 writes stay inside the project and never go through links; O2 special and
  oversize files neither hang nor are read past 1 MiB, and bytes outside the markers survive; O3
  ambiguous marker arrangements are refused with nothing written; O4 manifest content cannot change
  the structure of the generated section or forge terminal lines; O5 the walk writes only the
  requested project or the workspace that lists it; O6 `--check` writes nothing and exits 0 only
  when every file it owns is fresh; O7 every reachable read is bounded in time; O8 no library
  tarball publishes without its card; O9 card snippets do not lead a copier to an insecure
  deployment.

Decisions:

- **F1 (O4):** every manifest-derived string that reaches the section is admitted only if it is safe
  there; nothing is escaped into a different value. A dependency key is rendered (and card-checked)
  only when its bare name matches the npm package-name grammar `^[a-z0-9][a-z0-9._-]*$` and is not
  `.` or `..`; any other key is omitted. A member name, port, `dependsOn` entry or `transportUrl` is
  rendered only when it contains no control character and none of `` ` ``, `|`, `<`, `>`; otherwise
  it renders as `(not shown)`. A rendered section that would contain the begin or end marker more
  than once is refused rather than written.
- **F2 (O4):** every terminal line the command prints from project data goes through `escapeName`,
  and card warnings name only admitted package names (F1).
- **F3 (O5, O7):** the walk follows `installSearchDirs` (`app-loader.ts`): an ancestor is a
  workspace only when it holds a regular `setu.workspace.json` (opened-handle checked, at most 1
  MiB) that parses and lists the project as `apps/<member>`; the directory itself counts when it is
  that root. A project that is not a listed member is standalone. Only `setu.workspace.json` is read
  in ancestors — never their `package.json`/`deno.json` — and an ancestor whose marker is unreadable
  (a non-missing stat error, a non-regular file, oversize, unparsable) is treated as not a workspace
  and the walk continues, so a planted file can neither hang nor misroute the command.
- **F4 (O7):** the `.yarnrc.yml` `nodeLinker` read is linear: lines are scanned one by one with an
  anchored, non-multiline pattern.
- **F5 (O9):** card snippets use visibly placeholder secrets (`replace-with-…`) that still satisfy
  the length checks, matching the READMEs.
- **R2-1 (O7):** the stat/read race in ancestor markers is closed by a CLI-internal optional
  `readRegularFile` capability, installed by the Node executable. It opens read-only with
  non-blocking/no-controlling-terminal flags where available, checks the opened handle with `fstat`,
  refuses non-regular files, reads at most 1 MiB + 1 bytes and refuses overflow, and always closes
  the handle. `readExistingText` uses it without a preceding path stat; test filesystems lacking it
  retain the existing stat-then-read fallback. No common interface or public export changes.
- **R2-2 (O7):** project manifests use that same bounded text reader; non-regular, oversize or
  unreadable content maps to `unreadable`, and ENOENT stays `missing`. Runtime marker presence uses
  only `stat`: any existing file type counts as present, including a FIFO or device, and no content
  is opened. Other stat errors retain `RuntimeMarkerUnreadableError`.
- **R2-3 (O5):** agents workspace adoption and `installSearchDirs` share one internal comparison
  helper. Backslashes become separators only for drive-rooted or UNC paths; a POSIX `apps\x`
  directory never matches the listed `apps/x` member. Trailing slashes are stripped.
- **R2-4 (O9):** the secrets and mail cards' two credential literals were replaced by configuration
  reads in commit `57ede20d`. This repair does not change cards.
- **Re-audit:** after F1–F5 land, a fresh-context audit re-runs O4, O5, O7 and O9.
