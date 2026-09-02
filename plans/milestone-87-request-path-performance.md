# Milestone 87 — Request-path performance (`@setu-ts/common`, `@setu-ts/kernel`, `@setu-ts/runtime`)

> **Status:** Planning. Branch: `feat/m87-request-path-performance`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The framework retained ~34% of the throughput of the router it is built on. A measured spike
established that the loss was not algorithmic but structural: the request path allocated work no
route needed (a full body read on every bodyless GET, two URL parses, an eager `Headers` copy) and
was **eagerly asynchronous end to end**, which foreclosed the synchronous fast path
`@hono/node-server` uses to answer a request without ever entering the microtask queue. This
milestone removes that fixed per-request cost and makes every framework-owned layer
synchronous-capable, so a request that needs no `await` never takes one. Handler and middleware
semantics, routing, and the middleware pipeline's ordering guarantees are unchanged.

The plan is written after a measured spike rather than before one. That ordering is deliberate for
this milestone and is the only honest option: every target below is a ratio against a competitor
measured on this machine, and a performance target invented without a measurement is a guess that
later gets rationalized. The spike is reproducible from `~/setu-benchmarks/`.

- **In scope:** the per-request path only — `mapWebRequestToFrameworkRequest`, `RequestContext`
  construction, `Application.#handleRequest` and its dispatch, the four HTTP adapters' fetch
  handlers, and the `IHttpAdapter` widening those require.
- **NOT this milestone:** the response path (`ResponseBuilder` → `snapshot()` →
  `mapSnapshotToWebResponse` → `Response` is four objects where Hono builds one) — deferred to M88.
  Making `executeChain` itself synchronous-capable, which needs `NextFunction` widened from
  `() => Promise<void>` and would break middleware calling `next().then(...)` — deferred to M88.
  Benchmarks as a release gate, and the Node/Bun compatibility suites — M40 owns those.

## 1. Contracts verified from SOURCE (not names)

| Reference                      | Source (file:line)                                       | Verified surface / fact                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IHttpAdapter.setHandler`      | `packages/common/src/runtime.ts:466`                     | Was `(request: IRequest) => Promise<IResponse>` — the handler's return type is what forces the kernel to be async                                                                        |
| `IHttpAdapter.fetch`           | `packages/common/src/runtime.ts:475`                     | Was `Promise<Response>`                                                                                                                                                                  |
| `RouteHandler`                 | `packages/common/src/http.ts:334`                        | ALREADY `HandlerResult \| Promise<HandlerResult>` — a sync handler was always legal; nothing on the contract forced the async path                                                       |
| `MiddlewareFunction`           | `packages/common/src/http.ts:304`                        | ALREADY `void \| HandlerResult \| Promise<void \| HandlerResult>` — likewise sync-capable                                                                                                |
| `NextFunction`                 | `packages/common/src/http.ts:286`                        | `() => Promise<void>` — the one middleware-facing type that IS hard-async; why `executeChain` is deferred to M88                                                                         |
| `MiddlewarePipeline.execute`   | `packages/kernel/src/pipeline/middleware-pipeline.ts:85` | `async`, and `compile()` caches into `#compiled`, so consulting it per request is a null check                                                                                           |
| `executeChain`                 | `packages/kernel/src/pipeline/execute-chain.ts:41`       | On an EMPTY chain it does exactly one meaningful thing before the terminal — the `responseEnded()` defense-in-depth check — behind two closures and three microtask boundaries           |
| `Application.#tryUpgrade`      | `packages/kernel/src/application/application.ts:745`     | Opens with two SYNCHRONOUS refusals (`ctx.raw === undefined`, then `registry.has(WEBSOCKET)`) yet is `async`, so an app registering neither pays a promise to be told "no"               |
| `Application.#tryGrpc`         | `packages/kernel/src/application/application.ts:832`     | Same shape, same cost                                                                                                                                                                    |
| `ServiceRegistry` sealing      | M71 (`registry-seal.test.ts`)                            | The application registry seals after `runBootstrap()`, so WEBSOCKET/GRPC presence is fixed once serving begins — a per-request `has()` cannot go stale mid-run                           |
| `@hono/node-server` fast path  | `node_modules/@hono/node-server/dist/index.mjs:1027`     | `if (!isPromise(res) && isImmediateCacheableResponse(res)) return responseViaCache(res, outgoing)` — gated on BOTH conditions, and skips the per-request `outgoing.on('close')`          |
| `isImmediateCacheableResponse` | `.../index.mjs:858`                                      | Requires the internal `cacheKey` symbol, set only by node-server's own `Response` class, and a body of `null \| string \| Uint8Array`                                                    |
| node-server global override    | `.../index.mjs:996`                                      | `if (options.overrideGlobalObjects !== false && ...)` installs its `Request`/`Response` as globals — the ONLY way for our `new Response()` to carry `cacheKey`, since it is not exported |
| node-server `newRequest`       | `.../index.mjs:1011`                                     | Called UNCONDITIONALLY — the inbound request is node-server's lightweight facade whether or not globals are overridden                                                                   |
| `URL` path normalization       | probed, Node 24 + Deno 2.9                               | The ONLY rewriting `URL` performs on a path is dot-segment resolution and backslash conversion; it does NOT percent-decode and does NOT collapse `//`                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                              | Doc deliverable (same PR)                                                    |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| C1 | `node-http-adapter.ts` said `overrideGlobalObjects: false` prevents node-server "mutating the global Request/Response which would corrupt the shared mapping". Source says `newRequest()` is unconditional, so the mapping receives the same facade regardless. | The comment is wrong. The flag decided the class backing `new Response(...)`, i.e. whether the fast path was reachable at all. Override is enabled.                                   | Comment rewritten to state the real mechanism and the cost of opting out.    |
| C2 | `fetch-mapping.ts` said the request `Headers` copy exists "to ensure immutability". `new Headers(src)` is mutable, so it provides the opposite.                                                                                                                 | The copy normalizes **writability** across runtimes — a server-received `Request` on Deno throws `TypeError` on `headers.set`, while Node and Bun permit it. Copy is kept, made lazy. | Comment rewritten to state the real purpose and name the runtime divergence. |
| C3 | `application.ts:987` said "the framework mapping has already disturbed it via `arrayBuffer()`" when refusing an upgrade carrying a body. The mapping no longer pre-reads.                                                                                       | Comment corrected. The lazy body means an ordinary upgrade now reaches the handshake with its raw `Request` undisturbed — the M46 hazard, removed rather than worked around.          | Comment rewritten, naming the M46 interaction.                               |

## 3. Design decisions

### 3.1 Body reads are memoized-lazy, with a framing-header discriminator

- **Decision:** `FrameworkRequest` reads the body on first `bytes()`/`text()`/`json()` and caches
  it. A `GET`/`HEAD` carrying neither `content-length` nor `transfer-encoding` resolves to a shared
  empty `Uint8Array` without touching the native request. The discriminator is read off the NATIVE
  headers, never `this.headers`.
- **Why:** the mapping called `await request.arrayBuffer()` on every request. Under node-server that
  forces `getRequestCache()`, which materializes the full undici `Request` the lightweight facade
  exists to avoid — the single largest cost on the path. Reading the discriminator off
  `this.headers` would take the lazy copy on every request and undo the saving. Memoizing preserves
  idempotency: the contract permits `bytes()` twice, and a raw body stream does not.
- **Test home:** `fetch-mapping.test.ts` (bodyless fast path, repeat-read idempotency, and that a
  GET WITH `content-length` still reads).

### 3.2 Cold context members are lazy behind prototype getters

- **Decision:** `RequestContext` becomes a class. `id`, `services`, `state`, `query` and `signal`
  are lazy getters; `startTime` stays eager; `raw` is a conditionally-assigned own property.
- **Why:** an object literal with per-request closures gets a fresh shape each request; a class
  gives one hidden class and monomorphic access. `id` costs a `uuid()`, `services` a child registry,
  `query` a `URL` parse — none of which most handlers touch. `raw` is assigned rather than exposed
  as a getter because `exactOptionalPropertyTypes` forbids a getter typed `Request` returning
  `undefined`, and omission is the semantically correct representation of "this adapter has no raw
  request".
- **Test home:** `request-context.test.ts`, plus `request-context-raw.test.ts` for the omission.

### 3.3 Every framework-owned layer returns synchronously when it can

- **Decision:** `#handleRequest` is no longer `async`. It splits into `#runRequest` → `#dispatch` →
  `#dispatchRoute`, each returning `undefined` when it completed synchronously and a promise
  otherwise. Lifecycle hooks and/or global middleware route to `#runRequestFull`, which is unchanged
  and async. The failure path stays synchronous when no `onError` hook is registered.
- **Why:** node-server's fast path is gated on the handler NOT returning a promise. One
  eagerly-async link anywhere forecloses it for every request. Splitting rather than rewriting keeps
  the general path byte-identical, so only the hook-free, middleware-free shape changes.
- **Test home:** `application.test.ts` (existing behavioural suite must pass unchanged) plus
  `sync-path.test.ts` asserting `#handleRequest` returns a non-promise for a hook-free app.

### 3.4 Drain accounting decrements exactly once, before anything that can throw

- **Decision:** `#inFlight--` happens on four paths (sync completion, resolved promise, rejected
  promise, sync throw), each reaching it exactly once. `#finishFailure` decrements FIRST, ahead of
  the reporting and responder calls.
- **Why:** the original body used `finally`, which could not leak the counter even if the catch
  block threw. Splitting the method loses that structural guarantee, so ordering restores it
  explicitly. A leaked counter stalls shutdown drain forever.
- **Test home:** `application-stop.test.ts` (drain completes after a throwing handler).

### 3.5 The protocol helpers are gated by a synchronous capability check

- **Decision:** `#dispatch` checks `ctx.raw !== undefined && (has(WEBSOCKET) || has(GRPC))` before
  entering the async `#dispatchProtocol`.
- **Why:** both helpers already began with exactly those refusals; hoisting them changes no outcome,
  because absent the token each returned `false` regardless. M71's registry sealing is what makes a
  per-request `has()` safe. Precedence (protocol before route matching, M70a/M49) is preserved.
- **Test home:** `catchall-vs-plugin-routes.test.ts` and `pipeline-runs-for-upgrade.test.ts`,
  unchanged.

### 3.6 Route matching reuses the already-resolved path

- **Decision:** `#dispatchRoute` matches on the `path` the caller resolved, not a second
  `new URL(request.url).pathname`.
- **Why:** the mapping parsed the URL and the malformed-path guard read the result fifty lines
  above; the second parse was pure duplication. `IRequest` is fully readonly, so the value cannot
  have changed.
- **Test home:** `router.test.ts` and `route-matcher.test.ts`, unchanged.

### 3.7 Path extraction is a string slice with an exact-semantics fallback

- **Decision:** `extractPath(url)` slices between the authority and the first `?`/`#`, and falls
  back to `new URL(url).pathname` when the result contains `/.` or a backslash, or when the string
  carries no scheme.
- **Why:** it must equal `new URL().pathname` for EVERY input, not merely common ones. This is what
  separates it from Hono's `getPath`, which stops normalizing dot-segments — so `/foo/../admin`
  would cease to resolve to `/admin` and route somewhere else. Probing established that dot-segments
  and backslashes are the only inputs `URL` rewrites, so the guard is complete rather than
  heuristic. The fallback is genuinely reachable: node-server builds its URL from `incoming.url`
  verbatim, so a client sending `GET /a/../b` arrives unnormalized, where a real `Request` would
  have normalized first.
- **Test home:** `extract-path.test.ts`, asserting equality against `new URL().pathname` over a
  corpus that includes unnormalized inputs.

### 3.8 node-server installs its own globals

- **Decision:** stop passing `overrideGlobalObjects: false`.
- **Why:** §1 shows the fast path requires our `new Response(...)` to carry node-server's
  `cacheKey`, and that class is not exported, so the global override is the only route to it. It is
  node-server's default and what every Hono-on-Node deployment already runs. Opting out made §3.3
  unrewarded, since the fast path needs both conditions at once.
- **Test home:** `fetch-mapping.test.ts` response-shape assertions, plus the benchmark equivalence
  run.

### 3.9 Route matching answers a single candidate without allocating

- **Decision:** `Router.match` handles `candidatesRaw.length === 1` before building anything. The
  `RouteEntry` is carried on the stub handler Hono already returns in the match tuple, read with one
  property access; params are decoded by an internal `decodeParams` that skips `decodeURIComponent`
  for a value containing no `%` and returns a shared frozen object when a route has none.
- **Why:** the single-candidate case is every request in an application without overlapping
  patterns, and it was paying for a candidates array, a per-candidate object literal, an
  `Object.entries` array, and a `${method} ${path}` string key for a `Map` lookup — none of which
  can change the outcome when there is nothing to tie-break against. Profiling put `match` at 0.549
  µs/req against find-my-way's 0.10. `#entryMap` remains the duplicate-registration guard (M68); the
  handler-carried entry is a second route to the same object, not a second source of truth. Skipping
  `decodeURIComponent` is exact: it is an identity function on a string with no `%`, and does NOT
  decode `+`.
- **Test home:** `router-fast-path.test.ts`.

## 4. Exported surface — every symbol names its consumer

**No package's `src/index.ts` gains or loses a symbol.** This milestone changes the shape of two
existing `IHttpAdapter` members and adds no public API. `extractPath` is exported from
`fetch-mapping.ts` — an internal module NOT re-exported by `packages/runtime/src/index.ts` — solely
so its branches can be unit-tested directly, per the internal-seam rule.

| Exported symbol                      | Kind             | Consumer / real code path that READS it                                           |
| ------------------------------------ | ---------------- | --------------------------------------------------------------------------------- |
| `IHttpAdapter.setHandler` (widened)  | interface method | `Application.#runStartup` installs a handler that may now return synchronously    |
| `IHttpAdapter.fetch` (widened)       | interface method | `Application.fetch`; the four adapters return a plain `Response` on the fast path |
| `extractPath` (internal, non-barrel) | function         | `mapWebRequestToFrameworkRequest`; `extract-path.test.ts` asserts its branches    |

### 4.1 Options — every option names its consumer

None added (checked). The milestone introduces no plugin option and no configuration flag;
`overrideGlobalObjects` is a node-server argument, decided once in `defaultNodeServeHost`, not
surfaced.

## 5. Implementation files

| File                                                                 | Purpose                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/common/src/runtime.ts`                                     | Widen `IHttpAdapter.setHandler` and `fetch` (breaking for out-of-repo adapter implementors) |
| `packages/kernel/src/context/request-context.ts`                     | `RequestContext` class; lazy cold members                                                   |
| `packages/kernel/src/application/application.ts`                     | Sync-capable `#handleRequest`; `#runRequest`/`#dispatch`/`#dispatchRoute`/`#failRequest`    |
| `packages/kernel/src/router/router.ts`                               | Single-candidate fast path; entry carried on the stub handler; `decodeParams`               |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`              | `FrameworkRequest` class, lazy body/headers, `extractPath`, sync mapping                    |
| `packages/runtime/src/adapters/node/node-http-adapter.ts`            | Non-async fetch handler; enable node-server globals                                         |
| `packages/runtime/src/adapters/{deno,bun,workers}/*-http-adapter.ts` | Non-async fetch handlers                                                                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                | src covered                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                         |
| -------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime/test/unit/extract-path.test.ts`                 | `fetch-mapping.ts` (extractPath) | Equals `new URL(url).pathname` across a corpus incl. unnormalized dot-segments and backslashes; does not percent-decode; throws on a scheme-less URL (`extractPath(string): string`)                                     |
| `runtime/test/unit/fetch-mapping.test.ts`                | `fetch-mapping.ts`               | Bodyless GET/HEAD never touches the native request; a GET WITH `content-length` does; repeat `bytes()` is idempotent; headers copy is lazy and writable (`mapWebRequestToFrameworkRequest(Request): IRequest`, now sync) |
| `kernel/test/unit/request-context.test.ts`               | `request-context.ts`             | Lazy members materialize on access and memoize; `startTime` is `hrtime()` not `Date.now()`; `params` default is frozen                                                                                                   |
| `kernel/test/unit/request-context-raw.test.ts`           | `request-context.ts`             | `raw` is OMITTED, not `undefined`, when the request carries none                                                                                                                                                         |
| `kernel/test/integration/application.test.ts`            | `application.ts`                 | Existing behavioural suite passes unchanged — the general path must be byte-identical                                                                                                                                    |
| `kernel/test/integration/application-stop.test.ts`       | `application.ts`                 | Drain completes after a throwing handler and after a throwing `onError` hook (§3.4)                                                                                                                                      |
| `kernel/test/unit/execute-chain.test.ts`                 | `execute-chain.ts`               | Empty-chain bypass preserves the `ended` short-circuit: a global stage that ends the response AND calls `next()` still prevents the handler running                                                                      |
| `kernel/test/unit/router-fast-path.test.ts`              | `router.ts`                      | Static route reports no params; `%20`/`%2F` decode; a `+` survives undecoded; a malformed escape reports no match; the shared params object cannot be mutated; multi-candidate tie-break still applies                   |
| `runtime/test/unit/cf-http-adapter.test.ts`              | `cf-http-adapter.ts`             | Returns a `Response` and NOT a promise for a synchronous handler, and a promise for an async one — an `await` would pass in both cases, so absence-of-promise is the only assertion that sees it                         |
| `runtime/test/unit/{node,deno,bun}-http-adapter.test.ts` | adapters                         | Fetch handler returns a non-promise when the framework handler does, and a promise when it does not                                                                                                                      |

Benchmark equivalence (33 responses byte-identical across 11 servers) is run as an external gate,
not a unit test — it needs real sockets and competitor servers.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m87-request-path-performance, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check
deno task release:verify <version>
```

## 8. Risks & mitigations

- **The `IHttpAdapter` widening is breaking for out-of-repo adapter implementors** (the handler's
  return type is contravariant). → CHANGELOG migration note; in-repo it broke exactly two test
  doubles, the same blast radius M47 hit. TypeScript's bivariant method parameters mean an existing
  `Promise`-only implementation still compiles, so the break is narrow.
- **Enabling node-server's globals replaces `globalThis.Request`/`Response` process-wide.** → It is
  node-server's own default and what every Hono-on-Node app already runs; its classes are
  spec-compatible; equivalence is asserted byte-for-byte across all routes. Node adapter only —
  Deno/Bun/Workers are untouched.
- **A split `#handleRequest` loses `finally`'s structural drain guarantee.** → §3.4 orders the
  decrement ahead of anything that can throw, with a test.
- **`extractPath` could diverge from `URL` on an input not probed.** → The guard is derived from
  what `URL` actually rewrites rather than from a list of known-bad strings, and falls back rather
  than guessing; a corpus test asserts equality including the unnormalized cases node-server really
  delivers.
- **Benchmarks are noisy (~10% run-to-run drift observed).** → Every comparison is interleaved
  run-by-run and reported as a median of paired runs, never a best-of or a cross-session ratio.

## 9. Out of scope

- The response path — `ResponseBuilder` → `snapshot()` → `mapSnapshotToWebResponse` → `Response` is
  four allocations plus an eager `new Headers()` where Hono builds one object. **M88.**
- Synchronous `executeChain`, which requires widening `NextFunction` from `() => Promise<void>` and
  breaks middleware calling `next().then(...)`. **M88.**
- Benchmarks wired as a release gate, plus the Node/Bun compatibility suites. **M40.**
- Deno/Bun/Workers-specific response fast paths equivalent to node-server's `responseViaCache`.
  **M88.**
