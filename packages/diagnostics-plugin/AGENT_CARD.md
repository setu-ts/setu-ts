# @setu-ts/diagnostics-plugin — authenticated local diagnostics connector

`setu devtool enable` installs and wires this package; `setu add diagnostics` refuses and names that
command. Importing it enables nothing: `DiagnosticsPlugin` needs an explicit `enabled: true`, the
`sessionId` and `sessionKey` the trusted launcher minted for this launch, and a `port` in
1024–65535. The application must also turn on kernel diagnostics with `diagnostics: {}`.

```ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiagnosticsPlugin } from '@setu-ts/diagnostics-plugin';

export function createDevApp(sessionId: string, sessionKey: Uint8Array) {
  const diagnostics = DiagnosticsPlugin({
    enabled: true,
    port: 4919,
    sessionId,
    sessionKey,
    ttlMs: 900_000,
  });
  const app = createApplication({
    plugins: [RuntimePlugin(), diagnostics],
    diagnostics: {},
  });
  return { app, revoke: diagnostics.revoke };
}
```

- `enabled` is the literal `true` — an acknowledgement, not a toggle. `enabled: false` is refused at
  composition, so decide by inclusion: a development entry point that production never imports, the
  shape `setu new --devtool` and `setu devtool enable` emit.
- `ttlMs` defaults to 900000 and is capped at 3600000. Omitting `maxSessionLifetimeMs` disables
  renewal and keeps the legacy status body; when set (max 43200000) `renew` extends the same
  session.
- Activation refusals are startup failures: missing kernel diagnostics, an unsupported runtime, a
  non-loopback or unavailable port, or bad credentials. No port scan, no fallback address.
- `diagnostics.revoke()` closes the listener and discards the key without stopping the application.
- Loopback is neither authentication nor encryption: every request and response is MAC-verified with
  HMAC-SHA-256 under the per-launch session key. Deno only, bounded polling.
- `createDiagnosticsClient` is the reviewed client the devtool uses; it takes `endpoint`,
  `sessionId`, `sessionKey`, `subtle`, `fetch` and a `timing` port.
