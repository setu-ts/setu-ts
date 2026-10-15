# Milestone 111f — Governing documents and the JSR sunset (docs + `scripts/`)

> **Status:** Planning. Branch: `feat/m111f-docs-jsr-sunset`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR into
> `develop`.

## 0. Objective & scope

After M111e3 the root `deno.json` is gone, so every `deno task <name>` instruction addressed to this
repository fails outright, and the documents that govern agent and contributor work still describe a
Deno toolchain. This milestone makes the documents describe the toolchain the repository actually
uses (pnpm, Node 24, Vitest, Prettier, ESLint, `tsc`, TypeDoc), fixes the user-facing install lines
that still resolve the stale JSR versions, points each JSR package page at npm, and adds a gate so a
`deno task` or JSR install instruction cannot come back. Deno stays a supported runtime: the Deno
adapter, the CLI's `--runtime deno` output and the Deno lane are not touched.

- **In scope:**
  - Rewrite the live toolchain prose in `AI_GUIDELINES.md`, `AGENTS.md`, `CLAUDE.md` (every section
    except `## Current status`), `CONTRIBUTING.md`, `ARCHITECTURE.md`, `PUBLIC_API.md`, `README.md`,
    `docs/`, `plans/TEMPLATE.md`, `.roo/` rules and skills, every package and app README, the live
    sections of `ROADMAP.md` (the Versioning Policy section), `.gitignore`/`.prettierignore`
    comments, and code comments that name a `deno task` as the gate that checks them.
  - Fix the three bare `deno add @setu-ts/<pkg>` lines (auth, queue, graphql READMEs), which Deno
    resolves from JSR and so install 0.8.0, and the website's `deno add jsr:@setu-ts/…` line.
  - A toolchain-prose gate (`scripts/toolchain-prose.ts`, run by `check:docs`).
  - The JSR sunset: each of the 49 JSR package descriptions leads with the npm pointer, set by the
    existing `release:set-metadata` script restricted to the packages that exist on JSR.
- **NOT this milestone:**
  - Publishing anything to JSR — no milestone owns that; nothing new is published there (README).
  - Removing the JSR-only release scripts (`release:create-packages`, `release:link-repos`,
    `release:verify-repos`, `release:archive-old-scope`) — no milestone owns it; kept deliberately
    (§9).
  - The `v0.9.0` smoke run and M104 — separate tracks.

## 1. Contracts verified from SOURCE (not names)

| Reference                             | Source (file:line)                                                                                                          | Verified surface / fact                                                                                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No root Deno manifest                 | `test/node/task-surface.test.ts:6-18`                                                                                       | Asserts `deno.json`, `deno.lock`, `website/deno.json` and every `apps/*/deno.json` absent, so `deno task <x>` at the root or in an app cannot run.                                                                                                  |
| Root script surface                   | `package.json` `scripts`                                                                                                    | 41 scripts incl. `check`, `check:docs`, `check:plan`, `test`, `test:coverage`, `test:coverage:pkg`, `test:tooling`, `test:deno-lane`, `fmt:check`, `lint`, `audit`, `release:*`. Every live `deno task X` has a `pnpm run X`.                       |
| App script surface                    | `apps/*/package.json`                                                                                                       | Every app has `start`, `smoke`, `check`; `full-stack` adds `build`/`test`/`browser`, `graphql-demo` `interop`, `compiled-binary` `build:sea`, `plugin-development` `test`. No app has `compile`.                                                    |
| `check` covers `test/`                | `package.json:10`, `tsconfig.check.json` `include`/`exclude`                                                                | `tsc -p tsconfig.check.json` includes `packages/*/src`, `packages/*/test`, starters, `scripts`, `test`, minus an explicit exclude list. A comment "type-checked by `deno task check`" is true as `pnpm run check` only if its file is not excluded. |
| ESLint and Prettier ignore `.claude/` | `eslint.config.mjs:14` (`includeIgnoreFile(.gitignore)`), `.gitignore:61`                                                   | ESLint reads `.gitignore`; Prettier 3 reads `.gitignore` by default. AI_GUIDELINES §15.4's "invisible to `deno fmt`/`deno lint`" becomes "to Prettier and ESLint".                                                                                  |
| Audit                                 | `package.json` `audit`/`audit:ci` → `scripts/audit.ts`                                                                      | Runs `pnpm audit`, not `deno audit`. §12.5 and §17.2 are stale.                                                                                                                                                                                     |
| JSDoc ratchet                         | `scripts/generate-api-docs.ts` (M111e2: TypeDoc 0.28.20)                                                                    | The `deno doc --lint` ratchet is TypeDoc; §7.4 and §17.2 are stale.                                                                                                                                                                                 |
| JSR descriptions also feed npm        | `scripts/node-manifests.ts:426`, `scripts/npm-placeholders.ts:2`                                                            | `PACKAGE_METADATA[name].description` is the generated `package.json` `description` on npm. The JSR sunset text must NOT be written into `PACKAGE_METADATA`.                                                                                         |
| `release:set-metadata` package set    | `scripts/set-jsr-metadata.ts:78`                                                                                            | `const names = PUBLISHED_PACKAGES.map(...)` — 52 packages. `localization-plugin`, `idempotency-plugin` and `create` were never on JSR, so a run would 404 on three.                                                                                 |
| Packages on JSR                       | `GET https://api.jsr.io/scopes/setu-ts/packages?limit=100` (2026-10-16)                                                     | 49 packages, every one `latestVersion: 0.8.0`.                                                                                                                                                                                                      |
| JSR description rule                  | jsr-io/jsr `api/src/api/package.rs` `update_description` (lines 708-718)                                                    | Trimmed, `\n` → space, rejected over **250 bytes** (Rust `len()`), rejected if it contains a control character. One enum variant per PATCH (`set-jsr-metadata.ts` module doc).                                                                      |
| JSR archive                           | same file, `ApiUpdatePackageRequest::IsArchived(bool)`                                                                      | Archiving exists, blocks new versions and hides the package from search; reversible.                                                                                                                                                                |
| JSR README per version                | `CLAUDE.md` alpha.2 entry; JSR versions are immutable                                                                       | A package page renders the latest version's README; changing it needs a new JSR version.                                                                                                                                                            |
| `docs/upgrading.md` 0.9.0 entry       | `docs/upgrading.md:14-37`                                                                                                   | Already covers `jsr:@setu-ts/*` and `npm:@jsr/setu-ts__*` → npm, and `setu adopt` (shipped in the `v0.9.0` cut, PR #451).                                                                                                                           |
| "Deno-first" in AI_GUIDELINES         | `git grep -n Deno-first AI_GUIDELINES.md` → 0 hits                                                                          | The statement the ROADMAP names does not exist there; the stale Deno-first claim is `CLAUDE.md:3-5` ("published to JSR … via JSR npm compatibility").                                                                                               |
| Bare `deno add @setu-ts/…`            | `packages/auth-plugin/README.md:42`, `packages/queue-plugin/README.md:8`, `packages/graphql-plugin/README.md:19`            | Deno resolves an unprefixed `deno add` argument from JSR, so these install 0.8.0. All other package READMEs already use `deno add npm:@setu-ts/…`.                                                                                                  |
| Website install line                  | `website/src/pages/index.astro:76`                                                                                          | `deno add jsr:@setu-ts/kernel jsr:@setu-ts/runtime` (line 76) and `npx jsr add @setu-ts/kernel @setu-ts/runtime` (line 78) — both install 0.8.0.                                                                                                    |
| Starter JSDoc links                   | `packages/starters/{rest,microservice,full-stack}-starter/src/index.ts:11`                                                  | `@see {@link https://jsr.io/@setu-ts/<starter>}` — published API docs pointing at a page frozen at 0.8.0.                                                                                                                                           |
| Generated Deno task names             | `packages/cli/src/templates/project-files.ts` (task literals)                                                               | A `--runtime deno` project gets `build`, `check`, `dev`, `install`, `start`, `test`, and `proto:gen` with a gRPC transport (`workspace/proto-toolchain.ts:90`). No `lint` task.                                                                     |
| `deno fmt` still runs                 | `package.json` `fmt`/`fmt:check`; `CONTRIBUTING.md:57`                                                                      | The fmt pair runs `deno fmt` over the five SDK generated-client fixtures, so `deno fmt` is a true statement in the governing docs.                                                                                                                  |
| React Router `jsr:` matcher           | `packages/react-router-plugin/src/dev/vite-dev-externals.ts:107`                                                            | Matches any `jsr:` specifier (third-party JSR libraries stay valid); its test fixture's `jsr:@setu-ts/common` is matcher data, not an install instruction.                                                                                          |
| CLI legacy-pin handling               | `packages/cli/src/workspace/legacy-pins.ts:4-5`, `commands/adopt.ts:380`, `devtool/sources.ts:261-263`, `app-loader.ts:260` | Recognizes and rewrites pre-0.9 `jsr:`/`npm:@jsr/` pins. Legitimate code that must keep naming them.                                                                                                                                                |
| Script coverage inventory             | `scripts/script-targets.ts` `SCRIPT_TARGETS`                                                                                | New measured scripts are added here (M111e2 precedent); `set-jsr-metadata.ts` is not a target today.                                                                                                                                                |
| `check:docs` entry                    | `scripts/check-docs.ts:2342` (`runDocsMain`)                                                                                | The new scan is called from `runDocsMain`, so no new `package.json` script (which `node-manifests.ts` would also have to generate).                                                                                                                 |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                 | Resolution (picked side)                                                                                                                        | Doc deliverable (same PR)                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| C1  | ROADMAP M111f: "Each JSR package's README … point to npm". A published JSR README cannot change (§1).                                                                                                    | Only the package **description** is mutable and is changed. No JSR version is published.                                                        | ROADMAP M111f bullet corrected.                 |
| C2  | ROADMAP M111f exit: the search returns "only historical records and the Deno adapter". Measured: CLI legacy-pin code, CLI Deno-target output and gate test fixtures also legitimately contain the terms. | The gate's categorized allowlist (§3.2) is the definition; the exit reads "returns only files in the gate's allowlist, each with its category". | ROADMAP M111f exit corrected.                   |
| C3  | ROADMAP M111f names "the Deno-first statement" in AI_GUIDELINES; none exists there (§1).                                                                                                                 | The stale claim is `CLAUDE.md:3-5`; it is rewritten there. AI_GUIDELINES gets its own stale sections (§3.4).                                    | ROADMAP bullet corrected.                       |
| C4  | ROADMAP M111f lists a `docs/upgrading.md` JSR→npm entry as a deliverable; it shipped in the `v0.9.0` cut.                                                                                                | Recorded as delivered by PR #451; no second entry.                                                                                              | ROADMAP bullet marked delivered.                |
| C5  | AI_GUIDELINES §6.4 says `deno task test` forwards to the tooling member; there is no `deno task` (§1).                                                                                                   | Commands are `pnpm run <name>` everywhere.                                                                                                      | AI_GUIDELINES §6.4 (and every section in §3.4). |
| C6  | README.md lines 385 and 415 call the scripts and `docs/releasing.md` "JSR release tooling" / "JSR release runbook".                                                                                      | npm release tooling and runbook.                                                                                                                | README.md.                                      |

## 3. Design decisions

### 3.1 Command translation

- **Decision:** a repository instruction `deno task <x>` becomes `pnpm run <x>`; an app instruction
  becomes `pnpm --dir apps/<name> run <x>` (runnable from the root, no `cd`). Commands are rewritten
  only where `<x>` exists in the target `package.json` (§1); a name that no longer exists (an app's
  `compile`) is replaced by the script that does the job (`build:sea`) or removed with the sentence.
  A comment claiming `deno task check` type-checks a file becomes `pnpm run check` only after the
  file is confirmed inside `tsconfig.check.json` and not in its exclude list; otherwise the comment
  names the gate that does check it (the Deno lane's `deno test`).
- **Why:** M111e3 removed the forwarding manifests; a translated command that names a missing script
  is the same defect in a new spelling.
- **Test home:** `test/toolchain-prose.test.ts` rule P4 (§3.2) for the files it covers; the
  type-check claims by a one-off `tsc --listFilesOnly -p tsconfig.check.json` comparison recorded in
  the PR.

### 3.2 Toolchain-prose gate

- **Decision:** a pure module `scripts/toolchain-prose.ts` exporting
  `scanToolchainProse(files: readonly ProseFile[], rules: ToolchainProseRules): ToolchainProseFinding[]`
  over in-memory `{ path, text }` pairs, plus `TOOLCHAIN_PROSE_RULES` (the committed data below),
  and `runToolchainProseCheck(root)` which reads `git ls-files` restricted to `.md`, `.ts`, `.tsx`,
  `.mjs`, `.js`, `.json`, `.jsonc`, `.yaml`, `.yml`, `.toml`, `.astro`, `.txt` and the two ignore
  files, and calls the scanner. `scripts/check-docs.ts` `runDocsMain` calls it and prints each
  finding. Rules:
  - **History** (exempt from every rule): `CHANGELOG.md`, `ROADMAP.md`, `plans/archive/**`,
    `plans/reviews/**`, a milestone plan at `plans/` root (`plans/milestone-*.md`, archived when its
    milestone merges; `plans/TEMPLATE.md` is scanned), and the `## Current status` section of
    `CLAUDE.md` (from that heading to the next `## ` heading; the rest of `CLAUDE.md` is scanned).
  - **P1** — `deno task`, `jsr:@setu-ts/`, `@jsr/setu-ts__`, `Deno-first` (case-insensitive) is a
    finding in any file not in the **allowlist**. Each allowlist entry is
    `{ path, category, reason }` with category `deno-target` (CLI output and tests for
    `--runtime deno` projects, the Deno workspace sections of `PUBLIC_API.md`, `docs/cli.md`),
    `legacy-pin` (pre-0.9 pin recognition and its tests, `docs/upgrading.md`,
    `docs/getting-started.md`'s JSR-era troubleshooting), `fixture` (gate tests whose inputs are the
    strings, this gate's own source and test, `scripts/check-docs.ts` and the `@since` gate, which
    read JSR for 0.8.0 and earlier, `test/deno-lane/deno.lock`), or `matcher` (the React Router
    `jsr:` matcher test). An allowlisted file with no P1 hit is itself a finding, so the list only
    shrinks (the M38 ratchet precedent).
  - **P2** — in any non-history file, allowlisted or not, `deno task <name>` where `<name>` is a
    root `package.json` script and not one of `GENERATED_DENO_TASKS` (`build`, `check`, `dev`,
    `install`, `proto:gen`, `start`, `test`, measured in §1) is a finding: it is a repository
    instruction.
  - **P3** — in any non-history file, a `deno add` or `jsr add` command (including `npx jsr add`)
    with an argument starting `@setu-ts/` (no `npm:`/`jsr:` prefix) is a finding: both resolve it
    from JSR.
  - **P4** — in the repository-instruction files (`AGENTS.md`, `AI_GUIDELINES.md`,
    `CONTRIBUTING.md`, `CLAUDE.md` outside history, `plans/TEMPLATE.md`, `.roo/**`,
    `docs/releasing.md`, `docs/examples.md`, `apps/README.md`, `apps/*/README.md`),
    `pnpm run <name>` must name a root script and `pnpm --dir apps/<a> run <name>` must name a
    script of that app.
  - **P5** — the repository-instruction files above, except `CLAUDE.md` (whose verification notes
    describe generated Deno projects), must not name `deno lint`, `deno doc`, `deno audit` or
    `deno-lint-ignore`: no repository gate runs them. `deno fmt` is not refused — the `fmt` pair
    still runs it over the SDK fixtures (§1).
  - **P6** — a `jsr.io/@setu-ts` URL is a finding in any non-history file not allowlisted: the page
    stops at 0.8.0.
- **Why:** the enumeration lives in the test as data (CLAUDE.md "Docs must match behavior"); a prose
  sweep without it regresses on the next edit. Running inside `check:docs` puts it on every PR
  without a new script entry.
- **Test home:** `test/toolchain-prose.test.ts` — each rule with a planted violation in memory, the
  history and section exemption, the stale-allowlist finding, and one case scanning the real tree
  that expects zero findings.

### 3.3 JSR sunset description

- **Decision:** a pure module `scripts/jsr-sunset.ts` exports `JSR_PACKAGES` (the 49 names on JSR,
  frozen data verified against the registry, §1) and `jsrSunsetDescription(name, base)`, which
  returns `Moved to npm as @setu-ts/<name>; JSR keeps 0.8.0 and earlier. <base>`, cut at the last
  space so the result is at most 250 UTF-8 bytes (ending `…` when cut), and throws when the input
  contains a control character or the prefix alone exceeds the bound. `set-jsr-metadata.ts` iterates
  `JSR_PACKAGES` (refusing a name absent from `PUBLISHED_PACKAGES`), sends and compares
  `jsrSunsetDescription(name, PACKAGE_METADATA[name].description)`, and its `--dry-run` prints that
  description per package. `PACKAGE_METADATA` is unchanged, so npm descriptions are unchanged.
  Running it against JSR needs the maintainer's `JSR_TOKEN` and is a post-merge maintainer step,
  documented in `docs/releasing.md`; this milestone does not run it.
- **Why:** the description is the one JSR field that can change (§1, C1); deriving it keeps one
  authored description per package; the 49-name list stops the three never-on-JSR packages from
  failing the run.
- **Test home:** `test/unit/jsr-sunset.test.ts` (byte bound with a multi-byte base, cut position,
  control-character refusal, every `JSR_PACKAGES` name in `PUBLISHED_PACKAGES`, the three npm-only
  packages absent); `test/set-jsr-metadata-dry-run.test.ts` runs the script with `--dry-run` as a
  subprocess and asserts 49 packages listed, one exact description, and no network use (no token
  set).

### 3.4 What each governing document says

- **Decision:** `AI_GUIDELINES.md` — §3.7 version source is the member `package.json`; §4.5 drops
  "repository scripts keep their Deno runner until M111e"; §5.1 compiler options live in
  `tsconfig.base.json`; §6.4 and §6.9 name `pnpm run test:tooling` and the Vitest partition; §7.4
  TypeDoc and npm; §8.1/8.3/8.6 `pnpm run`; §12.2 "published package's dependency graph"; §12.5
  `pnpm audit` through `pnpm run audit`; §14.3 `exports` and `sideEffects` in the generated
  `package.json`; §15.4 Prettier and ESLint; §17.2 enforcement table with the real tools; §17.3
  `// eslint-disable-next-line <rule> -- <reason>`. `CLAUDE.md` — the opening paragraph (npm, Node,
  Deno as a supported runtime), the pitfalls' `deno lint`/`deno fmt`/`deno-lint-ignore-file`
  references, and the worktree note. `AGENTS.md`, `.roo/**`, `plans/TEMPLATE.md`: every command
  block. `ROADMAP.md`: the Versioning Policy section's `deno task check:plan`, and the M111f section
  (C1–C4). Every rewritten claim is checked against the source it describes before it is written.
- **Why:** these files instruct agents; a wrong command there is copied into every plan and review.
- **Test home:** P1, P4 and P5 of `test/toolchain-prose.test.ts` against the real tree.

### 3.5 No JSR archive

- **Decision:** the JSR packages are not archived.
- **Why:** archiving hides a package from search, which removes the npm pointer from where a JSR
  user finds it, and blocks a JSR security patch should one ever be needed. Reversible later by one
  PATCH per package if the maintainer chooses.
- **Test home:** none (no code path); recorded in `docs/releasing.md`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. No package `src/index.ts` changes; package READMEs and comments
change, and the `src` edits are comment-only:
`packages/database-plugin/src/adapters/mongo/mongo-client-types.ts`, the three starters' module
JSDoc `@see` link (jsr.io → npmjs.com), and any CLI comment §3.1 finds addressed to this repository
rather than to a generated project.

| Exported symbol                                             | Kind     | Consumer / real code path that READS it                                  |
| ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `scanToolchainProse`                                        | function | `runToolchainProseCheck`; `test/toolchain-prose.test.ts`                 |
| `runToolchainProseCheck`                                    | function | `scripts/check-docs.ts` `runDocsMain` (so `pnpm run check:docs` in CI)   |
| `TOOLCHAIN_PROSE_RULES`                                     | const    | `runToolchainProseCheck`                                                 |
| `ProseFile`, `ToolchainProseFinding`, `ToolchainProseRules` | types    | the three functions above and the test                                   |
| `JSR_PACKAGES`                                              | const    | `scripts/set-jsr-metadata.ts` main                                       |
| `jsrSunsetDescription`                                      | function | `scripts/set-jsr-metadata.ts` main (compare, PATCH body, dry-run output) |

### 4.1 Options — every option names its consumer

| Option                                     | Consumer                   | Behavior (per implementation)                                        |
| ------------------------------------------ | -------------------------- | -------------------------------------------------------------------- |
| `set-jsr-metadata.ts --dry-run` (existing) | `set-jsr-metadata.ts` main | Now also prints each package's sunset description; still no network. |

## 5. Implementation files

| File                                    | Purpose                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/toolchain-prose.ts`            | The gate of §3.2.                                                                                                                                            |
| `scripts/jsr-sunset.ts`                 | `JSR_PACKAGES` and `jsrSunsetDescription` (§3.3).                                                                                                            |
| `scripts/set-jsr-metadata.ts`           | Iterates `JSR_PACKAGES`; sends the sunset description; dry-run prints it.                                                                                    |
| `scripts/check-docs.ts`                 | Calls `runToolchainProseCheck`.                                                                                                                              |
| `scripts/script-targets.ts`             | Adds the two new scripts to the coverage inventory.                                                                                                          |
| `packages/starters/*/src/index.ts`      | `@see` link to the npm package page.                                                                                                                         |
| `website/src/pages/index.astro`         | Both install lines: `deno add npm:@setu-ts/kernel npm:@setu-ts/runtime` and `npm install @setu-ts/kernel @setu-ts/runtime`.                                  |
| The documents and comments of §0 / §3.4 | Prose rewrite.                                                                                                                                               |
| `docs/releasing.md`                     | "JSR sunset" section: the one-time `release:set-metadata` run, no archive, nothing new published.                                                            |
| `CHANGELOG.md` `Unreleased`             | Fixed: the three bare `deno add` lines and the website install line; Changed: JSR descriptions point to npm. No `docs/upgrading.md` entry: no reader action. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                               | src covered                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/toolchain-prose.test.ts`          | `scripts/toolchain-prose.ts`                 | `scanToolchainProse(files, rules)`: each of P1–P6 reports a planted line with path and line number; history files and the `CLAUDE.md` `## Current status` section are exempt while `CLAUDE.md` outside it is not; a stale allowlist entry is a finding; P2 ignores generated task names; P3 accepts `npm:`/`jsr:` prefixes; `runToolchainProseCheck(repoRoot)` on the real tree returns `[]`. |
| `test/unit/jsr-sunset.test.ts`          | `scripts/jsr-sunset.ts`                      | `jsrSunsetDescription(name, base): string` ≤250 bytes for every `JSR_PACKAGES` × `PACKAGE_METADATA` pair and for a 300-byte multi-byte base; cut at a space with `…`; throws on a control character; `JSR_PACKAGES` has 49 names, all in `PUBLISHED_PACKAGES`, none of `localization-plugin`, `idempotency-plugin`, `create`.                                                                 |
| `test/set-jsr-metadata-dry-run.test.ts` | `scripts/set-jsr-metadata.ts` (dry-run path) | Subprocess `node scripts/set-jsr-metadata.ts --dry-run` with no `JSR_TOKEN`: exit 0, 49 packages listed, the `kernel` line carries the exact sunset description.                                                                                                                                                                                                                              |

`scripts/set-jsr-metadata.ts` stays outside `SCRIPT_TARGETS` (it was before; its network path needs
a token), with its decidable logic moved into the measured `scripts/jsr-sunset.ts`.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m111f-docs-jsr-sunset, never develop or main
pnpm run check:plan         # this plan lints clean
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run test:tooling:coverage   # ANSI-stripped per-file table; both new scripts ≥90% branch/function/line
pnpm run check:docs
```

Negative controls, each observed failing and reverted: restore `deno task fmt:check` in `AGENTS.md`
(P1 and P2); restore `deno add @setu-ts/auth-plugin` (P3); point an app README at
`pnpm --dir apps/minimal run compile` (P4); add `deno lint` to `.roo/rules/01-project.md` (P5); add
a needless allowlist entry (stale entry); make `jsrSunsetDescription` skip the byte cut (the
300-byte case); add a `jsr.io/@setu-ts/kernel` link to `docs/getting-started.md` (P6). Package
source changes are comments only, which `pnpm run check` and `pnpm run lint` cover; the README
fences `test/package-readme-fence-compiler.test.ts` covers are compiled by the tooling suite. The
website runs `pnpm --dir website test` and its build in the CI website job, which the `index.astro`
change triggers.

## 8. Risks & mitigations

- A prose rewrite states a command or claim that is false → §3.1's existence checks, P4, and one
  read of every rewritten claim against its source; the review re-runs a sample of rewritten
  commands.
- The real-tree gate case is slow → the scan reads only tracked text files once; measured in the PR.
- The JSR run is never performed → `docs/releasing.md` names it; the PR description lists it as the
  maintainer's post-merge step.
- An allowlist entry hides a live instruction in a `deno-target` file → P2 and P3 still apply inside
  allowlisted files.

## 9. Out of scope

- Publishing a final JSR version to change its README — nothing new is published on JSR (C1).
- Archiving the JSR packages — decided against (§3.5); a later maintainer call, no milestone owns
  it.
- Deleting the JSR-only release scripts — they cost nothing idle and `release:set-metadata` is still
  needed; no milestone owns a deletion.
- `deno fmt` as the SDK generator's output target and the CLI's `--runtime deno` output — supported
  Deno behaviour, not repository tooling.
