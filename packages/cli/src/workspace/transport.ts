/**
 * The bus a workspace's members publish to and consume from.
 *
 * Every member already reaches its siblings over HTTP through the generated
 * discovery map, and a member may also co-serve gRPC (`rpc.ts`). That is how a
 * service is CALLED. A broker is something else: the microservice template
 * registers `MessagingPlugin()`, whose default broker is IN-MEMORY and therefore
 * process-local, so two generated members publishing and subscribing on the
 * same topic exchange nothing while both report success. Choosing the broker at
 * workspace creation is what closes that.
 *
 * The broker belongs to the WORKSPACE rather than to a member, because members
 * can only meet on a bus they share. A per-member broker would make a workspace
 * whose services silently cannot reach each other trivially expressible. The
 * RPC style carries no such risk — an HTTP member and a gRPC member still reach
 * each other over HTTP — so it is chosen per member (M138).
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import type { WorkspaceRuntimeProfile } from './runtime-profile.ts';
import { nodeRedisClientCall } from '../templates/node-redis.ts';

/**
 * The brokers `setu new --workspace --broker` accepts.
 *
 * `pubsub` and `service-bus` were originally left out because each needs a value
 * no scaffold can invent — a GCP project id, an Azure connection string — and a
 * generated empty string is a dead option that fails at the first call rather
 * than at scaffold time. What closes that is not inventing the value:
 * {@linkcode BrokerSpec.connection} reads it from the ENVIRONMENT and falls
 * back to the vendor's own local-emulator setting, so a scaffolded workspace runs
 * against an emulator with no configuration and against the real service with one
 * variable set.
 */
export const BROKERS = [
  'memory',
  'redis',
  'rabbitmq',
  'nats',
  'kafka',
  'pubsub',
  'service-bus',
] as const;

/** A broker accepted by `--broker`. */
export type BrokerName = (typeof BROKERS)[number];

/** Redis client selected by a scaffold; ioredis remains the default. @since 0.11.0 */
export type RedisClient = 'ioredis' | 'node-redis';

/** The broker a workspace uses when `--broker` is not given: the plugin's own in-process default. */
export const DEFAULT_BROKER: BrokerName = 'memory';

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
   * Whether `--broker-url` may replace {@linkcode localDefault}.
   *
   * False for the two arms whose connection value is not an endpoint: a GCP
   * **project id** is a name, and an Azure **connection string** carries a
   * shared-access key. `--broker-url` is refused for those with a message
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
 * What a broker contributes to every member of the workspace.
 */
export interface BrokerSpec {
  /** Explicit node-redis selection, omitted for the default ioredis arm. */
  readonly redisClient?: 'node-redis';
  /** The `--broker` value that selects it. */
  readonly name: BrokerName;
  /** One line for `--help` and the workspace README. */
  readonly description: string;
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
  /** Redis cache options for a later setu add cache in a workspace member. */
  readonly cacheArgs?: (connection: string) => string;
  /** Redis idempotency-store options for a later setu add idempotency. */
  readonly idempotencyArgs?: (connection: string) => string;
  /** Redis distributed-lock options merged with any generated artifact options. */
  readonly schedulerArgs?: (connection: string) => string;
  /** Redis backplane options for a later setu add realtime-backplane. */
  readonly backplaneArgs?: (connection: string) => string;
  /**
   * Client packages the project needs once {@linkcode messagingArgs} selects this
   * broker. Each is an OPTIONAL peer of `messaging-plugin`, which no package
   * manager installs for the consumer, so the arm declares it in the project
   * itself (`client-dependencies.ts`).
   */
  readonly messagingClients?: readonly string[];
  /** Client packages the project needs once {@linkcode queueArgs} selects this queue. */
  readonly queueClients?: readonly string[];
  /**
   * Where the connection value comes from. Omitted → the transport has none
   * (`memory`).
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

/**
 * The subjects the NATS broker's `MESSAGING` stream owns.
 *
 * Declared once and rendered into every NATS wiring, because the broker has no
 * default: absent `streamSubjects` it creates nothing and fails at startup with
 * `JetStreamStreamError`. The fixed `app` scope is intentional — workspace
 * members share one stream, and only one stream per account may own
 * `rr.inbox.>`. These are the RPC-capable subjects the messaging plugin's own
 * README documents (`rr.req.<topic>` / `rr.inbox.<uuid>`).
 */
const NATS_STREAM_SUBJECTS = ['app.>', 'rr.req.app.>', 'rr.inbox.>'] as const;

/**
 * Re-indents a rendered connection expression by one nesting level.
 *
 * {@linkcode WorkspaceRuntimeProfile.envRead} bakes a FIXED continuation indent
 * into its output (`Deno.env.get('X') ??\n<10 spaces>'fallback'`), which is
 * what `deno fmt` wants for a value sitting directly under a plugin option at
 * eight spaces. Kafka is the one arm that nests the connection inside a bracket
 * — `brokers: [...]` — where the element sits two columns deeper and the
 * formatter therefore wants its continuation two columns deeper too. Emitting
 * the unshifted form made a fresh `--broker kafka` (standalone or workspace)
 * scaffold fail its OWN `deno fmt --check`, which is the bar M63 set.
 *
 * Adds two spaces to every line after the first rather than rewriting a known
 * indent, so it stays correct if a profile ever renders a different one.
 *
 * @param connection - The rendered connection expression
 * @returns The expression, indented for one extra nesting level
 */
function nestConnection(connection: string): string {
  return connection.replaceAll('\n', '\n  ');
}

const BROKER_SPECS: Readonly<Record<BrokerName, BrokerSpec>> = {
  ['memory']: {
    name: 'memory',
    description: 'In-process broker — messages never leave one service (single-service testing)',
  },
  ['redis']: {
    name: 'redis',
    messagingClients: ['ioredis'],
    queueClients: ['ioredis'],
    description: 'Redis Streams broker shared by every member',
    messagingArgs: (connection) => `{ broker: 'redis-streams', url: ${connection} }`,
    queueArgs: (connection) => `{ adapter: 'redis', url: ${connection} }`,
    cacheArgs: (connection) => `{ store: 'redis', options: { url: ${connection} } }`,
    idempotencyArgs: (connection) =>
      `{ store: { type: 'redis', namespace: 'setu', url: ${connection} } }`,
    schedulerArgs: (connection) =>
      `{ distributedLock: { enabled: true, storage: 'redis', url: ${connection} } }`,
    backplaneArgs: (connection) => `{ transport: 'redis', url: ${connection} }`,
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
    messagingClients: ['amqplib'],
    queueClients: ['amqplib'],
    description: 'RabbitMQ broker shared by every member',
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
    messagingClients: ['nats'],
    description: 'NATS broker shared by every member',
    // The stream subject set is mandatory on this arm: `NatsMessagingOptions`
    // has no default, and the broker creates the stream ONLY from the subjects
    // it is given — a NATS server with `-js` alone does not create anything.
    // `app` is a fixed scope because every workspace member shares the one
    // `MESSAGING` stream (cross-member pub/sub needs it): the first member to
    // start creates it and later members use it as is, so a per-member prefix
    // would leave every other member's subjects uncaptured. The RPC subjects are
    // the ones the README documents; `>` alone is refused by NATS, and `*.>`
    // overlaps `$JS.API.>`.
    messagingArgs: (connection) =>
      `{\n        broker: 'nats',\n        url: ${connection},\n        streamSubjects: [${NATS_STREAM_SUBJECTS.map((subject) => `'${subject}'`).join(', ')}],\n      }`,
    connection: {
      variable: 'NATS_URL',
      localDefault: 'nats://127.0.0.1:4222',
      urlOverridable: true,
      note:
        'Every topic published through NATS must start with `app.`. The broker creates its ' +
        '`MESSAGING` stream with the subjects `app.>`, `rr.req.app.>` and `rr.inbox.>` on first ' +
        'start, and uses a pre-existing stream exactly as it is. A `RealtimeBackplanePlugin` on ' +
        "the `'messaging'` transport must set `topic: 'app.realtime'` — its default " +
        '`setu-ts.realtime` falls outside that subject set.',
    },
    compose: {
      services: `  nats:
    image: nats:2
    # JetStream is not optional for this broker: the generated MessagingPlugin
    # passes the stream subjects below, and the plugin creates the MESSAGING
    # stream from them on first start. A server started without -js refuses that
    # creation outright.
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
    messagingClients: ['kafkajs'],
    // `brokers` is a LIST on this arm, not a `url` — the one broker whose option
    // shape differs, which is why each spec renders its own literal instead of a
    // shared `{ broker, url }` template.
    description: 'Kafka broker shared by every member',
    messagingArgs: (connection) =>
      `{\n        broker: 'kafka',\n        brokers: [\n          ${nestConnection(
        connection,
      )},\n        ],\n      }`,
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
    messagingClients: ['@google-cloud/pubsub'],
    description: 'GCP Pub/Sub shared by every member (emulator by default)',
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
      note:
        'Point the SDK at the emulator by exporting PUBSUB_EMULATOR_HOST=127.0.0.1:8085 — it ' +
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
    messagingClients: ['@azure/service-bus'],
    description: 'Azure Service Bus shared by every member (emulator by default)',
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
        SERVICE_BUS_CONNECTION_STRING:
          'Endpoint=sb://servicebus;' +
          'SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;' +
          'UseDevelopmentEmulator=true;',
      },
      files: [
        {
          path: 'docker/servicebus-config.json',
          contents: `${JSON.stringify(
            {
              UserConfig: {
                Namespaces: [
                  {
                    Name: 'sbemulatorns',
                    Queues: [],
                    Topics: [
                      {
                        Name: 'orders.created',
                        Properties: { DefaultMessageTimeToLive: 'PT1H' },
                        Subscriptions: [
                          {
                            Name: DEFAULT_BROKER_SUBSCRIPTION,
                            Properties: { LockDuration: 'PT1M', MaxDeliveryCount: 10 },
                          },
                        ],
                      },
                    ],
                  },
                ],
                Logging: { Type: 'File' },
              },
            },
            null,
            2,
          )}\n`,
        },
      ],
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
 * Reads a transport from the registered ConfigPlugin, including dotenv values.
 * @param connection - The transport's connection declaration
 * @param override - The workspace's replacement fallback
 * @param column - Column at which the expression begins (zero based)
 * @param depth - Indentation of the containing property
 * @returns A config read, wrapped to the generated 100-column budget
 */
export function renderConfigConnection(
  connection: TransportConnection,
  override?: string,
  column = 15,
  depth = 10,
): string {
  const quote = (value: string): string =>
    `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`;
  const variable = quote(connection.variable);
  const fallback = quote(override ?? connection.localDefault);
  const single = `config.get<string>(${variable}, { default: ${fallback} })`;
  if (column + single.length + 1 <= 100) return single;
  // What `deno fmt` and Prettier both print when the call overflows (measured on
  // the Service Bus emulator default, 2026-10-28): the last argument hugs the call,
  // and `default:` breaks onto its own line only when its value still overflows.
  // Callers render in the inline frame and shift the literal two spaces deeper, so
  // the property's final inner column is `depth + 4`.
  const inner = ' '.repeat(depth + 2);
  const property =
    depth + 4 + `default: ${fallback},`.length <= 100
      ? `${inner}default: ${fallback},`
      : `${inner}default:\n${inner}  ${fallback},`;
  return `config.get<string>(${variable}, {\n${property}\n${' '.repeat(depth)}})`;
}

/**
 * Looks up a broker by an UNTRUSTED string — a flag value, or a manifest field.
 *
 * @param name - The `--broker` value
 * @param redisClient - Which Redis driver to render, defaulting to ioredis
 * @returns Its spec, or undefined when no such broker exists
 */
export function getBroker(
  name: string,
  redisClient: RedisClient = 'ioredis',
): BrokerSpec | undefined {
  // `Object.hasOwn` rather than a bare index, so an inherited property name
  // (`constructor`, `__proto__`, `toString`) misses cleanly instead of
  // returning something off `Object.prototype`.
  return Object.hasOwn(BROKER_SPECS, name)
    ? brokerSpec(name as BrokerName, redisClient)
    : undefined;
}

/**
 * Resolves an already-validated broker name to its spec.
 *
 * Total by construction: the record covers the whole union, so a manifest whose
 * broker the reader has accepted needs no "cannot happen" branch here.
 *
 * @param name - A validated broker name
 * @param redisClient - Which Redis driver to render, defaulting to ioredis
 * @returns Its spec
 */
export function brokerSpec(name: BrokerName, redisClient: RedisClient = 'ioredis'): BrokerSpec {
  const spec = BROKER_SPECS[name];
  if (name !== 'redis' || redisClient === 'ioredis') return spec;
  const client = nodeRedisClientCall;
  return {
    ...spec,
    redisClient: 'node-redis',
    messagingClients: ['redis'],
    queueClients: ['redis'],
    messagingArgs: (connection) => `{ broker: 'redis-streams', client: ${client(connection)} }`,
    queueArgs: (connection) => `{ adapter: 'redis', client: ${client(connection)} }`,
    cacheArgs: (connection) => `{ store: 'redis', options: { client: ${client(connection)} } }`,
    idempotencyArgs: (connection) =>
      `{ store: { type: 'redis', namespace: 'setu', client: ${client(connection)} } }`,
    schedulerArgs: (connection) =>
      `{ distributedLock: { enabled: true, storage: 'redis', client: ${client(connection)} } }`,
    backplaneArgs: (connection) =>
      `{ transport: 'redis', client: ${client(connection)}, subscriber: ${client(connection)} }`,
  };
}

/**
 * Lists every name `setu new --broker` accepts, derived from the registry.
 *
 * Every arm declaring a {@linkcode BrokerSpec.messagingArgs} renderer, plus
 * `memory` — the default the plugin already takes, which is accepted everywhere
 * the flag is accepted and rewrites nothing. Derived rather than hand-written
 * so help text, refusal text and validation cannot drift from the arms that
 * exist.
 *
 * @returns Each accepted broker name, in registry order
 */
export function listBrokers(): readonly BrokerName[] {
  return BROKERS.filter(
    (name) => name === 'memory' || BROKER_SPECS[name].messagingArgs !== undefined,
  );
}

/**
 * Lists every name `setu new --queue` accepts, derived from the registry.
 *
 * Every arm declaring a {@linkcode BrokerSpec.queueArgs} renderer, plus
 * `memory`. A smaller set than {@linkcode listBrokers}: the queue supports
 * fewer backends than the brokers.
 *
 * @returns Each accepted queue backend name, in registry order
 */
export function listQueues(): readonly BrokerName[] {
  return BROKERS.filter((name) => name === 'memory' || BROKER_SPECS[name].queueArgs !== undefined);
}
