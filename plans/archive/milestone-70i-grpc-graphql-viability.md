# Milestone 70i — gRPC and GraphQL viability (`@setu-ts/grpc-plugin`, `@setu-ts/graphql-plugin`)

> **Status:** Complete (PR #180). Archived on completion. Branch:
> `feat/m70i-grpc-graphql-viability`. `main` is protected — all work (implementation + fixes) stayed
> on this one branch until it merged via a single PR.

## 0. Objective & scope

Two packages the alpha.8 smoke programme found undeliverable as documented. `grpc-plugin` carries an
explicit **repair-versus-withdraw** decision the ROADMAP deferred to this milestone: its default
`basePath` is unreachable by every native gRPC client, and native `application/grpc` works on no
runtime it can run on. `graphql-plugin`'s only documented registration API does not exist, its
code-first arm does not type-check against the real `graphql` package, and its resolver surface
cannot be typed at all. This milestone decides gRPC's scope explicitly, makes both packages'
documented paths executable, and installs the recurrence gate for the class of defect that produced
X6-2 and X7-1 — a README that no gate compiles.

- **In scope:** the nine register rows the ROADMAP assigns this workstream — **X7-1**, **X7-2**,
  **X7-4** (gRPC), **X6-2**, **X6-3**, **X6-4**, **X6-5**, **X6-6**, **X6-7** (GraphQL +
  websocket-plugin docs) — plus the stated viability decision and a fence gate covering the two
  owned READMEs.
- **NOT this milestone:**
  - X7-3 (module loading on Node/Bun) — closed by **M70e** (PR #174); it is this milestone's
    _precondition_, not its work.
  - X6-1 / X7-6 / X7-7 (pipeline bypass, RPC shutdown drain) — closed by **M70a** (PR #167).
  - X7-5 (handler errors logged nowhere) — closed by **M70f** (PR #176).
  - X7-8 (health faces disagree on `degraded`) — closed by **M70c** (PR #172).
  - X7-9 (`resilience.wrap()` per request) — **M70n**, `resilience-plugin` docs.
  - A trailer-capable serve path (the only thing that could make native gRPC-binary work) — unowned;
    §3.3 states why it is architectural rather than deferrable.
  - `setu generate ws-route` — declined with reason in §3.11; a CLI feature, not a docs fix.
  - Extending the fence gate to **all** package READMEs and to `PUBLIC_API.md` in full — **M70n**
    (docs sweep). §3.10 ships the narrow deep gate plus a repo-wide shallow one.

### 0.1 Package-list correction (recorded, not inherited)

The ROADMAP row names `(grpc-plugin, graphql-plugin)`. Two corrections, both established by reading
the register rows the same row assigns:

1. **`websocket-plugin` is added.** X6-5's register row names `websocket-plugin` (docs) and `cli`;
   the fix is a README change in that package. This mirrors the M70b (`feature-flags-plugin`,
   `common`) and M70h (`common`, `runtime`) corrections.
2. **`cli` is dropped.** X6-5's `cli` half is the missing `ws-route` schematic, declined in §3.11 —
   no `cli` file changes on this branch.

Final package list: **`grpc-plugin`, `graphql-plugin`, `websocket-plugin`**, plus root `test/` for
the recurrence gates and the four committed docs.

## 1. Contracts verified from SOURCE (not names)

| Reference                           | Source (file:line)                                                  | Verified surface / fact                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalizeBasePath`                 | `packages/grpc-plugin/src/transports/rpc-dispatcher.ts:29`          | Default parameter is `'/grpc'`. `''` and `'/'` both normalize to the **empty string** — not `'/'`, which would produce an unmatchable `//pkg.Svc/Method` key.                                                   |
| `isWithinBasePath`                  | `packages/grpc-plugin/src/transports/rpc-dispatcher.ts:45`          | Returns `true` unconditionally when `basePath === ''`. Otherwise segment-aware: `/grpcfoo` is NOT inside `/grpc`.                                                                                               |
| `dispatchRequest`                   | `packages/grpc-plugin/src/transports/rpc-dispatcher.ts:66`          | A miss under a **root** base path returns `null` (falls through to Hono); a miss under a non-root base path returns a `404`. So `basePath: '/'` cannot 404 an ordinary route.                                   |
| `GrpcService.claims`                | `packages/grpc-plugin/src/services/grpc-service.ts:133`             | At a root `basePath` claims **only registered procedure paths** (exact `dispatchMap` hit); outside root, claims the whole prefix. This is what makes a root default safe post-M70a.                             |
| `GrpcService` basePath default      | `packages/grpc-plugin/src/services/grpc-service.ts:82`              | `normalizeBasePath(init.options.basePath ?? '/grpc')` — the default is spelled **twice** (here and the `normalizeBasePath` default parameter). Two homes for one value.                                         |
| `ConnectRuntime.createFetchHandler` | `packages/grpc-plugin/src/transports/connect-loader.ts:120-126`     | Delegates to Connect-ES's own `protocol.createFetchHandler(handler)`. The plugin adds no response post-processing, so it has no place to attach trailers even if it had them.                                   |
| trailer forwarding                  | `grep -rni "trailer" packages/grpc-plugin/src packages/runtime/src` | **Zero hits.** The README's "the plugin correctly forwards `Response.trailers` when available" describes code that exists nowhere.                                                                              |
| `GraphqlSchemaLike.toAST`           | `packages/graphql-plugin/src/interfaces/graphql-runtime.ts:17`      | Declared **required**, `toAST(): unknown`. `grep -rn toAST packages/graphql-plugin/src` returns **no src reader** — only test fixtures satisfy it. Dead required surface.                                       |
| `GraphqlModuleLike.parse`           | `packages/graphql-plugin/src/interfaces/graphql-runtime.ts:141`     | `parse(source: string \| { source: string })`. The real `graphql.parse` takes `string \| Source`; a bare `{ source: string }` is not a `Source`, so `adaptGraphqlModule(graphql)` cannot type-check.            |
| `FieldResolver`                     | `packages/graphql-plugin/src/interfaces/options.ts:38`              | Non-generic, all four parameters `unknown`. Lives in the **plugin**, not `common` (see C1).                                                                                                                     |
| `DefaultGraphqlContext`             | `packages/graphql-plugin/src/interfaces/options.ts:194`             | `{ services: unknown; requestContext: unknown; user?: unknown; tenant?: unknown }`. Declares **no** `connection`.                                                                                               |
| subscription context construction   | `packages/graphql-plugin/src/services/graphql-service.ts:213`       | The local is typed `Record<string, unknown>` — that cast is what lets line 224 add `connection` to a shape the interface does not declare.                                                                      |
| HTTP context construction           | `packages/graphql-plugin/src/services/graphql-service.ts:164`       | `requestContext: requestContext` — over WS `execute()` is not the path taken; over `subscribe()` `opContext.requestContext` is `undefined`. Confirms X6-6's `requestContextKeys=null`.                          |
| `GraphqlConnectionInfo`             | `packages/common/src/services/graphql.ts:101`                       | Carries `id`, `connectionParams?`, `headers`, `query`, `protocol?`, `data` — the upgrade request's headers and query, but **no** `IRequestContext`.                                                             |
| APQ refusal status                  | `packages/graphql-plugin/src/http/graphql-handler.ts:144,198`       | Hardcoded `400` on the batch and single POST paths, regardless of negotiated media type.                                                                                                                        |
| APQ refusal status (GET)            | `packages/graphql-plugin/src/http/graphql-handler.ts:305`           | Uses `apqResult.status` — a **third** spelling of the same decision. Three sites, no shared owner.                                                                                                              |
| negotiated media type               | `packages/graphql-plugin/src/http/graphql-handler.ts:67,258`        | `negotiateMediaType(ctx.request.headers.get('accept'))` is already in scope at both entry points, so the watershed fix needs no new plumbing.                                                                   |
| documented status watershed         | `PUBLIC_API.md:9060-9070`                                           | "**Exactly three** cases keep their status under `application/json`" — 415, 400 (malformed JSON), 405. APQ is a fourth.                                                                                         |
| `IServiceRegistry`                  | `packages/common/src/registry.ts:85`                                | Exists in `common`; the plugin already depends on `common`.                                                                                                                                                     |
| `IPrincipal`                        | `packages/common/src/services/auth.ts:16`                           | Exists in `common`. `IRequest.user?: IPrincipal` (`packages/common/src/http.ts:48`).                                                                                                                            |
| `ITenant`                           | `packages/common/src/http.ts:53`                                    | `IRequest.tenant?: ITenant`.                                                                                                                                                                                    |
| fence engine                        | `test/fixtures/snippets/fence-engine.ts:48`                         | `GUIDES` is a plain list of ten `docs/*.md` paths; `extractFences`/`classify`/`assembleSource` are all exported and file-agnostic. Extending the gate to more files is a list change.                           |
| fence engine Setu detection         | `test/fixtures/snippets/fence-engine.ts:329`                        | `importsFromSetuTs(code)` — the engine already distinguishes a Setu fence from a foreign-framework one, which the migration guides need (see §3.10's false-positive note).                                      |
| kernel's exported surface           | `packages/kernel/src/index.ts`                                      | One value export, `createApplication` (`:18`), plus four types (`ApplicationOptions`, `IKernelApplication`, `InjectRequest`, `InjectResponse`). No `Application` class and no `use()` member — confirming X6-2. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                               | Resolution (picked side)                                                                                                                                                                                                                             | Doc deliverable (same PR)                                                                                         |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP §"Scope realities" lists "resolver typing (X6-4)" among the **`common` widenings** alpha.9 carries. Source disagrees: `FieldResolver` and `DefaultGraphqlContext` both live in `packages/graphql-plugin/src/interfaces/options.ts`; `common` declares neither. | **Source wins.** X6-4 is a plugin-local type change. No `common` widening, no new token, and the alpha.9 breaking-change list is one item shorter than the ROADMAP states.                                                                           | ROADMAP.md — strike X6-4 from the `common`-widening bullet, noting it is plugin-local.                            |
| C2 | `packages/grpc-plugin/README.md:19` claims "Module loading works on Node, Deno, Bun, and Cloudflare Workers without modification"; `README.md:34-38` then adds an M70e note deferring `basePath` reachability and native-transport viability to M70i.                  | The deferral note has served its purpose and is **replaced**, not kept: this milestone settles both. The feature list keeps the module-loading claim (true post-M70e) and loses "for grpcurl, grpcui" from the reflection bullet unless §3.2 ships.  | `packages/grpc-plugin/README.md` — remove the M70i deferral block, rewrite Features and Limitations per §3.1-3.3. |
| C3 | `README.md:137` says the plugin "correctly forwards `Response.trailers` when available"; no `trailer` token exists in `packages/grpc-plugin/src` or `packages/runtime/src`, and `Response.trailers` is not in the Fetch standard any runtime implements.               | **Delete the sentence.** It describes code that does not exist and an API that does not exist.                                                                                                                                                       | `packages/grpc-plugin/README.md` Limitations — rewritten per §3.3.                                                |
| C4 | `PUBLIC_API.md:9066-9070` states the `application/json` watershed has "**exactly three**" exceptions; the code has four (APQ refusals answer `400`).                                                                                                                   | **The document wins and the code is corrected** (§3.9) — the stated rationale ("a client reads a non-200 as a network failure and never reads the `errors` array") describes the APQ miss precisely, since that is the one error a client MUST read. | `PUBLIC_API.md` §GraphQL — keep "exactly three", add a sentence naming APQ refusals as following the rule.        |
| C5 | `packages/grpc-plugin/README.md:52` and `PUBLIC_API.md:8411` both resolve `CAPABILITIES.GRPC` before `app.start()`; plugins register during `start()`, so both throw (X7-1).                                                                                           | **Both documents are corrected** to the `services` option as the primary form, with post-`start()` resolution documented as the supported alternative it already is (`addService` invalidates the lazily built router — `grpc-service.ts:196`).      | Both files, plus a `createApplication` note in PUBLIC_API (§3.4) so the next plugin's docs do not repeat it.      |
| C6 | `packages/graphql-plugin/README.md:121-125` puts `nodejs_compat` under `[vars]` in `wrangler.toml`; it is a `compatibility_flags` entry. Same README lists "Internal errors are masked by default" twice (lines 202, 205).                                             | Both corrected. Surfaced by X6-2's author while reading the same README; they are in scope because §3.10's fence gate makes the file a gated artifact and the duplicate bullet is in the same Security list being edited.                            | `packages/graphql-plugin/README.md`.                                                                              |

## 3. Design decisions

### 3.1 The viability decision — **REPAIR, with the native-gRPC claim withdrawn**

- **Decision:** `grpc-plugin` is **repaired and kept**. Its supported scope is narrowed, in code and
  in documentation, to **Connect** and **gRPC-Web** over all four RPC kinds. The native
  `application/grpc` wire format is **withdrawn as an advertised capability** and answered with an
  explicit, protocol-legal refusal (§3.3) rather than left to produce a broken response.
- **Why:** withdrawing the package would delete working capability. The measured evidence is that 12
  of 15 reference-client checks pass — Connect and gRPC-Web, on both HTTP/1.1 and HTTP/2, for unary,
  server-streaming and client-streaming — and reflection and Health v1 were complete against real
  `grpcurl` **on alpha.8, before this milestone's refusal**; after it, a native client reaches them
  only through Connect or gRPC-Web (§3.3, and the measurement under Verification bar below). Exactly
  one wire format fails, and its failure is **architectural, not a bug**: native gRPC signals
  completion in HTTP/2 **trailers**, the Fetch `Response` has no trailer mechanism, and M23
  deliberately moved the whole framework onto Hono's `fetch` entry point. No runtime adapter can
  emit trailers through a `Response`, so "run it on Node or Bun" is not a remedy even now that X7-3
  is closed and the package loads there. Making native gRPC work is a non-fetch serve path in
  `packages/runtime` — a reversal of M23, not a plugin fix — so it is named in §0 as unowned rather
  than deferred to a letter.
- **Test home:** no test asserts the decision itself; §3.2 and §3.3 are its executable halves, and
  the README/PUBLIC_API rewrites are its documented half.

### 3.2 `basePath` defaults to the root, and the default gets one home

- **Decision:** the default `basePath` becomes `'/'` (normalizing to `''`). The literal moves to a
  single exported `DEFAULT_BASE_PATH` constant in `rpc-dispatcher.ts`, read by both the
  `normalizeBasePath` default parameter and `grpc-service.ts:82`. This is a **breaking**
  configuration change with CHANGELOG migration text.
- **Why:** a gRPC client derives its path from the fully-qualified method name alone. No prefix
  option exists in grpcurl, grpcui, `grpc-go` or `grpc-java` — the concept is absent from the
  protocol — so under `/grpc` the reflection service the README advertises "for grpcurl, grpcui" is
  unreachable by both tools it names. Root mounting is safe, and §1 records why in two independent
  places: `dispatchRequest` falls through on a miss at root rather than 404-ing, and post-M70a
  `claims()` at root reports **only registered procedure paths**, so the kernel consults it before
  route matching without shadowing anything. Documenting `basePath: '/'` instead (the register's
  option 1) was rejected: it leaves every default installation broken for the clients the feature
  list names, and a default that must be overridden to work is not a default. The two spellings of
  `'/grpc'` are collapsed because a default with two homes is how one of them drifts.
- **Test home:** `test/unit/rpc-dispatcher.test.ts` (constant is the single source; a stock
  `GrpcService` claims `/pkg.Svc/Method`), `test/integration/grpc-integration.test.ts` (a stock
  `GrpcPlugin()` serves an RPC at the bare method path **and** an ordinary Hono route at `/products`
  is untouched).

### 3.3 A native `application/grpc` request is refused with a Trailers-Only `UNIMPLEMENTED`

- **Decision:** `dispatchRequest` inspects the request `content-type` before invoking a matched
  handler. A **native gRPC** content type is answered with a gRPC **Trailers-Only** response — HTTP
  `200`, `content-type: application/grpc`, `grpc-status: 12` (UNIMPLEMENTED), a `grpc-message`
  naming Connect and gRPC-Web as the working formats, and an empty body. Detection is **exact**:
  `application/grpc`, `application/grpc+proto`, `application/grpc+json` — and explicitly **not**
  `application/grpc-web…`.
- **Why:** today a native client gets `protocol error: missing status` (Connect) or
  `server closed the stream without sending trailers` (grpcurl) — a diagnostic that reads as a
  server fault and gives no route to the fix. Trailers-Only is the protocol's own way to report a
  status without trailers: the status lives in the HTTP header block, so it needs exactly the
  capability a fetch `Response` has. Every conformant client renders it as a clean
  `Unimplemented: <message>`. The alternative — documenting the limitation and leaving the broken
  response — was rejected because §3.2 makes the server **reachable** by native clients for the
  first time, so the number of people meeting that cryptic error goes up, not down.
- **The detection is the risk, and it is called out here because a naive `startsWith` would break
  the working path.** `'application/grpc-web+proto'.startsWith('application/grpc')` is `true`, so a
  prefix test would refuse gRPC-Web — the format that carries its trailers in the body and is the
  standard browser answer. The check parses the media type's essence and matches the exact set
  above.
- **Verification bar:** asserted in unit tests **and** driven against real `grpcurl`, per this
  repo's real-client discipline.

  **Measured (grpcurl v1.9.3), after the branch was first archived** — the plan originally recorded
  this bar as met when `grpcurl` was not yet installed, which CodeRabbit correctly flagged on PR
  #180; these are the actual results:

  | check                                             | result                                                        |
  | ------------------------------------------------- | ------------------------------------------------------------- |
  | unary native call (`-proto`, reflection bypassed) | `UNIMPLEMENTED` reported cleanly, exit 1 — **the bar is met** |
  | `grpcurl list` (reflection, **bidi**-streaming)   | hangs (exit 124)                                              |
  | control: same `list` with the refusal **removed** | hangs identically — so the hang is **not** this refusal       |
  | `grpcurl -format connect`                         | rejected: "The -format option must be 'json' or 'text'"       |

  So a conformant client **does** accept the Trailers-Only refusal on the unary path. A bidi call
  never reaches it, for the transport reason the bidi Limitations bullet already gives — the control
  is what separates the two, and it is why this is recorded as a pre-existing limitation rather than
  a defect in §3.3. The last row confirms by execution the README correction that replaced
  `grpcurl -format connect`, which was previously argued from documented flag semantics alone.
- **Test home:** `test/unit/grpc-binary-refusal.test.ts` (the exact-match table, gRPC-Web explicitly
  passing through), `test/integration/grpc-integration.test.ts` (a native content type refused; the
  same procedure over Connect and over gRPC-Web still answering normally).

### 3.4 X7-1 — the documented Usage sequence becomes the one that works

- **Decision:** both `packages/grpc-plugin/README.md` and `PUBLIC_API.md` §gRPC lead with the
  `services` plugin option. Post-`start()` resolution is documented beside it as a supported
  alternative, with the reason it works (`addService` invalidates the lazily built router,
  `grpc-service.ts:196`), so a reader knows it is designed rather than a workaround.
  `PUBLIC_API.md`'s `createApplication` entry gains one sentence: a capability is not resolvable
  from `app.services` until `start()` has run.
- **Why:** the register measured four orderings and only two work; the two documented are the two
  that throw. The `createApplication` note is the cheap generalization — X7-1 and X6-5 are the same
  mistake in two packages, so fixing it only in the two READMEs guarantees a third.
- **Test home:** the §3.10 fence gate compiles the README's Usage block; `test/docs-gate.test.ts`
  gains the nonexistent-API check.

### 3.5 X6-2 — the GraphQL README and PUBLIC_API use the API the kernel exports

- **Decision:** all five `new Application()` / `app.use(` occurrences in
  `packages/graphql-plugin/README.md` and both in `PUBLIC_API.md` §GraphQL become
  `createApplication({ plugins: [...] })`. C6's two secondary defects in the same README are fixed
  in the same pass.
- **Why:** `@setu-ts/kernel` exports exactly one symbol and it is not `Application`; a reader
  following the README fails at the import line. This package is the only one of 12 checked that
  does it, so it is a local defect, not a template — which is why the durable fix is the gate
  (§3.10) rather than a repo-wide rewrite.
- **Test home:** `test/graphql-readme-fences.test.ts` via the shared fence engine.

### 3.6 X6-3 — the structural facades accept what the real `graphql` package produces

- **Decision:** `GraphqlSchemaLike.toAST` becomes **optional**, and `GraphqlModuleLike.parse` widens
  its source parameter to `unknown`. A new committed type fixture statically imports the real
  `npm:graphql@^16`, assigns a real `GraphQLSchema` to `GraphqlSchemaLike`, and passes the real
  module through `adaptGraphqlModule`.
- **Why:** no `src` file reads `toAST` (§1) — it is a required member of a facade that nothing
  consumes, so requiring it excludes every schema the library can build in exchange for nothing.
  Both changes are widenings, so they are source-compatible for callers. The fixture must be a
  **static** import: the package's five existing real-`graphql` tests all use a dynamic `import()`
  inside a test body, which is why `deno check` never compared the two type worlds and this shipped.
- **Test home:** `test/types/real-graphql-types.ts` (a committed fixture, type-checked by
  `deno task check`, which covers `test/`) plus `test/unit/graphql-runtime-types.test.ts` asserting
  the adapted module round-trips a real parse.
- **Execution note (plan claim corrected by measurement):** the two widenings above were necessary
  but not sufficient. Measured against the real `graphql@16.14.2` under the workspace's `strict` +
  `exactOptionalPropertyTypes` compiler options, the facades diverged from the real package in ~15
  members, so the static fixture failed until the widening was completed: `GraphqlSchemaLike`
  getters return `Maybe<T>` (`| null | undefined`) and plural getters return `ReadonlyArray`;
  `GraphqlFieldLike.resolve`/`subscribe` are `unknown` (the real resolvers take a concrete
  `GraphQLResolveInfo` that no facade can name, and no `src` reader invokes them);
  `GraphqlDirectiveLike.locations` is a string-union array, not `number[]`; `validate`/`errors`
  return `ReadonlyArray`; `execute`/`subscribe` `variableValues` is a readonly index that may be
  `null`; `GraphQLError`'s `options` is `undefined` (contravariance); and `GraphqlModuleLike` is
  declared with method syntax (bivariant) referencing only the public `GraphqlSchemaLike` +
  `unknown`, so the real module assigns without a cast while keeping the precise types internal on
  `GraphqlRuntime`. The ratchet recorded the net effect: `DOC_LINT_BASELINE` 775 → 764 (the widened,
  documented facade members replaced a number of `missing-jsdoc`/`private-type-ref` diagnostics on
  the old narrow ones).

### 3.7 X6-4 — the resolver surface becomes typeable

- **Decision:** `FieldResolver` becomes generic with `unknown` defaults —
  `FieldResolver<TSource = unknown, TContext = unknown, TArgs = Record<string, unknown>>` — matching
  graphql-js's own `GraphQLFieldResolver` shape. `SubscriptionResolver.subscribe` takes the same
  parameters. `DefaultGraphqlContext` is typed against `common`: `services: IServiceRegistry`,
  `requestContext?: IRequestContext`, `user?: IPrincipal`, `tenant?: ITenant`, and the previously
  undeclared `connection?: GraphqlConnectionInfo` (§3.8).
- **Why:** under `strictFunctionTypes` a narrower parameter on a non-generic function type is a
  contravariance error, so today **every** resolver in a real application is written with `unknown`
  parameters and hand-written casts — in a codebase whose own guidelines forbid `any` and discourage
  casts. Defaults keep every existing resolver assignable.
- **`requestContext` becomes optional rather than staying required-and-`unknown`**, because the WS
  path genuinely does not supply one (§3.8) and `exactOptionalPropertyTypes` forbids assigning
  `undefined` to it. That is a type-level breaking change with no realistic runtime break — the
  member was `unknown`, so no consumer could dereference it without a cast already — and it carries
  CHANGELOG text.
- **Test home:** `test/types/resolver-typing.ts` (a committed fixture: a narrowly annotated resolver
  assigns cleanly; `ctx.services.get(...)` and `ctx.user?.id` compile with no cast),
  `test/unit/graphql-service.test.ts` for the runtime shape.

### 3.8 X6-6 — the subscription context is typed and documented, not synthesized

- **Decision:** `requestContext` is **not** populated over the WebSocket transport. It is declared
  optional (§3.7), `connection` is declared, and PUBLIC_API's "Resolver context" note states the
  per-transport shape explicitly, naming `GraphqlConnectionInfo.headers` and `.query` as where the
  upgrade request's data lives. The `Record<string, unknown>` escape at `graphql-service.ts:213` is
  replaced by the real `DefaultGraphqlContext` type.
- **Why:** the register's stronger suggestion — synthesize a `requestContext` from the snapshotted
  upgrade request — hands resolvers a context that is **dead by the time they run**. M46 records
  that the runtime closes the native request once the handshake response is returned, and post-M70a
  the upgrade's `IRequestContext` has already had its response sent and its signal settled before
  the first subscription message arrives. A resolver reading `ctx.requestContext.response` or
  awaiting `ctx.requestContext.signal` would then get a plausible object with wrong behaviour, which
  is worse than an absent one. Declaring it optional makes the compiler enforce the caveat the
  document currently states nowhere.
- **Test home:** `test/integration/graphql-ws-context.test.ts` — one resolver, driven over HTTP and
  over WS, asserting the key sets differ exactly as documented (`connection` present and
  `requestContext` absent over WS; the inverse over HTTP).

### 3.9 X6-7 — APQ refusals follow the documented watershed, from one owner

- **Decision:** a single internal helper decides the refusal status from the negotiated media type —
  `200` under `application/json`, the APQ result's own status under `graphql-response`. It is called
  from the two sites whose status can vary (single POST, GET). **Corrected at implementation time:**
  this plan first said "all three refusal sites (batch POST, single POST, GET)". The batch path
  cannot vary — a batch is refused outright under `graphql-response` before any element is resolved
  — so it carries no per-element status at all rather than calling the helper with a constant.
- **Why:** the documented rule is stated as an exhaustive invariant and one of the two is wrong; the
  rule's own rationale ("a client predating the newer media type reads a non-200 as a network
  failure and never reads the `errors` array") describes the APQ miss exactly, since
  `PersistedQueryNotFound` is the one error a client is **required** to read and retry. Apollo copes
  with both statuses (measured), and `200` is what Apollo Server itself returns, so this moves
  toward interop rather than away. Three sites already spell the decision three ways — two hardcoded
  `400` and one `apqResult.status` — which is the split the one-implementation rule exists to
  prevent.
- **Test home:** `test/unit/graphql-handler.test.ts` — the matrix of {batch POST, single POST, GET}
  × {`application/json`, `application/graphql-response+json`}, driving **both** entry points under a
  non-default configuration per the self-review checklist.

### 3.10 Recurrence gates — two layers, because one alone would be wrong

- **Decision:** (a) the M38 fence engine is extended to compile every copyable fence in
  `packages/grpc-plugin/README.md` and `packages/graphql-plugin/README.md`, with the same four
  classifications and inventory pinning the guides use; (b) a shallow repo-wide check asserts the
  nonexistent kernel API (`new Application(`, `app.use(`) appears in **no** package README and not
  in `PUBLIC_API.md`.
- **Why:** X6-2's own diagnosis is that the fence compiler enumerates ten `docs/*.md` guides, so no
  README fence and no `PUBLIC_API.md` fence is ever compiled. (a) is the deep fix but is scoped to
  the two owned packages: extending it to all 40+ READMEs would surface an unbounded number of
  failures and swallow this milestone. (b) covers the exact X6-2 class everywhere for almost
  nothing.
- **(b) must not be a naive grep, and that is measured rather than assumed.**
  `grep -rn 'app\.use(' docs/` returns five hits in `migration-fastify.md` and `migration-nestjs.md`
  — legitimate **foreign-framework** code showing what the reader is migrating from. The check is
  therefore scoped to package READMEs and `PUBLIC_API.md`, where the measured hit set today is
  exactly the seven X6-2 occurrences and nothing else. `docs/` stays with the fence engine, which
  already classifies a foreign fence via `importsFromSetuTs`.
- **Discrimination:** each gate gets a negative control — reintroducing `new Application()` into the
  graphql README must fail (b), and breaking a Usage fence must fail (a). Both observed and
  reverted.
- **Test home:** `test/package-readme-fence-compiler.test.ts` (a — see §3.10.1),
  `test/docs-gate.test.ts` (b).

#### 3.10.1 Deviation — one gate, not two (recorded at implementation time)

This plan specified a NEW `test/readme-fence-compiler.test.ts`. It was written, and then M70k merged
to `main` carrying `test/package-readme-fence-compiler.test.ts` — the same gate, for the same
reason, deferring the same backlog to M70n. Git saw no conflict (different filenames), but two gates
for one job is the duplication AI_GUIDELINES §11.1 forbids, and M70k's own header warns against
exactly "a second classifier that could disagree with it".

M70i's file was **deleted** and its two READMEs folded into M70k's list, because M70k's is the
better-founded implementation: it reuses the M38 engine's
`extractFences`/`classify`/`assembleSource`, while M70i's re-implemented extraction and
classification over `scanFences`.

**The fold was not merely tidier — it was strictly stronger, and that is measured.** M70i's gate
pinned 1 compilable fence in the gRPC README and 3 in GraphQL; the engine finds **2 and 6**. Four of
the fences M70i's gate never reached **did not compile**, including the `## Options` fence for the
very plugin this milestone repairs. Making them compile needed the engine's own intended mechanisms
rather than any new one: plugin factories go in `FRAGMENT_GLOBALS` **and** `VALUE_EXPORTS` (the
first so a fence whose only unresolved name is the factory classifies `compile-fragment` and gets a
prelude at all; the second so the prelude imports the REAL factory and option checking survives),
types go in `TYPE_EXPORTS`, and illustrative placeholders go in `FRAGMENT_GLOBALS` +
`APP_DECLARATIONS`. `@setu-ts/grpc-plugin` was also missing from the snippet import map.

The guide, decorator and snippet-validation gates all share this engine and were re-run: the guide
gate's pinned inventory is unchanged, so the extension is backward-compatible.

### 3.11 X6-5 — the WebSocket README leads with the form a scaffolded project can use

- **Decision:** `packages/websocket-plugin/README.md` leads with the plugin-based registration — an
  `IPlugin` with `dependencies: [CAPABILITIES.WEBSOCKET]` calling `ws.route(...)` in `register()` —
  and names `setu generate plugin <name>` as the command that emits exactly that seam. The
  post-`start()` form is kept as the standalone-script variant. **No `setu generate ws-route`
  schematic is added.**
- **Why:** the README's only documented path resolves the service after `app.start()`, which a
  CLI-scaffolded `setu.config.ts` structurally cannot do — its own generated JSDoc forbids starting
  the server, and doing it inside `createApp()` throws. The schematic is declined because the seam
  it would land in already exists and is already generated by `g plugin`; a dedicated schematic is a
  CLI feature with its own gating, e2e and hostile-name obligations, and it would be a near-copy of
  the plugin schematic. Naming the existing command closes the "no documented location" half at zero
  new surface.
- **Test home:** the §3.10(b) check covers the README; the plugin-based form itself is already
  exercised by `packages/websocket-plugin`'s integration suite.

## 4. Exported surface — every symbol names its consumer

No package's `src/index.ts` gains or loses a symbol. Three exported **types** change shape, and one
internal constant is added.

| Exported symbol             | Kind     | Consumer / real code path that READS it                                                                                                                                       |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FieldResolver`             | type     | **Changed** (generic). Read by `ResolverMap` / `TypeResolverMap` → `attach-resolvers.ts`, and by every application resolver map. Fixture: `test/types/resolver-typing.ts`.    |
| `DefaultGraphqlContext`     | type     | **Changed** (typed members, `connection` added). Read by `graphql-service.ts:164` and `:213` as the annotation for the context handed to `executeGraphql`/`subscribeGraphql`. |
| `GraphqlSchemaLike`         | type     | **Changed** (`toAST` optional). Read by `GraphqlCodeFirstOptions.schema`, `build-schema.ts`, `attach-resolvers.ts`. Fixture: `test/types/real-graphql-types.ts`.              |
| `GraphqlModuleLike`         | type     | **Changed** (`parse` source widened). Read by `adaptGraphqlModule` and `graphql-loader.ts`.                                                                                   |
| `DEFAULT_BASE_PATH`         | const    | **New, internal — NOT barrel-exported.** Read by `normalizeBasePath`'s default parameter and `grpc-service.ts:82`. Asserted by `test/unit/rpc-dispatcher.test.ts`.            |
| `isNativeGrpcContentType`   | function | **New, internal — NOT barrel-exported.** Read by `dispatchRequest`. Asserted by `test/unit/grpc-binary-refusal.test.ts`.                                                      |
| `trailersOnlyUnimplemented` | function | **New, internal — NOT barrel-exported.** Read by `dispatchRequest`. Asserted by `test/unit/grpc-binary-refusal.test.ts` and the integration suite.                            |

A `barrel-exports.test.ts` already exists in `grpc-plugin` and is extended to pin that the three new
internals do **not** reach `src/index.ts` (the M56 defect class).

### 4.1 Options — every option names its consumer

| Option                       | Consumer                                   | Behavior (per implementation)                                                                                                                     |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GrpcPluginOptions.basePath` | `grpc-service.ts:82` → `normalizeBasePath` | **Default changes `'/grpc'` → `'/'`.** No new option. A non-root value keeps today's behaviour exactly: prefix claim, `404` on an in-prefix miss. |

**No new option is introduced by this milestone.** The §3.3 refusal is deliberately unconditional
rather than opt-in: an option gating it would default to one of the two behaviours anyway, and the
disabled arm would be "produce a response no client can interpret", which nothing should choose.

## 5. Implementation files

| File                                                         | Purpose                                                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/grpc-plugin/src/transports/rpc-dispatcher.ts`      | `DEFAULT_BASE_PATH` constant; `dispatchRequest` consults the native-gRPC refusal before invoking a matched handler.                                       |
| `packages/grpc-plugin/src/transports/grpc-binary-refusal.ts` | **New.** `isNativeGrpcContentType` (exact match, gRPC-Web excluded) and `trailersOnlyUnimplemented`.                                                      |
| `packages/grpc-plugin/src/services/grpc-service.ts`          | Reads `DEFAULT_BASE_PATH` instead of a second `'/grpc'` literal; JSDoc updated for the root default.                                                      |
| `packages/graphql-plugin/src/interfaces/graphql-runtime.ts`  | `toAST?`; `parse(source: unknown)`.                                                                                                                       |
| `packages/graphql-plugin/src/interfaces/options.ts`          | Generic `FieldResolver`/`SubscriptionResolver`; `DefaultGraphqlContext` typed against `common` and declaring `connection`.                                |
| `packages/graphql-plugin/src/services/graphql-service.ts`    | Both context builders annotated `DefaultGraphqlContext`; the `Record<string, unknown>` escape removed.                                                    |
| `packages/graphql-plugin/src/http/graphql-handler.ts`        | One `apqRefusalStatus(mediaType, status)` helper called from the two APQ refusal sites whose status varies; the batch path answers `200` unconditionally. |
| `test/fixtures/snippets/fence-engine.ts`                     | `PACKAGE_READMES` source list beside `GUIDES`; `allFences` parameterized over a file list.                                                                |
| `test/package-readme-fence-compiler.test.ts`                 | The two owned READMEs folded into M70k's engine-based gate (§3.10.1), with pinned counts.                                                                 |
| `test/fixtures/snippets/fence-engine.ts`                     | `GrpcPlugin`/`GraphqlPlugin` as fragment globals + value imports; `ResolverMap`/`GrpcServiceDefinition` type imports; six placeholder declarations.       |
| `test/fixtures/snippets/deno.json`                           | `@setu-ts/grpc-plugin` added to the snippet import map (it was absent).                                                                                   |
| `test/docs-gate.test.ts`                                     | The nonexistent-kernel-API check over package READMEs + `PUBLIC_API.md`.                                                                                  |

**Docs (deliverables, not incidental):** `packages/grpc-plugin/README.md`,
`packages/graphql-plugin/README.md`, `packages/websocket-plugin/README.md`, `PUBLIC_API.md` (§gRPC,
§GraphQL, `createApplication` note), `CHANGELOG.md`, `ROADMAP.md` (row + C1), `CLAUDE.md` (status
entry), `smoke/DEFECTS.md` (nine Status cells).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                              | src covered                              | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grpc-plugin/test/unit/rpc-dispatcher.test.ts` (extend)                | `rpc-dispatcher.ts`                      | `DEFAULT_BASE_PATH === '/'`; `normalizeBasePath()` with no argument returns `''`; a root miss returns `null`, a non-root miss returns `404` (unchanged).                                                                                                                                 |
| `grpc-plugin/test/unit/grpc-binary-refusal.test.ts` **(new)**          | `grpc-binary-refusal.ts`                 | Exact-match table over `application/grpc`, `+proto`, `+json`, with parameters and casing; **`application/grpc-web+proto` and `application/grpc-web+json` are NOT native**; `trailersOnlyUnimplemented()` returns `200` + `grpc-status: 12` + empty body.                                 |
| `grpc-plugin/test/unit/grpc-service.test.ts` (extend)                  | `grpc-service.ts`                        | A stock `GrpcService` claims `/pkg.Svc/Method` and does **not** claim `/products`; an explicit `basePath: '/grpc'` restores prefix claiming.                                                                                                                                             |
| `grpc-plugin/test/integration/grpc-integration.test.ts` (extend)       | dispatch + service, through a kernel app | Stock `GrpcPlugin()` serves an RPC at the bare method path while an ordinary route at `/products` still answers; a native `application/grpc+proto` request is refused Trailers-Only; the same procedure over `application/connect+json` and `application/grpc-web+proto` still succeeds. |
| `grpc-plugin/test/unit/barrel-exports.test.ts` (extend)                | `src/index.ts`                           | The three new internals are absent from the barrel.                                                                                                                                                                                                                                      |
| `graphql-plugin/test/types/real-graphql-types.ts` **(new)**            | `graphql-runtime.ts`                     | Committed fixture, **statically** importing `npm:graphql@^16`: a real `GraphQLSchema` is assignable to `GraphqlSchemaLike`; `adaptGraphqlModule(graphql)` type-checks. Compiled by `deno task check`.                                                                                    |
| `graphql-plugin/test/types/resolver-typing.ts` **(new)**               | `options.ts`                             | Committed fixture: `FieldResolver<IssueRow, DefaultGraphqlContext, { id: string }>` accepts a narrowly annotated function; `ctx.services.get(...)` and `ctx.user?.id` compile with **no cast**.                                                                                          |
| `graphql-plugin/test/unit/graphql-runtime-types.test.ts` **(new)**     | `graphql-runtime.ts`                     | The adapted real module round-trips `parse` on a `string` and on a real `Source`.                                                                                                                                                                                                        |
| `graphql-plugin/test/unit/graphql-handler.test.ts` (extend)            | `graphql-handler.ts`                     | APQ matrix: {batch POST, single POST, GET} × {`application/json` → `200`, `graphql-response` → `400`}, body carrying `PersistedQueryNotFound` in every cell. Both entry points, non-default configuration.                                                                               |
| `graphql-plugin/test/unit/graphql-service.test.ts` (extend)            | `graphql-service.ts`                     | The HTTP context carries `requestContext` and no `connection`; the WS context carries `connection` and omits `requestContext` (property **absent**, not `undefined`).                                                                                                                    |
| `graphql-plugin/test/integration/graphql-ws-context.test.ts` **(new)** | `graphql-service.ts` + ws transport      | One resolver dumping its context keys, driven over HTTP and over a real WS subscription; key sets differ exactly as §3.8 documents.                                                                                                                                                      |
| `test/package-readme-fence-compiler.test.ts` **(extended)**            | `fence-engine.ts` (READMEs)              | Every compilable Setu fence in all five listed READMEs compiles; counts pinned per README (grpc 2, graphql 6). Discrimination: a bogus option name fails with `TS2561 … does not exist in type 'GrpcPluginOptions'`, so the prelude's real import keeps option checking alive.           |
| `test/docs-gate.test.ts` (extend)                                      | —                                        | `new Application(` and `app.use(` appear in no `packages/*/README.md` and not in `PUBLIC_API.md`.                                                                                                                                                                                        |

**External-dependency rule.** `npm:graphql@^16` is the external dep in play; the guarded real-import
test already exists (`graphql-plugin/test/unit/graphql-real-import.test.ts`) and this milestone adds
the **static** type-level fixture it lacked, which is the half that would have caught X6-3.
`@connectrpc/connect` is unchanged by this milestone and keeps its M70e real-import coverage.

**Coverage.** Every `src` file touched must be ≥90% branch/function/line, read from the
ANSI-stripped per-file table. `grpc-binary-refusal.ts` is a new pure module with no I/O and is
expected at **100%**; a shortfall there means a missing row in the exact-match table, not a hard
case.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70i-grpc-graphql-viability, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Both packages change, so both publish gates run on the **committed** tree:

```bash
deno task publish:check
deno task release:verify 0.1.0-alpha.8
```

Plus the checks the four gates structurally cannot make:

```bash
grep -rn "new Function\|eval(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" \
  packages/grpc-plugin/src packages/graphql-plugin/src    # must be empty
grep -rni "trailer" packages/grpc-plugin/README.md         # no forwarding claim survives
```

And the real-client probe §3.3 mandates: `grpcurl -plaintext 127.0.0.1:<port> list` against a stock
`GrpcPlugin()` must now succeed (X7-2 closed), and a native-binary call must report a clean
`Unimplemented` rather than a missing-status protocol error (X7-4 closed as withdrawn).

### 7.1 Negative controls — each observed failing, then reverted

| # | Control                                                               | Must fail                                                                                                               |
| - | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1 | Revert `DEFAULT_BASE_PATH` to `'/grpc'`                               | The stock-plugin integration test; the real `grpcurl list` probe hangs again.                                           |
| 2 | Change §3.3 detection to `contentType.startsWith('application/grpc')` | The gRPC-Web pass-through cases — proving the refusal cannot eat the working format.                                    |
| 3 | Restore the hardcoded `400` at one of the three APQ sites             | Exactly that cell of the matrix — proving all three sites are covered.                                                  |
| 4 | Re-require `toAST` on `GraphqlSchemaLike`                             | `deno task check` on `test/types/real-graphql-types.ts`.                                                                |
| 5 | Reintroduce `new Application()` into the graphql README               | `test/docs-gate.test.ts` **and** `test/package-readme-fence-compiler.test.ts` (both observed).                          |
| 7 | Rename `basePath` to `basePathTypo` in the grpc README Options fence  | `test/package-readme-fence-compiler.test.ts` with `TS2561` (observed) — proves the fold did not weaken option checking. |
| 6 | Populate `requestContext` over WS from the upgrade request            | `graphql-ws-context.test.ts` — pinning the decision apart from the alternative.                                         |

## 8. Risks & mitigations

- **The `basePath` default change breaks existing Connect clients.** An application on
  `GrpcPlugin()` today has its clients pointed at `/grpc`; after the bump they must drop the prefix
  or pin `basePath: '/grpc'`. → CHANGELOG migration text naming both routes, and the pin is a
  one-line change that restores today's behaviour exactly.
- **The Trailers-Only refusal may not satisfy a conformant client.** → §3.3's real-`grpcurl` probe
  is a mandated deliverable, not a note; a negative result is recorded in this plan and the PR body
  rather than papered over.
- **Widening `GraphqlModuleLike.parse` to `unknown` loses a compile-time signal** for callers
  passing a wrong source. → The parameter was already wrong for the only real implementation; the
  new static fixture is a stronger signal than the old too-narrow annotation, which rejected the
  real module outright.
- **Typing `DefaultGraphqlContext.requestContext` optional could break a consumer.** → It was
  `unknown`, so no consumer could dereference it without a cast; a cast still compiles. CHANGELOG
  entry regardless.
- **Extending the fence engine could destabilize the guide gate.** → The two READMEs go in a
  **separate** test file over a separate source list, so a README failure cannot be confused with a
  guide failure and the guide inventory is untouched.
- **The two packages' suites include real-socket e2e tests that assume the `/grpc` prefix.** → The
  prefix-assuming tests are updated to pass `basePath: '/grpc'` explicitly rather than deleted, so
  the non-root path keeps its coverage (M55's deleted-coverage lesson).

## 9. Out of scope

- **A trailer-capable serve path** — the only change that could make native `application/grpc` work.
  It is a `packages/runtime` non-fetch serve path and a reversal of M23; unowned, and named here
  rather than assigned to a letter so it is not mistaken for deferred work.
- **X7-3, X6-1, X7-6, X7-7, X7-5, X7-8** — closed by M70e, M70a, M70a, M70a, M70f, M70c
  respectively.
- **X7-9** — `resilience-plugin` docs, **M70n**.
- **The fence gate over all package READMEs and `PUBLIC_API.md` in full** — **M70n**; §3.10 ships
  the two owned READMEs deep and the X6-2 class shallow-but-repo-wide.
- **`setu generate ws-route`** — declined in §3.11 with reason; if it is ever wanted it is a CLI
  milestone with gating, e2e and hostile-name obligations.
- **A gRPC service schematic / `protoc-gen-es` wiring** — the register's "Friction, already known"
  note; unowned CLI work.
- **`setu add` for gRPC's npm peers** — D3, shipped in **M70h**.

## 9. Implementation deviations — plan claims corrected by measurement

Recorded during the fix-finding pass that completed §3.1–§3.11. Each is a plan claim the
implementation measured false; the code and tests follow the MEASUREMENT.

1. **§3.9, batch × `graphql-response` matrix cell is unreachable for APQ** (measured). Under
   `application/graphql-response+json` a batch body is refused `400 BATCHING_NOT_SUPPORTED`
   (graphql-handler.ts:126) BEFORE per-element APQ resolution runs, so no APQ refusal can ever
   surface in that cell. The test asserts the measured behavior (`BATCHING_NOT_SUPPORTED`, not an
   APQ status) and this section records why. The other five cells behave exactly as specified.
2. **§3.9's "three sites" were three sites with two behaviors**: the GET site already used
   `apqResult.status` verbatim under BOTH media types. The unified `apqRefusalStatus` helper now
   decides all three; under `application/json` every APQ refusal is `200` (the watershed), which is
   a behavior change from the two hardcoded `400`s — existing tests asserting `400` were updated.
3. **§3.7's fixture cannot assign a narrow resolver to a bare-typed map entry** (measured).
   `TypeResolverMap` names the bare `FieldResolver` (§4 lists it as unchanged), and under
   `strictFunctionTypes` a narrow resolver does NOT assign to a bare-typed slot. The fixture
   (`test/types/resolver-typing.ts`) therefore demonstrates the assignment against a generically
   typed map entry — the shape a real application writes — and separately pins that the legacy
   all-`unknown` resolver still assigns to the bare type.
4. **§3.3's Connect/gRPC-Web integration test needed protocol-correct requests** (measured). Connect
   unary over `application/connect+json` requires a `Connect-Protocol-Version` header (absent →
   415); gRPC-Web requires 5-byte envelope framing, not raw JSON. The test uses `application/json`
   for the Connect leg (a real Connect unary content type) and envelope-framed `grpc-web+json` for
   the gRPC-Web leg, reading the first envelope via its length prefix.
5. **§3.10(b) scans code fences only**, not whole files: the corrected READMEs deliberately NAME
   `new Application()` / `app.use()` in prose ("there is no … API"), which is the correction, not
   the defect. Fence-scoped matching keeps the gate exact while still catching any fence that uses
   the nonexistent API. Negative control observed: reintroducing `new Application()` into the
   graphql README's Usage fence fails the gate; reverted, it passes.
6. **DOC_LINT_BASELINE ratcheted 764 → 760**: the widened facades and new modules replaced four
   further diagnostics beyond the X6-3 drop recorded in §3.6.
7. **§3.11 websocket README**: the plugin-based form leads, naming `setu generate plugin <name>`;
   the post-`start()` form is kept as the standalone-script variant, per the decision. No schematic
   added.
