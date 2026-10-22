# @setu-ts/sdk — HTTP and realtime API clients

**Add it:** `setu add sdk` adds the dependency. Construct a client in application code; there is no
plugin registration or provided capability.

## Fetch JSON with retries

```ts
import { createClient } from "@setu-ts/sdk";

const client = createClient({
  baseUrl: "https://api.example.com",
  retry: { limit: 3, delay: 100, backoff: "exponential" },
});
const response = await client.request<{ id: string }[]>({ method: "GET", path: "/users" });
console.log(response.data);
```

## Subscribe to server-sent updates

Keep the returned client and close it when the subscription is no longer needed:

```ts
import { createSseClient } from "@setu-ts/sdk";
import type { ISseClient } from "@setu-ts/sdk";

export function watchUpdates(signal: AbortSignal): ISseClient {
  return createSseClient({
    url: "https://api.example.com/events",
    signal,
    onEvent: (event) => { console.log(event.data); },
  });
}
```

## Behaviour the types do not show

- `request` returns status, headers and parsed JSON data; data is `undefined` for `204` or an empty
  body. Non-2xx responses throw `HttpClientError`.
- `retry.limit` counts total attempts, not extra retries; `delay` is milliseconds. Request
  interceptors run once before retries, in registration order.
- A per-request `idempotencyKey` enables retries on any method and on `409`; client `idempotency`
  generates one key per request and reuses it across attempts.
- The bearer interceptor leaves an existing authorization header alone.
- SSE payloads default to JSON parsing. Reconnects are unlimited unless bounded by `maxAttempts`;
  `client.close()` or the abort signal stops the stream and future reconnects.
- SSE reconnect delay defaults to `1000` milliseconds and its ceiling to `30000` milliseconds.

## Other options

- `fetch` and `timing` inject transport and time; `circuitBreaker` and `rateLimit` add resilience.
- `createBearerAuthInterceptor` and `createApiKeyAuthInterceptor` add credentials;
  `createTraceContextInterceptor` propagates traces.
- `createRealtimeClient` covers WebSocket; `generateOpenApiClient` generates typed operation
  methods.
- SSE `parse`, `onError`, `onStateChange` and `reconnect` customize parsing and lifecycle.
