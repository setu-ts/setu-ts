# Milestone 101f — the devtool lifecycle (`@setu-ts/cli`, `@setu-ts/common`, every diagnostics source)

> **Status:** Planning. Branch: `feat/m101f-devtool-lifecycle`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The M98c devtool works on the project it was scaffolded with and fails at every later stage of that
project's life: enabling it on a member scaffolded before the devtool existed (V8-18, V8-19),
reallocating ports (V8-20), building the production image (V8-21), running it on a non-Deno project
(V8-34), and trusting the aliases its sources display (V8-22). Plus the one port decision M101g
references and this letter owns: the standalone connector port, fixed at `4919` (the port half of
V8-32). Every row is new `0.8.0` surface or reproduces on `0.7.0`; none is a regression.

**Dependencies (decided in the ROADMAP sequence).** This letter lands AFTER **M101e** and reuses,
without redefining, three of its helpers: `readJsonManifest` (`utils/manifest-reader.ts`, so
`devtool enable` reads a commented `deno.json` and a `deno.jsonc`), `reconcileMembers`
(`workspace/reconcile.ts`, so `ports --reallocate` refuses a manifest naming a deleted member before
it rewrites anything), and the `WriteOutcome` reporting from `writeFiles` (so a rewritten
`main.dev.ts` prints as `updated`, never `created`). M101e's `interrupt` signal reaches `devtool`
and `workspace` through the threading M101e already does. **M101g** sits on this letter: its
diagnostics-option deliverable extends the `devtool enable` merge rules written here, and it only
REFERENCES port handling — every port rule, including `4919`, is decided below.

- **In scope:** `devtool enable` verifying that the devtool composition is USED, not merely
  declared, and printing the complete edit; the generated `main.dev.ts` failing loudly when the
  composition is dropped; refusing a member whose framework pins disagree with the CLI's version; a
  devtool port range separate from the application sequence; `ports --reallocate` moving the port
  literal in `main.dev.ts`; the production image carrying neither `main.dev.ts` nor the connector's
  cached source; one alias predicate in `common` that rejects Unicode format characters, adopted by
  every source; `devtool enable` naming the runtime on Node, Bun and Workers; the standalone default
  port chosen by probe.
- **NOT this milestone:** generating any plugin's `diagnostics` option (M101g's no-row deliverable);
  `setu add` wiring (M101g, V8-31/V8-32); a `--base-port` on `ports --reallocate` (generator gap 4's
  second half — not a finding, deferred with a name in §9); re-pinning the devtool extension's
  recipe catalog (a change in the `setu-ts-devtool` repository, §8).

## 1. Contracts verified from SOURCE (not names)

| Reference                                      | Source (file:line)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Verified surface / fact                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacyFactoryRefusal`                         | `packages/cli/src/devtool/planner.ts:106,119-156`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | proceeds as soon as `DEVTOOL_PARAMETER_MARK` (`devtool?: { plugins?: readonly IPlugin[];`) is present; checks the SIGNATURE only, never that `devtool.plugins`/`devtool.diagnostics` reach `createApplication`; `EXPECTED_SIGNATURE` (`:127-130`) is the whole printed remedy — the V8-18 mechanism                                                  |
| The usage fragments a generated config carries | `packages/cli/src/templates/project-files.ts:423,446-452`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `'      ...(devtool?.plugins ?? []),'` in the plugin list and `...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),` in the `createApplication` options — both exact strings this package writes, so both are detectable textually                                                                                   |
| `renderDevEntry`                               | `packages/cli/src/devtool/dev-entry.ts:62-127`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `const app = await createApp(undefined, { plugins: [diagnostics], diagnostics: {} })` then `app.start(...)`; nothing checks afterwards that the plugin was registered; the port is a literal `port: ${input.devtoolPort},` at `:114`                                                                                                                 |
| `IApplication.diagnostics`                     | `packages/common/src/plugin.ts:471-488`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | present ONLY when the application was created with diagnostics enabled; `undefined` otherwise — readable on the `IApplication` the generated factory returns, with no cast                                                                                                                                                                           |
| `IApplication` members                         | `packages/common/src/plugin.ts:434-470`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `router`, `middleware`, `services`, `register`, `start`, `stop`, `fetch`; NO `hasPlugin` (that is `IKernelApplication`, `packages/kernel/src/application/application.ts:191`)                                                                                                                                                                        |
| `DiagnosticsPlugin` identity                   | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts:209-211`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `name: 'diagnostics-plugin'`, `dependencies: [CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER]`, and it PROVIDES no capability — so `services.has(...)` cannot detect it from the entry                                                                                                                                                                      |
| `devtool enable` member branch                 | `packages/cli/src/commands/devtool.ts:342-350,372-446,506-574`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | runtime refused from `manifest.runtime` (workspace); config read, starter then legacy refusal; `openDenoJson` uses bare `JSON.parse` (`:131`); `mergeImport` pins ONLY `@setu-ts/diagnostics-plugin` at `^VERSION` (`:204-220`) and never reads the member's other `@setu-ts/*` pins — the V8-19 mechanism; the port comes from `resolveDevtoolPort` |
| `devtool enable` standalone branch             | `packages/cli/src/commands/devtool.ts:587-714`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | refuses "No deno.json in … — this is not a Setu-TS project" (`:609`) BEFORE any runtime detection — a Node or Bun project (which has no `deno.json`) hits this message; a Workers project (which has one) reaches `deriveDevTask` and is refused on its `deno serve` start task (`:645-652`) — the two V8-34 messages                                |
| `resolveDevtoolPort`                           | `packages/cli/src/commands/devtool.ts:728-765`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | an unrequested port is `allocatePort(manifest)` — the APPLICATION sequence (V8-19's second half); the standalone branch takes `requestedPort ?? DEFAULT_DEVTOOL_PORT` (`:663`)                                                                                                                                                                       |
| `DEFAULT_DEVTOOL_PORT` and `--devtool-port`    | `packages/cli/src/devtool/planner.ts:34`; `new.ts:509-515`; `app.ts:476-483`; `devtool.ts:244`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `4919`, overridable by `--devtool-port` on `new`, `generate app` AND `devtool enable` — the flag EXISTS (see §2 C3)                                                                                                                                                                                                                                  |
| `allocatePort`                                 | `packages/cli/src/workspace/manifest.ts:471-485`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `max(basePort − 1, every port, every devtoolPort) + 1` — one shared sequence for both kinds                                                                                                                                                                                                                                                          |
| `WorkspaceMember.devtoolPort`, manifest reader | `packages/cli/src/workspace/manifest.ts:122-144,283-300,319`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | optional number; a DEFINED non-number invalidates the manifest; the comment at `:283-288` already names V8-20's exact failure as the reason for that strictness                                                                                                                                                                                      |
| `reallocate` / `managedFiles`                  | `packages/cli/src/commands/workspace.ts:42-78`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | devtool port reassigned as `candidate + 1` in the same walk; `managedFiles` lists discovery modules, the manifest, container and k8s files — and no `main.dev.ts`                                                                                                                                                                                    |
| Generated Dockerfile and `.dockerignore`       | `packages/cli/src/workspace/compose.ts:124-135,163,180,200-215,431-432`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `COPY apps/${MEMBER} ./apps/${MEMBER}` (whole member, `main.dev.ts` included); `RUN deno cache main.ts && deno install && deno install --frozen …` (every import-map entry, so the connector's source is cached); both files are `managed: true`, so a regeneration reaches existing workspaces                                                      |
| `deno install --entrypoint`                    | `deno install --help` (Deno 2.9.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `-e, --entrypoint  Install dependents of the specified entrypoint(s)` — caches one graph, not the whole import map                                                                                                                                                                                                                                   |
| The alias predicate, 13 copies                 | `common/src/diagnostics/realtime-observations.ts:184`; `kernel/src/diagnostics/projection.ts:71`; `diagnostics-plugin/src/protocol/protocol.ts:1344`; `cache-plugin …/cache-observations.ts:86`; `config-plugin …/provenance.ts:71`; `health-plugin …/health-observation-collector.ts:88`; `queue-plugin …/queue-observation-collector.ts:127`; `events-plugin …/event-observations.ts:75`; `scheduler-plugin …/scheduler-observations.ts:79`; `storage-plugin …/storage-observations.ts:79`; `telemetry-plugin …/span-observation-collector.ts:118`; `auth-plugin …/authorization-observation-collector.ts:70`; `sdk/src/diagnostics/outbound-http-observations.ts:70-74` | every copy is the same loop: `code <= 0x1f \|\| (code >= 0x7f && code <= 0x9f)` — C0/C1 only. **There is no shared validator in `common` today** (see §2 C1)                                                                                                                                                                                         |
| The sdk's reason for a local copy              | `packages/sdk/src/diagnostics/outbound-http-observations.ts:9-13,25`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | "importing them would give the SDK its first runtime import of `common` and end its type-only, browser-portable property. A shared alias test table keeps the two copies in agreement" — the table is `packages/sdk/test/unit/outbound-http-observations.test.ts:315-327`, a 10-row literal with no Cf case                                          |
| Alias byte bound                               | `cache-observations.ts:124-130` (and each sibling)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 1–64 UTF-8 bytes checked BEFORE the character scan; the bound stays per source, the character rule moves                                                                                                                                                                                                                                             |
| Launcher: how the port is read                 | `setu-ts-devtool/src/discovery/discover.ts:66-93`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | a workspace member's connector port is `members[].devtoolPort` from `setu.workspace.json`; a standalone project has no manifest and the extension asks for the port (`src/editor/connection.ts:55-56`, default `4919`)                                                                                                                               |
| Launcher: how `main.dev.ts` is accepted        | `setu-ts-devtool/src/launch/preflight.ts:75-83`; `src/launch/recipes.ts:2-12`; `scripts/prepare-framework.mjs:60-100`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `entryMatches` requires the file to equal a CLI rendering (`renderDevEntry` at the pinned commit, `deno fmt`'d variant allowed) with `port: 49191,` replaced by the manifest's port — so `main.dev.ts` MUST keep the literal `port: <n>,`, and any change to `renderDevEntry`'s text changes the catalog                                             |
| `KernelDiagnosticsOptions`, `IPlugin` exports  | `packages/kernel/src/index.ts:17`; `packages/common/src/index.ts` (`IPlugin`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | both importable by the generated entry; the entry already imports `@setu-ts/common` and `@setu-ts/kernel` is pinned by every scaffold (`project-files.ts:837`)                                                                                                                                                                                       |
| `detectTargetRuntime`                          | `packages/cli/src/utils/runtime-detector.ts:57-95`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `wrangler.toml` → workers; `package.json` start → bun/node; else deno — usable BEFORE the `deno.json` read in the standalone branch                                                                                                                                                                                                                  |
| `check:deploy --generated`                     | `scripts/check-deploy.ts` (M99b §3.2); `test/deploy-gate.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | scaffolds a workspace, `deno install`s, builds the generated Dockerfile, serves `/health` under `--read-only --network none` — the gate §3.5 extends with a devtool member                                                                                                                                                                           |
| M101e helpers this letter consumes             | `plans/milestone-101e-cli-write-safety.md` §3.5, §3.6, §3.7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `readJsonManifest`, `reconcileMembers`, `WriteOutcome`                                                                                                                                                                                                                                                                                               |

**Measured by the smoke run.** X62: applying `EXPECTED_SIGNATURE` alone is accepted by the re-run,
the app serves, and no connector binds (`up:false`, no message). The same member kept `kernel`,
`common`, `runtime` at `^0.7.0` beside a new `diagnostics-plugin@^0.8.0`, so `deno task check`
failed on `KernelDiagnosticsOptions` and `dev` died on an unprovided `local-diagnostics-listener`;
its devtool port was `5870`, the next number in the application sequence. X61/X63: after
`ports --reallocate` the manifest held `5861/5863/5865` while every `main.dev.ts` still bound
`5851/5853/5855`. X62: the built image ran `deno run --frozen -A main.dev.ts` and bound
`127.0.0.1:4963` inside the container. X61: an alias carrying U+202E was accepted by all eleven
option families and served in `/v1/cache` with a valid MAC.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                           | Doc deliverable (same PR)                                                                                                                                          |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | ROADMAP M101f says "Reject Cf in the **shared alias validator in `common`**" — no shared validator exists; there are thirteen private copies (§1)                                                           | The ROADMAP's intended end state is right and its premise is wrong: this letter CREATES the shared predicate and deletes twelve copies (§3.6)      | ROADMAP M101f V8-22 paragraph corrected to "create the shared predicate"; its package list gains `kernel`, `diagnostics-plugin` and `sdk`                          |
| C2 | ROADMAP M101f package list reads "`cli`, `common`, every diagnostics source"                                                                                                                                | Incomplete: the kernel projection, the connector protocol and the sdk each carry a copy of the predicate                                           | Same ROADMAP edit as C1                                                                                                                                            |
| C3 | ROADMAP V8-32 (M101g) and `smoke/X60-X65-FINDINGS.md` gap 8 say the standalone port is "fixed at 4919 **with no flag**"                                                                                     | `--devtool-port` exists on all three entry points (§1). What is true is that the DEFAULT never changes; §3.8 fixes the default, and the flag stays | ROADMAP V8-32 wording corrected to "defaults to 4919 regardless of availability"; `packages/cli/README.md` "Devtool development" names the flag beside the default |
| C4 | `packages/cli/README.md:166-203` "Devtool development" and `PUBLIC_API.md` `setu devtool enable` describe the stale-factory remedy as the signature alone                                                   | The remedy is the signature AND the two usage lines (§3.1)                                                                                         | Both sites show the complete edit                                                                                                                                  |
| C5 | `docs/deployment.md:376-406` describes the generated image's `deno cache main.ts && deno install && deno install --frozen` step and says nothing about the development entry                                | §3.5 changes the step; the doc follows the code                                                                                                    | `docs/deployment.md` gains the `--entrypoint main.ts` reasoning and the `.dockerignore` exclusion                                                                  |
| C6 | `renderDevEntry`'s module doc (`dev-entry.ts:3-7`) claims exclusion from production "is a property of the build" — true of the import graph, false of the image, which copied the file and cached its graph | The doc's claim becomes true through §3.5                                                                                                          | The module doc names the two image rules that make it true                                                                                                         |

## 3. Design decisions

### 3.1 `devtool enable` verifies USE of the composition and prints the complete edit (V8-18)

- **Decision:** `legacyFactoryRefusal` is replaced by `factoryRefusal(source)` with three outcomes,
  evaluated in order: (a) a known pre-devtool signature → refuse with the COMPLETE edit (the
  signature, the `...(devtool?.plugins ?? []),` line inside `plugins: [ … ]`, and the
  `...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),` line inside
  the `createApplication({ … })` object, each located by name); (b) the devtool parameter mark
  present but at least one of the two usage fragments ABSENT → refuse naming the missing fragment(s)
  and where they go — this is the X62 case; (c) mark and both fragments present → proceed. A
  hand-written factory with no mark and no legacy signature still proceeds (the existing
  cannot-classify rule), because the entry's own check (§3.2) now covers it.
- **Why:** the refusal told the developer to change the signature and nothing else, and then
  accepted that edit, producing precisely the silent no-connector boot it describes. Checking for
  the two fragments the CLI itself emits (`project-files.ts:423,446-452`) is a textual check on
  known strings, the same conservative mechanism the mark already uses, so it cannot refuse a config
  wrongly unless the developer rewrote the fragments — in which case (c) still proceeds and §3.2
  reports at run time.
- **Test home:** `packages/cli/test/unit/devtool-planner.test.ts` (signature-only config → refusal
  names BOTH fragments; config missing only the diagnostics spread → names that one; complete config
  → `undefined`), `packages/cli/test/e2e/devtool-e2e.test.ts` (the existing "refusing first" case
  now applies the signature alone, is refused AGAIN naming the fragments, applies them, and then
  BOOTS with the connector answering a signed status). **Negative control:** restore the mark-only
  check — the signature-only config is accepted and the e2e's booted connector probe reports no
  listener.

### 3.2 `main.dev.ts` fails loudly when the composition is dropped

- **Decision:** `renderDevEntry` emits a one-line marker plugin alongside the diagnostics plugin —
  `let devtoolRegistered = false; const devtoolProbe: IPlugin = { name: 'setu-devtool-probe',
  version: '0.0.0', register() { devtoolRegistered = true; } };`
  — passes `plugins: [diagnostics, devtoolProbe]`, and after `await app.start(...)` checks
  `if (!devtoolRegistered || app.diagnostics === undefined)`: prints
  `setu devtool: setu.config.ts did not pass the devtool composition to createApplication — the
  connector is not running. Re-run \`setu
  devtool enable\`, which names the two lines to
  add.`,
  awaits`app.stop()`and exits`1`. Both checks use`IApplication`members only — no cast and
  no dependency on M101g's`IKernelApplication`
  return type.
- **Why:** `DiagnosticsPlugin` provides no capability and `IApplication` has no `hasPlugin`, so "was
  the plugin registered" is only observable by a plugin that records its own registration; "was the
  kernel option honoured" is observable through `app.diagnostics`, which `common` documents as
  absent when the option was not passed. Checking after `start()` is necessary because registration
  runs there. This covers the hand-edited factory that §3.1 cannot classify. **This changes
  `renderDevEntry`'s text, which is the launcher's recipe catalog (§1)** — see §8 for the cross-repo
  consequence; it is accepted because the alternative is a connector that silently never binds.
- **Test home:** `packages/cli/test/unit/dev-entry.test.ts` (the rendered entry contains the probe
  and both checks; the port literal is unchanged in form),
  `packages/cli/test/e2e/devtool-e2e.test.ts` (a config whose spread was deleted by hand: the entry
  exits `1` with the message and the app port is closed afterwards). **Negative control:** remove
  the post-start check — the e2e case serves `/health` with no connector and the process stays up.

### 3.3 `devtool enable` refuses a member whose framework pins disagree (V8-19)

- **Decision:** before merging, `devtool enable` reads every `@setu-ts/*` entry in the target
  manifest(s) (through `readJsonManifest`) and refuses (`EXIT_ERROR`) when any pin's range is not
  `^${VERSION}`, listing each offending key with its current value and the expected one, followed by
  the sentence "The devtool entry imports types that exist only at `${VERSION}`; upgrade the project
  first (see docs/upgrading.md), then run this again." Nothing is written.
- **Why:** the ROADMAP offers "bump the set together or refuse". Bumping was rejected: a
  cross-version bump is a migration (`0.7.0 → 0.8.0` carried breaking changes), and a command named
  `devtool enable` rewriting every framework pin of a project would do the one thing the M98c merge
  rules forbid — replacing a value the developer owns without being asked. The refusal names every
  line to change; `docs/upgrading.md` owns what else that version step needs.
- **Test home:** `packages/cli/test/unit/devtool-refusals.test.ts` (a member at `^0.7.0` is refused
  with the three keys named and zero writes; a member at `^${VERSION}` proceeds; `--dry-run` reports
  the same refusal). **Negative control:** remove the pin check — the `0.7.0` fixture reports
  success and its planned manifest carries a lone `^${VERSION}` beside `^0.7.0`.

### 3.4 Devtool ports come from their own range (V8-19, second half)

- **Decision:** `WorkspaceManifest` gains an optional `devtoolBasePort?: number`, recorded the first
  time a devtool port is allocated (default `basePort + 1000`, clamped to `MAX_PORT`;
  `--devtool-port` on `generate app --devtool` or `devtool enable` with no record yet sets it to
  that value), and a new `allocateDevtoolPort(manifest)` returns
  `max(devtoolBasePort − 1, every devtoolPort) + 1`, then keeps advancing past any candidate that is
  an existing member's application `port` or fails the bindability probe (`allocatePort`'s probe),
  and never past `MAX_PORT`: a candidate above it ends the search, and `allocateDevtoolPort` returns
  `undefined` — the `allocatePort` contract at `manifest.ts:463-470`, which the caller already turns
  into a refusal naming the exhausted range — rather than a port `main.dev.ts` would fail to bind. A
  stopped application is invisible to the probe, so the configured-port skip is what keeps a
  connector off an application port the range overlaps — a `basePort + 1000` default does not stop a
  workspace with hand-edited ports, or one past a thousand members, from overlapping. `allocatePort`
  keeps walking BOTH kinds (so an application port can never land on a connector port), `reallocate`
  assigns devtool ports from the devtool range, and `readWorkspaceManifest` accepts an absent key
  (derived) and refuses a defined non-number, the `devtoolPort` precedent at `manifest.ts:283-294`.
  The launcher reads only `members[].devtoolPort` (§1), so it is unaffected.
- **Why:** allocating connector ports in the application sequence makes a devtool member consume two
  consecutive application numbers, which is what collided with the smoke's reserved range and what
  makes "this member's port is `5870`" ambiguous between an app and a connector. A fixed offset from
  `basePort` was rejected in M98c for the member's OWN port ("nothing constrains `basePort`
  spacing", `manifest.ts:141-142`); a recorded range with a default is the version of that idea that
  survives a hand-edited `basePort`, because it is stored rather than derived on every read.
- **Test home:** `packages/cli/test/unit/workspace-manifest.test.ts` (absent key → derived default;
  defined non-number → malformed), `packages/cli/test/unit/allocate-port.test.ts`
  (`allocateDevtoolPort` starts at the range base and skips occupied ports, and skips a member's
  application `port` that sits at the range base even when nothing is bound to it; a
  `devtoolBasePort` of `MAX_PORT` whose port the probe reports unavailable returns `undefined`, and
  the probe is never asked for `MAX_PORT + 1`; `allocatePort` still skips connector ports),
  `packages/cli/test/unit/reallocate.test.ts` (devtool ports land in the devtool range),
  `packages/cli/test/unit/devtool-manifest-merge.test.ts` (first allocation records
  `devtoolBasePort`). **Negative control:** route `resolveDevtoolPort` back through `allocatePort` —
  with `basePort: 5869`, `devtoolBasePort: 6000` and one member at `port: 5869`, the allocation case
  asserts `6000`, and the rerouted call returns `5870` and fails.

### 3.5 The production image carries no connector (V8-21)

- **Decision:** two changes to the managed files, both regenerated for an existing workspace by the
  next `generate app`, `ports --reallocate` or `devtool enable`: the generated `.dockerignore` gains
  `apps/*/main.dev.ts`, and the Deno Dockerfile's cache step becomes
  `RUN deno cache main.ts && deno install --entrypoint main.ts && deno install --entrypoint main.ts --frozen && chown …`
  — so the image's module cache holds the production entry's graph and nothing the import map alone
  names. `devtool enable` in a workspace plans the regenerated `.dockerignore` and `Dockerfile`
  beside its manifest edits (they are `managed: true` already, `compose.ts:431-432`).
- **Why:** the M99b/M95a guarantee is "no external network at runtime, no lockfile write"; the
  frozen verify at `compose.ts:138-163` exists because a partially recorded jsr edge list fails
  `--frozen` at startup. Restricting both `deno install` invocations to the same entrypoint keeps
  that pairing intact for the graph that runs, while the diagnostics plugin — reachable only from
  `main.dev.ts` — is never fetched. Excluding the file as well means an overridden command cannot
  find anything to run. Measured, not assumed: the extended `check:deploy --generated` (§6) builds a
  workspace with a devtool member and greps the image's `DENO_DIR` for `diagnostics-plugin`,
  expecting no match, and confirms `/health` still answers under `--read-only --network none`.
- **Test home:** `packages/cli/test/unit/dockerfile.test.ts` and
  `packages/cli/test/unit/workspace/compose.test.ts` (emitted text), `test/deploy-gate.test.ts` (the
  `--generated` sequence now scaffolds a devtool member and runs the cache grep),
  `deno task check:deploy --generated` (real Docker). **Negative control:** revert the two lines —
  the image grep finds the connector's cached source and `deno run main.dev.ts` inside the container
  binds a port.

### 3.6 One alias predicate in `common`, rejecting Cc and Cf (V8-22)

- **Decision:** `packages/common/src/diagnostics/alias.ts` exports
  `hasForbiddenAliasCharacter(value: string): boolean` — `true` for any code point in general
  category Cc (U+0000–U+001F, U+007F–U+009F) or Cf (`/\p{Cf}/u`), scanned by code point. The twelve
  in-repo copies (common's realtime validator, the kernel projection, the connector protocol, and
  the nine plugin collectors) are DELETED and delegate to it; each source keeps its own byte bound
  and its own fixed error message, and the connector's wire-side validator (`protocol.ts:1344`)
  delegates too, so a replacement source that smuggles a format character into a body is refused at
  the connector as well as at construction. The sdk keeps its local copy by its stated rule
  (type-only `common` imports, §1) and gains the identical Cf clause; its agreement test gains the
  Cf rows. A root-level conformance test, `test/unit/alias-predicate-conformance.test.ts`, iterates
  one table — plain ASCII, `é` runs, each C0/C1 boundary, U+200B, U+200E, U+202A–U+202E,
  U+2066–U+2069, U+FEFF, U+00AD — over every package's compile function and the sdk's, so a
  fourteenth copy cannot drift.
- **Why:** the finding is display spoofing in a devtool UI (Trojan-Source reordering of an alias the
  developer wrote), and the fix is one character class. Deleting the copies rather than editing
  thirteen loops is §11.1; it is possible for every package but the sdk because each already imports
  `common` at runtime. `\p{Cf}` is used rather than a hand-written range because the category is
  long and revised; the engine's table is the authority.
- **Test home:** `packages/common/test/unit/alias.test.ts`, the conformance test above, and each
  package's existing alias test gaining one Cf row. **Negative control:** drop the `\p{Cf}` clause —
  the conformance table's U+202E row passes in every package, which is the X61 observation.

### 3.7 `ports --reallocate` moves the port literal in `main.dev.ts` (V8-20)

- **Decision:** for every member carrying a `devtoolPort`, `reallocate` reads
  `apps/<member>/main.dev.ts` and compares it to the CLI rendering at the member's CURRENT port
  (`renderDevEntry({ devtoolPort: old, port: { symbol: SERVICE_PORT, from: './src/discovery/services.ts' } })`,
  with its `deno fmt`'d variant also accepted — the same two forms the launcher accepts).
  Byte-identical → the file joins `managedFiles` for this run at the NEW port and prints `updated`.
  Different → the whole reallocation is REFUSED before any write, naming the file and the launcher
  rule: "the devtool launcher accepts only the CLI's rendering of this file, so an edited entry
  cannot be launched; restore it (delete it and run `setu devtool enable <member>`) or move the port
  literal yourself." `reconcileMembers` (M101e) runs first, so a deleted member is refused by name
  rather than having a `main.dev.ts` planned for a directory that no longer exists.
- **Why:** the ROADMAP's second option — reading the port from the discovery module — changes
  `main.dev.ts`'s text AND makes it depend on a workspace file a standalone project lacks; the
  launcher byte-matches the entry against the CLI rendering with the LITERAL substituted
  (`recipes.ts:9`), so the literal must stay. Rewriting a file the developer owns is justified only
  when it is provably still the CLI's output; the launcher already imposes exactly that condition,
  which is why refusing an edited entry costs the developer nothing they had. The third option
  (refuse to reallocate a devtool member) would make the command useless for the workspaces that
  most need it.
- **Test home:** `packages/cli/test/unit/reallocate.test.ts` (an untouched entry is rewritten with
  the new literal and nothing else changes; an edited entry refuses the whole run with zero writes),
  `packages/cli/test/e2e/workspace-e2e.test.ts` (REAL filesystem: a devtool member is reallocated,
  then its `deno task dev` is BOOTED with session credentials and a signed status request reaches
  the NEW port — the observation the smoke could not make). **Negative control:** leave
  `main.dev.ts` out of `managedFiles` — the booted entry binds the old port and the status request
  to the new one is refused.

### 3.8 `devtool enable` names the runtime (V8-34), and the standalone default port is probed (V8-32)

- **Decision:** both standalone paths (`new --devtool` already does this; `devtool enable` does not)
  call `detectTargetRuntime` FIRST and refuse with `devtoolRuntimeRefusal(runtime)` — "The devtool
  requires the Deno runtime … a node project could never start the connector" — before any manifest
  or start-task check, so a Node/Bun project is never told it "is not a Setu-TS project" and a
  Workers project is never told to change its entry. For the port: when no `--devtool-port` is given
  and a `portAvailable` probe is present, the standalone default is the first bindable port from
  `4919` upward (bounded at `4919 + 100`, then refused by name); the chosen port is printed in the
  existing "the connector listens on 127.0.0.1:<port>" line and written into the generated README's
  devtool paragraph, because the extension asks the user for it (`connection.ts:55`).
  `DEFAULT_DEVTOOL_PORT` stays `4919` as the range START.
- **Why:** V8-34 is misdirection — the message names the wrong cause on three runtimes while the
  correct sentence already exists in the planner. For the port, a standalone project has no
  allocation space and the launcher cannot discover its port, so the honest improvement is to avoid
  a port that is bound RIGHT NOW and to tell the developer which one was chosen; a collision between
  two projects that are not running at scaffold time remains a bind-time failure with the listener's
  own named refusal, as the planner's comment says. A persistent per-project record was rejected: it
  would be a second manifest for one number.
- **Test home:** `packages/cli/test/unit/devtool-refusals.test.ts` (Node, Bun and Workers fixtures
  are refused by the runtime sentence, in that order of checks),
  `packages/cli/test/unit/devtool-planner.test.ts` and `new-command.test.ts` (a probe reporting
  `4919` busy yields `4920`, printed and in the README; no probe → `4919`). **Negative control:**
  move the runtime check back below the `deno.json` read — the Node fixture reports "not a Setu-TS
  project".

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — `common` gains one function and no contract member changes.

`packages/cli/src/index.ts` is unchanged (pinned by `barrel-exports.test.ts`). `common` gains one
export; no capability token and no contract member changes.

| Exported symbol                       | Kind                       | Consumer / real code path that READS it                                                               |
| ------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `hasForbiddenAliasCharacter` (common) | function                   | twelve in-repo alias validators (§3.6) at construction time; the connector protocol's wire validation |
| `WorkspaceManifest.devtoolBasePort`   | field (cli, internal type) | `allocateDevtoolPort`, `reallocate`, `renderWorkspaceManifest`, `readWorkspaceManifest`               |

Internal to `packages/cli/src`: `factoryRefusal` (replacing `legacyFactoryRefusal`),
`allocateDevtoolPort`, `devEntryVariants(port)` (the two accepted renderings, read by `reallocate`).

### 4.1 Options — every option names its consumer

| Option                       | Consumer                                | Behavior (per implementation)                                                                  |
| ---------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `--devtool-port` (existing)  | `new`, `generate app`, `devtool enable` | unchanged semantics; in a workspace with no `devtoolBasePort` yet, also records the range base |
| `devtoolBasePort` (manifest) | `allocateDevtoolPort`, `reallocate`     | absent → `basePort + 1000`; present → the range start                                          |

No new CLI flag.

## 5. Implementation files

| File                                                                                                             | Purpose                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/diagnostics/alias.ts`, `src/index.ts`                                                       | §3.6 predicate and its export                                                                                                                  |
| `packages/common/src/diagnostics/realtime-observations.ts`                                                       | delegate; delete the local loop                                                                                                                |
| `packages/kernel/src/diagnostics/projection.ts`                                                                  | delegate                                                                                                                                       |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`                                                           | delegate (wire side)                                                                                                                           |
| nine plugin collectors (cache, config, health, queue, events, scheduler, storage, telemetry, auth — paths in §1) | delegate                                                                                                                                       |
| `packages/sdk/src/diagnostics/outbound-http-observations.ts`                                                     | local copy gains the Cf clause (documented exception)                                                                                          |
| `packages/cli/src/devtool/planner.ts`                                                                            | §3.1 `factoryRefusal` with the complete edit; §3.8 range start                                                                                 |
| `packages/cli/src/devtool/dev-entry.ts`                                                                          | §3.2 probe plugin and post-start check; C6 module doc                                                                                          |
| `packages/cli/src/commands/devtool.ts`                                                                           | §3.1, §3.3 pin check, §3.4 port range, §3.5 managed-file regeneration, §3.8 runtime-first and probed default; reads through `readJsonManifest` |
| `packages/cli/src/commands/workspace.ts`                                                                         | §3.7 `main.dev.ts` in `managedFiles` with the refusal; `reconcileMembers`; §3.4 range                                                          |
| `packages/cli/src/workspace/manifest.ts`                                                                         | §3.4 `devtoolBasePort`, `allocateDevtoolPort`                                                                                                  |
| `packages/cli/src/workspace/compose.ts`                                                                          | §3.5 `.dockerignore` line and `--entrypoint main.ts`                                                                                           |
| `packages/cli/src/commands/app.ts`, `new.ts`                                                                     | §3.4 allocation through `allocateDevtoolPort`; §3.8 probed standalone default and README paragraph                                             |
| `packages/cli/src/templates/project-files.ts`                                                                    | README devtool paragraph names the chosen port                                                                                                 |
| `scripts/check-deploy.ts`                                                                                        | §3.5 devtool member + cache grep in `--generated`                                                                                              |
| `test/unit/alias-predicate-conformance.test.ts`                                                                  | §3.6 cross-package table                                                                                                                       |
| `ROADMAP.md`, `packages/cli/README.md`, `PUBLIC_API.md`, `docs/deployment.md`                                    | C1–C6                                                                                                                                          |
| `CHANGELOG.md`, `docs/upgrading.md`                                                                              | alias refusal (behaviour change), image step, manifest field, entry text change and the launcher re-pin note                                   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                          | src covered                                                                                                                                                                                                                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/test/unit/alias.test.ts`                                                                          | `common/src/diagnostics/alias.ts`                                                                                                                                                                                                                  | `hasForbiddenAliasCharacter(value)` over the §3.6 table; every C0/C1 boundary; `é` accepted                                                                                                            |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)                                                      | `common/src/index.ts`                                                                                                                                                                                                                              | `hasForbiddenAliasCharacter` is exported, declared against the barrel — a re-export file is fully covered merely by being loaded, so only this assertion fails when the export is dropped (M56)        |
| `test/unit/alias-predicate-conformance.test.ts`                                                                    | all thirteen validators                                                                                                                                                                                                                            | each package's `compile…Alias`/`assertAliasShape` and the sdk's `compileOutboundAlias(alias)` agree with the table row by row                                                                          |
| existing per-package alias tests (common realtime, kernel projection, protocol, nine plugins, sdk agreement table) | each delegating file: `common/src/diagnostics/realtime-observations.ts`, `kernel/src/diagnostics/projection.ts`, `diagnostics-plugin/src/protocol/protocol.ts`, `sdk/src/diagnostics/outbound-http-observations.ts`, and the nine collectors in §1 | one Cf row added to each; the sdk agreement table gains U+202E and U+200B                                                                                                                              |
| `packages/cli/test/unit/devtool-planner.test.ts`                                                                   | `devtool/planner.ts`                                                                                                                                                                                                                               | `factoryRefusal(source)` three outcomes; the printed edit contains both fragments verbatim                                                                                                             |
| `packages/cli/test/unit/dev-entry.test.ts`                                                                         | `devtool/dev-entry.ts`                                                                                                                                                                                                                             | `renderDevEntry({ devtoolPort, port? })` contains the probe, both checks and `port: <n>,`                                                                                                              |
| `packages/cli/test/unit/devtool-refusals.test.ts`, `devtool-manifest-merge.test.ts`                                | `commands/devtool.ts`                                                                                                                                                                                                                              | §3.3 pin refusal lists keys; §3.8 runtime-first on node/bun/workers fixtures; §3.4 first allocation records the range; `.dockerignore`/`Dockerfile` planned in a workspace; JSONC member manifest read |
| `packages/cli/test/unit/workspace-manifest.test.ts`, `allocate-port.test.ts`                                       | `workspace/manifest.ts`                                                                                                                                                                                                                            | `allocateDevtoolPort(manifest)`; reader accepts absent / refuses malformed `devtoolBasePort`; `allocatePort` still skips connector ports                                                               |
| `packages/cli/test/unit/reallocate.test.ts`, `workspace-command.test.ts`                                           | `commands/workspace.ts`                                                                                                                                                                                                                            | untouched entry rewritten at the new literal and reported `updated`; edited entry refuses with zero writes; deleted member refused first                                                               |
| `packages/cli/test/unit/dockerfile.test.ts`, `unit/workspace/compose.test.ts`                                      | `workspace/compose.ts`                                                                                                                                                                                                                             | `--entrypoint main.ts` in both install invocations; `apps/*/main.dev.ts` in `.dockerignore`                                                                                                            |
| `packages/cli/test/unit/new-command.test.ts`, `app-command.test.ts`                                                | `commands/new.ts`, `commands/app.ts`, `templates/project-files.ts`                                                                                                                                                                                 | probed standalone default; README paragraph names it; member allocation lands in the devtool range                                                                                                     |
| `test/deploy-gate.test.ts`                                                                                         | `scripts/check-deploy.ts`                                                                                                                                                                                                                          | the `--generated` sequence scaffolds a devtool member and runs the cache grep (asserted on the command sequence)                                                                                       |
| `packages/cli/test/e2e/devtool-e2e.test.ts`                                                                        | end to end (BOOTED)                                                                                                                                                                                                                                | signature-only remedy refused again; complete edit accepted and the connector answers a signed status; a hand-deleted spread makes the entry exit `1` with the message                                 |
| `packages/cli/test/e2e/workspace-e2e.test.ts`                                                                      | end to end (BOOTED)                                                                                                                                                                                                                                | after `ports --reallocate` the devtool member's `deno task dev` binds the NEW port; `.dockerignore` names `main.dev.ts`                                                                                |
| `deno task check:deploy --generated`                                                                               | real Docker (local + CI where Docker exists, as today)                                                                                                                                                                                             | image `DENO_DIR` has no `diagnostics-plugin`; `/health` 200 under `--read-only --network none`                                                                                                         |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m101f-devtool-lifecycle, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:deploy --generated
deno task publish:check
deno task release:verify 0.8.0
```

Negative controls, each observed failing and reverted: the eight named in §3.1–§3.8. Control §3.5
must be run against the REAL image (the unit test on the Dockerfile text cannot see the cache), and
control §3.7 against the BOOTED entry (a text diff of `main.dev.ts` cannot see which port a process
binds).

## 8. Risks & mitigations

- §3.2 changes `renderDevEntry`'s text, and the devtool extension accepts only the renderings of its
  pinned CLI commit (`prepare-framework.mjs`, `framework-pin.json`) → an extension built before this
  merges answers `PREPARATION_FAILED` for a project scaffolded or re-enabled after it. Mitigation:
  the `setu-ts-devtool` repository bumps `framework-pin.json` to the merge commit in the same
  release window (named in CHANGELOG and in the hand-back, not silently assumed), and the
  extension's catalog keeps the previous commit's renderings as additional variants so older
  projects keep launching. That second half is a change in the other repository and is recorded here
  as a dependency, not performed here.
- `deno install --entrypoint main.ts` could record a lockfile edge set that `--frozen` then disputes
  at build time → the pairing is verified by the real-image gate on every CI run that has Docker,
  the same place M99b proved the previous pairing.
- A `devtoolBasePort` default of `basePort + 1000` can exceed `MAX_PORT` or collide with a port a
  member already binds → clamped and probed; `allocatePort` keeps walking both kinds, so neither
  allocator can hand out the other's number.
- Rejecting Cf refuses an alias that was accepted at `0.8.0` → a behaviour change at construction,
  CHANGELOG'd; such an alias was always a display hazard and never a working identifier.
- §3.7 rewrites a developer-owned file → only when byte-identical to the CLI's own rendering, the
  same condition the launcher imposes; everything else refuses with zero writes.

## 9. Out of scope

- Generating any plugin's `diagnostics` option — M101g's no-row deliverable, which extends the
  `devtool enable` merge rules written here.
- `setu add` wiring and `generate ws-route`/`job` gating — M101g.
- A `--base-port` argument on `ports --reallocate` (generator gap 4's second half, no finding);
  deferred and named here so it is not mistaken for an oversight.
- Bumping a project's framework pins automatically — refused by name (§3.3); the upgrade guide owns
  the migration.
- Re-pinning and re-cataloguing in the `setu-ts-devtool` repository — a dependency of §3.2,
  performed there.
