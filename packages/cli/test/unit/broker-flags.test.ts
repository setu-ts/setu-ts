import { describe, expect, it } from 'vitest';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runNewCommand } from '../../src/commands/new.ts';
import { listBrokers, listQueues, listTransports } from '../../src/workspace/transport.ts';
import type { TransportSpec } from '../../src/workspace/transport.ts';
import {
  missingComposeServices,
  withBrokerArgs,
  withQueueArgs,
} from '../../src/templates/broker.ts';
import { workspaceProfile } from '../../src/workspace/runtime-profile.ts';
import { resolveHost } from '../../src/templates/project-files.ts';
import { getTemplate } from '../../src/templates/registry.ts';

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
  for (const spec of listTransports()) {
    for (const flag of ['broker', 'queue'] as const) {
      const builder = flag === 'broker' ? spec.messagingArgs : spec.queueArgs;
      if (builder === undefined) continue;
      for (const runtime of ['node', 'deno'] as const) {
        it(`renders full-stack ${flag} ${spec.name} with clients, dotenv and Compose on ${runtime}`, async () => {
          const h = harness();
          expect(
            await h.run([
              'portal',
              '--template',
              'full-stack',
              '--runtime',
              runtime,
              `--${flag}`,
              spec.name,
            ]),
          ).toBe(0);
          const config = h.fs.read('/work/portal/setu.config.ts');
          expect(config).toContain(`${flag === 'broker' ? 'messaging' : 'queue'}: {`);
          expect(config).toContain(`'${spec.connection!.variable}'`);
          expect(config).toContain('config.get<string>(');
          for (const client of (flag === 'broker' ? spec.messagingClients : spec.queueClients) ??
            []) {
            expect(
              h.fs.read(`/work/portal/${runtime === 'deno' ? 'deno.json' : 'package.json'}`),
            ).toContain(client);
          }
          expect(h.fs.read('/work/portal/.env')).toContain(
            `${spec.connection!.variable}=${spec.connection!.localDefault}`,
          );
          expect(h.fs.read('/work/portal/.env.example')).toContain(`${spec.connection!.variable}=`);
          expect(h.fs.read('/work/portal/docker/compose.yaml')).toContain('services:');
        });
      }
    }
  }
  it('renders the redis-streams wiring with the environment read', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'microservice', '--broker', 'redis'])).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    expect(config).toContain('{');
    expect(config).toContain("broker: 'redis-streams'");
    expect(config).toContain('process.env.REDIS_URL');
    expect(config).toContain("'redis://127.0.0.1:6379'");
  });

  it('renders the NATS stream subject set and its README note (V9-17)', async () => {
    const h = harness();
    expect(await h.run(['svc', '--template', 'microservice', '--broker', 'nats'])).toBe(0);
    const config = h.fs.read('/work/svc/setu.config.ts');
    expect(config).toContain("broker: 'nats'");
    expect(config).toContain("streamSubjects: ['app.>', 'rr.req.app.>', 'rr.inbox.>']");
    // Pinned as one exact block, at the indentation the config renderer places a
    // plugin call: the multi-line form is what `deno fmt`/Prettier produce, so a
    // one-line regression is a scaffold that fails its own format check.
    expect(config).toContain(
      [
        '      MessagingPlugin({',
        "        broker: 'nats',",
        "        url: process.env.NATS_URL ?? 'nats://127.0.0.1:4222',",
        "        streamSubjects: ['app.>', 'rr.req.app.>', 'rr.inbox.>'],",
        '      }),',
      ].join('\n'),
    );
    // The scope is an operational fact the developer cannot guess, so it is in
    // the standalone README as well as the workspace one.
    const readme = h.fs.read('/work/svc/README.md');
    expect(readme).toContain('must start with `app.`');
    expect(readme).toContain('MESSAGING');
    // Wrapped to the generated width with the inline code span kept whole, which
    // is what `deno fmt --check` on a fresh scaffold requires.
    expect(readme).toContain(
      'must set\n`topic: ' + "'app.realtime'" + '` — its default `setu-ts.realtime`',
    );
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
    expect(config).toContain('process.env.REDIS_URL');
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
    expect(readme.indexOf('## Local transport services')).toBeLessThan(readme.indexOf('## Run'));

    // Every broker arm declares a backing service — a selection without one
    // would scaffold a project that cannot boot.
    for (const name of listBrokers()) {
      if (name === 'memory') continue;
      const h2 = harness();
      const code = await h2.run(['svc', '--template', 'microservice', '--broker', name]);
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

describe('the transport note carried by both overlay arms', () => {
  // No registered transport declares a note AND both arms, but both overlays
  // read the same `connection.note`, so a spec that did would print the
  // paragraph twice without the guard. Driven directly rather than left as an
  // assumption about which arms can coexist.
  const spec: TransportSpec = {
    name: 'redis',
    description: 'synthetic transport with one note and both arms',
    plugins: [],
    messagingArgs: () => `{ broker: 'redis-streams' }`,
    queueArgs: () => `{ adapter: 'redis' }`,
    connection: {
      variable: 'REDIS_URL',
      localDefault: 'redis://127.0.0.1:6379',
      urlOverridable: true,
      note: 'Start the broker before the app.',
    },
  };

  it('appends the note once when both arms apply', () => {
    const host = resolveHost(getTemplate('microservice')!, 'deno');
    const afterBroker = withBrokerArgs(host, spec, workspaceProfile('deno'));
    expect(afterBroker.transportNotes).toEqual(['Start the broker before the app.']);

    const afterQueue = withQueueArgs(afterBroker, spec, workspaceProfile('deno'));
    expect(afterQueue.transportNotes).toEqual(['Start the broker before the app.']);
  });

  it('treats absent client lists as optional while still rewriting', () => {
    const host = resolveHost(getTemplate('microservice')!, 'deno');
    const afterBroker = withBrokerArgs(host, spec, workspaceProfile('deno'));
    const afterQueue = withQueueArgs(afterBroker, spec, workspaceProfile('deno'));

    expect(afterBroker.plugins.some((wiring) => wiring.pkg === 'messaging-plugin')).toBe(true);
    expect(afterQueue.plugins.some((wiring) => wiring.pkg === 'queue-plugin')).toBe(true);
  });
});

describe('missingComposeServices (PR #519 review)', () => {
  for (const spec of listTransports().filter((arm) => arm.compose !== undefined)) {
    it(`reports ${spec.name} as missing from a file without it, and nothing once present`, () => {
      const block = spec.compose!.services.replace(/\n$/, '');
      expect(missingComposeServices('services:\n  other:\n    image: x\n', spec)).toBe(block);
      expect(missingComposeServices(`services:\n${block}\n`, spec)).toBeUndefined();
    });
  }
  it('reports an arm when only some of its services are present', () => {
    const multi = listTransports()
      .map((arm) => ({
        arm,
        names: [...(arm.compose?.services ?? '').matchAll(/^ {2}([\w-]+):\s*$/gm)].map(
          (m) => m[1]!,
        ),
      }))
      .filter(({ names }) => names.length > 1);
    expect(multi.map(({ arm }) => arm.name)).toContain('service-bus');
    for (const { arm, names } of multi) {
      const partial = `services:\n  ${names[0]}:\n    image: x\n`;
      expect(missingComposeServices(partial, arm), arm.name).toBeDefined();
    }
  });
  it('does not count a same-named entry outside services:', () => {
    const redis = listTransports().find((arm) => arm.name === 'redis')!;
    const lookalike = 'services:\n  other:\n    image: x\nvolumes:\n  redis:\n';
    expect(missingComposeServices(lookalike, redis)).toBeDefined();
    expect(missingComposeServices('volumes:\n  redis:\n', redis)).toBeDefined();
  });
  it('accepts comments, CRLF line endings and any service indentation', () => {
    const redis = listTransports().find((arm) => arm.name === 'redis')!;
    for (const file of [
      'services: # local backing services\n  redis: # the broker\n    image: redis:7\n',
      'services:\r\n  redis:\r\n    image: redis:7\r\n',
      'services:\n    redis:\n        image: redis:7\n',
      'services:\n# a comment at column 0\n  other:\n    image: x\n  redis:\n    image: redis:7\n',
    ]) {
      expect(missingComposeServices(file, redis), JSON.stringify(file)).toBeUndefined();
    }
    // A nested key with the service's name is not a service.
    const nested = 'services:\n  other:\n    redis:\n      image: x\n';
    expect(missingComposeServices(nested, redis)).toBeDefined();
  });
  it('has nothing to report for an arm with no backing service', () => {
    const none = listTransports().find((arm) => arm.compose === undefined)!;
    expect(missingComposeServices('services:\n', none)).toBeUndefined();
  });
});
