# Milestone 143c — Calls Between Services That Hang or Pile Up (`@setu-ts/service-discovery-plugin`, `@setu-ts/resilience-plugin`, `@setu-ts/grpc-plugin`)

> **Status:** Planning. Branch: `feat/m143c-calls-between-services`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR into `develop`.

## 0. Objective & scope

The Services lane's only letter of the `v0.13.0` smoke closeout (ROADMAP "Milestone 143c"). Today a
hung or restarted registry takes every caller down, and gRPC calls pile onto one replica or onto a
peer that is gone. After this letter, a discovery read has a bound and a stale list survives it; an
empty answer follows one rule on every provider; a Consul self-registration keeps the same id across
restarts; a hung Kubernetes probe says that its bound fired; the DNS provider can report `down`,
treats "no such name" as an answer, and (with the Core half) can be pointed at a name server;
`grpcClient` reports every transport fault as an instance failure and sends a unary call that a
draining peer turned away to another replica; and the circuit breaker can open on a failure rate
(with the Core half). Every value below was checked against the code on `develop` at `d2ec1aef1`
and, where it touches the Core lane, against the M143i branch state.

- **In scope:** V13-101, V13-24, V13-25, V13-102, V13-103, V13-104, V13-246, V13-247, V13-52, and
  the `grpc-plugin` half of V13-23 (owned by M143i), plus M143i's hand-over of the streamed RPC
  `cancel()` that waits behind a blocked handler (§3.11). Code, tests and README/agent-card text in
  `packages/service-discovery-plugin`, `packages/resilience-plugin` and `packages/grpc-plugin`; this
  letter's entries in `CHANGELOG.md`, `PUBLIC_API.md` (the three packages' sections) and
  `docs/upgrading.md`.
- **NOT this milestone:** the kernel's GOAWAY at drain start and the drain accounting for RPC
  streams (M143i §3.5 and §3.6, already built on `feat/m143i-process-and-runtimes`); the
  `CircuitBreakerPolicy` change in `packages/common` and a DNS resolver that targets a name server
  in `packages/common` and `packages/runtime`, and the marker on the kernel's drain 503 (Core lane,
  see §11 Hand-overs, OD3, OD4 and the decided OD6); a headless Service and per-pod discovery in
  generated Kubernetes output (CLI lane, see §11); prose under `docs/` other than
  `docs/upgrading.md` (M143n).

### 0.1 Reproduction read, per row

| Row                            | What the code does today (file:line)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Why the symptom follows                                                                                                                                                                                                                     | Reproduces from source?                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| V13-101 (and X123-11 on `dns`) | `ConsulProvider.resolve` calls `#http.request(url, { headers })` with no signal (`consul-provider.ts:150-153`); `KubernetesProvider.resolve` likewise (`kubernetes-provider.ts:196-199`); `DnsProvider.resolve` awaits `resolveSrv`/`resolveHost` with no bound (`dns-provider.ts:112`, `:123`). `ServiceDiscoveryService.#read` falls back to the stale entry only in `catch` (`service-discovery-service.ts:244-257`), and `resolve` coalesces every caller onto the one in-flight read (`:168-179`). A stale serve does not re-stamp the entry (`:251-256`). | A hung backend never rejects, so every caller waits on the coalesced read for as long as the backend hangs, and `#degraded` is never set (`/ready` 200, `degraded: false`). After it finally fails, the next call after expiry waits again. | Yes.                                                             |
| V13-102                        | `#read` stores any successful answer, including `[]` (`service-discovery-service.ts:245-249`); the watch listener does the same (`:212-219`). Consul's `?passing=true` read answers `[]` right after an agent restart (`consul-provider.ts:79`).                                                                                                                                                                                                                                                                                                                | The warm list is replaced by `[]`, so `pick()` returns null for a whole `cacheTtlMs`. The ejection layer refuses to empty a pool (`ejection-tracker.ts:114-118`) but the cache has no such rule.                                            | Yes.                                                             |
| V13-103                        | `selfId` defaults to `${serviceName}-${runtime.uuid()}` (`consul-provider.ts:276`), memoised per registration object only (`:271-281`).                                                                                                                                                                                                                                                                                                                                                                                                                         | Each process start registers a new id. A crashed process never deregisters, and its HTTP check targets an address the restarted process answers, so the orphan passes forever.                                                              | Yes.                                                             |
| V13-104                        | `CircuitBreaker.#recordFailure` trips when `failures.length >= threshold` inside the `timeout` window (`circuit-breaker.ts:115-126`); successes are not counted at all (`:86-92`). `CircuitBreakerPolicy` has `threshold`, `timeout`, `resetTimeout` only (`common/src/services/resilience.ts:96-106`).                                                                                                                                                                                                                                                         | Sensitivity scales with traffic: at high volume one failing instance in three reaches the absolute count at once.                                                                                                                           | Yes.                                                             |
| V13-246                        | The `dns` arm has no server option (`options.ts:116-152`); the resolver is `createNodeDnsResolver()` over the namespace import of `node:dns/promises` (`runtime/src/adapters/shared/node-dns-resolver.ts:13`, `:70`). `DnsProvider` has no `isHealthy`, so the probe returns `true` (`service-discovery-service.ts:87-88`). No TTL is read (`dns-provider.ts:107-137`).                                                                                                                                                                                         | Only the host resolver can be used; `dns.setServers` in application code changes the CommonJS module, not the ESM bindings the runtime holds. The indicator is `reachable: true` whatever happens.                                          | Yes (the `setServers` half from the report's probe, not re-run). |
| V13-247                        | `DnsProvider.resolve` lets Node's `ENOTFOUND`/`ENODATA` rejection through (`dns-provider.ts:123`); `#read` treats every rejection as a failed refresh and serves stale (`service-discovery-service.ts:251-256`).                                                                                                                                                                                                                                                                                                                                                | An authoritative "no such name" is read as an outage, so the removed instances are served for as long as the name stays absent.                                                                                                             | Yes.                                                             |
| V13-52                         | `KubernetesProvider.isHealthy` aborts its request with a bare `controller.abort()` after 2 s (`kubernetes-provider.ts:222-223`) and lets the rejection reach the reporter (`service-discovery-service.ts:98-102`).                                                                                                                                                                                                                                                                                                                                              | The log line is the platform's `AbortError: This operation was aborted`, which names neither the API server nor the bound.                                                                                                                  | Yes.                                                             |
| V13-25                         | `#attempt` reports `failure` only for `isRefusedStream` or `runtime.isUnavailable(error)` (`grpc-client.ts:515-531`). connect-node maps a peer reset to `Aborted`/`Internal`/`Canceled` (`@connectrpc/connect-node/dist/esm/node-error.js:20-57`, `:105-118`); a non-gRPC HTTP response becomes `codeFromHttpStatus` (`@connectrpc/connect/dist/esm/protocol-grpc/validate-response.js:31-33`, 404 is `Unimplemented`).                                                                                                                                         | A peer that closes, resets or does not speak HTTP/2, or an HTTP server without the service at that port, counts as `success`; with `failureThreshold: 1` the instance stays in rotation and fails every other call.                         | Yes (the four cases from the report's table).                    |
| V13-24                         | One cached transport and HTTP/2 session per origin (`grpc-client.ts:561-606`); the generated workspace discovery map lists one host per sibling, the Kubernetes Service name (`cli/src/workspace/discovery-module.ts:114-127`).                                                                                                                                                                                                                                                                                                                                 | kube-proxy balances connections, not streams, so one session pins every call to one pod.                                                                                                                                                    | Yes.                                                             |
| V13-23 (`grpc-plugin` half)    | The kernel answers a pre-pipeline 503 while `#stopping` (`kernel/src/application/application.ts:1084-1102` on `develop`, `:1320-1337` on the M143i branch); `grpcClient` resends only a refused stream (`grpc-client.ts:211-234`, `:453-480`). connect maps an HTTP 503 with no `grpc-status` to `Unavailable` with message `HTTP 503` and `isWireError` unset (`validate-response.js:31-33`; `protocol-connect/validate-response.js:31-38`).                                                                                                                   | After M143i's GOAWAY, a stream that raced it is still answered 503 by the draining peer and fails, although its handler never ran.                                                                                                          | Yes, from source; the race window after GOAWAY was not measured. |

### 0.2 Compared with (sibling code and established frameworks)

Each cell was read from the linked documentation or source on 2026-11-22; a cell marked "not
verified" was not.

| Question                                       | This repo today                                                                                                                                                                                                         | gRPC (grpc-go, gRFCs)                                                                                                                                                                                            | Envoy                                                                                                                                                                                          | Netflix Eureka / Spring Cloud                                                                                                                                                                         | .NET (`Grpc.Net.Client`, service discovery)                                                                                                    | Resilience4j / Polly / opossum                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 Bound on a registry read                    | Probe bound 2 s (`service-discovery-service.ts:105-106`); none on `resolve`. Request-path backend calls elsewhere default to 5 s (`secrets-plugin/src/providers/vault.ts:18`, `idempotency-plugin/src/constants.ts:90`) | DNS lookup under `ResolvingTimeout`, default 30 s (`internal/resolver/dns/dns_resolver.go`); resolution runs in the background, so a call never waits for it                                                     | not verified                                                                                                                                                                                   | Eureka: callers read a local copy refreshed in the background (not verified for the timeout value)                                                                                                    | DNS resolver caches; refreshed when a connection is interrupted or on an optional `refreshInterval` (learn.microsoft.com, gRPC load balancing) | not applicable                                                                                                                                                                                                                                                                                                                  |
| Q2 A failed refresh with a list in hand        | Serve stale (`service-discovery-service.ts:251-256`)                                                                                                                                                                    | A resolver error keeps the existing subchannels (`balancer/base/balancer.go`, `ResolverError`)                                                                                                                   | not verified                                                                                                                                                                                   | Eureka self-preservation stops evicting registrations when many renewals stop at once (Eureka wiki)                                                                                                   | not verified                                                                                                                                   | not applicable                                                                                                                                                                                                                                                                                                                  |
| Q3 An empty answer with a list in hand         | `[]` replaces the list (`:245-249`); the ejection layer never empties a pool (`ejection-tracker.ts:114-118`)                                                                                                            | NXDOMAIN is not an error: the DNS resolver sends an empty update, and an update with zero addresses shuts every subchannel down (`dns_resolver.go` `handleDNSError`; `base/balancer.go` `UpdateClientConnState`) | not verified                                                                                                                                                                                   | Eureka: self-preservation (keeps entries); Spring Cloud Consul: not verified                                                                                                                          | not verified                                                                                                                                   | not applicable                                                                                                                                                                                                                                                                                                                  |
| Q4 Default registration id                     | `<name>-<uuid>`, new per process (`consul-provider.ts:276`)                                                                                                                                                             | not applicable                                                                                                                                                                                                   | not applicable                                                                                                                                                                                 | Spring Cloud Consul: `${spring.application.name}:<profiles>:${server.port}`, stable across restarts (Spring Cloud Consul reference); Consul itself defaults `ID` to `Name` (Consul agent service API) | not applicable                                                                                                                                 | not applicable                                                                                                                                                                                                                                                                                                                  |
| Q5 What counts as an instance failure          | `Unavailable` or a refused stream only (`grpc-client.ts:515-531`)                                                                                                                                                       | Outlier detection (gRFC A50) leaves what counts to the caller (per the smoke report; not verified by this plan)                                                                                                  | Locally originated errors (timeout, reset, connect failure) count; with `split_external_local_origin_errors` they have their own counter (outlier detection docs)                              | not applicable                                                                                                                                                                                        | not verified                                                                                                                                   | not applicable                                                                                                                                                                                                                                                                                                                  |
| Q6 Resend a call a draining server turned away | Refused stream and `GOAWAY` only (`grpc-client.ts:211-234`)                                                                                                                                                             | Transparent retry covers a stream refused (`REFUSED_STREAM`) or past a `GOAWAY`'s last stream id; a bare HTTP 503 is not covered, and only a configured `retryPolicy` resends status codes (gRFC A6)             | Nothing is retried unless configured; `gateway-error` covers 502/503/504, `refused-stream` and `reset` are separate, gRPC `unavailable` reads `grpc-status` 14 in headers (router filter docs) | not applicable                                                                                                                                                                                        | not verified                                                                                                                                   | not applicable                                                                                                                                                                                                                                                                                                                  |
| Q7 One HTTP/2 connection pinned to one replica | One session per origin (`grpc-client.ts:576-583`)                                                                                                                                                                       | Server `MAX_CONNECTION_AGE`, default infinite (grpc.io keepalive guide)                                                                                                                                          | not verified                                                                                                                                                                                   | not applicable                                                                                                                                                                                        | A network load balancer pins every call of one connection; the remedy is client-side balancing over a headless Service, or an L7 proxy         | not applicable                                                                                                                                                                                                                                                                                                                  |
| Q8 DNS name server, bound, TTL                 | Host resolver only; no bound; no TTL                                                                                                                                                                                    | Re-resolution no more often than every 30 s (`MinResolutionInterval`)                                                                                                                                            | not verified                                                                                                                                                                                   | not applicable                                                                                                                                                                                        | not verified                                                                                                                                   | not applicable. Node's own `dns.promises.Resolver` takes `timeout` and `tries` (default 4), and `setServers` on an instance affects only that instance; only `resolve4`/`resolve6` return TTLs, `resolveSrv` never does (nodejs.org dns). Deno's `resolveDns` takes `nameServer: { ipAddr, port }` and `signal` (docs.deno.com) |
| Q9 Breaker trip rule and defaults              | Absolute count in a time window (`circuit-breaker.ts:115-126`); the sibling ejection cap is a percentage (`options.ts:189-194`, `maxEjectionPercent`)                                                                   | not applicable                                                                                                                                                                                                   | not applicable                                                                                                                                                                                 | Hystrix: not verified                                                                                                                                                                                 | Polly v8 below                                                                                                                                 | Resilience4j: `failureRateThreshold` 50 (percent), `minimumNumberOfCalls` 100, count window of 100. Polly v8: `FailureRatio` 0.1 (a ratio), `MinimumThroughput` 100, `SamplingDuration` 30 s, `BreakDuration` 5 s. opossum: `errorThresholdPercentage` 50, `volumeThreshold` 0, `rollingCountTimeout` 10 s in 10 buckets        |

| Q10 How a server marks a refusal as safe to resend | Nothing on the drain 503
(`application.ts:1320-1337`, M143i branch); the client trusts only a refused stream or GOAWAY
(`grpc-client.ts:211-234`). Repo header precedent: `x-setu-instance`, `x-setu-attempt`,
`x-setu-session` | gRFC A6: a stream refused or above a GOAWAY's last stream id was never seen by
the server application and is resent transparently, outside `maxAttempts` | `x-envoy-overloaded` is
set on a request Envoy dropped for maintenance mode or circuit breaking; the docs state no resend
rule for it (router filter docs) | not applicable | not verified | HTTP/2 (RFC 9113 §8.7):
`REFUSED_STREAM` means the stream was closed before any processing and its request "can be safely
retried"; streams above a GOAWAY's last id are "guaranteed to be safe to retry", and a server must
not claim that unless it can guarantee it. HTTP (RFC 9110 §10.2.3): `Retry-After` indicates only how
long to wait before a follow-up request, nothing about processing |

Second survey, read from the linked documentation or source on 2026-11-22 (each cell names its
source; "not verified" where it could not be confirmed):

| Question                                       | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1b Registry read bounds and who waits         | grpc-go DNS `ResolvingTimeout` 30 s, pushed to the ClientConn ([dns_resolver.go](https://raw.githubusercontent.com/grpc/grpc-go/master/internal/resolver/dns/dns_resolver.go)); Envoy `dns_refresh_rate` 5000 ms, requests use the host set a background refresh keeps ([cluster.proto](https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/cluster.proto)); Eureka callers read `localRegionApps`, refreshed every 30 s, read timeout 8 s ([DefaultEurekaClientConfig](https://github.com/Netflix/eureka/blob/master/eureka-client/src/main/java/com/netflix/discovery/DefaultEurekaClientConfig.java)); Spring Cloud Consul `getInstances` calls Consul synchronously, caching only through Spring Cloud LoadBalancer (TTL 35 s) ([ConsulDiscoveryClient](https://github.com/spring-cloud/spring-cloud-consul/blob/main/spring-cloud-consul-discovery/src/main/java/org/springframework/cloud/consul/discovery/ConsulDiscoveryClient.java)); .NET ServiceDiscovery refresh 60 s, DNS resolver timeout 3 s × 2 attempts, the caller awaits once the cache expires ([ServiceEndpointWatcher](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.ServiceDiscovery/ServiceEndpointWatcher.cs)) |
| Q2b Retry spacing after a failed refresh       | grpc-go 1 s × 1.6, jitter 0.2, max 120 s, reset on success ([backoff.go](https://github.com/grpc/grpc-go/blob/master/backoff/backoff.go)); Envoy `dns_failure_refresh_rate` base required, max 10 × base; Eureka doubles to 10 × interval on timeouts only ([TimedSupervisorTask](https://github.com/Netflix/eureka/blob/master/eureka-client/src/main/java/com/netflix/discovery/TimedSupervisorTask.java)); .NET DNS 1 s × 2 to 30 s, no jitter ([DnsServiceEndpointProviderOptions](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.ServiceDiscovery.Dns/DnsServiceEndpointProviderOptions.cs))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Q3b A successful empty answer                  | Envoy STRICT_DNS: 0 hosts means no hosts ([service discovery](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/service_discovery)); .NET: replaces the set and retries with backoff ([DnsServiceEndpointProviderBase](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.ServiceDiscovery.Dns/DnsServiceEndpointProviderBase.cs)); Eureka: a successful response replaces the cache, a failed one keeps it (empty guard not verified); Consul checks start `critical` unless `status` is set ([checks](https://developer.hashicorp.com/consul/docs/services/usage/checks)), so `?passing` can be empty after a (re-)registration (the agent-restart case itself not documented, not verified)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Q4b Outlier failures                           | Envoy: local-origin errors and 5xx share one bucket unless `split_external_local_origin_errors`; `consecutive_gateway_failure` counts 502/503/504 and local failures ([outlier](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier)); gRFC A50 implementations count any non-OK status (grpc-go `info.Err == nil`, grpc-js `statusCode === Status.OK`) but eject on success-rate or failure-percentage over a request volume (defaults 100 and 50) ([A50](https://github.com/grpc/proposal/blob/master/A50-xds-outlier-detection.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q5 A cancelled stream whose handler is blocked | gRPC "does not have a mechanism to interrupt the application-provided server handler" ([cancellation guide](https://grpc.io/docs/guides/cancellation/)); grpc-go cancels the handler context, `Stop` does not wait unless `WaitForHandlers(true)`, unbounded ([server.go](https://github.com/grpc/grpc-go/blob/master/server.go)); grpc-js sets `cancelled` and emits `'cancelled'`, awaits nothing; connect-es `HandlerContext.signal` aborts on deadline, error and shutdown; WHATWG `ReadableStreamCancel` runs the source's cancel at once; ECMA-262 §27.9.1.3 queues `return()` on an executing async generator; no framework found that bounds the wait (not exhaustive)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q8b A 503 without `grpc-status`                | gRPC maps it to `UNAVAILABLE` ([status mapping](https://github.com/grpc/grpc/blob/master/doc/http-grpc-status-mapping.md)); A6 transparent retry covers refused streams and GOAWAY only, outside `maxAttempts`, and does not address an HTTP status ([A6](https://github.com/grpc/proposal/blob/master/A6-client-retries.md)); Envoy `5xx`/`gateway-error`/`retriable-status-codes` only when configured; Finagle marks a no-work 503 with `finagle-http-nack` (retryable) vs `finagle-http-nonretryable-nack` ([HttpNackFilter](https://github.com/twitter/finagle/blob/develop/finagle-base-http/src/main/scala/com/twitter/finagle/http/filter/HttpNackFilter.scala)), the closest precedent for a server-set "not processed" header; Linkerd documents none; Istio not verified                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q11 Runtime DNS APIs                           | Node `Resolver` `timeout` (default -1, c-ares default), `tries` (default 4), instance-scoped `setServers` taking IP literals, `resolveSrv` with no TTL, `ENOTFOUND`/`ENODATA` ([nodejs.org dns](https://nodejs.org/api/dns.html)); Deno `resolveDns` `nameServer {ipAddr, port}` and `signal`, `Deno.errors.NotFound` for NXDOMAIN and no records (`ares_code` distinguishes), a signal forces a 1 s one-attempt timeout ([ops.rs](https://github.com/denoland/deno/blob/main/ext/net/ops.rs)); Bun `node:dns` fully implemented except `resolveTlsa`, `Resolver` `maxTimeout` ignored ([compat](https://bun.com/docs/runtime/nodejs-compat))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Q12 Default registration id                    | Consul: defaults to the service name, unique per agent ([agent service API](https://developer.hashicorp.com/consul/api-docs/agent/service)); Spring Cloud Consul: application name plus instance id or port ([ConsulAutoRegistration](https://github.com/spring-cloud/spring-cloud-consul/blob/main/spring-cloud-consul-discovery/src/main/java/org/springframework/cloud/consul/serviceregistry/ConsulAutoRegistration.java)); Micronaut: `appName:<instance id or port>`, with a documented collision warning across hosts ([guide](https://micronaut-projects.github.io/micronaut-discovery-client/latest/guide/)); Go-kit not verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Where the frameworks split (Q2/Q3 between keep and replace, Q6 between "retry only when configured"
and "transparent", Q9 between a percentage and a ratio), each choice is DECIDED by the maintainer
(OD1, OD6, recorded in §3.1 and §3.9) or is listed in §12 Open decisions, and the design decision
names the recommendation it is written against.

## 1. Contracts verified from SOURCE (not names)

| Reference                                                              | Source (file:line)                                                                                                                                                                                                              | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DiscoveryProvider` (plugin port, exported)                            | `packages/service-discovery-plugin/src/interfaces/index.ts:17-79`                                                                                                                                                               | `kind`, `resolve(serviceName)`, `watch(serviceName, listener)`, optional `registerSelf`, `deregisterSelf`, `isHealthy`. `isHealthy` may reject with its reason (`:70-74`). No signal parameter on `resolve`.                                                                                                                                                                                                                                                                                                                                        |
| `IDiscoveryHttp.request`                                               | `interfaces/index.ts:225-248`                                                                                                                                                                                                   | `request(url, init?)`; "An implementation must honour `init.signal`" (`:231-232`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SelfRegistration.id`                                                  | `interfaces/index.ts:107-130`                                                                                                                                                                                                   | Optional; JSDoc "Defaults to `<name>-<uuid>`" (`:110`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `CommonDiscoveryOptions`, `ResolvedDiscoveryOptions`, `resolveOptions` | `packages/service-discovery-plugin/src/options.ts:22-37`, `:201-217`, `:231-265`                                                                                                                                                | `cacheTtlMs`, `strategy`, `ejection`, `selfRegistration`; resolved adds `watchIntervalMs`, `waitSeconds`. Explicit `!== undefined` checks for `0` (`:219-226`). No time bound option. Not validated for range today.                                                                                                                                                                                                                                                                                                                                |
| DNS arm options                                                        | `options.ts:116-152`                                                                                                                                                                                                            | `provider: 'dns'`, `domainTemplate`, `secure`, `watchIntervalMs`, `mode`, `port` (mode `'a'`). No server, no bound.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ServiceDiscoveryService`                                              | `packages/service-discovery-plugin/src/services/service-discovery-service.ts:46-277`                                                                                                                                            | Cache `Map<string, {instances, stampMs}>` (`:36-39`, `:54`); coalescing `#inFlight` (`:55`, `:168-179`); `#read` (`:240-276`); stale on rejection sets `#degraded` (`:251-256`); a cold failure is a `DiscoveryUnavailableError` with `withHttpStatusHint` 503, except a provider's own `DiscoveryUnavailableError`, which passes through as a 500 (`:258-274`). Probe: `createCachedProbe`, ttl 5000, timeout 2000, `isHealthy === undefined` returns `true` (`:85-108`). `report` reads the cached list length for the ejection cap (`:200-206`). |
| Health indicator                                                       | `packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts:115-133`                                                                                                                                              | `status` is `down` only when `!everResolved && !reachable`; data `{ provider, cachedServices, watchedServices, ejectedInstances, degraded, reachable, everResolved }`. Reporter `createConnectionErrorReporter({ source: 'service-discovery-plugin: <kind>' })` (`:83-86`).                                                                                                                                                                                                                                                                         |
| `ConsulProvider`                                                       | `packages/service-discovery-plugin/src/providers/consul-provider.ts:46-282`                                                                                                                                                     | `resolve` (`:150-160`), `isHealthy` with its own 2 s abort, returning `false` on any failure (`:168-181`), `registerSelf` PUT `/v1/agent/service/register` (`:205-244`), `selfId` (`:271-279`).                                                                                                                                                                                                                                                                                                                                                     |
| `KubernetesProvider`                                                   | `packages/service-discovery-plugin/src/providers/kubernetes-provider.ts:68-283`                                                                                                                                                 | `resolve` (`:196-206`); `isHealthy` bare `controller.abort()` at 2000 ms, rejects with the cause (`:221-239`); `isMissingFile` cross-runtime error classifier precedent, `@internal` export (`:295-303`).                                                                                                                                                                                                                                                                                                                                           |
| `DnsProvider`                                                          | `packages/service-discovery-plugin/src/providers/dns-provider.ts:78-188`                                                                                                                                                        | `resolve` (`:107-137`), polling `watch` that swallows a failed tick (`:145-187`); no `isHealthy`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `createProvider` (dns arm)                                             | `packages/service-discovery-plugin/src/providers/provider-factory.ts:129-149`                                                                                                                                                   | Refuses with `DiscoveryUnavailableError` when `runtime.dns` is absent; passes `runtime.dns` to `DnsProvider`.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `EjectionTracker.filter` / `record`                                    | `packages/service-discovery-plugin/src/services/ejection-tracker.ts:69-101`, `:114-118`                                                                                                                                         | A success clears the instance's window; `filter` returns the whole list when everything is ejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `IDnsResolver`, `IRuntimeServices.dns`                                 | `packages/common/src/runtime.ts:268-289`, `:420`                                                                                                                                                                                | `resolveSrv(hostname)`, `resolveHost(hostname)`; no options, no signal. `dns?` is optional and absent on Workers. Not changed by the M143i branch (its `runtime.ts` diff adds `SIGHUP`, `FatalErrorOrigin` and an observer member only).                                                                                                                                                                                                                                                                                                            |
| Node/Bun DNS resolver                                                  | `packages/runtime/src/adapters/shared/node-dns-resolver.ts:13`, `:70-85`                                                                                                                                                        | Namespace import of `node:dns/promises`; injectable `NodeDnsModule` with `resolveSrv`, `resolve4`, `resolve6`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Deno DNS resolver                                                      | `packages/runtime/src/adapters/deno/deno-dns-resolver.ts:55-80`                                                                                                                                                                 | `host.resolveDns(hostname, 'SRV'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 'A'                                                                                       | 'AAAA')`; no options passed. |
| `withDeadline`, `deadlineRangeError`                                   | `packages/common/src/health/deadline.ts:77-85`, `:118-158`; exported `packages/common/src/index.ts:97`                                                                                                                          | Hands the call a signal, races it, aborts with and REJECTS with the caller's `onTimeout()` error, propagates the call's own rejection unchanged; `0` is unbounded; `deadlineRangeError(name, ms)` for construction-time refusal (0 to 2147483647).                                                                                                                                                                                                                                                                                                  |
| `createCachedProbe`                                                    | `packages/common/src/health/probe.ts:121-137`                                                                                                                                                                                   | Never rejects; a timeout resolves the fallback (`false`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `createConnectionErrorReporter`, `describeError`                       | `packages/common/src/health/connection-errors.ts:15-17`, `:71-84`, `:133-163`; used at `service-discovery-plugin.ts:14-17`, `:83-86`; `packages/common/src/errors/describe-error.ts:51-55`                                      | `report(error)`: the first error of a run, or one whose rendered text differs, at `warn`; an identical repeat at `debug` with a `repeats` count; `recovered()` logs `info` once after errors and resets. `describeError` masks URL userinfo.                                                                                                                                                                                                                                                                                                        |
| Readiness HTTP mapping                                                 | `packages/health-plugin/src/plugin/health-plugin.ts:348-358`                                                                                                                                                                    | `checkReady` answers 503 for any status that is not `up`; overall health answers 503 only for `down`. So an indicator `degraded` status pulls a replica out of readiness.                                                                                                                                                                                                                                                                                                                                                                           |
| Kernel error writer and response header API                            | `packages/common/src/errors/error-responder.ts:163-188`, `:245-270` (M143i branch); `packages/kernel/src/context/response.ts:98`, `:116`                                                                                        | `respondWithError` delegates to the registered responder (whose body and content type are the application's) or writes `{ error }` JSON; `ErrorResponseInit` has no header member. `ResponseBuilder.header(name, value)` and `setHeaders` exist, so the kernel can add a header after the writer.                                                                                                                                                                                                                                                   |
| Existing Setu header names                                             | `grep` over `packages/*/src` on `develop`                                                                                                                                                                                       | Lower-case `x-setu-*` names are the convention (`x-setu-instance`, `x-setu-attempt`, `x-setu-session`, `x-setu-sequence`, `x-setu-mac`); no `x-setu-unprocessed` exists yet.                                                                                                                                                                                                                                                                                                                                                                        |
| `CircuitBreakerPolicy`, `WrapOptions`                                  | `packages/common/src/services/resilience.ts:96-106`, `:147-156`                                                                                                                                                                 | `threshold`, `timeout` (rolling window, ms), `resetTimeout`. `WrapOptions.circuitBreaker?: boolean                                                                                                                                                                                                                                                                                                                                                                                                                                                  | CircuitBreakerPolicy`. An existing committed contract: a new field is a Core-lane change. |
| `CircuitBreaker`                                                       | `packages/resilience-plugin/src/patterns/circuit-breaker.ts:24-132`                                                                                                                                                             | Internal (not in `src/index.ts`). Successes are not recorded in the closed state (`:86-92`); trip in `#recordFailure` (`:115-126`); single half-open probe (`:94-113`).                                                                                                                                                                                                                                                                                                                                                                             |
| `ResilienceService` breaker resolution                                 | `packages/resilience-plugin/src/services/resilience-service.ts:82`, `:106`, `:133-140`                                                                                                                                          | One `CircuitBreaker` per `wrap`; `true` needs `defaultCircuitBreaker`. No breaker policy validation (retry has `validateRetryPolicy`, `resilience-plugin.ts:46`).                                                                                                                                                                                                                                                                                                                                                                                   |
| `GrpcClientOptions`                                                    | `packages/common/src/services/grpc.ts:148-172`                                                                                                                                                                                  | `basePath`, `protocol`, `httpVersion`, `timeoutMs`. Committed contract; this letter adds nothing to it.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GrpcPluginOptions`                                                    | `packages/grpc-plugin/src/interfaces/index.ts:16-60+`                                                                                                                                                                           | Lane-owned; `clients?: Record<string, GrpcClientOptions>`; `connectModule?: ConnectRuntime`.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ConnectRuntime` (internal port)                                       | `packages/grpc-plugin/src/interfaces/connect-runtime.ts:155-209`; not exported (`src/index.ts:70-71`)                                                                                                                           | `unavailable(message, cause?)`, `isUnavailable(error)`; built by `adaptConnectModule` (`transports/connect-loader.ts:112-170`); faked in `test/fixtures/fake-connect-runtime.ts:243-249`.                                                                                                                                                                                                                                                                                                                                                           |
| `GrpcClients`                                                          | `packages/grpc-plugin/src/client/grpc-client.ts:325-655`                                                                                                                                                                        | `#call` resends a unary refused stream once within the remaining deadline (`:453-480`); `#attempt` picks, runs, reports (`:482-533`); `isRefusedStream` (`:211-234`); transports cached per origin (`:561-606`).                                                                                                                                                                                                                                                                                                                                    |
| `ConnectError.isWireError`                                             | `@connectrpc/connect@2.3.0` `dist/esm/connect-error.d.ts:53`; set in `protocol-grpc/trailer-status.js:93`, `:109` and `protocol-connect/error-json.js:54-55`                                                                    | `true` exactly when the error was decoded from a server's gRPC status or Connect error body; an HTTP-status-derived or transport error leaves it `false`.                                                                                                                                                                                                                                                                                                                                                                                           |
| HTTP status mapping                                                    | `@connectrpc/connect` `protocol-grpc/validate-response.js:31-33`, `protocol-connect/validate-response.js:31-38`, `protocol-connect/http-status.js:25-41`                                                                        | A non-200 response throws `ConnectError("HTTP <n>", codeFromHttpStatus(n), headers)`; 404 is `Unimplemented`; 429, 502, 503, 504 are `Unavailable`. A Connect unary JSON error body replaces it with a wire error.                                                                                                                                                                                                                                                                                                                                  |
| connect-node transport errors                                          | `@connectrpc/connect-node@2.3.0` `dist/esm/node-error.js:20-57`, `:105-118`                                                                                                                                                     | `ECONNRESET`/`ERR_STREAM_DESTROYED` are `Aborted`; `ECONNREFUSED`/`ETIMEDOUT`/`ENOTFOUND` are `Unavailable`; RST codes `PROTOCOL_ERROR` etc. are `Internal`, `CANCEL` is `Canceled`, `REFUSED_STREAM` is `Unavailable`.                                                                                                                                                                                                                                                                                                                             |
| Kernel drain 503                                                       | `packages/kernel/src/application/application.ts:1084-1102` (develop); `:1320-1337` (M143i branch)                                                                                                                               | Pre-pipeline problem response, status 503, title `Service Unavailable`, written through the error responder when one is registered; no marker header.                                                                                                                                                                                                                                                                                                                                                                                               |
| M143i hand-over to this letter                                         | `.claude/worktrees/m143i-process-and-runtimes-b7bbc8/plans/archive/milestone-143i-process-and-runtimes.md:167-185`, `:612`                                                                                                      | "`grpcClient` retries an HTTP 503 answer that carries no `grpc-status` from a peer (the kernel's drain 503 for a stream that raced GOAWAY)."                                                                                                                                                                                                                                                                                                                                                                                                        |
| Generated workspace discovery map                                      | `packages/cli/src/workspace/discovery-module.ts:100-170`                                                                                                                                                                        | One `{ host, port }` per sibling; host from `<MEMBER>_HOST`, the Compose or Kubernetes Service name. Read only (CLI lane).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@setu-ts/sdk` breaker (other lane, read only)                         | `packages/sdk/src/circuit-breaker/circuit-breaker.ts:48`, `:94`, `:96`; `sdk/src/http/contracts.ts:205`; `sdk/src/index.ts:31`                                                                                                  | Reads `policy.threshold`/`policy.timeout` from `CircuitBreakerPolicy`; re-exports the type. The union breaks it (§3.7, OD4b).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| connect JSON error bodies                                              | `@connectrpc/connect` `protocol-connect/validate-response.js:32-37`, `protocol-connect/transport.js:112-113`, `protocol-connect/error-json.js:36-55`                                                                            | A non-200 unary reply with a JSON content type is parsed as a Connect error; any JSON object yields `isWireError = true`, the HTTP-derived code when the body has no `code`, response headers on `metadata`.                                                                                                                                                                                                                                                                                                                                        |
| connect streaming body and cancel                                      | `protocol-grpc/handler-factory.js:85-119`, `:99-102`; `protocol/async-iterable.js:22-32`, `:113-114`; grpc-plugin `transports/rpc-call.ts:133-135`, `transports/native-grpc-reply.ts:57-60`, `transports/rpc-dispatcher.ts:148` | The body is an async generator; `return()` queues behind a pending `next()`; the call signal reaches the handler context.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Kernel streamed-body cancel (M143i branch)                             | `kernel/src/application/deferred.ts:157-187`, `:185`, `:205-210`; `application.ts:2131-2133`, `:1266`, `:1284`                                                                                                                  | The kernel aborts the request signal only on the client-abort path with cleanups; it awaits `cancel()` with no bound.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `createCapabilityToken`                                                | `packages/common/src/tokens.ts:438`                                                                                                                                                                                             | No new token in this letter (checked: every change is an option, a port member or an internal file).                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                                       | Resolution (picked side)                                                                                                                        | Doc deliverable (same PR)                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| C1  | `grpc-plugin/README.md:113`: "`failure` for `Unavailable` (a refused, reset or closed connection)" vs `grpc-client.ts:530`, where a reset or closed connection is `Canceled`/`Internal`/`Aborted` and counts as success.                                       | The code changes (§3.8); the sentence is rewritten to the new rule.                                                                             | `grpc-plugin/README.md` "Target" bullet and `AGENT_CARD.md`.                                                |
| C2  | `dns-health.test.ts:7-21` and `interfaces/index.ts:61-78` record a M70c decision that the DNS arm omits `isHealthy`; `README.md:256-257` says `down` means "never resolved and unreachable", which the DNS arm can never be.                                   | The README's meaning wins; the DNS provider gains `isHealthy` (§3.5) and the M70c test is replaced.                                             | `service-discovery-plugin/README.md` "Health indicator"; JSDoc of `DiscoveryProvider.isHealthy`.            |
| C3  | `PUBLIC_API.md` Service Discovery notes (around `:13392-13397`) say the indicator "never issues a backend call" and that `'down'` is "unreachable by construction", while the indicator probes the backend since M70c (`service-discovery-plugin.ts:115-133`). | The code is right; the notes are corrected.                                                                                                     | `PUBLIC_API.md` Service Discovery "Notes".                                                                  |
| C4  | `interfaces/index.ts:110` JSDoc and `README.md:152-181` ("Self-registration") imply the uuid default is fine; V13-103 shows it leaves orphans.                                                                                                                 | The default changes (§3.3); both texts state the new default and why.                                                                           | `interfaces/index.ts` JSDoc, README "Self-registration", PUBLIC_API Service Discovery, `docs/upgrading.md`. |
| C5  | `grpc-plugin/README.md:131-138` ("Rolling restarts") promises that a server shutting down refuses calls with `REFUSED_STREAM`; with M143i's GOAWAY that holds for new streams, and the drain 503 for a racing stream is still a failure.                       | The client resends that 503 only when it carries the Core marker (§3.9, OD6 decided C); the paragraph names each case and what is never resent. | `grpc-plugin/README.md` "Rolling restarts".                                                                 |

## 3. Design decisions

### 3.1 A warm name never waits on the backend; a cold read has a bound (V13-101; X123-11)

**DECIDED by the maintainer on 2026-11-22: OD1 option B (serve a warm list at once and refresh in
the background).** Rejected: option A, serve stale after a failed read and retry no sooner than 5 s
later, which still made one caller per interval wait the bound (evidence: the ROADMAP's "one bounded
wait" wording and the read-through shape of `service-discovery-service.ts:156-180`).

- **Decision:**
  - **Warm and cold.** A name is _warm_ once its cache entry exists, that is after one successful
    provider read or one watch delivery for it (an empty answer included, since it is an answer). It
    stays warm for the life of the service; no entry is evicted while the service runs. `close()`
    clears the cache, the in-flight map, the per-name retry state and the per-name reporters, and
    marks the service closed, so a refresh that settles after `close()` writes nothing (today
    `close()` does not clear `#cache`, `service-discovery-service.ts:231-237`). A name with no entry
    is _cold_.
  - **Warm read.** `resolve()` on a warm name always returns the cached list in the same call,
    without awaiting anything. When the entry's age is at least `cacheTtlMs` and no refresh for that
    name is in flight and the name's retry time has passed, `resolve()` also starts a background
    refresh and does not await it. Its rejection is caught inside the service, never surfaced to a
    caller and never left unhandled.
  - **One refresh per name.** The existing `#inFlight` map (`service-discovery-service.ts:55`) holds
    at most one provider read per name, whether a cold caller or a background refresh started it; a
    second expired call while one runs starts nothing.
  - **The bound.** Every provider read, cold or background, runs through `withDeadline` with the new
    common option `resolveTimeoutMs` (default `2000`, `0` unbounded, refused at
    `ServiceDiscoveryPlugin()` with `deadlineRangeError('resolveTimeoutMs', …)`),
    `timing: resolveProbeTiming(runtime)`, and an `onTimeout` error
    `` `${kind} discovery did not answer the read for '${serviceName}' within ${ms} ms` `` (a plain
    `Error`, so the cold path still brands it 503 at `:264-274`). `DiscoveryProvider.resolve` gains
    an optional `signal?: AbortSignal` (additive on the plugin's own exported port), which Consul
    and Kubernetes pass as `init.signal`; `StaticProvider` ignores it. `DnsProvider` cannot forward
    it to `IDnsResolver` (it takes none), so it races the lookup against the signal itself: when the
    signal aborts first it records the abort reason as its last outcome (§3.5) and rejects with it;
    the lookup is left to settle on its own and its late result is ignored. A bounded refresh frees
    the in-flight slot when it times out, so a hung backend never blocks the next attempt.
  - **The DNS watch is bounded too.** `DnsProvider.watch` today starts a lookup on every interval
    with no bound, and a hung first tick never arms the interval (`dns-provider.ts:153-179`). Each
    tick now runs under the same `resolveTimeoutMs` (passed to the provider at construction), a tick
    starts nothing while the previous tick's lookup is still in flight, and the interval is armed
    before the first tick so a hung first lookup cannot stop polling.
  - **Retry spacing after a failed background refresh.** Per name, exponential: the first retry is
    allowed 1 s after the failure, then 2, 4, 8, 16 s, capped at 30 s; a successful read resets it.
    These are constants, not options, and are the values of .NET's DNS service discovery
    (`MinRetryPeriod` 1 s, `RetryBackOffFactor` 2, `MaxRetryPeriod` 30 s, Q2b). No jitter: the retry
    is per name inside one process, so there is no herd to spread. Until the retry time passes,
    expired calls start nothing and are still answered from the cache.
  - **Cold read.** The first call for a cold name awaits the coalesced provider read, bounded by
    `resolveTimeoutMs`, exactly as today otherwise: a failure rejects with the branded 503 (or a
    provider's own `DiscoveryUnavailableError` as a 500). Cold reads have no retry spacing: each
    later cold call tries again (coalesced).
  - **What `cacheTtlMs` now means.** "How long after a list was read a call starts a background
    refresh of it." On a backend that answers, a served list is at most `cacheTtlMs` plus one
    refresh (at most `resolveTimeoutMs`) old. While refreshes fail there is no upper bound: the last
    good list is served and its age is reported (below). `cacheTtlMs: 0` now means "start a
    background refresh on every call to a warm name" (coalesced), no longer "every call waits on the
    backend". No committed text promised "never older than this": the `options.ts:24-29` JSDoc
    ("served from cache", "`0` disables caching") and the README row (`README.md:224`, "`0` disables
    caching") are rewritten to the sentence above, and the PUBLIC_API note "read-through … with …
    stale-on-failure" becomes "served from cache, refreshed in the background".
  - **State flags.** `degraded` becomes a computed value: true while ANY name's last read failed or
    §3.2 holds an empty answer for it, tracked per name on the cache entry. Today it is one global
    flag that any name's success clears (`service-discovery-service.ts:217`, `:247`), which would
    let `degraded: false` sit beside `staleForMs > 0`. `everResolved` is unchanged.
  - **Logging.** A failed provider read (cold or background) goes to a `ConnectionErrorReporter` PER
    NAME, built like the probe's (`service-discovery-plugin.ts:83-86`) with source
    `service-discovery-plugin: <kind> resolve '<serviceName>'`, created on the name's first failure
    and dropped by `close()`. One shared reporter cannot warn once per run: it deduplicates by the
    last rendered message only (`connection-errors.ts:136-152`), so two failing names alternate and
    each repeat warns again. The plugin passes the service a factory
    `(serviceName) => ConnectionErrorReporter`. The probe's reporter is unchanged; for the DNS arm
    the probe re-reports the last lookup's error (§3.5), so one DNS fault can produce one line from
    each reporter, which is accepted and stated in the README. Verified behaviour of that reporter
    (`packages/common/src/health/connection-errors.ts:15-17`, `:133-163`): the first error of a run,
    or an error whose rendered text differs from the previous one, at `warn`; an identical repeat at
    `debug` with a count; the first success after errors at `info`. The read is reported with
    `describeError`, which masks URL userinfo.
  - **Readiness.** The indicator's `status` mapping is unchanged (`down` only when never resolved
    and unreachable), so a warm cache at any age keeps the replica ready: `/ready` is 503 for any
    status that is not `up` (`health-plugin/src/plugin/health-plugin.ts:348-351`), and pulling every
    replica because the registry is down would turn V13-101 into a full outage again (the M113o
    decision, `README.md:318-323`). The indicator's data gains `staleForMs`: for the names whose
    last refresh failed, the age of the oldest list being served, measured from its last successful
    read on the monotonic clock; `0` when no refresh is failing. Operators alert on it. Whether an
    age should ever change the status is OD8.
- **Why:** a warm caller's latency no longer depends on the registry at all (gRPC's resolver and
  Eureka's client, Q1 and Q2). The 2000 ms bound now matters only for cold names and for freeing the
  refresh slot; it matches the plugin's own probe bound (`:105-106`) and leaves most of
  `grpcClient`'s 5 s default deadline (`grpc-client.ts:30-35`). The exponential spacing follows
  .NET's DNS provider exactly and grpc-go's resolver in shape (1 s base, exponential, capped;
  grpc-go multiplies by 1.6 to 120 s with jitter, Q2b).
- **Test home:** `test/unit/service-discovery-service.test.ts`: a warm caller never awaits the
  backend (a fake provider that answers once, then returns a promise that never settles; after
  advancing the fake clock past `cacheTtlMs`, `resolve()` settles with the cached list before any
  timer fires, and the provider was called exactly once more); concurrent expired calls start one
  refresh; a failed refresh sets `degraded`, warns once, logs a repeat at `debug`, and a later
  success logs `info` and clears `degraded`; retry spacing 1, 2, 4 … 30 s on the fake clock and
  reset on success; a refresh that hangs past `resolveTimeoutMs` frees the slot; a cold name waits
  at most the bound and rejects with the branded 503 naming it; `cacheTtlMs: 0` refreshes in the
  background on every call; `staleForMs` grows while refreshes fail and returns to `0`; two names
  failing: `degraded` stays true until both succeed, and each name warns once (per-name reporters);
  `close()` during a refresh: the late result writes nothing and the cache is empty.
  `test/unit/dns-provider.test.ts`: a hung lookup is abandoned at the signal and recorded; the watch
  tick is bounded, skips while one is in flight, and keeps polling after a hung first tick.
  `test/unit/consul-provider.test.ts` and `test/unit/kubernetes-provider.test.ts` (the signal
  reaches `request`); `test/unit/options.test.ts` (default, `0`, refusal);
  `test/unit/plugin/health-indicator.test.ts` (`staleForMs` in data, status stays `up`);
  `test/integration/readiness.test.ts` (a hung Consul `IDiscoveryHttp` fake under a running kernel
  app via `inject()`: calls answer at once from the warm list, `/ready` stays 200, `data.degraded`
  true and `data.staleForMs` above zero).

### 3.2 One rule for an empty answer when a list is in hand (V13-102, V13-247)

- **Decision:**
  - One internal method `#accept(serviceName, instances)` stores every successful answer, called by
    both `#read` and the watch listener (`service-discovery-service.ts:212-219`), so the two read
    paths cannot disagree.
  - New common option `emptyAnswerGraceMs`, default `30_000`, `0` means an empty answer replaces the
    list at once (gRPC's behaviour), refused out of range like §3.1.
  - When an answer is `[]` and the entry holds instances: the first such answer records `emptySince`
    on the entry, keeps the old instances, sets `#degraded`, and stamps the entry as read now (it
    was a successful read, so §3.1's failure spacing does not apply); a later empty answer at least
    `emptyAnswerGraceMs` after `emptySince` replaces the list with `[]`. Any non-empty answer clears
    `emptySince`. An empty answer for a name with no entry, or whose entry is already empty, is
    stored at once.
  - **What a watch caller sees.** The watch listener (`service-discovery-service.ts:212-219`) is
    called after `#accept` with the list the cache now holds, so during the grace it receives the
    held instances, never `[]`, and `resolve()` and `watch()` callers always agree.
  - **With §3.1's background refresh:** the empty answers arrive through background refreshes (and
    watch deliveries), never through a waiting caller, so callers keep the old list without delay
    throughout the grace. Because the next refresh starts only when a call arrives after
    `cacheTtlMs`, the list is replaced at the first empty answer read at least `emptyAnswerGraceMs`
    after the first one: with both defaults at 30 s, between 30 s and about 60 s after the instances
    disappeared, sooner on a watched name. `staleForMs` is not raised by a held empty answer (the
    refresh succeeded); `degraded` is.
  - `DnsProvider.resolve` returns `[]` when the lookup says the name or the record type does not
    exist: an internal classifier `isNameAbsent(error)` (exported `@internal` like `isMissingFile`)
    walks the error's `cause` chain (bounded depth 5) and matches `code` `'ENOTFOUND'` or
    `'ENODATA'` (Node and Bun, `node:dns/promises`) or `name` `'NotFound'` (Deno, which throws
    `Deno.errors.NotFound` for both NXDOMAIN and no records, with `ares_code` telling them apart,
    Q11). The walk is needed because mode `'a'`'s `resolveHost` wraps the first failure as
    `new Error('DNS lookup failed for …', { cause })` on every runtime
    (`runtime/src/adapters/shared/node-dns-resolver.ts:57-58`, used by Bun at `bun-runtime.ts:110`;
    `deno/deno-dns-resolver.ts` around `:80`). Every other rejection (timeout, refused, `SERVFAIL`)
    still rejects. **Known limit, handed to Core (§11):** `resolveHost` keeps only the first
    failure, so "no A record, AAAA lookup timed out" reads as absent; Core's DNS PR should reject
    with every failure (an `AggregateError` cause) so the classifier can require all of them to be
    absent. Until then the README states the limit.
- **Why:** Consul's restart answers `[]` for one check interval while every instance is healthy, and
  an authoritative NXDOMAIN means the service is really gone; the grace window is the one rule that
  serves the first and still honours the second. Most compared clients replace the set on a
  successful empty answer (Envoy STRICT_DNS, grpc-go on NXDOMAIN, .NET, which also retries it with
  backoff); none was found that holds it (Q3, Q3b). The grace is therefore a deliberate departure,
  taken because Consul answers `?passing` with nothing while checks start `critical` after a
  (re-)registration, so the default is OD2; `0` gives the majority behaviour. The ejection tracker
  already refuses to empty a pool (`ejection-tracker.ts:114-118`), which is the sibling precedent
  for not serving nothing on one signal.
- **Test home:** `test/unit/empty-answer-rule.test.ts` (new; one table driven through BOTH `#read`
  and `watch` on the fake clock: warm then `[]` keeps the list and is degraded; `[]` after the grace
  replaces; a non-empty answer in between resets; cold `[]` stored at once; `0` replaces at once;
  the watch listener receives the held list during the grace); `test/unit/dns-provider.test.ts`
  (each classifier input as a table row, in SRV mode and wrapped in mode `'a'`'s `cause`:
  `ENOTFOUND`, `ENODATA`, Deno `NotFound` resolve `[]`; `ETIMEOUT`, `ECONNREFUSED`, `ESERVFAIL`
  reject; a cause chain deeper than the bound rejects).

### 3.3 A stable default Consul registration id (V13-103)

- **Decision:** `selfId` defaults to `` `${serviceName}-${address}-${port}` `` when
  `registration.id` is absent. The memo per registration object stays. The `SelfRegistration.id`
  JSDoc, README and PUBLIC_API say: unique within the agent, and the same across restarts so a
  restarted process replaces its own entry. `deregisterSelf` puts the id in the URL path through
  `encodeURIComponent` (today it is interpolated raw, `consul-provider.ts:253`), because an IPv6
  address (`fe80::1%eth0`) in the default id would otherwise break the path.
- **Why:** Consul itself defaults `ID` to the service name (one per agent); Spring Cloud Consul
  builds it from the application name and an instance id or the port, and Micronaut from the name
  and port, both stable across restarts (Q4, Q12). Micronaut's guide warns that name plus port
  collides across hosts, which is why the address is part of this id. Two live processes cannot
  share an address and port, so the id stays unique, and a restart on the same address re-registers
  over its orphan. No option is added: `id` already exists for anything else.
- **Test home:** `test/unit/consul-provider.test.ts` (default id is `<name>-<address>-<port>`, the
  explicit id wins, deregistration uses the same id, an IPv6 address is encoded in the deregister
  path); `test/integration/self-registration.test.ts` (two plugin instances in sequence on one fake
  agent with the same registration: the agent holds one entry).

### 3.4 A hung Kubernetes probe says that its bound fired (V13-52)

- **Decision:** `KubernetesProvider.isHealthy` runs its request through `withDeadline` (2000 ms, the
  existing value) with
  `onTimeout: () => new Error('The Kubernetes API server did not answer the reachability probe within 2000 ms')`,
  forwarding the signal. The reporter then logs that message. `ConsulProvider.isHealthy` keeps its
  `false` return (its log line already names the provider) but uses the same `withDeadline` so both
  probes share one bound mechanism.
- **Why:** the row is the log text; the bound value is unchanged.
- **Test home:** `test/unit/providers/kubernetes-health.test.ts` (a never-answering fake: the
  rejection message names the API server and 2000 ms, never `AbortError`);
  `test/unit/providers/consul-health.test.ts` (unchanged results, the signal is aborted at 2000 ms).

### 3.5 The DNS arm can report `down` (V13-246, indicator half)

- **Decision:** `DnsProvider` implements `isHealthy()` from the outcome of its own last lookup (it
  issues no probe of its own, since DNS has no service-independent name to ask): it rejects with the
  last lookup's error when that lookup failed for any reason other than §3.2's absent name, and
  resolves `true` after a success, after an absent-name answer, and before any lookup. A lookup
  abandoned at its bound (§3.1, the provider's own race against the signal) is recorded as a failure
  with the bound's error, so a resolver that never answers is seen: without this, a hung lookup
  would never record an outcome and `isHealthy` would keep answering `true`. The plugin's indicator
  mapping (`!everResolved && !reachable` is `down`) is unchanged.
- **Why:** with a resolver that never answers, `everResolved` stays false and the last lookup
  failed, so the indicator is `down`, as the README defines it. Reporting a probe it never made
  would be false; reporting the last real lookup is a fact.
- **Test home:** `test/unit/providers/dns-health.test.ts` (replaces the M70c test: each state as a
  row, including a hung lookup abandoned at the bound); `test/unit/plugin/health-indicator.test.ts`
  (a `dns` arm whose resolver always rejects is `down`, and one whose resolver never answers is
  `down`; one that answered once and then fails is `up` with `degraded` and `reachable: false`).

### 3.6 The DNS arm can be pointed at a name server, with a per-lookup bound (V13-246, server half)

- **Decision (written against OD3 recommendation A):** the DNS arm gains
  `servers?: readonly string[]`, each an IP literal with an optional port (`'127.0.0.1'`,
  `'127.0.0.1:7853'`, `'::1'`, `'[::1]:53'`), because Node's `Resolver.setServers` takes IP literals
  only (Q11); a host name or a malformed entry is refused at `ServiceDiscoveryPlugin()` with a
  `RangeError` naming the entry. `createProvider` builds the resolver with
  `runtime.createDnsResolver({ servers, timeoutMs: resolveTimeoutMs })` (the Core member, §11) when
  `servers` is set, and refuses with `DiscoveryUnavailableError` naming the option when the runtime
  has no such member. Without `servers` the arm uses `runtime.dns`, as today. The Core member owns
  the mapping to each runtime (stated in the hand-over, §11): on Node and Bun a `Resolver` with
  `tries: 1` (Node's default is 4, which would multiply the bound) and `timeout: timeoutMs`, with
  `0` mapped to Node's `-1` (the c-ares default); on Deno `nameServer` plus a signal (Deno then
  forces a 1 s, one-attempt resolver timeout, Q11). The record TTL is not read: `resolveSrv` returns
  none on Node (Q11), so `cacheTtlMs` stays the freshness bound and the README says so.
- **Why:** a name-server option is the report's own remedy, and both runtimes support it natively
  (Node `Resolver` instances with `timeout`/`tries` and per-instance `setServers`; Deno
  `nameServer`). The plugin may not import `node:dns` (runtime-specific APIs live in
  `packages/runtime` only), so the resolver must come from the runtime, which is the Core lane.
- **Test home:** `test/unit/provider-factory.test.ts` (with `servers` the factory calls the fake
  runtime's `createDnsResolver` with the servers and the bound and uses its resolver; without it,
  `runtime.dns`; a runtime without the member is refused naming `servers`);
  `test/unit/options.test.ts` (each accepted and refused server form as a table row: IPv4, IPv4 with
  port, bare IPv6, bracketed IPv6 with port; a host name, a port above 65535, an empty string and an
  unbracketed IPv6 with port are refused).

### 3.7 The breaker can open on a failure rate (V13-104)

- **Decision (written against OD4 recommendation A; the `common` half is Core's, §11):**
  - `CircuitBreakerPolicy` becomes a union: today's count policy, or a rate policy
    `{ failureRateThreshold: number /* percent, 1-100 */; minimumCalls: number; timeout; resetTimeout }`.
  - The count arm keeps its exact rule and its exact per-failure timestamps
    (`circuit-breaker.ts:115-126`), so its behaviour does not change. The rate arm keeps a rolling
    window over `timeout` ms in ten buckets of calls and failures (bucket-granular expiry, stated in
    the README), and trips when the window holds at least `minimumCalls` calls and
    `failures * 100 / calls >= failureRateThreshold`. Cancellation is counted as today on both arms:
    a call whose signal was already aborted is not recorded (`circuit-breaker.ts:69-71`); a call
    aborted mid-flight is recorded as a failure (`:88-92`). Half-open is unchanged.
  - `ResilienceService` validates a breaker policy at `wrap()` and `ResiliencePlugin()` with a
    `RangeError` naming the field (new `validateCircuitBreakerPolicy` in
    `patterns/circuit-breaker.ts`, the shape `validateRetryPolicy` has in `patterns/retry.ts:27`):
    `failureRateThreshold` in 1 to 100, `minimumCalls` a positive integer, `timeout` and
    `resetTimeout` in the timer range, `threshold` a positive integer.
  - No default changes: `defaultCircuitBreaker` stays caller-supplied.
  - **`@setu-ts/sdk` reads the same type.**
    `packages/sdk/src/circuit-breaker/circuit-breaker.ts:48`, `:94`, `:96` reads `policy.threshold`
    and `policy.timeout`, `sdk/src/http/contracts.ts:205` takes
    `circuitBreaker?: CircuitBreakerPolicy`, and `sdk/src/index.ts:31` re-exports it. The union
    therefore breaks the SDK's compile unless the SDK narrows it. The SDK is in the CLI lane, so its
    half is a hand-over (§11), and it must land in the same window as the Core union, since the Core
    PR cannot merge with the SDK failing to compile. The SDK's choice is OD4b.
- **Why:** every compared library trips on a rate over a minimum volume (Q9); the plugin's sibling
  cap is already a percentage (`maxEjectionPercent`), and Resilience4j, opossum and Hystrix use
  percent (default 50), Polly a ratio (0.1). Buckets bound memory at any traffic, as opossum and
  Hystrix do (ten buckets). A union, rather than optional fields beside a required `threshold`,
  avoids a required field that the rate arm would never read (the dead-surface rule).
- **Test home:** `test/unit/circuit-breaker.test.ts` (the count arm's existing cases unchanged,
  including a mid-flight abort recorded as a failure; the rate arm: below `minimumCalls` never
  trips, at the rate trips, old buckets expire on the fake clock, one failing instance in three at
  high volume does not trip at 50 %); `test/unit/rolling-window.test.ts` (bucket rotation and sums);
  `test/unit/resilience-service.test.ts` (each refusal row; a rate policy through `wrap` and through
  `circuitBreaker: true` with a rate default, the two entry points under the same non-default policy
  give the same trips).

### 3.8 `grpcClient` reports every transport fault as an instance failure (V13-25)

- **Decision:** `#attempt` classifies a failed call with one function, `callOutcome(error, signal)`
  in a new internal file:
  - the caller's own signal is aborted: no report;
  - a refused stream (`isRefusedStream`): `failure` (unchanged);
  - code `Unavailable` or `Unimplemented`, wire or not: `failure`. `Unavailable` keeps today's rule.
    `Unimplemented` is the instance not serving this service (connect maps an HTTP 404 to it,
    `protocol-connect/http-status.js:25-41`), which is a misrouted instance, not an application
    answer;
  - `DeadlineExceeded`: `success` (unchanged; OD5);
  - any other code that is a server's answer (`isWireError`, through a new
    `ConnectRuntime.isWireError` member): `success` (an application error is the instance working);
  - anything else (no server answer: a reset, a close, a protocol error, a refused connection, or an
    HTTP response that is not gRPC): `failure`. The README rule becomes: an instance is reported
    failed when it did not answer as a gRPC server serving the service, or answered `Unavailable`.
- **Why the wire flag alone is not enough:** on the client's default protocol, `'connect'`
  (`grpc-client.ts:30-35`), connect parses ANY non-200 unary reply whose content type is JSON as a
  Connect error body (`protocol-connect/validate-response.js:32-37`,
  `protocol-connect/transport.js:112-113`), and `errorFromJson` sets `isWireError = true` for any
  JSON object, falling back to the HTTP-derived code when the body has no `code`
  (`protocol-connect/error-json.js:36-55`). So a JSON 404 from a Setu app without the service, or a
  JSON 429/502/503 from a proxy, is a "wire" error with code `Unimplemented` or `Unavailable`. The
  code rows above therefore come first. Envoy counts locally originated errors (reset, timeout,
  connect failure) and gateway errors as failures (Q5, Q4b); gRFC A50 implementations count every
  non-OK status, but they eject on a success-rate statistic over a request volume, not on one
  failure, so counting application errors here (threshold 1 is allowed) would eject healthy
  instances for `NotFound` answers.
- **Test home:** `test/unit/grpc-client.test.ts` and `test/unit/call-outcome.test.ts` (new; one
  table, iterated as data, of every error shape and its outcome, including a wire `Unimplemented`
  and a wire `Unavailable` built the way `errorFromJson` builds them);
  `test/e2e/grpc-client-scenarios-e2e.test.ts` (the report's four "dead port" cases as rows on real
  sockets: nothing listening, an HTTP/1.1 listener, an HTTP/2 server without the service, a listener
  that accepts and closes; with `failureThreshold: 1` and two instances, every row is ejected after
  one call and the next five succeed; each row run on the `connect`, `grpc` and `grpc-web`
  protocols, and the "server without the service" row also against a Setu app answering its JSON
  404).

### 3.9 A unary call a draining peer turned away goes to another replica (V13-23, `grpc-plugin` half)

**DECIDED by the maintainer on 2026-11-22: OD6 option C (Core marks the kernel's drain 503; the
client resends only a response carrying that marker).** Rejected: option A, resend any non-wire
`HTTP 503`, because a proxy's 503 can follow a request that reached a server (Envoy resends 503 only
when configured, gRFC A6 does not name 503); option B, resend only `application/problem+json`,
because the drain answer is written through the application's error responder when one is registered
(`common/src/errors/error-responder.ts:245-270`), so its type is not fixed.

- **The marker (Core half, §11).** The kernel's drain 503 carries the response header
  `x-setu-unprocessed: shutdown`, set on the builder after `respondWithError`
  (`kernel/src/application/application.ts:1320-1337` on the M143i branch; `ResponseBuilder.header`,
  `kernel/src/context/response.ts:98`), so it is present whatever the responder writes. The name and
  value are one exported constant pair in `packages/common` (additive), read by the kernel and by
  this client, so the two cannot drift. Its meaning is the one RFC 9113 §8.7 gives `REFUSED_STREAM`:
  the server guarantees the request was not processed. The `x-setu-` prefix follows the repo's own
  headers (`x-setu-instance`, `x-setu-attempt`, among others). Only the kernel's pre-pipeline drain
  answer sets it; no handler path does.
- **Decision (client):** `#call` treats a unary call's error as safe to send again when it is a
  refused stream (today), or an error with code `Unavailable` whose response metadata carries
  `x-setu-unprocessed: shutdown`, read through a new internal `ConnectRuntime.errorMetadata(error)`
  member. The wire flag is NOT part of the rule: on the `connect` protocol the kernel's drain 503 is
  JSON, so connect parses it as a wire error (§3.8), and the headers are still on `metadata`
  (`protocol-connect/error-json.js:38-40` appends them to the fallback, and the wire error is built
  with the same `metadata`, `:54`; `protocol-grpc/validate-response.js:33` and
  `protocol-connect/validate-response.js:33` for the HTTP-status form; connect-node passes the
  HTTP/2 response headers through, `node-universal-client.js:58`). Such an error reports `failure`
  for the instance and is resent once on a new pick within what is left of the deadline, exactly as
  the refused-stream path does (`grpc-client.ts:453-480`). Streaming calls are not resent. A 503
  without the marker is never resent and is reported per §3.8 (`Unavailable`, so `failure`).
- **The marker is not reserved by the client.** A gRPC handler can set response headers (connect's
  `ctx.responseHeader`), so an application that copies the marker onto its own `Unavailable` gets
  one resend of that unary call. The client cannot tell the two apart; the Core hand-over (§11) asks
  the kernel to delete the header from every response that is not its drain answer, which makes the
  guarantee the kernel's to keep. The cost without it is one extra send of one unary call to another
  instance of the same service, within the deadline (§13).
- **Order of work (gated).** The client half is built only after the Core PR carrying the marker and
  its constant has merged into `develop` and this branch has merged `develop`. Until then the branch
  ships no resend rule for 503 at all: a drain 503 fails the call as it does today, and is reported
  as an instance failure through §3.8. If the Core PR is not merged when the rest of this letter is
  ready, §3.9 is cut from this branch, V13-23's `grpc-plugin` half stays open, and the README keeps
  stating that a drain 503 is not resent. No code reads a marker that nothing in `develop` writes.
- **Why:** a marker set only by the server that knows it did not run the handler is the HTTP-level
  form of HTTP/2's `REFUSED_STREAM` and of the GOAWAY last-stream-id guarantee, which gRPC resends
  transparently (Q6, Q10); `Retry-After` says only how long to wait, not that nothing ran (RFC 9110
  §10.2.3), and Envoy's `x-envoy-overloaded` is documented only as "set on a dropped request", with
  no stated resend rule (Q10). The closest established precedent is Finagle's `finagle-http-nack`
  header on a 503 that did no work (Q8b).
- **Test home:** `test/unit/grpc-client.test.ts` (an `Unavailable` error whose metadata carries the
  marker is resent once with the remaining deadline, as both a wire and a non-wire error; a 503
  without it, a marked error with another code, and a streaming call with it are not resent; the
  constant is imported from `@setu-ts/common`, not re-typed);
  `test/e2e/grpc-client-scenarios-e2e.test.ts` (two real instances, one a kernel app whose `stop()`
  has begun and which answers new calls with the marked drain 503: unary calls all succeed on the
  other, on each of `connect`, `grpc` and `grpc-web`, and with and without a registered
  `errorHandler` writing problem+json; a control instance answering an unmarked 503 is not resent).

### 3.10 Calls spread over a service's replicas (V13-24)

- **Decision (written against OD7 recommendation A):** no new client option. The README's
  "Connections" bullet states the consequence (one session per instance, so a Service address that
  load-balances connections pins every call to one pod) and the remedy the plugin supports today:
  discover the pods themselves (`dns` arm in mode `'a'` over a headless Service, or the `kubernetes`
  arm), so each pod is its own instance and the balancer spreads calls. The generated Kubernetes
  output half is a CLI-lane hand-over (§11).
- **Why:** .NET's guidance and gRPC's both name client-side balancing over per-pod addresses as the
  remedy, and server-side connection age as the other (Q7), which is runtime code (Core). Per pod
  discovery already gives one session per pod here.
- **Test home:** `test/e2e/grpc-client-e2e.test.ts` (two discovered instances on two ports: 100
  unary calls split within 40 to 60 each under round robin). This row's fix is documentation: the
  test pins the remedy the README names and passes on `develop` too, so V13-24 is the one row
  without a red-on-`develop` test; its proof is the README text and the CLI hand-over.

### 3.11 A cancelled RPC stream stops its handler before awaiting it (M143i hand-over)

- **Fact base.** connect's universal response body is an async generator (`untilFirst(pipe(...))`,
  `protocol-grpc/handler-factory.js:85-119`; `pipe` is a tslib `__asyncGenerator`,
  `protocol/async-iterable.js:22-32`, `:113-114`), and `return()` on an async generator that is
  suspended at an `await` is queued behind the pending `next()` (ECMA-262 §27.9.1.3, Q5). The
  streams spec runs the source's `cancel()` at once, even while a `pull` is pending. So
  `iterableStream`'s `cancel()` (`transports/rpc-call.ts:133-135`) and `nativeGrpcReply`'s
  (`transports/native-grpc-reply.ts:57-60`) wait until the handler's next `yield`; connect's own
  `return` path, which aborts the handler context (`handler-factory.js:99-102`), is never reached
  meanwhile. The call's signal does reach the handler (`rpc-dispatcher.ts:148`, `rpc-call.ts:60-68`,
  connect `implementation.js:35-36`), but on the M143i branch the kernel aborts it only on the
  client-abort path and only when the stream has deferred cleanups (`deferred.ts:157-187`, `:185`;
  an RPC stream with none, `application.ts:2131-2133`; `inject()`'s `body.cancel()`,
  `application.ts:1266`, `:1284`). Since M143i the kernel waits for `cancel()` with no time limit,
  so a handler waiting for its next event holds the request's drain slot and cleanups until it
  yields.
- **Decision (written against OD9 recommendation A).** For a procedure that streams its response,
  the dispatcher creates a local `AbortController` and passes
  `AbortSignal.any([transport.signal, local.signal])` (or `local.signal` alone when there is no
  transport signal) to `universalRequest`. Both reply builders' `cancel()` first aborts the local
  controller with the cancel reason, then awaits `iterator.return()` with no bound, as today. A
  handler that watches `ctx.signal` (connect's handler context) exits at once and `cancel()`
  settles. A handler that ignores the signal still holds the stream until it yields, exactly as a
  hung unary handler holds its request; the README says so. Unary procedures are unchanged (no
  `AbortSignal.any`, whose cost the kernel measured on the unary path). `@setu-ts/common` has no
  `AbortSignal.any` helper; it is a web standard on Node 20+, Deno and Bun, used directly.
- **Why not a bound.** Racing `return()` against a bound releases the request's cleanups and limit
  slot while the handler may still be running, which is the bypass M143i's security audit rejected
  (P15, `m143i-audit-record.md`). No compared framework interrupts a blocked handler or bounds the
  wait: gRPC "does not have a mechanism to interrupt the application-provided server handler",
  grpc-go cancels the context, grpc-js sets `cancelled` (Q5).
- **Test home:** `test/unit/rpc-call.test.ts` and `test/unit/native-grpc-reply.test.ts` (new) (a
  source generator suspended at an `await` that listens to the signal: `cancel()` aborts it and
  settles; the abort happens before `return()` is called; a generator that ignores the signal keeps
  `cancel()` pending until it yields, documented); `test/unit/rpc-dispatcher.test.ts` (a streaming
  procedure gets a combined signal, a unary one the transport signal unchanged);
  `test/e2e/grpc-streaming-e2e.test.ts` (extend): a streaming row through a running kernel app and
  `inject()`: a server-stream handler awaiting its next event is cancelled by `body.cancel()` and
  its `finally` runs.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none in this lane. `DiscoveryProvider.resolve` gains an optional
parameter (an existing custom provider still type-checks). The Core half's `CircuitBreakerPolicy`
union is not breaking for callers that pass today's shape, but is for code that READS
`policy.threshold` from a value typed `CircuitBreakerPolicy`: `resilience-plugin` (this lane) and
`@setu-ts/sdk` (`sdk/src/circuit-breaker/circuit-breaker.ts:48`, `:94`, `:96`; CLI lane, §11 and
OD4b). Core states its own line. Ships in minor 0.14.0.

| Exported symbol                                                         | Kind                         | Consumer / real code path that READS it                                                                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DiscoveryProvider.resolve(serviceName, signal?)`                       | port member (changed)        | `ServiceDiscoveryService.#read` passes the `withDeadline` signal; Consul and Kubernetes forward it.                                                                         |
| `ServiceDiscoveryPluginOptions` (new fields)                            | type                         | `resolveOptions` and `createProvider` (§4.1).                                                                                                                               |
| Indicator data `staleForMs`                                             | health indicator data field  | Read by the health plugin's detailed report (`HealthPlugin({ details: true })`) and by operators' alerts; computed from the service's cache entries on every indicator run. |
| `x-setu-unprocessed` name and value constants (Core, `packages/common`) | constants (Core PR)          | Written by the kernel's drain 503; read by `callOutcome`'s resend rule. Exists only after the Core PR (§3.9 gate).                                                          |
| `DnsProvider.isHealthy`                                                 | method (new on a class)      | `ServiceDiscoveryService` probe (`service-discovery-service.ts:85-108`).                                                                                                    |
| `isNameAbsent`                                                          | function, `@internal` export | `DnsProvider.resolve` and `DnsProvider.isHealthy`. Exported only for the plugin's own tests, like `isMissingFile`; not added to `src/index.ts`.                             |
| `ConnectRuntime.isWireError`                                            | internal port member         | `callOutcome`. Not exported.                                                                                                                                                |
| `ConnectRuntime.errorMetadata`                                          | internal port member         | The marked-503 resend rule in `GrpcClients.#call` (after the Core gate, §3.9). Not exported; added only with §3.9.                                                          |
| Streaming-procedure local `AbortController`                             | internal (no symbol)         | `rpc-dispatcher.ts` creates it; `iterableStream` and `nativeGrpcReply` `cancel()` abort it (§3.11).                                                                         |
| `callOutcome`                                                           | internal function            | `GrpcClients.#attempt` and `#call`. Not exported.                                                                                                                           |
| `validateCircuitBreakerPolicy`                                          | internal function            | `ResiliencePlugin.register` and `ResilienceService.#resolveCircuitBreaker`. Not exported.                                                                                   |

### 4.1 Options — every option names its consumer

| Option                                     | Consumer                                                                         | Behavior (per implementation)                                                                                                                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveTimeoutMs` (all arms)              | `ServiceDiscoveryService.#read` (`withDeadline`); `createProvider` for `servers` | Every arm: a cold read slower than this rejects with the branded 503; a background refresh slower than this fails, frees its slot and starts the retry spacing. Consul/Kubernetes also abort the HTTP request; DNS cannot abort, the race bounds it; static answers at once. |
| `cacheTtlMs` (all arms, meaning changed)   | `ServiceDiscoveryService.resolve`                                                | Age after which a call to a warm name starts a background refresh; `0` starts one on every call. Never makes a warm caller wait.                                                                                                                                             |
| `emptyAnswerGraceMs` (all arms)            | `ServiceDiscoveryService.#accept`                                                | Same on every arm, on both the read and the watch path. Static never answers `[]` for a known name, so it never applies there.                                                                                                                                               |
| `resolveTimeoutMs` in `DnsProvider`        | `DnsProvider.watch` tick bound (§3.1)                                            | DNS watch only; the read path is bounded by the service.                                                                                                                                                                                                                     |
| `servers` (`dns` arm only)                 | `createProvider` (`runtime.createDnsResolver`)                                   | DNS only; refused when the runtime lacks the Core member. Depends on OD3.                                                                                                                                                                                                    |
| `CircuitBreakerPolicy` rate arm (`common`) | `CircuitBreaker` via `ResilienceService`                                         | Rate trip rule of §3.7. Depends on OD4 and the Core PR.                                                                                                                                                                                                                      |

## 5. Implementation files

| File                                                                          | Purpose                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/service-discovery-plugin/src/index.ts`                              | Barrel unchanged (no new export); option types already exported.                                                                                        |
| `packages/service-discovery-plugin/src/options.ts`                            | `resolveTimeoutMs`, `emptyAnswerGraceMs`, `servers`; defaults and range refusals in `resolveOptions`.                                                   |
| `packages/service-discovery-plugin/src/interfaces/index.ts`                   | `resolve(serviceName, signal?)`; `SelfRegistration.id` and `isHealthy` JSDoc.                                                                           |
| `packages/service-discovery-plugin/src/services/service-discovery-service.ts` | Warm read from cache with background refresh, cold bounded read, per-name retry spacing, `#accept` with the empty rule, resolve reporter, `staleForMs`. |
| `packages/service-discovery-plugin/src/services/refresh-backoff.ts`           | New: the per-name exponential retry spacing (1 s doubling to 30 s, reset on success) on an injected monotonic clock.                                    |
| `packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts`    | Builds the resolve reporter, passes it to the service, adds `staleForMs` to the indicator data.                                                         |
| `packages/service-discovery-plugin/src/providers/consul-provider.ts`          | Signal forwarding, stable `selfId`, encoded deregister path, `withDeadline` probe.                                                                      |
| `packages/service-discovery-plugin/src/providers/kubernetes-provider.ts`      | Signal forwarding, named probe bound.                                                                                                                   |
| `packages/service-discovery-plugin/src/providers/dns-provider.ts`             | `isNameAbsent` (cause chain), `[]` for an absent name, signal race, last-outcome `isHealthy`, bounded watch tick.                                       |
| `packages/service-discovery-plugin/src/providers/provider-factory.ts`         | `servers` through `runtime.createDnsResolver`.                                                                                                          |
| `packages/service-discovery-plugin/src/providers/static-provider.ts`          | Accepts and ignores the signal parameter (signature only).                                                                                              |
| `packages/resilience-plugin/src/patterns/circuit-breaker.ts`                  | Count arm unchanged, rate arm over the bucketed window, `validateCircuitBreakerPolicy`.                                                                 |
| `packages/resilience-plugin/src/patterns/rolling-window.ts`                   | New: the ten-bucket call/failure counter on an injected monotonic clock.                                                                                |
| `packages/resilience-plugin/src/services/resilience-service.ts`               | Validates a breaker policy from `wrap`.                                                                                                                 |
| `packages/resilience-plugin/src/plugin/resilience-plugin.ts`                  | Validates `defaultCircuitBreaker` at registration.                                                                                                      |
| `packages/grpc-plugin/src/client/call-outcome.ts`                             | New: `callOutcome`, and (after the Core gate, §3.9) the marked-503 resend rule.                                                                         |
| `packages/grpc-plugin/src/client/grpc-client.ts`                              | Uses `callOutcome`; passes the caller's signal; resends a marked drain 503 (after the Core gate).                                                       |
| `packages/grpc-plugin/src/interfaces/connect-runtime.ts`                      | `isWireError(error): boolean`; `errorMetadata(error): Headers \| undefined` (with §3.9 only).                                                           |
| `packages/grpc-plugin/src/transports/connect-loader.ts`                       | Implements `isWireError` (and, with §3.9, `errorMetadata`) over `ConnectError`.                                                                         |
| `packages/grpc-plugin/src/transports/rpc-dispatcher.ts`                       | Local `AbortController` and combined signal for response-streaming procedures (§3.11).                                                                  |
| `packages/grpc-plugin/src/transports/rpc-call.ts`                             | `iterableStream` takes the controller and aborts it before `return()` (§3.11).                                                                          |
| `packages/grpc-plugin/src/transports/native-grpc-reply.ts`                    | Same for the native gRPC reply (§3.11).                                                                                                                 |
| READMEs and `AGENT_CARD.md` of the three packages                             | §10 docs deliverables.                                                                                                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                         | src covered                    | Key assertions (and the signature each call type-checks against)                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service-discovery-plugin/test/unit/service-discovery-service.test.ts` (extend)   | `service-discovery-service.ts` | §3.1 rows, including "a warm caller never awaits the backend" with a fake whose refresh never resolves; `new ServiceDiscoveryService(provider, runtime, resolved, reporter, resolveReporter)`. |
| `service-discovery-plugin/test/unit/refresh-backoff.test.ts` (new)                | `refresh-backoff.ts`           | 1, 2, 4, 8, 16, 30, 30 s spacing on a fake clock; reset on success; names independent.                                                                                                         |
| `service-discovery-plugin/test/unit/empty-answer-rule.test.ts` (new)              | `service-discovery-service.ts` | §3.2 table through `resolve()` and `watch()`.                                                                                                                                                  |
| `service-discovery-plugin/test/unit/options.test.ts` (extend)                     | `options.ts`                   | Defaults `2000`/`30_000`, `0` accepted, `-1`/`NaN`/over range refused; `servers` shape refused.                                                                                                |
| `service-discovery-plugin/test/unit/consul-provider.test.ts` (extend)             | `consul-provider.ts`           | Signal on `request`; default id `<name>-<address>-<port>`.                                                                                                                                     |
| `service-discovery-plugin/test/unit/providers/consul-health.test.ts` (extend)     | `consul-provider.ts`           | Probe bound through `withDeadline`; results unchanged.                                                                                                                                         |
| `service-discovery-plugin/test/unit/kubernetes-provider.test.ts` (extend)         | `kubernetes-provider.ts`       | Signal on `request` in `resolve`.                                                                                                                                                              |
| `service-discovery-plugin/test/unit/providers/kubernetes-health.test.ts` (extend) | `kubernetes-provider.ts`       | Named bound message, no `AbortError`.                                                                                                                                                          |
| `service-discovery-plugin/test/unit/dns-provider.test.ts` (extend)                | `dns-provider.ts`              | `isNameAbsent` table; `[]` for absent; other errors reject.                                                                                                                                    |
| `service-discovery-plugin/test/unit/providers/dns-health.test.ts` (rewrite)       | `dns-provider.ts`              | Last-outcome table.                                                                                                                                                                            |
| `service-discovery-plugin/test/unit/provider-factory.test.ts` (extend)            | `provider-factory.ts`          | `servers` path and refusal with a fake runtime carrying `createDnsResolver`.                                                                                                                   |
| `service-discovery-plugin/test/unit/static-provider.test.ts` (extend)             | `static-provider.ts`           | Accepts a signal, unchanged answer.                                                                                                                                                            |
| `service-discovery-plugin/test/unit/plugin/health-indicator.test.ts` (extend)     | `service-discovery-plugin.ts`  | DNS `down` and `up`+`degraded` rows; `staleForMs` present and status `up` while refreshes fail; resolve reporter wired.                                                                        |
| `service-discovery-plugin/test/integration/readiness.test.ts` (extend)            | plugin + service               | Hung Consul fake in a kernel app via `inject()`: warm calls answer at once, `/ready` 200, `degraded` true, `staleForMs` above zero.                                                            |
| `service-discovery-plugin/test/integration/self-registration.test.ts` (extend)    | `consul-provider.ts`, plugin   | Restart with the same registration leaves one agent entry.                                                                                                                                     |
| `resilience-plugin/test/unit/circuit-breaker.test.ts` (extend)                    | `circuit-breaker.ts`           | Count arm unchanged; rate arm rows.                                                                                                                                                            |
| `resilience-plugin/test/unit/rolling-window.test.ts` (new)                        | `rolling-window.ts`            | Rotation, sums, expiry on a fake clock.                                                                                                                                                        |
| `resilience-plugin/test/unit/resilience-service.test.ts` (extend)                 | `resilience-service.ts`        | Refusal rows; both entry points under one non-default rate policy agree.                                                                                                                       |
| `resilience-plugin/test/unit/resilience-plugin.test.ts` (extend)                  | `resilience-plugin.ts`         | `defaultCircuitBreaker` refused at registration.                                                                                                                                               |
| `grpc-plugin/test/unit/grpc-client.test.ts` (extend)                              | `grpc-client.ts`               | Outcome wiring; marked-503 resend rows (after the Core gate); an unmarked 503 is never resent.                                                                                                 |
| `grpc-plugin/test/unit/call-outcome.test.ts` (new)                                | `call-outcome.ts`              | The §3.8 table as data, including JSON-parsed wire `Unimplemented`/`Unavailable`.                                                                                                              |
| `grpc-plugin/test/unit/rpc-call.test.ts` (extend)                                 | `rpc-call.ts`                  | §3.11: abort before `return()`, a signal-watching suspended generator settles.                                                                                                                 |
| `grpc-plugin/test/unit/native-grpc-reply.test.ts` (new)                           | `native-grpc-reply.ts`         | §3.11 rows for the native reply, plus its existing trailer behaviour.                                                                                                                          |
| `grpc-plugin/test/unit/rpc-dispatcher.test.ts` (extend)                           | `rpc-dispatcher.ts`            | Combined signal for a streaming procedure only.                                                                                                                                                |
| `grpc-plugin/test/e2e/grpc-streaming-e2e.test.ts` (extend)                        | streaming end to end           | A handler awaiting its next event is cancelled by `body.cancel()` and its `finally` runs.                                                                                                      |
| `grpc-plugin/test/unit/connect-loader.test.ts` (extend)                           | `connect-loader.ts`            | `isWireError` true for a decoded trailer error and a JSON-parsed body, false for `HTTP 503` and a transport error; `errorMetadata` (with §3.9).                                                |
| `grpc-plugin/test/unit/connect-real-import.test.ts` (extend)                      | `connect-loader.ts`            | Guarded REAL import: `isWireError` on real `ConnectError` instances.                                                                                                                           |
| `grpc-plugin/test/e2e/grpc-client-scenarios-e2e.test.ts` (extend)                 | client end to end              | Four dead-port rows ejected; drain 503 resent to the other replica.                                                                                                                            |
| `grpc-plugin/test/e2e/grpc-client-e2e.test.ts` (extend)                           | client end to end              | Two instances share 100 calls.                                                                                                                                                                 |
| `grpc-plugin/test/fixtures/fake-connect-runtime.ts` (fixture)                     | n/a                            | Gains `isWireError`, matching the real flag (cross-checked by the real-import test).                                                                                                           |

`connect-runtime.ts` and `service-discovery-plugin/src/interfaces/index.ts` are types-only files (no
runtime code to cover). Every fix row except V13-24 (documentation, §3.10) has a test that fails
without the fix; the PR records, per row, the test run red on `develop` and green on the branch.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m143c-calls-between-services, never main or develop
pnpm run check:plan        # this plan lints clean
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test
pnpm run test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Also: `pnpm test:coverage service-discovery-plugin resilience-plugin grpc-plugin` in the edit loop;
`pnpm run test:deno-lane` (the Deno DNS classifier row); `pnpm run release:publish --dry-run` and
`pnpm run release:verify 0.13.0` on the committed tree (the version the packages carry until the
release bump); `pnpm run ci:local` once, taken in turn. The Part 26 gate: V13-246 and V13-247 are
re-driven against the CoreDNS stand-in the rows were found on
(`~/Projects/hono-enterprise-published-smoke/v0.13.0/part28/x123/drive-dns.sh`), and V13-101/102/103
against the Consul container of X83, before the rows close on `0.14.0`.

## 8. Risks & mitigations

- The DNS race leaves a hung lookup running after its bound fires. Mitigation: the retry spacing
  keeps new lookups to one per name per interval; with the Core resolver (§3.6) the lookup itself is
  bounded.
- Background refresh serves a list one refresh older than before on every expiry, and serves the
  last good list indefinitely while the registry is down. Mitigation: `staleForMs` and `degraded` in
  the indicator, the warn line, and ejection of instances that fail calls; documented in the README
  and `docs/upgrading.md`.
- A background refresh outlives `close()`. Mitigation: `close()` marks the service closed and a
  settling refresh writes nothing; a unit test closes during a refresh.
- The empty grace serves removed instances for up to 30 s after a real scale-to-zero. Mitigation:
  `degraded` is true during the grace, the option documents `0`, and the ejection layer still
  removes instances that fail calls.
- The Core marker PR may not land in time. Mitigation: §3.9's gate; without it the branch ships no
  503 resend and V13-23's client half stays open.
- A peer (or a proxy) that copies the marker header onto a 503 it did not refuse could cause one
  extra send. Mitigation: once, unary only, within the deadline, and only for a non-wire error; §13.
- A spoofed or unauthenticated NXDOMAIN now empties a name's list after the grace window, where it
  used to be served stale. Mitigation: the grace window, `degraded` during it, the README's advice
  to use a trusted resolver (`servers`), and the security audit (§13).
- A response-streaming handler that ignores `ctx.signal` still holds its stream after a cancel
  (§3.11). Mitigation: documented, same as a hung unary handler; the drain bound still ends
  `stop()`.
- The new default registration id leaves, once, the uuid entries of processes that crashed before
  the upgrade. Mitigation: `docs/upgrading.md` says how to list and deregister them.
- Classifying every non-wire error as an instance failure ejects a healthy instance when the
  caller's own network fails. Mitigation: the 50 % ejection cap and the never-empty filter stay.
- The Core PRs for OD3 and OD4 may not land before this branch is ready. Mitigation: §3.6 and §3.7
  are the only parts that wait; the rest merges without them only if the maintainer agrees to split
  (the rows V13-104 and V13-246 then stay open).

## 9. Out of scope

- Kernel GOAWAY at drain start and stream accounting: M143i.
- Server-side HTTP/2 connection age (`MAX_CONNECTION_AGE`): runtime, Core lane; not requested by a
  row.
- Reading DNS record TTLs: no runtime resolver exposes them for SRV (Q8).
- A `DeadlineExceeded` counted as an instance failure: OD5.
- Guides under `docs/` (deployment, discovery, gRPC pages): M143n.

## 10. Documentation deliverables

- `packages/service-discovery-plugin/README.md`: options table (`resolveTimeoutMs`,
  `emptyAnswerGraceMs`, `servers`, and the new meaning of `cacheTtlMs` from §3.1 replacing "`0`
  disables caching" at `README.md:224`), "Health indicator" (DNS reachability, C2, and
  `staleForMs`), the M113b/M113o readiness section (a warm list at any age keeps `/ready` 200),
  "Self-registration" (C4), "Composing with the resilience plugin" (the rate breaker), a "Faults"
  paragraph for warm and cold reads, the retry spacing, the warn line, the empty rule and the
  NXDOMAIN warning (use a trusted resolver); `AGENT_CARD.md` (inside its byte budget). The
  `options.ts:24-29` JSDoc changes with it.
- `packages/grpc-plugin/README.md`: "Target" outcome rule (C1), "Connections" pinning and remedy
  (§3.10), "Rolling restarts" (C5: a refused stream, a GOAWAY and a marked drain 503 are resent, an
  unmarked 503 never; if §3.9 is cut, it says a drain 503 is not resent), a "Streaming" sentence
  that a cancelled stream aborts `ctx.signal` and a handler ignoring it holds the stream (§3.11),
  and that the server's own post-`close()` 503 (`grpc-service.ts:398-403`) is unmarked;
  `AGENT_CARD.md`.
- `packages/resilience-plugin/README.md`: the rate policy and its validation; `AGENT_CARD.md`.
- `PUBLIC_API.md`: Service Discovery options and notes (C3, C4, and the note "read-through … with …
  stale-on-failure" rewritten to "served from cache, refreshed in the background"), Resilience
  `CircuitBreakerPolicy` (after the Core PR), grpc-plugin client failure and resend rules.
- `CHANGELOG.md` "Unreleased": one entry per package, `Changed` for the registration id, the empty
  rule, the DNS absent-name answer and the outcome classification; `Added` for the options.
- `docs/upgrading.md` "Unreleased": the registration id (orphans of crashed processes), a missing
  DNS name now resolving `[]` instead of a 503 (static's rule), the grace window, the outcome rule,
  warm names served at once with background refresh and the new meaning of `cacheTtlMs: 0`.

## 11. Hand-overs

- **Core lane (a small PR after M143i merges; OD4):** `packages/common/src/services/resilience.ts`
  `CircuitBreakerPolicy`: "add a rate arm
  `{ failureRateThreshold, minimumCalls, timeout, resetTimeout }` as a union with today's
  `{ threshold, timeout, resetTimeout }`, with JSDoc for each field, and update `PUBLIC_API.md`
  Resilience."
- **Core lane (same PR; OD3):** `packages/common/src/runtime.ts` and
  `packages/runtime/src/adapters/{shared/node-dns-resolver.ts,deno/deno-dns-resolver.ts}`: "add an
  optional
  `IRuntimeServices.createDnsResolver?(options: { servers: readonly string[]; timeoutMs: number }): IDnsResolver`,
  served on Node and Bun by a `node:dns/promises` `Resolver` instance with `setServers`, `tries: 1`
  and `timeout` (`0` mapped to `-1`), and on Deno by `resolveDns` with `nameServer` and an abort
  signal; absent on Workers. Also make `resolveHost` reject with every failed lookup (an
  `AggregateError` cause), not only the first, so a caller can tell 'no such name' from 'one family
  timed out'."
- **Core lane (OD6, decided C; a small PR after M143i merges, and before §3.9 is built):**
  `packages/common` (a new file and its export line, additive) and
  `packages/kernel/src/application/application.ts` (`#handleRequest`'s `#stopping` branch): "add
  exported constants `UNPROCESSED_HEADER = 'x-setu-unprocessed'` and
  `UNPROCESSED_SHUTDOWN = 'shutdown'`, with JSDoc stating the guarantee of RFC 9113 §8.7 (the
  request was not processed); in the drain branch, after `respondWithError(...)`, call
  `builder.header(UNPROCESSED_HEADER, UNPROCESSED_SHUTDOWN)` so the header is present whatever the
  error responder writes; no other site sets it; test that the drain 503 carries it with and without
  a registered `errorHandler`, and that an in-pipeline 503 does not; update `PUBLIC_API.md` (Common
  constants, kernel shutdown notes) and `docs/upgrading.md`. Also delete the header from every
  response that is not the drain answer (a handler or middleware cannot set it), and test that." The
  constant names are this plan's proposal; Core may rename them, and §3.9 follows. On the `connect`
  protocol the default drain body is JSON and parses as a wire error; §3.9's rule does not depend on
  that, so Core need not change the body.
- **CLI lane, `@setu-ts/sdk` (OD4b; must land with the Core union):**
  `packages/sdk/src/circuit-breaker/circuit-breaker.ts` and `sdk/src/http/contracts.ts`: "narrow the
  `CircuitBreakerPolicy` union: implement the rate arm with the same rule as `resilience-plugin`
  (OD4b A), or refuse it at construction with a `TypeError` naming the field (OD4b B); update the
  SDK README and `PUBLIC_API.md` SDK section." Owning letter: the CLI-lane letter that holds `sdk`
  (M143k per the lane table), to be confirmed by the maintainer.
- **CLI lane (V13-24; M143d, whose ROADMAP section lists "Half of a row owned elsewhere: V13-24
  (owned by M143c)"):** `packages/cli/src/workspace/k8s.ts` and
  `packages/cli/src/workspace/discovery-module.ts`: "for a member whose transport is gRPC, emit a
  headless Service beside the ClusterIP one and have the deployed discovery resolve its pods (the
  `dns` arm, mode `'a'`, over the headless name), so calls spread over replicas."
- **M143n (docs):** the discovery and gRPC pages under `docs/` repeat §10's README changes.
- **ROADMAP correction (maintainer):** M143c's "Half of a row owned elsewhere" lists V13-23; V13-24
  also has a CLI half (M143d already lists it), V13-104 has a Core half and an SDK half (CLI lane),
  V13-246 has a Core half, V13-23 now has a second Core half (the drain marker) beside M143i's
  GOAWAY, and M143c also carries the M143i streamed-cancel hand-over (§3.11).

## 12. Open decisions for the maintainer

OD1 and OD6 were decided by the maintainer on 2026-11-22 (options B and C) and are recorded in §3.1
and §3.9.

- **OD2, the empty answer (Q3).** A: a grace window, default 30 s, `0` for immediate. B: replace at
  once (gRPC), and special-case Consul's restart. C: never replace a non-empty list with `[]`
  (Eureka's self-preservation), which leaves V13-247 open. **Recommend A** with 30 s (Consul's
  default check interval here is 10 s, `options.ts:182-186`).
- **OD3, the DNS name server (V13-246).** A: Core adds `createDnsResolver` (§11), the arm takes
  `servers`. B: the arm takes an injected `resolver?: IDnsResolver` and the application builds it,
  which puts runtime APIs in application code. **Recommend A.**
- **OD4, the breaker rate shape (Q9).** A: percent (`failureRateThreshold` 1 to 100, Resilience4j,
  opossum and Hystrix; the sibling `maxEjectionPercent`) with `minimumCalls`, as a union. B: a ratio
  (Polly's `FailureRatio`). C: optional fields beside the required `threshold`. **Recommend A.**
  Cost found in review: the union breaks `@setu-ts/sdk`'s compile (OD4b).
- **OD4b (new), the SDK's breaker under the union.** A: the SDK implements the rate arm with the
  same rule (one rule in both breakers; the SDK cannot import the plugin). B: the SDK refuses a rate
  policy at construction (refusing is allowed: ignoring it would fail silently). C: keep the SDK on
  a separate count-only type (`SdkCircuitBreakerPolicy`), which splits one public type in two.
  **Recommend A**, in the CLI lane, landing with the Core union.
- **OD5, `DeadlineExceeded` as an instance failure (Q5).** Envoy counts timeouts; a caller's tight
  deadline would then eject a healthy, slow instance. **Recommend no change** in this letter (no row
  asks for it).
- **OD7, spreading calls (Q7).** A: docs plus the CLI hand-over for per-pod discovery, no new
  option. B: also a `GrpcPluginOptions.sessionMaxAgeMs` that recycles a session so kube-proxy
  re-balances over time (off by default; no compared client ships one). C: several sessions per
  origin. **Recommend A.**
- **OD9 (new, M143i hand-over), a cancelled RPC stream whose handler is blocked (§3.11).** A: abort
  the handler's signal first, then await `return()` with no bound; a handler that ignores the signal
  still holds the stream (as a hung unary handler does). B: race `return()` against a bound (for
  example 5000 ms) and settle; cleanups and limit slots are released while the handler may still
  run, which M143i's audit rejected (P15). C: document only. **Recommend A**: no compared framework
  interrupts or bounds a blocked handler (Q5), and A releases everything a cooperating handler
  holds.
- **OD10 (new, from review), the outcome rule for JSON error replies (§3.8).** A: count
  `Unavailable` and `Unimplemented` as failures whatever the wire flag, other wire codes as success.
  B: count only non-wire errors (the draft), which on the default `connect` protocol makes a JSON
  404 or a proxy's JSON 503 a success, a regression from today. C: count every non-OK status (gRFC
  A50 implementations), which with `failureThreshold: 1` ejects instances for application errors
  such as `NotFound`. **Recommend A.**
- **OD8 (new, from OD1's decision), whether a stale list's age changes readiness.** With background
  refresh the last good list is served for as long as the registry is down. A: the indicator stays
  `up` at any age and reports `staleForMs` (§3.1), keeping the M113o rule that a warm cache keeps a
  replica ready. B: add an option `maxStaleMs` after which the indicator reports `degraded`, which
  makes `/ready` 503 (`health-plugin.ts:348-351`) and, because every replica's list ages together,
  takes every replica out at once. **Recommend A**; Eureka's self-preservation (Q2) is the same
  judgement that a registry outage should not empty the fleet.

## 13. Design security review

- **Trust boundaries crossed.** Network input from a registry (Consul, Kubernetes, DNS) decides
  where calls go; that was already true. New: a name-server address from configuration (operator
  input, not request input), and a resend of a unary call (with its headers and any credentials in
  them) to another instance of the same named service.
- **Credentials.** No new place holds a token. The new timeout messages name the provider kind, the
  service name and the bound, never the agent or API URL (already credential-free by
  `credentialFreeUrl`, `provider-factory.ts:87-91`, `:114-119`) or a token; the resolve reporter
  uses `describeError`, which masks URL userinfo.
- **Integrity.** The client trusts `x-setu-unprocessed: shutdown` from a peer it chose through
  discovery. A peer that sends the marker falsely can cause at most one extra send of one unary call
  to another instance of the same service, within the deadline; it cannot cause a resend of a wire
  error or of a stream. The marker carries no data and is never logged with request content.
- **Authorization and tenancy.** Not touched.
- **Availability from network answers.** An authoritative NXDOMAIN now replaces a list with `[]`
  after `emptyAnswerGraceMs` (V13-247), where it used to be served stale; an unauthenticated or
  spoofed UDP answer can therefore take a service out after the grace. Mitigations: the grace,
  `degraded` during it, `servers` for a trusted resolver, the README's warning. A Consul or
  Kubernetes answer that is empty follows the same rule.
- **The marker is a convention until Core strips it.** A gRPC handler can set `x-setu-unprocessed`
  on its own `Unavailable` (connect's `ctx.responseHeader`); the effect is bounded to one extra send
  of one unary call (§3.9), and the Core hand-over makes the kernel delete the header from every
  non-drain response.
- **Bounds.** The per-name reporters and retry state are keyed by service names the application
  resolves (not request input), and are cleared by `close()`; the DNS watch never holds more than
  one lookup per name.
- **Audit (required).** The diff crosses trust boundaries named by CLAUDE.md and the security-audit
  skill: network input from registries and name servers decides where calls and their credentials
  go, and a resend carries a call's headers to another host. A committed-tree security audit per
  `.roo/skills/security-audit/SKILL.md` runs on the final commit in a freshly spawned Claude agent
  that did not implement or review the milestone, and its record goes in the PR.
