/**
 * How a workspace's members talk to each other.
 *
 * Every member already reaches its siblings over HTTP through the generated
 * discovery map. That is one mechanism, and it is not the one a service mesh
 * usually wants: the microservice template registers `MessagingPlugin()`, whose
 * default broker is IN-MEMORY and therefore process-local, so two generated
 * members publishing and subscribing on the same topic exchange nothing while
 * both report success. Choosing the transport at workspace creation is what
 * closes that.
 *
 * The choice belongs to the WORKSPACE rather than to a member, because members
 * can only meet on a bus they share. A per-member flag would make a workspace
 * whose services silently cannot reach each other trivially expressible — the
 * exact failure this milestone exists to remove.
 *
 * @module
 */

import type { Wiring } from '../templates/registry.ts';

/**
 * The inter-service transports `setu new --workspace --transport` accepts.
 *
 * `pubsub` and `service-bus` are deliberately absent though the messaging
 * plugin supports both: each needs a credential (`projectId`,
 * `connectionString`) that no scaffold can invent, and a generated empty string
 * is a dead option that fails at the first call rather than at scaffold time.
 */
export const TRANSPORTS = [
  'http',
  'grpc',
  'memory',
  'redis',
  'rabbitmq',
  'nats',
  'kafka',
] as const;

/** An inter-service transport accepted by `--transport`. */
export type TransportName = (typeof TRANSPORTS)[number];

/** The transport a workspace uses when `--transport` is not given. */
export const DEFAULT_TRANSPORT: TransportName = 'http';

/**
 * What a transport contributes to every member of the workspace.
 */
export interface TransportSpec {
  /** The `--transport` value that selects it. */
  readonly name: TransportName;
  /** One line for `--help` and the workspace README. */
  readonly description: string;
  /**
   * Plugins every member registers on top of its template's set.
   *
   * Empty for the broker arms: the microservice template ALREADY registers
   * `MessagingPlugin`, so a broker rewrites that wiring's arguments rather than
   * appending a second registration — the kernel refuses a duplicate plugin
   * name at `start()`.
   */
  readonly plugins: readonly Wiring[];
  /**
   * The `MessagingPlugin` argument literal this transport needs, rendered as
   * source. Omitted → the template's own wiring is left exactly as it is.
   *
   * @param endpoint - The resolved broker endpoint
   * @returns The argument list, without the enclosing parentheses
   */
  readonly messagingArgs?: (endpoint: string) => string;
  /**
   * Where the broker listens when the workspace does not say.
   *
   * Standard local ports, for the same reason the discovery map says
   * `127.0.0.1`: the CLI knows the local development topology and nothing else,
   * and this is what running the broker's official container gives you.
   * Omitted → the transport has no endpoint (`http`, `grpc`, `memory`).
   */
  readonly defaultEndpoint?: string;
}

/**
 * Every transport, keyed by its flag value.
 *
 * A `Record` typed over the whole {@linkcode TransportName} union rather than a
 * `Map`, so {@linkcode transportSpec} is TOTAL: a manifest's already-validated
 * transport resolves with no "cannot happen" branch to leave permanently
 * uncovered. Untrusted strings go through {@linkcode getTransport}, which owns
 * the prototype-safe lookup a `Map` would otherwise have provided.
 */
const TRANSPORT_SPECS: Readonly<Record<TransportName, TransportSpec>> = {
  ['http']: {
    name: 'http',
    description: 'Members call each other over HTTP, resolved through the discovery map',
    plugins: [],
  },
  ['grpc']: {
    name: 'grpc',
    // Verified by probe, not assumed: a bare `GrpcPlugin()` answers
    // `POST /grpc/grpc.health.v1.Health/Check` with `200 {"status":"SERVING"}`,
    // so a member is callable over Connect the moment it boots — no proto
    // toolchain, no generated descriptors. Serving YOUR OWN protos still needs
    // descriptors from buf/protoc handed to `grpc.addService`, which the CLI
    // cannot generate and does not pretend to.
    description: 'Members co-serve Connect/gRPC on their own port, alongside HTTP',
    plugins: [{ pkg: 'grpc-plugin', symbol: 'GrpcPlugin' }],
  },
  ['memory']: {
    name: 'memory',
    description: 'In-process broker — messages never leave one service (single-service testing)',
    plugins: [],
  },
  ['redis']: {
    name: 'redis',
    description: 'Redis Streams broker shared by every member',
    plugins: [],
    messagingArgs: (endpoint) => `{ broker: 'redis-streams', url: '${endpoint}' }`,
    defaultEndpoint: 'redis://127.0.0.1:6379',
  },
  ['rabbitmq']: {
    name: 'rabbitmq',
    description: 'RabbitMQ broker shared by every member',
    plugins: [],
    messagingArgs: (endpoint) => `{ broker: 'rabbitmq', url: '${endpoint}' }`,
    defaultEndpoint: 'amqp://127.0.0.1:5672',
  },
  ['nats']: {
    name: 'nats',
    description: 'NATS broker shared by every member',
    plugins: [],
    messagingArgs: (endpoint) => `{ broker: 'nats', url: '${endpoint}' }`,
    defaultEndpoint: 'nats://127.0.0.1:4222',
  },
  ['kafka']: {
    name: 'kafka',
    // `brokers` is a LIST on this arm, not a `url` — the one broker whose
    // option shape differs, which is why each spec renders its own literal
    // instead of a shared `{ broker, url }` template.
    description: 'Kafka broker shared by every member',
    plugins: [],
    messagingArgs: (endpoint) => `{ broker: 'kafka', brokers: ['${endpoint}'] }`,
    defaultEndpoint: '127.0.0.1:9092',
  },
};

/**
 * Looks up a transport by an UNTRUSTED string — a flag value, or a manifest
 * field.
 *
 * @param name - The `--transport` value
 * @returns Its spec, or undefined when no such transport exists
 */
export function getTransport(name: string): TransportSpec | undefined {
  // `Object.hasOwn` rather than a bare index, so an inherited property name
  // (`constructor`, `__proto__`, `toString`) misses cleanly instead of
  // returning something off `Object.prototype`.
  return Object.hasOwn(TRANSPORT_SPECS, name) ? TRANSPORT_SPECS[name as TransportName] : undefined;
}

/**
 * Resolves an already-validated transport name to its spec.
 *
 * Total by construction: the record covers the whole union, so a manifest whose
 * transport the reader has accepted needs no "cannot happen" branch here.
 *
 * @param name - A validated transport name
 * @returns Its spec
 */
export function transportSpec(name: TransportName): TransportSpec {
  return TRANSPORT_SPECS[name];
}

/**
 * Lists every transport in registration order.
 *
 * Consumed by the help text, so the documented list cannot drift from the
 * transports that exist.
 *
 * @returns Each transport spec
 */
export function listTransports(): readonly TransportSpec[] {
  return TRANSPORTS.map((name) => TRANSPORT_SPECS[name]);
}

/**
 * The name a user is most likely to reach for that this framework does not
 * have, mapped to what they actually want.
 *
 * There is no raw-TCP transport here: every inter-service path is HTTP over TCP
 * or a broker client over TCP. Refusing with this explanation beats accepting
 * `tcp` and quietly giving them HTTP under another name.
 */
export const TRANSPORT_ALIASES: Readonly<Record<string, TransportName>> = { tcp: 'http' };
