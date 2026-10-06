/** Real boot evidence for every plugin setu add registers without options. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CqrsPlugin } from '@setu-ts/cqrs-plugin';
import { EventsPlugin } from '@setu-ts/events-plugin';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import { QueuePlugin } from '@setu-ts/queue-plugin';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { CachePlugin } from '@setu-ts/cache-plugin';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';
import { SsePlugin } from '@setu-ts/sse-plugin';
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';
import { withPluginWiring } from '../../src/commands/add.ts';

const factories: Readonly<Record<string, () => IPlugin>> = {
  'cqrs-plugin': CqrsPlugin,
  'events-plugin': EventsPlugin,
  'messaging-plugin': MessagingPlugin,
  'queue-plugin': QueuePlugin,
  'scheduler-plugin': SchedulerPlugin,
  'websocket-plugin': WebSocketPlugin,
  'cache-plugin': CachePlugin,
  'health-plugin': HealthPlugin,
  'metrics-plugin': MetricsPlugin,
  'openapi-plugin': OpenApiPlugin,
  'sse-plugin': SsePlugin,
  'realtime-backplane-plugin': RealtimeBackplanePlugin,
};

describe('zero-configuration add wiring', () => {
  for (const [name, factory] of Object.entries(factories)) {
    it(`registers, boots and stops ${name} with no options`, async () => {
      expect(withPluginWiring('      ...(devtool?.plugins ?? []),', name)).toBeDefined();
      const app = createApplication({ plugins: [RuntimePlugin(), factory()] });
      try {
        await app.start();
        expect(app.hasPlugin(name)).toBe(true);
      } finally {
        await app.stop();
      }
    });
  }
});
