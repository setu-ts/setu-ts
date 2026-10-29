# Milestone 119i — Documentation That Does Not Match the Code, or Is Missing (docs, agent cards, two doc gates)

> **Status:** Reopened 2026-10-30. §3.1–§3.17 are implemented (commits `166491dc`, `a0df90b1`); §0.1
> and §3.18–§3.27 fold in the held documentation batch and the agent-brief fixes, by the
> maintainer's decision. Branch: `docs/m119i-docs-that-match-the-code` (a **docs** letter of M119,
> so one `docs/…` branch). `develop` and `main` are protected — all work stays on this branch until
> it merges via a single PR.

## 0. Objective & scope

Fifteen register rows where a reader following the documentation ends up wrong (ROADMAP M119i;
`smoke/DEFECTS.md`, findings in `smoke/V0100-REGRESSION.md`, `smoke/X75-X82-FINDINGS.md`,
`smoke/M115-FINDINGS.md`). The code is correct in every row; the documents change. The letter also
closes the two gaps that let these reach a release: package READMEs outside the fence compiler, and
links whose target heading is renamed at release.

- **In scope:**
  - **Upgrade guide:** V10-15 (`swagger-ui-dist` on Deno), V10-16 (`allowJs` in the Workers
    full-stack repair), V10-39 (responder terminals log nothing), V10-46 (`ReactRouterPluginOptions`
    is a union), V10-47 (SDK `_client` / `_encodeURIComponent`), V10-48 (a plugin command named
    `agents`).
  - **Wrong claims:** V10-7 (links to a heading that a release renames), V10-8 (generated probes),
    V10-12 (service-discovery `RetryPolicy` example), V10-38 (module-scoped service token), V10-43
    (agent cards say `setu add` "installs"), V10-56 (React Router 7 vs 8).
  - **Missing:** V10-40 (request logger records the raw path), V10-57 (unrepresentable Zod types are
    silent), the V9-29 remainder (worker-pool thread overshoot).
  - **Found while planning (no register row):** the resilience README says `timeout` does not cancel
    the wrapped work, which the code contradicts (§3.15).
  - **Recurrence gates:** every package README gated by the fence compiler (§3.16); links that name
    a heading a release renames, or point into this repository by absolute URL, are checked (§3.17).
- **NOT this milestone:** any behaviour change. A generation-time warning for unrepresentable Zod
  types (V10-57) would be a code change and is not taken here — the row is the missing
  documentation. The rows close only on a re-run against a published version.

### 0.1 Folded scope (maintainer decision, 2026-10-30)

The documentation batch held until M121–M124 landed, and the agent-brief gaps those milestones left,
are taken here rather than on separate branches. None has a register row. Each is documentation that
does not match the code, except §3.18–§3.20, which change what `setu agents` writes.

- **In scope (folded):** the generated agent brief lists no development command (§3.18) and its
  full-stack and messaging rules predate M120, M121, M123 and #524 (§3.19, §3.20); two agent cards
  miss M124 and M121 (§3.21, §3.22); `docs/react-router-dev.md` names a script Node and Bun projects
  do not have and leads with hand wiring (§3.23); getting-started has no full-stack path and treats
  `npm create` as an aside (§3.24); the website homepage shows no way to create a project (§3.25);
  "Publishing Your Plugin" is JSR-era (§3.26); the examples guide proves but does not teach (§3.27).
- **NOT this milestone:** rendering package READMEs, example code, per-package `PUBLIC_API.md`
  sections, the CHANGELOG and ARCHITECTURE on the website, and `npm create @setu-ts -- --example`.
  These become two new ROADMAP milestones, opened on their own `docs/` branch. A `setu dev` verb is
  not proposed.

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                                                                                                                                                                                                                                                                                            | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V10-7 broken link                    | `packages/openapi-plugin/README.md:218`                                                                                                                                                                                                                                                                                                       | `blob/main/docs/upgrading.md#unreleased`; at `v0.10.0` (= `main`) the guide has no `Unreleased` heading. The content is `### Declared \`@ApiOperation\` ids and descriptions (0.10.0)`, at the tag (line 37) and on develop (`docs/upgrading.md:262`)                                                                                                                                                                                         |
| V10-7 prose                          | `CHANGELOG.md:692`                                                                                                                                                                                                                                                                                                                            | Inside `[0.10.0]`: "See `docs/upgrading.md` Unreleased."                                                                                                                                                                                                                                                                                                                                                                                      |
| CHANGELOG link definitions           | `CHANGELOG.md:9466-9483`                                                                                                                                                                                                                                                                                                                      | `[unreleased]` compares from `v0.8.0`; no `[0.9.0]` / `[0.10.0]` definitions                                                                                                                                                                                                                                                                                                                                                                  |
| existing link checker                | `scripts/check-docs.ts:134-141, 260-310, 878-1127`; skip of absolute URLs at `:914-921`                                                                                                                                                                                                                                                       | `anchorFor` slugs; same-file and relative cross-file anchors are checked; `http(s)` links are skipped, so an absolute link into this repository is never checked                                                                                                                                                                                                                                                                              |
| V10-8 text                           | `docs/deployment.md:562-564`                                                                                                                                                                                                                                                                                                                  | Under "What is deliberately not generated": probes are `tcpSocket`                                                                                                                                                                                                                                                                                                                                                                            |
| k8s probes                           | `packages/cli/src/workspace/k8s.ts:25-30, 89-117, 133-139, 268-269`                                                                                                                                                                                                                                                                           | `healthProbes === true` → `httpGet /ready` and `/live`; else `tcpSocket`. `metricsEndpoint === true` → `prometheus.io/scrape                                                                                                                                                                                                                                                                                                                  | port | path` annotations |
| who sets them                        | `packages/cli/src/commands/app.ts:678,683`; `packages/cli/src/workspace/adopt.ts:71-75,93-98`                                                                                                                                                                                                                                                 | `generate app --template <name>` sets both; `adopt` sets each from the starter or the installed health/metrics plugin                                                                                                                                                                                                                                                                                                                         |
| V10-12 fence                         | `packages/service-discovery-plugin/README.md:118-135` (`:133`)                                                                                                                                                                                                                                                                                | `retry: { maxAttempts: 3 }`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `RetryPolicy`                        | `packages/common/src/services/resilience.ts:90, 116-123, 151, 174`                                                                                                                                                                                                                                                                            | `{ limit: number; delay: number; backoff: 'fixed' \| 'exponential' }`, all required; `WrapOptions.retry?: boolean \| RetryPolicy`; JSDoc example `{ limit: 3, delay: 100, backoff: 'exponential' }`                                                                                                                                                                                                                                           |
| resilience timeout                   | `packages/resilience-plugin/README.md:6, 71-73`; `packages/resilience-plugin/src/patterns/timeout.ts:12-20,58`; `resilience.ts:37,181-186`                                                                                                                                                                                                    | README says the timeout does not cancel the work and wraps `() => Promise<T>`; the code aborts the signal it hands to `fn` (`ResilientCall<T> = (signal: AbortSignal) => Promise<T>`)                                                                                                                                                                                                                                                         |
| V10-15 text                          | `docs/upgrading.md:537-539, 177-178`; `packages/openapi-plugin/README.md:84-86, 94-96`                                                                                                                                                                                                                                                        | Install instructions give only `npm install`                                                                                                                                                                                                                                                                                                                                                                                                  |
| swagger load                         | `packages/openapi-plugin/src/plugin/openapi-plugin.ts:194-210`                                                                                                                                                                                                                                                                                | Bare `await import('swagger-ui-dist/absolute-path.js')`; failure → `OptionalDependencyUnavailableError`                                                                                                                                                                                                                                                                                                                                       |
| V10-15 measurement (this plan)       | scratch Deno 2.9.6 workspace from published `@setu-ts/cli@0.10.0`, member `api` from `--template rest`                                                                                                                                                                                                                                        | Generated member carries `"swagger-ui-dist": "npm:swagger-ui-dist@^5"` and serves `/docs`. Clean `node_modules` with no entry anywhere → startup fails (`Could not find package 'swagger-ui-dist' from referrer …openapi-plugin…`). An `npm:` entry in the member's `deno.json`, or alternatively in the root's, followed by `deno install` at the root → starts. The register's "must be the ROOT `deno.json`" is not what was measured (C3) |
| V10-16 text / code                   | `docs/upgrading.md:674-693`; `packages/cli/src/templates/project-files.ts:1438-1465`                                                                                                                                                                                                                                                          | Repair adds the `../build/server/index.js` import; fresh Workers full-stack scaffolds set `allowJs: true` (TS7016 otherwise)                                                                                                                                                                                                                                                                                                                  |
| V10-38 occurrences / generator       | `docs/cli.md:400-401`; `CHANGELOG.md:1145-1146`; `packages/cli/README.md:231,344`; `PUBLIC_API.md:10137,10811`; `packages/cli/src/seams/services.ts:61-63`; `schematics/service.ts:75-76`; `commands/generate.ts:647`                                                                                                                         | Docs say `<module>-<name>-service`; the generator passes `${module}.${kebab}` → `<module>.<name>-service`                                                                                                                                                                                                                                                                                                                                     |
| V10-39 text                          | `docs/upgrading.md:550-552`                                                                                                                                                                                                                                                                                                                   | "Handled 4xx now logs once at `warn` …"                                                                                                                                                                                                                                                                                                                                                                                                       |
| what logs                            | `packages/exceptions/src/middleware/error-handler.ts:265-287,328-358`; `packages/common/src/errors/error-responder.ts:211-235`; `packages/kernel/src/application/application.ts:1489-1491, 2145-2168`; `packages/auth-plugin/src/guards/index.ts:69-78`; `packages/validation-plugin/src/middleware/validation-middleware.ts:96-104, 264-274` | Only errors THROWN into `errorHandler` log (`warn` < 500, `error` ≥ 500); `respondWithError` terminals (unmatched 404, guard 401/403, validation 400/415, kernel pre-pipeline refusals) write a response and log nothing; the request logger's completion record still appears                                                                                                                                                                |
| V10-40 code                          | `packages/logger-plugin/src/middleware/request-logger.ts:27-33, 61-101`; `packages/logger-plugin/src/plugin/logger-plugin.ts:60, 65-66, 114-115`; `packages/common/src/http.ts:41-42`; `packages/database-plugin/src/errors/scrub.ts`                                                                                                         | Logs `{ method, path }` (concrete path, no query) at receive and on slow requests; `excludePaths` skips all records; `redaction` field redactors or `redact` can rewrite or drop `path`; the M113f scrub covers database errors only                                                                                                                                                                                                          |
| V10-40 docs                          | `packages/logger-plugin/README.md:65-71`; `PUBLIC_API.md:694-702`; `packages/database-plugin/README.md:6-14`                                                                                                                                                                                                                                  | No mention that the path is logged unscrubbed                                                                                                                                                                                                                                                                                                                                                                                                 |
| V10-43 cards                         | `packages/*/AGENT_CARD.md:3` (32 cards); `docs/cli.md:266`; gate `test/agent-card-gate.test.ts:145-149`                                                                                                                                                                                                                                       | 29 say "installs it", audit "installs and registers", graphql "installs the package", testing "installs a dev dependency"; cards are hand-written; 2560-byte cap (events 2557, database 2553 bytes today)                                                                                                                                                                                                                                     |
| `setu add` output                    | `packages/cli/src/commands/add.ts:952-956, 1041-1044, 1340, 1350-1352, 1411-1424`                                                                                                                                                                                                                                                             | Edits `package.json` / `deno.json`, prints the file outcome, then `Next:` and the runtime's install command; never spawns an install                                                                                                                                                                                                                                                                                                          |
| V10-46                               | `packages/react-router-plugin/src/interfaces/index.ts:247-256`; `CHANGELOG.md:1000-1002`                                                                                                                                                                                                                                                      | `export type ReactRouterPluginOptions = ReactRouterPathOptions \| ReactRouterModuleOptions`; CHANGELOG warns implementors; the guide's 0.10.0 section does not                                                                                                                                                                                                                                                                                |
| V10-47                               | `packages/sdk/src/codegen/openapi-codegen.ts:548-559, 812`; `CHANGELOG.md:508-516`; `packages/sdk/README.md:447-451`                                                                                                                                                                                                                          | `SHADOWING_OPERATION_NAMES = {client, encodeURIComponent}` → `_client` / `_encodeURIComponent`, shipped in 0.10.0; absent from the guide                                                                                                                                                                                                                                                                                                      |
| V10-48                               | `packages/cli/src/cli.ts:228-309`; `CHANGELOG.md:703-705`; `packages/common/src/plugin.ts:308-316`; `docs/custom-plugins.md:271`; `docs/programmatic-api.md:475`                                                                                                                                                                              | Built-ins match first; convention `plugin:command`; two guides show an un-namespaced `'my-command'`                                                                                                                                                                                                                                                                                                                                           |
| V10-56                               | `packages/react-router-plugin/README.md:15`; `PUBLIC_API.md:4645`; `ARCHITECTURE.md:1638`; `packages/react-router-plugin/src/index.ts:4`; `packages/react-router-plugin/package.json:42-44`                                                                                                                                                   | Four sites say v7; the peer range is `^8`, the card and other docs say 8                                                                                                                                                                                                                                                                                                                                                                      |
| V10-57                               | `packages/openapi-plugin/src/transformers/zod-to-openapi.ts:436-475`; `generators/openapi-generator.ts:484-489, 774-776`; `services/openapi-service.ts:120-131`; `packages/openapi-plugin/README.md:21-37`; `PUBLIC_API.md:9879-9896`                                                                                                         | Unrepresentable nodes become `{}` plus `x-setu-unrepresentable`; nothing logs; the document is built lazily on first `getSpec()`; `z.iso.datetime()` exists in zod 4 (`zod/v4/classic/iso.d.ts:4`)                                                                                                                                                                                                                                            |
| V9-29                                | `packages/worker-pool-plugin/README.md:171-185, 258`; `PUBLIC_API.md:5026`; `pool/task-pool.ts:157-170, 214, 613-652`; `pool/worker-budget.ts:26-49, 74-89`; `packages/runtime/src/adapters/node/node-worker-host.ts:84`                                                                                                                      | README says "by 1–2 for 20–60 ms" (0.9.0); the metric table calls the slot gauge "Worker threads alive"; PUBLIC_API still says "Node and Bun were not measured". A slot is released before its thread exits, and the next waiter spawns at once                                                                                                                                                                                               |
| README fence gate                    | `test/package-readme-fence-compiler.test.ts:58-154, 184-194, 221-231`                                                                                                                                                                                                                                                                         | 44 READMEs pinned; 8 in `UNGATED` (cli, cloudflare, cqrs, database, notification, openapi, secrets, service-discovery: 53 compilable fences); coverage asserts `READMES ∪ UNGATED` = every README                                                                                                                                                                                                                                             |
| guide fence gate                     | `test/guide-fence-compiler.test.ts:50-262`; engine `test/fixtures/snippets/fence-engine.ts`                                                                                                                                                                                                                                                   | Per-guide pinned inventory; editing a guide fence's string content changes no count                                                                                                                                                                                                                                                                                                                                                           |
| script coverage inventory            | `scripts/script-targets.ts:2-11`                                                                                                                                                                                                                                                                                                              | `scripts/check-docs.ts` is a measured target (90% per file)                                                                                                                                                                                                                                                                                                                                                                                   |
| brief command list                   | `packages/cli/src/agents/facts.ts:63` — `start`, `check`, `test`, `test:e2e`, `dev`, `build`, `db:migrate`; no `start:dev`, `start:debug`                                                                                                                                                                                                     |
| brief command rendering              | `packages/cli/src/agents/render.ts:42`                                                                                                                                                                                                                                                                                                        |
| brief full-stack, messaging rules    | `packages/cli/src/agents/rules.ts:89-100`; prose identifiers checked by `packages/cli/test/unit/agents/rule-blocks.test.ts`                                                                                                                                                                                                                   |
| generated `start:dev`, `start:debug` | `packages/cli/src/templates/project-files.ts:1270-1271` (Deno), `:1299-1300` (Deno full-stack, which also has `dev`), `:1664-1672` (Node, Bun; no `dev`)                                                                                                                                                                                      |
| brief byte budget                    | `packages/cli/test/unit/agents/budget.test.ts` — 12288 bytes                                                                                                                                                                                                                                                                                  |
| card cap                             | `test/agent-card-gate.test.ts` — 2560 bytes; the auth-plugin card is 2349                                                                                                                                                                                                                                                                     |
| M124 auth options                    | `packages/auth-plugin/src/interfaces/index.ts:651` (`signInPage`), `:774` (`providers`, empty = password-only), `:790` (`sessionStamp`)                                                                                                                                                                                                       |
| starter `messaging`, `queue`         | `packages/starters/microservice-starter/src/options.ts:23,28`; the full-stack starter passes them through                                                                                                                                                                                                                                     |
| M123 styling                         | `packages/cli/src/templates/full-stack-ui-files.ts` — `app/app.css`, `app/components/ui/button.tsx`, `app/components/ui/card.tsx`; `cn` imported from the `cn` package (`full-stack-app-files.ts:500`)                                                                                                                                        |
| #524 page collision                  | `packages/cli/src/commands/generate.ts:434-440`                                                                                                                                                                                                                                                                                               |
| create forms                         | probed 2026-10-30 on published `@setu-ts/create` 0.10.0: `npm create @setu-ts x -- <flags>`, `pnpm create @setu-ts x <flags>`, `bun create @setu-ts x <flags>` each reach `setu new` (`--help` prints its usage; `--template full-stack --dry-run` lists 41 files). Yarn is not installed here, so it is not documented                       |
| wrong script name                    | `docs/react-router-dev.md:17`                                                                                                                                                                                                                                                                                                                 |
| JSR rationale                        | `docs/react-router-dev.md:20`; `packages/cli/src/templates/full-stack-build-files.ts:340-345` (comment); `packages/react-router-plugin/src/dev/vite-dev-externals.ts` JSDoc gives the identity reason                                                                                                                                         |
| plugin publishing                    | `docs/custom-plugins.md:548-603` (`deno.json`, `deno add jsr:`); first-party manifests, e.g. `packages/cache-plugin/package.json`                                                                                                                                                                                                             |
| homepage install block               | `website/src/pages/index.astro:74-79`; `website/test/landing-positioning.test.ts`                                                                                                                                                                                                                                                             |
| examples guide                       | `docs/examples.md:1-7` (proof framing), deep dives `:110-416`; pins `test/guide-fence-compiler.test.ts:116`, `test/snippet-validation.test.ts:44`                                                                                                                                                                                             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                               | Resolution (picked side)                                                                                       | Doc deliverable (same PR)                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| C1  | `docs/cli.md`, CHANGELOG, CLI README, PUBLIC_API say `<module>-<name>-service`; the generator writes `<module>.<name>-service`                         | The generator (and its printed guidance) is right                                                              | §3.6 sites                                            |
| C2  | React Router "v7" in four places vs "8" in the card, the peer range and other docs                                                                     | 8                                                                                                              | §3.11 sites                                           |
| C3  | ROADMAP / register: `swagger-ui-dist` "goes in the workspace ROOT `deno.json`"                                                                         | The measurement (§1): an `npm:` entry in the member's or the root `deno.json`, then `deno install` at the root | §3.3 wording; the ROADMAP row text is left as history |
| C4  | `PUBLIC_API.md:5026` "Node and Bun were not measured" vs the worker-pool README, which already dropped it                                              | The README                                                                                                     | §3.14                                                 |
| C5  | Resilience README: timeout does not cancel; `resilience.ts` JSDoc and `timeout.ts`: it aborts the signal                                               | The code                                                                                                       | §3.15                                                 |
| C6  | `docs/react-router-dev.md:17` says `npm run dev` / `bun run dev`; `docs/cli.md` and the generated scripts say `start:dev` (Node and Bun have no `dev`) | The generated scripts: `start:dev` on every runtime                                                            | §3.23                                                 |
| C7  | `docs/react-router-dev.md:20` and the template comment say Vite cannot resolve a JSR import; since M111 every `@setu-ts` package is on npm             | The identity reason `vite-dev-externals.ts` gives                                                              | §3.23                                                 |

## 3. Design decisions

Every prose change below states its claim from the §1 source; the implementer re-checks each against
that line before writing it.

### 3.1 V10-7 — links to a heading a release renames

- **Decision:** `packages/openapi-plugin/README.md:218` links
  `https://github.com/setu-ts/setu-ts/blob/main/docs/upgrading.md#declared-apioperation-ids-and-descriptions-0100`
  (the `###` slug, which exists at `v0.10.0` and on develop; `###` headings are not renamed at
  release). `CHANGELOG.md:692` says "See `docs/upgrading.md`, `## 0.10.0`." The link definitions at
  the bottom of the CHANGELOG gain `[0.9.0]` and `[0.10.0]` and `[unreleased]` compares from
  `v0.10.0`.
- **Test home:** §3.17's gate fails on the old README link and the old prose and passes on the new.

### 3.2 V10-8 — generated probes

- **Decision:** the "HTTP probes" bullet leaves "What is deliberately not generated" in
  `docs/deployment.md` and becomes a statement in the workspace Kubernetes section: a member whose
  record has `healthProbes` gets `httpGet /ready` and `/live`, otherwise `tcpSocket`;
  `metricsEndpoint` adds the three `prometheus.io/*` annotations; `generate app --template <name>`
  sets both, `adopt` sets each from the installed plugin or starter; switch a TCP member by adding
  `HealthPlugin` and `healthProbes: true` to its record.
- **Test home:** prose; checked by review against `k8s.ts:89-139`.

### 3.3 V10-15 — `swagger-ui-dist` on Deno

- **Decision:** `docs/upgrading.md` (0.10.0 M113f paragraph and the Unreleased M119c paragraph) and
  `packages/openapi-plugin/README.md:84-96` add the Deno form: add
  `"swagger-ui-dist": "npm:swagger-ui-dist@5.33.3"` to the `imports` of the app's `deno.json` (in a
  workspace, the member's — as generated members do — or the root's), run `deno install` from the
  workspace root, and keep `--allow-read`. Say why: the plugin's optional import resolves from the
  installed `node_modules`, so an entry with no install still fails at startup.
- **Test home:** prose, from the §1 measurement.

### 3.4 V10-16 — `allowJs` in the Workers full-stack repair

- **Decision:** the repair section (`docs/upgrading.md:674-693`) adds `"allowJs": true` to
  `compilerOptions`, why (the compiled build has no declarations → TS7016), and the
  `npm run build && tsc --noEmit` check script.
- **Test home:** prose; checked against `project-files.ts:1438-1465`.

### 3.5 V10-39 — which 4xx paths log

- **Decision:** `docs/upgrading.md:550-552` (and `docs/programmatic-api.md:522-525` if it repeats
  the claim) says only errors thrown into `errorHandler` log; responder terminals (unmatched 404,
  guard 401/403, validation 400/415, kernel pre-pipeline refusals) write the response and log
  nothing beyond the request logger's completion record.
- **Test home:** prose; checked against the §1 sites.

### 3.6 V10-38 — module-scoped service token

- **Decision:** every §1 site says `<module>.<name>-service` (example `billing.invoice-service`).
- **Test home:** a `grep -rn '<module>-<name>-service'` over the repo returns nothing (review).

### 3.7 V10-46, V10-47, V10-48 — three 0.10.0 omissions

- **Decision:** three `###` entries in `docs/upgrading.md` `## 0.10.0`:
  - `ReactRouterPluginOptions` is a union type: `interface X extends ReactRouterPluginOptions` fails
    with TS2312; use `type X = ReactRouterPluginOptions & { … }`.
  - The SDK generator emits an operation named `client` or `encodeURIComponent` as `_client` /
    `_encodeURIComponent`: callers of those operations change after regenerating.
  - `agents` is a built-in command and wins over a plugin command of that name; rename the plugin
    command, following the `plugin:command` convention (`ICliApi.register`). The two guide examples
    registering `'my-command'` (`docs/custom-plugins.md:271`, `docs/programmatic-api.md:475`) use
    `'my-plugin:greet'`-style names.
- **Test home:** prose; the guide fence gate keeps both guides compiling (string-only edits, counts
  unchanged).

### 3.8 V10-12 — `RetryPolicy` in the service-discovery README

- **Decision:** the fence uses `retry: { limit: 3, delay: 100, backoff: 'exponential' }`. The README
  is gated by §3.16, which is what proves it compiles.
- **Test home:** `test/package-readme-fence-compiler.test.ts`.

### 3.9 V10-40 — the request logger and the path

- **Decision:** the logger README "Request logging" section and the matching `PUBLIC_API.md`
  paragraph say: the request logger records `method` and the concrete `path` (no query string) on
  receive and on a slow request, not a route template, and the M113f scrub covers database errors
  only, so an identifier in a path segment reaches the log. To keep it out: `excludePaths` (skips
  the request's records), a `redaction` field redactor for `path`, or `redact` (which replaces the
  default secret patterns, so re-list them). The database README's scrub paragraph adds one sentence
  that request paths are outside it.
- **Test home:** prose; any new fence is gated (the logger README is in `READMES`).

### 3.10 V10-43 — agent cards and `setu add`

- **Decision:** in the 32 cards, "installs it" → "adds it", "installs and registers" → "adds and
  registers", "installs the package" → "adds the package", "installs a dev dependency" → "adds a dev
  dependency"; `docs/cli.md:266` likewise. Every replacement is shorter, so the 2560-byte cap holds.
- **Test home:** `test/agent-card-gate.test.ts` (cap and identifiers); a grep for `installs` in the
  cards returns only the two accurate uses (react-router line 5, grpc `interceptors`).

### 3.11 V10-56 — React Router 8

- **Decision:** the four §1 sites say React Router 8.
- **Test home:** grep for `React Router v7` returns nothing.

### 3.12 V10-57 — unrepresentable Zod types

- **Decision:** the openapi README bullet and `PUBLIC_API.md:9879-9896` add: nothing is logged; the
  document is built on the first `getSpec()` / `/openapi.json` request, not at startup, so inspect
  it (or test for `x-setu-unrepresentable`) in CI; for dates use `z.iso.datetime()`.
- **Test home:** prose; any new fence is gated (§3.16 adds this README).

### 3.13 Docs-only CHANGELOG

- **Decision:** one `### Fixed` entry under `## [Unreleased]` naming the rows (M119i). The two gates
  are repository tooling, not a package change, and get no entry.
- **Test home:** `check:docs` (CHANGELOG checks).

### 3.14 V9-29 remainder — worker-pool overshoot

- **Decision:** the README overshoot sentence (`:182-185`) gives the 0.10.0 measurement — a cold
  first burst on Node peaked at 6 threads with `maxWorkers: 3` in 3 of 3 runs, one burst above the
  bound for about 0.7 s — and the mechanism (a slot is released before its thread has exited, and
  the next waiter spawns at once). The 0.9.0 figure stays only under the existing
  `<!-- version:history -->` marker. The metric table row says "Worker slots alive".
  `PUBLIC_API.md:5026` drops "Node and Bun were not measured" and carries the same overshoot
  paragraph.
- **Test home:** prose; `scripts/version-sweep.ts` keeps accepting the history marker.

### 3.15 Resilience README — timeout cancels

- **Decision:** `packages/resilience-plugin/README.md:6, 71-73` say the wrapped function receives an
  `AbortSignal` that the timeout aborts, and that work ignoring the signal keeps running.
- **Test home:** prose; checked against `timeout.ts:12-20,58`.

### 3.16 Gate — every package README compiled

- **Decision:** the 8 `UNGATED` READMEs move into `READMES` with their compilable-fence counts; the
  `UNGATED` list and its exemption are deleted, so the coverage assertion is `READMES` = every
  `packages/**/README.md` and the size pin becomes 52. Every fence that fails is fixed against the
  source it describes (V10-12 is one); none is reclassified to avoid compiling.
- **Test home:** `test/package-readme-fence-compiler.test.ts`; a negative control (V10-12's old
  fence restored) fails it.

### 3.17 Gate — links that a release breaks, and absolute links into the repository

- **Decision:** `scripts/check-docs.ts` gains, in default mode:
  1. A link whose target is `https://github.com/setu-ts/setu-ts/(blob|tree)/<ref>/<path>[#anchor]`
     is checked as a local link to `<path>` (a `tree/` directory resolves to its `README.md`, as
     relative links already do): the file must exist and its anchor must match a heading in the
     current tree. (The current tree stands in for `<ref>`; a heading that moves before release is
     what the next rule catches.)
  2. A link to `docs/upgrading.md` or `CHANGELOG.md` (relative or absolute) whose anchor is
     `#unreleased` is refused from every file: that heading is renamed at each release.
  3. Inside a released `CHANGELOG.md` section (any `## [x.y.z]`), a line naming `upgrading.md` and
     `Unreleased` is refused. Each finding names the file, line and target, like the existing link
     findings.
- **Test home:** `test/docs-gate.test.ts`: each rule passes a valid case and refuses the broken one
  (including the exact V10-7 README link and CHANGELOG line); the real tree passes; per-file
  coverage of `scripts/check-docs.ts` stays ≥ 90%.

### 3.18 Agent brief — the development commands

- **Change:** `facts.ts` gathers `start:dev` and `start:debug` too, in the order `start`,
  `start:dev`, `start:debug`, `check`, `test`, `test:e2e`, `dev`, `build`, `db:migrate`. `render.ts`
  adds a short gloss to the three entry commands only, which an agent cannot tell apart from their
  names: `start` — the production entry; `start:dev` — the development loop, used while editing;
  `start:debug` — the development entry with the inspector. A command the project lacks is not
  listed, as today.
- **Why here:** M120 made `start:dev` the development loop after M116 fixed the list; every project
  except a Deno full-stack one gets a brief with no development command.
- **Test home:** `render-brief.test.ts` scaffolds each runtime's `rest` and `full-stack` project
  with `runCli`, gathers facts from the fake file system, and asserts the brief carries the
  runtime's `start:dev` line with its gloss (the real-path shape `budget.test.ts` already uses), and
  that a project without the script does not get the line. `budget.test.ts` adds the two names to
  its list.

### 3.19 Agent brief — the full-stack rule

- **Text (applies when `react-router-plugin` is installed):** route modules live under app/routes/;
  loaders read framework services through the context keys `setu.config.ts` declares; never
  introduce module-level caches. Develop with the start:dev script, where Vite serves the routes and
  nothing is built; the start script needs a build first. Style with Tailwind classes and the
  components in app/components/ui/, merging class names with cn from the cn package. Kernel routes
  cannot take a page's path — generation refuses them — so give API routes their own prefix.
- **Constraint:** the rule's prose is checked against the exports of the packages it lists
  (`rule-blocks.test.ts`), so paths, script names and `cn` are written plainly, as the existing
  rules write paths, not as backticked identifiers.
- **Test home:** `rule-blocks.test.ts` (identifier check passes; the rule names start:dev and
  app/components/ui/); `budget.test.ts` keeps every brief within 12288 bytes.

### 3.20 Agent brief — the messaging rule

- **Text:** publish integration events through `CAPABILITIES.MESSAGING` with versioned topics;
  declare consumers in the messaging options — `MessagingPlugin`'s, or the starter's messaging arm
  when `setu.config.ts` composes through a starter (`setu add messaging` writes the arm there,
  M121).
- **Test home:** `rule-blocks.test.ts`.

### 3.21 auth-plugin card — M124

- **Change:** one behaviour bullet: an unauthenticated browser navigation to a guard built with a
  `signInPage` is redirected with a `returnTo`; API requests keep the 401. One "Other options"
  entry: a `signIn` with no providers is password-only sign-in, and `signIn.sessionStamp` ends every
  session of a user. Existing text is shortened so the card stays within 2560 bytes.
- **Constraint:** option names that are not exports are written so the identifier gate accepts them
  (it allows the exports of the card's package, of `common` and of any package the card names, plus
  a `card-allow` comment's list); the gate decides, not the author.
- **Test home:** `test/agent-card-gate.test.ts` (cap, identifiers, fences unchanged).

### 3.22 full-stack-starter card — M121

- **Change:** an "Other options" entry: the microservice tier's `messaging` and `queue` options pick
  the broker and the queue backend; `setu add messaging` and `setu add queue` write them.
- **Test home:** `test/agent-card-gate.test.ts`.

### 3.23 `docs/react-router-dev.md` — scaffold first

- **Change:** a new first section, "In a scaffolded project": create the project
  (`npm create @setu-ts my-app -- --template full-stack`), run `npm run start:dev`
  (`deno task start:dev`, `bun run start:dev`), what the loop does (one application port; Vite
  in-process on its own port; client URLs under `/__vite/` through one proxy route; route edits
  served without a restart), and `npm run build` then `npm start` for production. The existing
  material moves under "Wiring it by hand (an existing application)", unchanged except: the script
  names (C6), and the JSR sentence replaced by the identity reason (C7). The template comment at
  `full-stack-build-files.ts:340-345` gets the same correction (comment only; generated output
  unchanged). The version sentence stays as the record of what was verified.
- **Test home:** `pnpm run check:docs` (links and anchors). The page is not in the guide fence gate,
  and this letter does not add it: its fences are application wiring the template already compiles.

### 3.24 `docs/getting-started.md` — `npm create` first, and a full-stack path

- **Change:** "Two ways to start" leads with `npm create @setu-ts my-app -- --template rest`, with
  the pnpm and Bun forms beside it (neither needs `--`; §1 probe) and `npx @setu-ts/cli new` as the
  equivalent. A new subsection, "A full-stack project": create with `--template full-stack`, develop
  with `npm run start:dev`, ship with `npm run build` and `npm start`; one paragraph on what each
  does, linking the CLI guide's production build section and §3.23's page.
- **Test home:** `test/guide-fence-compiler.test.ts` and `test/snippet-validation.test.ts` pins
  updated to the new fence counts; `check:docs`.

### 3.25 Website homepage — create a project

- **Change:** the install block in `website/src/pages/index.astro` leads with "New project" and
  `npm create @setu-ts my-app`, then the existing two lines relabelled "Existing app — Node" and
  "Existing app — Deno".
- **Test home:** `website/test/landing-positioning.test.ts` asserts the page carries
  `npm create @setu-ts`.

### 3.26 `docs/custom-plugins.md` — publishing to npm

- **Change:** "Publishing Your Plugin" becomes an npm package: `package.json` with `name`,
  `"type": "module"`, `exports` (`types` and `default` from `dist`), `files`, and `@setu-ts/common`
  in `peerDependencies` at the application's range (plus `devDependencies` to build), built with
  `tsc`; the README example installs with `npm install @acme/my-plugin`. A new subsection, "Sharing
  a plugin inside one workspace": `setu generate library <name>` creates `libs/<name>/`, whose
  manifest declares the `@setu-ts` packages it imports at the members' range, linking the
  duplicate-copy warning in `docs/plugins.md`.
- **Why a peer:** the application owns the one `@setu-ts/common`; a plugin that brings its own copy
  is the two-copies case `docs/plugins.md` warns about. First-party packages use `dependencies`
  because they release in lockstep with each other.
- **Test home:** `test/guide-fence-compiler.test.ts` and `test/snippet-validation.test.ts` pins;
  `check:docs`.

### 3.27 `docs/examples.md` — teaching, not only proof

- **Change:** the introduction says each example teaches one concept and its smoke check proves it.
  A new "Before you start": clone the repository, `pnpm install`, Node 24; the examples run from
  repository source, so outside it start from `npm create @setu-ts`. A new "A learning path" table
  orders the examples (minimal → rest-api → di-decorators → database → cqrs → multi-tenant →
  plugin-development → realtime → microservices → full-stack, then the specialised ones) with the
  concept each teaches. Each deep dive gains **Concept** (one paragraph) and **Read, in order** (two
  or three files, each linked, each with what to notice), keeping its run commands and proof. Each
  `apps/<name>/README.md` gains one line pointing at its deep dive.
- **Drift:** every file a walkthrough names is a relative link, which `check:docs` resolves; every
  symbol a walkthrough names is grep-checked against the app at review. No new code is quoted.
- **Test home:** `check:docs`; `test/guide-fence-compiler.test.ts` and
  `test/snippet-validation.test.ts` pins if fences change; `test/apps-layout.test.ts` unchanged.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. No package export changes; the one source edit is a module
JSDoc line (§3.11).

| Exported symbol  | Kind | Consumer / real code path that READS it |
| ---------------- | ---- | --------------------------------------- |
| None (docs-only) | —    | —                                       |

### 4.1 Options — every option names its consumer

| Option            | Consumer | Behavior (per implementation) |
| ----------------- | -------- | ----------------------------- |
| None (no options) | —        | —                             |

## 5. Implementation files

| File                                                                                                             | Purpose                                      |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `docs/upgrading.md`                                                                                              | §3.3, §3.4, §3.5, §3.7                       |
| `docs/deployment.md`                                                                                             | §3.2                                         |
| `docs/cli.md`, `packages/cli/README.md`, `PUBLIC_API.md`, `CHANGELOG.md`                                         | §3.1, §3.6, §3.9, §3.10, §3.12, §3.13, §3.14 |
| `docs/custom-plugins.md`, `docs/programmatic-api.md`                                                             | §3.5, §3.7                                   |
| `packages/openapi-plugin/README.md`                                                                              | §3.1, §3.3, §3.12                            |
| `packages/service-discovery-plugin/README.md`                                                                    | §3.8                                         |
| `packages/logger-plugin/README.md`, `packages/database-plugin/README.md`                                         | §3.9                                         |
| `packages/*/AGENT_CARD.md` (32)                                                                                  | §3.10                                        |
| `packages/react-router-plugin/README.md`, `packages/react-router-plugin/src/index.ts` (JSDoc), `ARCHITECTURE.md` | §3.11                                        |
| `packages/worker-pool-plugin/README.md`                                                                          | §3.14                                        |
| `packages/resilience-plugin/README.md`                                                                           | §3.15                                        |
| the 8 newly gated READMEs                                                                                        | §3.16 fence repairs                          |
| `test/package-readme-fence-compiler.test.ts`                                                                     | §3.16                                        |
| `scripts/check-docs.ts`, `test/docs-gate.test.ts`                                                                | §3.17                                        |
| `packages/cli/src/agents/facts.ts`, `packages/cli/src/agents/render.ts`                                          | §3.18                                        |
| `packages/cli/src/agents/rules.ts`                                                                               | §3.19, §3.20                                 |
| `packages/auth-plugin/AGENT_CARD.md`, `packages/starters/full-stack-starter/AGENT_CARD.md`                       | §3.21, §3.22                                 |
| `docs/react-router-dev.md`, `packages/cli/src/templates/full-stack-build-files.ts` (comment)                     | §3.23                                        |
| `docs/getting-started.md`                                                                                        | §3.24                                        |
| `website/src/pages/index.astro`                                                                                  | §3.25                                        |
| `docs/custom-plugins.md`                                                                                         | §3.26                                        |
| `docs/examples.md`, `apps/*/README.md`                                                                           | §3.27                                        |
| `ROADMAP.md` (M119i section), `CHANGELOG.md` (M119i entry)                                                       | §0.1                                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                              | src covered                                          | Key assertions                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `test/docs-gate.test.ts`                                               | `scripts/check-docs.ts`                              | §3.17 rules 1–3, valid and refused cases; real tree                                           |
| `test/package-readme-fence-compiler.test.ts`                           | the 52 package READMEs                               | §3.16 coverage = every README; all fences compile                                             |
| `test/agent-card-gate.test.ts`                                         | the 32 edited cards                                  | §3.10 cap and identifiers                                                                     |
| `test/guide-fence-compiler.test.ts`                                    | `docs/custom-plugins.md`, `docs/programmatic-api.md` | §3.7 edits keep counts and compile                                                            |
| `packages/react-router-plugin` (none)                                  | `src/index.ts` JSDoc line only                       | no behaviour; `check:docs` API JSDoc gate                                                     |
| `packages/cli/test/unit/agents/render-brief.test.ts`                   | `facts.ts`, `render.ts`                              | §3.18 real scaffolds per runtime carry `start:dev` with its gloss; absent script, absent line |
| `packages/cli/test/unit/agents/rule-blocks.test.ts`                    | `rules.ts`                                           | §3.19, §3.20 identifiers pass; rule text names start:dev and app/components/ui/               |
| `packages/cli/test/unit/agents/budget.test.ts`                         | `render.ts`                                          | every brief ≤ 12288 bytes with the new commands                                               |
| `test/agent-card-gate.test.ts`                                         | the two edited cards                                 | §3.21, §3.22 cap and identifiers                                                              |
| `website/test/landing-positioning.test.ts`                             | `index.astro`                                        | §3.25 `npm create @setu-ts` present                                                           |
| `test/guide-fence-compiler.test.ts`, `test/snippet-validation.test.ts` | the edited guides                                    | §3.24, §3.26, §3.27 counts and compile                                                        |

Gate proof: §3.16 and §3.17 each shown failing on the unfixed tree (the V10-12 fence, the V10-7 link
and prose) and passing after.

## 7. Verification gates

```bash
git branch --show-current   # MUST be docs/m119i-docs-that-match-the-code
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run test:tooling:coverage   # docs-gate, both fence gates, agent cards; scripts/check-docs.ts ≥ 90%
pnpm run release:verify 0.10.0
```

Folded scope adds `pnpm test:coverage cli` (`facts.ts`, `render.ts`, `rules.ts` ≥ 90% each),
`pnpm --dir website test`, and one manual proof: `setu new app --template full-stack --agents` on
Node and on Deno, with the written `AGENTS.md` read for the `start:dev` line and the new rules. The
final commit runs `pnpm run ci:local`, the Deno lane and both publish gates.

## 8. Risks & mitigations

- Gating 8 READMEs may surface more broken fences than V10-12 → each is fixed against its source;
  the count is bounded (53 fences) and the gate pins the result.
- Rule 1 checks anchors against the current tree, not `<ref>` → a heading removed between the ref
  and develop could pass; rule 2 covers the one heading known to be renamed at release, and the
  release `verify` already runs on the release tree.
- Card edits could break the 2560-byte cap → every replacement is shorter.
- Rule 1 newly checks the 132 absolute repository links in the scanned markdown (counted while
  planning; most target `blob/main`) → each broken one it reports is fixed in this PR, not exempted.
- Changing the brief changes every existing project's `AGENTS.md`, so `setu agents --check` reports
  it stale until `setu agents` is re-run → intended; the CHANGELOG entry says to re-run
  `setu agents`.
- The examples rewrite can name a symbol an app later renames → names are grep-checked at review,
  and files are links `check:docs` resolves.

## 9. Out of scope

- A warning at OpenAPI generation for unrepresentable types (V10-57 is the documentation of today's
  behaviour) — a future code change.
- Reference-style link definitions, non-ASCII slugs and HTML anchors in `check-docs` — no row needs
  them.
- Rewriting the register's V10-15 text — the register is history; the measured wording ships in the
  guide.
