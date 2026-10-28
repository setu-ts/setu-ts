import * as nodeFs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { tempDir } from '../../../../test/node-helpers.ts';
import { runCli } from '../../src/cli.ts';
import {
  npmInstall,
  npmRun,
  runIn,
  startOverlay,
  withNodeServer,
} from '../fixtures/node-project.ts';

const runtime = createNodeRuntimeServices();
let root = '';
beforeEach(async () => {
  root = await tempDir({ prefix: 'm121-full-stack-' });
});
afterEach(async () => {
  await nodeFs.rm(root, { recursive: true, force: true });
});

function cli(args: readonly string[]): Promise<number> {
  return runCli(args, {
    fs: runtime.fs!,
    cwd: root,
    now: () => runtime.now(),
    log: () => {},
    error: () => {},
  });
}

describe.skipIf(process.env['REDIS_URL'] === undefined)('full-stack on real Redis', () => {
  it(
    'publishes from a full-stack workspace member and reads the actual Redis stream (dotenv and environment)',
    { timeout: 900_000 },
    async () => {
      expect(
        await cli([
          'new',
          'ws',
          '--workspace',
          '--runtime',
          'node',
          '--transport',
          'redis',
          '--transport-url',
          'redis://127.0.0.1:1',
        ]),
      ).toBe(0);
      expect(
        await cli(['generate', 'app', 'portal', '--template', 'full-stack', '--dir', `${root}/ws`]),
      ).toBe(0);
      const project = `${root}/ws/apps/portal`;
      const overlay = await startOverlay();
      try {
        const installed = await npmInstall(`${root}/ws`, overlay);
        expect(installed.code, installed.output).toBe(0);
        const built = await npmRun(project, 'build');
        expect(built.code, built.output).toBe(0);
        const probe = `import { createApp } from './setu.config.ts';
import { CAPABILITIES, type IMessageBroker, type ISubscription } from '@setu-ts/common';
import Redis from 'ioredis';
if (process.env.PROBE_DOTENV === 'true') delete process.env.REDIS_URL;
const app = await createApp();
const endpoint = process.env.PROBE_REDIS_URL;
if (endpoint === undefined) throw new Error('missing Redis probe URL');
const redis = new Redis(endpoint);
const topic = 'm121.' + crypto.randomUUID();
let subscription: ISubscription | undefined;
try {
  await app.start();
  const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  let delivered!: (message: { proof: string }) => void;
  const received = new Promise<{ proof: string }>((resolve) => { delivered = resolve; });
  subscription = await broker.subscribe<{ proof: string }>(topic, (message) => { delivered(message); });
  await broker.publish(topic, { proof: topic });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const payload = await Promise.race([received, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no delivery')), 10000); })]);
    if (payload.proof !== topic) throw new Error('incorrect round trip payload');
  } finally { clearTimeout(timer); }
  console.log('M121_XLEN=' + await redis.xlen(topic));
} finally {
  await subscription?.unsubscribe();
  await app.stop();
  await redis.del(topic);
  await redis.quit();
}
`;
        await nodeFs.writeFile(`${project}/m121-probe.ts`, probe);
        const envPath = `${project}/.env`;
        const env = await nodeFs.readFile(envPath, 'utf8');
        for (const dotenv of [true, false]) {
          const endpoint = new URL(process.env['REDIS_URL']!);
          endpoint.pathname = dotenv ? '/13' : '/14';
          const url = endpoint.href;
          await nodeFs.writeFile(
            envPath,
            `${env}\nREDIS_URL=${dotenv ? url : 'redis://127.0.0.1:1'}\n`,
          );
          const result = await runIn(
            project,
            'node',
            ['--import', 'tsx', 'm121-probe.ts'],
            overlay,
            {
              REDIS_URL: url,
              PROBE_REDIS_URL: url,
              PROBE_DOTENV: String(dotenv),
            },
          );
          expect(result.code, result.output).toBe(0);
          const length = /M121_XLEN=(\d+)/.exec(result.output);
          expect(length, result.output).not.toBeNull();
          expect(Number(length![1]), result.output).toBeGreaterThan(0);
          console.log(`Redis ${dotenv ? 'dotenv' : 'environment'} XLEN=${length![1]}`);
        }
      } finally {
        await overlay.close();
      }
    },
  );

  it(
    'boots a standalone full-stack --broker redis with the Redis health indicator up',
    { timeout: 900_000 },
    async () => {
      expect(
        await cli([
          'new',
          'portal',
          '--runtime',
          'node',
          '--template',
          'full-stack',
          '--broker',
          'redis',
        ]),
      ).toBe(0);
      const project = `${root}/portal`;
      const overlay = await startOverlay();
      try {
        const installed = await npmInstall(project, overlay);
        expect(installed.code, installed.output).toBe(0);
        const built = await npmRun(project, 'build');
        expect(built.code, built.output).toBe(0);
        const result = await withNodeServer(
          project,
          async (origin) => {
            const response = await fetch(`${origin}/health`);
            return { status: response.status, health: await response.json() };
          },
          { REDIS_URL: process.env['REDIS_URL']! },
        );
        expect(result.result.status, result.output).toBe(200);
        expect(result.result.health).toMatchObject({
          checks: {
            messaging: { status: 'up' },
          },
        });
      } finally {
        await overlay.close();
      }
    },
  );
});
