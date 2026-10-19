# Milestone 113k — The Idempotency Key From Client to Server (`@setu-ts/sdk` + docs)

> **Status:** Planning. Branch: `feat/m113k-idempotency-key`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A browser or service calling an idempotent endpoint through the generated SDK client must be able to
send a key the server de-duplicates on, and an operator wiring the server must be able to follow the
docs to a working setup. X68 (`smoke/X67-X73-FINDINGS.md`) proved the server side correct on every
backend and found three gaps between client and server: a generated operation cannot carry a
per-call key (V9-15), the CORS example blocks the key header and nothing says to expose the replay
header (V9-16), and the tier-C store has no published schema while the idempotency README describes
two shipped features as future work (V9-14). One code change (the SDK generator), the rest
documentation pinned by tests.

- **In scope:**
  - **V9-15** — every generated operation takes an optional final
    `request?: OperationRequestOptions` (`idempotencyKey`, `signal`), forwarded to
    `IHttpClient.request`; plus the pre-existing local identifier collisions this parameter would
    widen (§3.2).
  - **V9-16** — the `http-security-plugin` CORS example allows `idempotency-key` and exposes
    `idempotent-replayed`; a "From a browser" section in the idempotency README; a sentence in the
    SDK's Keyed retries; a test that drives the README's exact CORS options.
  - **V9-14** — the tier-C DDL (PostgreSQL and SQLite) and its Drizzle mapping in the
    `database-plugin` README, pinned to the committed fixtures by a test; the idempotency README's
    guarantee 2, the M105 purge-race sentence, the `within` `ttlMs` floor, and the `ioredis` install
    step.
- **NOT this milestone:**
  - Closing the tier-C purge race with M105's `deleteWhere` — a store behaviour change (both rows
    must go together, and deferred-write transaction sources omit conditional members). Unowned;
    named in the README as the reason the race remains.
  - A `setu add idempotency` command and a schematic emitting an `idempotent()` route (X68's
    generation gaps, recorded there as expected) — CLI work with no register row; unowned.
  - The `database-plugin` README's `Deno.env.get` / `npm:mongodb` sites V9-14 also names — already
    corrected by M113j (PR #469); verified absent (§1).

## 1. Contracts verified from SOURCE (not names)

| Reference                              | Source (file:line)                                                                                                          | Verified surface / fact                                                                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClientRequest`                        | `packages/sdk/src/http/contracts.ts:41-69`                                                                                  | Has `method`, `path`, `query?`, `headers?`, `json?`, `idempotencyKey?: string`, `signal?: AbortSignal`. All readonly. `idempotencyKey` is validated before any network call and makes the request retryable on any method and on `409`.       |
| Header conflict refusal                | `packages/sdk/src/http/http-client.ts:381-389`, `:149`                                                                      | A request carrying both `idempotencyKey` and the configured header throws; `ClientOptions.headers` carrying the header is refused while `idempotency` is configured. Unchanged here — the per-call key is the route around it (V9-15).        |
| Generated operation signatures         | `packages/sdk/src/codegen/openapi-codegen.ts:1271-1349`                                                                     | Interface pass and factory pass each build `params` from `pathParams` (positional) then `opts${?}: <Args>`; the factory's parameter is `client: IHttpClient` (`:1288`); body as `json: opts.body`. One `renderSignature` (`:327`) wraps both. |
| Local identifier collisions (probed)   | probe in session scratch, against `develop` `828bf7de`                                                                      | Path param `client` emits `client.request` on the string parameter; path param `opts` beside a query param emits `getB(opts: string, opts?: GetBArgs)` — duplicate parameter. Both generate broken source today.                              |
| Import names claimed                   | `packages/sdk/src/codegen/openapi-codegen.ts:1102-1104`                                                                     | `ClientResponse`, `IHttpClient`, `HttpClientError` are claimed in the `TypeNameRegistry`, so a document component of the same name refuses rather than shadowing the import. A new import must join this list.                                |
| Path-parameter identifier, three sites | `openapi-codegen.ts:832`, `:836`, `:856` (`assertPathParamsMatchTemplate`), `:875` (`render`), `:1028` (`buildPathLiteral`) | Each site calls `sanitizeIdentifier` independently. Renaming at one site only would leave the path template interpolating a name the parameter list no longer declares.                                                                       |
| Operation named `client` (probed)      | `tsc --strict` on the emitted shape                                                                                         | `function client()` inside `createApi(client)` is `TS2300 Duplicate identifier` — broken today. An operation named `request` or `opts` is not: a nested function's own parameter of that name shadows harmlessly.                             |
| `RESERVED` / identifier sanitizing     | `packages/sdk/src/codegen/openapi-codegen.ts:133`, `:210-214`                                                               | Reserved JS words get a `_` prefix. `client`, `opts` are not in it.                                                                                                                                                                           |
| SDK barrel                             | `packages/sdk/src/index.ts:12-80`                                                                                           | Exports `createClient`, the contract types, `generateOpenApiClient`, errors. No per-operation option type exists.                                                                                                                             |
| Committed codegen fixtures             | `packages/sdk/test/fixtures/*-client.ts`                                                                                    | Five generated clients type-checked by `pnpm run check`; the `deno fmt --check` gate covers them (M111e1). They regenerate with this change.                                                                                                  |
| Tier-C store rows                      | `packages/database-plugin/src/idempotency/database-idempotency-store.ts:66-117`, `:197-232`                                 | Default entity `'Idempotency'`; rows `id, kind, role, fingerprint, createdAt, expiresAt, result`; purge reads `where {kind, role}` + `expiresAt lt`, and deletes claim and result in one transaction after a re-read. No `deleteWhere`.       |
| Committed tier-C DDL                   | `packages/database-plugin/test/fixtures/idempotency-postgres.sql`, `idempotency-sqlite.sql`                                 | Table `setu_idempotency` with those columns (`bigint` times) and index `(kind, role, expires_at)`; used by `idempotency-plugin/test/fixtures/within-backends.ts:40` and `within-d1.test.ts:45`. Not in any README.                            |
| README-DDL pin precedent               | `packages/messaging-plugin/test/unit/inbox/readme-ddl.test.ts:27-44`                                                        | Asserts the README embeds the committed `.sql` fixture verbatim. The pattern to copy.                                                                                                                                                         |
| `MIN_WITHIN_TTL_MS`                    | `packages/idempotency-plugin/src/constants.ts:99`; `within/within-options.ts:71`                                            | `60_000`; a smaller `ttlMs` refuses every call. Not in the README's options table.                                                                                                                                                            |
| `loadIoredis`                          | `packages/idempotency-plugin/src/stores/redis-client.ts:31-40`                                                              | Already throws `OptionalDependencyUnavailableError('ioredis')` (M113d). The README names no install step.                                                                                                                                     |
| Replay header                          | `packages/idempotency-plugin/README.md:99`                                                                                  | A replay adds `Idempotent-Replayed: true`.                                                                                                                                                                                                    |
| CORS options                           | `packages/http-security-plugin/README.md:46-48`, `:138-142`; `src/middleware/cors-middleware.ts:94`, `:163-174`             | Example sets `allowedHeaders: ['content-type', 'authorization']`; `exposedHeaders?` defaults `[]`. On a non-preflight request `Access-Control-Expose-Headers` is written BEFORE `next()`.                                                     |
| Replay header writes                   | `packages/idempotency-plugin/src/core/record.ts:271-279`                                                                    | `replay()` sets the status and ADDS headers with `ctx.response.header`; it does not reset the response, so CORS headers written earlier survive a replay.                                                                                     |
| Key header option                      | `packages/idempotency-plugin/src/core/options.ts:615`; `constants.ts:9`                                                     | The route source's `key: { header }`, default `IDEMPOTENCY_KEY_HEADER` (`'Idempotency-Key'`).                                                                                                                                                 |
| README fence counts                    | `test/package-readme-fence-compiler.test.ts:136`, `:139`, `:148`, `:189`                                                    | Compilable-fence counts are pinned per README (http-security 2, idempotency 3, sdk 15); `database-plugin/README.md` is in `UNGATED`. A new TypeScript fence changes the pinned count.                                                         |
| SDK fixture format gate                | `package.json:43-44`, generated by `scripts/node-manifests.ts:564-566`                                                      | `deno fmt --check` names the five client fixtures explicitly; a NEW fixture file needs a `node-manifests.ts` edit, extending an existing one does not.                                                                                        |
| Executed generated code                | `packages/sdk/test/e2e/generated-client.test.ts:15-18`, `:1083-1087`, `:1148-1152`                                          | The e2e imports the COMMITTED fixtures and runs them over the real `HttpClient`; other cases compare each fixture byte-for-byte with fresh generator output.                                                                                  |
| Stale database README sites            | `grep -n "Deno.env\|npm:mongodb" packages/database-plugin/README.md`                                                        | No match — fixed by M113j.                                                                                                                                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                        | Resolution (picked side)                                  | Doc deliverable (same PR)                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C1  | Idempotency README guarantee 2 says recording inside the business transaction "is a later milestone"; `within` (M109b) ships it | The code: tier C delivers guarantee 2 for database work   | Rewrite guarantee 2 to name `within` and its limits (outside effects still at-least-once)   |
| C2  | Idempotency README says a conditional delete "the portable repository does not offer yet (M105)"; M105 shipped `deleteWhere`    | The code: `deleteWhere` exists; the purge does not use it | State why the race remains (two rows, deferred-write transaction sources omit conditionals) |
| C3  | `http-security-plugin` CORS example blocks the key header the SDK README tells the reader to allow                              | The SDK README                                            | Example gains `idempotency-key` and `exposedHeaders: ['idempotent-replayed']`               |

## 3. Design decisions

### 3.1 Per-call request options on generated operations (V9-15)

- The SDK exports
  `interface OperationRequestOptions { readonly idempotencyKey?: string; readonly signal?: AbortSignal }`
  from `src/http/contracts.ts`, beside `ClientRequest`, with JSDoc stating each field's
  `ClientRequest` meaning. `headers` is deliberately absent: header parameters the document declares
  are already typed fields of `opts`, and a free header map would reopen the key-in-headers
  conflict.
- Every generated operation — interface pass and factory pass — gains a final optional parameter
  `request?: OperationRequestOptions`, after path parameters and after `opts`. It is optional even
  when `opts` is required. Both passes build the list through the same code that builds it today, so
  the two cannot disagree.
- The factory forwards only the two fields, each only when defined, so the emitted code type-checks
  under `exactOptionalPropertyTypes` and a JavaScript caller's extra properties never reach
  `client.request`:

  ```ts
  ...(request?.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
  ...(request?.signal === undefined ? {} : { signal: request.signal }),
  ```

  emitted after the operation's own fields. The generated file's type import gains
  `OperationRequestOptions` from `sdkImport`, and the name joins the claimed-imports list
  (`openapi-codegen.ts:1102`), so a document component named `OperationRequestOptions` refuses like
  `ClientResponse` does instead of shadowing the import.

- Validation and conflict behaviour are the client's, unchanged: a malformed key throws `RangeError`
  before any request, and a key beside an `Idempotency-Key` header still refuses.
- **Compatibility:** an added optional trailing parameter is source-compatible for callers, and an
  object implementing the old `Api` (fewer parameters) stays assignable. Regenerated fixtures
  change. CHANGELOG `Added`; no upgrade-guide entry needed (no reader action).

### 3.2 Local identifiers the generator owns

The factory body introduces three names: `client` (the factory parameter), `opts` and `request`
(each method's parameters). Two collisions already generate broken source (§1) and the new parameter
would add a third.

- **Path parameters.** One internal helper, `pathArgumentName(raw)` — `sanitizeIdentifier(raw)`,
  then a `_` prefix when the result is `client`, `opts` or `request` — replaces the bare
  `sanitizeIdentifier` call at all three path-parameter sites (`assertPathParamsMatchTemplate`,
  `render` for path parameters only, `buildPathLiteral`), so the declared parameter and the
  interpolated template cannot disagree. One prefix is enough because `sanitizeIdentifier` drops
  leading underscores (the unit test pins this), so no document can supply `_client` itself, and the
  existing duplicate-placeholder refusal still applies to the renamed set. Path parameters are
  positional, so the rename is invisible to callers.
- **Operation names.** An operation whose `safeName` is `client` becomes `_client`, through the same
  check at the one site that derives `safeName` (`openapi-codegen.ts:548`). This renames a public
  method, acceptable only because such a document generates source that does not compile today.
  `request` and `opts` are not renamed as operation names (§1 probe).
- Query and header parameters are fields of `opts` and need nothing.

### 3.3 CORS documentation and its test (V9-16)

- `http-security-plugin` README example:
  `allowedHeaders: ['content-type', 'authorization', 'idempotency-key']`,
  `exposedHeaders: ['idempotent-replayed']`, with two sentences: a keyed SDK request carries a
  non-safelisted header, so the preflight must allow it; the page can read `Idempotent-Replayed`
  only when it is exposed.
- Idempotency README: a "From a browser" section — the two CORS options, the SDK per-call key and
  `ClientOptions.idempotency`, and that a renamed key header (the route's `key: { header }` and
  `ClientIdempotencyOptions.header`) must be renamed in CORS too. The CORS middleware must run
  before `idempotent()`; a replay only adds headers (§1), so the exposed header list survives it.
- Any TypeScript fence added to the http-security, idempotency or sdk README updates its pinned
  count in `test/package-readme-fence-compiler.test.ts`.
- SDK README Keyed retries: one sentence on `exposedHeaders` for the replay header, and the per-call
  form `api.op(args, { idempotencyKey })`.
- **Test** (`packages/http-security-plugin/test/integration/readme-cors-idempotency.test.ts`):
  builds `corsMiddleware` with the README example's exact options in a kernel app, sends a preflight
  with `Access-Control-Request-Headers: content-type, idempotency-key` and asserts the allow list
  contains `idempotency-key`; sends a simple request and asserts `Access-Control-Expose-Headers`
  contains `idempotent-replayed`. The options object lives in the test as the same literal the
  README shows, and a second assertion reads the README fence and checks the literal appears in it,
  so editing one without the other fails.

### 3.4 Tier-C schema and README corrections (V9-14)

- `database-plugin` README gains a "Tier-C idempotency store" subsection beside the outbox/inbox
  DDL: the PostgreSQL DDL embedded verbatim from `idempotency-postgres.sql`, the SQLite DDL from
  `idempotency-sqlite.sql`, the Drizzle mapping (`drizzleTables: { Idempotency: pgTable(...) }`,
  `bigint` in `{ mode: 'number' }`), and that the index serves the purge.
- **Test** (`packages/database-plugin/test/unit/idempotency/readme-ddl.test.ts`): the inbox
  `readme-ddl.test.ts` pattern — the README contains each fixture verbatim.
- Idempotency README: guarantee 2 per C1; the purge-race paragraph per C2; the options table states
  `within`'s `ttlMs` range (`60,000` ms minimum, `MAX_TTL_MS` maximum — read the constant, do not
  restate a number not in source); Installation names `npm install ioredis` for the Redis store and
  that its absence fails startup with `OptionalDependencyUnavailableError`.

## 4. Exported surface — every symbol names its consumer

| Symbol                    | Kind      | Consumer                                                               |
| ------------------------- | --------- | ---------------------------------------------------------------------- |
| `OperationRequestOptions` | interface | Every generated client's `Api` and factory (imported from `sdkImport`) |

**Breaking for implementors:** none — `IHttpClient` is unchanged, and an object implementing a
previously generated `Api` (fewer parameters) stays assignable to the regenerated one.

### 4.1 Options — every option names its consumer

| Option                                   | Consumer                                           |
| ---------------------------------------- | -------------------------------------------------- |
| `OperationRequestOptions.idempotencyKey` | Generated factory → `ClientRequest.idempotencyKey` |
| `OperationRequestOptions.signal`         | Generated factory → `ClientRequest.signal`         |

## 5. Implementation files

- `packages/sdk/src/http/contracts.ts` — `OperationRequestOptions`.
- `packages/sdk/src/index.ts` — export it.
- `packages/sdk/src/codegen/openapi-codegen.ts` — the trailing parameter, the forwarding spreads,
  the import, the local-identifier rename.
- `packages/sdk/test/fixtures/*-client.ts` — regenerated (by the generator, not by hand).
- `packages/sdk/test/fixtures/name-collision-document.ts` — extended with a path parameter named
  `client`, one named `opts` beside a query parameter, and an operation named `client`, so the
  renamed output is byte-compared, type-checked by `pnpm run check` and format-checked by the
  existing fixture gate (no `node-manifests.ts` edit).
- Docs: `packages/sdk/README.md`, `packages/idempotency-plugin/README.md`,
  `packages/http-security-plugin/README.md`, `packages/database-plugin/README.md`, `PUBLIC_API.md`
  (SDK section: the type and the parameter), `CHANGELOG.md` (`Unreleased`), README export tables via
  `pnpm run docs:exports`.
- Tracking: ROADMAP 113k section **Shipped** paragraph and Progress row ✅, `CLAUDE.md` Current
  status entry; plan archived to `plans/archive/`.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| `src` file                           | Test file                                                               | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk/src/codegen/openapi-codegen.ts` | existing codegen unit tests + new cases in the same file                | Every operation in the interface and factory ends with `request?: OperationRequestOptions`; the two spreads are emitted; the import line includes the type; a component named `OperationRequestOptions` refuses; path params `client`, `opts`, `request` are renamed and the path template interpolates the renamed identifier; a placeholder spelled `_client` sanitizes to `client` (pinning the one-prefix claim); an operation named `client` becomes `_client`. |
| (behaviour)                          | `sdk/test/e2e/generated-client.test.ts` (new cases)                     | Through the committed `generated-client.ts` fixture over the real `HttpClient` and an injected `fetch`: the per-call key reaches the configured header and stays identical across a `503` retry; a `signal` aborts; no `request` sends no key; a JS caller's `{ method: 'DELETE' }` in `request` does not change the method.                                                                                                                                         |
| `sdk/src/http/contracts.ts`          | barrel-exports test (type assertion, declared against the barrel)       | `OperationRequestOptions` is exported and assignable from `{ idempotencyKey: 'k' }`.                                                                                                                                                                                                                                                                                                                                                                                 |
| (committed fixtures)                 | `pnpm run check` + the fixture `deno fmt --check` gate                  | Regenerated fixtures type-check and format.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| (docs)                               | `http-security-plugin/test/integration/readme-cors-idempotency.test.ts` | §3.3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| (docs)                               | `database-plugin/test/unit/idempotency/readme-ddl.test.ts`              | §3.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**Negative controls (each observed failing, then reverted):** drop the `request` parameter from the
factory pass only (interface/factory disagreement fails `check` on the fixtures); emit
`idempotencyKey: request?.idempotencyKey` instead of the spread (fails `check` under
`exactOptionalPropertyTypes`); apply the rename in `render` only and not in `buildPathLiteral` (the
extended name-collision fixture fails `check`); remove the local-identifier rename (the `client`
path-param test fails); revert the README CORS literal (the CORS test fails); delete one DDL line
from the README (the DDL test fails).

**End to end (verification step):** regenerate a client from a running `idempotent()` app's
`/openapi.json`, call one operation twice with one `idempotencyKey`, assert one effect and a
replayed second response.

## 7. Verification gates

```bash
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test sdk http-security-plugin database-plugin idempotency-plugin
pnpm test:coverage sdk http-security-plugin database-plugin idempotency-plugin
pnpm run check:docs
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

Per-file 90% branch/function/line for every changed `src` file.

## 8. Risks & mitigations

- **Regenerated fixtures drift from what users see** — fixtures are regenerated by running the
  generator, never edited; the existing comparison tests catch a hand edit.
- **A later field added to `OperationRequestOptions` but not forwarded** — the forwarding spreads
  are emitted from one list in the generator, and the behaviour test asserts each field arrives.
- **Renaming a path parameter breaks an existing caller** — only names that today generate broken
  source are renamed (§1 probe), so no working client changes.

## 9. Out of scope

- The purge race closure with `deleteWhere` (§0).
- `setu add idempotency` and an idempotent-route schematic — unowned (§0).
- Server-side automatic CORS for the idempotency header — the plugin does not own CORS.

## 10. Design security review (recorded after implementation)

Recorded before the committed-tree audit, after implementation (the M101a / M113a / M113n / M113o
precedent); it is not presented as having guided the design.

**Flows reviewed.** (a) The OpenAPI generator turning a document into TypeScript source: the new
trailing parameter, the forwarding spreads, the claimed import name, and the local-identifier
renames. (b) A caller's per-call `OperationRequestOptions` object reaching `IHttpClient.request`
through a generated operation. (c) The documented CORS configuration for keyed browser calls — which
request header a cross-origin page may send and which response header it may read. (d) The
documented key-reuse guidance. (e) The documented tier-C table schema and the `ioredis` install
step.

**Assets.** The integrity of generated source (a document must not inject code); the request a
generated operation sends (method, path, headers, body); the idempotency key's confidentiality and
its scoping to one principal; the CORS boundary of an application that follows the docs; stored
idempotency results, which may hold personal data.

**Attackers.** A hostile or careless OpenAPI document author (the generator's input is untrusted). A
JavaScript caller passing an arbitrary object as `request`. A cross-origin page, both one the
application's CORS allowlist admits and one it does not. Another principal reusing a key it has
observed or guessed.

**Obligations.**

1. No document-derived text newly reaches emitted source: the parameter name `request`, the type
   name `OperationRequestOptions` and both spreads are constants, and a rename only prefixes `_` to
   an identifier `sanitizeIdentifier` already produced.
2. Only `idempotencyKey` and `signal` from a caller's `request` object reach `client.request`, so a
   caller-supplied `method`, `path`, `headers`, `query` or `json` cannot change the request.
3. A per-call key gets exactly the client's existing validation — `RangeError` before any network
   I/O for anything outside 1–255 characters of `0x21`–`0x7E` without `"` — so no header injection;
   the key-plus-header refusal is unchanged. The generated path adds neither a second check nor a
   bypass.
4. A document component cannot shadow an SDK import: `OperationRequestOptions` is claimed like
   `ClientResponse`, `IHttpClient` and `HttpClientError`.
5. A rename cannot collide: `sanitizeIdentifier` never yields a leading `_`, so no document can
   supply `_client`, and the existing duplicate-name refusals apply to the renamed set.
6. The documented CORS widening is the minimum the feature needs: one named request header and one
   named response header, under an explicit origin with credentials; no wildcard origin is shown. An
   origin outside the allowlist gains nothing.
7. The docs never advise scoping a record by anything but authenticated identity, and state that a
   reused key never crosses principals.
8. The schema docs add no secret: the table holds hashed key ids, a fingerprint hash and the encoded
   result, whose retention is already documented.

**Residual, accepted (documented).** A keyed request is retried on any method and on `409`, so a
per-call key on a `DELETE` or a `POST` against a server that does not de-duplicate can execute twice
— the SDK README states that keyed retries are safe only behind `idempotent()` or `within`. With
`principal: 'optional'` every anonymous caller shares one scope, so a guessed key replays another
anonymous caller's result (pre-existing, documented in the idempotency README's check-order list).
An exposed `Idempotent-Replayed` header tells an allowed origin a response was a replay, which is
its purpose. The generated spreads read each field of the caller's own object twice; a getter that
changes between reads affects only that caller's own request, and the client validates the value it
receives.

**Findings.**

| #   | Finding                                                                                                                      | Severity | Disposition                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| R1  | Review: "the per-call `idempotencyKey` is the way to share one key across clients" can be read as sharing a key across users | Low      | Fixed: reworded to client instances acting for one principal, and states that a key never crosses principals           |
| R2  | Review: obligation 3 had no test driving a malformed key through a generated operation; the e2e covered only valid keys      | Low      | Fixed: an e2e case sends CRLF, `"` and empty keys through `getUserById` and asserts `RangeError` with zero fetch calls |
