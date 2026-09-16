# Milestone 97b — Response Shaping for Decorated Handlers (`@setu-ts/decorator-plugin`)

> **Status:** Planning. Branch: `feat/m97b-response-shaping`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Let a decorated handler state its success status and its response headers in its declaration rather
than taking `@Ctx()` and mutating the response builder. `createHandler` answers
`ctx.response.json(result)` for every plain return, so a decorated handler is always `200`, always
JSON, always header-free unless it reaches for the context. The second half of the milestone is the
one that justifies touching `common`: a declared success status is derivable into the OpenAPI
document through the brand mechanism M57 and M70m already built twice, and today a decorated `201`
is invisible to the generated client, which types every success as `200`.

**This is an ergonomics milestone, not a defect repair, and the plan says so.** The `@Ctx()` escape
works: `ResponseBuilder.status()` mutates and returns `this`, so `@Ctx()` plus
`ctx.response.status(201)` plus returning the value does produce a `201`, and it composes with
`@Render` because the render branch fires on a non-`HandlerResult` return. What is wrong is that a
handler must accept an unrelated parameter to say one thing about its response.

- **In scope:** `@HttpCode`, `@ResponseHeader`, `@Redirect` in `decorator-plugin`;
  `RESPONSE_METADATA` + `withResponseMetadata` + `responseMetadataOf` in `common`;
  `deriveResponseStatus` in `openapi-plugin`; precedence rules pinned by tests; README,
  `PUBLIC_API.md` and `docs/decorators.md` updates.
- **NOT this milestone:** A `@Res()`-style raw response injection — `@Ctx()` already is that.
  Content negotiation. Any change to `IResponse`. Decorators for non-HTTP ingress — M97a. Typed
  configuration sections — M97c.

## 1. Contracts verified from SOURCE (not names)

| Reference                                                        | Source (file:line)                                                                                                           | Verified surface / fact                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The cliff is one line                                            | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:327-350`                                                           | `createHandler` resolves parameters, awaits the method, returns `result` verbatim when `isHandlerResult(result)`, otherwise `ctx.response.json(result)` — or `ctx.response.html(await render.engine.render(...))` when a `@Render` route. No status or header path exists.               |
| The `@Ctx()` escape genuinely works                              | `packages/kernel/src/context/response.ts:36-39,41-42`                                                                        | `status(code)` sets `#status` and returns `this`; `header(name, value)` materialises headers and sets. Both mutate, so a `@Ctx()` handler can shape the response and still return a plain value.                                                                                         |
| `HandlerResult` is a brand, not a carrier                        | `packages/common/src/http.ts:26-29`                                                                                          | `{ readonly __handlerResult: true }` — it carries no status. `isHandlerResult` (`packages/decorator-plugin/src/internal.ts:82-88`) tests that property. So "a returned `HandlerResult` wins" is a statement about ordering in `createHandler`, not about reading a status off the value. |
| `IResponse` has the primitives already                           | `packages/common/src/http.ts:182,188,215,222,233,240,248,266`                                                                | `status`, `header`, `appendHeader`, `json`, `text`, `html`, `send`, `redirect(url, status?)`, `stream`. Nothing in `common`'s response surface needs to change.                                                                                                                          |
| The brand precedent, twice                                       | `packages/common/src/http.ts:519` (`SECURITY_METADATA`), `:741` (`VALIDATION_METADATA`), `:679-688` (`withSecurityMetadata`) | Both are `Symbol.for`-keyed and the helper uses `Object.defineProperty(..., { enumerable: false, configurable: true, writable: false })`. `:731-733` records why `Symbol.for`: "a locally-created symbol would simply miss on every read, silently."                                     |
| The document has a status-keyed slot already                     | `packages/common/src/http.ts:445`                                                                                            | `RouteSchema.response?: Readonly<Record<number, unknown>>`.                                                                                                                                                                                                                              |
| And a default `200` arm to displace                              | `packages/openapi-plugin/src/generators/openapi-generator.ts:1004-1008`                                                      | With no response schema, `#buildResponses` writes `responses['200'] = { description: 'Successful response' }`. This is the exact line a derived status changes.                                                                                                                          |
| `deriveSecurity` is the shape to copy                            | `packages/openapi-plugin/src/generators/openapi-generator.ts:263,474,729,815`                                                | `readonly deriveSecurity?: { readonly scheme: string }`, threaded through options, consulted at `:729` only when `schema?.security === undefined`.                                                                                                                                       |
| M70m's precedence rule, stated in source                         | `packages/openapi-plugin/src/generators/openapi-generator.ts:722-727`                                                        | "Precedence: a DECLARED requirement wins, then a DERIVED one, then nothing"; the declared test is `!== undefined` rather than a length check, deliberately. The derived-status arm must mirror this.                                                                                     |
| `deriveRequestSchemas` is ON by default, `deriveSecurity` is not | `packages/openapi-plugin/src/generators/openapi-generator.ts:305`                                                            | "Unlike `OpenApiGeneratorOptions.deriveSecurity` this is ON by default." The distinction exists because `deriveSecurity` needs a caller-named scheme and request-schema derivation needs nothing. A status likewise needs nothing, which is the argument for defaulting it on.           |
| M58 recorded the consequence of the gap                          | `CLAUDE.md` M58 entry                                                                                                        | "The `201` on `create` is dropped rather than faked, since a decorated handler cannot set a status code." M64 then shipped `@Ctx()` as the escape.                                                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                                                                         | Doc deliverable (same PR)                                                                                                                                                                                                                     |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `docs/decorators.md` and the `decorator-plugin` README document `@Ctx()` as the way to influence a response, with no mention that a status is the common case. After this milestone there are two ways and the guides name one. | `@HttpCode`/`@ResponseHeader`/`@Redirect` become the documented default for a fixed status or header; `@Ctx()` stays documented for anything computed per request.                                                               | A `## Response Shaping` section in `docs/decorators.md` and a README subsection, each stating which of the two to reach for, with the fence counts bumped in `test/decorator-fence-compiler.test.ts` and `test/guide-fence-compiler.test.ts`. |
| C2 | `PUBLIC_API.md`'s decorator table lists the parameter and pipeline decorators; the generated-client section documents success responses as `200`.                                                                               | The table gains the three decorators; the OpenAPI section gains `deriveResponseStatus` and states that a derived status changes the generated client's success type.                                                             | `PUBLIC_API.md` decorator-plugin export rows, `common` export row for the three new symbols, and an OpenAPI options row.                                                                                                                      |
| C3 | The CLI's `g controller` and `g module` schematics emit handlers that return plain values, and M58's review recorded dropping a `201` because it was unexpressible. It is expressible now.                                      | The schematics are NOT changed in this milestone: changing generated output is a behaviour change to already-published generated output (the M58 precedent required a CHANGELOG migration note), and it is a separable decision. | A named follow-up line in `ROADMAP.md` M97b's Out of scope, so the option is recorded rather than forgotten.                                                                                                                                  |

## 3. Design decisions

### 3.1 Three decorators, applied in `createHandler` BEFORE the handler method is invoked

- **Decision:** `@HttpCode(status: number)`, `@ResponseHeader(name: string, value: string)`
  (repeatable), and `@Redirect(url: string, status?: number)` are method decorators recording into
  the existing route metadata. `createHandler` applies the recorded status and headers to
  `ctx.response` **before `method(...)` is invoked** — before the `await` at
  `decorator-plugin.ts:340`, not merely before the `isHandlerResult` test below it.
- **Why:** Two things depend on the exact position and an earlier draft of this plan pinned only one
  of them. (a) Writing before the `isHandlerResult` test is what makes `@Render` work: the render
  branch returns `ctx.response.html(...)` on a builder already given its status, so a rendered `201`
  needs no special case. (b) Writing before `method(...)` runs is what makes §3.2's precedence true
  — the handler's own `ctx.response.status(202)` then overwrites the decorator's value. Writing
  after the method satisfies (a) and INVERTS (b), silently making `@HttpCode` beat an explicit
  runtime call. The draft said only "before the `isHandlerResult` test", which both positions
  satisfy.
- **Test home:** `test/unit/response-shaping.test.ts` for each decorator alone;
  `test/integration/render-with-status.test.ts` for `@Render` + `@HttpCode` together.

### 3.2 A returned `HandlerResult` wins over `@HttpCode`

- **Decision:** A handler that returns `ctx.response.status(202).json(...)` answers `202` even under
  `@HttpCode(201)`.
- **Why:** The explicit runtime value is the more specific statement, and §1 establishes that
  `HandlerResult` carries no status — so this falls out of §3.1's ordering (the decorator writes to
  the builder, then the handler's own call overwrites it) rather than needing a comparison. It is
  therefore only true while §3.1's write stays before `method(...)`, which is why that position is
  part of that decision rather than an implementation detail.
- **Test home:** `test/unit/response-shaping.test.ts` — a case asserting `202`, with a comment
  naming this decision.

### 3.3 `@Redirect` writes the `Location` header and the status, and short-circuits nothing

- **Decision:** `@Redirect(url, status = 302)` sets the status and `Location` on the builder. The
  handler still runs and its return value is still serialised if it returns one.
- **Why:** A decorator cannot decline to call the handler — `createHandler` invokes the method
  before it can inspect anything the method returns — so a `@Redirect` that claimed to skip the body
  would be lying about a path it does not control. `IResponse.redirect(url, status?)` exists (§1)
  and is what a handler wanting to terminate should call itself; the decorator is for the
  declarative case where the handler's work is the side effect.
- **Test home:** `test/unit/response-shaping.test.ts` asserts the header and status are set and that
  the handler body still executed.

### 3.4 `RESPONSE_METADATA` is `Symbol.for`-keyed and lives in `common/src/http.ts`

- **Decision:** `RESPONSE_METADATA`, `RouteResponseMetadata`, `withResponseMetadata` and
  `responseMetadataOf` are added to `packages/common/src/http.ts` beside `SECURITY_METADATA` and
  `VALIDATION_METADATA`, using the same `Object.defineProperty` shape.
- **Why:** §1 records both precedents and the reason for `Symbol.for` in the source's own words. The
  home is `http.ts` rather than a new module because the two siblings are there and the subject is a
  route's response.
- **Test home:** `packages/common/test/unit/response-metadata.test.ts` including a cross-copy case
  that imports a second module instance under a distinct URL, the M64 precedent, with a vacuity
  guard asserting the two copies really are distinct.

### 3.5 The brand is applied to the route's HANDLER, not to a middleware

- **Decision:** `withResponseMetadata` brands the `RouteHandler` that `createHandler` returns, and
  `openapi-plugin` reads it off `RouteInfo.definition.handler`.
- **Why:** M57 and M70m branded middleware because a guard and a validator ARE middleware. A
  response status is a property of the handler, and a decorated route may have no middleware at all
  — branding a synthetic middleware purely to carry it would add a pipeline entry that does nothing,
  which is the dead-surface rule.
- **Test home:** `packages/openapi-plugin/test/integration/derive-response-status.test.ts` reads
  through a real kernel application's `RouteInfo`, so the two packages are proven to agree on the
  symbol.

### 3.6 `deriveResponseStatus` defaults ON, and precedence mirrors M70m exactly

- **Decision:** `OpenApiGeneratorOptions.deriveResponseStatus?: boolean`, default `true`. A DECLARED
  `RouteSchema.response` wins (tested `!== undefined`); otherwise a derived status replaces the
  default `200` key at `openapi-generator.ts:1004-1008`; otherwise the `200` default stands.
- **Why:** §1 establishes that `deriveSecurity` is opt-in because it needs a caller-supplied scheme
  name and `deriveRequestSchemas` is opt-in-by-default because it needs nothing. A status needs
  nothing, so it follows the second. The `!== undefined` test rather than a length check is copied
  deliberately — an empty declared map is a caller's way of saying "no documented responses".
- **Test home:** `derive-response-status.test.ts`: declared wins; derived replaces the default;
  `deriveResponseStatus: false` reproduces the previous document byte-for-byte.

### 3.7 `@Redirect` contributes a `3xx` response to the document; `@ResponseHeader` contributes nothing

- **Decision:** A `@Redirect` route's derived status is the redirect status. `@ResponseHeader` is
  NOT derived into the document.
- **Why:** An OpenAPI response header entry needs a schema and a description the decorator does not
  carry, so deriving one would put an under-specified `headers` object into every document that used
  the decorator. Stating this makes it a decision rather than an omission a reviewer re-raises.
- **Test home:** `derive-response-status.test.ts` asserts the `3xx` key appears and that no
  `headers` object is emitted for a `@ResponseHeader` route.

### 3.8 Derivation happens at the operation builder, not inside `#buildResponses`

- **Decision:** `#deriveResponseStatus(route)` is called from the operation builder at
  `openapi-generator.ts:705`, which already has `route` in scope, and its result re-keys the map
  `#buildResponses` returned. `#buildResponses`'s signature is unchanged.
- **Why:** `#buildResponses(responseSchema, operationId)` receives no route
  (`openapi-generator.ts:975-977`), so it cannot read the brand; the call site can, which is exactly
  how `#deriveSecurity(route)` is reached at `:729`. An earlier draft of this plan left this as a
  slash between two mechanisms in §4.1, which is the undecided seam §3's own template comment
  forbids — recorded here rather than silently resolved.
- **Test home:** `packages/openapi-plugin/test/integration/derive-response-status.test.ts`, whose
  byte-identity case for `deriveResponseStatus: false` is what proves the re-key is the only change.

## 4. Exported surface — every symbol names its consumer

| Exported symbol         | Kind                  | Consumer / real code path that READS it                                                                                                                                |
| ----------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HttpCode`              | fn (method decorator) | `createHandler` applies the recorded status; `openapi-plugin` derives from the brand.                                                                                  |
| `ResponseHeader`        | fn (method decorator) | `createHandler` applies the recorded headers. Deliberately NOT read by `openapi-plugin` (§3.7).                                                                        |
| `Redirect`              | fn (method decorator) | `createHandler` applies status + `Location`; `openapi-plugin` derives the `3xx` key.                                                                                   |
| `RESPONSE_METADATA`     | symbol (`common`)     | Exported for the same reason `VALIDATION_METADATA` is (`http.ts:735-737`): a handler produced outside `decorator-plugin` can be branded. Read by `responseMetadataOf`. |
| `RouteResponseMetadata` | type (`common`)       | The brand's payload; named in `withResponseMetadata`'s signature, so a consumer branding its own handler can construct one.                                            |
| `withResponseMetadata`  | fn (`common`)         | Called by `createHandler`.                                                                                                                                             |
| `responseMetadataOf`    | fn (`common`)         | Called by `openapi-plugin`'s `#deriveResponseStatus`.                                                                                                                  |

### 4.1 Options — every option names its consumer

| Option                                                   | Consumer                                                                             | Behavior (per implementation)                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenApiGeneratorOptions.deriveResponseStatus?: boolean` | The operation builder at `openapi-generator.ts:705`, never `#buildResponses` (§3.8). | Default `true`. `false` skips the derivation entirely, reproducing the pre-milestone document byte-for-byte — asserted, not assumed (§6). |
| `@HttpCode(status)` argument                             | `createHandler` → `ctx.response.status(...)`.                                        | The success status for a plain return. Overridden by a returned `HandlerResult` (§3.2).                                                   |
| `@Redirect(url, status?)` arguments                      | `createHandler` → `status` + `Location` header.                                      | `status` defaults to `302`, matching `IResponse.redirect`'s documented default (`common/src/http.ts:248`).                                |

## 5. Implementation files

| File                                                          | Purpose                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/common/src/http.ts`                                 | `RESPONSE_METADATA`, `RouteResponseMetadata`, `withResponseMetadata`, `responseMetadataOf` (§3.4). |
| `packages/common/src/index.ts`                                | Barrel additions.                                                                                  |
| `packages/decorator-plugin/src/decorators/response.ts`        | The three decorators.                                                                              |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts`    | `createHandler` applies the metadata and brands the returned handler (§3.1, §3.5).                 |
| `packages/decorator-plugin/src/index.ts`                      | Barrel additions.                                                                                  |
| `packages/openapi-plugin/src/generators/openapi-generator.ts` | `deriveResponseStatus` option and `#deriveResponseStatus` (§3.6, §3.7).                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                 | src covered                                            | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/response-metadata.test.ts`                     | `common/src/http.ts` additions                         | Brand round-trips; a foreign value under the same global symbol is treated as absent (the `VALIDATION_METADATA` behaviour at `http.ts:718-719`); the property is non-enumerable; a cross-copy case with a vacuity guard (§3.4).                                                                                                                                               |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)             | `common/src/index.ts`                                  | Compile-time assertions declared against the barrel, not the concrete module — M70m's review found that dropping a type export left every runtime assertion green.                                                                                                                                                                                                            |
| `packages/decorator-plugin/test/unit/response-shaping.test.ts`            | `decorators/response.ts`, `plugin/decorator-plugin.ts` | `@HttpCode(201)` yields `201`; repeated `@ResponseHeader` yields both headers; `@Redirect` sets status + `Location` and the handler body still ran (§3.3); a returned `HandlerResult` wins (§3.2). Calls type-check against `SetuMethodDecorator`.                                                                                                                            |
| `packages/decorator-plugin/test/unit/response-shaping-order.test.ts`      | `plugin/decorator-plugin.ts`                           | §3.1: the write lands BEFORE `method(...)` — a handler reading `ctx.response` observes the decorator's status, and its own `status(202)` then wins. Moving the write to after the method must fail this; a test asserting only the final status would pass regardless.                                                                                                        |
| `packages/decorator-plugin/test/integration/render-with-status.test.ts`   | `plugin/decorator-plugin.ts`                           | `@Render` + `@HttpCode(201)` answers `201` with the rendered HTML body and `text/html` — driven through `app.fetch`, not `inject()`, because `inject()` exposes no response headers (the M51 `Allow` lesson).                                                                                                                                                                 |
| `packages/decorator-plugin/test/unit/barrel-exports.test.ts` (extended)   | `decorator-plugin/src/index.ts`                        | The barrel gains exactly the three decorators.                                                                                                                                                                                                                                                                                                                                |
| `packages/openapi-plugin/test/integration/derive-response-status.test.ts` | `openapi-generator.ts`                                 | Derived `201` replaces the default `200`; a DECLARED `response` map wins; `deriveResponseStatus: false` reproduces the previous document byte-for-byte; a `@Redirect` route emits its `3xx`; a `@ResponseHeader` route emits no `headers`. Drives the REAL `decorator-plugin` through a real kernel application so the two packages are proven to agree on the symbol (§3.5). |

Per-file 90% branch/function/line on every changed `src` file.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m97b-response-shaping, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs        # fence counts for docs/decorators.md
deno task publish:check     # committed tree — common and two plugin barrels change
deno task release:verify 0.6.0
```

## 8. Risks & mitigations

- **The derivation changes an existing document and nobody notices.** Every regenerated client's
  success type moves from `200` to the derived status for any decorated route carrying `@HttpCode`,
  which is a compile-time break for a call site reading the success body. Mitigation: CHANGELOG
  entry under a breaking marker, `docs/upgrading.md` entry written at milestone time rather than
  reconstructed at release cut (the M90h finding, and the release step that was skipped on its first
  use), and §6's byte-identity assertion for the `false` arm.
- **`Symbol()` instead of `Symbol.for`.** Silent on every read when two copies of `common` share a
  process. Mitigation: §6's cross-copy case, with a vacuity guard so it cannot pass if Deno ever
  deduplicates the modules.
- **The brand is read off the wrong member.** `RouteInfo.definition` has `handler`, `middleware?`
  and `schema?` (`common/src/http.ts:856-862`); reading `middleware` would find nothing for a
  decorated route with no guards. Mitigation: §3.5 fixes the member and §6's integration row reads
  through a real `RouteInfo`.
- **`inject()` cannot see the assertion.** It exposes no response headers, so a `@ResponseHeader`
  test written against it would pass regardless. Mitigation: §6 mandates `app.fetch` for every
  header assertion.
- **A second stacked JSDoc block.** M70m and M75 both shipped a docblock describing the wrong
  function because an insertion stacked a new block on an existing one, and M75's was caught only by
  the doc-lint ratchet. Mitigation: re-read each touched block after insertion, and `check:docs` is
  a named gate above.

## 9. Out of scope

- **`@Res()` raw response injection.** `@Ctx()` already is that; a second spelling is dead surface.
- **Content negotiation.** M94 measured that no framework of the three negotiates HTML-versus-JSON
  on the exception path automatically; nothing here changes that.
- **Deriving OpenAPI response HEADERS from `@ResponseHeader`** — §3.7, declined with reason.
- **Changing what `setu g controller` and `g module` emit** so a create handler answers `201` — C3.
  It is a behaviour change to already-published generated output and wants its own CHANGELOG
  migration note, as M58's did.
- **Decorators for non-HTTP ingress** — M97a. **Typed configuration sections** — M97c.
