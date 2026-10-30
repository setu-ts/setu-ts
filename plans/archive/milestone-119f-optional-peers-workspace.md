# Milestone 119f — Optional peers in an npm workspace (`@setu-ts/common`, `@setu-ts/cli`, every package with optional peers)

> **Status:** Planning. Branch: `feat/m119f-optional-peers-workspace`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

An optional peer a Setu-TS package loads must be installed where that package can resolve it, and
when it is not, the startup error must say where it belongs. M113d made every optional peer a
guarded `await import()` resolved from the **framework package's** location. In an npm or Bun
workspace npm hoists the framework package to the root, while a peer can land nested under a member,
where the hoisted package cannot see it (V10-50); and nothing tells a user where peers go (V10-58).

**Reproduction (2026-10-25, published `0.10.0`, npm 11, scratch workspaces):**

- A member installing `@setu-ts/cache-plugin` with `ioredis@6` (outside the plugin's `5.x` peer
  range): npm installs a SECOND, in-range `ioredis@5.11.1` at the root for the hoisted plugin and
  `6.0.0` under the member for the app — two copies, silently.
- A member installing `@setu-ts/telemetry-plugin` with `@opentelemetry/api@1.10.0` (which the
  OpenTelemetry 2.x packages' own peer ranges, `<1.10.0`, reject): npm splits the API into `1.9.1`
  at the root and `1.10.0` under the member.
- The M115 builders' crash (`relaymark/notes/optional-peer-startup-failure.log`): the deployed image
  installs from the root lockfile with one member's manifest; the lockfile recorded the
  OpenTelemetry peers nested under the member (a conflict between members), so the root-hoisted
  `telemetry-plugin` could not import `@opentelemetry/exporter-trace-otlp-http` and the process
  exited. Their repair was declaring exact, in-range peers in the ROOT manifest.
- A bare `npm install` of the peers into a member, with nothing conflicting, resolves every peer to
  an in-range version at the root, and works. The latest upstream releases are already outside our
  ranges (`@opentelemetry/exporter-trace-otlp-http` 0.300.0 vs `^0.220.0`, `resources` and
  `context-async-hooks` 3.0.0 vs `^2`, `ioredis` 6.0.0 vs `5.x`), so a pinned or explicit install
  lands outside them easily.

Maintainer decision (2026-10-25, recommended option, after comparing frameworks): keep resolving
from the framework package's own location (Next.js resolves `sharp`, NestJS `loadPackage` its
drivers, the same way) rather than resolving from the application (Vite, Prettier, pino) or taking
injected modules (ESLint flat config). The fix is placement tooling, a startup error that names the
remedy, and documentation.

- **In scope:** V10-50, V10-58 — the `OptionalDependencyUnavailableError` message and its optional
  `requiredBy`; `setu add` recording peers in an npm/Bun workspace root; the guidance in
  `docs/plugins.md`, `docs/cli.md`, the telemetry README and the `common` README.
- **NOT this milestone:** resolving peers from the application or injecting modules (declined,
  2026-10-25); refreshing the stale peer RANGES to the new upstream majors (each major needs its own
  compatibility work — no smoke row; a later milestone); Deno workspaces (Deno resolves `npm:`
  packages through its own cache, not hoisted `node_modules` — not reproduced, not changed); pnpm
  (`pnpm-workspace.yaml`, not a `workspaces` field — Setu workspaces do not generate it, unchanged);
  adding `@opentelemetry/exporter-trace-otlp-http` to `setu add telemetry`'s peer list (the console
  exporter is what `setu add` wires); M119h's `add.ts:339` link change (separate branch, separate
  lines).

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                                                        | Verified surface / fact                                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OptionalDependencyUnavailableError` | `packages/common/src/errors/optional-dependency.ts:41–62`                                                 | `(dependency, options?: { cause? })`; field `dependency`; the pre-M119f message names the dependency and suggests installing it in the application No status hint.                                                                           |
| Its call sites                       | `git grep "OptionalDependencyUnavailableError(" packages/*/src`                                           | 49 sites in 16 packages (auth 2, cache 1, cli 2, database 4, graphql 1, grpc 4, idempotency 1, mail 2, messaging 6, openapi 1, queue 4, runtime 1, scheduler 1, secrets 4, storage 4, telemetry 11), excluding `common`'s own JSDoc example. |
| Peer declaration                     | `scripts/node-manifests.ts:255–276`, `scripts/node-dependency-ranges.ts`                                  | A `src` external reached only by dynamic `import()` becomes an optional `peerDependencies` entry (+ `peerDependenciesMeta.optional`) with the range from the tooling table; the table never ships.                                           |
| Published telemetry peers            | `npm view @setu-ts/telemetry-plugin@0.10.0`                                                               | Ten `@opentelemetry/*` optional peers, e.g. `api ^1.9.0`, `exporter-trace-otlp-http ^0.220.0`, `context-async-hooks ^2.0.0`.                                                                                                                 |
| `setu add` peer table                | `packages/cli/src/commands/add.ts:92–100, 154–177, 544–556`                                               | `ADDABLE` entries carry `peers: { runtimes, packages }`; `peerPackagesFor(bare, runtime)` reads ranges from `CLIENT_RANGES`.                                                                                                                 |
| `setu add` writes                    | `add.ts:828–905`                                                                                          | Rewrites the MEMBER's `deno.json`/`deno.jsonc`/`package.json` only; peers ride the same rewrite via `withPeerDependencies` (`add.ts:560–590`) into `dependencies`/`imports`; it prints the install command, never runs it.                   |
| Workspace-root refusal               | `add.ts:791–801`                                                                                          | `setu add` run AT a workspace root is refused; it must target a member (`--dir`).                                                                                                                                                            |
| Setu workspace detection             | `packages/cli/src/app-loader.ts:201–218`, `workspace/manifest.ts:27`                                      | `installSearchDirs` walks up to a `setu.workspace.json` whose `members` lists this directory (members under `apps/`); returns `[dir]` otherwise.                                                                                             |
| Workspace profiles                   | `packages/cli/src/workspace/runtime-profile.ts:208–239`                                                   | `node` and `bun` profiles: `manifestKind: 'npm'`, `rootManifestFile: 'package.json'`, `globKey: 'workspaces'`; Deno uses `deno.json` `workspace`.                                                                                            |
| `CLIENT_RANGES`                      | `packages/cli/src/templates/client-dependencies.ts:20–38`                                                 | The CLI's install ranges: `@opentelemetry/api ~1.9.0` (pinned below 1.10 on purpose), `sdk-trace-base ^2.9.0`, `resources ^2.9.0`, `context-async-hooks ^2.0.0`, `ioredis 5.x`, `ws ^8.18.0`, `zod ^4.6.6`, …                                |
| Optional-peer docs                   | `docs/plugins.md:22–60`, `docs/cli.md:640` (`### Workspaces`), `packages/telemetry-plugin/README.md:6–11` | Explain that a package manager never installs an optional peer; say nothing about workspaces or hoisting.                                                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                            | Resolution (picked side)                                                                               | Doc deliverable (same PR)                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| C1  | The error says "Install it in the application", which in a workspace member is exactly the place a hoisted package cannot see.                      | The message changes (§3.1).                                                                            | `common` README + `PUBLIC_API.md` `OptionalDependencyUnavailableError` entry. |
| C2  | `docs/plugins.md` says to install optional peers but not where; the builders installed them per member, as the generated workspace layout suggests. | Peers go where the framework package is installed — the workspace root in an npm/Bun workspace (§3.3). | `docs/plugins.md`, `docs/cli.md` Workspaces, telemetry README.                |

## 3. Design decisions

### 3.1 The error names who loads the peer and where it must be installed (V10-50)

- **Decision:** `OptionalDependencyUnavailableError` gains an optional constructor option
  `requiredBy?: string` (the npm name of the package whose code ran the import). The message
  becomes:
  `Optional dependency '<d>' could not be loaded[ by '<requiredBy>']. Install it where '<requiredBy | the package that loads it>' is installed, in the range its peerDependencies declare — in an npm, Yarn or Bun workspace that is usually the workspace root, not the member — or choose an option that does not need it on this runtime.`
  Without `requiredBy` the bracketed parts read generically. Every one of the 49 `src` call sites
  passes its own package name as a string literal (no runtime lookup, no `import.meta`). No new
  field: the name only feeds the message (a field read by nothing would be dead surface). The range
  is NOT repeated in the message: ranges live only in the tooling table, and copying them into 16
  packages would drift.
- **Why:** the builders' log said "Install it in the application" — they had, in the member. The
  message must name the location rule.
- **Test home:** `common/test/unit/optional-dependency-error.test.ts` (both message forms,
  field-by-field; `cause` kept; no `requiredBy` property on the instance); a root tooling test that
  every `new OptionalDependencyUnavailableError(` in `packages/*/src` passes `requiredBy` equal to
  its own package's npm name (a table the test iterates, built from the source scan).

### 3.2 `setu add` records peers in the workspace root as well (V10-50)

- **Decision:** when `setu add <name>` targets a member of a Setu workspace (`setu.workspace.json`
  listing it, found the way `installSearchDirs` finds it) whose runtime profile has
  `manifestKind: 'npm'` (Node, Bun), the peers it records in the member's `package.json` are ALSO
  recorded in the workspace root `package.json` `dependencies`, with the same `CLIENT_RANGES` range,
  through the same `withPeerDependencies` (never replacing an existing entry). Not
  `devDependencies`: an image built with `--omit=dev` would drop them. The output names both files.
  A Deno workspace, a standalone project, and a member whose root `package.json` is absent or not
  JSON are unchanged (member only, as today; the unreadable-root case prints the same JSONC/JSON
  refusal `add.ts` already prints for a member, naming the root file).
- **Why:** a root entry is what makes npm place ONE in-range copy at the root, where the hoisted
  framework package resolves it, whatever another member pins — the repair the builders found by
  hand. Keeping the member entry preserves `setu generate`'s gating and a member built outside the
  workspace.
- **Test home:** `packages/cli/test/unit/commands/add.test.ts` (Node and Bun workspace members: root
  gains the peers in `dependencies`; existing root entry kept; Deno workspace and standalone project
  untouched; unreadable root refused by name); a guarded real-npm e2e (§6) that runs
  `setu add telemetry` in a generated Node workspace member, with a second member pinning
  `@opentelemetry/api@1.10.0`, runs `npm install`, and imports each peer from the hoisted
  `telemetry-plugin`'s directory.

### 3.3 Where optional peers go, written down (V10-58)

- **Decision:** `docs/plugins.md` gains a "Optional peers in a workspace" subsection: the rule
  (install them where the framework package is installed — the root in an npm/Yarn/Bun workspace),
  why (a hoisted package resolves from its own location; a peer nested under a member is invisible
  to it, or a second copy), the ranges (use the package's `peerDependencies`), the symptom (the §3.1
  message, or two copies), and that `setu add` records them at the root (§3.2). `docs/cli.md`
  Workspaces section and the telemetry README link to it; the `common` README states the new
  message.
- **Why:** V10-58 is the absence of exactly this paragraph.
- **Test home:** `pnpm run check:docs` (links, prose assertions); no behavioural test.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. One optional constructor option is added; the error message
text changes (messages are not a contract — `PUBLIC_API.md` documents the class and its `dependency`
field).

| Exported symbol                                | Kind  | Consumer / real code path that READS it                    |
| ---------------------------------------------- | ----- | ---------------------------------------------------------- |
| `OptionalDependencyUnavailableError` (widened) | class | the 49 `src` loaders; apps that `instanceof` it at startup |

### 4.1 Options — every option names its consumer

| Option                                            | Consumer                          | Behavior (per implementation)                       |
| ------------------------------------------------- | --------------------------------- | --------------------------------------------------- |
| `OptionalDependencyUnavailableError` `requiredBy` | the constructor's message builder | named in the message; omitted → the generic wording |

## 5. Implementation files

| File                                                                                                                                                       | Purpose                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/errors/optional-dependency.ts`                                                                                                        | §3.1 option and message                                                                                      |
| the 49 loader sites in 16 packages' `src`                                                                                                                  | pass `requiredBy`                                                                                            |
| `packages/cli/src/commands/add.ts`                                                                                                                         | §3.2 root recording                                                                                          |
| `packages/cli/src/app-loader.ts` (or a sibling helper)                                                                                                     | expose the enclosing Setu workspace root for §3.2, reusing the `installSearchDirs` walk (one implementation) |
| `docs/plugins.md`, `docs/cli.md`, `packages/telemetry-plugin/README.md`, `packages/common/README.md`, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md` | §3.3 and the doc deliverables                                                                                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                     | src covered                    | Key assertions                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/optional-dependency-error.test.ts` | `optional-dependency.ts`       | §3.1 both forms, exact text                                                                                                                                                                                                                                                                                            |
| root `test/optional-peer-required-by.test.ts` (new, tooling)  | every loader site              | each site passes its own package name (table from the scan)                                                                                                                                                                                                                                                            |
| each touched package's existing loader test                   | the loader sites               | unchanged behaviour; any test asserting the old message text updated to the new one                                                                                                                                                                                                                                    |
| `packages/cli/test/unit/commands/add.test.ts`                 | `add.ts`, the workspace helper | §3.2 matrix                                                                                                                                                                                                                                                                                                            |
| `packages/cli/test/e2e/add-workspace-peers-e2e.test.ts` (new) | the real npm placement         | §3.2 real path, installed through the scaffold e2e's existing registry overlay (`startOverlay` / `npmInstall(project, overlay)` in `scaffold-runs-e2e.test.ts`, which serves this tree's own packs — never the published versions): peers importable from the hoisted plugin's directory, one copy of each at the root |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m119f-optional-peers-workspace
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run ci:local            # final commit; fix rounds use --shard
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.10.0
```

`setu add` changes what the CLI writes into a project, so
`packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (in the cli shard) must pass, and the new e2e must
RUN, not skip.

## 8. Risks & mitigations

- **A root `dependencies` entry the user did not expect** → printed by name in `setu add`'s output
  and explained in `docs/cli.md`; never replaces an existing root entry.
- **49 mechanical edits drift from the package name** → the tooling test fails on any mismatch.
- **Old message text asserted in tests elsewhere** → updated in the same change; the grep for the
  old sentence must come back empty outside `CHANGELOG.md`.
- **A Docker image built from a member only** → the root manifest is what the generated Dockerfile
  copies first, so the root entry reaches the image; the e2e checks resolution, the docs say so.

## 9. Out of scope

- Resolving peers from the application, or injecting modules — declined, 2026-10-25.
- Widening the peer ranges to the new upstream majors (OpenTelemetry 0.300 / 3.0, ioredis 6) — a
  compatibility milestone of its own.
- Deno workspaces and pnpm — not reproduced; unchanged.
