# @setu-ts/sdk — portable HTTP, SSE and WebSocket client

`setu add sdk` adds the dependency; nothing is registered. Construct clients at the edge of an
application or in a browser bundle, not inside a plugin.

```ts
import { createBearerAuthInterceptor, createClient } from '@setu-ts/sdk';

export async function fetchUsers(token: string) {
  const client = createClient({
    baseUrl: 'https://api.example.com',
    headers: { accept: 'application/json' },
    retry: { limit: 3, delay: 100, backoff: 'exponential' },
    requestInterceptors: [createBearerAuthInterceptor(async () => token)],
  });
  return await client.request<{ id: string }[]>({ method: 'GET', path: '/users' });
}
```

```ts
import { createSseClient } from '@setu-ts/sdk';

export function subscribe(url: string) {
  const client = createSseClient({ url, onEvent: (event) => console.log(event.data) });
  client.close();
}
```

- `ClientOptions.baseUrl` is required. Inject `fetch` and `timing` seams in tests; otherwise global
  fetch and `createDefaultClientTiming()` are used.
- `retry` is a `ClientRetryPolicy`: `limit`, `delay`, `backoff` and optional `maxRetryAfterMs`.
  Invalid counts, delays or backoffs throw at construction, as do `circuitBreaker.threshold < 1` and
  a non-positive rate-limit `maxRequests` or `windowMs`.
- `client.request<T>({ method, path })` resolves `ClientResponse<T>` with `status`, `headers` and
  `data`; `data` is undefined for 204 or an empty body. Non-2xx throws `HttpClientError`; an open
  circuit throws `ClientCircuitOpenError`.
- A per-request `idempotencyKey` (1–255 printable characters) makes any method retryable, including
  on 409. The `idempotency` option generates one key per request and reuses it across retries.
- Request interceptors run once before retries. `createBearerAuthInterceptor` takes a static token
  or async provider and leaves an existing authorization header alone; `createApiKeyAuthInterceptor`
  defaults to the X-API-Key header.
- `createSseClient({ url, onEvent })` reconnects until `client.close()` or an abort signal;
  `createRealtimeClient` covers WebSocket. `generateOpenApiClient` and `OperationRequestOptions`
  (`idempotencyKey`, `signal`) are the generated-code seams.
