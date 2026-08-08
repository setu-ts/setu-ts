# Milestone 55 — Static File Serving (`@setu-ts/static-plugin`)

> **Status:** Planning. Branch: `feat/m55-static-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The framework has exactly one static file server, `createStaticAssetHandler` in
`react-router-plugin`, written to deliver content-hashed SSR bundles. It does that correctly and is
wrong for every other use: an unconditional immutable `Cache-Control`, no directory-index
resolution, no conditional requests, and a whole-file read into memory. This milestone ships static
file serving as a first-class capability — a new `@setu-ts/static-plugin` registering `IStaticFiles`
under a new `CAPABILITIES.STATIC_FILES` token — and widens `IFileSystem` with an optional
read-stream member so a large file is never fully materialised. The pure parts shared with the
existing handler move into `common`, and `react-router-plugin` delegates to them, so one
content-type map and one containment check exist rather than two that drift.

- **In scope:** the `static-plugin` package; the optional `IFileSystem.readStream?` widening in
  `common` plus its Node/Deno/Bun adapter implementations; the shared `content-types` and
  `path-containment` pure modules in `common`; `react-router-plugin` delegating to those two modules
  with its emitted headers pinned unchanged; conditional requests, Range, precompressed sidecar
  negotiation, index resolution, SPA fallback, `HEAD`, a health indicator; an `apps/static-site`
  example with a smoke check.
- **NOT this milestone:** on-the-fly compression (out of scope permanently — ROADMAP M55 "Explicitly
  out of scope"); directory listing (same); serving from object storage, which `storage-plugin`
  already owns via `getStream`; Workers asset serving, which belongs to `cloudflare-plugin` (M52)
  and its Workers Assets / R2 bindings.

## 1. Contracts verified from SOURCE (not names)

| Reference                        | Source (file:line)                                                            | Verified surface / fact                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IFileSystem`                    | `packages/common/src/runtime.ts:51`                                           | `readFile`, `realPath?`, `writeFile`, `stat`, `readdir`, `mkdir`, `rm`. **No stream member, no partial read, no byte-range read** — this is why §3.3 widens it.              |
| `StatResult`                     | `packages/common/src/runtime.ts:34`                                           | `isFile`, `isDirectory`, `size`, `mtime?`. `mtime` is OPTIONAL — the ETag strategy in §3.6 must work without it.                                                             |
| `IResponse.stream`               | `packages/common/src/http.ts:175`                                             | `stream(body: ReadableStream<Uint8Array>): HandlerResult`. Exists since M42; the streaming path needs no response-side change.                                               |
| `IRequest.headers`               | `packages/common/src/http.ts:41`                                              | `readonly headers: Headers` — web-standard, so `If-None-Match`, `If-Modified-Since`, `Range`, `Accept-Encoding`, `Accept` are all readable with no widening.                 |
| `RouteHandler`                   | `packages/common/src/http.ts:290`                                             | `(ctx: IRequestContext) => HandlerResult \| Promise<HandlerResult>`. The handler shape §3.9 mounts on both verbs.                                                            |
| `IRouterApi.get` / `.head`       | `packages/common/src/plugin.ts:81`, `:116`                                    | Both exist. `head()` is available, so §3.9 needs no kernel change.                                                                                                           |
| `IPluginContext.health`          | `packages/common/src/plugin.ts:466`                                           | `readonly health: IHealthApi` — the indicator in §3.12 registers here.                                                                                                       |
| `createCapabilityToken` grammar  | `packages/common/src/tokens.ts:179-187`                                       | Lowercase kebab-case, optionally dot-namespaced. **Colons are illegal.** `static-files` passes.                                                                              |
| `CAPABILITIES` insertion point   | `packages/common/src/tokens.ts:136`                                           | `CLOUDFLARE: 'cloudflare'` is the last entry; `STATIC_FILES: 'static-files'` is appended after it. No existing token is `static`/`static-files`.                             |
| `createStaticAssetHandler`       | `packages/react-router-plugin/src/assets/static-assets.ts:54`                 | `(options: { fs, assetsDir, assetUrlPrefix }) => RouteHandler`. Exported from that package's barrel at `src/index.ts:25`.                                                    |
| Its hardcoded cache header       | `packages/react-router-plugin/src/assets/static-assets.ts:42`, applied `:130` | `CACHE_CONTROL_IMMUTABLE` is a module constant applied unconditionally to every response. This is defect #1.                                                                 |
| Its index behaviour              | `packages/react-router-plugin/src/assets/static-assets.ts:81-83`              | Returns `404` for `''` and `/`. No index resolution. Defect #2.                                                                                                              |
| Its content-type map             | `packages/react-router-plugin/src/assets/static-assets.ts:15-35`              | 19 extensions, module-private `CONTENT_TYPES`. This is the map §3.2 promotes.                                                                                                |
| Its containment logic            | `packages/react-router-plugin/src/assets/static-assets.ts:89-114`             | Lexical `..` rejection, then `realPath`-based containment when available. This is the guard §3.2 promotes.                                                                   |
| RR mounts GET only               | `packages/react-router-plugin/src/plugin/react-router-plugin.ts:153`          | `ctx.router.get(assetRoutePattern, assetHandler)` — no `HEAD`. Defect noted, fixed for RR by §3.11 delegation only if it re-mounts; see §3.11 decision.                      |
| RR skips the route with no fs    | `packages/react-router-plugin/src/plugin/react-router-plugin.ts:146`, `:155`  | `if (runtime.fs != null)` guards registration; comment states 404-degrade on edge. The precedent §3.10 follows.                                                              |
| Deno fs adapter                  | `packages/runtime/src/adapters/deno/deno-runtime.ts:81`                       | Builds `const fs: IFileSystem` from an injectable `DenoHost`. Async throughout.                                                                                              |
| Node fs adapter                  | `packages/runtime/src/adapters/node/node-runtime.ts:123`                      | Builds `fs` from an injectable `NodeModules.fs`, already `node:fs/promises`-shaped.                                                                                          |
| Bun fs adapter                   | `packages/runtime/src/adapters/bun/bun-runtime.ts:87`, host at `:39`          | Builds `fs` from an injectable `BunHost` whose members are **synchronous** (`readFile: (path) => Uint8Array \| null`), wrapped into promises. Imports `node:fs` at `:20-28`. |
| Workers omits fs                 | `packages/runtime/src/adapters/workers/cf-runtime.ts:6`                       | Documented: "`fs` is `undefined` (no file system on edge)." So `runtime.fs` is absent on Workers — §3.10.                                                                    |
| `storage-plugin` already streams | `packages/storage-plugin/src/index.ts` (`IStorage.getStream?`)                | Object-storage streaming exists and is a DIFFERENT concern (remote buckets, not a local root). Confirms no overlap rather than duplication.                                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                 | Resolution (picked side)                                                                                                                                        | Doc deliverable (same PR)                                                                |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| C1 | `IFileSystem.realPath?` JSDoc (`packages/common/src/runtime.ts:64-65`) names "the static-asset handler in the React Router plugin" as the canonical caller. After §3.2 the caller moves. | Update the JSDoc to name the shared `common` containment helper as the caller, since that is what will actually read it.                                        | `packages/common/src/runtime.ts` JSDoc correction.                                       |
| C2 | ARCHITECTURE §8 package diagram does not contain a `static-plugin` node, and M38's backlog already records that diagram as out of date for 10 members.                                   | Add the node in this PR rather than deferring to M38 — M50 set the precedent of adding its own node while leaving the pre-existing backlog named and untouched. | `ARCHITECTURE.md` §8 diagram gains `static-plugin`; the M38 backlog line is left intact. |
| C3 | ARCHITECTURE §10 middleware priority table has no row for static serving.                                                                                                                | No row is added: this capability is a **route handler**, not middleware (§3.13). The table stays correct as-is.                                                 | None — recorded here so a reviewer does not re-raise it.                                 |
| C4 | `PUBLIC_API.md` has no Static Files section, and no `STATIC_FILES` row in its capability-token table.                                                                                    | Add both, plus the `IFileSystem.readStream?` row in the runtime section, in this PR (§10.5: every export from `index.ts` must be in `PUBLIC_API.md`).           | `PUBLIC_API.md` gains a Static Files section (Options/Exports/Notes) and two table rows. |
| C5 | Root `README.md` capability list has no static-serving entry and its package/plugin counts are stated numerically.                                                                       | Add the row and bump the counts — the M50 precedent, where five inconsistent counts were corrected in the milestone that added the 43rd member.                 | `README.md` row + count correction.                                                      |

## 3. Design decisions

### 3.1 Package, capability token, and service shape

- **Decision:** a new package `packages/static-plugin` (`@setu-ts/static-plugin`) exporting
  `StaticPlugin(options)`, which registers a `StaticFilesService` implementing `IStaticFiles` under
  a new `CAPABILITIES.STATIC_FILES = 'static-files'`. `IStaticFiles` is declared in the **plugin**,
  not `common`: no second implementation is planned and no other package resolves it, so promoting
  it would be speculative surface. The token goes in `common` because tokens are the one thing
  plugins must share.
- **Why:** §3.1/§3.6 of AI_GUIDELINES require every capability to be a plugin named
  `@setu-ts/[name]-plugin`. Declaring the interface locally follows the M50 `DiscoveryProvider`
  precedent (port declared in the owning plugin) rather than the M52c promotion, which happened only
  because a second package genuinely needed to implement it.
- **Test home:** `test/unit/barrel-exports.test.ts` (token value and grammar),
  `test/integration/static-integration.test.ts` (resolution through a real kernel app).

### 3.2 Shared pure modules move to `common`; both packages read one implementation

- **Decision:** two new pure modules in `common` — `src/static/content-types.ts` exporting
  `contentTypeFor(path: string): string`, and `src/static/path-containment.ts` exporting
  `isLexicallyContained(relativePath: string): boolean` and
  `assertRealPathContained(fs, root, target): Promise<boolean>`. `static-plugin` and
  `react-router-plugin` both import them. The extension map gains the extensions a general server
  needs (`.txt`, `.xml`, `.map`, `.wasm`, `.mp4`, `.webm`, `.eot`, `.md`) on top of the existing 19.
- **Why:** §2.2 forbids `static-plugin` importing `react-router-plugin`. §2.1 permits "pure
  zero-dependency type utilities" in `common`, and these are pure string/boolean functions with no
  I/O — `assertRealPathContained` takes `fs` as a parameter rather than reaching for a runtime, so
  `common` still imports nothing. This is the M47 frame-codec and M52 `splitWorkerEnv` precedent,
  and it **deletes** a duplicate instead of creating the M30b `pemToDer` one.
- **Test home:** `test/unit/content-types.test.ts` and `test/unit/path-containment.test.ts` in
  `packages/common`.

### 3.3 The `IFileSystem` widening

- **Decision:** one new OPTIONAL member on `IFileSystem`:

  ```typescript
  readStream?(
    path: string,
    options?: { readonly start?: number; readonly end?: number },
  ): Promise<ReadableStream<Uint8Array>>;
  ```

  `start` and `end` are byte offsets and **`end` is inclusive**, matching both `node:fs`
  `createReadStream` and HTTP `Range` semantics so no off-by-one translation layer is needed.
  Implemented by the Node, Deno, and Bun adapters; omitted on Workers.
- **Why:** optional and additive, so no existing implementor breaks and every current `IFileSystem`
  caller is untouched — the M44 `realPath?`, M45 `workers?`, M50 `dns?` precedent. Inclusive `end`
  is chosen because both the platform API and the wire format already use it; picking exclusive
  would put an off-by-one in the one place this milestone is most likely to get wrong.
- **Per-runtime mechanism, fixed here so it is not improvised:**
  - **Node** (`node-runtime.ts`): `createReadStream(path, { start, end })` from `node:fs`, then
    `Readable.toWeb(stream) as ReadableStream<Uint8Array>` from `node:stream`. Added to the
    injectable `NodeModules.fs` seam.
  - **Bun** (`bun-runtime.ts`): identical to Node — the adapter already statically imports `node:fs`
    at `:20-28`. Added to the `BunHost` seam. Note the existing host members are synchronous;
    `readStream` returns the stream object synchronously from `createReadStream`, so the seam member
    stays sync-shaped (`(path, options) => ReadableStream<Uint8Array> | null`) and the `IFileSystem`
    wrapper promotes it to a promise, exactly as `readFile` is wrapped at `:88-95`.
  - **Deno** (`deno-runtime.ts`): `Deno.open(path)` then, when `start`/`end` are absent,
    `file.readable` directly. When a range IS requested, `file.seek(start, Deno.SeekMode.Start)`
    followed by a `ReadableStream` that reads at most `end - start + 1` bytes and closes the file in
    `cancel()` as well as on completion. **`FsFile.readable` has no range parameter** — this wrapper
    is required, and it is the one place the three runtimes genuinely differ.
- **Test home:** `packages/common/test/unit/runtime-contracts.test.ts` (the member is optional and a
  fs without it still satisfies `IFileSystem`); per-adapter unit tests driving the injected host
  seam; `packages/runtime/test/integration/read-stream-real.test.ts` as the guarded REAL-fs test
  (reads a temp file, whole and ranged, on the actual platform).

### 3.4 `Cache-Control` resolution

- **Decision:** `cacheControl?: string | ((relativePath: string) => string)`. When a string, it is
  used verbatim for every response. When a function, it is called per request with the root-relative
  path. The default is a function returning `'public, max-age=31536000, immutable'` for a path
  matching `IMMUTABLE_PATTERN` (`/[.-][0-9a-f]{8,}\.[a-z0-9]+$/i` — a content-hash segment before
  the extension) and `'public, max-age=0, must-revalidate'` otherwise.
- **Why:** the hardcoded constant is the headline defect. A per-path function is the smallest
  surface that expresses "hashed assets are immutable, everything else revalidates" without asking
  the application to enumerate paths. `must-revalidate` with `max-age=0` rather than `no-cache`
  because it still permits a `304`, which is the entire point of §3.6.
- **Test home:** `test/unit/cache-control.test.ts` — asserts both defaults on representative paths,
  a string override, and a function override; plus the ONE test driving both `StaticPlugin` and the
  standalone handler under a non-default `cacheControl` (CLAUDE.md's two-entry-points rule).

### 3.5 Index resolution and SPA fallback

- **Decision:** two separate options. `index?: string` (default `'index.html'`) — when the resolved
  path is a directory, `<dir>/<index>` is served; `index: ''` disables. `fallback?: string`
  (default: unset) — when the resolved file does NOT exist, the request method is `GET`/`HEAD`, and
  the request's `Accept` header includes `text/html`, serve `<root>/<fallback>` with status `200`.
  The `Accept` condition is mandatory, not cosmetic.
- **Why:** without the `Accept` guard a missing `/app.js` returns the HTML shell with a
  `text/javascript` content type, which browsers surface as an opaque syntax error — the classic
  SPA-fallback bug. Keeping `index` and `fallback` separate matters because a static site wants
  `index` and no `fallback`, while an SPA wants both.
- **Test home:** `test/unit/resolve-path.test.ts` (directory → index, disabled index, fallback hit,
  fallback correctly NOT taken for a missing `.js` with a non-HTML `Accept`).

### 3.6 Conditional requests and the ETag strategy

- **Decision:** a **weak** validator derived from `stat`: `W/"<size>-<mtimeMs>"`, falling back to
  `W/"<size>"` when `StatResult.mtime` is absent. `Last-Modified` is emitted only when `mtime` is
  present. A request is answered `304` (no body, but with `ETag`, `Last-Modified` and
  `Cache-Control` retained) when `If-None-Match` matches the computed ETag, or — only when
  `If-None-Match` is absent — when `If-Modified-Since` is not older than `mtime`.
- **Why:** `StatResult.mtime` is optional in the committed contract (`runtime.ts:34`), so a strategy
  requiring it would break on any adapter that omits it. Weak is honest: size+mtime does not prove
  byte equality. `If-None-Match` taking precedence over `If-Modified-Since` is required by RFC 9110
  §13.1.3 and is the kind of rule that gets silently inverted without a named decision.
- **Test home:** `test/unit/conditional.test.ts` — ETag with and without `mtime`, `304` on match,
  `200` on mismatch, `If-None-Match` winning over a contradictory `If-Modified-Since`.

### 3.7 Range requests

- **Decision:** single-range only. Parse `Range: bytes=<start>-<end>`, with open-ended
  (`bytes=500-`) and suffix (`bytes=-500`) forms supported. On success: `206`,
  `Content-Range:
  bytes <start>-<end>/<size>`, `Content-Length` of the slice, body from
  `fs.readStream(path, { start, end })`. Unsatisfiable (start beyond `size - 1`): `416` with
  `Content-Range: bytes */<size>`. A multi-range header (containing a comma) is **ignored** and the
  full `200` is served. `Accept-Ranges: bytes` is emitted on every `200` for a file. A `Range`
  request is honoured only when `If-Range` is absent or matches the current ETag.
- **Why:** multipart/byteranges is a materially larger encoder for a case browsers essentially never
  send; ignoring it and serving `200` is explicitly permitted and is what most servers do. `416`
  rather than clamping because a client asking beyond EOF has stale metadata and should be told.
- **Test home:** `test/unit/range.test.ts` — all three forms, `416`, multi-range falling back to
  `200`, and `If-Range` mismatch falling back to `200`.

### 3.8 Precompressed sidecar negotiation

- **Decision:** when `compressed !== false` (default enabled), and `Accept-Encoding` permits, probe
  `<file>.br` then `<file>.gz` via `stat`. On a hit, serve the sidecar's bytes with
  `Content-Encoding: br|gzip`, the **original** file's content type, `Vary: Accept-Encoding`, and an
  ETag computed from the **sidecar's** stat. Range requests apply to the sidecar's byte range.
- **Why:** the ETag must come from the sidecar or two different byte streams share one validator,
  which corrupts caches — the single most likely correctness bug in this feature. `Vary` is
  mandatory for the same reason. Brotli is probed first because it is smaller when both exist.
- **Test home:** `test/unit/precompressed.test.ts` — `.br` preferred, `.gz` fallback, neither
  present, `Accept-Encoding` absent, and an assertion that the sidecar's ETag differs from the
  original's.

### 3.9 `GET` and `HEAD` share one handler

- **Decision:** `StaticPlugin` mounts the same `RouteHandler` on `ctx.router.get` and
  `ctx.router.head`. The handler branches on `ctx.request.method === 'HEAD'` to send headers with no
  body, after computing everything else identically.
- **Why:** CLAUDE.md's one-capability-one-implementation rule. Two handlers drift; the existing RR
  handler mounts GET only (`react-router-plugin.ts:153`), which is why `HEAD` is missing today.
- **Test home:** `test/integration/static-integration.test.ts` — a `HEAD` and a `GET` on one path
  assert identical status and identical `Content-Length`/`ETag`/`Cache-Control`, with an empty body
  on the `HEAD`.

### 3.10 Workers degradation

- **Decision:** `register()` checks `ctx.runtime.fs`. When absent, the service is still registered
  and the health indicator reports `degraded` with `detail: 'no file system on this runtime'`, but
  **no route is mounted**. `IStaticFiles.serve()` called directly returns a `404`-shaped result
  rather than throwing.
- **Why:** exactly the RR precedent at `react-router-plugin.ts:146,155`. A missing file is a `404`,
  so a throw would be the wrong signal — this is the inverse of M45's `WorkerPoolUnavailableError`,
  where the operation genuinely cannot be expressed at all.
- **Test home:** `test/unit/static-plugin.test.ts` — registration with an `fs`-less runtime mounts
  no route, registers the capability, and reports `degraded`.

### 3.11 `react-router-plugin` delegates, with headers pinned

- **Decision:** `createStaticAssetHandler` keeps its exact signature and exported name, and its
  internal `CONTENT_TYPES` and containment block are replaced by calls to the two `common` modules
  from §3.2. Its hardcoded `CACHE_CONTROL_IMMUTABLE` behaviour is **retained unchanged** — this
  milestone does NOT add ETag, index resolution, or `HEAD` to the RR handler.
- **Why:** RR serves content-hashed bundles, where immutable is correct; changing its emitted
  headers would be a behaviour change to a published package for no benefit, and §9.4 forbids silent
  ones. Applications wanting the richer behaviour mount `StaticPlugin`. The delegation is worth
  doing regardless because it removes the duplicate map.
- **Test home:** `packages/react-router-plugin/test/unit/static-assets.test.ts` gains a regression
  test asserting the exact `Content-Type` and `Cache-Control` emitted for a hashed `.js` asset, so
  the delegation is proven byte-identical rather than assumed.

### 3.12 Health indicator

- **Decision:** register a `static-files` indicator that `stat`s the configured root once per probe
  and reports `up` when `isDirectory`, `down` with the error message when the stat throws, and
  `degraded` when `runtime.fs` is absent (§3.10). It never reads a file.
- **Why:** a misconfigured root is the most common failure and is invisible otherwise — the M52c D1
  lesson, where an unvalidated binding let an app boot clean and fail every request. Statting a
  directory is cheap; reading a file per probe would not be.
- **Test home:** `test/unit/health.test.ts` — all three states.

### 3.13 Route handler, not middleware

- **Decision:** the capability mounts route handlers at a configured `urlPrefix` (default `'/'`) via
  `ctx.router.get`/`.head`, and adds no middleware. No entry is added to the ARCHITECTURE §10
  priority table.
- **Why:** middleware would run an `fs` probe on every request in the application including API
  routes, which §14.1 and the M19 metrics-priority reasoning both argue against. A route handler
  costs nothing on paths it does not own.
- **Test home:** `test/integration/static-integration.test.ts` — an API route registered alongside
  the static root still reaches its own handler, and the static handler is not consulted for it.

## 4. Exported surface — every symbol names its consumer

| Exported symbol             | Kind      | Consumer / real code path that READS it                                                                                                                    |
| --------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StaticPlugin`              | function  | Application composition (`createApplication({ plugins: [...] })`); `apps/static-site/main.ts`; the integration test.                                       |
| `StaticFilesService`        | class     | Registered by `StaticPlugin` under the token; resolved by the integration test through `ctx.services.get`.                                                 |
| `IStaticFiles`              | interface | The type parameter every `ctx.services.get<IStaticFiles>(CAPABILITIES.STATIC_FILES)` call uses.                                                            |
| `StaticPluginOptions`       | type      | The `StaticPlugin` parameter; read by `apps/static-site` and by the options tests.                                                                         |
| `createStaticHandler`       | function  | The standalone entry point — mounted manually by an application that does not want the plugin; the second entry point in the two-entry-points test (§3.4). |
| `CAPABILITIES.STATIC_FILES` | token     | `common` export; read by `StaticPlugin.provides` and by every consumer resolving the service.                                                              |
| `contentTypeFor`            | function  | `common` export; read by `static-plugin`'s handler AND `react-router-plugin`'s handler (§3.2).                                                             |
| `isLexicallyContained`      | function  | `common` export; read by both handlers' traversal guard.                                                                                                   |
| `assertRealPathContained`   | function  | `common` export; read by both handlers' symlink guard.                                                                                                     |
| `IFileSystem.readStream?`   | member    | `common` contract; implemented by three runtime adapters, read by the static handler's body path (§3.3, §3.7).                                             |

### 4.1 Options — every option names its consumer

| Option           | Consumer                          | Behavior (per implementation)                                                                                |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `root`           | `resolvePath`, health indicator   | Required. Filesystem directory served. No default — an implicit root is a security footgun.                  |
| `urlPrefix`      | route registration, `resolvePath` | Default `'/'`. Stripped from the request path before resolution.                                             |
| `index`          | `resolvePath` (§3.5)              | Default `'index.html'`. `''` disables directory-index resolution.                                            |
| `fallback`       | `resolvePath` (§3.5)              | Unset by default. When set, served for a missing file on `GET`/`HEAD` with an HTML-accepting `Accept`.       |
| `cacheControl`   | header assembly (§3.4)            | Default: the hashed/unhashed function. String applies verbatim; function is called per request.              |
| `etag`           | conditional handling (§3.6)       | Default `true`. `false` emits no `ETag` and skips `If-None-Match`; `Last-Modified` still applies.            |
| `ranges`         | Range handling (§3.7)             | Default `true`. `false` omits `Accept-Ranges` and ignores `Range`, always serving `200`.                     |
| `compressed`     | sidecar negotiation (§3.8)        | Default `true`. `false` skips the `.br`/`.gz` probe entirely (two `stat` calls saved per request).           |
| `maxBufferBytes` | body path (§3.3)                  | Default `1_048_576`. Files at or below this are read with `readFile`; above it, `readStream` when available. |

## 5. Implementation files

| File                                                              | Purpose                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/static-plugin/src/index.ts`                             | Barrel: `StaticPlugin`, `StaticFilesService`, `createStaticHandler`, `IStaticFiles`, `StaticPluginOptions`. `@module` FIRST in the JSDoc (release:verify check 5). |
| `packages/static-plugin/src/plugin/static-plugin.ts`              | `StaticPlugin` factory: option defaults, route mounting on `get`+`head`, health registration, Workers degradation.                                                 |
| `packages/static-plugin/src/handler/static-handler.ts`            | `createStaticHandler` — the single `RouteHandler` both entry points use.                                                                                           |
| `packages/static-plugin/src/handler/resolve-path.ts`              | Prefix stripping, containment, directory-index, SPA fallback (§3.5).                                                                                               |
| `packages/static-plugin/src/http/cache-control.ts`                | `IMMUTABLE_PATTERN`, the default resolver, and option normalisation (§3.4).                                                                                        |
| `packages/static-plugin/src/http/conditional.ts`                  | ETag computation and `If-None-Match` / `If-Modified-Since` evaluation (§3.6).                                                                                      |
| `packages/static-plugin/src/http/range.ts`                        | `Range` parsing, `Content-Range` assembly, `416` decision (§3.7).                                                                                                  |
| `packages/static-plugin/src/http/precompressed.ts`                | `Accept-Encoding` parsing and sidecar probing (§3.8).                                                                                                              |
| `packages/static-plugin/src/services/static-files-service.ts`     | `IStaticFiles` implementation registered under the token.                                                                                                          |
| `packages/static-plugin/src/interfaces/index.ts`                  | `IStaticFiles`, `StaticPluginOptions`.                                                                                                                             |
| `packages/common/src/static/content-types.ts`                     | `contentTypeFor` — the promoted map (§3.2).                                                                                                                        |
| `packages/common/src/static/path-containment.ts`                  | `isLexicallyContained`, `assertRealPathContained` (§3.2).                                                                                                          |
| `packages/common/src/runtime.ts` (edit)                           | `IFileSystem.readStream?` (§3.3) + the C1 JSDoc correction.                                                                                                        |
| `packages/common/src/tokens.ts` (edit)                            | `STATIC_FILES: 'static-files'`.                                                                                                                                    |
| `packages/common/src/index.ts` (edit)                             | Re-export the two static modules.                                                                                                                                  |
| `packages/runtime/src/adapters/node/node-runtime.ts` (edit)       | `readStream` via `createReadStream` + `Readable.toWeb` (§3.3).                                                                                                     |
| `packages/runtime/src/adapters/bun/bun-runtime.ts` (edit)         | Same, through the `BunHost` seam (§3.3).                                                                                                                           |
| `packages/runtime/src/adapters/deno/deno-runtime.ts` (edit)       | `Deno.open` + `readable`, with the seek/limit wrapper for ranges (§3.3).                                                                                           |
| `packages/react-router-plugin/src/assets/static-assets.ts` (edit) | Delegate to the two `common` modules; behaviour unchanged (§3.11).                                                                                                 |
| `apps/static-site/{deno.json,main.ts,smoke.ts,public/*}`          | The runnable example (outside the workspace, own `deno.json`, per M37).                                                                                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                    | src covered                           | Key assertions (and the signature each call type-checks against)                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static-plugin/test/unit/static-plugin.test.ts`              | `plugin/static-plugin.ts`             | Mounts on BOTH `get` and `head`; registers the token; `fs`-absent runtime mounts no route and reports `degraded`. Calls `StaticPlugin(options: StaticPluginOptions)`.                  |
| `static-plugin/test/unit/static-handler.test.ts`             | `handler/static-handler.ts`           | `200` with body and content type; `404` missing; `HEAD` returns identical headers with empty body. Handler typed `RouteHandler` per `http.ts:290`.                                     |
| `static-plugin/test/unit/resolve-path.test.ts`               | `handler/resolve-path.ts`             | Prefix stripping; `..` rejected; directory → `index`; `index: ''` disables; fallback taken for HTML `Accept`; fallback NOT taken for a missing `.js`.                                  |
| `static-plugin/test/unit/cache-control.test.ts`              | `http/cache-control.ts`               | Hashed path → immutable; unhashed → `must-revalidate`; string override verbatim; function override called with the root-relative path.                                                 |
| `static-plugin/test/unit/conditional.test.ts`                | `http/conditional.ts`                 | ETag with `mtime`; ETag without `mtime` (contract-faithful `StatResult` per `runtime.ts:34`); `304` on match; `If-None-Match` beats `If-Modified-Since`.                               |
| `static-plugin/test/unit/range.test.ts`                      | `http/range.ts`                       | `bytes=0-99`, `bytes=500-`, `bytes=-500`; `416` with `Content-Range: bytes */<size>`; comma multi-range → `200`; `If-Range` mismatch → `200`.                                          |
| `static-plugin/test/unit/precompressed.test.ts`              | `http/precompressed.ts`               | `.br` preferred over `.gz`; `.gz` fallback; neither → identity; sidecar ETag differs from the original's; `Vary: Accept-Encoding` present.                                             |
| `static-plugin/test/unit/static-files-service.test.ts`       | `services/static-files-service.ts`    | `serve()` returns the same result the route handler produces for the same path.                                                                                                        |
| `static-plugin/test/unit/health.test.ts`                     | `plugin/static-plugin.ts` (indicator) | `up` for a real directory; `down` when `stat` rejects; `degraded` with no `fs`.                                                                                                        |
| `static-plugin/test/unit/barrel-exports.test.ts`             | `src/index.ts`, `interfaces/`         | Exactly the documented public surface; `STATIC_FILES` passes `createCapabilityToken` (`tokens.ts:179`).                                                                                |
| `static-plugin/test/integration/static-integration.test.ts`  | all, through a kernel app             | Real `createApplication` + `inject`/`fetch`: `200` for a file, `304` on revalidation, SPA fallback, and an API route alongside the static root still reaching its own handler (§3.13). |
| `static-plugin/test/e2e/static-application.test.ts`          | all                                   | `app.fetch` (never `inject`, since streamed bodies and response headers are involved — the M51 `Allow` lesson): streamed large file, Range `206`, `HEAD`.                              |
| `static-plugin/test/unit/two-entry-points.test.ts`           | plugin + handler                      | Drives `StaticPlugin` AND `createStaticHandler` under a NON-default `cacheControl` and asserts identical output (CLAUDE.md's mandatory rule).                                          |
| `common/test/unit/content-types.test.ts`                     | `static/content-types.ts`             | Known extensions; unknown → `application/octet-stream`; case-insensitive; no extension.                                                                                                |
| `common/test/unit/path-containment.test.ts`                  | `static/path-containment.ts`          | `..` forms rejected; encoded traversal; `assertRealPathContained` true inside / false for a symlink escaping the root, driven with a fake `fs`.                                        |
| `common/test/unit/runtime-contracts.test.ts` (edit)          | `runtime.ts`                          | An `IFileSystem` WITHOUT `readStream` still satisfies the interface (proves the member is optional).                                                                                   |
| `runtime/test/unit/{node,bun,deno}-runtime.test.ts` (edit)   | three adapters                        | `readStream` with and without `{start,end}`, driven through each adapter's injected host seam; the Deno range wrapper closes the file on `cancel()`.                                   |
| `runtime/test/integration/read-stream-real.test.ts`          | three adapters                        | **Guarded REAL-fs test**: writes a temp file, reads it whole and ranged through the actual platform API, asserts bytes. Skipped where `runtime.fs?.readStream` is absent.              |
| `react-router-plugin/test/unit/static-assets.test.ts` (edit) | `assets/static-assets.ts`             | Regression: exact `Content-Type` and `Cache-Control` for a hashed `.js` asset, proving §3.11 delegation is byte-identical.                                                             |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m55-static-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:apps        # NOT covered by the four gates — the M55 example must run
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.4
```

Additionally, because this milestone adds a package: `packages/static-plugin` MUST be added to
`PUBLISHED_PACKAGES` in `scripts/release-packages.ts`, or `release:verify` fails check 3 — the M51
defect, where a workspace member in neither list would simply never have published.

## 8. Risks & mitigations

- **The Deno range wrapper leaks a file handle.** `Deno.open` returns a resource that
  `ReadableStream` will not close on its own when the consumer cancels → close in both the
  `cancel()` path and on normal completion, and assert it in the adapter unit test with a fake that
  counts closes.
- **The sidecar ETag is taken from the original file**, so an identity response and a brotli
  response share a validator and poison caches → §3.8 fixes the source of truth and the test asserts
  the two differ.
- **`Readable.toWeb` is not available on an old Node** → it is stable from Node 18, which is below
  the repo's floor; the adapter test drives the injected seam so the branch is covered without
  depending on the host's version.
- **`maxBufferBytes` splits the body path in two**, so a bug can live in the streamed branch only →
  the e2e test uses a file deliberately larger than the default so the streamed branch is the one
  exercised end-to-end, and the unit tests drive both sides explicitly.
- **The `common` promotion changes a published package's internals** → §3.11 pins RR's emitted
  headers with a regression test that must fail if the delegation alters them.
- **A local implementer may guess at platform APIs rather than reading them** → §3.3 fixes the exact
  call for all three runtimes, including the fact that `Deno.FsFile.readable` takes no range.

## 9. Out of scope

- **On-the-fly compression** — permanently out of scope (ROADMAP M55), because it spends CPU per
  request on a result a build step or CDN produces once.
- **Directory listing** — permanently out of scope; an information-disclosure default.
- **Object-storage serving** — `storage-plugin` owns it via `IStorage.getStream?`.
- **Workers asset serving** — `cloudflare-plugin` (M52) owns it via Workers Assets and R2.
- **Making `ReactRouterPlugin` emit ETags, resolve an index, or mount `HEAD`** — deliberately not
  done (§3.11); applications wanting that mount `StaticPlugin`.
