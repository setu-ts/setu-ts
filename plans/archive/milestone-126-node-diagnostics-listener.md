# Milestone 126 — A local diagnostics listener on Node (`@setu-ts/runtime`, `@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m126-node-diagnostics-listener`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR. Additive: no BREAKING entry, so it ships in whichever release comes next.

## 0. Objective & scope

Make the authenticated local diagnostics connector (M98b) work in a Node application, and make the
CLI's devtool opt-in (M98c) emit it for a Node project. Since M111d, Node has been the default
target. The listener binds only on Deno and the CLI refuses `--devtool` everywhere else, so the
separately maintained devtool cannot inspect a project created with the defaults. After this
milestone, a Node project created with `setu new --devtool`, or enabled later with
`setu devtool enable`, starts the same connector with the same wire protocol. It pairs with the
unchanged native client, and a workspace runner hands the session to one member only.

- **In scope:** ROADMAP M126 items 1–8 and decisions 1–8, as corrected in §2; the Node listener; the
  shared connector suites running on both test lanes; the CLI's Node arm at `new`, `generate app`
  and `devtool enable`; the devtool path in the Node workspace runner; a runtime-neutral development
  entry; the design security review (§8a) and the committed-tree audit; docs.
- **NOT this milestone:**
  - **Bun:** the refusal stays (§9). It is named, not taken (ROADMAP M126).
  - **Workers:** no loopback socket of its own (§9).
  - **Devtool repository work** (npm discovery, the Node recipe catalog, launching `dev`, teardown):
    devtool milestone D06.
  - **Clearing the pair from the application's own environment after reading it:** §9, flagged for
    the security review.

### Compared with

Surveyed 2026-10-28. Source was read for `vite@8.3.5`, `webpack-dev-server@6.1.0`,
`@nestjs/devtools-integration@12.0.0` and Node v24's inspector (`src/inspector_socket.cc`).
Behaviour was probed on Node 24.22.1. Spring Boot DevTools and Next.js were not verified and are not
cited.

| Concern          | Node `--inspect`                    | Vite dev                             | webpack-dev-server                  | NestJS Devtools              | **This plan (both runtimes)**                                                    |
| ---------------- | ----------------------------------- | ------------------------------------ | ----------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| Server           | Native C++ (libuv + llhttp)         | `node:http` + Connect                | `node:http` + Express               | `node:http`                  | `node:http`, no framework wrapper (§3.1)                                         |
| Bind             | `127.0.0.1` by default; widenable   | `localhost`; `host: true` widens     | all interfaces by default           | **all interfaces** (no host) | `127.0.0.1` only; there is no option to widen it (unchanged from M98b)           |
| Host check       | empty, IP literal or `localhost` OK | missing Host and IP literals allowed | missing Host refused; 403           | none (Origin only)           | exact `127.0.0.1:<port>`; any `Origin` or forwarding header refused (M98b, kept) |
| Client auth      | UUID in the path, listed at `/json` | none                                 | none                                | token printed to stdout      | per-launch HMAC key passed by environment, never printed (M98b, kept)            |
| Parser hardening | native                              | defaults + `clientError` handler     | defaults                            | defaults                     | every limit explicit + fixed-byte `clientError` handler (§3.3)                   |
| Port conflict    | logs, application keeps running     | next port (`strictPort` throws)      | explicit port rejects               | bootstrap rejects            | `listen()` rejects; the connector fails startup closed (M98b, kept; §3.4)        |
| Shutdown         | —                                   | destroy sockets, then `close()`      | `close()` + `closeAllConnections()` | `close()`, no wait           | `close()` + `closeAllConnections()` (§3.5)                                       |

**What the comparison changed:**

- **Every timeout and size limit is set explicitly, with a `clientError` handler.** Vite is the only
  surveyed tool that handles `clientError`; the others run on Node's defaults.
- **Shutdown also calls `closeAllConnections()`,** as webpack-dev-server does. `close()` alone was
  measured to wait on a slowloris connection (§1).

**What it did not change:**

- **Port conflict fails closed** (M98b's decision). Node's inspector logs and carries on, but a
  devtool that dialled a port someone else holds would talk to the wrong process; the HMAC would
  refuse it, but only after a confusing pairing failure.
- **The Host check stays exact.** It is stricter than every surveyed tool, and safe, because the
  only client is native and sets its own headers.

## 1. Contracts verified from SOURCE (not names)

| Reference                                    | Source (file:line)                                                                                                                             | Verified surface / fact                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ILocalDiagnosticsListenerFactory`           | `packages/common/src/runtime.ts:590-630`                                                                                                       | `listen({ port, handler, onListen? }): Promise<ILocalDiagnosticsListener>`; one active listener; `127.0.0.1` only; a runtime without a transport rejects before binding. Runtime-neutral: no change is needed in `common`.                                                                                                          |
| `ILocalDiagnosticsListener`                  | `packages/common/src/runtime.ts:582`                                                                                                           | `close(): Promise<void>` only.                                                                                                                                                                                                                                                                                                      |
| Listener factory dispatch                    | `packages/runtime/src/diagnostics/local-diagnostics-listener.ts:301-309`                                                                       | `createLocalDiagnosticsListenerFactory(platform, host?)` returns `UnsupportedLocalDiagnosticsListenerFactory` unless `platform === 'deno'` (`:305`).                                                                                                                                                                                |
| Shared refusal surface                       | `local-diagnostics-listener.ts:45`, `:53`, `:60`, `:73-79`, `:99-104`, `:127-147`                                                              | `UNSUPPORTED_TRANSPORT_ERROR` (names Deno only), `INVALID_PORT_ERROR`, `LISTENER_ALREADY_ACTIVE_ERROR`, `SINGLETON_HEADER_NAMES`, `refusalResponse(status, code)`, `nativeFramingRefusal(request)`.                                                                                                                                 |
| Deno handler                                 | `local-diagnostics-listener.ts:236-256`                                                                                                        | Framing refusal → `mapWebRequestToFrameworkRequest` → `handler` → `mapSnapshotToWebResponse(snapshot())`; a throw answers `refusalResponse(503, 'unavailable')`.                                                                                                                                                                    |
| RuntimePlugin wiring                         | `packages/runtime/src/plugin/runtime-plugin.ts:248-256`                                                                                        | Builds the factory from the resolved platform, registers it under `CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER`, and registers `closeActive()` on `onClose`.                                                                                                                                                                            |
| `FrameworkRequest`                           | `packages/runtime/src/adapters/shared/fetch-mapping.ts:88-118`, `:413-426`                                                                     | Takes `(raw: Request, method, url, path, …)` with `url` separate from `raw.url`. `mapWebRequestToFrameworkRequest` passes `request.url`. `extractPath(url)` is exported (`:356`).                                                                                                                                                   |
| Connector's Host and target checks           | `packages/diagnostics-plugin/src/transport/connector-handler.ts:1022`, `:1045`, `:1058`                                                        | Refuses `host` ≠ `127.0.0.1:<port>`, `url.host` ≠ that authority, and any `request.url` that is not the canonical target. This relies on the runtime handing over the request-target AS SENT.                                                                                                                                       |
| Connector header budget                      | `packages/diagnostics-plugin/src/transport/limits.ts:65-66`, `:279-285`                                                                        | `maxHeaderBytes: 8 * 1024` across parsed names and values; refused as `invalid-request`.                                                                                                                                                                                                                                            |
| Connector onListen / fail-closed             | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts:417-442`                                                                         | Passes `onListen` only when a logger exists, so the runtime's default banner otherwise stands. `await factory.listen(...)` in `onBootstrap`: a rejection fails application start.                                                                                                                                                   |
| Node HTTP adapter host                       | `packages/runtime/src/adapters/node/node-http-adapter.ts:94-128`, `:136-165`, `:547-560`                                                       | `NodeServeHost.serve(...)` over a lazy `@hono/node-server` import; `listen()` awaits `serve()`, which does not wait for the bind.                                                                                                                                                                                                   |
| `@hono/node-server` 2.1.5 (measured)         | `node_modules/.pnpm/@hono+node-server@2.1.5_hono@4.13.14/…/dist/index.mjs:175`, `:599`, `:863-879`, `:1016-1068`, `:1324-1331`                 | `serve()` returns synchronously and has no `'error'` listener. `newRequest` builds the URL with `new URL` when it is not plain, so dot segments and `\` are normalized. A bad Host gets its own empty 400. A response failure writes `Error: ${message}`. `getRequestListener` takes `errorHandler`, but `serve()` never passes it. |
| Test lanes                                   | `scripts/test-lanes.ts:3-50`, `:53-88`, `:91-97`                                                                                               | `NODE_EXCLUDED_TESTS` holds 16 diagnostics-plugin suites (12 e2e, `activation`, `core-conformance`, `lifecycle`, `security`), `test/inspect-local-diagnostics.test.ts` and the Redis realtime-observations suite. `DENO_ONLY_SOURCES` holds the listener source.                                                                    |
| Test-side Deno APIs                          | the 17 suites above (`grep 'Deno\.'`)                                                                                                          | `Deno.listen`/`Deno.NetAddr` for free ports, `Deno.connect` for raw sockets, `Deno.env` in `config-provenance`, `Deno.serve` in `outbound-http-observations`, and `Deno.Command`/`Deno.execPath` in the consumer exercise.                                                                                                          |
| Shared Node test helpers                     | `test/node-helpers.ts:10-22`, `:163`, `:197`                                                                                                   | `unusedPort()`, `connect({ port })` (a raw socket) and `serveHttp(...)` over `node:net`/`node:http`. Deno runs `node:` modules, so the same helpers run on both lanes.                                                                                                                                                              |
| CLI runtime refusal                          | `packages/cli/src/devtool/planner.ts:255-268`; callers `commands/new.ts:585`, `commands/app.ts:588`, `commands/devtool.ts:443`, `:768`, `:779` | `devtoolRuntimeRefusal(runtime, context)` returns `undefined` only for `deno`.                                                                                                                                                                                                                                                      |
| Development entry                            | `packages/cli/src/devtool/dev-entry.ts:66-125`, `:140-160`, `:166-205`, `:212-216`                                                             | One renderer (`renderEntry`). It reads the pair with `Deno.env.get` (`:100-101`) and exits with `Deno.exit(1)` (`:108`, `:115`, `:160`); the rest already uses `runtime.env.PORT` and `shutdownBlock`. `devEntryVariants` lists the recognized CLI renderings; `isDevEntry` and `devEntryPort` read them.                           |
| Runtime-neutral exit                         | `packages/common/src/runtime.ts:404`; `packages/cli/src/templates/project-files.ts:752-800`                                                    | `IRuntimeServices.exit(code?)`. `shutdownBlock` renders one body for every runtime, through `onSignal`, `exit` and the logger.                                                                                                                                                                                                      |
| `runtime.env`                                | `packages/common/src/runtime.ts:389-397`; `adapters/deno/deno-runtime.ts:240`                                                                  | Deno materializes `Deno.env.toObject()` (needs a full `--allow-env`, which the generated `start`/`dev` grant: `project-files.ts:1446`); Node passes `process.env`.                                                                                                                                                                  |
| Node scripts after M120                      | `packages/cli/src/templates/project-files.ts:1637-1660`                                                                                        | `build` (`tsc --noEmit && setu build`), `start` (`node --enable-source-maps dist/main.js`), `start:dev` (`tsx watch main.ts`), `start:debug`, and the test scripts. No `dev` script.                                                                                                                                                |
| Node `check` covers every `.ts`              | `packages/cli/src/templates/npm-tooling.ts:32`; `project-files.ts:1454-1500`, `:1855-1857`                                                     | `check: 'tsc --noEmit && setu check'`; the generated `tsconfig.json` carries only `compilerOptions` (no `include`/`files`), so `main.dev.ts` is type-checked with no new script.                                                                                                                                                    |
| `setu build` entry                           | `packages/cli/src/commands/build.ts:163`                                                                                                       | `entries = ['main.ts']`: `main.dev.ts` and `diagnostics-plugin` never enter `dist`.                                                                                                                                                                                                                                                 |
| Node production image                        | `packages/cli/src/workspace/compose.ts:345-380`, `:298-299`                                                                                    | Runtime stage: `npm ci --omit=dev` (plus `--workspace` flags in a workspace), then only `dist` is copied. `.dockerignore` lists `main.dev.ts` and `apps/*/main.dev.ts`.                                                                                                                                                             |
| Deno image strip (V8-21)                     | `packages/cli/src/workspace/compose.ts:213`                                                                                                    | Deletes the `@setu-ts/diagnostics-plugin` import from `deno.json` in the image. Node needs no equivalent: §3.9.                                                                                                                                                                                                                     |
| `devtool enable` (Deno arm)                  | `packages/cli/src/commands/devtool.ts:150-301`, `:744-930`, `:993-1012`                                                                        | Reads only `deno.json`/`deno.jsonc`. Derives `dev` from `start` (`deriveDevTask`, `planner.ts:308`), merges `check` and the import, refuses mixed framework pins (`frameworkPinRefusal`: refuse, never bump), refuses starter and legacy factories, and refuses to overwrite a hand-edited entry.                                   |
| npm manifest helpers                         | `packages/cli/src/commands/add.ts:463-484`, `:501-535`                                                                                         | `pinnedInOtherNpmSection`, and `withDependency` (order-preserving insert, 2-space re-serialization). Reused, not copied.                                                                                                                                                                                                            |
| Workspace runner (Node)                      | `packages/cli/src/workspace/dev-runner.ts:185-277`                                                                                             | `spawn('npm', ['run', 'start:dev'], { cwd, stdio: 'inherit', detached: grouped })` (`:243-247`); no `env` (inherits everything); never reads `SETU_DEVTOOL_*`; signals the group on shutdown.                                                                                                                                       |
| Workspace runner (Deno)                      | `dev-runner.ts:50-152`                                                                                                                         | Reads the three variables, refuses an unknown or port-less member, blanks the pair for every non-selected child (`:109-121`), and runs `dev` for the selected member and `start` for the rest.                                                                                                                                      |
| Stale-runner refusal                         | `packages/cli/src/devtool/planner.ts:46-48`, `:75-98`                                                                                          | `devtoolDevRunner()` renders the Deno runner only. `devtoolRunnerRefusal` refuses a runner that lacks the three names; the remedy is to delete it and re-run, after which it is written fresh.                                                                                                                                      |
| tsx process model (measured)                 | `node_modules/.pnpm/tsx@4.23.15/…/dist/cli.mjs`                                                                                                | The CLI `spawn`s `process.execPath` as a child. Under `npm run dev` the chain is npm → sh → tsx → node.                                                                                                                                                                                                                             |
| Devtool supervisor (separate repository)     | `setu-ts-devtool/src/launch/supervisor.ts:19`, `:39`, `:131-137`                                                                               | A process-group leader. It tears down with `process.kill(0, SIGTERM/SIGKILL)` and spawns `<executable> task dev` with an explicit `env`. A detached grandchild escapes its group kill.                                                                                                                                              |
| Node `http` server semantics (measured, §1a) | Node 24.22.1                                                                                                                                   | See §1a.                                                                                                                                                                                                                                                                                                                            |

### 1a. Measured: the same raw requests against `Deno.serve` and `node:http`

Probe scripts were run in the session scratchpad: raw `node:net` writes, Deno 2.9.6, Node 24.22.1.
The handler echoed what it received. This table becomes the conformance table's data (§3.6); each
row's outcome is classified per runtime, not assumed equal.

| Raw request                             | `Deno.serve`                                     | `node:http` + node-server `serve()`                       | `node:http`, Node defaults (no wrapper)                            |
| --------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------ |
| No `Host`, HTTP/1.1                     | reaches handler, `host` null                     | Node core 400, empty chunked body                         | Node core 400 (`requireHostHeader`)                                |
| Invalid `Host` (`evil.com/../x`)        | reaches handler with that host                   | node-server 400, empty body                               | reaches handler                                                    |
| Two `Host` lines                        | **Deno 400**, `content-length: 0`                | handler sees `127.0.0.1, evil.com`; `rawHeaders` has both | same; `rawHeaders` has both                                        |
| Two `X-Setu-Session` lines              | handler sees `a, b`                              | handler sees `a, b`                                       | handler sees `a, b`; `rawHeaders` has both                         |
| Garbage request line                    | Deno 400, `content-length: 0`                    | Node `clientError` 400, no body                           | same                                                               |
| `Transfer-Encoding` + `Content-Length`  | Deno 400                                         | Node `clientError` 400                                    | same                                                               |
| Two `Content-Length: 0`                 | reaches handler (`0, 0`)                         | Node `clientError` 400                                    | same                                                               |
| Absolute-form target                    | handler, `url` host `evil.com`                   | handler, `url` host `evil.com`                            | `incoming.url` = `http://evil.com/…`                               |
| 20 KB header                            | reaches handler                                  | Node 431, no body                                         | Node 431 (`maxHeaderSize` 16 KiB)                                  |
| `/v1/./status`, `/x/../v1/status`       | handler sees the raw target                      | **handler sees `/v1/status`** (normalized)                | `incoming.url` is raw                                              |
| `/v1\status`                            | handler sees the raw target                      | **handler sees `/v1/status`** (normalized)                | `incoming.url` is raw                                              |
| Slowloris (partial headers) at shutdown | `shutdown()` resolves in 1 ms                    | —                                                         | `close()` still open after 3 s; with `closeAllConnections()`, 0 ms |
| Port already bound                      | `Deno.serve` throws synchronously                | uncaught `'error'` (no listener)                          | `'error'` event `EADDRINUSE`                                       |
| Default banner                          | `Listening on http://127.0.0.1:<port>/` (stderr) | none                                                      | none                                                               |

Also measured: `new Request('http://h/v1/./s').url` is `http://h/v1/s`. Any path through a web
`Request` normalizes, so the raw target must travel beside the request, never inside its URL.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                                                                                                                 | Resolution (picked side)                                                                                                                                                                                               | Doc deliverable (same PR)                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| C1  | ROADMAP M126 decision 1 (as first written) had the Node listener use node-server's `getRequestListener` with an `errorHandler`. §1a shows node-server normalizes the request-target before any handler runs, so the connector would SERVE `/v1/./status` instead of refusing it as an alias.                                             | Plain `node:http` with the listener's own request mapping, and no node-server code on this path (§3.1, §3.2).                                                                                                          | ROADMAP M126 decision 1 corrected (commit `250467df`).                                                              |
| C2  | ROADMAP M126 decision 7 said `diagnostics-plugin` is "bumped together with `kernel`/`common`/`runtime` (the V8-19 rule)". The shipped V8-19 fix (`frameworkPinRefusal`, `devtool.ts:993`) REFUSES mixed pins and names the upgrade guide; it never bumps.                                                                                | Refuse, as the Deno arm does (§3.8).                                                                                                                                                                                   | ROADMAP M126 decision 7 corrected (commit `250467df`).                                                              |
| C3  | ROADMAP M126 decision 2 said every request's status and body bytes match the Deno listener. §1a shows each HTTP parser refuses some requests before the protocol sees them, and the two parsers draw that line in different places: Node refuses a duplicate `Content-Length` and a 20 KB header, while Deno refuses a duplicate `Host`. | Equality holds for every request that reaches the protocol. A parser refusal is its own family on both runtimes: a bare `400` with no body. The conformance table records each row's outcome per runtime (§3.3, §3.6). | ROADMAP M126 decision 2 corrected (commit `250467df`). `docs/diagnostics-protocol.md` "Transport" names the family. |
| C4  | ROADMAP M126 item 4 and decision 4 count "19 diagnostics-plugin suites".                                                                                                                                                                                                                                                                 | 18 suites in `NODE_EXCLUDED_TESTS` need a real connector: the 16 diagnostics-plugin suites, the consumer exercise and the Redis realtime-observations suite (§1).                                                      | Already corrected on the ROADMAP branch (commit `43b7a4b1`); re-checked here.                                       |
| C5  | `docs/runtime-deployment.md:336-344`, `docs/diagnostics-protocol.md:17`, `docs/diagnostics-security-review.md:138,189`, `PUBLIC_API.md:5137`, `:5419`, `:10200`, `packages/cli/README.md:274`, `:307-308`, `packages/diagnostics-plugin/AGENT_CARD.md:36`                                                                                | Each says Deno only. `PUBLIC_API.md:10200` also names only `scripts/dev.ts`. Updated to Deno and Node; Bun and Workers still refuse; the Node runner is `scripts/dev.mjs`.                                             | Each line listed is edited in this PR; `pnpm run check:docs` passes.                                                |

## 3. Design decisions

### 3.1 The Node listener: `node:http`, its own factory and file

- **Decision:**
  - **Where it lives.** `createLocalDiagnosticsListenerFactory(platform, hosts?)` returns a
    `NodeLocalDiagnosticsListenerFactory` when `platform === 'node'`. It is a new internal class in
    `packages/runtime/src/diagnostics/node-local-diagnostics-listener.ts`. The Deno class moves,
    unchanged, to `deno-local-diagnostics-listener.ts`.
  - **What stays shared.** `local-diagnostics-listener.ts` keeps everything both runtimes use: the
    three error constants, `SINGLETON_HEADER_NAMES`, `refusalResponse`, `nativeFramingRefusal`, the
    unsupported factory and the dispatcher.
  - **The host seam.** The Node class takes an internal `NodeListenerHost`:
    `{ createServer(options, listener): NodeListenerServer }`, where `NodeListenerServer` is the
    slice of `http.Server` this file calls (`listen`, `once`, `on`, `address`, `close`,
    `closeAllConnections`). The default host is a static `import { createServer } from 'node:http'`.
  - **No lazy import.** `node:http` is a builtin, not a §12.2 dependency. Deno and Bun resolve
    `node:` specifiers, and the Workers build never reaches this file because the dispatcher refuses
    first (§3.4).
  - **No node-server.** The listener does not import `@hono/node-server`. That keeps its URL
    normalization (C1), its global `Request`/`Response` override and its `Error: <message>` writer
    off this path.
- **Why:** §1a. Every node-server behaviour this listener would have to undo is a measured
  difference from Deno, and the listener needs none of what node-server adds. Splitting the files
  lets the Node lane measure the Node file and the shared file. The Deno class stays in
  `DENO_ONLY_SOURCES`.
- **Test home:** `packages/runtime/test/unit/node-local-diagnostics-listener.test.ts` (fake host);
  `packages/runtime/test/integration/node-local-diagnostics-listener-real.test.ts` (real sockets);
  the existing `local-diagnostics-listener.test.ts` keeps its Deno and shared cases.

### 3.2 Request mapping keeps the request-target as sent

- **Decision:** A new internal function in `fetch-mapping.ts`,
  `mapWebRequestWithTarget(raw: Request, url: string, peerAddress?: string): IRequest`, builds a
  `FrameworkRequest` whose `url` and `path` come from the given string, never from `raw.url`. It is
  not exported from `src/index.ts`.

  The Node listener handles each request in this order. Every refusal goes through
  `refusalResponse(400, 'invalid-request')`, which is byte-identical to the connector's own refusal:
  1. Refuse a request-target that does not start with `/`: absolute-form, authority-form and
     asterisk-form. Deno hands those to the connector, which refuses them by `url.host`.
  2. Refuse an absent `Host`. The connector refuses `host !== authority` on Deno.
  3. Refuse any singleton header (`SINGLETON_HEADER_NAMES`) that appears on more than one raw line
     in `incoming.rawHeaders`.
  4. Build `new Headers()` by appending each `rawHeaders` pair. This joins duplicates the way Deno's
     `Headers` does. A pair that `Headers` rejects is refused.
  5. Build a body-less `Request` for `http://127.0.0.1:<port>/` with those headers and the method.
  6. Run `nativeFramingRefusal` on it.
  7. Map it with `url = \`http://${host}${incoming.url}\``, concatenated, never parsed.

- **Why:** The connector's alias refusal (`connector-handler.ts:1058`) is only sound if the runtime
  passes the target through unchanged. §1a shows any web `Request` normalizes it. Steps 1–2 refuse
  at the listener only cases the connector would refuse anyway, with the same bytes. They exist
  because Node cannot build the URL the connector would inspect.
- **Test home:**
  - The node listener unit suite runs one table: each row is a raw `incoming.url` plus headers, and
    the expected IRequest `url` or refusal.
  - The two-runtime conformance table (§3.6) carries `/v1/./status`, `/x/../v1/status`, `/v1\status`
    and absolute-form, and asserts both runtimes REFUSE them.

### 3.3 Server limits and the parser-refusal family

- **Decision:**
  - **Server options**, each set explicitly:

    | Option                        | Value                          |
    | ----------------------------- | ------------------------------ |
    | `requireHostHeader`           | `false` (§3.2 refuses instead) |
    | `insecureHTTPParser`          | `false`                        |
    | `joinDuplicateHeaders`        | `false`                        |
    | `maxHeaderSize`               | `16_384`                       |
    | `headersTimeout`              | `5_000`                        |
    | `requestTimeout`              | `10_000`                       |
    | `keepAliveTimeout`            | `5_000`                        |
    | `connectionsCheckingInterval` | `1_000`                        |
    | `maxRequestsPerSocket`        | `0`                            |
    | `server.maxConnections`       | `32`                           |

    Together they are one exported-internal constant, `NODE_LISTENER_SERVER_OPTIONS`.

  - **Refusals from the parser and timeouts.** A `'clientError'` handler writes exactly
    `HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n` when the socket is
    writable and `err.code` is not `ECONNRESET`, and then destroys the socket. It handles every
    error code the same way, so header overflow (Node's default 431) and request timeout (Node's
    default 408) collapse into the one family. Nothing in the reply depends on the request.
- **Why:**
  - **No reflection.** A `clientError` reply carries no request bytes. One family keeps one fixed
    reply, the M98b rule that error text is not a fingerprinting channel.
  - **Header size.** `maxHeaderSize` sits at twice the connector's 8 KiB header budget. Between 8
    and 16 KiB the connector answers `invalid-request`; above 16 KiB the transport answers.
  - **Timeouts.** Node enforces `headersTimeout` and `requestTimeout` only on its checking interval
    (default 30 s), so `connectionsCheckingInterval` is lowered for the timeouts to mean anything.
  - **Connections.** `maxConnections: 32` is four times the connector's handler concurrency (8),
    enough for a keep-alive pool without letting a local flood grow sockets without bound.
- **Test home:** `node-local-diagnostics-listener-real.test.ts`:
  - the parser rows of the conformance table;
  - a timed slowloris test, where a partial header gets the fixed 400 and close within
    `headersTimeout + connectionsCheckingInterval + 1 s`;
  - a 33rd-connection test;
  - a peak-connection measurement: the real-socket suite builds the Node factory with a host that
    delegates to the real `createServer` and counts open sockets on `'connection'`/`'close'`. It
    composes `DiagnosticsPlugin` with that factory, then drives the real `createDiagnosticsClient`
    through pairing, a snapshot, an event read and a renewal. It records the peak and asserts it is
    at most 16, half the cap. That measures the cap against the real client instead of leaving it to
    D06. The counter lives in the test's host and adds nothing to `src`.

### 3.4 Platforms, binding and the default banner

- **Decision:**
  - **Platforms.** Deno and Node have listeners. Bun, Workers and unknown platforms keep the
    refusing factory. `UNSUPPORTED_TRANSPORT_ERROR` becomes
    `'Local diagnostics listener: this runtime has no supported local transport. Only Deno and Node are supported in this version.'`.
  - **Bind result.** `listen()` resolves on `'listening'` and rejects with the server's `'error'`.
    `once` is used for both, and the losing listener is removed. On rejection the factory slot is
    released, so a later `listen()` can retry. The rejected error is the OS error object, never
    rewritten. It reaches only the application's own startup failure, never the wire.
  - **onListen.** It receives `{ hostname: '127.0.0.1', port: address.port }`. Without `onListen`,
    the listener writes `Listening on http://127.0.0.1:<port>/\n` to `process.stderr`, the same text
    Deno prints (§1a). That keeps the M98b rule that the bind is never silent
    (`diagnostics-plugin.ts:417-427`).
- **Why:** The connector's fail-closed startup (§0, "Compared with") needs a real rejection; §1a
  shows node-server never produces one. The banner keeps the two runtimes' stderr identical for the
  launcher.
- **Test home:**
  - Unit: the `'error'` path rejects and frees the slot, `onListen` gets the mapped address, and the
    default banner goes through an injected writer seam.
  - Real: binding a taken port rejects with `EADDRINUSE` and the application does not start, driven
    through `DiagnosticsPlugin` in `activation.test.ts`.

### 3.5 Close is bounded and idempotent

- **Decision:**
  - `close()` stores one promise. It calls `server.close()`, then `server.closeAllConnections()`
    immediately, resolves when `close`'s callback fires, and releases the factory slot exactly once,
    whichever path closed it (revoke, the RuntimePlugin `onClose` hook, or a direct call).
  - A `close` callback error is swallowed after the slot is released, as the Deno class does, so
    `revoke()` can never reject the application.
  - `closeActive()` behaves as on Deno.
- **Why:** §1a: `close()` alone waits on a slowloris connection until its timeouts; Deno's
  `shutdown()` does not. Connector handlers are bounded (no long polling,
  `docs/diagnostics-protocol.md:18`), so cutting an in-flight one costs one retried poll.
- **Test home:** unit (concurrency-safe double close; slot released once); real (close resolves in
  under 1 s with an idle keep-alive socket and a slowloris socket open).

### 3.6 Proof: the existing connector suites run on both lanes, plus one two-runtime table

- **Decision:**
  - **Test lanes.**
    - Remove the 16 diagnostics-plugin suites, `test/inspect-local-diagnostics.test.ts` and the
      Redis realtime-observations suite from `NODE_EXCLUDED_TESTS`.
    - Remove `packages/runtime/src/diagnostics/local-diagnostics-listener.ts` from
      `DENO_ONLY_SOURCES` and add `deno-local-diagnostics-listener.ts` in its place.
    - The diagnostics-plugin suites stay in `DENO_LANE_TESTS`, so they now run on both lanes.
  - **Removing the Deno APIs from those suites.** Each test-side Deno API is replaced:

    | Test-side Deno API                                   | Replaced by                                            |
    | ---------------------------------------------------- | ------------------------------------------------------ |
    | `Deno.listen` / `Deno.NetAddr`                       | `unusedPort()` from `test/node-helpers.ts`             |
    | `Deno.connect`                                       | `connect()` from `test/node-helpers.ts`                |
    | `Deno.serve`                                         | `serveHttp()` from `test/node-helpers.ts`              |
    | `Deno.env`                                           | `process.env`, permitted in tests (AI_GUIDELINES §6.7) |
    | `Deno.Command` / `Deno.execPath` (consumer exercise) | `spawnProcess` with `process.execPath`                 |

  - **The new table.** One new two-runtime table,
    `packages/runtime/test/integration/local-diagnostics-listener-conformance.test.ts`, lists §1a's
    rows as data. Each row records the expected outcome per runtime as one of:
    - `protocol-refusal` (the JSON `invalid-request` bytes);
    - `transport-refusal` (§3.3's bare 400, or Deno's bare 400);
    - `served`.

    The suite drives the platform's real listener through `RuntimePlugin` with a fake protocol
    handler, and it is in both lanes.
- **Why:** The 16 suites already prove pairing, every observation family, aliases, the replay
  window, renewal, revocation and lifecycle against a real socket. Running them on Node proves the
  protocol is the same without a second copy of those assertions. The table covers only what those
  suites cannot see: transport cases where the two runtimes legitimately differ. Per the CLAUDE.md
  set-as-data rule, the differences live in the table, not in prose.
- **Test home:** the suites themselves; the conformance table; `test/test-lanes.test.ts` asserts the
  moved entries.

### 3.7 A runtime-neutral development entry

- **Decision:**
  - **The new rendering.** `renderEntry` reads `runtime.env['SETU_DEVTOOL_SESSION_ID']` and
    `runtime.env['SETU_DEVTOOL_SESSION_KEY']` and exits with `runtime.exit(1)`. The probe check
    calls `runtime.exit(1)` after `await app.stop()`. Its header comment names the `dev` script/task
    without naming `deno task`, and `cliInvocation('deno')` in the probe message becomes
    `cliInvocation(runtime)`. This one rendering serves Deno and Node.
  - **Recognizing older entries.** `devEntryVariants` keeps every previous rendering, including the
    current Deno one, so `isDevEntry` still recognizes an entry written by `0.8.0`–`0.10.x`. Ports
    can still be reallocated on those entries, and `enable` can rewrite them to the new rendering
    rather than refusing them as hand-edited.
  - **The runtime parameter.** `renderDevEntry` takes the target runtime, because
    `cliInvocation(runtime)` differs between Deno and Node. The emitted source otherwise does not
    vary by runtime.
- **Why:** AI_GUIDELINES §4.2. M70h moved `shutdownBlock` off `Deno.*` for the same reason.
  `runtime.env` already works in the Deno entry (it reads `PORT`), under the full `--allow-env` the
  generated tasks grant (`project-files.ts:1446`).
- **Test home:** `packages/cli/test/unit/dev-entry.test.ts`:
  - one table drives every variant through `isDevEntry` and `devEntryPort`;
  - the emitted source contains no `Deno.` and no `process.`.

  `devtool-e2e.test.ts` boots the new rendering on Deno and on Node.

### 3.8 The CLI emits the devtool for a Node project

- **Decision:** `devtoolRuntimeRefusal` returns `undefined` for `deno` and `node`. Its message for
  `bun` and `cloudflare-workers` names "Deno or Node". For a Node target, every entry point writes
  through one planner function, `planNodeDevtool`, in a new
  `packages/cli/src/devtool/npm-manifest.ts`:
  - **The `dev` script.** `scripts.dev` is set to `tsx main.dev.ts`, a constant named
    `NODE_DEVTOOL_DEV_SCRIPT`. The name `dev` was settled against M120 (ROADMAP M126): M120 took
    `start:dev` and `start:debug`, and Deno's devtool task is already `dev`. It is never a watch
    script.
  - **The dependency.**
    - `@setu-ts/diagnostics-plugin` is added to `devDependencies` at `FRAMEWORK_RANGE` with
      `withDependency`.
    - Already present in `devDependencies` at that range: a no-op.
    - Present in `dependencies`: refused by name. It would reach the production image, and the
      remedy is to move it to `devDependencies`.
    - Present at another range: refused by the pin rule below.
  - **The pin rule.** Every `@setu-ts/*` entry in `dependencies` or `devDependencies` must equal
    `FRAMEWORK_RANGE`, or the whole command is refused naming each mismatch and `docs/upgrading.md`.
    This is the Node counterpart of `frameworkPinRefusal`.
  - **The `tsx` requirement.** `tsx` must be in `devDependencies` (every Node scaffold has it,
    `project-files.ts:1711`), or the command is refused by name.
  - **An existing `scripts.dev`.** If it is not `NODE_DEVTOOL_DEV_SCRIPT`, the command is refused
    with the merge contract's "a script you wrote is yours" message.
  - **Manifest parsing.** The `package.json` is parsed after stripping a UTF-8 BOM. Invalid JSON is
    refused by name, and nothing is written.
  - **Unchanged from the Deno arm.** The starter refusal, the legacy-factory refusal and the
    entry-overwrite refusal apply as on Deno.
  - **No `check` change.** The Node `check` script already type-checks `main.dev.ts` (§1).
  - **The next step.** After a write, the command prints `npm install` as the next step. It never
    runs it.
  - **Where it is called from.** `setu new --devtool` (standalone Node),
    `setu generate app --devtool` (a Node workspace member) and `setu devtool enable` all call
    `planNodeDevtool`. Only the member's own `package.json` is written; the workspace root manifest
    is never touched.
- **Why:**
  - **Refuse, don't bump.** The C2 resolution, consistent with the Deno arm.
  - **`devDependencies` with `--omit=dev`** keeps the plugin out of the image with no strip step
    (§3.9).
  - **Manifest shapes.** The cases covered come from the `setu add` manifest checklist (M119f): a
    pin in the other section, a BOM, invalid JSON, and an entry already present. Root `overrides`
    are not consulted because the root is not written. An npm member is not subject to `EOVERRIDE`.
- **Test home:**
  - `packages/cli/test/unit/devtool-npm-manifest.test.ts`: one table, one row per manifest shape
    above, with the expected write or refusal.
  - `packages/cli/test/unit/devtool-refusals.test.ts`, `devtool-manifest-merge.test.ts` and
    `devtool-lifecycle.test.ts`, extended: the Node standalone and workspace-member arms, with
    dry-run parity and idempotent re-run.
  - `devtool-e2e.test.ts`, extended (§3.11).

### 3.9 The production image needs no Node strip step

- **Decision:** No change to `compose.ts`. `diagnostics-plugin` in `devDependencies`, M120's
  `npm ci --omit=dev` runtime stage, `setu build`'s `main.ts`-only bundle and the existing
  `.dockerignore` entry together keep the connector out of a Node image.
- **Why:** M120 already ships each piece (§1). Adding a strip step would duplicate them.
- **Test home:** `packages/cli/test/unit/workspace/compose.test.ts`, extended:
  - the rendered Node Dockerfile's runtime-stage install line contains `--omit=dev`;
  - the runtime stage copies only `dist` and `build`.

  `devtool-e2e.test.ts`: after a Node devtool scaffold is built, `dist/main.js` contains no
  `diagnostics-plugin` specifier and no `SETU_DEVTOOL_` name.

### 3.10 The Node workspace runner hands the session to one member

- **Decision:** `nodeRunner` (both the Node and Bun profiles render it; Bun still cannot select a
  member, because `enable` refuses Bun) gains the Deno runner's devtool path:
  - **The selected member.**
    - The runner reads `SETU_DEVTOOL_MEMBER`, `SETU_DEVTOOL_SESSION_ID` and
      `SETU_DEVTOOL_SESSION_KEY` from `process.env` (this is generated application tooling, not
      framework source).
    - It refuses an unknown member or one without `devtoolPort`, with the Deno runner's messages,
      before spawning anything.
    - It runs `npm run dev` for the selected member and `npm run start:dev` for every other member.
  - **Every child's environment.** Every child gets
    `env: { ...process.env, SETU_DEVTOOL_MEMBER, SETU_DEVTOOL_SESSION_ID, SETU_DEVTOOL_SESSION_KEY }`,
    with all three blanked for every member except the selected one.
  - **Detaching.** When a member is selected, no child is spawned with `detached: true`. The
    launcher's process group then reaches every process: the launcher signals the group, and the
    runner's own `SIGINT`/`SIGTERM` handler still signals each child. With no selection, the runner
    detaches exactly as today.
  - **Rewriting an older runner.** `devtoolDevRunner(runtime)` renders the profile's runner.
    `devtoolRunnerRefusal` applies unchanged to `scripts/dev.mjs`: a runner without the three names
    is refused, and the remedy is to delete it and re-run.
- **Why:** §1: the current Node runner leaks the pair to every sibling, and its `detached` children
  leave the devtool's group, so the supervisor's group kill (`supervisor.ts:19,39`) would miss them.
  Not detaching under the devtool is safe because the devtool owns the group and its teardown;
  without the devtool, the M119-era reason for detaching (a shell that does not forward signals)
  still applies.
- **Test home:**
  - `packages/cli/test/unit/workspace/dev-runner.test.ts`: rendered-text assertions for the three
    names, the blanking, the conditional `detached`, and `dev` versus `start:dev`.
  - `packages/cli/test/e2e/dev-runner-e2e.test.ts`, extended ("the npm-profile dev runner,
    forwarding the devtool environment"):
    - the selected child sees the pair;
    - each sibling sees empty values;
    - an unknown member is refused with nothing spawned;
    - under selection, every child shares the runner's process group (Linux: `ps -o pgid`).

### 3.11 End-to-end: a Node devtool project boots and pairs

- **Decision:** `devtool-e2e.test.ts` gains Node cases mirroring its Deno ones.
  - **Standalone.**
    1. Scaffold `setu new <name> --devtool` (default runtime: Node).
    2. Repoint it at this workspace's packages.
    3. Run `npm run check`.
    4. Boot `npm run dev` with a fresh pair.
    5. Read the snapshot and an event batch through `createDiagnosticsClient`.
    6. Renew.
    7. Stop with SIGTERM to the group, and assert that no process from the tree survives.
  - **Workspace.**
    1. Run `setu new <ws> --workspace` (Node).
    2. Run `generate app a --devtool` and `generate app b`.
    3. Run `npm run dev` at the root with `SETU_DEVTOOL_MEMBER=a` and a pair.
    4. Pair with `a`.
    5. On Linux, assert that `/proc/<pid>/environ` of `b`'s node process carries empty
       `SETU_DEVTOOL_SESSION_*` values.
  - **No credentials.** Booting without the pair exits non-zero with the named message, and nothing
    binds the devtool port.
- **Why:** CLAUDE.md: a milestone that changes what the CLI generates boots a scaffolded project.
  Checking the emitted text proves the renderer, not the feature (`devtool-e2e.test.ts:1-15`).
- **Test home:** `packages/cli/test/e2e/devtool-e2e.test.ts`.

### 3.13 A connection flood evicts the oldest idle socket instead of locking the client out (audit F1)

- **Decision:** `server.maxConnections` is no longer set; Node's refusal of every connection past
  the cap is what let 32 held partial-request sockets lock the paired client out (audit F1, contrary
  to T8). The listener tracks its sockets itself, in arrival order, each marked busy while a request
  is being handled (from `'request'` until the response's `'finish'` or `'close'`, after which the
  socket moves to the back as most recently used). When a new connection arrives and 32 are open,
  the oldest socket that is NOT busy is destroyed — a partial-request socket, a slowloris socket or
  an idle keep-alive socket — and the new one is admitted. Only when all 32 are busy is the new
  socket destroyed. The cap value stays `NODE_LISTENER_SERVER_OPTIONS.maxConnections` (32).
- **Why:** the client sends its request as soon as it connects, so its socket is busy while it is
  served and cannot be evicted; a flood can at most cost it an idle keep-alive socket, after which
  its reconnect evicts a flood socket. Open sockets stay bounded at 32, which was the cap's purpose.
  Deno has no cap at all (measured), so this keeps the bound without reintroducing a lockout Deno
  does not have.
- **Test home:** `node-local-diagnostics-listener-real.test.ts`: 32 held partial-request sockets,
  then 8 real-client `snapshot()` calls all succeed (the auditor's F1 probe, now a regression test);
  open sockets never exceed 32 (counted by a delegating host); the 33rd-connection test becomes
  "evicts the oldest idle socket". Unit (fake sockets): eviction order, busy sockets never evicted,
  all-busy refuses the newcomer, recency move after a response.

### 3.14 `Expect` requests take the ordinary path (audit F2)

- **Decision:** the listener registers `'checkContinue'` and `'checkExpectation'` and hands both to
  the same request path as `'request'`. Node then sends neither an interim `100 Continue` nor its
  own `417 Expectation Failed`; the request is mapped, framed and answered exactly like any other.
- **Why:** measured on Deno 2.9.6: both `Expect: 100-continue` and an unknown expectation reach the
  handler with no interim response. Node's defaults answered outside the fixed refusal family and
  fingerprinted the runtime (audit F2). Taking the ordinary path gives byte parity.
- **Test home:** two conformance rows (`Expect: 100-continue`, `Expect: <token>`), `served` on both
  runtimes, and the raw reply asserted to contain no `100 Continue` and no `417`.

### 3.12 Release shape

- **Decision:** No public API changes: no new export, no changed signature, no new capability token.
  The entries are a CHANGELOG `### Added` entry (Node listener; `--devtool` on Node) and a
  `### Changed` entry (the development entry is runtime-neutral, and existing entries are still
  recognized; `UNSUPPORTED_TRANSPORT_ERROR` text). There is no BREAKING entry.
- **Why:** The behaviour on Node changes from a refusal to a working listener. Nothing could depend
  on the refusal except a caller that wanted no connector, and such a caller does not register
  `DiagnosticsPlugin`.
- **Test home:** `pnpm run release:verify <version>` (changelog coverage).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `ILocalDiagnosticsListenerFactory` and every other published
interface are unchanged.

No symbol is added to or removed from any `src/index.ts`. Internal symbols this plan adds, and the
code path that reads each:

| Exported symbol                                          | Kind     | Consumer / real code path that READS it                                                     |
| -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `NodeLocalDiagnosticsListenerFactory` (internal)         | class    | `createLocalDiagnosticsListenerFactory` on `platform === 'node'`, called by `RuntimePlugin` |
| `NodeListenerHost`, `NodeListenerServer` (internal)      | types    | the Node factory's constructor; the unit suite's fake host                                  |
| `NODE_LISTENER_SERVER_OPTIONS` (internal)                | const    | the Node factory's `createServer` call; the real-socket suite's timing bounds               |
| `PARSER_REFUSAL_BYTES` (internal)                        | const    | the Node `clientError` handler; the conformance table's `transport-refusal` row             |
| `mapWebRequestWithTarget` (internal)                     | function | the Node listener's request path                                                            |
| `planNodeDevtool` (internal, cli)                        | function | `new.ts`, `app.ts`, `devtool.ts` Node arms                                                  |
| `NODE_DEVTOOL_DEV_SCRIPT` (internal, cli)                | const    | `planNodeDevtool`; `nodeRunner`'s selected-member script name is `dev`, asserted equal      |
| `devtoolDevRunner(runtime)` (internal, signature change) | function | `devtool.ts` workspace arm                                                                  |
| `renderDevEntry(input, runtime)` (internal, sig change)  | function | `new.ts`, `app.ts`, `devtool.ts`, `workspace.ts` (port reallocation)                        |

### 4.1 Options — every option names its consumer

| Option                                     | Consumer                               | Behavior (per implementation)                                                                                                          |
| ------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `LocalDiagnosticsListenerOptions.port`     | both factories                         | Validated `1024`–`65535` before any bind; bound on `127.0.0.1`.                                                                        |
| `LocalDiagnosticsListenerOptions.handler`  | both factories                         | Called with the mapped `IRequest`; a throw answers `refusalResponse(503, 'unavailable')`.                                              |
| `LocalDiagnosticsListenerOptions.onListen` | both factories                         | Deno: passed to `Deno.serve`. Node: called on `'listening'` with `{ hostname: '127.0.0.1', port }`. Both: absent → the default banner. |
| `setu new` / `generate app` `--devtool`    | `planNodeDevtool` (Node), Deno planner | Node: §3.8. Deno: unchanged except the entry rendering (§3.7). Bun/Workers: refused.                                                   |
| `setu devtool enable --devtool-port`       | both arms                              | Unchanged semantics on Node: allocated port or the requested one.                                                                      |

## 5. Implementation files

| File                                                                   | Purpose                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/index.ts`                                        | Unchanged (no new export); listed so the barrel is checked                                                                                                                                                                                         |
| `packages/runtime/src/diagnostics/local-diagnostics-listener.ts`       | Shared constants, `refusalResponse`, `nativeFramingRefusal`, unsupported factory, dispatcher (§3.1, §3.4)                                                                                                                                          |
| `packages/runtime/src/diagnostics/local-diagnostics-framing.ts`        | The shared refusal surface (error texts, singleton headers, `refusalResponse`, `nativeFramingRefusal`), split out in review so neither listener file imports the dispatcher back (no import cycle); re-exported by `local-diagnostics-listener.ts` |
| `packages/runtime/src/diagnostics/deno-local-diagnostics-listener.ts`  | The Deno classes, moved unchanged                                                                                                                                                                                                                  |
| `packages/runtime/src/diagnostics/node-local-diagnostics-listener.ts`  | The Node factory, listener, host seam, request path, `clientError`, server options (§3.1–§3.5)                                                                                                                                                     |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`                | `mapWebRequestWithTarget` (§3.2)                                                                                                                                                                                                                   |
| `packages/runtime/src/plugin/runtime-plugin.ts`                        | Only if the dispatcher's signature needs the Node host passed through; otherwise unchanged                                                                                                                                                         |
| `packages/cli/src/devtool/planner.ts`                                  | `devtoolRuntimeRefusal` narrowed; `devtoolDevRunner(runtime)` (§3.8, §3.10)                                                                                                                                                                        |
| `packages/cli/src/devtool/dev-entry.ts`                                | Runtime-neutral rendering; previous renderings kept as variants (§3.7)                                                                                                                                                                             |
| `packages/cli/src/devtool/npm-manifest.ts`                             | `planNodeDevtool`, `NODE_DEVTOOL_DEV_SCRIPT` (§3.8)                                                                                                                                                                                                |
| `packages/cli/src/commands/devtool.ts`                                 | Node standalone and workspace arms calling `planNodeDevtool` (§3.8)                                                                                                                                                                                |
| `packages/cli/src/commands/new.ts`, `packages/cli/src/commands/app.ts` | Node `--devtool` arms (§3.8)                                                                                                                                                                                                                       |
| `packages/cli/src/templates/project-files.ts`                          | The scaffold path's `dev` script and devDependency for a Node devtool project, via `planNodeDevtool` (§3.8)                                                                                                                                        |
| `packages/cli/src/workspace/dev-runner.ts`                             | `nodeRunner` devtool path (§3.10)                                                                                                                                                                                                                  |
| `packages/cli/src/commands/workspace.ts`                               | Port reallocation passes the runtime to `renderDevEntry` (§3.7)                                                                                                                                                                                    |
| `scripts/test-lanes.ts`                                                | Lane moves (§3.6)                                                                                                                                                                                                                                  |
| `scripts/inspect-local-diagnostics.ts`                                 | Runs on Node unchanged; only its header comment changes (no longer "Deno")                                                                                                                                                                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                             | src covered                                                           | Key assertions (and the signature each call type-checks against)                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/test/unit/local-diagnostics-listener.test.ts` (existing, both lanes)                                                | `local-diagnostics-listener.ts`, `deno-local-diagnostics-listener.ts` | Existing cases; dispatcher returns the Node factory on `'node'`, refusing on `'bun'`/`'cloudflare-workers'`; new `UNSUPPORTED_TRANSPORT_ERROR` text. `createLocalDiagnosticsListenerFactory(platform, host?)`.                                 |
| `packages/runtime/test/unit/node-local-diagnostics-listener.test.ts` (new)                                                            | `node-local-diagnostics-listener.ts`                                  | Fake `NodeListenerHost`: port validation before `createServer`; one active; `'error'` rejects and frees the slot; `onListen` mapping; default banner via writer seam; §3.2 table; handler throw → 503; streaming snapshot → 503; double close. |
| `packages/runtime/test/integration/node-local-diagnostics-listener-real.test.ts` (new, Node)                                          | `node-local-diagnostics-listener.ts`                                  | Real sockets: `EADDRINUSE` rejects; slowloris closed within bound; close < 1 s with idle + partial sockets; 33rd connection; raw duplicate `X-Setu-*` lines refused via `rawHeaders`; real-client peak connections ≤ 16.                       |
| `packages/runtime/test/integration/local-diagnostics-listener-conformance.test.ts` (new, both)                                        | both listener files through `RuntimePlugin`                           | §1a rows as data with per-runtime expected outcome class (§3.6).                                                                                                                                                                               |
| `packages/runtime/test/unit/fetch-mapping.test.ts` (existing, extended)                                                               | `fetch-mapping.ts`                                                    | `mapWebRequestWithTarget(raw, url)` keeps `url`/`path` verbatim for dot segments, backslash, empty query and fragment; `raw.url` ignored.                                                                                                      |
| The 16 diagnostics-plugin suites + `test/inspect-local-diagnostics.test.ts` + Redis realtime suite (moved to both lanes)              | `diagnostics-plugin/src/**` (unchanged) through the Node listener     | Unchanged assertions; Deno APIs replaced per §3.6.                                                                                                                                                                                             |
| `packages/cli/test/unit/dev-entry.test.ts` (existing, extended)                                                                       | `dev-entry.ts`                                                        | Variant table through `isDevEntry`/`devEntryPort`; no `Deno.`/`process.` in output; `renderDevEntry(input, runtime)`.                                                                                                                          |
| `packages/cli/test/unit/devtool-npm-manifest.test.ts` (new)                                                                           | `npm-manifest.ts`                                                     | One row per §3.8 shape → write or refusal; `planNodeDevtool(...)`.                                                                                                                                                                             |
| `packages/cli/test/unit/devtool-planner.test.ts` (existing, extended)                                                                 | `planner.ts`                                                          | Refusal set as data: `deno`/`node` → none; `bun`/`cloudflare-workers` → message naming Deno or Node; `devtoolDevRunner('node').path === 'scripts/dev.mjs'`.                                                                                    |
| `packages/cli/test/unit/devtool-refusals.test.ts`, `devtool-manifest-merge.test.ts`, `devtool-lifecycle.test.ts` (existing, extended) | `commands/devtool.ts`                                                 | Node standalone + workspace arms; dry-run lists the same writes; second run is a no-op; stale `scripts/dev.mjs` refused.                                                                                                                       |
| `packages/cli/test/unit/new-command.test.ts`, `app-command.test.ts` (existing, extended)                                              | `commands/new.ts`, `commands/app.ts`, `templates/project-files.ts`    | `--devtool` on Node emits `main.dev.ts`, `scripts.dev`, the devDependency; Bun still refused.                                                                                                                                                  |
| `packages/cli/test/unit/workspace/dev-runner.test.ts` (existing, extended)                                                            | `workspace/dev-runner.ts`                                             | §3.10 rendered-text assertions.                                                                                                                                                                                                                |
| `packages/cli/test/unit/reallocate.test.ts` (existing, extended)                                                                      | `commands/workspace.ts`                                               | Reallocation on a Node member rewrites the runtime-neutral entry at the new port.                                                                                                                                                              |
| `packages/cli/test/unit/workspace/compose.test.ts` (existing, extended)                                                               | `workspace/compose.ts` (unchanged; regression assertion)              | §3.9.                                                                                                                                                                                                                                          |
| `packages/cli/test/e2e/dev-runner-e2e.test.ts`, `devtool-e2e.test.ts` (existing, extended)                                            | the generated runner and project                                      | §3.10, §3.11.                                                                                                                                                                                                                                  |
| `test/test-lanes.test.ts` (existing, extended)                                                                                        | `scripts/test-lanes.ts`                                               | The moved entries and `DENO_ONLY_SOURCES` contents.                                                                                                                                                                                            |

Every existing test file named above was confirmed with `ls` on 2026-10-28.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m126-node-diagnostics-listener
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run ci:local           # all CI shards on the final commit (memory: use-ci-local-for-milestones)
pnpm run test:deno-lane     # the moved suites still pass on Deno, listener coverage on the Deno lane
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

The per-file coverage tables, ANSI-stripped, are read for every touched `src` file on both lanes.
`packages/cli/test/e2e/devtool-e2e.test.ts` and `dev-runner-e2e.test.ts` must run, not skip, and
their Node cases are listed in the PR evidence.

## 8. Risks & mitigations

- **Converting 17 suites off `Deno.*` changes a test that guards M98b's security cases.**
  Mitigation: the conversion is mechanical (§3.6 table), lands as its own commit before any Node
  listener code, and must pass on the Deno lane unchanged. Only then does the Node listener make
  them pass on Node.
- **Node's `clientError` fires for reasons other than parse errors** (`ECONNRESET`, a timeout after
  a partial write). Mitigation: §3.3 writes only on a writable socket and never on `ECONNRESET`; the
  slowloris and reset cases are in the real-socket suite.
- **`maxConnections: 32` could starve the real client if it opens a larger pool.** Mitigation: the
  native client is the only caller, and §3.3's peak-connection measurement drives that client
  against the real server and asserts its peak is at most half the cap.
- **Changing the Deno entry rendering breaks the devtool's byte-identical recipe catalog.**
  Mitigation: the old rendering stays a recognized variant (§3.7), so existing projects keep working
  with the CLI. The devtool's catalog is regenerated from the pinned CLI at its next pin move
  (D03b/D06), which the devtool roadmap already requires.
- **A Node scaffold in a workspace hoists `diagnostics-plugin` into the root `node_modules`, where a
  sibling could import it.** Mitigation: importing it does nothing without an explicit
  `DiagnosticsPlugin({ enabled: true, … })` composition and a pair (M98b T13). The image installs
  only the selected member's production dependencies (`--omit=dev --workspace`).

## 8a. Design security review

Written as a delta against `docs/diagnostics-security-review.md`, whose threat IDs are used here.
The committed-tree audit (`.roo/skills/security-audit/SKILL.md`) runs on the PR's merge commit in a
fresh context and checks each obligation with a positive control.

| Threat / case                                      | Delta introduced by M126                                                                   | Obligation and its proof                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T13 unintended exposure                            | A second runtime can now bind.                                                             | Without `DiagnosticsPlugin` or `enabled: true`, no socket on Node (the 16 suites' existing exposure cases, now on Node); the application port serves no `/v1/*`; Bun refuses. |
| Bind address                                       | Node `listen` takes a host argument the factory controls.                                  | `server.address().address === '127.0.0.1'` asserted after bind; no option widens it (§3.4).                                                                                   |
| DNS rebinding / Host                               | Node's `requireHostHeader` turned off; listener refuses missing Host itself.               | Conformance rows: missing, invalid, duplicate and non-loopback `Host` all refused on both runtimes.                                                                           |
| Request-target aliasing                            | A Node wrapper would normalize the target (§1a).                                           | §3.2; conformance rows for dot segments, backslash and absolute-form refused on both runtimes.                                                                                |
| Header smuggling / duplicate singleton lines       | Node sees raw lines.                                                                       | `rawHeaders` multiplicity refusal (§3.2 step 3) plus the comma check; real-socket rows.                                                                                       |
| Request smuggling (TE/CL)                          | Node parser.                                                                               | `insecureHTTPParser: false` asserted in `NODE_LISTENER_SERVER_OPTIONS`; TE+CL and dual-CL rows → transport refusal.                                                           |
| Reflection / fingerprinting in refusals            | Node default `clientError` and node-server error writers.                                  | Fixed bytes (§3.3); node-server not on the path (§3.1); every refusal row asserts the exact bytes; a canary in the request line and headers never appears in any reply.       |
| Resource exhaustion (slowloris, connection flood)  | Node keeps sockets until its timeouts are checked.                                         | §3.3 options; slowloris and 33rd-connection tests; close bounded (§3.5).                                                                                                      |
| T1/T11 credential handling in the launcher handoff | Credentials now pass through npm → sh → tsx → node, and through the Node workspace runner. | Entry reads via `runtime.env` and never prints (§3.7); runner blanks siblings (§3.10, `/proc` assertion); the canary suite (security review case 10) runs on Node.            |
| Connection flood (T8, audit F1)                    | A connection cap that refuses newcomers locks the paired client out.                       | §3.13 oldest-idle eviction; regression test with 32 held sockets and 8/8 client snapshots served.                                                                             |
| Interim and expectation replies (audit F2)         | Node's default `100 Continue` / `417` sit outside the fixed refusal family.                | §3.14; conformance rows assert neither appears.                                                                                                                               |
| Process ownership                                  | The Node runner detached members from the launcher's group.                                | No `detached` under selection (§3.10); e2e asserts the group and that no process survives a group SIGTERM (§3.11).                                                            |
| Production image                                   | Node image could carry the connector.                                                      | §3.9 assertions on the Dockerfile and on `dist/main.js`.                                                                                                                      |

## 9. Out of scope

- **Bun.** `Bun.serve` resembles `Deno.serve` and Bun runs `node:http`. A follow-up letter is taken
  only when the devtool asks for Bun; until then `devtoolRuntimeRefusal('bun')` and the factory's
  Bun refusal stay.
- **Workers.** No loopback socket of its own; inspecting one needs a different transport design.
- **Removing the pair from the application's environment after it is read.** M98b's handoff text
  says application subprocesses "must not inherit these dedicated variables unnecessarily", and no
  runtime does this today: `IRuntimeServices.env` is read-only, so it needs a `common` change. The
  §8a review records it as an open item for the maintainer. It is not silently added here.
- **Devtool repository work:** npm discovery, the Node recipe catalog, launching `npm run dev`, and
  teardown across npm → sh → tsx → node belong to devtool milestone D06.
- **A Node runner variant list.** A stale `scripts/dev.mjs` is refused with the delete-and-rerun
  remedy, as M98c refuses a stale `scripts/dev.ts`. Recognizing and rewriting older runners in place
  is not added.
