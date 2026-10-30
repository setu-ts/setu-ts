/**
 * A node-redis client in the generated project's load order is traced.
 *
 * Its own file, so no earlier `redis` import in this worker can have loaded
 * node-redis already: OpenTelemetry patches `@redis/client` as Node loads it,
 * and a scaffold's `setu.config.ts` builds its clients (through the generated
 * `src/node-redis.ts`) before `app.start()` registers the instrumentation.
 */
import { describe, expect, it } from 'vitest';
import { fromNodeRedis, PLUGIN_PRIORITY, type IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import * as sdk from '@opentelemetry/sdk-trace-base';
import * as resources from '@opentelemetry/resources';
import { TelemetryPlugin } from '../../src/index.ts';
import { buildTracerHost } from '../../src/tracing/tracer.ts';
import type { OtelSdkModule, OtelResourcesModule } from '../../src/tracing/tracer.ts';

const redisUrl = process.env['REDIS_URL'];

describe('REAL node-redis auto-instrumentation, generated load order', () => {
  it(
    'traces a client built before app.start() through a factory that imports redis',
    { skip: redisUrl === undefined },
    async () => {
      // What the generated helper returns, built at configuration import time.
      const client = fromNodeRedis(async () => {
        const { createClient } = await import('redis');
        return createClient({ url: redisUrl! });
      });
      const key = `m117-order-${crypto.randomUUID()}`;
      const exporter = new sdk.InMemorySpanExporter();
      const host = buildTracerHost({
        sdkMod: sdk as unknown as OtelSdkModule,
        resourcesMod: resources as unknown as OtelResourcesModule,
        pluginOptions: { serviceName: 'm117-redis-order', exporter: 'console' },
        consoleExporterCtor: class {
          constructor() {
            return exporter;
          }
        },
      });
      // Listed BEFORE TelemetryPlugin and connecting in register(), as the
      // Redis-backed plugins do in a scaffold's plugin list.
      const consumer: IPlugin = {
        name: 'redis-consumer',
        version: '0.0.0',
        priority: PLUGIN_PRIORITY.NORMAL,
        async register() {
          await client.connect();
        },
      };
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          consumer,
          TelemetryPlugin({
            serviceName: 'm117-redis-order',
            exporter: 'console',
            middleware: false,
            tracerProviderFactory: () => Promise.resolve(host),
            instrumentations: { redis: true },
          }),
        ],
      });
      try {
        await app.start();
        expect(await client.set(key, 'value')).toBe('OK');
        await host.forceFlush();
        const names = exporter.getFinishedSpans().map((span) => span.name);
        expect(names).toContain('redis-SET');
      } finally {
        await client.del(key);
        await client.quit();
        await app.stop();
      }
    },
  );
});
