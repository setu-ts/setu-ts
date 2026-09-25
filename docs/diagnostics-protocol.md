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
every inspector the connector knows and whether it is implemented; M98d serves `health: true` and
leaves the rest (`configuration`, `queues`, `traces`, `authorization`, `cache`, `events`,
`scheduler`, `realtime`, `storage`, `outboundHttp`) reserved and `false`. A client that reads a
legacy M98b three-field status body (no `inspectors`) resolves the manifest to all-`false`, so its
`health()` answers a typed `unsupported` without sending the request.

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
