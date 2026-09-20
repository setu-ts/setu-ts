# @setu-ts/diagnostics-plugin

The authenticated **local diagnostics connector** (M98b): connects a native devtool client to the
kernel diagnostics (M98a) over a separate, runtime-owned authenticated IPv4 loopback HTTP listener.
Deno and bounded polling only. No browser UI, no application-data reads, no application-control
commands, and authentication is independent of any devtool subscription.

## Trust model — read this first

- **Loopback is not authentication.** The HMAC-SHA-256 signed protocol is. Every request and
  response byte is MAC-verified with a fresh per-launch session key.
- **Loopback is not encryption.** A privileged local process can sniff authenticated bytes. Remote
  tunnels, shared untrusted hosts, and production use are outside this transport's threat model.
- **No environment fallback.** Importing the package, registering unrelated plugins, or setting an
  environment variable never exposes an endpoint. Activation requires explicit plugin options.
- Trusted application code and installed in-process plugins already run with application privileges;
  this is not a sandbox against a compromised process.

## Installation

```typescript
import { DiagnosticsPlugin } from '@setu-ts/diagnostics-plugin';
```

No third-party dependency. The listener socket is owned by `@setu-ts/runtime` (`RuntimePlugin` is a
required dependency of every application and now provides
`CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER`).

## Pairing

The trusted native launcher generates a fresh 32-byte session key and a 16-byte session ID per
launch and passes them to the application's composition in memory (its environment handoff is the
launcher's trust boundary; application subprocesses must not inherit these values). Sharing one pair
across applications is unsupported. The plugin copies the key into a non-extractable Web Crypto HMAC
key and zeroes its temporary copy.

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiagnosticsPlugin } from '@setu-ts/diagnostics-plugin';

// Fresh per-launch credentials, generated here for the example; in a real
// launch the trusted native launcher supplies them in memory.
const sessionId = Array.from(
  crypto.getRandomValues(new Uint8Array(16)),
  (b) => b.toString(16).padStart(2, '0'),
).join('');
const sessionKey = crypto.getRandomValues(new Uint8Array(32));

const diagnostics = DiagnosticsPlugin({
  enabled: true, // explicit opt-in; false/omitted refuses activation
  port: 4919, // 1024–65535, IPv4 loopback only, no auto-selection
  sessionId, // 16 random bytes as 32 lowercase hex, per launch
  sessionKey, // 32 random bytes, per launch
  ttlMs: 900_000, // optional; 15 minutes default, max 1 hour
});

const app = createApplication({
  plugins: [RuntimePlugin(), diagnostics],
  diagnostics: {}, // M98a kernel diagnostics must be enabled
});
await app.start();

// Later, without stopping the application:
await diagnostics.revoke();
```

Activation refusals are startup failures: missing kernel diagnostics, an unsupported runtime, an
invalid port, or invalid credentials. Port conflicts fail closed — no scan, no fallback address.

## Protocol

Three signed GET operations — `/v1/status`, `/v1/snapshot`, and `/v1/events?after=<N>&limit=<N>` —
over bounded polling. Requests authenticate with `X-Setu-Session`, `X-Setu-Sequence` (strictly
monotonic), `X-Setu-Instance`, and `X-Setu-Mac` (HMAC-SHA-256 over canonical newline-joined fields,
verified via `subtle.verify`). Responses are signed over their exact bytes; the client verifies
BEFORE parsing anything. Bodies are bounded (256 KiB), events are capped at 128 per read, and a
fixed set of value-free error codes (`invalid-request`, `unauthorized`, `expired`,
`unsupported-version`, `unavailable`, `rate-limited`) never reflects input. See
`docs/diagnostics-protocol.md` in the repository for the complete wire specification and fixtures.

Bounds: at most 8 simultaneous handlers with one slot reserved against unpaired floods, an anonymous
refusal budget of 5 requests/second (burst 10), a per-session budget of 20 requests/second (burst
40), and an 8 KiB header budget. Expiry uses the runtime's monotonic clock.

## Native client

`createDiagnosticsClient` is the reviewed client-side implementation, consumed by the separately
maintained devtool. Every dependency is injected (`subtle`, `fetch`, a `timing` port); calls are
serialized with strictly increasing sequence numbers; the initial pairing exchange is terminal on
failure; response MACs verify over the exact bounded bytes before parsing.

The full public surface is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#diagnostics-connector-setu-tsdiagnostics-plugin).

## Privacy

The connector serves M98a's minimized projections only: allowlisted labels, opaque ids, bounded
counts, value-free failure codes. No request bodies, headers, credentials, payloads, logs, or
environment values ever cross the protocol. Diagnostic counters are in-process and value-free.

## Exports

| Export                     | Kind      |
| -------------------------- | --------- |
| `createDiagnosticsClient`  | function  |
| `DiagnosticsPlugin`        | function  |
| `DiagnosticsClientOptions` | interface |
| `DiagnosticsPluginOptions` | interface |
| `IDiagnosticsClient`       | interface |
| `IDiagnosticsPlugin`       | interface |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.
