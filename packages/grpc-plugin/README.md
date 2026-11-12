# @setu-ts/grpc-plugin

gRPC plugin for Setu-TS — enables co-serving of gRPC, Connect, and gRPC-Web protocols on the same
port as ordinary Hono routes. The plugin registers an `IGrpcService` under `CAPABILITIES.GRPC`; the
kernel resolves that service from the registry and dispatches RPC traffic itself — after the
middleware pipeline, before route matching — so gRPC rides the same auth, metrics, and shutdown
drain as every other route. No adapter seam is involved: `GrpcService.available` is unconditionally
`true`, and `Application.inject()` reaches gRPC handlers exactly as it reaches ordinary routes.

## Features

- Supports all four RPC kinds: unary, server-streaming, client-streaming, and bidi (bidi needs
  HTTP/2). Streamed responses reach the client message by message, and client- and bidi-streaming
  requests reach the procedure while the client is still sending
- Connect protocol (`application/connect+json`, `application/connect+proto`)
- gRPC-Web protocol (`application/grpc-web+json`, `application/grpc-web+proto`)
- Native gRPC (`application/grpc`, `+proto`, `+json`) on Node and Bun with
  `RuntimePlugin({ http2 })` — so `grpcurl`, `ghz` and grpc-go/grpc-java clients reach the server
  directly. Elsewhere it is refused with a Trailers-Only `UNIMPLEMENTED` — see
  [Limitations](#limitations)
- Server reflection (v1, default ON), reachable over Connect and gRPC-Web everywhere, and from stock
  `grpcurl`/`grpcui` wherever native gRPC is served
- gRPC Health v1 service bridged to M20 health plugin (default ON)
- A client for calling other services (`grpcClient`): targets resolved through service discovery per
  call, one HTTP/2 session per instance, a default deadline and trace propagation — see
  [Calling another service](#calling-another-service)
- Zero runtime dependencies in the source — Connect-ES is loaded lazily behind a structural facade
- Module loading works on Node, Deno, Bun, and Cloudflare Workers without modification

## Installation

The Connect and Protobuf-ES modules are lazy-loaded on first use. In a Setu project, `setu add grpc`
records both beside the plugin. By hand, install the plugin and both modules with the package
manager that matches your runtime:

```bash
# Deno
deno add npm:@setu-ts/grpc-plugin npm:@connectrpc/connect@^2.1.2 npm:@bufbuild/protobuf@^2.7.0
# npm
npm i @setu-ts/grpc-plugin @connectrpc/connect @bufbuild/protobuf
# Bun
bun add @setu-ts/grpc-plugin @connectrpc/connect @bufbuild/protobuf
```

A member that calls other services also needs `@connectrpc/connect-node` (the client's transport),
loaded on the first call, never by a member that only serves.

## Usage

Pass your services through the plugin's **`services` option**. Plugins register during
`app.start()`, so `CAPABILITIES.GRPC` does not exist until `start()` resolves — resolving it before
`start()` throws `No service registered for capability 'grpc'`. (`createApplication()` returns a
descriptor, not a running application; there is no `new Application()` / `app.use()` API.)

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GrpcPlugin } from '@setu-ts/grpc-plugin';
import type { GrpcServiceDefinition } from '@setu-ts/grpc-plugin';

// Your generated descriptor + implementation (illustrative stand-ins).
declare const MyServiceDefinition: GrpcServiceDefinition;
declare const myServiceImpl: Record<string, unknown>;

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    GrpcPlugin({
      services: [{ definition: MyServiceDefinition, implementation: myServiceImpl }],
    }),
  ],
});

await app.start({ port: 3000 });
```

## Calling another service

Register the plugin with `serve: false` in a member that only calls (it then claims no request and
serves no procedure, health or reflection service), name each target's mount in `clients`, and ask
for a typed client with `grpcClient()`:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GrpcPlugin, grpcClient } from '@setu-ts/grpc-plugin';

// The generated descriptor of the service billing serves (illustrative stand-in).
declare const BillingService: Parameters<typeof grpcClient>[1];

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    GrpcPlugin({ serve: false, clients: { billing: { basePath: '/grpc' } } }),
  ],
});
await app.start({ port: 3000 });

// In a handler: the same arguments return the same client, so this is a lookup.
const billing = grpcClient(app.services, BillingService, 'billing');
```

- **Target.** A service name resolves through `CAPABILITIES.SERVICE_DISCOVERY` on every call (a name
  with no discovery registered throws a `TypeError` at `grpcClient()`); an absolute `http(s)://` URL
  is used as is. A service name is letters, digits, `.`, `_` and `-` (at most 253, starting with a
  letter or digit); anything else that is not an `http(s)://` URL — a malformed URL, a path, a
  query, whitespace — throws a `TypeError` that does not repeat it, as does a URL that does not
  parse. A target carrying credentials (`http://user:secret@host`, or `user:secret@host`) throws a
  `TypeError` that does not repeat it: send credentials as call headers, never in a target, where
  every error naming the target would carry them. So does a URL target with a query or fragment,
  which Connect never sends; an error about a URL target names only its origin. A `clients` key is a
  target and is checked the same way at `GrpcPlugin()`. After each call the client reports to
  discovery — `failure` for `Unavailable` (a refused, reset or closed connection), `success`
  otherwise — so an instance that refuses connections is ejected.
- **Connections.** One HTTP/2 session per instance, shared by every call to it and closed with the
  application. Each session may buffer 64 MB (Node's `maxSessionMemory`; its default of 10 MB reset
  streams once sixteen 1 MB replies were in flight on one connection). At most 64 instance origins
  keep a session; the least recently used is forgotten first, never closed by the client — a call
  may still be on it. connect-node closes a session once it has had no stream for 60 s (its default
  is 15 minutes), so an evicted session closes 60 s after its last stream ends, and the
  application's stop closes whatever is left. A stream the application drops without cancelling it
  stays open until its deadline (or, with Connect's `timeoutMs: 0`, until the application stops).
  Each reply message is bounded by the plugin's `readMaxBytes`, as each request is.
- **Defaults.** The Connect protocol, binary, over HTTP/2, with a 5 s deadline. Per target in
  `clients`, or per client in `grpcClient()`'s options: `basePath`, `protocol` (`'connect'`,
  `'grpc'`, `'grpc-web'`), `httpVersion` (`'2'`, `'1.1'`; native gRPC needs `'2'`) and `timeoutMs`
  (1 to 2147483647). A call's own `{ timeoutMs }` still overrides. An option out of range throws a
  `TypeError` at `GrpcPlugin()` or `grpcClient()`.
- **Tracing.** With telemetry registered, each call carries the active span as `traceparent`, unless
  the call sets its own.
- **Rolling restarts.** A server shutting down refuses a call already on the wire (HTTP/2
  `REFUSED_STREAM`, never processed). The client reports that instance's failure and sends a unary
  call once more on another pick, within what is left of the call's deadline (its own, or the
  configured one). That spares most unary calls during a restart; a call whose retry is refused too
  (by the only instance, say) still fails, and a refused streaming call rejects as `Unavailable`.
  Only the refusal itself is resent — Node's stream error, connect-node's own reading of the reset
  code, or Bun's stream refused after `GOAWAY` — never an error a server sent, even one whose
  message names `REFUSED_STREAM`: that server ran its handler.
- **Caching.** The same arguments return the same client; each service definition keeps at most 256
  clients, the least recently used dropped first, so a target built from request data cannot grow
  the cache without bound.
- **Failures** reject with Connect's `ConnectError`: `Unavailable` when discovery knows no instance
  (`no instance of "billing" is available`) or the discovery backend fails
  (`could not resolve "billing"`, the backend's error as `cause`), when the connection fails, and
  after the application stops (`the gRPC client is closed`); `DeadlineExceeded` past the deadline;
  otherwise the server's code. A missing `@connectrpc/connect-node` rejects the call with
  `GrpcRuntimeLoadError`.
- **Runtimes.** Node and Bun. On Cloudflare Workers `grpcClient()` throws a `TypeError` where it is
  called: connect-node loads there, but `workerd` implements no `node:http2` client, and an HTTP/1.1
  call hangs until its deadline (measured on `workerd`). **Not on Deno yet:** Deno's own Node-style
  HTTP clients can crash the Deno process natively (`free(): invalid pointer`, a segmentation fault)
  when the server they are connected to goes away — measured with connect-node alone and no Setu
  code, so it is a Deno defect, but a Setu member on Deno would die when a member it calls restarts.

A workspace member generated with `--depends-on` a gRPC member gets this wiring from the CLI.

With `DiPlugin` and decorators, take the client by injection instead: `grpcClientProvider()` is the
same client as an `@Module` provider entry, registered under a token a class `@Inject`s (`@Inject`
names string tokens).

```typescript
import { Inject, Injectable, Module } from '@setu-ts/decorator-plugin';
import { grpcClient, grpcClientProvider } from '@setu-ts/grpc-plugin';

declare const BillingService: Parameters<typeof grpcClient>[1];

export const BILLING = 'billing.client';

@Injectable({ token: 'orders' })
@Inject(BILLING)
export class OrdersService {
  // Connect's `Client<typeof BillingService>`, as grpcClient() types it.
  constructor(private readonly billing: ReturnType<typeof grpcClient<typeof BillingService>>) {}
}

@Module({ providers: [OrdersService, grpcClientProvider(BILLING, BillingService, 'billing')] })
export class OrdersModule {}
```

## Options

The `GrpcPlugin` accepts optional configuration:

- `basePath`: Base path under which gRPC services are served (defaults to `/` — the root, so a
  client pointed at `http://host:3000` reaches its procedures without a path prefix). Detection is
  still segment-aware: with the default, `/grpcfoo` and other prefix-adjacent routes stay yours.
- `reflection`: Whether to enable server reflection (defaults to `true`)
- `health`: Whether to enable gRPC Health v1 service (defaults to `true`)
- `services`: Initial services to register at startup
- `connectModule`: Injected Connect runtime module (for testing)
- `interceptors`: Application Connect interceptors, forwarded to Connect router construction
  (`createConnectRouter({ interceptors })`). Composed after the built-in handler-error logging, so a
  handler throw is logged before an application interceptor observes it. Absent: none installed
  (defaults to `[]`)
- `serve`: Whether the plugin serves gRPC (defaults to `true`). `false` registers it for calling
  only: no request is claimed and no procedure, health or reflection service is served; `services`
  must then be empty. Not a boolean → `TypeError` at `GrpcPlugin()`
- `clients`: Per-target client defaults, keyed by the target passed to `grpcClient()` — see
  [Calling another service](#calling-another-service)
- `readMaxBytes`: The largest request message a procedure accepts, and the largest reply message
  this plugin's clients accept, in bytes (defaults to 4 MiB, the receive limit grpc-go and grpc-js
  default to; connect-node's own client default is 4 GiB). Connect applies it per message on gRPC,
  gRPC-Web and Connect streaming, and to the whole body of a unary Connect request; a larger message
  is refused with `RESOURCE_EXHAUSTED`. It is the bound on a streamed request:
  `RuntimePlugin({ maxBodyBytes })` is a total, so it bounds only the buffered bodies of unary and
  server-streaming calls. An integer from 1 to `4294967295`; anything else throws at `GrpcPlugin()`

```typescript
GrpcPlugin({
  basePath: '/my-grpc',
  reflection: true,
  health: true,
  services: [{ definition: MyServiceDescriptor, implementation: MyServiceImpl }],
  interceptors: [myInterceptor],
});
```

## Reflection and Health

Reflection (`grpc.reflection.v1.ServerReflection`, default ON) answers `list_services`,
`file_by_filename`, `file_containing_symbol` and `all_extension_numbers_of_type`. Symbols resolve
for services, their methods, messages, nested types, enums and extensions — of the plugin's own two
protos AND of every registered application service's `DescFile` plus its transitive `dependencies`.
Nothing else is exposed. `file_containing_extension` answers `UNIMPLEMENTED` (the framework
registers no extensions); an unknown filename, symbol or type answers `NOT_FOUND`. Set
`reflection: false` to register nothing.

Health (`grpc.health.v1.Health`, default ON) implements `Check` only, resolving
`CAPABILITIES.HEALTH` optionally — absent, it answers `SERVING`. An empty `service` field means "the
whole server" and returns the mapped readiness aggregate: `up → SERVING`, `down → NOT_SERVING`, and
`degraded → NOT_SERVING`. Since **M119b** the bridge reads the readiness report (`checkReady()`), so
it agrees with the health plugin's `/ready`: an indicator that counts toward `/health` but not
`/ready` (the `mail` indicator, by default) does not turn the server `NOT_SERVING`. `degraded` still
maps to `NOT_SERVING` because the health plugin already withdraws a degraded replica from its
Service (503) — reporting `SERVING` here would leave the two health faces of one process
disagreeing, with gRPC clients load-balancing onto a replica HTTP has taken out of rotation. A
`service` naming something this server does not serve answers `SERVICE_UNKNOWN`. `List` and `Watch`
are left to Connect's automatic `unimplemented` responder.

## Errors

| Error                  | Thrown when                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GrpcRuntimeLoadError` | A Connect/Protobuf-ES specifier cannot be imported at registration, or `@connectrpc/connect-node` on a client's first call                                                                                         |
| `GrpcDescriptorError`  | An embedded descriptor set cannot be decoded or lacks its expected service                                                                                                                                         |
| `GrpcUnavailableError` | **Deprecated — never thrown since M70a.** Retained as published surface only; gRPC dispatch no longer depends on any adapter capability, so `handleRequest` is always serviceable and `available` is always `true` |

## Limitations

- **Detection is prefix-only.** A request is RPC when its path starts with `basePath`. Content-type
  sniffing is deliberately NOT used: Connect's real unary content types include `application/json`
  and `application/proto`, so matching them would hijack ordinary application routes. Point your
  client's base URL at `basePath`. Paths outside it — including prefix-adjacent ones like `/grpcfoo`
  — fall through to Hono untouched.

- **What each runtime serves** (since `0.13.0`):

  | Runtime and listener                                             | Connect, gRPC-Web | Server streams as sent | Client and bidi streaming                                    | Native gRPC, reflection via `grpcurl`      |
  | ---------------------------------------------------------------- | ----------------- | ---------------------- | ------------------------------------------------------------ | ------------------------------------------ |
  | Node, default (HTTP/1.1)                                         | yes               | yes                    | client yes, bidi no                                          | refused                                    |
  | Node, `RuntimePlugin({ http2: true })`                           | yes, h1 and h2c   | yes                    | yes over HTTP/2                                              | yes over HTTP/2                            |
  | Node, `RuntimePlugin({ http2: { key, cert } })`                  | yes, h1 and h2    | yes                    | yes over HTTP/2                                              | yes over HTTP/2                            |
  | Bun, default (`Bun.serve`)                                       | yes               | yes                    | client yes, bidi no                                          | refused                                    |
  | Bun with `http2` (served by `node:http2`)                        | as Node           | yes                    | as Node                                                      | as Node                                    |
  | Deno (`Deno.serve`, h1 and h2c; TLS with `http2: { key, cert }`) | yes               | yes                    | yes over HTTP/2                                              | refused — `Deno.serve` writes no trailers  |
  | Cloudflare Workers                                               | yes               | yes                    | client yes; bidi half-duplex only (full duplex not verified) | refused — no trailers on a Worker response |

  Native gRPC reports each call's status in HTTP/2 trailers, so it is served only where the adapter
  can write them: the Node adapter on an HTTP/2 connection (`IRequest.responseTrailers`). On the
  shared cleartext port, an HTTP/1.1 request for a native procedure is still refused, since a native
  client never speaks HTTP/1.1. Bidi needs a full-duplex transport: over HTTP/1.1 Connect's own bidi
  check is left unset (the adapter reports no negotiated version), so a bidi call there fails at the
  transport rather than with a clean `505`.

- **Request bodies.** A unary or server-streaming call's single request message is buffered under
  `RuntimePlugin({ maxBodyBytes })`. A client- or bidi-streaming call gets the unread body stream,
  bounded per message by `readMaxBytes` — unless middleware already read the body, in which case it
  is dispatched from that read.

- **Timing and `inject()`.** A streamed reply leaves the pipeline at its first byte, so the request
  logger, metrics and the telemetry span time a streaming RPC to its first message, as they do SSE;
  time a whole call in a Connect interceptor (`interceptors`). `Application.inject()` reaches unary
  and client-streaming procedures, whose replies are buffered; a server-streaming or bidi reply is a
  stream, which `inject()` refuses — use `app.fetch()` with a web `Request` and read the body.
- **Clients on Workers and Deno**: on Workers `grpcClient()` refuses with a `TypeError`; call
  another service with Connect's own `@connectrpc/connect-web` transport, or a service binding. On
  Deno the client is not safe to use until Deno's `node:http2` client stops crashing when its peer
  goes away (see [Calling another service](#calling-another-service)).

<!-- version:history -->

- **Native gRPC before `0.13.0`** was refused on every runtime, because the kernel wrote replies
  through a fetch `Response`, which carries no trailers, and Node served HTTP/1.1 only. Where it is
  still refused (see the table above), the answer is a **Trailers-Only `UNIMPLEMENTED`** — HTTP
  `200`, `content-type: application/grpc`, `grpc-status: 12` in the headers — decided from the
  request headers before the body is read, so a half-open native stream gets it without hanging.
  There, use Connect or gRPC-Web (`buf curl --protocol connect` or `--protocol grpcweb`, a generated
  Connect client, or Envoy's `grpc_web` filter in front of a native fleet); `grpcurl` implements
  native gRPC only.

## Health Indicator

The plugin registers a health indicator named `'grpc'` whose `data` reports:

- `available`: whether gRPC dispatch is available — unconditionally `true` since M70a, because the
  kernel resolves `IGrpcService` from the service registry and dispatches after the middleware
  pipeline; the previous adapter-based seam (and the `GrpcUnavailableError` that guarded it) is
  retired
- `serviceCount`: how many application services are registered

## Development

To regenerate embedded descriptor constants (when upgrading protos):

```bash
# From grpc/grpc-proto at the desired commit
protoc -Iproto --include_imports \
  --descriptor_set_out=health.binpb proto/grpc/health/v1/health.proto
protoc -Iproto --include_imports \
  --descriptor_set_out=reflection.binpb proto/grpc/reflection/v1/reflection.proto

base64 -w0 < health.binpb      # 1168 chars
base64 -w0 < reflection.binpb  # 2332 chars
```

## See Also

- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#api-reference-setu-tsgrpc-plugin)
  — the `grpc-plugin` Options / Exports / Notes section
- [ARCHITECTURE.md](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md) — §7 the
  `IHttpAdapter` seam, §18 why the plugin does not hang off the kernel
- [ROADMAP.md](https://github.com/setu-ts/setu-ts/blob/main/ROADMAP.md) — Milestone 49

## Exports

| Export                  | Kind      |
| ----------------------- | --------- |
| `adaptConnectModule`    | function  |
| `grpcClient`            | function  |
| `grpcClientProvider`    | function  |
| `GrpcPlugin`            | function  |
| `GrpcDescriptorError`   | class     |
| `GrpcRuntimeLoadError`  | class     |
| `GrpcService`           | class     |
| `GrpcUnavailableError`  | class     |
| `CAPABILITIES`          | const     |
| `ConnectModuleLike`     | interface |
| `GrpcClientOptions`     | interface |
| `GrpcPluginOptions`     | interface |
| `GrpcServiceDefinition` | interface |
| `IGrpcService`          | interface |
| `GrpcServingStatus`     | type      |
| `RpcFetchHandler`       | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.
