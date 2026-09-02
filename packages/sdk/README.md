# @setu-ts/sdk

Portable, zero-npm-dependency client SDK for consuming Setu-TS APIs from browsers and servers.
Provides an injectable `fetch` HTTP client, bearer and API-key authentication interceptors,
per-origin retry with backoff, circuit breaker, and sliding-window rate limiting, plus a pure
generator that turns OpenAPI 3.1 documents into type-checked TypeScript client source.

This package does **not** register a plugin or resolve capability tokens. It is an external-consumer
library with no dependency on `kernel`, `runtime`, or any plugin — its only in-repo import is
type-level from `@setu-ts/common`.

## Realtime clients

`createSseClient` consumes an SSE endpoint through `fetch` on every supported runtime. It sends
configured headers on every reconnect, ignores comment-frame heartbeats, parses JSON events, applies
server `retry:` delays, and sends `Last-Event-ID` after an identified event. It does not delegate to
`EventSource`, so bearer authentication works equally in browsers and server runtimes.

```typescript
import { createSseClient } from '@setu-ts/sdk';

const events = createSseClient({
  url: 'https://api.example.com/sse/scores',
  headers: { Authorization: 'Bearer token' },
  onEvent: ({ event, data }) => console.log(event, data),
});
// later: events.close()
```

`createRealtimeClient` wraps the global WebSocket with the server's application-level keep-alive
contract. It filters the heartbeat payload (`'ping'` by default), replies to keep the server's
inbound-idle timer fresh, reconnects with backoff, and re-applies the configured room query value.

```typescript
import { createRealtimeClient } from '@setu-ts/sdk';

const board = createRealtimeClient({
  url: 'wss://api.example.com/ws/board',
  room: 'game-7',
  onMessage: ({ data }) => console.log(data),
});
```

## Installation

```bash
# Deno
deno add jsr:@setu-ts/sdk@^0.2.0

# npm / pnpm / yarn
npx jsr add @setu-ts/sdk@^0.2.0

# Bun
bunx jsr add @setu-ts/sdk@^0.2.0
```

## Quick Start

```typescript
import { createBearerAuthInterceptor, createClient } from '@setu-ts/sdk';

const client = createClient({
  baseUrl: 'https://api.example.com',
  requestInterceptors: [
    createBearerAuthInterceptor('my-token'),
  ],
  retry: {
    limit: 3,
    delay: 500,
    backoff: 'exponential',
  },
});

const res = await client.request<User>({
  method: 'GET',
  path: 'users/123',
});

console.log(res.data); // User
```

## Options

`createClient(options)` takes:

| Option                 | Type                          | Default                                 | Description                                       |
| ---------------------- | ----------------------------- | --------------------------------------- | ------------------------------------------------- |
| `baseUrl`              | `string`                      | —                                       | Base URL for every request. Required.             |
| `headers`              | `HeadersInit`                 | —                                       | Headers merged into every request.                |
| `fetch`                | `typeof fetch`                | global `fetch`                          | Injected transport.                               |
| `timing`               | `IClientTiming`               | `performance.now()` + abort-aware sleep | Clock and sleep seam, so tests need no real time. |
| `retry`                | `RetryPolicy`                 | off                                     | Retry with fixed or exponential backoff.          |
| `circuitBreaker`       | `CircuitBreakerPolicy`        | off                                     | Rolling-window breaker.                           |
| `rateLimit`            | `ClientRateLimitPolicy`       | off                                     | Sliding-window limiter.                           |
| `requestInterceptors`  | `ClientRequestInterceptor[]`  | `[]`                                    | Run in order before the request.                  |
| `responseInterceptors` | `ClientResponseInterceptor[]` | `[]`                                    | Run in order after the response.                  |

`fetch` and `timing` are the two seams that keep the client testable without a network or real time
— `Date.now()` appears nowhere in this package. See [Resilience](#resilience) for the three policy
shapes and [Authentication](#authentication) for the bundled interceptors.

The `fetch` default needs no browser-specific value: it resolves `globalThis.fetch` **at call
time**, with the global as its receiver, so the default transport works in a browser unchanged. (An
injected `fetch` is always used as-is, which is what tests rely on.)

## HTTP Client

`createClient(options)` returns an `IHttpClient` whose single method is
`request<TResponse, TBody>(request: ClientRequest<TBody>): Promise<ClientResponse<TResponse>>`.

### ClientOptions

| Option                 | Type                          | Description                                                                 |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `baseUrl`              | `string` (required)           | Base URL for every request                                                  |
| `headers`              | `Record<string, string>`      | Default headers cloned into each request                                    |
| `fetch`                | `Function`                    | Injectable fetch seam (default bound to the global realm)                   |
| `timing`               | `IClientTiming`               | Injectable timing seam (defaults to `createDefaultClientTiming()`)          |
| `retry`                | `RetryPolicy`                 | Retry policy (retries transport failures + 408/425/429/5xx on safe methods) |
| `circuitBreaker`       | `CircuitBreakerPolicy`        | Per-origin circuit breaker policy                                           |
| `rateLimit`            | `ClientRateLimitPolicy`       | Per-origin sliding-window rate limiter                                      |
| `requestInterceptors`  | `ClientRequestInterceptor[]`  | Run once before resilient execution                                         |
| `responseInterceptors` | `ClientResponseInterceptor[]` | Run after successful parse; skipped on failure                              |

### Request

```typescript
interface ClientRequest<TBody = never> {
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  json?: TBody;
  signal?: AbortSignal;
}
```

- `path` must be relative. A leading slash, a scheme-relative `//host/x`, and a fully absolute
  `https://host/x` are all rejected — otherwise a request could leave `baseUrl`'s origin and bypass
  the per-origin circuit breaker and rate limiter.
- Query values are encoded; arrays repeat the key.
- `json` is serialized with `JSON.stringify`; `Content-Type: application/json` is set automatically.
- `signal` aborts fetches, queued waits, and retry attempts.

### Response

```typescript
interface ClientResponse<T> {
  status: number;
  headers: Headers;
  data?: T;
}
```

- `data` is parsed when the response `Content-Type` names JSON: `application/json` or any structured
  `+json` suffix (`application/problem+json`, `application/vnd.api+json`). Media-type parameters and
  casing are ignored.
- `data` is `undefined` for `204`, for an empty body, and for a non-JSON content type.
- Non-2xx responses throw `HttpClientError` rather than resolving.

## Authentication

### Bearer Token

```typescript
import { createBearerAuthInterceptor } from '@setu-ts/sdk';

const client = createClient({
  baseUrl: 'https://api.example.com',
  requestInterceptors: [
    // Literal token
    createBearerAuthInterceptor('my-token'),
    // Or async provider
    createBearerAuthInterceptor(() => tokenStore.get()),
  ],
});
```

### API Key

```typescript
import { createApiKeyAuthInterceptor } from '@setu-ts/sdk';

const client = createClient({
  baseUrl: 'https://api.example.com',
  requestInterceptors: [
    // Default header: X-API-Key
    createApiKeyAuthInterceptor('my-key'),
    // Custom header
    createApiKeyAuthInterceptor('my-key', 'Authorization'),
  ],
});
```

Both factories accept a literal string or an async value provider. The header is only set when the
request has not already supplied that header.

## Resilience

### Retry

```typescript
import { BackoffStrategy } from '@setu-ts/sdk';

const client = createClient({
  baseUrl: 'https://api.example.com',
  retry: {
    limit: 3, // total attempts
    delay: 500, // base delay in ms
    backoff: 'exponential' as BackoffStrategy,
  },
});
```

Retries transport rejections and statuses 408, 425, 429, 500-599. Only retries safe methods (GET,
HEAD, OPTIONS, PUT, DELETE). When a retryable response carries a `Retry-After` header with
delta-seconds, that delay replaces the computed backoff.

### Circuit Breaker

```typescript
const client = createClient({
  baseUrl: 'https://api.example.com',
  circuitBreaker: {
    threshold: 5,
    timeout: 30_000,
    resetTimeout: 10_000,
  },
});
```

Per-origin rolling-window circuit breaker. An open circuit throws `ClientCircuitOpenError` before
consuming a rate-limit slot. The breaker counts one failure per exhausted transient sequence (not
one per retry attempt).

The two windows are independent:

- `timeout` is the rolling window used to decide when the circuit **trips** — `threshold` counted
  failures inside it open the circuit.
- `resetTimeout` is how long the circuit **stays open**, measured from the moment it tripped. It is
  not shortened by `timeout` elapsing, so `timeout` may safely be shorter than `resetTimeout`.

After `resetTimeout` elapses, exactly one half-open probe is admitted; concurrent callers get
`ClientCircuitOpenError`. A successful probe closes the circuit and clears the window. A **failed**
probe reopens it and restarts `resetTimeout`, so a dead dependency is probed once per cooldown
rather than on every request.

What counts as a failure: a 5xx response, a transport rejection, or an exhausted retry sequence. A
4xx `HttpClientError` does **not** — a bad request means the caller was wrong, not that the origin
is unhealthy — and neither does a caller abort.

### Rate Limiting

```typescript
const client = createClient({
  baseUrl: 'https://api.example.com',
  rateLimit: {
    maxRequests: 100,
    windowMs: 60_000,
  },
});
```

Per-origin sliding-window limiter. When the window is full, the client waits until the oldest
retained timestamp expires.

## Interceptors

### Request Interceptors

```typescript
import { ClientRequestContext, ClientRequestInterceptor } from '@setu-ts/sdk';

const loggingInterceptor: ClientRequestInterceptor = (ctx: ClientRequestContext) => {
  console.log(`${ctx.url.method} ${ctx.url.href}`);
};

const client = createClient({
  baseUrl: 'https://api.example.com',
  requestInterceptors: [loggingInterceptor],
});
```

Request interceptors receive a mutable `ClientRequestContext` (resolved `URL` and `Headers`) and
execute once in registration order before the outbound attempt sequence.

### Response Interceptors

```typescript
import { ClientResponse, ClientResponseInterceptor } from '@setu-ts/sdk';

const timingInterceptor: ClientResponseInterceptor<unknown> = (
  response: ClientResponse<unknown>,
  request: { method: string; path: string },
) => {
  console.log(`${request.method} ${request.path} → ${response.status}`);
  return response;
};
```

Response interceptors receive a successful `ClientResponse<T>` and its immutable request
description. They are skipped entirely when the request throws.

## OpenAPI Code Generation

`generateOpenApiClient(document, options?)` is a pure function that turns an OpenAPI 3.1 document
into TypeScript source.

```typescript
import { generateOpenApiClient } from '@setu-ts/sdk';
import { readFileSync } from 'node:fs';

const document = JSON.parse(readFileSync('openapi.json', 'utf-8'));

const source = generateOpenApiClient(document, {
  sdkImport: '@setu-ts/sdk',
  factoryName: 'createApi',
  apiTypeName: 'Api',
});

// Write `source` to a file, then import the generated factory:
// import { createApi } from './generated-api.js';
// const api = createApi(client);
```

The generated factory accepts an `IHttpClient` and returns typed operation methods. Schema mapping
covers the M21 vocabulary: primitives, arrays, objects with `required`, `$ref`, `enum`, `const`,
`anyOf`, `allOf`, `additionalProperties`, `null`, and `integer`.

**The output is publishable, formatted and lint-clean.** `createApi` has a written-out return type
(`export interface Api`), so JSR does not reject the file as a slow type; the source round-trips
through `deno fmt` unchanged and needs no lint pragma. Both properties are load-bearing rather than
cosmetic: the generated file's own header says "Do not edit manually", so a consumer who cannot
publish or format it has nowhere to go.

### Generated names and shapes

- **Operation methods are lower-camelCase and preserve interior casing.** An `operationId` is split
  on every run of non-alphanumeric characters and re-joined, so `listUsers` stays `listUsers` and
  `get-users-{id}` becomes `getUsersId`. A leading digit run is prefixed with `n`, a reserved word
  is prefixed with `_`, and an id that sanitizes to nothing becomes `operation`.
- **Component schemas and argument interfaces are PascalCase.** Component `User` emits
  `export type User`, and operation `listUsers` emits `export interface ListUsersArgs`.
- **The factory returns a named interface.** `export interface Api { … }` lists every operation's
  signature and is the factory's return type; rename it with `apiTypeName`.
- **Two names that derive onto one identifier throw** `OpenApiCodegenError` rather than emitting a
  file with a duplicate declaration, and the diagnostic names both originals. Component schemas,
  `*Args` interfaces, `*Error` unions, `*Error<status>Body` aliases and the client interface all
  draw from ONE registry, so a component named `ListUsersArgs` beside an operation `listUsers` is
  refused rather than silently emitting two declarations of one name.
- **Declared error responses are typed.** An operation declaring a non-2xx response also emits a
  union discriminated on the literal `status` and a narrowing guard:

  ```typescript
  try {
    await api.getUserById('1');
  } catch (e) {
    if (isGetUserByIdError(e) && e.status === 404) {
      e.body.code; // typed by the document's 404 schema
    }
  }
  ```

  `HttpClientError` is generic in its body (`HttpClientError<TBody = unknown>`), so the bare name
  means what it always did. The union is discriminated on `status` because
  `HttpClientError<A> | HttpClientError<B>` is not — `status` is `number` on both arms. A `default`
  response and range codes such as `4XX` are skipped: they name no single status.
- **Formatting matches `deno fmt`.** Two-space indentation, a signature past 100 columns wrapped one
  parameter per line, and a path template too long for one line emitted as an equivalent
  `[…].join('')` — a template literal is not usable there, because `deno fmt` rewraps a long one at
  whichever `${` happens to fit, which no generator can predict.
- **No multi-line type is written at a use site.** An inline (non-`$ref`) body, parameter or success
  response is hoisted into an exported alias. A rendered type lands at several indentation levels,
  and a success type lands at two at once — the client interface's signature and the
  `client.request<…>` type argument — so no single indentation is correct for a multi-line object
  literal and `deno fmt` reindents whatever is emitted. A schema that `@setu-ts/openapi-plugin`
  derived from `validateBody` and used once arrives inline, so this is the ordinary case.
- **No lint pragma.** An empty-object schema emits `Record<PropertyKey, never>` rather than `{}`,
  which is both what the schema means and what `deno lint`'s `ban-types` accepts. A narrowed pragma
  could not be emitted unconditionally either: an ignore matching nothing is itself reported as
  `ban-unused-ignore`.
- **Path parameters are positional arguments; everything else lives in `opts`.** Each path
  placeholder is substituted and percent-encoded, including a placeholder that shares a segment with
  literal text (`/files/{id}.json`).
- **`opts` is required when any of its fields is required.** A required query parameter or a
  `requestBody` marked `required` makes the `opts` parameter itself required, so a caller cannot
  omit it and silently skip a mandatory value.
- **Wire names are preserved.** The query key and header name sent on the wire are the original
  OpenAPI names (`user_id`, `X-API-Key`); only the TypeScript field identifier is derived. Header
  values are stringified, so a non-`string` header schema still compiles.
- **All eight operation slots are generated**, including `trace`. Parameters declared at the
  path-item level are merged into every operation on that path; an operation's own parameter
  overrides a shared one with the same `name` and `in`.
- **Document text can never escape into code.** Text emitted into a comment (the `operationId` on
  each generated method) has comment terminators escaped and line breaks collapsed, and every
  emitted string literal and path template is escaped for its own context.

### Codegen diagnostics

`generateOpenApiClient` throws `OpenApiCodegenError` — carrying `path` and `method` where they apply
— rather than emitting a client that misbehaves or does not compile:

| Condition                                                        | Why it is rejected                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| Missing `operationId`                                            | No name to derive a method from                              |
| Two operations deriving onto one method name                     | Duplicate declaration; both originals are named              |
| Two emitted TYPE names colliding                                 | Duplicate declaration; one registry covers all four families |
| Parameter with `in: 'cookie'`                                    | Unsupported location                                         |
| Path placeholder with no matching `in: 'path'` parameter         | Emitted source would reference an undeclared argument        |
| `in: 'path'` parameter absent from the path template             | The caller's value would be silently dropped                 |
| Two placeholders in one template deriving onto one argument name | Duplicate parameter in the emitted signature                 |
| Malformed local `$ref`                                           | No component name to resolve                                 |

## Errors

| Error                    | When thrown                                                 |
| ------------------------ | ----------------------------------------------------------- |
| `HttpClientError`        | Non-2xx HTTP response (carries `status`, `headers`, `body`) |
| `ClientCircuitOpenError` | Circuit breaker is open for the request origin              |
| `OpenApiCodegenError`    | Invalid OpenAPI document during code generation             |

## Public Surface

| Export                        | Kind        | Description                              |
| ----------------------------- | ----------- | ---------------------------------------- |
| `createClient`                | factory     | Creates an `IHttpClient` instance        |
| `IHttpClient`                 | interface   | Client contract (`request<T>()`)         |
| `ClientOptions`               | interface   | Factory options                          |
| `ClientRequest`               | type        | Outbound request description             |
| `ClientResponse`              | type        | Parsed response                          |
| `ClientRequestContext`        | type        | Mutable context for request interceptors |
| `ClientRequestInterceptor`    | type        | Request interceptor signature            |
| `ClientResponseInterceptor`   | type        | Response interceptor signature           |
| `IClientTiming`               | interface   | Timing seam (`now()`, `sleep()`)         |
| `createDefaultClientTiming`   | factory     | Default timing over `performance.now()`  |
| `ClientRateLimitPolicy`       | type        | Sliding-window rate limiter config       |
| `RetryPolicy`                 | re-export   | From `@setu-ts/common`                   |
| `CircuitBreakerPolicy`        | re-export   | From `@setu-ts/common`                   |
| `BackoffStrategy`             | re-export   | From `@setu-ts/common`                   |
| `createBearerAuthInterceptor` | factory     | Bearer-token request interceptor         |
| `createApiKeyAuthInterceptor` | factory     | API-key request interceptor              |
| `HttpClientError`             | error class | Failed non-2xx response                  |
| `ClientCircuitOpenError`      | error class | Fail-fast circuit state                  |
| `OpenApiCodegenError`         | error class | Invalid-spec diagnostic                  |
| `generateOpenApiClient`       | function    | Pure OpenAPI → TypeScript generator      |
| `OpenApiCodegenOptions`       | type        | Generator options                        |
| `SdkOpenApi*`                 | types       | Structural OpenAPI 3.1 subset            |

## Portability

- **Zero npm dependencies** — uses only web-standard APIs (`URL`, `Headers`, `AbortSignal`,
  `performance.now()`).
- **Browser and server** — runs in browsers, Node.js, Deno, Bun, and Cloudflare Workers. The default
  transport needs no browser-specific value: it resolves `globalThis.fetch` at call time with the
  global as its receiver, so the default works in a browser unchanged.
- **Injectable `fetch`** — tests inject a fake; the default is bound to the global realm.
- **Injectable timing** — `IClientTiming` makes backoff, breaker windows, and rate-limit waits
  testable without real time.

---

[Architecture](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md) ·
[Public API](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#sdk--client-sdk-setu-tssdk)
· [Roadmap](https://github.com/setu-ts/setu-ts/blob/main/ROADMAP.md)

## Exports

| Export                        | Kind      |
| ----------------------------- | --------- |
| `createApiKeyAuthInterceptor` | function  |
| `createBearerAuthInterceptor` | function  |
| `createClient`                | function  |
| `createDefaultClientTiming`   | function  |
| `createRealtimeClient`        | function  |
| `createSseClient`             | function  |
| `generateOpenApiClient`       | function  |
| `ClientCircuitOpenError`      | class     |
| `HttpClientError`             | class     |
| `OpenApiCodegenError`         | class     |
| `CircuitBreakerPolicy`        | interface |
| `ClientOptions`               | interface |
| `ClientRateLimitPolicy`       | interface |
| `ClientRequest`               | interface |
| `ClientRequestContext`        | interface |
| `ClientResponse`              | interface |
| `IClientTiming`               | interface |
| `IHttpClient`                 | interface |
| `IRealtimeClient`             | interface |
| `ISseClient`                  | interface |
| `IWebSocketTransport`         | interface |
| `OpenApiCodegenOptions`       | interface |
| `RawSseEvent`                 | interface |
| `RealtimeClientOptions`       | interface |
| `RealtimeMessage`             | interface |
| `RealtimeReconnectOptions`    | interface |
| `RetryPolicy`                 | interface |
| `SdkOpenApiDocument`          | interface |
| `SdkOpenApiOperation`         | interface |
| `SdkOpenApiParameter`         | interface |
| `SdkOpenApiPathItem`          | interface |
| `SdkOpenApiRequestBody`       | interface |
| `SdkOpenApiResponse`          | interface |
| `SdkOpenApiSchema`            | interface |
| `SseClientOptions`            | interface |
| `SseEvent`                    | interface |
| `SseReconnectOptions`         | interface |
| `BackoffStrategy`             | type      |
| `ClientRequestInterceptor`    | type      |
| `ClientResponseInterceptor`   | type      |
| `RealtimeClientState`         | type      |
| `SseClientState`              | type      |
| `SseEventMap`                 | type      |
| `WebSocketFactory`            | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.
