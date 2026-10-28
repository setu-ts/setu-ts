/**
 * The standalone broker overlay — what `setu new --broker/--queue` applies.
 *
 * The workspace transport overlay already knew how to rewrite a
 * `MessagingPlugin`/`QueuePlugin` wiring from a rendered connection; this module
 * composes that same machinery (via `plugin-args.ts`) for a STANDALONE project,
 * and adds the two things only the standalone path needs: the connection
 * variable in the generated dotenv pair, and a Compose file starting the broker
 * the flag names. It shares every renderer with the workspace rather than
 * keeping a second table, so the two paths cannot drift on the first arm added.
 *
 * @module
 */
import type { TargetRuntime } from '../constants.ts';
import type { WorkspaceRuntimeProfile } from '../workspace/runtime-profile.ts';
import {
  getTransport,
  listBrokers,
  listQueues,
  renderConfigConnection,
  renderConnection,
  type TransportSpec,
} from '../workspace/transport.ts';
import type { ParsedArgs } from '../args.ts';
import { escapeName } from '../utils/names.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import type { EnvVariable } from './registry.ts';
import { BROKER_COMPOSE_FILE, type ResolvedHost } from './project-files.ts';
import { reindentLiteral, rewritePluginArgs, wrapPluginArgs } from './plugin-args.ts';
import { withClientDependencies } from './client-dependencies.ts';

/** The package whose wiring a broker arm rewrites. */
const MESSAGING_PACKAGE = 'messaging-plugin';

/** The package whose wiring a queue arm rewrites. */
const QUEUE_PACKAGE = 'queue-plugin';

/**
 * Carries a transport's operational note onto the host, once.
 *
 * Both overlays read the same `connection.note`, and a transport with both arms
 * (redis, rabbitmq) applies both, so an append without the guard would print the
 * paragraph twice in the generated README.
 *
 * @param host - The host the arm rewrote
 * @param spec - The selected transport
 * @returns The host with the note appended, or unchanged when there is none
 */
function withTransportNote(host: ResolvedHost, spec: TransportSpec): ResolvedHost {
  const note = spec.connection?.note;
  if (note === undefined) return host;
  const notes = host.transportNotes ?? [];
  if (notes.includes(note)) return host;
  return { ...host, transportNotes: [...notes, note] };
}

/**
 * Renders a transport arm as the value of a full-stack starter option.
 *
 * The ONE rendering of a starter option, shared by `setu new`/`generate app` (through
 * {@linkcode withBrokerArgs}/{@linkcode withQueueArgs}) and `setu add`, so the three entry
 * points cannot drift. The arm's literal is written for the inline plugin list, so it is
 * rendered there with a ConfigPlugin read and shifted two spaces deeper, to a property of
 * the generated factory's returned object (M121 §3.1, §3.2).
 *
 * @param builder - The arm's `messagingArgs` or `queueArgs`
 * @param spec - The selected transport, which declares a connection
 * @param override - The workspace's replacement fallback, when it set one
 * @returns The option literal, indented for an eight-space property
 */
export function starterOptionLiteral(
  builder: (connection: string) => string,
  spec: TransportSpec,
  override?: string,
): string {
  const connection = spec.connection!;
  // The read's first column once shifted: the property sits at 10 and the one long
  // value (the Service Bus emulator string) is the `connectionString:` property.
  const column = spec.name === 'service-bus' ? 28 : 15;
  return reindentLiteral(
    wrapPluginArgs(builder(renderConfigConnection(connection, override, column, 8))),
    6,
    8,
  );
}

/**
 * Rewrites the host's `MessagingPlugin` wiring to the transport's broker arm.
 *
 * A no-op when the spec declares no messaging arm or no connection (the
 * `http`, `grpc` and `memory` arms) and when the host registers no such
 * wiring — the caller refuses those cases on the standalone path rather than
 * letting them pass silently.
 *
 * @param host - The resolved host
 * @param spec - The selected transport
 * @param profile - How the target runtime reads the environment
 * @param override - Replaces the local default as the read's fallback
 * @returns The host with the wiring rewritten, or the input unchanged
 */
export function withBrokerArgs(
  host: ResolvedHost,
  spec: TransportSpec,
  profile: WorkspaceRuntimeProfile,
  override?: string,
): ResolvedHost {
  if (spec.connection === undefined || spec.messagingArgs === undefined) return host;
  if (host.appFactory !== undefined) {
    return withTransportNote(
      withClientDependencies(
        {
          ...host,
          appFactoryContext: {
            ...host.appFactoryContext,
            messaging: starterOptionLiteral(spec.messagingArgs, spec, override),
          },
        },
        spec.messagingClients ?? [],
      ),
      spec,
    );
  }
  if (!host.plugins.some((wiring) => wiring.pkg === MESSAGING_PACKAGE)) return host;
  return withTransportNote(
    withClientDependencies(
      rewritePluginArgs(
        host,
        MESSAGING_PACKAGE,
        spec.messagingArgs,
        renderConnection(spec.connection, profile, override),
      ),
      spec.messagingClients ?? [],
    ),
    spec,
  );
}

/**
 * Rewrites the host's `QueuePlugin` wiring to the transport's queue arm.
 *
 * Present on fewer transports than {@linkcode withBrokerArgs}: the queue
 * supports fewer backends than the brokers, so a NATS or Kafka selection keeps
 * the in-memory queue — refused by name on the standalone path rather than
 * left as a silent no-op.
 *
 * @param host - The resolved host
 * @param spec - The selected transport
 * @param profile - How the target runtime reads the environment
 * @param override - Replaces the local default as the read's fallback
 * @returns The host with the wiring rewritten, or the input unchanged
 */
export function withQueueArgs(
  host: ResolvedHost,
  spec: TransportSpec,
  profile: WorkspaceRuntimeProfile,
  override?: string,
): ResolvedHost {
  if (spec.connection === undefined || spec.queueArgs === undefined) return host;
  if (host.appFactory !== undefined) {
    return withTransportNote(
      withClientDependencies(
        {
          ...host,
          appFactoryContext: {
            ...host.appFactoryContext,
            queue: starterOptionLiteral(spec.queueArgs, spec, override),
          },
        },
        spec.queueClients ?? [],
      ),
      spec,
    );
  }
  if (!host.plugins.some((wiring) => wiring.pkg === QUEUE_PACKAGE)) return host;
  return withTransportNote(
    withClientDependencies(
      rewritePluginArgs(
        host,
        QUEUE_PACKAGE,
        spec.queueArgs,
        renderConnection(spec.connection, profile, override),
      ),
      spec.queueClients ?? [],
    ),
    spec,
  );
}

/**
 * The dotenv row for a transport's connection variable.
 *
 * `EnvVariable` wants exactly what `TransportConnection` carries: the variable
 * name and the local development value. The tracked `.env.example` writes the
 * name with an EMPTY value automatically, so one row serves both files.
 *
 * @param spec - The selected transport
 * @returns The variable row, empty when the transport has no connection
 */
export function brokerEnvVariables(spec: TransportSpec): readonly EnvVariable[] {
  const connection = spec.connection;
  if (connection === undefined) return [];
  return [
    {
      name: connection.variable,
      description:
        `Where the ${spec.name} transport connects. The default is this project's local ` +
        `development value; deployments set the real endpoint here.`,
      develop: connection.localDefault,
    },
  ];
}

/**
 * The Compose service block an existing file lacks for a transport, if any.
 *
 * `setu add --broker/--queue` never rewrites a developer's `docker/compose.yaml`; when the
 * file exists without the selected arm's services, the caller prints this block instead of
 * staying silent (PR #519 review). Services are matched by their top-level key
 * (`  rabbitmq:`), so an arm with several services is reported if any one is missing.
 *
 * @param existing - The current Compose file
 * @param spec - The selected transport
 * @returns The block to add under `services:`, or undefined when nothing is missing
 */
export function missingComposeServices(existing: string, spec: TransportSpec): string | undefined {
  const block = spec.compose?.services;
  if (block === undefined) return undefined;
  const names = [...block.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((match) => match[1]!);
  // Only the `services:` section counts: a same-named `volumes:` entry is not a service
  // (PR #519 review). The section runs to the next top-level key; a column-0 comment does
  // not end it. CRLF files and trailing comments on keys are accepted.
  const text = existing.replace(/\r\n?/g, '\n');
  const section = /^services:[ \t]*(?:#.*)?$/m.exec(text);
  const tail = section === null ? '' : text.slice(section.index + section[0].length);
  const services = tail.slice(0, /^[^\s#]/m.exec(tail)?.index ?? tail.length);
  // A service is a key at the section's shallowest key indentation, whatever it is.
  const keys = [...services.matchAll(/^( +)([\w.-]+):[ \t]*(?:#.*)?$/gm)].map((match) => ({
    depth: match[1]!.length,
    name: match[2]!,
  }));
  const depth = Math.min(...keys.map((key) => key.depth));
  const declared = new Set(keys.filter((key) => key.depth === depth).map((key) => key.name));
  return names.every((name) => declared.has(name)) ? undefined : block.replace(/\n$/, '');
}

/**
 * Emits the per-project Compose file starting the selected transports' backing
 * services.
 *
 * The messaging plugin connects during `register()` and does not retry, so a
 * fresh scaffold cannot complete `app.start()` with nothing listening — the
 * file exists so the flag's promise ("this project talks to redis") is true the
 * first time it boots. Broker services ONLY: the deployable image and the full
 * orchestration story are M39's, and the header says so in its own words.
 *
 * @param specs - The selected transports, in flag order
 * @returns The compose file plus any backing-service config files
 */
export function brokerComposeFiles(specs: readonly TransportSpec[]): readonly GeneratedFile[] {
  // One arm can serve both flags (`--broker redis --queue redis`); its service
  // block must appear once, not twice.
  const backing = [
    ...new Map(
      specs.filter((spec) => spec.compose !== undefined).map((spec) => [spec.name, spec]),
    ).values(),
  ];

  if (backing.length === 0) return [];

  const files: GeneratedFile[] = [
    {
      path: BROKER_COMPOSE_FILE,
      contents: `# Local development backing services for this project.
#
#   docker compose -f ${BROKER_COMPOSE_FILE} up -d
#
# Broker services ONLY: they exist so the transports this project selected can
# connect at app.start(). The deployable image and the orchestration objects
# (Kubernetes, the full stack) are separate concerns this file does not own.
services:
${backing.map((spec) => (spec.compose?.services ?? '').replace(/\n$/, '')).join('\n')}
`,
    },
  ];

  for (const spec of backing) {
    for (const file of spec.compose?.files ?? []) files.push(file);
  }
  return files;
}

/**
 * Why a standalone broker/queue flag would be a silent no-op, as source text.
 *
 * Both command refusals and the interactive question skip derive from this
 * function. Starter-composed hosts receive their option arms; inline hosts need
 * matching wiring. Workers continues to use platform queues.
 *
 * @param flag - Which flag the refusal is worded for
 * @param runtime - The selected runtime target
 * @param host - The resolved host AFTER its runtime swap has been applied
 * @returns The refusal message, or undefined when the flag can apply
 */
export function standaloneOverlayRefusal(
  flag: 'broker' | 'queue',
  runtime: TargetRuntime,
  host: ResolvedHost,
): string | undefined {
  if (runtime === 'cloudflare-workers') {
    return (
      `--${flag} cannot apply on Cloudflare Workers: the Workers build replaces ` +
      `${MESSAGING_PACKAGE} and ${QUEUE_PACKAGE} with the platform's own queues and a Durable ` +
      `Object, so there is no wiring left for the flag to rewrite and it would report success ` +
      `while the project talked to Cloudflare. Scaffold for deno, node or bun to select one.`
    );
  }
  if (host.appFactory !== undefined) return undefined;
  const pkg = flag === 'broker' ? MESSAGING_PACKAGE : QUEUE_PACKAGE;
  if (!host.plugins.some((wiring) => wiring.pkg === pkg)) {
    return (
      `--${flag} has nothing to configure: this template registers no ${pkg} wiring, so the ` +
      `flag would be accepted and silently do nothing. Use --template microservice to select ` +
      `a ${flag} (add --style class-based for decorators).`
    );
  }
  return undefined;
}

/**
 * Reads and validates one standalone transport-backend flag.
 *
 * The accepted set is DERIVED from the registry (`listBrokers`/`listQueues`), so
 * help text, refusal text and validation cannot drift from the arms that exist.
 * `memory` is always accepted: it states the default the plugin already takes
 * and rewrites nothing.
 *
 * @param args - The parsed arguments
 * @param flag - Which flag is being read
 * @returns The selected spec (undefined when the flag is absent), or the refusal
 */
export function readArmFlag(
  args: ParsedArgs,
  flag: 'broker' | 'queue',
):
  | { readonly ok: true; readonly spec?: TransportSpec }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  const raw = args.flags[flag];
  if (raw === undefined) return { ok: true };

  const accepted = flag === 'broker' ? listBrokers() : listQueues();
  if (typeof raw !== 'string') {
    return { ok: false, message: `--${flag} needs a value: ${accepted.join(' | ')}.` };
  }

  const spec = getTransport(raw);
  const hasArm =
    spec !== undefined &&
    (flag === 'broker' ? spec.messagingArgs !== undefined : spec.queueArgs !== undefined);
  if (spec === undefined || (raw !== 'memory' && !hasArm)) {
    // The two failures are told apart, because "no such transport" and "this
    // transport has no arm for this flag" are different mistakes.
    const prefix =
      spec === undefined
        ? `Unknown ${flag} "${escapeName(raw)}".`
        : flag === 'broker'
          ? `"${raw}" declares no message-broker wiring.`
          : `"${raw}" declares no queue wiring.`;
    return {
      ok: false,
      message: `${prefix} --${flag} accepts: ${accepted.join(', ')}.`,
    };
  }
  return { ok: true, spec };
}
