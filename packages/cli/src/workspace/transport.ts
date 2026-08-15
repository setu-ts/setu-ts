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
import type { GeneratedFile } from '../utils/file-writer.ts';
import type { WorkspaceRuntimeProfile } from './runtime-profile.ts';
import {
  PROTO_IMPORTS,
  PROTO_TASK,
  PROTO_TASK_COMMAND,
  protoToolchainFiles,
} from './proto-toolchain.ts';

/**
 * The inter-service transports `setu new --workspace --transport` accepts.
 *
 * `pubsub` and `service-bus` were originally left out because each needs a value
 * no scaffold can invent — a GCP project id, an Azure connection string — and a
 * generated empty string is a dead option that fails at the first call rather
 * than at scaffold time. What closes that is not inventing the value:
 * {@linkcode TransportSpec.connection} reads it from the ENVIRONMENT and falls
 * back to the vendor's own local-emulator setting, so a scaffolded workspace runs
 * against an emulator with no configuration and against the real service with one
 * variable set.
 */
export const TRANSPORTS = [
  'http',
  'grpc',
  'memory',
  'redis',
  'rabbitmq',
  'nats',
  'kafka',
  'pubsub',
  'service-bus',
] as const;

/** An inter-service transport accepted by `--transport`. */
export type TransportName = (typeof TRANSPORTS)[number];

/** The transport a workspace uses when `--transport` is not given. */
export const DEFAULT_TRANSPORT: TransportName = 'http';

/**
 * How a transport's connection value reaches the running member.
 *
 * ONE mechanism for every transport that has such a value, and that matters more
 * than it looks. The broker arms used to interpolate a literal
 * (`url: 'redis://127.0.0.1:6379'`), which is unreachable from inside a container:
 * two Compose services do not share a loopback interface, so a member started by
 * the generated stack would dial its own container and fail at `app.start()`. An
 * environment read with the local value as its FALLBACK serves both — `deno task
 * dev` on the host gets `127.0.0.1`, and the Compose stack overrides the variable
 * with the broker's service name.
 */
export interface TransportConnection {
  /** The environment variable the generated wiring reads. */
  readonly variable: string;
  /**
   * The value baked in as the fallback: what the broker's official container
   * listens on locally, for the same reason the discovery map says `127.0.0.1` —
   * the CLI knows the local development topology and nothing else.
   */
  readonly localDefault: string;
  /**
   * Whether `--transport-url` may replace {@linkcode localDefault}.
   *
   * False for the two arms whose connection value is not an endpoint: a GCP
   * **project id** is a name, and an Azure **connection string** carries a
   * shared-access key. `--transport-url` is refused for those with a message
   * naming the variable, rather than silently storing a URL nothing addresses.
   */
  readonly urlOverridable: boolean;
  /** An operational fact the generated README has to carry. Omitted → none. */
  readonly note?: string;
}

/** A transport's backing service in the generated Compose stack. */
export interface ComposeBacking {
  /**
   * Service definitions, rendered as YAML at two-space indentation so they nest
   * directly under Compose's `services:` key.
   */
  readonly services: string;
  /**
   * Service names each member must wait for.
   *
   * A member that starts before its broker accepts connections fails at
   * `app.start()`, because the plugin connects during registration and does not
   * retry — so this is ordering the stack needs, not a nicety.
   */
  readonly dependsOn: readonly string[];
  /**
   * The `depends_on` condition to wait for.
   *
   * `service_healthy` wherever the image can actually be probed; Compose REFUSES
   * to start a stack whose dependency has that condition and no healthcheck, so
   * this cannot be a blanket default. The images that ship no shell to probe with
   * (the NATS binary image is one) get `service_started`, and the member services
   * carry `restart` for exactly that gap: losing the race means the member exits,
   * and Compose brings it back until the broker answers.
   */
  readonly condition: 'service_healthy' | 'service_started';
  /**
   * Environment every member service carries inside the stack, over and above the
   * transport's own connection variable.
   */
  readonly memberEnv: Readonly<Record<string, string>>;
  /** Extra files the backing service needs, relative to the workspace root. */
  readonly files?: readonly GeneratedFile[];
}

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
   * Receives the connection value as an EXPRESSION rather than as a string, so
   * each arm places the environment read inside its own option shape — `url`,
   * `brokers` (a list), `projectId`, `connectionString`.
   *
   * @param connection - Source for the connection value
   * @returns The argument list, without the enclosing parentheses
   */
  readonly messagingArgs?: (connection: string) => string;
  /**
   * The `QueuePlugin` argument literal this transport needs, rendered as source.
   * Omitted → the template's bare `QueuePlugin()` is left alone.
   *
   * Present only for the transports the QUEUE supports, which is a smaller set
   * than the brokers: `QueueAdapterType` is
   * `'memory' | 'redis' | 'rabbitmq' | 'sqs'`, so NATS, Kafka, Pub/Sub and
   * Service Bus have no queue arm and keep the in-memory default.
   *
   * X2-3: `--transport rabbitmq` correctly rewrote `MessagingPlugin` and then
   * left `QueuePlugin()` on memory — so in the one template built for
   * distributed work, background jobs were process-local: lost on restart,
   * invisible to a second replica, and unaffected by the broker the workspace
   * was explicitly pointed at. Everything needed was already known to the CLI.
   *
   * @param connection - Source for the connection value
   * @returns The argument list, without the enclosing parentheses
   */
  readonly queueArgs?: (connection: string) => string;
  /**
   * Where the connection value comes from. Omitted → the transport has none
   * (`http`, `grpc`, `memory`).
   */
  readonly connection?: TransportConnection;
  /**
   * What this transport's backing service looks like in the generated Compose
   * stack.
   *
   * Declared HERE rather than in the Compose renderer, so the transport is one
   * source of truth: the arm that rewrites `MessagingPlugin`'s arguments is the
   * same arm that says what has to be running for those arguments to mean
   * anything. A renderer-side switch would let a transport be added with a broker
   * nothing starts — which is the state every broker transport was in before this,
   * where the README named an endpoint and nothing served it.
   *
   * Omitted → the transport needs no backing service.
   */
  readonly compose?: ComposeBacking;
  /**
   * Extra source files every member of this workspace gets.
   *
   * A function of the member's name, because the files it produces are named
   * after the service: a proto package is `<member>.v1`, and a fixed one would
   * put two members' messages in the same namespace.
   *
   * @param member - The member's kebab-case name
   * @returns Files relative to the member root
   */
  readonly memberFiles?: (member: string) => readonly GeneratedFile[];
  /** Tasks merged into every member's `deno.json`, for what those files need. */
  readonly memberTasks?: Readonly<Record<string, string>>;
  /**
   * Import-map entries merged into every member's `deno.json`.
   *
   * Needed because {@linkcode TransportSpec.memberFiles} can produce source that
   * imports something the framework does not: the Protobuf-ES descriptors the gRPC
   * toolchain generates import `@bufbuild/protobuf/codegenv2`, and without the
   * mapping the member cannot compile the file its own task just wrote — measured,
   * as `Import "@bufbuild/protobuf/codegenv2" not a dependency and not in import
   * map`.
   */
  readonly memberImports?: Readonly<Record<string, string>>;
}

/**
 * Microsoft's documented connection string for the Service Bus emulator.
 *
 * A public constant rather than a secret — `UseDevelopmentEmulator=true` is what
 * makes the SDK talk to a local container, and the key is the same fixed string
 * in every emulator's documentation. It is still read through the environment
 * variable first, so a real deployment never carries it.
 */
const EMULATOR_SERVICE_BUS_CONNECTION =
  'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;' +
  'SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;';

/**
 * The subscription name every member's broker consumes under.
 *
 * `messaging-plugin`'s own default, repeated here because the Service Bus
 * emulator creates NO entities at run time: each topic in the generated
 * `Config.json` needs a subscription of exactly this name, or `subscribe` fails
 * against an entity that does not exist. Read from the broker source, not
 * guessed — `service-bus-broker.ts` declares it as `DEFAULT_QUEUE`.
 */
const DEFAULT_BROKER_SUBSCRIPTION = 'messaging-consumers';

/** The SA password the Service Bus emulator's SQL sidecar starts with. */
const SQL_EDGE_PASSWORD_VARIABLE = 'MSSQL_SA_PASSWORD';

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
    // emits a toolchain for rather than generating itself.
    description: 'Members co-serve Connect/gRPC on their own port, alongside HTTP',
    plugins: [{ pkg: 'grpc-plugin', symbol: 'GrpcPlugin' }],
    // The health service needs none of this — the plugin carries that descriptor
    // itself. Serving the member's OWN protos needs a compiler, so the toolchain
    // ships instead of the descriptors.
    memberFiles: (member) => protoToolchainFiles(`${member.replaceAll('-', '_')}.v1`),
    memberTasks: { [PROTO_TASK]: PROTO_TASK_COMMAND },
    memberImports: PROTO_IMPORTS,
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
    messagingArgs: (connection) => `{ broker: 'redis-streams', url: ${connection} }`,
    queueArgs: (connection) => `{ adapter: 'redis', url: ${connection} }`,
    connection: {
      variable: 'REDIS_URL',
      localDefault: 'redis://127.0.0.1:6379',
      urlOverridable: true,
    },
    compose: {
      services: `  redis:
    image: redis:7
    ports:
      - '\${REDIS_PORT:-6379}:6379'
    healthcheck:
      # Members wait on this: the messaging plugin connects during registration,
      # so a member that starts first fails at app.start() rather than retrying.
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 5
`,
      dependsOn: ['redis'],
      condition: 'service_healthy',
      memberEnv: { REDIS_URL: 'redis://redis:6379' },
    },
  },
  ['rabbitmq']: {
    name: 'rabbitmq',
    description: 'RabbitMQ broker shared by every member',
    plugins: [],
    messagingArgs: (connection) => `{ broker: 'rabbitmq', url: ${connection} }`,
    queueArgs: (connection) => `{ adapter: 'rabbitmq', url: ${connection} }`,
    connection: {
      variable: 'RABBITMQ_URL',
      localDefault: 'amqp://127.0.0.1:5672',
      urlOverridable: true,
    },
    compose: {
      services: `  rabbitmq:
    image: rabbitmq:4-management
    ports:
      - '\${RABBITMQ_PORT:-5672}:5672'
      - '\${RABBITMQ_UI_PORT:-15672}:15672'
    healthcheck:
      test: ['CMD', 'rabbitmq-diagnostics', '-q', 'ping']
      interval: 10s
      timeout: 5s
      retries: 10
`,
      dependsOn: ['rabbitmq'],
      condition: 'service_healthy',
      memberEnv: { RABBITMQ_URL: 'amqp://rabbitmq:5672' },
    },
  },
  ['nats']: {
    name: 'nats',
    description: 'NATS broker shared by every member',
    plugins: [],
    messagingArgs: (connection) => `{ broker: 'nats', url: ${connection} }`,
    connection: {
      variable: 'NATS_URL',
      localDefault: 'nats://127.0.0.1:4222',
      urlOverridable: true,
    },
    compose: {
      services: `  nats:
    image: nats:2
    # JetStream is not optional for this broker: NatsBroker publishes into a
    # stream, and a server started without -js refuses the stream creation.
    command: ['-js']
    ports:
      - '\${NATS_PORT:-4222}:4222'
`,
      dependsOn: ['nats'],
      // The official NATS image ships the binary and no shell, so there is
      // nothing to run a healthcheck with.
      condition: 'service_started',
      memberEnv: { NATS_URL: 'nats://nats:4222' },
    },
  },
  ['kafka']: {
    name: 'kafka',
    // `brokers` is a LIST on this arm, not a `url` — the one broker whose option
    // shape differs, which is why each spec renders its own literal instead of a
    // shared `{ broker, url }` template.
    description: 'Kafka broker shared by every member',
    plugins: [],
    messagingArgs: (connection) => `{ broker: 'kafka', brokers: [${connection}] }`,
    connection: {
      variable: 'KAFKA_BROKERS',
      localDefault: '127.0.0.1:9092',
      urlOverridable: true,
    },
    compose: {
      services: `  kafka:
    image: apache/kafka:3.9.0
    ports:
      - '\${KAFKA_PORT:-9092}:9092'
    environment:
      # KRaft single-node: no ZooKeeper service to run beside it. Two listeners
      # because the advertised address differs by caller — members reach it as
      # \`kafka\` on the Compose network, a developer on the host as localhost.
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9094,CONTROLLER://:9093,HOST://:9092
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9094,HOST://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,HOST:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
    healthcheck:
      # The broker answers this only once the controller has elected a leader, so
      # it is a readiness signal rather than a liveness one.
      test: ['CMD', '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', 'kafka:9094', '--list']
      interval: 10s
      timeout: 10s
      retries: 12
`,
      dependsOn: ['kafka'],
      condition: 'service_healthy',
      memberEnv: { KAFKA_BROKERS: 'kafka:9094' },
    },
  },
  ['pubsub']: {
    name: 'pubsub',
    description: 'GCP Pub/Sub shared by every member (emulator by default)',
    plugins: [],
    // The project id, not an endpoint: the SDK takes the EMULATOR host from
    // `PUBSUB_EMULATOR_HOST` itself and skips authentication entirely when it is
    // set, so there is nothing for the plugin options to address. Verified
    // against `PubSubOptions`, which carries `projectId`/`credentials`/`client`
    // and no endpoint of any kind.
    messagingArgs: (connection) =>
      `{\n        broker: 'pubsub',\n        projectId: ${connection},\n      }`,
    connection: {
      variable: 'PUBSUB_PROJECT_ID',
      localDefault: 'setu-local',
      urlOverridable: false,
      note: 'Point the SDK at the emulator by exporting PUBSUB_EMULATOR_HOST=127.0.0.1:8085 — it ' +
        'honours that variable natively and skips authentication when it is set. Topics are NOT ' +
        'created for you: `publish` posts to an existing topic and `subscribe` creates only the ' +
        'subscription, so create each topic before publishing to it (`curl -X PUT ' +
        '$PUBSUB_EMULATOR_HOST/v1/projects/$PUBSUB_PROJECT_ID/topics/<name>` against the ' +
        'emulator, `gcloud pubsub topics create` against a real project).',
    },
    compose: {
      services: `  pubsub:
    # The emulator ships inside the gcloud CLI image; there is no smaller one.
    image: gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators
    command:
      - gcloud
      - beta
      - emulators
      - pubsub
      - start
      - --project=\${PUBSUB_PROJECT_ID:-setu-local}
      - --host-port=0.0.0.0:8085
    ports:
      - '\${PUBSUB_PORT:-8085}:8085'
`,
      dependsOn: ['pubsub'],
      condition: 'service_started',
      // Both variables: the SDK reads the emulator host itself, and reads it
      // from the environment only — there is no plugin option for it.
      memberEnv: { PUBSUB_EMULATOR_HOST: 'pubsub:8085' },
    },
  },
  ['service-bus']: {
    name: 'service-bus',
    description: 'Azure Service Bus shared by every member (emulator by default)',
    plugins: [],
    // Read from the environment rather than interpolated: a Service Bus
    // connection string carries `SharedAccessKey=…`, so a generated literal would
    // be a secret committed to the repository. The fallback is Microsoft's
    // documented emulator string, whose key is a public constant.
    messagingArgs: (connection) =>
      `{\n        broker: 'service-bus',\n        connectionString: ${connection},\n      }`,
    connection: {
      variable: 'SERVICE_BUS_CONNECTION_STRING',
      localDefault: EMULATOR_SERVICE_BUS_CONNECTION,
      urlOverridable: false,
      note:
        'The emulator creates NO entities at run time: every topic a member uses must be declared ' +
        `in \`docker/servicebus-config.json\` with a \`${DEFAULT_BROKER_SUBSCRIPTION}\` ` +
        "subscription (the broker's default consumer group) before the container starts. It also " +
        'supports no management operations, so brokered request-reply cannot round-trip against ' +
        'it — that path needs a real namespace.',
    },
    compose: {
      services: `  servicebus:
    image: mcr.microsoft.com/azure-messaging/servicebus-emulator:latest
    ports:
      - '\${SERVICE_BUS_PORT:-5672}:5672'
    environment:
      # Microsoft's image refuses to start without an explicit acceptance.
      ACCEPT_EULA: 'Y'
      SQL_SERVER: sqledge
      ${SQL_EDGE_PASSWORD_VARIABLE}: \${${SQL_EDGE_PASSWORD_VARIABLE}:-Setu-Local-Dev-1}
    volumes:
      # Mounted, never baked: the emulator reads its entity list from this file at
      # startup and creates nothing afterwards.
      - ./servicebus-config.json:/ServiceBus_Emulator/ConfigFiles/Config.json:ro
    depends_on:
      sqledge:
        condition: service_started

  sqledge:
    # A sidecar the emulator requires, not a choice: it keeps its state in SQL.
    image: mcr.microsoft.com/azure-sql-edge:latest
    environment:
      ACCEPT_EULA: 'Y'
      ${SQL_EDGE_PASSWORD_VARIABLE}: \${${SQL_EDGE_PASSWORD_VARIABLE}:-Setu-Local-Dev-1}
`,
      dependsOn: ['servicebus'],
      condition: 'service_started',
      memberEnv: {
        SERVICE_BUS_CONNECTION_STRING: 'Endpoint=sb://servicebus;' +
          'SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;' +
          'UseDevelopmentEmulator=true;',
      },
      files: [{
        path: 'docker/servicebus-config.json',
        contents: `${
          JSON.stringify(
            {
              UserConfig: {
                Namespaces: [{
                  Name: 'sbemulatorns',
                  Queues: [],
                  Topics: [{
                    Name: 'orders.created',
                    Properties: { DefaultMessageTimeToLive: 'PT1H' },
                    Subscriptions: [{
                      Name: DEFAULT_BROKER_SUBSCRIPTION,
                      Properties: { LockDuration: 'PT1M', MaxDeliveryCount: 10 },
                    }],
                  }],
                }],
                Logging: { Type: 'File' },
              },
            },
            null,
            2,
          )
        }\n`,
      }],
    },
  },
};

/**
 * Renders a transport's connection value as source: an environment read with the
 * local value as its fallback.
 *
 * `Deno.env.get` rather than a configuration lookup, deliberately: plugin
 * arguments are evaluated when `createApp()` builds the plugin list, which is
 * BEFORE `ConfigPlugin` has registered anything, so nothing else can supply a
 * value at that point. A member's generated `start` task already carries
 * `--allow-env`.
 *
 * @param connection - The transport's connection declaration
 * @param override - The workspace's `transportUrl`, when it set one
 * @returns The expression, as source
 */
export function renderConnection(
  connection: TransportConnection,
  profile: WorkspaceRuntimeProfile,
  override?: string,
): string {
  return profile.envRead(connection.variable, override ?? connection.localDefault);
}

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
