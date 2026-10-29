# @setu-ts/diagnostics-plugin — inspect a local development application

**Add it:** use `setu devtool enable`; `setu add diagnostics` refuses. The launcher wires
`DiagnosticsPlugin` with fresh in-memory credentials and kernel `diagnostics: {}`; the connector
provides no capability; it consumes `CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER`
(`ILocalDiagnosticsListenerFactory`).

## Read the application through an authenticated client

Use the client constructed by the trusted launcher; do not build a browser endpoint:

```ts
import type { IDiagnosticsClient } from '@setu-ts/diagnostics-plugin';

export async function inspectApplication(client: IDiagnosticsClient) {
  const composition = await client.snapshot();
  const events = await client.read(0, 64);
  return { composition, events };
}
```

## End a local session without stopping the application

Keep the plugin handle returned to the development composition:

```ts
import type { IDiagnosticsPlugin } from '@setu-ts/diagnostics-plugin';

export async function endInspection(connector: IDiagnosticsPlugin): Promise<void> {
  await connector.revoke();
}
```

## Behaviour the types do not show

- Activation supports Deno and Node and binds IPv4 loopback. Missing kernel diagnostics or an
  unavailable port fails startup; there is no fallback port or address.
- Every request and response is MAC-verified. The launcher supplies a fresh session id and 32-byte
  key in memory; the plugin has no environment fallback.
- `ttlMs` is monotonic milliseconds, defaults to 900000 and is capped at 3600000.
- Client reads pair automatically and validate deeply frozen responses; failed pairing is terminal.
- `read` takes a cursor and a limit of 1–128; continue from the returned `next` cursor.
- `revoke` discards key references and closes the listener; repeated calls share cleanup. A revoked
  instance cannot be reactivated.

## Other options

- `enabled: true` is explicit acknowledgement; include the plugin only in a development composition.
- `port` must be 1024–65535; `maxSessionLifetimeMs` enables renewal up to 43200000 milliseconds.
- `createDiagnosticsClient` takes the launch credentials, crypto, fetch and timing ports.
- Inspector methods include `health`, `configuration`, `queues`, `traces` and `storage`.
