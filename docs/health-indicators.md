# Health indicators — classification audit

Every `ctx.health.register(...)` call in `packages/*/src`, classified. This is the M70c audit
deliverable (plan §3.9): it stops the "hardcoded `up` next to live `data`" pattern recurring by
making every indicator's status source explicit, and it is enforced by
[`test/health-indicator-audit.test.ts`](../test/health-indicator-audit.test.ts), which fails if a
`ctx.health.register` site is added (or moved) without a matching row here.

The CLI schematic at `packages/cli/src/schematics/health-indicator.ts` mentions
`ctx.health.register` inside a template string and is not a registration site.

There are **26** registration sites. `static-plugin` registers the same `static-files` indicator
from two branches (the no-`fs` arm and the `fs` arm), so it contributes two rows; only one is active
at a time.

## What each status means

The health plugin projects every indicator to `{ status, data }` (M70c, fixing X3-7) and aggregates:
`/ready` is `200` only when **every** indicator is `up`; `/health` is `503` only when any is `down`
(`degraded` is `200`). The gRPC bridge maps the aggregate to `grpc.health.v1.Health/Check` — since
M70c, `degraded` maps to `NOT_SERVING`, agreeing with `/ready` (X7-8).

| Classification          | Meaning                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-state`            | The status reflects a **live** fact about the backend or a live probe: a reachability probe (`isHealthy()`), a readiness flag that tracks a real connection, or an actual I/O check. The status can change at runtime as the backend changes.                       |
| `justified-literal`     | The status is a fixed literal, but the **justification is documented** and the literal is the correct signal for that plugin (e.g. a platform binding whose presence is known at registration).                                                                     |
| `configuration-literal` | The status is a fixed literal (or a lifecycle flag that only ever reports "started / stopped") while the `data` payload is live. The status says nothing about the backend's health. **These are the X8-5 class of defect** — the indicator's status is decorative. |

The six M70c in-scope packages (`messaging`, `realtime-backplane`, `storage`, `mail`, `queue`,
`service-discovery`) are now `live-state`: each reports both signals — `isReady()` (lifecycle) and
`isHealthy()` (reachability) — and the indicator maps them (see the per-package READMEs for the
status tables).

## The register

| #  | Indicator            | Package                   | Site                                                                            | Classification          | Status source and note                                                                                                                                                                                                                |
| -- | -------------------- | ------------------------- | ------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | `messaging` (token)  | messaging-plugin          | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:256`                  | `live-state`            | M70c: `isReady()` lifecycle + `isHealthy()` reachability; `down` when not ready or unreachable, `degraded` when ready but unreachable and a reconnect is in flight.                                                                   |
| 2  | `realtime-backplane` | realtime-backplane-plugin | `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts:69` | `live-state`            | M70c: transport `isHealthy()`; a fan-out failure is `degraded` (local delivery still works), never `down`.                                                                                                                            |
| 3  | `storage`            | storage-plugin            | `packages/storage-plugin/src/plugin/storage-plugin.ts:183`                      | `live-state`            | M70c: provider `isHealthy()` probe (HEAD/list) + lifecycle; `down` when unreachable.                                                                                                                                                  |
| 4  | `mail`               | mail-plugin               | `packages/mail-plugin/src/plugin/mail-plugin.ts:127`                            | `live-state`            | M70c: provider `isHealthy()` (SMTP `verify?`, SES `isHealthy?`) + lifecycle.                                                                                                                                                          |
| 5  | `queue` (token)      | queue-plugin              | `packages/queue-plugin/src/plugin/queue-plugin.ts:122`                          | `live-state`            | M70c: adapter `isHealthy()` (PING / connection-fault / `GetQueueAttributes`) + lifecycle; `data.reachable` distinguishes `up`/`down`/`unknown`.                                                                                       |
| 6  | `service-discovery`  | service-discovery-plugin  | `packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts:122`  | `live-state`            | M70c: `#everResolved` + provider probe (Consul `/v1/status/leader`, Kubernetes `limit=1` EndpointSlice LIST); never-resolved-and-unreachable is `down` (X10-3 fix), stale-cache is `degraded`.                                        |
| 7  | `grpc`               | grpc-plugin               | `packages/grpc-plugin/src/plugin/grpc-plugin.ts:58`                             | `configuration-literal` | `status: 'up'` beside live `data.available`/`serviceCount`. The transport's real health is the `Health/Check` RPC (mapped from the health plugin's aggregate), so the plugin's own indicator only reports that the plugin registered. |
| 8  | `scheduler`          | scheduler-plugin          | `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts:77`                   | `configuration-literal` | `createHealthIndicator()` reports `#connected` (lifecycle) only — no reachability probe.                                                                                                                                              |
| 9  | `audit`              | audit-plugin              | `packages/audit-plugin/src/plugin/audit-plugin.ts:136`                          | `configuration-literal` | `storage.isReady()` (lifecycle) only. **Recorded in `smoke/DEFECTS.md` (H-70c-1)** — out of scope for M70c.                                                                                                                           |
| 10 | `cache` (token)      | cache-plugin              | `packages/cache-plugin/src/plugin/cache-plugin.ts:108`                          | `configuration-literal` | `backend.isReady()` (lifecycle) only. **Recorded in `smoke/DEFECTS.md` (H-70c-2)** — out of scope.                                                                                                                                    |
| 11 | `database` (token)   | database-plugin           | `packages/database-plugin/src/plugin/database-plugin.ts:119`                    | `configuration-literal` | `service.isHealthy()` resolves to `adapter.isReady()` — lifecycle, not a reachability probe. **Recorded in `smoke/DEFECTS.md` (H-70c-3)** — out of scope.                                                                             |
| 12 | `notification`       | notification-plugin       | `packages/notification-plugin/src/plugin/notification-plugin.ts:88`             | `configuration-literal` | `status: 'up'` beside live `data.channels`. **Recorded in `smoke/DEFECTS.md` (H-70c-4)** — out of scope.                                                                                                                              |
| 13 | `worker-pool`        | worker-pool-plugin        | `packages/worker-pool-plugin/src/plugin/worker-pool-plugin.ts:74`               | `configuration-literal` | `status: 'up'` beside live `data.available`/`pools`. **Recorded in `smoke/DEFECTS.md` (H-70c-5)** — out of scope.                                                                                                                     |
| 14 | `cloudflare`         | cloudflare-plugin         | `packages/cloudflare-plugin/src/plugin/cloudflare-plugin.ts:229`                | `justified-literal`     | Reports the **billed binding read** — which arms are present is a platform fact known at registration, not a backend to probe. The status is `up`/`down` on the presence of the bindings the arms need.                               |
| 15 | `feature-flags`      | feature-flags-plugin      | `packages/feature-flags-plugin/src/plugin/feature-flags-plugin.ts:136`          | `live-state`            | Queries the provider's `status()`; a provider that reports `degraded` (stale cache, fallback mode) is surfaced as `degraded` with the detail.                                                                                         |
| 16 | `session`            | session-plugin            | `packages/session-plugin/src/plugin/session-plugin.ts:131`                      | `live-state`            | `service.storeHealth()` — a store that reports unhealthy is `down` (a session store failure is the one invisible from outside).                                                                                                       |
| 17 | `static-files`       | static-plugin             | `packages/static-plugin/src/plugin/static-plugin.ts:56`                         | `live-state`            | The no-`fs` runtime arm: `degraded`, justified — the plugin cannot serve files without a filesystem.                                                                                                                                  |
| 18 | `static-files`       | static-plugin             | `packages/static-plugin/src/plugin/static-plugin.ts:85`                         | `live-state`            | The `fs` arm: a real `fs.stat(root)`; `down` when the root is missing or not a directory.                                                                                                                                             |
| 19 | `sse`                | sse-plugin                | `packages/sse-plugin/src/plugin/sse-plugin.ts:78`                               | `configuration-literal` | `status: 'up'` beside live `data.connections`. The SSE service has no backend to probe; the status is decorative.                                                                                                                     |
| 20 | `websocket`          | websocket-plugin          | `packages/websocket-plugin/src/plugin/websocket-plugin.ts:110`                  | `configuration-literal` | `status: 'up'` beside live `data.available`/`connections`/`rooms`/`routes`. No backend to probe.                                                                                                                                      |
| 21 | `cqrs`               | cqrs-plugin               | `packages/cqrs-plugin/src/plugin/cqrs-plugin.ts:124`                            | `configuration-literal` | `status: 'up'` beside live `data.commands`/`queries` handler counts. In-process bus, no backend.                                                                                                                                      |
| 22 | `events`             | events-plugin             | `packages/events-plugin/src/plugin/events-plugin.ts:127`                        | `configuration-literal` | `status: 'up'` beside live `data.handlers`. In-process bus, no backend.                                                                                                                                                               |
| 23 | `graphql`            | graphql-plugin            | `packages/graphql-plugin/src/plugin/graphql-plugin.ts:208`                      | `configuration-literal` | `status: 'up'` beside live `data.endpoint`/`cachedDocuments`/`subscriptions`. The endpoint is in-process.                                                                                                                             |
| 24 | `multi-tenancy`      | multi-tenancy-plugin      | `packages/multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts:251`          | `configuration-literal` | `status: 'up'` beside live `data.resolver`/`strategy`/`store`. In-process middleware, no backend.                                                                                                                                     |
| 25 | `react-router`       | react-router-plugin       | `packages/react-router-plugin/src/plugin/react-router-plugin.ts:160`            | `configuration-literal` | `status: 'up'` beside live `data.mode`/`serverBuildPath`. Stateless handler (the source notes there is no socket, pool, timer, or subscription to close).                                                                             |
| 26 | `secrets`            | secrets-plugin            | `packages/secrets-plugin/src/plugin/secrets-plugin.ts:129`                      | `configuration-literal` | `provider.isReady()` (lifecycle) only.                                                                                                                                                                                                |

## Out-of-scope defects recorded (not changed on this branch)

Per plan §3.9, the `configuration-literal` sites **outside** the six in-scope packages that
nonetheless hide a real backend behind a decorative status are recorded in the smoke register
(`smoke/DEFECTS.md`, which is deliberately not tracked in git — hence a plain reference rather than
a link) and not fixed here:

| Defect ID | Package             | Issue                                                                                                             |
| --------- | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| H-70c-1   | audit-plugin        | `audit` indicator reports `storage.isReady()` (lifecycle) while the audit sink's reachability is never probed.    |
| H-70c-2   | cache-plugin        | `cache` indicator reports `backend.isReady()` (lifecycle) only; a Redis/KV backend that is down still reads `up`. |
| H-70c-3   | database-plugin     | `database` indicator's `isHealthy()` resolves to `adapter.isReady()` — lifecycle, not a reachability probe.       |
| H-70c-4   | notification-plugin | `notification` indicator hardcodes `status: 'up'` beside live `data.channels`.                                    |
| H-70c-5   | worker-pool-plugin  | `worker-pool` indicator hardcodes `status: 'up'` beside live `data.available`/`pools`.                            |

The remaining `configuration-literal` rows (7, 8, 19–25) are **defensible**: the plugin has no
external backend — the status says "this in-process capability is registered", and the live `data`
carries the useful part. They are recorded here so a future milestone can decide whether to
reclassify them, but they are not defects in the X8-5 sense (no backend is being hidden).
