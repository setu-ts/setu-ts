# @hono-enterprise/sse-plugin

Server-Sent Events — one-way, server → client streaming over `text/event-stream`. Registers an
`ISseService` under `CAPABILITIES.SSE` (`'sse'`).

Zero dependencies, built on `IResponse.stream()` and `IRequestContext.signal`.

## When to use it

SSE runs over ordinary HTTP: it survives proxies and corporate middleboxes far more reliably than a
socket upgrade, and browsers reconnect automatically. Reach for it whenever traffic only flows
server → client — notifications, progress feeds, log tailing, metric ticks.

When the client also needs to **send**, use
[`@hono-enterprise/websocket-plugin`](../websocket-plugin).

## Installation

```typescript
import { SsePlugin } from '@hono-enterprise/sse-plugin';
```

## Usage

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { SsePlugin } from '@hono-enterprise/sse-plugin';
import { CAPABILITIES, type ISseService } from '@hono-enterprise/common';

const app = createApplication({
  plugins: [RuntimePlugin(), SsePlugin({ heartbeatMs: 15_000, retryMs: 3_000 })],
});
await app.start({ port: 3000 });

app.router.get('/events', async (ctx) => {
  const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
  const conn = sse.open(ctx);
  conn.send({ id: '1', data: 'hello world' });
  return conn.result;
});
```

## Named channels

```typescript
const deploys = sse.channel('deploys');
deploys.broadcast({ data: JSON.stringify({ build: 412, status: 'live' }) });
```

## Options

| Option        | Type     | Default  | Description                                                                    |
| ------------- | -------- | -------- | ------------------------------------------------------------------------------ |
| `heartbeatMs` | `number` | disabled | Interval for a `: heartbeat` comment frame. Omitted means **no timer at all**. |
| `retryMs`     | `number` | disabled | Emits a leading `retry: <ms>` advertising the reconnect delay.                 |

## Reconnection

A reconnecting browser sends `Last-Event-ID`. Set `id` on the messages you send so a client can
resume from where it dropped.

## Full API

Every export and option is documented in [PUBLIC_API.md](../../PUBLIC_API.md).
