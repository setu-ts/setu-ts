import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runNewCommand } from '../../src/commands/new.ts';
import { listBrokers, listQueues, listTransports } from '../../src/workspace/transport.ts';

import type { PortProbe } from '../../src/workspace/port-probe.ts';

interface Harness {
  readonly fs: ReturnType<typeof createFakeFs>;
  run(argv: readonly string[]): Promise<number>;
  errText(): string;
}

function harness(seed: Readonly<Record<string, string>> = {}, portAvailable?: PortProbe): Harness {
  const fs = createFakeFs(seed);
  const err = createRecorder();
  return {
    fs,
    errText: () => err.text(),
    run: (argv) =>
      runNewCommand(parseArgs(argv), {
        fs,
        cwd: '/work',
        log: () => {},
        error: err.sink,
        ...(portAvailable === undefined ? {} : { portAvailable }),
      }),
  };
}

describe('the derived broker and queue lists', () => {
  it('equals the registry arms carrying the matching renderer, plus memory', () => {
    // Derived rather than hand-written: adding an arm without a renderer (or a
    // renderer without an arm) fails this equality instead of drifting.
    const withMessaging = listTransports()
      .filter((spec) => spec.messagingArgs !== undefined)
      .map((spec) => spec.name);
    expect(listBrokers()).toEqual(['memory', ...withMessaging]);

    const withQueue = listTransports()
      .filter((spec) => spec.queueArgs !== undefined)
      .map((spec) => spec.name);
    expect(listQueues()).toEqual(['memory', ...withQueue]);
  });

  it('covers every named MessagingPluginOptions arm except custom', () => {
    // The plugin's union is memory | redis-streams | rabbitmq | nats | kafka |
    // pubsub | service-bus | custom; the registry covers every named arm.
    expect([...listBrokers()].sort()).toEqual(
      ['kafka', 'memory', 'nats', 'pubsub', 'rabbitmq', 'redis', 'service-bus'].sort(),
    );
    // `QueueAdapterType` supports fewer backends; sqs has no arm (plan §9).
    expect(listQueues()).toEqual(['memory', 'redis', 'rabbitmq']);
  });
});

describe('a --broker scaffold', () => {
  it('renders the redis-streams wiring with the environment read', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'microservice', '--broker', 'redis'])).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    expect(config).toContain('{');
    expect(config).toContain("broker: 'redis-streams'");
    expect(config).toContain("Deno.env.get('REDIS_URL')");
    expect(config).toContain("'redis://127.0.0.1:6379'");
  });

  it('differs from the default microservice scaffold', async () => {
    const plain = harness();
    await plain.run(['svc', '--template', 'microservice']);
    const brokered = harness();
    await brokered.run(['svc', '--template', 'microservice', '--broker', 'redis']);

    const plainConfig = plain.fs.read('/work/svc/setu.config.ts');
    const brokeredConfig = brokered.fs.read('/work/svc/setu.config.ts');
    expect(brokeredConfig).not.toBe(plainConfig);
    expect(plainConfig).toContain('MessagingPlugin()');
    expect(brokeredConfig).toContain("broker: 'redis-streams'");
  });

  it('renders the queue adapter from the same flag family', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'microservice', '--queue', 'redis'])).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    expect(config).toContain("adapter: 'redis'");
    expect(config).toContain("Deno.env.get('REDIS_URL')");
  });

  it('writes the connection variable into the dotenv pair', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'microservice', '--broker', 'redis'])).toBe(0);
    const env = h.fs.read('/work/svc/.env');
    expect(env).toContain('REDIS_URL=redis://127.0.0.1:6379');
    const example = h.fs.read('/work/svc/.env.example');
    expect(example).toContain('REDIS_URL=');
    // The committed example carries no development value.
    expect(example).not.toContain('REDIS_URL=redis://127.0.0.1:6379');
  });

  it('emits the broker Compose service and names the command in the README', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'microservice', '--broker', 'redis'])).toBe(0);
    const compose = h.fs.read('/work/svc/docker/compose.yaml');
    expect(compose).toContain('redis:');
    expect(compose).toContain('image: redis:7');
    // ORDER, not just presence: the plugins connect during `register()` and do
    // not retry, so a reader following the README top-to-bottom must be told to
    // start the broker BEFORE the app. Emitting `## Run` first hands them a
    // guaranteed first-run failure — which is the very thing the Compose file
    // was added to prevent.
    const readme = h.fs.read('/work/svc/README.md');
    expect(readme).toContain('docker compose -f docker/compose.yaml up -d');
    expect(readme.indexOf('## Local transport services')).toBeLessThan(
      readme.indexOf('## Run'),
    );

    // Every broker arm declares a backing service — a selection without one
    // would scaffold a project that cannot boot.
    for (const name of listBrokers()) {
      if (name === 'memory') continue;
      const h2 = harness();
      const code = await h2.run([
        'svc',
        '--template',
        'microservice',
        '--broker',
        name,
      ]);
      expect(code).toBe(0);
      expect(h2.fs.read('/work/svc/docker/compose.yaml')).toContain('services:');
    }
  });
});

describe('a broker and queue naming the same arm', () => {
  // One arm can serve BOTH flags. Its Compose service and its dotenv row must
  // appear exactly once — a duplicated `redis:` key makes the stack refuse to
  // start, and a duplicated variable is a file the reader has to reconcile by
  // hand. Both dedups exist in `brokerComposeFiles` and `applyBrokerOverlay`;
  // asserting the presence of a block cannot tell one from two, so these count.
  it('emits its Compose service and dotenv row exactly once', async () => {
    const h = harness();
    expect(
      await h.run(['svc', '--template', 'microservice', '--broker', 'redis', '--queue', 'redis']),
    ).toBe(0);

    const compose = h.fs.read('/work/svc/docker/compose.yaml');
    expect(compose.match(/^ {2}redis:$/gm)?.length).toBe(1);
    expect(h.fs.read('/work/svc/.env').match(/^REDIS_URL=/gm)?.length).toBe(1);
    expect(h.fs.read('/work/svc/.env.example').match(/^REDIS_URL=/gm)?.length).toBe(1);
  });

  it('keeps both services when the two flags name different arms', async () => {
    const h = harness();
    expect(
      await h.run([
        'svc',
        '--template',
        'microservice',
        '--broker',
        'rabbitmq',
        '--queue',
        'redis',
      ]),
    ).toBe(0);

    const compose = h.fs.read('/work/svc/docker/compose.yaml');
    expect(compose.match(/^ {2}rabbitmq:$/gm)?.length).toBe(1);
    expect(compose.match(/^ {2}redis:$/gm)?.length).toBe(1);
    // And each wiring reads its OWN variable, not the other's.
    const config = h.fs.read('/work/svc/setu.config.ts');
    expect(config).toContain("broker: 'rabbitmq'");
    expect(config).toContain('RABBITMQ_URL');
    expect(config).toContain("adapter: 'redis'");
    expect(config).toContain('REDIS_URL');
  });
});

describe('broker and queue refusals', () => {
  it('refuses an unknown broker name', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'microservice', '--broker', 'rediss'])).toBe(2);
    expect(h.errText()).toContain('--broker accepts:');
    expect(h.errText()).toContain('rabbitmq');
  });

  it('refuses a transport with no messaging arm for --broker', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'microservice', '--broker', 'http'])).toBe(2);
    expect(h.errText()).toContain('"http" declares no message-broker wiring');
    expect(h.errText()).toContain('--broker accepts:');
  });

  it('refuses a queue backend the queue does not support', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'microservice', '--queue', 'nats'])).toBe(2);
    expect(h.errText()).toContain('--queue accepts:');
  });

  it('refuses a template that registers no messaging wiring', async () => {
    // The silent success §3.4 exists to remove: the flag would be accepted and
    // rewrite nothing.
    const h = harness();
    expect(await h.run(['svc', '--template', 'rest', '--broker', 'redis'])).toBe(2);
    expect(h.errText()).toContain('--template microservice');
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses Cloudflare Workers, where the swap removed both wirings', async () => {
    const h = harness();
    expect(
      await h.run([
        'svc',
        '--template',
        'microservice',
        '--runtime',
        'cloudflare-workers',
        '--broker',
        'redis',
      ]),
    ).toBe(2);
    expect(h.errText()).toContain('Cloudflare Workers');
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses a starter-composed template, naming --template microservice', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'full-stack', '--broker', 'redis'])).toBe(2);
    expect(h.errText()).toContain('--template microservice');
    expect(h.fs.writes).toEqual([]);
  });

  it('refuses --workspace, naming the workspace-wide flag', async () => {
    const h = harness({});
    expect(await h.run(['mono', '--workspace', '--broker', 'redis'])).toBe(2);
    expect(h.errText()).toContain('--transport');
    expect(h.fs.writes).toEqual([]);
  });

  it('accepts memory everywhere the flag is accepted and rewrites nothing', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'microservice', '--broker', 'memory'])).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    expect(config).toContain('MessagingPlugin()');
    expect(config).not.toContain('broker:');
    expect(h.fs.has('/work/svc/docker/compose.yaml')).toBe(false);
  });
});
