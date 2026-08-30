# Milestone 84 — Realtime Client Consumption (`@setu-ts/sdk` + `@setu-ts/cli`)

> **Status:** Complete. Branch: `feat/m84-realtime-client-consumption`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Ship first-party, runtime-independent SSE and WebSocket clients in `@setu-ts/sdk`, plus
CLI-generated application-local starting points. The SDK owns portable transport behavior with no
React or plugin dependency; the CLI owns React hook source and route/plugin scaffolding because
those artifacts belong to the consuming application.

- **In scope:** fetch-based SSE parsing, reconnection, `Last-Event-ID`, bearer headers and abort
  teardown; global-WebSocket keep-alive reply, reconnect and room re-join; `sse` and `ws-route` CLI
  schematics; registry-aware generated HTTP route registration; SDK/CLI READMEs and `PUBLIC_API.md`;
  roadmap real-server exercises.
- **NOT this milestone:** changing the two server wire protocols (M43/M46); a published React
  package/subpath; EventSource delegation; persistent room membership or connection identity across
  reconnects.

## 1. Contracts verified from SOURCE (not names)

| Reference                  | Source (file:line)                                                                                                                | Verified surface / fact                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SseConnection`            | `packages/sse-plugin/src/connection/sse-connection.ts:73-98`                                                                      | Sets SSE stream headers, sends heartbeat comments, and emits `retry: <ms>` as first stream bytes.                                                                                                        |
| `encodeSseMessage`         | `packages/sse-plugin/src/utils/sse-frame.ts:33-61`                                                                                | Wire fields are `id`, `event`, one or more `data`, optional `retry`, then a blank line.                                                                                                                  |
| SSE resume header          | `packages/sse-plugin/src/connection/sse-connection.ts:49`                                                                         | Server reads `last-event-id` from request headers.                                                                                                                                                       |
| WebSocket heartbeat        | `packages/websocket-plugin/src/interfaces/index.ts:24-48`                                                                         | Heartbeats are application text frames; idle close uses code `1001`.                                                                                                                                     |
| WebSocket inbound activity | `packages/websocket-plugin/src/services/websocket-service.ts:544-559`                                                             | `touch()` occurs only in `onMessage`, before the handler runs.                                                                                                                                           |
| WebSocket sweeper          | `packages/websocket-plugin/src/heartbeat/heartbeat.ts:88-117`                                                                     | Each tick closes inbound-idle peers or sends the heartbeat payload.                                                                                                                                      |
| SDK conventions            | `packages/sdk/src/http/contracts.ts:83-162`; `packages/sdk/src/sdk.ts:24-58`                                                      | Public contracts are structural; factories validate once; injected seams make timing/transport deterministic.                                                                                            |
| SDK barrel                 | `packages/sdk/src/index.ts:11-43`                                                                                                 | Only factories, errors and types are exported; concrete implementations stay private.                                                                                                                    |
| CLI schematic registry     | `packages/cli/src/schematics/registry.ts:113-149`                                                                                 | One map owns valid schematic names, factories and plugin gates.                                                                                                                                          |
| Generated HTTP seam        | `packages/cli/src/seams/http.ts:102-174`                                                                                          | One barrel owns registration JSDoc/header and `registerGeneratedRoutes`.                                                                                                                                 |
| Scaffolded seam call       | `packages/cli/src/templates/seam.ts:96-122`                                                                                       | Every host renders the route registration call through `seamSetupCalls`.                                                                                                                                 |
| CLI generation             | `packages/cli/src/commands/generate.ts:103-108,206-225`                                                                           | Generation enforces declared gates, checks paths before writes and rewrites only declared managed barrels.                                                                                               |
| `encodeSseComment`         | `packages/sse-plugin/src/utils/sse-frame.ts:72-74`                                                                                | Returns `` `: ${text}\n\n` `` — the heartbeat is a COMMENT frame, so discarding `:` lines is what delivers zero heartbeat leakage.                                                                       |
| HTTP seam specs            | `packages/cli/src/seams/http.ts:187-225`                                                                                          | Four specs keyed on `(schematic, suffix, importSymbols)`: `.controller.ts`/`controllerClassSymbol`, `.controller.ts`/`routeRegistrarSymbol`, and `.routes.ts`/`routeRegistrarSymbol` twice.              |
| Suite run permissions      | `deno.json:63`                                                                                                                    | `deno task test` grants `--allow-run=deno,git,docker`. Measured under that exact set, spawning `node` fails `NotCapable` — so no package test can drive Node, Bun or workerd.                            |
| `check:apps` run grant     | `deno.json` (`check:apps` task); `scripts/check-apps.ts:4,181-188`                                                                | Runs with unrestricted `--allow-run` and owns the exit-77 skip protocol plus `ALLOW_SKIP` enforcement, so an unavailable runtime fails rather than passing quietly.                                      |
| SDK `common` imports       | `packages/sdk/src/{http/contracts.ts:16,http/http-client.ts:19,retry/retry-strategy.ts:15,circuit-breaker/circuit-breaker.ts:30}` | Every `common` import is `import type`, therefore erased at runtime. Measured: Node v24.18.0 `--experimental-strip-types` and Bun 1.4.0 both load SDK `.ts` source directly by path and execute into it. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                      | Resolution (picked side)                                                                                  | Doc deliverable (same PR)                                                                 |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md` still lists `route` under `src/routes/`, while source uses the shared `src/controllers/` seam.                                                                                                | Source is authoritative.                                                                                  | Correct the CLI generated-artifacts table and seam notes.                                 |
| C2 | SDK docs currently describe HTTP only, despite approved M84 clients.                                                                                                                                          | Add the exact new client surface; never imply EventSource delegation.                                     | Add SDK realtime API sections to `PUBLIC_API.md` and SDK README.                          |
| C3 | The HTTP seam documents a one-argument registrar, but M84 needs the service registry for generated SSE controllers.                                                                                           | Change owned emitter/call sites together to `registerGeneratedRoutes(app.router, app.services)`.          | Update seam header/JSDoc, templates, CLI README and tests.                                |
| C4 | `ROADMAP.md` (M84) states the literal `registerGeneratedRoutes(app.router)` is pinned by "[n]ine assertions ... across 11 test files". Measured: **9 occurrences across 6 files** under `packages/cli/test/`. | The measurement is authoritative; the assertion count is right and the file count is wrong.               | Correct the M84 ROADMAP sentence to 6 test files.                                         |
| C5 | `ROADMAP.md` (M84) sets a four-runtime verification bar for the SSE client, but the mandated `deno task test` gate cannot spawn Node, Bun or workerd (see §1).                                                | The bar stands; the HOME moves. The four-runtime exercise runs under `check:apps`, not the package suite. | State the harness and its CI wiring in the ROADMAP verification bar and `apps/README.md`. |

## 3. Design decisions

### 3.1 One fetch-based SSE implementation

- **Decision:** `createSseClient` uses injected-or-global `fetch`, a streaming UTF-8 frame parser
  and an abort controller; it never constructs `EventSource`.
- **Why:** Fetch is portable and supports authorization headers, yielding one reconnect/resumption
  policy.
- **Test home:** `packages/sdk/test/unit/sse-frame-parser.test.ts`,
  `packages/sdk/test/unit/sse-client.test.ts`, and real-server runtime exercises.

### 3.2 SSE reconnection and shutdown

- **Decision:** Record non-empty event IDs after dispatch, send `Last-Event-ID` on reconnect, adopt
  valid server `retry:` as the base delay, and stop permanently on abort or `close()`.
- **Why:** Matches the committed M43 server behavior while supporting authenticated server
  consumers.
- **Test home:** `packages/sdk/test/unit/sse-client.test.ts` plus real SSE bearer/heartbeat/resume
  assertions.

### 3.3 WebSocket keep-alive, reconnect, and room re-join

- **Decision:** `createRealtimeClient` uses global WebSocket behind an injectable constructor seam.
  It filters heartbeat payloads, replies with that payload, reconnects with bounded backoff and
  rebuilds the URL with configured room query parameters on every open.
- **Why:** M46 heartbeats are application frames and idleness measures inbound activity only; a
  reconnected socket has a new membership identity.
- **Test home:** `packages/sdk/test/unit/realtime-client.test.ts` and
  `packages/sdk/test/e2e/realtime-client-socket.test.ts` against a real idle sweep.

### 3.4 Generated artifacts stay in application code

- **Decision:** `setu generate sse <name>` always emits an SSE controller and emits its
  application-local React hook only when `react-router-plugin` and `sdk` are already configured;
  `setu generate ws-route <name>` emits a WebSocket plugin route. Each is gated on its transport
  package.
- **Why:** React cannot enter a JSR package graph; SSE routes use the generated registry seam while
  WebSocket routes need the plugin’s exact-path API.
- **Test home:** schematic unit tests, generation e2e, scaffold boot and seam-probe tests.

### 3.5 One owner for generated HTTP registration text

- **Decision:** The HTTP seam exposes one rendered-call helper used by both its barrel header and
  `seamSetupCalls`; its registrar accepts `(router: IRouterApi, services: IServiceRegistry)`.
- **Why:** The roadmap identifies three copied calls; central ownership prevents emitted
  guidance/config drift.
- **Test home:** HTTP seam, wiring, scaffold-runs and seam-probe tests.

### 3.6 The four-runtime SSE exercise runs under `check:apps`, never the package suite

- **Decision:** The multi-runtime bar is met by a new `apps/realtime-clients` example whose
  mandatory `smoke` task boots one real Setu SSE/WebSocket server and drives the SDK clients on
  **Deno in-process**, then on **Node** and **Bun** as spawned subprocesses running the same driver
  module, then on **workerd** via `wrangler dev`. `packages/sdk/test/e2e/*` stays Deno-only and
  asserts client behavior against an in-process server; it makes no cross-runtime claim.
- **Why:** measured, not assumed. `deno task test` grants `--allow-run=deno,git,docker`, and under
  that exact set spawning `node` fails `NotCapable` (§1) — so the row this plan previously wrote
  against `sse-client-runtime.test.ts` was unachievable under its own gate. `check:apps` already
  runs with unrestricted `--allow-run`, already runs in CI, and already owns the exit-77 +
  `ALLOW_SKIP` protocol that M53 built so an unavailable prerequisite fails instead of reading as a
  pass. The `apps/cloudflare` + `wrangler dev` harness is the precedent for the workerd arm.
- **What makes the subprocess arm possible:** every `common` import in `@setu-ts/sdk` is
  `import type` and therefore erased at runtime, so Node `--experimental-strip-types` and Bun load
  SDK `.ts` source directly by path (§1, measured on Node v24.18.0 and Bun 1.4.0). **This is a
  constraint the implementation must hold, not merely an observation:** the new `src/realtime/*`
  modules may import `common` in type position ONLY. A single value import would leave a bare `jsr:`
  specifier in emitted JavaScript that neither Node nor Bun can resolve, breaking two of the four
  arms — and the Deno-only package suite would stay green while it happened. A test asserts the
  realtime modules carry no value import of `common`.
- **CI wiring:** the job that runs `check:apps` gains `actions/setup-node` and `oven-sh/setup-bun`
  steps, so the app never skips for a missing runtime. `wrangler` is reached through `npx`. The
  workerd arm alone may report a per-runtime skip BY NAME; Deno, Node and Bun may not, and
  `test/apps-gate.test.ts` pins that `realtime-clients` is absent from `ALLOW_SKIP` (the M37c
  `full-stack` precedent).
- **Test home:** `apps/realtime-clients/smoke.ts`, its driver module, and the
  `test/apps-gate.test.ts` guard.

### 3.7 The generated SSE controller reuses an existing seam triple

- **Decision:** `setu generate sse <name>` emits `src/controllers/<name>.controller.ts` exporting
  `routeRegistrarSymbol(names)` — the existing functional-controller triple
  `('controller', '.controller.ts', routeRegistrarSymbol)` (§1) — so the artifact scanner admits it
  and the existing HTTP barrel registers it with no new `SeamSpec`. The React hook is emitted
  **outside** the seam directory, at `src/hooks/use-<name>.ts`, so the scanner never sees a file it
  cannot classify.
- **Why:** `readArtifactNames` admits a file only when it exports every symbol the barrel will
  import. A new schematic name emitting into `src/controllers/` under a symbol no spec declares is
  skipped and REPORTED, and M65 showed that diagnostic's advice ("regenerate it") loops, because
  regenerating produces the identical file. Reusing the committed triple means the schematic adds a
  generator, not an admission rule.
- **Consequence for C3:** the registrar gains a second parameter for every artifact in the seam, not
  just SSE ones. The empty-body case must `void` BOTH parameters or a generated project fails
  `noUnusedParameters`, which the drift gate applies.
- **Test home:** `packages/cli/test/unit/schematics/sse.test.ts`,
  `packages/cli/test/unit/seams/http.test.ts`, and the generation e2e that regenerates the barrel
  after `g sse` and type-checks it.

## 4. Exported surface — every symbol names its consumer

| Exported symbol         | Kind      | Consumer / real code path that READS it                                      |
| ----------------------- | --------- | ---------------------------------------------------------------------------- |
| `createSseClient`       | factory   | Browser/server applications construct a subscription client.                 |
| `ISseClient`            | interface | Application code retains it for state and `close()`.                         |
| `SseClientOptions`      | interface | Factory reads transport, headers, callbacks, signal and reconnect policy.    |
| `SseEvent`              | interface | Parser creates it and application callbacks consume it.                      |
| `createRealtimeClient`  | factory   | Browser/server applications construct an M46-aware socket client.            |
| `IRealtimeClient`       | interface | Application code sends data, closes and observes state.                      |
| `RealtimeClientOptions` | interface | Factory reads URL, room, heartbeat, callbacks, reconnect and transport seam. |
| `RealtimeMessage`       | interface | Realtime client emits it after heartbeat filtering.                          |

### 4.1 Options — every option names its consumer

| Option                                   | Consumer             | Behavior (per implementation)                            |
| ---------------------------------------- | -------------------- | -------------------------------------------------------- |
| `SseClientOptions.url`                   | request builder      | Target for every initial/reconnect fetch.                |
| `SseClientOptions.headers`               | request builder      | Cloned into requests; enables bearer authentication.     |
| `SseClientOptions.fetch`                 | SSE transport        | Injected implementation; defaults to global fetch.       |
| `SseClientOptions.signal`                | lifecycle controller | Aborts active reads and prevents reconnect.              |
| `SseClientOptions.reconnect`             | scheduler            | Bounds failure retry; server `retry:` sets base delay.   |
| `RealtimeClientOptions.url`              | URL builder          | Base endpoint rebuilt before every open.                 |
| `RealtimeClientOptions.room`             | URL builder          | Added to room query parameter on initial/reconnect open. |
| `RealtimeClientOptions.heartbeatPayload` | message handler      | Filters/replies to server heartbeat frames.              |
| `RealtimeClientOptions.reconnect`        | scheduler            | Bounds abnormal-close reconnect delay.                   |
| `RealtimeClientOptions.webSocket`        | socket transport     | Injectable constructor; defaults to global WebSocket.    |
| callback options                         | event dispatch       | Receive state, messages, errors and close outcomes.      |

## 5. Implementation files

| File                                               | Purpose                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/sdk/src/realtime/sse-contracts.ts`       | Public SSE interfaces/options.                                                                                                                                                 |
| `packages/sdk/src/realtime/sse-frame-parser.ts`    | Internal incremental SSE parser.                                                                                                                                               |
| `packages/sdk/src/realtime/sse-client.ts`          | Fetch stream lifecycle, resume and reconnect implementation.                                                                                                                   |
| `packages/sdk/src/realtime/websocket-contracts.ts` | Public WebSocket interfaces/options and injected transport shape.                                                                                                              |
| `packages/sdk/src/realtime/realtime-client.ts`     | Heartbeat reply/filter, reconnect and room re-join implementation.                                                                                                             |
| `packages/sdk/src/index.ts`                        | Re-export approved realtime surface only.                                                                                                                                      |
| `packages/sdk/README.md`                           | Realtime installation and usage.                                                                                                                                               |
| `packages/cli/src/schematics/sse.ts`               | Generate SSE controller and application-local React hook.                                                                                                                      |
| `packages/cli/src/schematics/ws-route.ts`          | Generate a WebSocket plugin route.                                                                                                                                             |
| `packages/cli/src/schematics/registry.ts`          | Register schematic factories and gates.                                                                                                                                        |
| `packages/cli/src/seams/http.ts`                   | Registry-aware HTTP registrar and shared call rendering.                                                                                                                       |
| `packages/cli/src/templates/seam.ts`               | Emit owned two-argument call.                                                                                                                                                  |
| `packages/cli/README.md`                           | Document realtime schematics/boundary.                                                                                                                                         |
| `PUBLIC_API.md`                                    | New SDK surface and corrected CLI behavior.                                                                                                                                    |
| `apps/realtime-clients/*`                          | Example app whose `smoke` task drives both clients on Deno, Node, Bun and workerd (§3.6). Outside the workspace, own `deno.json`, own `package.json` for the npm-side runners. |
| `.github/workflows/ci.yml`                         | `setup-node` + `setup-bun` on the job that runs `check:apps`, so the new app never skips for a missing runtime.                                                                |
| `test/apps-gate.test.ts`                           | Pins that `realtime-clients` is absent from `ALLOW_SKIP` and that both setup steps are wired.                                                                                  |
| `ROADMAP.md`                                       | C4/C5 corrections (§2).                                                                                                                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                | src covered                                                              | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sdk/test/unit/sse-frame-parser.test.ts`        | `src/realtime/sse-frame-parser.ts`                                       | BOM, line endings, comments, spaces, multi-line data, ID/retry and blank-line dispatch.                                                                                                                                                                               |
| `packages/sdk/test/unit/sse-client.test.ts`              | `src/realtime/sse-contracts.ts`, `src/realtime/sse-client.ts`            | `createSseClient(options: SseClientOptions): ISseClient`; headers, abort, retry and resume.                                                                                                                                                                           |
| `packages/sdk/test/unit/realtime-client.test.ts`         | `src/realtime/websocket-contracts.ts`, `src/realtime/realtime-client.ts` | `createRealtimeClient(options: RealtimeClientOptions): IRealtimeClient`; heartbeats, URL room rebuild, reconnect/send/close/error paths.                                                                                                                              |
| `packages/sdk/test/unit/barrel-exports.test.ts`          | `src/index.ts`                                                           | Exact documented exports and no concrete client leak.                                                                                                                                                                                                                 |
| `packages/sdk/test/e2e/sse-client-runtime.test.ts`       | SSE client integration                                                   | **Deno only.** Against an in-process real SSE endpoint: bearer header reaches the server, zero heartbeat leakage under a heartbeat interval short enough to guarantee ticks, and `Last-Event-ID` resent after the stream is cut. Makes no cross-runtime claim (§3.6). |
| `apps/realtime-clients/smoke.ts`                         | four-runtime SSE + real-socket WS                                        | The ROADMAP's verification bar. Same three SSE assertions driven on Deno in-process and on Node, Bun and workerd as subprocesses; plus the read-only WebSocket subscriber surviving a real idle sweep. Runs under `check:apps`, not the package suite.                |
| `packages/sdk/test/unit/realtime-module-imports.test.ts` | `src/realtime/*`                                                         | Every `common` import in the realtime modules is `import type`, so Node/Bun can load the source directly (§3.6). Fails the moment a value import is added.                                                                                                            |
| `packages/sdk/test/e2e/realtime-client-socket.test.ts`   | Realtime client integration                                              | Real socket with heartbeat/idle proves a read-only subscriber survives only with heartbeat reply.                                                                                                                                                                     |
| `packages/cli/test/unit/schematics/sse.test.ts`          | `src/schematics/sse.ts`                                                  | Generated controller/hook use SDK and registry seam.                                                                                                                                                                                                                  |
| `packages/cli/test/unit/schematics/ws-route.test.ts`     | `src/schematics/ws-route.ts`                                             | Generated plugin owns an exact WebSocket route and lifecycle callbacks.                                                                                                                                                                                               |
| `packages/cli/test/unit/seams/http.test.ts`              | `src/seams/http.ts`                                                      | Header and implementation share the two-argument call.                                                                                                                                                                                                                |
| `packages/cli/test/unit/seam-wiring.test.ts`             | `src/templates/seam.ts`                                                  | Every host emits `registerGeneratedRoutes(app.router, app.services);`.                                                                                                                                                                                                |
| `packages/cli/test/unit/schematics/registry.test.ts`     | `src/schematics/registry.ts`                                             | Help/lookup expose both names and gates.                                                                                                                                                                                                                              |
| `packages/cli/test/e2e/generate-e2e.test.ts`             | CLI artifact integration                                                 | Gates, dry-run, output and managed barrels behave as declared.                                                                                                                                                                                                        |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`        | CLI scaffold integration                                                 | A scaffold using the changed seam type-checks and boots.                                                                                                                                                                                                              |
| `packages/cli/test/e2e/seam-probe.test.ts`               | CLI seam integration                                                     | Generated SSE controller resolves its capability through the real scaffolded call.                                                                                                                                                                                    |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m84-realtime-client-consumption, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Before completion, run the roadmap real SSE/WebSocket exercises, grep changed SDK/CLI source for
forbidden constructs, commit the milestone tree, then run `deno task publish:check` and
`deno task release:verify <version>` on that committed tree.

## 8. Risks & mitigations

- Streaming chunks can split frames/UTF-8 sequences → use a stateful decoder and boundary-split
  tests.
- Timer-driven reconnect tests can flake → inject clock/transport seams; retain small real-server
  exercises.
- CLI literal registration calls can drift → centralize rendering and retain literal assertions as a
  drift guard.
- Generated React could leak into published packages → emit app source only; add no React package
  import/dependency.
- A socket test could avoid idle behavior → use a short real server heartbeat/idle window and prove
  the no-reply negative control closes.
- A value import of `common` reaching `src/realtime/*` silently breaks the Node and Bun arms while
  the Deno suite stays green → pinned by `realtime-module-imports.test.ts` (§3.6).
- The four-runtime app could be quietly exempted with a one-word `ALLOW_SKIP` edit →
  `test/apps-gate.test.ts` asserts it never is (the M37c `full-stack` precedent).
- A new schematic emitting into `src/controllers/` under a symbol no `SeamSpec` declares is skipped
  and reported with advice that loops (M65) → §3.7 reuses the committed
  `('controller', '.controller.ts', routeRegistrarSymbol)` triple.

## 9. Out of scope

- Published React bindings or a realtime plugin React subpath; applications own their hooks here.
- Server protocol/heartbeat changes and persistent realtime history; clients consume M43/M46 as
  committed.
- Backplane changes; reconnect re-supplies room URL membership but cannot preserve a connection
  identity or `exceptId`.
