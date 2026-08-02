# Milestone 51 — GraphQL Plugin (`@hono-enterprise/graphql-plugin`)

> **Status:** Planning. Branch: `feat/m51-graphql-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

GraphQL is the last mainstream API paradigm the framework cannot serve. REST rides the kernel
router, gRPC/Connect rides the M49 adapter seam, real-time rides M43/M46 — but a GraphQL request has
no home at all: `README.md:179` still lists it as `🚧 Planned` and `ARCHITECTURE.md:2519` still
lists it under "Future Additions". This milestone ships `@hono-enterprise/graphql-plugin`,
registering an `IGraphqlService` under a new `CAPABILITIES.GRAPHQL = 'graphql'` token, serving a
spec-compliant GraphQL-over-HTTP endpoint on the ordinary kernel router, with both schema-first
(SDL + resolver map) and code-first (application-built `GraphQLSchema`) schema construction.

**The structural point that separates this milestone from M46 and M49: GraphQL needs no adapter
seam.** M46 widened `IHttpAdapter` with `setUpgradeRouter?` because an RFC 6455 handshake needs the
native `Request` and answers with a 101 carrying a socket. M49 widened it with `setRpcHandler?`
because a gRPC exchange needs a raw streaming body and trailers. A GraphQL-over-HTTP exchange is a
`POST` of `application/json` answered with JSON — every byte of it fits `IRequest.json()` and
`IResponse.send()` as committed. So this plugin registers two ordinary routes and touches no
adapter, no widening of `IHttpAdapter`, and no runtime code. That is a deliverable in itself: the
ARCHITECTURE note added in §2/C2 says so explicitly, so the next reader does not copy the M46/M49
seam by pattern-matching.

- **In scope:** the plugin factory and `GraphqlService`; the new `GRAPHQL` capability token and the
  `common` service contract; schema-first construction (SDL + resolver map, with resolvers attached
  by an internal `attachResolvers`); code-first construction (the application hands over a built
  schema); the GraphQL-over-HTTP transport on `POST`/`GET` including media-type negotiation and the
  spec's status-code watershed; a bounded parse+validate document cache; security defaults (internal
  error masking, query-depth limit, introspection switch); the request context handed to resolvers;
  a GraphiQL page mirroring the M21 Swagger UI precedent; a `graphql` health indicator; the
  `npm:graphql@^16` inject-or-lazy runtime seam.
- **NOT this milestone:** subscriptions over any transport — **M51b** owns both the
  `graphql-transport-ws` protocol over `CAPABILITIES.WEBSOCKET` and the GraphQL-over-SSE transport
  over M42 `IResponse.stream()`. Request batching, Automatic Persisted Queries and a federation
  gateway are also M51b. Client-side GraphQL belongs to `@hono-enterprise/sdk` (M35), not here. See
  §9 for the full list and for the behaviour a subscription operation gets over HTTP in the
  meantime, which is a tested 400 rather than silence.

## 1. Contracts verified from SOURCE (not names)

Every row was checked by opening the file, and every `npm:graphql` row was checked by **running**
the real package (`graphql@16.14.2`, resolved fresh from the registry during planning), not by
recalling its API.

| Reference                      | Source (file:line)                                                                       | Verified surface / fact                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES`                 | `packages/common/src/tokens.ts:41-140`                                                   | 45 tokens, last added `GRPC: 'grpc'`. **No `GRAPHQL` token exists** — this milestone adds one. `createCapabilityToken` (`tokens.ts:167`) enforces lowercase kebab-case with dot namespacing; `'graphql'` is a single legal segment under `TOKEN_SEGMENT:150`.                                  |
| `IRequest`                     | `packages/common/src/http.ts:33-85`                                                      | `method`, `url`, `path`, `headers: Headers`, `ip?`, `user?: IPrincipal`, `tenant?: ITenant`, `signal?`, `json<T>()`, `text()`, `bytes()`. `json()` is documented to throw `SyntaxError` on a malformed body — the 400 branch in §3.4 hangs off exactly that.                                   |
| `IResponse`                    | `packages/common/src/http.ts:100-197`                                                    | `status`, `header`, `appendHeader`, `json`, `text`, `send(body?: Uint8Array)`, `redirect`, `stream`, `snapshot`. No trailer surface and no raw body — which is why M49 needed a seam and this milestone does not.                                                                              |
| `ResponseBuilder` content-type | `packages/kernel/src/context/response.ts:38-56`                                          | `json()` **overwrites** `content-type` with `application/json; charset=utf-8` and `text()` with `text/plain`; `send()` sets `application/octet-stream` **only when the header is absent** (`response.ts:54`). This is what makes §3.5's `header()`+`send()` work.                              |
| `IRequestContext`              | `packages/common/src/http.ts:205-234`                                                    | `id`, `request`, `response`, `services`, `params`, `query`, `state`, `startTime` (monotonic), `signal`. `query` is the pre-parsed `Readonly<Record<string,string>>` the GET transport reads.                                                                                                   |
| `IRouterApi`                   | `packages/common/src/plugin.ts:74-141`                                                   | `get`/`post`/`put`/`patch`/`delete`/`head`/`options`/`group`/`listRoutes`. A plugin registers plain routes; nothing else is needed to serve GraphQL.                                                                                                                                           |
| `IPluginContext`               | `packages/common/src/plugin.ts:456-495`                                                  | `services`, `middleware`, `router`, `environment`, `health`, `metrics`, `openapi`, `decorators`, `cli`, `lifecycle`, `runtime` (non-optional), `config?`, `logger?`, `metadata?`, `container?`, `options`, `app`.                                                                              |
| `IPlugin.register`             | `packages/common/src/plugin.ts:545`                                                      | Returns a `void`-or-`Promise<void>` union — the kernel awaits it, so the lazy `import()` in §3.1 is legal (M31/M49 precedent).                                                                                                                                                                 |
| `PLUGIN_PRIORITY`              | `packages/common/src/types.ts:80-93`                                                     | `HIGHEST:0`, `HIGH:100`, `NORMAL:500`, `OPENAPI:700`, `LOW:900`, `LOWEST:1000`. This plugin takes `NORMAL`, as `GrpcPlugin` does.                                                                                                                                                              |
| `HealthIndicatorFn`            | `packages/common/src/services/health.ts:26`                                              | `() => Promise<HealthCheckResult>`; registered through `ctx.health.register(name, fn)` (`plugin.ts:192`).                                                                                                                                                                                      |
| `IWebSocketService.route`      | `packages/common/src/services/websocket.ts:351-375`                                      | `route(path, handlers, options?)` with `WebSocketRouteOptions.protocols` (`websocket.ts:318-326`). **Verified for M51b, not used in M51** — it confirms the subscription deferral has a real landing site and needs no further widening.                                                       |
| `GrpcPlugin` shape             | `packages/grpc-plugin/src/plugin/grpc-plugin.ts:36-91`                                   | `async register`, `optionalDependencies: ['logger', CAPABILITIES.HEALTH]`, `provides`, service registration, health indicator, `onClose`. This milestone copies the shape, not the seam.                                                                                                       |
| `loadConnectModule`            | `packages/grpc-plugin/src/transports/connect-loader.ts`                                  | The committed inject-or-lazy split: a PURE `adaptConnectModule(modules)` plus a `loadConnectModule(importer = defaultImporter)` whose default is a real `import(specifier)`. §3.1 reproduces this split exactly.                                                                               |
| Swagger UI serving             | `packages/openapi-plugin/src/ui/swagger-ui.ts:34-50`, `plugin/openapi-plugin.ts:117-129` | An HTML string referencing `unpkg.com` assets, served on a `GET` route, default **on** (`swagger = true`, `openapi-plugin.ts:69`). This is the precedent GraphiQL follows in §3.6.                                                                                                             |
| `npm:graphql` version          | registry probe                                                                           | `^16` resolves to **16.14.2**. `graphql@17` is not pinned: its incremental-delivery and `subscribe` changes are a separate migration.                                                                                                                                                          |
| `graphql` exports              | probe of `npm:graphql@^16`                                                               | `parse`, `validate`, `execute`, `subscribe`, `buildSchema`, `specifiedRules` (27 rules), `getOperationAST`, `GraphQLError`, `validateSchema`, `printSchema`, `createSourceEventStream`, `GraphQLSchema`, `NoSchemaIntrospectionCustomRule` are all present.                                    |
| Resolver attachment works      | probe                                                                                    | Mutating `schema.getQueryType().getFields().hello.resolve = fn` on a `buildSchema()` result and executing returns `{"data":{"hello":"hi bob …"}}`. This is what makes an internal `attachResolvers` viable with **zero** `@graphql-tools/schema` dependency.                                   |
| `execute` signature            | probe                                                                                    | Single-object form `execute({ schema, document, variableValues, contextValue, operationName, rootValue })` — v16 accepts no positional form.                                                                                                                                                   |
| Error serialization            | probe                                                                                    | `JSON.stringify(result)` renders errors as `{message, locations, path, extensions}` via `GraphQLError.toJSON()`. No hand-rolled formatter is needed for the wire shape.                                                                                                                        |
| Masking discriminator          | probe                                                                                    | A resolver throwing `new Error('plain')` yields `extensions: {}` with `originalError: Error`; `new GraphQLError('coded', {extensions:{code:…}})` yields `extensions.code` preserved; a **validation** error yields `originalError: undefined`. §3.7 keys off exactly these three observations. |
| `getOperationAST`              | probe                                                                                    | Returns the operation node for a single-operation document, and **`null`** for a two-operation document with no `operationName`. The 400 branch in §3.4 hangs off that `null`.                                                                                                                 |
| Custom validation rules        | probe                                                                                    | `validate(schema, doc, [...specifiedRules, myRule])` runs a hand-written rule; a depth rule counting `SelectionSet` ancestors reported `too deep (3)` on a 3-deep document and nothing on a 1-deep one. `NoSchemaIntrospectionCustomRule` blocks `__schema`.                                   |
| `subscribe` over a query       | probe                                                                                    | Returns a plain `ExecutionResult` (no `Symbol.asyncIterator`) rather than throwing. Recorded for M51b; M51 never calls it.                                                                                                                                                                     |
| **Cross-copy hazard**          | probe                                                                                    | A schema built with `graphql@16.8.1` executed by `graphql@16.14.2` throws `Error: Cannot use GraphQLSchema "…" from another module or realm`. This is the single largest integration risk and drives the `graphqlModule` option in §3.1.                                                       |
| **`process.env` at import**    | probe + `graphql/16.14.2/jsutils/instanceOf.js:13`                                       | Importing `graphql` reads `process.env.NODE_ENV` at module scope. Under Deno the import fails without `--allow-env`; on Cloudflare Workers it requires the `nodejs_compat` flag. Drives the manifest permissions and the portability statement in §3.10.                                       |
| README package counts          | `README.md:22-25`, `README.md:219`, `README.md:321`                                      | Line 22 says 38 published and "the workspace has since grown to 43 packages; the five added after that release ship with the next one", while lines 219 and 321 both assert **all 43 are published**. A pre-existing self-contradiction — see C4.                                              |
| ROADMAP milestone list         | `ROADMAP.md:4901` (M50), `ROADMAP.md:5145-5211`                                          | The highest milestone section is 50 and the Progress Tracking table's last row is `50`. **No M51 section and no `51` row exist** — both are deliverables here (the M36b defect class).                                                                                                         |
| PUBLIC_API GraphQL section     | `PUBLIC_API.md` (grep)                                                                   | The string `graphql` does not appear anywhere in the file. The whole section is new surface, not an edit.                                                                                                                                                                                      |
| Archive naming recommendation  | `plans/archive/architecture-review.md:1165,1237`                                         | The 2024 architecture review proposed the package name `@hono-enterprise/graphql`. AI_GUIDELINES §3.6 mandates `-plugin` for capability packages — see C5.                                                                                                                                     |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                  | Resolution (picked side)                                                                                                                                                                                                                                                      | Doc deliverable (same PR)                                                                                                                                                                                                                   |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md` has no M51 section and no `51` Progress row, while this milestone is being implemented. Identical to the M36b defect, which shipped with neither.                                            | The ROADMAP is the milestone register; a milestone without a section there is unreviewable.                                                                                                                                                                                   | Add `## Milestone 51: GraphQL Plugin` after the M50 section (scope, files, deliverables, out-of-scope), and a `\| 51 \| ✅ \| graphql-plugin \|` Progress row.                                                                              |
| C2 | `ARCHITECTURE.md:2435` puts `GraphQL[GraphQL Plugin]` in the mermaid **Future** subgraph and `:2519` lists "GraphQL Plugin — New plugin that registers GraphQL routes and schema" under Future Additions. | GraphQL is no longer future. Beyond deleting the rows, the note must state the **negative** result — no `IHttpAdapter` widening — because the two neighbouring notes (WebSocket, gRPC) both describe adapter seams and a reader will otherwise assume a third.                | Remove the `GraphQL` mermaid node and its `Kernel --> GraphQL` edge; delete the Future Additions row; add a "The **GraphQL Plugin** shipped in Milestone 51" note beside the WebSocket and gRPC notes stating it rides the ordinary router. |
| C3 | `README.md:179` lists GraphQL under **"Not yet built"** with `🚧 Planned`, in a table whose only other row (`gRPC`) is already `✅` — so the table's own heading is false for both rows.                  | Move GraphQL into the feature table where the plugins live and delete the now-empty "Not yet built" table together with its heading, rather than leaving a section that contains only shipped work.                                                                           | Move the GraphQL row into the plugin feature table as `✅ graphql-plugin`; move the `gRPC` row with it; delete the `### Not yet built` heading and table.                                                                                   |
| C4 | `README.md:22-25` says 38 published and 43 in the workspace, while `README.md:219` and `README.md:321` both claim **all 43 packages are published**. A pre-existing contradiction, widened by M51.        | Line 22 is the accurate one (M48–M50 have not been published). Lines 219 and 321 are corrected to say what is published versus what is in the workspace, so a reader does not `deno add` a package that is not on JSR.                                                        | Update all three sites to 44 workspace members / 34 plugins, and rewrite 219 and 321 to "38 published in `v0.1.0-alpha.3`; six more ship with the next release".                                                                            |
| C5 | `plans/archive/architecture-review.md:1165,1237` proposes the package name `@hono-enterprise/graphql`; AI_GUIDELINES §3.6 mandates `@hono-enterprise/[name]-plugin` for capability packages.              | §3.6 wins: the package is `@hono-enterprise/graphql-plugin`, plugin `name` `'graphql-plugin'`, matching all 33 existing plugins. The archive is a historical record of a past review and is **not** amended — correcting it would rewrite history rather than fix a live doc. | None. Recorded here so the discrepancy is a decision rather than an oversight.                                                                                                                                                              |
| C6 | `PUBLIC_API.md` documents no GraphQL surface at all, and AI_GUIDELINES §10.5 requires every `index.ts` export to appear there.                                                                            | The section is written from §4 of this plan, including the `common` widening (token, contract types) and every plugin export.                                                                                                                                                 | Add a "GraphQL" section to `PUBLIC_API.md` (Options / Exports / Notes, matching the Feature Flags and Notifications sections), plus the `GRAPHQL` row in the capability-token table.                                                        |

## 3. Design decisions

### 3.1 `graphql` runtime access — inject-or-lazy, with injection as the documented default

- **Decision:** an internal `GraphqlRuntime` port (`src/interfaces/graphql-runtime.ts`) is produced
  by a pure `adaptGraphqlModule(module: GraphqlModuleLike): GraphqlRuntime` and by an impure
  `loadGraphqlModule(importer = defaultImporter)` whose default performs a real
  `import('npm:graphql@^16')`. `GraphqlPluginOptions.graphqlModule` short-circuits the load. A
  failed import throws the exported `GraphqlRuntimeLoadError`, naming the specifier and the
  `deno add npm:graphql@^16` command. There is no global hook and no no-op fallback runtime.
- **Why:** AI_GUIDELINES §12.2, and the M49 `connect-loader.ts` split is the committed shape. The
  pure/impure split is what makes every branch unit-testable while the one real `import()` sits
  behind a guarded test. **Injection is not merely an optimisation here**: a schema built by the
  application's own `graphql` copy and executed by a second copy throws
  `Cannot use GraphQLSchema … from another module or realm` (§1, verified). Any application using
  the code-first arm already imports `graphql` itself, so the README and the JSDoc tell it to pass
  that module through `graphqlModule`, and the schema-first arm avoids the hazard entirely because
  the plugin builds the schema with the same copy it executes with.
- **Test home:** `test/unit/graphql-loader.test.ts` (pure adapter over a fake module bundle; the
  failing-specifier branch through an injected importer that rejects) and
  `test/unit/graphql-real-import.test.ts` (guarded real `import()`).

### 3.2 Schema construction — two arms, one internal schema, no `@graphql-tools/schema`

- **Decision:** `GraphqlPluginOptions` is a union of two arms with mutually exclusive keys, each arm
  declaring the other's key as `?: never` so supplying both is a compile error:
  - **code-first** — `{ schema: GraphqlSchemaLike; typeDefs?: never; resolvers?: never }`; the
    application builds a `GraphQLSchema` however it likes (hand-built types, Pothos, Nexus) and the
    plugin uses it as-is.
  - **schema-first** — `{ typeDefs: string; resolvers: ResolverMap; schema?: never }`; the plugin
    calls `runtime.buildSchema(typeDefs)` and then the internal `attachResolvers(schema, resolvers)`
    assigns `field.resolve` per named field and `type.resolveType` for `__resolveType`.

  `attachResolvers` **throws** `GraphqlSchemaError` when the resolver map names a type absent from
  the schema, a field absent from that type, or a scalar type (custom scalar resolvers are not
  supported in M51 — see §9). After construction, both arms run `runtime.validateSchema(schema)` and
  throw `GraphqlSchemaError` listing the schema errors, so an invalid schema fails at `register()`
  and never at the first request.
- **Why:** `makeExecutableSchema` from `@graphql-tools/schema` would be a second npm dependency for
  roughly 120 lines of field-map walking that the probe in §1 proved works by direct mutation. The
  throw-on-unknown-name behaviour is the part that matters: a silently ignored resolver typo is the
  classic GraphQL footgun, and returning `null` for a field whose resolver was never attached is
  indistinguishable from a legitimate `null` at the wire.
- **Test home:** `test/unit/attach-resolvers.test.ts` (attaches, `__resolveType`, and all three
  throws) and `test/unit/build-schema.test.ts` (both arms produce an executable schema; invalid SDL
  and a schema failing `validateSchema` throw).

### 3.3 The `common` widening — a new token and a transport-independent service contract

- **Decision:** `common` gains `CAPABILITIES.GRAPHQL = 'graphql'` and
  `packages/common/src/services/graphql.ts` exporting `GraphqlRequestParams`,
  `GraphqlFormattedError`, `GraphqlExecutionResult`, `GraphqlExecutionOutcome` and `IGraphqlService`
  (§4). Every type is structural and zero-dependency; `common` never sees a `graphql` type, so its
  no-dependency rule (§2.1) holds. `IGraphqlService.execute(params, requestContext?)` is the single
  execution entry point — the HTTP route handler calls it, application code calls it, and M51b's
  subscription transports will call it.
- **Why:** the token/interface binding rule requires the service resolved from
  `CAPABILITIES.GRAPHQL` to be typed as a contract in `common`, exactly as `IGrpcService` and
  `IWebSocketService` are. And "one capability, one implementation" requires that the two entry
  points cannot drift: the route handler owns HTTP concerns (media type, method, status) and nothing
  else, delegating every parse/validate/execute/mask step to `execute()`.
- **Test home:** `test/integration/graphql-integration.test.ts` drives `execute()` directly and the
  HTTP route with the **same** non-default configuration (`maskInternalErrors: false`, custom
  `buildContext`) and asserts identical `result` payloads.

### 3.4 HTTP transport — the GraphQL-over-HTTP request rules

- **Decision:** the plugin registers exactly two routes, `POST path` and `GET path` (default
  `/graphql`). Request handling is a fixed decision table, and every row has a test:

  | Condition                                                                                    | Outcome                                                                          |
  | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
  | `POST` with a `content-type` that is not `application/json`                                  | `415`, body `{errors:[{message:…, extensions:{code:'UNSUPPORTED_MEDIA_TYPE'}}]}` |
  | `POST` whose body is not valid JSON (`IRequest.json()` throws)                               | `400`, code `'INVALID_JSON'`                                                     |
  | `POST` body that is not an object, or whose `query` is not a string                          | `400`, code `'BAD_REQUEST'`                                                      |
  | `POST` `variables` present and not an object                                                 | `400`, code `'BAD_REQUEST'`                                                      |
  | `GET` with no `query` param and an `Accept` including `text/html`                            | the GraphiQL page (§3.6)                                                         |
  | `GET` with no `query` param and no `text/html` in `Accept`                                   | `400`, code `'BAD_REQUEST'`                                                      |
  | `GET` whose `variables` param is not valid JSON                                              | `400`, code `'INVALID_VARIABLES'`                                                |
  | `GET` carrying a `mutation` operation                                                        | `405` with `Allow: POST`, code `'METHOD_NOT_ALLOWED'`                            |
  | any method carrying a `subscription` operation                                               | `400`, code `'SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP'` (§9)                       |
  | a document with several operations and no `operationName` (`getOperationAST` returns `null`) | `400`, code `'OPERATION_RESOLUTION_FAILED'`                                      |
  | parse failure                                                                                | `400` with the `GraphQLError` locations preserved                                |
  | validation failure                                                                           | `400` with every validation error                                                |
  | execution succeeded, field errors present                                                    | `200` — a field error is not a request error                                     |

  The operation kind is resolved with `getOperationAST(document, operationName ?? undefined)`
  **after** parse and **before** validate, so the `405` and the subscription refusal are decided
  without paying for validation.
- **Why:** these are the GraphQL-over-HTTP rules, and each row is a real interoperability
  requirement rather than defensive coding: Apollo Client and urql both issue `GET` for queries when
  configured to, and both rely on the mutation refusal being `405`. The `null` from
  `getOperationAST` was verified in §1 rather than assumed.
- **Test home:** `test/unit/request-parser.test.ts` for the parse rows and
  `test/e2e/graphql-http-e2e.test.ts` for the status rows, driven through a real kernel app.

### 3.5 Media-type negotiation and the status-code watershed

- **Decision:** `negotiateMediaType(accept: string | null)` returns `'graphql-response'` when the
  `Accept` header contains `application/graphql-response+json`, and `'json'` otherwise (including an
  absent header). With `'graphql-response'`, the response carries
  `Content-Type: application/graphql-response+json; charset=utf-8` and the status codes of the table
  in §3.4. With `'json'`, the response carries `Content-Type: application/json; charset=utf-8` and
  **every well-formed GraphQL request answers `200`**, errors included; only the pre-GraphQL
  failures (415, malformed JSON, the `405` on a GET mutation) keep their HTTP status. Both paths
  write the body with `ctx.response.status(s).header('Content-Type', ct)` followed by
  `send(encoder.encode(json))` — never `json()`, which overwrites `content-type` (`response.ts:40`,
  verified) — and `send()` preserves a pre-set header (`response.ts:54`, verified).
- **Why:** the watershed is the spec's own compatibility mechanism: clients predating
  `application/graphql-response+json` treat a non-200 as a transport failure and never read the
  `errors` array, so answering `400` to them turns a field-level error into an opaque network error.
  Answering `200` to a client that _did_ ask for the new media type is equally wrong. Negotiation is
  the only correct behaviour, and it is one function.
- **Test home:** `test/unit/media-type.test.ts` (the pure negotiation function, including `*/*`, a
  missing header, and a multi-value `Accept`) and two e2e cases asserting the same failing query
  yields `400` under one `Accept` and `200` under the other, with the matching `Content-Type`.

### 3.6 GraphiQL — mirroring the Swagger UI precedent exactly

- **Decision:** `graphiqlHtml({ endpoint, title })` returns a self-contained HTML string loading
  GraphiQL from `unpkg.com`, served on the **same** `GET path` route, taken only when the request
  carries no `query` parameter and its `Accept` includes `text/html`. The `graphiql` option defaults
  to `true`; when `false` that branch is not taken and such a request gets the `400` of §3.4.
- **Why:** M21 already serves Swagger UI from `unpkg` with `swagger` defaulting to `true`
  (`openapi-plugin.ts:69`), so a different posture here would be inconsistent rather than safer. The
  no-`query`-plus-`text/html` condition is unambiguous: a real GraphQL `GET` always carries `query`,
  and a browser address bar always sends `text/html`, so the two never collide.
- **Test home:** `test/unit/graphiql.test.ts` (the endpoint is interpolated and HTML-escaped into
  the page) and an e2e case asserting `text/html` on the browser request and `400` for the same
  request with `graphiql: false`.

### 3.7 Error masking — an explicit exposure predicate, not `instanceof`

- **Decision:** `isExposable(error)` returns `true` when the error carries **no** `originalError` (a
  request error raised by `graphql` itself: parse, validate, coercion) or when a `code` string is
  present in `error.extensions`. Everything else is replaced by
  `{ message: 'Internal server error', path, extensions: { code: 'INTERNAL_SERVER_ERROR' } }` and
  the original is logged through `ctx.logger?.error`. `maskInternalErrors` defaults to `true` and
  turns the replacement off when `false`. A `formatError` option, when supplied, maps every
  already-masked error last, so it can add fields without being able to un-mask by accident.
- **Why:** every part of this was verified rather than assumed (§1): a plain `Error` from a resolver
  surfaces with `extensions: {}` and `originalError: Error`, a `GraphQLError` carrying
  `extensions.code` keeps that code, and a validation error has no `originalError` at all. Using
  `instanceof GraphQLError` instead would be the one check guaranteed to misfire in this codebase,
  because the cross-copy scenario of §3.1 is exactly a `GraphQLError` from another realm. The
  consequence is documented rather than hidden: a resolver throwing a bare `new GraphQLError('x')`
  **is** masked, and the way to surface a message to clients is to attach a code.
- **Test home:** `test/unit/mask-errors.test.ts` — all three shapes from the probe, plus
  `maskInternalErrors: false`, plus a `formatError` that runs after masking.

### 3.8 Query-depth limiting and introspection

- **Decision:** `createDepthLimitRule(maxDepth)` is a hand-written validation rule counting
  `SelectionSet` ancestors at each `Field` node and reporting a `GraphQLError` past the limit.
  `maxDepth` defaults to `10`; `0` disables the rule. When `introspection` is `false`, the runtime's
  `NoSchemaIntrospectionCustomRule` is appended. Extra application rules arrive through
  `validationRules` and are appended last. The final rule list is assembled **once** at `register()`
  and reused for every request.
- **Why:** an unbounded recursive schema (`user { friends { user { friends … } } }`) is a
  single-request denial of service, so a default limit is the secure default AI_GUIDELINES §13.4
  asks for, and `10` is beyond any hand-written query while stopping the pathological ones.
  Introspection defaults to **`true`**, deliberately: it is not a security boundary (field
  suggestions leak the schema regardless), and disabling it by default breaks every client tool on
  first contact. §14 forbids per-request work, hence assembling the list at registration.
- **Test home:** `test/unit/depth-limit.test.ts` (a passing document, a failing one, `0` disabling)
  and `test/unit/executor.test.ts` (`introspection: false` blocks `__schema`; `validationRules`
  entries run).

### 3.9 Document cache — internal, bounded, and never the `cache` capability

- **Decision:** an internal `DocumentCache` keyed on the raw query string, holding the parsed
  document together with its validation errors, with LRU eviction implemented by `Map` delete-then-
  reinsert. `documentCacheSize` defaults to `1000`; `0` disables caching. `onClose` clears it.
- **Why:** parsing and validating are the expensive half of a small GraphQL request and the same
  documents repeat, so this is the §14.1/§14.2 hoist. It is explicitly **not** `CAPABILITIES.CACHE`:
  that surface is `async` and possibly remote, while an AST is neither serializable nor worth a
  network hop. Caching the validation result alongside the document is sound because the rule list
  is fixed at registration (§3.8).
- **Test home:** `test/unit/document-cache.test.ts` (hit, miss, LRU eviction order, `0` disabling,
  clear) plus an executor test asserting the runtime's `parse` is called once across two identical
  requests.

### 3.10 Resolver context, and what runs where

- **Decision:** the default `contextValue` is `{ services, requestContext, user, tenant }` —
  `services` from `IRequestContext.services` (or the application registry when `execute()` is called
  with no request), `user` from `request.user`, `tenant` from `request.tenant`.
  `buildContext(input)` replaces it wholesale when supplied, receiving `{ services, request? }`.
  `rootValue` passes straight through to `execute`. The plugin declares
  `optionalDependencies: ['logger', CAPABILITIES.HEALTH]` and no hard dependency, so it registers in
  an application with neither.
- **Why:** resolvers need the service registry to reach every other capability, and reading `user`
  and `tenant` off `IRequest` (`http.ts:48,53`) is how the auth and multi-tenancy middleware already
  publish them — the GraphQL plugin does no authentication of its own and imports no plugin.
  Portability follows from the same decision: everything here is web-standard, so the only platform
  constraint is `graphql` itself reading `process.env.NODE_ENV` at import
  (`jsutils/instanceOf.js:13`, verified), which means `--allow-env` under Deno and the
  `nodejs_compat` flag on Cloudflare Workers. Both are documented in the README rather than papered
  over, and the package manifest sets `test.permissions.env`.
- **Test home:** `test/unit/graphql-service.test.ts` (default context carries the four members; a
  resolver reads `user` set on the request; `buildContext` replaces the default) and
  `test/integration/graphql-integration.test.ts` (a resolver resolves another capability from
  `services`).

## 4. Exported surface — every symbol names its consumer

### 4.1 `@hono-enterprise/common` (flagged widening)

| Exported symbol           | Kind      | Consumer / real code path that READS it                                                                                      |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.GRAPHQL`    | token     | `GraphqlPlugin.provides` and `ctx.services.register`; applications resolving the service; the M51b subscription transports.  |
| `IGraphqlService`         | interface | The type of the registered service; the HTTP route handler holds one; applications resolve one.                              |
| `GraphqlRequestParams`    | interface | Produced by `request-parser.ts`, consumed by `GraphqlService.execute`.                                                       |
| `GraphqlFormattedError`   | interface | Produced by `mask-errors.ts`, serialized by the route handler.                                                               |
| `GraphqlExecutionResult`  | interface | The `result` member of the outcome; serialized to the wire.                                                                  |
| `GraphqlExecutionOutcome` | interface | Returned by `execute()`; the route handler reads `.status` to choose the HTTP status under `'graphql-response'` negotiation. |

`GraphqlRequestParams` deliberately has **no `extensions` member**. The GraphQL-over-HTTP spec
defines one, but nothing in M51 reads it (it exists for Automatic Persisted Queries, deferred to
M51b), and an unread field is dead surface by the checklist's own rule. The parser ignores the key
and the JSDoc says so; M51b adds the member together with the code that reads it.

### 4.2 `@hono-enterprise/graphql-plugin`

| Exported symbol           | Kind      | Consumer / real code path that READS it                                                                                                |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GraphqlPlugin`           | factory   | The application's plugin list; the starters gain no arm in this milestone (see §9).                                                    |
| `GraphqlService`          | class     | Instantiated by the plugin; exported so an application can construct one against an injected runtime for testing, as `GrpcService` is. |
| `adaptGraphqlModule`      | function  | Called by `loadGraphqlModule`; exported so an application already bundling `graphql` adapts its own module (the §3.1 hazard).          |
| `graphiqlHtml`            | function  | Called by the plugin when `graphiql` is on; exported so an application can serve the page on its own route.                            |
| `createDepthLimitRule`    | function  | Assembled into the rule list by the plugin; exported so an application can reuse it inside its own `validationRules`.                  |
| `GraphqlSchemaError`      | class     | Thrown by `build-schema.ts` and `attach-resolvers.ts`; caught by application startup code with `instanceof`.                           |
| `GraphqlRuntimeLoadError` | class     | Thrown by `loadGraphqlModule`; names the specifier and the install command.                                                            |
| `GraphqlPluginOptions`    | type      | The plugin factory's parameter (the two-arm union of §3.2).                                                                            |
| `ResolverMap`             | type      | The schema-first `resolvers` option; read by `attachResolvers`.                                                                        |
| `FieldResolver`           | type      | The member type of `ResolverMap`; assigned to `field.resolve`.                                                                         |
| `GraphqlSchemaLike`       | type      | The code-first `schema` option's structural constraint.                                                                                |
| `GraphqlModuleLike`       | type      | The parameter of `adaptGraphqlModule`.                                                                                                 |
| `DefaultGraphqlContext`   | interface | The shape resolvers receive as `contextValue` when `buildContext` is absent; applications type their resolvers against it.             |
| `GraphqlContextInput`     | interface | The parameter of `buildContext`.                                                                                                       |

`GraphqlRuntime` and the structural `graphql` facades behind it are **not** exported: they are an
internal port, and publishing them would commit the plugin to tracking `graphql`'s own API — the
same call M49 recorded at the foot of its barrel.

### 4.3 Options — every option names its consumer

| Option               | Consumer                                                                           | Behavior (per implementation)                                                                    |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `schema`             | `build-schema.ts` (code-first arm)                                                 | Used as the executable schema as-is, after `validateSchema`.                                     |
| `typeDefs`           | `build-schema.ts` (schema-first arm)                                               | Passed to `runtime.buildSchema`.                                                                 |
| `resolvers`          | `attach-resolvers.ts`                                                              | Attached field by field; throws on an unknown type, unknown field, or a scalar type.             |
| `path`               | `graphql-plugin.ts` route registration, `IGraphqlService.endpoint`, `graphiqlHtml` | Defaults to `/graphql`; both routes and the GraphiQL page use it.                                |
| `graphiql`           | `graphql-handler.ts` GET branch                                                    | Defaults to `true`; `false` removes the HTML branch so a browser request gets the `400` of §3.4. |
| `introspection`      | `executor.ts` rule assembly                                                        | Defaults to `true`; `false` appends `NoSchemaIntrospectionCustomRule`.                           |
| `maxDepth`           | `executor.ts` rule assembly                                                        | Defaults to `10`; `0` omits the depth rule entirely.                                             |
| `validationRules`    | `executor.ts` rule assembly                                                        | Appended after the built-in rules, once, at registration.                                        |
| `maskInternalErrors` | `mask-errors.ts`                                                                   | Defaults to `true`; `false` passes resolver errors through verbatim.                             |
| `formatError`        | `mask-errors.ts`                                                                   | Applied to every error last, after masking; absent means identity.                               |
| `documentCacheSize`  | `document-cache.ts`                                                                | Defaults to `1000`; `0` constructs a pass-through cache that stores nothing.                     |
| `buildContext`       | `graphql-service.ts`                                                               | Replaces the default context wholesale; may be async.                                            |
| `rootValue`          | `graphql-service.ts`                                                               | Passed through to `execute` as `rootValue`.                                                      |
| `graphqlModule`      | `graphql-plugin.ts`                                                                | Short-circuits `loadGraphqlModule`; the documented fix for the cross-copy hazard of §3.1.        |

## 5. Implementation files

| File                                      | Purpose                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/tokens.ts`           | **Edit** — add `GRAPHQL: 'graphql'`.                                                                                 |
| `packages/common/src/services/graphql.ts` | **New** — the six contract types of §4.1.                                                                            |
| `packages/common/src/index.ts`            | **Edit** — barrel the new module.                                                                                    |
| `packages/graphql-plugin/deno.json`       | Manifest; `exports: './src/index.ts'`; `test.permissions.env` for the `process.env.NODE_ENV` read.                   |
| `packages/graphql-plugin/README.md`       | Package README (§7.1), including the Deno `--allow-env` and Workers `nodejs_compat` notes.                           |
| `src/index.ts`                            | Barrel of §4.2.                                                                                                      |
| `src/plugin/graphql-plugin.ts`            | The `GraphqlPlugin` factory: loads the runtime, builds the schema, registers the service, routes, health, `onClose`. |
| `src/services/graphql-service.ts`         | `GraphqlService` implementing `IGraphqlService`; owns context building and delegates to the executor.                |
| `src/execution/executor.ts`               | Parse → cache → validate → operation-kind guard → execute; owns the assembled rule list.                             |
| `src/execution/document-cache.ts`         | The bounded LRU of §3.9.                                                                                             |
| `src/schema/build-schema.ts`              | The two-arm construction and `validateSchema` of §3.2.                                                               |
| `src/schema/attach-resolvers.ts`          | Resolver-map attachment and its three throws.                                                                        |
| `src/http/graphql-handler.ts`             | The `RouteHandler` pair; owns method, media type, and status only.                                                   |
| `src/http/request-parser.ts`              | `GET`/`POST` request shapes into `GraphqlRequestParams`, with the typed failures of §3.4.                            |
| `src/http/media-type.ts`                  | `negotiateMediaType` and the two content-type constants.                                                             |
| `src/security/depth-limit.ts`             | `createDepthLimitRule`.                                                                                              |
| `src/security/mask-errors.ts`             | `isExposable`, masking, and `formatError` application.                                                               |
| `src/runtime/graphql-loader.ts`           | `adaptGraphqlModule` / `loadGraphqlModule` / `defaultImporter`.                                                      |
| `src/interfaces/graphql-runtime.ts`       | The internal `GraphqlRuntime` port and the structural `graphql` facades (not exported).                              |
| `src/interfaces/options.ts`               | `GraphqlPluginOptions` and the option-adjacent types of §4.2.                                                        |
| `src/ui/graphiql.ts`                      | `graphiqlHtml`.                                                                                                      |
| `src/errors/graphql-errors.ts`            | `GraphqlSchemaError`, `GraphqlRuntimeLoadError`.                                                                     |
| `deno.json` (root)                        | **Edit** — add `./packages/graphql-plugin` to the workspace list.                                                    |
| `scripts/release-packages.ts`             | **Edit** — add `packages/graphql-plugin` to Tier 4.                                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                      | src covered                               | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/graphql-loader.test.ts`             | `runtime/graphql-loader.ts`               | `adaptGraphqlModule(fake)` produces a runtime whose methods delegate; `loadGraphqlModule(rejectingImporter)` throws `GraphqlRuntimeLoadError` naming the specifier and install command.                                                                        |
| `test/unit/graphql-real-import.test.ts`        | `runtime/graphql-loader.ts` (import line) | Guarded real `import('npm:graphql@^16')` through `loadGraphqlModule()`; executes a one-field query end to end so the adapter is proven against the real module, not a fake.                                                                                    |
| `test/unit/build-schema.test.ts`               | `schema/build-schema.ts`                  | Both arms return an executable schema; invalid SDL throws `GraphqlSchemaError`; a schema failing `validateSchema` throws with the schema errors in the message; supplying both arms is covered by a type-level test comment plus a runtime guard.              |
| `test/unit/attach-resolvers.test.ts`           | `schema/attach-resolvers.ts`              | A resolver is reachable through `execute`; `__resolveType` drives an interface; unknown type, unknown field, and a scalar type each throw `GraphqlSchemaError` naming the offender.                                                                            |
| `test/unit/document-cache.test.ts`             | `execution/document-cache.ts`             | Hit returns the same document instance; LRU evicts the least recently used at capacity; `0` stores nothing; `clear()` empties.                                                                                                                                 |
| `test/unit/executor.test.ts`                   | `execution/executor.ts`                   | Parse error, validation error, `getOperationAST` returning `null`, subscription refusal, mutation-over-GET refusal, field-error `200`; `introspection: false` blocks `__schema`; a `validationRules` entry runs; a repeated query parses once.                 |
| `test/unit/request-parser.test.ts`             | `http/request-parser.ts`                  | Every `POST` and `GET` row of §3.4's table, each asserting the returned failure code; a body carrying `extensions` is accepted and the key ignored.                                                                                                            |
| `test/unit/media-type.test.ts`                 | `http/media-type.ts`                      | `application/graphql-response+json` wins; `application/json`, `*/*`, an absent header, and a multi-value `Accept` each resolve as specified.                                                                                                                   |
| `test/unit/mask-errors.test.ts`                | `security/mask-errors.ts`                 | The three probe shapes (plain `Error`, coded `GraphQLError`, bare `GraphQLError`) and a validation error map as §3.7 states; `maskInternalErrors: false` passes through; `formatError` runs after masking.                                                     |
| `test/unit/depth-limit.test.ts`                | `security/depth-limit.ts`                 | A document at the limit passes, one past it reports, `0` disables; the reported error carries the offending node's location.                                                                                                                                   |
| `test/unit/graphiql.test.ts`                   | `ui/graphiql.ts`                          | The endpoint appears in the page; a quote-carrying endpoint is escaped rather than breaking out of its attribute; the title is interpolated.                                                                                                                   |
| `test/unit/graphql-errors.test.ts`             | `errors/graphql-errors.ts`                | Both classes carry `name`, `message`, and a preserved `cause`.                                                                                                                                                                                                 |
| `test/unit/graphql-service.test.ts`            | `services/graphql-service.ts`             | Default context carries `services`/`requestContext`/`user`/`tenant`; a resolver reads a `user` set on the request; `buildContext` replaces the default; `rootValue` reaches resolvers; `endpoint` and `cachedDocumentCount` report.                            |
| `test/unit/graphql-handler.test.ts`            | `http/graphql-handler.ts`                 | The negotiated content type is set through `header()` and survives `send()`; the GraphiQL branch is taken only with no `query` and `text/html`; `graphiql: false` removes it.                                                                                  |
| `test/unit/graphql-plugin.test.ts`             | `plugin/graphql-plugin.ts`                | Registers under `CAPABILITIES.GRAPHQL`; registers `POST`/`GET` at `path`; the health indicator reports `up` with its data; `onClose` clears the cache; `graphqlModule` short-circuits the loader (an importer that would throw is never called).               |
| `test/unit/barrel-exports.test.ts`             | `src/index.ts`                            | Every symbol of §4.2 is exported and no more, so a stray export cannot slip past PUBLIC_API review.                                                                                                                                                            |
| `test/integration/graphql-integration.test.ts` | plugin + service + executor together      | A real kernel app resolves the service; a resolver resolves another capability from `services`; **both entry points** (`execute()` and the HTTP route) are driven under `maskInternalErrors: false` and a custom `buildContext` and produce identical results. |
| `test/e2e/graphql-http-e2e.test.ts`            | the whole HTTP surface                    | Through `app.inject()`: query, mutation, variables, `operationName`; the status watershed under both `Accept` values; 415/400/405; the GraphiQL page; a **write-then-read-back** case where a mutation's effect is observed by a following query.              |
| `test/e2e/graphql-schema-first-e2e.test.ts`    | the schema-first arm end to end           | An SDL + resolver map application serves a nested query with arguments and an interface field through a real app, proving the arm is not a stub.                                                                                                               |
| `packages/common/test/unit/tokens.test.ts`     | `common/src/tokens.ts` (edit)             | `CAPABILITIES.GRAPHQL === 'graphql'` and it satisfies `createCapabilityToken`'s grammar.                                                                                                                                                                       |

Fixtures (`test/fixtures/`) hold the fake `graphql` module bundle and a shared test schema, and are
excluded from coverage measurement.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m51-graphql-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Plus the end-of-task self-audit CLAUDE.md mandates, whose results go in the hand-back:

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/graphql-plugin/src
file packages/graphql-plugin/src/**/*.ts   # M50's NUL-byte lesson: a "binary" source file makes greps silently pass
```

## 8. Risks & mitigations

- **Two `graphql` copies in one process** — verified to throw
  `Cannot use GraphQLSchema … from another module or realm`. Mitigation: the `graphqlModule`
  injection seam (§3.1), a README section stating that a code-first application must pass its own
  module, and a `GraphqlSchemaError` at `register()` whose message names this cause when
  `validateSchema` throws a realm error.
- **`graphql` reads `process.env.NODE_ENV` at import** — fails under Deno without `--allow-env` and
  on Workers without `nodejs_compat`. Mitigation: `test.permissions.env` in the manifest, and an
  explicit portability paragraph in the README rather than a claim of universal portability.
- **`graphql@17` will change `subscribe` and add incremental delivery.** Mitigation: pin `^16` in
  the specifier and in the README; M51b re-evaluates when it takes subscriptions.
- **A depth limit that rejects legitimate queries.** Mitigation: the default of `10` is documented
  alongside `0` to disable, and the rejection message names the depth reached.
- **Coverage of the one real `import()` line.** Mitigation: the M49 shape — a pure adapter carrying
  every branch, one impure loader whose failure branch is driven by an injected importer, and a
  guarded real-import test for the line itself.
- **Serving GraphiQL from a CDN** conflicts with a strict CSP from `http-security-plugin`.
  Mitigation: documented in the README with the directive to add, exactly as the Swagger UI page
  already requires; `graphiql: false` is the production posture.
- **Scope creep from subscriptions.** Mitigation: the HTTP refusal of §3.4 is a tested, coded 400
  that names the limitation, so the gap is visible at the wire rather than being silent.

## 9. Out of scope

- **Subscriptions — M51b.** Both transports: the `graphql-transport-ws` protocol over
  `CAPABILITIES.WEBSOCKET` (resolved optionally, so the plugin still works with no WebSocket plugin
  registered — the `route()` surface it needs is verified present in §1), and GraphQL-over-SSE over
  M42 `IResponse.stream()`. Until then a subscription operation over HTTP answers `400` with
  `SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP`, which is a design decision (§3.4) with a test, not an
  omission.
- **Request batching and Automatic Persisted Queries — M51b**, together with the
  `GraphqlRequestParams.extensions` member APQ needs (§4.1).
- **Custom scalar resolvers in the schema-first arm — M51b.** M51 throws `GraphqlSchemaError` when a
  resolver map names a scalar type rather than ignoring the entry.
- **Federation, schema stitching, and a gateway** — a separate milestone; nothing here forecloses
  it.
- **A code-first schema builder** (a Pothos/Nexus-style DSL). The code-first arm consumes a schema
  the application already built; the framework does not ship a builder.
- **Starter arms.** No `graphql` arm is added to `rest-starter` or the tiers in this milestone:
  M36's rule is that a starter bundles nothing an application cannot use out of the box, and this
  plugin cannot boot without an application-supplied schema. A starter arm belongs with M51b, when
  the option shape has settled.
- **Client-side GraphQL** — `@hono-enterprise/sdk` (M35) owns HTTP clients; a typed GraphQL client
  would be an SDK milestone.
- **`honoe generate` schematics for GraphQL resolvers** — the CLI's schematic registry (M34) is
  where that lands, gated on the plugin's presence in the target project's manifest.
