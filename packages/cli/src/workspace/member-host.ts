/**
 * The workspace-member overlay — what makes a member's config read its
 * generated discovery map.
 *
 * A member is an ordinary scaffolded project, rendered by
 * `templates/project-files.ts` like any other. Two things differ, and both
 * point the member's config at a CLI-owned module rather than at a literal:
 * its `ServiceDiscoveryPlugin` wiring reads `src/discovery/services.ts`, and its
 * broker options and RPC plugins come from `src/transport/index.ts` (M138), so
 * a later change to either regenerates a module and leaves the config alone.
 *
 * @module
 */

import { JOBS_SEAM } from '../seams/jobs.ts';
import type { ResolvedHost } from '../templates/project-files.ts';
import { DISCOVERY_SPECIFIER, SERVICE_ENDPOINTS_EXPORT } from './discovery-module.ts';
import { workspaceProfile, type WorkspaceRuntimeProfile } from './runtime-profile.ts';
import type { BrokerSpec } from './transport.ts';
import { GRPC_CALLER_CLIENTS, GRPC_PLUGIN, type RpcSpec } from './rpc.ts';
import { withClientDependencies } from '../templates/client-dependencies.ts';
import { NODE_REDIS_MODULE_PATH, nodeRedisModuleFile } from '../templates/node-redis.ts';
import {
  renderTransportModule,
  TRANSPORT_EXPORTS,
  TRANSPORT_MODULE,
  TRANSPORT_SPECIFIER,
  transportModuleShape,
  type TransportModuleInput,
} from './transport-module.ts';

/** The package whose wiring the discovery overlay rewrites. */
const DISCOVERY_PACKAGE = 'service-discovery-plugin';

/** The wirings the transport module's options replace the arguments of. */
const MESSAGING_PACKAGE = 'messaging-plugin';
const QUEUE_PACKAGE = 'queue-plugin';

/**
 * Points a member at its generated discovery map and transport module.
 *
 * The discovery half applies ONLY when the member's plugin set contains the
 * service discovery plugin. A member without it — a `rest` member, or one
 * scaffolded with no template — keeps its wiring, because adding the import would
 * put an identifier in its `setu.config.ts` that no wiring reads. Being REACHABLE
 * by siblings and CONSUMING their map are separate properties: every member
 * appears in every other member's map regardless of what it installs.
 *
 * @param host - The member's resolved host
 * @param broker - The workspace's broker
 * @param rpc - The member's own RPC style
 * @param member - The member's kebab-case name, which names its proto package
 * @param profile - The workspace's runtime profile
 * @param endpoint - The workspace's `brokerUrl`, when it set one
 * @param targets - The gRPC members this member calls (M139b §3.12)
 * @returns The host reading both CLI-owned modules
 */
export function withWorkspaceMember(
  host: ResolvedHost,
  broker: BrokerSpec,
  rpc: RpcSpec,
  member: string,
  profile: WorkspaceRuntimeProfile = workspaceProfile('node'),
  endpoint?: string,
  targets: readonly string[] = [],
): ResolvedHost {
  return withTransportModule(
    withDiscoveryMap(host),
    {
      broker,
      rpc,
      grpcTargets: targets,
      host: host.appFactory === undefined ? 'plugin-list' : 'app-factory',
      profile,
      messaging: host.plugins.some((wiring) => wiring.pkg === MESSAGING_PACKAGE),
      queue: host.plugins.some((wiring) => wiring.pkg === QUEUE_PACKAGE),
      ...(endpoint === undefined ? {} : { brokerUrl: endpoint }),
    },
    member,
  );
}

/**
 * Points a member's discovery wiring at its generated map.
 *
 * @param host - The member's resolved host
 * @returns The host with the discovery wiring and import, or the input unchanged
 */
function withDiscoveryMap(host: ResolvedHost): ResolvedHost {
  if (host.appFactory !== undefined) {
    return {
      ...host,
      appFactoryContext: { ...host.appFactoryContext, serviceEndpoints: SERVICE_ENDPOINTS_EXPORT },
      localImports: [
        ...host.localImports,
        { symbols: [SERVICE_ENDPOINTS_EXPORT], from: DISCOVERY_SPECIFIER },
      ],
    };
  }
  if (!host.plugins.some((wiring) => wiring.pkg === DISCOVERY_PACKAGE)) return host;

  return {
    ...host,
    plugins: host.plugins.map((wiring) =>
      wiring.pkg === DISCOVERY_PACKAGE
        ? {
            ...wiring,
            args: `{ provider: 'static', services: ${SERVICE_ENDPOINTS_EXPORT} }`,
          }
        : wiring,
    ),
    localImports: [
      ...host.localImports,
      { symbols: [SERVICE_ENDPOINTS_EXPORT], from: DISCOVERY_SPECIFIER },
    ],
  };
}

/**
 * Writes the member's transport module and points its config at it.
 *
 * A plugin-list config passes `messagingOptions()` to the template's own
 * `MessagingPlugin` and spreads `queueOptions()` into its `QueuePlugin`, rather
 * than registering second ones: the kernel refuses a duplicate plugin name at
 * `start()`. A member whose template registers no messaging gets no such call,
 * so a broker never hands a service a bus its template did not ask for. A
 * starter-composed config passes the same functions to the starter's
 * `messaging`/`queue` options, which it always registers.
 *
 * The packages the module imports are declared here: the broker's clients (an
 * optional peer of the plugin, `client-dependencies.ts`), and for gRPC the plugin
 * itself, its clients and the proto toolchain.
 *
 * @param host - The member's resolved host
 * @param input - The module's inputs
 * @param member - The member's kebab-case name
 * @returns The host with the module, the config calls and the declared packages
 */
function withTransportModule(
  host: ResolvedHost,
  input: TransportModuleInput,
  member: string,
): ResolvedHost {
  const shape = transportModuleShape(input);
  const { broker, rpc } = input;
  const factory = input.host === 'app-factory';
  const onDeno = input.profile.manifestKind === 'deno';
  const symbols = [
    ...(shape.messaging ? [TRANSPORT_EXPORTS.messaging] : []),
    ...(shape.queue ? [TRANSPORT_EXPORTS.queue] : []),
    TRANSPORT_EXPORTS.plugins,
    ...(shape.csrf ? [TRANSPORT_EXPORTS.csrf] : []),
  ];
  const nodeRedis =
    broker.redisClient === 'node-redis' && (shape.messaging || shape.queue)
      ? [nodeRedisModuleFile()]
      : [];
  const note = broker.connection?.note;
  const wired: ResolvedHost = {
    ...host,
    ...(factory
      ? {
          appFactoryContext: {
            ...host.appFactoryContext,
            messaging: `${TRANSPORT_EXPORTS.messaging}(config)`,
            queue: `{ ${broker.connection !== undefined && broker.queueArgs !== undefined ? 'processors: [...QUEUE_PROCESSORS], ' : ''}...${TRANSPORT_EXPORTS.queue}(config) }`,
            csrfExclude: `${TRANSPORT_EXPORTS.csrf}()`,
          },
          setupCalls: [
            `for (const plugin of ${TRANSPORT_EXPORTS.plugins}()) app.register(plugin);`,
            ...host.setupCalls,
          ],
        }
      : {
          plugins: host.plugins.map((wiring) =>
            wiring.pkg === MESSAGING_PACKAGE
              ? { ...wiring, args: `${TRANSPORT_EXPORTS.messaging}()` }
              : wiring.pkg === QUEUE_PACKAGE
                ? { ...wiring, args: withQueueSpread(wiring.args) }
                : wiring,
          ),
          pluginSpreads: [`...${TRANSPORT_EXPORTS.plugins}()`, ...host.pluginSpreads],
        }),
    localImports: [
      ...host.localImports,
      { symbols, from: TRANSPORT_SPECIFIER },
      ...(factory && broker.connection !== undefined && broker.queueArgs !== undefined
        ? [{ symbols: ['QUEUE_PROCESSORS'], from: './src/jobs/index.ts' }]
        : []),
    ],
    files: [
      ...host.files.filter(
        (file) =>
          file.path !== TRANSPORT_MODULE &&
          (nodeRedis.length === 0 || file.path !== NODE_REDIS_MODULE_PATH),
      ),
      { path: TRANSPORT_MODULE, contents: renderTransportModule(input), managed: true },
      ...(factory &&
      broker.connection !== undefined &&
      broker.queueArgs !== undefined &&
      !host.files.some((file) => file.path === JOBS_SEAM.barrel)
        ? [{ path: JOBS_SEAM.barrel, contents: JOBS_SEAM.renderBarrel({}), managed: true }]
        : []),
      ...nodeRedis,
      ...(rpc.memberFiles?.(member, onDeno) ?? []),
    ],
    ...(note === undefined ||
    (!shape.messaging && !shape.queue) ||
    host.transportNotes?.includes(note)
      ? {}
      : { transportNotes: [...(host.transportNotes ?? []), note] }),
    extraFrameworkPackages: [
      ...host.extraFrameworkPackages,
      ...(factory && broker.connection !== undefined && broker.queueArgs !== undefined
        ? [QUEUE_PACKAGE]
        : []),
      ...(rpc.plugin === undefined && (input.grpcTargets ?? []).length === 0
        ? []
        : [GRPC_PLUGIN.pkg]),
    ],
    // Each manifest kind gets only its own half: a Deno member's tasks and import
    // map, an npm member's scripts and devDependencies.
    ...(onDeno
      ? {
          extraTasks: { ...host.extraTasks, ...rpc.memberTasks },
          extraImports: { ...host.extraImports, ...rpc.memberImports },
        }
      : {
          extraScripts: { ...host.extraScripts, ...rpc.memberScripts },
          extraDevDependencies: { ...host.extraDevDependencies, ...rpc.memberDevDependencies },
        }),
  };
  return withClientDependencies(
    wired,
    [
      ...(shape.messaging && broker.messagingArgs !== undefined
        ? (broker.messagingClients ?? [])
        : []),
      ...(shape.queue && broker.queueArgs !== undefined ? (broker.queueClients ?? []) : []),
      ...(rpc.clients ?? []),
      ...((input.grpcTargets ?? []).length === 0 ? [] : GRPC_CALLER_CLIENTS),
    ].filter((name, index, all) => all.indexOf(name) === index),
  );
}

/**
 * Spreads the module's queue options into a `QueuePlugin` argument.
 *
 * The template's own options (the generated jobs seam, `processors`) are kept in
 * front of the spread, so `setu check` still sees the barrel wired.
 *
 * @param args - The wiring's current arguments, if any
 * @returns The arguments calling `queueOptions()`
 */
function withQueueSpread(args: string | undefined): string {
  const call = `${TRANSPORT_EXPORTS.queue}()`;
  const body =
    args
      ?.trim()
      .replace(/^\{|\}$/g, '')
      .trim()
      .replace(/,$/, '') ?? '';
  return body === '' ? call : `{ ${body}, ...${call} }`;
}
