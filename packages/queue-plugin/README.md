# Queue Plugin

Background job queue plugin for Setu-TS with Memory, Redis, RabbitMQ, and SQS adapters.

## Installation

```bash
deno add npm:@setu-ts/queue-plugin
```

## Usage

### Basic Setup (Memory Adapter)

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

app.register(QueuePlugin({ adapter: 'memory' }));
```

### Redis Adapter

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

app.register(
  QueuePlugin({
    adapter: 'redis',
    url: 'redis://localhost:6379',
  }),
);
```

Connection errors of the `ioredis` client the adapter builds go to the application logger — the
first error of an outage at `warn`, identical repeats at `debug`, the recovery at `info` — instead
of `ioredis` printing every reconnect failure to `console.error`. An injected client gets no
listener: it belongs to the caller.

**node-redis.** To use node-redis instead of ioredis, pass
`QueuePlugin({ adapter: 'redis', client: fromNodeRedis(createClient({ url })) })` (`fromNodeRedis`
from `@setu-ts/common`, `createClient` from `redis`, installed in your application). The adapter
provides `eval`, so every transition still runs as one script. See
[Using node-redis](https://github.com/setu-ts/setu-ts/blob/main/packages/common/README.md#using-node-redis-0110).

### RabbitMQ Adapter

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

app.register(
  QueuePlugin({
    adapter: 'rabbitmq',
    url: 'amqp://localhost:5672',
    // Queue names are derived per job name from this prefix
    // (`<prefix>.<name>.ready` / `.delay` / `.dead`); there is no `queues` map.
    prefix: 'he.queue',
  }),
);
```

<!-- version:history -->

Every job is published **persistent** through a **confirm channel**. The ready, delay and dead
queues are durable, and a durable queue keeps only persistent messages across a broker restart —
before 0.9.0 jobs were published transient, so a RabbitMQ restart silently discarded every job not
yet processed. `add()` resolves only once RabbitMQ has accepted the job, and a retry or dead-letter
acknowledges the reserved job only after its replacement is accepted, so a broker failure between
the two can run a job twice but cannot lose it. `publishTimeoutMs` (default `15000`) bounds each
publish, queue declarations included, so a paused broker rejects `add()` rather than leaving it
pending; a rejection is not proof the job was dropped. `persistentMessages: false` restores the
transient publishes. An injected `client` without `createConfirmChannel()` keeps a plain channel and
the adapter logs one warning saying its publishes are unconfirmed.

<!-- version:history -->

A queue name is an AMQP short string of at most 255 UTF-8 bytes, so `<prefix>.<name>.delay` must
fit: with the default prefix a job name may be at most 240 bytes. A longer name is refused with a
`RangeError` before the channel is touched — by `add()`, and at registration by `process()` and
`addRecurring()`, so a declared processor with such a name stops `start()` rather than failing every
poll — and a `prefix` over 247 bytes is refused at construction. Before 0.9.0 an oversized name
reached amqplib, which had already claimed the channel's reply slot, so every later queue
declaration on the channel waited forever.

Independently of the backend, one job name whose reserve or recurring enqueue fails is reported and
skipped for that tick; the processors and recurring jobs after it still run, and a recurring job
whose enqueue failed stays due and is retried on the next tick.

### SQS Adapter

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

app.register(
  QueuePlugin({
    adapter: 'sqs',
    sqs: {
      region: 'us-east-1',
      queues: { default: 'https://sqs.us-east-1.amazonaws.com/123456789012/tasks' },
    },
  }),
);
```

### Named Instances

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

// Foreground queue
app.register(QueuePlugin({ adapter: 'memory', name: 'foreground' }));

// Background queue
app.register(QueuePlugin({ adapter: 'memory', name: 'background' }));
```

## API

### Adding Jobs

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue } from '@setu-ts/common';

const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);

// Basic job
await queue.add('send-email', { to: 'user@example.com' });

// Delayed job
await queue.add('send-email', { to: 'user@example.com' }, { delayMs: 5000 });

// Job with retry limit
await queue.add('process-data', { rows: 100 }, { maxAttempts: 5 });
```

### Processing Jobs

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IMailer, IQueue } from '@setu-ts/common';

const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);
const mailer = ctx.services.get<IMailer>(CAPABILITIES.MAIL);
const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);

interface SendEmail {
  to: string;
}

queue.process<SendEmail>(
  'send-email',
  async (job) => {
    await mailer.send({ to: job.data.to, subject: 'Welcome', text: 'Hello' });
  },
  {
    concurrency: 3,
    // Invoked once when a job has exhausted its attempts, immediately before it
    // is dead-lettered — the only programmatic notice that work was abandoned.
    onFailed: (job, error) => {
      logger.error('job dead-lettered', { id: job.id, name: job.name, error: String(error) });
    },
  },
);
```

### Recurring Jobs

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue } from '@setu-ts/common';

const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);

await queue.addRecurring('cleanup', {}, { cron: '0 0 * * *' }); // Daily at midnight
```

## Options

<!-- version:history -->

| Option               | Type                                                                 | Default                    | Description                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter`            | `'memory' \| 'redis' \| 'rabbitmq' \| 'sqs'`                         | `'memory'`                 | Queue adapter type                                                                                                                                                                                                                                                                                                                    |
| `name`               | `string`                                                             | —                          | Instance name for multi-instance support                                                                                                                                                                                                                                                                                              |
| `url`                | `string`                                                             | `'redis://localhost:6379'` | Redis / RabbitMQ connection URL                                                                                                                                                                                                                                                                                                       |
| `client`             | `IRedisQueueClient \| IAmqpQueueConnection`                          | —                          | Injected client, bypassing the lazy import                                                                                                                                                                                                                                                                                            |
| `prefix`             | `string`                                                             | `'he.queue'`               | Queue-name prefix (RabbitMQ)                                                                                                                                                                                                                                                                                                          |
| `sqs`                | `SqsQueueOptions`                                                    | —                          | SQS configuration; required when `adapter: 'sqs'`                                                                                                                                                                                                                                                                                     |
| `defaultMaxAttempts` | `number`                                                             | `3`                        | Default retry attempts                                                                                                                                                                                                                                                                                                                |
| `pollIntervalMs`     | `number`                                                             | `1000`                     | Worker poll interval                                                                                                                                                                                                                                                                                                                  |
| `deadLetterTtlMs`    | `number`                                                             | — (retained forever)       | Retention for a dead-lettered payload (Redis only)                                                                                                                                                                                                                                                                                    |
| `keyPrefix`          | `string`                                                             | `'queue:'`                 | Redis namespace for every key, including recurring keys; non-empty, at most 128 characters, no control characters                                                                                                                                                                                                                     |
| `commandTimeoutMs`   | `number`                                                             | `15000`                    | Bound on one Redis command (Redis only; `0` disables). A paused server makes `add()` reject and a poll record the failure instead of waiting forever. The server may still apply a timed-out command, so a rejected `add()` can still have enqueued the job — retrying it can run the job twice. Not applied to an injected `client`. |
| `persistentMessages` | `boolean`                                                            | `true`                     | Publish every job persistent so it survives a RabbitMQ restart (adapter `rabbitmq` only); `false` restores the pre-0.9.0 transient publishes                                                                                                                                                                                          |
| `publishTimeoutMs`   | `number`                                                             | `15000`                    | Bound on one job publish, including its broker confirm (adapter `rabbitmq` only); `0` disables it                                                                                                                                                                                                                                     |
| `processors`         | `readonly QueueProcessorEntry[]`                                     | —                          | Declarative `process()` registrations. A `QueueProcessorDefinition` is `{ name, processor, options? }`; factories resolve at `onInit`.                                                                                                                                                                                                |
| `behaviors`          | `readonly (IIngressBehavior \| RegistryFactory<IIngressBehavior>)[]` | —                          | Chain around every processor. It sees `kind: 'queue'`, job name, the delivered job, and its attempt count.                                                                                                                                                                                                                            |
| `diagnostics`        | `QueueDiagnosticsOptions`                                            | — (disabled)               | Opt-in minimized attempt and depth observations for the diagnostics connector (M98f) — see below.                                                                                                                                                                                                                                     |

Two options this table used to list do not exist and never did: `region` (SQS configuration lives
under `sqs`) and `queues` (RabbitMQ derives its queue names from `prefix`).

`QueueProcessorDefinition<T = unknown>` uses method syntax:
`processor(job: IJob<T>): void | Promise<void>`. Typed payload processors fit the declarative list,
and methods retain their definition as `this`. The processor member is writable.

Declarative processors coexist with imperative `queue.process()` calls. Behaviours run in declared
order; a short circuit acknowledges the job, while a throw follows the existing retry, final
`onFailed`, and dead-letter path. With no behaviours, the processor receives the original job
directly and no chain is allocated.

A behaviour also sees `IngressContext.consumer`, which the queue service sets to `job.name` — the
dispatch identity a behaviour keys per-consumer state on (an idempotency record, for example). It is
always present for a delivered job.

**Retry span vs an ingress lease.** A behaviour that claims a job for the duration of its work — the
[`idempotentIngress()`](https://github.com/setu-ts/setu-ts/tree/main/packages/idempotency-plugin)
behaviour is the one shipped — refuses a redelivery inside the claim's lease as `in-progress`, and
every refusal consumes an attempt. With the default 3 attempts and the 2 s / 4 s backoff the retry
span is 6 s, shorter than the default 30 s ingress lease, so a crashed holder's job is dead-lettered
rather than retried. For a job name you make idempotent, keep the queue's retry span ABOVE the
lease: with the default backoff that means `defaultMaxAttempts ≥ 6`.

## Queue observations (M98f)

`diagnostics` exposes actual attempts and supported depths as minimized observations through the
local diagnostics connector's `GET /v1/queues` (`@setu-ts/diagnostics-plugin`). It never changes a
processor, a retry, `onFailed`, or a settlement.

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

app.register(
  QueuePlugin({
    adapter: 'memory',
    diagnostics: {
      enabled: true,
      instanceAlias: 'mailer',
      // Exact job-name -> display-alias allowlist; unlisted names are neither observed nor counted.
      queues: { 'send-welcome-email': 'welcome-emails' },
      // Optional, separately bounded depth counting; absent by default.
      depths: { intervalMs: 30000, timeoutMs: 2000, concurrency: 2 },
    },
  }),
);
```

Every instance — named or not, observed or not — registers one source under
`CAPABILITIES.QUEUE_DIAGNOSTICS` as a multi provider, so named instances stay independently
observable. Without `diagnostics` that source answers `disabled` and dispatch is untouched.
`enabled` must be the literal `true`; aliases are 1–64 UTF-8 bytes with no control character (queue
aliases unique, at most 64 queues), and approving an alias is authorizing its disclosure.

Each observed attempt carries the approved queue alias, a session-local `j<N>` job alias, the
attempt number, monotonic timing, the processor `outcome` and the `settlement` — recorded only after
the adapter's settlement call returned, never inferred from the outcome. No payload, header, raw job
id, claim token, credential or error text is captured.

| Adapter    | Settlement evidence                                                            | Depths                                     |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| `memory`   | confirmed (in-process)                                                         | `process-local`                            |
| `redis`    | confirmed (awaited server commands)                                            | `shared-backend` when the client can count |
| `rabbitmq` | `unknown` — an AMQP `ack` has no broker confirmation (publishes are confirmed) | `unavailable` (never zero)                 |
| `sqs`      | `unknown` — a lapsed claim or a failed dead-letter send is absorbed and logged | `unavailable` (never zero)                 |

Depth counting runs one non-overlapping cycle at bootstrap and one per `intervalMs`, over approved
job names this instance has a processor for; a count still pending after `timeoutMs` is reported as
timed out but keeps its slot until it settles. `shared-backend` counts from several instances or
replicas are the same inventory — never sum them.

A depth row describes the latest cycle only. A name that cycle did not read (timed out, failed, or
not reached because every slot was still held) has no row at all; the source's `failure` and
`depthCoverage: 'partial'` say why. A depth that cannot be read is never reported as a retained
zero.

## Seeing a job that failed for the last time

A job that exhausts its attempts is dead-lettered by every adapter, and used to be reachable only by
opening a Redis client: `IQueue` has no `getJob` and no dead-letter accessor, the health payload was
`{"adapter":"RedisQueue"}`, and `/metrics` carried no queue series at all. Three surfaces answer
different questions about it:

| Surface                                  | Answers                                                               |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `ProcessOptions.onFailed`                | "This job is being abandoned" — log, alert, or compensate in process. |
| `queue_jobs_total{name,outcome}`         | "How often is this happening?" — the alertable rate.                  |
| The `queues` field in the health payload | "How many are sitting there right now?" — survives a restart.         |

The counter needs `@setu-ts/metrics-plugin` registered; without it no collector is built and
behaviour is unchanged. Depths are reported by the memory and Redis adapters and OMITTED (never
reported as zeros) on RabbitMQ and SQS, whose counts need a management API.

`deadLetterTtlMs` bounds how long the retained payload lives. Without it the jobs hash grows for the
lifetime of the deployment — the retention exists for debugging, so dropping it by default would
remove the value it is there for.

Retention is enforced **per payload**: each dead-letter sweeps the dead set — which is scored by
dead-letter time — and deletes every entry older than the TTL along with its payload. A key-level
`EXPIRE` alone would not do this, because each new dead-letter renews it, so a queue that keeps
failing would retain its oldest payloads forever. The key-level expiry is kept beside the sweep as
the backstop for the case the sweep cannot reach: a queue that dead-letters once and then goes quiet
never runs another sweep.

The bound this gives is **at least the TTL, and at most the TTL past the last dead-letter** — so a
payload that dead-letters just before a short burst that then stops can live for just under twice
the TTL. Two mechanics produce that: the sweep only runs when a dead-letter arrives, so a payload is
dropped at the first dead-letter after its deadline rather than at the deadline itself; and the
backstop is armed from the dead-letter that armed it, because one shared key carries one deadline
and arming it from the oldest survivor would take the newer payloads with it before their own TTL
elapsed. It errs late by construction: dropping a payload early would discard exactly the debugging
data the option exists to keep. Exact per-payload expiry is not expressible here — Redis has no
per-member TTL on a sorted set, and the payloads share one hash.

With a client exposing `eval` — always true of the client the adapter builds — the payload move and
the dead-set insert run as one Lua script and are atomic (M101a). The rest of this paragraph
describes an injected client without `eval`, which keeps separate commands. The payload move is
issued **before** the dead-set insert, and that order is load-bearing: no two of these commands are
atomic, and a sweep starts from the dead set, so a member that became visible before its payload was
written can be swept by a concurrent `deadLetter` — deleting the member and stranding the payload
where no later sweep can reach it. Writing first means a sweep either misses the id, and a later one
collects it, or finds both together. Ordering closes that window; it does not make the sequence
atomic, so a process that dies mid-sequence can still leave a payload behind.

Setting it MOVES a dead job's payload from `queue:<name>:jobs` into `queue:<name>:dead:jobs`, and
the expiry is applied to that key and the dead set. It is never applied to the live jobs hash: that
key holds the payload of **every** job for the name, Redis keeps a key's TTL across later writes,
and a job whose payload has vanished cannot be returned by `reserve` — so expiring it would silently
discard work that was only waiting to run.

## Adapters

### MemoryQueue

In-memory queue for testing and local development. Jobs are lost on restart.

### Redis key namespaces

Set `keyPrefix` on `QueuePlugin({ adapter: 'redis', keyPrefix: 'orders:' })` or
`new RedisQueue({ keyPrefix: 'orders:' })` to isolate applications sharing one Redis. The default
remains `queue:` so existing jobs are found after upgrading. Every key, including recurring and
dead-letter keys, uses the prefix. It must be non-empty, at most 128 characters and contain no
control characters; invalid values are refused at construction. The RabbitMQ `prefix` option is
separate and does not move Redis keys. Changing a deployed prefix requires draining or migrating its
existing jobs.

Keys are the prefix followed by the job name, and job names may contain `:`. Isolation therefore
holds only when no prefix on one Redis is a string prefix of another: `app:` with a job named `b:x`
and `app:b:` with a job named `x` both use `app:b:x:*`. Choose sibling prefixes such as `orders:`
and `billing:`, never nested ones. The adapter cannot check this, because one application never sees
another's prefix.

### RabbitMQ recovery

Connection and channel faults start automatic reconnect with full-jitter backoff. Readiness is down
during the fault window. An injected connection receives a fresh channel only; the caller owns
reconnecting that connection. Queues are re-declared lazily after recovery. RabbitMQ returns unacked
jobs for at-least-once redelivery: a job can run twice across an outage, and its redelivery can
carry the original attempt count. Make processors idempotent. Disconnect stops scheduled reconnects
and removes listeners. Each delivery has a fresh claim token; a pre-outage delivery cannot settle
the redelivered message. A late ack, retry or dead-letter rejects with the internal
`StaleClaimError`, reported by the service as a failed settlement.

### RedisQueue

Redis-backed queue using sorted sets for delayed job storage. Supports persistence and distributed
processing.

Since M101a each transition (`enqueue`, `reserve`, `ack`, `requeue`, dead-lettering) runs as one Lua
script through the client's `eval`, so a command that times out locally cannot leave a job half
moved. An injected client without `eval` keeps the separate commands. The scripts touch several
`<keyPrefix><name>:*` keys with no hash tag, so a Redis Cluster client is not supported: it would
refuse them with `CROSSSLOT`.

### Claims and dead workers

Redis 5 or later is required: the lease scripts use `TIME` before writes under script-effects
replication. `RedisQueueOptions.visibilityTimeoutMs` and the flat
`QueuePluginOptions.visibilityTimeoutMs` default to `30000`. A duration from `1000` to `2147483647`
is required, so renewal never runs more often than every 333 ms; invalid values throw `RangeError`
at construction. Each reservation sets its lease deadline by Redis server time and mints a token
with `INCR <keyPrefix><name>:claimseq`. Which jobs are due is decided by the reserving replica's own
clock, the same clock that wrote `availableAtMs`, so clock skew between an application host and
Redis shifts neither delays nor retries. Reclaimed jobs become due at once. The service renews the
claim every `Math.floor(visibilityTimeoutMs / 3)` ms while the processor runs, without overlapping
renewal calls. A failed or false renewal is reported once per delivery; the processor continues.

On reserve, up to the requested limit of expired claims return to ready. Each reclaim counts as an
attempt: a delivery has `max(stored attempts, 1) + stalls`. Once that exceeds `maxAttempts`,
dispatch calls `onFailed` (if configured) and then dead-letters it without running the processor, so
an abandoned job sends the same signal as a final failed attempt. The claim is renewed while
`onFailed` runs, as it is during a processor, so a slow callback is not reclaimed; one that never
settles holds its concurrency slot, like a processor that never settles. Orphan ids without payloads
are removed. A timed-out reserve that Redis eventually applies is recovered by this same lease.
Settlement clears claims and stalls; a stale ack, retry or dead-letter rejects with internal
`StaleClaimError` and the service reports a failed settlement, leaving the current delivery intact.
Payload bytes are unchanged by reclaim.

Delivery is at least once: a process death, GC pause or event-loop stall longer than the lease can
run a job twice. Make processors idempotent and raise the lease for expected pauses. An alive but
stuck processor keeps renewing and is not reclaimed. Drain old replicas before upgrading, since
pre-upgrade processing entries are immediately reclaimable. Claim tokens fence deliveries; they are
not authorization. A Redis writer can read them and already has access to delete jobs; Redis ACLs
are the security boundary.

An injected client without `eval` keeps the old multi-command behavior, with no claims or reclaim.
`connect()` reports once through the connection-error reporter that `visibilityTimeoutMs` is
inactive. The client the adapter builds always has `eval`.

### RabbitMqQueue

RabbitMQ-backed queue polling per-name durable queues through the default exchange. Delayed jobs and
retries wait in a per-name delay queue whose message TTL dead-letters them into the ready queue.
Jobs are published persistent through a confirm channel (see [RabbitMQ Adapter](#rabbitmq-adapter)).
Requires the `amqplib` package at runtime (or an injected `IAmqpQueueConnection`). Each connection
attempt the adapter makes is bounded at 10 seconds in total, TCP and AMQP handshake together, so a
broker that never answers, or answers too slowly, is retried rather than waited on; a connection
that opens after its attempt expired is closed at once. A message in a ready queue whose body is not
a stored job (not JSON, not an object, or missing a string `id` or `name`, `data`, or a finite
`attempts`, `maxAttempts` or `availableAtMs`) is moved with its bytes unchanged into the dead queue,
acknowledged, and reported once as a warning that does not quote the body; the rest of the batch is
reserved normally. If the dead queue refuses the move (a `reject-publish` length policy, or a
blocked broker past `publishTimeoutMs`), the warning says so, the jobs already claimed in that call
are returned, fetching stops, and the message stays unacknowledged until the channel closes, when
RabbitMQ redelivers it and the move is tried again.

### SqsQueue

AWS SQS-backed queue using the AWS SDK `@aws-sdk/client-sqs`. Supports visibility timeouts, delayed
jobs (up to 15 minutes via `DelaySeconds`), and manual DLQ forwarding. The `maxAttempts` field in
the job envelope drives the DLQ promotion logic. Requires the `@aws-sdk/client-sqs` package at
runtime (or an injected transport).

#### SQS Retry and DLQ

When a job reaches `maxAttempts`, `SqsQueue.deadLetter()` forwards the original message body to the
configured DLQ queue URL (via `sqs.deadLetterQueues`), then deletes the source message. If DLQ send
fails, the source message is **not** deleted (preventing silent data loss). If the source delete
fails after a successful DLQ send, a duplicate-risk warning is logged. Note: AWS SQS does not
support managed DLQ redrive for this adapter — DLQ forwarding is manual via the `deadLetterQueues`
option.

#### ElasticMQ E2E

The SQS adapter includes guarded E2E tests against ElasticMQ (`SQS_ENDPOINT_URL` environment
variable). These tests verify enqueue→reserve→ack round-trips, queue isolation, visibility retry
progression, and DLQ promotion.

## Trace propagation

A queue job is deferred work whose whole diagnostic value is "which request caused this". With a
`CAPABILITIES.TELEMETRY` provider registered, a job joins the trace of the request that enqueued it:
`queue.add()` runs inside an `enqueue <name>` producer span and writes its W3C `traceparent` into
`AddJobOptions.headers`, and every processor runs inside a `process <name>` consumer span parented
from `IJob.headers`.

Every registration route is covered — the `processors` arm, a `processors` factory, and an
imperative `queue.process()` through the resolved capability — and all four adapters carry the map
end to end. An M86 ingress behaviour reads it as `IngressContext.headers`, the same member the
`'messaging'` arm uses.

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';
import { TelemetryPlugin } from '@setu-ts/telemetry-plugin';
import { CAPABILITIES, type IQueue } from '@setu-ts/common';

app.register(
  TelemetryPlugin({
    serviceName: 'orders',
    exporter: 'otlp',
    endpoint: 'http://localhost:4318/v1/traces',
  }),
);
app.register(QueuePlugin({ adapter: 'redis', url: 'redis://localhost:6379' }));

app.router.post('/orders', async (ctx) => {
  const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);
  // Both the enqueue and the eventual processing join THIS request's trace.
  await queue.add('order.export', { id: 'o-1' }, { headers: { 'x-tenant': 't-1' } });
  return ctx.response.json({ accepted: true });
});
```

`headers` is a public option and its delivery never depends on which capabilities are registered: a
map you pass reaches the processor with or without telemetry. What telemetry adds is the
`traceparent` alongside it.

**Semantics.** `IJob.headers` mirrors `MessageMetadata.headers` exactly — `{}` means the channel was
read and carried nothing; **absent** means there was no channel. It is never substituted, so "this
job had no cause recorded" stays distinguishable from "the cause was lost".

**Without telemetry** nothing is injected and behaviour is byte-identical to before. A job carrying
no `traceparent` starts a root span rather than failing. `addRecurring` is deliberately untraced: a
recurring job fires on a schedule, so the call that registered it is not the cause of any run.

**Known limitation.** With `behaviors` configured, a behaviour runs OUTSIDE the consumer span,
because the behaviour chain is applied by a service subclass that is necessarily outermost at
dispatch. The processor's own work is correctly parented regardless, and with no behaviours
configured the question does not arise.

## License

MIT

## Health indicator

Registered under the queue's capability token. Since M70c it reports two signals: the adapter's
lifecycle (`isReady()`) and its reachability (`isHealthy()`).

| Status | Meaning                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up`   | The adapter is connected and reachable, or its reachability is unknown — no liveness check, or a probe that did not answer within its 2 s bound (`reachable` is `'unknown'`). |
| `down` | The adapter is not connected, or is connected but unreachable.                                                                                                                |

`data` reports `{ adapter, reachable }`, where `reachable` is `true`, `false`, or `'unknown'` when
the adapter has no liveness check.

**Probes and readiness (M119b, V10-22).** The reachability check stays cached for 5 s and bounded at
2 s. The RabbitMQ adapter no longer reads a supervisor flag — its check opens and closes a throwaway
AMQP channel on the connection, so a paused broker can no longer report `reachable: true`; a refused
round trip answers `false`. For every queue adapter, a check that does not answer within the 2 s
bound now reports `up` with `reachable: 'unknown'` and no depth counts, instead of `down`: a hung
probe is not evidence the backend is down. A check that answers `false` — a stopped broker — still
reads `down` at once. The indicator counts toward readiness by default; the health plugin's
`readiness` option overrides it by name.

## Exports

| Export                         | Kind      |
| ------------------------------ | --------- |
| `adaptSnsModule`               | function  |
| `adaptSqsModule`               | function  |
| `loadSnsModule`                | function  |
| `loadSqsModule`                | function  |
| `QueuePlugin`                  | function  |
| `MemoryQueue`                  | class     |
| `QueueBackendUnavailableError` | class     |
| `RabbitMqQueue`                | class     |
| `RedisQueue`                   | class     |
| `SnsPublisher`                 | class     |
| `SqsDelayTooLongError`         | class     |
| `SqsQueue`                     | class     |
| `SqsQueueNotConfiguredError`   | class     |
| `AddJobOptions`                | interface |
| `IJob`                         | interface |
| `IQueue`                       | interface |
| `ISnsTransport`                | interface |
| `ISqsTransport`                | interface |
| `ProcessOptions`               | interface |
| `QueueDepthDiagnosticsOptions` | interface |
| `QueueDepths`                  | interface |
| `QueueDiagnosticsOptions`      | interface |
| `QueueLogger`                  | interface |
| `QueuePluginOptions`           | interface |
| `QueueProcessorDefinition`     | interface |
| `RabbitMqQueueOptions`         | interface |
| `RecurringOptions`             | interface |
| `RedisQueueOptions`            | interface |
| `SnsPublisherOptions`          | interface |
| `SnsSdkModule`                 | interface |
| `SqsQueueOptions`              | interface |
| `SqsReceivedMessage`           | interface |
| `SqsSdkModule`                 | interface |
| `JobProcessor`                 | type      |
| `QueueAdapterType`             | type      |
| `QueueProcessorEntry`          | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#queue-setu-tsqueue-plugin).
