# Milestone 70a — Pipeline bypass fix (`common`, `kernel`, `runtime`, `grpc-plugin`)

> **Status:** Complete. Branch: `feat/m70a-pipeline-bypass`. `main` is protected — all work
> (implementation + fixes) stayed on this one branch until it merged via a single PR.
>
> **Two decisions below were superseded during implementation and are corrected in place, with the
> original reasoning kept so the error is not reintroduced: §3.2 (the `ctx.state` channel, which is
> unreachable from an adapter) and §3.6's implementation route (`content-length`, which is absent on
> the cases that matter). §3.4 gained the `IGrpcService.claims` member the prefix guard needs.**

## 0. Objective & scope

Close the **pipeline bypass** security defect found by the alpha.8 smoke programme.
`setUpgradeRouter` and `setRpcHandler` are consulted in the HTTP adapter **before** the kernel
middleware pipeline, so no middleware applies to WebSocket upgrades or gRPC requests. An
unauthenticated WebSocket writes through a guarded endpoint (X6-1), an unauthenticated gRPC client
reads and writes through one (X7-6), with metrics and security headers absent on both. X7-7 is the
same seam seen from shutdown — RPC serves `200` through the whole drain while ordinary paths answer
`503`.

**The fix:** every inbound request runs the kernel middleware pipeline BEFORE any upgrade or RPC
dispatch, so auth, metrics, security headers and the shutdown drain apply uniformly.

- **In scope:**
  - Carry the undisturbed web `Request` from the adapter into the kernel (`IRequest.raw?`)
  - WebSocket: the pipeline runs first on every upgrade path; the handshake happens only if the
    pipeline does not short-circuit
  - gRPC: dispatch moves into the kernel, after the pipeline and after route matching
  - Remove the pre-pipeline `#rpcStore.consult()` and upgrade consultation from the fetch paths
  - `GrpcPlugin` stops calling `adapter.setRpcHandler`; the kernel resolves `IGrpcService`
  - Tests proving middleware applies to both, on every adapter that can carry them

- **NOT this milestone:** see §9.

## 1. Contracts verified from SOURCE (not names)

Every row below was read from the file at the stated line on this branch's base commit. Rows marked
**CORRECTED** were wrong in the first draft of this plan and are recorded so the error is not
reintroduced.

| Reference                         | Source (file:line)                                                 | Verified surface / fact                                                                                            |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `IHttpAdapter`                    | `packages/common/src/runtime.ts:376`                               | `setHandler`, `fetch`, `listen`, `close`, `setUpgradeRouter?`, `setRpcHandler?`                                    |
| `IRequestContext`                 | `packages/common/src/http.ts:205` **CORRECTED**                    | Lives in `http.ts`, NOT `context.ts` — `packages/common/src/context.ts` does not exist. Fully `readonly`; no `raw` |
| `IResponse`                       | `packages/common/src/http.ts:100` **CORRECTED**                    | Lives in `http.ts`, NOT `response.ts` — `packages/common/src/response.ts` does not exist                           |
| `setUpgradeRouter?` JSDoc         | `packages/common/src/runtime.ts:426`                               | Documents "consulted … _before_ the request is mapped to an `IRequest` and enters the middleware pipeline"         |
| `setRpcHandler?` JSDoc            | `packages/common/src/runtime.ts:446`                               | Same "_before_ … enters the middleware pipeline" wording                                                           |
| `IGrpcService.handleRequest`      | `packages/common/src/services/grpc.ts:125` **CORRECTED**           | `handleRequest(request: Request): Promise<Response>` — returns `Response`, **never `null`**                        |
| `IGrpcService`                    | `packages/common/src/services/grpc.ts:105,131`                     | `addService`, `handleRequest`, `available`                                                                         |
| `Application.#handleRequest`      | `packages/kernel/src/application/application.ts:513`               | Signature is `(request: IRequest)` — the kernel never sees a web `Request`. `#stopping` → `503` at the top         |
| `createRequestContext`            | `packages/kernel/src/context/request-context.ts:56`                | `(request: IRequest, registry: ServiceRegistry, runtime: IRuntimeServices)` — no channel for a raw `Request`       |
| `mapWebRequestToFrameworkRequest` | `packages/runtime/src/adapters/shared/fetch-mapping.ts:37`         | `const bodyBuffer = await request.arrayBuffer();` — unconditional, every request                                   |
| Deno upgrade path                 | `packages/runtime/src/adapters/deno/deno-http-adapter.ts:160`      | Inside `createFetchHandler`; comment asserts "the request body must stay undisturbed"                              |
| Workers upgrade path              | `packages/runtime/src/adapters/workers/cf-http-adapter.ts:80`      | Inside the fetch path; same "body is never read before a handshake" rationale                                      |
| Bun upgrade path                  | `packages/runtime/src/adapters/bun/bun-http-adapter.ts:190`        | **In the `Bun.serve` callback, NOT `createFetchHandler`** — and RPC is deliberately not consulted there (`:176`)   |
| Node upgrade path                 | `packages/runtime/src/adapters/node/node-http-adapter.ts:289`      | **Never reaches the fetch callback** — arrives on the raw `upgrade` event via `attachUpgradeListener(server)`      |
| `UpgradeRouterStore`              | `packages/runtime/src/adapters/shared/upgrade-router-store.ts:18`  | `set(router)`, `consult(request)` → decision or `null`                                                             |
| `RpcInterceptorStore`             | `packages/runtime/src/adapters/shared/rpc-interceptor-store.ts:21` | `set(handler)`, `consult(request)` → `Response` or `null`                                                          |
| `GrpcPlugin.register`             | `packages/grpc-plugin/src/plugin/grpc-plugin.ts:45`                | Calls `adapter.setRpcHandler(grpcService.createFetchHandler())`                                                    |
| Test layout                       | `packages/kernel/test/{unit,integration,fixtures}` **CORRECTED**   | Package tests live under `packages/<pkg>/test/`; root `test/` holds repo-wide gates only                           |

### 1.1 Runtime facts established by probe, not by reading

- **Pre-reading the body does NOT break a conformant WebSocket upgrade.** The adapters' comments
  assert the body "must stay undisturbed", which reads as a hard blocker for running the mapping
  first. Probed against real Deno (`Deno.serve` + a real client upgrade): calling
  `await request.arrayBuffer()` on the upgrade request yields `byteLength=0`, leaves
  **`bodyUsed === false`**, and `Deno.upgradeWebSocket(request)` then **succeeds**. Per the Fetch
  spec `bodyUsed` is "body is non-null AND disturbed", so a bodyless GET is never disturbed.
- **The residual case is a non-conformant upgrade request that carries a body.** There the
  `arrayBuffer()` DOES disturb the request and the handshake would fail where today it succeeds. RFC
  6455 forbids a body on the handshake, so this is a malformed client; §3.6 decides the behaviour
  explicitly rather than discovering it.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                        | Resolution (picked side)                                                                                                      | Doc deliverable (same PR)                                      |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| C1 | `setUpgradeRouter?` JSDoc (`runtime.ts:426`) documents pre-pipeline consultation; this milestone makes it post-pipeline                         | Rewrite the JSDoc: the adapter STORES the router, and the handshake runs only after the pipeline declines to short-circuit    | `packages/common/src/runtime.ts` JSDoc                         |
| C2 | `setRpcHandler?` JSDoc (`runtime.ts:446`) documents pre-pipeline consultation; the kernel now owns gRPC dispatch and nothing calls the setter   | Deprecate (§9.2 — published surface, so deprecate-not-remove) and document that the kernel dispatches gRPC after the pipeline | `packages/common/src/runtime.ts` JSDoc + CHANGELOG deprecation |
| C3 | ARCHITECTURE §10's middleware table describes ordinary HTTP only and says nothing about upgrade/RPC traffic, which is why the bypass read as OK | Add a sentence stating the pipeline runs for ALL inbound traffic including upgrades and RPC                                   | `ARCHITECTURE.md` §10                                          |

## 3. Design decisions

### 3.1 Transporting the raw `Request` into the kernel

- **Decision:** widen `IRequest` with an optional `raw?: Request` in `common`. The adapter attaches
  the undisturbed web `Request` when it builds the `IRequest`; `createRequestContext` reads it and
  exposes it on the context.
- **Why this and not `IRequestContext.raw` alone:** the first draft widened only `IRequestContext`,
  which cannot work — `Application.#handleRequest` takes an `IRequest` and `createRequestContext`
  takes `(IRequest, ServiceRegistry, IRuntimeServices)`, so **no channel exists** to get a web
  `Request` to the place the context is built. Widening `IRequest` is the minimum that makes the
  data path real. `IRequestContext` exposure follows from it.
- **Optional, not required:** `IRequest` is a committed contract with in-repo implementors
  (`testing`, and every adapter). A required field breaks all of them; optional matches the M42
  `signal?` / M44 `fs?` precedent.
- **Test home:** `packages/kernel/test/unit/request-context-raw.test.ts`.

### 3.2 Upgrade and RPC intent travels on `ctx.state`, not on `IResponse`

- **Decision:** when the terminal handler determines an upgrade should proceed, it records that on
  `ctx.state` under a symbol exported from `common`. The adapter reads it after the handler returns.
- **Why not `IResponse.upgradeRequested`** (the first draft's choice): `IResponse` is a published
  value-shaped contract, and hanging a live `WebSocketSink` off it means every response in the
  system is typed as potentially carrying an open socket. `ctx.state` is already the documented
  channel for per-request data between pipeline stages (the M48 session precedent), costs **no
  `common` widening beyond the symbol**, and keeps the socket out of the response contract.
- **CORRECTED during implementation: `ctx.state` does not work either, for the same class of reason
  the first draft's `IRequestContext.raw` did not.** The adapter holds the `IRequest` it built and
  handed to the framework handler; it **never sees the `IRequestContext`**, which the kernel creates
  internally and discards when the handler returns. There is no path by which a value written to
  `ctx.state` reaches the adapter that must perform the handshake. The intent is therefore branded
  onto the **`IRequest`** under the `UPGRADE_INTENT` symbol, through exported
  `setUpgradeIntent`/`upgradeIntentOf` accessors — the M57 `SECURITY_METADATA` precedent, which
  keeps the cast in one place instead of at seven call sites. Everything §3.2 wanted still holds:
  the socket stays out of `IResponse`, and the only `common` widening is the symbol plus its two
  accessors.
- **Test home:** `packages/kernel/test/unit/upgrade-intent.test.ts`.

### 3.3 WebSocket: three adapter shapes, not one

- **Decision:** the "pipeline first, then handshake" rule is uniform; the **mechanism is per
  adapter**, because the upgrade does not arrive on one path.
  - **Deno / Workers** — the upgrade is already inside the fetch path. Move the consultation to
    after the framework handler returns.
  - **Bun** — the upgrade lives in the `Bun.serve` callback (`bun-http-adapter.ts:190`), not
    `createFetchHandler`. The callback must invoke the framework handler itself before calling
    `server.upgrade()`.
  - **Node** — the upgrade **never reaches the fetch callback at all**; it arrives on the raw
    `upgrade` event (`node-http-adapter.ts:289`). `attachUpgradeListener` already builds a `Request`
    to feed `#upgrades.consult`; that same `Request` must be run through the framework handler, and
    the handshake performed only if the handler does not short-circuit.
- **Why this is called out:** the first draft said "all four adapters restructure
  `createFetchHandler` … same restructuring", which is **impossible on Node and Bun**. Their source
  says so directly. Planning one mechanism and discovering two more mid-implementation is exactly
  the failure this section exists to prevent.
- **Test home:** one file per adapter under `packages/runtime/test/unit/`.

### 3.4 gRPC dispatch moves into the kernel terminal handler

- **Decision:** after the pipeline runs and route matching returns no match, the kernel resolves
  `IGrpcService` (optionally — absent the capability nothing changes) and dispatches when the path
  is claimed. `GrpcPlugin` stops calling `setRpcHandler`.
- **Detection is by `basePath` prefix, not by a null return.** `IGrpcService.handleRequest` is typed
  `Promise<Response>` and **never returns `null`** (`grpc.ts:125`) — the first draft's "if gRPC
  returns `null`, fall through to the 404" describes a contract that does not exist. The
  null-returning type is `RpcFetchHandler`, which is the adapter-side seam being retired here. M49
  established that detection is prefix-only anyway, because Connect's unary content types include
  `application/json` and sniffing would hijack ordinary routes.
- **CORRECTED during implementation: naming the rule was not enough — the prefix guard needs a
  member on the contract, and the first implementation shipped without one.** Because
  `handleRequest` never returns `null`, a path outside `basePath` and a claimed path with no such
  procedure both arrive as a `404`, so the kernel cannot recover the distinction after dispatching.
  Without a guard it claimed EVERY unmatched route, changing the whole application's 404 from the
  kernel's `{"error":"Not Found"}` (`application/json`) to gRPC's `Not Found` (`text/plain`) — which
  is exactly the negative control §6 already required, and it was not run. `IGrpcService` therefore
  gains an **optional** `claims?(request): boolean`, implemented over the existing segment-aware
  `isWithinBasePath`. Optional for source compatibility; the kernel treats an implementor that lacks
  it as claiming nothing, because silently claiming everything is the more damaging default.
- **X7-7 falls out for free:** `#stopping` is checked at the top of `#handleRequest`
  (`application.ts:513-518`), so once gRPC is dispatched from inside the kernel it answers `503`
  during the drain like every other path.
- **Test home:** `packages/grpc-plugin/test/integration/grpc-pipeline.test.ts`.

### 3.5 The gRPC body — one decision, not three

- **Decision:** on the gRPC path only, the kernel **reconstructs** a web `Request` from the mapped
  `IRequest` (method, url, headers, buffered body) and passes that to `handleRequest`.
- **Why:** `handleRequest` takes a web `Request` and reads its body, but
  `mapWebRequestToFrameworkRequest` has already consumed the original via `arrayBuffer()`, so
  `ctx.raw` is disturbed for any request that carries a body — and gRPC always does. Reconstructing
  costs nothing on the ordinary path; `request.clone()` before mapping would tax **every** request
  in the application to serve the gRPC minority.
- **Residual risk, stated rather than discovered:** a reconstructed `Request` is not byte-identical
  to the original — trailers in particular do not survive. M49 already records that native
  gRPC-binary trailers work on no runtime this plugin runs on, so this does not regress a working
  path, but it must be asserted rather than assumed.
- **This supersedes three contradictory statements in the first draft** — §3.1 ("reads from the
  `IRequest` body"), §3.5 ("no special handling needed") and §8 ("clone the body before mapping",
  offered as one of two alternatives inside a Risks section). A design decision belongs here,
  decided once.
- **Test home:** `packages/grpc-plugin/test/integration/grpc-pipeline.test.ts`.

### 3.6 A non-conformant upgrade request carrying a body

- **Decision:** it is refused with `400` before the handshake is attempted, rather than being
  allowed to fail inside the runtime's upgrade call with a runtime-specific message.
- **Why:** §1.1 establishes that a conformant (bodyless) upgrade survives the mapping, but one
  carrying a body is disturbed by it and would fail the handshake in a way that differs per runtime.
  RFC 6455 forbids a body on the handshake, so refusing it is correct and makes the behaviour one
  thing on all four adapters instead of four.
- **CORRECTED during implementation: the refusal belongs to the KERNEL, and cannot be driven off
  `content-length`.** The first implementation read that header and so refused nothing in either
  case that matters — an in-process `Request` carries no `content-length`, and neither does a
  chunked upload; measured, an upgrade with a body was answered `101`. The check now reads the
  **mapped** body (`ctx.request.bytes()`), which is already buffered and is authoritative on every
  path. It runs only after the router has ACCEPTED, and closes the sink with code `1006` before
  answering, so a reserved connection slot is not leaked per malformed upgrade.
- **Test home:** the refusal itself is
  `packages/kernel/test/integration/pipeline-runs-for-upgrade.test.ts`, because only the kernel sees
  both the mapped body and the router decision.
  `packages/runtime/test/unit/upgrade-with-body.test.ts` pins the adapter half — that no adapter
  handshakes without an intent.

## 4. Exported surface — every symbol names its consumer

| Exported symbol         | Kind                       | Consumer / real code path that READS it                                              |
| ----------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `IRequest.raw?`         | interface field (widening) | `createRequestContext` (`kernel`) reads it to expose the raw request on the context  |
| `IRequestContext.raw?`  | interface field (widening) | Kernel terminal handler, for the upgrade decision and gRPC reconstruction            |
| `UPGRADE_INTENT` symbol | `const` symbol in `common` | Kernel writes it to `ctx.state`; all four runtime adapters read it after the handler |

`Symbol.for`, not `Symbol()` — two copies of `common` in one process must agree, the M57
`SECURITY_METADATA` precedent.

**No new capability token. No plugin option added or changed.**

### 4.1 Options — every option names its consumer

None. This milestone changes no plugin options.

## 5. Implementation files

| File                                                       | Purpose                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/common/src/http.ts`                              | `IRequest.raw?`, `IRequestContext.raw?`, `UPGRADE_INTENT` symbol               |
| `packages/common/src/runtime.ts`                           | C1/C2 JSDoc; deprecate `setRpcHandler?`                                        |
| `packages/kernel/src/context/request-context.ts`           | Thread `raw` from `IRequest` onto the context                                  |
| `packages/kernel/src/application/application.ts`           | Terminal handler: upgrade intent, then gRPC dispatch on a `basePath` match     |
| `packages/runtime/src/adapters/deno/deno-http-adapter.ts`  | Upgrade consultation moves after the framework handler                         |
| `packages/runtime/src/adapters/workers/cf-http-adapter.ts` | Same                                                                           |
| `packages/runtime/src/adapters/bun/bun-http-adapter.ts`    | `Bun.serve` callback invokes the framework handler before `server.upgrade()`   |
| `packages/runtime/src/adapters/node/node-http-adapter.ts`  | `attachUpgradeListener` runs its `Request` through the framework handler first |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`    | Attach the undisturbed `Request` as `IRequest.raw`                             |
| `packages/grpc-plugin/src/plugin/grpc-plugin.ts`           | Stop calling `adapter.setRpcHandler`                                           |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Paths are package-local (`packages/<pkg>/test/…`), matching the repo layout; the first draft put
these at repo-root `test/`, which holds repo-wide gates only.

| Test file                                                            | src covered                              | Key assertions                                                                                 |
| -------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/kernel/test/unit/request-context-raw.test.ts`              | `request-context.ts`, `http.ts` widening | `ctx.raw` is the same `Request` instance the adapter passed; absent when the adapter omits it  |
| `packages/kernel/test/unit/upgrade-intent.test.ts`                   | `application.ts` terminal handler        | Intent written to `ctx.state` only when no route matched and a router is registered            |
| `packages/kernel/test/integration/pipeline-runs-for-upgrade.test.ts` | `application.ts`                         | A short-circuiting guard prevents the intent being set at all                                  |
| `packages/runtime/test/unit/deno-upgrade-order.test.ts`              | `deno-http-adapter.ts`                   | Framework handler invoked before the handshake; a `401` returns with no handshake attempted    |
| `packages/runtime/test/unit/cf-upgrade-order.test.ts`                | `cf-http-adapter.ts`                     | Same                                                                                           |
| `packages/runtime/test/unit/bun-upgrade-order.test.ts`               | `bun-http-adapter.ts`                    | Serve callback invokes the handler before `server.upgrade()`                                   |
| `packages/runtime/test/unit/node-upgrade-order.test.ts`              | `node-http-adapter.ts`                   | The raw `upgrade` event runs the handler before the handshake                                  |
| `packages/runtime/test/unit/upgrade-with-body.test.ts`               | shared upgrade path                      | §3.6 — an upgrade carrying a body is refused `400` on every adapter                            |
| `packages/runtime/test/integration/upgrade-real-socket.test.ts`      | Deno adapter, real socket                | A real client upgrade still succeeds after the mapping has run — the §1.1 probe, committed     |
| `packages/grpc-plugin/test/integration/grpc-pipeline.test.ts`        | `grpc-plugin.ts`, `application.ts`       | Guard `401`s an unauthenticated RPC; `503` during drain (X7-7); reconstructed body round-trips |
| `packages/grpc-plugin/test/unit/no-rpc-handler.test.ts`              | `grpc-plugin.ts`                         | `register()` does not call `setRpcHandler`                                                     |
| `packages/websocket-plugin/test/integration/guarded-upgrade.test.ts` | end-to-end                               | X6-1 regression: an unauthenticated upgrade is refused; verified to fail without the fix       |

**Negative controls (each observed failing, then reverted):** revert the adapter ordering and the
X6-1 test must fail; remove the `basePath` guard and an ordinary 404 route must start reaching gRPC.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70a-pipeline-bypass, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; 90% branch/function/line every src file
deno task publish:check     # committed tree — this changes common's published surface
```

## 8. Risks & mitigations

- **Node and Bun upgrade paths are separate code paths** (§3.3). Mitigation: named per-adapter
  design and one test file each, rather than one assumed restructuring.
- **Reconstructed gRPC `Request` loses trailers** (§3.5). Mitigation: asserted in the integration
  test; M49 already records native trailers as non-functional on every supported runtime.
- **`IRequest.raw` is optional, so a custom adapter may omit it.** Mitigation: the terminal handler
  treats an absent `raw` as "no upgrade, no RPC" and falls through to the 404 — never throws.
- **Pipeline now runs on upgrade requests.** Intended: that IS the fix. Cost is one middleware chain
  per upgrade, once per connection, not per message.

## 9. Out of scope

- Removing `setUpgradeRouter?`/`setRpcHandler?` from `IHttpAdapter` — §9.2 deprecate-then-remove;
  `setRpcHandler?` is deprecated here and removed no earlier than the next breaking release.
- `packages/graphql-plugin` transport threading — M70i owns GraphQL viability, including whether
  `graphql-plugin`'s own WS path inherits this fix automatically or needs its own change.
- Every other M70 workstream (M70b–M70n).
