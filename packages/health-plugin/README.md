# @setu-ts/health-plugin

Health checks and Kubernetes-style probes. Registers an `IHealthService` under `CAPABILITIES.HEALTH`
(`'health'`) and serves `/health`, `/live`, and `/ready`.

Plugins across the framework contribute their own indicators (cache, storage, mail, scheduler,
websocket, …), so a health report reflects the whole application without extra wiring.

## Installation

```typescript
import { createHttpIndicator, HealthPlugin } from '@setu-ts/health-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createHttpIndicator, HealthPlugin } from '@setu-ts/health-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    HealthPlugin({
      endpoints: { health: '/health', live: '/live', ready: '/ready' },
      indicators: [
        createHttpIndicator('external-api', { url: 'https://api.example.com/health' }),
      ],
    }),
  ],
});
await app.start({ port: 3000 });
```

## Options

| Option       | Type                 | Default                                                 | Description                       |
| ------------ | -------------------- | ------------------------------------------------------- | --------------------------------- |
| `endpoints`  | `EndpointsOptions`   | `{ health: '/health', live: '/live', ready: '/ready' }` | Probe paths.                      |
| `indicators` | `IHealthIndicator[]` | `[]`                                                    | Indicators registered at startup. |

Indicators passed via `indicators` are registered **before** the `onInit` drain, so they are present
even when the lifecycle is bypassed.

## Statuses

An indicator reports `'up'`, `'degraded'`, or `'down'`; the overall report takes the worst status
among them.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md).
