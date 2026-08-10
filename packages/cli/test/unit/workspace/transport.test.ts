import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  DEFAULT_TRANSPORT,
  getTransport,
  listTransports,
  TRANSPORT_ALIASES,
  TRANSPORTS,
  transportSpec,
} from '../../../src/workspace/transport.ts';

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

    it('is exactly the set with an endpoint to address', () => {
      expect(brokers.map((t) => t.name)).toEqual(['redis', 'rabbitmq', 'nats', 'kafka']);
      for (const broker of brokers) {
        expect(broker.defaultEndpoint).toBeDefined();
      }
    });

    it('names the discriminant the messaging plugin expects', () => {
      expect(transportSpec('redis').messagingArgs?.('redis://h:1')).toBe(
        "{ broker: 'redis-streams', url: 'redis://h:1' }",
      );
      expect(transportSpec('rabbitmq').messagingArgs?.('amqp://h:1')).toBe(
        "{ broker: 'rabbitmq', url: 'amqp://h:1' }",
      );
      expect(transportSpec('nats').messagingArgs?.('nats://h:1')).toBe(
        "{ broker: 'nats', url: 'nats://h:1' }",
      );
    });

    // Kafka is the one arm whose option is a LIST, not a `url` — rendering it
    // like the others would produce a literal the union rejects.
    it('renders kafka as a broker list, not a url', () => {
      expect(transportSpec('kafka').messagingArgs?.('h:9092')).toBe(
        "{ broker: 'kafka', brokers: ['h:9092'] }",
      );
    });

    it('registers no extra plugin — it rewrites the template own wiring', () => {
      for (const broker of brokers) {
        expect(broker.plugins).toEqual([]);
      }
    });
  });

  // A bare `GrpcPlugin()` serves `grpc.health.v1.Health/Check` immediately, so
  // registering it is the whole of what this transport needs.
  it('adds the gRPC plugin and nothing else for the grpc arm', () => {
    expect(transportSpec('grpc').plugins).toEqual([
      { pkg: 'grpc-plugin', symbol: 'GrpcPlugin' },
    ]);
    expect(transportSpec('grpc').messagingArgs).toBeUndefined();
  });

  // `memory` exists so the in-process default is a CHOICE rather than a
  // surprise: it is what the microservice template already does, named.
  it('leaves memory as the plugin own default', () => {
    expect(transportSpec('memory').plugins).toEqual([]);
    expect(transportSpec('memory').messagingArgs).toBeUndefined();
    expect(transportSpec('memory').defaultEndpoint).toBeUndefined();
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
