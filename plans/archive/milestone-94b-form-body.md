# Milestone 94b — one form-body abstraction (`@setu-ts/common`, `runtime`, `kernel`, `testing`, `storage-plugin`, `session-plugin`)

> **Status:** Planning. Branch: `feat/m94b-form-data`. `main` is protected — all work
> (implementation
>
> - fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

`IRequest` exposes `json()` / `text()` / `bytes()` and no form accessor
(`packages/common/src/http.ts:35-112`). That single gap is the root cause of three frictions the M92
demo applications hit: an application hand-rolls urlencoded parsing, `session-plugin`'s CSRF
verifier structurally cannot see a token in a multipart body, and `storage-plugin` ships a multipart
parser nothing else can reach. This milestone adds an **optional** `IRequest.formData?()` returning
one shape for both form encodings, memoized exactly as `json()` is; promotes the zero-import
multipart parser into `common` as the single implementation every producer and every fallback path
reads; and points both first-party consumers at it. The multipart CSRF hole closes as a
**consequence** of the shared accessor rather than as its own fix.

- **In scope:** the `FormBody` / `FormFile` value shape and the pure `parseFormBody` /
  `formEncodingOf` that produce it, in `common`; `formData?()` on the `IRequest` type and on all
  three in-repo implementations (`runtime`'s `FrameworkRequest`, the kernel's `inject()` synthetic
  request, `testing`'s `MockRequest`); deletion of `storage-plugin`'s private parser in favour of
  the promoted one; `createUploadMiddleware` and the CSRF verifier consuming the accessor; the
  documentation corrections named in §2.
- **NOT this milestone:** the application-owned error-response hook (M94a, shipped); the CSRF token
  field helper and the global-registration documentation (M94c); a streaming request body, which
  would let a middleware decline to read at all (unowned — named in §9); any change to
  `parseMultipart`'s own parsing behaviour, which moves byte-identically (§3.3).

## 1. Contracts verified from SOURCE (not names)

Every row was read at the cited line on this branch. No row rests on a name.

| Reference                                 | Source (file:line)                                                    | Verified surface / fact                                                                                                                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRequest`                                | `packages/common/src/http.ts:35-112`                                  | `method`, `url`, `path`, `headers`, `ip?`, `user?`, `tenant?`, `signal?`, `raw?`, `json<T>()`, `text()`, `bytes()`. **No form accessor of any kind.**                                                                           |
| `parseJsonBody`                           | `packages/common/src/http.ts:132-138`                                 | The X37-1 precedent: ONE pure parse in `common` that all three `json()` implementations call, so the `@throws` contract holds at every producer. `parseFormBody` is modelled on it exactly.                                     |
| `MalformedRequestBodyError`               | `packages/common/src/errors/malformed-body.ts:40-57`                  | Extends `Error`, sets `name`, brands itself `{ status: 400, title, detail }` in its own constructor. The template for `UnsupportedFormEncodingError`.                                                                           |
| `withHttpStatusHint` / `httpStatusHintOf` | `packages/common/src/errors/status-hint.ts:141`, `:175`               | `status` must be an integer in `400`–`599`, so `415` is admissible; `HttpStatusHint extends ErrorResponseInit` (`:89`), which is what lets `respondWithError` serve a brand verbatim.                                           |
| `ErrorResponseInit`                       | `packages/common/src/errors/error-responder.ts:146-158`               | `{ status, title, detail?, details? }` — the shape a brand must satisfy.                                                                                                                                                        |
| `FrameworkRequest`                        | `packages/runtime/src/adapters/shared/fetch-mapping.ts:78-206`        | A class with prototype methods and private-field memoization: `#body` behind `bytes()` (`:157`), `#json` behind `json()` (`:175`). Caches the in-flight **promise**, and caches a rejection deliberately.                       |
| kernel `inject()` synthetic request       | `packages/kernel/src/application/application.ts:635-657`              | An object literal implementing `IRequest`; all three readers serve from one `bodyStr`. Defaults `content-type` to `application/json` when a body is present and no header was supplied (`:603-604`).                            |
| `MockRequest`                             | `packages/testing/src/mock-context.ts:139-233`                        | A class; the body is reduced ONCE to `#bodyText` (plus `#bodyBytes` for an exact `Uint8Array`), so the three readers cannot disagree.                                                                                           |
| `parseMultipart` / `ParsedPart`           | `packages/storage-plugin/src/multipart/multipart-parser.ts:31`, `:11` | 172 lines, **`grep -c '^import'` returns 0** — a pure function over `(Uint8Array, string)`. `ParsedPart` is `{ name, filename?, data, mimeType }`; `filename` is present **exactly when** the part declared one.                |
| storage-plugin barrel                     | `packages/storage-plugin/src/index.ts:28`, `:56-57`                   | Exports `createUploadMiddleware`, `getUploadedFile`, `UploadedFile`, `UploadMiddlewareOptions`. **Neither `parseMultipart` nor `ParsedPart` is exported**, so promoting them removes nothing public.                            |
| `createUploadMiddleware`                  | `packages/storage-plugin/src/middleware/upload-middleware.ts:100-217` | Guards on `ct.includes('multipart/form-data')`, checks `Content-Length`, reads `bytes()`, checks `body.length` against `resolveMaxBodyBytes`, calls `parseMultipart`, then applies `maxFiles` / `maxSize` / `allowedMimeTypes`. |
| `UploadedFile`                            | `packages/storage-plugin/src/interfaces/index.ts:248-262`             | `{ name, filename, data, mimeType, size }`; `filename` falls back to the field name when the client sent none.                                                                                                                  |
| `extractToken` (CSRF)                     | `packages/session-plugin/src/csrf/verify.ts:92-113`                   | Reads the configured header first, then returns `undefined` unless the content-type contains `application/x-www-form-urlencoded` (`:21`), then `new URLSearchParams(await text())`. Multipart is unreachable.                   |
| `ResolvedCsrfConfig`                      | `packages/session-plugin/src/options.ts:222-242`                      | `fieldName` and `headerName` are **required `string`s**, defaulted by `resolveCsrfConfig` (`_csrf`, `x-csrf-token`).                                                                                                            |
| `csrfFormMiddleware` priority             | `packages/session-plugin/src/plugin/session-plugin.ts:33`             | `CSRF_FORM: 275` — registered globally, so it runs **before** any route-level upload middleware. Load-bearing for §3.8.                                                                                                         |
| `react-router-plugin` body bridge         | `packages/react-router-plugin/src/handler/request-bridge.ts:46`       | Reads `ctx.request.bytes()`, so it is served from the same memoized buffer and is unaffected by an earlier form parse.                                                                                                          |
| `CLEAN_PACKAGES`                          | `scripts/generate-api-docs.ts:29-40`                                  | Contains `'common'`. Every new `common` export must produce **zero** `deno doc --lint` diagnostics — including `private-type-ref`, so every referenced type must itself be exported.                                            |
| `DOC_LINT_BASELINE`                       | `scripts/generate-api-docs.ts:88`                                     | `496`. The ratchet fails a run above it and a run below it.                                                                                                                                                                     |
| package-README fence counts               | `test/package-readme-fence-compiler.test.ts:56`, `:74`, `:76`         | `storage-plugin: 3`, `session-plugin: 10`, `common: 2`. A README gaining a compilable fence must move its constant.                                                                                                             |
| `packages/common/deno.json`               | whole file                                                            | `"exports": "./src/index.ts"` — a single entrypoint, so a new `src/form/` module needs no export-map change.                                                                                                                    |
| `common/src/static/`                      | `packages/common/src/index.ts:13-14`                                  | The M55 promotion precedent: `contentTypeFor`, `assertRealPathContained` live in `common/src/static/` and are barrel-exported. `common/src/form/` follows it structurally.                                                      |

### 1.1 Behaviours measured, not assumed

Each was produced by a probe on this branch (Deno 2.9.x). They decide §3.1, §3.3 and §3.4.

| Probed behaviour                                                      | Native web `FormData`     | Promoted `parseMultipart`                        |
| --------------------------------------------------------------------- | ------------------------- | ------------------------------------------------ |
| Part with `filename="a.txt"`                                          | `File`                    | `filename: 'a.txt'`                              |
| Part with **no** `filename`, even carrying `Content-Type: text/plain` | `string`, type dropped    | `filename: undefined`, `mimeType: 'text/plain'`  |
| Part with `filename=""` (an empty `<input type="file">`)              | `File`, `name: ''`        | `filename: ''`                                   |
| Repeated field name                                                   | ordered `getAll`          | ordered duplicate parts                          |
| Unparseable multipart body                                            | throws `TypeError`        | returns `[]`                                     |
| `content-type` with no `boundary=`                                    | throws `TypeError`        | throws bare `Error`                              |
| urlencoded `'a&b=&c=1'`                                               | `[[a,''],[b,''],[c,'1']]` | — (`URLSearchParams` gives the identical result) |

So the web standard's file-versus-text discriminator is **exactly** `filename !== undefined`, which
is what `parseMultipart` already records, and `URLSearchParams` already equals the web answer for
urlencoded. The two divergences (an unparseable body, a missing boundary) are settled in §3.4.

### 1.2 The shape choice, measured

The ROADMAP requires the web-`FormData` candidate to be checked against what `ParsedPart` carries.
`ParsedPart.data` is a synchronous `Uint8Array`; a web `File` yields bytes only through
`await arrayBuffer()`, which **copies**. Interleaved over 11 rounds in one process, a framework
shape retaining the parser's own `Uint8Array` against a web `FormData` carrying `File`s:

| Body           | Construct (framework / web) | Read one file's bytes back (web / framework) |
| -------------- | --------------------------- | -------------------------------------------- |
| 1 KB file part | 86.1% (faster in 11/11)     | 1,995 ns / 36 ns (×55)                       |
| 1 MB file part | 75.9% (faster in 11/11)     | 92,333 ns / 56 ns (×1658)                    |

`parseMultipart` already copies each part once (`body.slice(...)`), so the web shape adds a
**second** full copy per file and keeps both live for the request's duration. At the upload
middleware's default `maxSize` of 10 MB that is roughly 0.9 ms and 2× peak memory per file — which
would spend the milestone's own stated performance win (one parse instead of two, ≈6.7 µs) fourteen
times over on a single 1 MB upload. Decision in §3.1.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                                                                                                        | Doc deliverable (same PR)                                                                         |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| C1 | `UploadMiddlewareOptions.maxBodyBytes` JSDoc (`packages/storage-plugin/src/interfaces/index.ts:283-289`) states "the HTTP adapter buffers the whole body into memory before any middleware runs (`mapWebRequestToFrameworkRequest` calls `arrayBuffer()`)". M87 made the body **memoized-lazy** (`fetch-mapping.ts:6-12`) and M90a added `RuntimePlugin({ maxBodyBytes })`, which bounds the read (`fetch-mapping.ts:233-272`). The source is right; the JSDoc is two milestones stale. | The code wins. Rewrite the JSDoc to say the read is lazy and bounded by `RuntimePlugin({ maxBodyBytes })`, and that this option bounds the **parse** the middleware itself triggers — which after §3.8 is no longer necessarily the first parse of the request. | JSDoc rewrite at that site.                                                                       |
| C2 | `PUBLIC_API.md:5686-5687` repeats C1 verbatim ("the HTTP adapter buffers the whole body before any middleware runs, and `IRequest` exposes no body stream").                                                                                                                                                                                                                                                                                                                            | Same side as C1. The first clause is false since M87; the second stays true (this milestone adds an accessor, not a stream).                                                                                                                                    | Edit those two lines.                                                                             |
| C3 | `verifyCsrfToken`'s JSDoc (`packages/session-plugin/src/csrf/verify.ts:32-34`) states "the runtime's request mapping pre-reads it into a buffer, so `text()` is replayable". Post-M87 nothing is pre-read; replayability comes from memoization, not from a pre-read.                                                                                                                                                                                                                   | The code wins. The conclusion (safe to read, the handler can still read afterwards) is unchanged; the stated mechanism is wrong and is corrected to memoization.                                                                                                | JSDoc rewrite at that site, extended to say multipart is now read too.                            |
| C4 | `extractToken`'s JSDoc (`verify.ts:88-90`) states multipart "is deliberately not parsed — that would duplicate the storage plugin's multipart parser, which this package may not import." True when written; this milestone removes the premise by putting the parser in `common`.                                                                                                                                                                                                      | The premise is removed, so the comment is deleted with the limitation it described.                                                                                                                                                                             | Rewrite `extractToken`'s JSDoc; state that a token arriving as a **file** part is refused (§3.7). |
| C5 | `PUBLIC_API.md:9307-9312` describes the X37-1 note as covering "all three producers" of `IRequest.json()`. Correct as written, but it is the natural home for the parallel `formData?()` note and would otherwise leave the new member undocumented next to its sibling.                                                                                                                                                                                                                | Keep the `json()` note exactly as it is (it is true) and add a sibling bullet for `formData?()` beside it, counting the same three implementations.                                                                                                             | New `PUBLIC_API.md` bullet in the `@setu-ts/common` notes.                                        |

## 3. Design decisions

### 3.1 The returned shape — a framework value, not the web `FormData`

- **Decision:** `formData()` resolves a `FormBody`, a framework-owned read-only interface with
  `get(name)`, `getAll(name)` and `entries()`. A value is `string | FormFile`, where
  `FormFile = { filename, mimeType, data: Uint8Array }` — `ParsedPart` minus its field name. The web
  standard's **semantics** are adopted wholesale (ordered `getAll` for repeats, file-versus-text
  discriminated on `filename !== undefined`); the web `File`'s **async, copying** byte access is
  not.
- **Why:** §1.1 shows the discriminator and the repeat ordering map onto `ParsedPart` with nothing
  left over, so adopting the semantics costs nothing. §1.2 shows adopting `File` costs a second full
  copy per file part, held concurrently with the parser's own, on the exact path the milestone
  promises to make cheaper. `FormFile` omits the field name because `getAll(name)` and `entries()`
  already carry it, and a copy inside the value would be a second source of truth; it omits `size`
  because `data.byteLength` is the same number. The interface is non-`I`-prefixed, matching the
  method-carrying `SseChannel` and `WebSocketRoom` in `common/src/services/` — the `IXxx` convention
  marks ports, not values (established in M86 review). **Measured on this branch rather than taken
  from that note**, which cited 114 non-prefixed interfaces: `common` today exports 94 non-prefixed
  against 92 `I`-prefixed, so the note's figure does not reproduce and the argument is restated on
  the count that does. It is named `FormBody`, never `FormData`, so it cannot shadow the global.
- **Test home:** `packages/common/test/unit/form-body.test.ts` asserts each semantic row of §1.1
  against the same fixtures, including the `filename=""` file case;
  `packages/common/test/unit/form-shape.test.ts` is a type-level test pinning that `FormFile`
  carries a synchronous `Uint8Array` and that a value narrows on `typeof v === 'string'`.

### 3.2 One implementation, two encodings, one classifier

- **Decision:** `common` exports the pure
  `parseFormBody(body: Uint8Array, contentType: string | null): FormBody` and the pure
  `formEncodingOf(contentType: string | null): FormEncoding | undefined` where
  `FormEncoding = 'urlencoded' | 'multipart'`. `parseFormBody` classifies with `formEncodingOf`,
  then runs `new URLSearchParams(decode(body))` for the urlencoded arm and the promoted
  `parseMultipart` for the multipart arm. Every `formData()` implementation is
  `parseFormBody(await this.bytes(), contentTypeHeader)` and nothing else.
- **Why:** this is the `parseJsonBody` shape (§1) — one parse in `common` so the three producers
  cannot disagree, which is what X37-1 was filed for. `formEncodingOf` additionally **deletes** two
  hand-rolled content-type checks that already disagree (`upload-middleware.ts:113` uses
  `ct.includes('multipart/form-data')` with no case folding; `verify.ts:104` uses
  `contentType.toLowerCase().includes(FORM_URLENCODED)`), which is the M90a `createPathMatcher`
  precedent: one classifier replacing private copies that had drifted.
- **Test home:** `form-encoding.test.ts` (classifier, including case folding and parameters such as
  `; charset=UTF-8`); `form-body.test.ts` (both arms through one entry point); the cross-producer
  agreement test in §3.6.

### 3.3 `parseMultipart` moves byte-identically; `ParsedPart` stays internal

- **Decision:** the parser file moves to `packages/common/src/form/multipart-parser.ts` with its
  logic unchanged, and `storage-plugin`'s copy is deleted. Neither `parseMultipart` nor `ParsedPart`
  is added to `common`'s barrel: `parseFormBody` is the only public entry, and `parseMultipart` is
  its internal implementation.
- **Why:** the ROADMAP's deliverable is that the duplicate is deleted (§2.1's pure-utility
  allowance, the M55 content-type-map precedent), and that is satisfied by delegating through
  `parseFormBody`. Exporting both would leave `parseMultipart` with no consumer outside
  `parseFormBody` and its own test — the §4 dead-surface rule, and the exact defect class this
  repo's plan checklist names. Keeping the logic unchanged is what makes the move auditable: the
  parser's divergences from native (§1.1) are pre-existing behaviour of a released middleware, and
  changing them here would be a silent behaviour change riding on a refactor.
- **Test home:** `packages/storage-plugin/test/unit/multipart-parser.test.ts` moves to
  `packages/common/test/unit/multipart-parser.test.ts` **unchanged**, so a green run is evidence the
  move altered nothing.

### 3.4 Contract for a body the accessor cannot parse

- **Decision:** `parseFormBody` (and therefore `formData()`) **throws**
  `UnsupportedFormEncodingError`, self-branded `{ status: 415, title: 'Unsupported Media Type' }`,
  when `formEncodingOf` returns `undefined` — a JSON body, a missing content-type, a multipart
  content-type carrying no `boundary=`. It does **not** invent a malformed-body throw: a multipart
  body the parser cannot make sense of yields an **empty** `FormBody`, which is `parseMultipart`'s
  existing behaviour (§1.1) and stays that way per §3.3. That limit is documented on `formData?()`,
  on `parseFormBody`, and in `PUBLIC_API.md`.
- **Why:** three callers want three things, and the classifier is what lets each have it without a
  union return. A caller that wants to _branch_ calls `formEncodingOf` first — the CSRF verifier and
  the upload middleware both already branch on content-type, so neither ever reaches the throw. A
  caller that wants the fields gets a correct, formatted `415` instead of an unbranded throw from
  body depth, which `errorHandler` would mask as `500`: that is the `MalformedRequestBodyError`
  precedent verbatim. Returning `Promise<FormBody | undefined>` was rejected because `formData?()`
  is already optional, so `undefined` would carry two different absences — the ambiguity M70k had to
  invent `IWorkerHost.reportsExit?` to avoid. Returning an empty `FormBody` for a JSON body was
  rejected outright: silently reporting "this request carried no fields" for a request that carried
  a whole JSON document is the silent-wrong class.
- **Test home:** `form-body.test.ts` asserts the throw, its `name`, and that `httpStatusHintOf`
  reports `415` for each of the three refusable content-types; `form-body.test.ts` also asserts the
  empty-`FormBody` outcome for an unparseable multipart body so the documented limit is pinned
  rather than latent.

### 3.5 Optionality and the fallback path

- **Decision:** `IRequest.formData?(): Promise<FormBody>` is optional, on the M42 `signal?` / M44
  `fs?` / M70a `raw?` precedent. All three in-repo implementations provide it. A consumer reads
  `ctx.request.formData?.()` and falls back to `parseFormBody(await ctx.request.bytes(), ct)`.
- **Why:** a required member breaks every out-of-repo `IRequest` implementor with no deprecation
  path, and the ROADMAP specifies optional. The fallback is **not** a second implementation — it is
  the same `common` function the producers call, so §11.1 is not engaged; what the accessor buys
  over the fallback is memoization, which is the whole point when two middlewares read the same
  body.
- **Test home:** `packages/storage-plugin/test/unit/upload-fallback.test.ts` and
  `packages/session-plugin/test/unit/csrf/csrf-multipart.test.ts` each drive a context whose request
  omits `formData`, asserting identical results to the accessor path.

### 3.6 Memoization, in each producer

- **Decision:** each implementation caches the in-flight **promise** in a private field, never the
  resolved value, and caches a rejection: `FrameworkRequest` gains `#form`, `MockRequest` gains
  `#form`, and the kernel's synthetic request closes over one `form` variable.
- **Why:** this is `bytes()`'s own documented rule (`fetch-mapping.ts:142-156`) — caching the
  resolved value leaves a race in which two concurrent readers both parse. Here the underlying
  `bytes()` is already one-shot-safe, so the race would cost a duplicate parse rather than a
  rejection; caching the promise removes it anyway and keeps the three producers structurally
  identical. Caching a rejection matches `json()`: a body that is not a form will not become one on
  a retry.
- **Test home:** `packages/kernel/test/integration/form-body-producers.test.ts` — the X37-1
  `malformed-body.test.ts` shape — drives the same urlencoded body and the same multipart body
  through `inject()`, through a real `FrameworkRequest`, and through `createTestContext`, asserting
  identical `get`/`getAll`/`entries` output from all three; plus a per-producer test asserting that
  two **concurrent** `formData()` calls return the **same reference** (§6 control 5).

### 3.7 The CSRF verifier reads the form, and refuses a token that arrives as a file

- **Decision:** `extractToken` keeps checking the configured header first, then calls
  `formEncodingOf`; for both form encodings it reads `formData?.() ?? parseFormBody(...)` and takes
  `form.get(config.fieldName)`, accepting it only when `typeof value === 'string' && value !== ''`.
- **Why:** the header-first order is unchanged, so a client already sending the header triggers no
  parse. The `typeof` guard is a security requirement, not tidiness: without it a `FormFile` under
  the token's field name would reach `timingSafeEqualStrings` as a non-string, and a caller can
  choose that shape freely by adding a `filename` to the part. Urlencoded behaviour is
  byte-identical to today, because `URLSearchParams` equals the web answer (§1.1) and the existing
  code already used it.
- **Test home:** `packages/session-plugin/test/unit/csrf/csrf-multipart.test.ts` — accepted from a
  multipart field; refused when submitted as a file part; unchanged urlencoded and header cases; and
  a regression case pinning that a non-form content-type still produces the "carried no CSRF token"
  mismatch rather than a `415`.

### 3.8 The upload middleware consumes the accessor; policy stays where it is

- **Decision:** `createUploadMiddleware` keeps its `Content-Length` check, keeps reading `bytes()`
  and keeps testing that length against `resolveMaxBodyBytes` **before** touching the form, then
  obtains the form through the accessor and takes `form.getAll(fieldname)`, keeping only the
  `FormFile` values. `maxFiles`, `maxSize` and `allowedMimeTypes` stay in the middleware, unchanged.
  `resolveMaxBodyBytes` and every refusal status are unchanged.
- **Why:** parsing is a pure transform and policy is the middleware's; splitting them that way is
  what lets one parse serve both consumers. The ceiling still precedes the parse _this_ middleware
  triggers because `bytes()` is memoized and therefore free to read first.
- **Consequence, accepted and documented:** a part carrying **no** `filename` under the upload field
  name is no longer reported as an upload. Today it becomes an `UploadedFile` with
  `filename: <field name>`. This is a behaviour change to a released API and gets CHANGELOG
  migration text. It is the web standard's answer and a browser file input always sends a `filename`
  — even an empty one, which §1.1 confirms still yields a file — so the dropped case is a
  non-browser client posting a plain value under the file field.
- **Test home:** `packages/storage-plugin/test/unit/upload-middleware.test.ts` gains the
  `filename=""` case (the trap: `if (part.filename)` is falsy for `''`, so a naive discriminator
  drops the empty-file-input case) and the no-`filename` drop; every existing refusal test stays and
  must pass unchanged.

### 3.9 No new state key, no new capability token, no new option

- **Decision:** nothing is added to `ctx.state`, `CAPABILITIES`, `UploadMiddlewareOptions` or
  `CsrfFormOptions`.
- **Why:** the accessor's memoization lives on the request, which is already request-scoped, so a
  state key would be a second cache. A bound on the parse triggered by an earlier reader was
  considered and rejected in §8 with its reason.
- **Test home:** `test/state-key-convention.test.ts` (unchanged, must stay green) and the three
  `barrel-exports.test.ts` files.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                           | Kind      | Consumer / real code path that READS it                                                                                                                                                                                            |
| ----------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FormBody` (`common`)                     | interface | Return type of `IRequest.formData?()` and `parseFormBody`; read by `extractToken` (`session-plugin`) and `createUploadMiddleware` (`storage-plugin`).                                                                              |
| `FormFile` (`common`)                     | interface | `createUploadMiddleware` maps it to `UploadedFile`; `extractToken` narrows **against** it to refuse a file-borne token (§3.7).                                                                                                     |
| `FormValue` (`common`)                    | type      | `string \| FormFile` — the declared value type of `FormBody.get`/`getAll`/`entries`; exported because `common` is in `CLEAN_PACKAGES` and an unexported referenced type is a `private-type-ref` diagnostic.                        |
| `FormEncoding` (`common`)                 | type      | Return type of `formEncodingOf`; `createUploadMiddleware` compares against `'multipart'`.                                                                                                                                          |
| `parseFormBody` (`common`)                | function  | Called by all three `formData()` implementations AND by both consumers' fallback paths (§3.5).                                                                                                                                     |
| `formEncodingOf` (`common`)               | function  | `createUploadMiddleware`'s multipart guard and `extractToken`'s form guard — replacing the two private `includes()` checks it deletes.                                                                                             |
| `UnsupportedFormEncodingError` (`common`) | class     | Thrown by `parseFormBody`; its brand is read generically by `respondWithError`/`errorHandler`. Exported for the same reason `MalformedRequestBodyError` is: an application catching its own `formData()` rejection needs the type. |
| `IRequest.formData?()` (`common`)         | member    | Implemented by `runtime`, `kernel` `inject()`, `testing`; called by both consumers and by application handlers.                                                                                                                    |

`parseMultipart` and `ParsedPart` are deliberately **not** exported (§3.3). `FormBody.entries()` has
no framework reader and is included knowingly: it is the enumeration primitive an application needs
to read a form whose field names it does not know ahead of time, which is precisely the hand-rolled
`new URLSearchParams(body)` iteration this accessor exists to replace. It is therefore pinned by an
e2e that drives a **real handler in a running kernel application**, not by a unit test of its own
(§6) — the distinction the dead-surface rule turns on.

### 4.1 Options — every option names its consumer

None added (checked). §3.9 records why each of the three candidate option sites is left alone.
Existing options are unchanged:
`UploadMiddlewareOptions.{fieldname,maxSize,allowedMimeTypes,maxFiles,maxBodyBytes}` keep their
current consumers and semantics (§3.8), and `CsrfFormOptions.{fieldName,headerName}` keep theirs
(§3.7).

## 5. Implementation files

| File                                                          | Purpose                                                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/form/multipart-parser.ts`                | The promoted parser, moved byte-identically from `storage-plugin`. Internal — not barrel-exported.                                  |
| `packages/common/src/form/form-body.ts`                       | `FormBody`, `FormFile`, `FormValue`, `FormEncoding`, `formEncodingOf`, `parseFormBody`, and the internal `FormBody` implementation. |
| `packages/common/src/errors/unsupported-form-encoding.ts`     | `UnsupportedFormEncodingError`, self-branding `415` in its constructor (the `malformed-body.ts` shape).                             |
| `packages/common/src/http.ts`                                 | Adds the optional `formData?()` member to `IRequest`, with JSDoc naming the `415` throw and the empty-`FormBody` limit.             |
| `packages/common/src/index.ts`                                | Barrel: the seven symbols in §4.                                                                                                    |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`       | `FrameworkRequest` gains `#form` and `formData()` (§3.6).                                                                           |
| `packages/kernel/src/application/application.ts`              | The `inject()` synthetic request gains a memoized `formData()`.                                                                     |
| `packages/testing/src/mock-context.ts`                        | `MockRequest` gains `#form` and `formData()`.                                                                                       |
| `packages/storage-plugin/src/multipart/multipart-parser.ts`   | **Deleted** (moved to `common`).                                                                                                    |
| `packages/storage-plugin/src/middleware/upload-middleware.ts` | Consumes the accessor; `formEncodingOf` replaces the private content-type check (§3.8).                                             |
| `packages/storage-plugin/src/interfaces/index.ts`             | C1 JSDoc correction.                                                                                                                |
| `packages/session-plugin/src/csrf/verify.ts`                  | `extractToken` reads the form for both encodings and refuses a file-borne token; C3/C4 JSDoc corrections.                           |
| `PUBLIC_API.md`                                               | C2, C5, the `common` export-table rows, and the storage/session behaviour notes.                                                    |
| `CHANGELOG.md`                                                | `Unreleased`: the additive `common` surface, the CSRF multipart acceptance, and the §3.8 breaking change with migration text.       |
| `packages/{common,storage-plugin,session-plugin}/README.md`   | Export tables (`deno task docs:exports`) and prose.                                                                                 |
| `test/package-readme-fence-compiler.test.ts`                  | Fence counts for any README gaining a compilable fence.                                                                             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                                   | src covered                                                                                                                                                                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/multipart-parser.test.ts`                                                                                                                        | `common/src/form/multipart-parser.ts`                                                                                                                                            | The storage-plugin file moved **unchanged**, against `parseMultipart(body: Uint8Array, contentType: string): ParsedPart[]`. Green is the evidence the move altered nothing (§3.3).                                                                                                                                                                                                                                                                                                                               |
| `packages/common/test/unit/form-encoding.test.ts`                                                                                                                           | `common/src/form/form-body.ts` (classifier)                                                                                                                                      | `formEncodingOf(ct: string \| null): FormEncoding \| undefined` — `'multipart'`, `'urlencoded'`, case folding, `; charset=UTF-8`, `null`, JSON, and a multipart type with no `boundary=`.                                                                                                                                                                                                                                                                                                                        |
| `packages/common/test/unit/form-body.test.ts`                                                                                                                               | `common/src/form/form-body.ts`, `common/src/errors/unsupported-form-encoding.ts`                                                                                                 | Every §1.1 semantic row through `parseFormBody(body: Uint8Array, contentType: string \| null): FormBody`: file-vs-string, `filename=""` **is** a file, repeats through `getAll`, `get` returns the first, `entries()` order, empty form, unparseable multipart → empty `FormBody` (§3.4), and the `415` throw with `httpStatusHintOf` asserted.                                                                                                                                                                  |
| `packages/common/test/unit/form-shape.test.ts`                                                                                                                              | `common/src/form/form-body.ts` (types)                                                                                                                                           | Type-level: `FormFile.data` is `Uint8Array` (synchronous), a `FormValue` narrows on `typeof v === 'string'`, and `FormBody` is read-only — a `@ts-expect-error` on a write, which is self-validating (an unused directive is a compile error).                                                                                                                                                                                                                                                                   |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)                                                                                                               | `common/src/index.ts`                                                                                                                                                            | The seven §4 symbols are present, and `parseMultipart`/`ParsedPart` are **absent** — pinning §3.3 so a later "symmetry" export fails a test naming why.                                                                                                                                                                                                                                                                                                                                                          |
| `packages/runtime/test/unit/fetch-mapping.test.ts` (extended)                                                                                                               | `runtime/.../fetch-mapping.ts`                                                                                                                                                   | `formData()` over a real `Request` for both encodings; two awaits return the same reference; a rejection is cached; `bytes()` afterwards still resolves; and a bodyless GET still allocates no read.                                                                                                                                                                                                                                                                                                             |
| `packages/kernel/test/integration/form-body-producers.test.ts` (new)                                                                                                        | `common/src/http.ts` (the member's contract) + all three implementations: `kernel/src/application/application.ts`, `runtime/.../fetch-mapping.ts`, `testing/src/mock-context.ts` | The X37-1 cross-producer shape: one urlencoded body and one multipart body driven through `inject()`, through a served request, and through `createTestContext`, asserting identical `get`/`getAll`/`entries`. This is the test that makes "one implementation" checkable.                                                                                                                                                                                                                                       |
| `packages/testing/test/unit/mock-context.test.ts` (extended)                                                                                                                | `testing/src/mock-context.ts`                                                                                                                                                    | `MockRequest.formData()` for a string body, a `Uint8Array` body, and memoization; a non-form content-type throws `UnsupportedFormEncodingError`.                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/storage-plugin/test/unit/upload-middleware.test.ts` (extended)                                                                                                    | `storage-plugin/.../upload-middleware.ts`                                                                                                                                        | Every existing refusal unchanged (`maxFiles` 400, `maxSize` 413, MIME 400, body cap 413); **new**: `filename=""` still uploads; a part with no `filename` under the field name is no longer an upload (§3.8); `formEncodingOf` guard passes a non-multipart request through.                                                                                                                                                                                                                                     |
| `packages/storage-plugin/test/unit/upload-fallback.test.ts` (new)                                                                                                           | `storage-plugin/.../upload-middleware.ts` (fallback branch)                                                                                                                      | A context whose `ctx.request` omits `formData` yields identical uploads to the accessor path (§3.5) — the branch a third-party `IRequest` takes.                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/session-plugin/test/unit/csrf/csrf-multipart.test.ts` (new)                                                                                                       | `session-plugin/src/csrf/verify.ts`                                                                                                                                              | Against `verifyCsrfToken(ctx: IRequestContext, options?: CsrfFormOptions): Promise<void>`: accepted from a multipart field; **refused** when the token arrives as a file part; header still wins; urlencoded unchanged; a JSON body still produces the mismatch, not a `415`; and the fallback branch.                                                                                                                                                                                                           |
| `packages/storage-plugin/test/{unit/upload-body-bound,unit/upload-refusal-status,integration/upload-body-cap-e2e,integration/upload-error-passthrough}.test.ts` (unchanged) | `storage-plugin/.../upload-middleware.ts`                                                                                                                                        | Must pass untouched — the four existing suites are the evidence that §3.8 moved only the parse and left every bound and every refusal status where it was.                                                                                                                                                                                                                                                                                                                                                       |
| `packages/session-plugin/test/unit/csrf/csrf.test.ts` (unchanged)                                                                                                           | same                                                                                                                                                                             | Must pass untouched — evidence the urlencoded and header paths did not move.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/storage-plugin/test/integration/upload-csrf-one-parse.test.ts` (new)                                                                                              | both consumers                                                                                                                                                                   | A running kernel application with `csrfFormMiddleware` at 275 and `createUploadMiddleware` on the route, one multipart POST carrying the token in a **field**: the request succeeds (today it `403`s), the file is delivered, and the body is parsed **once** — asserted as its one observable consequence, that both consumers receive the **same `FormBody` reference**. Counting `bytes()` calls would prove nothing: that read is already memoized and returns once whether the form is parsed twice or not. |
| `packages/kernel/test/e2e/form-handler.test.ts` (new)                                                                                                                       | `common/src/form/form-body.ts` (`entries`)                                                                                                                                       | A real handler in a running kernel app reads an **unknown-shaped** urlencoded form through `entries()` and echoes it — the application path §4 names for that member.                                                                                                                                                                                                                                                                                                                                            |
| `test/package-readme-fence-compiler.test.ts` (constants)                                                                                                                    | the three READMEs                                                                                                                                                                | Fence counts move only if a README gains a compilable fence; the fences themselves must compile.                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Negative controls** (each to be observed failing, then reverted, and the result recorded in the
PR):

1. Discriminate on `if (part.filename)` instead of `!== undefined` → the `filename=""` cases fail in
   `form-body.test.ts` and `upload-middleware.test.ts` while every other case passes.
2. Drop the `typeof value === 'string'` guard in `extractToken` → the file-borne-token refusal fails
   and nothing else does (§3.7).
3. Have `parseFormBody` return an empty `FormBody` instead of throwing for a JSON content-type → the
   `415` cases fail while the CSRF suite still passes, which is the evidence that the CSRF path
   never reaches the throw (§3.4).
4. Point `extractToken` back at `text()` + `URLSearchParams` → `csrf-multipart.test.ts` fails and
   `csrf.test.ts` passes, separating the new capability from the preserved one.
5. Cache the resolved `FormBody` across the `await` rather than the in-flight promise in
   `FrameworkRequest` → a **sequential** same-reference assertion still passes, so it must be
   asserted **concurrently**: `Promise.all([r.formData(), r.formData()])` lets both callers past the
   empty-cache check before any assignment lands, so each parses and each receives its own object.
   The concurrent form fails under the revert and the sequential form does not, which is what makes
   §3.6's promise-caching load-bearing rather than stylistic.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m94b-form-data, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task check:docs        # includes the deno doc --lint ratchet; `common` is a CLEAN_PACKAGE (zero diagnostics)
deno task docs:exports      # regenerate the three README export tables, then re-run fmt:check
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.5.0
```

## 8. Risks & mitigations

- **An earlier reader parses before the upload middleware's ceiling is checked.**
  `csrfFormMiddleware` runs globally at priority 275, ahead of any route-level upload middleware, so
  after §3.7 it can trigger the multipart parse first — outside
  `UploadMiddlewareOptions.maxBodyBytes`, which the middleware applies to its own parse.
  Mitigations: the verifier reads the header first, so a client sending the token in a header
  triggers no parse at all; the bytes are already buffered, so the incremental exposure is one
  O(body) pass plus the parser's per-part copies; and `RuntimePlugin({ maxBodyBytes })` (M90a) is
  the bound that covers **every** reader. A new CSRF-side limit option was considered and rejected:
  it would be a second bound over the same bytes with one consumer, and the read bound is the one
  that actually caps memory. Named in C1's rewritten JSDoc and in `PUBLIC_API.md` so a reader meets
  it before an incident.
- **`common` is a `CLEAN_PACKAGE`** (`scripts/generate-api-docs.ts:29`), so a missing `@param`, a
  missing `@returns`, or a reference to an unexported type fails `check:docs` outright rather than
  moving the ratchet. Mitigation: `FormValue` is exported for exactly this reason (§4), and
  `check:docs` runs before the PR rather than after.
- **A moved file can lose coverage silently.** `multipart-parser.ts` leaves a package whose per-file
  table already covers it and enters one that must. Mitigation: the test file moves with it
  unchanged, and the per-file table is read for **both** packages after the move, not only `common`.
- **The parser's divergences from native are inherited, not fixed.** An unparseable multipart body
  becomes an empty form rather than a `400` (§1.1, §3.4). Mitigation: documented on three surfaces
  and pinned by a test, so it is a stated contract rather than a latent surprise; changing it is a
  behaviour change to a released middleware and belongs to whichever milestone chooses to make it.
- **`common` gains its first `TextEncoder`/`TextDecoder` use** (verified: `grep` over
  `packages/common/src` returns none today). These are web standards, not runtime-specific APIs, so
  §4.1 is untouched — but it is a new kind of dependency for the package and is recorded here rather
  than discovered in review.
- **`ResolvedCsrfConfig.headerName` is a required `string`, so `extractToken`'s
  `config.headerName !== undefined` check is unreachable from typed code** (M70n's X4-5 gave it a
  default). Rewriting `extractToken` could tempt a cleanup. Mitigation: leave it exactly as it is —
  `verifyWithConfig` is exported and the branch is a boundary guard, and removing it is a change
  this milestone did not come to make.

## 9. Out of scope

- **A streaming request body.** `IRequest` still exposes no stream, so no middleware can decline to
  read, and `UploadMiddlewareOptions.maxBodyBytes` still cannot bound the read. Unowned; C1/C2 state
  the limit rather than implying it is solved.
- **Changing `parseMultipart`'s parsing behaviour** to match native on an unparseable body or a
  preamble. Deliberately excluded by §3.3 so the promotion stays auditable; unowned.
- **The CSRF token field helper and the global-registration documentation** — M94c.
- **The application-owned error-response hook** — M94a, already shipped.
- **Exporting `parseMultipart` for non-request multipart bodies** (a stored blob, an email part).
  Speculative, with no consumer today; §3.3 records why it stays internal.
