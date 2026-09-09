# Upgrading Setu-TS

The CHANGELOG answers "what changed in the framework"; this guide answers "what must I change in
**my** project". A release that demands reader action adds an entry here, version by version — that
is a release step ([releasing.md](./releasing.md)), not a memory exercise.

Each heading names the release that **shipped** the change, so an upgrade spanning several releases
is the union of every section between the version you are on and the one you are moving to.

<!-- version:history -->

## 0.5.0

0.5.0 is a breaking release across several packages. Two changes fail `deno check`; the rest change
a status code, a response body, a Redis key, a consumer-group name or a CLI exit code, and are
listed here because each one can pass a type-checker and fail in production.

### Add `ping()` to an injected `IRedisClient`

`@setu-ts/cache-plugin`'s Redis store gained a reachability probe, so `IRedisClient` gained a
required `ping(): Promise<string>` member. If you pass your own client — the commonest case being a
test double — supply it:

```typescript
// TS2741 Property 'ping' is missing in type '…' but required in type 'IRedisClient'.
const client: IRedisClient = {
  // …get, set, del, exists, scan, quit…
  ping: () => Promise.resolve('PONG'),
};
```

`ioredis` already has it, so an application passing a real client needs no change. The probe treats
a rejection as unreachability rather than an error, so a double that rejects reports
`reachable:
false` on `/health` and nothing else.

### Add `rotate` and `revokeFamily` to a custom `RefreshTokenStore`

`@setu-ts/auth-plugin` now revokes a whole credential family when a refresh token is replayed or a
session is logged out, which a store must implement:

```typescript
class MyStore implements RefreshTokenStore {
  // …existing members…

  /**
   * Must be ATOMIC: two concurrent refreshes of one token may not both succeed.
   * `rotated` says whether the presented token was live when `successor` was
   * stored — the loser of a race gets `{ record, rotated: false }`, which the
   * service reads as a replay.
   */
  async rotate(
    jti: string,
    successor: RefreshTokenRecord,
  ): Promise<IRefreshTokenRotation> {/* … */}

  /** Revokes the token and every descendant, and RETURNS what it revoked. */
  async revokeFamily(jti: string): Promise<readonly RefreshTokenRecord[]> {/* … */}
}
```

`revokeFamily` returns the records rather than `void` because their `accessTokenJti` values are what
the service revokes alongside them. Your records must also persist the optional lineage fields on
`RefreshTokenRecord` (`familyId`, `accessTokenJti`, `accessTokenExpiresAt`), or `revokeFamily` has
no chain to walk and a replayed token revokes only itself. `MemoryRefreshTokenStore` implements both
and is the in-repo reference.

Policy refusals also stopped disclosing the required role or permission: a `403` now reads
`Insufficient privileges`. Update tests asserting the old detail.

### Errors that were `500` now carry their real status

Every condition below is one a caller caused, or one a caller can retry, and all of them were
reaching clients as a masked `500`. They now answer honestly. Nothing about **your** code has to
change for these to be correct — but a `catch` or a test matching `500` will stop matching:

| Condition                                                              | Was | Now   |
| ---------------------------------------------------------------------- | --- | ----- |
| A malformed JSON request body (`IRequest.json()`)                      | 500 | `400` |
| A backend serialization conflict (`SerializationConflictError`)        | 500 | `409` |
| A transiently unreachable database (`DatabaseUnavailableError`)        | 500 | `503` |
| Bulkhead full / circuit open (`BulkheadFullError`, `CircuitOpenError`) | 500 | `503` |
| A resilience timeout (`TimeoutError`)                                  | 500 | `504` |
| A write to a read-only secret provider (`ReadOnlySecretProviderError`) | 500 | `501` |
| Memory-adapter raw SQL and `migrate()`                                 | 500 | `501` |

`instanceof SerializationConflictError` is the retry signal for optimistic concurrency, which the
masked `500` made unusable. None of these carries `Retry-After`.

One is also a call-shape change: `DatabaseService.query()` on the memory adapter used to throw
**synchronously** from a method typed `Promise`, so a caller using `.catch()` never saw it. It
rejects now. A synchronous `try`/`catch` around an un-awaited `query()` no longer catches — `await`
it, or use `.catch()`.

### The rate limiter's `429` body and Redis keys both change

`@setu-ts/auth-plugin`'s `rateLimitMiddleware` wrote its own `{ error, message }` body, ignoring
`errorHandler`'s configured format. It now answers in that format like every other refusal, so a
client reading `body.message` should read `body.detail` (or `body.details.detail` under
`format: 'default'`). The `Retry-After` and `RateLimit-*` headers are unchanged.

It also stopped refusing the operational probes. `exclude` now defaults to `/live`, `/ready`,
`/health`, `/metrics`, `/openapi.json` and `/docs` — an exhausted limiter used to answer `/live`
with `429`, which a kubelet reads as a failed liveness probe and restarts a container whose only
fault was load. A caller list **replaces** the defaults, so spread
`DEFAULT_RATE_LIMIT_EXCLUDED_PATHS` to extend them, or pass `exclude: []` for the previous
behaviour.

Finally, `RedisRateLimitStore` now namespaces its keys under `DEFAULT_RATE_LIMIT_KEY_PREFIX`
(`'setu:ratelimit:'`). Two applications sharing one managed Redis were previously counting against
each other's budget. In-flight counters under the old keys are orphaned but TTL-bounded, so the
blast radius is one window; pass `keyPrefix: ''` for the previous keys byte for byte.

### Kafka's shared `messaging-consumers` group is derived per topic

A subscription with no `queue` used to join one shared `messaging-consumers` group. Members of a
Kafka consumer group must subscribe the same topics, so an application subscribing two topics ended
with empty assignments and **no delivery at all**. The group is now `<defaultQueue>:<topic>`. If you
have tooling, dashboards or ACLs keyed on the literal `messaging-consumers`, repoint them at the
derived names. A caller-supplied `queue` still names the group itself and is unaffected.

### `CAPABILITIES.LOGGER` resolves to a wrapper

The registered `ILogger` is now a trace-enriching decorator around your configured transport, so
`logger instanceof ConsoleLogger` no longer holds. Every `ILogger` method behaves identically and
`level` passes through. Branch on behaviour or on your own configuration instead — `ILogger` is the
contract and the concrete class never was.

### The `setu` CLI refuses unknown flags, and bare `setu generate` exits 0

`setu` collected every flag and positional and consulted neither, so `setu new app --templat rest`
scaffolded the **minimal** project and reported success. Unknown flags and extra positionals now
exit `2` with nothing written. In the other direction, bare `setu generate` now exits `0` and lists
the schematics, where it printed the same guidance and exited `2`. A script branching on either exit
code needs updating; a script passing a stray flag was already misbehaving silently.

### Health indicators run concurrently under `indicatorTimeoutMs`

`/health` used to await each selected indicator in registration order, so a 2-second outage across
six dependency indicators held the endpoint for 12+ seconds and one never-settling indicator held it
forever. Indicators now run concurrently under `HealthPluginOptions.indicatorTimeoutMs` (default
5,000). Report shape and key order are unchanged; a timeout records
`{ status: 'down', data: { reason: 'timeout' } }`. If a test asserted wall-clock interleaving
between two indicators, assert on the report instead.

<!-- version:history -->

## 0.2.0

### Add `findPage` to a hand-written `IRepository`

<!-- version:history -->

`IRepository` gained a **required** `findPage(options: PageOptions): Promise<Page<Entity>>` member
in 0.2.0 (keyset cursor pagination). The `IDataSource.findPage?` the CHANGELOG's Added entry
describes is optional — a different type. If you implement `IRepository` by hand rather than
extending `BaseRepository` — the commonest case being a test double — you must now supply it:

<!-- version:history -->

```typescript
// Before — compiles until 0.2.0, then:
// TS2741 Property 'findPage' is missing in type '…' but required in type 'IRepository<UserRow, string>'.
class UserRepo implements IRepository<UserRow, string> {
  // …findById, findAll, findOne, create, update, delete, exists, count…
}

// After — the member is required on the interface.
class UserRepo implements IRepository<UserRow, string> {
  // …
  async findPage(options: PageOptions): Promise<Page<UserRow>> {
    // `nextCursor` is non-null IF AND ONLY IF the page is non-terminal, and is
    // never derived from `rows.length`: a page that returns exactly `limit`
    // rows may still be the last one. The row-based mechanism is to fetch one
    // more row than asked for and let the extra row be the signal.
    const limit = options.limit ?? 50;
    const rows = await this.load({ ...options, limit: limit + 1 });
    return rows.length > limit
      ? { rows: rows.slice(0, limit), nextCursor: this.cursorAfter(rows[limit - 1]) }
      : { rows, nextCursor: null };
  }
}
```

`load` and `cursorAfter` above stand for your own storage and sort key — the block is a **sketch of
the member**, not a file that compiles on its own, which is also why the class body is elided. For
one that does compile, and is type-checked and tested on every run, the in-repo reference
implementation is
[`repository-implementor.ts`](../packages/database-plugin/test/fixtures/repository-implementor.ts),
a hand-written `IRepository` that doubles as a compile-time tripwire: adding a required member to
the interface without updating it fails `deno check`.

<!-- version:history -->

## 0.1.0-alpha.10

### Remove `experimentalDecorators` from your own manifest

The decorator surface moved to TC39 standard decorators and the legacy form was removed. The
framework removed the option from all of **its own** declaration sites — that part is done for you.
What the release entry does not do for you: a project scaffolded by an earlier CLI still carries
`"compilerOptions": { "experimentalDecorators": true }` in its own `deno.json` (or the equivalent in
a generated Node `tsconfig.json`), and a migrated project that keeps it compiles its decorators
under the **legacy** semantics and fails `deno check` with `TS1238`/`TS1241` on every decorated
member.

The errors point at the decorators, not the option, which is exactly why this step needs to be
written down:

```text
TS1238  Unable to resolve signature of class decorator when called as an expression.
        The runtime will invoke the decorator with 1 arguments, but the decorator expects 2.
TS1241  Unable to resolve signature of method decorator when called as an expression.
```

Remove **that one key** from your project's manifest. Leave the rest of your `compilerOptions`
alone: Deno applies its own defaults to every option you do not specify, so declaring one option
does not disturb the others (measured on Deno 2.9.6 — a manifest declaring only
`experimentalDecorators` still type-checks under `strict`). If `experimentalDecorators` was the only
option you had, the whole `compilerOptions` object can go.

<!-- version:history -->

## 0.1.0-alpha.8

### Add `findOne` to a hand-written `IRepository`

The same class of change as `findPage` above, two releases earlier: `IRepository` gained a required
`findOne` member. A class implementing `IRepository` without extending `BaseRepository` must now
implement `findOne`.
