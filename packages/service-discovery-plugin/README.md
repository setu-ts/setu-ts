# @setu-ts/service-discovery-plugin

Service discovery for Setu-TS — turns a logical service name into a reachable address, balances
across the instances behind it, and takes them out of rotation when callers report failures.

Registers an `IServiceDiscovery` under `CAPABILITIES.SERVICE_DISCOVERY`. **Zero npm dependencies**:
the HTTP providers run on web-standard `fetch` and the DNS provider on the optional
`IRuntimeServices.dns`.

## Install

```bash
deno add jsr:@setu-ts/service-discovery-plugin
```

## Quick start

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';
import { CAPABILITIES, type IServiceDiscovery } from '@setu-ts/common';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    ServiceDiscoveryPlugin({
      provider: 'static',
      services: {
        billing: [
          { host: '10.0.0.1', port: 8080 },
          { host: '10.0.0.2', port: 8080, weight: 3 },
        ],
      },
    }),
  ],
});

await app.start({ port: 3000 });

const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
const url = await discovery.resolveUrl('billing', '/invoices'); // http://10.0.0.1:8080/invoices
```

## Providers

| Provider       | Reads                              | `watch()`                   | Runtimes            |
| -------------- | ---------------------------------- | --------------------------- | ------------------- |
| `'static'`     | A literal list in your options     | Fires once, then never      | All, incl. Workers  |
| `'consul'`     | `GET /v1/health/service/:service`  | Blocking queries (push)     | All, incl. Workers  |
| `'kubernetes'` | EndpointSlices from the API server | Watch stream (push)         | All, incl. Workers¹ |
| `'dns'`        | `SRV` or `A`/`AAAA` records        | Polled at `watchIntervalMs` | Deno, Node, Bun     |
| `'custom'`     | Your own `DiscoveryProvider`       | Whatever you implement      | Yours               |

¹ Workers needs an explicit `token`, since it has no file system to read the projected
service-account token from.

The `'dns'` arm needs `IRuntimeServices.dns`, which Cloudflare Workers does not supply — its network
access is `fetch`, which resolves names internally and exposes no lookup surface. Configuring it
there throws `DiscoveryUnavailableError` at `register()`, naming the alternatives.

## Load balancing

`strategy` is `'round-robin'` (default), `'random'`, or `'weighted-random'`, set per plugin and
overridable per call:

```typescript
await discovery.pick('billing', { strategy: 'weighted-random' });
```

`weighted-random` reads `ServiceInstance.weight` (absent means `1`, non-positive means never
selected). The DNS provider maps an `SRV` record's own weight onto it, so a zone's intent is
honoured with no extra configuration. Randomness comes from `IRuntimeServices.randomBytes`, never
`Math.random()`.

`SRV` resolution keeps only the records in the numerically **lowest priority tier**, per RFC 2782 —
a primary tier and its designated fallback are not mixed into one pool.

## Outlier ejection

Report how each call went and discovery stops picking instances that keep failing:

```typescript
const instance = await discovery.pick('billing');
if (instance === null) throw new Error('no billing instance');

try {
  const response = await fetch(`http://${instance.host}:${instance.port}/invoices`);
  discovery.report(instance, response.ok ? 'success' : 'failure');
} catch (error) {
  discovery.report(instance, 'failure');
  throw error;
}
```

Defaults: 5 failures inside a 30 s rolling window eject an instance for 30 s; one success clears its
window and un-ejects it immediately. `ejection: false` disables the mechanism.

Two safeguards exist because ejection can otherwise amplify a correlated failure into a total
outage. `maxEjectionPercent` (default `50`) caps how much of a service may be ejected at once, and
if every instance is ejected anyway, `pick()` falls back to the unfiltered list rather than
returning `null`. Ejection state is **per-process**; a cluster-wide view is not attempted.

`resolve()` deliberately does **not** filter ejected instances — it reports what discovery knows,
while `pick()` reports what is usable.

### Composing with the resilience plugin

Ejection is a different mechanism from a circuit breaker, not a duplicate of one. `wrap()` breaks a
**call site** — after enough failures it stops calling at all, which for a multi-instance service
means refusing healthy instances because unhealthy ones failed. Ejection removes a **pool member**
while the call site stays open. They compose by re-picking inside the wrapped call:

```typescript
const call = resilience.wrap(async () => {
  const instance = await discovery.pick('billing');
  if (instance === null) throw new Error('no billing instance');
  try {
    const response = await fetch(`http://${instance.host}:${instance.port}/invoices`);
    discovery.report(instance, response.ok ? 'success' : 'failure');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    discovery.report(instance, 'failure');
    throw error;
  }
}, { retry: { maxAttempts: 3 } });
```

`wrap` re-enters the function on every attempt, so each retry picks again and lands on a different
instance once the failing one is ejected.

## Watching for changes

```typescript
const unsubscribe = await discovery.watch('billing', (instances) => {
  console.log(`billing now has ${instances.length} instances`);
});
```

The listener always receives the **full** instance list, never a delta, and a change invalidates
that service's cache entry immediately — so the TTL is a safety net for unwatched services rather
than the freshness mechanism for watched ones.

## Self-registration (Consul only)

```typescript
ServiceDiscoveryPlugin({
  provider: 'consul',
  address: 'http://127.0.0.1:8500',
  selfRegistration: {
    serviceName: 'orders',
    address: '10.0.0.7',
    port: 3000,
    drainDelayMs: 5_000,
  },
});
```

Registration runs at `onBootstrap` and deregistration at `onStopping` — the kernel hook that fires
**before** the application starts refusing requests. Deregistering at `onShutdown` instead would
leave callers routed at a closed port for up to one check interval on every rolling deploy.
`drainDelayMs` then keeps serving normally for that long after deregistering, so callers holding a
stale instance list are served rather than refused while the change propagates.

The health check is **not optional**: it defaults to
`{ httpPath: '/health', intervalSeconds: 10, deregisterAfterSeconds: 60 }` and cannot be disabled.
`onBootstrap` runs before the socket is bound, so the instance is advertised a moment before it can
serve — that window is harmless only because Consul marks a newly registered service critical until
its first check passes and every read here sends `passing=true`.

Configuring `selfRegistration` with any other provider throws `SelfRegistrationNotSupportedError` at
`register()` rather than silently doing nothing.

## Kubernetes in-cluster TLS

The API server presents a cluster-internal CA that `fetch` rejects. No code change fixes this from
inside the process — point the runtime at the mounted CA bundle:

- Deno: `DENO_CERT=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`
- Node: `NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`

The `http` option is the alternative: supply your own `IDiscoveryHttp` over a TLS-configured client.

Service-account tokens are re-read from disk (memoized for 60 s) rather than read once at startup,
because Kubernetes rotates projected tokens roughly hourly — a token captured at registration stops
working while the pod is still healthy.

## Options

| Option             | Arms               | Default                      | Notes                                         |
| ------------------ | ------------------ | ---------------------------- | --------------------------------------------- |
| `provider`         | all                | —                            | Discriminant; always explicit                 |
| `cacheTtlMs`       | all                | `30_000`                     | `0` disables caching                          |
| `strategy`         | all                | `'round-robin'`              | Overridable per `pick()` call                 |
| `ejection`         | all                | see above                    | `false` disables                              |
| `selfRegistration` | consul (+ custom)  | —                            | Throws on the other arms                      |
| `watchIntervalMs`  | static, dns        | `30_000`                     | Absent from the push-based arms               |
| `services`         | static             | —                            | Unknown name resolves to `[]`                 |
| `address`          | consul             | —                            | Agent base URL                                |
| `token`            | consul             | —                            | Sent as `X-Consul-Token`                      |
| `datacenter`       | consul             | —                            | Sent as `?dc=`                                |
| `waitSeconds`      | consul             | `30`                         | Clamped to Consul's maximum of `600`          |
| `namespace`        | kubernetes         | —                            | Required                                      |
| `apiServer`        | kubernetes         | in-cluster env               | Required outside a cluster                    |
| `portName`         | kubernetes         | —                            | Required when a service exposes several ports |
| `mode`             | dns                | —                            | `'srv'` or `'a'`                              |
| `domainTemplate`   | dns                | `'{service}.service.consul'` | `{service}` is substituted                    |
| `port`             | dns (`'a'` only)   | —                            | Mandatory: address records carry no port      |
| `secure`           | consul, k8s, dns   | `false`                      | Decides the `https` scheme                    |
| `http`             | consul, kubernetes | `fetch`                      | Injectable transport                          |
| `discovery`        | custom             | —                            | Your `DiscoveryProvider`, used as supplied    |

## Health indicator

Registered as `service-discovery`, reporting `provider`, `cachedServices`, `watchedServices`,
`ejectedInstances`, and `degraded`. It reads the cache's own observed state and never issues a
backend call of its own — a health scrape should not become load against Consul. `degraded` means a
refresh failed and a stale snapshot is being served.

## Related documentation

- [Public API reference](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md)
- [Architecture](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md)

## License

MIT
