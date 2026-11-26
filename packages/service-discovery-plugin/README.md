# @setu-ts/service-discovery-plugin

Service discovery for Setu-TS — turns a logical service name into a reachable address, balances
across the instances behind it, and takes them out of rotation when callers report failures.

Registers an `IServiceDiscovery` under `CAPABILITIES.SERVICE_DISCOVERY`. **Zero npm dependencies**:
the HTTP providers run on web-standard `fetch` and the DNS provider on the optional
`IRuntimeServices.dns`.

## Install

```bash
npm install @setu-ts/service-discovery-plugin
# Deno: deno add npm:@setu-ts/service-discovery-plugin
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
service-account token from. So does any process outside a pod (a developer machine, a VM): without
`token` the provider reads `/var/run/secrets/kubernetes.io/serviceaccount/token`, and since M119c a
missing file is reported by one startup warning and a `DiscoveryUnavailableError` that name `token`
and `apiServer` (V10-44), rather than a silent `down`.

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
const call = resilience.wrap(
  async () => {
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
  },
  { retry: { limit: 3, delay: 100, backoff: 'exponential' } },
);
```

`wrap` re-enters the function on every attempt, so each retry picks again and lands on a different
instance once the failing one is ejected.

## Watching for changes

```typescript
const unsubscribe = await discovery.watch('billing', (instances) => {
  console.log(`billing now has ${instances.length} instances`);
});
```

The listener receives the **full** list. Each delivery updates the cache through the same rule as
reads: an empty change to a nonempty list is held for `emptyAnswerGraceMs`. One timer then starts a
coalesced background read at the grace deadline; an empty answer replaces the list and is delivered
to every watcher, even if the backend never repeats the empty change. Read-path list changes also
reach watchers, once per change. A read of a watched name still starts a background refresh once its
list is `cacheTtlMs` old.

Subscribers to one name share one provider watch. A later subscriber receives the cached list at
once; a listener may receive the current list on subscription and the same list more than once. The
provider watch stops when the last subscriber unsubscribes. A throwing listener does not block other
listeners or mark discovery degraded. Its error logs at `warn` as
`service-discovery-plugin: watch listener for '<name>' failed`, with the service name and masked
error and no instance data, once per name until every failing listener has succeeded, unsubscribed,
or its watch stopped. A read that started before a newer watch delivery neither replaces the
delivered list nor marks the name failed or starts retry spacing; a superseded failure opens no
outage or recovery log.

Discovery names should be chosen by the application, never taken from a request. As a backstop, the
resolve warnings of names with no non-empty list (never resolved, or only ever empty) share a budget
of 20 `warn` lines a minute; past it, further ones log at `debug` and one `warn` per minute window
says so. A name with a non-empty list always warns.

## Self-registration (Consul only)

```typescript
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';

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

The default id is `<serviceName>@<address>:<port>`, stable across restarts, so a restarted process
replaces its own orphan. `address` must be this instance's own address: a shared hostname gives two
instances the same default id, so one replaces the other's entry. Inside the service name and
address, `%` becomes `%25` and `@` becomes `%40`; no other character is encoded, so IPv6 remains
readable. Set `id` explicitly for another identity.

The health check is **not optional**: it defaults to
`{ httpPath: '/health', intervalSeconds: 10, deregisterAfterSeconds: 60 }` and cannot be disabled.
`onBootstrap` runs before the socket is bound, so the instance is advertised a moment before it can
serve — that window is harmless only because Consul marks a newly registered service critical until
its first check passes and every read here sends `passing=true`.

Configuring `selfRegistration` with any other provider throws `SelfRegistrationNotSupportedError` at
`register()` rather than silently doing nothing.

## Kubernetes RBAC

The `kubernetes` provider reads EndpointSlices with the pod's projected ServiceAccount token, so it
needs permission the plugin cannot grant itself:

```yaml
rules:
  - apiGroups: ['discovery.k8s.io']
    resources: ['endpointslices']
    verbs: ['get', 'list', 'watch']
```

`watch` is required as well as `list` — the provider re-LISTs on every watch event. The framework's
Helm chart renders this Role and its RoleBinding when `serviceDiscovery.enabled=true`; see the
[deployment guide](https://github.com/setu-ts/setu-ts/blob/main/docs/deployment.md).

## Kubernetes in-cluster TLS

The API server presents a cluster-internal CA that `fetch` rejects. No code change fixes this from
inside the process — point the runtime at the mounted CA bundle:

- Deno: `DENO_CERT=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`
- Node: `NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`

The `http` option is the alternative: supply your own `IDiscoveryHttp` over a TLS-configured client.

Without the CA the pod never becomes ready, and since 0.13.0 the readiness probe says why: the first
failure logs one `warn` under `service-discovery-plugin: kubernetes` naming the cause (Deno's
`UnknownIssuer`, or the API server's HTTP status), repeats log at `debug`, and the recovery logs one
`info`. A cold resolve's `DiscoveryUnavailableError` message ends with the same cause.

Service-account tokens are re-read from disk (memoized for 60 s) rather than read once at startup,
because Kubernetes rotates projected tokens roughly hourly — a token captured at registration stops
working while the pod is still healthy.

## Options

| Option               | Arms               | Default                      | Notes                                                                                                                      |
| -------------------- | ------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `provider`           | all                | —                            | Discriminant; always explicit                                                                                              |
| `cacheTtlMs`         | all                | `30_000`                     | Age that starts a background refresh; `0` refreshes every warm call; outside 0–2147483647 or `NaN` is refused              |
| `resolveTimeoutMs`   | all                | `2000`                       | Read bound, including DNS watch ticks; `0` unbounded; finite 0–2147483647                                                  |
| `emptyAnswerGraceMs` | all                | `30_000`                     | Hold a warm list on empty answers; `0` immediate; finite 0–2147483647                                                      |
| `strategy`           | all                | `'round-robin'`              | Overridable per `pick()` call                                                                                              |
| `ejection`           | all                | see above                    | `false` disables                                                                                                           |
| `selfRegistration`   | consul (+ custom)  | —                            | Throws on the other arms                                                                                                   |
| `watchIntervalMs`    | static, dns        | `30_000`                     | Absent from the push-based arms                                                                                            |
| `services`           | static             | —                            | Unknown name resolves to `[]`                                                                                              |
| `address`            | consul             | —                            | Agent base URL; one that does not parse or holds credentials is refused at startup, with any `http` transport; use `token` |
| `token`              | consul, kubernetes | — / projected token file     | Consul: `X-Consul-Token`; Kubernetes: bearer                                                                               |
| `datacenter`         | consul             | —                            | Sent as `?dc=`                                                                                                             |
| `waitSeconds`        | consul             | `30`                         | Clamped to Consul's maximum of `600`                                                                                       |
| `namespace`          | kubernetes         | —                            | Required                                                                                                                   |
| `apiServer`          | kubernetes         | in-cluster env               | Required outside a cluster; one that does not parse or holds credentials is refused at startup                             |
| `portName`           | kubernetes         | —                            | Required when a service exposes several ports                                                                              |
| `mode`               | dns                | —                            | `'srv'` or `'a'`                                                                                                           |
| `domainTemplate`     | dns                | `'{service}.service.consul'` | `{service}` is substituted                                                                                                 |
| `port`               | dns (`'a'` only)   | —                            | Mandatory: address records carry no port                                                                                   |
| `servers`            | dns                | host resolver                | Nonempty IP literals with optional ports; IPv6 ports need brackets; needs `runtime.createDnsResolver`                      |
| `secure`             | consul, k8s, dns   | `false`                      | Decides the `https` scheme                                                                                                 |
| `http`               | consul, kubernetes | `fetch`                      | Injectable transport                                                                                                       |
| `discovery`          | custom             | —                            | Your `DiscoveryProvider`, used as supplied                                                                                 |

## Faults

Warm names always answer from cache immediately. Once a list is `cacheTtlMs` old, a call starts a
background refresh; concurrent refreshes for one name coalesce. `cacheTtlMs: 0` starts a refresh on
every warm call, coalesced while one runs. The last good list survives failures indefinitely. Cold
names await one coalesced read, bounded by `resolveTimeoutMs` (default 2000 ms, `0` unbounded), and
reject with a branded 503 when it fails, including a Kubernetes API token rejection (401/403). Every
provider-thrown `DiscoveryUnavailableError` passes through unbranded and answers 500. The built-in
providers throw it for a multi-port Kubernetes service with no `portName`, a missing projected token
file or no runtime `fs` when no explicit token was supplied, or a Kubernetes service-account /
Consul ACL token holding anything but visible ASCII. A failed background refresh spaces retries by
1, 2, 4, 8, 16, then 30 seconds per name; a successful answer resets the spacing.

An empty answer holds a nonempty list for `emptyAnswerGraceMs` (default 30000 ms; `0` replaces at
once). Read and watch callers see the same held list, with `degraded: true`. Nonempty answers reset
the grace and clear its timer. A per-name timer starts a background read at the grace deadline,
coalesced with any active read and subject to normal failure retry spacing. Its empty answer
replaces the list and reaches every watcher without another backend event. A cold empty answer (a
name with no list yet, such as an absent DNS name) is cached like any other, but at most 256
unwatched names that have only ever answered empty stay cached; past that, the oldest is evicted (a
failing one last), and watched names are never evicted, so names taken from requests cannot grow the
cache; replacement and close clear the timer. An empty answer succeeded, so it does not raise
`staleForMs` or incur failure spacing.

DNS NXDOMAIN/no-record answers (`ENOTFOUND`, `ENODATA`, Deno `NotFound`, including wrapped causes)
resolve to `[]` only when every failed address family says absent. Any timeout or other failure
rejects and is reflected in health. Use a trusted resolver: a spoofed absent-name answer can empty
the list after the grace. On Deno 2.9.6, SERVFAIL also reads as `NotFound`, so it becomes `[]` after
the same grace rule.

The DNS arm accepts `servers?: readonly string[]`, for example `['127.0.0.1:7853', '[::1]:53']`.
Accepted entries are IPv4 (`127.0.0.1`), IPv4 with port (`127.0.0.1:7853`), bare IPv6 (`::1`), and
IPv6 with a bracketed port (`[::1]:53`). Ports are decimal 1–65535; omitted ports use 53. An empty
list, host names, empty strings, whitespace, malformed IPs and IPv6 zones are refused with a
`RangeError` (naming the entry; an empty list reads `servers must be a non-empty array`) at
`ServiceDiscoveryPlugin()` construction. A valid bare IPv6 literal such as `::1:5353` is an address
on port 53; to specify a port use brackets. `servers` requires `runtime.createDnsResolver` (Node,
Bun, Deno; not Workers); without it startup throws `DiscoveryUnavailableError` naming `servers`.
Omitting `servers` uses `runtime.dns`. `resolveTimeoutMs` bounds the whole lookup across all
servers, one attempt each; fractions are rounded up with `Math.ceil` for the runtime's integer
bound. `0` adds no lookup timer. On Deno a lookup may run about 2 s past the bound before its
underlying operation ends. DNS record TTLs are not read: `cacheTtlMs` stays the freshness bound.

Read failures log under `service-discovery-plugin: <kind> resolve '<serviceName>'`: first or changed
error at `warn`, identical repeats at `debug`, recovery at `info`, with URL userinfo masked. A name
keeps its reporter while its failure run is open, across cold and warm failures, so repeats log at
debug and the first success logs the recovery at info; the reporter is dropped at recovery. At most
256 cold names keep a reporter at once; a 257th cold failure evicts the least recently failing cold
name (its recovery then logs nothing). Warm names with nonempty cached lists retain their reporter
until recovery, regardless of cold-name churn. A watch listener error logs at `warn` once per name
(see Watching). Cold failures are not retry-spaced and do not mark discovery degraded. A DNS failure
may also produce a probe reporter line.

## Health indicator

Registered as `service-discovery`. Since M70c it composes three facts:

- `everResolved` — `false` until the first successful provider read, so a backend that was never
  reached is `down`, not `up` (the X10-3 fix).
- `data.degraded` — true when a warm name's last read failed, or an empty answer is held during its
  grace; the status stays `up`. Visible with `HealthPlugin({ details: true })`. Cold failures reject
  and log, then leave no cached failure state.
- `isHealthy()` — the provider's reachability probe (Consul `GET /v1/status/leader`, Kubernetes a
  `limit=1` EndpointSlice LIST). DNS uses the last lookup outcome: an absent name is success; any
  other failure, including a lookup abandoned at its bound, is unreachable. Before a lookup DNS
  reports reachable and issues no health lookup of its own. Stopping a DNS watch preserves the prior
  lookup outcome. Every provider's `isHealthy()` result passes through the same 5 s cache.

| Status | Meaning                                                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `up`   | The provider is reachable, or has resolved at least one service before. A name never cached still fails while the backend is down, so alert on `data.degraded`, `data.staleForMs` and `data.reachable` (in `/health` only with `HealthPlugin({ details: true })`). |
| `down` | The provider has never resolved and is unreachable.                                                                                                                                                                                                                |

`data` reports
`{ provider, cachedServices, watchedServices, ejectedInstances, degraded, reachable, everResolved, staleForMs }`.

## Errors

`DiscoveryUnavailableError` is thrown when discovery cannot answer. Its **cold-outage** instance — a
backend read failed and nothing is cached — carries a `503 Service Unavailable` status hint (M119g),
so `errorHandler` answers a named 503 with the fixed detail "Service discovery is temporarily
unavailable." rather than a masked 500. Configuration failures are not branded: the `'dns'` arm on a
runtime with no resolver and the `'kubernetes'` arm with neither a token nor `IRuntimeServices.fs`
are refused at startup, and a multi-port service with no `portName` fails its lookup with an
unbranded `DiscoveryUnavailableError` that is answered as a 500 — a misconfiguration is the
operator's to fix, not a temporary outage. `SelfRegistrationNotSupportedError` is thrown at
`register()` when `selfRegistration` is configured on a provider with no registration API.

## Related documentation

- [Public API reference](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#service-discovery-setu-tsservice-discovery-plugin)
- [Architecture](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md)

## License

MIT

## Exports

| Export                              | Kind      |
| ----------------------------------- | --------- |
| `createDefaultDiscoveryHttp`        | function  |
| `ServiceDiscoveryPlugin`            | function  |
| `ConsulProvider`                    | class     |
| `DiscoveryUnavailableError`         | class     |
| `DnsProvider`                       | class     |
| `KubernetesProvider`                | class     |
| `SelfRegistrationNotSupportedError` | class     |
| `StaticProvider`                    | class     |
| `ADnsDiscoveryOptions`              | interface |
| `ConsulDiscoveryOptions`            | interface |
| `ConsulProviderOptions`             | interface |
| `CustomDiscoveryOptions`            | interface |
| `DiscoveryHttpResponse`             | interface |
| `DiscoveryHttpStream`               | interface |
| `DiscoveryProvider`                 | interface |
| `EjectionOptions`                   | interface |
| `IDiscoveryHttp`                    | interface |
| `KubernetesDiscoveryOptions`        | interface |
| `KubernetesProviderOptions`         | interface |
| `SelfRegistration`                  | interface |
| `SelfRegistrationCheck`             | interface |
| `SrvDnsDiscoveryOptions`            | interface |
| `StaticDiscoveryOptions`            | interface |
| `StaticServiceDefinition`           | interface |
| `DnsDiscoveryOptions`               | type      |
| `DnsProviderOptions`                | type      |
| `ServiceDiscoveryPluginOptions`     | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Readiness and dependency outages (M113b)

Provider reachability probes are invoked as methods, retaining their receiver. Healthy Kubernetes
and Consul providers therefore report reachable and allow `/ready` to return 200. Since M113o, a
warm-cache outage also reports `up`, keeping serving replicas in rotation. `data.degraded` still
signals a failed read or a held empty answer; `data.staleForMs` is the age of the oldest list whose
last refresh failed (zero when none is failing); a warm list at any age keeps `/ready` 200. Alert on
the age; it is not a readiness cutoff. `data.reachable` exposes backend reachability. `/health`
includes `data` only with `HealthPlugin({ details: true })`; the default body carries each check's
`status` alone. Detailed reports expose every indicator's data, so protect the health endpoints when
they carry it
([Statuses](https://github.com/setu-ts/setu-ts/blob/main/packages/health-plugin/README.md#statuses)).

The discovery service caches reachability for 5 s, coalesces concurrent reads, and bounds each probe
at 2 s; a hung or rejecting probe reports `false`. Consul and Kubernetes probe requests carry an
`AbortSignal` aborted after 2 s by runtime timers, cleared on completion. Health reads now issue at
most one backend probe request per 5 s window per service instance. Before M113b, the detached
provider call threw before I/O and issued none.

Watch lookup and cache ordering: DNS polling keeps at most one raw resolver lookup pending per
watch, even after the caller-facing deadline; later ticks wait for it to settle. Kubernetes token
reads abandoned by cancellation do not update the token memo or start an HTTP request; an older read
cannot replace a newer cached token. Stopping the last subscriber also reapplies the empty-only
cache bound. Async listener rejections are isolated like synchronous throws. Only the latest call to each
listener can settle its failure state; older settlements are ignored. Removing a subscriber
or closing discovery during delivery prevents further calls to removed listeners in that broadcast.
Superseded reads never open outage or recovery logs. Empty-answer grace refreshes update retry
freshness without resetting the age used by `staleForMs`: time since the last successful refresh
that was not a held empty answer. An identical successful list resets that age too.
