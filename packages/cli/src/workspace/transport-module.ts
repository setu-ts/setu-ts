/**
 * The CLI-owned transport module every workspace member carries:
 * `src/transport/index.ts`.
 *
 * A member's `setu.config.ts` is the developer's file, and the CLI never rewrites
 * a plugin call already in it. So the broker options and the RPC plugins are not
 * written INTO it as literals. The config calls functions exported here instead,
 * and this file is regenerated from the workspace manifest whenever the broker
 * or the member's RPC style changes — the same split the discovery map already
 * makes for ports (`discovery-module.ts`). Changing a transport is then a
 * configuration change the code reads, which is how Dapr, Moleculer, Spring
 * Cloud Stream and Quarkus all change theirs (M138 §0).
 *
 * Every export is a FUNCTION, not a constant: `setu commands` imports the
 * config, so a module-scope environment read or client construction would run
 * on every CLI invocation that merely discovers commands.
 *
 * @module
 */

import { reindentLiteral, wrapPluginArgs } from '../templates/plugin-args.ts';
import { starterOptionLiteral } from '../templates/broker.ts';
import { NODE_REDIS_FACTORY, NODE_REDIS_MODULE_PATH } from '../templates/node-redis.ts';
import type { RpcSpec } from './rpc.ts';
import type { WorkspaceRuntimeProfile } from './runtime-profile.ts';
import { renderConnection, type BrokerSpec } from './transport.ts';

/** Where the module lives, relative to the member root. */
export const TRANSPORT_MODULE = 'src/transport/index.ts';

/** The specifier a member's `setu.config.ts` imports the module by. */
export const TRANSPORT_SPECIFIER = './src/transport/index.ts';

/** The exports a member's config calls, by name. */
export const TRANSPORT_EXPORTS = {
  messaging: 'messagingOptions',
  queue: 'queueOptions',
  plugins: 'transportPlugins',
  csrf: 'csrfExclusions',
} as const;

/** How the member's config composes its plugins. */
export type TransportHostKind = 'plugin-list' | 'app-factory';

/** Everything the module's contents are a function of. */
export interface TransportModuleInput {
  /** The workspace broker, already resolved with its Redis client. */
  readonly broker: BrokerSpec;
  /** The workspace's broker endpoint override, when it set one. */
  readonly brokerUrl?: string;
  /** The member's own RPC style. */
  readonly rpc: RpcSpec;
  /** A plugin list (`createApplication`) or a starter factory (full-stack). */
  readonly host: TransportHostKind;
  /** The member's runtime, which decides how the environment is read. */
  readonly profile: WorkspaceRuntimeProfile;
  /**
   * Whether the member registers `MessagingPlugin` and `QueuePlugin`.
   *
   * Read only on a plugin-list host. A starter factory always registers both,
   * so an app-factory host always gets both functions.
   */
  readonly messaging: boolean;
  /** See {@linkcode TransportModuleInput.messaging}. */
  readonly queue: boolean;
}

/** The functions a rendered module exports, so the config renderer calls exactly those. */
export interface TransportModuleShape {
  /** Whether `messagingOptions` is exported. */
  readonly messaging: boolean;
  /** Whether `queueOptions` is exported. */
  readonly queue: boolean;
  /** Whether `csrfExclusions` is exported (app-factory hosts only). */
  readonly csrf: boolean;
}

/**
 * Which functions a module for this input exports.
 *
 * `transportPlugins` is always exported, so a member can switch to gRPC without
 * its config changing.
 *
 * @param input - The module's inputs
 * @returns The exported functions besides `transportPlugins`
 */
export function transportModuleShape(input: TransportModuleInput): TransportModuleShape {
  const factory = input.host === 'app-factory';
  return {
    messaging: factory || input.messaging,
    queue: factory || input.queue,
    csrf: factory,
  };
}

/**
 * Renders one option function's body as the literal it returns.
 *
 * The literal comes from the SAME arm renderers the standalone `--broker`
 * overlay uses, so a workspace member and a standalone project on one broker
 * pass the plugin identical options. Those renderers lay a literal out for a
 * plugin argument (depth 6) or a starter option (depth 8); it is re-indented to
 * sit after `return` at depth 2, which `deno fmt` keeps as laid out.
 *
 * @param builder - The arm's renderer, or undefined when the broker has none
 * @param input - The module's inputs
 * @returns The literal, and whether it reads `config`
 */
function optionLiteral(
  builder: ((connection: string) => string) | undefined,
  input: TransportModuleInput,
): { readonly literal: string; readonly readsConfig: boolean } {
  const { broker } = input;
  if (builder === undefined || broker.connection === undefined) {
    return { literal: '{}', readsConfig: false };
  }
  if (input.host === 'app-factory') {
    return {
      literal: reindentLiteral(starterOptionLiteral(builder, broker, input.brokerUrl), 8, 2),
      readsConfig: true,
    };
  }
  const connection = renderConnection(broker.connection, input.profile, input.brokerUrl);
  return {
    literal: reindentLiteral(wrapPluginArgs(builder(connection)), 6, 2),
    readsConfig: false,
  };
}

/**
 * Renders one exported option function.
 *
 * @param name - The function's name
 * @param doc - Its one-line JSDoc summary
 * @param type - Its return type, as source
 * @param literal - What it returns
 * @param input - The module's inputs
 * @param readsConfig - Whether the body reads its `config` parameter
 * @returns The function, as source
 */
function optionFunction(
  name: string,
  doc: string,
  type: string,
  literal: { readonly literal: string; readonly readsConfig: boolean },
  input: TransportModuleInput,
): string {
  // Prefixed when unused, so the generated ESLint (`argsIgnorePattern: '^_'`) and
  // `deno lint` accept it, while the config's call site stays the same whatever
  // the broker.
  const parameter =
    input.host === 'app-factory' ? `${literal.readsConfig ? 'config' : '_config'}: IConfig` : '';
  return `/**
 * ${doc}
 *
${input.host === 'app-factory' ? ` * @param ${literal.readsConfig ? 'config' : '_config'} - The starter's configuration, which reads the member's \`.env\`\n` : ''} * @returns The options, rendered from setu.workspace.json
 */
export function ${name}(${parameter}): ${type} {
  return ${literal.literal};
}
`;
}

/**
 * Renders a member's `src/transport/index.ts`.
 *
 * @param input - The broker, the member's RPC style, and how its config composes
 * @returns The module's contents
 */
export function renderTransportModule(input: TransportModuleInput): string {
  const shape = transportModuleShape(input);
  const factory = input.host === 'app-factory';
  const grpc = input.rpc.plugin;
  const messaging = shape.messaging ? optionLiteral(input.broker.messagingArgs, input) : undefined;
  const queue = shape.queue ? optionLiteral(input.broker.queueArgs, input) : undefined;
  const usesNodeRedis =
    input.broker.redisClient === 'node-redis' &&
    [messaging, queue].some((option) => option?.literal.includes(`${NODE_REDIS_FACTORY}(`));

  const imports = [
    factory
      ? "import type { IConfig, IPlugin } from '@setu-ts/common';"
      : "import type { IPlugin } from '@setu-ts/common';",
    // Typed through the starter on an app-factory host: a full-stack member
    // declares `full-stack-starter`, not the messaging or queue plugin.
    ...(factory
      ? ["import type { FullStackStarterOptions } from '@setu-ts/full-stack-starter';"]
      : []),
    ...(!factory && shape.messaging
      ? ["import type { MessagingPluginOptions } from '@setu-ts/messaging-plugin';"]
      : []),
    ...(!factory && shape.queue
      ? ["import type { QueuePluginOptions } from '@setu-ts/queue-plugin';"]
      : []),
    ...(grpc === undefined ? [] : [`import { ${grpc.symbol} } from '@setu-ts/${grpc.pkg}';`]),
    ...(usesNodeRedis
      ? [
          `import { ${NODE_REDIS_FACTORY} } from '../${NODE_REDIS_MODULE_PATH.replace(/^src\//, '')}';`,
        ]
      : []),
  ];

  const functions = [
    ...(messaging === undefined
      ? []
      : [
          optionFunction(
            TRANSPORT_EXPORTS.messaging,
            `The ${input.broker.name} broker's \`MessagingPlugin\` options.`,
            factory ? 'StarterMessagingOptions' : 'MessagingPluginOptions',
            messaging,
            input,
          ),
        ]),
    ...(queue === undefined
      ? []
      : [
          optionFunction(
            TRANSPORT_EXPORTS.queue,
            input.broker.queueArgs === undefined
              ? `The \`QueuePlugin\` options: in memory, since the queue has no ${input.broker.name} arm.`
              : `The ${input.broker.name} broker's \`QueuePlugin\` options.`,
            factory ? 'StarterQueueOptions' : 'QueuePluginOptions',
            queue,
            input,
          ),
        ]),
    `/**
 * The plugins this member's RPC style adds: ${grpc === undefined ? 'none for HTTP, which every template already serves' : `\`${grpc.symbol}\`, mounted under \`/grpc\``}.
 *
 * @returns The plugins to register
 */
export function ${TRANSPORT_EXPORTS.plugins}(): readonly IPlugin[] {
  return [${grpc === undefined ? '' : `${grpc.symbol}(${grpc.args ?? ''})`}];
}
`,
    ...(shape.csrf
      ? [
          `/**
 * The paths form CSRF must not guard: ${grpc === undefined ? 'none' : 'the gRPC mount, whose callers are not browser forms'}.
 *
 * @returns The exclusions
 */
export function ${TRANSPORT_EXPORTS.csrf}(): readonly RegExp[] {
  return [${grpc === undefined ? '' : "new RegExp('^/grpc(?:/|$)')"}];
}
`,
        ]
      : []),
  ];

  return `/**
 * How this workspace member reaches the workspace broker, and how it is called.
 *
 * Generated by \`setu\`. The CLI owns this file and rewrites it from
 * setu.workspace.json, so edits here are lost. Change the broker with
 * \`setu workspace broker <name>\` and this member's RPC style with
 * \`setu workspace rpc <member> <http|grpc>\`.
 *
 * @module
 */

${imports.join('\n')}
${
  factory
    ? `
/** The starter's \`messaging\` option: \`MessagingPlugin\`'s options, as the starter takes them. */
type StarterMessagingOptions = NonNullable<FullStackStarterOptions['messaging']>;

/** The starter's \`queue\` option. */
type StarterQueueOptions = NonNullable<FullStackStarterOptions['queue']>;
`
    : ''
}
${functions.join('\n')}`;
}
