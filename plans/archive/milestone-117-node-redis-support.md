# Milestone 117 — node-redis as a supported Redis client (`@setu-ts/common` + 7 Redis consumers + `@setu-ts/telemetry-plugin` + `@setu-ts/cli`)

> **Status:** Complete. Branch: `feat/m117-node-redis-support`. `main` and `develop` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Let an application use node-redis (`redis`), which Redis recommends for new projects, anywhere the
framework uses Redis today, without writing its own adapter — while ioredis stays the default and no
published package depends on `redis`. The boundary: ONE structural adapter in `@setu-ts/common` that
every existing `client` option accepts unchanged, an outage classifier that recognizes node-redis's
errors, a telemetry arm, and a CLI choice between the two clients.

- **In scope:** `fromNodeRedis(client, options?)` in `common` (§3.1); RESP3 reply normalization
  (§3.2); the adapter's own command bound (§3.3); lifecycle and pub/sub (§3.4, §3.5);
  `isConnectionFault` widened with measured node-redis errors (§3.6); the `redis` telemetry arm
  (§3.7); `--redis-client ioredis|node-redis` on `setu new` / `setu add`, the workspace manifest's
  `redisClient`, the interactive prompt and the generated wiring (§3.8); real-Redis tests for every
  consumer driven through the adapter (§3.9); docs, ROADMAP section and row `117`.
- **NOT this milestone:** node-redis cluster / sentinel clients (`createCluster`, `createSentinel` —
  the adapter takes a single-node client; named in the README as not supported); a Valkey Glide arm;
  changing any facade to a client-neutral shape (the facades stay ioredis-shaped, §2 C3).

## 1. Contracts verified from SOURCE (not names)

| Reference                      | Source (file:line)                                                                                                                                                                                                                                                                                                                                                 | Verified surface / fact                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRedisClient` (cache)         | `packages/cache-plugin/src/interfaces/index.ts:108`                                                                                                                                                                                                                                                                                                                | `get`, `set(k, v, 'EX'?, n?)`, `del(...k)`, `exists`, `ping`, `scan(cursor, 'MATCH', pattern)`, `quit`, `connect?`.                                                                                                                                             |
| `IRedisQueueClient`            | `packages/queue-plugin/src/interfaces/index.ts:22`                                                                                                                                                                                                                                                                                                                 | `zadd`, `zrangebyscore(k, min, max, ...['LIMIT', o, c])`, `zrem`, `hset`, `hget`, `hdel`, `del`, `zcard?`, `expire?`, `eval?(script, numKeys, ...)`, `connect?`, `ping?`, `quit`.                                                                               |
| `IRedisStreamsClient`          | `packages/messaging-plugin/src/interfaces/index.ts:30`                                                                                                                                                                                                                                                                                                             | `xadd`, `xgroup`, `xreadgroup(...)`, `xpending`, `xclaim`, `xinfo`, `call?(cmd, ...)`, `xack`, `quit`, `connect?`, `ping?`, `status?`. Parsers read ioredis's RAW nested arrays (`redis-streams-broker.ts:454–700`).                                            |
| `IRedisBackplaneClient`        | `packages/realtime-backplane-plugin/src/interfaces/index.ts:23`                                                                                                                                                                                                                                                                                                    | `publish`, `subscribe(channel)`, `unsubscribe(channel)`, `on/off('message', (channel, message) => …)`, `quit`, `disconnect?`, `ping?`, `status?`. Health requires both connections' `status` + `ping`, and `status === 'ready'` (`redis-backplane.ts:266–290`). |
| `IRedisLockClient` (scheduler) | `packages/scheduler-plugin/src/interfaces/index.ts:411`                                                                                                                                                                                                                                                                                                            | `ping?`, `set(k, v, 'NX', 'PX', ttl)`, `quit`, `eval(script, numKeys, ...)`. Never calls `connect()`.                                                                                                                                                           |
| `IRedisIdempotencyClient`      | `packages/idempotency-plugin/src/interfaces/index.ts:19`                                                                                                                                                                                                                                                                                                           | `eval`, `ping`, `quit`, `call`. The injected arm (`type: 'redis', client`) never connects or quits the client (`stores/redis-store.ts:103,158`, `ownsClient`). `call('CONFIG', 'GET', 'maxmemory-policy')` is read as a flat array (`redis-store.ts:176`).      |
| `IRateLimitRedisClient` (auth) | `packages/auth-plugin/src/stores/redis-rate-limit-store.ts:44`                                                                                                                                                                                                                                                                                                     | `incr`, `pexpire`, `pttl`, `del`, `quit`.                                                                                                                                                                                                                       |
| Injected-client ownership      | cache `redis-store.ts:231`, queue `redis-queue.ts:353`, messaging `:291`, scheduler `redis-lock.ts:213`, auth `:238`, backplane `redis-backplane.ts:437`                                                                                                                                                                                                           | Six consumers call `quit()` on the client at shutdown whether injected or built; idempotency quits only a client it built. Messaging and queue also call `connect()` on an injected client (`:271`, `:301`).                                                    |
| `isConnectionFault`            | `packages/common/src/errors/connection-fault.ts:56`                                                                                                                                                                                                                                                                                                                | Codes (`ECONNREFUSED`, …), `MaxRetriesPerRequestError`, and `name === 'Error'` with three exact ioredis messages incl. `'Command timed out'`. Walks five `cause` links.                                                                                         |
| Telemetry `ioredis` arm        | `packages/telemetry-plugin/src/instrumentation/database-instrumentation.ts:17–58`, `instrumentation-registry.ts:87,126,246`, `interfaces/index.ts:44,262`, `plugin/telemetry-plugin.ts:60`                                                                                                                                                                         | Lazy `import('@opentelemetry/instrumentation-ioredis')` → `OptionalDependencyUnavailableError`; `InstrumentationKind` union; per-kind loader and dispatch.                                                                                                      |
| CLI Redis arm                  | `packages/cli/src/workspace/transport.ts:340–375`                                                                                                                                                                                                                                                                                                                  | `messagingClients`/`queueClients: ['ioredis']`; `messagingArgs`, `queueArgs`, `cacheArgs`, `schedulerArgs`, `backplaneArgs` render `url: <connection>`.                                                                                                         |
| CLI rendering seams            | `templates/broker.ts:71–190` (`starterOptionLiteral`, `withBrokerArgs`, `withQueueArgs`), `commands/add.ts:1028–1073` (`transportAddArgs`, hardcoded `['ioredis']` at :1072), `templates/client-dependencies.ts:19–80` (`CLIENT_RANGES`, `withClientDependencies`), `templates/project-files.ts:395–470` (`configModule` imports)                                  | `packageImports` merges extra `@setu-ts/common` symbols into one import; nothing emits a third-party import; the full-stack factory (`templates/full-stack.ts:133–175`) is an expression inside `setu.config.ts`.                                               |
| CLI flags                      | `packages/cli/src/flags.ts:120–140` (`new`: `workspace`, `transport`, `transport-url`, `broker`, `queue`), `:176–183` (`generate app` reads those only to refuse them), `:200` (`add`: `broker`, `queue`)                                                                                                                                                          | Interactive broker/queue questions in `commands/new-interactive.ts:180–200`.                                                                                                                                                                                    |
| Workspace manifest             | `packages/cli/src/workspace/manifest.ts:186–199,382,454`                                                                                                                                                                                                                                                                                                           | `transport`, `transportUrl?`; parsed field by field; `setu add` in a member reads it (`add.ts:1028–1039`).                                                                                                                                                      |
| Real-Redis fixtures            | `packages/common/test/fixtures/redis-connection-errors.ts`; per package `test/integration/{connection-errors,outage}-real.test.ts` (cache, queue, messaging, backplane, scheduler, auth); messaging `redis-redelivery-real`, `inbox-real`, `outbox-real`; queue `redis-atomic-transitions-real`, `redis-lease-real`, `redis-prefix-real`; idempotency `redis-real` | Guarded on `REDIS_URL` (CI job env, `.github/workflows/ci.yml:99`); outage tests `docker pause/stop` the container found by published port.                                                                                                                     |

**External facts, measured 2026-10-29** (`redis` 6.3.1 / `@redis/client` 6.3.1, `redis` 5.12.1,
`ioredis` 5.11.1, Redis 7.4.11 in a throwaway container; probes kept in the scratchpad, results
below are what the plan relies on):

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Current `redis` is **v6** (latest 6.3.1). `sendCommand(args: ReadonlyArray<string\|Buffer>, options?: { timeout?, abortSignal?, typeMapping?, … }): Promise<T>`; `connect()`, `close()` (waits for pending), `destroy()`, `quit()` (deprecated), `isOpen`, `isReady`, `duplicate()`, `subscribe(channel, (message, channel) => …)`, `unsubscribe(channel)`. v5.12.1 has the same members.                                                                                                                                                                                                                                                                                   |
| E2  | v6 speaks **RESP3 by default** (`HELLO` → proto 3; `options.RESP` is `undefined` when unset); v5 defaults to RESP2. Through raw `sendCommand`, every command the seven facades send replies byte-identically to ioredis under both protocols EXCEPT the RESP3 map replies: `XREADGROUP` (`{ stream: entries }` vs `[[stream, entries]]`), `XINFO GROUPS/CONSUMERS` (array of objects vs array of flat `[k, v, …]`), `CONFIG GET` (object vs flat), `HGETALL` (object vs flat, not sent by any facade). `XCLAIM`, `XPENDING`, `EVAL` (incl. Lua `TIME`), `SCAN`, `ZRANGEBYSCORE … LIMIT`, `SET … EX/NX PX`, `INCR/PEXPIRE/PTTL` are identical.                               |
| E3  | `sendCommand(…, { timeout })` and `abortSignal` do **not** bound a command already written: against `docker pause` both stayed pending for the full 5 s and resolved after unpause. With the default offline queue a command issued while reconnecting to a stopped server stays pending indefinitely; `connect()` to a refused port with the default reconnect strategy never settles. The client-level `socket.socketTimeout` DOES reject a paused command (`SocketTimeoutError`).                                                                                                                                                                                        |
| E4  | Every node-redis error has `name === 'Error'` (no class sets `name`): closed or never-connected → `ClientClosedError` "The client is closed"; dropped connection / stopped server → `SocketClosedUnexpectedlyError` "Socket closed unexpectedly"; `disableOfflineQueue` while down → `ClientOfflineError` "The client is offline"; `connectTimeout` → `ConnectionTimeoutError` "Connection timeout"; `socketTimeout` → `SocketTimeoutError` "Socket timeout timeout. Expecting data, but didn't receive any in 300ms." (the number is the configured ms); refused → `Error` code `ECONNREFUSED` (already classified); `WRONGTYPE` → `SimpleError` (must stay unclassified). |
| E5  | Pub/sub on a `duplicate()` connection: `subscribe(ch, listener)` delivers `(message, channel)`; regular commands still resolve on a subscribed v6 connection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| E6  | `@opentelemetry/instrumentation-redis`: 0.68.0 (the 0.220 train the repo pins) declares `redis >=2.6.0 <6`; **0.69.0** (train 0.221) is the first declaring `<7`; 0.72.0 is on 0.300. Its `@opentelemetry/instrumentation` is a regular dependency, `@opentelemetry/api` a peer (`^1.3.0`). node-redis v6's own `OpenTelemetry.init` emits metrics only.                                                                                                                                                                                                                                                                                                                    |
| E7  | Precedent: BullMQ 6.5 ships `createNodeRedisClient(raw)`, an explicit wrapper over a structurally typed user-built client exposing BullMQ's ioredis-shaped interface; requires `redis >= 5`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| E8  | node-redis v6 runs on Node 24, Deno 2.9.6 and Bun 1.4.2 (commands and pub/sub). On Deno it reads `REDIS_DEBUG_MAINTENANCE` from the environment: with `--allow-net` alone it fails (surfaced as an `'error'` event); with the unrestricted `--allow-env` every generated Deno task grants (`templates/project-files.ts:1445`) it works. The workspace launcher's scoped `--allow-env=` (`workspace/runtime-profile.ts:204`) never loads a client.                                                                                                                                                                                                                           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                                                                         | Doc deliverable (same PR)                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| C1  | ROADMAP §117: "A `fromNodeRedis(client)` adapter for each of the seven facades" and lists `common` only for connection-fault classification                                                                                                                                                 | ONE `fromNodeRedis` in `common` satisfying all seven facades (maintainer decision 2026-10-29; BullMQ precedent E7); no per-package helper                                                        | ROADMAP §117 rewritten to the shipped design                    |
| C2  | ROADMAP §117 states node-redis facts "from knowledge of its v4/v5 API", including that `sendCommand` returns ioredis's arrays and that a per-command timeout bounds a hang                                                                                                                  | Measured facts E1–E4 replace them: v6, RESP3 by default, per-command timeout does not bound a written command                                                                                    | ROADMAP §117 "What an adapter must translate" replaced by E1–E5 |
| C3  | ROADMAP §117 asks the plan to decide "whether the public facades move to a neutral shape"                                                                                                                                                                                                   | They do not: every facade stays ioredis-shaped; the adapter is the only translation                                                                                                              | ROADMAP §117                                                    |
| C4  | `IRedisLockClient.eval` (`scheduler-plugin/src/interfaces/index.ts:419`) declares `Promise<number \| string \| null>`, while the queue and idempotency facades declare `Promise<unknown>` for the same command; one adapter cannot honestly satisfy both (a Lua script may return an array) | Widen `IRedisLockClient.eval` to `Promise<unknown>`: both scheduler call sites ignore the result (`redis-lock.ts:277,305`); widening a return type an implementor provides breaks no implementor | `PUBLIC_API.md` scheduler section; CHANGELOG                    |

## 3. Design decisions

### 3.1 `fromNodeRedis` — one structural adapter in `common`

- **Decision:** new file `packages/common/src/redis/node-redis-adapter.ts` exports
  `fromNodeRedis(client: NodeRedisClientLike, options?: NodeRedisAdapterOptions): NodeRedisAdapter`.
  `NodeRedisClientLike` is a STRUCTURAL type of exactly the members E1 lists that the adapter calls
  (`isOpen`, `isReady`, `connect()`, `sendCommand(args, options?)`, `close()`, `destroy()`,
  `on(event, listener)`, `subscribe(channel, listener)`, `unsubscribe(channel)`); no file under
  `packages/*/src` imports `redis`, and `common` gains no dependency. `NodeRedisAdapter` is one
  class instance implementing the UNION of the seven facades' members with ioredis call shapes:
  `get set del exists ping scan zadd zrangebyscore zrem hset hget hdel zcard expire eval xadd xgroup xreadgroup xpending xclaim xinfo xack call publish subscribe unsubscribe on off incr pexpire pttl connect quit disconnect`
  and a `status` getter. Every command method is `this.#command([NAME, ...flatten(args)])`, where an
  argument is `string | number | undefined | readonly (string | number)[]`: `undefined` is dropped
  and an array is spread one level (ioredis's own argument rule, which the facades rely on:
  `set(k, v, ttlMode?, ttlSeconds?)`, `scan(…, matchValue?)`,
  `xadd(…, data: string | string[], …)`), and numbers become strings, so the server sees the
  commands ioredis would send. (Amended after Codex run 1: `(string | number)[]` could not accept
  the facades' optional and array arguments.) Each method declares the return type its facade(s)
  declare (`del` → `Promise<number>`, `ping` → `Promise<string>`, `xpending` → the facade's tuple
  array, …; where facades differ the narrowest, and `eval` → `Promise<unknown>` after C4). One
  compile-time assertion per facade proves assignability, and one against the REAL `redis` types
  proves a `createClient()` client (default and `RESP: 2` generics) is a `NodeRedisClientLike` (§6).
- **Why:** all seven facades already take ioredis's shapes, and E2 shows raw `sendCommand` returns
  ioredis's replies for every command they send; one implementation keeps the timeout, RESP3,
  lifecycle and error-listener rules in one place (maintainer decision 2026-10-29).
- **Test home:** `common/test/unit/node-redis-adapter.test.ts` (command translation table: each
  method → the exact `sendCommand` argument array, as data); per-package assignability assertions.

### 3.2 RESP3 replies normalized to RESP2 shapes

- **Decision:** `#command` normalizes the reply before returning it: a map reply (a plain object
  from node-redis's default type mapping, or a `Map` if the user configured one) becomes RESP2's
  encoding — for `XREADGROUP`/`XREAD`, the top-level map becomes an array of `[key, value]` pairs;
  everywhere else (`XINFO …`, `CONFIG GET`, `HGETALL`, and any map nested inside an array) a map
  becomes a flat `[k1, v1, k2, v2, …]` array, recursively. Arrays, strings, numbers and `null` pass
  through untouched. The same normalization applies to `call(...)`, so the idempotency store's
  `CONFIG GET` check works under RESP3.
- **Why:** E2 — v6 defaults to RESP3 and only map replies differ; requiring `RESP: 2` would make
  every v6 user configure it, and a forgotten setting would silently break the streams broker.
- **Test home:** unit table (RESP3 object/`Map` inputs → expected RESP2 arrays, incl. nested and
  `XREADGROUP` pairs); real-Redis tests run with a default (RESP3) client AND a `RESP: 2` client.

### 3.3 The adapter's own command bound

- **Decision:** `NodeRedisAdapterOptions.commandTimeoutMs` (default `15_000`, the plugins' own
  default; `0` disables; any other value must be a finite number from `0` to `2_147_483_647` or the
  call throws `RangeError` naming the option — the plugins' own rule and error,
  `cache-plugin/src/stores/redis-store.ts:64–78`). Every command — and the lazy connect in §3.4 —
  races a timer; on expiry the adapter rejects with `new Error('Command timed out')`, the exact
  message ioredis uses and `isConnectionFault` already classifies, so a hung node-redis call answers
  `503` exactly as a hung ioredis call does. The node-redis command is NOT cancelled (E3: it cannot
  be); its late reply is consumed by the client's queue and discarded by the adapter. This is the
  same contract as ioredis's `commandTimeout`, which the queue's Lua-script atomicity already
  accounts for (`interfaces/index.ts:58–70`). A plugin's own `commandTimeoutMs` option keeps
  applying only to a client the plugin builds (unchanged, documented). The streams broker's blocking
  `XREADGROUP … BLOCK <blockSizeMs>` (default 100 ms, `redis-streams-broker.ts:197,454`) shares the
  connection exactly as under ioredis; the README states that the adapter's bound must exceed
  `blockSizeMs`.
- **Why:** E3 — node-redis's per-command `timeout` and `abortSignal` do not bound a written command,
  and the default offline queue waits forever while reconnecting.
- **Test home:** unit (fake whose `sendCommand` never settles → rejects at the bound with that
  message; `0` → no timer; `NaN`, negative, `Infinity` and over-max refused with `RangeError`); real
  Redis `docker pause` → `503` per consumer.

### 3.4 Lifecycle: lazy connect, idempotent quit, always-attached error listener

- **Decision:** (a) `connect()` resolves at once when `client.isOpen`; otherwise it calls
  `client.connect()` ONCE (memoized until it settles) under the §3.3 bound. Every command first
  awaits the same connect when `!client.isOpen`, so consumers that never call `connect()`
  (scheduler, idempotency, auth) work, as with ioredis's default auto-connect. (b) `quit()` resolves
  at once when `!client.isOpen`; otherwise `client.close()` under the bound, falling back to
  `client.destroy()` if the bound expires; a second `quit()` resolves. `disconnect()` calls
  `client.destroy()`. (c) `status` is `'ready'` when `client.isReady`, `'connecting'` when open but
  not ready, `'wait'` before the first connect, `'end'` after `quit`/`disconnect` — the ioredis
  values the backplane's health reads. (d) The adapter attaches ONE `'error'` listener to the client
  at wrap time, calling `options.onError(error)` when given and doing nothing otherwise, because
  node-redis rethrows an unlistened `'error'` event and would crash the process; failures still
  surface through the rejected commands and health. The adapter never removes listeners the user
  attached.
- **Backplane start (amended after Codex run 1).** The adapter stays lazy — it must never open a
  socket when `setu.config.ts` is merely imported for command discovery — so an injected publisher
  that has run no command stays `'wait'`, and the backplane's health (which pings only a `'ready'`
  client) reported `down`. `IRedisBackplaneClient` gains an optional `connect?(): Promise<unknown>`,
  and the backplane's `#open` (`redis-backplane.ts:189`) awaits `connect()` on each injected client
  whose `status === 'wait'` before subscribing. A non-lazy ioredis client is never `'wait'`, so its
  path is unchanged; a lazy ioredis client now connects at start, which the subscriber's `SUBSCRIBE`
  already required.
- **Why:** six consumers call `quit()` on their client and two call `connect()` (§1 ownership row);
  node-redis does not auto-connect and its `connect()` throws on an open client.
- **Test home:** unit (connect memo; already-open client; quit twice; quit on never-connected;
  close-timeout → destroy; status transitions; error listener present and forwarding); real Redis
  boot/shutdown through a kernel app per consumer.

### 3.5 Pub/sub for the backplane

- **Decision:** `subscribe(channel)` calls `client.subscribe(channel, dispatch)` where `dispatch`
  delivers `(channel, message)` to every listener registered through `on('message', …)`;
  `unsubscribe(channel)` calls `client.unsubscribe(channel)`; `on`/`off` for `'message'` maintain
  the adapter's own registry and forward any other event name to `client.on`/`client.off`. The
  application passes two adapters — `client: fromNodeRedis(base)`,
  `subscriber: fromNodeRedis(base.duplicate())` — mirroring the two connections the lazy ioredis
  path builds.
- **Why:** E5 — node-redis delivers messages to a per-subscribe listener, not an emitter event.
- **Test home:** unit (listener registry, off, argument order); backplane real-Redis scenarios
  through the adapter pair (§3.9).

### 3.6 `isConnectionFault` recognizes node-redis outages

- **Decision:** add the measured E4 signals to the `name === 'Error'` branch: messages
  `'The client is closed'`, `'The client is offline'`, `'Socket closed unexpectedly'`,
  `'Connection timeout'`, and the exact pattern
  `/^Socket timeout timeout\. Expecting data, but didn't receive any in \d+ms\.$/`. Nothing else
  changes: `SimpleError`/`ErrorReply` (e.g. `WRONGTYPE`) stay unclassified, and the walk bound is
  unchanged. The JSDoc's measurement paragraph gains the node-redis version and each scenario.
- **Why:** E4 — every node-redis outage error is `name: 'Error'` with a message the classifier did
  not know, so a node-redis outage would answer `500` instead of `503` (undoing M113b).
- **Test home:** `common/test/unit/connection-fault.test.ts` table: each E4 shape as data with its
  expected classification (incl. `WRONGTYPE` → false and a socket-timeout message with a different
  ms value); real-Redis outage tests through the adapter (§3.9).

### 3.7 Telemetry: a `redis` instrumentation arm

- **Decision:** `InstrumentationKind` gains `'redis'`;
  `TelemetryInstrumentationsConfig.redis?: true | InstrumentationConfig`; `loadRedisInstrumentation`
  in `database-instrumentation.ts` does `await import('@opentelemetry/instrumentation-redis')`
  inside its `try` (M113d rule) and builds `RedisInstrumentation`, throwing
  `OptionalDependencyUnavailableError` when absent; registry and plugin list as for `ioredis`.
  (Amended after Codex run 2:) the diagnostics wire vocabulary restates these kinds, so
  `TraceInstrumentationKind` (`packages/common/src/services/diagnostics.ts:1020`) and the
  `INSTRUMENTATION` allowlist (`packages/diagnostics-plugin/src/protocol/trace-protocol.ts:49`) also
  gain `'redis'` — additive; without it the plugin's enabled-kinds report fails to type-check and a
  trace batch naming `redis` would be refused. `@opentelemetry/instrumentation-redis` `^0.69.0` is
  an OPTIONAL peer and a dev dependency (0.69.0 is the first release declaring `redis <7`, E6).
- **Why:** maintainer decision 2026-10-29; node-redis's own telemetry is metrics only (E6).
- **Test home:** registry unit tests mirroring the `ioredis` ones; one guarded real-span test: a
  `fromNodeRedis`-driven `SET` against real Redis produces a `redis`-named span through an in-memory
  exporter with the rest of the repo's 0.220-train OTel packages installed. If it produces no span,
  the arm does not ship and the plan is amended (the deliverable becomes the documented decision) —
  it is not shipped untested.

### 3.8 CLI: `--redis-client ioredis|node-redis`

- **Decision:**
  - **Flag and prompt.** `setu new` and `setu add` accept `--redis-client <ioredis|node-redis>`
    (default `ioredis`). It applies only when a Redis arm is selected (`--broker redis`,
    `--queue redis`, `--transport redis`, or `setu add` of a plugin whose arm resolves to Redis);
    otherwise it is refused with a named message, as `--transport-url` is without a broker.
    `setu generate app` refuses it with the same guidance as the other transport flags, and
    `setu add` inside a workspace member refuses it as it refuses `--broker` (`add.ts:1242–1246`:
    members share the workspace transport). On `--runtime cloudflare-workers` it is refused (Workers
    already refuses Redis arms). The interactive `setu new` asks "Redis client?" (ioredis /
    node-redis) only after a Redis broker or queue was chosen.
  - **Workspace.** `setu new --workspace --transport redis --redis-client node-redis` records
    `redisClient: 'node-redis'` in the workspace manifest (absent = `ioredis`, so existing manifests
    read unchanged); `setu generate app` and member `setu add` read it.
  - **Rendering.** The Redis `TransportSpec` arm gains node-redis renderings of `messagingArgs`,
    `queueArgs`, `cacheArgs`, `schedulerArgs` and `backplaneArgs`, each replacing `url: <conn>` with
    `client: nodeRedisClient(<conn>)` — one client per plugin, because six consumers `quit()` their
    client at shutdown and a shared client would be closed under the others (§1). The backplane arm
    adds `subscriber: nodeRedisClient(<conn>)`. The clients list becomes `['redis']` instead of
    `['ioredis']`, including `add.ts:1072`'s hardcoded fallback. `CLIENT_RANGES` gains
    `redis: '6.x'` and `scripts/node-dependency-ranges.ts` gains `redis: '6.x'` and
    `@opentelemetry/instrumentation-redis: '^0.69.0'` (`client-dependencies.test.ts` holds the two
    tables equal); Deno import maps get `npm:redis@6.x`.
  - **Imports (amended during the run-3 takeover).** The client is built in a generated
    project-local module `src/node-redis.ts` (`templates/node-redis.ts`), which imports
    `fromNodeRedis` from `@setu-ts/common` and `createClient` from `redis` and exports
    `nodeRedisClient(url)`; `setu.config.ts` imports it relatively. The first design put
    `import { createClient } from 'redis'` in `setu.config.ts`, and the configuration classifier
    (`devtool/sources.ts` `isRecognizedSpecifier`, audited) accepts only framework and relative
    imports — measured: a fresh node-redis scaffold drew false `setu.W001` "config is
    unclassifiable" warnings from its own `setu check`, and a second `setu add` stopped wiring
    automatically. The classifier is left unchanged. `setu add` writes the module when it is missing
    (on a real install, as the barrels are), inserts the relative import when the config lacks it,
    falls back to guidance when `nodeRedisClient` is already bound some other way, and prints the
    import line with any guidance that names the call. A member of a workspace whose manifest stores
    an unknown `redisClient` is refused by `setu add` before the member check (`app-loader.ts`
    `unknownWorkspaceRedisClient`), since an unreadable manifest otherwise reads as "not a member".
  - **Default unchanged.** Every `ioredis` output stays byte-identical: the existing snapshot/golden
    assertions for `--broker redis`, `--queue redis`, `--transport redis` and `setu add` pass
    untouched, and no new key appears in an ioredis workspace manifest.
  - **Manifests.** Dependencies are written through the existing `withClientDependencies` and
    M119f's `setu add` writer — no new manifest logic; the checklist shapes stay covered by those
    writers' tests plus one `redis` case.
- **Why:** maintainer decision 2026-10-29 (CLI in M117); ROADMAP rule "one Redis client per
  scaffolded project".
- **Test home:** flag/refusal and prompt unit tests; transport-arm rendering tests (node-redis
  literals as data per plugin); `configModule` import-order test; manifest parse/write tests for
  `redisClient`; guarded e2e (§3.9).

### 3.9 Real-Redis proof for every consumer, and CI

- **Decision:** each guarded real-Redis suite listed in §1 becomes a table over two clients —
  `ioredis` (as today) and `fromNodeRedis(createClient(...))` — and node-redis runs twice, default
  (RESP3) and `RESP: 2`. The scenarios, reads-back and outage assertions are the SAME code for both;
  nothing is weakened for node-redis. Specifically: messaging redelivery/inbox/outbox/outage and the
  M75 header conformance; backplane cross-instance delivery and outage; queue atomic transitions,
  lease and prefix; cache, scheduler, auth and idempotency read-back and outage. The outage tests
  keep each suite's EXISTING assertions for every client (amended after Codex run 1: a suite whose
  app registers no error handler answers the kernel's default `500` for both clients; what it proves
  is the classified store error, the failure counter and the `down` health indicator, and those hold
  for node-redis exactly as for ioredis). The Redis inbox/outbox scenarios also need
  `OUTBOX_POSTGRES_URL` and run with it during verification. `redis` `^6` and `ioredis` are dev
  dependencies of each package whose tests import them; no `src` file imports `redis` or `ioredis`
  for this. CI already sets `REDIS_URL` for these jobs. The CLI's guarded e2es
  (`broker-scaffold-e2e`, `full-stack-broker-e2e`, `workspace-mesh-e2e`) gain a node-redis variant
  for every runtime its ioredis variant covers, which installs, type-checks, boots against real
  Redis with the generated task's own permissions (E8) and requests the endpoints the ioredis
  variant requests (health `up`, a message round-trip where that variant has one).
- **Why:** ROADMAP deliverable; M75's lesson — a fake's reply nesting hid a dead delivery path.
- **Test home:** the suites named above.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `common` gains exports; `InstrumentationKind` widens (a union
used as input); `IRedisLockClient.eval`'s return widens to `unknown` (C4 — any injected client still
satisfies it); `isConnectionFault` classifies MORE values as outages (only node-redis's own messages
and pattern). Ships in minor 0.11.0.

| Exported symbol                         | Kind                                | Consumer / real code path that READS it                                                                                    |
| --------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `fromNodeRedis`                         | function                            | applications and CLI-generated `setu.config.ts` (§3.8), passing it to the seven `client` options; real-Redis suites (§3.9) |
| `NodeRedisClientLike`                   | type                                | `fromNodeRedis`'s parameter; an application typing a helper that builds the client                                         |
| `NodeRedisAdapterOptions`               | type                                | `fromNodeRedis`'s second parameter                                                                                         |
| `NodeRedisAdapter`                      | type                                | `fromNodeRedis`'s return; the per-facade assignability assertions                                                          |
| `TelemetryInstrumentationsConfig.redis` | option (existing type gains member) | `instrumentation-registry.ts` dispatch → `loadRedisInstrumentation`                                                        |

### 4.1 Options — every option names its consumer

| Option                                     | Consumer                                              | Behavior (per implementation)                                                                     |
| ------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `NodeRedisAdapterOptions.commandTimeoutMs` | `#command` and the lazy connect / `quit` (§3.3, §3.4) | bound per call; `0` none; invalid → `TypeError`                                                   |
| `NodeRedisAdapterOptions.onError`          | the attached `'error'` listener (§3.4)                | called with each client `'error'` event; absent → listener present but silent                     |
| `instrumentations.redis`                   | telemetry registry (§3.7)                             | `true` or an `InstrumentationConfig`; Node only, as for `ioredis`                                 |
| CLI `--redis-client`                       | `new`, `add` (§3.8)                                   | selects the node-redis renderings; refused without a Redis arm, on Workers, and on `generate app` |
| Workspace manifest `redisClient`           | `generate app`, member `setu add` (§3.8)              | `'node-redis'` or absent (= ioredis); any other value refused by the manifest parser by name      |

## 5. Implementation files

| File                                                                                                                                                                                                                 | Purpose                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/common/src/redis/node-redis-adapter.ts` (new)                                                                                                                                                              | `fromNodeRedis`, the adapter class, option validation, the command bound, lifecycle                 |
| `packages/common/src/redis/resp3.ts` (new)                                                                                                                                                                           | internal: map-reply normalization (§3.2); NOT exported from `src/index.ts`                          |
| `packages/common/src/errors/connection-fault.ts`                                                                                                                                                                     | E4 messages and the socket-timeout pattern (§3.6)                                                   |
| `packages/common/src/index.ts`                                                                                                                                                                                       | export `fromNodeRedis`, `NodeRedisClientLike`, `NodeRedisAdapterOptions`, `NodeRedisAdapter`        |
| `packages/telemetry-plugin/src/interfaces/index.ts`, `instrumentation/database-instrumentation.ts`, `instrumentation/instrumentation-registry.ts`, `plugin/telemetry-plugin.ts`, `package.json`                      | the `redis` arm (§3.7); optional peer + dev dependency                                              |
| `packages/cli/src/flags.ts`, `commands/new.ts`, `commands/new-interactive.ts`, `commands/add.ts`, `commands/app.ts`                                                                                                  | `--redis-client` flag, refusals, prompt, member reads (§3.8)                                        |
| `packages/cli/src/workspace/transport.ts`, `workspace/manifest.ts`                                                                                                                                                   | node-redis renderings of the Redis arm; `redisClient` field                                         |
| `packages/cli/src/templates/broker.ts`, `templates/client-dependencies.ts`, `templates/project-files.ts`, `templates/registry.ts`                                                                                    | rendering selection, `redis` range, `externalImports`                                               |
| `packages/realtime-backplane-plugin/src/interfaces/index.ts`, `src/transports/redis-backplane.ts`                                                                                                                    | `connect?` on `IRedisBackplaneClient`; `#open` connects an injected `'wait'` client (§3.4, amended) |
| `packages/scheduler-plugin/src/interfaces/index.ts`                                                                                                                                                                  | C4: `IRedisLockClient.eval` returns `Promise<unknown>`                                              |
| `scripts/node-dependency-ranges.ts`                                                                                                                                                                                  | `redis` and `@opentelemetry/instrumentation-redis` ranges (§3.8)                                    |
| `packages/common/src/services/diagnostics.ts`, `packages/diagnostics-plugin/src/protocol/trace-protocol.ts`                                                                                                          | `'redis'` in `TraceInstrumentationKind` and the trace-protocol allowlist (§3.7, amended)            |
| `packages/{cache,queue,messaging,realtime-backplane,scheduler,idempotency,auth}-plugin/package.json`                                                                                                                 | `redis` dev dependency for the real-Redis suites                                                    |
| READMEs (common, the seven consumers, telemetry, cli), `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`, the messaging/caching/realtime guides under `docs/`, `ROADMAP.md`, `CLAUDE.md` status, `plans/archive/` | docs (§2), status flip and plan archive in this PR                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                             | src covered                                                   | Key assertions (and the signature each call type-checks against)                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/test/unit/node-redis-adapter.test.ts`                                                                                                                | `redis/node-redis-adapter.ts`                                 | translation table (method + args → `sendCommand` array) as data; bound; lazy connect memo; quit/close/destroy; status; error listener; pub/sub registry; option refusals (`fromNodeRedis(client, options?)`) |
| `packages/common/test/unit/node-redis-types.test.ts`                                                                                                                  | type-level, real `redis` types                                | `fromNodeRedis(createClient())` and `fromNodeRedis(createClient({ RESP: 2 }))` compile (`redis` dev dependency of `common`)                                                                                  |
| `packages/common/test/unit/resp3.test.ts`                                                                                                                             | `redis/resp3.ts`                                              | object and `Map` inputs, nested maps, `XREADGROUP` pairs, pass-through scalars                                                                                                                               |
| `packages/common/test/unit/connection-fault.test.ts`                                                                                                                  | `errors/connection-fault.ts`                                  | E4 table incl. `WRONGTYPE` false and a different-ms socket-timeout message                                                                                                                                   |
| `packages/common/test/integration/node-redis-adapter-real.test.ts` (guarded `REDIS_URL`)                                                                              | adapter against real Redis                                    | every translated command's reply under RESP3 and RESP2 equals ioredis's for the same command                                                                                                                 |
| `packages/{cache,queue,messaging,realtime-backplane,scheduler,auth}-plugin/test/integration/*-real.test.ts`, `idempotency-plugin/test/integration/redis-real.test.ts` | the consumers through the adapter                             | the §3.9 two-client tables; reads-back; outage `503` + health `down`                                                                                                                                         |
| `packages/{each consumer}/test/unit/node-redis-assignable.test.ts`                                                                                                    | type-level                                                    | `const c: <Facade> = fromNodeRedis(fake)` compiles for each of the seven facades                                                                                                                             |
| `packages/realtime-backplane-plugin/test/unit/redis-backplane.test.ts` (extended)                                                                                     | `transports/redis-backplane.ts`                               | an injected `'wait'` client is connected once at open; a `'ready'` or connect-less client is not; a connect rejection fails open and leaves injected clients as they arrived                                 |
| `packages/scheduler-plugin/test/unit/*` (existing lock tests)                                                                                                         | `interfaces/index.ts` (C4)                                    | unchanged behaviour with the widened `eval` type                                                                                                                                                             |
| `packages/cli/test/unit/templates/client-dependencies.test.ts` (extended)                                                                                             | `client-dependencies.ts`, `scripts/node-dependency-ranges.ts` | `redis` present and equal in both tables                                                                                                                                                                     |
| `packages/telemetry-plugin/test/unit/instrumentation-registry.test.ts` (extended), `test/integration/redis-span-real.test.ts` (guarded)                               | telemetry arm                                                 | loader success/absence; dispatch; one real `redis` span from an adapter-driven command                                                                                                                       |
| `packages/diagnostics-plugin/test/unit/*trace-protocol*` (extended)                                                                                                   | `trace-protocol.ts`                                           | a batch whose instrumentations include `redis` is accepted                                                                                                                                                   |
| `packages/cli/test/unit/{flags,broker-flags,new-interactive,commands/add,workspace/manifest,workspace/transport,full-stack-template,plugin-args}.test.ts` (extended)  | CLI files in §5                                               | flag acceptance/refusals; prompt only after a Redis choice; node-redis literals per plugin as data; `externalImports` order; manifest `redisClient` parse/write; ioredis output unchanged                    |
| `packages/cli/test/e2e/{broker-scaffold,full-stack-broker,workspace-mesh}-e2e.test.ts` (extended, guarded)                                                            | generated projects                                            | node-redis variant installs, type-checks, boots on real Redis, endpoints answer as for ioredis                                                                                                               |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m117-node-redis-support, never develop/main
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
REDIS_URL=redis://127.0.0.1:6379 pnpm test:coverage common cache-plugin queue-plugin messaging-plugin realtime-backplane-plugin scheduler-plugin idempotency-plugin auth-plugin telemetry-plugin cli
pnpm run ci:local          # on the final commit, alone on the machine
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.10.0
```

## 8. Risks & mitigations

- A RESP3 reply shape the facades read that the probes missed → every real-Redis suite runs under
  RESP3 and RESP2 with identical assertions (§3.9).
- A hung node-redis call never bounded → the adapter's own timer (§3.3), proven by `docker pause`
  per consumer.
- An outage answering `500` → E4 classification plus outage tests asserting `503` with both clients.
- The process crashing on an unlistened `'error'` → the adapter always attaches a listener (§3.4).
- A shared client closed under other plugins → one client per plugin in generated code (§3.8).
- The OTel arm not tracing v6 → the real-span test decides whether it ships (§3.7).
- A Deno node-redis project failing on env access → generated tasks grant `--allow-env` (E8) and the
  Deno e2e variant boots with the task's own permissions.
- The adapter's types claiming more than the server guarantees → per-method return types from the
  facades, `eval` widened rather than narrowed (C4), real-type compile test.
- ioredis scaffolds changing → existing golden assertions untouched, plus a byte-identity test.

## 9. Out of scope

- node-redis cluster and sentinel clients; Valkey Glide.
- Neutral (non-ioredis) facade shapes (§2 C3).
- Making node-redis the default client anywhere.

## 10. Design security review

| Change                          | Trust boundary            | Threat considered                                                                              | Mitigation in design                                                                       |
| ------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| §3.1–3.2 adapter, normalization | data from Redis           | a reply shape that makes a parser misread a message (delivery, idempotency replay)             | normalization limited to map replies; identical real-Redis assertions under both protocols |
| §3.3 command bound              | availability              | a hung call holding a request or shutdown forever                                              | own timer, default 15 s; close falls back to destroy                                       |
| §3.6 classifier                 | error disclosure / status | a programming or command error reported as `503`, hiding a bug; or an outage reported as `500` | exact measured messages and one anchored pattern; `WRONGTYPE` negative case                |
| §3.8 CLI                        | generated code            | a generated project shipping a crashing or unbounded client                                    | generated code always goes through `fromNodeRedis` (bound + error listener)                |

No credentials, tokens or user data cross a new boundary; a committed-tree security audit is not
required beyond the standard review. (If review finds otherwise, a fresh Claude agent audits per
`.roo/skills/security-audit/SKILL.md`.)
