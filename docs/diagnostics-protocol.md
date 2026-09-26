# Local Diagnostics Protocol v1

The wire protocol between the local diagnostics connector (`@setu-ts/diagnostics-plugin`) and its
native client (`createDiagnosticsClient`). This document is the specification the protocol fixtures
under `packages/diagnostics-plugin/test/fixtures/` pin, and the starting point for the separately
maintained devtool's implementation.

This protocol required security review before implementation acceptance; shipping standard
primitives is not that review, and this document makes no claim that the separately maintained
devtool has been verified.

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

| Target                           | Answer                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/status`                 | `{ version: 1, instanceId, expiresInMs, inspectors }` — binds the session to the application instance on the first exchange; `inspectors` is the M98d inspector manifest (below) |
| `GET /v1/snapshot`               | M98a's compact final snapshot JSON (not an envelope)                                                                                                                             |
| `GET /v1/events?after=N&limit=N` | M98a's frozen event batch; `after` is a canonical non-negative decimal, `limit` is 1–128, in exactly this order                                                                  |
| `GET /v1/health`                 | M98d's minimized health-observation snapshot (below)                                                                                                                             |
| `GET /v1/queues?after=N&limit=N` | M98f's merged queue-observation batch (below); the same canonical query grammar as `/v1/events`                                                                                  |

Everything else — unknown operations, extra path segments, percent-encoded aliases, reordered,
duplicated, or unknown query fields, non-canonical numbers (leading zeros), write methods — is
refused.

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

## Replay, expiry, and binding

- Sequence numbers are strictly monotonic per session; the server atomically advances its highest
  accepted number after `subtle.verify` and re-checks revocation and expiry in the same synchronous
  gate. Replays and races cannot both pass.
- Expiry uses the runtime's monotonic clock from activation (15 minutes default, 1 ms–1 h range).
- The first successful signed status exchange binds the session to M98a's non-null instance UUID;
  later requests must present exactly that ID, and an empty instance is never accepted after the
  initial exchange. Obtaining a UUID alone grants nothing.

## Response requirements

All responses (signed or refusals) carry `Cache-Control: no-store`,
`Content-Type: application/json`, and `X-Content-Type-Options: nosniff`. Signed responses add
`X-Setu-Mac` and `X-Setu-Instance`. The client verifies the response MAC over the exact bounded body
bytes (256 KiB hard ceiling on the STREAM, not `Content-Length`) BEFORE parsing anything, and checks
the parsed status body's `instanceId` against the authenticated header.

Unauthenticated refusals are not signed and use one fixed shape:

```json
{ "version": 1, "error": "invalid-request" }
```

| Code                  | Status | When                                             |
| --------------------- | ------ | ------------------------------------------------ |
| `invalid-request`     | 400    | structural/grammar/framing violation             |
| `unauthorized`        | 401    | wrong session, wrong key, wrong instance, replay |
| `expired`             | 401    | monotonic expiry reached                         |
| `unsupported-version` | 400    | source DTO version is not 1                      |
| `unavailable`         | 503    | internal failure or an over-limit result         |
| `rate-limited`        | 429    | refusal budget exhausted or session budget spent |

No refusal ever echoes supplied input, error causes, or stacks.

## Health observations (M98d)

`GET /v1/health` is the first inspector operation. The status body's `inspectors` manifest names
every inspector the connector knows and whether it is implemented; the connector serves
`health: true` (M98d) and `queues: true` (M98f) and leaves the rest (`configuration`, `traces`,
`authorization`, `cache`, `events`, `scheduler`, `realtime`, `storage`, `outboundHttp`) reserved and
`false`. A client that reads a legacy M98b three-field status body (no `inspectors`) resolves the
manifest to all-`false`, so its `health()` answers a typed `unsupported` without sending the
request.

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

## Bounds (fixed, not configurable)

| Bound                           | Value                                  |
| ------------------------------- | -------------------------------------- |
| Simultaneous connector handlers | 8 (1 reserved against unpaired floods) |
| Unpaired lanes                  | 7 of the 8 slots                       |
| Authentication (verify) lane    | 4                                      |
| Anonymous refusal budget        | 5/s, burst 10                          |
| Session budget (post-verify)    | 20/s, burst 40                         |
| Parsed header bytes             | 8 KiB                                  |
| Response body                   | 256 KiB                                |
| Events per read                 | 128                                    |
| Queue sources read              | 16                                     |
| Queue merge ring                | 1,024 events                           |
| Client request deadline         | 5 seconds                              |

## Revocation

`revoke()` immediately disables authorization, discards key references, and closes the listener; it
is idempotent and does not stop the owning application or M98a's in-process reader. The
RuntimePlugin's close hook closes any active listener on every shutdown and failed-startup path. A
revoked or expired session cannot be reactivated; pairing again requires a fresh application launch.

## Confidentiality limits

Loopback HTTP provides no encryption: authenticated bytes are not confidential against a privileged
local sniffer. Remote tunnels, shared untrusted hosts, and production use are outside the supported
threat model. Nothing in this document advertises TLS or a secure remote debugger.
