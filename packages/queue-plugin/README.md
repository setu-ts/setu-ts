# Queue Plugin

Background job queue plugin for Hono Enterprise with Memory and Redis adapters.

## Installation

```bash
deno add @hono-enterprise/queue-plugin
```

## Usage

### Basic Setup (Memory Adapter)

```typescript
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

app.register(QueuePlugin({ adapter: 'memory' }));
```

### Redis Adapter

```typescript
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

app.register(QueuePlugin({
  adapter: 'redis',
  url: 'redis://localhost:6379',
}));
```

### Named Instances

```typescript
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

// Foreground queue
app.register(QueuePlugin({ adapter: 'memory', name: 'foreground' }));

// Background queue
app.register(QueuePlugin({ adapter: 'memory', name: 'background' }));
```

## API

### Adding Jobs

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';

const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);

// Basic job
await queue.add('send-email', { to: 'user@example.com' });

// Delayed job
await queue.add('send-email', { to: 'user@example.com' }, { delayMs: 5000 });

// Job with retry limit
await queue.add('process-data', data, { maxAttempts: 5 });
```

### Processing Jobs

```typescript
queue.process('send-email', async (job) => {
  await emailService.send(job.data);
}, { concurrency: 3 });
```

### Recurring Jobs

```typescript
await queue.addRecurring('cleanup', {}, { cron: '0 0 * * *' }); // Daily at midnight
```

## Options

| Option               | Type                  | Default                    | Description                              |
| -------------------- | --------------------- | -------------------------- | ---------------------------------------- |
| `adapter`            | `'memory' \| 'redis'` | `'memory'`                 | Queue adapter type                       |
| `name`               | `string`              | -                          | Instance name for multi-instance support |
| `url`                | `string`              | `'redis://localhost:6379'` | Redis connection URL                     |
| `defaultMaxAttempts` | `number`              | `3`                        | Default retry attempts                   |
| `pollIntervalMs`     | `number`              | `1000`                     | Worker poll interval                     |

## Adapters

### MemoryQueue

In-memory queue for testing and local development. Jobs are lost on restart.

### RedisQueue

Redis-backed queue using sorted sets for delayed job storage. Supports persistence and distributed
processing.

## License

MIT
