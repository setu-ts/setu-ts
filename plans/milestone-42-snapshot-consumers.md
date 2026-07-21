# Milestone 42 — Streaming Response Body (`IResponse` Streaming Primitive)

> **Status:** Planning. Branch: `feat/42-snapshot-consumers`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.
>
> **Naming note (see conflict C1):** the committed ROADMAP titles this milestone "Streaming Response
> Body — `IResponse` Streaming Primitive". The branch and this plan file carry the label
> `snapshot-consumers`, which names a genuine sub-aspect of the work (ROADMAP §5: every `snapshot()`
> consumer must skip a streaming body). The scope below follows the committed ROADMAP, which is the
> authoritative source for milestone scope.

## 0. Objective & scope

Add a web-standard streaming response body to the `IResponse` contract so a handler can flush bytes
progressively over a long-lived connection instead of buffering a whole body before send. This is
the shared foundation both Server-Sent Events (M43) and React SSR streaming (M44) build on; it also
serves large file downloads (storage-plugin, M28) and large export/report responses. The change is a
deliberate, additive `common` API addition shipped with its PUBLIC_API.md delta in the same PR.

The gap is in the response contract itself. Today `IResponse` terminates only via `json`, `text`,
`send`, and `redirect`, all of which buffer. A plugin cannot add a response terminal, so the
contract must. Because the runtime was rebased on a web-standard `fetch(Request) => Response` model
in M23, streaming is a single shared mapper change, not a per-adapter write path: every platform
(Node/Deno/Bun/Cloudflare Workers) pumps a `ReadableStream` body natively.

- **In scope:**
  - `IResponse.stream(body)` terminal, a widened `IResponse.snapshot()` (stream body plus a
    `streaming` marker), and an `IRequestContext.signal: AbortSignal` so a producer can stop on
    client disconnect.
  - The threading vehicle for that signal: an optional `IRequest.signal`.
  - Kernel `ResponseBuilder` carrying the stream and the marker, and `createRequestContext`
    populating `ctx.signal`.
  - Runtime shared `fetch-mapping.ts` streaming pass-through plus native `Request.signal`
    forwarding.
  - The cache-middleware `snapshot()` consumer learning to skip a streaming body (the ROADMAP §5
    guard).
  - Updating every hand-rolled `IResponse` / `IRequestContext` test double across the workspace to
    the new required shapes — a mandatory compile-break fix, enumerated in §6.1.
  - PUBLIC_API.md delta and the ROADMAP doc corrections C2/C3/C5/C6 (§2).
- **NOT this milestone:**
  - SSE framing, channels, heartbeats — **Milestone 43** (`sse-plugin`).
  - React Router SSR embed, request bridge, static assets — **Milestone 44**
    (`react-router-plugin`).
  - Storage/large-file streaming — **Milestone 28** (`storage-plugin`) consumes this primitive.
  - Per-adapter socket write logic — deleted in M23; the single shared mapper owns this now.

## 1. Contracts verified from SOURCE (not names)

| Reference                             | Source (file:line)                                                                                                                                                                         | Verified surface / fact                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IResponse`                           | `packages/common/src/http.ts:83`                                                                                                                                                           | Methods `status`, `header`, `appendHeader`, `json<T>`, `text`, `send`, `redirect`. No `stream` method today.                                                                                                               |
| `IResponse.snapshot()`                | `packages/common/src/http.ts:149`                                                                                                                                                          | Returns `{ readonly status: number; readonly headers: Headers; readonly body: Uint8Array \| string \| null }`. No `streaming` field today.                                                                                 |
| `IRequest`                            | `packages/common/src/http.ts:32`                                                                                                                                                           | Fields `method`, `url`, `path`, `headers`, `ip?`, `user?`; methods `json<T>()`, `text()`, `bytes()`. No `signal` today.                                                                                                    |
| `IRequestContext`                     | `packages/common/src/http.ts:162`                                                                                                                                                          | Fields `id`, `request`, `response`, `services`, `params`, `query`, `state`, `startTime`. No `signal` today.                                                                                                                |
| `HandlerResult`                       | `packages/common/src/http.ts:22`                                                                                                                                                           | Opaque brand `{ readonly __handlerResult: true }`; the type every terminal returns.                                                                                                                                        |
| `ResponseBuilder`                     | `packages/kernel/src/context/response.ts:16`                                                                                                                                               | Private `#status`, `#headers`, `#body: Uint8Array \| string \| null`, `#ended`. `snapshot()` at `:73` returns `{ status, headers, body }`. `ended` getter at `:82`.                                                        |
| `createRequestContext`                | `packages/kernel/src/context/request-context.ts:41`                                                                                                                                        | Signature `(request: IRequest, registry: ServiceRegistry, runtime: IRuntimeServices)`. Builds the `ctx` literal at `:56` with no `signal`.                                                                                 |
| `Application.#handleRequest`          | `packages/kernel/src/application/application.ts:427`                                                                                                                                       | Calls `createRequestContext(request, this.#registry, runtime)` at `:447`; returns `ctx.response as ResponseBuilder` at `:499`.                                                                                             |
| `Application.inject`                  | `packages/kernel/src/application/application.ts:368`                                                                                                                                       | Builds a synthetic `IRequest` at `:389` (no signal); reads `response.snapshot()` at `:408`; `body: typeof snapshot.body === 'string' ? snapshot.body : null` at `:413`.                                                    |
| `mapSnapshotToWebResponse`            | `packages/runtime/src/adapters/shared/fetch-mapping.ts:71`                                                                                                                                 | Param `{ status, headers, body: Uint8Array \| string \| null }`; builds `bodyPart: string \| BlobPart \| null`; `new Response(bodyPart, { status, headers })`.                                                             |
| `mapWebRequestToFrameworkRequest`     | `packages/runtime/src/adapters/shared/fetch-mapping.ts:25`                                                                                                                                 | Builds the `IRequest` at `:39` with no `signal`; pre-reads the body via `arrayBuffer()`.                                                                                                                                   |
| Adapter `createFetchHandler`          | node `packages/runtime/src/adapters/node/node-http-adapter.ts:105`, deno `…/deno/deno-http-adapter.ts:113`, bun `…/bun/bun-http-adapter.ts:103`, workers `…/workers/cf-http-adapter.ts:35` | Each composes `mapWebRequestToFrameworkRequest(request)` → `this.#handler(frameworkRequest)` → `mapSnapshotToWebResponse(frameworkResponse.snapshot())`. Handler signature is `(request: IRequest) => Promise<IResponse>`. |
| `IHttpAdapter.setHandler`             | `packages/kernel/src/application/application.ts:297`                                                                                                                                       | `adapter.setHandler((request: IRequest) => this.#handleRequest(request))` — `IRequest` is the sole vehicle from adapter to application to context.                                                                         |
| `cacheMiddleware` (snapshot consumer) | `packages/cache-plugin/src/middleware/cache-middleware.ts:115`                                                                                                                             | On MISS reads `ctx.response.snapshot()` then `encodePayload(snapshot)` then `store.set`. Must skip a streaming body.                                                                                                       |
| `encodePayload`                       | `packages/cache-plugin/src/utils/cache-payload.ts:25`                                                                                                                                      | Expects `body: Uint8Array \| string \| null`; a `ReadableStream` falls through to `body: null`, so the guard must live in `cacheMiddleware` before this call.                                                              |
| metrics `http-collector`              | `packages/metrics-plugin/src/collectors/http-collector.ts:143`                                                                                                                             | Reads only `ctx.response.snapshot().status`. Does not touch the body; safe, no change.                                                                                                                                     |
| telemetry middleware                  | `packages/telemetry-plugin/src/middleware/telemetry-middleware.ts:69`                                                                                                                      | Reads only `snapshot.status`. Does not touch the body; safe, no change.                                                                                                                                                    |
| `CAPABILITIES`                        | `packages/common/src/tokens.ts:39`                                                                                                                                                         | No streaming or SSE token. `createCapabilityToken` grammar is lowercase kebab-case with dot namespacing; colons are illegal. M42 adds no token — `stream` is a contract method, not a service.                             |
| common HTTP exports                   | `packages/common/src/index.ts:38`                                                                                                                                                          | `IResponse`, `IRequest`, `IRequestContext`, `HandlerResult` already re-exported as types. M42 changes their shape, it adds no new `index.ts` export.                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                             | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Doc deliverable (same PR)                                                                                                                                       |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | Scope/label mismatch: ROADMAP titles M42 "Streaming Response Body — `IResponse` Streaming Primitive"; the branch and this plan file use `snapshot-consumers`.                                                        | Scope follows the committed ROADMAP (authoritative for scope). The `snapshot-consumers` label is retained for the branch/file because it names a real sub-aspect (ROADMAP §5).                                                                                                                                                                                                                                                                                                                     | Note recorded here; no ROADMAP edit required. Branch renaming is out of scope for this plan-only pass (flagged in §9).                                          |
| C2 | ROADMAP M42 "Implementation Files" lists `packages/kernel/src/http/response.ts`; that path does not exist. The real file is `packages/kernel/src/context/response.ts`.                                               | Use the real path `packages/kernel/src/context/response.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                       | Fix the ROADMAP M42 implementation-files line to the real path.                                                                                                 |
| C3 | ROADMAP §3 lists only `IRequestContext.signal` as "populated by the HTTP adapter", but gives no vehicle from adapter to context. Verified from SOURCE that the adapter→handler→context path carries only `IRequest`. | Add an OPTIONAL `IRequest.signal?: AbortSignal` as the threading vehicle; `createRequestContext` populates the required `IRequestContext.signal` from `request.signal` (falling back to a non-aborting signal).                                                                                                                                                                                                                                                                                    | PUBLIC_API.md documents both fields; ROADMAP §3 gains a one-line note that the signal threads through `IRequest`.                                               |
| C4 | Adding fields to already-exported interfaces could read as a breaking change (AI_GUIDELINES §9.1).                                                                                                                   | `IRequest.signal` is optional, so no existing PRODUCTION consumer breaks. But `IResponse.stream()` (new required method), the discriminated `snapshot()` shape (C5), and required `IRequestContext.signal` DO break every hand-rolled test double typed against those interfaces — a compile break, resolved by updating all doubles in the same PR (§6.1). Net effect on published `common` consumers is a backward-compatible minor-version addition; the break is confined to in-repo fixtures. | PUBLIC_API.md delta (semver note); fixture updates enumerated in §6.1.                                                                                          |
| C5 | ROADMAP M42 contract addition #2 says "add a `streaming: boolean` marker to the snapshot" (a flat shape); a flat `{ body: …\|ReadableStream; streaming: boolean }` does not type-check at `encodePayload` (§3.1).    | Deliberate deviation: `snapshot()` returns a DISCRIMINATED union keyed on `streaming` (§3.1), preserving the observable `streaming` discriminant the ROADMAP describes while narrowing `body` with zero casts. A shape refinement, not a scope change.                                                                                                                                                                                                                                             | PUBLIC_API.md documents the union shape; one-line ROADMAP M42 note that the marker is realized as a discriminated union.                                        |
| C6 | ROADMAP M42 "Implementation Files" lists `packages/kernel/src/pipeline/*` ("streaming-aware result handling; cache/snapshot guard") and a conditional `{node,deno,bun,workers}/*`; the fetch model needs neither.    | No `pipeline/*` file is edited (the stream rides in `ResponseBuilder.#body`, pumped lazily by the runtime — §3.1); the guard lives in `cache-plugin` (§3.4); the signal rides the shared mapper, so no per-adapter file changes.                                                                                                                                                                                                                                                                   | Fix the ROADMAP M42 implementation-files list: drop the `pipeline/*` line and the conditional per-adapter line (superseded by the single shared-mapper change). |

## 3. Design decisions

The streaming request flows through one shared path on every platform. An aborted request propagates
back along the same path so a producer can stop.

```mermaid
flowchart LR
  WEB["web Request plus native signal"] --> MAP["mapWebRequestToFrameworkRequest"]
  MAP --> REQ["IRequest signal optional"]
  REQ --> CTX["createRequestContext"]
  CTX --> CONTEXT["IRequestContext signal required"]
  CONTEXT --> HANDLER["route handler"]
  HANDLER --> STREAM["ctx.response.stream ReadableStream"]
  STREAM --> SNAP["snapshot streaming true"]
  SNAP --> RESP["mapSnapshotToWebResponse"]
  RESP --> OUT["web Response ReadableStream body"]
  WEB -. abort on disconnect .-> REQ
  REQ -. ctx.signal aborts .-> HANDLER
```

### 3.1 Stream body representation — `snapshot()` is a DISCRIMINATED union on `streaming`

- **Decision:** `IResponse.stream(body: ReadableStream<Uint8Array>): HandlerResult` is a new
  terminal. `ResponseBuilder` stores the stream in its existing `#body` slot (widened to
  `Uint8Array | string | ReadableStream<Uint8Array> | null`), sets a new private
  `#streaming = true`, and sets `#ended = true`. `snapshot()` returns a **discriminated union keyed
  on `streaming`**, NOT a flat object with a widened `body` plus a separate `streaming: boolean`:

  ```typescript
  type ResponseSnapshot =
    | {
      readonly streaming: false;
      readonly status: number;
      readonly headers: Headers;
      readonly body: Uint8Array | string | null;
    }
    | {
      readonly streaming: true;
      readonly status: number;
      readonly headers: Headers;
      readonly body: ReadableStream<Uint8Array>;
    };
  ```

- **Why the union, not a flat `{ body: …|ReadableStream; streaming: boolean }`:** a flat shape does
  NOT type-check at the one consumer that reads the body after guarding. `cacheMiddleware` does
  `if (snapshot.streaming) return; … encodePayload(snapshot)`, and `encodePayload`'s parameter is
  `body: Uint8Array | string | null` (verified, `cache-payload.ts:25`). Narrowing a flat
  `streaming: boolean` to `false` does NOT narrow a separately-typed `body`, so
  `encodePayload(snapshot)` would fail with TS2345 (`ReadableStream` not assignable); the only
  workarounds are a banned cast or a widening of `encodePayload` to a `ReadableStream` branch it
  must never take — both rejected. The discriminated union makes `if (snapshot.streaming)` narrow
  `body` correctly on BOTH arms: the `false` arm's `body` is exactly `Uint8Array | string | null`
  (assignable to `encodePayload` with no cast), and the `true` arm's `body` is exactly
  `ReadableStream<Uint8Array>` (assignable to `new Response(body)` in the mapper with no cast). One
  body slot, one discriminant, zero casts.
- **Why one body slot and lazy pump:** the runtime hands the `ReadableStream` straight to
  `new Response(stream, { status, headers })`; the web fetch model pumps it lazily on every platform
  with no buffer-then-send and no "do not await" special-casing.
- **Test home:** `packages/kernel/test/unit/response.test.ts` asserts `stream()` returns the
  `HandlerResult` brand, sets `ended`, that `snapshot().body` is the exact stream passed, and that
  `snapshot().streaming === true`; the buffered regressions assert `snapshot().streaming === false`
  and that `body` is the expected `Uint8Array | string | null`.

### 3.2 Signal threading vehicle

- **Decision:** add an OPTIONAL `IRequest.signal?: AbortSignal`. `mapWebRequestToFrameworkRequest`
  sets `signal: request.signal` from the native `Request.signal`. `createRequestContext` populates
  the required `IRequestContext.signal` as `request.signal ?? NEVER_ABORT` where `NEVER_ABORT` is a
  module-level `new AbortController().signal` in `request-context.ts`.
- **Why:** verified from SOURCE that the adapter→handler→context path carries only `IRequest`, so
  `IRequest` is the only carrier that reaches `createRequestContext`. Putting the signal on
  `IRequest` (optional) avoids widening `IHttpAdapter` or the handler signature and keeps the change
  backward-compatible. `IRequestContext.signal` stays required so every handler and streaming
  producer can rely on it (M43 heartbeat cleanup / channel auto-remove depend on it being present).
- **⚠ Compile-break scope — `IRequestContext.signal` is REQUIRED, which is NOT free.**
  `IRequest.signal` is optional (adapters set it, `inject()`/fakes omit it — those genuinely need no
  change). But `IRequestContext.signal` is REQUIRED, so **every hand-rolled `IRequestContext` object
  literal in the test suite fails `deno task check` (TS2741) until it adds `signal`**. This is
  compounded by §3.1: adding the required `IResponse.stream()` method and the discriminated
  `snapshot()` shape breaks **every hand-rolled `IResponse` fake** the same way. The earlier draft's
  claim that "test fakes … require no change to compile" was WRONG for these two required additions
  and is corrected here — the fixture-update surface is enumerated as an explicit deliverable in
  §6.1. The `??
NEVER_ABORT` fallback and the `request.signal`-present path are BOTH exercised (see
  §6.1) so the fallback branch is covered, not merely present.
- **`NEVER_ABORT` honesty:** it is a real, never-aborted `AbortSignal` from a module-level
  `AbortController` that is never `.abort()`-ed — so `ctx.signal` is always a live `AbortSignal`,
  matching how the adapter path produces it. Fixtures that add `signal` MUST use a real
  `new AbortController().signal` (never `{} as AbortSignal`), per the "test doubles must honor the
  real contract" rule.
- **Test home:** `packages/runtime/test/unit/fetch-mapping.test.ts` asserts the mapped request
  carries the native `request.signal`; the streaming integration test asserts aborting the request
  aborts `ctx.signal` and stops the producer; the kernel integration test asserts the `NEVER_ABORT`
  fallback (a request with no `signal` still yields a present, non-aborted `ctx.signal`).

### 3.3 Streaming pass-through in `mapSnapshotToWebResponse`

- **Decision:** widen the mapper parameter to the discriminated `ResponseSnapshot` union (§3.1).
  When `snapshot.streaming` is true, `snapshot.body` is narrowed to `ReadableStream<Uint8Array>` and
  the mapper returns `new Response(snapshot.body, { status, headers })` directly — no cast, because
  `ReadableStream` is a valid `BodyInit`. On the `false` arm, `snapshot.body` narrows to
  `Uint8Array | string | null` and the existing buffered path is unchanged (the current
  `body as unknown as BlobPart` cast for `Uint8Array` stays as-is; it is unrelated to streaming).
- **Why:** M23 deleted the per-adapter write path; the shared mapper is the single point every
  adapter funnels through. Passing the stream through unchanged is the one change ROADMAP §6 asks
  for.
- **Test home:** `packages/runtime/test/unit/fetch-mapping.test.ts` asserts a streaming snapshot
  produces a `Response` whose body reader yields chunks incrementally (chunks are readable before
  the producer closes the stream), and that the buffered path is byte-for-byte unchanged.

### 3.4 snapshot consumer guard

- **Decision:** `cacheMiddleware` checks
  `if (snapshot.streaming) { ctx.response.header('X-Cache', 'MISS'); return; }` in its MISS path
  before `encodePayload`. Because `snapshot()` is the discriminated union (§3.1), this guard NARROWS
  `snapshot` to the `streaming: false` arm for the rest of the function, so the subsequent
  `encodePayload(snapshot)` type-checks against its `body: Uint8Array | string | null` parameter
  with no cast and no widening of `encodePayload`. The metrics `http-collector` and the telemetry
  middleware read only `snapshot.status` (verified), so they need no change and no stream is ever
  drained by them.
- **Why:** ROADMAP §5 — a live stream is not cacheable and must not be drained by an observer.
  Without the guard, `encodePayload` would silently store a streaming response as a `null` body
  (and, under a flat non-union snapshot, would not even compile — see §3.1).
- **Test home:** `packages/cache-plugin/test/unit/cache-middleware.test.ts` asserts a streaming
  response is neither stored nor drained, and is marked MISS.

### 3.5 inject behavior for a streaming response

- **Decision:** `inject()` is unchanged in logic. Its buffered `InjectResponse.body` is
  `string | null`, so a streaming snapshot surfaces as `body: null` (the existing
  `typeof snapshot.body === 'string'` check already yields null for a `ReadableStream`). Streaming
  is verified through `app.fetch(Request)`, not `inject()`.
- **Why:** `inject()` is the buffered test harness; pumping a live stream into a buffered shape
  would defeat streaming. Keeping `inject()` unchanged avoids widening its return type.
- **Test home:** `packages/kernel/test/integration/application.test.ts` asserts that injecting a
  streaming route returns the status with a null body and does not throw.

## 4. Exported surface — every symbol names its consumer

No NEW symbol is exported from any `src/index.ts`: `IResponse`, `IRequest`, `IRequestContext`, and
`HandlerResult` are already re-exported from `packages/common/src/index.ts:38`. This milestone
changes the SHAPE of already-exported interfaces. Each changed member and its reader:

| Changed member                                                         | Kind                              | Consumer / real code path that READS it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IResponse.stream(body)`                                               | method (new, required)            | Route handlers (M43 SSE, M44 SSR, app code) call it; `ResponseBuilder` implements it; the returned `HandlerResult` flows through the pipeline terminal. As a NEW required interface method, every hand-rolled `IResponse` fake must add a `stream` method to compile — enumerated in §6.1.                                                                                                                                                                                                                              |
| `IResponse.snapshot()` → discriminated `ResponseSnapshot` union (§3.1) | method (widened, breaking-shaped) | `mapSnapshotToWebResponse` (`packages/runtime/src/adapters/shared/fetch-mapping.ts:71`) branches on `streaming` for pass-through; `cacheMiddleware` (`packages/cache-plugin/src/middleware/cache-middleware.ts:115`) branches on `streaming` to skip; metrics `http-collector` and telemetry middleware read only `.status`; `Application.inject` reads `.body`. Every hand-rolled `IResponse` fake that implements `snapshot()` must return the new union shape (`streaming` discriminant added) — enumerated in §6.1. |
| `IRequest.signal?: AbortSignal`                                        | field (new, optional)             | `mapWebRequestToFrameworkRequest` produces it from the native `Request.signal`; `createRequestContext` reads it to populate `ctx.signal`.                                                                                                                                                                                                                                                                                                                                                                               |
| `IRequestContext.signal: AbortSignal`                                  | field (new, required)             | Route handlers and streaming producers read it to stop on client disconnect (M43 heartbeat cleanup and channel auto-remove depend on it); `createRequestContext` is the sole producer. As a NEW required field, every hand-rolled `IRequestContext` object literal must add `signal` to compile — enumerated in §6.1.                                                                                                                                                                                                   |

### 4.1 Options — every option names its consumer

None (checked). Milestone 42 adds an `IResponse` contract primitive, not a plugin, so there are no
plugin options to consume. The single new contract parameter, `IResponse.stream(body)`, names its
consumer in the table above.

## 5. Implementation files

| File                                                       | Purpose                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/http.ts`                              | Add `IResponse.stream(body)` terminal; widen `IResponse.snapshot()` to the stream body plus `streaming: boolean`; add `IRequest.signal?` and `IRequestContext.signal`; full JSDoc on each. |
| `packages/kernel/src/context/response.ts`                  | Implement `stream()` on `ResponseBuilder`; add `#streaming`; widen `snapshot()` return; store the `ReadableStream` in `#body`.                                                             |
| `packages/kernel/src/context/request-context.ts`           | Populate `ctx.signal` from `request.signal ?? NEVER_ABORT`; add the module-level non-aborting signal.                                                                                      |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`    | `mapWebRequestToFrameworkRequest` sets `signal: request.signal`; `mapSnapshotToWebResponse` widens its parameter and does streaming pass-through; buffered path unchanged.                 |
| `packages/cache-plugin/src/middleware/cache-middleware.ts` | Skip a streaming snapshot before `encodePayload` (the ROADMAP §5 guard).                                                                                                                   |

No per-adapter file (`node`, `deno`, `bun`, `workers`) is edited: the signal rides on `IRequest`
through the shared mapper, and the streaming body flows through the shared mapper. This matches
ROADMAP's "one shared change, not per-adapter" and resolves the ROADMAP implementation-files line
that listed the adapter dirs as conditional.

No `npm:` specifier is added. The primitive uses only web-standard globals (`ReadableStream`,
`AbortSignal`, `Request`, `Response`) available on Node, Deno, Bun, and Cloudflare Workers, so the
inject-or-lazy `npm:` client pattern from M14b and M15b does not apply and no guarded real-import
test is needed.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                     | src covered                                                                                                   | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel/test/unit/response.test.ts` (extend)                         | `packages/kernel/src/context/response.ts`                                                                     | `stream(rs)` returns the `HandlerResult` brand and sets `ended`; `snapshot().body === rs` (the exact `ReadableStream<Uint8Array>`); `snapshot().streaming === true`; regression that `json`/`text`/`send`/`redirect` set `streaming === false` and keep their existing body semantics.                                                          |
| `packages/kernel/test/integration/application.test.ts` (extend)               | `packages/kernel/src/context/request-context.ts`, `packages/kernel/src/application/application.ts` (`inject`) | A handler reads `ctx.signal` (an `AbortSignal`, present, not aborted by default); `inject()` on a streaming route returns the status with `body === null` and does not throw.                                                                                                                                                                   |
| `packages/runtime/test/unit/fetch-mapping.test.ts` (extend)                   | `packages/runtime/src/adapters/shared/fetch-mapping.ts`                                                       | The mapped `IRequest.signal === request.signal` (native signal forwarded); a streaming snapshot maps to a `Response` whose body reader yields chunks before the producer closes (incremental, not one buffered blob); the buffered path is unchanged for `Uint8Array`/`string`/`null`.                                                          |
| `packages/runtime/test/integration/streaming.test.ts` (new)                   | shared streaming path end-to-end through `app.fetch(Request)`                                                 | Multi-chunk stream delivered incrementally; aborting the request's `AbortController` aborts `ctx.signal` and the producer stops (no leaked producer); a streaming route mounted behind `cacheMiddleware` is not stored and not drained. Uses `app.fetch(new Request(url, { signal }))`, the runtime-agnostic entry that runs on every platform. |
| `packages/cache-plugin/test/unit/cache-middleware.test.ts` (extend)           | `packages/cache-plugin/src/middleware/cache-middleware.ts`                                                    | A streaming response (`snapshot().streaming === true`) is not written to the store and is not drained; the `X-Cache: MISS` header is still set; a buffered response is still cached (regression).                                                                                                                                               |
| `packages/common/test/unit/types.test.ts` (extend, if it asserts HTTP shapes) | `packages/common/src/http.ts`                                                                                 | Compile-time assertions that `IResponse.stream`, the widened `snapshot()`, `IRequest.signal`, and `IRequestContext.signal` are part of the public type surface. (`http.ts` is type-only; its behavioral coverage is the kernel and runtime tests above.)                                                                                        |

The signal-abort and producer-stop branches are driven by injected fakes and a real
`AbortController`, never by an external service. No real socket is required because the shared
mapper is the single change; `app.fetch(Request)` exercises the full
`mapWebRequest → handler →
mapSnapshotToWebResponse` path on the CI runtime.

### 6.1 Cross-package fixture updates (mandatory compile-break scope)

Three required-shape additions — `IResponse.stream()` (new method), the discriminated `snapshot()`
union (§3.1), and `IRequestContext.signal` (new required field) — break every hand-rolled
`IResponse` / `IRequestContext` test double that is typed against those interfaces. This is NOT
optional cleanup: `deno task check` fails repo-wide until each is fixed, so these edits ship in THIS
milestone's PR even though they live outside the five `src` files in §5. The earlier draft omitted
this surface entirely; it is the single largest correction to the plan.

**Per-double changes:**

- Every `IResponse` fake gains a `stream(body: ReadableStream<Uint8Array>): HandlerResult` method (a
  fixture may `throw new Error('not implemented')` if the test never calls it — a documented,
  never-exercised throw is fine here; it is a test double, not `src`).
- Every fake `snapshot()` returns the discriminated union: add `streaming: false` to the existing
  `{ status, headers, body }` literal (buffered doubles) — no double needs a `streaming: true` arm
  unless the test specifically drives streaming.
- Every `IRequestContext` object literal gains `signal: new AbortController().signal` (a real,
  non-aborted signal — never `{} as AbortSignal`, per the real-contract rule).

**Candidate file surface (confirm the exact set by running `deno task check` — a file that casts its
double `as any`/`as unknown as I…` may not break and must NOT be touched just to touch it):**

| Package                | Files (test doubles)                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth-plugin`          | `test/unit/auth-middleware.test.ts`, `test/unit/guards.test.ts`, `test/unit/rate-limit-middleware.test.ts`, `test/integration/auth-integration.test.ts`, `test/integration/auth-behavior-probe.test.ts`, `test/integration/refresh-rate-limit-integration.test.ts` |
| `cache-plugin`         | `test/unit/cache-middleware.test.ts`, `test/unit/cache-key.test.ts`                                                                                                                                                                                                |
| `decorator-plugin`     | `test/fixtures/fake-request-context.ts`                                                                                                                                                                                                                            |
| `exceptions`           | `test/fixtures/fake-runtime.ts` (note: the `snapshot` field's inline type annotation at ~`:71` must also become the union)                                                                                                                                         |
| `http-security-plugin` | `test/fixtures/fake-request-context.ts`                                                                                                                                                                                                                            |
| `validation-plugin`    | `test/fixtures/fake-runtime.ts`                                                                                                                                                                                                                                    |
| `logger-plugin`        | `test/unit/request-logger.test.ts`                                                                                                                                                                                                                                 |
| `runtime`              | `test/unit/{node,deno,bun,cf}-http-adapter.test.ts`, `test/integration/{node,deno}-http-adapter.test.ts`, `test/unit/runtime-plugin.test.ts` (several cast `as any` and will NOT break — verify)                                                                   |
| `telemetry-plugin`     | `test/unit/telemetry-middleware.test.ts`, `test/unit/telemetry-plugin.test.ts`                                                                                                                                                                                     |

**Coverage guard:** these are `test/` fixtures, excluded from the 90% `src` measurement, so adding a
never-called `stream()` to a fake does NOT lower any coverage number. But re-run the ANSI-stripped
per-file table afterward per CLAUDE.md — a fixture edit can perturb which branches a test reaches in
the `src` it drives.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/42-snapshot-consumers, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
```

Plus the milestone-specific grep (CLAUDE.md "Before reporting a task done"):

```bash
grep -rn "new Function\|eval(\|require(\|as any\|@ts-ignore\|globalThis.__" \
  packages/common/src packages/kernel/src packages/runtime/src packages/cache-plugin/src
```

must be empty (comments excepted). The changed packages use only web-standard APIs, so no
`Date.now()`/runtime-API smell is expected outside `packages/runtime`.

## 8. Risks & mitigations

- **A streaming body read twice throws.** A `ReadableStream` is one-shot. Mitigation: the
  `streaming: true` marker plus the cache guard ensure no middleware re-reads or buffers it; the
  only reader is the web `Response` the adapter returns.
- **Forgetting a `snapshot()` consumer would silently buffer or null-store a stream.** Mitigation:
  the §1 enumeration is exhaustive for production `src` (cache reads the body and is guarded;
  metrics and telemetry read only `.status`; `inject` is documented as null-body; the mapper passes
  through). The cache-middleware test pins the guard.
- **`exactOptionalPropertyTypes`.** `IRequest.signal` is optional and only ever assigned a real
  `AbortSignal` (producers set it, they never assign `undefined`); `inject()` and fakes omit it.
- **Fixture compile break is the largest scope item, not an afterthought.** The required additions
  (`IResponse.stream()`, discriminated `snapshot()`, `IRequestContext.signal`) fail
  `deno task check` across ~9 packages of hand-rolled doubles until fixed. Mitigation: §6.1
  enumerates the surface and the per-double change; the implementer runs `deno task check` to
  confirm the exact set (some `as any`-cast doubles will not break). Skipping this is not an option
  — the gate is red until it is done, and it must ship in the same PR as the `common` change.
- **Cloudflare Workers streaming limits.** Long-lived streams on Workers are subject to platform
  duration/streaming limits; that is a platform constraint owned by M43 (SSE), not by this
  primitive. Recorded here so M42 does not assume Node-style indefinite connections.

## 9. Out of scope

- SSE framing, channels, heartbeats, and `Last-Event-ID` — owned by **Milestone 43**.
- React Router SSR embed, request bridge, `loadContext`, and static assets — owned by **Milestone
  44**.
- Storage/large-file streaming — owned by **Milestone 28**; it consumes `IResponse.stream`.
- Per-platform socket-bound streaming round-trips beyond the `app.fetch(Request)` integration test —
  the shared mapper is the single change, so the runtime-agnostic `app.fetch` path plus the mapper
  unit test are the verification; full per-socket binds reuse the existing M41 adapter test harness.
- Renaming the branch from `feat/42-snapshot-consumers` to a streaming label — outside the allowed
  actions of this plan-only pass (no command execution available); flagged for the human to decide.
