# Milestone 88 — Response-Path Performance (`@setu-ts/common`, `@setu-ts/kernel`, `@setu-ts/runtime`)

> **Status:** Complete (PR pending). Branch: `feat/m88-response-path-performance`. `main` is
> protected — all work (implementation + fixes) stayed on this one branch and will merge via a
> single PR.

## 0. Objective & scope

Remove the response path's avoidable framework `Headers` allocation from the ordinary
terminal-response shape while preserving `IResponse.snapshot()` as a live-header read view for
middleware. M87 left this path intentionally: a `ResponseBuilder` constructs `Headers`, `snapshot()`
exposes it, and `new Response(..., { headers })` builds the native response's own headers. A
measured in-process representative JSON response costs 0.648 µs through that path versus 0.313 µs
for a direct web response on the same machine. The kernel will publish an internal, typed snapshot
hint only when it can represent headers without a `Headers` instance; every other shape retains the
existing path.

- **In scope:** lazy default response headers, a `ResponseSnapshot.responseInit` inter-package hint,
  adapter consumption of that hint, exact semantic tests, and interleaved Node benchmark evidence.
- **NOT this milestone:** synchronous middleware chains (which require the documented `NextFunction`
  compatibility decision), response object pooling, changing `snapshot()` into a copy, or changing
  the `IResponse` handler API.

## 1. Contracts verified from SOURCE (not names)

| Reference            | Source (file:line)                                                                                                                           | Verified surface / fact                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IResponse.snapshot` | `packages/common/src/http.ts:122-229`                                                                                                        | Returns `ResponseSnapshot`; its documented `headers` member is a live `Headers` read view, not a copy.                                                |
| `ResponseSnapshot`   | `packages/common/src/http.ts:807-826`                                                                                                        | Buffered and streaming discriminated arms both expose `status`, `headers`, and their respective body type.                                            |
| `ResponseBuilder`    | `packages/kernel/src/context/response.ts:16-125`                                                                                             | Eagerly constructs `Headers`; terminal methods write status/body/content type and `snapshot()` returns a fresh shape.                                 |
| Response mapper      | `packages/runtime/src/adapters/shared/fetch-mapping.ts:239-273`                                                                              | Creates the web `Response` from a snapshot; it is the one shared response conversion used by every HTTP adapter.                                      |
| Adapter completion   | `packages/runtime/src/adapters/node/node-http-adapter.ts:298-310`                                                                            | Node maps a framework response only after pipeline completion and accepts the result synchronously when possible.                                     |
| Snapshot consumers   | `packages/cache-plugin/src/middleware/cache-middleware.ts:118-130`, `packages/telemetry-plugin/src/middleware/telemetry-middleware.ts:67-71` | Middleware reads the documented snapshot fields; cache reads `headers`, so the lazy path must materialize an identical live `Headers` when requested. |
| M87 deferral         | `ROADMAP.md:8642-8644`                                                                                                                       | The response path was deliberately deferred to M88; M87's synchronous request dispatch is already shipped.                                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                   | Resolution (picked side)                                                                                                                         | Doc deliverable (same PR)                                                                                                                  |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | M87 describes four response-path objects while `IResponse.snapshot()` promises live `Headers`; removing `Headers` outright would contradict that contract. | Keep `snapshot().headers` exactly as documented and make only the adapter-owned conversion use the typed init hint before the lazy view is read. | Update the `ResponseSnapshot` notes in `PUBLIC_API.md` and `packages/common/README.md`; add this milestone and its status to `ROADMAP.md`. |

## 3. Design decisions

### 3.1 Lazy headers preserve the existing snapshot contract

- **Decision:** `ResponseBuilder` stores a web `Headers` object only after `header`, `appendHeader`,
  or `snapshot().headers` needs its full semantics. Built-in terminal-only headers use a shared,
  immutable internal source and expose a fresh snapshot-local `HeadersInit` record to the adapter. A
  snapshot retains its captured status/body/streaming values, while its `headers` getter
  materializes and returns the same live backing `Headers` object described today.
- **Why:** ordinary `json`, `text`, `html`, byte-send, and redirect responses need known header
  values but do not need framework header mutation before the adapter constructs the native
  response. Materializing `Headers` only for observers removes the framework copy without weakening
  middleware behavior or `Set-Cookie` fidelity.
- **Test home:** `packages/kernel/test/unit/response.test.ts` covers terminal methods, explicit
  headers, appended cookies, snapshots captured before later mutation, and materialized header
  identity.

### 3.2 A typed snapshot-local hint bridges kernel and runtime

- **Decision:** `common` adds `ResponseSnapshotInit` and an optional `ResponseSnapshot.responseInit`
  field. `ResponseBuilder` supplies a fresh, mutable `ResponseInit`-compatible header source only
  when its headers are still unmaterialized; the runtime reads that field before `snapshot.headers`.
- **Why:** runtime must consume the fast representation but cannot import the kernel's internal
  `ResponseBuilder`; a typed common field preserves package boundaries without adding a per-request
  symbol lookup or callback. The ordinary `IResponse` methods and existing snapshot fields remain
  source-compatible.
- **Test home:** `packages/kernel/test/unit/response.test.ts` proves common terminal snapshots carry
  the hint, and `packages/runtime/test/unit/fetch-mapping.test.ts` proves the mapper consumes it
  without reading the live headers view.

### 3.3 The shared mapper prefers the hint without changing output

- **Decision:** `mapSnapshotToWebResponse` consults `snapshot.responseInit` before reading
  `snapshot.headers`. When present, it gives that header init directly to `new Response`; otherwise
  it keeps passing the public `Headers` object through. Streaming bodies still pass through
  unchanged.
- **Why:** this one shared branch covers Node, Deno, Bun, and Workers and retains the custom-header
  and multi-`Set-Cookie` fallback. Reading `snapshot.headers` first would eagerly trigger the exact
  allocation the change removes.
- **Test home:** `packages/runtime/test/unit/fetch-mapping.test.ts` covers the hinted buffered and
  stream paths, normal snapshot fallback, repeated cookies, and byte-for-byte response
  headers/body/status equivalence.

## 4. Exported surface — every symbol names its consumer

| Exported symbol        | Kind      | Consumer / real code path that READS it                                                              |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `ResponseSnapshotInit` | interface | `ResponseBuilder.snapshot()` describes the hint it attaches; `mapSnapshotToWebResponse` consumes it. |

### 4.1 Options — every option names its consumer

None (checked). The change adds no plugin/application configuration and enables the fast path solely
from a response's actual usage.

## 5. Implementation files

| File                                                       | Purpose                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/common/src/http.ts`                              | Define and document the typed snapshot-local response init hint.                 |
| `packages/common/src/index.ts`                             | Re-export the documented `ResponseSnapshotInit` type.                            |
| `packages/kernel/src/context/response.ts`                  | Defer framework `Headers`, publish init hints, and retain live snapshot headers. |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`    | Prefer a snapshot init hint before accessing public headers.                     |
| `packages/kernel/test/unit/response.test.ts`               | Test lazy response headers and complete response semantics.                      |
| `packages/runtime/test/unit/fetch-mapping.test.ts`         | Test hinted mapper behavior and ordinary fallback.                               |
| `packages/runtime/test/integration/runtime-plugin.test.ts` | Exercise terminal JSON through the real Node adapter and `@hono/node-server`.    |
| `PUBLIC_API.md`                                            | Document the common protocol and compatibility behavior.                         |
| `packages/common/README.md`                                | Add the response snapshot-init type/functions to the export listing.             |
| `ROADMAP.md`                                               | Add M88 scope and Progress Tracking row.                                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                  | src covered                                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel/test/unit/response.test.ts`               | `kernel/src/context/response.ts`                     | Every terminal method has its existing status/body/header semantics; `snapshot(): ResponseSnapshot` exposes live `Headers` when read and carries `responseInit` only for an unmaterialized common terminal shape. |
| `packages/runtime/test/unit/fetch-mapping.test.ts`         | `runtime/src/adapters/shared/fetch-mapping.ts`       | `mapSnapshotToWebResponse(snapshot): Response` preserves status, headers, buffers, streams, and `Set-Cookie` on both hinted and unhinted snapshots.                                                               |
| `packages/runtime/test/integration/runtime-plugin.test.ts` | `kernel/src/context/response.ts` + Node adapter seam | A terminal JSON response traverses `RuntimePlugin({ platform: 'node' })`, the real `@hono/node-server`, and a loopback socket.                                                                                    |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m88-response-path-performance, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task publish:check
deno task release:verify <version>
```

## 8. Risks & mitigations

- A lazy `Headers` implementation could change `set`/`append` normalization or coalesce `Set-Cookie`
  values. → Any explicit header operation materializes native `Headers`; regression tests cover
  overwrite, append, and `getSetCookie()`.
- A snapshot hint could accidentally be used after a consumer mutates headers. → The hint is
  attached only while the builder has no mutable headers; reading `snapshot.headers` clears the fast
  representation by materializing it before returning it. Each hint access returns a fresh record,
  so a native server adding `Content-Length` cannot mutate the shared internal source.
- The measurement could be noise. → Compare the branch to its parent with repeated focused
  response-conversion samples and keep the optimization only when output equivalence and A/B
  measurements agree. The final five-sample in-process builder → snapshot → web-response comparison
  (200,000 JSON responses/sample) had medians of 0.241 µs/op on this branch and 0.375 µs/op on the
  clean M87 baseline worktree: 35.7% lower response-conversion cost. The follow-up Node-adapter
  loopback driver alternated five 2,000-request JSON samples: its medians were 12,381 requests/sec
  on this branch and 11,799 requests/sec on M87 (+4.9%), with substantial local-run variance.
  Neither result is a claim of equivalent production throughput.

## 9. Out of scope

- Making `executeChain` synchronous remains deferred because widening `NextFunction` changes code
  that calls `next().then(...)`.
- Pooling response builders or sharing mutable `Headers` across requests is excluded; it would
  violate per-request state isolation.
