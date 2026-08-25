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
import { renderConnection, type TransportSpec } from '../workspace/transport.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import type { EnvVariable } from './registry.ts';
import { BROKER_COMPOSE_FILE, type ResolvedHost } from './project-files.ts';
import { rewritePluginArgs } from './plugin-args.ts';

/** The package whose wiring a broker arm rewrites. */
const MESSAGING_PACKAGE = 'messaging-plugin';

/** The package whose wiring a queue arm rewrites. */
const QUEUE_PACKAGE = 'queue-plugin';

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
  return rewritePluginArgs(
    host,
    MESSAGING_PACKAGE,
    spec.messagingArgs,
    renderConnection(spec.connection, profile, override),
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
  return rewritePluginArgs(
    host,
    QUEUE_PACKAGE,
    spec.queueArgs,
    renderConnection(spec.connection, profile, override),
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
  return [{
    name: connection.variable,
    description: `Where the ${spec.name} transport connects. The default is this project's local ` +
      `development value; deployments set the real endpoint here.`,
    develop: connection.localDefault,
  }];
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
export function brokerComposeFiles(
  specs: readonly TransportSpec[],
): readonly GeneratedFile[] {
  // One arm can serve both flags (`--broker redis --queue redis`); its service
  // block must appear once, not twice.
  const backing = [...new Map(
    specs.filter((spec) => spec.compose !== undefined).map((spec) => [spec.name, spec]),
  ).values()];

  if (backing.length === 0) return [];

  const files: GeneratedFile[] = [{
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
  }];

  for (const spec of backing) {
    for (const file of spec.compose?.files ?? []) files.push(file);
  }
  return files;
}

/**
 * Why a standalone broker/queue flag would be a silent no-op, as source text.
 *
 * The three structural cases mirror §3.4 of the M72 plan exactly, and BOTH the
 * command refusals and the interactive question skip derive from THIS function,
 * so a prompt whose answer would be refused cannot be asked.
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
    return `--${flag} cannot apply on Cloudflare Workers: the Workers build replaces ` +
      `${MESSAGING_PACKAGE} and ${QUEUE_PACKAGE} with the platform's own queues and a Durable ` +
      `Object, so there is no wiring left for the flag to rewrite and it would report success ` +
      `while the project talked to Cloudflare. Scaffold for deno, node or bun to select one.`;
  }
  if (host.appFactory !== undefined) {
    return `--${flag} cannot apply to a starter-composed template: the whole plugin set is ` +
      `rendered through the starter factory, so a plugin-list rewrite would be dropped and the ` +
      `project would look connected while talking to nobody. Use --template microservice to ` +
      `select a ${flag}.`;
  }
  const pkg = flag === 'broker' ? MESSAGING_PACKAGE : QUEUE_PACKAGE;
  if (!host.plugins.some((wiring) => wiring.pkg === pkg)) {
    return `--${flag} has nothing to configure: this template registers no ${pkg} wiring, so the ` +
      `flag would be accepted and silently do nothing. Use --template microservice to select ` +
      `a ${flag}.`;
  }
  return undefined;
}
