# Milestone 143 Core follow-up — DNS resolver with chosen name servers, and the drain marker (`@setu-ts/common`, `@setu-ts/runtime`, `@setu-ts/kernel`)

> **Status:** Complete (PR pending); security-audited at 727b58da6, no findings. Branch:
> `feat/m143-core-dns-drain`. `develop` and `main` are protected; all work (implementation and
> fixes) stays on this one branch until it merges through a single PR into `develop`. Ships in
> `0.14.0`.

## 0. Objective & scope

M143c (Services lane) handed two pieces to the Core lane, and both block M143c rows. **V13-246,
server half:** the `dns` discovery arm cannot be pointed at a name server, and a lookup has no bound
the runtime enforces. The plugin may not import `node:dns`, so the runtime must offer a resolver
built for chosen name servers with a per-lookup bound (maintainer decision on M143c's OD3, option A,
M143c plan §3.6 and §11). In the same seam, `resolveHost` keeps only the first family's failure as
its `cause`, so a caller cannot tell "no such name" from "the AAAA lookup timed out". **V13-23,
client half:** the kernel's drain 503 says nothing a client can trust about whether the request ran.
M143c's gRPC client resends a unary call only when the server marks the 503 as not processed
(maintainer decision OD6 option C, M143c plan §3.9 and §11), with Finagle's `finagle-http-nack` as
the precedent. This branch ships the runtime half of the first and the server half of the second.

- **In scope:**
  - An optional `IRuntimeServices.createDnsResolver(options)` in `common`.
    - Node and Bun serve it with a `node:dns/promises` `Resolver` per lookup.
    - Deno serves it with `resolveDns` and `nameServer`.
    - Workers leave it absent.
  - Option validation shared by every runtime.
  - A whole-lookup bound the resolver enforces itself.
  - `resolveHost` rejecting with every failed lookup (an `AggregateError` cause), on the existing
    `runtime.dns` resolvers and the new ones.
  - The exported marker constants in `common`.
  - The kernel setting the marker on its drain 503. It is not removed from other responses
    (maintainer decision, 2026-11-23, §3.7).
  - Docs: `PUBLIC_API.md`, `docs/upgrading.md`, the three READMEs and agent cards, `CHANGELOG.md`.
- **NOT this milestone:**
  - The discovery plugin's `servers` option, its validation, and reading `createDnsResolver`: M143c
    (`service-discovery-plugin`).
  - The gRPC client's resend rule that reads the marker: M143c §3.9 (`grpc-plugin`).
  - `src/adapters/workers`: Workers lane. Nothing there changes; the member stays absent because
    `cf-runtime.ts` never sets it.
  - The Node HTTP/2 listener advertising `maxHeaderListSize`: dropped by the maintainer on
    2026-11-23.
  - Normalising DNS error codes across runtimes: out of scope (§9).

### 0.1 Compared with (sibling code and established frameworks)

Each cell was read from the linked documentation or source on 2026-11-23, or measured on this
machine (Node 24.22.1, Bun 1.4.5, Deno 2.9.6) against a local UDP DNS fixture that answers, returns
NXDOMAIN or SERVFAIL, or never replies. "Not verified" means it was not confirmed.

| Question                                           | This repo today                                                                                           | grpc-go                                                                                                                                                                                                                    | Envoy                                                                                                                                                                                                                                        | Go `net.Resolver`                                                                       | Finagle                                                                                                                                                                                                                                                                                                                                                                                            | Runtimes (measured)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 Choosing a name server                          | Host resolver only (`node-dns-resolver.ts:70-86`, `deno-dns-resolver.ts:54-85`)                           | The target's authority, `dns://<server>/host`, default port 53 (`internal/resolver/dns/dns_resolver.go`, `newNetResolver`)                                                                                                 | `resolvers` on `CaresDnsResolverConfig`; `use_resolvers_as_fallback` default `false` ([cares_dns_resolver.proto](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/network/dns_resolver/cares/v3/cares_dns_resolver.proto))      | `PreferGo` plus a `Dial` that connects to the chosen server ([pkg.go.dev/net#Resolver]) | not applicable                                                                                                                                                                                                                                                                                                                                                                                     | Node and Bun: instance `setServers` takes IP literals with an optional port (`'127.0.0.1:7853'`, `'[::1]:53'`); a host name throws `ERR_INVALID_IP_ADDRESS`; an empty list fails each lookup (`UNKNOWN_ARES_ERROR` on Node, `ENOSERVER` on Bun). Deno: one `nameServer: { ipAddr, port }` per call; a host name rejects with "invalid IP address syntax"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Q2 What the lookup bound covers                    | No bound on `runtime.dns`                                                                                 | Whole resolution: `context.WithTimeout(ctx, ResolvingTimeout)`, 30 s                                                                                                                                                       | Per server attempt: `query_timeout_seconds` (Envoy default 5) is "each name server is given to respond… on the first try", with `query_tries` (Envoy default 4)                                                                              | Whole lookup: the caller's `context`                                                    | not applicable                                                                                                                                                                                                                                                                                                                                                                                     | Node `Resolver` `timeout` is per attempt: `tries: 1, timeout: 500` ends at 501 ms; two silent servers take 1003 ms; default `tries` (4) takes 7536 ms. `timeout: 0` and `-1` both take about 2010 ms (the c-ares default) on a lookup that is not the process's first. The first lookup in a Node process takes about twice the attempt timeout (989 ms for `timeout: 500`, about 2995 ms for `-1`; review probe), so these times describe later lookups. A fraction or a value of 2^31 or more throws `ERR_OUT_OF_RANGE`. Bun's attempts are coarser: `timeout: 300` and `timeout: 500` each end at about 1002 ms with one server, but two servers with `timeout: 500` end at about 1501 ms, so there is no simple per-server rule. Deno without a signal: 15 s per server; with a signal that fires first, a `DOMException` `TimeoutError` at the signal; with a longer signal, Deno times out on its own at about 2006 ms |
| Q3 Cancelling a lookup                             | not applicable                                                                                            | Context cancellation                                                                                                                                                                                                       | not verified                                                                                                                                                                                                                                 | Context cancellation                                                                    | not applicable                                                                                                                                                                                                                                                                                                                                                                                     | Node and Bun: `Resolver.cancel()` rejects every outstanding query on that instance with `ECANCELLED` (302 ms after a 300 ms cancel). Deno: `signal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q4 Telling failures apart                          | `resolveHost` keeps `failures[0]` as `cause` (`node-dns-resolver.ts:57-58`, `deno-dns-resolver.ts:80-82`) | NXDOMAIN is an empty update, not an error (`dns_resolver.go`, `handleDNSError`)                                                                                                                                            | not verified                                                                                                                                                                                                                                 | `*net.DNSError` with `IsNotFound`, `IsTimeout`                                          | not applicable                                                                                                                                                                                                                                                                                                                                                                                     | Node: `ENOTFOUND` (NXDOMAIN), `ENODATA` (a v4-only host's AAAA), `ESERVFAIL`, `ETIMEOUT`, `ECONNREFUSED` (closed port). Bun: a v4-only host's AAAA is `ENOTFOUND`, and a closed port is `ETIMEOUT`. **Deno 2.9.6 throws `NotFound` with the same message for NXDOMAIN, no records and SERVFAIL**; the error has only `name`, `message` and `stack`, with no code to separate them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q5 How a server marks a response as safe to resend | Nothing on the drain 503 (`kernel/src/application/application.ts:1392-1408`)                              | gRFC A6: transparent retry covers a refused stream or a stream past GOAWAY; `grpc-retry-pushback-ms` says only how long to wait, or not to retry ([A6](https://github.com/grpc/proposal/blob/master/A6-client-retries.md)) | `x-envoy-overloaded` is set on a response Envoy dropped for maintenance mode or circuit breaking; the docs state no resend rule ([router filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/router_filter)) | not applicable                                                                          | `HttpNackFilter`: 503 with `finagle-http-nack` (and `Retry-After: 0`), body "Request was not processed by the server… and is safe to retry"; `finagle-http-nonretryable-nack` for "not processed… should not be retried" ([HttpNackFilter.scala](https://raw.githubusercontent.com/twitter/finagle/develop/finagle-base-http/src/main/scala/com/twitter/finagle/http/filter/HttpNackFilter.scala)) | HTTP/2 RFC 9113 §8.7: `REFUSED_STREAM` means no processing and "can be safely retried", and a server must not claim that unless it can guarantee it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q6 Is the marker removed from other responses      | not applicable                                                                                            | not applicable                                                                                                                                                                                                             | Envoy docs do not say it removes upstream `x-envoy-*` response headers; not verified                                                                                                                                                         | not applicable                                                                          | The filter removes its request marker `finagle-http-retryable-request` from every incoming request ("only valid on a hop-by-hop basis"); it does not remove nack headers from other responses                                                                                                                                                                                                      | not applicable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

.NET's `Microsoft.Extensions.ServiceDiscovery.Dns` resolver options could not be read (the source
path returned 404), so .NET is not used in any recommendation here.

Where they split: Q2 divides between a whole-lookup bound (grpc-go, Go) and a per-attempt one
(Envoy, c-ares); OD1 in §11 chooses. Q6 shows no framework removes its marker; the maintainer
decided on 2026-11-23 that the kernel removes none (§3.7).

## 1. Contracts verified from SOURCE (not names)

| Reference                                        | Source (file:line)                                                                                            | Verified surface / fact                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDnsResolver`                                   | `packages/common/src/runtime.ts:277-298`                                                                      | `resolveSrv(hostname): Promise<readonly SrvRecord[]>`; `resolveHost(hostname): Promise<readonly string[]>`. JSDoc: "rejects only when both families fail"; `@throws {Error}`. No statement about `cause`                                                                                                                    |
| `IRuntimeServices.dns`                           | `packages/common/src/runtime.ts:432-440`                                                                      | `readonly dns?: IDnsResolver`; absent on Workers. Optional-method precedent on the same interface: `reportError?` (`:319`), `unrefTimer?` (`:392`), `onSignal?` (`:472`), `onFatalError?` (`:508`)                                                                                                                          |
| Node and Bun default resolver                    | `packages/runtime/src/adapters/shared/node-dns-resolver.ts:24-86`                                             | Injectable `NodeDnsModule` (`resolveSrv`, `resolve4`, `resolve6`); `combineAddressFamilies` throws `Error('DNS lookup failed for <host>', { cause: failures[0] })` when both fail. Static `node:dns/promises` import                                                                                                        |
| Deno default resolver                            | `packages/runtime/src/adapters/deno/deno-dns-resolver.ts:21-85`                                               | `DenoDnsHost.resolveDns(query, 'SRV' \| 'A' \| 'AAAA')`, no options parameter; its own copy of the combine loop with `cause: failures[0]`                                                                                                                                                                                   |
| `DenoHost.resolveDns`                            | `packages/runtime/src/adapters/deno/deno-runtime.ts:71-74`                                                    | Two overloads, two parameters, no options                                                                                                                                                                                                                                                                                   |
| Runtime factories that set `dns`                 | `node-runtime.ts:212-264`, `bun-runtime.ts:115-215`, `deno-runtime.ts:101-258`                                | Each takes an injected `dns: IDnsResolver` with a default and passes `dns` to `mergeRuntimeServices`                                                                                                                                                                                                                        |
| `mergeRuntimeServices`                           | `packages/runtime/src/services/cross-runtime.ts:92-121`                                                       | Takes a `Pick<IRuntimeServices, …>` that names `dns` but not any new key; spreads `divergent` last. A new member must be added to the `Pick`                                                                                                                                                                                |
| Workers runtime                                  | `packages/runtime/src/adapters/workers/cf-runtime.ts:54-60`                                                   | "`fs`, `workers`, `dns` and `onSignal` are all deliberately ABSENT here"; it never sets keys it does not name, so `createDnsResolver` stays absent with no edit                                                                                                                                                             |
| Runtime barrel                                   | `packages/runtime/src/index.ts:42-47`                                                                         | Exports `createNodeDnsResolver`, `NodeDnsModule`, `createDenoDnsResolver`, `DenoDnsHost`, `DenoSrvRecord`                                                                                                                                                                                                                   |
| Drain branch                                     | `packages/kernel/src/application/application.ts:1391-1408`                                                    | `if (this.#stopping)`: a fresh `ResponseBuilder`, the startup error responder seeded into a fresh state map, `respondWithError(…, { status: 503, title: 'Service Unavailable' })`, `return builder`. No request context, no pipeline, no handler                                                                            |
| The three consumers of `#handleRequest`          | `application.ts:1009` (adapter `setHandler`), `:1238` (`dispatch`), `:1329` (`inject`)                        | `dispatch` and `inject` read `response.snapshot()` and its `headers`; adapters receive the builder                                                                                                                                                                                                                          |
| How runtimes read a response                     | `runtime/src/adapters/shared/fetch-mapping.ts:635-662`; `node-http-adapter.ts:669`                            | Every consumer reads headers through a lazy `snapshot()`: `mapSnapshotToWebResponse` uses `snapshot.responseInit?.headers ?? snapshot.headers`, and `responseInit` is undefined once headers are materialised. So a header set after the terminal call reaches `inject`, `dispatch` and the wire                            |
| `ResponseBuilder.header()` after a terminal call | `packages/kernel/src/context/response.ts:98-101`, `:267-277`                                                  | `header()` sets (not appends) and has no `#ended` guard, so it works after `respondWithError` has ended the builder with `.json()` or `.send()`. `#materializeHeaders` folds a frozen `#responseInit` (the `content-type` from `.json()`) into `#headers`, and snapshots read headers lazily through `headersForSnapshot()` |
| Error responder                                  | `packages/common/src/errors/error-responder.ts` (`respondWithError`)                                          | Writes status, headers and body through the application's responder when one is seeded, else the framework default; application code, so it can write any header                                                                                                                                                            |
| `x-setu-` header constants precedent             | `packages/common/src/services/messaging.ts:19,27`                                                             | `ORDERING_KEY_HEADER = 'x-setu-ordering-key'`, `DEDUPLICATION_ID_HEADER = 'x-setu-deduplication-id'`: exported `const` strings in `common`                                                                                                                                                                                  |
| The consumer's absent-name classifier            | M143c branch `service-discovery-plugin/src/providers/dns-provider.ts:243-253`                                 | Walks `cause` to depth five and matches `code` `ENOTFOUND`/`ENODATA` or `name` `NotFound`; it does not yet walk `AggregateError.errors` (M143c's plan says it will once this lands)                                                                                                                                         |
| M143c's bound option                             | M143c branch `service-discovery-plugin/src/options.ts:34,245`; plan §3.1                                      | `resolveTimeoutMs`, default `2000`, `0` = unbounded. M143c passes it as `timeoutMs` and also races each lookup against it itself                                                                                                                                                                                            |
| Test lanes                                       | `scripts/test-lanes.ts`: `DENO_LANE_TESTS` (`:3`), `NODE_EXCLUDED_TESTS` (`:61`), `DENO_ONLY_SOURCES` (`:80`) | `DENO_LANE_TESTS` lists `packages/runtime/test/unit/deno-dns-resolver.test.ts`. A test that needs real Deno APIs goes in `DENO_LANE_TESTS` and `NODE_EXCLUDED_TESTS`. A source listed in `DENO_ONLY_SOURCES` is measured only by the Deno lane                                                                              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                   | Resolution (picked side)                                                               | Doc deliverable (same PR)                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| C1  | M143c §3.6 and §11 say Deno "forces a 1 s, one-attempt resolver timeout" when a signal is passed. Measured on Deno 2.9.6: the lookup times out on its own at about 2006 ms | The measurement. The docs state "about 2 s on Deno 2.9.6" and do not promise it        | `packages/runtime/README.md` DNS section; the coordinator relays the correction to M143c (§12 H3)               |
| C2  | M143c §0.2 Q11 says Deno's `NotFound` can be told apart by `ares_code`. On Deno 2.9.6 the error has no such field, and SERVFAIL also throws `NotFound`                     | The measurement. The runtime README says Deno cannot tell SERVFAIL from an absent name | `packages/runtime/README.md`; relayed to M143c (§12 H2), whose classifier reads Deno SERVFAIL as an absent name |

## 3. Design decisions

### 3.1 `createDnsResolver`: an optional member, absent on Workers

- **Decision:** `common` adds `createDnsResolver?(options: DnsResolverOptions): IDnsResolver` to
  `IRuntimeServices`, beside `dns`. It also adds the exported interface `DnsResolverOptions`:
  `{ readonly servers: readonly string[]; readonly timeoutMs: number }`.
  - The Node and Bun factories set it to the shared Node implementation (§3.3).
  - The Deno factory sets it to the Deno implementation (§3.4).
  - Workers sets nothing.
  - `mergeRuntimeServices`'s `Pick` gains `'createDnsResolver'`.
  - Each factory takes an injected creator, the same way `dns` is injected today, so a test can pass
    a fake. Its default is the real one. On Node and Bun this is a fourth parameter. On Deno it is a
    fifth parameter after `globalEvents`.
  - The member is a method, so every call returns a new resolver. The options are checked at the
    call (§3.2), so a bad server fails when the application starts, not on the first lookup.
- **Why:** the optional-member shape follows `dns?`, `onSignal?` and `onFatalError?` on the same
  interface. An optional member breaks no implementor (`IRuntimeServices` is implemented outside the
  repo by test fakes). Workers has no resolver API, so leaving it absent lets M143c refuse with a
  named error, as M143c's decided OD3 says.
- **Test home:** `packages/runtime/test/unit/node-runtime.test.ts`, `bun-runtime.test.ts`,
  `deno-runtime.test.ts` (the member is a function and passes the injected creator its options),
  `packages/runtime/test/unit/cf-runtime.test.ts` (the key is absent:
  `'createDnsResolver' in runtime === false`), `cross-runtime.test.ts` (the merge keeps the key).

### 3.2 One validation for every runtime

- **Decision:** a new internal module, `packages/runtime/src/adapters/shared/dns-server-options.ts`
  (not exported from `src/index.ts`), exports `parseDnsResolverOptions(options)`. It returns
  `{ servers: readonly { address: string; port: number; family: 4 | 6 }[]; timeoutMs: number }` or
  throws a `RangeError`.
  - `servers` must be a non-empty array. An empty array is refused: Node and Bun would fail every
    lookup with an unnamed error (Q1).
  - Each entry is one of four forms:
    - an IPv4 literal (`'10.0.0.53'`);
    - an IPv4 literal with a port (`'10.0.0.53:5353'`);
    - a bare IPv6 literal (`'::1'`);
    - a bracketed IPv6 literal with a port (`'[::1]:5353'`).
  - The port defaults to 53. It is written as plain decimal digits (no sign, no whitespace) and must
    be from 1 to 65535.
  - Any entry containing `%` is refused first, as an IPv6 zone index. `isIP('fe80::1%eth0')` returns
    6 on all three runtimes, and Node's `setServers` silently drops the zone (review probe).
  - The literal is then checked with `nodeNet.isIP`, read at call time from a namespace import
    (`import * as nodeNet from 'node:net'`), for the same reason as §3.3: this module is reachable
    from the runtime barrel that Workers apps load, and a named import of a member workerd might
    lack would fail module linking in every Worker.
  - These are refused: a host name, an IPv6 zone index (`fe80::1%eth0`), an empty string, and
    anything else `isIP` rejects. Each refusal is a `RangeError` naming `servers[<index>]` and the
    entry. The message says a port needs brackets for IPv6.
  - An unbracketed IPv6 address followed by `:port` cannot be detected: `'::1:5353'` is itself a
    valid IPv6 literal. It is read as an address on port 53, and the README says so.
  - `timeoutMs` must be an integer from `0` to `2_147_483_647`. A fraction, a negative value, `NaN`
    or a larger value is refused with a `RangeError` naming `timeoutMs`. Node itself throws
    `ERR_OUT_OF_RANGE` above that limit (Q2).
  - Node and Bun receive servers rebuilt from the parsed form (`address` for port 53 IPv4,
    `address:port`, `[address]:port`). Deno receives `{ ipAddr, port }`.
- **Why:** M143c validates its own option too, but this is a public runtime API with other callers.
  The runtimes refuse different inputs with different errors (Q1), so one parser gives one rule and
  one message everywhere.
- **Test home:** `packages/runtime/test/unit/dns-server-options.test.ts`. Every accepted and refused
  form is a table row, including the default port, port 0, port 65536, `'10.0.0.53:+53'`,
  `' 10.0.0.53'`, an IPv6 zone, `'::1:5353'` (accepted as an address on port 53), a duplicate entry
  (accepted), and `timeoutMs` of `0`, `2_147_483_647`, `2_147_483_648`, `1.5`, `-1` and `NaN`.

### 3.3 Node and Bun: a `Resolver` per lookup, under a whole-lookup bound

- **Decision (OD1 recommendation A):** `timeoutMs` bounds **each lookup call as a whole**. That is
  one `resolveSrv` call, or one `resolveHost` call covering both families. It holds whatever the
  number of servers and whatever the runtime's own attempt timing. The resolver enforces it with its
  own timer. A new internal module,
  `packages/runtime/src/adapters/shared/node-server-dns-resolver.ts`, exports
  `createNodeServerDnsResolver(options, deps)`. `deps` is an injectable
  `{ createResolver(opts: { timeout: number; tries: number }): NodeResolverLike; setTimeout; clearTimeout }`.
  The real `createResolver` default is `new nodeDns.Resolver(opts)`. It reads the class from the
  same namespace import the existing resolver uses (`import * as nodeDns from 'node:dns/promises'`,
  `node-dns-resolver.ts:13`), never a named `import { Resolver }`. The runtime barrel is loaded by
  Workers apps, and a named import of a member workerd might lack would fail module linking in every
  Worker. A namespace import only fails when the member is read, and Workers never calls the
  creator.
  - **One `Resolver` per lookup call**, because `Resolver.cancel()` cancels every query on that
    instance (Q3), and lookups must not cancel each other. The resolver is created with `tries: 1`;
    Node's default of 4 multiplies the time (Q2). Its servers are set with
    `setServers(<rebuilt servers>)`.
  - **Attempt timeout passed to c-ares:** `Math.max(1, Math.ceil(timeoutMs / servers.length))`, so
    each server gets its share of the bound. This is always an integer from 1 to 2^31-1, so c-ares
    accepts it. The share is a target, not a guarantee: the first lookup in a Node process takes
    about twice the attempt timeout (review probe: 989 ms for `timeout: 500`, then 502 ms on later
    lookups). The README says so. When `timeoutMs` is `0`, the attempt timeout is `-1`, the c-ares
    default: about 2 s per server, or about 3 s on the first lookup in a process.
  - **The bound:** when `timeoutMs > 0`, a timer of `timeoutMs` is started with the lookup. If the
    lookup has not settled when it fires, the resolver first sets a timed-out flag, then calls
    `cancel()` on that lookup's instance. `cancel()` rejects the pending queries with `ECANCELLED`
    (Q3). The flag makes every settlement after it ignored, so an `ECANCELLED` never reaches the
    caller. The lookup then settles by these rules:
    - `resolveSrv` rejects with a timeout error.
    - `resolveHost` treats each family still pending as failed with that timeout error, then applies
      §3.5. So a family that already answered is still returned.
    - The timeout error is `Error('DNS lookup for <host> did not finish within <timeoutMs> ms')`
      with `code: 'ETIMEOUT'`, the code Node itself uses.
    - The timer is cleared when the lookup settles first.
  - **When `timeoutMs` is `0`,** the resolver adds no timer of its own. The runtime's own attempt
    timeout ends each lookup (Q2).
  - **The result shape** is the same as `createNodeDnsResolver`: SRV `name` becomes `host`.
  - **Bun:** the same module. Bun's attempt timing is coarser than the share asks for: a single
    attempt of `timeout: 300` or `500` lasts about 1 s. Two servers with `timeout: 500` took about
    1501 ms (review probe), so there is no simple per-server rule. The README says only that a short
    bound may end before a later server is tried. The bound itself holds, because the resolver's own
    timer enforces it.
- **Why whole-lookup:**
  - Callers think in "how long may I wait for this name". M143c's `resolveTimeoutMs` is exactly
    that, and grpc-go (`ResolvingTimeout`) and Go (`context`) bound the whole resolution.
  - A per-attempt bound (Envoy, c-ares) would make the worst case `servers × timeout` on Node and
    longer on Bun, measured (Q2). A caller could not predict it.
  - Splitting the bound across servers keeps the c-ares order. After the first lookup in a process,
    a silent first server still leaves time for the second.
- **Test home:**
  - `packages/runtime/test/unit/node-server-dns-resolver.test.ts`, with the injected fake `Resolver`
    and timers:
    - the options passed (`tries: 1`, the split timeout, `-1` for `0`);
    - the rebuilt server strings;
    - one instance per call;
    - SRV mapping;
    - the timer cancelling and rejecting with `ETIMEOUT`, and not fired when the lookup settles
      first;
    - the fake's `cancel()` rejecting outstanding queries with `ECANCELLED`, and the caller's error
      (and every `AggregateError` member) being the `ETIMEOUT` error, never `ECANCELLED`;
    - a pending family under `resolveHost` counted as failed, both while the other family answered
      and while both are pending;
    - no timer when `timeoutMs` is `0`.
  - `packages/runtime/test/integration/dns-server-resolver-node.test.ts`, real `node:dns` against
    the UDP fixture of §3.8. The suite starts with one untimed warm-up lookup, so the first-lookup
    doubling never decides a timing assertion. The two-server case uses `timeoutMs: 3000`:
    - an answer;
    - NXDOMAIN (`ENOTFOUND` inside the `AggregateError`);
    - a v4-only host resolving to its v4 address;
    - a silent server rejecting with `ETIMEOUT` in under `timeoutMs + 250` ms;
    - two servers whose first is silent still answering from the second within the bound.

### 3.4 Deno: `resolveDns` with `nameServer`, servers tried in order

- **Decision:** a new module, `packages/runtime/src/adapters/deno/deno-server-dns-resolver.ts`,
  exports `createDenoServerDnsResolver(options, host, timers)`. `timers` defaults to the global
  `setTimeout`/`clearTimeout` (the runtime package may use them); tests inject fakes. It is internal
  and not exported from `src/index.ts`. `host` is a `DenoDnsHost` whose `resolveDns` overloads gain
  an optional third parameter,
  `options?: { nameServer?: { ipAddr: string; port: number }; signal?: AbortSignal }`. Adding an
  optional trailing parameter to an exported interface's overloads keeps every existing
  implementation assignable. `DenoHost.resolveDns` in `deno-runtime.ts` gains the same parameter.
  - Deno takes one name server per call (Q1). So each record-type lookup tries the servers in order.
    It moves to the next server only when the error is not `NotFound`. It stops at the first answer
    or the first `NotFound`, because NXDOMAIN is the zone's own answer and another server would give
    the same.
  - Each server attempt gets its own `AbortController`. The injected `setTimeout(share)` aborts it,
    with the same share as §3.3, and the timer is cleared when the attempt settles.
    `AbortSignal.timeout` is not used: it cannot be injected or cleared. The whole-lookup timer
    (also injected) aborts the current attempt's controller. Before that it sets the same timed-out
    flag as §3.3, so the abort's rejection is ignored. The lookup then settles exactly as §3.3 does:
    `ETIMEOUT` error, pending families counted as failed.
  - When `timeoutMs` is `0`, no signal is passed and Deno's own timeout applies: 15 s per server,
    measured (Q2). The README states this.
  - Deno on its own ends a signalled attempt at about 2 s even when the share is longer (C1). That
    is an earlier end, never a later one, so the bound holds.
  - When the resolver's own timer is what fires, the lookup surfaces as `ETIMEOUT`. When Deno's own
    timer ends an attempt first, it surfaces as Deno's `TimedOut`, and the resolver rotates to the
    next server or reports it.
- **Why:** this is the closest Deno can come to c-ares's server rotation. Rotation on a non-answer
  matches what c-ares does on timeout and on a refused connection. Not rotating on `NotFound`
  matches c-ares on NXDOMAIN. Deno also reports SERVFAIL as `NotFound` (Q4, C2), so on Deno a
  SERVFAIL does not move to the next server; the README states it.
- **Test home:**
  - `packages/runtime/test/unit/deno-server-dns-resolver.test.ts`, Node-run with a fake host and
    timers:
    - the `nameServer` and signal passed per attempt;
    - rotation on a `TimedOut` and on a generic error;
    - no rotation on `NotFound`;
    - the share per attempt, driven by the injected timers, with every attempt timer cleared once
      the lookup settles (the fake timer has none pending);
    - the whole-lookup timeout settling as §3.3, with the abort's rejection never reaching the
      caller;
    - no signal when `timeoutMs` is `0`;
    - SRV `target` becoming `host`.
  - `packages/runtime/test/integration/dns-server-resolver-deno.test.ts`, real `Deno.resolveDns`
    against the UDP fixture, added to `DENO_LANE_TESTS`: an answer, NXDOMAIN, a silent first server
    with an answering second, and a silent server rejecting within the bound.

### 3.5 `resolveHost` rejects with every failure

- **Decision:** one shared function, `combineAddressFamilies(results, hostname)`, moves to a new
  internal module, `packages/runtime/src/adapters/shared/address-families.ts`. It is used by
  `createNodeDnsResolver`, `createDenoDnsResolver`, and the two new resolvers. This also deletes
  Deno's copy of the loop.
  - When both families fail, it throws
    `Error('DNS lookup failed for <host>', { cause: new AggregateError([aError, aaaaError], 'Every address lookup failed for <host>') })`.
    The errors are in A-then-AAAA order, each the runtime's own error or the §3.3 timeout error.
  - When one family succeeds, the addresses are returned and the other family's error is dropped, as
    today.
  - `common`'s JSDoc on `IDnsResolver.resolveHost` states the `AggregateError` cause and the order.
- **Why:** the hand-over asks for it, so that "no such name" (every member absent) and "one family
  timed out" (one member `ETIMEOUT`) can be told apart. Keeping `failures[0]` hid the second
  family's error.
- **Changes behaviour for:** code that read `error.cause.code`. That code now finds an
  `AggregateError` with no `code`. Inside the repo the only reader is M143c's classifier, which is
  being changed to walk `errors` (§12 H2). It ships in `0.14.0` as a Changed entry with an upgrading
  note, not as Breaking: the type surface is unchanged.
- **Test home:** `packages/runtime/test/unit/address-families.test.ts`. A table of fulfilled and
  rejected pairs gives the result or the error's `cause.errors`, in order. The existing
  `node-dns-resolver.test.ts:100-112` and `deno-dns-resolver.test.ts:97-110` assertions on `cause`
  change to the aggregate.

### 3.6 The drain marker constants

- **Decision (OD2 recommendation: keep the proposed names):** a new file,
  `packages/common/src/unprocessed-response.ts`, exports `UNPROCESSED_HEADER = 'x-setu-unprocessed'`
  and `UNPROCESSED_SHUTDOWN = 'shutdown'` as `const` strings. Both are exported from
  `packages/common/src/index.ts`.
  - The JSDoc states the guarantee: a response carrying `UNPROCESSED_HEADER: UNPROCESSED_SHUTDOWN`
    was answered by the Setu kernel before any lifecycle hook, middleware or handler ran for the
    request. The application's error responder may format the answer, and nothing else of the
    application ran, so the application did not process it. It is the meaning RFC 9113 §8.7 gives
    `REFUSED_STREAM`.
  - Readers compare the value exactly. Other values are reserved for later reasons and mean nothing
    today.
  - The JSDoc names the limit: the guarantee covers the Setu server that wrote the response. A proxy
    in between may have done work of its own.
  - The marker does not depend on the status. The drain answer is 503 by default, but an application
    error responder may write another status (`respondWithError` passes the status through
    `withServeableStatus`). The marker still means the request was not processed.
- **Why:** one constant pair read by the kernel and by M143c's client means the two cannot drift.
  The `x-setu-` prefix and the `common` placement follow `ORDERING_KEY_HEADER`. A value rather than
  a bare presence flag leaves room for another reason without a second header.
- **Test home:** `packages/common/test/unit/unprocessed-response.test.ts` (the exact strings, and a
  lowercase name, because `Headers` lowercases).

### 3.7 The kernel marks its drain answer (decided by the maintainer, 2026-11-23)

- **Decision:** in the drain branch of `#handleRequest`
  (`packages/kernel/src/application/application.ts:1392-1408`), after `respondWithError(…)`, the
  kernel calls `builder.header(UNPROCESSED_HEADER, UNPROCESSED_SHUTDOWN)`.
  - It runs after the responder, so the header is present with exactly that value whatever the error
    responder wrote. A responder that wrote the name with another value is overwritten, because
    `header()` sets rather than appends (`response.ts:98-101`).
  - No other kernel site sets it.
  - **The kernel does not remove the header from any other response** (maintainer decision,
    2026-11-23, replacing this plan's earlier removal design and its OD3). A handler, middleware,
    hook or error responder that writes `x-setu-unprocessed` sends it. No other kernel,
    response-builder or `@setu-ts/testing` change.
  - The header is **reserved**. The constant's JSDoc, `PUBLIC_API.md`, `docs/upgrading.md` and the
    READMEs say so: only the kernel's pre-pipeline shutdown answer sets it. An application that sets
    it is itself claiming the request was not processed, and a client that honours the marker may
    send that request again. The docs say no more than that, because no client reads the marker yet:
    the Setu gRPC client's rule (one resend of a unary call, within the deadline) is M143c §3.9's,
    and M143c names it in the docs when it ships.
- **Why:** the maintainer decided only that the kernel marks its drain 503. The "remove it
  everywhere else" item came from M143c's plan review. No compared framework removes its marker
  (Q6): Finagle sets `finagle-http-nack` and never strips it. Without removal, the cost is one extra
  send of one unary call, and only when an application writes the reserved header itself, which is
  that application's own claim. §10 records this as an accepted risk.
- **Test home:** `packages/kernel/test/integration/drain-unprocessed-marker.test.ts`, on each of
  `inject`, `fetch` and `dispatch`:
  - the drain 503 carries `x-setu-unprocessed: shutdown` with no `errorHandler`;
  - it carries it with a registered `errorHandler` writing problem+json;
  - it carries it with a responder that writes the header with another value (the value is
    `shutdown`). The responder is installed with `brandErrorResponder(middleware, { respond })` from
    `common` on a global middleware, which `#resolveErrorResponder` (`application.ts:2712-2726`)
    seeds into the drain branch; `errorHandler`'s formatter cannot write headers;
  - a handler's own 503 outside a drain does not carry it;
  - a request admitted before `stop()` began, whose handler answers 503 during the drain, does not
    carry it (§10 S2);
  - the existing drain-window test still sees 503.

  The `inject` and `dispatch` arms use the fake runtime and `fake.tick`, following
  `application-stop.test.ts:197-219` (a gated handler, `stop()`, release). The kernel test fake's
  `adapter.fetch` answers 501 (`kernel/test/fixtures/fake-runtime.ts:129-136`), so the `fetch` arm
  uses the real `RuntimePlugin()` and `start()`, as `detached-fetch.test.ts` does.

  `packages/runtime/test/e2e/drain-unprocessed-marker-node.test.ts`: on a real Node listener, a
  request during `stop()`'s drain gets the header on the wire.

### 3.8 The UDP DNS test fixture

- **Decision:** a test fixture, `packages/runtime/test/fixtures/udp-dns-server.ts`, built on
  `node:dgram` (Node and Deno both run it). It binds `127.0.0.1` on an OS-assigned port and answers:
  - `ok.test` with A `10.0.0.1` and no AAAA;
  - `v6.test` with AAAA only;
  - `_svc._tcp.ok.test` with an SRV record;
  - `servfail.*` with SERVFAIL;
  - `hang.*` with nothing;
  - every other name with NXDOMAIN.

  It counts the queries it receives. The probe used for this plan is the starting point. Fixtures
  are excluded from coverage.

- **Why:** real-backend proof without network access or a container. The silent name is the only way
  to test a bound honestly.
- **Test home:** used by the three real-runtime tests above. The Bun arm is a guarded spawn in the
  existing `runtime-edges-bun-deno.test.ts` pattern: it runs only when `bun` is installed and
  asserts the silent-server bound and an answer. Its child script,
  `packages/runtime/test/fixtures/bun-dns-child.ts`, calls the Bun runtime's `createDnsResolver`
  against the parent's UDP fixture and prints one JSON line per lookup; fixtures are excluded from
  coverage.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `createDnsResolver` is optional. `DenoDnsHost`'s new parameter
is optional and trailing. The `resolveHost` cause changes behaviour, not types, and ships in minor
`0.14.0` as Changed.

| Exported symbol                                                             | Kind                      | Consumer / real code path that READS it                                                                                                                                                                       |
| --------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRuntimeServices.createDnsResolver` (`common`)                             | optional interface method | M143c `service-discovery-plugin/src/providers/provider-factory.ts` (its `servers` arm); set by the Node, Bun and Deno runtime factories                                                                       |
| `DnsResolverOptions` (`common`)                                             | type                      | The member's parameter; `parseDnsResolverOptions` in `runtime`; M143c's factory call                                                                                                                          |
| `UNPROCESSED_HEADER` (`common`)                                             | const                     | `kernel/src/application/application.ts` drain branch; M143c `packages/grpc-plugin/src/client/grpc-client.ts` §3.9                                                                                             |
| `UNPROCESSED_SHUTDOWN` (`common`)                                           | const                     | `kernel/src/application/application.ts` drain branch; M143c `grpc-plugin` §3.9                                                                                                                                |
| `DenoDnsHost` (`runtime`, existing, widened)                                | interface                 | `createDenoDnsResolver` and `createDenoServerDnsResolver`; the Deno runtime factory passes its `DenoHost`                                                                                                     |
| `createNodeDnsResolver`, `createDenoDnsResolver` (existing)                 | function                  | Unchanged signatures; now use the shared `combineAddressFamilies`                                                                                                                                             |
| `DenoHost` (`runtime`, existing, widened)                                   | interface                 | `resolveDns` gains the optional third parameter; read by `createDenoRuntimeServices`, which passes it to both Deno resolvers                                                                                  |
| `createNodeRuntimeServices`, `createBunRuntimeServices` (existing, widened) | function                  | A fourth positional parameter, the injected `createDnsResolver` creator, defaulting to the real one. Read by the runtime's own default construction and by the factory unit tests (the same pattern as `dns`) |
| `createDenoRuntimeServices` (existing, widened)                             | function                  | A fifth positional parameter after `globalEvents`, the same creator. Same readers                                                                                                                             |

Internal and not exported: `parseDnsResolverOptions`, `createNodeServerDnsResolver`,
`createDenoServerDnsResolver` and `combineAddressFamilies`. `parseDnsResolverOptions` is read by the
two server resolvers; `combineAddressFamilies` by all four resolvers; the two server resolvers are
the factories' default creators. The injected creator's type is
`(options: DnsResolverOptions) => IDnsResolver`.

### 4.1 Options — every option names its consumer

| Option                         | Consumer                                                             | Behavior (per implementation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DnsResolverOptions.servers`   | `parseDnsResolverOptions` → Node/Bun `setServers`; Deno `nameServer` | Node/Bun: one `Resolver` per lookup with all servers, c-ares order. Deno: tried in order, next on a non-`NotFound` error. Workers: member absent                                                                                                                                                                                                                                                                                                                                                       |
| `DnsResolverOptions.timeoutMs` | the resolver's own whole-lookup timer; the per-server attempt share  | `> 0`: the whole lookup settles by the bound on every runtime. That is `ETIMEOUT` from the resolver's own timer, or the runtime's own error if that ends sooner (Deno `TimedOut` at about 2 s). Each server's attempt targets `ceil(timeoutMs / servers.length)`; Bun's timing is coarser and a process's first Node lookup takes about twice that. `0`: no own timer; the runtime's default applies (about 2 to 3 s per server on Node and Bun, 15 s per server on Deno, all measured, none promised) |

## 5. Implementation files

| File                                                                     | Purpose                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/runtime.ts`                                         | `DnsResolverOptions`; `createDnsResolver?` with JSDoc; `resolveHost` JSDoc on the `AggregateError` cause                                                                                                                 |
| `packages/common/src/unprocessed-response.ts` (new)                      | `UNPROCESSED_HEADER`, `UNPROCESSED_SHUTDOWN` with the guarantee in JSDoc                                                                                                                                                 |
| `packages/common/src/index.ts`                                           | barrel exports: `DnsResolverOptions`, the two constants                                                                                                                                                                  |
| `packages/runtime/src/adapters/shared/dns-server-options.ts` (new)       | `parseDnsResolverOptions` (§3.2)                                                                                                                                                                                         |
| `packages/runtime/src/adapters/shared/address-families.ts` (new)         | `combineAddressFamilies` with the `AggregateError` cause (§3.5)                                                                                                                                                          |
| `packages/runtime/src/adapters/shared/node-server-dns-resolver.ts` (new) | `createNodeServerDnsResolver` (§3.3)                                                                                                                                                                                     |
| `packages/runtime/src/adapters/shared/node-dns-resolver.ts`              | use `combineAddressFamilies`                                                                                                                                                                                             |
| `packages/runtime/src/adapters/deno/deno-server-dns-resolver.ts` (new)   | `createDenoServerDnsResolver` (§3.4)                                                                                                                                                                                     |
| `packages/runtime/src/adapters/deno/deno-dns-resolver.ts`                | `DenoDnsHost` optional third parameter; use `combineAddressFamilies`                                                                                                                                                     |
| `packages/runtime/src/adapters/deno/deno-runtime.ts`                     | `DenoHost.resolveDns` third parameter; inject and set `createDnsResolver`                                                                                                                                                |
| `packages/runtime/src/adapters/node/node-runtime.ts`                     | inject and set `createDnsResolver`                                                                                                                                                                                       |
| `packages/runtime/src/adapters/bun/bun-runtime.ts`                       | inject and set `createDnsResolver`                                                                                                                                                                                       |
| `packages/runtime/src/services/cross-runtime.ts`                         | `'createDnsResolver'` in the `Pick`                                                                                                                                                                                      |
| `packages/kernel/src/application/application.ts`                         | drain branch sets `UNPROCESSED_HEADER: UNPROCESSED_SHUTDOWN` after `respondWithError`                                                                                                                                    |
| `scripts/test-lanes.ts`                                                  | add `dns-server-resolver-deno.test.ts` to `DENO_LANE_TESTS` and `NODE_EXCLUDED_TESTS`; `deno-server-dns-resolver.ts` stays OUT of `DENO_ONLY_SOURCES`, because its fake-host unit test runs on Node and Node measures it |
| `packages/runtime/src/index.ts`                                          | unchanged (no new export; `DenoDnsHost` already exported)                                                                                                                                                                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                           | src covered                               | Key assertions (and the signature each call type-checks against)                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/unprocessed-response.test.ts` (new)                                                                      | `unprocessed-response.ts`                 | exact strings; lowercase name (§3.6)                                                                                              |
| `packages/common/test/unit/runtime-contracts.test.ts` (updated)                                                                     | `runtime.ts` (types only)                 | a fake `IRuntimeServices` without `createDnsResolver` and one with it both type-check; `DnsResolverOptions` fields are `readonly` |
| `packages/runtime/test/unit/dns-server-options.test.ts` (new)                                                                       | `dns-server-options.ts`                   | §3.2's table of accepted and refused entries and bounds; each `RangeError` names the field and index                              |
| `packages/runtime/test/unit/address-families.test.ts` (new)                                                                         | `address-families.ts`                     | §3.5's table; `cause` is an `AggregateError` with `errors` in A-then-AAAA order                                                   |
| `packages/runtime/test/unit/node-server-dns-resolver.test.ts` (new)                                                                 | `node-server-dns-resolver.ts`             | §3.3's fake-resolver assertions against `createNodeServerDnsResolver(options: DnsResolverOptions, deps)`                          |
| `packages/runtime/test/integration/dns-server-resolver-node.test.ts` (new)                                                          | `node-server-dns-resolver.ts` (real path) | §3.3's real `node:dns` assertions against the UDP fixture                                                                         |
| `packages/runtime/test/unit/deno-server-dns-resolver.test.ts` (new)                                                                 | `deno-server-dns-resolver.ts`             | §3.4's fake-host assertions                                                                                                       |
| `packages/runtime/test/integration/dns-server-resolver-deno.test.ts` (new, Deno lane)                                               | `deno-server-dns-resolver.ts` (real path) | §3.4's real `Deno.resolveDns` assertions                                                                                          |
| `packages/runtime/test/integration/runtime-edges-bun-deno.test.ts` (extended)                                                       | Bun real path                             | Bun arm: an answer and the silent-server bound, guarded on `bun` being installed                                                  |
| `packages/runtime/test/unit/node-dns-resolver.test.ts`, `deno-dns-resolver.test.ts` (updated)                                       | the two default resolvers                 | the aggregate cause; `DenoDnsHost` without the third parameter still assignable                                                   |
| `packages/runtime/test/unit/node-runtime.test.ts`, `bun-runtime.test.ts`, `deno-runtime.test.ts`, `cross-runtime.test.ts` (updated) | the factories and the merge               | §3.1                                                                                                                              |
| `packages/runtime/test/unit/cf-runtime.test.ts` (updated)                                                                           | `cf-runtime.ts` (no edit)                 | `createDnsResolver` absent                                                                                                        |
| `packages/kernel/test/integration/drain-unprocessed-marker.test.ts` (new)                                                           | `application.ts` drain branch             | §3.7 integration assertions on `inject`, `fetch` and `dispatch`                                                                   |
| `packages/runtime/test/e2e/drain-unprocessed-marker-node.test.ts` (new)                                                             | the wire                                  | §3.7 wire assertions                                                                                                              |

The fixtures `packages/runtime/test/fixtures/udp-dns-server.ts` and `bun-dns-child.ts` are excluded
from measurement. The fail-without-fix proof for the hand-back: the drain integration test fails
before the kernel edit, and the address-families test fails on `failures[0]`.

## 6.1 Documentation deliverables (same PR)

| Document                                                                               | Change                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_API.md`                                                                        | `IRuntimeServices.createDnsResolver` and `DnsResolverOptions` beside `dns` (around `:905-1010`); the `IDnsResolver.resolveHost` `AggregateError` cause; the two constants under Common; the widened `DenoDnsHost` and `DenoHost`; the three factory signatures (factory table around `:15009`); kernel shutdown notes naming the marker; the header is reserved (§3.7) |
| `docs/upgrading.md` (Unreleased)                                                       | the `resolveHost` cause change, and the new reserved `x-setu-unprocessed` header on the drain answer: what it means, and what an application that sets it is claiming                                                                                                                                                                                                  |
| `docs/deployment.md`                                                                   | the drain section names the marker and what a client may do with it; `docs/programmatic-api.md`'s shutdown order (`:313-314`) names it too                                                                                                                                                                                                                             |
| `packages/common/README.md`, `packages/runtime/README.md`, `packages/kernel/README.md` | the new surface; the runtime DNS section states §3.2's accepted forms, the bound and its per-runtime caveats (C1, C2, the first-lookup doubling, Bun timing); `## Exports` tables regenerated with `pnpm run docs:exports`                                                                                                                                             |
| `packages/{common,runtime,kernel}/AGENT_CARD.md`                                       | one line each, within the card byte budget                                                                                                                                                                                                                                                                                                                             |
| `CHANGELOG.md` `[Unreleased]`                                                          | Added: `createDnsResolver`, `DnsResolverOptions`, the constants and the drain marker. Changed: the `resolveHost` cause (`check-changelog-coverage` needs every new barrel export named)                                                                                                                                                                                |
| JSDoc                                                                                  | `@since 0.14.0` on each new export (`check-since-tags`); the TypeDoc ratchet (`generate-api-docs --check`) passes                                                                                                                                                                                                                                                      |
| `ROADMAP.md`, `CLAUDE.md`                                                              | per OD4; the CLAUDE.md status line "complete (PR pending)"; the plan archived to `plans/archive/`                                                                                                                                                                                                                                                                      |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m143-core-dns-drain, never develop or main
pnpm run check:plan        # this plan lints clean
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run test
pnpm run test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.13.0
```

Every suite runs through `/home/dkpaul91/.local/bin/setu-suite-queue`: one full `pnpm run ci:local`
on the final commit, then only the shards a later diff touches. The committed tree is
security-audited by a freshly spawned Claude agent following `.roo/skills/security-audit/SKILL.md`
(§10).

## 8. Risks & mitigations

- **A concurrent Core follow-up (circuit breaker; messaging and diagnostics) edits `common`'s
  barrel, `PUBLIC_API.md` and `CHANGELOG.md`.** Mitigation: additive lines only, merged from
  `develop` before the PR; conflicts there are line-order only.
- **Real-DNS timing tests flake under load.** Mitigation: assert upper bounds with 250 ms of slack
  and never a lower bound below the share. The fixture runs on loopback with an OS-assigned port.
  Bun's whole-second rounding is asserted only as "within the whole bound".
- **An application writes the reserved header on a response it processed.** A client that honours
  the marker may send that request again (with M143c, the Setu gRPC client resends a unary call
  once). Mitigation: the docs reserve the header and say what setting it claims; the risk is
  accepted by the maintainer (§3.7, §10).
- **A per-lookup `Resolver` costs more than a shared one.** Measured cost is construction and
  `setServers`, both in-process. A lookup already costs a network round trip. This is not on the
  request path unless the caller puts it there; M143c's cache keeps it off.
- **M143c's classifier reads Deno SERVFAIL as absent (C2).** Mitigation: relayed as H2. Core cannot
  fix it, because Deno 2.9.6 exposes nothing to tell them apart.

## 9. Out of scope

- One error code set across runtimes (`ENOTFOUND` vs Deno `NotFound`, Bun's `ENOTFOUND` for no
  data): callers already classify per runtime. Normalising would change `runtime.dns` errors for
  every caller. A later Core letter can take it, if a second consumer needs it.
- Reading record TTLs: Node's `resolveSrv` returns none (M143c Q11). M143c keeps `cacheTtlMs`.
- A marker for other kernel refusals, such as the pre-pipeline 400 or a body-limit 413. Those
  requests may already have been read, and nothing consumes a marker for them.
- The gRPC client's use of the marker: M143c §3.9.
- Removing the marker from responses other than the drain answer: decided against (§3.7).
- Workers DNS: Workers lane; there is no resolver API.

## 10. Design security review

Reviewed on 2026-11-23, before implementation, by the planning session and two fresh-agent plan
reviews.

- **Flows:** (1) application configuration → `createDnsResolver({ servers, timeoutMs })` → UDP/TCP
  queries to the chosen name servers → records returned to the caller (service discovery in M143c);
  (2) a request arriving after `stop()` began → the kernel's pre-pipeline drain branch → the error
  responder → the `x-setu-unprocessed: shutdown` header → a client deciding whether to send again.
- **Assets:** the bound on how long a lookup can hold a caller and a socket; the integrity of the
  name-server list (no host name resolved to find one); the truth of the marker's claim that the
  request was not processed.
- **Attackers:** a name server that never answers, answers slowly or answers with odd records; a
  caller passing malformed options (wrong types, sparse arrays, proxies); application code that
  writes the reserved header (accepted risk A1); an HTTP client sending the marker on a request (it
  is a response header; the kernel never reads it from a request). The diff crosses two trust
  boundaries. The committed-tree audit (freshly spawned Claude agent,
  `.roo/skills/security-audit/SKILL.md`) runs these obligations with positive and negative controls:

- **S1, the drain answer always carries the marker, with exactly the reserved value.** With and
  without an `errorHandler`, and when the responder writes the name with another value.
- **S2, the kernel never marks a processed request.** A request admitted before `stop()` began and
  finishing during the drain does not carry the marker from the kernel, even with status 503.
- (S3 was withdrawn with the removal design on 2026-11-23.)
- **Accepted risk A1 (maintainer, 2026-11-23): application code can send the marker.** The kernel
  does not remove `x-setu-unprocessed` from responses it did not mark. An application that writes it
  claims its request was not processed, and a client that honours the marker may send that request
  again. With M143c's rule, the Setu gRPC client sends a unary call once more, to another instance
  of the same service, within the deadline. The audit records this as accepted, not as a finding,
  and checks only that the docs reserve the header and say that a client may send the request again
  (the docs name no gRPC client until M143c ships its rule).
- **S4, chosen name servers are IP literals only.** No host name is resolved to find a name server.
  A refused entry's `RangeError` names the entry but carries no other configuration. Servers come
  from application configuration, never from a request.
- **S5, a silent or hostile name server cannot hold a lookup past its bound.** With `timeoutMs > 0`,
  every lookup settles by the bound, the cancelled query frees its socket (`Resolver.cancel`, Deno
  abort), and no timer is left behind after settling.
- **S6, no growth across lookups.** Per-lookup resolvers, controllers and timers are released.
- **S7, response records are not trusted beyond their shape.** SRV and address answers pass through
  as today (the mapping is unchanged). The audit confirms that nothing new parses record contents.

## 11. Decisions (maintainer, 2026-11-23)

- **OD1, what `timeoutMs` bounds: A.** The whole lookup call, enforced by the resolver's own timer,
  with each server's attempt given an equal share. Rejected: B, each server attempt (c-ares, Envoy);
  C, the whole lookup without the split.
- **OD2, the marker's name and value: A.** `UNPROCESSED_HEADER = 'x-setu-unprocessed'` and
  `UNPROCESSED_SHUTDOWN = 'shutdown'`. Rejected: B, a presence-only header.
- **OD3, the Connect `trailer-` form: moot.** The kernel removes the marker from no response (§3.7).
- **OD4, where this work is recorded: A, as a shared list.** A heading
  `#### Core follow-ups (after M143i)` under ROADMAP's M143 section, with one line for this PR (the
  circuit-breaker follow-up adds its line under the same heading), and a CLAUDE.md "Current status"
  line.
- **Marker removal: not done** (§3.7, §10 A1).

## 12. Hand-backs to M143c (relayed by the coordinator)

- (H1 was withdrawn with the removal design on 2026-11-23.)
- **H2 (classifier):** walk `AggregateError.errors` and call the name absent only when **every**
  member is absent. On Deno 2.9.6, `NotFound` also means SERVFAIL (C2), so a Deno SERVFAIL reads as
  absent; state it in the discovery README.
- **H3 (docs):** Deno's signalled lookup ends at about 2 s, not 1 s (C1). Timeouts from the
  resolver's own bound surface as `code: 'ETIMEOUT'` on every runtime; an attempt that ends on
  Deno's own timer is `name: 'TimedOut'`.
- **H4 (names):** OD2 A keeps M143c's constant names unchanged.
- **H5 (marker):** the kernel does not remove the marker from other responses; an application that
  sets it gets one resend of a unary call from M143c's client (§3.7). This branch's docs say only
  that a client that honours the marker may send the request again; M143c names its gRPC client
  there when the resend rule ships.
