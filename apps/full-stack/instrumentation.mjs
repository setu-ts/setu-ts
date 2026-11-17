// Registers OpenTelemetry's ESM loader hook before the application loads, so
// the Redis, AMQP and Kafka drivers the plugins import lazily can be traced.
// The start scripts and the image run this with `node --import`.
//
// Without @opentelemetry/instrumentation installed this does nothing and the
// application starts normally. `setu add telemetry` installs it.
import { register } from 'node:module';

try {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
    data: {
      include: [
        'http',
        'https',
        'ioredis',
        'redis',
        '@redis/client',
        '@node-redis/client',
        'amqplib',
        'kafkajs',
      ],
    },
  });
} catch {
  // No instrumentation package: start without the hook.
}
