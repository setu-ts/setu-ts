# Milestone 109a — Idempotency core (`@setu-ts/idempotency-plugin`, `@setu-ts/common`, `@setu-ts/decorator-plugin`, `@setu-ts/cloudflare-plugin`, `@setu-ts/messaging-plugin`, `@setu-ts/queue-plugin`)

> **Status:** Planning. Branch: `feat/m109a-idempotency-core`. `main` and `develop` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR into
> `develop`.
>
> **Written for an implementer who will not re-derive anything.** Every file, exported symbol,
> signature, default, bound, status code, header name, Lua script, check order and test below is
> DECIDED. Where a sentence says "MUST", a test in §6 asserts it. Where this plan cites `file:line`,
> the line was read on branch `feat/m109a-idempotency-core` at `754888f2`. Do not improvise a
> mechanism this plan does not name; if a cited fact turns out false when you open the file, stop
> and report it rather than working around it.
>
> **Revision 2 (2026-10-08)** applies an independent review: the ingress key gained a consumer
> identity and a required allow-list (B1), the cross-package types are written out in full (M1),
> option validation is split into call-time shape checks and resolution-time rules (M2), the ingress
> lease and failure semantics were corrected (M3), the Redis and memory guarantees were narrowed and
> a per-scope cap added (M4), plus the minor findings. §11 lists every finding and its disposition.

## 0. Objective & scope

A repeated HTTP request, queue job or broker message does its work once per key. One core state
machine — `claim(key, fingerprint, lease)` → `claimed` with a token, then `complete(token, record)`
or `release(token)` — behind one store port in `@setu-ts/common`, with an in-process store (tier A)
and two cross-replica stores (tier B: Redis via an atomic Lua script, and a Cloudflare Durable
Object). Two entry points reach it: a route-level `idempotent(options)` middleware plus an
`@Idempotent()` decorator for HTTP, and an ingress behaviour (`idempotentIngress(options)`) for
queue jobs and broker messages on an explicit allow-list of topics and job names.

The guarantee this milestone delivers is **the first of three, and only the first**:

1. **No duplicate processing** — a second arrival of a key whose work completed is answered from the
   record (HTTP) or skipped (ingress); a concurrent second arrival is refused (`409` on HTTP, a
   retryable rejection on ingress). Delivered here, on every store, within the limits of §3.18.
2. **The work and its record committed together** — tier C, a record written inside the business
   transaction. NOT this milestone (109b, after M108).
3. **External side effects once** — only by forwarding a derived key to a provider that
   de-duplicates. This milestone exposes the derived key (`derivedIdempotencyKey(ctx)`, §3.12) and
   documents the pattern; it does not and cannot make an outbound call happen once.

The words "exactly once" appear nowhere in code, JSDoc, README, PUBLIC_API.md or CHANGELOG (§6
asserts it with a grep test).

- **In scope:**
  - `common`: the store port, the service contract, the route and ingress option types, the token
    `CAPABILITIES.IDEMPOTENCY = 'idempotency'`, and an OPTIONAL `IngressContext.consumer` member
    (§3.19).
  - New package `packages/idempotency-plugin`: `IdempotencyPlugin`, the HTTP middleware,
    `idempotent()`, `idempotentIngress()`, `derivedIdempotencyKey()`, the memory store (tier A), the
    Redis store (tier B, inject-or-lazy `npm:ioredis@5.x`), the health indicator `idempotency`,
    `IdempotencyRefusedError` and `IdempotencyConfigurationError`.
  - `decorator-plugin`: `@Idempotent(options?)`, appended LAST in a decorated route's middleware —
    after guards, declarative authorization and the validation band (§3.9).
  - `cloudflare-plugin`: `DurableObjectIdempotencyStore` (Worker side) and `IdempotencyObjectCore`
    (Durable Object side), tier B on Workers.
  - `messaging-plugin`: `PipelinedBroker` populates `IngressContext.consumer` (§3.19).
  - `queue-plugin`: `withIngressBehaviors` populates `IngressContext.consumer` (§3.19).
  - `cli`: one line in the health-indicator claim table (`packages/cli/src/utils/plugin-claims.ts`),
    the M103 precedent — the root drift gate fails without it.
  - Docs: package README, PUBLIC_API.md sections, CHANGELOG `Unreleased`, `docs/plugins.md` catalog
    section, `docs/health-indicators.md` row, root README package row, ARCHITECTURE package node and
    responsibility table, ROADMAP M109 corrections (§2) and a `109a` Progress row,
    `scripts/release-packages.ts` (new package → publish list).
  - A design security review (§10), recorded as complete, with the obligations the committed-tree
    audit must meet.
- **NOT this milestone:**
  - Tier C `within(uow, key, fn)` — 109b, after M108 (it shares M108's transaction seam).
  - The SDK `idempotencyKey` request option and making POST/PATCH retryable in `packages/sdk` —
    109b. `packages/sdk` is NOT touched here.
  - A D1 tier-B store — not built (§3.15 says why). D1 is the natural Workers tier C, 109b.
  - The ingress entry point on Cloudflare Workers: `WorkersQueue` and `WorkersBroker` apply no
    behaviour chain (`grep -rn behaviors packages/cloudflare-plugin/src` is empty), so
    `idempotentIngress` cannot reach them. HTTP on Workers is in scope through the Durable Object
    store. Unowned; recorded in the README.
  - Lease renewal (heartbeating a long-running claim) — unowned; documented as a limit (§8).
  - An erase-by-principal API on the store — unowned; retention is TTL-bounded (§3.13, §10).
  - OpenAPI documentation of the `Idempotency-Key` request header on `@Idempotent` routes — unowned;
    a follow-up for `openapi-plugin`.
  - Business uniqueness ("one payroll run per company and period") — a unique constraint
    (`DuplicateKeyError`, #420), never this mechanism. Scheduler ticks — already de-duplicated by
    M70l's slot locks. The README says both (§9).

## 1. Contracts verified from SOURCE (not names)

| Reference                                 | Source (file:line)                                                                                                                                                                                                   | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token grammar                             | `packages/common/src/tokens.ts:290-326`                                                                                                                                                                              | `createCapabilityToken` accepts `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.<same>)*$`; colons illegal. `'idempotency'` passes. `CAPABILITIES` ends at `:276`; no `IDEMPOTENCY` member today.                                                                                                                                                                                                                                                                                  |
| `ICacheStore`                             | `packages/common/src/services/cache.ts:19-54`                                                                                                                                                                        | Exactly `get`/`set(key, value, ttlSeconds?)`/`delete`/`has`/`clear`. No set-if-absent, no compare-and-set. Tier B cannot be built on it without a race (§3.4).                                                                                                                                                                                                                                                                                                         |
| `IngressContext`                          | `packages/common/src/services/ingress.ts:48-91`                                                                                                                                                                      | Members `kind`, `name`, `payload`, `attempt?`, `headers?` — NO `state`, `services`, `messageId` or subscription identity. A behaviour cannot hand a value to the handler.                                                                                                                                                                                                                                                                                              |
| `IngressContext` member-set pin           | `packages/common/test/unit/ingress-contract.test.ts:40-59`                                                                                                                                                           | A compile-time `Equals<IngressContext, PinnedEnvelope>` and a `keyof` pin. Adding `consumer?` fails both until they are updated — that is the deliberate gate (§3.19).                                                                                                                                                                                                                                                                                                 |
| `IngressKind`                             | `packages/common/src/services/ingress.ts:26`                                                                                                                                                                         | `'queue' \| 'scheduler' \| 'messaging' \| 'websocket'`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `IIngressBehavior`                        | `packages/common/src/services/ingress.ts:130-141`                                                                                                                                                                    | `handle(ctx: IngressContext, next: () => Promise<void>): void \| Promise<void>`. Returning without `next()` short-circuits (`messaging-plugin/src/interfaces/index.ts:272-274`).                                                                                                                                                                                                                                                                                       |
| `RegistryFactory`, `resolveRegistryEntry` | `packages/common/src/registry.ts:66`, `:216-229`                                                                                                                                                                     | `RegistryFactory<T> = (services: IServiceRegistry) => T`; an entry is a factory iff `typeof entry === 'function'`.                                                                                                                                                                                                                                                                                                                                                     |
| Queue `behaviors`                         | `packages/queue-plugin/src/interfaces/index.ts:380`                                                                                                                                                                  | `readonly (IIngressBehavior \| RegistryFactory<IIngressBehavior>)[]`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Queue chain + failure path                | `packages/queue-plugin/src/processors/job-processor.ts:290-340` (`withIngressBehaviors`, envelope at `:316-327`), `:109-170` (`runJob`)                                                                              | Envelope `kind: 'queue'`, `name: job.name`, `payload: IJob`, `attempt`. A chain rejection reaches `runJob`'s `catch` (`:141`): requeued with `computeBackoffMs(attempts + 1)` while `attempts < maxAttempts` (`:144-170`), dead-lettered after. The requeue keeps `storedJob.id` (`:161-166`).                                                                                                                                                                         |
| Queue retry span (defaults)               | `packages/queue-plugin/src/retry/retry-strategy.ts:12`, `:17`, `:38-45`; `packages/queue-plugin/src/plugin/queue-plugin.ts:83`                                                                                       | `computeBackoffMs(n) = min(1000 * 2^(n-1), 30000)`; default `maxAttempts` 3. A job failing three times waits 2,000 ms then 4,000 ms — a 6 s retry span — before it is dead-lettered. `IQueue` (`common/src/services/queue.ts:141-159`) exposes only `add`/`process`/`addRecurring`: the retry configuration is NOT readable by another plugin.                                                                                                                         |
| `IJob`                                    | `packages/common/src/services/queue.ts:14-43`, `AddJobOptions.headers` `:65-76`                                                                                                                                      | `id`, `name`, `data`, `attempts`, `headers?`. `attempts` changes per delivery — it MUST NOT enter a fingerprint.                                                                                                                                                                                                                                                                                                                                                       |
| Messaging `behaviors` + chain             | `packages/messaging-plugin/src/interfaces/index.ts:296`; `packages/messaging-plugin/src/pipeline/pipelined-broker.ts:69`, `:105-121` (ctor), `:159-165` (`subscribe` → `subscribeWithHeaders`), `:178-214`           | ONE `PipelinedBroker` wraps EVERY subscription in the plugin; the envelope (`:188-193`) carries no subscription identity. `subscribe` delegates to `subscribeWithHeaders`, so every subscription passes `:178`. The chain's rejection is RETURNED to the broker's failure path (`:207-212`).                                                                                                                                                                           |
| `PipelinedBroker` construction            | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:461-469`                                                                                                                                                   | Built only when behaviours are configured; `ctx.runtime` is in scope there.                                                                                                                                                                                                                                                                                                                                                                                            |
| `SubscribeOptions`                        | `packages/common/src/services/messaging.ts:433-436`                                                                                                                                                                  | `{ readonly queue?: string }` — "Consumer group / queue name for load-balanced delivery". The only subscription identity a caller supplies.                                                                                                                                                                                                                                                                                                                            |
| `MessageMetadata.messageId`               | `packages/common/src/services/messaging.ts:401-413`                                                                                                                                                                  | Broker-assigned, optional, NOT carried into `IngressContext`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DEDUPLICATION_ID_HEADER`                 | `packages/common/src/services/messaging.ts:27`; `packages/messaging-plugin/src/brokers/publish-options.ts:72-74`; `packages/messaging-plugin/src/integration/publish.ts:91`                                          | `'x-setu-deduplication-id'`, written whenever `PublishOptions.deduplicationId` is set; `publishIntegrationEvent` defaults it to the envelope id. A plain `publish` without it carries no such header.                                                                                                                                                                                                                                                                  |
| Header-less internal traffic              | `packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts:110-120`                                                                                                                                   | The realtime backplane's `'messaging'` transport subscribes through the same broker and publishes frames with no deduplication id — any behaviour applied to every topic would refuse it (probe `fanout.ts`, §11).                                                                                                                                                                                                                                                     |
| `MiddlewareFunction`, `NextFunction`      | `packages/common/src/http.ts:381-384`, `:363`                                                                                                                                                                        | `(ctx, next) => void \| HandlerResult \| Promise<void \| HandlerResult>`; `next: () => Promise<void>`.                                                                                                                                                                                                                                                                                                                                                                 |
| `IRequest` body + identity                | `packages/common/src/http.ts:36-157`                                                                                                                                                                                 | `method`, `url`, `path`, `headers: Headers`, `user?: IPrincipal` (`:57`), `tenant?: ITenant` (`:66`), `json()` (throws `MalformedRequestBodyError`, a `400` status hint, `:110-118`), `text()`, `bytes()`.                                                                                                                                                                                                                                                             |
| `path` excludes the query                 | `packages/runtime/src/adapters/shared/fetch-mapping.ts:301-304`                                                                                                                                                      | `path` is the URL pathname, extracted without the query.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Body read is memoized                     | `packages/runtime/src/adapters/shared/fetch-mapping.ts:1-13`, `:158-160`                                                                                                                                             | `bytes()` is `this.#body ??= this.#readBody()`. `inject()` (`packages/kernel/src/application/application.ts:1030`) and `MockRequest` (`packages/testing/src/mock-context.ts:238`) also serve repeat reads. A capped read throws `RequestBodyTooLargeError` (`fetch-mapping.ts:38-50`, `413` hint).                                                                                                                                                                     |
| `IResponse.snapshot()`                    | `packages/common/src/http.ts:286-306`, `ResponseSnapshot` `:1015-1048`                                                                                                                                               | Discriminated on `streaming`: `false` → `body: Uint8Array \| string \| null`; `true` → a live `ReadableStream`.                                                                                                                                                                                                                                                                                                                                                        |
| `IResponse.send`                          | `packages/kernel/src/context/response.ts:78-85`                                                                                                                                                                      | Sets `application/octet-stream` ONLY when no `content-type` is set; `send()` with no body sets none.                                                                                                                                                                                                                                                                                                                                                                   |
| `IPrincipal`                              | `packages/common/src/services/auth.ts:16-25`                                                                                                                                                                         | `id`, `roles?`, `permissions?`, `claims?`. NO issuer or strategy member. `JwtStrategy` deliberately EXCLUDES `iss` from `claims` (`packages/auth-plugin/src/strategies/jwt-strategy.ts:115-138`), so nothing distinguishes two issuers' identical subjects (§3.11).                                                                                                                                                                                                    |
| `ITenant`                                 | `packages/common/src/services/tenancy.ts:14-21`                                                                                                                                                                      | `id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Localization writes `Content-Language`    | `packages/localization-plugin/src/middleware/locale-middleware.ts:118-127`                                                                                                                                           | After `next()`, and only when the response carries no `content-language` yet.                                                                                                                                                                                                                                                                                                                                                                                          |
| Route chain execution                     | `packages/kernel/src/pipeline/execute-chain.ts:92-137`; `packages/kernel/src/application/application.ts:1499-1510`                                                                                                   | Route middleware run in array order; ending the response without `next()` stops the chain (`:104`, `:111`); a handler throw propagates out of `next()` (`:137`).                                                                                                                                                                                                                                                                                                       |
| `errorHandler` is outermost               | `packages/exceptions/src/middleware/error-handler.ts:4-8`, `:171-178`                                                                                                                                                | Formats AFTER the route chain unwinds; a route middleware sees a thrown error, never its formatted body (§3.8).                                                                                                                                                                                                                                                                                                                                                        |
| `respondWithError`                        | `packages/common/src/errors/error-responder.ts:146-158`, `:206-231`                                                                                                                                                  | `respondWithError(ctx, { status, title, detail? })` writes in the configured format, returns `void`. Titles from `packages/exceptions/src/errors/exceptions.ts:50-63` (`STATUS_TITLES`): 400 `'Bad Request'`, 401 `'Unauthorized'`, 409 `'Conflict'`, 422 `'Unprocessable Entity'`, 429 `'Too Many Requests'`, 503 `'Service Unavailable'`.                                                                                                                            |
| Decorated route middleware order          | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:909-946`, `:487-499`, `:661-683`, `:722-737`                                                                                                               | guards (`:932`) → authorization (`:933-935`) → interceptors/middleware/filters (`:936`) → validation band (`:937-939`). Nothing after validation today.                                                                                                                                                                                                                                                                                                                |
| Register-time capability resolution       | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:1007-1022`, `:1034-1048`                                                                                                                                   | `VALIDATION`/`AUTHORIZATION` resolved once at `register()`; optional-dependency edges order providers first.                                                                                                                                                                                                                                                                                                                                                           |
| Missing-provider refusal                  | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:451-483`                                                                                                                                                   | `routeLabel` + `requireViewEngine`: `@Render` without `CAPABILITIES.VIEW` throws at `register()`.                                                                                                                                                                                                                                                                                                                                                                      |
| Method decorator plumbing                 | `packages/decorator-plugin/src/metadata/context-bridge.ts:60`, `:122-127`; `packages/decorator-plugin/src/decorators/response.ts:75-80`                                                                              | `export function HttpCode(status): SetuMethodDecorator` via `methodDecorator((store, target, handler) => store.mutateMethod(...))`.                                                                                                                                                                                                                                                                                                                                    |
| Route metadata materialization            | `packages/decorator-plugin/src/metadata/metadata-store.ts:238-276`, `:288-325`, `:780-797`                                                                                                                           | Optional scalars copied with conditional spreads.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Redis lock precedent                      | `packages/scheduler-plugin/src/lock/redis-lock.ts:20`, `:90-113`, `:150`, `:244`                                                                                                                                     | Lazy `await import('npm:ioredis@5.x')`, structural validation, reporter on a BUILT client only. Uses `crypto.randomUUID()` — NOT copied here.                                                                                                                                                                                                                                                                                                                          |
| Lazy client precedent                     | `packages/cache-plugin/src/stores/redis-store.ts:63-86` (`createLazyRedisClient`), `:199-213`                                                                                                                        | `new RedisCtor(url, { lazyConnect: true, commandTimeout })` (omitting `commandTimeout` at `0`), then explicit `connect()`.                                                                                                                                                                                                                                                                                                                                             |
| Connection error reporter                 | `packages/common/src/health/connection-errors.ts:108`, `:188`; use `packages/cache-plugin/src/plugin/cache-plugin.ts:113-122`                                                                                        | `createConnectionErrorReporter({ source, logger: () => ctx.logger })` + `attachConnectionErrorReporter(client, reporter)`.                                                                                                                                                                                                                                                                                                                                             |
| Cached probe                              | `packages/common/src/health/probe.ts:20-66`, `:121-141`, `resolveProbeTiming` `:243`; use `packages/cache-plugin/src/plugin/cache-plugin.ts:166-187`, `:294-319`                                                     | `createCachedProbe({ probe, ttlMs, timeoutMs, hrtime, setTimer, clearTimer })`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `withDeadline`                            | `packages/common/src/health/deadline.ts:34-45`, `:118-135`                                                                                                                                                           | `withDeadline(run, { timeoutMs, onTimeout, timing })`; `0` disables.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Health API / lifecycle                    | `packages/common/src/plugin.ts:207-215`, `:329-397`                                                                                                                                                                  | `ctx.health.register(name, fn)`; `onInit`, `onClose`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `IRuntimeServices`                        | `packages/common/src/runtime.ts:303-365`                                                                                                                                                                             | `uuid()`, `subtle`, `now()` (wall clock), `hrtime()` (monotonic), `setTimeout`/`clearTimeout`.                                                                                                                                                                                                                                                                                                                                                                         |
| Redaction                                 | `packages/common/src/redaction/redaction-service.ts:9-46`; `packages/common/src/redaction/policy.ts:7-14`                                                                                                            | `createRedactionService(policy)` → `{ redactValue, redactRecord }`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Binary codec                              | `packages/common/src/realtime-codec.ts:15-21`, `:43-55`, `:68-79`                                                                                                                                                    | `encodeFrameData` / `decodeFrameData`, reused for stored bodies.                                                                                                                                                                                                                                                                                                                                                                                                       |
| State-key convention                      | `packages/common/src/state-keys.ts:49-89`; `test/state-key-convention.test.ts:1-30`                                                                                                                                  | `<existing-package-dir>:<kebab-key>`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Durable Object lock core                  | `packages/cloudflare-plugin/src/durable-objects/distributed-lock-object.ts:22-39`, `:70-137`                                                                                                                         | One object per key; no non-storage `await` between read and write; `now` seam defaulting to `Date.now` (§4.2 deviation documented `:28-38`).                                                                                                                                                                                                                                                                                                                           |
| DO client precedent                       | `packages/cloudflare-plugin/src/lock/durable-object-lock.ts:13`, `:79-157`                                                                                                                                           | `namespace.get(namespace.idFromName(...)).fetch(ORIGIN + path, POST JSON)`; non-2xx throws `CloudflareUnsupportedError`.                                                                                                                                                                                                                                                                                                                                               |
| DO facades / guard / error                | `packages/cloudflare-plugin/src/durable-objects/do-facades.ts`; `src/bindings/facades.ts:387-395`, `:493-495`; `src/errors.ts:19-28`                                                                                 | `IDurableObjectStorage` has `get`/`put`/`delete` only; `isDurableObjectNamespace`; `new CloudflareBindingMissingError(message)`.                                                                                                                                                                                                                                                                                                                                       |
| DO input-gate fake                        | `packages/cloudflare-plugin/test/do-fakes.ts:36-55`, `:178-260`                                                                                                                                                      | `FakeDurableObjectNamespace` serializes calls per object name and dispatches by `kind`.                                                                                                                                                                                                                                                                                                                                                                                |
| DO limits/alarms (external)               | https://developers.cloudflare.com/durable-objects/platform/limits and https://developers.cloudflare.com/durable-objects/api/alarms/ (read 2026-10-08)                                                                | KV-backed values ≤ 131,072 bytes; SQLite-backed key+value ≤ 2 MB. One alarm per object; `setAlarm` overrides; `alarm()` invoked at the time.                                                                                                                                                                                                                                                                                                                           |
| ioredis facade assignability              | probes `.verify-109a/seam.ts`, `.verify-109a/seam2.ts` (2026-10-08)                                                                                                                                                  | A real `Redis` is assignable, with no cast, to `{ eval(script: string, numkeys: number, ...args: (string \| number)[]): Promise<unknown>; ping(): Promise<string>; quit(): Promise<unknown>; call(command: string, ...args: (string \| number)[]): Promise<unknown> }` and to that plus `connect(): Promise<void>; on(event: 'error', listener: (error: Error) => void): unknown`.                                                                                     |
| `CONFIG GET` on real Redis                | probe `.verify-109a/cfg.ts` against `redis:7.4.10` (2026-10-08)                                                                                                                                                      | `call('CONFIG', 'GET', 'maxmemory-policy')` → `['maxmemory-policy', 'noeviction']`; after `CONFIG SET … allkeys-lru` → `['maxmemory-policy', 'allkeys-lru']` (restored afterwards).                                                                                                                                                                                                                                                                                    |
| Lua scripts on real Redis 7               | probe `.verify-109a/lua.ts`; reviewer probe `lua2.ts` (2026-10-08)                                                                                                                                                   | 50 concurrent claims → exactly 1 `claimed`; wrong-token COMPLETE → `lost`; reclaim after completion → `completed` + record verbatim (UTF-8, lone surrogate, a 600 KB record); different fingerprint → mismatch; takeover after a lapsed 50 ms lease; old token → `lost`; an empty `''` record round-trips. A non-JSON value at the key makes CLAIM fail with a script error; a JSON number fails indexing — both surface as a rejected `eval` (§3.5 maps them to 503). |
| Fan-out collision (B1)                    | reviewer probe `fanout.ts`, reproduced at `.verify-109a/fanout.ts` (2026-10-08)                                                                                                                                      | With a key of `['ingress', kind, name, '', dedupId]`, two subscribers on one topic: only `billing` ran, `shipping` was refused `in-progress`; a header-less publish on `backplane` was refused `key-missing` and its handler never ran.                                                                                                                                                                                                                                |
| `JSON.stringify` canonicalisation         | reviewer probe `canon.ts` (2026-10-08)                                                                                                                                                                               | A replacer-sorted stringify serialises every `Map` as `{}` (so two different maps collide), a cycle raises `RangeError` (stack overflow), bigint raises `TypeError`, a top-level `undefined` yields `undefined`.                                                                                                                                                                                                                                                       |
| Stripe                                    | https://docs.stripe.com/api/idempotent_requests (read 2026-10-08)                                                                                                                                                    | Saves status and body of the first request including `500`s; keys ≤ 255 characters; prunable after ≥ 24 h; errors on parameter mismatch; not saved when validation fails or a concurrent request runs.                                                                                                                                                                                                                                                                 |
| IETF draft                                | https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/ — draft-07, 2025-10-15, **expired**; text https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-07.html (2026-10-08) | §2.1 Item Structured Field, String value; §2.4 fingerprint; §2.3 expiry MAY; §2.6 replay previous result; missing **400**, different payload **422**, concurrent **409**; §5 composite key with client attributes.                                                                                                                                                                                                                                                     |
| AWS Powertools (TS)                       | https://docs.aws.amazon.com/powertools/typescript/latest/features/idempotency/ (2026-10-08)                                                                                                                          | `INPROGRESS`/`COMPLETE`/`EXPIRED`; in-progress expiry; default expiry 3600 s; `IdempotencyValidationError`; `IdempotencyAlreadyInProgressError`; an unhandled exception deletes the record; Redis via `SET NX`.                                                                                                                                                                                                                                                        |
| Brandur Leach                             | https://brandur.org/idempotency-keys — 2017-10-27 (2026-10-08)                                                                                                                                                       | `(user_id, idempotency_key)` unique; `locked_at` → 409; ~72 h retention; "pass through our own unique ID" to a provider.                                                                                                                                                                                                                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                                                                            | Doc deliverable (same PR)                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| C1  | ROADMAP "B: Redis `SET NX PX`". A bare `SET NX PX` cannot detect a lapsed lease with a matching fingerprint, compare an existing fingerprint, or fence `complete`/`release`.                                          | Three Lua scripts (§3.5), atomic on the server, reading the server clock with `TIME`.                                                                                                                               | ROADMAP M109 scope bullet corrected.                                             |
| C2  | ROADMAP: a claim answers "… or lease expired".                                                                                                                                                                        | A lapsed lease is taken over INSIDE the claim: `claimed` with `takeover: true` (§3.3).                                                                                                                              | ROADMAP M109 core bullet corrected.                                              |
| C3  | ROADMAP deliverable "refusing a streaming route at registration". No registration-time signal exists: `RouteDefinition` (`common/src/http.ts:999-1006`) and `RouteMetadata` (`metadata-store.ts:238-276`) carry none. | Detected at request time from `snapshot().streaming`; the record is status-only (§3.10). Registration refuses `@Idempotent` on `GET`/`HEAD`/`OPTIONS` instead (§3.9).                                               | ROADMAP deliverable corrected.                                                   |
| C4  | ROADMAP key source "message id". `IngressContext` carries none; a broker id changes on a re-send.                                                                                                                     | Messaging default key = `x-setu-deduplication-id` (§3.7).                                                                                                                                                           | ROADMAP config bullet corrected.                                                 |
| C5  | ROADMAP replay rule as a strip list.                                                                                                                                                                                  | An ALLOW list plus a fixed DENY list (§3.10).                                                                                                                                                                       | ROADMAP config bullet corrected.                                                 |
| C6  | ROADMAP "a recorded caller error replays". A thrown caller error is formatted only after the route chain unwinds (`error-handler.ts:4-8`, `:171-178`).                                                                | Only a 4xx the handler RETURNS is recorded; any THROWN error releases and rethrows (§3.8).                                                                                                                          | ROADMAP config bullet; README "Failure classification".                          |
| C7  | ROADMAP packages list (`sdk`, no `decorator-plugin`/`messaging-plugin`/`queue-plugin`/`cli`).                                                                                                                         | 109a: `idempotency-plugin` (new), `common`, `decorator-plugin`, `cloudflare-plugin`, `messaging-plugin`, `queue-plugin`, `cli`. `sdk` → 109b.                                                                       | ROADMAP `Package(s)` split per sub-milestone; Progress row `109a`.               |
| C8  | ROADMAP lists no status for a MISSING key; draft-07 says 400.                                                                                                                                                         | `required: true` default; missing key → 400 (§3.6).                                                                                                                                                                 | ROADMAP config bullet gains the 400 row.                                         |
| C9  | ROADMAP "an ingress behaviour for queue jobs and messages" — silent on fan-out, internal traffic and scheduler/websocket.                                                                                             | The behaviour acts only on an allow-list of `topics`/`jobNames`; the key includes the consumer identity; everything else (including every `scheduler`/`websocket` envelope) passes through untouched (§3.7, §3.19). | ROADMAP ingress bullet corrected; README; PUBLIC_API.md.                         |
| C10 | Prior art on a payload mismatch: Brandur 409, Stripe error, draft-07 422.                                                                                                                                             | 422.                                                                                                                                                                                                                | README cites draft-07 as EXPIRED.                                                |
| C11 | `IngressContext` JSDoc and the `ingress-contract.test.ts` pin say the member set is closed (`ingress.ts:30-46`; test `:40-59`).                                                                                       | Widened with an OPTIONAL `consumer` (§3.19). The JSDoc block gains a paragraph explaining why; the two compile-time pins are updated, and the test comment records it as a deliberate addition.                     | PUBLIC_API.md `IngressContext` row; messaging/queue READMEs (behaviour section). |

## 3. Design decisions

### 3.1 Package layout and dependency direction

- **Decision:** a new plugin package `packages/idempotency-plugin` depending on `@setu-ts/common`
  only at runtime. The store port, service contract, option types and token live in `common`.
  `cloudflare-plugin` implements the port; `decorator-plugin` consumes the service contract; neither
  imports `idempotency-plugin`. `messaging-plugin` and `queue-plugin` only populate the new
  `IngressContext.consumer`; they import nothing new.
- **Why:** AI_GUIDELINES §2.2 forbids a plugin importing a plugin; §2.1 permits types, interfaces
  and constants in `common`.
- **Test home:** `packages/common/test/unit/idempotency-contract.test.ts`;
  `packages/idempotency-plugin/test/unit/barrel-exports.test.ts`.

### 3.2 Exact cross-package declarations (`common/src/services/idempotency.ts`)

- **Decision:** the file contains exactly these declarations (JSDoc on every member, `@since 0.9.0`;
  if `0.9.0` has been tagged before merge, the next unreleased version). Imports:
  `import type { IRequestContext, MiddlewareFunction } from '../http.ts'`,
  `import type { IIngressBehavior, IngressContext } from './ingress.ts'`,
  `import type { IRuntimeServices } from '../runtime.ts'`,
  `import type { RedactionPolicy } from '../redaction/policy.ts'`,
  `import type { IRedactionService } from '../redaction/redaction-service.ts'`.

```ts
// ── Store port ──────────────────────────────────────────────────────────────
export interface IdempotencyClaimRequest {
  /** Store key: 64 lower-case hex characters, scoped and hashed by the caller (§3.11). */
  readonly key: string;
  /** Capacity bucket: 64 lower-case hex characters (§3.16). Stores without per-scope caps ignore it. */
  readonly scope: string;
  /** Request fingerprint: 64 lower-case hex characters. */
  readonly fingerprint: string;
  /** Candidate token minted by the caller with `runtime.uuid()`. Fences the RECORD only. */
  readonly token: string;
  /** Milliseconds before a retry may take the claim over. Integer ≥ 1. */
  readonly leaseMs: number;
  /** Milliseconds the record is retained from this write. Integer ≥ `leaseMs`. */
  readonly ttlMs: number;
}

export type IdempotencyClaimResult =
  | { readonly outcome: 'claimed'; readonly takeover: boolean }
  | { readonly outcome: 'completed'; readonly record: string }
  | { readonly outcome: 'in-progress' }
  | { readonly outcome: 'fingerprint-mismatch' }
  | { readonly outcome: 'capacity-exceeded' };

export type IdempotencySettleResult = 'settled' | 'lost';

export interface IIdempotencyStore {
  /** Short store kind for health data, e.g. `'memory'`, `'redis'`, `'durable-object'`. */
  readonly name: string;
  /** Largest serialized record in UTF-8 bytes the store can hold. Absent: no store limit. */
  readonly maxRecordBytes?: number;
  /** Prepares the store. Called exactly once, before any other member. */
  connect(runtime: IRuntimeServices): Promise<void>;
  claim(request: IdempotencyClaimRequest): Promise<IdempotencyClaimResult>;
  complete(
    key: string,
    token: string,
    record: string,
    ttlMs: number,
  ): Promise<IdempotencySettleResult>;
  release(key: string, token: string): Promise<IdempotencySettleResult>;
  /** Reachability probe. Absent: "cannot tell". */
  isHealthy?(): Promise<boolean>;
  /** Releases the store's own resources. Called from the plugin's close hook. */
  disconnect?(): Promise<void>;
}

// ── HTTP options ────────────────────────────────────────────────────────────
/** Where an HTTP request's idempotency key comes from. */
export type IdempotencyKeySource =
  | { readonly header: string }
  | { readonly bodyField: string }
  | ((ctx: IRequestContext) => string | undefined | Promise<string | undefined>);

/** How an HTTP request is fingerprinted. The function's result is re-hashed. */
export type IdempotencyFingerprintSource =
  | 'request'
  | ((ctx: IRequestContext) => string | Promise<string>);

export interface IdempotentRouteOptions {
  /** Default `{ header: 'Idempotency-Key' }`. */
  readonly key?: IdempotencyKeySource;
  /** Default `true`: a request without a key answers 400. `false`: it passes through, unclaimed. */
  readonly required?: boolean;
  /** Default `'required'`: no principal → 401. `'optional'`: anonymous requests share one scope. */
  readonly principal?: 'required' | 'optional';
  /** Default `` `${method} ${path}` `` of the request. 1–256 characters, none below U+0020. */
  readonly namespace?: string;
  /** Default `'request'`. */
  readonly fingerprint?: IdempotencyFingerprintSource;
  /** Default: the plugin's `leaseMs` (60,000). */
  readonly leaseMs?: number;
  /** Default: the plugin's `ttlMs` (86,400,000). */
  readonly ttlMs?: number;
  /** Default `'full'`. `'status'` stores no body and no headers. */
  readonly response?: 'full' | 'status';
  /** Default: the plugin's `maxResponseBytes` (262,144). UTF-8 bytes of a string body; byte length of a binary body. */
  readonly maxResponseBytes?: number;
  /** Extra replayable header names, beyond the default allow-list. Default `[]`. */
  readonly replayHeaders?: readonly string[];
  /** Redacts a JSON-object body before it is stored. Default: none. */
  readonly redaction?: RedactionPolicy | IRedactionService;
}

// ── Ingress options ─────────────────────────────────────────────────────────
/** Where an ingress work item's key comes from. */
export type IngressIdempotencyKeySource =
  | 'auto'
  | 'job-id'
  | 'deduplication-header'
  | ((ctx: IngressContext) => string | undefined);

/** How an ingress work item is fingerprinted. The function's result is re-hashed. */
export type IngressIdempotencyFingerprintSource =
  | 'payload'
  | ((ctx: IngressContext) => string | Promise<string>);

export interface IdempotentIngressCommonOptions {
  /** Default `'auto'`: a queue job's id; a message's `x-setu-deduplication-id` header. */
  readonly key?: IngressIdempotencyKeySource;
  /** Default `'payload'`. */
  readonly fingerprint?: IngressIdempotencyFingerprintSource;
  /** An extra scope segment (for example a tenant id read from the payload). Default: none. */
  readonly scope?: (ctx: IngressContext) => string | undefined;
  /** Default: the plugin's `ingressLeaseMs` (30,000). */
  readonly leaseMs?: number;
  /** Default: the plugin's `ttlMs` (86,400,000). */
  readonly ttlMs?: number;
}

/** At least one of `topics` and `jobNames` is required; anything not listed passes through. */
export type IdempotentIngressOptions =
  | (IdempotentIngressCommonOptions & {
    readonly topics: readonly string[];
    readonly jobNames?: readonly string[];
  })
  | (IdempotentIngressCommonOptions & {
    readonly topics?: readonly string[];
    readonly jobNames: readonly string[];
  });

// ── Service ─────────────────────────────────────────────────────────────────
export interface IIdempotencyService {
  /**
   * Builds the HTTP middleware. SYNCHRONOUS. Resolves `options` against the provider's defaults
   * and throws when the result is invalid (`ttlMs < leaseMs`, an option shape the provider refuses).
   */
  middleware(options?: IdempotentRouteOptions): MiddlewareFunction;
  /** Builds the ingress behaviour. SYNCHRONOUS; throws like `middleware`. */
  behavior(options: IdempotentIngressOptions): IIngressBehavior;
}
```

Every type above is exported from `common/src/index.ts`, INCLUDING `IdempotentIngressCommonOptions`
(declared `export interface`): an unexported type referenced by an exported union is a
`deno doc --lint` `private-type-ref` diagnostic, which the M38 ratchet counts.

- **Why:** the reviewer's M1; the record is an opaque string so every store holds identical bytes;
  `scope` lets the memory store cap per caller (§3.16) without the store re-deriving anything.
- **Test home:** `packages/common/test/unit/idempotency-contract.test.ts` (type-level rows below).

### 3.3 The state machine (every store implements exactly this)

`now` is the store's clock (memory: `runtime.hrtime()`; Redis: server `TIME`; DO: the core's
`now()`). "Absent" includes a record with `expiresAt <= now`. Checks run in this order: capacity
(memory only, on insert), expiry, fingerprint, state, lease.

| Current state                                         | Event                             | Result                                                                                                              | New state                                                                                                                |
| ----------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| absent, per-scope or global cap reached (memory only) | `claim`                           | per-scope: `{ outcome: 'capacity-exceeded' }`; global: the store THROWS `Error('memory idempotency store is full')` | unchanged                                                                                                                |
| absent                                                | `claim(k, f, token, lease, ttl)`  | `{ outcome: 'claimed', takeover: false }`                                                                           | in-progress `{ token, f, leaseUntil: now+lease, expiresAt: now+ttl }`                                                    |
| present, stored fingerprint ≠ `f`                     | `claim`                           | `{ outcome: 'fingerprint-mismatch' }`                                                                               | unchanged                                                                                                                |
| completed, fingerprint = `f`                          | `claim`                           | `{ outcome: 'completed', record }`                                                                                  | unchanged                                                                                                                |
| in-progress, fingerprint = `f`, `leaseUntil > now`    | `claim`                           | `{ outcome: 'in-progress' }`                                                                                        | unchanged                                                                                                                |
| in-progress, fingerprint = `f`, `leaseUntil <= now`   | `claim` (new `token`)             | `{ outcome: 'claimed', takeover: true }`                                                                            | in-progress `{ token: NEW, f, leaseUntil: now+lease, expiresAt: now+ttl }`                                               |
| in-progress, stored token = `token`                   | `complete(k, token, record, ttl)` | `'settled'`                                                                                                         | completed `{ f, record, expiresAt: now+ttl }`, token cleared — accepted even after the lease lapsed, if nobody took over |
| absent, completed, or another token                   | `complete`                        | `'lost'`                                                                                                            | unchanged                                                                                                                |
| in-progress, stored token = `token`                   | `release(k, token)`               | `'settled'`                                                                                                         | absent (deleted)                                                                                                         |
| absent, completed, or another token                   | `release`                         | `'lost'`                                                                                                            | unchanged                                                                                                                |

- **Decision:** the token fences the RECORD only — a stale holder can neither complete nor release
  its successor's claim, but a database write it already made stays made. JSDoc and README say so.
- **Why:** Powertools' in-progress expiry plus the M52d token comparison; fingerprint before state
  makes a different-payload concurrent duplicate a `422`, the more useful answer.
- **Test home:** the conformance fixture (one `it` per row), run against all three stores.

### 3.4 Tier B on Redis owns its client (the `ICacheStore` gap)

- **Decision:** the Redis store lives in `idempotency-plugin` and owns its client (inject-or-lazy
  `npm:ioredis@5.x`). The cache contract is NOT widened.
- **Why:** `ICacheStore` has no atomic member (§1); fenced `complete`/`release` need compare-and-set
  too, and `KvCacheStore` (Cloudflare KV, eventually consistent) could honour none of them.
  **Rejected:** an optional `setIfAbsent?` on `ICacheStore`.
- **Test home:** `test/unit/redis-store.test.ts`, `test/integration/redis-real.test.ts`.

### 3.5 Redis store: scripts, keys, client, guarantees

- **Decision:**
  - Store key = `` `${keyPrefix}${namespace}:${key}` ``. `namespace` is REQUIRED on both Redis arms
    (grammar `^[a-z0-9][a-z0-9._-]{0,63}$`, refused otherwise); `keyPrefix` default
    `'setu:idempotency:'` (1–64 characters, each `0x21`–`0x7E`).
  - Record value: JSON
    `{ "s": "p"|"c", "t": token, "f": fingerprint, "l": "<leaseUntil ms>", "r":
    record }`; `l`
    is a STRING.
  - Three scripts, sent as `client.eval(script, 1, storeKey, ...args)`; no value is ever
    concatenated into script text:

```lua
-- CLAIM: ARGV = token, fingerprint, leaseMs, ttlMs
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local raw = redis.call('GET', KEYS[1])
if raw then
  local rec = cjson.decode(raw)
  if rec.f ~= ARGV[2] then return {'fingerprint-mismatch'} end
  if rec.s == 'c' then return {'completed', rec.r} end
  if tonumber(rec.l) > now then return {'in-progress'} end
  rec.t = ARGV[1]
  rec.l = tostring(now + tonumber(ARGV[3]))
  redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ARGV[4])
  return {'claimed', '1'}
end
redis.call('SET', KEYS[1], cjson.encode({s = 'p', t = ARGV[1], f = ARGV[2], l = tostring(now + tonumber(ARGV[3]))}), 'PX', ARGV[4])
return {'claimed', '0'}
```

```lua
-- COMPLETE: ARGV = token, record, ttlMs
local raw = redis.call('GET', KEYS[1])
if not raw then return 'lost' end
local rec = cjson.decode(raw)
if rec.s ~= 'p' or rec.t ~= ARGV[1] then return 'lost' end
rec.s = 'c'
rec.r = ARGV[2]
rec.t = nil
redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ARGV[3])
return 'settled'
```

```lua
-- RELEASE: ARGV = token
local raw = redis.call('GET', KEYS[1])
if not raw then return 'lost' end
local rec = cjson.decode(raw)
if rec.s ~= 'p' or rec.t ~= ARGV[1] then return 'lost' end
redis.call('DEL', KEYS[1])
return 'settled'
```

- `parseClaimReply(reply: unknown): IdempotencyClaimResult` accepts exactly `['claimed','0'|'1']`,
  `['completed', string]`, `['in-progress']`, `['fingerprint-mismatch']`; anything else throws
  `Error('redis idempotency store: unexpected CLAIM reply')`.
  `parseSettleReply(reply: unknown): IdempotencySettleResult` accepts `'settled'`/`'lost'`, else
  throws `Error('redis idempotency store: unexpected reply')`. A script error (a foreign value at
  the key, §1) rejects `eval`; that rejection is a store failure (HTTP 503 / ingress retry).
- Client facades (in `src/interfaces/index.ts`):

```ts
export interface IRedisIdempotencyClient {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
}
/** The shape of a client this package BUILDS (internal, not exported). */
interface IBuiltRedisIdempotencyClient extends IRedisIdempotencyClient {
  connect(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
```

- Built arm `{ type: 'redis', namespace, url, commandTimeoutMs?, keyPrefix? }`:
  `createRedisIdempotencyClient(RedisCtor, url, commandTimeoutMs)` — the cache-plugin
  `createLazyRedisClient` precedent (`cache-plugin/src/stores/redis-store.ts:63-86`) — constructs
  with `{ lazyConnect: true, commandTimeout }` (`commandTimeoutMs` default 15,000; `0` omits the
  option); `RedisCtor` comes from `loadIoredis()` = `(await import('npm:ioredis@5.x')).Redis`. The
  connection-error reporter is attached. `store.connect()` calls `client.connect()`; `disconnect()`
  calls `client.quit()`.
- Injected arm `{ type: 'redis', namespace, client, keyPrefix? }`: validated structurally (`eval`,
  `ping`, `quit`, `call` are functions, else
  `IdempotencyConfigurationError('store.client', 'redis idempotency store: the injected
    client needs eval, ping, quit and call')`);
  no listener attached; `connect()` NOT called; `disconnect()` does NOT quit it (the application
  owns it).
- **Eviction-policy check**, in `store.connect()` for both arms, after the connection:
  `client.call('CONFIG', 'GET', 'maxmemory-policy')`. If it resolves to an array whose second
  element is a string other than `'noeviction'`, log `warn`
  `'redis idempotency store: maxmemory-policy
    is <policy>; completed records can be evicted, which allows a duplicate'`
  with `{ policy }`. If the call rejects (managed Redis commonly disables `CONFIG`), or the reply
  has another shape, log nothing and continue. The logger is the plugin's thunk passed in (§3.14).
- `isHealthy()` = `(await client.ping()) === 'PONG'`; a rejection is `false`.
- `maxRecordBytes` absent.
- **Version floor:** Redis ≥ 5. `TIME` inside a script is safe only under script-effects
  replication, the default from Redis 5 (Redis documentation; verified here on 7.4.10 only). The
  README states the floor.
- **Durability:** completed records survive only under `maxmemory-policy noeviction` and persistence
  that does not drop acknowledged writes on failover; with eviction, or an asynchronous replica
  promoted after a primary dies, a completed record can vanish silently and the next duplicate
  executes. README, §3.18 and §10 D18 say this.
- **Why:** proven on real Redis (§1); `TIME` puts every replica on one clock; the required
  `namespace` stops two applications sharing a Redis from reading each other's records (§10 D19).
- **Test home:** `test/unit/redis-store.test.ts`, `test/unit/redis-client.test.ts`,
  `test/integration/redis-real.test.ts`, `test/types/redis-client-seam.assert.ts`.

### 3.6 HTTP: check order, key, fingerprint, statuses

- **Decision — the middleware runs these steps in this order; each is tested:**
  1. **Safe method:** `GET`, `HEAD`, `OPTIONS` → `await next()`, no store call, return.
  2. **Key extraction:** read the key from the source.
     - `{ header }`: `ctx.request.headers.get(header)`; `null` → missing.
     - `{ bodyField }`: `await ctx.request.json()`; a THROW propagates unchanged — the platform's
       `MalformedRequestBodyError` carries a `400` status hint (`common/src/http.ts:110-118`), so
       `errorHandler` answers 400; a `RequestBodyTooLargeError` (`413`) propagates unchanged. The
       parsed value must be a plain object; the field must be a string, else INVALID; absent field →
       missing.
     - function: its result; a THROW propagates unchanged (`errorHandler` → 500).
  3. **Missing key with `required: false`:** `await next()`, no store call, return — BEFORE any
     principal check.
  4. **Principal:** `principal: 'required'` and `ctx.request.user` absent → 401, return.
  5. **Missing key with `required: true`** → 400, return. **Invalid key** (`parseKeyValue` returns
     `undefined`) → 400, return.
  6. **Fingerprint:** `'request'` hashes method, path, raw query, content-type and
     `await ctx.request.bytes()` (a `413` from the read propagates unchanged); a custom function's
     result is re-hashed. A custom function's throw propagates unchanged.
  7. **Scope and key derivation** (§3.11), **claim** with a fresh `runtime.uuid()` token.
  8. **Outcome:** §3.8 for `claimed`; the status table below for the rest; replay for `completed`
     (§3.10).
- **Key normalization (`parseKeyValue(raw: string): string | undefined`):** if `raw` has length ≥ 2
  and starts AND ends with `"`, strip exactly those two characters (draft-07 §2.1; no escape
  processing). The result must be 1–255 characters, each `0x21`–`0x7E` and not `"`. Otherwise
  `undefined`.
- **Fingerprint (`'request'`):** SHA-256 (`runtime.subtle`) over the length-prefixed segments
  `method`, `path` (`ctx.request.path`, the pathname), `query`, `content-type` (lower-cased, `''`
  when absent), then the raw body bytes. `query` = the substring of `ctx.request.url` from the first
  `?` (inclusive) to the end, exactly as received — never parsed, never re-ordered — `''` when there
  is no `?`. A URL never carries a fragment to the server. Two URLs whose parameters differ only in
  order fingerprint DIFFERENTLY; the README says so.
- **Length-prefix encoding** (fingerprints AND keys, `core/hash.ts`): for each segment, the UTF-8
  bytes of `` `${byteLength}:` `` then the segment's UTF-8 bytes. Output lower-case hex.
- **Statuses** — all through `respondWithError`; the client's key never appears in a body:

| Condition                                                            | Status | `title`                  | `detail`                                                          |
| -------------------------------------------------------------------- | ------ | ------------------------ | ----------------------------------------------------------------- |
| step 4: no principal, `principal: 'required'`                        | 401    | `'Unauthorized'`         | `'Idempotent requests require an authenticated principal'`        |
| step 5: key missing, `required: true`                                | 400    | `'Bad Request'`          | `'This request requires an idempotency key'`                      |
| step 5: key invalid                                                  | 400    | `'Bad Request'`          | `'The idempotency key is not valid'`                              |
| claim → `fingerprint-mismatch`                                       | 422    | `'Unprocessable Entity'` | `'The idempotency key was already used with a different request'` |
| claim → `in-progress`                                                | 409    | `'Conflict'`             | `'A request with this idempotency key is still being processed'`  |
| claim → `capacity-exceeded`                                          | 429    | `'Too Many Requests'`    | `'Too many idempotency keys are held for this caller'`            |
| claim throws, or a completed record fails `decodeHttpRecord` (§3.10) | 503    | `'Service Unavailable'`  | `'The idempotency store is unavailable'`                          |

- **Why:** draft-07's codes; Stripe's 255 bound; the reviewer's ordering — a request a client chose
  not to make idempotent never needs a principal; the principal check precedes every key-validity
  answer so an anonymous caller learns nothing about key grammar.
- **Test home:** `test/unit/key.test.ts`, `test/unit/hash.test.ts`,
  `test/unit/http-middleware.test.ts` (one `it` per step), `test/integration/http-kernel.test.ts`.

### 3.7 Ingress: allow-list, key, consumer, fingerprint, outcomes

- **Decision — the behaviour runs these steps in this order:**
  1. **Allow-list:** `kind === 'messaging'` and `name` ∈ `topics`, or `kind === 'queue'` and `name`
     ∈ `jobNames`. Otherwise `await next()` and return — no store call, nothing read. Every
     `scheduler` and `websocket` envelope therefore passes through untouched, as does the realtime
     backplane's topic unless an application lists it.
  2. **Consumer:** `ctx.consumer` (§3.19). Absent → throw
     `IdempotencyRefusedError('consumer-missing', kind, name, 'idempotentIngress: a listed <kind> reached the behaviour without a consumer identity')`.
     Not detectable at registration (a behaviour factory sees only the registry).
  3. **Key:** `'auto'` → queue: `(payload as IJob).id` (a string, else missing); messaging:
     `ctx.headers?.[DEDUPLICATION_ID_HEADER]`. `'job-id'` on messaging or `'deduplication-header'`
     on queue → throw `('unsupported-key-source')`. A function's result is used; its throw
     propagates unchanged. Missing → throw `('key-missing')`; `parseKeyValue` → `undefined` → throw
     `('key-invalid')`.
  4. **Fingerprint:** `'payload'` → SHA-256 over the length-prefixed segment `canonicalJson(x)`, `x`
     = `{ name: job.name, data: job.data }` for a queue job (NEVER `attempts`), the message payload
     for messaging. A `CanonicalJsonError` (§3.20) → throw `('fingerprint-unavailable')` with the
     error as `cause`. A custom function's result is re-hashed; its throw propagates unchanged.
  5. **Derive** key and capacity scope (§3.11); **claim**. A claim THROW propagates (the job or
     message is retried).
  6. **Outcome:** `completed` → return WITHOUT `next()` (acknowledged as handled). `in-progress` →
     throw `('in-progress')`. `fingerprint-mismatch` → throw `('fingerprint-mismatch')`.
     `capacity-exceeded` → throw `('capacity-exceeded')`. `claimed` → `takeover` logs `warn`
     `'idempotency claim took over a lapsed lease'` `{ kind, name }`; then `await next()`:
     - rejects → `release`; a `release` rejection or `'lost'` is logged (`warn` for `'lost'`,
       `error` for a rejection) and NEVER replaces the original error; rethrow the ORIGINAL.
     - resolves → `complete(key, token, '', ttlMs)`; `'lost'` → `warn`
       `'idempotency lease lapsed
       before completion; the work may have run twice'`; a
       rejection → `error`; neither is thrown.
- **What the caller sees when `complete`/`release` fails on ingress:** the handler's outcome,
  always. A successful handler is acknowledged even if `complete` failed; the record stays
  in-progress until its lease lapses, so a redelivery inside the lease is refused `in-progress` and
  a redelivery after it re-runs the work. A failed handler's original error reaches the queue/broker
  even if `release` failed; the retry is refused `in-progress` until the lease lapses.
- **Missing key on a listed topic or job:** a named throw, so it is visible: the queue dead-letters
  after `maxAttempts`; a broker redelivers per its own policy (dead-lettering is the broker's
  configuration, M108 owns poison handling). The README states it.
- **Why:** B1 — the allow-list keeps internal and unrelated traffic untouched; the consumer makes
  two subscribers' work two keys. A failed job or message must be retried, so it always releases.
- **Test home:** `test/unit/ingress-behavior.test.ts` (one `it` per step and outcome),
  `test/integration/messaging-fanout.test.ts`, `test/integration/queue-ingress.test.ts`,
  `test/integration/messaging-ingress.test.ts`, `test/integration/crash-redelivery.test.ts`.

### 3.8 HTTP failure classification

- **Decision:** after `claimed`:
  - `takeover: true` → log `warn` `'idempotency claim took over a lapsed lease'` `{ namespace }`.
  - set `ctx.state.set(IDEMPOTENCY_DERIVED_KEY_STATE_KEY, storeKey)` (§3.12).
  - `await next()` rejects → `release` (rejection logged `error`, `'lost'` logged `warn`, neither
    masks), rethrow the ORIGINAL error. Covers every thrown error, including a thrown `4xx`.
  - resolves → `snapshot()`. `status >= 500` or `status` ∈ `{ 408, 425, 429 }` → `release` (same
    logging). Status 200–499 otherwise → `complete` with the §3.10 record. A status below 200 is
    released (never recorded).
  - `complete` → `'lost'`: `warn`
    `'idempotency lease lapsed before completion; the work may have run
    twice'` `{ namespace }`.
    `complete` rejection: `error`. Neither thrown.
- **What the caller sees when `complete`/`release` fails on HTTP:** the response the handler already
  produced, unchanged. After a failed `complete` the record stays in-progress: a retry inside the
  lease gets 409, a retry after it re-executes. After a failed `release` the same.
- **Why:** C6; `408`/`425`/`429` are transient; a `5xx` releases per the ROADMAP and Powertools (the
  one deliberate departure from Stripe, which replays `500`s).
- **Test home:** `test/unit/http-middleware.test.ts`, `test/integration/http-kernel.test.ts`.

### 3.9 HTTP entry points, placement, and validation timing

- **Decision:**
  - **Call-time shape validation** (`validateRouteOptionShape(options): void`, internal in
    `core/options.ts`): each field ALONE — types, integer ranges (§3.13), string grammars, the `key`
    arm's shape, `replayHeaders` entries (valid header name via `new Headers().set(name,
    'x')`,
    not on the DENY list), `redaction` is a `RedactionPolicy`-shaped object or has a `redactRecord`
    function. Throws `IdempotencyConfigurationError` naming the field, never its value.
  - **Resolution** (`resolveRouteOptions(options, defaults): ResolvedRouteOptions`, called by
    `IIdempotencyService.middleware`): merges plugin defaults, then checks cross-field rules —
    `ttlMs ≥ leaseMs` — and builds the redaction service once. Throws
    `IdempotencyConfigurationError`.
  - `idempotent(options?)` (free function): runs the shape validation at the CALL. Returns a
    `MiddlewareFunction` whose closure owns a
    `WeakMap<IIdempotencyService, MiddlewareFunction |
    IdempotencyConfigurationError>` CREATED
    INSIDE THIS CALL (never module-level). Per request:
    - `ctx.services.has(CAPABILITIES.IDEMPOTENCY)` false → throw
      `IdempotencyConfigurationError('idempotent(): no CAPABILITIES.IDEMPOTENCY provider is registered — add IdempotencyPlugin() to the application')`.
    - else `service = ctx.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY)`; cached
      middleware → delegate; cached error → throw it; neither → call `service.middleware(options)`
      inside try: success caches and delegates; an `IdempotencyConfigurationError` is cached, logged
      ONCE at `error` through the registry's `CAPABILITIES.LOGGER` when present
      (`{ error:
      message }`), and thrown — `errorHandler` maps it to 500 (it carries no status
      hint). Later requests rethrow the cached error without logging again (`errorHandler`'s own
      per-request logging is separate).
  - Placement for `idempotent()` is the application's: README and JSDoc say "list it LAST in the
    route's `middleware` array — after guards and validation".
  - `@Idempotent(options?: IdempotentRouteOptions): SetuMethodDecorator` (decorator-plugin) records
    `idempotent: options ?? {}` via `methodDecorator`/`mutateMethod`; topmost wins. No validation at
    decoration.
  - `DecoratorPlugin.register()` resolves `CAPABILITIES.IDEMPOTENCY` once beside `VALIDATION`
    (`decorator-plugin.ts:1034-1048`). `registerController` gains a parameter
    `idempotency: IIdempotencyService | undefined` and, after `appendValidationMiddleware`
    (`:937-939`) whether or not `enforceSchemas` is on, calls
    `appendIdempotencyMiddleware(target, route, fullPath, middleware, idempotency)`:
    - route has no `idempotent` → no-op;
    - `route.method` ∈ `GET`/`HEAD`/`OPTIONS` → throw
      `` `${routeLabel(...)} is decorated with @Idempotent, but ${method} is a safe method; idempotency keys apply to unsafe methods only.` ``
    - `idempotency === undefined` → throw
      `` `${routeLabel(...)} is decorated with @Idempotent, but no CAPABILITIES.IDEMPOTENCY provider is registered. Register IdempotencyPlugin from @setu-ts/idempotency-plugin (or another provider of CAPABILITIES.IDEMPOTENCY).` ``
    - else `middleware.push(idempotency.middleware(route.idempotent))` — shape AND resolution errors
      throw here, failing `register()`.
  - `DecoratorPlugin.optionalDependencies` gains `CAPABILITIES.IDEMPOTENCY` in BOTH arms
    (`:1007-1022`).
- **Why:** M89a/M70n placement; one implementation behind both entry points; the reviewer's M2 —
  resolution may depend on the provider, which the functional form cannot see before its first
  request.
- **Test home:** `packages/decorator-plugin/test/integration/idempotent-registration.test.ts`,
  `packages/decorator-plugin/test/unit/idempotent-decorator.test.ts`,
  `packages/idempotency-plugin/test/unit/idempotent.test.ts`,
  `packages/idempotency-plugin/test/integration/decorator.test.ts`.

### 3.10 HTTP record: encode, decode, replay

- **Decision:**
  - Record JSON (v1):
    `{ "v": 1, "s": <status>, "h": [[name, value], ...], "b": { "data": string,
    "binary"?: true } | null }`;
    `b` = `encodeFrameData(body)`.
  - Default ALLOW list: `content-type`, `content-encoding`, `content-location`, `location`,
    `cache-control`, `etag`, `last-modified`, `expires`, `vary`, plus `replayHeaders` (lower-cased).
  - Fixed DENY list (never stored, never replayed, refused in `replayHeaders`): `set-cookie`,
    `set-cookie2`, `content-language` (the localization middleware writes it after the handler from
    the CURRENT request's locale, `locale-middleware.ts:118-127`), `ratelimit`, `ratelimit-policy`,
    `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `retry-after`, `x-request-id`,
    `request-id`, `traceparent`, `tracestate`, `date`, `content-length`, `transfer-encoding`,
    `connection`, `keep-alive`, `www-authenticate`, `idempotent-replayed`.
  - Body size: a string body counts its UTF-8 byte length (`TextEncoder`), a `Uint8Array` its
    `byteLength`.
  - Status-only (`b: null`, `h: []`) when ANY of: `response: 'status'`; the snapshot is streaming
    (warn once per namespace `'idempotency: a streaming response is recorded without its body'`);
    body > `maxResponseBytes` (warn); serialized record > `store.maxRecordBytes` UTF-8 bytes (warn);
    `redaction` set and the body is not a JSON object under a JSON content type (warn). In
    status-only mode the FINGERPRINT (an unsalted SHA-256 of the request body) is still stored (§10
    D5).
  - Redaction: with `redaction` and `response: 'full'`, a body whose content-type matches
    `/^application\/(?:[\w.+-]+\+)?json\b/i` and that parses to a plain object is `redactRecord`-ed
    and stored as `JSON.stringify(redacted)`.
  - **`decodeHttpRecord(record, resolved): DecodedHttpRecord | IdempotencyRecordError`** — validates
    BEFORE any byte is written to the response:
    - JSON parses; `v === 1`;
    - `s` is an integer 200–499 (the only statuses §3.8 records — stricter than "200–599", because a
      stored 5xx can only be tampering);
    - `h` is an array of `[string, string]` pairs; every name, lower-cased, is on the CURRENT
      allow-list (default plus this route's `replayHeaders`) and NOT on the DENY list; every value
      passes `new Headers().set(name, value)` without throwing and contains no CR/LF;
    - `b` is `null` or `{ data: string, binary?: true }`; the decoded body's byte length ≤ the
      route's current `maxResponseBytes`. Any violation returns an `IdempotencyRecordError`
      (internal class, `name =
    'IdempotencyRecordError'`, message names the failed rule, never
      the content). The middleware logs it at `error` and answers 503; nothing is replayed.
  - Replay: `ctx.response.status(s)`; each header via `ctx.response.header(name, value)`;
    `ctx.response.header('Idempotent-Replayed', 'true')`; return `ctx.response.send(bytes)` (a text
    body UTF-8 encoded) or `ctx.response.send()` when `b` is `null`. The original response is not
    modified.
- **Why:** an allow-list cannot replay an unreviewed header (C5); decoding is a trust boundary when
  a store is shared (§10 D20).
- **Test home:** `test/unit/record.test.ts`, `test/integration/http-kernel.test.ts`.

### 3.11 Scope and store-key derivation

- **Decision:** two hashes per claim, each lower-case hex SHA-256 of length-prefixed segments:
  - HTTP: `key = H(['http', tenantId, principalId, namespace, clientKey])`;
    `scope = H(['http', tenantId, principalId])`. `tenantId = ctx.request.tenant?.id ?? ''`,
    `principalId = ctx.request.user?.id ?? ''`, `namespace = options.namespace ?? \`${method}
    ${path}\``.
  - Ingress: `key = H(['ingress', kind, name, consumer, scopeSegment, clientKey])`;
    `scope = H(['ingress', kind, name, consumer])`; `scopeSegment = options.scope?.(ctx) ?? ''`.
  - **Principal identity is `IPrincipal.id` alone** — `IPrincipal` has no issuer or strategy member
    (`common/src/services/auth.ts:16-25`) and `JwtStrategy` drops `iss` from `claims`
    (`jwt-strategy.ts:115-138`). An application authenticating through more than one issuer or
    strategy MUST ensure principal ids are unique across them (for example prefix them in the
    strategy); otherwise two issuers' identical subjects share a scope. The README and the
    `principal` JSDoc state this obligation.
- **Why:** principal scope prevents cross-user replay (§10 D1); consumer scope prevents cross-
  subscriber skips (§10 D17); hashing keeps ids and keys out of store key names.
- **Test home:** `test/unit/hash.test.ts`, `test/integration/http-kernel.test.ts`,
  `test/integration/messaging-fanout.test.ts`.

### 3.12 Derived key for forwarding

- **Decision:** `IDEMPOTENCY_DERIVED_KEY_STATE_KEY = 'idempotency-plugin:derived-key'` (internal);
  `derivedIdempotencyKey(ctx: IRequestContext): string | undefined` returns the state value when it
  is a string. Stable across retries of the same key by the same principal on the same namespace.
  Not available on ingress (no state bag, §1).
- **Test home:** `test/unit/idempotent.test.ts`, `test/integration/http-kernel.test.ts`.

### 3.13 Defaults and bounds

Shape validation (call time) enforces each row alone; resolution enforces `ttlMs ≥ leaseMs` after
merging defaults. `NaN`, `Infinity`, negatives and non-integers fail every numeric bound.

| Option                      | Default                          | Bound                                            |
| --------------------------- | -------------------------------- | ------------------------------------------------ |
| `leaseMs` (HTTP)            | plugin `leaseMs` → 60,000        | integer 1–86,400,000                             |
| `leaseMs` (ingress)         | plugin `ingressLeaseMs` → 30,000 | integer 1–86,400,000                             |
| `ttlMs`                     | plugin `ttlMs` → 86,400,000      | integer 1–2,592,000,000; resolution: ≥ `leaseMs` |
| `maxResponseBytes`          | plugin → 262,144                 | integer 0–16,777,216                             |
| `namespace` (route)         | `${method} ${path}`              | 1–256 characters, none below U+0020              |
| `key.header`                | `'Idempotency-Key'`              | valid header name                                |
| `key.bodyField`             | —                                | 1–256 characters                                 |
| `topics` / `jobNames`       | — (one required, non-empty)      | each entry 1–512 characters; ≤ 1,000 entries     |
| memory `maxEntries`         | 100,000                          | integer 1–10,000,000                             |
| memory `maxEntriesPerScope` | 1,000                            | integer 1–`maxEntries`                           |
| memory `maxBytes`           | 67,108,864                       | integer 1,024–4,294,967,296                      |
| redis `namespace`           | — (required)                     | `^[a-z0-9][a-z0-9._-]{0,63}$`                    |
| redis `keyPrefix`           | `'setu:idempotency:'`            | 1–64 characters, each `0x21`–`0x7E`              |
| redis `commandTimeoutMs`    | 15,000                           | integer 0–2,147,483,647 (`0` disables)           |
| DO `namespace`              | — (required)                     | `^[a-z0-9][a-z0-9._-]{0,63}$`                    |
| DO `keyPrefix`              | `'idempotency:'`                 | 1–64 characters, each `0x21`–`0x7E`              |
| DO `timeoutMs`              | 5,000                            | integer 0–2,147,483,647 (`0` disables)           |

**Queue retry span vs the ingress lease.** A claim held by a crashed holder blocks redeliveries of
its key until the lease lapses; each redelivery inside the lease is refused `in-progress`, which
consumes a queue attempt. With the queue defaults (3 attempts; backoffs 2,000 ms then 4,000 ms — §1)
the retry span is 6 s, shorter than the 30 s lease, so a crashed holder's job is DEAD-LETTERED
rather than retried. The retry span (the sum of `computeBackoffMs(2..maxAttempts)`) must EXCEED the
lease: with the default backoff and a 30 s lease that means `defaultMaxAttempts ≥ 6` (2+4+8+16+30 =
60 s). The queue's retry configuration is not readable from this plugin (`IQueue` exposes none, §1),
so this is documented — README and PUBLIC_API.md — not checked. Brokers redeliver on their own
schedule; the same rule applies to their redelivery delay × attempts.

### 3.14 Plugin wiring and lifecycle health

- **Decision:** `IdempotencyPlugin(options?: IdempotencyPluginOptions): IPlugin`:
  - `name: 'idempotency-plugin'`, `version` from `deno.json`,
    `provides: [CAPABILITIES.IDEMPOTENCY]`, `priority: PLUGIN_PRIORITY.NORMAL`. Options
    shape-validated in the factory call.
  - Lifecycle state `'pending' | 'connected' | 'closed'`, starting `'pending'`.
  - `register(ctx)`: `store = resolveStore(config, reporter, logger)`;
    `await store.connect(ctx.runtime)`; state → `'connected'`; immediately
    `ctx.lifecycle.onClose(async () => { state = 'closed'; await
    store.disconnect?.(); })`;
    construct
    `IdempotencyService({ store, runtime: ctx.runtime, logger:
    () => ctx.logger, defaults })`;
    register under `CAPABILITIES.IDEMPOTENCY`; register the indicator.
  - Health `idempotency` — lifecycle truth first, for EVERY store arm:
    - state ≠ `'connected'` → `{ status: 'down', data: { store: store.name, state } }`;
    - no `isHealthy` → `{ status: 'up', data: { store: store.name, reachable: 'unknown' } }`;
    - else
      `createCachedProbe({ probe: () => store.isHealthy!.call(store), ttlMs: 5000, timeoutMs:
      2000, ...resolveProbeTiming(ctx.runtime) })`
      → `up`/`down` with `reachable: boolean`.
  - The logger is read at call time through the thunk.
- **Test home:** `test/unit/idempotency-plugin.test.ts`, `test/unit/indicator.test.ts`.

### 3.15 Cloudflare Durable Object store; no D1 store

- **Decision:**
  - `IdempotencyObjectCore` — constructor
    `(state: IIdempotencyObjectState, options?:
    IdempotencyObjectCoreOptions)`; `options.now`
    defaults to `Date.now` (the documented §4.2 deviation, `distributed-lock-object.ts:28-38`,
    restated in the JSDoc). `fetch(request:
    Request): Promise<Response>` routes `POST /claim`,
    `/complete`, `/release`; anything else `404`. `alarm(): Promise<void>`.
  - Exported facade (the published `IDurableObjectStorage` is NOT widened):

```ts
export interface IIdempotencyObjectState {
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(scheduledTimeMs: number): Promise<void>;
  };
}
export interface IdempotencyObjectCoreOptions {
  readonly now?: () => number;
}
```

- One object per store key; one storage entry `'idempotency:record'` =
  `{ s: 'p'|'c', t?: string,
    f: string, l: number, e: number, r?: string }` (`l`, `e` epoch ms).
- Request bodies: `/claim` `{ token: string, fingerprint: string, leaseMs: number, ttlMs: number }`,
  `/complete` `{ token: string, record: string, ttlMs: number }`, `/release` `{ token: string }`.
  Each handler parses and validates its body FIRST (types, integers ≥ 1); invalid → `400` with no
  storage access.
- **Input-gate rule:** after validation, no `await` of anything except `this.#state.storage.*` until
  the response is built.
- **Alarm, precisely:** `setAlarm(e)` is called after the `put` of a NEW claim, of a TAKEOVER, and
  of a COMPLETE — never after `release`. `release` deletes the record and leaves any alarm armed;
  `alarm()` then finds no record and returns (a no-op). `alarm()`: read; absent → return;
  `e <=
    now` → `delete`; else `setAlarm(e)`. A claim treats `e <= now` as absent.
- Responses: `/claim` → `{ outcome, takeover?, record? }`; `/complete`, `/release` →
  `{ result: 'settled' | 'lost' }`. The core never stores capacity state (`capacity-exceeded` is
  memory-only).
- `DurableObjectIdempotencyStore implements IIdempotencyStore` — constructor
  `(namespaceBinding:
    unknown, options: DurableObjectIdempotencyStoreOptions)`:

```ts
export interface DurableObjectIdempotencyStoreOptions {
  /** Required. Isolates this application's records from another sharing the binding. */
  readonly namespace: string;
  /** Default `'idempotency:'`. */
  readonly keyPrefix?: string;
  /** Name used in error messages. Default `'the durable object'`. */
  readonly binding?: string;
  /** Per-call bound in ms. Default 5,000; `0` disables. */
  readonly timeoutMs?: number;
}
```

    Throws `CloudflareBindingMissingError` when `!isDurableObjectNamespace(namespaceBinding)`; options
    validated per §3.13 (`RangeError`/`TypeError` naming the field). `name = 'durable-object'`;
    `maxRecordBytes = 120_000`; `connect(runtime)` stores the runtime for `withDeadline` timing; each
    call targets `idFromName(\`${keyPrefix}${namespace}:${key}\`)` and is bounded by `timeoutMs`
    (timeout → `Error('durable object idempotency store: no answer within <n> ms')`); non-2xx →
    `CloudflareUnsupportedError` naming the binding and `IdempotencyObject`; a 2xx body of the wrong
    shape → `Error('durable object idempotency store: unexpected answer from <path>')`. No
    `isHealthy` (a probe would create and bill an object); no `disconnect`. Calling a member before
    `connect` throws `Error('durable object idempotency store: not connected')` (as a rejection).

- **No D1 store** — it needs an application table and migration; the DO meets the Workers tier-B
  need; D1 is Workers tier C, 109b.
- **Test home:** `packages/cloudflare-plugin/test/unit/durable-objects/idempotency-object.test.ts`,
  `packages/cloudflare-plugin/test/unit/stores/durable-object-idempotency-store.test.ts`.

### 3.16 Memory store (tier A)

- **Decision:** internal `MemoryIdempotencyStore` (`name = 'memory'`, no namespace — process-local):
  - `Map<string, Entry>` plus a per-`scope` key index (`Map<string, Set<string>>`; a scope's count
    is its set's size, and a scope sweep visits only its own keys — audit F2 replaced the original
    live-entry count map, whose sweep scanned the whole store); clock `runtime.hrtime()` from
    `connect`. Every method does ALL reads and writes synchronously and returns
    `Promise.resolve(...)` — no `await` inside (that is the atomicity).
  - Insert path (claim of an absent key): if `scopeCount >= maxEntriesPerScope` → sweep that scope's
    expired entries (bounded by the throttle below), still at cap →
    `{ outcome: 'capacity-exceeded' }`. If `size >= maxEntries` or `bytes >= maxBytes` → sweep (at
    most once per 1,000 ms of `hrtime()`), still full → THROW
    `Error('memory idempotency store is full (maxEntries / maxBytes)')` (→ 503 on HTTP, retry on
    ingress).
  - Accounting `bytes += key.length + fingerprint.length + (record?.length ?? 0)` (string lengths,
    documented approximate); counts and bytes decrement on delete and on lazy expiry.
  - `disconnect` clears every map: the entries, the scope index, the key-to-scope map and the sweep
    throttle rows (audit round 2, N3).
- **Why:** an evicted completed record would silently allow a duplicate; refusing is fail-closed.
  The per-scope cap stops one principal (or one consumer) filling the shared cap (§10 D21); 429
  tells the caller it is their own load.
- **Test home:** `test/unit/memory-store.test.ts` (+ conformance).

### 3.17 Errors (`idempotency-plugin/src/errors.ts`)

```ts
export type IdempotencyRefusalReason =
  | 'in-progress'
  | 'fingerprint-mismatch'
  | 'key-missing'
  | 'key-invalid'
  | 'fingerprint-unavailable'
  | 'consumer-missing'
  | 'unsupported-key-source'
  | 'capacity-exceeded';

export class IdempotencyRefusedError extends Error {
  override readonly name = 'IdempotencyRefusedError';
  readonly reason: IdempotencyRefusalReason;
  readonly ingress: IngressKind;
  /** The topic or job name. */
  readonly target: string;
  constructor(
    reason: IdempotencyRefusalReason,
    ingress: IngressKind,
    target: string,
    message: string,
    options?: { readonly cause?: unknown },
  );
}

export class IdempotencyConfigurationError extends Error {
  override readonly name = 'IdempotencyConfigurationError';
  /** The option path that failed, e.g. `'ttlMs'`, `'key.header'`, `'store.namespace'`. */
  readonly option: string;
  constructor(option: string, message: string);
}
```

Messages never contain a key, a payload, or an option VALUE. `IdempotencyConfigurationError` is
thrown by shape validation, resolution, and the plugin factory (the factory throws it for store
option violations too, replacing the bare `RangeError`/`TypeError` wording used above — the store
classes in `cloudflare-plugin` keep `RangeError`/`TypeError` because they cannot import this class).
The `IntegrationEventRejectedError` precedent (`messaging-plugin/src/errors.ts:177-196`).

### 3.18 Per-store guarantees

| Tier | Store                     | Claim atomicity                                        | Across replicas                                                                                                                  | Atomic with the business write | A process crashes mid-work                                    | Expiry                                      | Clock               |
| ---- | ------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------- | ------------------------------------------- | ------------------- |
| A    | memory                    | Synchronous `Map` read+write in one event-loop turn    | No                                                                                                                               | No                             | Record dies with the process; a restarted process re-executes | Lazy + throttled sweep at capacity          | `runtime.hrtime()`  |
| B    | Redis (Lua)               | One `EVAL`; Redis runs scripts atomically              | Yes — durable only with `maxmemory-policy noeviction` and persistence/replication that keeps acknowledged writes across failover | No                             | Record survives; takeover after `leaseMs`                     | Key `PX` = `ttlMs`; lease inside the record | Redis server `TIME` |
| B    | Cloudflare Durable Object | One object per key; input gate; no non-storage `await` | Yes                                                                                                                              | No                             | Record survives (and eviction); takeover after `leaseMs`      | Alarm at `expiresAt` + lazy check on claim  | DO `now()`          |
| C    | (109b) `within()`         | In the business transaction                            | Yes                                                                                                                              | Yes                            | Rolled back with the work                                     | Backend-specific                            | —                   |

The README carries this table, plus: "Tier A on Cloudflare Workers is per isolate — use the Durable
Object store there"; "the ingress entry point is not available on Workers in this release".

### 3.19 Consumer identity on `IngressContext` (a `common` widening)

- **Decision:**
  - `common/src/services/ingress.ts`: add to `IngressContext`, after `headers?`:

```ts
/**
 * Identity of the CONSUMER this work item was dispatched to, so per-consumer state (an
 * idempotency record) does not collide when one topic has several subscribers.
 * `'messaging'`: the subscription's `SubscribeOptions.queue` when given, otherwise
 * `subscription:<instance>:<n>` — unique per subscription per process.
 * `'queue'`: the job name. ABSENT on `'scheduler'` and `'websocket'`.
 * @since 0.9.0
 */
readonly consumer?: string;
```

    and a paragraph in the interface JSDoc (`:30-46`) stating the member is a dispatch identity, not
    a capability or state bag, so the "no `state`, no `services`" rule stands.

- `common/test/unit/ingress-contract.test.ts:40-59`: `PinnedEnvelope` and the `keyof` pin gain
  `consumer`; the comment records the M109a addition.
- `messaging-plugin/src/pipeline/pipelined-broker.ts`: constructor gains a 5th optional parameter
  `subscriptionIdPrefix: string = 'pipelined'`; a private counter `#subscriptions = 0`. In
  `subscribeWithHeaders`, ONCE per call (before building `dispatch`):
  `const consumer = options?.queue ?? \`subscription:${this.#subscriptionIdPrefix}:${++this.#subscriptions}\`;`and the envelope (`:188-193`) gains`consumer`.`messaging-plugin.ts:461-469`passes`ctx.runtime.uuid()`as the 5th argument in both constructions (the first gains`undefined,
  undefined` for the two optional middle arguments).
- `queue-plugin/src/processors/job-processor.ts:316-327`: the envelope gains `consumer: job.name`.
- Brokers: every broker's subscriptions pass through `PipelinedBroker.subscribeWithHeaders`
  (`pipelined-broker.ts:159-165`), so all seven `messaging-plugin` brokers get a consumer from the
  same line — no broker change. A queue-less subscription's id is per process: on a broker whose
  queue-less default is a SHARED group (competing consumers across replicas), a redelivery to
  another replica carries another consumer id and is not de-duplicated. README: "on a listed topic,
  pass `queue` to `subscribe` for competing-consumer subscriptions".
- **Breaking for implementors:** none — an OPTIONAL member on a type the framework PRODUCES; an
  out-of-repo producer that omits it still type-checks, and a consumer reading it must already
  handle `undefined`. Verified against the member-set pin, which is the one site that changes.
- **Why:** B1, confirmed by probe (§1).
- **Test home:** `common/test/unit/ingress-contract.test.ts`,
  `messaging-plugin/test/unit/pipelined-broker.test.ts` (new cases),
  `queue-plugin/test/integration/queue-behaviors.test.ts` (new case),
  `idempotency-plugin/test/integration/messaging-fanout.test.ts`.

### 3.20 Canonical JSON (`core/fingerprint.ts`)

- **Decision:** `canonicalJson(value: unknown): string` is a hand-written walker, NOT a
  `JSON.stringify` replacer:
  - top-level `undefined` → `''` (fingerprints as the empty body);
  - `null`, booleans, strings → `JSON.stringify(value)`; finite numbers → `JSON.stringify`;
    non-finite numbers → `'null'` (JSON semantics);
  - `Date` → `JSON.stringify(value.toISOString())`; an invalid Date → refuse;
  - arrays → `[` elements `,`-joined `]`, an `undefined` element → `null`;
  - plain objects (prototype `Object.prototype` or `null`) → keys sorted by code unit, entries with
    `undefined` values skipped, `{"k":v,...}`;
  - anything else at ANY depth — `Map`, `Set`, functions, symbols, bigint, class instances, typed
    arrays — → throw `CanonicalJsonError` (internal, `name = 'CanonicalJsonError'`, message names
    the type found and the path, e.g. `'$.items[2]: Map is not canonicalisable'`, never the value);
  - cycles detected with an ancestor `Set` → throw `CanonicalJsonError('$.<path>: cycle')`; depth >
    64 → throw `CanonicalJsonError('$.<path>: deeper than 64')`. HTTP never calls it (it
    fingerprints raw bytes); the ingress behaviour maps a `CanonicalJsonError` to
    `IdempotencyRefusedError('fingerprint-unavailable')`.
- **Why:** the reviewer's `canon.ts` — a replacer serialises `Map` as `{}` (collisions) and dies on
  a cycle with `RangeError`. (The reviewer asked for "the same named 400 error" on a cycle; no 400
  can arise because HTTP fingerprints raw bytes — on ingress the named error is the refusal above.)
- **Test home:** `test/unit/fingerprint.test.ts`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Every addition is a new interface, type, token or class, plus
one OPTIONAL member on `IngressContext` (§3.19), a type the framework produces. No published
interface gains a required member. `DecoratorPlugin.optionalDependencies` gains one token (ordering
only); `RouteMetadata` gains an optional `idempotent?`; `PipelinedBroker` (internal, not exported)
gains an optional constructor parameter.

`@setu-ts/common`:

| Exported symbol                       | Kind         | Consumer / real code path that READS it                                                            |
| ------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.IDEMPOTENCY`            | token member | `IdempotencyPlugin` registers; `idempotent()`, `idempotentIngress()`, `DecoratorPlugin` resolve    |
| `IngressContext.consumer`             | member       | Written by `PipelinedBroker` and `withIngressBehaviors`; read by the idempotency behaviour         |
| `IIdempotencyStore`                   | interface    | Memory/Redis stores, `DurableObjectIdempotencyStore`; read by `IdempotencyService`                 |
| `IdempotencyClaimRequest`             | type         | `IIdempotencyStore.claim` parameter                                                                |
| `IdempotencyClaimResult`              | type         | Switched on by the middleware and behaviour                                                        |
| `IdempotencySettleResult`             | type         | `complete`/`release` results; `'lost'` → warn                                                      |
| `IIdempotencyService`                 | interface    | `IdempotencyService`; called by `DecoratorPlugin`, `idempotent()`, `idempotentIngress()`           |
| `IdempotentRouteOptions`              | type         | `@Idempotent`, `idempotent`, `IIdempotencyService.middleware`                                      |
| `IdempotencyKeySource`                | type         | `IdempotentRouteOptions.key`                                                                       |
| `IdempotencyFingerprintSource`        | type         | `IdempotentRouteOptions.fingerprint`                                                               |
| `IdempotentIngressOptions`            | type         | `idempotentIngress`, `IIdempotencyService.behavior`                                                |
| `IngressIdempotencyKeySource`         | type         | `IdempotentIngressOptions.key`                                                                     |
| `IngressIdempotencyFingerprintSource` | type         | `IdempotentIngressOptions.fingerprint`                                                             |
| `IdempotentIngressCommonOptions`      | interface    | The shared half of `IdempotentIngressOptions`; exported so the union has no private type reference |

`@setu-ts/idempotency-plugin`:

| Exported symbol                 | Kind     | Consumer / real code path that READS it                               |
| ------------------------------- | -------- | --------------------------------------------------------------------- |
| `IdempotencyPlugin`             | factory  | Application composition root                                          |
| `IdempotencyPluginOptions`      | type     | `IdempotencyPlugin` parameter                                         |
| `IdempotencyStoreConfig`        | type     | `IdempotencyPluginOptions.store`                                      |
| `IRedisIdempotencyClient`       | type     | Redis injected arm `client`                                           |
| `idempotent`                    | function | Functional route `middleware` arrays                                  |
| `idempotentIngress`             | function | `QueuePlugin({ behaviors })`, `MessagingPlugin({ behaviors })`        |
| `derivedIdempotencyKey`         | function | Handlers forwarding a key to a provider                               |
| `IdempotencyRefusedError`       | class    | Thrown by the behaviour; consumers' `onFailed`/logs `instanceof`      |
| `IdempotencyRefusalReason`      | type     | `IdempotencyRefusedError.reason`                                      |
| `IdempotencyConfigurationError` | class    | Thrown by option validation; consumers' startup handling `instanceof` |
| `IDEMPOTENCY_KEY_HEADER`        | const    | `'Idempotency-Key'`; default key source; clients                      |
| `IDEMPOTENT_REPLAYED_HEADER`    | const    | `'Idempotent-Replayed'`; written on replay; clients                   |

`@setu-ts/decorator-plugin`: `Idempotent` — consumer: decorated controllers; read by
`registerController`.

`@setu-ts/cloudflare-plugin`: `DurableObjectIdempotencyStore` (consumer:
`IdempotencyPlugin({ store:
{ type: 'custom', store } })` in a Worker),
`DurableObjectIdempotencyStoreOptions`, `IdempotencyObjectCore` (consumer: the application's
exported DO class), `IdempotencyObjectCoreOptions`, `IIdempotencyObjectState` (the core's
constructor parameter type).

NOT exported: the memory and Redis store classes, `IdempotencyService`, the Lua scripts,
`canonicalJson`, `CanonicalJsonError`, `IdempotencyRecordError`, `parseKeyValue`, the derived-key
state-key constant, `createRedisIdempotencyClient`.

### 4.1 Options — every option names its consumer

`IdempotencyPluginOptions` (in `src/interfaces/index.ts`):

```ts
export type IdempotencyStoreConfig =
  | {
    readonly type: 'memory';
    readonly maxEntries?: number;
    readonly maxEntriesPerScope?: number;
    readonly maxBytes?: number;
  }
  | {
    readonly type: 'redis';
    readonly namespace: string;
    readonly url: string;
    readonly client?: never;
    readonly commandTimeoutMs?: number;
    readonly keyPrefix?: string;
  }
  | {
    readonly type: 'redis';
    readonly namespace: string;
    readonly client: IRedisIdempotencyClient;
    readonly url?: never;
    readonly keyPrefix?: string;
  }
  | { readonly type: 'custom'; readonly store: IIdempotencyStore };

export interface IdempotencyPluginOptions {
  /** Default `{ type: 'memory' }`. */
  readonly store?: IdempotencyStoreConfig;
  /** Default HTTP lease. Default 60,000. */
  readonly leaseMs?: number;
  /** Default ingress lease. Default 30,000. */
  readonly ingressLeaseMs?: number;
  /** Default retention. Default 86,400,000. */
  readonly ttlMs?: number;
  /** Default HTTP body cap. Default 262,144. */
  readonly maxResponseBytes?: number;
}
```

| Option             | Consumer                        | Behavior                                                 |
| ------------------ | ------------------------------- | -------------------------------------------------------- |
| `store`            | `resolveStore` in `register()`  | §3.5, §3.15, §3.16; `custom` passes the instance through |
| `leaseMs`          | `resolveRouteOptions` default   | HTTP lease                                               |
| `ingressLeaseMs`   | `resolveIngressOptions` default | Ingress lease                                            |
| `ttlMs`            | both resolvers                  | Retention                                                |
| `maxResponseBytes` | `resolveRouteOptions` default   | Body cap                                                 |

Route and ingress options: §3.2 (each field's default stated there); every field is read by
`resolveRouteOptions`/`resolveIngressOptions` and then by the middleware or behaviour.

## 5. Implementation files

`packages/common`:

| File                          | Purpose                                                                |
| ----------------------------- | ---------------------------------------------------------------------- |
| `src/services/idempotency.ts` | §3.2 declarations                                                      |
| `src/services/ingress.ts`     | `IngressContext.consumer?` (§3.19)                                     |
| `src/tokens.ts`               | `IDEMPOTENCY: 'idempotency'` with JSDoc, after `LOCALIZATION` (`:268`) |
| `src/index.ts`                | Re-export the §4 common types                                          |

`packages/idempotency-plugin` (new; `deno.json`: `name`, `version` = the workspace version (`0.8.0`
today), `license: "MIT"`, `exports: "./src/index.ts"`,
`imports: { "@setu-ts/common":
"jsr:@setu-ts/common@^<same>" }`, test permissions `read: true`,
`import: true`, `env: true`, `sys: ["hostname"]`, `net: ["127.0.0.1:6379", "localhost:6379"]`):

| File                                 | Purpose                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                       | `@module`-FIRST module JSDoc (release-verify check 5); barrel exactly §4                                                                                                                                                                                                                      |
| `src/constants.ts`                   | Header names, defaults, bounds, ALLOW/DENY sets, `RELEASE_STATUSES = [408, 425, 429]`, derived-key state key                                                                                                                                                                                  |
| `src/errors.ts`                      | §3.17                                                                                                                                                                                                                                                                                         |
| `src/interfaces/index.ts`            | `IdempotencyPluginOptions`, `IdempotencyStoreConfig`, `IRedisIdempotencyClient`                                                                                                                                                                                                               |
| `src/core/hash.ts`                   | `lengthPrefixed(segments: readonly string[]): Uint8Array`; `sha256Hex(subtle: SubtleCrypto, ...parts: Uint8Array[]): Promise<string>`; `deriveHash(subtle, segments): Promise<string>`                                                                                                        |
| `src/core/key.ts`                    | `parseKeyValue(raw: string): string \| undefined`                                                                                                                                                                                                                                             |
| `src/core/fingerprint.ts`            | `requestFingerprint(subtle, ctx, source): Promise<string>`; `canonicalJson`; `CanonicalJsonError`; `payloadFingerprint(subtle, ctx, source): Promise<string>`                                                                                                                                 |
| `src/core/options.ts`                | `validateRouteOptionShape`, `validateIngressOptionShape`, `validatePluginOptionShape`, `resolveRouteOptions`, `resolveIngressOptions`                                                                                                                                                         |
| `src/core/record.ts`                 | `encodeHttpRecord(snapshot, resolved, maxRecordBytes): { record: string; omitted?: 'response-mode' \| 'stream' \| 'size' \| 'store-limit' \| 'redaction' }`; `decodeHttpRecord`; `IdempotencyRecordError`; `replay(ctx, decoded): HandlerResult`                                              |
| `src/middleware/http-middleware.ts`  | `createHttpMiddleware(deps: ServiceDeps, resolved: ResolvedRouteOptions): MiddlewareFunction` — §3.6, §3.8, §3.10, §3.12                                                                                                                                                                      |
| `src/middleware/idempotent.ts`       | `idempotent(options?: IdempotentRouteOptions): MiddlewareFunction`; `derivedIdempotencyKey(ctx: IRequestContext): string \| undefined`                                                                                                                                                        |
| `src/ingress/ingress-behavior.ts`    | `createIngressBehavior(deps, resolved): IIngressBehavior` — §3.7                                                                                                                                                                                                                              |
| `src/ingress/idempotent-ingress.ts`  | `idempotentIngress(options: IdempotentIngressOptions): RegistryFactory<IIngressBehavior>`; shape-validated at the call; the factory body is `(services) => services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY).behavior(options)` (resolution errors fail the host plugin's `onInit`) |
| `src/service/idempotency-service.ts` | `IdempotencyService implements IIdempotencyService`; `ServiceDeps = { store, runtime, logger: () => ILogger \| undefined, defaults }`                                                                                                                                                         |
| `src/stores/memory-store.ts`         | §3.16                                                                                                                                                                                                                                                                                         |
| `src/stores/redis-scripts.ts`        | `CLAIM_SCRIPT`, `COMPLETE_SCRIPT`, `RELEASE_SCRIPT` exactly as §3.5                                                                                                                                                                                                                           |
| `src/stores/redis-client.ts`         | `loadIoredis()`, `createRedisIdempotencyClient(RedisCtor, url, commandTimeoutMs): IBuiltRedisIdempotencyClient`, `validateInjectedClient`                                                                                                                                                     |
| `src/stores/redis-store.ts`          | `RedisIdempotencyStore`, `parseClaimReply`, `parseSettleReply`, the eviction-policy check                                                                                                                                                                                                     |
| `src/stores/resolve-store.ts`        | `resolveStore(config, reporter, logger): IIdempotencyStore`                                                                                                                                                                                                                                   |
| `src/health/indicator.ts`            | `createIdempotencyIndicator(store, runtime, lifecycle: () => 'pending' \| 'connected' \| 'closed')`                                                                                                                                                                                           |
| `src/plugin/idempotency-plugin.ts`   | §3.14                                                                                                                                                                                                                                                                                         |
| `README.md`                          | §9                                                                                                                                                                                                                                                                                            |

`packages/decorator-plugin`: `src/decorators/idempotency.ts` (new, `Idempotent`);
`src/metadata/metadata-store.ts` (`idempotent?` on `RouteMetadata` and `MethodMeta`, conditional
spread at `:780-797`); `src/plugin/decorator-plugin.ts` (resolution, `appendIdempotencyMiddleware`,
`optionalDependencies`); `src/index.ts`; `README.md`.

`packages/cloudflare-plugin`: `src/durable-objects/idempotency-object.ts` (new);
`src/stores/durable-object-idempotency-store.ts` (new); `src/index.ts`; `README.md` (store section
with the wrangler `durable_objects` stanza and an exported DO class delegating `fetch` and `alarm`).

`packages/messaging-plugin`: `src/pipeline/pipelined-broker.ts`, `src/plugin/messaging-plugin.ts`
(§3.19); `README.md` (behaviours section: `consumer`, and pass `queue` for competing consumers).

`packages/queue-plugin`: `src/processors/job-processor.ts` (§3.19); `README.md` (behaviours section:
`consumer`; the retry-span rule of §3.13).

Repository: root `deno.json` workspace entry (after `./packages/diagnostics-plugin`);
`scripts/release-packages.ts` (Tier 4, after `http-security-plugin`);
`packages/cli/src/utils/plugin-claims.ts` (`['idempotency-plugin', ['idempotency']]`);
`docs/health-indicators.md` (row `idempotency`, classification `live-state` — lifecycle state plus a
store probe); `docs/plugins.md` (catalog section; runtimes Deno/Node/Bun ✅, Workers ✅ for HTTP
with the Durable Object store); root `README.md` (row, counts); `ARCHITECTURE.md` (node,
`common -->
idempotency` edge, responsibility row); `PUBLIC_API.md` (Idempotency section; `common`
rows incl. `IngressContext.consumer`; decorator-plugin and cloudflare-plugin rows; the §3.13
retry-span rule); `CHANGELOG.md` (`Unreleased` → `Added`, one entry per package; note that the first
publish needs `release:create-packages` and `release:link-repos`); `ROADMAP.md` (§2 corrections,
Progress row `109a`); `test/apps-gate.test.ts` (`'idempotency-plugin'` in `redisPackages`, `:385`).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

`describe`/`it` + `expect` only. Real-backend tests use `{ ignore: REDIS_URL === undefined }`, never
an early `return`.

`packages/common`:

| Test file                                        | src covered                            | Key assertions                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/idempotency-contract.test.ts`         | `services/idempotency.ts`, `tokens.ts` | Token value + grammar; a minimal literal type-checks as `IIdempotencyStore`; `@ts-expect-error`: `claimed` without `takeover`; `IdempotentIngressOptions` with neither `topics` nor `jobNames`; a `ttlMs` string                                                                                                                                                                                                                          |
| `test/unit/ingress-contract.test.ts` (update)    | `services/ingress.ts`                  | Member-set and `keyof` pins include `consumer`                                                                                                                                                                                                                                                                                                                                                                                            |
| `test/unit/barrel-exports.test.ts` (extend)      | `index.ts`                             | Each §4 common type importable from the barrel                                                                                                                                                                                                                                                                                                                                                                                            |
| `test/fixtures/idempotency-store-conformance.ts` | (fixture)                              | `runIdempotencyStoreConformance(label: string, setup: { make(): Promise<IIdempotencyStore>; advance(ms: number): Promise<void>; runtime: IRuntimeServices; ignore?: boolean })` — every `it` receives `ignore: setup.ignore ?? false`. One `it` per §3.3 row (capacity rows only when `label === 'memory'`), "50 concurrent claims → exactly one `claimed`", multi-byte UTF-8 record verbatim, "`complete` restarts retention at `ttlMs`" |

`packages/idempotency-plugin` (`test/fixtures/clock-runtime.ts`: an object literal implementing
`uuid`, `subtle`, `now`, `hrtime`, `setTimeout`, `clearTimeout` with `advance(ms)`; never spread a
class):

| Test file                                                                 | src covered                                                                                                                                                                   | Key assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/hash.test.ts`                                                  | `core/hash.ts`                                                                                                                                                                | SHA-256 vector; `['a:b','c']` ≠ `['a','b:c']`; 64 hex                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/unit/key.test.ts`                                                   | `core/key.ts`                                                                                                                                                                 | Bare and sf-quoted accepted; 255/256; space, `"`, `0x7F`, non-ASCII, `""` refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/unit/fingerprint.test.ts`                                           | `core/fingerprint.ts`                                                                                                                                                         | Request fingerprint differs by method, path, raw query, content-type, one byte; `?a=1&b=2` ≠ `?b=2&a=1`; `canonicalJson` key-order independent; `Map`, `Set`, function, symbol, bigint, class instance at depth 3 → `CanonicalJsonError` naming the path; cycle → `CanonicalJsonError` (NOT `RangeError`); depth 65 refused; top-level `undefined` → `''`; queue fingerprint ignores `attempts`                                                                                                                                                                                                                                                                                 |
| `test/unit/options.test.ts`                                               | `core/options.ts`                                                                                                                                                             | Every §3.13 row at limit and limit+1; `NaN`/`Infinity`/`1.5`; shape validation does NOT check `ttlMs ≥ leaseMs`, resolution does; DENY header (incl. `content-language`) refused; `IdempotencyConfigurationError.option` names the field; message omits the value; ingress with empty `topics` and no `jobNames` refused                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/record.test.ts`                                                | `core/record.ts`                                                                                                                                                              | Round-trip string and binary; ALLOW/DENY applied; status-only for each `omitted` reason; byte counting (a 4-byte emoji string counts 4); redaction; `decodeHttpRecord` rejects: non-JSON, `v ≠ 1`, `s` 199/500/`201.5`, a DENY header, a header no longer allowed, a CR/LF value, an over-cap body — each returns `IdempotencyRecordError`                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/memory-store.test.ts`                                          | `stores/memory-store.ts`                                                                                                                                                      | Conformance; per-scope cap → `capacity-exceeded` while another scope still claims; global cap → throws; sweep throttled to once per 1,000 ms; lazy expiry decrements counts; `disconnect` clears                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `test/unit/redis-client.test.ts`                                          | `stores/redis-client.ts`                                                                                                                                                      | `createRedisIdempotencyClient` passes `{ lazyConnect: true, commandTimeout: 15000 }`, omits `commandTimeout` at `0` (recording constructor); `validateInjectedClient` accepts the four-method shape, refuses a missing `call` with `IdempotencyConfigurationError` (`option === 'store.client'`)                                                                                                                                                                                                                                                                                                                                                                                |
| `test/unit/redis-store.test.ts`                                           | `stores/redis-store.ts`, `stores/redis-scripts.ts`, `stores/resolve-store.ts`                                                                                                 | Recording fake: scripts with `numkeys 1`, key `setu:idempotency:<ns>:<hex>`, ARGV order; reply parsing incl. malformed; eviction check: fake `call` returns `['maxmemory-policy','allkeys-lru']` → one `warn` naming `allkeys-lru`; returns `['maxmemory-policy','noeviction']` → no log; rejects `ERR unknown command 'CONFIG'` → no log and `connect` resolves; injected client: no `connect`, no `quit`, no listener; built: `connect`, reporter attached, `quit` on `disconnect`; `isHealthy`                                                                                                                                                                               |
| `test/types/redis-client-seam.assert.ts`                                  | (compile-time)                                                                                                                                                                | `import type { Redis } from 'npm:ioredis@5.x'; declare const redis: Redis; export const client: IRedisIdempotencyClient = redis;` — no cast; never executed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/unit/http-middleware.test.ts`                                       | `middleware/http-middleware.ts`                                                                                                                                               | One `it` per §3.6 step, each asserting the store saw NO call when it should not: GET passes; missing + `required:false` passes BEFORE the principal check (no user, still passes); no user → 401; missing + required → 400; invalid → 400; `bodyField` with malformed JSON → `MalformedRequestBodyError` propagates; `key()` throwing → propagates; `bytes()` throwing a 413 error → propagates; every claim outcome's status/title/detail and that the key text is absent from the body; release-on-throw rethrows the ORIGINAL even when `release` rejects; `complete` rejection logged not thrown; 408/425/429/5xx/1xx release; 4xx recorded; tampered record → 503 + logged |
| `test/unit/idempotent.test.ts`                                            | `middleware/idempotent.ts`                                                                                                                                                    | Shape error at call; no provider → `IdempotencyConfigurationError`; resolution error (`ttlMs < leaseMs` via plugin defaults) thrown on first request, logged ONCE across three requests, rethrown each time; the built middleware is built once per service (spy); TWO `idempotent()` calls with different `namespace`/`ttlMs` on two routes: the recording store sees each call's own `ttlMs` and distinct keys (the WeakMap is per call); `derivedIdempotencyKey`                                                                                                                                                                                                             |
| `test/unit/ingress-behavior.test.ts`                                      | `ingress/ingress-behavior.ts`                                                                                                                                                 | Unlisted topic/job, `scheduler`, `websocket` → `next` called, NO store call; listed without `consumer` → `consumer-missing`; key defaults; `unsupported-key-source`; missing/invalid key; `fingerprint-unavailable` with `cause`; each claim outcome; failure releases and rethrows ORIGINAL; success completes with `''`; `lost` and rejections logged, not thrown; `consumer` and `scope` change the key                                                                                                                                                                                                                                                                      |
| `test/unit/idempotent-ingress.test.ts`                                    | `ingress/idempotent-ingress.ts`                                                                                                                                               | Returns a factory; shape error at call; resolves the service; resolution error surfaces from the factory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/idempotency-service.test.ts`                                   | `service/idempotency-service.ts`                                                                                                                                              | Defaults applied; overrides win; ingress default lease 30,000                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/unit/indicator.test.ts`                                             | `health/indicator.ts`                                                                                                                                                         | `pending` → down; `closed` → down (memory arm and a probe-less custom arm); no probe → `up`/`unknown`; probe true/false/timeout; probe invoked on its owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/unit/idempotency-plugin.test.ts`                                    | `plugin/idempotency-plugin.ts`, `constants.ts`                                                                                                                                | Factory validation; `provides`; service + indicator registered; health down after `app.stop()`; close hook registered right after `connect` (a store whose indicator registration throws still gets `disconnect`)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/unit/errors.test.ts`                                                | `errors.ts`                                                                                                                                                                   | Both classes: `name`, fields, `cause`, `instanceof Error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/unit/barrel-exports.test.ts`                                        | `index.ts`                                                                                                                                                                    | Exactly §4; internals absent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/unit/no-exactly-once.test.ts`                                       | (docs)                                                                                                                                                                        | README, `src/**`, and the PUBLIC_API.md Idempotency section contain no case-insensitive "exactly once"/"exactly-once"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/integration/http-kernel.test.ts`                                    | end to end (`createApplication` + `RuntimePlugin`)                                                                                                                            | Replay with `Idempotent-Replayed: true` via `app.fetch`, handler once; concurrent → one 201 + one 409; 422; cross-user and cross-tenant both execute; 401; thrown `HttpError(400)` re-executes; returned 400 replays; returned 503 re-executes; `Set-Cookie`/`RateLimit-*`/`Content-Language` absent on replay; streaming → status-only; over cap → status-only; `derivedIdempotencyKey` stable per principal; rejecting store → 503, handler not run; memory per-scope cap → 429 for that principal while another principal still succeeds; `errorHandler({ format: 'rfc9457' })` bodies are Problem Details                                                                   |
| `test/integration/decorator.test.ts`                                      | `@Idempotent` + `DecoratorPlugin` + `ValidationPlugin` + a guard                                                                                                              | Invalid body → 400, corrected retry with the SAME key executes; guard 401 consumes no key; duplicate replayed; idempotency middleware LAST                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/integration/messaging-fanout.test.ts`                               | `MessagingPlugin` (in-memory) + `behaviors: [idempotentIngress({ topics: ['order.placed.v1'] })]` + `IdempotencyPlugin()` on a real kernel (the reviewer's `fanout.ts` shape) | Two subscribers (`queue: 'billing'`, `queue: 'shipping'`) on the listed topic each run ONCE for `deduplicationId: 'evt-1'`; publishing `evt-1` again runs NEITHER; a third subscriber with no `queue` also runs once; an unlisted topic `backplane` published WITHOUT a dedup id runs its handler every time; a header-less publish on the LISTED topic is refused and its handler does not run                                                                                                                                                                                                                                                                                 |
| `test/integration/queue-ingress.test.ts`                                  | `QueuePlugin` (memory) + `behaviors: [idempotentIngress({ jobNames: [...] })]`                                                                                                | Failing attempt 1 → released → attempt 2 runs; two jobs with the same `headers['x-order']` and `key: (ctx) => ctx.headers?.['x-order']`, `concurrency: 1` → processor body once; an unlisted job name runs every time                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/integration/messaging-ingress.test.ts`                              | `MessagingPlugin` (in-memory)                                                                                                                                                 | `publishIntegrationEvent` twice with one envelope → handler once; `publish` twice with the same `deduplicationId` → once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/integration/crash-redelivery.test.ts`                               | behaviour + memory store + clock runtime                                                                                                                                      | Holder A claims and its `next` never settles (crashed before its side effect); a redelivery INSIDE the lease → `in-progress` refusal; `advance(30_001)`; redelivery → `claimed` with `takeover: true` (warn logged) → handler runs; side-effect counter = 1; holder A's late `complete` → `lost`                                                                                                                                                                                                                                                                                                                                                                                |
| `test/integration/redis-real.test.ts` (`ignore: REDIS_URL === undefined`) | Redis store on real Redis 7                                                                                                                                                   | Conformance (`ignore` passed through; real sleeps; leases ≥ 50 ms); 50 parallel claims → 1; two kernel apps sharing Redis and namespace `'shop'`: duplicate to app B replays app A's response; two apps with namespaces `'shop'` and `'billing'` and the same client key BOTH execute; PTTL ≈ `ttlMs`; `connect` logs nothing under `noeviction` (the CI default — the test asserts the policy first and does not change it)                                                                                                                                                                                                                                                    |

`packages/decorator-plugin`:

| Test file                                          | src covered                                               | Key assertions                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/idempotent-decorator.test.ts`           | `decorators/idempotency.ts`, `metadata/metadata-store.ts` | Metadata recorded; `{}` default; every binding; topmost wins                                                                                                                                                                                                                                                              |
| `test/integration/idempotent-registration.test.ts` | `plugin/decorator-plugin.ts`                              | Fake `IIdempotencyService` (via `createMockPlugin`): its middleware is LAST, after a `@ValidateBody` middleware; `enforceSchemas: false` still appends; no provider → named throw; `@Get` → safe-method throw; a service whose `middleware` throws `Error('bad')` fails `register()`; `optionalDependencies` in both arms |
| `test/unit/barrel-exports.test.ts` (extend)        | `index.ts`                                                | `Idempotent`                                                                                                                                                                                                                                                                                                              |

`packages/cloudflare-plugin` (`test/do-fakes.ts`: `FakeDurableObjectStorage` gains
`alarmAt: number |
null` and `setAlarm(ms)` recording calls; `FakeDurableObjectNamespace` gains kind
`'idempotency'` constructing `IdempotencyObjectCore` with `{ now: () => this.now() }` through the
SAME per-object gate):

| Test file                                                   | src covered                                  | Key assertions                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/durable-objects/idempotency-object.test.ts`      | `durable-objects/idempotency-object.ts`      | Every §3.3 row (non-capacity); malformed body → 400 with no storage call; 404; `setAlarm` called after new claim, takeover and complete and NOT after release; `alarm()` with no record → no-op; deletes an expired record; re-arms an unexpired one; expired record treated as absent                |
| `test/unit/stores/durable-object-idempotency-store.test.ts` | `stores/durable-object-idempotency-store.ts` | Conformance through the gated fake; 50 concurrent → 1; missing `namespace` refused; non-namespace binding → `CloudflareBindingMissingError`; non-2xx → `CloudflareUnsupportedError`; wrong shape → named error; timeout; before `connect` → rejection; `idFromName` received `idempotency:<ns>:<hex>` |
| `test/unit/barrel-exports.test.ts` (extend)                 | `index.ts`                                   | §4 cloudflare symbols                                                                                                                                                                                                                                                                                 |

`packages/messaging-plugin`: `test/unit/pipelined-broker.test.ts` gains: `consumer` equals `queue`
when given; two queue-less subscriptions get two different `consumer` values sharing the prefix; the
prefix passed by `MessagingPlugin` differs between two app instances.

`packages/queue-plugin`: `test/integration/queue-behaviors.test.ts` gains: every envelope carries
`consumer === job.name`.

Root: `test/apps-gate.test.ts` — `redisPackages` includes `'idempotency-plugin'`.

**Negative controls** (each run once at verification, observed failing, reverted; recorded in the
PR):

1. Drop `principalId` from the HTTP key segments → the cross-user test fails.
2. Drop `consumer` from the ingress key segments → the fan-out test fails (one subscriber skipped).
3. Remove the allow-list check → the unlisted-topic and backplane cases fail.
4. Remove the fingerprint comparison from the memory store → the 422 conformance case fails.
5. Replace the Redis CLAIM `EVAL` with a client-side `GET` then `SET` → the real 50-claim test
   reports more than one `claimed`.
6. Remove the per-object gate for kind `'idempotency'` in the fake → the DO 50-claim test fails.
7. Remove the token comparison from COMPLETE → the "old token after takeover → `lost`" case fails.
8. Append the idempotency middleware BEFORE validation → the "invalid body consumes no key" test
   fails.
9. Replace the ALLOW list with "store every header" → the `Set-Cookie` replay test fails.
10. Make the ingress behaviour swallow a handler failure → the queue retry test fails.
11. Hoist the `idempotent()` WeakMap to module scope keyed only by service → the two-routes test
    fails.
12. Use a `JSON.stringify` replacer for `canonicalJson` → the `Map` and cycle cases fail.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m109a-idempotency-core, never develop or main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # on the COMMITTED tree
deno task release:verify 0.8.0   # the workspace version at the time; 51 publishable packages (50 today + this one)
```

Also, against a live `redis:7` (`REDIS_URL=redis://localhost:6379`): the guarded suite runs, ignored
count zero. Grep `packages/idempotency-plugin/src` for
`new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__\|crypto.randomUUID` —
empty except `client.eval(` (the ioredis method, stated in the PR). In `cloudflare-plugin`,
`Date.now` appears only as the documented default of `IdempotencyObjectCore`'s `now` seam. A workerd
drive of the Durable Object store via `wrangler dev` is a verification step in `.verify-109a/`, not
a committed gate (the M52d precedent).

## 8. Risks & mitigations

- A lease shorter than the work → a retry takes over and runs it again: defaults 60 s (HTTP) and 30
  s (ingress); takeover and `lost` are logged; README: "lease > longest work"; no renewal.
- A lease LONGER than the queue's retry span → a crashed holder's job is dead-lettered, not retried
  (§3.13: defaults give a 6 s span against a 30 s lease). Not checkable from this plugin; README and
  PUBLIC_API.md state the rule and the `defaultMaxAttempts ≥ 6` recommendation. (Revision 1 claimed
  the 300 s default was safe; it was not.)
- Whether a shipped queue adapter can deliver the SAME job id twice while it is in flight was NOT
  verified; the behaviour is correct in both cases (`in-progress` → retry), only the attempt cost
  differs.
- Redis eviction or async failover silently drops completed records → the connect-time policy
  warning, the §3.18 row, README, §10 D18.
- A queue-less subscription on a broker whose default is a shared group is not de-duplicated across
  replicas → README tells listed-topic subscribers to pass `queue`.
- `redis-client-seam.assert.ts` depends on ioredis's types → intended (the M95c lesson).
- A custom `IRequest` that does not memoize `bytes()` would starve the handler → JSDoc of
  `idempotent()`; all first-party producers memoize (§1).
- The DO fake stands in for workerd → it reproduces the input gate; a workerd drive at verification.

## 9. Out of scope

- Tier C, the SDK option, SDK POST/PATCH retry — 109b. A D1 store — 109b (tier C).
- Ingress on Cloudflare Workers; lease renewal; erase-by-principal; OpenAPI header docs — unowned.
- Business uniqueness (unique constraint, `DuplicateKeyError`) and scheduled ticks (M70l slot locks)
  — the README "What this is not" section names both.
- The README must also contain: the three guarantees from §0 (only the first delivered); the §3.18
  table, the Redis durability caveat and the Redis ≥ 5 floor; placement ("`idempotent()` goes LAST,
  after guards and validation"); the §3.6 check order; failure classification (§3.8, §3.7); replay
  rules (§3.10, incl. query order); the ingress allow-list, consumer identity, `queue` for competing
  consumers, the missing-key refusal and what happens to it on a queue vs a broker; the retry-span
  rule (§3.13); the principal-id uniqueness obligation (§3.11); retention and personal data (§10
  D5); multi-replica deployments need Redis or the Durable Object store with a per-application
  `namespace`; a `derivedIdempotencyKey` forwarding example; the IETF draft cited as draft-07,
  expired.

## 10. Design security review (recorded before implementation)

Recorded 2026-10-08 before any implementation; revised the same day after an independent review
(rows D17–D21 and obligations 12–16 added). Nothing below is reverse-engineered from code.

**Flows reviewed.** (F1) An HTTP request on an idempotent route: client key, principal, tenant, raw
body → store key, capacity scope and fingerprint → claim → handler → stored response → replay. (F2)
A queue job or broker message on a listed topic or job: consumer identity, key, payload → claim →
handler → release or completion. (F3) The store boundary: the in-process map, Redis (network,
possibly shared with other applications), a Durable Object over a service binding. (F4) Logs and
error bodies.

**Assets.** Idempotent responses (may carry personal data and secrets); isolation between
principals, tenants, consumers and applications; the guarantee itself; store capacity; log
integrity.

**Attackers.** (A1) An authenticated user choosing keys, including another user's key. (A2) An
anonymous client on a `principal: 'optional'` route. (A3) A client flooding unique keys. (A4) A
foreign producer with write access to a shared topic. (A5) A reader of logs and error bodies. (A6)
Developer misconfiguration (placement, shared store, unlisted topics). (A7) Another application, or
an operator, with write access to a shared Redis.

**Approved budgets.** Per idempotent request: one SHA-256 over the body (bounded by the runtime's
`maxBodyBytes`), one claim round trip, one settle round trip; none on a replay; zero store calls for
an unlisted topic/job or a safe method. One `CONFIG GET` per Redis store connect.

**Design-time findings.**

| #   | Finding                                                                                                                                                                                     | Disposition                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Without principal scope, user B with A's key receives A's response (A1)                                                                                                                     | Principal id in the key; `principal: 'required'` default (§3.11)                                                                                                                                                                                                                                                                                          |
| D2  | Cross-tenant collision (A1)                                                                                                                                                                 | Tenant id in the key (§3.11)                                                                                                                                                                                                                                                                                                                              |
| D3  | `409`/`422` reveal a key exists (A1)                                                                                                                                                        | Accepted once principal-scoped; key never echoed (§3.6)                                                                                                                                                                                                                                                                                                   |
| D4  | Unique keys grow the store (A3)                                                                                                                                                             | Rate limiting earlier; TTL ≤ 30 days; key ≤ 255 → hashed 64; body cap; memory caps refuse rather than evict (§3.13, §3.16); DO alarms (§3.15)                                                                                                                                                                                                             |
| D5  | Stored responses hold personal data and secrets at rest for the TTL                                                                                                                         | `response: 'status'`; `redaction`; header ALLOW list; README: retention counts toward the data inventory and erasure timelines. In status mode the FINGERPRINT — an unsalted SHA-256 of the request body — is still stored; a low-entropy body (a short code, a PIN) can be confirmed by brute force from it. Accepted and documented; not salted in 109a |
| D6  | A replayed `Set-Cookie` re-issues a session; replayed trace/request ids misattribute logs                                                                                                   | ALLOW list + fixed DENY list (§3.10)                                                                                                                                                                                                                                                                                                                      |
| D7  | Anonymous clients share one scope (A2)                                                                                                                                                      | `principal: 'optional'` is explicit; JSDoc/README recommend `response: 'status'` there                                                                                                                                                                                                                                                                    |
| D8  | `idempotent()` before authentication (A6)                                                                                                                                                   | Default `principal: 'required'` → 401 on every keyed request (§3.6 step 4)                                                                                                                                                                                                                                                                                |
| D9  | Before validation, an invalid request consumes the key (A6)                                                                                                                                 | `@Idempotent` appended after validation by construction; README placement rule                                                                                                                                                                                                                                                                            |
| D10 | Store unreachable → running unprotected                                                                                                                                                     | Claim failure → 503 / ingress retry; never runs unclaimed                                                                                                                                                                                                                                                                                                 |
| D11 | A stale holder completes over its successor                                                                                                                                                 | Token-fenced; fence covers the record only (§3.3)                                                                                                                                                                                                                                                                                                         |
| D12 | Lua injection                                                                                                                                                                               | Values only via `KEYS`/`ARGV`; constant scripts (§3.5)                                                                                                                                                                                                                                                                                                    |
| D13 | Log forging / key disclosure (A5)                                                                                                                                                           | Keys, fingerprints, bodies never logged; error messages carry no client value (§3.6, §3.17)                                                                                                                                                                                                                                                               |
| D14 | A foreign producer reuses a dedup id to suppress another's message (A4)                                                                                                                     | Documented (M106 D12); `scope` adds a tenant segment; topic write access is the trust boundary                                                                                                                                                                                                                                                            |
| D15 | Principal ids from two issuers collide (A1 across issuers)                                                                                                                                  | `IPrincipal` has no issuer (§1); documented application obligation (§3.11)                                                                                                                                                                                                                                                                                |
| D16 | DO per key: key flood creates many objects (billing)                                                                                                                                        | Upstream rate limiting; alarm cleanup; README cost note                                                                                                                                                                                                                                                                                                   |
| D17 | Cross-CONSUMER skip: one topic, two subscribers → the second subscriber's work is skipped as a "duplicate"; header-less internal traffic (realtime backplane) refused (B1, probe-confirmed) | `consumer` in the key (§3.19); required allow-list — unlisted topics untouched (§3.7)                                                                                                                                                                                                                                                                     |
| D18 | Silent loss: Redis eviction (any policy but `noeviction`) or async-replica failover drops completed records → a duplicate executes                                                          | Connect-time `maxmemory-policy` warning; §3.18 durability caveat; README                                                                                                                                                                                                                                                                                  |
| D19 | Cross-APPLICATION skip/read: two services sharing a Redis or DO namespace read each other's records (A6, A7)                                                                                | REQUIRED store `namespace` in every key (§3.5, §3.15)                                                                                                                                                                                                                                                                                                     |
| D20 | Decode tampering: a forged or corrupted record (A7) replays an attacker-chosen status, header or body                                                                                       | `decodeHttpRecord` re-validates status 200–499, re-filters headers against the CURRENT allow/deny lists, validates values and body size; violation → 503, logged, no replay (§3.10)                                                                                                                                                                       |
| D21 | Per-principal exhaustion of a shared cap: one principal fills the memory store and every other caller gets 503 (A3)                                                                         | `maxEntriesPerScope` (default 1,000) → that caller gets 429 while other SCOPES still claim (§3.16). Scoped by the audit (F4): a scope is one (tenant, principal), so a principal choosing tenants occupies many scopes and can fill the global cap (503 for everyone); that falls to D4's upstream rate limiting, stated in the README                    |

**Obligations the implementation audit must meet.**

1. User A's stored response is never served to user B, nor tenant X's to tenant Y, for the same key,
   on every store.
2. No principal on `principal: 'required'` → 401 and NO store call.
3. No body, log line or error message contains the client's key, the fingerprint, the stored body,
   or an option value; probe with recognizable values and grep captured logs and bodies.
4. A replay never carries `Set-Cookie`, `RateLimit-*`, `Retry-After`, `X-Request-Id`, `traceparent`,
   `Date` or `Content-Language` from the original; `replayHeaders` naming them is refused at
   construction.
5. A claim failure never runs the handler.
6. Two concurrent claims of one key → one execution on real Redis and on the gated DO fake; a lapsed
   holder's `complete` after takeover is `lost`.
7. Every numeric option refuses `NaN`, `Infinity`, negatives and out-of-range values.
8. The memory store refuses at capacity rather than evicting a completed record; one scope at its
   cap does not block another.
9. The Lua scripts take every value through `KEYS`/`ARGV`.
10. With `response: 'status'` no body byte is written to the store (inspect the stored value); the
    fingerprint IS stored, as D5 states.
11. "Exactly once" appears nowhere in the shipped package, README or its PUBLIC_API section.
12. Two subscribers on one listed topic each process a message once; an unlisted topic and a
    header-less publish on it make no store call.
13. Two applications with different store namespaces never read each other's records (real Redis).
14. A tampered record (forged status, DENY header, CR/LF value, oversize body) is never replayed.
15. A non-`noeviction` policy produces exactly one warning; a refused `CONFIG GET` produces none.
16. Health reports `down` before `connect()` and after `close()` for every store arm.

## 11. Review dispositions (revision 2)

| Finding                 | Verified how                                                                      | Disposition                                                                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1                      | Reviewer `fanout.ts` re-run: `shipping` refused, `backplane` refused              | Accepted: §3.7 allow-list, §3.19 consumer, required store namespaces, fan-out test                                                                                                                                                                  |
| M1                      | —                                                                                 | Accepted: §3.2, §3.15, §3.17, §4.1 declarations                                                                                                                                                                                                     |
| M2                      | —                                                                                 | Accepted: §3.9 split; per-call WeakMap; two-routes test                                                                                                                                                                                             |
| M3                      | `retry-strategy.ts:12,17,38-45`, `job-processor.ts:144-147`, `queue-plugin.ts:83` | Accepted with one correction: the default queue retry waits are 2,000 ms and 4,000 ms (backoff of attempts 2 and 3), not 1 s and 2 s; the conclusion (span < lease) holds. Lease 30 s; documented, not checkable (`IQueue` exposes no retry config) |
| M4                      | `.verify-109a/cfg.ts` (`CONFIG GET` on 7.4.10)                                    | Accepted: §3.5 check, §3.16 per-scope cap, §3.18, D18, D21                                                                                                                                                                                          |
| Canonicalisation        | Reviewer `canon.ts`                                                               | Accepted (§3.20); the "same named 400" for a cycle does not apply — HTTP never canonicalises; ingress uses the named refusal                                                                                                                        |
| Check order             | —                                                                                 | Accepted (§3.6), with the missing+required 400 and the invalid-key 400 placed after the principal check                                                                                                                                             |
| Decode validation       | —                                                                                 | Accepted, status range tightened to 200–499 (the only recorded statuses)                                                                                                                                                                            |
| Failure paths           | `common/src/http.ts:110-118`, `fetch-mapping.ts:38-50`                            | Accepted: all three propagate unchanged; the `bodyField` "named 400" IS the platform's `MalformedRequestBodyError`                                                                                                                                  |
| Health                  | —                                                                                 | Accepted (§3.14); `docs/health-indicators.md` classification `live-state`                                                                                                                                                                           |
| Redis seam              | `.verify-109a/seam2.ts`                                                           | Accepted: `call`, `connect`, `on`; `createRedisIdempotencyClient` in `stores/redis-client.ts`                                                                                                                                                       |
| DO alarm                | —                                                                                 | Accepted: no alarm after `release`; the handler no-ops                                                                                                                                                                                              |
| Conformance `ignore`    | —                                                                                 | Accepted                                                                                                                                                                                                                                            |
| Status mode fingerprint | —                                                                                 | Accepted: D5, obligation 10; not salted                                                                                                                                                                                                             |
| Principal issuer        | `auth.ts:16-25`, `jwt-strategy.ts:115-138`                                        | Nothing distinguishes issuers → documented obligation (§3.11, D15)                                                                                                                                                                                  |
| Redis ≥ 5               | Redis documentation (not re-verified on 5.x; tested on 7.4.10)                    | Accepted (§3.5)                                                                                                                                                                                                                                     |
| `maxResponseBytes` unit | —                                                                                 | Accepted (§3.2, §3.10)                                                                                                                                                                                                                              |
| Query nit               | `fetch-mapping.ts:301-304`                                                        | Accepted (§3.6)                                                                                                                                                                                                                                     |
| `content-language` nit  | `locale-middleware.ts:118-127`                                                    | Accepted: moved from ALLOW to DENY (§3.10)                                                                                                                                                                                                          |
