# @hono-enterprise/sdk

Portable, zero-npm-dependency client SDK for consuming Hono Enterprise APIs from browsers and
servers. Provides an injectable `fetch` HTTP client, bearer and API-key authentication interceptors,
per-origin retry with backoff, circuit breaker, and sliding-window rate limiting, plus a pure
generator that turns OpenAPI 3.1 documents into type-checked TypeScript client source.

This package does **not** register a plugin or resolve capability tokens. It is an external-consumer
library with no dependency on `kernel`, `runtime`, or any plugin — its only in-repo import is
type-level from `@hono-enterprise/common`.

## Installation

```bash
# Deno
deno add jsr:@hono-enterprise/sdk@^0.1.0-alpha.2

# npm / pnpm / yarn
npx jsr add @hono-enterprise/sdk@^0.1.0-alpha.2

# Bun
bunx jsr add @hono-enterprise/sdk@^0.1.0-alpha.2
```

## Quick Start

```typescript
import { createBearerAuthInterceptor, createClient } from '@hono-enterprise/sdk';

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

## HTTP Client

`createClient(options)` returns an `IHttpClient` whose single method is
`request<TResponse, TBody>(request: ClientRequest<TBody>): Promise<ClientResponse<TResponse>>`.

### ClientOptions

| Option                 | Type                          | Description                                                                 |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `baseUrl`              | `string` (required)           | Base URL for every request                                                  |
| `headers`              | `Record<string, string>`      | Default headers cloned into each request                                    |
| `fetch`                | `Function`                    | Injectable fetch seam (defaults to global `fetch`)                          |
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

- `path` must be relative (absolute paths are rejected).
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

Successful JSON responses are parsed; a 204 or empty body yields `undefined` as `T`. Non-2xx
responses throw `HttpClientError`.

## Authentication

### Bearer Token

```typescript
import { createBearerAuthInterceptor } from '@hono-enterprise/sdk';

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
import { createApiKeyAuthInterceptor } from '@hono-enterprise/sdk';

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
import { BackoffStrategy } from '@hono-enterprise/sdk';

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
import { ClientRequestContext, ClientRequestInterceptor } from '@hono-enterprise/sdk';

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
import { ClientResponse, ClientResponseInterceptor } from '@hono-enterprise/sdk';

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
import { generateOpenApiClient } from '@hono-enterprise/sdk';
import { readFileSync } from 'node:fs';

const document = JSON.parse(readFileSync('openapi.json', 'utf-8'));

const source = generateOpenApiClient(document, {
  sdkImport: '@hono-enterprise/sdk',
  factoryName: 'createApi',
});

// Write `source` to a file, then import the generated factory:
// import { createApi } from './generated-api.js';
// const api = createApi(client);
```

The generated factory accepts an `IHttpClient` and returns typed operation methods. Schema mapping
covers the M21 vocabulary: primitives, arrays, objects with `required`, `$ref`, `enum`, `const`,
`anyOf`, `allOf`, `additionalProperties`, `null`, and `integer`.

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
| `RetryPolicy`                 | re-export   | From `@hono-enterprise/common`           |
| `CircuitBreakerPolicy`        | re-export   | From `@hono-enterprise/common`           |
| `BackoffStrategy`             | re-export   | From `@hono-enterprise/common`           |
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
- **Browser and server** — runs in Node.js, Deno, Bun, Cloudflare Workers, and browsers.
- **Injectable `fetch`** — tests inject a fake; production defaults to the global.
- **Injectable timing** — `IClientTiming` makes backoff, breaker windows, and rate-limit waits
  testable without real time.

---

[Architecture](../../ARCHITECTURE.md) · [Public API](../../PUBLIC_API.md) ·
[Roadmap](../../ROADMAP.md)
