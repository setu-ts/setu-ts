import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  DEFAULT_TRANSPORT,
  getTransport,
  listTransports,
  renderConnection,
  TRANSPORT_ALIASES,
  TRANSPORTS,
  transportSpec,
} from '../../../src/workspace/transport.ts';
import { workspaceProfile } from '../../../src/workspace/runtime-profile.ts';

describe('the transport registry', () => {
  it('lists every declared transport, in order', () => {
    expect(listTransports().map((t) => t.name)).toEqual([...TRANSPORTS]);
  });

  it('defaults to http, so an upgrade changes nothing', () => {
    expect(DEFAULT_TRANSPORT).toBe('http');
    expect(transportSpec('http').plugins).toEqual([]);
    expect(transportSpec('http').messagingArgs).toBeUndefined();
  });

  it('resolves every name it declares', () => {
    for (const name of TRANSPORTS) {
      expect(transportSpec(name).name).toBe(name);
    }
  });

  it('misses cleanly on an inherited property name', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(getTransport(name)).toBeUndefined();
    }
  });

  it('misses on an unknown name', () => {
    expect(getTransport('carrier-pigeon')).toBeUndefined();
  });

  // Every broker arm must render a literal the plugin's discriminated union
  // accepts. The GENERATED project is where that is really proven (the e2e
  // type-checks it); this pins the shape so a typo is caught here first.
  describe('the broker arms', () => {
    const brokers = listTransports().filter((t) => t.messagingArgs !== undefined);

    it('is exactly the set with a connection value', () => {
      expect(brokers.map((t) => t.name)).toEqual([
        'redis',
        'rabbitmq',
        'nats',
        'kafka',
        'pubsub',
        'service-bus',
      ]);
      // Both or neither. `member-host.ts` renders arguments only when the pair is
      // present, so an arm declaring one without the other would silently leave
      // its members on the in-process broker.
      for (const broker of brokers) {
        expect(broker.connection).toBeDefined();
      }
    });

    it('names the discriminant the messaging plugin expects', () => {
      expect(transportSpec('redis').messagingArgs?.('CONN')).toBe(
        "{ broker: 'redis-streams', url: CONN }",
      );
      expect(transportSpec('rabbitmq').messagingArgs?.('CONN')).toBe(
        "{ broker: 'rabbitmq', url: CONN }",
      );
      expect(transportSpec('nats').messagingArgs?.('CONN')).toBe(
        "{ broker: 'nats', url: CONN }",
      );
      expect(transportSpec('pubsub').messagingArgs?.('CONN')).toContain("broker: 'pubsub'");
      expect(transportSpec('pubsub').messagingArgs?.('CONN')).toContain('projectId: CONN');
      expect(transportSpec('service-bus').messagingArgs?.('CONN')).toContain(
        "broker: 'service-bus'",
      );
      expect(transportSpec('service-bus').messagingArgs?.('CONN')).toContain(
        'connectionString: CONN',
      );
    });

    // Kafka is the one arm whose option is a LIST, not a `url` — rendering it
    // like the others would produce a literal the union rejects.
    it('renders kafka as a broker list, not a url', () => {
      // Broken across lines, and the connection re-indented one level, because
      // this is the ONE arm nesting it inside a bracket: `deno fmt` wants the
      // element two columns deeper than a plain option value, and the
      // single-line form made a `--transport kafka` scaffold fail its own
      // `deno fmt --check`. `nestConnection` shifts every continuation line, so
      // a multi-line connection lands where the formatter puts it.
      expect(transportSpec('kafka').messagingArgs?.('CONN')).toBe(
        "{\n        broker: 'kafka',\n        brokers: [\n          CONN,\n        ],\n      }",
      );
      expect(transportSpec('kafka').messagingArgs?.('A ??\n          B')).toBe(
        "{\n        broker: 'kafka',\n        brokers: [\n          A ??\n            B,\n        ],\n      }",
      );
    });

    it('registers no extra plugin — it rewrites the template own wiring', () => {
      for (const broker of brokers) {
        expect(broker.plugins).toEqual([]);
      }
    });

    // The whole point of the connection indirection: a literal endpoint is
    // unreachable from inside a container, where loopback is the container itself.
    it('reads its connection value from the environment, with the local fallback', () => {
      const redis = transportSpec('redis').connection;
      expect(renderConnection(redis!, workspaceProfile('deno'))).toBe(
        `Deno.env.get('REDIS_URL') ??\n          'redis://127.0.0.1:6379'`,
      );
      // `--transport-url` replaces the FALLBACK, not the variable: an override
      // still has to lose to the environment inside a deployed stack.
      expect(renderConnection(redis!, workspaceProfile('deno'), 'redis://elsewhere:6379'))
        .toContain(
          `Deno.env.get('REDIS_URL')`,
        );
      expect(renderConnection(redis!, workspaceProfile('deno'), 'redis://elsewhere:6379'))
        .toContain(
          'redis://elsewhere:6379',
        );
    });

    // A GCP project id is a name and a Service Bus connection string carries a
    // key; neither is a URL, so `--transport-url` is refused for both rather than
    // stored as something no generated config addresses.
    it('marks the two cloud arms as not URL-overridable', () => {
      expect(transportSpec('pubsub').connection?.urlOverridable).toBe(false);
      expect(transportSpec('service-bus').connection?.urlOverridable).toBe(false);
      for (const name of ['redis', 'rabbitmq', 'nats', 'kafka'] as const) {
        expect(transportSpec(name).connection?.urlOverridable).toBe(true);
      }
    });

    // The emulator fallback is what makes a scaffolded workspace run with no
    // configuration at all, so it must be the vendor's documented value.
    it('falls back to the vendors local emulator settings', () => {
      expect(transportSpec('pubsub').connection?.localDefault).toBe('setu-local');
      expect(transportSpec('service-bus').connection?.localDefault).toContain(
        'UseDevelopmentEmulator=true',
      );
      // Both carry an operational fact a developer cannot guess: Pub/Sub does not
      // create topics, and the Service Bus emulator creates no entities at all.
      expect(transportSpec('pubsub').connection?.note).toContain('Topics are NOT');
      expect(transportSpec('service-bus').connection?.note).toContain('NO entities');
    });
  });

  // A transport that rewrites a member's broker wiring but starts no broker is
  // exactly the state every broker arm was in before this: a README naming an
  // endpoint nothing served.
  describe('the Compose backing', () => {
    it('is declared by every transport with a connection', () => {
      for (const transport of listTransports()) {
        if (transport.connection === undefined) {
          expect(transport.compose).toBeUndefined();
          continue;
        }
        expect(transport.compose).toBeDefined();
        expect(transport.compose?.services).toContain('image:');
        expect(transport.compose?.dependsOn.length).toBeGreaterThan(0);
      }
    });

    // Compose REFUSES to start a stack whose dependency is waited on with
    // `service_healthy` and has no healthcheck, so the two must agree.
    it('waits on service_healthy only where a healthcheck exists', () => {
      for (const transport of listTransports()) {
        const backing = transport.compose;
        if (backing === undefined) continue;
        if (backing.condition === 'service_healthy') {
          expect(backing.services).toContain('healthcheck:');
        }
      }
    });

    // Inside the stack the broker is reachable by SERVICE NAME, never by the
    // loopback address baked in for a developer running `deno task dev`.
    it('overrides the connection variable with the service name', () => {
      for (const transport of listTransports()) {
        const backing = transport.compose;
        if (backing === undefined) continue;
        const values = Object.values(backing.memberEnv);
        expect(values.length).toBeGreaterThan(0);
        for (const value of values) expect(value).not.toContain('127.0.0.1');
      }
    });

    // The emulator creates nothing at run time, so its entity list has to ship.
    it('ships the Service Bus emulator entity config', () => {
      const files = transportSpec('service-bus').compose?.files ?? [];
      expect(files.map((f) => f.path)).toEqual(['docker/servicebus-config.json']);
      const config = JSON.parse(files[0]?.contents ?? '{}') as {
        UserConfig: { Namespaces: { Topics: { Subscriptions: { Name: string }[] }[] }[] };
      };
      // The subscription name must be the broker's own default, or `subscribe`
      // asks the emulator for an entity that does not exist.
      expect(config.UserConfig.Namespaces[0]?.Topics[0]?.Subscriptions[0]?.Name).toBe(
        'messaging-consumers',
      );
    });
  });

  // A stable mount lets the full-stack CSRF policy exempt only RPC requests.
  it('adds the gRPC plugin and nothing else for the grpc arm', () => {
    expect(transportSpec('grpc').plugins).toEqual([
      { pkg: 'grpc-plugin', symbol: 'GrpcPlugin', args: "{ basePath: '/grpc' }" },
    ]);
    expect(transportSpec('grpc').messagingArgs).toBeUndefined();
  });

  // `memory` exists so the in-process default is a CHOICE rather than a
  // surprise: it is what the microservice template already does, named.
  it('leaves memory as the plugin own default', () => {
    expect(transportSpec('memory').plugins).toEqual([]);
    expect(transportSpec('memory').messagingArgs).toBeUndefined();
    expect(transportSpec('memory').connection).toBeUndefined();
  });

  it('maps tcp to http rather than inventing a transport', () => {
    expect(TRANSPORT_ALIASES['tcp']).toBe('http');
    expect(getTransport('tcp')).toBeUndefined();
  });

  it('gives every transport a description for the help text', () => {
    for (const transport of listTransports()) {
      expect(transport.description.length).toBeGreaterThan(10);
    }
  });
});

// X2-3. `--transport rabbitmq` rewrote MessagingPlugin correctly and then left
// `QueuePlugin()` on the memory adapter — so in the one template built for
// distributed work, background jobs were process-local: lost on restart,
// invisible to a second replica, and unaffected by the broker the workspace was
// explicitly pointed at.
describe('the queue arm of a transport', () => {
  /** The adapters `QueueAdapterType` supports, from the queue plugin's source. */
  const QUEUE_CAPABLE = ['redis', 'rabbitmq'] as const;

  for (const name of QUEUE_CAPABLE) {
    it(`derives a ${name} queue adapter from the transport`, () => {
      const spec = transportSpec(name);
      expect(spec.queueArgs).toBeDefined();
      expect(spec.queueArgs?.('CONNECTION')).toContain(`adapter: '${name}'`);
      // The SAME connection value the broker uses — one datum, so a workspace
      // cannot point its queue at a different server than its bus.
      expect(spec.queueArgs?.('CONNECTION')).toContain('url: CONNECTION');
    });
  }

  it('leaves the queue on memory for a transport the queue cannot serve', () => {
    // `QueueAdapterType` is 'memory' | 'redis' | 'rabbitmq' | 'sqs', so these
    // brokers have no queue adapter at all. Keeping the in-memory default is the
    // honest outcome; inventing one would be a silently wrong backend.
    for (const name of ['nats', 'kafka', 'pubsub', 'service-bus'] as const) {
      expect(transportSpec(name).queueArgs).toBeUndefined();
    }
  });

  it('declares a connection wherever it declares queue arguments', () => {
    // Same pairing the messaging arm is held to: an arm with arguments but no
    // connection would render `url: undefined` into a member's config.
    for (const name of listTransports()) {
      const spec = transportSpec(name.name);
      if (spec.queueArgs === undefined) continue;
      expect(spec.connection).toBeDefined();
    }
  });
});
