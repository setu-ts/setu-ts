/** Real adapter-driven node-redis span, using the existing locked OTel SDK. */
import { describe, expect, it } from 'vitest';
import { fromNodeRedis } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import * as sdk from '@opentelemetry/sdk-trace-base';
import * as resources from '@opentelemetry/resources';
import { TelemetryPlugin } from '../../src/index.ts';
import { buildTracerHost } from '../../src/tracing/tracer.ts';
import type { OtelSdkModule, OtelResourcesModule } from '../../src/tracing/tracer.ts';

const redisUrl = process.env['REDIS_URL'];

describe('REAL node-redis auto-instrumentation', () => {
  it(
    'exports redis-SET for an adapter-driven command',
    { skip: redisUrl === undefined },
    async () => {
      const exporter = new sdk.InMemorySpanExporter();
      const host = buildTracerHost({
        sdkMod: sdk as unknown as OtelSdkModule,
        resourcesMod: resources as unknown as OtelResourcesModule,
        pluginOptions: { serviceName: 'm117-redis-span', exporter: 'console' },
        consoleExporterCtor: class {
          constructor() {
            return exporter;
          }
        },
      });
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          TelemetryPlugin({
            serviceName: 'm117-redis-span',
            exporter: 'console',
            middleware: false,
            tracerProviderFactory: () => Promise.resolve(host),
            instrumentations: { redis: true },
          }),
        ],
      });
      let client: ReturnType<typeof fromNodeRedis> | undefined;
      const key = `m117-span-${crypto.randomUUID()}`;
      try {
        await app.start();
        // The hook must be enabled BEFORE node-redis is loaded; it patches the
        // CommonJS @redis/client modules as Node requires them.
        const { createClient } = await import('redis');
        client = fromNodeRedis(createClient({ url: redisUrl! }));
        expect(await client.set(key, 'value')).toBe('OK');
        expect(await client.get(key)).toBe('value');
        await host.forceFlush();
        const spans = exporter.getFinishedSpans();
        const observed = spans.map((span) => ({
          name: span.name,
          attributes: span.attributes,
          scope: span.instrumentationScope.name,
        }));
        const span = spans.find((candidate) => candidate.name === 'redis-SET');
        expect(span, JSON.stringify(observed)).toBeDefined();
        expect(span!.instrumentationScope.name).toBe('@opentelemetry/instrumentation-redis');
        expect(span!.attributes['db.system.name']).toBe('redis');
        expect(span!.attributes['db.operation.name']).toBe('SET');
        expect(span!.attributes['db.query.text']).toBe(`SET ${key} [1 other arguments]`);
      } finally {
        if (client !== undefined) {
          await client.del(key);
          await client.quit();
        }
        await app.stop();
      }
    },
  );
});
