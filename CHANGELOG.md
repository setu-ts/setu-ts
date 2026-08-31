# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — BREAKING (portable data-access contract, M79)

Three widenings to `@setu-ts/common`'s data-access contract. All three are **source-compatible for
callers** and **breaking for implementors**, because each widens a type in a position an implementor
must satisfy. No application that only _calls_ repositories needs a change; an application that
_implements_ `IDataSource` or declares a custom repository key type does.

- **`IDataSource.findById`/`update`/`delete` take `EntityKey`, not `string | number`.** The new arm
  is a composite record (`Readonly<Record<string, string | number>>`), so a join table or a
  tenant-scoped table can finally be addressed through a repository. A parameter is contravariant,
  so an out-of-repo adapter still declaring the scalar-only form is a compile error.

  ```typescript
  // Before — still valid, nothing to change for a scalar key.
  findById(id: string | number): Promise<Record<string, unknown> | null>;
  // After — an implementor must widen the parameter.
  findById(id: EntityKey): Promise<Record<string, unknown> | null>;
  ```

- **`FilterComparison.field` accepts `string | readonly string[]`.** An array is a nested document
  path (`['address', 'city']`); a plain `string` is unchanged. Any code that READS `filter.field`
  and assumes `string` must handle both. A dotted string is deliberately NOT a path — a column whose
  name contains a dot keeps its meaning.

- **The ordered-comparison arm (`gt`/`gte`/`lt`/`lte`) accepts `Date`.** Required for keyset
  pagination over a timestamp column, and it makes a portable date-range filter expressible for the
  first time. `IRepository`'s key type parameter is now constrained to `EntityKey`, which is
  breaking only for a declaration that was never supported at runtime.

### Added

- **Keyset cursor pagination.** `IDataSource.findPage?(query)` returns `{ rows, nextCursor }`, and
  `NormalizedQuery.cursor` carries the incoming position. The member is **optional** so an
  out-of-repo adapter keeps compiling; when it is absent the repository refuses by name, so absence
  means "cannot page by cursor" and never "there are no more rows". Implemented on all five shipped
  adapters — Memory, Prisma, Drizzle, Mongo and D1. `offset` is untouched and not deprecated; a
  query carrying both a non-zero `offset` and a `cursor` is refused, because the two express
  contradictory positions.
- `@setu-ts/common` gains `EntityKey`, `PageResult`, `CursorPayload`, `CursorValue`, and the pure
  `encodeCursor`/`decodeCursor`/`keysetPredicate`/`sortFingerprint`/`mintNextCursor` codec. The
  codec lives in `common` because `cloudflare-plugin` needs the identical encoding and a plugin may
  not import another plugin (AI_GUIDELINES §2.2) — one copy, not two.
- **The primary-key tiebreaker is a correctness requirement, not a refinement.** Measured against
  live PostgreSQL and MongoDB: over six rows carrying only two distinct sort values, a keyset walk
  omitting the key tiebreaker returned **four of six** and reported success. `keysetPredicate`
  always appends the resolved key columns, and the negative control is committed as a test.
- Composite primary keys per adapter: `D1EntityMapping.primaryKey` and
  `MongoEntityMapping.primaryKey` accept a column list, `MongoEntityMapping.idType` gains
  `'compound'` (a subdocument `_id`, built in the mapping's declared column order — a Mongo
  subdocument `_id` is matched by exact, order-sensitive equality, so the caller's key-object
  property order must never reach the driver), and `PrismaAdapterOptions.entities` /
  `DrizzleAdapterOptions.entities` carry per-entity key configuration. Prisma's compound-key field
  name is derived by joining the key columns with `_`; a model declaring a named `@@id` **must** set
  `compositeKeyName`, because Prisma rejects the derived name on such a model.
- `UnsupportedQueryFeatureError` in `@setu-ts/database-plugin`, for a query feature the active
  adapter cannot serve. `cloudflare-plugin` continues to refuse with `CloudflareUnsupportedError`;
  no error class is added to `common`, which exports none.

- **`@setu-ts/openapi-plugin` exports `SchemaIo`** and `ZodToOpenApi.transform` takes it as an
  optional second argument (`transform(schema, io?)`, defaulting to `'output'`), so an existing
  single-argument call is unchanged.

### Fixed

- **Prisma's `findById` and `update` threw synchronously on a malformed composite key**, bypassing a
  caller using `.catch()`, while `delete` on the same object rejected correctly. All three now
  reject.
- **Prisma's scalar key path addressed a hardcoded `id`**, ignoring a configured single-column
  `keyColumns`, so a lookup silently queried the wrong column. It now addresses the resolved column;
  the default `['id']` keeps the pre-M79 shape byte-identical.
- Prisma's composite-key refusals named `findById` regardless of the method that failed.
- **Mongo could write a partial compound `_id`** when a key column was absent from the row, storing
  a document that no `findById` could retrieve, since the read path requires every column.

- Added a native MongoDB backend to `@setu-ts/database-plugin`.
  `DatabasePlugin({ type: 'mongodb',
  options: { url } })` now provides repositories over the
  lazy-loaded MongoDB driver, including `_id` mapping, ObjectId-aware injected clients, query
  translation, and session transactions. `MongoAdapterOptions` is a union of two arms, so a
  registration supplying neither `url` nor `client` is a compile error rather than a `connect()`
  throw; `MongoAdapterOptionsBase` names the half both arms share. The `'mongodb'` member of the
  published `PrismaSqlProvider` union is retained but documented as unreachable on Prisma v7 — the
  adapter arm is the supported MongoDB route. Identity round-trips: an `ObjectId` is rendered as its
  24-hex string while a JSON scalar keeps its own type, `primaryKey` may name `_id` itself, and the
  primary key never travels in an update payload (MongoDB refuses a `$set` that would change `_id`).
  An empty filter group compiles to its boolean identity, matching Memory and Drizzle, because
  MongoDB refuses `$and: []`/`$or: []`. `contains` is case-sensitive and cannot be made otherwise —
  MongoDB does not apply collation to `$regex`. The arm accepts the shared `logQueries` option like
  every other built-in adapter.
- Added the `check:docs` executable prose-assertion gate. Marked Markdown tables are evaluated in a
  permission-denied Deno subprocess, including `.roo` rules, so false language-semantics claims fail
  CI instead of remaining unchecked prose.

- **`@setu-ts/openapi-plugin` documented a zod v4 REQUEST body as the shape the server holds after
  parsing, so a document could contradict the application serving it.** `ZodToOpenApi` converted
  every schema with `io: 'output'`. A field carrying `.default('free')` was therefore listed in the
  request body's `required` while the server accepted a body omitting it and supplied the default —
  reproduced in one running app, `201` from the route and `required: ["name","age","plan"]` from its
  own `/openapi.json` — so a generated client took a required argument for a field the API defaults.
  A `.transform()` field documented as `{}`, silently, because a transform's OUTPUT has no JSON
  Schema representation. And `additionalProperties: false` was emitted for a plain `z.object`, which
  strips an unknown key and answers 2xx rather than rejecting it.

  Every request-side position — `body`, `params`, `query`, `headers` — is now converted from the
  input side; `response` keeps the output side. A `z.strictObject` keeps
  `additionalProperties:
  false` under either view, so nothing a client may send is widened. This
  was a consequence of the alpha.10 zod-v4 fix rather than a regression in it: before that, a v4
  schema transformed to `{}`, so there was no `required` list to be wrong. **Zod v3 documents are
  unchanged** — that path has no `io` concept and already emitted the input view, which is what
  makes the two majors agree on a request body now.

  Two visible consequences, both by design. A request body built from a plain `z.object` no longer
  carries `additionalProperties: false`. And a schema whose two views differ and that is used on
  BOTH sides is hoisted into one component per side rather than one shared component; a schema whose
  views are identical — every zod v3 schema, and any v4 schema with no default, transform, coercion
  or object-mode difference — still yields exactly one, so most documents are unchanged. A schema
  registered with `addSchema('Name', …)` keeps that name on the output side and gains a `NameInput`
  twin when a request site reaches it — identified by schema rather than by name, so registering an
  unrelated `AddressInput` alongside `Address` cannot capture it.

## [0.1.0-alpha.10] — 2026-08-28

**The decorator surface moves to the TC39 standard, and realtime grows up.** Every shipped decorator
was the legacy TypeScript form, which requires the `experimentalDecorators` compiler option Deno now
deprecates and warns on. Removing that option would not merely untype the parameter decorators — the
Stage 3 proposal has no parameter position at all, so they would stop parsing. The surface is
therefore migrated deliberately now rather than under time pressure later: parameter injection
becomes positional `@Params(...)`, constructor injection collapses onto the class-position
`@Inject(...)` list, and no compiler option is required anywhere any more. This is the one change in
this release an application must act on, and the migrations are worked through below.

The realtime story closes the two gaps a browser actually hits. A browser can send exactly one
credential over an `EventSource` request or a WebSocket constructor — a cookie — and neither
built-in strategy read one, so the two transports the framework offers for realtime could not
authenticate a browser at all. `AuthPluginOptions.session` now reads the session cookie through a
new headers-only session read, and an authenticated upgrade's principal reaches `onOpen`. Both
realtime registries also gained a non-mutating read: `room(name)` and `channel(name)` are
get-or-create, so a presence endpoint reporting `size` for a request-supplied name was registering
one entry per distinct name polled.

Traces now cross a broker and nest under the request that caused them. Every first-party messaging
broker writes `traceparent` on publish and reports the transport headers it read, and telemetry
spans run with their span active rather than arriving as detached roots — which changes exported
trace shape for anyone already exporting.

Nothing else here requires an application change unless it is named **Breaking** below.

### Added

- **Broker trace propagation (M75).** `@setu-ts/common` now provides the W3C trace-context codec and
  header-name constants. When telemetry is registered, every first-party messaging broker writes
  `traceparent` on publish and exposes delivered transport headers; the messaging plugin creates
  producer/consumer spans around that path. `MessagingPlugin({ tracing: false })` opts out.

- **`@setu-ts/common`: a headers-only session read and the authenticated-principal bridge for
  WebSocket upgrades.** `ISessionService.fromHeaders(headers)` opens a session from a `Headers`
  object alone — the read for non-HTTP entry points (a WebSocket `onOpen` handler, an auth strategy
  reading a cookie) that have no request context to commit onto — and returns a new read-only
  `SessionView` (`{ id, data }`) or `null`. It runs the same envelope-open, snapshot-parse, and
  store-read path as the load behind `from(ctx)`, so it inherits real revocation on the store
  strategy, but it never commits and never writes. `WebSocketConnectionContext` gains an optional
  `user?: IPrincipal` — the principal that authenticated the upgrade, omitted when it was anonymous
  — and `IWebSocketService.routeUpgrade` gains an optional second parameter
  (`principal?: IPrincipal`) that carries it. Both additions are optional members, so existing
  implementors and consumers compile unchanged.
- **`@setu-ts/auth-plugin`: a cookie-backed `SessionStrategy` and a caller-supplied strategy
  hatch.** `AuthPluginOptions.session` takes a `SessionAuthOptions` whose single required member,
  `toPrincipal(view)`, maps the opened `SessionView` to the principal it carries (returning `null`
  continues the chain). When present, the plugin appends an internal `SessionStrategy` — the
  strategy that reads the session cookie through `ISessionService.fromHeaders` — after the API-key
  strategy, and requires the `session` capability (`SessionPlugin`) to be registered, or
  `register()` throws naming both plugins. `AuthPluginOptions.strategies` accepts caller-supplied
  `IAuthStrategy`s, appended after every built-in in declaration order; a `name` colliding with any
  other strategy in the assembled chain throws at `register()`. The assembled order is fixed — **jwt
  → api-key → session → caller-supplied** — and the first non-null principal wins. This closes X3-5:
  a browser can now authenticate over `EventSource` and a WebSocket upgrade, the two transports that
  can send only a cookie.
- **`@setu-ts/session-plugin`, `@setu-ts/kernel`, and `@setu-ts/websocket-plugin`: the bridge wired
  end to end.** `SessionService` implements `fromHeaders`; the kernel's terminal handler passes
  `ctx.request.user` to `routeUpgrade`; and `WebSocketService` threads that principal into
  `buildContext`, so `onOpen`'s `context.user` is the authenticated peer. No adapter change is
  needed: since M70a `routeUpgrade` is the only live upgrade-routing path on every runtime.
- **Declared dependency-compatibility ranges, and a reproducibility artifact on every release.** The
  Zod-facing packages now state the ranges they are tested against rather than leaving them to be
  inferred: `@setu-ts/validation-plugin`, `@setu-ts/openapi-plugin` and `@setu-ts/decorator-plugin`
  support **zod v3 (`>=3.24.0 <4`) and zod v4 (`>=4.4.0 <5`)**, and `deno task check:compat`
  exercises each declared major independently — no package imports zod, so an application may use
  either major, or both in one process. `@setu-ts/database-plugin` records its tested Drizzle
  baseline (`0.45.2`) and its Prisma v7 integration as the current claims, with wider ranges pending
  the work that would make them tested rather than guessed. Separately, every GitHub Release now
  carries a `resolved-set.json` asset wrapping the committed `deno.lock` under the release version —
  exact transitive versions and integrity hashes, so the tagged framework tree rebuilds against the
  reviewed resolution — and a weekly **Dependency drift** workflow re-resolves every workspace range
  into a fresh lockfile, runs the gates against it, and files one issue naming each committed→fresh
  change. It never modifies `deno.lock` and cannot block a pull request or a release.

### Changed

- **Telemetry spans now nest.** Real OTel `withSpan` callbacks run with their span active using an
  async-local context manager (unless `contextPropagation: false`), so work initiated in a request
  becomes a child of its request span rather than a detached root. **This changes exported trace
  shape for every application already using `exporter: 'otlp'` or `'console'`:** spans that arrived
  as separate roots now arrive as one tree, so dashboards or alerts keyed on root-span counts will
  see fewer roots and deeper traces. Nothing needs changing to adopt it; set
  `TelemetryPlugin({ contextPropagation: false })` to keep the previous flat shape. Activation needs
  `npm:@opentelemetry/context-async-hooks`; when that package is absent, or the runtime supplies no
  async-context store, the plugin logs one `warn` and degrades to the previous behaviour rather than
  failing startup.

- **`traceparent` parsing is stricter.** The codec promoted to `@setu-ts/common` rejects two inputs
  the telemetry plugin's private copy accepted: an UPPERCASE-hex header (the previous regex carried
  the `i` flag, while W3C Trace Context defines the value as lowercase hex), and an all-zero trace
  or span id, which is not a valid parent. Both now yield "no extractable parent", so a request from
  a non-conformant upstream starts a new trace instead of continuing an invalid one.

- **`MessageMetadata.headers` is now populated by every first-party broker.** It was already read by
  the RabbitMQ and Kafka brokers and omitted entirely by the memory, Redis Streams, Pub/Sub and
  Service Bus brokers; all seven now report the transport headers they read, and `{}` — not
  `undefined` — when the transport carried none. **A consumer that branches on the member's presence
  changes behaviour:** `if (metadata.headers)` was falsy on those four brokers and is now truthy.
  Test emptiness instead (`Object.keys(metadata.headers ?? {}).length === 0`).
- **BREAKING — `@setu-ts/decorator-plugin`: the decorator surface moves to TC39 standard decorators,
  and the legacy form is removed.** Every shipped decorator was a legacy TypeScript decorator, which
  requires the `experimentalDecorators` compiler option. Deno deprecates that option and warns on
  every `check` and `lint` run, and its removal would not merely untype the parameter decorators —
  it would make them **unparseable**, because the Stage 3 proposal has no parameter position at all.
  The surface is therefore migrated deliberately now rather than under time pressure later.

  **No compiler option is required any more, anywhere.** `experimentalDecorators` is removed from
  all eight declaration sites — the `decorator-plugin`, `openapi-plugin` and `rest-starter`
  manifests, `apps/di-decorators`, the guide-snippet fixture, both CLI template stamps, and the
  generated Node `tsconfig.json`. Do not add it back: declaring **any** compiler option replaces
  Deno's entire default set (see M63's `full-stack` JSX failure), so a project needing none should
  declare none.

  **Parameter decorators become positional sources inside `@Params(...)`.** `@Body`, `@Query`,
  `@Param`, `@Header`, `@Cookie`, `@CurrentUser` and `@Ctx` keep their names but change kind, from
  parameter decorator to source descriptor. Each stale call site is a compile error rather than a
  silent behaviour change, because the returned value is no longer a decorator.

  ```typescript
  // Before
  @Get('/:id')
  show(@Param('id') id: string, @Ctx() ctx: IRequestContext) {}

  // After — sources listed in argument order
  @Get('/:id')
  @Params(Param('id'), Ctx())
  show(id: string, ctx: IRequestContext) {}
  ```

  The declaration is now **type-checked against the handler's own signature**, which the legacy form
  never was: a source whose value type disagrees with the parameter it binds fails `deno check`.

  **`createParameterDecorator(name, metadata?)` is replaced by `Custom(name, metadata?)`**, used
  inside `@Params`. Resolvers registered with `registerParameterResolver` are unchanged.

  ```typescript
  // Before
  export const TenantId = () => createParameterDecorator('tenant-id');
  async list(@TenantId() tenantId: unknown) {}

  // After
  export const TenantId = () => Custom<string | undefined>('tenant-id');
  @Params(TenantId())
  async list(tenantId: string | undefined) {}
  ```

  **Constructor injection collapses onto the class-position `@Inject(...)` list**, which already
  shipped and is no longer deprecated; the parameter position is removed. `@Optional()` changes kind
  the same way, becoming `Optional(token)` used inside that list.

  ```typescript
  // Before
  @Injectable()
  class Repo {
    constructor(
      @Inject('database') private db: Db,
      @Optional() @Inject('cache') private cache?: ICacheStore,
    ) {}
  }

  // After — one entry per constructor argument, in argument order
  @Injectable()
  @Inject('database', Optional('cache'))
  class Repo {
    constructor(private db: Db, private cache?: ICacheStore) {}
  }
  ```

  Two startup refusals disappear with the form that caused them, because no input can reach them any
  more: "declares both `@Inject` forms" and "parameter N has no `@Inject` token". The
  `MetadataStore.mergeCtorParam` and `MetadataStore.ctorInject` methods are removed with them — a
  class-position list is positional and cannot have gaps, so `services.inject` is the one place a
  token list lives. A list shorter than the constructor simply leaves the trailing arguments
  `undefined`.

  **One `IMetadataStore` read narrows.** A standard member decorator never receives the constructor,
  so it records onto `context.metadata` and the store replays those writes when the class is read by
  target. A carrier holds no reference back to its class, so the target-less reads — the
  `controllers`/`services`/`routes` getters and `getCustomDecorators()` — cannot replay: a class
  carrying member decorators and NO class decorator is absent from them until something reads it by
  target, where the legacy form recorded it eagerly. Every class the plugin registers carries
  `@Controller` or `@Injectable`, and a class decorator flushes eagerly, so this is confined to a
  class the plugin never registers either.

  **New exports:** `Params`, `Custom`, `Optional` (new kind), `ParamSource`, `SourceValues`,
  `InjectToken`, `OptionalToken`, and the three decorator-kind types `SetuClassDecorator`,
  `SetuMethodDecorator`, `SetuClassOrMethodDecorator`.

  **Generated projects change shape.** `setu generate controller` and `setu generate module` emit
  `@Params(...)` and the class-position `@Inject`, and no scaffolded project stamps a decorator
  compiler option. A project generated before this release keeps working only until it is
  regenerated; migrate its decorated sources with the transformations above.

  **Node is unaffected in requirement but not in reason.** A generated Node project still runs
  through `tsx`, because V8 has not shipped decorators — measured on Node v24, both `node` and
  `node --experimental-strip-types` answer a **standard** decorator with
  `SyntaxError: Invalid or unexpected token`. Its `tsconfig.json` no longer sets any decorator
  option.

- **`@setu-ts/common`: `ISessionService.fromHeaders` is a REQUIRED member.** Callers are unaffected
  — the addition is source-compatible for every consumer. But an application that implements
  `ISessionService` itself (not the framework's `SessionService`) now fails to type-check until it
  adds `fromHeaders(headers: Headers): Promise<SessionView | null>`. It is required rather than
  optional because a strategy in another package must call it without a capability-shaped guard, and
  the framework's `SessionService` is the only in-repo implementor (the M51b
  `IGraphqlService.subscribe` precedent). Migration: add the member to your implementation; the
  contract is read-only — it must open the session from the supplied headers, return `null` for
  every condition the load path treats as "no usable session" (absent cookie, unopenable envelope,
  unparseable snapshot, absolute expiry or idle timeout passed, or a gone store entry), and never
  commit, advance the `seen` stamp, or write.
- **A non-mutating read on both realtime registries: `IWebSocketService.peek(name)` and
  `ISseService.peek(name)`** (M74, X3-8). `room(name)` and `channel(name)` are get-or-create, so a
  presence or dashboard endpoint reporting `size` for a name taken from a request registered one
  entry per distinct name polled — measured at 3 → 53 rooms across 50 read-only requests, with
  nothing to reclaim them until an unrelated socket disconnected. `peek` returns the room or channel
  when one exists and `undefined` otherwise, registering nothing:

  ```typescript
  const present = ws.peek(`board:${boardId}`)?.size ?? 0;
  ```

  This is **breaking for anyone implementing either service contract outside this repository**:
  `peek` is a required member, not an optional one, because an optional `peek?` returning
  `undefined` cannot distinguish "no such room" from "this implementation does not offer the read".
  Add a lookup that does not create; both first-party services delegate to a single map read.
  Consumers are unaffected.

- **`ISseService.channelCount`** (M74) — the counterpart to `IWebSocketService.roomCount`, reported
  by the `sse` health indicator as `channels`. Nothing reclaims a channel, so the value only rises
  for the life of a running application — a climbing value is the signal that channel names are
  being derived from unbounded input. Shutdown discards every channel and resets it to zero.
  **Breaking for an out-of-repo implementor of `ISseService`** in the same way `peek` is: add a
  getter returning the registry size. The health payload gains a field, which is additive for
  consumers.

- **`JsonValue` in `@setu-ts/common`** (M74) — a recursive JSON-safe value type. Its object arm
  admits `undefined` deliberately, because `JSON.stringify` drops such a property rather than
  failing, so an optional field still assigns.

- **`SseMessage.data` is narrowed to `JsonValue`** (M74, X3-8). **Breaking.** The member was
  `string | number | boolean | null | readonly unknown[] | Record<string, unknown>`, whose last two
  arms admitted values `JSON.stringify` cannot represent — while `PUBLIC_API.md` claimed the member
  "accepts any JSON-serializable value". It now does. What this rejects, and what to do instead:

  - **A `bigint` anywhere in the payload** (`{ balance: 10n }`, `[10n]`). `JSON.stringify` throws on
    it, and the throw surfaced differently depending on configuration: `conn.send` threw to the
    caller, `channel.publish` with no backplane delivered to nobody and reported nothing, and
    `channel.publish` with a backplane threw synchronously. Convert the value first —
    `{ balance: String(balance) }`.
  - **A function or symbol value.** `JSON.stringify` silently drops the key, so the data never
    arrived. Remove it from the payload.
  - **An `interface` that extends `Record<string, unknown>`** to satisfy the old object arm. Change
    it to `extends Record<string, JsonValue | undefined>`. A named `interface` still does not assign
    without an index signature — TypeScript grants implicit ones only to object-literal types, which
    was equally true before this change — so a `type` alias remains the simpler option.

  A property written `T | undefined` is unaffected. A **circular structure** still throws at
  runtime; no type can express acyclicity.

- **`@setu-ts/openapi-plugin`: an unrepresentable schema node is now REPORTED instead of silently
  emitting `{}`.** A type zod cannot represent in JSON Schema (`z.date()`, `z.bigint()`, …) still
  degrades to an empty schema — never a throw — but the operation owning it now carries a
  machine-readable vendor extension naming the route:
  `"x-setu-unrepresentable": [{ "at": "<operationId>", "reason": "…" }]`. The extension is absent
  when every schema is representable, so valid documents are unchanged.

### Fixed

- **`@setu-ts/messaging-plugin`: a transport header whose bytes are not valid UTF-8 is dropped
  rather than decoded to replacement characters.** The normalizer decoded byte values with a lenient
  `TextDecoder`, which substitutes `U+FFFD` for malformed input — so a subscriber received a string
  the producer never sent, indistinguishable from a real value, while the module's own contract says
  a value with no faithful string form is dropped. Decoding is now fatal and a rejected value is
  omitted. The throw is caught inside the normalizer, which matters on the Kafka path: an escaping
  throw inside `eachMessage` prevents the offset commit and the record is redelivered indefinitely.
  Valid multi-byte UTF-8 is unaffected.

- **`@setu-ts/messaging-plugin`: `MessageMetadata.headers` could carry values that were not
  strings.** The member is declared `Readonly<Record<string, string>>` and is documented as
  populated by every first-party broker, but `RabbitMqBroker` and `ServiceBusBroker` reached it by
  assertion rather than conversion. An AMQP field table legitimately carries numbers, booleans,
  timestamps, byte arrays and nested tables, and the Service Bus SDK types application properties
  `number | boolean | string | Date | null`, so a subscriber reading `metadata.headers.x` could get
  a value of any of those types while the compiler promised a string. Both now normalize at the
  transport boundary through the same helper Kafka already used: a byte value is decoded as UTF-8, a
  number or boolean is stringified, a `Date` becomes ISO-8601, the first element of a repeated
  header is taken, and a value with no faithful string form is dropped rather than rendered as
  `[object Object]`. Kafka's private copy of that logic was deleted in favour of the shared helper.

- **`@setu-ts/messaging-plugin`: the Kafka producer put the entire message payload into Kafka
  transport headers.** `publish` passed the payload object itself as `headers` whenever it was
  non-null, so every field of every message was duplicated into the record's headers — and a
  non-string field is not a legal `IHeaders` value (`Buffer | string | (Buffer | string)[]`), so
  kafkajs had to coerce it. Only framework-owned headers are sent now. A consumer reading payload
  fields off `metadata.headers` was relying on the defect and must read them off the message.

- **`@setu-ts/messaging-plugin`: `metadata.headers` on the NATS broker exposed the client's private
  internals instead of the message headers.** The delivered `MsgHdrs` was cast to
  `Record<string, string>`; probed against real `npm:nats@2.x`, that yields `undefined` for every
  real key and `Object.keys` of `['_code', '_description', 'headers']`. Headers are now read through
  the object's own `keys()`/`get()`. `NatsOptions.headersFactory` supplies the `MsgHdrs` constructor
  when the connection is injected (a lazily-loaded module provides its own); with neither available
  the broker publishes without headers and reports it once.

- **Three committed docs still said WebSocket upgrades and gRPC requests bypass the middleware
  pipeline**, which M70a made false. `packages/websocket-plugin/README.md` claimed "the adapter
  therefore consults the plugin's upgrade router first", and the `ARCHITECTURE.md` package-diagram
  notes said the §10 pipeline "is likewise bypassed for upgrade requests, by design" and that RPC is
  "intercepted inside the HTTP adapter's `fetch` path". Since M70a the kernel's terminal handler
  decides both, after the pipeline has run and before route matching; the adapter stores the upgrade
  router without consulting it, and `setRpcHandler` is deprecated and consulted by nothing. Each
  correction now matches the canonical prose in `ARCHITECTURE.md` §10 and `PUBLIC_API.md`. Both
  documents were reachable by a reader deciding whether a guard protects a socket, which is exactly
  the question M70a exists to answer. Two further copies were found in `@setu-ts/common`'s own
  JSDoc, which jsr.io renders: `IHttpAdapter.setUpgradeRouter` said the handshake happens "when the
  pipeline does not short-circuit **and route matching returns no match**" — the pre-review ordering
  that M70a's code review inverted, because a catch-all was shadowing every upgrade — and
  `RpcFetchHandler` still described the adapter consulting it before mapping the request.
  `ARCHITECTURE.md` also claimed `grpc-plugin` depends on the `http-adapter` capability; it resolves
  no adapter at all since M70a. Documentation only — no behaviour, signature or export changed.

- **`@setu-ts/openapi-plugin` produced an EMPTY OpenAPI schema for every zod v4 schema.** Zod v4
  removed the private `_def.typeName` marker the transformer dispatched on, so every v4 schema fell
  through to `{}` and `/openapi.json` served `{"schema":{}}` for any route documented with one. Zod
  v4 schemas are now converted through `schema.toJSONSchema()` (draft 2020-12, adapted to OpenAPI
  3.1), with dedup, `$ref`/`components` extraction and recursive-schema hoisting working on both
  majors. Both zod v3 and v4 are supported; the plugin imports neither — detection is by duck-typing
  `toJSONSchema`. Zod v3 output is byte-identical.

## [0.1.0-alpha.9] — 2026-08-26

**A security release, and the closeout of the alpha.8 smoke programme.** Driving the published
packages through twelve exercises — real projects, real brokers, a real cluster — produced a
register of verified defects rather than a list of suspicions, and this release closes it. The five
that change what an application is exposed to are listed first: no middleware ran before a WebSocket
upgrade or a gRPC request, so a guard could not refuse either; a cached response crossed tenants; a
session minted under one tenant authenticated a write into another; an unhandled error returned the
failing SQL and its bound values to the caller; and feature flags had no tenant dimension at all.

The rest is what the register kept finding once it looked. Capabilities reported `up` with their
backends stopped, so a dead dependency triggered no restart and no rolling-deploy gate. The default
branch of an injectable seam was the one line no test ever ran, because every test injects — which
is how `@setu-ts/grpc-plugin` shipped unable to load on Node or Bun, and how the SDK's own default
transport died on a browser's first request. Generated artifacts compiled and were wired to nothing.
Database adapters reported success while doing something other than what their contract said.

Two contracts tightened as a result. The kernel's application registry seals after bootstrap and a
duplicate route is refused rather than silently overwriting — one of the two handlers used to become
permanently unreachable with no diagnostic. And `@setu-ts/common` gained the optional runtime seams
(`onSignal`, `onExit`) that let a generated entry point stop hard-coding the runtime it was
scaffolded for: one `main.ts` body now serves Deno, Node and Bun byte-identically.

Nothing here requires an application change unless it is named **Breaking** below.

### Security

- **The middleware pipeline now runs before every WebSocket upgrade and gRPC request** (M70a).
  `setUpgradeRouter` and `setRpcHandler` were consulted inside the HTTP adapter _before_ the request
  was mapped and entered the pipeline, so **no middleware applied to either**: an unauthenticated
  WebSocket could write through a guarded endpoint, an unauthenticated gRPC client could read and
  write through one, metrics and security headers were absent on both, and RPC kept answering `200`
  through a shutdown drain while ordinary paths answered `503`. Every inbound request now runs the
  pipeline first; the handshake or RPC dispatch happens only in the kernel's terminal handler, after
  the pipeline declines to short-circuit, and **before** route matching so an application catch-all
  cannot shadow either. No application change is required. Note that an **accepted** upgrade is
  answered by the runtime's own `101`, which does not carry response headers a middleware wrote on
  `ctx.response`; the pipeline still runs, so a guard can refuse, and a refused upgrade is an
  ordinary HTTP response carrying everything.

- **A tenant is no longer served another tenant's cached response** (M70b, X4-1). `cacheMiddleware`
  keyed on `method:url` alone, and the `cache: { prefix: true }` isolation the multi-tenancy plugin
  advertised was a string **no package read** — so with one route cached, whichever tenant missed
  first populated the entry and every other tenant was served its body, with `X-Cache: HIT`. The key
  now composes a length-prefixed tenant segment, read from the committed `ctx.request.tenant`,
  around the default **and** any custom `key` function. An application with no tenancy resolves no
  tenant and keeps byte-identical keys.
- **A session is now bound to the tenant it was minted under** (M70b, X4-3). Tenancy resolves at
  priority 40 and the session loads at 260, and neither consulted the other, so an `acme` session
  authenticated a **write into `globex`** — CSRF token included, because that token lives in the
  session that crossed with it. The resolved tenant is now sealed into the session on commit and a
  mismatch is refused with `403` before the handler runs (`SessionPlugin({ tenantBinding })`,
  default `true`). Inert without tenancy: nothing is sealed, so nothing is compared.
- **An unhandled error no longer returns the failing SQL and its bound parameter values to the
  client** (M70b, X12-3). `errorHandler` — the middleware every CLI template emits — copied a raw
  error's `message` into the response, so an ordinary unique-constraint violation disclosed the
  schema, the table, every column, and every bound value to any caller who could reach the route.
  `maskInternalErrors` (new, default `true`) replaces that message with the status title; the logger
  still receives the real error first. See **Changed** for the compatibility note.
- **Feature flags can be scoped to tenants** (M70b, X4-6). `FlagContext.tenantId` and
  `FlagDefinition.tenants` add a tenant restriction evaluated ahead of every other rule, so a user
  allowlist cannot cross a tenant boundary. `createFlagGuard` derives `tenantId` from
  `ctx.request.tenant`. Absent `tenants`, evaluation is unchanged.

### Added

- **`setu new --broker <name>` and `--queue <name>` select a standalone project's message broker and
  job queue at scaffold time** (M72). Values derive from the same transport registry the workspace
  `--transport` flag reads; the selected arm rewrites the template's `MessagingPlugin`/`QueuePlugin`
  wiring to an environment read, adds its connection variable to the generated dotenv pair, and
  emits a broker-only `docker/compose.yaml` so the scaffold can complete `app.start()`. Each flag is
  refused — never silently ignored — wherever it would be a no-op: Cloudflare Workers,
  starter-composed templates (`full-stack`; use `--template microservice` for a broker), templates
  registering no matching wiring, unknown or arm-less names, workspaces, and `generate app`. No
  existing flag's behaviour changes; a default scaffold is byte-identical.
- **`setu new` can ask for the choices it already accepts as flags** (M72). At an interactive
  terminal it prompts for runtime, template, broker and queue (standalone) or runtime and transport
  (workspace); every prompted value is expressible as a flag, so prompts are never a second
  configuration surface. Non-interactive by construction in three layers: `CliDependencies.ask` is
  optional and programmatic callers pass none; the executable supplies the terminal prompter only
  behind `Deno.stdin.isTerminal()`; Deno's own prompt returns `null` on a non-terminal. `--yes`
  (`-y`) takes every default and asks nothing. New exports: the `Prompter` and `PromptChoice` types;
  `createTerminalPrompter` stays internal.
- **Decorated validation schemas can be enforced without hand-wiring middleware** (M70n, E1/E2) —
  see **Changed** for the breaking default. `DecoratorPluginOptions.enforceSchemas` controls it, and
  `@Body()`/`@Query()`/`@Param()` read the VALIDATED value (transforms, defaults and coercions
  included) via the new `validatedStateKey(target)` helper exported from `@setu-ts/common` — the
  cross-package state-key wire format both plugins must agree on byte-for-byte, replacing two
  hardcoded literals. Presence-tested with `ctx.state.has`, so a validated `null` or `0` is
  honoured; falls back to the raw source when no validated value exists. `@Header`/`@Cookie`
  deliberately unchanged (case-insensitive header lookup; no cookies schema key).
- **`PasswordHasher.verify(stored, secret)` throws `MalformedPasswordHashError`** (M70n, X3-9) when
  `stored` is not a well-formed `pbkdf2$…` string, instead of returning `false`. Both parameters are
  plain strings, so a reversed call used to fail closed silently — every correct password answered
  `401 Invalid credentials` with nothing logged. Exported for `instanceof`; a genuinely wrong
  password still returns `false`.
- **`StoredAuditEntry` and `AuditQuery` exported from the audit-plugin barrel** (M70n, X4-7). They
  are the return and parameter types of every exported storage class's `query` member, which were
  previously unnameable by any consumer (the M52c `NormalizedQuery` class).
- **`SseMessage.data` accepts any JSON-serializable value** (M70n, X3-6):
  `string | number | boolean
  | null | readonly unknown[] | Record<string, unknown>`. The encoder
  already handled all of them; the type rejected what the implementation accepted, so named
  interfaces needed casts.
- **A process-local notice on `RealtimeBackplanePlugin`** (M70n, X3-4). Registering bare defaults to
  the single-process `'memory'` transport AND silenced the consumers' startup notices — worse than
  not registering it. The plugin now logs the notice itself at `register()` naming `'redis'`/
  `'messaging'`; `localNotice: false` suppresses it.
- **`ReactRouterPluginOptions.publicFiles`** (M70n, X5-5), default `true`: files Vite copies to the
  client build root (`public/robots.txt`, `favicon.ico`) are served with `must-revalidate` instead
  of answering an HTML 404 through the SSR catch-all. `false` restores prefix-only behaviour.
- **`FullStackStarterOptions.static`** (M70n, X5-9): a gated arm registering `StaticPlugin` — the
  browser-serving tier could not compose static files through configuration. Absent, the plugin list
  is unchanged.

- **The OpenAPI document is derived from validation middleware** (M70m, X11-5). A route carrying
  `validateBody(schema)` contributed **nothing** to the document, so the generated client for an
  API's only write took no argument and answered `400` against the live server, and every response
  was typed `void`. `@setu-ts/common` gains `VALIDATION_METADATA`, `RouteValidationMetadata`,
  `withValidationMetadata` and `validationMetadataOf` — the `RouteSecurityMetadata` mechanism
  applied to request shape — every `@setu-ts/validation-plugin` helper AND
  `IValidationService.middleware(...)` brand what they validate, and `@setu-ts/openapi-plugin` reads
  the brand to fill `requestBody` and `parameters`. **On by default**; a declared `schema` field
  still wins per field, and `OpenApiPlugin({ deriveRequestSchemas: false })` turns derivation off.
  That flag disables derivation ONLY — the owner exclusion, `operationId` format and schema
  deduplication changes below are unconditional, so it does not restore the previous document. See
  **Changed** for the compatibility note. A `cookies` brand derives nothing, with cause:
  `RouteSchema` has no `cookies` field and `@setu-ts/sdk` refuses an `in: 'cookie'` parameter, so
  emitting one would turn a working document into a codegen failure.
- **A derived route is documented as answering `400`** (M70m). The validation middleware genuinely
  answers it, and an operation carrying no `4XX` is flagged by every strict linter. Description
  only, no body schema — that shape depends on the validation plugin's configured `errorFormat`,
  which the generator cannot see. A route declaring its own `400` is left alone.
- **`OpenApiPlugin({ excludeOwners })`** (M70m, X11-8), defaulting to
  `['health-plugin', 'metrics-plugin']`. `/health`, `/live`, `/ready` and `/metrics` were documented
  by default, so every generated client shipped the application's operational surface. Exclusion is
  by `RouteInfo.owner` rather than by path because those paths are configuration — a static path
  list stops working the moment an endpoint is renamed. Pass `[]` to document them again. See
  **Changed** for the compatibility note — a regenerated client loses `getHealth` and friends.
- **The generated SDK client can be published to JSR** (M70m, X11-4). `createApi` had an inferred
  return type, which JSR rejects as a slow type — so a consumer had to hand-edit a file whose own
  header says "Do not edit manually", or lose `.d.ts` generation for their whole package. The
  generator now emits `export interface Api { … }` and `createApi(client): Api`, renameable with the
  new `OpenApiCodegenOptions.apiTypeName`.
- **Declared error responses are typed in the generated client** (M70m, X11-7). An operation
  declaring a non-2xx response now emits a `status`-discriminated union and an `is<Operation>Error`
  narrowing guard, so a document's 4xx schemas finally type something. `HttpClientError` is generic
  in its body (`HttpClientError<TBody = unknown>`), which is source-compatible: the bare name still
  means `HttpClientError<unknown>`.
- **`ZodToOpenApi` accepts an optional `onSchema` hook** (M70m), consulted at every node it
  transforms. Additive — `new ZodToOpenApi()` is unchanged — and it is what lets the document
  generator deduplicate a schema nested inside another.
- **`IStorage.put` takes object metadata** (M70k, X8-6). `put(path, data, options?)` accepts a new
  `PutObjectOptions` carrying `contentType` and `metadata`. Optional, so every existing two-argument
  call is unchanged. Without it every stored object was `application/octet-stream`, so a presigned
  URL — the entire point of the feature that produces one — downloaded the object instead of
  rendering it. S3, GCS, Azure Blob and Cloudflare R2 each record both on the object in their own
  spelling; the memory and local providers accept and do NOT persist them, documented per provider,
  because neither backend has anything that could read an attribute back.
- **`ProcessOptions.onFailed`** (M70k, X8-4). Invoked once when a job has exhausted its attempts,
  immediately before it is dead-lettered — the first programmatic notice that work was permanently
  abandoned. `IQueue` has no `getJob` and no dead-letter accessor, so before this the only way to
  find a dead job was to open a Redis client. A callback that throws or rejects is reported and
  swallowed; the dead-letter still happens.
- **Queue metrics** (M70k, X8-4). With `@setu-ts/metrics-plugin` registered, the queue publishes
  `queue_jobs_total{name,outcome}` where `outcome` is `completed`, `retried` or `dead_lettered`.
  Absent the metrics capability no collector is built and behaviour is unchanged.
- **Per-name queue depths in the `queue` health payload** (M70k, X8-4). `data.queues` reports
  `{ ready, processing, dead }` per job name for the memory and Redis adapters — the durable view a
  per-process counter cannot give after a restart. OMITTED, never reported as zeros, on RabbitMQ and
  SQS: "this adapter cannot tell you" and "there is nothing there" are different answers.
- **`QueuePluginOptions.deadLetterTtlMs`** (M70k, X8-4). Bounds how long a dead-lettered job's
  payload is retained (Redis). Without it the jobs hash grows for the lifetime of the deployment;
  opt-in, because the retention exists for debugging. Configuring it MOVES a dead job's payload out
  of `queue:<name>:jobs` into `queue:<name>:dead:jobs`, and only that key and the dead set carry the
  expiry — the live hash holds every queued job's payload for that name, so expiring it would
  destroy work that is merely waiting. Retention is a bound, not a deadline: at least the TTL, and
  at most the TTL past the last dead-letter, because the sweep runs only when one arrives and the
  shared key carries a single deadline. It errs late deliberately — dropping a payload early would
  discard the debugging data the option exists to keep. The payload move is ordered before the
  dead-set insert so a concurrent dead-letter's sweep cannot delete a member whose payload has not
  been written and strand it beyond every later sweep.
- **`UploadMiddlewareOptions.maxBodyBytes`** (M70k, X8-3). An explicit ceiling on the request body
  the upload middleware will parse, default 50 MB.
- **`IWorkerHandle.onExit?` and `IWorkerHost.reportsExit?`** (M70k, X8-7). An optional worker-exit
  signal, implemented over `node:worker_threads`' `'exit'` on Node and Bun's non-standard `'close'`,
  and **omitted on Deno**, whose web `Worker` emits nothing at all when a worker ends itself.
  Absence means "this runtime cannot tell me a worker died", never "no worker has died".
- **`WorkerExitError`** (M70k, X8-7), exported from `@setu-ts/worker-pool-plugin` for `instanceof`
  handling. Distinct from `WorkerTaskError`, which carries an error the worker managed to report.
- **`QueueDepths`** is exported from `@setu-ts/queue-plugin`: it appears in the public signature of
  `MemoryQueue.depths` and `RedisQueue.depths`, and a type a consumer can see but cannot name is a
  defect (the M52c `NormalizedQuery` class).

- **Per-adapter option arms on `DatabasePluginOptions`** (M70j, D7). `MemoryDatabaseOptions`,
  `PrismaDatabaseOptions` and `DrizzleDatabaseOptions` join the exported `CustomDatabaseOptions`,
  and `BuiltInDatabaseOptions` becomes the union of the first three, keeping its published name.
  `PrismaAdapterOptions` and `DrizzleAdapterOptions` narrow `DatabaseAdapterOptions` for their arm.
  See **Changed** for the compile-time requirement this introduces.

- **A request-scoped error responder seam in `@setu-ts/common`** (M70f).
  `respondWithError(ctx,
  { status, title, detail?, details? })` and the `IErrorResponder` /
  `ErrorResponseInit` / `ERROR_RESPONDER_STATE_KEY` types let a package that produces an error
  response — but may not import `@setu-ts/exceptions`, where every formatter lives — answer in the
  application's configured format. `errorHandler` publishes a responder (built from the formatter
  and content type it already resolved at factory time) into `ctx.state` before `next()`; every
  short-circuiting site in the kernel and in the storage, multi-tenancy, session, auth,
  http-security and feature-flags middleware now delegates to it, so one
  `errorHandler({ format: 'rfc9457' })` governs every error body those sites produce.
  `validation-plugin` is deliberately **not** part of the seam — it owns its own `errorFormat`
  option and formats validation failures itself — so an application configures the two together; the
  CLI templates and `rest-starter` now do (C3). `@setu-ts/common` also gains `serializeError` /
  `SerializedError`, a pure serializer that turns any thrown value into a plain object with a
  bounded `cause` chain.
- **`INotifier.sendSettled?` and `ChannelSendResult` in `@setu-ts/common`** (M70f, X8-12). An
  optional, non-throwing twin of `send` that reports one `{ channel, ok }` result per requested
  channel (a failure carrying its serialized error), so a caller behind a retrying queue can retry
  the one failing channel instead of re-sending the whole notification. `NotificationService`
  implements it; `send`'s `AggregateError` members now each **name their channel**
  (`"channel '<name>' failed"`), the original error riding on `cause`.
- **Reachability-aware health signals for six infrastructure plugins** (M70c). `messaging-plugin`,
  `realtime-backplane-plugin`, `storage-plugin`, `mail-plugin`, `queue-plugin`, and
  `service-discovery-plugin` now report a backend's _reachability_, not just its lifecycle. Each
  provider/broker/adapter gains an optional `isHealthy()` probe (a `PING`, a `HEAD`, a
  `GetQueueAttributes`, Consul's `/v1/status/leader`, a Kubernetes `limit=1` EndpointSlice LIST),
  and each plugin's indicator maps the two signals — `isReady()` (lifecycle) and `isHealthy()`
  (reachability) — to a status. A configured backend that is down is now `down` (or `degraded` for
  the backplane, whose local delivery still works) instead of `up`. An unprobeable provider honestly
  reports `data.reachable: 'unknown'` rather than claiming health.
- **`createCachedProbe(options)` and `CachedProbeOptions` in `@setu-ts/common`** (M70c). A small
  pure helper that wraps a reachability check in a cache so a health scrape does not become load
  against the backend: the outcome is cached for `ttlMs` (default 5000) measured on an injected
  **monotonic** clock, concurrent callers during one in-flight probe share a single probe call, and
  each probe is bounded by `timeoutMs` (default 2000) on an injected timer seam
  (`setTimer`/`clearTimer`, defaulting to the ambient ones) so a custom `IRuntimeServices`' timers
  are honoured rather than bypassed. A probe that rejects, throws, or exceeds its timeout resolves
  `false` — the returned function never rejects. Reporting _unprobeable_ is the caller's job, not
  the helper's: a port that implements no probe is what each plugin's indicator surfaces as
  `data.reachable: 'unknown'`.
- **`ReconnectSupervisor` in `messaging-plugin`** (M70c). A `drive`-mode broker (RabbitMQ — amqplib
  has no reconnection of its own) now re-establishes its connection on loss through a backoff-driven
  supervisor instead of failing open, re-asserting the exchange and replaying every active
  subscription. Retries are **unbounded** by design, with full-jitter exponential backoff capped at
  30s: an outage longer than any attempt cap is exactly the case that must still self-repair, and
  the health signal reports the fault throughout. A single connection loss opens exactly one attempt
  loop even when the client reports it through more than one event (amqplib emits `'error'` and then
  `'close'`). The broker exposes a `reachability()` that distinguishes "connected and answering"
  from "connected but the backend stopped answering".
- **`docs/health-indicators.md` and `test/health-indicator-audit.test.ts`** (M70c). A classification
  of every `ctx.health.register` site in the framework — `live-state`, `justified-literal`, or
  `configuration-literal` — enforced by a test that fails if a new (or moved) indicator is added
  unclassified. Five out-of-scope `configuration-literal` sites that hide a real backend are
  recorded in `smoke/DEFECTS.md` (H-70c-1…H-70c-5).
- **Worker pool metrics** (M45b). With `@setu-ts/metrics-plugin` registered,
  `@setu-ts/worker-pool-plugin` now publishes six Prometheus series, all labelled `task_module`:
  gauges `worker_pool_workers`, `worker_pool_busy_workers`, `worker_pool_queued_tasks`, and counters
  `worker_pool_tasks_completed_total`, `worker_pool_tasks_failed_total` and
  `worker_pool_tasks_rejected_total` (the last two also labelled `reason`). Pool saturation was
  previously answerable only by polling `/health` and diffing counts by hand. **Nothing is
  configured and nothing changes without the metrics plugin** — the instruments exist exactly when
  `CAPABILITIES.METRICS` does, there is no new plugin option, and no export was added. The gauges
  are written from the same snapshot the `worker-pool` health indicator reads, so the two surfaces
  cannot disagree, and no polling interval is armed. `..._failed_total` summed over `reason` equals
  the health payload's `failed`; `..._rejected_total` covers refusals that never became tasks
  (`queue_full`/`pool_closed`/`unavailable`), which the health payload cannot see at all.

- **`setu add <plugin>`** — installs a framework package into the current project, pinned to the
  version of the CLI that added it, and updates `deno.json` and `package.json` when a project
  carries both. Accepts a short name, the bare package name, or the full specifier (`setu add auth`,
  `setu add auth-plugin`, `setu add @setu-ts/auth-plugin`). It writes the manifest and reports
  `deno install --min-dep-age 0` rather than running it — on release day the pin is younger than
  Deno's dependency-age policy, so the flags need to be visible. Both places that used to say
  "install `@setu-ts/auth-plugin`" now name this command.
- **`IRuntimeServices.onSignal?(signal, handler)`** and the `RuntimeSignal` type in
  `@setu-ts/common`, implemented by the Node, Deno and Bun runtime adapters. Optional on the
  established `fs?` / `workers?` / `dns?` precedent: it is **omitted** on Cloudflare Workers (an
  isolate is evicted, never signalled) and on Deno for Windows (`addSignalListener('SIGTERM')`
  throws there), so a caller reads it with `?.` and gets a correct no-op rather than a crash.
- A generated project's `main.ts` now installs a graceful-shutdown handler through that seam, and
  **one body serves Deno, Node and Bun byte-identically**. It reaches no runtime-specific API at all
  — no `Deno.addSignalListener`, no `Deno.exit`, no `process.on`, no `Deno.build.os` check — so
  moving a project between runtimes no longer means rewriting its entry point.
- `setu generate migration` now emits a managed `src/migrations/index.ts` listing every migration in
  filename order and a project-local `src/migrations/run.ts` that applies them, run with
  `deno run -A src/migrations/run.ts` (add `--down` to reverse). The migration it wrote was
  previously an orphan that nothing imported and nothing could run.
- Every template emits a `test` task, so the `*.service.test.ts` that `setu generate module` writes
  is reachable at all — and on each target it emits a harness that target can actually execute.
  `@std/testing/bdd` reaches `Deno.test` internally, so the test it used to emit everywhere died on
  Bun with `ReferenceError: Deno is not defined` before a single assertion ran. Bun and Node now get
  `bun:test` and `node:test`, which are built in, so those two targets also stop declaring
  `@std/testing`/`@std/expect` — two dependencies that could only fail there.
- `setu generate` detects the target runtime from the project's own manifests instead of assuming
  Deno whenever `--runtime` is absent, which nobody passes. `setu new svc --runtime bun` records the
  choice once and every later `generate` now honours it.
- `IRequest.raw?: Request` and `IRequestContext.raw?: Request` — the undisturbed web `Request`,
  attached by the HTTP adapter beside the mapped request whose body has been buffered. Optional, so
  existing implementors are unaffected; the kernel treats an absent `raw` as neither an upgrade nor
  RPC and falls through to the `404`.
- `UPGRADE_INTENT`, `WebSocketUpgradeIntent`, `setUpgradeIntent`, `upgradeIntentOf` in `common` —
  how the kernel tells the adapter to perform a handshake it has already authorized.
- `isWebSocketUpgradeRequest` in `common` — the shared RFC 6455 §4.2.1 predicate. `@setu-ts/runtime`
  re-exports it rather than keeping a second copy, so its published surface is unchanged.
- `IWebSocketService.routeUpgrade?` and `IGrpcService.claims?` — both optional, so existing
  implementors keep compiling. `claims` is the path guard that keeps an ordinary `404` intact.
- `inject()` now populates `IRequest.raw`, so an injected request can exercise the upgrade and gRPC
  paths instead of silently falling through to the `404`.
- **`CacheMiddlewareOptions.vary`** — a per-request discriminator whose values are length-prefixed
  into the cache key after the tenant segment, for any dimension beyond the tenant.
- **`MultiTenancyPluginOptions.exclude`** — paths that skip tenant resolution entirely, defaulting
  to the operational probes the framework's own plugins serve (`/live`, `/ready`, `/health`,
  `/metrics`, `/openapi.json`, `/docs`). Pass `[]` to exempt nothing. See **Changed**.
- **`SessionPluginOptions.tenantBinding`** (default `true`) — seals the resolved tenant into the
  session and refuses a mismatch with `403`.
- **`ErrorHandlerOptions.maskInternalErrors`** (default `true`) — see **Security** and **Changed**.
- **`FlagContext.tenantId`** (in `@setu-ts/common`) and **`FlagDefinition.tenants`** — both
  optional, so every existing caller, implementor, and flag definition is source-compatible.
- **A factory arm on the four registration seams** (M70d). `CqrsPluginOptions.commandHandlers`,
  `queryHandlers` and `behaviors`, `EventsPluginOptions.handlers`, and
  `HealthPluginOptions.indicators` each accept, beside the instance, a factory —
  `RegistryFactory<T> = (services: IServiceRegistry) => T` (new, `@setu-ts/common`). A factory is
  resolved at the `onInit` phase — the first phase at which the registry holds every capability —
  and its result is registered exactly as the instance arm would be, so a generated handler or
  indicator can build a capability (the event bus, a database, the logger) at startup. Instance
  entries keep their `register()` timing byte-identically, so an existing configuration is
  unchanged. A factory that throws rejects `start()`, naming the option and the entry, with the
  original error preserved as `cause` (through `resolveRegistryEntry`, also new in
  `@setu-ts/common`).
- **`DatabaseAdapterOptions.provider`**, the exported **`PrismaSqlProvider`** type, and
  **`UnsupportedFilterOperatorError`** — see **Changed** for the `contains` behaviour they govern.
- **Telemetry auto-instrumentation outcomes are now reported, not silent** (M70e). The
  `instrumentations` registry reports every outcome through the plugin's logger (`ctx.logger`, read
  at call time): an enabled instrumentation logs one line at `debug`, a loader or enable failure one
  line at `warn` carrying `kind` and `reason`. A failure remains a documented no-op — it is still
  never thrown — but it is no longer invisible. The plugin declares the logger capability in
  `optionalDependencies`, so the kernel registers a plugin-provided logger (e.g. `LoggerPlugin`)
  before it and the standard configuration (`RuntimePlugin` + `LoggerPlugin` + `TelemetryPlugin`)
  reports every outcome; without any logger plugin the app still boots and the outcomes are recorded
  on the registry handle with nothing emitted. The five instrumentation loaders' default importers
  now take zero arguments (the specifier is a literal inside the default), so the default path is
  the one a published artifact can actually run.
- **A recurrence gate for computed `import()` specifiers** (M70e). `scripts/npm-specifier-audit.ts`
  walks every `packages/*/src` file and refuses any dynamic `import()` whose first argument is not a
  string literal, unless the call carries a `computed-specifier: <reason>` marker (an empty reason
  is rejected). `test/npm-specifier-gate.test.ts` runs it on every suite run, and
  `deno task release:verify` enforces it as check 6, so the X7-3 shape (a specifier routed through a
  variable that JSR's static npm-compat rewrite cannot reach) cannot re-enter the source tree.

- **Scheduler multi-instance deduplication** (M70l, X10-2). A `cron` or `every` fire claims a slot
  lock keyed on the fire's intended time (`scheduler:job:<name>:<slot>`) which is **never released**
  and expires on `ttlMs`, so replicas sharing one lock backend run an intended fire exactly once
  between them — a guarantee that holds only while `ttlMs` exceeds the maximum skew between
  replicas, since the TTL is how long a claimed slot stays remembered. A `delay` job differs: its
  slot is keyed on the job name (`scheduler:job:<name>:once`), claimed at REGISTRATION rather than
  at fire time, and **released** when the entry leaves the registry, so re-registering the name
  after it fired fires again. The existing per-handler mutex is kept unchanged for overlap
  protection. `MemoryLock` now sweeps every expired entry on `acquire`, because a recurring slot key
  is never released and never reacquired, so the previous lazy per-key delete could never reclaim it
  and the map grew one entry per job per fire, forever.

- **`MetricsPluginOptions.excludePaths`** (M70l, X10-7). Request paths the HTTP metrics middleware
  skips entirely. When supplied it REPLACES the default `['/health', '/live', '/ready']`; the
  plugin's own scrape endpoint is always excluded either way, so `/metrics` no longer counts its own
  scrapes or the health probes.

- **Generated Kubernetes members carry the chart's graceful-shutdown pieces** (M70l, X10-4/X10-6).
  `setu generate app` now emits `lifecycle.preStop.sleep.seconds: 5` (Kubernetes 1.30+) on every
  container, and `prometheus.io/scrape|port|path` annotations on members generated with a template
  (recorded via the new `metricsEndpoint` field of `setu.workspace.json`; absent means unknown and
  emits none).

- **`SchedulerUnavailableError`** (M70l, X9-2). `SchedulerPlugin.register()` refuses to register on
  Cloudflare Workers, where its timers cannot fire, naming `WorkersCron` and `[triggers] crons` as
  the replacement.

### Changed

- **Breaking: `ctx.state` keys now use the owner-prefixed convention** (M71). Migrate literal
  readers from `'clientIp'` to `'http-security-plugin:client-ip'`, `'__he_telemetry_span'` to
  `'telemetry-plugin:span'`, `'validated:<target>'` to `'validation-plugin:validated-<target>'`,
  `'setu.error.responder'` to `'exceptions:error-responder'`, and `'setu-ts:session'` to
  `'session-plugin:session'`. Prefer `CLIENT_IP_STATE_KEY`, `TELEMETRY_SPAN_KEY`,
  `validatedStateKey`, and `ERROR_RESPONDER_STATE_KEY` where those exports are available;
  `SESSION_STATE_KEY` is exported from its own module but is not a public package export, so read a
  session through `getSession(ctx)` rather than the key.
- **Breaking: application-scoped registry mutation now stops after bootstrap** (M71). Plugins that
  retain a context and call `register`, `registerFactory`, or `unregister` after `runBootstrap()`
  now receive an error. Register during `register()`, `onInit`, or `onBootstrap`; use the
  request-scoped `ctx.services` in middleware for per-request services.
- **Breaking: request identity fields reject a second implicit assignment** (M71). `request.user`
  and `request.tenant` permit one assignment and then throw; use `replacePrincipal` or
  `replaceTenant` for a deliberate replacement. This is an accidental-overwrite guard, not an
  authorization boundary: a write before authentication remains a permitted first write.

- **BREAKING: `@ValidateBody(schema)` (and `@ValidateQuery`/`@ValidateParams`) now enforce their
  schema by default** (M70n, E1). The decorators shipped as inert metadata — a decorated route
  accepted any body — so an application upgrading that carries a decorated route whose body its
  schema rejects starts answering `400` with no configuration change. Enforcement appends the
  validation capability's middleware LAST in the route's chain (innermost, after guards), preserving
  guard `401`/`403` precedence; with no validation provider registered the schema stays
  description-only and ONE warning per route names the controller, handler, targets and
  `ValidationPlugin`. **Migration:** pass `DecoratorPlugin({ enforceSchemas: false })` to keep the
  previous description-only behaviour.

- **BREAKING: the default session cookie is renamed `hono_session` → `setu_session`** (M70n, X9-10).
  The framework is not Hono, and the rename only gets more expensive with every release that ships
  it. In-flight sessions are invalidated at deploy: every user is logged out once. **Migration:**
  pin `SessionPlugin({ cookie: { name: 'hono_session' } })` for one `maxAge` window to preserve live
  sessions, then drop the pin.

- **BREAKING: `IResponse` gains a REQUIRED `html(body)` member** (M70n, X4-11), implemented in the
  kernel's `ResponseBuilder` and `testing`'s `MockResponse`. It sets
  `content-type: text/html; charset=utf-8` — the charset is not optional, because a bare `text/html`
  lets a browser sniff the encoding. **Migration:** an out-of-repo `IResponse` implementor adds the
  member; every caller-side use is source-compatible.

- **BREAKING: the `cacheControl` callback receives a leading-slash path** (M70n, C5/D8). The value
  was slash-less for a file (`assets/app.js`) but the literal `'/'` at the prefix root, while the
  docs said only "root-relative" — a callback written against one observed shape was silently wrong
  for the other. Both shapes are now normalised to a leading slash (`/assets/app-A9acsx54.js`, `'/'`
  at the root) and documented as such. **Migration:** a callback comparing against a slash-less form
  (e.g. `path.startsWith('assets/')`) changes to `/assets/`; one matching on extensions or the root
  literal is unaffected.

- **`WorkersCron.dispatch` now rejects on failure instead of always resolving** (M70l, X9-5).
  **Breaking.** A firing trigger with no registered handler throws naming the expression; one or
  more rejecting handlers run to settlement — a failing handler still never abandons the others —
  and then `dispatch` throws an `AggregateError` carrying every failure. `createScheduledHandler` is
  a bare delegation, so the rejection reaches Cloudflare and counts the whole invocation as failed:
  that is the signal, and it needs no logger configuration. A configured logger still receives both
  reports first. An application that wants the old fire-and-forget behaviour wraps its own handlers
  in `try`.

- **The generated Cloudflare Workers `fetch` export no longer propagates a failed boot** (M70l,
  X9-8). A boot error (a mistyped binding, a broker briefly down at cold start) is now logged to the
  platform's console and answered with a generic `503 Service Unavailable` — the stack never reaches
  the client. The failed boot promise is cleared, so the next request re-attempts the boot rather
  than being pinned to the failure for the isolate's life. An application that wants the error body
  can wrap its own handler around `app.fetch`.

- **The generated Dockerfile folds `chown -R` into the dependency-cache layer** (M70l, X10-5). A
  standalone `chown -R` rewrites metadata on every file the cache layer created, so overlayfs copied
  the ENTIRE Deno module cache into a second layer — measured at 563 MB vs 362 MB with the fold,
  paid on every push and every node pull. Image contents are unchanged; only the layer layout
  differs, so existing deployments need no action beyond the next rebuild.

- **`every` jobs arm on an absolute epoch grid** (M70l, X10-2). The first fire lands on
  `(floor(now / interval) + 1) * interval` rather than a full interval after registration, at
  registration, re-arm, and resume alike. The period is unchanged; only the phase moves, and the
  fire is never LATER than before — it may come sooner than one full interval after registration, so
  a job assuming "I have been up a full interval" behaves differently. This is what makes replicas
  started at different instants agree on distributed-lock slot keys. **Breaking (resume contract):**
  the released contract stated that resuming an `every` job restarts the interval "from now";
  resuming now lands the next fire on the next epoch grid boundary instead. The implementation has
  always resumed on the grid (that is the alignment replicas need to agree on slot keys), so the
  contract and `PUBLIC_API.md` are corrected to match — a resumed fire may come sooner than one full
  interval after `resume()` (never later).

- **`RabbitMqBroker` declares its queues with the shape their subscription implies** (M70l, X10-1).
  **Breaking.** A caller-supplied queue name (a consumer group) is declared `{ durable: true }` — it
  survives a broker restart, which is what `queue` documents; the private per-subscriber queue and
  the RPC reply inbox are declared `{ exclusive: true, autoDelete: true }`. The previous
  unconditional `{ durable: false }` named non-exclusive form is refused by RabbitMQ 4 outright
  (`541 INTERNAL-ERROR … transient_nonexcl_queues`). CI's RabbitMQ service moves to major version 4
  with this change.

  **Migration — deployments upgrading against an EXISTING broker.** A named consumer-group queue
  that the old client created as `{ durable: false }` cannot be re-declared `{ durable: true }`:
  RabbitMQ answers `406 PRECONDITION_FAILED` and closes the channel, so every subscriber on that
  queue stops until the queue is redeclared. To restore service, delete the existing non-durable
  queue (drain it first if in-flight messages must be preserved — a non-durable queue's contents are
  lost on broker restart anyway) and let the new client re-declare it as durable:

  ```bash
  rabbitmqadmin delete queue name=<consumer-group-queue>
  ```

  Deployments whose brokers are provisioned fresh (or whose queues were already declared durable)
  see no change. Private per-subscriber queues and the RPC reply inbox are exclusive/auto-delete and
  are recreated per connection; they never carry this problem.

- **Reused OpenAPI schemas are deduplicated symmetrically, and named from their first use** (M70m,
  X11-6). The first use of a reused schema was inlined and never rewritten, so one shape appeared
  **both inline and as a `$ref`** in one document, under the meaningless name `Schema1`; and a
  schema nested inside another was not counted at all, so two structurally identical cases behaved
  differently. Every site of a reused schema now carries a `$ref`, nested schemas are deduplicated
  too, and a hoisted component is named from the site that first reached it
  (`GetOrdersByIdResponse404`). **A generated client's component type names change accordingly** —
  regenerate it. A reused primitive stays inline: a `$ref` to `{"type":"string"}` is larger than the
  schema it replaces.
- **`operationId` no longer carries path braces** (M70m, X11-8). `GET /orders/{id}` derived
  `get-orders-{id}`, which Redocly's recommended ruleset flags as URL-unsafe and which breaks any
  tool that puts an `operationId` in an anchor, a filename or a URL. It is now `get-orders-by-id`.
  **This renames generated client methods** — `getOrdersId` becomes `getOrdersById` — so regenerate
  clients and update call sites. Nothing else reads an `operationId`.
- **Breaking (behaviour): an operation's `requestBody` and `parameters` are now derived from its
  validation middleware** (M70m, X11-5). Derivation is ON by default, so the document emitted for
  any application whose routes carry `validateBody`/`validateQuery`/`validateParams`/
  `validateHeaders` changes without a configuration change, and a derived route also gains a `400`.
  Regenerate any committed client. `OpenApiPlugin({ deriveRequestSchemas: false })` restores the
  previous request shape — and nothing else; see the two entries below.
- **Breaking (behaviour): operational routes are no longer documented** (M70m, X11-8). `/health`,
  `/live`, `/ready` and `/metrics` are excluded by default via the new `excludeOwners`. A
  regenerated client therefore NO LONGER declares `getHealth`, `getLive`, `getReady` or
  `getMetrics`, so any call site using one stops compiling — that is the intended correction, since
  those operations were the application's operational surface rather than its API. Pass
  `excludeOwners: []` to document them again.
- **Breaking (behaviour): CORS no longer refuses `content-type` while advertising `POST`** (M70m,
  X11-3). `CorsOptions.allowedHeaders` defaulted to `[]` while `methods` defaulted to every standard
  verb, so a preflight offered `POST`/`PUT`/`PATCH`/`DELETE` and then carried no
  `Access-Control-Allow-Headers` — every browser blocked every JSON request made against the
  configuration the README itself showed. Omitting the option now ECHOES the preflight's
  `Access-Control-Request-Headers` for an allowed origin and adds
  `Vary: Access-Control-Request-Headers`. An explicit list still allows only those headers, and an
  explicit `[]` still allows none, so any application that configured the option is unaffected. The
  origin allowlist — the actual security boundary — is unchanged, and a denied origin echoes
  nothing.
- **Generated SDK client source is `deno fmt`- and `deno lint`-clean** (M70m, X11-9). It emitted
  4-space indentation against the 2-space config every scaffolded project ships, left nested inline
  object types unindented, and opened with a blanket `deno-lint-ignore-file` carrying no rule list —
  so codegen output could not be committed to a scaffolded project without formatting a file whose
  header forbids editing it. Output is now 2-space and depth-indented, signatures past 100 columns
  wrap one parameter per line, a path template too long for one line is emitted as an equivalent
  `[…].join('')`, an empty-object schema emits `Record<PropertyKey, never>` rather than the
  `ban-types`-rejected `{}`, and no pragma is emitted at all. The two committed generator-output
  fixtures were removed from `deno.json`'s `fmt.exclude`, so the repository's own `fmt` and `lint`
  gates now enforce this permanently. Every multi-line type is also **hoisted into an exported
  alias** rather than written inline at a use site — an inline (non-`$ref`) request body, parameter
  or success response was emitted at whatever indentation its use site sat at, and a success type is
  written at TWO indentation levels at once, so no single indent could be correct. Both original
  fixtures name every schema through `$ref` and so could not show it, while a schema derived from
  validation middleware and used once arrives inline; a third fixture generated from an
  inline-schema document now covers the case.
- **`GrpcPlugin`'s `basePath` now defaults to `/` (the root), and native gRPC-binary requests are
  refused with `UNIMPLEMENTED`** (M70i, X7-2 / X7-4). The old default `'/grpc'` was unreachable by
  every native client — a gRPC path comes from the method name alone, and no client has a prefix
  option. RPC detection stays segment-aware, so ordinary routes like `/grpcfoo` are untouched.

  **Migration — applications that relied on the default.** If you pointed clients at
  `http://host:3000/grpc/<service>/<method>`, either pass `basePath: '/grpc'` explicitly or point
  the client at `http://host:3000/<service>/<method>`. Applications that already set `basePath`
  explicitly see no change.

  Native gRPC-binary requests (`application/grpc`, `application/grpc+proto`,
  `application/grpc+json`) are answered with a Trailers-Only `UNIMPLEMENTED` (`grpc-status: 12`)
  instead of reaching Connect's handler, where every call failed with an opaque "missing status"
  transport error after a successful handshake: no runtime on which the plugin loads exposes the
  HTTP/2 trailers the native protocol requires. **Connect (`application/connect+*`) and gRPC-Web
  (`application/grpc-web+*`) remain fully supported** on all runtimes; point native gRPC clients at
  a gRPC-Web-capable proxy or switch them to Connect.

- **`graphql-plugin`: resolvers can be typed without casts, and the WebSocket context no longer
  pretends to carry an HTTP request** (M70i, X6-4 / X6-6 / X6-7). `FieldResolver` is generic
  (`FieldResolver<TSource = unknown, TContext = unknown, TArgs = Record<string, unknown>>`; existing
  all-`unknown` resolvers stay assignable), and `DefaultGraphqlContext` is typed against
  `@setu-ts/common` (`services: IServiceRegistry`, `user?: IPrincipal`, `tenant?: ITenant`). Over
  HTTP the context is `{ services, requestContext, user?, tenant? }`; over WebSocket it is
  `{ services, connection }` and **`requestContext` is absent** — the upgrade request is closed once
  the handshake response returns, so a synthesized one would be dead by resolver time. The upgrade
  request's headers/query live on `connection.headers`/`.query`. `requestContext` is therefore typed
  optional; code that dereferenced it must narrow first.

  A resolver's `ctx.services` is now the live registry on **every** entry point. `execute()` and
  `subscribe()` take their request context optionally, and a call passing only `params` previously
  received `{}` there — so `ctx.services.get(...)`, which `services: IServiceRegistry` now invites
  without a cast, threw a `TypeError` that error masking reported as `Internal server error`. The
  fallback is the plugin-level registry instead.

  APQ refusals now follow the documented media-type watershed from one owner: under
  `application/json` an APQ miss answers `200` with `PersistedQueryNotFound` in the body (the one
  error a client must read and retry); under `application/graphql-response+json` it carries the
  resolver's own status.

- **BREAKING: `StoragePluginOptions` is now a union discriminated on `provider`** (M70k, X8-11). One
  unknown key used to make the compiler report EVERY property of the literal as
  `not assignable to type 'never'` while never naming the offending one, because the union's first
  member was `MemoryProviderOptions = Record<string, never>` — which accepts any object shape while
  requiring every property to be `never`. Discriminating the union alone did NOT fix the reporting
  (measured); removing that member did. **Migration:** `provider` stays optional on the memory arm,
  so `StoragePlugin()` and `StoragePlugin({ provider: 'memory' })` are unchanged. Every other arm
  now requires its own `options` and its required fields — `bucket` for `'s3'`/`'b2'`/`'gcs'`,
  `containerName` for `'azure'` — which were previously runtime failures. `MemoryProviderOptions` is
  removed; the memory arm takes no `options`, so drop `options: {}` if you passed it.
- **`IAwsS3Client` is renamed `IS3Backend`, with the old name kept as a deprecated alias** (M70k,
  X8-10). The old name promised something it never was: `@aws-sdk/client-s3`'s surface is
  `send(command)`, so injecting a real `S3Client` was refused with
  `Injected S3 client is missing required methods`. What the type declares is the backend surface
  this package's own adapter PRODUCES. **Migration:** rename the import; the shape is unchanged, and
  the alias keeps existing code compiling in the meantime (AI_GUIDELINES §9.2 — the replacement is a
  working, identical shape, so a rename does not need to be a compile error). There is still no
  supported way to configure the underlying SDK client.
- **BREAKING: `WebWorkerLike` requires `addEventListener`** (M70k, X8-7). A real web `Worker` is an
  `EventTarget`, and the worker-exit signal needs it. **Migration:** an injected fake worker must
  add the method; a real `Worker` already satisfies it.
- **Upload size refusals answer `413` rather than `400`** (M70k, X8-3). A body over the parse bound
  and a file over `maxSize` are now `413 Request entity too large` / `413 File too large`; a
  malformed body, a disallowed MIME type and too many files remain `400`. Telling a client its
  request was malformed when it was merely large sent it to the wrong fix.
- **`LocalStorageProvider.connect()` proves its root is writable and refuses to start otherwise**
  (M70k, X8-9). It also became a rejection rather than a synchronous throw, so a caller using
  `.catch()` on this `Promise`-typed method reaches it. **Migration:** none for a working
  configuration; a root the process cannot write now fails at startup naming the cause — and, on
  Deno, naming `--allow-write` — instead of failing every upload while `/health` reported `up`.

- **BREAKING (types only): a `'prisma'` or `'drizzle'` registration must now name the options its
  adapter cannot run without** (M70j, D7). `DatabasePluginOptions` is a union discriminated on
  `type`, and its built-in arm made every adapter-specific field optional on a nested bag, so
  omitting one was a runtime throw at `connect()` rather than a compile error — unlike the
  `'custom'` arm, which has required `adapter` since M52c. `type: 'prisma'` now requires
  `options.prismaClient` and `type: 'drizzle'` requires both `options.drizzleInstance` and
  `options.drizzleTables`. **Only a registration that already failed at startup stops compiling**,
  and the runtime guards are unchanged, so a JavaScript caller sees exactly what it saw before.

  ```typescript
  // Before — compiled, then threw at app.start()
  DatabasePlugin({ type: 'prisma' });
  DatabasePlugin({ type: 'drizzle', options: { drizzleTables: { User: users } } });

  // After
  DatabasePlugin({ type: 'prisma', options: { prismaClient } });
  DatabasePlugin({
    type: 'drizzle',
    options: {
      drizzleInstance: createDrizzleDatabase(db, (database, work) => database.transaction(work)),
      drizzleTables: { User: users },
    },
  });
  ```

- **BREAKING (behaviour): the Memory adapter refuses an unknown `select` or `orderBy` column**
  (M70j, X12-5). The **default** adapter used to accept both silently — a projection quietly lost
  the field and a sort quietly returned rows in insertion order — while Prisma and Drizzle answered
  `500` for the identical call, so a rule proved in development became a production failure. A field
  that **no stored row carries** is now refused with the entity, the clause and the observed column
  list, matching Drizzle's message. A field present on at least one row counts as known, and an
  entity holding no rows accepts anything. `where` and `filter` are deliberately unchanged: with no
  schema this adapter cannot tell an unknown column from one absent everywhere, and matching nothing
  is a defensible answer. If a projection over a column that has never been written is intentional,
  write the column (even as `null`) on one row, or list only fields the store has seen. Uniqueness
  and column types remain unenforced and cannot be enforced by a schema-less store — the package
  README now states that plainly.

- **The Drizzle table registry validates `id` lazily** (M70j, X4-9). `connect()` refused **every**
  registered table without an `id` column, so a composite-key join or per-tenant table registered
  only for the typed query builder made the whole registry unusable. The registry now accepts any
  table definition; a repository for an `id`-less table is refused by name at `getRepository()`,
  where `IRepository`'s single-key contract actually applies. Strictly widening — no configuration
  that worked before changes.

- **Error bodies now answer in the application's configured format (X4-8, C3)** (M70f). Every
  short-circuiting site — the kernel's 404/400/503/500 terminals, `createUploadMiddleware`'s
  rejections, the multi-tenancy `400`, the session tenant-mismatch and form-CSRF `403`s, the auth
  guards, the http-security `413`/`403`s, and the feature-flag guard — now writes its body through
  the responder seam, so an `errorHandler({ format: 'rfc9457' })` governs them all.

  **Migration — with `errorHandler` registered (every CLI template and starter).** This is the case
  that changes, and it changes for every one of these sites: they previously bypassed the configured
  format and answered their own `application/json` body, and they now answer in it. Under
  `format: 'rfc9457'` a rejection that was
  `{"error":"Too many files","detail":"Maximum 3 file(s) allowed"}` (`application/json`) becomes
  `{"type":"about:blank","title":"Bad Request","status":400,"detail":"Maximum 3 file(s) allowed","instance":"/upload"}`
  (`application/problem+json`). **A client that branched on the `error` member must read `detail`
  instead** — the site-specific label (`Too many files`, `Tenant Required`, `Tenant Mismatch`,
  `Invalid MIME type`) is no longer a body member, because RFC 9457 §4.2 requires `title` to be the
  status title for the `about:blank` problem type. Under `format: 'default'` the label is the
  `message` member and the disclosure is `details.detail`. There is no option that restores the
  pre-M70f ad-hoc bodies; answering in the configured format is the defect being fixed (X4-8).

  **Migration — with no `errorHandler` registered.** Sites that answered `{ error, message }` now
  answer `{ error, detail }` (the disclosure moves from the non-standard `message` key to the RFC
  9457 `detail` key), and the feature-flag guard's bare `text/plain` `Not Found` is now the JSON
  fallback `{"error":"Not Found"}`.
- **`IGrpcService.addService`'s `implementation` parameter is now `unknown`** (M70f). It was
  `Partial<ServiceImpl>`, an index-signature type that **rejects a class instance** — whose methods
  live on the prototype rather than as own properties — although Connect accepts one, so a
  class-based service implementation could not be passed without a cast. Widening is
  source-compatible for callers: an implementation that type-checked before still does.
  **`ServiceImpl` is removed** from `@setu-ts/common` — the widening left it with no reader anywhere
  in the framework, and while the project is in prerelease a dead export is deleted rather than
  carried as deprecated surface. **Migration:** drop any `as Partial<ServiceImpl>` cast or
  `ServiceImpl` annotation at an `addService` call site and pass the implementation directly.
- **An unhandled request error is now logged by the kernel (X11-2)** (M70f). The fallback `500` path
  previously discarded the error and logged nothing even with `LoggerPlugin` registered; it now
  reports the message and stack through `CAPABILITIES.LOGGER` (guarded so a missing or broken logger
  degrades silently). The response body stays opaque — the message is not disclosed to the client.
- **A raw `Error` in log metadata no longer serializes to `{}` (X2-5)** (M70f). The console and pino
  loggers normalize any `Error` value in merged metadata through `serializeError` before redaction,
  so **any** call site is safe on those two loggers, and the two known raw-`Error` call sites
  (`events-plugin`'s handler failure and `errorHandler`'s `cause`) serialize explicitly, so those
  stay correct on a third-party `ILogger` too. A third-party logger does not normalize, so a NEW
  call site handing it a raw `Error` can still render `{}` — pass `serializeError(err)` there.
- **A gRPC handler error is now logged (X7-5)** (M70f). `grpc-plugin` wraps each application handler
  so a thrown or rejected error is logged at `error` level with the procedure name and a serialized
  error, then rethrown — the masked wire response is unchanged. The logger is resolved at call time,
  so a logger registered after `GrpcPlugin` is still seen. `GrpcPluginOptions` gains
  `interceptors?: readonly unknown[]`, threaded into `createConnectRouter` (which previously dropped
  the argument its own facade declared).

- **Breaking (behaviour): a route that names its path now beats a catch-all, in either registration
  order** (M70g, X5-1/F1). The kernel's tie-break ranked candidates by static-segment count, and a
  `*` segment was COUNTED AS STATIC — so `GET /*` tied with `GET /openapi.json` and whichever
  registered first simply won. `ReactRouterPlugin` mounts its SSR catch-all at
  `PLUGIN_PRIORITY.NORMAL` (500) while `OpenApiPlugin` registers at `OPENAPI` (700), deliberately
  last so it can document every route, so **every full-stack application silently lost
  `/openapi.json` and `/docs`** to an SSR 404 page, with no error anywhere; the same shape removed
  those endpoints under a root-mounted `StaticPlugin`. `*` is now its own segment kind and the
  ranking is: more static segments, then FEWER wildcards, then earliest registration. That also
  corrects an inversion — `/a/*` outranked `/a/:id` in both orders. **Migration:** an application
  relying on a catch-all registered first to shadow a later single-segment route now serves the
  later route. The shadowed route was unreachable by accident rather than by configuration, so the
  change is toward what the developer wrote; a route that must not be reachable should not be
  registered. Known limit: the rule compares counts rather than positions, so `/a/*` loses to
  `/:x/b` on `/a/b`.
- **Breaking (message): the duplicate-route refusal now names the plugin that registered the route
  first** (M70g, X5-6/X4-4). `Route 'GET /*' is already registered.` became
  `Route 'GET /*' is already registered by plugin 'react-router'.`, or `… by the application.` for a
  route the application registered itself. The old message named the pattern and the SECOND
  claimant, which the stack trace already carried; the missing half was who held it. **Migration:**
  a test asserting the exact old string needs the suffix; the message is otherwise unchanged.
- **Breaking (behaviour): `setu generate` no longer lists a hand-registered module in the generated
  barrel** (M70g, X4-4/F2). The seam scanner admits any file matching a family's suffix and exports,
  so a developer's own `src/controllers/admin.routes.ts`, wired by hand from `setu.config.ts`, was
  swept into the CLI-owned barrel by an UNRELATED `setu generate route report` — and since M68
  refuses a duplicate `METHOD path`, the application stopped booting, with an error naming two files
  the developer had not touched, from a command that reported success. A candidate whose symbol
  already appears in `setu.config.ts` is now left out of the barrel and reported — for a barrel that
  registers something, which excludes the functional `src/services/index.ts` re-export, where that
  symbol is the developer consuming the barrel exactly as its header documents. A file the barrel
  claims for the first time is reported as adopted, once, at the moment it happens. **Migration:**
  none for generated artifacts, whose symbols never appear in `setu.config.ts`. A project that
  deliberately wired a conventionally-named module by hand AND relied on the barrel registering it
  too was already failing to boot.
- **Breaking (behaviour): `setu generate health-indicator` refuses a name an installed plugin
  claims** (M70g, A1). `setu g health-indicator database` in a project with `DatabasePlugin` wrote a
  file, type-checked, and then threw `Duplicate health indicator name: "database"` at `app.start()`.
  Every plugin that registers an indicator claims a name, and fifteen of them claim exactly the ones
  reached for first — `database`, `cache`, `storage`, `session`, `events`, `mail`, `audit`, and
  more. The command now refuses before writing, naming the plugin. **Migration:** choose a qualified
  name (`billing-schema` rather than `database`), or remove the plugin.

- **Breaking (behaviour): the gRPC health bridge maps `degraded → NOT_SERVING`** (M70c, X7-8). It
  previously mapped `degraded → SERVING`, so a degraded process answered `SERVING` on
  `grpc.health.v1.Health/Check` while the health plugin's `/ready` already returned `503` — the two
  health faces of one process disagreed, and gRPC clients kept load-balancing onto a replica HTTP
  had taken out of rotation. **Migration:** a client that relied on `SERVING` while a process is
  degraded now sees `NOT_SERVING`; that is the agreement the framework's own default already
  produced on the HTTP side. `up → SERVING` and `down → NOT_SERVING` are unchanged.
- **Breaking (behaviour): a service-discovery indicator reports `down`, not `up`, when its backend
  was never reached** (M70c, X10-3). The old comment claimed `down` was "unreachable by
  construction", but a provider that never resolved (e.g. a Kubernetes API whose TLS the runtime
  rejects) reported `up` forever. The indicator now composes `everResolved` (set on the first
  successful read, never by a stale-cache serve) with the provider's reachability probe:
  never-resolved-and-unreachable is `down`, a stale cache or a just-unreachable warm cache is
  `degraded`, otherwise `up`.
- **Health indicators are projected to `{ status, data }`** (M70c, X3-7). An indicator's undeclared
  fields were previously echoed verbatim into `/health` — a returned `details` sat beside the
  built-ins' `data`. The health service now projects every result to the documented shape.

- **Breaking (behaviour): an unhandled non-`HttpError` 500 no longer carries its own message.**
  `maskInternalErrors` defaults to `true`, so the body's `detail`/`message` becomes the status
  title. **Migration:** nothing, if you were reading the message for diagnostics — it is still
  logged, in full, with its cause chain, exactly as before. Set `maskInternalErrors: false` to
  restore the previous body verbatim. A deliberately thrown `HttpError` (a message the developer
  chose for the caller) and every 4xx are never masked. Where a `maskInternalErrors: true` error
  would previously have carried a `stack` under `includeStackTrace: true`, it no longer does — a
  stack begins with the message that was just masked, so masking wins over that option.
- **Breaking (behaviour): `contains` on the Prisma adapter is now connector-aware, and is refused on
  SQLite.** Prisma emits a bare `LIKE` with no `ESCAPE` clause, so the value was matched as a
  **pattern**: a search for `%` returned every row in the table and a search for `50% off` matched
  rows that do not contain it. The value is now escaped on `postgresql`/`postgres`, `mysql`,
  `sqlserver` and `cockroachdb` (whose `LIKE` defaults its escape character to backslash), passed
  through unchanged on `mongodb` (whose `contains` is a `$regex` match, where `%` and `_` are
  already literal), and **refused** on `sqlite` with `UnsupportedFilterOperatorError`, because no
  escaping is expressible there through Prisma's filter API. **Migration:** a Prisma + SQLite
  application using `contains` must switch to a raw query or the Drizzle/Memory adapter — it was
  returning wrong rows before, silently. If the adapter cannot detect your connector it throws the
  same error naming the new `provider` option; pass `provider: '<connector>'` in the adapter
  options.
- **Breaking (cache keys): a tenant-aware application's cache keys change shape**, because the
  tenant segment is now part of them. The effect is a one-time cold cache on upgrade, not a
  correctness problem — expect a miss spike rather than investigating one. Keys in an application
  that resolves no tenant are byte-identical to before.
- **`MultiTenancyPlugin({ required: true })` no longer rejects the operational probes.** It answered
  `400` on `/live`, `/ready`, `/health`, `/metrics`, `/openapi.json` and `/docs`, which carry no
  tenant header — so a required-tenant deployment never passed the readiness probe in the Kubernetes
  manifests the CLI itself generates. Those six paths are now exempt by default. **Migration:** if
  your application serves its own business routes on any of those paths and wants them tenant-gated,
  pass an explicit `exclude` list (or `[]` to exempt nothing).
- **Breaking (generated layout): `src/routes/` is merged into `src/controllers/`.** A scaffolded
  project had two directories for HTTP endpoints, wired by two mechanisms, and `setu generate route`
  and `setu generate controller` each owned one — so "where does an endpoint go?" had two answers
  and the seam scanner could adopt a hand-written file from the other. There is now one directory
  and one barrel carrying both shapes.

  To migrate an existing project: move everything under `src/routes/` into `src/controllers/`,
  delete `src/routes/`, update the import in `setu.config.ts` from `./src/routes/index.ts` to
  `./src/controllers/index.ts`, and run any `setu generate` to regenerate the barrel. An un-migrated
  project degrades loudly rather than silently — the scanner reports each file it skipped and why.

- **Breaking (generated output): `setu generate module`'s barrel re-exports the service module
  rather than the stub symbol.** It emitted `export { listWidget } from './widget.service.ts'`, so
  replacing the generated stub — the obvious next step — broke the barrel with `TS2305`, and the
  barrel is not reachable from `deno check main.ts setu.config.ts`, so it stayed broken through a
  full green run of every gate. It is now `export * from …`. The generated test and route module
  still import the function by name, which is correct — they exercise and serve it. Existing
  projects need no change; regenerating replaces the named re-export.

- **Breaking (runtime host seams): `DenoHost`, `NodeHost`, `BunHost`, `NodeModules` and `BunModules`
  gained required members.** These are public type exports whose own JSDoc advertises injection as
  the supported way to test an adapter, so a consumer holding a hand-written fake now fails
  `deno check`: `DenoHost` needs `build: { os: string }` and `addSignalListener`, `NodeHost` and
  `BunHost` need `onSignal`, and both `*Modules.proc` need `on`. Add those members to the fake — the
  three fixtures in this repository needed exactly that. `IRuntimeServices.onSignal` itself is
  optional and source-compatible; only the injectable host seams are affected.

- **Breaking (generated output): a generated health indicator's shape now follows the project's
  generator mode.** A class-based project keeps today's class; every other project — which since M65
  includes `rest` and `microservice` — gets `export const <name>Indicator: IHealthIndicator`. An
  indicator generated before this therefore no longer matches what its barrel imports: it is dropped
  from the barrel, **its health check stops running**, and `setu generate` reports the file by name.
  Rename its export to the one reported, or delete it and regenerate. (The report used to say
  "regenerate it", which could not be followed — the file is not CLI-owned, so the overwrite check
  refused. It now names both routes out.)

- **Breaking (generated output): a CLI-generated registration artifact no longer registers until it
  exports a factory** (M70d). The CLI-owned barrel no longer constructs the artifact with `new X()`
  — it references an exported factory by name, and `setu generate` now emits that factory
  (`create<Pascal>…()`) in the artifact file itself. An artifact generated before this change
  exports no factory, so the seam scanner rejects it: it is left out of the regenerated barrel,
  **not registered**, and `setu generate` reports the file by name. **Migration:** add the two-line
  factory the new schematic emits —
  `export function create<Pascal>…(): <Pascal>… { return new <Pascal>…(); }` — or delete the file
  and re-run the schematic.
- **The `class-based` template now emits `DiPlugin({ autoRegister: true })`** (M70d, E3).
  `autoRegister` defaults to `false`, and both the container's external resolver and its registry
  fallback are gated on it — so a bare `DiPlugin()` could not resolve any `@Inject(CAPABILITIES.X)`
  at startup, and the entire plugin ecosystem was unreachable from a scaffolded class-based service.
  **Migration:** none for new projects; a hand-written `setu.config.ts` that relies on the container
  NOT falling back to the registry should pass `autoRegister: false` explicitly.

- The documented install lines and the generated `install` task pass `--min-dep-age 0`, matching the
  `minimumDependencyAge` the scaffolded manifest already set.
- A generated `full-stack` project can be started by following its own README: it emits
  `install`/`build` tasks and `start` depends on `build`, and it declares `nodeModulesDir` so
  `check:app` resolves on a cold checkout.
- The generated full-stack config resolver carries a return-type annotation, which restores
  excess-property checking. TypeScript does not apply it to an object literal returned from a
  contextually-typed callback, so a misspelled starter arm previously type-checked, booted, and
  reported nothing.
- Cloudflare Workers projects: `deno task start` serves instead of binding nothing and exiting `0`,
  post-response `waitUntil` work is no longer dropped, and the emitted `wrangler.toml` documents all
  the binding types most projects reach for.
- A `--transport rabbitmq` workspace passes its own `deno fmt --check`. Generated Markdown prose and
  plugin arguments are wrapped programmatically rather than hand-wrapped around whichever value the
  author happened to interpolate.
- Kubernetes probes generated for a workspace member select `httpGet` only when that member's
  template actually serves a health endpoint, and `tcpSocket` otherwise.
- `IGrpcService.available` is now unconditionally `true`. It reported whether the HTTP adapter
  implemented `setRpcHandler`; dispatch no longer depends on any adapter capability.
- A non-conformant WebSocket upgrade carrying a body is refused `400` by the kernel rather than
  failing inside the runtime's own upgrade call with a runtime-specific message. RFC 6455 forbids a
  body on the handshake.
- WebSocket upgrade **detection** moved from the HTTP adapter into `WebSocketService`'s own router,
  which is where a routing failure can still be logged. Behaviour on the wire is unchanged.
- Node's raw `upgrade` listener now refuses an unroutable upgrade with the status the pipeline
  produced (`404` for a path with no WebSocket route) rather than a fixed `400`.

### Fixed

- **Every doc site showed `authMiddleware()` registered at a priority its own architecture table
  does not grant it** (M70n, X3-1). `ARCHITECTURE.md` §10 reserves 300 for authentication, but a
  bare `app.middleware.add(authMiddleware())` takes the kernel default of 500 — AFTER every band in
  that table, so a hand-written global guard in any documented band rejected valid credentials while
  route guards worked. The README, both JSDoc examples and `PUBLIC_API.md` now write the explicit
  `{ priority: 300 }`, and §10 states that its priorities are conventional bands, not
  self-registrations, with 500 outside the table's range.
- **The backplane's documented partition guarantee was wrong for the first ~11 seconds** (M70n,
  X3-3). ioredis's default offline queue holds publishes during a short partition and delivers them
  LATE (measured ~5.9 s) — which an application told "frames during a partition are missed" will not
  defend against — until the `maxRetriesPerRequest` budget exhausts and drops them with a warn per
  frame. Both READMEs and `PUBLIC_API.md` document the actual shape; neither ioredis default is
  reachable through plugin options (inject a client pair to change it).
- **The websocket README nominated a cookie as the first credential to verify in `onOpen` — and a
  cookie cannot be verified there** (M70n, X3-5). `ISessionService.from(ctx)` needs the request
  context an upgrade bypasses, and no open-from-headers seam exists. The README now says what works:
  a signed query parameter or subprotocol nonce, with the composition gap tracked in
  `smoke/DEFECTS.md`.
- **`room()`/`channel()` are get-or-create, and nothing public said so** (M70n, X3-8). A presence
  endpoint reading `size` for caller-supplied names created one room/channel per distinct name,
  reclaimed only on some other connection's disconnect. Both READMEs and `PUBLIC_API.md` document
  the semantics.
- **A hand-written `RouterContextKey` literal silently returns its default** (M70n, X5-7) — keys
  match by identity and the declaring module reliably exists twice in a framework-mode build. The
  react-router README now carries the `contextKeyFor` warning (and its loader example, which read a
  nonexistent `context.services`, actually compiles).
- **`resilience.wrap()` rebuilt per request silently disables the circuit breaker** (M70n, X7-9).
  Retry and timeout keep working, so the broken shape looks identical to the working one. The
  resilience README and `PUBLIC_API.md` say to hoist the wrapped call to module or plugin scope.
- **`SessionPlugin({ csrf: {} })` — the registration every doc shows — could not accept a JSON
  mutation** (M70n, X4-5): `csrf.headerName` had no default, so the token was readable only from a
  urlencoded body. It defaults to `'x-csrf-token'` (the name the package's own JSDoc example already
  used); an explicit name still wins.

- **`every` jobs armed their timer for a full interval instead of the delay to the grid boundary**
  (M70l, X10-2). `every()` computed a grid-aligned `nextRunAtMs` but armed the timer for the whole
  `intervalMs`, so an off-grid registration ran the job a full interval LATER than the boundary it
  was aligned to — defeating the grid alignment (and the slot agreement it exists for) until the
  re-arm after the first fire. The timer is now armed for `Math.max(0, nextRunAtMs - now)` at
  registration and on every re-arm, so each fire lands at the boundary it was aligned to.

- **`delay` jobs no longer deduplicated across replicas** (M70l, X10-2). The fire slot for `delay`
  entries was keyed on `nextRunAtMs`, which for a delay is `now + delayMs` and therefore carries
  per-replica startup skew: two replicas registering the same one-shot delay 700 ms apart computed
  different slot keys and BOTH ran the handler. The slot is now claimed at REGISTRATION, keyed on
  the job name (skew-independent), and released when the entry leaves the registry — on fire,
  `remove()`, or TTL expiry — so a re-registration under the same name after the delay fired gets a
  fresh slot and still fires (the regression the name-keying previously guarded against stays
  guarded). `cron` and `every` keep their fire-time, grid-aligned slot keys, which are
  skew-independent by construction.

- **`RabbitMqBroker` treated any user queue named `rr.inbox.*` as the private RPC reply inbox**
  (M70l, X10-1). The reply inbox's transience was detected by pattern-matching queue names against
  the internal `rr.inbox.` prefix, but `SubscribeOptions.queue` has no reserved-prefix restriction —
  a legitimate consumer group named e.g. `rr.inbox.orders` was declared
  `{ exclusive: true, autoDelete: true }` and non-durable, so a second instance's use of it was
  refused. The inbox is now marked transient by a flag on the internal subscribe call at the point
  it is created, and a user `subscribe({ queue: 'rr.inbox.orders' })` is declared as a normal
  durable competing-consumer group queue.

- **Every documented example of reading a validated request read the WRONG `ctx.state` key** (M70m,
  found in verification). `validateBody` and friends store under `validated:${target}` —
  `validated:body`, `validated:query`, … — while `packages/validation-plugin/README.md`, that
  package's module JSDoc (which is what jsr.io renders as its package page), `ARCHITECTURE.md` and
  five `PUBLIC_API.md` examples all wrote `validatedBody`/`validatedQuery`/`validatedParams`. A
  route following any of them received `undefined` and answered with an empty body — validation
  itself worked, so nothing failed loudly. 11 sites corrected; the code's key is released behaviour
  and is unchanged. Every test in the package already used the real key, which is exactly why no
  gate could see it.
- **An upload's `maxSize` did not bound what the middleware parsed** (M70k, X8-3). The buffering
  bound was `Math.max(maxSize * 2, 50 MB)` under a comment reading "cap at 50 MB", which made 50 MB
  a **floor**: a 1 KB per-file limit multipart-parsed a 40 MB body before rejecting it, and a 100 MB
  limit raised the bound to 200 MB and delivered a 60 MB body to the handler unchecked. It is now
  `min(maxSize * 2 + framing, maxBodyBytes)` — a real cap. Note what this does and does not do: it
  bounds the PARSE and the per-part copies, not the initial read, because the HTTP adapter buffers
  the whole body before any middleware runs and `IRequest` exposes no body stream.
- **`taskTimeoutMs: 0` leaked a pool slot permanently** (M70k, X8-7). A worker that ended its own
  thread raised no host event, so the task timeout was the only thing that ever settled its task —
  and `0`, a documented and reasonable choice for long CPU-bound work, removed it. On a `size: 1`
  pool one self-terminated worker wedged the pool forever. The pool now settles the task with
  `WorkerExitError` and frees the slot wherever the runtime reports the exit (Node, Bun). On Deno it
  cannot, so the pool reports `exitDetection: false` in its health payload and warns once at
  `register()` rather than leaving the developer to discover the wedge.
- **A dead-lettered job was invisible through every surface the framework offered** (M70k, X8-4).
  See the three additions above; together they answer "this job is being abandoned", "how often is
  this happening", and "how many are sitting there right now".
- **The `local` storage provider could not work in a scaffolded project** (M70k, X8-9). The
  generated `start` task requests `--allow-read` and not `--allow-write`, so every upload failed
  while `/health` reported `storage: up` — the M70c liveness probe calls `stat`, a READ, which the
  granted permission satisfies. Three defects had to be understood before the one-flag cause was
  visible. The provider now fails at startup naming the flag, its health probe reflects writability,
  and `setu add storage` prints the note.
- **The storage README's Uploads example was broken three ways** (M70k, X8-8) — `maxFileSize` (the
  option is `maxSize`, and the compiler's suggestion `maxFiles` means something else),
  `file.contentType` (the field is `mimeType`), and a `getUploadedFile(ctx, 'avatar')` the
  middleware's own fieldname filter guaranteed would return `undefined`. The same example sat in
  `PUBLIC_API.md`. None of it was catchable because the doc-fence gate covered ten `docs/` guides
  and no package README; it now covers the three READMEs this milestone rewrote.
- **The queue README documented two options that do not exist** (M70k) — `region` and `queues`. SQS
  configuration lives under `sqs`, and RabbitMQ derives its queue names from `prefix`. Found by the
  new README fence gate.

- **`IDatabaseService.query()` was inoperative on the Drizzle adapter** (M70j, X12-2). The adapter
  called `execute({ sql, params })`, a shape no Drizzle driver accepts, so every raw query failed
  with the internal `TypeError: query.getSQL is not a function` — a method on the capability's own
  interface with no working path on that adapter at all. It now builds a real Drizzle `SQL` from the
  statement and its parameters: the text is emitted verbatim for an ascending-placeholder statement
  (`$1…` on PostgreSQL, `?` on MySQL and SQLite) and every value is bound, never interpolated. A
  placeholder count that disagrees with `params`, a gap in the `$N` sequence, or both placeholder
  styles in one statement is refused before the driver is reached, because a mis-bound parameter is
  silent. On PostgreSQL a jsonb `?`/`?|`/`?&` operator is indistinguishable from a placeholder, so
  such a statement is refused or fails at the database rather than being mis-bound — write it with
  `$N` placeholders. The defect survived because the unit fake accepted any argument; the proof is
  now the real Drizzle SQL generator, and that fake refuses a non-`SQLWrapper` exactly as a driver
  does.
- **`logQueries: true` silently dropped a portable `count` filter** (M70j). The service's logging
  wrapper declared `count(where)` and called `ds.count(where)`, discarding the second parameter
  `IDataSource.count(where, filter?)` defines — so `repo.count({ filter })` answered a different
  number with query logging on than with it off. Every existing test built the service without
  logging, which is why it survived. The wrapper now spreads the data source it wraps before
  overriding the six required methods, so a member the contract does not require cannot be dropped
  the same way again.

- **X10-3 — a service-discovery indicator that never reached its backend reported `up`** (M70c). See
  Changed.
- **X7-8 — the gRPC health bridge disagreed with `/ready` about a degraded process** (M70c). See
  Changed.
- **X3-7 — a health indicator's undeclared fields leaked into `/health`** (M70c). See Changed.
- **`S3Provider` is unusable against MinIO/R2/B2 with a custom `endpoint`** (M70c). The client
  config never set `forcePathStyle`, so the AWS SDK used virtual-hosted-style addressing
  (`<bucket>.<endpoint>`) against the custom host and every request failed (400 MalformedXML on
  `put`, 404 NoSuchBucket on `get`). A custom `endpoint` now forces path-style
  (`<endpoint>/<bucket>/<key>`), which is what the documented "R2 and MinIO via `endpoint`" promise
  requires; AWS (no `endpoint`) is unchanged.
- **The Redis backplane reachability probe reported `false` forever against a healthy Redis**
  (M70c). `RedisBackplane` captured `client.ping` and called it unbound; ioredis's `ping()` reads
  `this.options`, so the call threw
  `TypeError: Cannot read properties of undefined (reading
  'options')`, swallowed into `false` —
  the indicator reported `degraded`/`reachable: false` for a healthy backplane, inverting the
  milestone's purpose. The probe now calls `ping.call(client)` (the pattern `RedisStreamsBroker`
  already used).
- **`RedisQueue.isHealthy()` reported `false` forever against a healthy Redis** (M70c). The same
  unbound `ping()` defect in the queue adapter's probe; fixed with `ping.call(client)`.
- **`RabbitMqQueue` crashed the host process on a real backend outage** (M70c, surfaced by the §3.7
  real-outage suite). Two defects no fake-based test could construct: `disconnect()` threw
  `IllegalOperationError: Channel closed` when the channel/connection had already been torn down by
  the fault (both closes are now best-effort), and `connect()` installed the connection's `'error'`
  fault listener only AFTER `createChannel()` — a socket reset during channel creation (the port is
  open before the AMQP handshake is ready after a restart) was an unhandled `'error'` event that
  killed the process. The listener is now installed before the channel is created, and the channel
  gets its own `'error'` listener (amqplib emits `error` on every channel when the connection
  resets).
- **X11-1 — the SDK's default `fetch` receiver broke the client in a browser** (M70e). The default
  transport stored the bare global `fetch` on a private field and called it as `this.#fetch(...)`,
  so in a browser its receiver was the `HttpClient` instance and the first request died with
  `TypeError: Illegal invocation` before any network I/O. The default now resolves
  `globalThis.fetch` at call time with the global as its receiver, so the default works in a browser
  unchanged — and a `globalThis.fetch` installed after construction (a mocking library or polyfill)
  is honoured rather than shadowed by a value captured at construction. An injected `fetch` is
  always used as-is. No configuration change is required; the fix is in the default.
- **X7-3 — `@setu-ts/grpc-plugin` could not load on Node or Bun** (M70e). The Connect/Protobuf-ES
  specifiers reached `import()` through a constant map, so JSR's static npm-compatibility rewrite
  never saw them and the published artifact shipped `npm:` verbatim — unresolvable on Node and Bun.
  The default importer now calls four literal `import('npm:…')` expressions (one per module,
  including the two `/protocol` and `/wkt` subpaths), so the rewrite reaches every one. The
  injectable seam is reshaped rather than removed: `loadConnectModule` now takes a partial record of
  per-module zero-argument importers (`Partial<ConnectImporters>`) instead of one specifier-taking
  `ModuleImporter`, so each of the four failure branches is still drivable in isolation. Both
  `ModuleImporter` and `defaultImporter` are gone; neither was exported from the package barrel, so
  no consumer could reference them. **Migration:** none — the published package now loads on Node
  and Bun; the Connect/Protobuf-ES packages must be installed with the host runtime's package
  manager (the README names the `deno add` / `npm i` / `bun add` commands).
- **Telemetry outcome reporting was silent in the standard plugin configuration** (M70e). The
  reporter reads `ctx.logger` at call time, but `TelemetryPlugin` (priority 30) declared no
  dependency on the logger, so the kernel registered it before `LoggerPlugin` (priority 100) and
  every outcome line was dropped — the documented "reported through the plugin's logger" behaviour
  was unreachable in the standard configuration. `TelemetryPlugin` now declares
  `CAPABILITIES.LOGGER` in `optionalDependencies`, so the kernel orders the logger provider first;
  the edge is optional, so an app without a logger plugin still boots with no lines emitted. A
  kernel-level e2e test with the real `LoggerPlugin` pins both directions. **Migration:** none — the
  standard configuration now reports as documented.
- **A non-cloneable worker task input no longer kills the host process** (M45b, X8-2).
  `@setu-ts/worker-pool-plugin` documents that task inputs travel by structured clone, so passing a
  function or a class instance is a documented misuse that should reject the returned promise — and
  it did, but only when a worker happened to be idle. When the task was **queued** first, the
  dispatch ran from inside a worker `message` callback with no promise to reject into, so the
  `DataCloneError` escaped as an uncaught exception and **took the whole process down**, losing the
  results of every other in-flight task with it. A pool of `size: 1` with one task already running
  is an entirely ordinary state under load. `TaskPool.dispatch` now catches, rejects that task
  alone, and keeps the worker — which never received the message — so the pool carries on and the
  freed slot takes the next queued task instead of stalling behind the bad one. Both paths now
  behave identically. No application change is required.

### Deprecated

- `IHttpAdapter.setRpcHandler?` — the kernel resolves `IGrpcService` from the service registry and
  dispatches after the pipeline, so nothing calls this. All four first-party adapters accept it as a
  no-op. To be removed in the next major release.
- `RpcInterceptorStore` (`@setu-ts/runtime`), `GrpcUnavailableError` and
  `GrpcService.createFetchHandler` (`@setu-ts/grpc-plugin`) — all reachable only through the retired
  pre-pipeline seam. Retained as published surface; nothing throws or installs them.

### Known limitations

- **On Deno, `WorkerPoolPlugin({ taskTimeoutMs: 0 })` disables crash detection for a self-terminated
  worker** (X8-7). Node and Bun report a worker's exit, so the pool settles the task with
  `WorkerExitError` and frees the slot regardless of the timeout (see **Fixed**). Deno emits no
  event at all for a worker that ends its own thread, so `IWorkerHost.reportsExit?` is omitted
  there, the timeout remains the only thing that settles such a task, and `0` leaves that `run()`
  unsettled with its slot held — which wedges a `size: 1` pool permanently. The plugin reports
  `exitDetection: false` in its health payload and warns once at `register()`, but set a timeout on
  any Deno pool whose task module can call `self.close()`.

## [0.1.0-alpha.8] — 2026-08-14

**A release about what the generator actually produces, and what the database adapters actually
ran.** Building a three-service monorepo on the published `alpha.7` packages found a scaffold that
could not be installed on release day, could not answer its own `/health` probe, could not
type-check its own frontend routes, and failed `deno fmt --check` on 62 of the 74 files the CLI had
just written — every one of them past the gate that type-checks generated output and stops there.
The gate now formats, lints, installs, type-checks and **boots** each template and requests what the
project advertises.

Generation itself changed shape: decorators are no longer the default. `--template rest` and
`--template microservice` register no `DecoratorPlugin`, `setu generate` reads the style from the
target project's own manifest, and the decorated-plus-DI composition moved to one opt-in,
`--template class-based` (the old `--template nest` and `setu new --di` are refused with a message
naming it).

**The breaking changes ride together, and every one of them is a compile or startup error rather
than a silent behavior shift:** a Drizzle instance must now be wrapped in `createDrizzleDatabase()`,
a Prisma client must be constructed by the application and injected, the kernel refuses a duplicate
`METHOD path` instead of letting the second registration overwrite the first, and a class
implementing `IRepository` without extending `BaseRepository` must now implement `findOne`. The
database work is the reason: both ORM adapters shipped paths that could not work against a real
server — Drizzle filtered, sorted and paginated whole tables in JavaScript and addressed writes with
a fabricated column, and Prisma's lazy client construction passed an option v7 rejects outright.
Both now execute their drivers, and repositories gained a portable `filter` expression tree plus
`findOne` so a search no longer has to drop to raw `query()`.

All 47 packages move as one version, because the CLI stamps its own version as the dependency range
for every project it scaffolds. Installs still need an explicit version
(`jsr:@setu-ts/kernel@^0.1.0-alpha.8`) — JSR does not point `latest` at a prerelease — and Deno
refuses dependencies younger than 24 hours unless you pass `--min-dep-age 0`.

### Added

- **Typed native Drizzle query access.** `getDrizzleDatabase(service, configured)` returns the exact
  configured instance, and `getDrizzleTransaction(uow, configured)` returns a derived
  `DrizzleTransaction<typeof drizzleDb>` — Drizzle's callback-scoped native transaction for an
  `IUnitOfWork`. Both preserve the application's schema inference for joins and aggregations, which
  the single-entity repository contract cannot express, and the transaction form shares one
  commit/rollback boundary with repository writes. Both take the opaque configuration built by
  `createDrizzleDatabase` (see Changed), so the result type is derived from the application's own
  database rather than from an unchecked type argument. Promise-aware SQLite Proxy/libsql-shaped
  instances without `execute()` now connect for repositories and typed builders; raw `query()` alone
  rejects with a descriptive limitation. The exported `UnitOfWork` constructor accepts an optional
  adapter-type third argument while preserving the released two-argument call shape.

- **`ConfigPluginOptions.envFileOptional`.** When `true`, a path in `envFilePath` that does not
  exist is skipped instead of throwing. The default is `false`, so nothing about an existing
  application changes. Only ABSENCE is tolerated — a file that exists and cannot be read still
  throws, which the implementation establishes with a `stat` probe rather than by interpreting a
  runtime-specific error code.

- **Scaffolded projects generate their configuration.** `setu new` and `setu generate app` emit a
  gitignored dotenv file beside a tracked `<path>.example` and wire
  `ConfigPlugin({ envFilePath, envFileOptional: true })`; `--env-file <path>` chooses the path. A
  template that requires a value names it in both files — `full-stack` emits `SESSION_SECRET`, with
  a development value in the ignored file and an empty one in the committed example.

- **`setu workspace ports --reallocate`** reassigns every member to a currently bindable port and
  rewrites the manifest, discovery maps, Compose and Kubernetes artifacts together. Workspace
  creation and member allocation now probe a port before claiming it.

- **`setu generate app --depends-on <member>`**, repeatable, records startup prerequisites in
  `setu.workspace.json`. The generated root `dev` runner starts prerequisites first and waits for
  each one's `/ready` endpoint before starting its dependents, naming a cycle or a stalled
  prerequisite and terminating started children on failure.

- **`RestStarterOptions.serviceDiscovery`**, inherited by the microservice and full-stack tiers.
  Supplied → one `ServiceDiscoveryPlugin` is registered; omitted → the plugin list is unchanged.
  This is what lets a `full-stack` workspace member consume the discovery map the CLI already
  generated for it, through the starter factory rather than a hand-written registration.

- **Portable repository filters and `findOne`.** `FindOptions` and `CountOptions` gain an optional
  `filter` expression tree — comparison leaves (`eq`, `contains`, `gt`, `gte`, `lt`, `lte`, `in`)
  composed with `and` / `or` — conjoined with the existing equality `where` map, which is unchanged.
  Memory, Prisma, Drizzle and D1 each translate it natively rather than filtering in JavaScript, so
  a search no longer has to drop to raw `query()`. `FilterExpression`, `FilterComparison` and
  `FilterOperator` are exported from `@setu-ts/common` and re-exported from
  `@setu-ts/database-plugin`. `IRepository.findOne(options?)` returns the first match or `null`
  through the same one-source path as `findAll`.

- **`RouteInfo.owner`.** `app.router.listRoutes()` now reports the name of the plugin whose
  `register()` created each route, and leaves it absent for a route added directly by application
  code — so middleware can derive the paths the plugins own instead of hand-listing them.

- **`AuthPluginOptions.rbac` is optional.** A JWT-only application supplies `jwt` alone; AuthPlugin
  then registers `jwt` and `authentication` and neither creates nor advertises the `authorization`
  capability. Supplying `rbac` is unchanged in every respect.

- **`@Ctx()` for decorated controller handlers.** The decorator-plugin now injects the active
  `IRequestContext` into a decorated handler, so it can configure `ctx.response` (including status
  and headers) or return a streaming response without leaving the class-based routing API.

- **Startup warnings for two silent decorator misconfigurations.** When a logger is registered,
  `DecoratorPlugin.register()` now warns about a class listed in `controllers` that carries no
  `@Controller` metadata (which registers no routes, so every path 404s — usually caused by two
  copies of the package in one process), and about a custom parameter that no registered resolver
  can satisfy (which reaches the handler as `undefined`). Both warn rather than throw, so no working
  application changes behavior.

### Changed

- **A Drizzle instance must now be wrapped in `createDrizzleDatabase()` before it is injected.**
  `DatabaseAdapterOptions.drizzleInstance` changed from `unknown` to the opaque
  `DrizzleDatabaseIdentity`, so an unwrapped instance is a **compile error**, and `connect()` also
  rejects one at runtime naming the requirement. This is breaking for every existing
  `type: 'drizzle'` configuration.

  Migration — wrap the instance and pass a bridge that calls its own `transaction`:

  ```typescript
  DatabasePlugin({
    type: 'drizzle',
    options: {
      drizzleInstance: createDrizzleDatabase(db, (database, work) => database.transaction(work)),
      drizzleTables: { User: users },
    },
  });
  ```

  The bridge is application-supplied rather than inferred because a driver whose `transaction`
  callback is **synchronous** (better-sqlite3) commits before any awaited unit-of-work runs, so
  accepting one would report atomicity the database never provided. Those drivers are refused by
  `createDrizzleDatabase`'s types, which is why the requirement is a compile error rather than a
  runtime surprise.

- **The kernel refuses a duplicate route instead of silently replacing it.** Registering the same
  method and path twice — from a plugin, a group, or application code — now throws
  `Route '<METHOD> <path>' is already registered.` at registration time. Previously the second
  registration overwrote the first in the router's entry map, so one of the two handlers became
  permanently unreachable with no diagnostic: a `setu g route todos` in a project that already had a
  `@Controller('/todos')` shadowed one of them at random depending on load order.

  This is a breaking change for an application that registers duplicates today, and it surfaces at
  `app.start()` rather than at the first request. Migration: remove the duplicate registration, or
  give one of the two routes a distinct path. Distinct methods on one path, and distinct path
  patterns, are unaffected.

- **`IRepository` gains a required `findOne` member.** Classes extending `BaseRepository` inherit
  the implementation and need no change. A class implementing `IRepository` directly — without
  extending `BaseRepository` — must now implement `findOne`, which is a compile error until it does.
  `IDataSource.count` gained an optional second `filter` parameter, which existing implementations
  satisfy unchanged.

- **`contains` now carries an explicit `ESCAPE` clause on the Drizzle adapter.** The predicate is
  built with Drizzle's `sql` tag as `LIKE ? ESCAPE '\'` rather than a bare `like()`. Escaping the
  pattern alone relies on the dialect's default escape character, which PostgreSQL and MySQL define
  as a backslash but SQLite does not define at all — so on a SQLite-backed instance a search whose
  value contained `%`, `_` or `\` would have matched nothing. `DrizzleOperators` (not exported from
  the package barrel) accordingly requires `sql` in place of `like`.

- **Scaffolded REST-derived templates now answer errors as RFC 9457 Problem Details.** The inline
  `errorHandler()` the CLI emits passes `{ format: 'rfc9457' }`, matching what the starter factories
  already did. `@setu-ts/exceptions` itself is untouched: `errorHandler()` still defaults to the
  `'default'` format.

- **The Prisma and Drizzle database adapters now execute their drivers, and both require the
  application to own the client.** Both shipped with paths that could not work against a real
  server, so each is a breaking configuration change rather than a tuning option.

  `PrismaAdapter` no longer constructs a client. Prisma v7 generates its client into an
  application-selected output path, which a JSR package cannot locate, and the removed lazy
  `import('npm:@prisma/client')` path passed the legacy `datasources` constructor option that v7
  rejects outright. `options.prismaClient` is now required and is validated at `connect()`.

  Migration: generate the client in the application, construct it, and inject it —
  `DatabasePlugin({ type: 'prisma', options: { prismaClient } })`. `options.url` is still accepted
  for source compatibility but is no longer a working Prisma connection mechanism; an adapter
  configured without a client now fails at startup with a message naming the requirement, where it
  previously failed at the first query.

  `DrizzleAdapter` now translates every repository operation into real Drizzle builder calls against
  real columns. It previously selected whole tables and filtered, ordered, paginated and projected
  them in JavaScript, and passed a fabricated `{ column: 'id' }` object to `eq` for writes — so
  `update` and `delete` addressed nothing. `options.drizzleTables` is now required, each registered
  table must carry an `id` column, and every field named by `where`, `orderBy` or `select` must be a
  real column on it. `drizzle-orm` must be installed alongside the injected instance; the previous
  silent fallback to placeholder operators is gone, since it produced expressions no driver could
  execute. `create`, `update` and `delete` read their result from the driver's `RETURNING` clause
  and throw descriptively on a dialect without it, rather than echoing the input back as if it had
  been persisted.

  Migration: pass a table registry beside the instance —
  `DatabasePlugin({ type: 'drizzle', options: { drizzleInstance: createDrizzleDatabase(db, (database, work) => database.transaction(work)), drizzleTables: { User: users } } })`.

- **Generated projects are functional by default, and decorators plus DI are one opt-in.**
  `--template rest` and `--template microservice` no longer register `DecoratorPlugin`, and
  `setu generate` now derives its output style from the packages the target project actually holds:
  a project with `@setu-ts/decorator-plugin` gets decorated classes, and one without it gets
  `ctx`-first routes and plain exported functions. `setu generate module` is **ungated** as a result
  — in a functional project it writes a service plus a `src/routes/<name>.routes.ts` module the
  managed routes barrel already registers, so the module serves `GET /<name>` and `POST /<name>` (a
  real `201`) with no edit to `setu.config.ts`. Decorated write handlers now take `@Ctx()`, which is
  how they set that status. `setu generate service` emits a plain exported function plus a
  `src/services/index.ts` re-export barrel — a convenience, not a registration: nothing imports it
  for you, because no plugin option takes a list of functions.

  **Nothing about an existing project changes.** Style is read from its manifest, so a project
  scaffolded with decorators keeps generating decorated classes, including one that holds
  `DecoratorPlugin` without `DiPlugin`.

### Fixed

- **A stock scaffold now installs, boots, answers its probes, type-checks and formats clean.** Four
  defects, all reproduced against the published `alpha.7` packages by building a three-service
  workspace, and all four passed the drift check that type-checks generated output:

  - `deno install` on a pristine project failed outright on release day —
    `Could not find version of '@setu-ts/common' that matches '^…' … newer than the specified
    minimum dependency age`.
    Deno 2.9 refuses a dependency published in the last 24 hours and `setu new` pins projects to the
    CLI's own just-published version, so the window was guaranteed. The generated root now sets
    `minimumDependencyAge`.
  - `GET /health` on a stock `--template rest` project answered **500** — the path its own generated
    Kubernetes probes point at. HealthPlugin's `selfIndicator` reads `runtime.hostname()`, which
    Deno gates behind `--allow-sys`, and the generated `start` task never asked for it. The
    per-template `denoPermissions` seam already existed and simply had no entry.
  - Every `.tsx` route in a `--template full-stack` project failed `deno check` with 79 `TS2686`.
    Declaring **any** `compilerOptions` in a manifest replaces Deno's own `react-jsx` default, so
    the unconditionally-emitted `experimentalDecorators` was the cause rather than a redundant
    extra. Compiler options are now per template, and `full-stack` gained the `check:app` task that
    reaches route modules `deno check main.ts` never sees.
  - A fresh workspace failed `deno fmt --check` on 62 of the 74 files the CLI itself wrote: no `fmt`
    configuration was emitted at all, and with one added the `.tsx` emitters still disagreed.
    Generated imports are now sorted and wrapped the way `deno fmt` does, and emitted JSX is
    single-quoted.

  The gate that keeps them fixed formats, lints, installs, type-checks and **boots** every template,
  then requests what the project advertises — deliberately without a blanket permission grant, since
  a permission the generated task forgot to ask for is unobservable under `-A`.

- **`IRepository.count()` on the Drizzle adapter no longer drags the whole match set over the
  wire.** It selected every matching row and measured the resulting array's length in JavaScript, so
  counting a million-row table transferred a million rows. It now selects drizzle-orm's `count(*)`
  aggregate and reads the single row the database returns. Every fake-backed test passed either way;
  the guarded real-Drizzle proof now asserts the emitted SQL contains `count(*)` and names no
  columns.

- **A functional project no longer reports its own services as stale.** `setu generate` scans each
  generated family and refuses to list a file that does not export what the barrel would import,
  reporting it so the artifact is never silently unwired. The `service` family has two shapes and
  the scan used only the class one, so in a functional project every `setu generate` printed
  `Skipped src/services/x.service.ts: it does not export XService` followed by
  `Regenerate it to bring it up to date` — for a file the CLI had just written, naming a barrel that
  does not exist there, with advice that loops (the regenerated file is identical). The scan now
  selects the spec matching the project's own style.

### Removed

- **`--template nest` was renamed to `--template class-based`.** The composition is unchanged — the
  REST set plus `DecoratorPlugin` and `DiPlugin`, with a decorated controller and an injected
  service written for you. The framework has a class-based mode, not a NestJS mode, and the name
  said otherwise. The old name is refused with a message naming the new one rather than falling into
  the generic unknown-template error.
- **`setu new --di` was removed**, and is refused with a message pointing at
  `--template class-based`. Decorators and dependency injection were independently selectable, which
  made four compositions out of one axis; two of them — decorators without a container, and a
  container with nothing decorated to construct — are the incoherent middle. `--template full-stack`
  consequently has no DI opt-in from the CLI at all; `FullStackStarterOptions.di` is still there for
  an application composing the starter itself.

  Migration: `--template rest --di` and `--template nest --di` both become `--template class-based`;
  a bare `--di` has no direct equivalent, and a project wanting a container without decorators
  should register `DiPlugin()` in its own `setu.config.ts`.

## [0.1.0-alpha.7] — 2026-08-12

**A deployment release.** A generated workspace now emits the artifacts that ship it — a
parameterized Dockerfile, a Compose stack carrying every member plus the broker its transport needs,
and a Deployment and Service per member, all regenerated whenever a member is added. This repository
gained the same for itself: one image that builds any example, a Helm chart with its rendered
manifests committed beside it, and a deployment guide that finally writes down the RBAC the
`kubernetes` service-discovery provider has always needed. A workspace is also no longer Deno-only
(`--runtime node|bun` builds one on npm workspaces), an existing single-service project can become
one with `setu adopt`, members can share code through `libs/`, and two more transports carry a
workspace's internal traffic.

Deploying for real is what found the defect that would have undermined all of it: **nothing handled
`SIGTERM`**. A generated `main.ts` installed no signal handler, so `docker stop` and every pod
eviction killed the process outright — measured at exit 143 after 1 ms, with `app.stop()` never run:
no drain, no service-discovery deregistration, no database or broker disconnect, and a
`terminationGracePeriodSeconds` that did nothing. Fixed in the generator and in every example here.

All 47 packages move as one version, because the CLI stamps its own version as the dependency range
for every project it scaffolds. Installs still need an explicit version
(`jsr:@setu-ts/kernel@^0.1.0-alpha.7`) — JSR does not point `latest` at a prerelease — and Deno
refuses dependencies younger than 24 hours unless you pass `--min-dep-age 0`.

### Fixed

- **A scaffolded project now survives `SIGTERM`.** A generated `main.ts` installed no signal
  handler, so `docker stop` and every pod eviction killed it: measured at **exit 143 after 1 ms**,
  with `app.stop()` never run — no drain, no service-discovery deregistration, no database or broker
  disconnect. M39 found and fixed this in this repository's own examples and documented the pattern
  as recommended; the generator kept emitting the defect. `main.ts` now catches `SIGTERM` and
  `SIGINT` — `Deno.addSignalListener` (Windows-guarded, where it throws) or `process.on` for Node
  and Bun, nothing on Cloudflare Workers, which has no process. Both npm targets declare the type
  package their `process` reference needs.
- **`setu new --template full-stack` served a blank home page.** `app/routes.ts` wraps two
  `flatRoutes` groups in `layout()` calls and neither had an `_index`, so `/` matched a layout with
  no child: `<Outlet />` rendered nothing and the server answered **200 with an empty `<body>`** —
  not a 404, not an error. Measured on a scaffolded project: `/products` and `/login` rendered while
  `/` returned 2761 bytes of shell and no visible text. M37c found and fixed exactly this in
  `apps/full-stack`; the template kept emitting it, because every check requested `/products` and
  `/login` explicitly and nothing ever requested `/`.
- **Install snippets named versions the workspace no longer shipped.** Six of them, with
  `packages/sdk/README.md` two releases behind — and a package README is the first thing a new user
  runs, rendered on jsr.io. Nothing could see it: `release:verify` reads manifests and cross-package
  specifiers, not prose, and a stale-but-real version still resolves, so the command works and
  installs something old. `deno task check:docs` now compares every `@setu-ts` specifier in markdown
  against the shipping version, exempting the changelog and the release runbook, whose old versions
  are a record; it found two more on its first run. Also corrected: `packages/cli/README.md` still
  called the framework Hono Enterprise, the name dropped in `v0.1.0-alpha.5`, and three
  `github.com/setu-ts/hono-enterprise` links 404'd — the repository is `setu-ts/setu-ts`.

### Added

- **Container and Kubernetes artifacts for a generated workspace.** `setu generate app` emits
  `docker/Dockerfile` (one parameterized image per member), `.dockerignore` (at the workspace root,
  where Docker reads it — without one the host's `node_modules` is copied over the one the image
  installed), `docker/compose.yaml` (every member plus the transport's broker) and
  `k8s/members.yaml` (a Deployment and a Service per member), all regenerated for the whole
  workspace whenever a member is added. M39 owns this repository's own deployment objects; nothing
  produced any for a user's project.
- **Containerization and Kubernetes orchestration for the framework itself** (M39). The framework
  could be served on four runtimes and found by an orchestrator, but nothing here showed how to ship
  it to one: a single collector config was the only deployment artifact in the repository. Now
  [`docker/Dockerfile`](docker/Dockerfile) builds **any** example through one file
  (`--build-arg APP=<name>`, rather than fifteen near-copies),
  [`docker/Dockerfile.compiled`](docker/Dockerfile.compiled) offers a `deno compile` → distroless
  variant, [`docker/compose.yaml`](docker/compose.yaml) runs the stack, and
  [`k8s/chart/`](k8s/chart/) is a Helm chart — Deployment, Service, Ingress, ConfigMap/Secret
  projection, HPA, PodDisruptionBudget, and the ServiceAccount + RBAC — with its rendered manifests
  committed beside it in [`k8s/manifests/`](k8s/manifests/) and `deno task check:deploy` failing on
  any drift between the two.

  [`docs/deployment.md`](docs/deployment.md) is the guide, and it documents the thing that was
  written down nowhere: the exact Role the `kubernetes` service-discovery provider needs to read
  EndpointSlices. Two things a reader might expect are corrected there rather than left implied —
  `scratch` is impossible, because the compiled binary is dynamically linked against glibc, and the
  distroless win is 44.9 MB against 52.4 MB rather than an order of magnitude, since the binary
  embeds the whole Deno runtime. The reason to prefer it is the absent shell, not the size.

  The build context **must** be the repository root: an example's `deno.json` maps only its direct
  dependencies, so `@setu-ts/common` reaches `kernel` through the root workspace, and an image built
  without the root manifest fails resolution against JSR instead. Three defects only a real cluster
  surfaced are fixed in what ships: `runAsNonRoot` refuses a non-numeric image user (both images
  declare numeric UIDs), an `emptyDir` at `/deno-dir` masks the build-time module cache and makes
  every pod re-resolve from jsr.io at startup, and `helm template` defaults `.Release.Namespace`, so
  the RoleBinding named a ServiceAccount in the wrong namespace and granted nothing while applying
  cleanly.
- **`--transport pubsub` and `--transport service-bus`.** Both were previously refused because each
  needs a value no scaffold can invent. Every transport with a connection value now reads it from
  the environment with a local fallback, and for these two that fallback is the vendor's own
  local-emulator setting — so a scaffolded workspace runs against an emulator unconfigured and
  against the real service with one variable set.
- **`setu generate library <name>`.** Shared code as a workspace member under `libs/`, importable by
  every sibling as `@<scope>/<name>` with no import-map entry anywhere.
- **`setu adopt`.** Converts an existing single-service project into a workspace holding it as the
  first member. It moves only the files the CLI emits, so `.git`, CI configuration and `deno.lock`
  stay at the repository root.
- **`setu generate app --port <n>`.** A member can be given a specific port; one another member
  already binds is refused.
- **`--template full-stack` as a workspace member.** Its Vite build needs `node_modules`, which only
  the workspace root may enable, so the root gains `nodeModulesDir` when such a member arrives — and
  not before, because with it set an ordinary member's first `deno check` materialises every npm
  package the framework lazily imports.
- **Node and Bun workspaces.** `setu new --workspace --runtime node|bun` builds a monorepo on npm
  workspaces instead of a Deno one — the framework claims runtime independence, and only the
  monorepo was Deno-only. The runtime is recorded in `setu.workspace.json` (absent means `deno`, so
  nothing existing changes) and every later command reads it back: root manifest shape, environment
  reads in generated source, library manifest and test runner, base image, and install and run
  commands. Cloudflare Workers is refused, because each Worker is its own deploy unit.
- **A proto toolchain for `--transport grpc` members.** An example proto, both `buf` manifests and a
  `proto:gen` task. Both the compiler and the codegen plugin run through Deno's npm compatibility,
  so nothing needs `buf` or `protoc` on a PATH.

### Changed

- **A workspace transport's connection value is an environment read, not a literal.** A generated
  member's `MessagingPlugin` wiring was `url: 'redis://127.0.0.1:6379'`, which is unreachable from
  inside a container — two Compose services do not share a loopback interface, so the member dialled
  its own container. It is now `Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379'`.
- **The generated discovery map reads each sibling's host from `<MEMBER>_HOST`**, falling back to
  `127.0.0.1`, for the same reason: inside a container loopback is the container itself, so a fixed
  address had every member dial ITSELF on its sibling's port. The generated Compose stack and
  Kubernetes objects set those variables to the service names.
- **A new workspace's root declares both member globs** (`./apps/*` and `./libs/*`) at creation, so
  neither a service nor a library ever rewrites it. A workspace created earlier gets the second glob
  added when its first library arrives.

## [0.1.0-alpha.6] — 2026-08-11

**A generator release.** Eleven of the fourteen artifacts `setu generate` emits now reach a
registration site with no edit to a file you own — the other three have a stated reason they have
none. Decorators and dependency injection became independent choices, a repository can hold more
than one deployable service, and Cloudflare Workers gained the last capability it was missing.
Alongside that: a documentation hub with nine curated guides, RFC 9457 Problem Details, and an
OpenAPI document derived from the guards that enforce authentication.

All 47 packages move as one version, because the CLI stamps its own version as the dependency range
for every project it scaffolds. Installs still need an explicit version
(`jsr:@setu-ts/kernel@^0.1.0-alpha.6`) — JSR does not point `latest` at a prerelease — and Deno
refuses dependencies younger than 24 hours unless you pass `--min-dep-age 0`.

**One behavior change to already-generated code**: `setu generate controller` emitted a controller
that answered `500` on every request, in every release since the CLI first shipped in
`v0.1.0-alpha.2`. The fix changes the shape of what it emits — see _Changed_ below for the
migration.

### Added

- **Workers-native messaging: the last edge capability gap** (M59). `cloudflare-plugin` already
  served `QUEUE`, `CACHE`, `STORAGE`, `DATABASE` and `REALTIME_BACKPLANE` on Cloudflare Workers.
  `CAPABILITIES.MESSAGING` was the one token it could not: all ten `messaging-plugin` brokers need a
  socket or a socket-bound SDK. A new `messaging` arm serves it from the platform itself.

  ```typescript
  app.register(CloudflarePlugin({
    env,
    messaging: { binding: 'MESSAGES', rpc: { binding: 'REPLY_INBOX' } },
  }));

  // Consuming is a MODULE export — no plugin option can declare one.
  export default { fetch: app.fetch, queue: createMessagingHandler(app) };
  ```

  `publish` is a Queues producer call; `subscribe` registers into a dispatch table the `queue`
  export drives, matching `InMemoryBroker`'s fan-out and round-robin group semantics. Two limits are
  documented rather than papered over: Cloudflare allows **exactly one active consumer per queue**,
  so cross-service fan-out needs one queue per consumer, and a publish nobody subscribed to is
  **acked** rather than retried — retrying ordinary pub/sub would dead-letter every fire-and-forget
  message.

  `request`/`respond` ship behind the opt-in `rpc` arm. A queue reaches its one consumer Worker and
  never the caller, so the reply travels through a Durable Object the caller holds a WebSocket to
  while its request is in flight (`ReplyInboxObjectCore`, which the application exports as its own
  DO class). Without the arm both throw, naming the binding to add. A queue carrying RPC **must**
  set `max_batch_timeout = 0`: the platform default of 5s alone exhausts the default reply budget.

  `CloudflareRequestTimeoutError` and `CloudflareRemoteHandlerError` mirror `messaging-plugin`'s two
  RPC errors as distinct classes, because §2.2 forbids a plugin importing another plugin. Exactly
  one provider of `CAPABILITIES.MESSAGING` can be registered, so which to catch is never ambiguous.

- **`setu new --template microservice --runtime cloudflare-workers`** (M59). The template refused
  that target unconditionally. The refusal was right about `MessagingPlugin` and `QueuePlugin`
  needing raw sockets and wrong about the capabilities, which the platform serves itself. A new
  declarative `TemplateDefinition.runtimeSwaps` replaces those two with `CloudflarePlugin` on
  Workers only, and contributes the `queue` module export, the Durable Object class, and the
  wrangler stanzas — including `max_batch_timeout = 0`. The other three runtimes are byte-identical.
  Because Cloudflare invokes ONE `queue` export for every consumed queue, the emitted handler routes
  on the queue name and both queues get a consumer: one handler for both would feed the messaging
  broker its job batches, and an unconsumed producer discards every `IQueue.add()` silently.
  `TemplateDefinition.unsupported` and its refusal branch are **removed**: `microservice` held the
  last entry, so both became unreachable. CLI-internal, never a published export.

- **Monorepos: one repository, many deployable services** (M62). The CLI had no workspace concept at
  all, so a second service meant `setu new other --dir .` — a fully independent project with its own
  manifest, its own lockfile, and no knowledge of its sibling. The sharp edge was discovery: the
  microservice template wires `ServiceDiscoveryPlugin({ provider: 'static', services: {} })` with a
  deliberately EMPTY map, because a sample entry would have named a dead port, so every caller's map
  was hand-edited in every service and nothing propagated a new name.

  ```bash
  setu new acme --workspace                          # the root, no member yet
  cd acme
  setu generate app orders --template microservice   # apps/orders, port 3000
  setu generate app billing --template microservice  # apps/billing, port 3001
  deno task dev                                      # runs every member
  ```

  A workspace is a **Deno workspace** whose root declares members by GLOB
  (`"workspace":
  ["./apps/*"]`), so adding a service creates a directory and rewrites no manifest
  — no file you own is ever edited. Each member is an ordinary scaffolded project with its own
  framework pins, because plugin detection reads one directory's manifest and never walks up; two
  members may install different plugin sets.

  **Adding a service registers it with its callers.** Every member carries a CLI-owned
  `src/discovery/services.ts`, regenerated for all members on each `setu generate app`, exporting
  `SERVICE_PORT` (its own) and `SERVICE_ENDPOINTS` (every sibling). The member's `main.ts` binds the
  former and its `setu.config.ts` hands the latter to `ServiceDiscoveryPlugin`, so the port a member
  binds and the port its siblings dial are one datum and `discovery.resolveUrl('billing')` works
  from any sibling with no configuration. The map is the LOCAL development topology; a deployed one
  comes from a real backend (`consul`, `kubernetes`, `dns`).

  **The workspace chooses how its services talk.**
  `--transport http|grpc|memory|redis|rabbitmq|
  nats|kafka` is recorded in `setu.workspace.json`
  and inherited by every member, because services can only meet on a bus they share; `generate app`
  refuses the flag and names the workspace-level one. `http` stays the default, so an upgrade
  changes nothing. This closes a silent failure the workspace itself made reachable: the
  microservice template registers `MessagingPlugin()`, whose default broker is in-process, so two
  generated services publishing and subscribing on one topic exchanged nothing while both reported
  success. `--transport tcp` is refused with an explanation rather than aliased to HTTP — there is
  no raw-TCP transport here.

  Refusals rather than silent surprises: `generate app` outside a workspace names
  `setu new <name> --workspace`; a duplicate member names the directory it already has; a non-Deno
  `--runtime` names the standalone alternative; `--template full-stack` is refused because its Vite
  build needs `nodeModulesDir`, which Deno accepts only in a workspace ROOT; and `new --workspace`
  refuses `--template` because a root registers no plugins.

- **Decorators and DI are independently selectable in the generator** (M61). AI_GUIDELINES states
  that decorators are optional, DI is optional, and that no feature requires either — but the CLI
  offered one coarse control. No template gave you neither and refused `g controller`/`g module`;
  `rest`/`microservice` gave decorators without a container; only `nest` gave both, along with a
  worked NestJS-style example you may not have wanted.

  `setu new --di` adds `DiPlugin` to any template, so a container is now a choice of its own:

  ```bash
  setu new app --di                       # a container, no decorators
  setu new app --template rest --di       # decorators and a container
  setu new app --template nest --di       # a no-op — nest already registers DiPlugin
  ```

  It changes the composition, never the generated source: `DecoratorPlugin` branches on the
  container's presence, so the same `@Injectable` class works either way and what changes is the
  lifecycle it gets. On `--template full-stack` the flag reaches the starter's own `di` arm rather
  than a plugin wiring, because a starter-composed template owns its whole plugin set. Adding it to
  a template that already registers `DiPlugin` is deliberately a no-op — the kernel refuses a
  duplicate plugin name at `start()`, so a second registration would scaffold a project that
  type-checks and then cannot boot.

- **`setu generate route` is now a first-class decorator-free path.** A project scaffolded with no
  template registers the runtime plugin alone, so `g route` is the only HTTP handler it can generate
  — and it used to land unwired: the schematic wrote `src/routes/<name>.routes.ts` and a
  `src/routes/index.ts` barrel while the generated `setu.config.ts` imported neither, so the route
  answered `404` until you edited the config by hand. The no-template path is now a seam host for
  the three families that need no plugin (`route`, `middleware`, `plugin`), so a generated route,
  middleware or plugin is wired from scaffold time exactly as it is under `--template rest`.

  Existing projects are unaffected — nothing rewrites a scaffolded `setu.config.ts`. Each barrel's
  header states the two lines to add; add them once and every later generate is wired.

- **Generated code is now wired** (M60). `setu generate` emitted fourteen artifacts and exactly one
  of them — the M58 domain module — reached a registration site. The other thirteen compiled and did
  nothing: `g service` emitted a class nothing constructed, `g health-indicator` an indicator
  nothing registered, `g command-handler` a handler no bus dispatched to. Eleven now reach a
  registration site with no edit to a file you own, and three are documented as having none.

  Each wired schematic emits its artifact plus a CLI-owned `index.ts` seam barrel for its family,
  and the `rest`, `microservice` and `nest` templates scaffold a `setu.config.ts` that already
  imports every barrel they can consume. See PUBLIC_API "Generated code is wired" for the
  per-schematic table.

  ```bash
  setu new shop --template microservice
  setu g health-indicator external-api --dir shop   # appears in GET /health
  setu g metric orders-placed --dir shop            # appears in GET /metrics at boot
  setu g command-handler create-user --dir shop     # the command bus dispatches to it
  ```

  `guard`, `job` and `migration` are deliberately unwired, and their emitted JSDoc now names the
  real call instead of implying a site is waiting: a guard belongs on one route (a global one would
  answer `401` for `/health`), a job's transport is a choice between `queue.process` and the
  scheduler that the artifact cannot make for you, and nothing in the framework reads migration
  files — there is no `setu db:migrate`.

- **`CqrsPluginOptions.commandHandlers` / `.queryHandlers`, and `EventsPluginOptions.handlers`** —
  declarative handler registration, as `{ type, handler }` pairs. Pure additions: omitting them
  behaves exactly as before. The events option subscribes through the same exported
  `subscribeHandler` a caller would use by hand, so the two routes cannot diverge. Needed because
  `IApplication` exposes no lifecycle hook, so application code has no phase in which to reach a bus
  that does not exist until its plugin has registered. `CommandHandlerRegistration`,
  `QueryHandlerRegistration` and `EventHandlerRegistration` are exported alongside them.

- **`NamedMetricConfig` is exported from `@setu-ts/metrics-plugin`.**
  `MetricsPluginOptions.customMetrics` is typed as an array of it, so without the export that option
  could take an inline literal but a caller could not declare its own array in a variable.

- **`CqrsPlugin` and `EventsPlugin` join `setu new --template microservice`.** Both are in-memory
  and construct with no configuration, so the tier's rule that a scaffolded plugin needs no
  credentials holds, and neither needs a socket so the Cloudflare Workers refusal is unchanged. They
  are also the only host a scaffolded project can have for `g command-handler`, `g query-handler`
  and `g event-handler`, all three of which were gated on plugins no template installed.

- **A documentation hub, and gates that keep it true** (M38). Nine curated guides under
  [`docs/`](docs/) — getting started, plugin architecture, the plugin catalog, the programmatic API,
  decorators, writing custom plugins, migrating from NestJS and from Fastify, the examples index,
  and runtime deployment — plus a reproducible `deno doc` API-site generator (`deno task docs:api`).
  Every package README now links to its own `PUBLIC_API.md` section.

  The guides are mechanically checked rather than trusted: committed fixtures representing all nine
  are type-checked against the workspace, a Markdown gate validates the package catalog and every
  cross-file anchor, and a JSDoc lint ratchet freezes the measured diagnostic count so documentation
  debt can only be paid down, never added to. A below-baseline run fails and names the constant to
  lower. No package source, manifest export, capability token, or plugin option changed.

  `PUBLIC_API.md` section anchors now carry their package name, which **breaks external deep links**
  (`#storage` is now `#storage-setu-tsstorage-plugin`).

### Fixed

- **Every Cloudflare Worker misdetected its own runtime as `node`** (found while booting a
  CLI-scaffolded Workers project in M59). `detectRuntime()` tested
  `navigator.userAgent.includes('cloudflare')` — lowercase — and workerd reports
  `'Cloudflare-Workers'`, so the check never matched and detection fell through to `'node'` on every
  real deployment. That answer selects the runtime adapter, so a Worker built through
  `RuntimePlugin()` ran the **Node** adapter on Cloudflare, and the `cloudflare` health indicator
  reported `degraded` with a misleading detail. It also silently disabled every
  `runtime.platform() === 'cloudflare-workers'` guard, including `messaging-plugin`'s cloud gate —
  so Pub/Sub and Service Bus attempted their gRPC/AMQP SDK load instead of failing with the named
  `CloudBrokerUnavailableError`.

  The comparison is now case-insensitive. No test caught this because the unit fakes sent
  `'cloudflare-workers/v1'` and `'cloudflare'`, strings the platform never sends — a test double
  that violated the real contract, so the suite tested the double. The fakes now use the real
  string, and `apps/cloudflare` asserts `detectRuntime()` against **real workerd** in its smoke,
  which is the only place the platform sends its own user agent. Both were verified to fail without
  the fix.

- **A mistyped Queues binding now fails at `register()`, not at the first send** (M59).
  `BindingRegistry.queue()` cast its binding unvalidated, so a missing `[[queues.producers]]` stanza
  or a name typo let an application boot clean, report `up` from the `cloudflare` health indicator,
  and fail on the first `add()` with a bare `TypeError` pointing at nothing. A new `isQueueProducer`
  guard closes the last hole in that family — the same defect M52c fixed on D1 and M52d on Durable
  Objects. **Behaviour change** for anyone whose queue binding was already wrong: the failure now
  arrives at startup, naming the binding.

- **`setu new --runtime cloudflare-workers` produced a project that could not be built or
  deployed.** `wrangler` bundles `src/index.ts` with esbuild, which resolves neither `jsr:`
  specifiers nor a Deno import map — and the Workers target declared its framework packages only in
  `deno.json`, emitting no `package.json` and no `.npmrc`. So the flow the CLI itself prints,
  `npm install && npx wrangler dev`, failed with one `Could not resolve "@setu-ts/…"` per package.
  There was nothing to install.

  Workers projects now also emit `package.json` (the npm-compat `@jsr/…` dependencies, plus
  `wrangler` pinned in `devDependencies` and `dev`/`deploy` scripts) and `.npmrc`. Verified against
  real workerd through `wrangler dev`: a scaffolded project serves `/`, `/health`, `/metrics`, and
  every generated route, controller and module. The Deno target deliberately still gets no
  `package.json` — that would switch it to node_modules resolution.

  **Existing Workers projects are not rewritten.** Add a `package.json` declaring the same
  `@setu-ts/*` packages your `deno.json` lists, using their `npm:@jsr/setu-ts__<name>` form, plus an
  `.npmrc` containing `@jsr:registry=https://npm.jsr.io`.

- **`setu new --runtime node` could not run any decorated code.** Generated Node projects started
  with `node --experimental-strip-types main.ts`, and Node's built-in TypeScript support erases
  types without transforming code — so a legacy decorator was a bare
  `SyntaxError: Invalid or unexpected token`, and the constructor parameter property
  `setu generate module` emits was `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. In practice a scaffolded
  Node project booted until the first `setu generate service`, `generate controller` or
  `generate module`, and `setu new --template nest --runtime node` never booted at all. Deno, Bun
  and Cloudflare Workers were unaffected.

  Node projects now declare `tsx` in `devDependencies` and start with `tsx main.ts`, which reads the
  `experimentalDecorators` the generated `tsconfig.json` already sets.
  `--experimental-transform-types` was evaluated and rejected: it handles the parameter property but
  still refuses the decorator, because it does not enable `experimentalDecorators`. No other target
  carries the dependency — Bun compiles TypeScript outright, and Deno and Workers never invoke it.

  **Existing Node projects are not rewritten.** To pick this up, add `tsx` to your `devDependencies`
  and change the `start` script from `node --experimental-strip-types main.ts` to `tsx main.ts`.

### Changed

- **The `controller` and `module` gate refusals now name `setu generate route`** as the
  decorator-free alternative. The gate itself is unchanged (those schematics emit `@Controller`, so
  an ungated project would get source whose own import cannot resolve), but refusing with only
  "install `@setu-ts/decorator-plugin`" read as though decorators were required to serve HTTP, which
  is the opposite of what the framework promises.

  ```
  The "controller" schematic requires @setu-ts/decorator-plugin, which is not installed in /path/to/app.
  Install it, then run this command again.
  Or run `setu generate route user-profile` — it registers handlers on the router API, so it needs no decorators.
  ```

- **`setu generate plugin` now writes `src/plugins/<name>.plugin.ts`**, not `src/plugins/<name>.ts`.
  The seam barrel is regenerated from a directory scan, and a suffix of `.ts` would admit any module
  you hand-wrote in that folder — the barrel would then import a `<Pascal>Plugin` symbol you never
  wrote, and your project would fail to compile naming a file you never generated. Existing
  generated files are untouched; only new generates take the new path.

- **`setu generate service` emits an `@Injectable` when `@setu-ts/decorator-plugin` is installed**,
  registered under the token `<name>-service` and listed in `src/services/index.ts`. Without that
  package the output is unchanged, byte for byte, and the schematic stays **ungated** — so it keeps
  working in a project with no plugins at all.

- **An artifact generated before its family gained a second export is skipped and reported**, rather
  than listed in a barrel that cannot compile. `middleware` gained a
  `<SCREAMING>_MIDDLEWARE_PRIORITY` constant and `metric` a `<SCREAMING>_METRIC` declaration in this
  release; an artifact generated earlier has the right filename and lacks that export, so a barrel
  regenerated over it named a symbol the file did not have and the project stopped compiling — from
  a command that reported success. The scan now admits a file only when it exports everything the
  barrel will name, prints what it skipped and why, and tells you to regenerate. The same rule keeps
  a hand-written module in a scanned directory out of the barrel.

- **`setu generate` refuses a name that would collide with an existing artifact** (exit `1`), naming
  the conflict and the consequence. `route`, `controller` and `module` all mount `/<name>`, and the
  kernel's router keys routes by method and path — so a duplicate silently overwrites and one
  artifact becomes unreachable. `service` and `module` both register
  `@Injectable({ token: '<name>-service' })`, and the decorator plugin keeps the first class under a
  token — so the wrong service would be injected, which was observed as a `500` on every request to
  the affected module. Both checks apply only when `decorator-plugin` is installed, since neither
  collision can exist without it.

- **Fixed: `setu generate controller` emitted a controller that answered 500 on every request.**
  `DecoratorPlugin` builds a handler's argument list from parameter metadata alone and never passes
  the request context positionally, so the emitted `list(ctx: IRequestContext)` received `undefined`
  and threw on the first `ctx.response`. Handlers now take only decorated parameters and return
  plain values, which the plugin serializes as JSON; `create` takes `@Body()`. The `201` on create
  is gone rather than faked — a decorated handler cannot set a status code, so a handler that needs
  the context belongs on `app.router.get(...)` (`setu generate route`).

  Regenerate any controller produced by an earlier release, or drop its `ctx` parameter and return a
  plain value. Shipped alongside the module schematic below because it is the same package and the
  same one-line class of defect.

- **`setu generate module <name>` scaffolds a whole domain sub-module and wires it in** (M58),
  instead of requiring `g controller` + `g service` plus a hand edit of `setu.config.ts`. Emits an
  `@Injectable` service, a `@Controller` injecting it by token, a service test, a per-module barrel,
  and a regenerated aggregate barrel at `src/modules/index.ts` exporting `MODULE_CONTROLLERS` /
  `MODULE_SERVICES`. The `rest`, `microservice` and `nest` templates now scaffold a `setu.config.ts`
  that already imports both and passes them to `DecoratorPlugin`, so nothing the developer owns is
  ever edited by the CLI.

  ```bash
  setu new shop --template rest
  setu g module orders --dir shop   # wired; no edit to setu.config.ts
  ```

  Gated on `@setu-ts/decorator-plugin`, like `g controller`. `--template full-stack` is not a host:
  its layering is `routes → features → services` and it has no `src/modules/` concept. A project
  scaffolded before this release adds the barrel import once; every later `g module` is automatic.

  A directory counts as a module only when it holds both canonical files, so an unrelated folder
  under `src/modules/` is skipped instead of producing a barrel that imports files which do not
  exist. The host templates declare `@std/testing` and `@std/expect` (a `deno.json` import on
  Deno/Workers, an `npm:@jsr/std__*` alias on Node/Bun), so the emitted test runs with no further
  setup.

  `GeneratedFile` gains an optional `managed` flag and `SchematicOptions` an optional `modules`
  list. Both are additive — existing custom schematics compile unchanged. A managed file is exempt
  from the overwrite refusal, which previously covered every path without exception; only
  `src/modules/index.ts` is managed today, and the exemption is per file rather than a `--force`
  flag so a mistyped `g service` still cannot clobber hand-written work.

- **The OpenAPI document can be derived from the guards that enforce authentication** (M57), instead
  of requiring every route to declare a requirement a second time. `@setu-ts/common` gains a
  `SECURITY_METADATA` symbol, a `RouteSecurityMetadata` type, and the pure `withSecurityMetadata` /
  `securityMetadataOf` helpers; every guard `@setu-ts/auth-plugin` ships is branded with them, and
  `@setu-ts/openapi-plugin` reads the brand off a route's middleware.

  ```typescript
  app.register(OpenApiPlugin({
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    deriveSecurity: { scheme: 'bearerAuth' },
  }));

  app.router.get('/todos/:id', { middleware: [requireAuth()], handler }); // → requires bearerAuth
  app.router.post('/login', { middleware: [publicRoute()], handler }); // → public
  ```

  **Opt-in and non-breaking.** Without `deriveSecurity` nothing is derived and the document is
  byte-identical, and a requirement declared on `schema.security` always wins over a derived one.
  The brand is symbol-keyed and non-enumerable, so guard identity and behaviour are unchanged;
  `Symbol.for` is used so two copies of `common` in one process resolve the same key.

  Three limits are documented rather than left to discovery: only route-level middleware is
  inspected (`app.middleware.add()` is invisible to a route, which is correct for `authMiddleware()`
  — it populates the principal and never rejects); roles and permissions cannot be expressed,
  because an OpenAPI requirement names a scheme and none can be inferred from `'admin'`; and the
  scheme name is configured rather than inferred, with an undeclared name refused at `register()`.

- **`RouteSchema.security` and a document-level `security` option describe which operations need
  authentication.** `@setu-ts/openapi-plugin` accepted `securitySchemes` and emitted them under
  `components`, but nothing ever declared a **requirement** — `OpenApiOperation.security` existed in
  the generator's types with no assignment anywhere — so no operation was marked protected and
  generated clients had no signal that a route needed a token.

  `RouteSchema` in `@setu-ts/common` gains an optional `security`, alongside the `tags` and
  `summary` it already carried, plus a new exported `SecurityRequirement` type. The addition is
  optional, so existing routes and existing implementors are unaffected.

  ```typescript
  app.register(OpenApiPlugin({
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    security: [{ bearerAuth: [] }], // document-level default
  }));

  app.router.post('/login', { schema: { security: [] }, handler }); // explicitly public
  ```

  An **empty** `security` array is meaningful and is not the same as omitting the field: per the
  OpenAPI specification it declares the operation public, which is how a route opts out of the
  document-level default. Omitting the field leaves the operation inheriting it. Declaring this
  enforces nothing — authentication is still enforced by middleware and guards; this describes the
  route for documentation and client generation.

- **`OpenApiPluginOptions.exclude` keeps operational endpoints out of the document.** Paths are
  matched exactly against the fully-resolved router pattern — router-style (`/todos/:id`, not the
  OpenAPI template `/todos/{id}`) and including any `router.group()` prefix — and every method on a
  matched path is omitted.

- **`@Public` reaches the OpenAPI document.** A decorated route marked public is now documented with
  an empty `security` array, so it opts out of a document-level requirement. Without this the
  opt-out was reachable only from a programmatic `schema`, and a decorated login route would have
  been documented as requiring the token it issues. `@Roles`/`@Permissions` are deliberately not
  mapped: a role is not a security scheme, and no declared scheme can be inferred from one.

- **A `security` requirement naming an undeclared scheme is refused at `register()`,** naming the
  offending scheme and the declared ones. Emitting it produced a document that is invalid per the
  specification — Swagger UI renders a lock on every operation with no Authorize button to satisfy
  it, and strict validators and client generators reject it — while the spec endpoint still answered
  `200`, so nothing downstream could detect it.

### Fixed

- **The OpenAPI document no longer lists its own delivery endpoints.** `GET /openapi.json` and
  `GET /docs` were generated as API operations, so every consumer of the spec — Swagger UI readers
  and generated clients alike — was handed the documentation machinery as part of the API. Both are
  now excluded automatically, honoring `endpoint`/`specEndpoint` when they are customized. The
  routes are still served; only the document entries are gone.

- **Path parameters are typed as strings instead of rendering as `any`.** A path parameter with no
  entry in the route's `params` schema was emitted as `schema: {}`, which OpenAPI reads as "any
  type" — Swagger UI rendered an untyped box and client generators produced `unknown` arguments.
  Every path segment arrives as a string, so an undescribed path parameter now defaults to
  `{ type: 'string' }`. A declared `params` schema still wins, per parameter.

### Changed

- **Problem Details move from RFC 7807 to RFC 9457** (M56). RFC 7807 was obsoleted by
  [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) in July 2023, and the framework advertised
  the withdrawn specification in two packages, a public format alias, an exported symbol in each,
  the three starters, and every documentation site.

  `@setu-ts/exceptions` and `@setu-ts/validation-plugin` each gain an `'rfc9457'` format arm and an
  `rfc9457Formatter` export. `'rfc7807'` and `rfc7807Formatter` are **deprecated, not removed**
  (AI_GUIDELINES §9.2), and are scheduled for removal in v1.0.0.

  RFC 9457 changed very little on the wire — Appendix D lists three changes, none touching the five
  core members or the `application/problem+json` media type — so the bodies were already
  structurally valid. One 7807-era habit did need correcting, and that is the only behavior change
  here.

  > **⚠️ Breaking: `type` is now `about:blank` for status-only problems.** `@setu-ts/exceptions`
  > previously minted a URI from the status code for every error (`https://setu-ts.dev/errors/404`),
  > which identifies nothing the `status` member does not already carry. RFC 9457 §4.2 registers
  > `about:blank` for precisely that case, and that is what the `'rfc9457'` format now emits.
  > Clients matching on `type` to distinguish errors should read `status` instead. The one error
  > carrying an extension member, `validationError()`, keeps a concrete type URI —
  > `https://setu-ts.dev/errors/validation`, the same URI `@setu-ts/validation-plugin` emits for the
  > same problem type.
  >
  > ```jsonc
  > // Before                                   After
  > { "type": "https://setu-ts.dev/errors/404", { "type": "about:blank",
  >   "title": "Not Found",                       "title": "Not Found",
  >   "status": 404,                              "status": 404,
  >   "detail": "User 42 does not exist" }        "detail": "User 42 does not exist" }
  > ```
  >
  > Two escape hatches, in order of preference: read `status`, which is what it is for; or keep the
  > deprecated `format: 'rfc7807'`, which is **unchanged** and still emits the status-derived URI —
  > a deprecated symbol must not silently change behavior (§9.4).

  `@setu-ts/validation-plugin` has **no wire change at all**: its `type` was always a semantic URI
  rather than a status-derived one, so `rfc7807Formatter` there is a deprecated alias bound to the
  same object and the emitted body is byte-identical.

  The three starters (`rest`, `microservice`, `full-stack`) now compose `errorHandler` with
  `format: 'rfc9457'`, so an application built on one of them picks up the new `type` on upgrade.
  Applications wiring `errorHandler` themselves are unaffected until they change the format string.

### Fixed

- **The Problem Details media type survives a second formatter.** Both packages keyed
  `application/problem+json` off a single formatter **reference**, so that passing a formatter
  directly (`format: rfc9457Formatter`) agreed with passing the alias (`format: 'rfc9457'`). Adding
  a second formatter to that check without generalizing it would have served a Problem Details body
  as `application/json` — which generic problem-details clients ignore — while the string alias
  tested fine. The check is now a membership test over every Problem Details formatter, covered by
  tests that drive each spelling **by reference**.

- **`ARCHITECTURE.md` documented a `type` URI the code never emitted.** The Problem Details example
  showed `https://setu-ts.dev/errors/not-found`; the formatter emitted
  `https://setu-ts.dev/errors/404`. Corrected along with the rest of the section.

## [0.1.0-alpha.5] — 2026-08-08

**This release renames the project and moves every package to a new JSR scope.** It is the first
release published under `@setu-ts`; the `@hono-enterprise` packages are **archived** and receive no
further versions. Because the scope changes, **every consumer must update their imports and their
manifest** — there is no upgrade path that leaves specifiers untouched.

Two things about a prerelease under a brand-new scope, both of which will otherwise surprise you:
JSR does not point `latest` at a prerelease, so every install instruction must carry an explicit
version (`jsr:@setu-ts/kernel@^0.1.0-alpha.5`); and Deno refuses dependencies younger than 24 hours
unless you pass `--min-dep-age 0`, which affects the maintainer verifying the release rather than
ordinary users.

**The project is renamed from Hono Enterprise to Setu-TS, and every package moves to a new JSR
scope.** The old name asserted an association with the Hono project that does not exist: this
framework is not built, endorsed, or maintained by the Hono team, and its actual use of Hono is one
file — the kernel's router delegates matching to `jsr:@hono/hono`. That dependency is unchanged and
unaffected. The rename removes the false signal, nothing else.

> **⚠️ Breaking 1 of 5: every import specifier changes.** `@hono-enterprise/<pkg>` becomes
> `@setu-ts/<pkg>`, published under the `@setu-ts` JSR scope. On the npm compatibility path,
> `@jsr/hono-enterprise__<pkg>` becomes `@jsr/setu-ts__<pkg>`. This is a find-and-replace across
> your imports and your manifest; no API changes with it. The `@hono-enterprise` packages are
> **archived** on JSR — hidden from search and closed to new versions, but every published version
> stays installable and existing pinned builds keep resolving. They are deliberately **not yanked**:
> yanking signals a defective release and would break range resolution, and these versions are
> superseded rather than broken.

> **⚠️ Breaking 2 of 5: existing session cookies are invalidated.** The HKDF `info` parameters
> behind `@setu-ts/session-plugin` carried the old project name, so the derived encryption, signing,
> and key-id values all change. Every previously issued cookie fails to open and is treated as
> absent, signing users out once. No configuration changes and no key rotation is required — this
> happens on deploy and does not repeat.

> **⚠️ Breaking 3 of 5: the realtime backplane default topic changes.** `DEFAULT_TOPIC` moves from
> `hono-enterprise.realtime` to `setu-ts.realtime`, so replicas on either side of the upgrade **do
> not see each other's frames**. Restart all replicas together rather than rolling them, or pin the
> old value explicitly via the `topic` option to upgrade in stages. This mirrors the alpha.3
> request-reply wire change; if you do not use the backplane, nothing here applies to you.

> **⚠️ Breaking 4 of 5: RFC 7807 `type` URIs change.** The error-document base moves from
> `https://hono-enterprise.dev/errors` to `https://setu-ts.dev/errors`, affecting every Problem
> Details body from `@setu-ts/exceptions` and `@setu-ts/validation-plugin`. Clients matching on the
> `type` field need updating. Per RFC 7807 these URIs are identifiers and are not required to
> resolve.

> **⚠️ Breaking 5 of 5: the CLI binary is renamed.** `honoe` becomes `setu` — `setu new`,
> `setu generate`, and so on. Reinstall the CLI to pick up the new executable name; scaffolded
> projects are otherwise unchanged apart from the scope in their generated manifests.

Two further identifiers change with the rename and are noted for completeness rather than as
breaking: the exported `SESSION_STATE_KEY` is now `setu-ts:session`, and the GitHub repository moved
to `setu-ts/setu-ts`. Released sections below this one deliberately retain the `@hono-enterprise`
names, because they record what those releases actually shipped.

### Added

- **`@setu-ts/static-plugin` — static file serving as a capability** (M55). Registers `IStaticFiles`
  under a new `CAPABILITIES.STATIC_FILES` token and mounts one handler on both `GET` and `HEAD`.

  The framework previously had exactly one static file server, inside `react-router-plugin`, written
  for content-hashed SSR bundles: an unconditional `immutable` `Cache-Control` on every response, no
  directory-index resolution, no conditional requests, and a whole-file read into memory. That
  handler is unchanged and still correct for its job; this package is for everything else.

  Ships configurable `cacheControl` (a string, or a function receiving the root-relative path,
  defaulting to immutable-for-hashed and `must-revalidate` otherwise), `index` and `fallback` as
  separate options, conditional requests, single-range `206`/`416`, `.br`/`.gz` sidecar negotiation,
  a `static-files` health indicator, and streaming for files above `maxBufferBytes`.

  The SPA `fallback` fires only when `Accept` includes `text/html`. Without that guard a missing
  `.js` returns the HTML shell under a JavaScript content type, which browsers surface as an opaque
  syntax error.

  `ETag` is **strong** (`"<size>-<mtimeMs>"`) when the runtime reports an `mtime`, and degrades to a
  weak size-only validator when it does not. This is load-bearing rather than cosmetic: `If-Range`
  MUST be ignored for a weak validator (RFC 9110 §13.1.5), so a weak ETag makes every interrupted
  download restart from byte zero. `size`+`mtime` is what nginx and Apache emit as strong for static
  files.

  On Cloudflare Workers `runtime.fs` is absent, so the plugin registers its capability, reports
  `degraded`, and mounts no route. Use Workers Assets or R2 via `@setu-ts/cloudflare-plugin` there.

- **`IFileSystem.readStream?(path, { start, end })`** in `@setu-ts/common` — optional and additive,
  so no existing implementor breaks and every current caller is untouched. `end` is **inclusive**,
  matching both `node:fs` and the `Range` wire format, so no off-by-one translation exists.
  Implemented by the Node, Deno, and Bun runtime adapters and omitted on Workers, where callers
  degrade to a whole-file read exactly as they already do for `realPath`.

- **`contentTypeFor`, `isLexicallyContained`, `assertRealPathContained`** in `@setu-ts/common` —
  pure helpers shared by `static-plugin` and `react-router-plugin`, which now delegates to them. Its
  emitted headers are unchanged and pinned by a regression test.

- **`@Optional` constructor-parameter decorator** in `@setu-ts/decorator-plugin`. Pairs with
  `@Inject` on the same parameter (either order) and injects `undefined` when that token has no
  provider, so a class can depend on a capability the application may not have registered without
  the author hand-writing a container lookup.

  It means the dependency is **absent**, not that construction may fail: a token that IS provided is
  resolved normally, so a circular dependency or a throwing factory still surfaces instead of
  becoming `undefined`. Both construction paths honor it identically — the DI container when one is
  registered, the kernel's service registry otherwise.

  Three misuses are refused rather than silently misinjected: `@Optional` with no `@Inject` on the
  same parameter, `@Optional` combined with the deprecated class-level `@Inject(...)` list, and
  `@Optional` on a method parameter.

  On the container path a class carrying `@Optional` now registers as a `useFactory` provider
  instead of `useClass`, because `ClassProvider.inject` is a bare token list with nowhere to record
  optionality; its own `scope` is still honored, but its dependencies resolve from the registering
  container rather than the resolving scope. Classes without `@Optional` are unchanged. No `common`
  contract change and no new capability token.

- **`apps/full-stack` — a runnable React Router 8 SSR example** (M37c). The framework's full-stack
  story shipped in three places — the SSR plugin, the full-stack starter, and
  `honoe new --template full-stack` — and none of them had an application a reader could run. This
  one is served by the kernel through `react-router-plugin`, composed through
  `createFullStackAppFromConfig`, and its `smoke` task asserts that an SSR-rendered page contains
  rows **written through the database capability** — evidence that `populateLoadContext` bridges the
  kernel's service registry into a React Router loader, rather than that a server started. It then
  signs in through a `<Form>`, so the session and its synchronizer CSRF token round-trip too.

  Its routes are `/` (a landing page that reports session state), `/products` and `/login`.

  The example also makes the framework's distinguishing claim executable: `test/removal.test.ts`
  asserts that none of `lib/{session,csrf,sse,kv,service-logger}.server.ts` exists, and that
  `app/config/services.server.ts` holds no module-level cache — because the kernel's service
  registry is that cache.

  **The frontend build runs for real in CI, with no Node toolchain.** `deno install` plus the
  `@react-router/dev` CLI run the identical Vite build under Deno's own npm support (measured: ~4 s
  install, <1 s build), so no `ServerBuild` fixture is committed and `full-stack` is deliberately
  not in `ALLOW_SKIP`. No published package changed; the frontend build remains an app-level,
  build-time concern outside every published dependency graph (AI_GUIDELINES §12.2).
- **`@setu-ts/messaging-plugin`** — GCP Pub/Sub (`GcpPubSubBroker`) and Azure Service Bus
  (`ServiceBusBroker`) backends implementing `IMessageBroker` with request-reply over a shared reply
  topic + per-instance subscription. `MessagingPluginOptions` is now a **discriminated union on
  `broker`** with a `'custom'` arm (inject any `IMessageBroker`) and a default memory arm so
  `MessagingPlugin()` / `MessagingPlugin({})` remain valid. `MessagingBrokerType` widened to 8
  literals. Both cloud brokers throw `CloudBrokerUnavailableError` on Cloudflare Workers. **Verified
  against the vendors' own local emulators** — Google's Pub/Sub emulator and Microsoft's Service Bus
  emulator — covering publish/subscribe over real gRPC/AMQP, ack/nack settlement producing genuine
  redelivery, receiver teardown, and on Pub/Sub the RPC reply subscription's create/delete cycle.
  See `docs/messaging-emulators.md`. **Service Bus RPC is unverified**: that emulator supports no
  management operations, so the per-instance reply subscription cannot be created there — the suite
  asserts the refusal surfaces `ReplyInboxUnavailableError` instead. Neither backend has run against
  a live cloud account.
- **`@setu-ts/queue-plugin`** — SQS `SqsQueue` adapter (`QueueAdapter` seam, wrapped by
  `QueueService`) with per-name queue URLs, receipt-handle bookkeeping, `ApproximateReceiveCount`
  attempt ladder, visibility-timeout backoff, and dead-letter ordering. `SnsPublisher` for SNS
  fan-out. `QueueAdapterType` widened to include `'sqs'`. `QueueBackendUnavailableError` thrown on
  Cloudflare Workers. **The SQS adapter is verified against ElasticMQ** in CI (that suite drives
  `SqsQueue` directly; the `QueuePlugin` → `QueueService` wiring is covered separately by
  `sqs-arm-integration.test.ts` over a contract-honouring transport fake). SNS is fake-driven.

### Changed

- Node and Bun compatibility is now verified on every pull request, retiring the known limitation
  recorded in `0.1.0-alpha.1`. The `Node compatibility` and `Bun compatibility` CI jobs were
  placeholders blocked on the first JSR publish; they now install the published packages through
  JSR's npm compatibility layer and run `compat/compat.test.mjs`. **All 46 published packages are
  installed and imported** on each runtime — a package whose ESM output or transitive dependency
  does not resolve there is broken for every consumer and nothing else in CI would see it — and the
  suite then boots a kernel application, resolves a capability, and serves a request over a real
  socket. The expected package list is derived from the Deno workspace, so a new package that is
  never added to the compat suite fails the job rather than quietly shrinking coverage. The suite
  tracks the latest published release rather than `HEAD`, because Node and Bun cannot resolve this
  repo's `jsr:` and `npm:` specifiers from source.
- **⚠️ Breaking 1 of 1: `MessagingPluginOptions` is now a discriminated union.** A caller holding a
  widened variable (e.g. `let opts: MessagingPluginOptions = getOptions()`) must narrow before
  passing to the factory. Single-arm literals, `MessagingPlugin()`, `MessagingPlugin({})`, and the
  factory's own `= {}` default are unaffected. `MessagingBrokerType` includes `'pubsub'`,
  `'service-bus'`, and `'custom'`.
- **`@setu-ts/queue-plugin`** — the INTERNAL `QueueAdapter` seam gained a `claimToken` argument on
  `ack`/`requeue`/`deadLetter`, and `StoredJob` an optional `claimToken?`. It identifies one
  delivery, so an adapter can refuse a settle belonging to a superseded one — SQS needs this because
  a requeued message returns with a new `ReceiptHandle`. Adapters without a transport-level claim
  (memory, redis, rabbitmq) accept and ignore it. Neither type is barrel-exported, so **no published
  surface changes**; listed because it alters a contract shared by every adapter.

### Fixed

- **`@setu-ts/queue-plugin`** — the SQS backend settled nothing through `QueuePlugin`. The job
  runner passed the job id where the adapter expected the `claimToken` minted by `reserve`, so every
  `ack`/`requeue`/`deadLetter` failed its own claim check and returned without calling SQS: a
  processed job was never deleted and redelivered after each visibility timeout, forever. Adapter
  tests and the ElasticMQ e2e passed because both settle the adapter directly, supplying the token
  the real caller did not. Now covered through a real kernel application.
- **`@setu-ts/messaging-plugin`** — `ServiceBusBroker` leaked an AMQP receiver link per
  `unsubscribe()`. Teardown closed only the subscriber handle returned by `receiver.subscribe(...)`
  and never the receiver itself; it also closed the most recently opened receiver rather than the
  one being unsubscribed, so cancelling one of two subscriptions on the same topic stopped the wrong
  delivery.
- **`@setu-ts/messaging-plugin`** — `GcpPubSubBroker` and `ServiceBusBroker` constructed standalone
  with neither credentials nor an injected transport now fail at `connect()` naming the missing
  option, instead of building a client on an empty `projectId` / connection string and failing later
  inside the SDK.

- Redis-backed cache, queue, and messaging plugins now create ioredis clients with `lazyConnect`.
  Their explicit startup `connect()` call no longer fails because ioredis connected eagerly during
  construction.
- `@setu-ts/queue-plugin` — `RedisQueue.reserve()` now sends the mandatory `LIMIT` keyword in the
  `ZRANGEBYSCORE` command, so reserve works against a real Redis server. Previously the call sent
  positional offset/count arguments without the keyword, which caused Redis to return
  `ERR syntax error` on every reserve attempt.
- `@setu-ts/messaging-plugin` — `RedisStreamsBroker` now hands a timer handle back to
  `clearInterval` exactly as `setInterval` returned it. It previously stored the handle as a
  `number`, and `TimerHandle` is deliberately opaque (`unknown`), so a runtime returning an
  object-shaped handle had it coerced to `NaN` — making the cancel a silent no-op and leaking a poll
  loop that kept issuing commands after `unsubscribe()` and `disconnect()`. The bundled Node, Deno,
  and Bun runtimes were unaffected, because their handles happen to coerce to a numeric id; a custom
  `IRuntimeServices` whose handle does not coerce leaked outright.

## [0.1.0-alpha.4] — 2026-08-04

**The largest release so far: eight packages publish for the first time, bringing the scope to 46.**
The three starters (`rest-starter`, `microservice-starter`, `full-stack-starter`) ship at last,
along with `session-plugin`, `service-discovery-plugin`, `grpc-plugin`, `graphql-plugin`, and
`cloudflare-plugin`. Every other package is version-bumped so the scope stays on one version — the
CLI requires this, because `honoe new` stamps generated projects with its own version as the range
for every package it wires.

**Two changes can alter behavior you already depend on.** Both are narrow, and neither is a
capability regression, but the first is silent at compile time.

> **⚠️ Breaking 1 of 2: `@Cookie` and `parseCookies` return different values.** Cookie values are
> now percent-decoded, one layer of RFC 6265 quoting is stripped, and a repeated cookie name
> resolves to the **first** occurrence rather than the last. Nothing stops compiling, so this
> changes at runtime rather than at build time — if you were decoding values yourself after calling
> `parseCookies`, remove that step, because double-decoding will corrupt any value containing a
> literal `%`. Each difference is a defect fix; see _Changed_ for why they are being corrected
> during `0.1.x` rather than frozen.

> **⚠️ Breaking 2 of 2: `IGraphqlService` gains a required `subscribe` method.** Source-compatible
> for every caller and **breaking only for anyone who implements the interface**. The framework's
> own `GraphqlService` is the only implementor in this repository, so if you have not written your
> own GraphQL service, nothing here applies to you.

**Cloudflare is now a first-class target rather than merely a runtime that boots.** Four milestones
add KV, R2, D1, Queues, Cron Triggers, the Cache API, and Durable Objects behind typed accessors
that name a missing binding instead of handing you `undefined` — and they fixed the reason
`runtime.env` was empty on Workers, which had left `ConfigPlugin` and the secrets `EnvProvider`
reading nothing on the edge.

Alongside that: gRPC, Connect, and gRPC-Web co-served on the same port as ordinary routes; a GraphQL
plugin with subscriptions over both WebSocket and SSE; service discovery over Consul, Kubernetes,
DNS-SRV and static configuration, with load balancing and outlier ejection; cookie sessions with
form CSRF; and the starter and template work that makes all of it composable in one call.

### Added

- **GraphQL subscriptions, batching, and persisted queries** (Milestone 51b).
  `@hono-enterprise/graphql-plugin` gains two subscription transports — the `graphql-transport-ws`
  protocol over the OPTIONAL `CAPABILITIES.WEBSOCKET`, and GraphQL-over-SSE in distinct-connections
  mode over M42's `IResponse.stream()`, which needs no other plugin — plus request batching,
  Automatic Persisted Queries with server-side hash verification, and custom scalar resolvers in the
  schema-first arm.

  **Every new behaviour is opt-in.** `subscriptions`, `apq`, and `maxBatchSize` all default to off,
  so an application that upgrades without changing its options registers exactly the routes it did
  before and answers byte-identically. In particular the HTTP endpoint **still refuses a
  subscription** with `400 SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP`; subscriptions are reachable only
  on the dedicated WebSocket and SSE routes, which default to the endpoint path plus `/ws` and
  `/stream`.

  A subscription is declared in the schema-first resolver map as `{ subscribe, resolve? }` — the new
  exported `SubscriptionResolver` arm on `ResolverMap`. APQ verifies that a submitted hash matches
  the submitted document before persisting it, so a shared `ICacheStore` cannot be poisoned with a
  document under another client's hash; a mismatch answers `PERSISTED_QUERY_HASH_MISMATCH`. Resolver
  errors raised inside a live subscription are masked by the same `maskInternalErrors` path the HTTP
  transport uses.

  Three `@hono-enterprise/common` widenings: `GraphqlRequestParams.extensions` (read by APQ),
  `IGraphqlService.subscribe` with `GraphqlSubscriptionOutcome` / `GraphqlOperationContext` /
  `GraphqlConnectionInfo`, and `WebSocketRouteOptions.heartbeat` (below).

### Changed

- **`IGraphqlService` gains a required `subscribe` method** (Milestone 51b) — source-compatible for
  every CALLER, and **breaking for anyone who implements the interface**. The framework's own
  `GraphqlService` is the only implementor in this repository. An external implementation adds:

  ```typescript
  subscribe(
    params: GraphqlRequestParams,
    context?: GraphqlOperationContext,
  ): Promise<GraphqlSubscriptionOutcome>;
  ```

  The second parameter is deliberately NOT an `IRequestContext`: a WebSocket connection has none,
  and reusing `execute`'s parameter is what would hand a subscription resolver an empty service
  registry.

- **`WebSocketRouteOptions.heartbeat`** (Milestone 51b). A route may now opt out of
  `websocket-plugin`'s shared heartbeat sweep with `heartbeat: false`, which excludes its
  connections from both the payload send and the idle eviction. Defaults to `true`, so no existing
  route changes. This exists because the sweeper sends a raw text frame to every connection on every
  route: a `graphql-transport-ws` client that receives one must close with `4400`, so
  `WebSocketPlugin({ heartbeatMs })` would otherwise have broken every GraphQL subscription in the
  application. The GraphQL WS route claims the opt-out and runs its own protocol `ping`/`pong`.

- **Durable Objects: a realtime backplane and a distributed lock** (Milestone 52d).
  `@hono-enterprise/cloudflare-plugin` gains a `durableObject` arm registering
  **`DurableObjectBackplane`** under the committed `CAPABILITIES.REALTIME_BACKPLANE`, so
  `websocket-plugin` and `sse-plugin` reach clients on other replicas with no application change —
  and **`DurableObjectLock`**, which structurally satisfies `scheduler-plugin`'s `IDistributedLock`
  and is handed to `SchedulerPlugin({ distributedLock: { lock } })` (an injected lock wins outright;
  `enabled: true` is not required). No `common` change and no new capability token: both contracts
  were already committed. Register **either** this arm or `RealtimeBackplanePlugin`, never both —
  the kernel rejects two providers of one token.

  Both need a Durable Object class the **application** exports, plus a wrangler stanza; the package
  ships the behaviour as two plain cores (**`RealtimeBackplaneObjectCore`**,
  **`DistributedLockObjectCore`**) that the exported class delegates to. A mixin taking the base
  class would read better but cannot be typed without `any`, and delegation additionally keeps
  `cloudflare:workers` — unresolvable off a Worker toolchain — out of the package.

  Two platform facts shaped the implementation rather than being worked around. Sockets are accepted
  with `ctx.acceptWebSocket`, the **hibernation** API, which lets the runtime evict the object and
  re-run its constructor while connections stay open; the fan-out core therefore holds **zero**
  in-memory state and treats `getWebSockets()` as the only membership, because a `Set` in a field
  would empty itself on the first hibernation while every non-hibernating test still passed. And a
  Worker isolate cannot be relied on to hold a long-lived outbound WebSocket, so the socket opens
  lazily and reopens after any failure; the guarantee is stated rather than overstated — a
  subscription lives exactly as long as the isolate holding the members it serves, and since those
  members are client sockets in the same isolate, losing one loses both together. The lock persists
  its holder in the object's storage, never a field, because an object is evicted after 70–140
  seconds idle; correctness comes from the platform's input gate ("while a storage operation is
  executing, no events shall be delivered to the object"), which makes the read-compare-write atomic
  with no transaction. A non-2xx from the lock object **throws** rather than reporting "not
  acquired", since a 404 means the binding names the wrong class and folding that into contention
  would silently disable every scheduled job.

  Also closes the last hole in the binding-guard family: `BindingRegistry.durableObject` cast its
  binding **unvalidated**, so a missing `durable_objects` stanza or a mistyped `class_name` let an
  application boot clean and fail on the first `idFromName` with a bare `TypeError` — the defect
  M52c's review found on D1. Adds the exported **`isDurableObjectNamespace`** guard and constructor
  validation. Verified against real workerd via `wrangler dev` (12/12 checks), which also settled
  the design question the milestone could not answer from docs: **a plain Durable Object class
  without `extends DurableObject` is accepted**, so the delegation design is correct and not merely
  convenient. Not verified against a deployed Worker — CI holds no Cloudflare account.

### Fixed

- **A listen-only replica received nothing from a realtime backplane.**
  `IRealtimeBackplane.connect()` had exactly one caller — `RealtimeBackplanePlugin.register()` — and
  `websocket-plugin` / `sse-plugin` relied on the provider having connected before they subscribed.
  `subscribe()` registers a handler; it does not open a transport. Any provider that cannot connect
  at registration therefore left every replica that only listens silently receiving nothing, which a
  Cloudflare Durable Object backplane is the first transport to hit: a Worker runs `register()` at
  module scope, where the platform forbids the I/O `connect()` performs.

  Both consumers now open the transport on first local use, inside a request context on every
  runtime — `WebSocketService` when a connection joins its first room, `SseService` when a client
  connects. The call is fire-and-forget so an upgrade never waits on the transport, idempotent per
  the committed contract, and retried on the next join if it fails. Applications registering
  `RealtimeBackplanePlugin` are unaffected: its provider still connects at registration, and the
  extra call is a no-op.

- **Cloudflare D1 as a first-class database backend, and the `common` data-access promotion that
  made it possible** (Milestone 52c). The seam a database backend implements was `IDatabaseAdapter`,
  declared **inside** `@hono-enterprise/database-plugin` and never exported, while `common` shipped
  only the lifecycle-shaped `IOrmAdapter` — so a backend living in any other package was literally
  inexpressible, because AI_GUIDELINES §2.2 forbids one plugin importing another.
  `@hono-enterprise/common` now exports **`IDatabaseAdapter`, `IAdapterTransaction`, `IDataSource`,
  `NormalizedQuery` and `OrderDirection`**. The promoted port is the old shape plus one member — a
  non-transactional `createDataSource(entity)` — and that addition is the substance of the change:
  the plugin previously reached each adapter's data-source factory by **casting to the concrete
  class**, which is what actually kept the seam closed. That cast is gone, all three built-in
  adapters carry `createDataSource`, and `createDataSourceForEntity` is **deprecated, not removed**
  (§9.2). `DatabasePluginOptions` is now a union discriminated on `type` with a **`'custom'` arm**
  requiring an `adapter`, so registering an external backend without one is a compile error rather
  than a startup throw; every existing registration compiles unchanged. `DataSource` is retained as
  a deprecated alias of `IDataSource`. The promotion also repairs a latent public-API defect: the
  barrel exported `DataSource`, whose `findAll` parameter is `NormalizedQuery`, while
  `NormalizedQuery` itself was not exported — no consumer could name the type.

  `@hono-enterprise/cloudflare-plugin` gains **`D1Adapter`** (plus `D1AdapterOptions`,
  `D1EntityMapping`), constructed by the application from its D1 binding and handed to
  `DatabasePlugin({ type: 'custom', adapter })` — the `KvSessionStore` precedent, since those plugin
  options are read before any application exists. **D1 has no interactive transaction**: it rejects
  `BEGIN TRANSACTION` outright, and `batch()` is its only unit of atomicity. `beginTransaction()`
  therefore **buffers every write and flushes the whole buffer as one `batch()` at commit**;
  `rollback()` discards it and sends nothing. Atomicity is genuine, and the two costs are documented
  and tested rather than left to discovery: there is **no read-your-own-writes** inside a
  transaction (reads run against committed state), and an in-transaction `create()` **requires an
  explicit primary key**, throwing `CloudflareUnsupportedError` when absent — a deferred `INSERT`
  cannot report a generated key to a caller that awaits `create()` before the flush. Outside a
  transaction `create()` uses `RETURNING *` and returns the real persisted row. Values are always
  bound (`?N`); identifiers cannot be, so table and column names are validated against
  `[A-Za-z_][A-Za-z0-9_]*` and double-quoted, and every builder refuses a statement that would
  exceed D1's documented **100-bound-parameter** limit. Not verified against live D1 — CI holds no
  Cloudflare account — though the whole surface is driven against a real SQLite engine, the engine
  D1 runs, including batch rollback.

- **Cloudflare Queues, Cron Triggers, and the Cache API in `@hono-enterprise/cloudflare-plugin`**
  (Milestone 52b) — the three platform features that need a **module-level handler export** from the
  application's Worker rather than anything reachable through `fetch`. No `common` change and no new
  capability token. `WorkersQueue` satisfies the committed `IQueue` over a Queues producer binding,
  opt-in through a `queue` arm and registered under `CAPABILITIES.QUEUE` (or `queue.<name>`); the
  job's **name and id travel in a `{ v, name, id, data, maxAttempts? }` envelope**, because a
  Cloudflare message body is arbitrary JSON carrying neither and `producer.send()` resolves to
  `void`, so the id `add` returns is the id the processor sees as `job.id`.
  `createQueueHandler(app)` builds the `queue` export. A message whose body is not a readable
  envelope, or whose name has no processor, is **retried rather than acked** — acking would discard
  it permanently and silently, the failure a queue exists to prevent — and
  `AddJobOptions.maxAttempts` is enforced at dispatch, since Cloudflare's `max_retries` is
  queue-wide configuration rather than per message. `addRecurring` throws, naming Cron Triggers as
  the platform's own mechanism. Cron Triggers ship as `WorkersCron` plus
  `createScheduledHandler(cron)`, and **deliberately do not register `CAPABILITIES.SCHEDULER`**: of
  `IScheduler`'s eight methods only `cron` is expressible on Workers — `every` and `delay` arm
  timers across an isolate eviction (the same reason `scheduler-plugin` cannot run there),
  `pause`/`resume`/`remove` need state that does not survive an invocation, and `getNextRun` is
  owned by the `wrangler.toml` `[triggers]` block. An implementation where six of eight methods
  throw would violate Liskov substitution, so a small honest surface was chosen instead. An
  expression is matched against `ScheduledController.cron` **exactly**, and `expressions()` exists
  so an application can assert its own coverage against `wrangler.toml`, which no code in the
  process can read. `cacheApiMiddleware` caches responses in `caches.default`. It is a **different
  layer** from `cache-plugin`'s `cacheMiddleware` and composes with it, so it reports under
  **`X-Cache-Api`** rather than `X-Cache`. The platform's own refusals — non-GET, status 206,
  `Vary: *`, and an uncleared `Set-Cookie` — are checked first through the pure exported
  `assessCacheability` rather than discovered from a thrown `put`; the 206 and `Vary: *` rules are
  unconditional, because an operator may legitimately configure `cacheableStatuses: [200, 206]` and
  only the explicit rule then stops the platform throwing. The write rides
  `ICloudflareBindings.waitUntil` when the plugin is registered and is awaited inline when it is
  not, so it is never simply abandoned; with no cache handle at all the middleware passes through
  rather than throwing, so an application composed for several targets still serves off Workers. A
  HIT is replayed with `IResponse.stream`, so a cached response of any size reaches the client
  unbuffered — which means `app.inject()` cannot read it and cached routes are tested with
  `app.fetch`. `caches.default` is **per-datacenter**: a latency optimisation, not a shared store.
  D1 as a database backend moved to **Milestone 52c** (it needs the `IDatabaseAdapter` seam promoted
  from `database-plugin` into `common`, plus reconciling `ITransaction` with D1's batch-only
  atomicity) and Durable Objects to **Milestone 52d** (both the realtime backplane and the
  distributed lock need the application to export a DO class, and Durable Objects expose no pub/sub
  primitive, so a backplane means each replica holding a WebSocket to the object).

- **`@hono-enterprise/cloudflare-plugin`** (Milestone 52) — a new package registering
  `ICloudflareBindings` under a new `CAPABILITIES.CLOUDFLARE` token. The framework has served
  traffic on Workers since the Hono migration but could not reach a single platform binding; this
  publishes them as one typed accessor (`kv`, `r2`, `d1`, `queue`, `service`, `durableObject`,
  `get<T>`, `vars`, `waitUntil`), and optionally serves the committed cache and storage capabilities
  from KV and R2. **Zero npm dependencies**, and nothing in the package imports `cloudflare:workers`
  — the application passes `env` (and `waitUntil`) in, which keeps the package type-checkable on
  every runtime. `KvCacheStore` reconciles `ICacheStore`'s unbounded TTL with KV's 60-second
  `expirationTtl` floor by carrying a logical deadline inside the value, so a 5-second entry expires
  in 5 seconds rather than surviving a minute. The decoder reports three outcomes rather than two —
  live, _this store's_ expired entry, and neither — so a read never deletes a key the store does not
  own and a deliberately cached `null` survives; `clear()` additionally requires a key prefix,
  because the binding has no bulk delete and an unprefixed sweep would remove foreign keys.
  `R2Storage` implements the optional `getStream`, heads before `delete` so its committed
  `Promise<boolean>` is honest, and **throws** from `getSignedUrl` — the R2 Workers binding has no
  presign operation. `KvSessionStore` is constructed by the application and handed to
  `SessionPlugin({ store })`, since that option is read before any application exists. No binding
  I/O happens at registration, where the platform forbids it, and the `cloudflare` health indicator
  performs none either.
- **`splitWorkerEnv` and `SplitWorkerEnv` in `@hono-enterprise/common`** (Milestone 52) — the pure
  partition of a Workers `env` record into string variables and object bindings. In `common` because
  both `runtime` and `cloudflare-plugin` need the identical rule and no plugin may import another.

- **`@hono-enterprise/service-discovery-plugin`** (Milestone 50) — a new package registering an
  `IServiceDiscovery` under a new `CAPABILITIES.SERVICE_DISCOVERY` token, so an application can turn
  a logical service name into a reachable address. Five provider arms — `'static'`, `'consul'`,
  `'kubernetes'` (EndpointSlices), `'dns'` (`SRV` and address records), and `'custom'` — behind one
  `DiscoveryProvider` port, with the option type a **union discriminated on `provider`** so a
  missing per-arm credential is a compile error rather than a startup throw. Zero npm dependencies:
  the HTTP providers run on web-standard `fetch` and the DNS provider on the new optional
  `IRuntimeServices.dns`. Adds a monotonic-clock read-through cache with per-service in-flight
  coalescing and stale-on-failure; push-based `watch()` over Consul blocking queries (both
  documented index hazards handled — a backwards index resets to zero, an index of `0` becomes `1`
  to avoid busy-looping older servers) and Kubernetes watch streams (used as a change **signal**
  rather than a delta log, with `410 Gone` resync); three balancing strategies over
  `IRuntimeServices.randomBytes`; and outlier ejection with a panic-threshold cap and an all-ejected
  fallback. Ejection is deliberately **not** a second circuit breaker: `wrap` breaks a call site,
  ejection removes a pool member while the call site stays open.
- **`IServiceDiscovery`, `ServiceInstance`, `PickOptions`, `LoadBalanceStrategy`, `ServiceOutcome`
  and `CAPABILITIES.SERVICE_DISCOVERY` in `@hono-enterprise/common`** (Milestone 50) — the contract
  a consumer types the resolved capability as, without importing the plugin.
- **`IRuntimeServices.dns?: IDnsResolver`** and `SrvRecord` in `@hono-enterprise/common`, with
  `createNodeDnsResolver` (Node + Bun, over `node:dns/promises`) and `createDenoDnsResolver` (over
  `Deno.resolveDns`) exported from `@hono-enterprise/runtime` (Milestone 50). Purely additive,
  following the `fs?` / `workers?` precedent; **Cloudflare Workers omits the key entirely**, since
  its network access is `fetch`, which resolves names internally and exposes no lookup surface.
  `SrvRecord.host` is a normalized name on purpose — Deno spells the field `target`, Node spells it
  `name`, and passing either through unchanged would type-check on both runtimes while producing
  `undefined` hostnames on one.
- **`ILifecycleApi.onStopping`** in `@hono-enterprise/common` and `@hono-enterprise/kernel`
  (Milestone 50) — a new lifecycle phase running at the very start of `stop()`, **before** the
  application begins refusing new requests and before the socket closes. It is the only hook that
  fires while the application is still serving normally, which is what makes it correct for
  deregistering from a service registry: doing that in `onShutdown` leaves callers routed at a
  closed port for up to one health-check interval on every rolling deploy. Listed under Added rather
  than Changed because no existing behavior moves — `Application.#doStop()` skips the phase entirely
  when no hook is registered, so `stop()` is byte-for-byte unchanged for every application that does
  not opt in. (Awaiting an already-resolved promise instead would still defer when the shutting-down
  flag flips, handing a 404 to a request that used to get a 503 — a pre-existing kernel test caught
  exactly that.)

- **`honoe new --template full-stack`** (Milestone 36c) — scaffolds a React Router 8 SSR
  application: the `routes → features → services → models` layering, `flatRoutes` `_app`/`_auth`
  layout groups, the `~/*` alias, the `.server.ts` convention, one worked feature, and the Vite
  build files. What it deliberately does **not** emit is as important as what it does: no
  `lib/session.server.ts`, `lib/csrf.server.ts`, `lib/sse.server.ts`, `lib/kv.server.ts` or
  `lib/service-logger.server.ts`, because those are the session, SSE, secrets and logger
  capabilities, reached through the service registry the SSR plugin attaches to every request. The
  session reaches loaders through a context key the **application** declares and
  `populateLoadContext` fills, so no plugin imports another. Every runtime target is supported;
  Cloudflare Workers omits `assetsDir` and leaves assets to the platform binding. This is the only
  template that composes through a starter rather than inline wiring — its plugin set is twenty-two,
  and a generated file a human is meant to edit should not open with twenty-two imports they did not
  choose.
- **`contextKeyFor` in `@hono-enterprise/react-router-plugin`** (Milestone 36c) — creates React
  Router context keys by name, memoised, so the same name always yields the same object. Keys are
  matched by identity, and in a framework-mode application the module declaring them exists twice:
  Vite inlines application modules into the server build, while the runtime loads `honoe.config.ts`
  from source. Two hand-written `{ defaultValue }` literals then match nothing, and every read
  silently returns the default — a session that is always `null`, a CSRF token that is always empty,
  with no error raised. Requires the server build to treat `@hono-enterprise/*` as external
  (`environments.ssr.build.rollupOptions.external`), which the `full-stack` template configures. The
  `serverBuildPath` JSDoc now also states that the path must be **absolute**: the loader does
  `await import(serverBuildPath)`, so a relative specifier resolves against the plugin's own module
  and can never find the application's build.
- **`createFullStackAppFromConfig` in `@hono-enterprise/full-stack-starter`** (Milestone 36c) —
  `(build: (config: IConfig) => FullStackStarterOptions, options?: FromConfigOptions) =>
  Promise<IKernelApplication>`,
  where `FromConfigOptions` carries `config` (loading options) and `env`. **`env` is required on
  Cloudflare Workers**, where bindings arrive per request rather than process-wide, so without it
  the application composes from an empty configuration and fails on every request; the `full-stack`
  template threads the handler's `env` through automatically. Plugin options must be decided before
  the plugins are constructed, which is before `ConfigPlugin` has registered anything; this loads
  configuration once, hands the snapshot to the resolver, and passes that same object into the
  application, so the values the composition branched on are the values handlers read. It applies to
  every option uniformly, which is why no plugin option carries a `urlFromConfig`-style config-key
  field — such a field would need its value at the same impossible moment. Secrets remain out of
  reach by construction: they are served by a plugin that exists only after registration.
- **`loadConfig` and `ConfigPluginOptions.instance` in `@hono-enterprise/config-plugin`** (Milestone
  36c) — `loadConfig(runtime, options?)` is the same implementation `ConfigPlugin` registers,
  reachable without an application; `instance` registers a supplied snapshot verbatim, reading
  nothing from the environment. `ConfigPlugin.register` now delegates to `loadConfig`, so merging,
  expansion, and validation cannot drift between the two paths.
- **`createRuntimeServices` in `@hono-enterprise/runtime`** (Milestone 36c) — builds
  `IRuntimeServices` for the detected platform without an application. The barrel previously
  exported `detectRuntime` and four per-platform factories but nothing joining them, so the platform
  → adapter map was unreachable outside `RuntimePlugin.register`; that method now delegates here,
  leaving one implementation behind two entry points. `RuntimeAdapterFactories` and
  `CreateRuntimeServicesOptions` are exported alongside it.
- **Gated `session` arm on the three starters** (Milestone 36c) — `RestStarterOptions.session`
  registers `SessionPlugin`, inherited by the microservice and full-stack tiers. M48 shipped after
  the starters, so no tier could previously register a session at all. Gated because the plugin
  throws during `register()` without an adequate secret; **no default changes**.
- **Parameter-level `@Inject` in `@hono-enterprise/decorator-plugin`** (Milestone 36b) — `Inject`
  now works on a constructor parameter as well as on the class, binding one token to that argument
  by position, which is the form a developer arriving from NestJS expects:
  `constructor(@Inject(CAPABILITIES.DATABASE) private db: IDatabase) {}`. The class-level positional
  list is **deprecated, not removed** (AI_GUIDELINES §9.2) and keeps working for the whole `0.x`
  line. A token is still always required — inferring it from the parameter's type needs
  `emitDecoratorMetadata`, which Deno does not support — so three ambiguous cases throw at startup
  rather than misinjecting silently: mixing the two forms on one class, leaving a constructor
  parameter undecorated below the last injected one, and applying `@Inject` to a _method_ parameter.
- **Gated `realtime` and `di` arms on the three starters** (Milestone 36b) — `realtime` groups
  `websocket`, `sse`, and `backplane` sub-arms; `di` adds `DiPlugin`. Added to `RestStarterOptions`,
  so the microservice and full-stack tiers inherit them. **No default changes**: with no arm
  supplied the plugin set of all three tiers is byte-identical to the previous release. Supplying
  `di` does change how decorated services are constructed (`DecoratorPlugin` switches to its
  container path), which is why it is opt-in. `RealtimeArm` is exported from all three starter
  barrels.
- **`honoe new --template nest`** (Milestone 36b) — the REST plugin set plus `DiPlugin`, an
  `@Injectable` service, and a `@Controller` using parameter-level `@Inject`. Emits inline wiring
  like the other templates, and refuses no runtime target.
- **`Wiring.args`, `TemplateDefinition.localImports`, and `TemplateDefinition.files` in
  `@hono-enterprise/cli`** — the template contract could previously express neither a plugin call
  argument nor an extra emitted source file. All three are optional and every existing template
  renders byte-identically (`args` absent → `Symbol()`).
- **`@hono-enterprise/session-plugin`** (Milestone 48) — cookie-backed sessions and session-backed
  form CSRF, registering an `ISessionService` under the new `CAPABILITIES.SESSION` token. The
  default is a self-contained encrypted cookie (AES-256-GCM under an HKDF-SHA256 derived key,
  entirely through `runtime.subtle`), so the package has **zero npm dependencies** and works on
  Cloudflare Workers. Setting `store` (`'memory'`, `'cache'`, or a custom `ISessionStore`) moves the
  payload server-side and leaves an opaque id in the cookie, which is what makes immediate
  revocation possible. Secret rotation goes through a key list — index 0 seals, every entry opens —
  with an HKDF-derived non-secret `kid` in the envelope so opening is a lookup rather than trial
  decryption. Ships `getSession`, `getCsrfToken`, `verifyCsrfToken`, `csrfFormMiddleware`,
  `sessionMiddleware`, both stores, and four error types. Note that `mode: 'sign'` protects
  integrity only and leaves the payload readable by the client; `'encrypt'` is the default so that
  choice is never accidental.
- **`parseCookie` / `serializeCookie` / `CookieAttributes` in `@hono-enterprise/common`** — the
  framework's single cookie codec. It lives in `common` because the session plugin and the decorator
  plugin's `@Cookie` both need it and no plugin may import another (the `encodeFrameData`
  precedent).
- **`ISessionService` / `ISession` / `ISessionStore` / `SessionData` contracts** and
  `CAPABILITIES.SESSION` in `@hono-enterprise/common`. No `IRequest` widening was needed: the
  session middleware parks the session in `ctx.state`, so a `cookies` field with no consumer was
  declined.
- **`scalingNotice` option on `WebSocketPluginOptions` and `SsePluginOptions`** (`boolean`, default
  `true`) — set `false` to silence the startup notice described below, for a deployment where you
  have decided single-replica fan-out is correct and do not want the line on every boot. It
  suppresses the message only: room and channel delivery are identical either way, and the notice
  never appears once a backplane is registered.

### Changed

- **`runtime.env` is now populated on Cloudflare Workers** (Milestone 52). `RuntimePlugin` and
  `createRuntimeServices` gain an `env` option; passing the Worker's `env` makes `ConfigPlugin` and
  the secrets `EnvProvider` work on the edge, where previously they read an empty record. Only
  **string** entries reach `runtime.env`, which is contracted as a string record — object bindings
  are filtered out rather than stringified to `[object Object]`. Behaviour on Deno, Node, and Bun is
  unchanged; the option is ignored there.
- **`honoe new --runtime cloudflare-workers`** (Milestone 52) now threads `env` from the `fetch`
  handler into `createApp(env)` and renders `RuntimePlugin({ env })` on that target, bumps the
  scaffolded `compatibility_date` to `2025-09-01` (`import { waitUntil } from 'cloudflare:workers'`
  shipped 2025-08-08, so the previous `2024-09-23` could not import it), and emits commented
  `[[kv_namespaces]]` / `[[r2_buckets]]` stanzas in `wrangler.toml`. Generated output for the Deno,
  Node, and Bun targets is unchanged.

- **`DecoratorPlugin` now prefers the DI container for any class registered in it, with or without
  `@Injectable`.** `instantiate()` required service metadata before consulting the container, so a
  `@Controller` — which carries no `@Injectable` — took the service-registry path even in an
  application with `DiPlugin`, where its dependencies live in the container and not the registry,
  and construction failed outright with "No service registered for capability". The guard
  contradicted the function's own documented behavior. Reachable before this release only for a
  controller whose constructor took arguments; parameter-level `@Inject` makes that composition
  ordinary, which is how it surfaced.
- **`decorator-plugin`'s exported `parseCookies` now delegates to `common`'s `parseCookie`, which
  changes its output in three cases.** The signature is unchanged and no call site needs editing,
  but the values it returns can differ, so read this if you use `@Cookie` or call `parseCookies`
  directly. Each difference is a defect fix rather than a preference:
  - **Values are percent-decoded.** A cookie written by any standards-compliant server (including
    this framework's own `serializeCookie`) was previously returned still-encoded — `@Cookie('x')`
    handed you `a%20b` where the value was `a b`. If you were decoding the result yourself, remove
    that step; double-decoding will now corrupt a value containing a literal `%`.
  - **One layer of RFC 6265 quoting is stripped**, so `sid="abc"` yields `abc` rather than `"abc"`.
  - **A repeated cookie name resolves to the first occurrence, not the last.** Browsers send the
    most specific cookie first, so the first is the one that was meant.

  The alternative was two cookie parsers in the tree, which AI_GUIDELINES §11.1 forbids. Shipping
  the correction during `0.1.x` pre-release rather than freezing the defect follows the precedent of
  the Milestone 14d wire change and the Milestone 30b FCM replacement.

- **`websocket-plugin` and `sse-plugin` now say at startup that rooms and channels are
  process-local** when no realtime backplane is registered — one `info` line naming the limitation,
  the plugin that lifts it, and the transport it needs (`'redis'` or `'messaging'`; the backplane
  plugin's default `'memory'` transport is a single-process bus, so registering it bare would
  silence the notice without fanning anything out). Cross-replica fan-out has shipped since
  `0.1.0-alpha.3`, but a single-replica app and a three-replica app behave identically right up to
  the point where two thirds of your clients silently stop receiving broadcasts, with no error
  raised anywhere. Both READMEs gain a **Scaling beyond one replica** section for the same reason.
  If you run a single replica the line is informational and safe to ignore; registering a backplane
  under the `REALTIME_BACKPLANE` token removes it.

### Fixed

- **`DatabasePlugin({ options: { logQueries: true } })` threw on every repository call whenever a
  real logger was registered** (found in Milestone 52c). `resolveLogger` extracted `logger.debug`
  into a local and invoked it **detached**, so `this` was `undefined` at the call. Both loggers
  `logger-plugin` ships — `ConsoleLogger` and `PinoLogger` — implement `debug` in terms of a private
  `#` field, and a private-field access on an unbound method throws `TypeError`, so the documented
  `logQueries` option could not be used at all with `LoggerPlugin` present. Every existing test
  injected a plain-object logger, where a detached method works fine, which is exactly why no gate
  saw it. `cache-plugin` carries a regression test for the identical bug; `database-plugin` now has
  one too, driving the real `ConsoleLogger` through a running kernel application.

- **Every application failed to boot on Cloudflare Workers** — `packages/kernel`'s request-context
  factory built its never-aborting `ctx.signal` sentinel from a **module-scope**
  `new AbortController()`. workerd refuses that with
  `Disallowed operation called within global
  scope`, because an `AbortController` is bound to an
  I/O context, so the isolate threw at import time and no handler ever ran. Introduced with
  `IRequestContext.signal` in Milestone 42 and invisible to every gate: the whole suite runs on
  Deno, where a module-scope controller is legal, and the Workers path had only ever been exercised
  through `app.fetch` under Deno rather than under the real runtime. Found by driving the framework
  under `wrangler dev` (workerd) for the first time. The sentinel is now constructed **per
  request**; caching one lazily would not have been a fix either, since workerd then refuses to use
  a controller created for one request on behalf of another. A regression test pins that two
  contexts never share a fallback signal — it fails against the previous code.
- **`@hono-enterprise/cloudflare-plugin` queue reporting reaches a logger registered after the
  plugin** (Milestone 52b) — `WorkersQueueOptions.logger` is a thunk rather than an `ILogger`, for
  the reason `resolveWaitUntil` already takes one: `ctx.logger` resolves lazily through a Proxy that
  answers `undefined` until a logger is registered, and a capability may be registered imperatively
  with no `provides` declaration for the resolver to order against. Capturing the value during
  `register()` would silence every dispatch report in an application whose logger registers later.

- **`honoe new` now refuses a project plan containing the same path twice** (Milestone 36c). The
  overwrite check probes the filesystem, so it could not see a duplicate inside one plan: both files
  were written and the last silently won. A template emitting `deno.json` would have overwritten the
  framework manifest with no warning.
- **The CLI drift gate resolved starter packages to the wrong directory** (Milestone 36c). It mapped
  `@hono-enterprise/<name>` to `packages/<name>`, but the three starters live under
  `packages/starters/`, so any template importing one could not be type-checked. It also rewrote
  every import-map entry, mangling a template's project-local alias (`~/`) into a package path.
- **`websocket-plugin`'s README no longer claims cross-replica fan-out is unimplemented.** It stated
  "fan-out across replicas is a follow-up milestone; today two instances behind a load balancer do
  not share rooms", which stopped being true when `realtime-backplane-plugin` shipped in
  `0.1.0-alpha.3`.
- **`sse-plugin`'s README named a method that does not exist.** Its named-channels example called
  `channel.broadcast(...)`; the committed `SseChannel` contract exposes `publish(...)` and no
  `broadcast`, so the snippet would not compile.
- **`realtime-backplane-plugin`: `RedisBackplane.connect()` no longer leaks a connection on a failed
  open, and is safe to call concurrently.** The connected guard was only set after both connections
  had been constructed, so two overlapping calls each built their own pair — and if the second
  construction threw, the first connection was already live with nothing holding a reference to
  close it. The open is now memoized, so overlapping callers join one attempt and none of them
  returns before `SUBSCRIBE` has actually landed; a failed attempt quits whatever it built, removes
  its own listener from injected clients but does not close them (they belong to the caller), and
  clears the memo so a later call retries. A `close()` arriving mid-open now wins as well: the open
  retires whatever it built instead of publishing two live connections onto a backplane that has
  already shut down, which is what a shutdown during startup would otherwise strand.
  `RealtimeBackplanePlugin` calls `connect()` exactly once and `close()` only from `onClose`, so no
  application behavior changes — this closes the seam for callers driving the transport directly.

### Known limitations

**The Cloudflare surface has not been verified against a deployed Worker.** CI holds no Cloudflare
account, so nothing in the pipeline reaches the platform. It was driven against real **workerd** via
`wrangler dev` during development — Queues with a real `MessageBatch`, a real `ScheduledController`,
`caches.default`, KV, R2, D1, and both Durable Object classes including a real `WebSocketPair`
upgrade and the storage input gate — and that harness is what caught a kernel defect that broke
every application on Workers (fixed here). But those runs were manual and the harness is not
committed, so treat the edge story as well-exercised rather than continuously gated, and verify
against your own account before you depend on it.

**FCM push still has not been exercised against live FCM**, unchanged from `0.1.0-alpha.3`. The HTTP
v1 request is asserted field by field and its RS256 assertion is signed and verified with real Web
Crypto, but no test reaches Google.

**D1 transactions are deferred batches, with two consequences worth knowing before you use them.**
D1 rejects `BEGIN TRANSACTION` outright and `batch()` is its only unit of atomicity, so writes
buffer until commit and flush as one batch. Inside a transaction there is **no
read-your-own-writes** — reads see committed state — and `create()` **requires an explicit primary
key**, because a deferred insert cannot report a generated key to a caller awaiting it before the
flush. Both are documented in PUBLIC_API.md and covered by tests; neither applies outside a
transaction.

All 46 packages are live on JSR at `0.1.0-alpha.4`, published by CI from the tag.

Verified after publishing by querying every package on the registry, then installing `kernel` and
`runtime` from JSR into a throwaway directory — not the workspace, whose import map resolves locally
and would mask a broken published dependency — and serving a request (`200 {"ok":true}`). `common`
resolved transitively at `0.1.0-alpha.4`, which is the only real evidence that the cross-package
specifier bump landed inside the published tarballs: a dry run resolves those from the workspace and
so cannot show it.

Every package also carries a description and runtime-compat flags for the first time. Neither
setting lives in a published version — `deno publish` never touches them — so all 46 pages had shown
an empty description and "Compatibility unknown" through four releases. They are now set from
`scripts/jsr-metadata.ts` and reapplied by `deno task release:set-metadata`, which is idempotent and
refuses to run when a published package has no entry.

### Installing

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.4
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.4/main
```

Within 24 hours of a release, Deno's minimum-dependency-age policy refuses the version unless you
pass `--min-dep-age 0`.

## [0.1.0-alpha.3] — 2026-07-30

**Two breaking changes ship in this release.** Both are narrow, but you meet them in production
rather than in this file, so they are stated here in full and again under _Changed_.

> **⚠️ Breaking 1 of 2: brokered request-reply changes on the wire.** `request()`/`respond()` move
> from `<topic>` to a derived `rr.req.<topic>` channel, so a responder running `0.1.0-alpha.2` and a
> caller running this version **will not talk to each other**. RPC callers and responders must be
> restarted together, not rolled one at a time. Fire-and-forget `publish`/`subscribe` are
> unaffected, as is every other plugin. If you do not use `request`/`respond`, nothing here applies
> to you.

> **⚠️ Breaking 2 of 2: the FCM push channel takes service-account credentials.**
> `FcmProviderOptions.serverKey` is **replaced** by `{ projectId, clientEmail, privateKey }`, so
> existing config stops compiling. That is deliberate rather than a deprecation: `serverKey`
> addressed the legacy endpoint Google switched off in 2024, so every push sent through it already
> failed. A compile error is the only honest signal. If you do not configure a `push` channel,
> nothing here applies to you.

**Kafka gains request-reply, and five of the known limitations recorded against `0.1.0-alpha.1` are
closed.** Every entry below was a real capability gap rather than a documentation problem, so each
is fixed in code; the alpha.1 list annotates them in place rather than deleting them, because that
section records what was true of that release.

Kafka was not the reason Kafka lacked request-reply: the shared request-reply core minted its own
inbox topic and imposed it on every broker, which only works where topics are cheap and
per-instance-addressable. Brokers now supply their own reply inbox, so Kafka can read a shared reply
topic under a per-instance consumer group instead. The same seam is where a future native AMQP
`replyTo` or NATS JetStream reply-subject transport would plug in. Two defects in the M14c
implementation are fixed alongside it, both consequences of RPC sharing a topic with ordinary
pub/sub.

Alongside that, WebSocket rooms and SSE channels gain cross-replica fan-out, `feature-flags-plugin`
gains a LaunchDarkly provider, and `resilience-plugin` timeouts finally cancel the work they bound.

### Added

- **Kafka now supports brokered request-reply.** `KafkaBroker.request`/`respond` previously rejected
  outright; all five brokers are now reply-capable. Replies travel on a shared reply topic — the new
  `replyTopic` option, default `'messaging.replies'` — read by a consumer group unique to each
  broker instance, so delivery is exclusive to the caller rather than load-balanced across the
  shared default group. **The reply topic must already exist**: `IKafkaFactory` exposes no admin
  surface, so the broker creates no topics. Every instance receives every reply and discards those
  it did not originate; give a high-traffic service its own `replyTopic` to bound that fan-out.
- Each broker now supplies its own reply inbox through an internal seam, rather than having a topic
  string imposed on it by the shared request-reply core. The four brokers that were already
  reply-capable pass a shared helper and are behaviourally unchanged.
- **`notification-plugin` push delivery works again, on FCM HTTP v1.** `FcmProvider` now posts to
  `/v1/projects/{projectId}/messages:send` with an OAuth2 bearer token minted from a service
  account: it signs an RS256 JWT assertion with `runtime.subtle` and caches the token until shortly
  before expiry, so a send costs one request in the steady state. Zero npm dependencies and
  Workers-portable, like the other HTTP providers. A new `FcmTokenSource` export lets you source
  tokens elsewhere (a GCP metadata server, a key-holding broker) instead of from a local key.
- **`@hono-enterprise/realtime-backplane-plugin`** — cross-replica fan-out for WebSocket rooms and
  SSE channels. It registers an `IRealtimeBackplane` under the new `CAPABILITIES.REALTIME_BACKPLANE`
  token, which `websocket-plugin` and `sse-plugin` resolve **optionally** — so adding the plugin is
  the entire change needed to make `ws.room('lobby')` and `sse.channel('news')` reach clients on
  other replicas, and removing it restores in-process behavior with no application change. Four
  transports: `'memory'` (the default, and a real single-process bus rather than a no-op),
  `'messaging'` (over whatever broker is registered under `CAPABILITIES.MESSAGING`, reusing all five
  existing brokers with no new dependency), `'redis'` (pub/sub over an inject-or-lazy `ioredis`),
  and `'custom'`.

  > **Correction, made in `0.1.0-alpha.4`.** "Adding the plugin is the entire change needed" is
  > wrong, and the sentence is left in place because this section records what the release said.
  > `RealtimeBackplanePlugin()` defaults to `transport: 'memory'`, a **single-process** bus, so
  > registering it bare fans nothing out across replicas. You must also choose `'redis'` or
  > `'messaging'`. The memory-default caveat did appear two sentences later, but the headline is
  > what a reader acts on. The same looseness was corrected in the plugin log messages and both
  > plugin READMEs by PR #102; this was the last remaining copy.
- **A LaunchDarkly provider** for `@hono-enterprise/feature-flags-plugin`
  (`provider: 'launchdarkly'`), plus an optional `IFeatureFlags.isEnabledAsync` for callers that can
  await an answer carrying no cold-context caveat.
- **Real cancellation** in `@hono-enterprise/resilience-plugin`: `wrap` hands the protected call an
  `AbortSignal`, and the returned callable accepts an optional caller-owned one.
- **`@hono-enterprise/sdk`** — the client SDK publishes for the first time. Together with the
  realtime backplane above, that brings the published total to **38 packages**. A portable,
  zero-npm-dependency HTTP client for consuming a Hono Enterprise API from a browser or a server:
  `createClient()` returns an `IHttpClient` with one `request<TResponse, TBody>()` method, plus
  bearer and API-key request-interceptor factories, request/response interceptors, retry with
  fixed/exponential backoff honoring a delta-seconds `Retry-After`, a rolling-window circuit
  breaker, and a sliding-window rate limiter. Both the transport (`fetch`) and time
  (`IClientTiming`) are injectable seams, so nothing needs a network or a real clock to test. It
  registers no plugin and resolves no capability token — its only in-repo import is type-level from
  `@hono-enterprise/common`, which re-exports `RetryPolicy`, `CircuitBreakerPolicy`, and
  `BackoffStrategy` through the SDK barrel so consumers need not depend on `common` directly.
  `generateOpenApiClient(document, options?)` is a pure function turning an OpenAPI 3.1 document
  into type-checked TypeScript client source; it throws `OpenApiCodegenError` with the offending
  path and method rather than emitting a client that misbehaves or will not compile.

### Changed

- **BREAKING: `FcmProviderOptions.serverKey` is replaced by service-account fields.** The push
  channel now takes `{ projectId, clientEmail, privateKey }` (or a `tokenSource`) instead of
  `serverKey`. This is not a deprecation: `serverKey` addressed an endpoint Google switched off in
  2024, so every send through it already failed. Existing config becomes a compile error, which is
  the intended signal.

  ```typescript
  // Before — never reached a live endpoint
  push: { provider: 'fcm', options: { serverKey: config.get('FCM_SERVER_KEY') } }

  // After — values come from the service-account JSON
  push: {
    provider: 'fcm',
    options: {
      projectId: config.get('FCM_PROJECT_ID'),
      clientEmail: config.get('FCM_CLIENT_EMAIL'),
      privateKey: config.get('FCM_PRIVATE_KEY'),
    },
  }
  ```

  A `push` channel using the default signer now needs `CAPABILITIES.RUNTIME` (for Web Crypto and the
  clock) and throws during `register` without it, rather than failing on the first notification.
- **BREAKING (wire format): request-reply traffic moved to a derived channel.** `request(topic, …)`
  now publishes to, and `respond(topic, …)` subscribes to, `rr.req.<topic>` instead of `<topic>`. A
  `0.1.0-alpha.2` responder and a later requester **do not interoperate** — during an upgrade,
  restart RPC responders and callers together rather than rolling them one at a time.
  Fire-and-forget `publish`/`subscribe` are unaffected.
- **`IResilienceService.wrap` and `ICircuitBreaker.execute` widened.** `wrap<T>` now takes a
  `ResilientCall<T>` (`(signal: AbortSignal) => Promise<T>`) and returns a `HardenedCall<T>`
  (`(signal?: AbortSignal) => Promise<T>`). **Source-compatible for callers** — a zero-argument
  `() => Promise<T>` is still accepted and `await guarded()` still works — but **breaking for
  implementors**, because `fn` sits in a contravariant position, so an object literal declaring
  `wrap<T>(fn: () => Promise<T>)` no longer satisfies the interface. Implementors add the parameter.
- **`websocket-plugin` and `sse-plugin` `register()` are now async**, awaiting the optional
  backplane subscription. The kernel already awaited an async `register`, so applications are
  unaffected; a test calling `plugin.register(ctx)` directly must now await it.

### Fixed

- **Request envelopes leaked into plain subscribers.** A responder shared the raw topic with
  pub/sub, so a `subscribe('orders', …)` handler received the raw `rr-request` envelope instead of
  the payload. Separate channels fix this at the routing layer.
- **A responder could swallow a competing consumer's message.** Where a responder and an ordinary
  subscriber shared a topic _and_ a queue (competing-consumer delivery), the responder consumed its
  share of the round-robin and its envelope guard discarded anything that was not a request — the
  message vanished with no signal. Fan-out subscribers were unaffected.
- **The reply inbox subscribed without a queue name**, so on a broker that falls back to a shared
  consumer group (Kafka) replies could be delivered to a different instance than the caller, which
  then discarded them by correlation-id lookup — surfacing as an unexplained timeout. Each inbox now
  claims its own queue.
- **Resilience timeouts cancel the work they bound.** `timeout` raced the protected call against a
  timer and left it running; it now aborts the call's signal with the same `TimeoutError` instance
  it rejects with, so a call that forwards the signal to its I/O genuinely stops. Retry stops
  looping on abort and wakes its backoff early — that sleep also no longer leaks a timer handle on
  every attempt — and a bulkhead waiter cancelled while queued leaves the queue and never runs its
  call.
- **Six package pages on jsr.io now show their README.** `cli`, `feature-flags-plugin`,
  `multi-tenancy-plugin`, `openapi-plugin`, `queue-plugin`, and `storage-plugin` rendered a one-line
  blurb instead in `0.1.0-alpha.2`. Not a packaging fault — `/README.md` was in every published
  tarball. JSR's `readmeSource` defaults to `jsdoc` and falls back to README.md only when the
  entrypoint's module doc has no description; deno_doc drops prose that _follows_ a tag, so a block
  opening with `@module` has no description and the README renders, while one whose description
  comes first and ends with `@module` replaces the whole page. Those six were the only
  description-first entrypoints. `deno task release:verify` now enforces `@module`-first, because
  nothing else sees this: the README ships in the tarball, so every gate and
  `deno publish
  --dry-run` stay green and the loss shows up only on jsr.io.

### Deprecated

- **`MessagingNotSupportedError`** — no broker throws it now that Kafka implements request-reply.
  The export is retained so `instanceof` checks written against `alpha.1`/`alpha.2` keep compiling,
  and will be removed in the next major. Nothing replaces it; delete the branch.

### Notes

One real-time limitation remains, documented rather than silently approximated: `Room.size` /
`SseChannel.size` report **local** membership. A cluster-wide count is inherently asynchronous — it
needs a scatter-gather across replicas — so it cannot satisfy the synchronous committed `size`
getter and wants a separate async method. That is a later milestone.

`RoomBroadcastOptions.except` **is** honored cluster-wide: connection IDs come from `runtime.uuid()`
and are globally unique, so the frame carries the excluded ID and every replica skips it.

A call that ignores its `AbortSignal` still runs to completion; cancellation is cooperative, and the
widened JSDoc says so.

**FCM push has not been exercised against live FCM.** The HTTP v1 rewrite is asserted field by field
— request URL, headers, and body shape — and its RS256 assertion is signed and verified with real
Web Crypto, but no test reaches Google: CI holds no Firebase project. The endpoint and auth scheme
follow Google's documented HTTP v1 contract, and the previous `serverKey` path was provably dead, so
this is strictly an improvement — but if you depend on push, verify it against your own project
before you rely on it, and please report what you find.

All 38 packages are live on JSR at `0.1.0-alpha.3`.

Verified after publishing by querying every package on the registry, then installing `kernel` and
`runtime` from JSR into a throwaway directory — not the workspace, whose import map resolves locally
and would mask a broken published dependency — and serving a request (`200 {"ok":true}`). `common`
resolved transitively at `0.1.0-alpha.3`, which is the only real evidence that the cross-package
specifier bump landed inside the published tarballs: a dry run resolves those from the workspace and
so cannot show it.

The six package pages that shipped `0.1.0-alpha.2` without a visible README were re-checked and now
render theirs. The same check run against their `0.1.0-alpha.2` pages still finds no README content,
so it distinguishes the two rather than passing vacuously.

### Installing

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.3
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.3/main
```

Within 24 hours of a release, Deno's minimum-dependency-age policy refuses the version unless you
pass `--min-dep-age 0`.

## [0.1.0-alpha.2] — 2026-07-28

**Adds the CLI.** `@hono-enterprise/cli` publishes for the first time, bringing the total to **36
packages**. Every other package is version-bumped so the scope stays on one version — the CLI needs
this, because `honoe new` stamps generated projects with its OWN version as the range for `kernel`,
`runtime`, `common`, and every template plugin. A CLI at `alpha.2` alongside a framework at
`alpha.1` would scaffold projects pinning versions that do not exist.

### Added

- **`@hono-enterprise/cli`** — the `honoe` command: project scaffolding (`honoe new`, with
  `--template rest|microservice` and `--runtime deno|node|bun|cloudflare-workers`), 13 plugin-aware
  code-generation schematics, custom schematics, and dispatch of plugin-registered commands
  (`honoe commands`, `honoe db:migrate`).

### Fixed

- **Package READMEs linked `PUBLIC_API.md` relatively** (`../../PUBLIC_API.md`). JSR resolves a
  README's relative links against `jsr.io/@hono-enterprise/`, so every such link 400'd with
  _"package name must contain only lowercase ascii alphanumeric characters and hyphens"_. All 44
  relative links across 28 package READMEs now use absolute GitHub URLs.
- **`ICliApi`'s JSDoc** described a contract with no consumer; the CLI now reads it.

All 36 packages are live on JSR at `0.1.0-alpha.2`.

Verified after publishing by installing `honoe` from JSR into a clean directory — not the workspace,
whose import map resolves locally — scaffolding a `rest` project with it, generating a controller,
type-checking the result against the published packages, then starting it and serving `/` (`200`),
`/health` (`status: up`), and `/metrics`.

### The release pipeline, which had never worked

This was the first release published by CI. `0.1.0-alpha.1` went out by hand from a terminal,
because the tag-triggered workflow failed on every attempt. Three separate causes, each only visible
by running it:

1. **The publish step lacked `--allow-env`.** `publish-packages.ts` reads `JSR_TOKEN` at startup
   (left unset in CI so the runner's OIDC identity authenticates instead) and died before touching a
   package. The root cause was duplication: `deno.json`'s `release:publish` task always carried the
   right permissions, but the workflow inlined its own `deno run` and that copy drifted. The
   workflow now calls the task.
2. **It also lacked `--allow-net`.** The already-published check that makes a resumed release
   idempotent fetches jsr.io — and it is skipped under `--dry-run`, so a passing dry run proves
   nothing about a real run.
3. **No package was linked to the GitHub repository.** JSR accepts a GitHub Actions OIDC identity
   only for a package it knows belongs to the repo; without the link, `deno publish` uploads and
   then fails with `actorNotAuthorized`. Token-based publishing does not need the link, which is why
   `0.1.0-alpha.1` never surfaced it. `deno task release:link-repos` now does all 36 through the
   API.

None of the three published anything, so the tag stayed re-runnable throughout.

### Installing

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.2
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.2/main
```

Within 24 hours of a release, Deno's minimum-dependency-age policy refuses the version unless you
pass `--min-dep-age 0`.

## [0.1.0-alpha.1] — 2026-07-26

**First public prerelease.** The framework's kernel, runtime layer, and 30 plugins are implemented
and tested; they publish to [JSR](https://jsr.io) under the `@hono-enterprise` scope.

This is an **alpha**. The public API is not frozen, and breaking changes may land in any subsequent
prerelease without a major-version bump. Do not use it in production.

All 35 packages are live on JSR at `0.1.0-alpha.1`.

Verified after publishing by installing `kernel`, `runtime`, `metrics-plugin`, and
`telemetry-plugin` from JSR into a clean project — not the workspace, whose import map resolves
locally — starting an application, serving a request (`200`), and scraping the `/metrics` endpoint.

The release took two attempts. A JSR scope may create only 20 new packages per rolling 7-day window
by default; the first run created 20 and stopped. JSR raised the quota to 40 on request, and the
remaining 15 followed. Both halves carry the same version, and the publish order guarantees `common`
and `kernel` land before anything that depends on them, so the intermediate state was never
inconsistent.

### Installing a prerelease

JSR does not tag a prerelease as `latest`, so **every specifier must be version-pinned**:

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.1
```

A bare `deno add jsr:@hono-enterprise/kernel` fails with _"has only pre-release versions
available"_. Within 24 hours of a release, Deno's minimum-dependency-age policy additionally refuses
the version unless you pass `--min-dep-age 0`.

### All packages in this release

35 packages, all at `0.1.0-alpha.1`:

**Core** — `common`, `kernel`, `runtime`, `exceptions`, `testing`

**Request path** — `logger-plugin`, `config-plugin`, `validation-plugin`, `http-security-plugin`,
`auth-plugin`

**Data** — `database-plugin`, `cache-plugin`, `storage-plugin`, `multi-tenancy-plugin`

**Messaging & work** — `events-plugin`, `cqrs-plugin`, `messaging-plugin`, `queue-plugin`,
`scheduler-plugin`, `worker-pool-plugin`

**Real-time** — `sse-plugin`, `websocket-plugin`, `react-router-plugin`

**Operations** — `metrics-plugin`, `health-plugin`, `telemetry-plugin`, `audit-plugin`,
`resilience-plugin`, `secrets-plugin`

**Delivery** — `mail-plugin`, `notification-plugin`, `feature-flags-plugin`

**Optional ergonomics** — `di-plugin`, `decorator-plugin`, `openapi-plugin`

### Deliberately excluded

`@hono-enterprise/cli`, `@hono-enterprise/sdk`, and the three starter bundles (`rest-starter`,
`microservice-starter`, `full-stack-starter`) are **not part of this release**. They are stubs that
export nothing; publishing them would put empty pages on JSR, where versions are immutable. They
ship when their milestones land (the CLI is Milestone 34).

### Runtime support

Node.js, Deno, Bun, and Cloudflare Workers, via Hono's `fetch` entry point and the runtime's HTTP
adapters. Individual plugins document their own constraints — SMTP needs raw sockets, worker pools
need real threads, and neither exists on Workers.

Optional heavy dependencies (Prisma, ioredis, amqplib, kafkajs, nodemailer, the OTel SDK, `ws`, …)
are never hard dependencies. Each is injected through plugin options or imported lazily via an
`npm:` specifier, so an application only pays for what it configures.

### Known limitations

> Five entries in this list have since been closed; each is annotated in place rather than deleted,
> because this section records what was true of **this** release. See **[0.1.0-alpha.3]** for the
> work that closed them.

- **`notification-plugin` FCM push is non-functional.** It implements the legacy FCM `serverKey`
  API, which Google decommissioned in 2024. FCM HTTP v1 with service-account JWT signing is a
  follow-up. _(True of this release. Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30),
  where the provider moves to HTTP v1 and push delivery works.)_
- **LaunchDarkly is unsupported** in `feature-flags-plugin`. The LaunchDarkly Node server SDK's
  `variation`/`allFlagsState` are async and cannot satisfy the synchronous committed `isEnabled`
  contract. Use the provider's `'custom'` arm as a bridge. _(True of this release. Superseded — see
  [0.1.0-alpha.3](#010-alpha3--2026-07-30), which adds a `'launchdarkly'` provider and an optional
  `isEnabledAsync`.)_
- **`KafkaBroker` does not support request-reply.** Kafka's consumer-group and auto-commit model
  does not fit the pattern; `request()`/`respond()` throw `MessagingNotSupportedError`. _(True of
  this release. Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30), where Kafka becomes
  reply-capable; the limitation was in the shared request-reply core, not in Kafka.)_
- **Rooms and channels are in-process.** `websocket-plugin` rooms and `sse-plugin` channels are not
  shared across replicas; cross-instance fan-out is a later milestone. _(True of this release.
  Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30), which adds `realtime-backplane-plugin`.
  `Room.size` / `SseChannel.size` remain local-only.)_
- **`resilience-plugin` timeouts do not cancel.** `timeout` races the promise; the wrapped function
  keeps running. _(True of this release. Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30),
  where `wrap` hands the protected call an `AbortSignal` and the timeout aborts it.)_
- **Node and Bun compatibility suites have not run.** They consume the packages through JSR's npm
  compatibility layer and were therefore blocked on this publish — they are unblocked by it, and
  will run before the first stable release. Milestone 40 owns that verification, alongside
  benchmarks and the security audit.

### Milestones in this release

Milestones 0–33 and 41–46. See [ROADMAP.md](ROADMAP.md) for scope per milestone and
[PUBLIC_API.md](PUBLIC_API.md) for the full exported surface.

[0.1.0-alpha.10]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.10
[0.1.0-alpha.9]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.9
[0.1.0-alpha.8]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.8
[0.1.0-alpha.7]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.1
