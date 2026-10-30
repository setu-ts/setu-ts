/** Cross-instance delivery and echo suppression through real kernel applications. */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IRealtimeBackplane, RealtimeFrame } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { RealtimeBackplanePlugin } from '../../src/index.ts';
import {
  REDIS_CLIENTS,
  redisOptions,
  nodeClient,
} from '../../../common/test/fixtures/redis-clients.ts';

const url = process.env['REDIS_URL'];

describe.each(REDIS_CLIENTS)('%s real Redis backplane delivery', (variant) => {
  it(
    'delivers once to the other instance and suppresses its own echo',
    { skip: url === undefined },
    async () => {
      const topic = `m117-delivery-${crypto.randomUUID()}`;
      const apps = ['a', 'b'].map((origin) =>
        createApplication({
          plugins: [
            RuntimePlugin(),
            RealtimeBackplanePlugin({
              transport: 'redis',
              topic,
              origin,
              ...redisOptions(variant, url!),
              ...(variant === 'ioredis' ? {} : { subscriber: nodeClient(variant, url!) }),
            }),
          ],
        }),
      );
      const local: RealtimeFrame[] = [];
      const remote: RealtimeFrame[] = [];
      try {
        for (const app of apps) await app.start();
        const [a, b] = apps.map((app) =>
          app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE),
        );
        await a.subscribe((frame) => {
          local.push(frame);
        });
        await b.subscribe((frame) => {
          remote.push(frame);
        });
        const frame: RealtimeFrame = {
          kind: 'ws-room',
          origin: 'a',
          name: 'room',
          data: '雪',
        };
        await a.publish(frame);
        const deadline = performance.now() + 3000;
        while (remote.length === 0 && performance.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(remote).toEqual([frame]);
        expect(local).toEqual([]);
      } finally {
        for (const app of apps) await app.stop();
      }
    },
  );
});
