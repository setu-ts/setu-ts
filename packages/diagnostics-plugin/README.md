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

## Development-only composition

**`enabled` is an acknowledgement, not a toggle.** There is no disabled mode: `enabled: false` never
activated anything, it is _refused_ at composition time. So the obvious line for "run it outside
production only" —

```text
DiagnosticsPlugin({ enabled: !isProduction, … })
```

— would not give you an inert connector in production. It would give you an application that throws
at composition and never boots. `enabled` is typed as the literal `true` so that shape is a compile
error rather than a production outage. Decide by **inclusion**.

The decision has to be made at `createApplication()` time — the kernel's collector is built in the
constructor and `diagnostics` is a construction option — so the cleanest shape is a development-only
entry point that production never imports:

```typescript
import type { IApplication, IPlugin } from '@setu-ts/common';
import { createApplication, type KernelDiagnosticsOptions } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiagnosticsPlugin } from '@setu-ts/diagnostics-plugin';

// setu.config.ts — no devtool import anywhere in the production graph.
//
// The composition is the SECOND parameter deliberately — and it is spelled
// `devtool`, because this is the exact shape `setu new --devtool` and
// `setu devtool enable` emit since M98c. `setu commands` builds the
// application to discover plugin-contributed verbs, and it calls this factory
// with its own inert discovery env as the FIRST positional argument on every
// target (`app-loader.ts`) — so a single-parameter `createApp(extra?)` would
// receive that proxy as `extra` and throw on the spread below.
export function createApp(
  _env?: Readonly<Record<string, unknown>>,
  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },
): IApplication {
  return createApplication({
    plugins: [RuntimePlugin(), ...(devtool?.plugins ?? [])],
    ...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),
  });
}

// main.ts — production. Never imports @setu-ts/diagnostics-plugin.
export const production: IApplication = createApp();

// main.dev.ts — the ONLY module that imports the connector.
const sessionId = Array.from(
  crypto.getRandomValues(new Uint8Array(16)),
  (b) => b.toString(16).padStart(2, '0'),
).join('');
const sessionKey = crypto.getRandomValues(new Uint8Array(32));

export const development: IApplication = createApp(undefined, {
  plugins: [DiagnosticsPlugin({ enabled: true, port: 4919, sessionId, sessionKey })],
  diagnostics: {},
});
```

That makes exclusion a property of the build rather than of a runtime branch: the production entry
cannot enable the connector, because it never imports it.

Credentials come from the trusted launcher through the child process environment (see
[Pairing](#pairing)); the plugin reads no environment variable itself, so nothing auto-enables.
`setu new --devtool` and `setu devtool enable` emit exactly this composition — the development
entry, its `dev` task, and a `check` task that reaches `main.dev.ts`.

### Optional hardening: a scoped network grant

A generated project's `start` task carries a BARE `--allow-net`. Scoping it to the application port
is OPTIONAL hardening for a project with no egress — not a default, and not a guarantee you already
have. On Deno 2.9.6 an allowlist governs OUTBOUND connections as well as bind (measured): under
`--allow-net=0.0.0.0:3000`, a `fetch` to any other address fails with `NotCapable` the same way a
bind does, so a scoped grant refuses every database, broker and outbound API call the project makes.
If you scope it anyway, you get a second, independent guarantee on top of the build-level isolation
above: a bind on `127.0.0.1:4919` fails under the `start` grant with
`NotCapable: Requires net access to "127.0.0.1:4919"`, so even a connector that reached production
by mistake cannot open its port. The loopback restriction itself is the listener's, not a permission
flag's — the runtime-owned listener binds `127.0.0.1` before anything else and refuses a
non-loopback bind outright.

## Protocol

Six signed GET operations — `/v1/status`, `/v1/snapshot`, `/v1/events?after=<N>&limit=<N>`, and the
inspector operations `/v1/health` (M98d), `/v1/config` (M98e) and `/v1/queues?after=<N>&limit=<N>`
(M98f) — over bounded polling. The status body carries an `inspectors` manifest (`health`,
`configuration` and `queues` implemented; the rest reserved and `false` until their own operations
ship); a client paired against a legacy three-field status body resolves it to all-`false`, and its
`health()`, `configuration()` and `queues()` answer a typed `unsupported` without sending the
request. Requests authenticate with `X-Setu-Session`, `X-Setu-Sequence` (strictly monotonic),
`X-Setu-Instance`, and `X-Setu-Mac` (HMAC-SHA-256 over canonical newline-joined fields, verified via
`subtle.verify`). Responses are signed over their exact bytes; the client verifies BEFORE parsing
anything. Bodies are bounded (256 KiB), events are capped at 128 per read, and a fixed set of
value-free error codes (`invalid-request`, `unauthorized`, `expired`, `unsupported-version`,
`unavailable`, `rate-limited`) never reflects input. See `docs/diagnostics-protocol.md` in the
repository for the complete wire specification and fixtures.

Bounds: at most 8 simultaneous handlers with one slot reserved against unpaired floods, an anonymous
refusal budget of 5 requests/second (burst 10), a per-session budget of 20 requests/second (burst
40), and an 8 KiB header budget. Expiry uses the runtime's monotonic clock.

## Native client

`createDiagnosticsClient` is the reviewed client-side implementation, consumed by the separately
maintained devtool. Every dependency is injected (`subtle`, `fetch`, a `timing` port); calls are
serialized with strictly increasing sequence numbers; the initial pairing exchange is terminal on
failure; response MACs verify over the exact bounded bytes before parsing.

The M98d inspector operation is read through `client.health(): Promise<HealthDiagnosticsSnapshot>` —
the minimized health-observation snapshot the health plugin registers under
`CAPABILITIES.HEALTH_DIAGNOSTICS`. A connector without a health source answers a typed
`unsupported`; the client surfaces the snapshot's `state` rather than failing the call.

The M98e inspector operation is read through
`client.configuration(): Promise<ConfigDiagnosticsSnapshot>` — the value-free provenance snapshot
the config plugin registers under `CAPABILITIES.CONFIG_DIAGNOSTICS` (always registered, so "no
config plugin" answers `unsupported` where "present but off" answers `disabled`). Every string from
the config plugin is an application-approved display alias, and the connector and client both refuse
an alias carrying a control character, whoever registered the source: no configuration value, hash,
length, raw key name, or file path is ever carried, and unapproved keys are never observed at all.

The M98f queue inspector is read through
`client.queues(after, limit?): Promise<QueueDiagnosticsBatch>`. The cursor is the CONNECTOR's merge
cursor: every QueuePlugin instance contributes its own queue-diagnostics source, and each queue read
drains every source's new attempts into one bounded merge ring before serving the page. The batch
carries one status per source (a `q<N>` id, the approved instance alias, a per-source `lost` for
attempts that source's own ring evicted before the connector drained them), the page of attempts,
and every source's latest depths. With no queue plugin registered the connector answers
`state: 'unsupported'`.

The full public surface is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#diagnostics-connector-setu-tsdiagnostics-plugin).

## Privacy

The connector serves M98a's minimized projections only: allowlisted labels, opaque ids, bounded
counts, value-free failure codes. No request bodies, headers, credentials, payloads, logs, or
environment values ever cross the protocol. Diagnostic counters are in-process and value-free.

The M98d health inspector carries the same discipline: each observation holds only the approved
display alias, the framework's own status, the outcome state, and monotonic timing. An indicator's
`data`, the thrown value of a failure, and any absolute time are never projected — the canary test
plants both and asserts their absence at the source, in the raw signed bytes captured below the
client, and in the client DTO. The connector validates the projected DTO before signing it; a source
that violates it answers `collection-failed`.

The M98e configuration inspector holds it too: canary values planted in an unapproved key, inside
the approved file, and inside an expanded reference's resolution are asserted absent at all three
layers, as are the raw key names and the configured path. `droppedEntries` counts only budget
omissions — a count of unapproved keys would disclose that they exist, so there is none.

The M98g trace inspector (`GET /v1/traces?after=N&limit=N`, `client.traces(after, limit?)`) serves
the TelemetryPlugin's completed, sampled spans under the same rules: only approved operation
aliases, W3C-validated identifiers, at most eight link identifier pairs, kind, outcome, duration and
monotonic age. Span names, attributes, events, resource labels, tracestate, baggage, exceptions and
status messages never reach any layer — the e2e canary plants a hostile span name and a hostile
attribute and asserts their absence in the batch, the raw signed bytes and the client DTO.
Correlation joins EQUAL trace ids across independently authenticated sessions; an identifier grants
no discovery or connection authority, `parentVisibility` never fabricates an edge, and `ageMs` is
arrival age at one process, never a global timeline.

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
