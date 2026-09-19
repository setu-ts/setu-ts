# Milestone 98b — Runtime-Owned Local Diagnostics Connector

> **Status:** Planning; depends on M98a, whose APIs below are proposed, not shipped. Authored on
> `docs/m98-secure-devtool-diagnostics`. Implementation branch:
> `feat/m98b-local-diagnostics-connector`; implementation and fixes stay there until merge.

## 0. Objective & scope

Connect a native devtool client to M98a's minimized diagnostic snapshots and events over a separate,
runtime-owned authenticated IPv4 loopback HTTP listener. The first implementation supports Deno and
bounded polling. It has no browser-facing UI, application-data reads or application-control
commands. Authentication remains independent of any devtool subscription.

- **In scope:** a runtime-owned local-listener port, new optional connector plugin, native client
  helper, session authentication/revocation, resource limits, protocol fixtures and a real loopback
  consumer exercise.
- **NOT this milestone:** M98a owns capture/projection. Node/Bun connector support, Workers,
  browser/WebSocket transports, remote connections, persistence, payload capture and mutation
  operations remain the explicitly deferred M98 follow-ons in ROADMAP.md. The runtime listener port
  is limited to this local, Deno-only transport; it is not a generic second HTTP server API.

## 1. Contracts verified from SOURCE (not names)

Current-source references describe base `c9cd53d7`. Rebase after M98a and verify its actual merged
signatures before implementation; do not silently treat this plan's proposed contract as shipped.

| Reference              | Source (file:line)                                                    | Verified surface / fact                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IPlugin`, context     | `packages/common/src/plugin.ts:477`, `:538`                           | Plugins register services/hooks through context; context exposes the owning application.                                                                  |
| Capability tokens      | `packages/common/src/tokens.ts:39`                                    | Standard tokens live in `CAPABILITIES`; the new lower-kebab-case listener token must be added there and declared by its provider/consumer.                |
| Runtime primitives     | `packages/common/src/runtime.ts:303`                                  | `platform()`, `hrtime()`, random bytes, timers and `subtle` supply the required platform/expiry/crypto operations.                                        |
| `IHttpAdapter`         | `packages/common/src/runtime.ts:459`                                  | The application adapter has one mutable handler and `listen()` binds its socket. It cannot safely be reused or cloned for a second listener.              |
| Adapter ownership      | `packages/runtime/src/plugin/runtime-plugin.ts:171`, `:186`, `:202`   | RuntimePlugin owns registration of runtime services and the application HTTP adapter; another plugin must not create a server.                            |
| Deno adapter           | `packages/runtime/src/adapters/deno/deno-http-adapter.ts:255`, `:281` | Runtime code can construct this adapter; its `listen(port, hostname)` accepts an explicit numeric IPv4 hostname.                                          |
| Runtime server rule    | `AI_GUIDELINES.md:239`                                                | Plugins cannot directly create HTTP servers; runtime owns the server abstraction.                                                                         |
| Lifecycle teardown     | `packages/kernel/src/application/application.ts:295`, `:546`          | Startup failures run close hooks; normal stop runs stopping/shutdown/close phases. Revocation must also work independently of parent shutdown.            |
| HMAC support precedent | `packages/auth-plugin/src/services/jwt-service.ts:183`                | Existing JWT verification calls runtime Web Crypto. This plugin uses the same standard primitive directly, without importing auth-plugin internals.       |
| Proposed M98a reader   | `plans/milestone-98a-kernel-diagnostics.md`, §3.2                     | `IApplication.diagnostics`, `IDiagnosticsSource.snapshot/read` and bounded DTOs are dependencies to be delivered by M98a, not present on the base commit. |
| Publication list       | `scripts/release-packages.ts:20`                                      | New workspace members must be in the publish order; this plugin belongs after common/kernel/runtime.                                                      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                             | Resolution (picked side)                                                                                                                                           | Doc deliverable (same PR)                                             |
| -- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| C1 | ROADMAP leaves the local transport and supported runtimes to the plan.               | Select Deno, native client, IPv4 loopback HTTP polling. Reject every other runtime rather than exposing a fallback endpoint.                                       | Update M98b scope, PUBLIC_API.md, ARCHITECTURE.md and the new README. |
| C2 | Existing HTTP adapters are stateful and the application already owns one.            | Add one dedicated, runtime-owned local-diagnostics listener port. The connector supplies its handler but never receives an adapter or creates a child application. | Document the listener's narrow contract and composition example.      |
| C3 | ROADMAP refers to bounded streaming and pairing credentials without a wire protocol. | Use bounded polling, launch-time out-of-band pairing, authenticated request/response bytes and strict sequence replay protection.                                  | Add a versioned protocol document and native-client security model.   |

The listener implementation is added to `packages/runtime`; the connector depends on its new, narrow
capability and never imports a runtime adapter or calls `listen()`.

## 3. Design decisions

### 3.1 Public composition and listener lifecycle

The proposed runtime-owned port is the following exact common surface; `handler` accepts the
normalized framework request and returns the framework response, so the connector has no raw socket,
web `Request`, adapter or server-handle access.

```typescript
interface LocalDiagnosticsListenerOptions {
  readonly port: number;
  readonly handler: (request: IRequest) => IResponse | Promise<IResponse>;
}

interface ILocalDiagnosticsListener {
  close(): Promise<void>;
}

interface ILocalDiagnosticsListenerFactory {
  listen(options: LocalDiagnosticsListenerOptions): Promise<ILocalDiagnosticsListener>;
}
```

- **Decision:** Add `ILocalDiagnosticsListenerFactory` and `ILocalDiagnosticsListener` to common
  plus `CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER`. `RuntimePlugin` always provides this factory. Its
  sole method is `listen({ port, handler }): Promise<ILocalDiagnosticsListener>`: it permits one
  active listener, binds only `127.0.0.1`, accepts no hostname/adapter/body-limit option and returns
  only `close()`. The Deno factory creates and owns a private `DenoLocalDiagnosticsListener` inside
  `packages/runtime`; it uses the internal Deno serve-host seam and
  `mapWebRequestToFrameworkRequest`, without exposing an adapter or server handle. Node, Bun,
  Workers and unknown platforms reject with one fixed unsupported-transport error before any bind.
  The factory validates port 1024..65535 and uses a zero-body policy. Before mapping to `IRequest`,
  its native `Request` handler rejects any `Transfer-Encoding`, a `Content-Length` other than absent
  or exactly `0`, and comma-containing singleton `Host`, `X-Setu-Session`, `X-Setu-Sequence`,
  `X-Setu-Instance` or `X-Setu-Mac` values. Those grammars contain no comma, so the check rejects a
  duplicate line that the Fetch `Headers` interface coalesced. Deno does not expose raw header-line
  multiplicity after HTTP parsing; this plan therefore makes no raw-wire preservation claim and
  proves the parser/normalization boundary with real-socket duplicate-header tests. The connector
  handler repeats semantic header validation after mapping as defence in depth. RuntimePlugin
  registers a close hook that closes an active local listener on every shutdown/failure path;
  connector revocation and that hook share the same idempotent close operation.
- Export `DiagnosticsPlugin(options): IDiagnosticsPlugin`, where
  `IDiagnosticsPlugin extends IPlugin` with `revoke(): Promise<void>`. The plugin name is
  `diagnostics-plugin`, with `dependencies: [CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER]` and no
  provided capability token. `ctx.app.diagnostics` is required; refuse startup with a fixed error if
  M98a was not enabled.
- Require explicit options `{ enabled: true, port, sessionId, sessionKey }`. Omitted plugin means no
  work; no environment variable auto-enables it. The options are validated before listener
  construction. An omitted/false `enabled`, unsupported runtime, invalid port, invalid session or
  missing diagnostics refuses activation. This is an explicit development composition, not
  production auto-discovery.
- The connector resolves `ILocalDiagnosticsListenerFactory` through the declared capability, gives
  it the private protocol handler and explicit port in `onBootstrap`, and retains only the returned
  listener. It does not import `@setu-ts/runtime`, construct `DenoHttpAdapter`, call `IHttpAdapter`,
  create a child application or receive a server handle. Port conflict fails closed; do not scan or
  fall back to another address.
- Install parent cleanup hooks before opening the runtime listener in `onBootstrap`. `revoke()`
  immediately disables authorization, discards key references and closes the listener; it is
  idempotent and does not stop the parent application or M98a's in-process reader. Register it for
  `onStopping` and `onClose`, covering failed parent startup too. A generation/closed check after
  every asynchronous startup step ensures revocation during bind closes any late-created listener.
  No detached task may reopen it. A revoked/expired plugin instance cannot be reactivated; pairing
  again requires a fresh development application launch in this version.
- **Test home:** runtime `local-diagnostics-listener.test.ts`; connector `plugin.test.ts`,
  `activation.test.ts`, `lifecycle.test.ts`.

### 3.2 Pairing and attacker model

- **Decision:** Pair through the native devtool's trusted application launcher. Before launch it
  generates a fresh 32-byte random key and independent 16-byte random session ID; it passes them to
  the application's explicit diagnostics configuration through the child process environment, never
  command-line arguments, URLs, stdout, workspace files or captured diagnostic records. The
  application composition reads them through `IRuntimeServices.env`, validates/decodes them and
  passes explicit options. The plugin itself does not read environment variables. The native client
  holds the matching values in memory. No short human-chosen pairing code is supported.
- Environment inheritance is part of the trusted-launcher boundary, not a claim of secret storage:
  the launcher must restrict access to the child process, and application subprocesses must not
  inherit these dedicated variables unnecessarily. Code/processes with the developer account's
  privileges can already access application secrets and are outside isolation guarantees. Sharing a
  session/key across applications is unsupported; examples and fixtures generate a new pair for
  every launch. Secrets are never sent to a license service or analytics collector.
- Protect against unpaired local clients, hostile browser origins, replayed signed requests,
  accidental public mounting, cross-application mixups and response substitution. Loopback HTTP
  provides no encryption: authenticated bytes are not confidential against a privileged local
  sniffer. Remote tunnels/proxies, shared untrusted hosts and production use are outside this
  transport's supported threat model. Do not advertise it as TLS or a secure remote debugger.
- Key material is copied into a non-extractable Web Crypto HMAC-SHA-256 key; discard/zero the
  connector's temporary raw copy after import. Do not promise erasure of caller-owned copies or
  garbage-collected process memory. Validate input without printing it.
- **Test home:** `session.test.ts`, `client.test.ts`, `security.test.ts`, protocol fixtures.

### 3.3 Wire protocol v1 and mutual authentication

- **Decision:** Use Web Crypto HMAC-SHA-256 to authenticate every request and response. The shared
  key is never transmitted. This is a new application protocol requiring security review before
  implementation acceptance; standard primitives alone do not certify the protocol.
- Three GET operations only: `/v1/status`, `/v1/snapshot`, and `/v1/events?after=<N>&limit=<N>`. The
  events target has exactly this order and both parameters; accept only canonical non-negative
  decimal `after` and `limit` in 1..128. No request body, duplicate/unknown query field, extra path,
  encoded-path alias, upgrade, redirect, or write method is accepted. The client follows no
  redirects.
- Require exact `Host: 127.0.0.1:<port>` and matching request URL authority. Reject any `Origin`
  header, including `null`: this endpoint supports native clients only. Reject preflight and emit no
  CORS permission. Host/Origin are additional checks, never authentication. Reject forwarding
  headers and requests declaring a body (`Transfer-Encoding` or nonzero `Content-Length`); never
  parse, buffer or inspect a body. The native helper uses `credentials: 'omit'` and sends no
  cookies.
- Authentication headers are `X-Setu-Session` (32 lowercase hex), `X-Setu-Sequence` (canonical
  decimal safe integer starting at 1), `X-Setu-Instance` (empty only on the initial status request),
  and `X-Setu-Mac` (64 lowercase hex). Reject malformed/combined duplicate forms before crypto. MAC
  input is the UTF-8 encoding of these exact newline-separated fields, with no final newline:

```text
setu-diagnostics-v1
request
<sessionId>
<instanceId-or-empty>
<sequence>
GET
127.0.0.1:<port>
<canonical-target>
```

- Compare via `subtle.verify`, not string equality. After verification, recheck active generation,
  monotonic expiry and sequence, then atomically advance the session's highest accepted sequence
  before reading diagnostics. Only strictly increasing sequence numbers are accepted. The native
  client serializes requests and never reuses a number, including after network failure. Exhaustion
  at `Number.MAX_SAFE_INTEGER` ends the session rather than wrapping. Replayed or racing requests
  cannot both pass the final synchronous check. No unbounded nonce cache exists.
- The first signed `/v1/status` response carries `{ version: 1, instanceId, expiresInMs }` and binds
  the client's session to M98a's non-null instance UUID. Later requests must supply that exact ID,
  including subsequent status requests. Session ID/key are per launch; obtaining a UUID alone grants
  nothing. The server must not accept an empty instance ID after the initial status exchange.
- Serialize each response body once to UTF-8 JSON, then sign the following fields. `<sequence>` is
  exactly the accepted `X-Setu-Sequence` value from the request that produced this response; there
  is no response counter. Send the signature as `X-Setu-Mac`; the native client checks it over the
  exact bounded response bytes and the sequence it allocated for that request before parsing,
  displaying or persisting anything:

```text
setu-diagnostics-v1
response
<sessionId>
<instanceId>
<sequence>
<canonical-target>
<HTTP-status-code>
<lowercase-hex-SHA-256-of-body-bytes>
```

- Include `X-Setu-Instance` in the response so the first status MAC can be verified. This header is
  authenticated by the response MAC and the parsed status body must agree with it. Request and
  response domain separation prevents reflection. Signed authenticated errors use a fixed
  `{ version: 1, error: <code> }` shape. Codes are `invalid-request`, `unauthorized`, `expired`,
  `unsupported-version`, `unavailable`, `rate-limited`; no reflected input, error causes or stack.
  Unauthenticated refusals reveal no diagnostic data and need not be signed; the client treats an
  unverifiable response as a connection failure, never an application result.
- All responses use `Cache-Control: no-store`, `Content-Type: application/json` and
  `X-Content-Type-Options: nosniff`. The source's DTO version and instance must match the session.
  The snapshot response body is M98a's compact final snapshot JSON, not an envelope; measure its
  exact UTF-8 bytes again before signing/sending and refuse an over-limit internal result with the
  fixed `unavailable` error. Validate and re-project responses against the exact M98a field
  allowlist before serialization; do not spread an arbitrary provider result into output. Never pass
  a raw error to the logger.
- **Test home:** `protocol.test.ts`, `authentication.test.ts`, `client.test.ts`, `security.test.ts`.
  Include independent fixed HMAC vectors and raw HTTP adversarial cases; a server and client sharing
  the same canonicalization bug must not be the only evidence.

### 3.4 Bounds, expiry and revocation

- **Decision:** One paired native client per plugin instance; one in-flight request per client.
  Lifetime defaults to 15 minutes, with optional `ttlMs` from 1 through 3,600,000 milliseconds.
  Expiry uses the runtime monotonic clock from activation, not wall-clock time. Every authentication
  and post-await response path rechecks session state; a response in flight at revocation is
  discarded rather than releasing later diagnostic data. Already delivered bytes cannot be recalled.
- A single runtime timer triggers `revoke()` at expiry; clear it on every startup/close/failure
  path. A failure closing the listener does not restore authorization. Report only a fixed local
  error. Repeated revoke calls await the same cleanup promise.
- Fixed server limits: maximum 8 simultaneous connector handlers, maximum 8 KiB total parsed header
  bytes, 128 events per read and 256 KiB response body. Raw-validation refusals use a dedicated
  anonymous bucket of 5 requests/second with burst 10 and never debit the session budget. After
  successful MAC/session verification, only the paired session's bucket of 20 requests/second with
  burst 40 using `hrtime` applies. A matching session ID may enter a separate bounded authentication
  lane, but cannot debit the authenticated bucket until `subtle.verify` succeeds; it has a distinct
  concurrency cap and no snapshot/read access. Reserve one connector-processing slot for a
  successfully authenticated request, while anonymous/authentication lanes together use at most
  seven. Thus a flood of malformed, wrong-session or wrong-MAC requests cannot consume the paired
  client's request budget or all processing slots. Reject before crypto where a structural/native
  check fails, before snapshot copying where authentication/rate admission fails, and never log a
  supplied header. Header budgets are application-level limits after HTTP parsing; native adapter
  parsing remains a runtime responsibility, not a protection this plugin can claim to implement.
- Reads are immediate bounded polling, not long polling, SSE or WebSockets. No per-client event
  queue, application subscription, raw log sink, database, file or background export is created. The
  client reads at most 256 KiB through the response stream and cancels on overflow; checking
  `Content-Length` alone is insufficient. It has a 5-second abort deadline through an injected
  timing seam. All client deadlines are cleared after completion or `close()`.
- Diagnostic counters remain in-process and value-free. Invalid authentication cannot include
  supplied headers in logs. There is no global metrics label carrying client-supplied identifiers.
- **Test home:** `limits.test.ts`, `session.test.ts`, `client.test.ts`, `lifecycle.test.ts`.

### 3.5 Real consumer, support and package integration

- **Decision:** Export a native client helper so protocol bytes have one reviewed implementation
  consumed by the extension. `createDiagnosticsClient(options)` returns an `IDiagnosticsClient` with
  `snapshot(): Promise<DiagnosticsSnapshot>`,
  `read(after: number, limit?: number): Promise<DiagnosticsBatch>`, and `close(): void`. It performs
  the signed status exchange automatically before the first data operation. Public call arguments
  obey M98a's validation. Failed initial status pairing is terminal: discard the session and
  relaunch rather than accepting another server under the same identity.
- Client options require `endpoint`, `sessionId`, `sessionKey`, `subtle`, `fetch` and `timing`.
  `endpoint` must be exactly `http://127.0.0.1:<port>` with no credentials, path, query or fragment.
  `timing` is an inline `{ setTimeout(fn, ms): unknown; clearTimeout(handle): void }` port; callers
  in framework applications bind `IRuntimeServices` methods. No ambient runtime globals or new
  optional dependency are needed. Sequential calls reserve unique sequence numbers; `close()` aborts
  pending fetches, drops key references and rejects subsequent calls with a fixed error.
- Add `scripts/inspect-local-diagnostics.ts`, a standalone demonstration that creates a new random
  session, a small explicitly instrumented application and the native client. RuntimePlugin owns the
  local listener used by the connector. Inject a request, display only authenticated/minimized DTOs,
  revoke the connector, verify further reads fail, and prove the application still answers normally.
  No credential appears in output. The demo passes credentials in memory; the README separately
  documents the launcher's environment handoff and its trust limits. The extension repository is not
  claimed tested by this script.
- Add package manifest/README, workspace membership, publish-list entry, JSR metadata, documented
  exports and API/navigation/catalog entries using existing release tooling. Pin the workspace
  version at implementation time. No new npm dependency, no plugin-to-plugin import, no optional
  lazy load. The native helper uses web-standard fetch/Web Crypto supplied by its caller.
- **Test home:** real Deno socket e2e, script subprocess test and publication/documentation gates.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                           | Kind                          | Consumer / real code path that READS it                                                           |
| ----------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `LocalDiagnosticsListenerOptions`         | common options interface      | Runtime factory validates port and retains the connector handler.                                 |
| `ILocalDiagnosticsListener`               | common interface              | Connector revokes the runtime-owned listener without receiving its adapter/handle.                |
| `ILocalDiagnosticsListenerFactory`        | common interface              | RuntimePlugin implementation creates the Deno-only listener; connector resolves it by capability. |
| `CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER` | common token                  | RuntimePlugin provides it; DiagnosticsPlugin declares and resolves it.                            |
| `DiagnosticsPlugin`                       | factory                       | Development application composition and the executable local demo.                                |
| `IDiagnosticsPlugin`                      | interface extending `IPlugin` | Demo/application invokes `revoke()` without stopping the application.                             |
| `DiagnosticsPluginOptions`                | interface                     | Factory validation, listener, session/key and expiry logic.                                       |
| `createDiagnosticsClient`                 | factory                       | Native devtool integration and executable demo; real protocol consumer.                           |
| `IDiagnosticsClient`                      | interface                     | Demo reads snapshots/events and closes the client.                                                |
| `DiagnosticsClientOptions`                | interface                     | Native helper consumes endpoint, session, crypto, fetch and timing dependencies.                  |

Reuse M98a DTOs by type import from common, not duplicate type declarations or barrel re-exports.
Crypto/protocol/session/limit internals are not exported. The listener is the sole new token; it has
one runtime provider and one connector consumer.

### 4.1 Options — every option names its consumer

| Option                                                      | Consumer                           | Behavior (per implementation)                                                       |
| ----------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| Plugin `enabled: true`                                      | factory/activation                 | Required explicit opt-in; no environment fallback.                                  |
| Plugin `port: number`                                       | validation/listen/authority checks | 1024..65535; bind exactly IPv4 loopback; no auto-selection.                         |
| Runtime listener `handler`                                  | runtime listener                   | Receives normalized requests only; runtime owns all adapter/handle operations.      |
| Plugin/client `sessionId: string`, `sessionKey: Uint8Array` | session authentication             | Exactly 16-byte lowercase-hex ID and 32-byte random key from a fresh native launch. |
| Plugin `ttlMs?: number`                                     | expiry timer/auth checks           | Default 900,000; positive safe integer up to 3,600,000.                             |
| Client `endpoint: string`                                   | fetch and signed authority         | Only exact numeric loopback endpoint accepted; redirects refused.                   |
| Client `subtle: SubtleCrypto`                               | MAC/digest/key import              | Required standard crypto interface, no algorithm override.                          |
| Client `fetch: typeof fetch`                                | native request path                | Required injected web-standard fetch; omit browser credentials.                     |
| Client `timing`                                             | request abort deadline             | Required timeout/clear functions; fixed 5-second deadline.                          |

## 5. Implementation files

Connector paths are relative to `packages/diagnostics-plugin/`; common/runtime paths are explicit.

| File                                                                                                                | Purpose                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                                                      | Documented public exports with `@module` first.                                         |
| `src/interfaces/index.ts`                                                                                           | Six public factory/interface contracts and options.                                     |
| `src/plugin/diagnostics-plugin.ts`                                                                                  | Activation, parent lifecycle hooks and revocable IPlugin implementation.                |
| `src/transport/connector-handler.ts`                                                                                | Runtime-factory callback: protocol dispatch only, no adapter/server ownership.          |
| `src/security/session.ts`                                                                                           | Key import, sequence/instance binding, monotonic expiry and revocation state.           |
| `src/security/authentication.ts`                                                                                    | Canonical authenticated bytes, standard HMAC sign/verify and response digest.           |
| `src/protocol/protocol.ts`                                                                                          | Exact operations, DTO validation/projection, bounded fixed error responses.             |
| `src/transport/limits.ts`                                                                                           | Handler/header/rate/response bounds.                                                    |
| `src/client/client.ts`                                                                                              | Native helper, serialized reads, status binding, bounded verification and close.        |
| `packages/common/src/runtime.ts`, `packages/common/src/tokens.ts`, `packages/common/src/index.ts`                   | Narrow local-listener contracts, token and documented exports.                          |
| `packages/runtime/src/diagnostics/local-diagnostics-listener.ts`, `packages/runtime/src/plugin/runtime-plugin.ts`   | Deno-only owned listener, unsupported-platform refusal and capability registration.     |
| `deno.json`, `README.md`                                                                                            | Workspace package, test permissions, composition, lifecycle/privacy/support limits.     |
| `scripts/inspect-local-diagnostics.ts`                                                                              | Real publisher/client/revocation exercise, no credential logging.                       |
| root `deno.json`, `scripts/release-packages.ts`, `scripts/jsr-metadata.ts`                                          | Workspace and publication/metadata registration.                                        |
| `docs/diagnostics-protocol.md`, `PUBLIC_API.md`, `ARCHITECTURE.md`, `docs/plugins.md`, `docs/runtime-deployment.md` | Exact wire specification, public contracts, native-only support and catalog/navigation. |
| `CHANGELOG.md`, `ROADMAP.md`, `CLAUDE.md`, this plan                                                                | Release/tracking updates and plan archival in the implementation PR.                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Package tests below live under `packages/diagnostics-plugin/test/` and use `describe`/`it` with
`expect`. The source coverage bar applies independently to every file, including error paths.

| Test file                                         | src covered                                            | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runtime `unit/local-diagnostics-listener.test.ts` | common runtime/tokens, runtime listener/runtime-plugin | One active listener, exact loopback bind, native pre-mapping header/framing refusal, no adapter/handle escape, body refusal, unsupported-platform refusal, close idempotence and token/provider ordering.                                                     |
| `unit/plugin.test.ts`                             | plugin/interfaces/index                                | `DiagnosticsPlugin(options)` types, explicit activation, option bounds, declared listener dependency and `revoke(): Promise<void>`.                                                                                                                           |
| `unit/connector-handler.test.ts`                  | connector-handler                                      | Protocol handler receives only normalized requests and cannot create/listen/close an adapter.                                                                                                                                                                 |
| `unit/session.test.ts`                            | session                                                | Invalid key/ID, monotonic expiry, key disposal, atomic sequence race, overflow, terminal revoke and instance binding.                                                                                                                                         |
| `unit/authentication.test.ts`                     | authentication                                         | Fixed independent HMAC/SHA-256 vectors, exact canonical bytes, request/response domain separation, bad MAC and mutation of every signed field.                                                                                                                |
| `unit/protocol.test.ts`                           | protocol                                               | Canonical targets, allowed DTO shape, unsupported version, malformed/custom source result and fixed errors.                                                                                                                                                   |
| `unit/limits.test.ts`                             | limits                                                 | Separate anonymous/authentication/session buckets and reserved authenticated slot, burst/refill, concurrent hostile loopback traffic cannot debit/starve a valid session, UTF-8 header counting, body bounds, oversized output and no crypto/read on refusal. |
| `unit/client.test.ts`                             | client                                                 | Public snapshot/read/close, status verification, sequence serialization, modified response, oversized chunked body, redirect, timeout, abort and terminal failed pairing.                                                                                     |
| `integration/activation.test.ts`                  | plugin/connector-handler/interfaces                    | Real parent application: absent plugin opens no socket; missing diagnostics and non-Deno runtime refuse before listening.                                                                                                                                     |
| `integration/security.test.ts`                    | session/authentication/protocol/limits                 | Missing/wrong/replayed/stale/cross-instance credentials, all Origin values, wrong Host/forwarded authority, unknown methods and canary absence; allowed metadata remains observable.                                                                          |
| `integration/lifecycle.test.ts`                   | plugin/connector-handler/session/client                | Revoke and expiration during auth/read/bind, failed parent startup, failed close, no reopening, parent keeps serving.                                                                                                                                         |
| `e2e/local-connector.test.ts`                     | all source modules                                     | Real Deno socket, signed native client, snapshot, request observations, duplicate/coalesced singleton headers and framing refusal before mapping, raw hostile HTTP, port conflict, revocation and socket cleanup.                                             |
| `test/inspect-local-diagnostics.test.ts` (root)   | demo and public exports                                | Subprocess demo shows useful verified DTOs and a still-working application; no key/session environment dump.                                                                                                                                                  |

The package's `deno.json` uses the runtime package's existing `test.permissions` convention, with
`net: ["127.0.0.1"]` for real loopback socket exercises. Keep other permissions absent unless the
test runner's existing workspace setup requires them; do not copy runtime's broad permission set.
Never hide the e2e path behind an absent optional dependency. Injected adapters cover deterministic
failures; they do not substitute for the real socket test. No external package is lazily imported,
so the optional-dependency import gate is not applicable.

Protocol fixtures include independently calculated request/response signatures, rejected targets and
JSON DTOs with synthetic secrets in forbidden fields. Place them under `test/fixtures/`, outside
source coverage. Check server/client code against those bytes, not only against one another.

## 7. Verification gates

```bash
git branch --show-current   # feat/m98b-local-diagnostics-connector during implementation
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage
```

Read the ANSI-stripped per-file table and enforce 90% branch/function/line for every changed source
file. Run the real local demo with socket permissions and capture the positive/negative security
evidence. Inspect all exits for raw error/credential logging and forbidden constructs. Exercise
overload while the parent serves normal requests. Security review must cover bootstrap, MAC
canonicalization, replay races, origin/authority checks and post-await revocation before claiming
the connector safe; passing type checks is not that review.

Commit, run `deno task publish:check`, then `deno task release:verify` with the actual committed
workspace version. Run documentation/API generation and release-list checks for the new package.
Update implementation tracking and archive this single plan in that PR. The current documentation
change makes no claim that these future checks or the external extension's tests have passed.

## 8. Risks & mitigations

- A second listener takes over the application adapter: the runtime factory owns a separate private
  adapter, exposes no adapter/handle to the connector, binds only loopback and has a real
  two-listener test proving the parent handler remains intact.
- Loopback mistaken for authentication/encryption: per-launch authenticated bytes, native-only
  policy, no remote support and explicit local-privilege/confidentiality limits.
- Native launcher leaks environment credentials: exact bootstrap documentation, fresh pair per
  launch, no command-line/file/log handoff and explicit trusted-process boundary.
- Server and client share a protocol defect: independent known-answer fixtures, mutation tests and
  security review before implementation acceptance.
- Session state changes during awaits: recheck generation/expiry/sequence before reads and send;
  invalidate immediately on revoke, then close asynchronously.
- Collector/provider violates DTO contract: fixed projection, byte limits and value-free refusals.
- Supporting every runtime prematurely: fail closed outside the measured Deno transport; broaden
  only with a separately reviewed runtime matrix.

## 9. Out of scope

- M98a: registration/execution instrumentation, snapshots and capture privacy policy.
- M98 follow-ons in ROADMAP.md: persistent/shared captures, payloads, arbitrary logs/errors,
  database/cache/storage reads, queue/scheduler mutation, tenant switching, replay and fault
  injection.
- Browser UI, WebSockets, remote TLS/IPC transports and production access; no implicit fallback.
- Separate devtool repository: native launcher integration, UI, plans/billing and subscription
  enforcement. This plan supplies its protocol/helper and executable reference consumer, not a claim
  that an unseen launcher already implements the bootstrap securely.
