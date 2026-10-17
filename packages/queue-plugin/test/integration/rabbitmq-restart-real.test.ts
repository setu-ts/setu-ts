import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { IQueue } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { QueuePlugin } from '../../src/index.ts';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function eventually(run: () => void | Promise<void>): Promise<void> {
  let last: unknown;
  const end = performance.now() + 30_000;
  while (performance.now() < end) {
    try {
      await run();
      return;
    } catch (error) {
      last = error;
    }
    await wait(250);
  }
  throw last;
}

describe('RabbitMQ automatic recovery', { skip: process.env['RABBITMQ_URL'] === undefined }, () => {
  it(
    'adds, reserves, acknowledges and restores /ready after a real broker restart',
    { timeout: 90_000 },
    async () => {
      const url = process.env['RABBITMQ_URL']!;
      // This test restarts only the explicitly authorized throwaway container.
      expect(new URL(url).port).toBe('56720');
      const run = promisify(execFile);
      const id = crypto.randomUUID();
      let processed = 0;
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          QueuePlugin({
            adapter: 'rabbitmq',
            url,
            prefix: `m113c.${id}`,
            pollIntervalMs: 100,
            processors: [
              {
                name: 'email',
                processor: () => {
                  processed++;
                },
              },
            ],
          }),
          HealthPlugin(),
        ],
      });
      await app.start();
      const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
      try {
        await queue.add('email', { before: true });
        await eventually(() => {
          expect(processed).toBe(1);
        });
        await run('docker', ['restart', 'm113c-rabbit']);
        await eventually(async () => {
          await queue.add('email', { after: true });
        });
        await eventually(() => {
          expect(processed).toBeGreaterThanOrEqual(2);
        });
        await eventually(async () => {
          expect(
            (await app.inject({ method: 'GET', url: 'http://localhost/ready' })).statusCode,
          ).toBe(200);
        });
      } finally {
        await app.stop();
      }
    },
  );
});
