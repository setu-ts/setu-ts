# Local Diagnostics Protocol v1

The wire protocol between the local diagnostics connector (`@setu-ts/diagnostics-plugin`) and its
native client (`createDiagnosticsClient`). This document is the specification the protocol fixtures
under `packages/diagnostics-plugin/test/fixtures/` pin, and the starting point for the separately
maintained devtool's implementation.

The design security review for this protocol — its assets, attackers, approved budgets, design
findings and the obligations a committed-tree audit must meet — is
[`diagnostics-security-review.md`](./diagnostics-security-review.md). Standard primitives are not
that review, and this document makes no claim that the separately maintained devtool has been
verified.

## Transport

- A runtime-owned HTTP listener on IPv4 loopback (`127.0.0.1`) only, on a developer-chosen port in
  `1024`–`65535`. Deno only in v1; every other platform refuses activation.
- Bounded polling only — no long polling, no SSE, no WebSockets, no redirects, no upgrades.
- Zero-body policy: any `Transfer-Encoding`, any `Content-Length` other than absent or exactly `0`,
  and any comma inside the coalesced value of `Host`, `X-Setu-Session`, `X-Setu-Sequence`,
  `X-Setu-Instance`, or `X-Setu-Mac` is refused BEFORE framework mapping. (The comma proves a
  duplicate header line; the fetch layer coalesces duplicates, so the raw-wire multiplicity is not
  preservable and no claim is made that it is.)

## Operations

| Target                                  | Answer                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/status`                        | `{ version: 1, instanceId, expiresInMs, inspectors, renewal? }` — binds the session; `renewal` is present only when the application opted in (below)   |
| `GET /v1/renew`                         | Extends the same authenticated session within its activation-time cap and returns `{ version: 1, instanceId, expiresInMs, maxRemainingMs }`            |
| `GET /v1/snapshot`                      | M98a's compact final snapshot JSON (not an envelope)                                                                                                   |
| `GET /v1/events?after=N&limit=N`        | M98a's frozen event batch; `after` is a canonical non-negative decimal, `limit` is 1–128, in exactly this order                                        |
| `GET /v1/health`                        | M98d's minimized health-observation snapshot (below)                                                                                                   |
| `GET /v1/config`                        | M98e's value-free configuration-provenance snapshot (below)                                                                                            |
| `GET /v1/queues?after=N&limit=N`        | M98f's merged queue-observation batch (below); the same canonical query grammar as `/v1/events`                                                        |
| `GET /v1/cache`                         | M98i's cache operation counters across every cache source (below)                                                                                      |
| `GET /v1/scheduler`                     | M98k's scheduler execution observations across every scheduler source (below)                                                                          |
| `GET /v1/traces?after=N&limit=N`        | M98g's completed-sampled-span observation batch (below); the same canonical query grammar as `/v1/events`                                              |
| `GET /v1/authorization?after=N&limit=N` | M98h's authorization-decision-explanation batch (below); the same canonical query grammar as `/v1/events`                                              |
| `GET /v1/event`                         | M98j's aggregated event-dispatch observation snapshot (below); a SNAPSHOT operation — no query is admitted, exactly like `/v1/health` and `/v1/config` |
| `GET /v1/realtime`                      | M98l's realtime lifecycle observations across every WebSocket, SSE and backplane source (below); a SNAPSHOT operation — no query is admitted           |
| `GET /v1/outbound-http`                 | M98n's outbound HTTP attempt counters across every observed-fetch helper (below); a SNAPSHOT operation — no query is admitted                          |
| `GET /v1/storage`                       | M98m's storage operation counters across every storage source (below); a SNAPSHOT operation — no query is admitted, exactly like `/v1/cache`           |

Everything else — unknown operations, extra path segments, percent-encoded aliases, reordered,
duplicated, or unknown query fields, non-canonical numbers (leading zeros), application or
diagnostic mutation operations, and write methods — is refused. Session renewal is the sole
operation whose purpose is to change connector state; it cannot change application or diagnostic
state.

## Required request headers

| Header            | Grammar                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `Host`            | exactly `127.0.0.1:<port>`; must match the URL authority                              |
| `X-Setu-Session`  | 32 lowercase hex characters                                                           |
| `X-Setu-Sequence` | canonical decimal safe integer starting at 1                                          |
| `X-Setu-Instance` | absent or empty ONLY on the initial status request; otherwise the bound instance UUID |
| `X-Setu-Mac`      | 64 lowercase hex characters                                                           |

Any `Origin` header — including the string `null` — is refused: this endpoint supports native
clients only, and no CORS permission is ever emitted. `Host`/`Origin` checks are additional
hardening, never authentication. The client uses `credentials: 'omit'`, sends no cookies, and
follows no redirects.

## MAC input

HMAC-SHA-256 over the UTF-8 encoding of newline-joined fields with NO final newline. The shared key
is never transmitted.

Request:

```text
setu-diagnostics-v1
request
<sessionId>
<instanceId-or-empty>
<sequence>
GET
127.0.0.1:<port>
<canonical-target>
```

Response (`<sequence>` is exactly the accepted request's value; there is no response counter):

```text
setu-diagnostics-v1
response
<sessionId>
<instanceId>
<sequence>
<canonical-target>
<HTTP-status-code>
<lowercase-hex-SHA-256-of-body-bytes>
```

Verification uses `subtle.verify`, never string equality. Request and response domain separation
(the second line) prevents reflection.

Every field's grammar excludes the line feed, which is what makes newline-joining an unambiguous
encoding: two different field sequences can never produce the same MAC input. A new operation must
keep that property for its canonical target.

## Replay, expiry, and binding

- Sequence numbers are strictly monotonic per session; the server atomically advances its highest
  accepted number after `subtle.verify` and re-checks revocation and expiry in the same synchronous
  gate. Replays and races cannot both pass.
- The initial expiry window uses the runtime's monotonic clock from activation (15 minutes default,
  1 ms–1 h range). An application may opt into renewal with `maxSessionLifetimeMs`, from the initial
  TTL through 43,200,000 ms (12 hours of awake time). Each accepted renewal keeps the same key,
  session ID, instance binding and sequence space and sets expiry to
  `max(current expiry, min(now + ttlMs, activation + maxSessionLifetimeMs))`. It never revives or
  shortens a session. Without the option, the status bytes and expiry behavior are unchanged.
- The first successful signed status exchange binds the session to M98a's non-null instance UUID;
  later requests must present exactly that ID, and an empty instance is never accepted after the
  initial exchange. Obtaining a UUID alone grants nothing.

## Response requirements

All responses (signed or refusals) carry `Cache-Control: no-store`,
`Content-Type: application/json`, and `X-Content-Type-Options: nosniff`. Signed responses add
`X-Setu-Mac` and `X-Setu-Instance`. The client verifies the response MAC over the exact bounded body
bytes (256 KiB hard ceiling on the STREAM, not `Content-Length`) BEFORE parsing anything, and checks
the parsed status body's `instanceId` against the authenticated header. Once paired, the client
binds EVERY later response to that identity: a signed response whose `X-Setu-Instance` differs from
the instance the request presented is refused, and every body that carries an `instanceId` — the
core snapshot and event batch included — must equal it (a paired network body never carries `null`).
The MAC alone does not establish this, because the header identity is an input to the MAC: a peer
holding the session key could otherwise sign a response under any identity. Such a refusal is the
fixed connection failure, and — like any post-pairing verification failure — it is not terminal.

A verified body is authentic, not necessarily well-formed, so the client then checks it against its
exact DTO before returning it. For the core snapshot that means only the defined keys, `state` and
`failureCode` from their fixed vocabularies, at most 1,024 nodes and 4,096 edges, each node carrying
only its kind's fields under a unique id minted with its kind's prefix (`p`, `c`, `r`, `m`), labels
of at most 160 UTF-8 bytes with no control character, and every edge joining two nodes in the same
snapshot, once. For the event batch it means at most 128 events, each with only the defined keys,
every enum from its vocabulary, canonical `op<N>` and node ids, finite non-negative (or `null`)
timings, a finite numeric status code and validated W3C identifiers; consecutive sequences with
`next` equal to the last; and the cursor the request sent honored — an empty page echoes `after`
with `lost: 0`, and a returned page starts past `after` with `lost` counting exactly the unreadable
gap — records evicted from the ring, or discarded when a start failed. Every returned result is
deeply frozen. Two fields are deliberately left as the DTO types them — a plain, unranged `number`:
a middleware `priority` and an event `statusCode`, which the application sets. Either may be any
finite number (a status is not necessarily a valid HTTP status), so an application's unusual
priority or status never turns its own diagnostics into a refusal; the kernel omits a non-finite
value rather than letting it serialize to `null`, and the client refuses `null`.

Unauthenticated refusals are not signed and use one fixed shape:

```json
{ "version": 1, "error": "invalid-request" }
```

| Code                  | Status | When                                                                                             |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `invalid-request`     | 400    | structural/grammar/framing violation, or an authenticated operation the session does not support |
| `unauthorized`        | 401    | wrong session, wrong key, wrong instance, replay                                                 |
| `expired`             | 401    | monotonic expiry reached, or revocation landed while a request was in flight                     |
| `unsupported-version` | 400    | source DTO version is not 1                                                                      |
| `unavailable`         | 503    | internal failure or an over-limit result                                                         |
| `rate-limited`        | 429    | refusal budget exhausted or session budget spent                                                 |

No refusal ever echoes supplied input, error causes, or stacks. A wrong key, a wrong instance and a
replay are all the same `unauthorized` while the session is live (a replay is refused by the
post-MAC sequence gate). Once the session has expired, a replay whose MAC verifies is answered
`expired`, like any other MAC-valid request. `expired` is answered only to a request whose MAC
verified, so an unauthenticated prober cannot learn whether a session is live or has ended. One
admission exception: a session-ID mismatch is refused before MAC verification and debits the
anonymous refusal budget, so once that budget is exhausted a wrong session ID answers `rate-limited`
while the matching session ID with an invalid MAC answers `unauthorized`. That confirms only a
candidate session ID; it reveals nothing about whether the session is live or has ended (see the
design security review, R7).

## Session renewal (M98o)

Renewal is opt-in. A renewable signed status body adds exactly:

```json
"renewal": { "maxRemainingMs": 28799000 }
```

For that body, `expiresInMs` and `maxRemainingMs` are non-negative safe integers measured from one
monotonic-clock reading, with `expiresInMs <= maxRemainingMs`. A status without renewal retains the
pre-M98o numeric `expiresInMs` contract, including fractional monotonic values. `renewal` is valid
only beside the exact `inspectors` manifest; it is not admitted on the legacy three-field status.

`GET /v1/renew` passes every ordinary authentication, sequence, budget, and bound-instance gate
before it mutates the expiry. A disabled renewal is therefore refused only after authentication as
`invalid-request`; a wrong instance remains `unauthorized`; expiry remains terminal. The response
uses the exact four-field DTO shown in the operations table, and both lifetime values obey the same
safe-integer and inequality rules. The native client never parses an unsigned refusal body:
`session()` obtains a fresh signed status lifetime, while `renew()` sends no renew request when the
paired status did not advertise support.

## Health observations (M98d)

`GET /v1/health` is the first inspector operation. The status body's `inspectors` manifest names
every inspector the connector knows and whether it is implemented; the connector serves
`health: true` (M98d), `configuration: true` (M98e), `queues: true` (M98f), `traces: true` (M98g),
`cache: true` (M98i), `authorization: true` (M98h), `events: true` (M98j), `scheduler: true` (M98k),
`realtime: true` (M98l), `storage: true` (M98m) and `outboundHttp: true` (M98n) — every key is now
implemented. A client that reads a legacy M98b three-field status body (no `inspectors`) resolves
the manifest to all-`false`, so its `health()`, `configuration()`, `queues()`, `traces()`,
`cache()`, `authorization()`, `events()`, `scheduler()`, `realtime()`, `storage()` and
`outboundHttp()` answer a typed `unsupported` without sending the request.

The answer is the health plugin's minimized `HealthDiagnosticsSnapshot` — the same frozen DTO the
plugin registers under `CAPABILITIES.HEALTH_DIAGNOSTICS`, projected field-by-field:

```json
{
  "version": 1,
  "instanceId": "<bound instance UUID>",
  "state": "ready",
  "observations": [
    {
      "indicatorAlias": "database",
      "status": "up",
      "state": "reported",
      "latencyMs": 3,
      "ageMs": 12,
      "origin": "application"
    }
  ],
  "truncated": false,
  "droppedObservations": 0
}
```

`state` is the inspector's coarse availability: `unsupported` (no health plugin is registered — the
connector's answer), `disabled` (a health plugin without the `diagnostics` option registers a source
that answers this — the plugin's answer), `no-data` (opted in, nothing captured yet), `ready`,
`stale`, or `collection-failed` (the source threw, or its DTO failed the exact validator the
connector runs before signing; the answer is value-free, never a fault that changes the
application's readiness). Each observation carries only the approved display alias, the framework's
own status (present only when `reported`), the outcome state, and monotonic `latencyMs`/`ageMs`. No
indicator `data`, no error text, and no absolute time is admitted. The response is signed and
bounded exactly like every other operation: the MAC covers the exact body bytes, and the parsed
`instanceId` must equal the authenticated header.

## Configuration provenance (M98e)

`GET /v1/config` serves the config plugin's value-free provenance snapshot — the same frozen DTO the
plugin registers under `CAPABILITIES.CONFIG_DIAGNOSTICS`, projected field-by-field:

```json
{
  "version": 1,
  "instanceId": "<bound instance UUID>",
  "state": "ready",
  "entries": [
    {
      "keyAlias": "port",
      "origin": "environment",
      "overriddenSourceAliases": ["dotenv", "dotenv-local"],
      "expanded": false,
      "referenceAliases": [],
      "schemaEffect": "validated"
    },
    {
      "keyAlias": "api-url",
      "origin": "file",
      "sourceAlias": "dotenv-local",
      "overriddenSourceAliases": ["dotenv"],
      "expanded": true,
      "referenceAliases": ["host"],
      "schemaEffect": "validated"
    }
  ],
  "truncated": false,
  "droppedEntries": 0
}
```

`sourceAlias` may ride only a `file` origin, and only when the exact configured path was approved.
`origin` is `environment`, `file`, or `unknown`; `unknown` has exactly two producers — an opaque
injected `IConfig` instance (reported with schema effect `unknown`, honestly, with no presence flag
and no read of the instance), and a key present only after schema parsing (effect `introduced`,
which reports the appearance and never names a mechanism — a default and a transform are
indistinguishable by presence). No configuration value, value hash, value length, raw key name, or
file path is ever carried: only application-approved display aliases, the evidenced precedence and
expansion relationships between them, and the presence-derived schema effect. `droppedEntries`
counts only entries omitted by the 256 KiB budget — unapproved keys are never observed at all, so no
counter discloses that they exist. The response is signed and bounded exactly like every other
operation. The connector and the client run one exact validator, and it refuses a C0/C1 control
character in any alias (as the health and queue validators do), whoever registered the source; the
connector also re-checks the instance binding on the projected copy it signs.

## Queue observations (M98f)

`GET /v1/queues?after=N&limit=N` pages minimized queue attempt observations and returns every queue
source's status and latest depths in the same body. Every QueuePlugin instance contributes one
`IQueueDiagnosticsSource` under `CAPABILITIES.QUEUE_DIAGNOSTICS` as a MULTI provider (never claimed
in `provides`, so named instances cannot collide); the connector reads every source registered when
it bootstraps, in registration order, and reads at most 16 of them. A client whose negotiated
manifest has `queues: false` — including one paired against a legacy three-field status body —
answers a frozen typed `unsupported` batch echoing its cursor, without sending the request.

```json
{
  "version": 1,
  "instanceId": "<bound instance UUID>",
  "state": "ready",
  "sources": [
    {
      "sourceId": "q1",
      "state": "ready",
      "instanceAlias": "mailer",
      "depthCoverage": "complete",
      "failure": "none",
      "lost": 0,
      "droppedAttempts": 0,
      "evictedJobAliases": 0
    }
  ],
  "events": [
    {
      "sequence": 1,
      "sourceId": "q1",
      "instanceAlias": "mailer",
      "queueAlias": "emails",
      "jobAlias": "j1",
      "attempt": 1,
      "durationMs": 4,
      "outcome": "completed",
      "settlement": "acknowledged",
      "ageMs": 10
    }
  ],
  "depths": [
    {
      "sourceId": "q1",
      "instanceAlias": "mailer",
      "queueAlias": "emails",
      "ready": 2,
      "processing": 1,
      "dead": 0,
      "scope": "process-local",
      "coverage": "complete",
      "ageMs": 5
    }
  ],
  "next": 1,
  "lost": 0,
  "truncatedSources": 0,
  "truncatedDepths": 0
}
```

**The cursor.** M98b permits one paired session, so the CONNECTOR keeps one internal cursor per
source. Each authenticated queue read first drains every source's newly captured attempts into a
connector-owned merge ring of 1,024 events, in source registration order, and then serves the
requested page of that ring. `after`/`next`/`lost` follow M98a's cursor contract exactly: `after` is
exclusive, `after: 0` is not special-cased, a cursor older than the oldest retained event returns
the oldest retained events with the gap `first - after - 1` reported as `lost`, an empty page echoes
its cursor, and a cursor beyond the merge sequence is refused `invalid-request`. The merge sequence
orders drains, not wall-clock completion across sources.

**Two rings, four counters.** A source's own 1,024-attempt ring can wrap between two connector reads
— a busy queue outrunning the poller. That loss is accumulated onto THAT source's status `lost`,
never folded into the batch's `lost`, which counts merge-ring eviction only; so an unbroken merge
sequence never reads as complete coverage. `truncatedSources` counts sources beyond the 16-source
bound, and `truncatedDepths` the depth observations omitted to keep the frame inside the 256 KiB
budget (only depths are ever trimmed — events are pageable, and the frame with no depths is bounded
far below the budget).

**Fields.** `state` is `unsupported` when no queue source is registered, otherwise `ready`. A
source's `state` is `disabled` (a QueuePlugin without the `diagnostics` option), `no-data`, `ready`,
or `collection-failed` (the connector could not read or validate it — with the fixed failure
`source-read-failed`). `outcome` is `completed`, `retryable-error` or `terminal-error`; `settlement`
is reported only AFTER the adapter's settlement call returned — `acknowledged`, `requeued`,
`dead-lettered`, `failed` (the call rejected), or `unknown` (the call completed on an adapter that
cannot confirm it: RabbitMQ, SQS). An outcome is never presented as settlement proof. Depths come
only from a separately opted-in, bounded, non-overlapping count cycle — a diagnostic read never
counts, reserves or settles a job; `scope` is `process-local` (memory) or `shared-backend` (redis,
never to be summed across sources or replicas), and a source whose adapter cannot count reports
`depthCoverage: 'unavailable'`, never zero.

**Minimization.** The queue source receives only a job name (allowlist lookup), a raw job id (alias
lookup) and the attempt number at dispatch, and fixed outcome and settlement primitives afterwards.
The wire therefore carries approved aliases, session-local `j<N>` job aliases and fixed-vocabulary
values only — never a payload, header, raw id, claim token, credential, queue URL or error. A source
is untrusted input to the connector: its batch is validated key-by-key (aliases 1–64 UTF-8 bytes
with no control character) before anything is merged, and the merged frame runs the same exact
validator the client runs before it is signed.

## Cache observations (M98i)

`GET /v1/cache` (no query) answers
`{ version: 1, instanceId, state, sources: [{ sourceId, snapshot }] }` over every
`ICacheDiagnosticsSource` registered under `CAPABILITIES.CACHE_DIAGNOSTICS`. Every CachePlugin
instance registers one as a multi provider (never in `provides`); the connector resolves them ONCE
at bootstrap, in registration order, and REFUSES to start with more than 16 (a fixed, value-free
configuration error, never a silent drop). Sources are read only after the request authenticated;
`sourceId` is the session-local `s1`…`s16`.

A snapshot is exactly `{ state, alias, coverage: 'owned-instance', records, dropped }`; `alias` is
`null` when the plugin was not opted in (`state: 'disabled'`). A record is exactly
`{ alias, operation, count, lastDurationMs, ageMs, succeeded, failed, hits, misses, present, absent,
removed, notRemoved }`
for one of the five backend operations `get`, `set`, `delete`, `has`, `clear` (a `getOrSet` is
counted as its internal `get`/`set` calls). Every settled call increments `count` and exactly one of
`succeeded`/`failed`; the detail counters count only successful calls of their operation. There is
no eviction counter — a miss is never reported as an eviction.

Each source is untrusted input: only a plain object (`Object.prototype` or `null` prototype) of own
DATA properties is admitted, each field read once through its descriptor (a getter is never
invoked), lists read by index, at most 64 records, exact keys and enums, unique operations,
non-negative safe-integer counters. A source that throws or fails any check is reported as a fixed
`{ state: 'collection-failed', alias: null, records: [], dropped: 0 }` — no error text. Duplicate
non-null aliases across sources, or a response over 256 KiB, collapse the whole response to
`{ state: 'collection-failed', sources: [] }`; a partial document is never produced. The aggregate
`state` is `unsupported` with no source, otherwise the first of `ready`, `collection-failed`,
`stale`, `no-data`, `disabled` present. The client runs the same validator; a manifest with
`cache: false` answers a local typed `unsupported` response without a request.

Keys, prefixes, values, Redis URLs, factory results and errors never reach the collector, the wire,
or the client. Only calls through the plugin's OWN `CacheService` are counted: direct store calls
and a replacement service registered later are outside coverage.

## Scheduler execution observations (M98k)

`GET /v1/scheduler` (no query) answers
`{ version: 1, instanceId, state, sources: [{ sourceId, snapshot }] }` over every
`ISchedulerDiagnosticsSource` registered under `CAPABILITIES.SCHEDULER_DIAGNOSTICS`. Every
SchedulerPlugin instance registers one as a multi provider (never in `provides`); the connector
resolves them ONCE at bootstrap, in registration order, and REFUSES to start with more than 16 (a
fixed, value-free configuration error, never a silent drop). Sources are read only after the request
authenticated; `sourceId` is the session-local `s1`…`s16`.

A snapshot is exactly `{ state, alias, coverage: 'owned-instance', records, dropped }`; `alias` is
the configured SOURCE alias, `null` when the plugin was not opted in (`state: 'disabled'`). A record
is exactly
`{ alias, operation, count, lastDurationMs, ageMs, started, succeeded, failed,
contended, lockFailed, retryAttempts, lastLatenessMs }`
for one of the two observations `fire` and `attempt`, keyed by (job alias, operation) — at most 64
tuples per source. A NEW tuple at capacity first reclaims every expired slot; only when none is free
is it ignored, counting ONE saturating `dropped` per ignored observation (a refused attempt is one
drop, not two). On a `fire` record the counters describe local timer fires: `started` dispatched,
`contended` skipped because a fire slot or the overlap mutex was held elsewhere (or a delay's
registration slot belonged to another replica), `lockFailed` skipped because a lock operation
rejected, `succeeded`/`failed` the dispatch settlement; `lastLatenessMs` is
`max(0, actualStart - intendedFire)` of the last fire, rounded to integer milliseconds (a
`delay`/`every` time may be fractional), and `retryAttempts` is nonapplicable and `0`. On an
`attempt` record they describe handler invocations (a behaviour that declines a dispatch records
none); `contended`/`lockFailed`/`lastLatenessMs` are nonapplicable and `0`. `count` counts settled
observations, and `started` never falls below it: an attempt whose record expired while its handler
ran is counted as started in the record that receives its settlement; every counter saturates at
`Number.MAX_SAFE_INTEGER`; records expire after 60 seconds without an observation (age >30 s means
the snapshot is `stale`). A skipped local fire is never a globally missed execution, and no missed
counter exists.

Each source is untrusted input: only a plain object (`Object.prototype` or `null` prototype) of own
DATA properties is admitted, each field read once through its descriptor (a getter is never
invoked), lists read by index, at most 64 records, exact keys and enums, unique (alias, operation)
tuples, non-negative safe-integer counters. A source that throws or fails any check is reported as a
fixed `{ state: 'collection-failed', alias: null, records: [], dropped: 0 }` — no error text.
Duplicate non-null SOURCE aliases across sources, or a response over 256 KiB, collapse the whole
response to `{ state: 'collection-failed', sources: [] }`; a partial document is never produced. The
aggregate `state` is `unsupported` with no source, otherwise the first of `ready`,
`collection-failed`, `stale`, `no-data`, `disabled` present. The client runs the same validator; a
manifest with `scheduler: false` answers a local typed `unsupported` response without a request.

Job names, cron expressions, payloads, job ids, lock keys and tokens, and thrown values never reach
the collector, the wire, or the client. Only fires of and attempts by the plugin's OWN
`SchedulerService` are observed — a replacement service registered under the scheduler token is
outside coverage, and a read never acquires a lock, invokes a handler, or reads the job registry.

## Storage observations (M98m)

`GET /v1/storage` (no query) answers
`{ version: 1, instanceId, state, sources: [{ sourceId, snapshot }] }` over every
`IStorageDiagnosticsSource` registered under `CAPABILITIES.STORAGE_DIAGNOSTICS` — the same aggregate
shape, the same `s1`…`s16` session-local ids, and the same more-than-16-refuses-startup rule as the
M98i cache operation. Every StoragePlugin instance registers one as a multi provider (never in
`provides`); the connector resolves them ONCE at bootstrap, in registration order. Sources are read
only after the request authenticated.

A snapshot is exactly `{ state, alias, coverage: 'owned-instance', records, dropped }`; `alias` is
`null` when the plugin was not opted in (`state: 'disabled'`). A record is exactly
`{ alias, operation, count, lastDurationMs, ageMs, succeeded, failed, lastBytes }` for one of the
six public operations `put`, `get`, `delete`, `exists`, `getSignedUrl`, `getStream`. Every settled
call increments `count` and exactly one of `succeeded`/`failed`. `getSignedUrl` is a URL mint, not a
data transfer: `lastDurationMs` and `lastBytes` are `null` for it. `lastBytes` is the byte length of
the last settled buffer for the buffered operations `put` and `get` (a `get` that finds nothing
settles as a failure and carries `null`), and `null` for the non-buffered operations `delete`,
`exists`, `getStream`. A `getStream` counts the open, not the drain: the stream is handed to the
caller and its eventual consumption is outside coverage.

Each source is untrusted input: only a plain object (`Object.prototype` or `null` prototype) of own
DATA properties is admitted, each field read once through its descriptor (a getter is never
invoked), lists read by index, at most 6 records, exact keys and enums, unique operations,
non-negative safe-integer counters, and the per-operation nullability above. A source that throws or
fails any check is reported as a fixed
`{ state: 'collection-failed', alias: null, records: [],
dropped: 0 }` — no error text. Duplicate
non-null aliases across sources, or a response over 256 KiB, collapse the whole response to
`{ state: 'collection-failed', sources: [] }`; a partial document is never produced. The aggregate
`state` is `unsupported` with no source, otherwise the first of `ready`, `collection-failed`,
`stale`, `no-data`, `disabled` present. The client runs the same validator; a manifest with
`storage: false` answers a local typed `unsupported` response without a request.

Object paths, stored bytes, content types, signed URLs (the synthetic `memory://` URL encodes the
path) and error text never reach the collector, the wire, or the client. Only calls through the
plugin's OWN `StorageService` are counted: direct provider calls and a service constructed without
the collector are outside coverage.

## Trace observations (M98g)

`GET /v1/traces?after=N&limit=N` pages minimized completed-span observations from the
TelemetryPlugin's trace source — the ONE source registered under `CAPABILITIES.TRACE_DIAGNOSTICS`
(the kernel admits a single provider; the plugin registers it even when observation was not opted
into, answering `disabled`). When the built-in OTel provider is in use AND the application passed
the plugin's `diagnostics` option, an additional span processor — appended AFTER the exporter
processor in the same provider constructor — reduces every finished SAMPLED span to the approved
field set before anything is retained: only exact raw span names listed in the configured
`operations` map are observed, each replaced by its approved alias; identifiers are validated W3C
lowercase-hex (all-zero rejected); at most eight validated link identifier pairs are carried; kind,
outcome, duration and monotonic age are the only other fields. Span attributes, events, resource
labels, tracestate, baggage, exception data, status messages and the raw span name never enter the
record.

The batch carries `state` (`disabled` / `unsupported` / `no-data` / `ready`; `collection-failed` is
the connector's answer when the source threw or failed the exact validator), `coverage` (what
completed-span population the stack makes observable: `completed-sampled-spans`, `custom-provider`,
`noop-no-provider`, or `unknown` when the responder cannot describe one), `instrumentation` (the
Node-only auto-instrumentation families whose registry outcome reported enabled), `sampler` (the
configured description, or `unknown`), `records` under M98a's cursor contract (exclusive `after`,
per-batch `lost` from ring eviction, an empty page echoes its cursor, a cursor beyond the source's
sequence throws the fixed `RangeError` — surfaced as `invalid-request`), and a saturating
`droppedSpans` counter for spans refused before the ring. Parent relationships are IDENTIFIER
relationships only: `parentVisibility` names `observed` (the parent had already completed and been
retained in the same process when the child completed), `remote-or-unobserved` (including a local
parent that completes after its child, the ordinary nesting — join on `parentSpanId`), `root`, or
`unknown` — no edge is fabricated, and capture order is arrival order at one process, never a global
timeline. Cross-app correlation joins EQUAL trace ids across independently authenticated sessions;
identifiers grant no discovery or connection authority. With no trace source registered the batch is
`state: 'unsupported'` with `coverage: 'unknown'`; a client whose negotiated manifest has
`traces: false` answers that frozen batch, echoing its cursor, without sending the request.

## Authorization decision explanations (M98h)

`GET /v1/authorization?after=N&limit=N` pages minimized authorization-decision explanations from the
AuthPlugin's source — the ONE source registered under `CAPABILITIES.AUTHORIZATION_DIAGNOSTICS` (the
kernel admits a single provider; the plugin registers it even when observation was not opted into,
answering `disabled`). When the application passed the plugin's `authorizationDiagnostics` option,
an internal observer attached to the first-party `RbacService` reduces every evaluated check to the
approved field set BEFORE anything is retained: only application-approved role and permission
aliases (the M98d alias shape: 1–64 UTF-8 bytes, no control character, unique; at most 128 entries
per map), the fixed reason vocabulary, and the evaluation count actually performed. A compound that
short-circuits reports the steps it really took — a step list of at most 16 with the TRUE count in
`stepsEvaluated` and `stepsTruncated` `true` exactly when the evaluation ran more than 16 steps —
never a fabricated full sweep; a decision that evaluated exactly 16 steps is complete and reports
`false`. A compound's `ruleAliases` is the set of DISTINCT requested rules in first-requested order
(so at most 128), while `stepsEvaluated` counts every evaluated occurrence — a request repeating a
rule is evaluated once per repeat, so `stepsEvaluated` may exceed `ruleAliases.length`. Unevaluated
compound branches have no step at all, and a step never carries a rule name that was not approved.
Principal identifiers, role and permission VALUES, request paths, raw rules, credentials, claims,
resources and error text never enter the record. A decision whose requested rule lacks an approved
alias is dropped BEFORE buffering and counted in the saturating `droppedUnapproved` counter; partial
rule lists are never emitted. An unapproved GRANTING role never drops a decision — it is simply
omitted, so the decision carries no `viaRoleAlias`.

The batch carries `state` (`disabled` / `no-data` / `ready`; `unsupported` with `coverage`
(`rbac-not-configured` — no RBAC configured, `provider-identity-unavailable` — the registry lacks
the optional non-resolving `isCurrent` identity predicate, `custom-provider` — the current
`CAPABILITIES.AUTHORIZATION` provider is not the exact `RbacService` instance the plugin created, or
`unknown` when the responder cannot name a reason); `collection-failed` is the connector's answer
when the source threw or failed the exact validator), `decisions` under M98a's cursor contract
(exclusive `after`, per-batch `lost` from ring eviction, an empty page echoes its cursor, a cursor
beyond the source's sequence throws the fixed `RangeError` — surfaced as `invalid-request`),
`closed`, and `droppedUnapproved`. The source re-verifies its provider at read time through the
registry's optional `isCurrent?(token, instance)` — non-resolving, never instantiating a lazy
factory — and LATCHES `unsupported` terminal: it detaches, clears retained state, and never resumes
even if startup code later restores the old registration. A direct custom-service decision is never
guessed from booleans or status. With no source registered the batch is `state: 'unsupported'` with
`coverage: 'unknown'`; a client whose negotiated manifest has `authorization: false` answers that
frozen batch, echoing its cursor, without sending the request.

## Event dispatch observations (M98j)

`GET /v1/event` serves the events plugin's aggregated dispatch-observation snapshot — a SNAPSHOT
operation with no query, projected field-by-field from every source registered under the multi token
`CAPABILITIES.EVENTS_DIAGNOSTICS` (more than 16 refuses connector startup with a fixed configuration
error, the M98i cache rule). Note the path is one letter from the paged kernel-event stream
`/v1/events`; the manifest key `events` names THIS inspector:

```json
{
  "version": 1,
  "instanceId": "<bound instance UUID>",
  "state": "ready",
  "sources": [
    {
      "sourceId": "s1",
      "snapshot": {
        "state": "ready",
        "alias": "dev-bus",
        "coverage": "owned-instance",
        "records": [
          {
            "alias": "users",
            "operation": "publish",
            "count": 3,
            "started": 3,
            "succeeded": 3,
            "failed": 0,
            "noSubscribers": 1,
            "lastDurationMs": 2,
            "ageMs": 11
          }
        ],
        "dropped": 0
      }
    }
  ]
}
```

The events plugin registers its source whenever it is present — `disabled` without the `diagnostics`
option, otherwise the collector behind the bus. Opt-in collection reduces each dispatch to counters
BEFORE anything is retained: only event types whose exact raw name appears in the configured
`events` map are observed, each replaced by its approved alias; records aggregate per (alias,
operation) — `publish` (every publication, including no-subscriber ones) and `handler` (each
existing handler's await; async publication completion is not handler completion) — over a 64-slot
table with 60-second retention and a 30-second stale threshold. Event payloads, event ids, aggregate
ids, handler names, unapproved type names and error text never enter the record, and a saturating
`dropped` counter counts overflow refusals. `state` follows the shared vocabulary: `unsupported` (no
events plugin registered — the connector's answer), `disabled`, `no-data`, `stale`, `ready`, and
`collection-failed` — per source when that source throws (its snapshot is answered value-free) or
fails the exact validator, and for the WHOLE response (with NO sources listed) when two sources
report the same alias or when the body would exceed the 256 KiB budget. `sourceId` is positional
(`s1`…`s16`). `started` is counted when a boundary begins and `count` when it settles, so
`started - count` is work still in flight. The aggregate `state` is the strongest across sources:
`ready` beats everything, then `collection-failed`, `stale`, `no-data`, `disabled`. A client whose
negotiated manifest has `events: false` answers a frozen `unsupported` response without sending the
request.

## Realtime lifecycle observations (M98l)

`GET /v1/realtime` serves aggregate lifecycle counters and current-state gauges from every source
registered under the multi token `CAPABILITIES.REALTIME_DIAGNOSTICS` — one per WebSocket, SSE and
realtime-backplane plugin (more than 16 refuses connector startup with a fixed configuration error).
It is a SNAPSHOT operation with no query:

```json
{
  "version": 1,
  "instanceId": "<bound instance UUID>",
  "state": "ready",
  "sources": [
    {
      "sourceId": "s1",
      "snapshot": {
        "state": "ready",
        "alias": "dev-chat",
        "sourceKind": "websocket",
        "coverage": "owned-instance",
        "gauges": { "state": "available", "openConnections": 3, "groups": 1 },
        "records": [
          {
            "alias": "dev-chat",
            "operation": "send",
            "count": 42,
            "lastDurationMs": null,
            "ageMs": 120,
            "succeeded": 41,
            "failed": 1,
            "backpressureCloses": null
          }
        ],
        "dropped": 0
      }
    }
  ]
}
```

`sourceKind` is fixed when the source is built: `websocket` and `sse` count `open`, `close` and
`send`; `backplane` counts `backplane-publish` and `backplane-receive`. `unknown` appears only in
the connector's own value-free snapshot for a source that threw or failed validation (`alias: null`,
collection-failed gauges, no records); no source may claim it. The gauges are current state, read
fresh from the plugin's OWN service (`connectionCount` and `roomCount`/`channelCount`) on every read
of an enabled websocket or sse source — never from the registry, so a replacement provider is never
read — and they never expire: such a source is `ready` whenever its gauges were read, even when
every record has aged out. A backplane has no gauges (`state: 'unsupported'`, both values `null`)
and takes its state from record age: `no-data`, then `ready`, then `stale` after 30 seconds.
`disabled` gauges mean the reader was not called; `collection-failed` gauges mean the read failed
(or the source is latched after an earlier failure). Both carry `null` values.

`backpressureCloses` is a number only on an `sse` `close` record — the closes the 1 MiB backlog
guard caused, a subset of `failed`, `0` when none happened — and `null` everywhere else, so a
measured zero is distinguishable from "not supported". `lastDurationMs` is a number only on
`backplane-publish`, the one operation that settles asynchronously. A publication's success means
the transport's `publish()` resolved, never that a peer received it; a receive is counted only after
the transport's own frame-shape and own-origin filters admitted the frame. Both the connector and
the client reject a response that pairs a kind with an operation, gauge state or backpressure field
outside these rules.

No frame, message, comment, close code or reason, connection id, room or channel name, header, query
string, principal, `Last-Event-ID` or backplane origin ever enters a record. A record expires 60
seconds after its last observation. Duplicate non-null aliases and an over-budget body collapse the
whole response to `collection-failed` with no sources; the aggregate `state` follows the shared
priority (`ready`, `collection-failed`, `stale`, `no-data`, `disabled`; `unsupported` with no
source). A client whose negotiated manifest has `realtime: false` answers a frozen `unsupported`
response without sending the request.

## Outbound HTTP attempt observations (M98n)

`GET /v1/outbound-http` serves attempt counters from every source registered under the multi token
`CAPABILITIES.OUTBOUND_HTTP_DIAGNOSTICS` — one per `createObservedFetch` helper whose `plugin` the
application registered (more than 16 refuses connector startup with a fixed configuration error). It
is a SNAPSHOT operation with no query:

```json
{
  "version": 1,
  "instanceId": "<bound instance UUID>",
  "state": "ready",
  "sources": [
    {
      "sourceId": "s1",
      "snapshot": {
        "state": "ready",
        "alias": "payments-api",
        "coverage": "owned-instance",
        "records": [
          {
            "alias": "payments-api",
            "operation": "attempt",
            "started": 12,
            "count": 11,
            "responses": 10,
            "failures": 1,
            "lastStatusClass": "2xx",
            "lastDurationMs": 34,
            "ageMs": 210
          }
        ]
      }
    }
  ]
}
```

A source holds at most one record. `started - count` is the attempts in flight;
`responses + failures === count` and `count <= started` always hold, and an HTTP error status is a
response, not a failure. `lastStatusClass` is `null` until a response settles and never a raw status
number (`other` covers everything outside `200..599`); `lastDurationMs` is the last settled
attempt's integer time to headers, `null` until one settles. The record expires 60 seconds after its
last start or settlement — never while an attempt is in flight — and is `stale` after 30 seconds.
`disabled` (`alias: null`), `no-data` and `collection-failed` carry no record; `ready` and `stale`
carry exactly one. No URL, host, header, cookie, body, signal or error ever enters a record. The
connector and the client both refuse any snapshot that breaks these rules; duplicate non-null
aliases and an over-budget body collapse the whole response to `collection-failed` with no sources.
A client whose negotiated manifest has `outboundHttp: false` answers a frozen `unsupported` response
without sending the request.

## Bounds (fixed, not configurable)

| Bound                            | Value                                        |
| -------------------------------- | -------------------------------------------- |
| Simultaneous connector handlers  | 8 (1 reserved against unpaired floods)       |
| Unpaired lanes                   | 7 of the 8 slots                             |
| Authentication (verify) lane     | 4                                            |
| Anonymous refusal budget         | 5/s, burst 10                                |
| Session budget (post-verify)     | 20/s, burst 40                               |
| Parsed header bytes              | 8 KiB                                        |
| Response body                    | 256 KiB                                      |
| Events per read                  | 128                                          |
| Queue sources read               | 16                                           |
| Scheduler sources read           | 16                                           |
| Scheduler records per source     | 64 (job alias, operation) tuples             |
| Queue merge ring                 | 1,024 events                                 |
| Authorization alias map entries  | 128 per map                                  |
| Authorization steps per decision | 16 retained (true count in `stepsEvaluated`) |
| Authorization decision ring      | 1,024 decisions                              |
| Event sources read               | 16                                           |
| Event records per source         | 64 (60 s retention, 30 s stale)              |
| Client request deadline          | 5 seconds                                    |

## Revocation

`revoke()` immediately disables authorization, discards key references, and closes the listener; it
is idempotent and does not stop the owning application or M98a's in-process reader. The
RuntimePlugin's close hook closes any active listener on every shutdown and failed-startup path. A
revoked or expired session cannot be reactivated; pairing again requires a fresh application launch.

## Confidentiality limits

Loopback HTTP provides no encryption: authenticated bytes are not confidential against a privileged
local sniffer. Remote tunnels, shared untrusted hosts, and production use are outside the supported
threat model. Nothing in this document advertises TLS or a secure remote debugger.
