/**
 * The workspace-member overlay — what makes a member's config read its
 * generated discovery map.
 *
 * A member is an ordinary scaffolded project, rendered by
 * `templates/project-files.ts` like any other. The single difference is that
 * its `ServiceDiscoveryPlugin` wiring points at the CLI-owned
 * `src/discovery/services.ts` instead of at an empty literal — so this module
 * rewrites exactly that one wiring and adds exactly one import, using the same
 * technique `templates/seam.ts` uses for the generated-artifact seams.
 *
 * @module
 */

import type { ResolvedHost } from '../templates/project-files.ts';
import { DISCOVERY_SPECIFIER, SERVICE_ENDPOINTS_EXPORT } from './discovery-module.ts';
import { workspaceProfile, type WorkspaceRuntimeProfile } from './runtime-profile.ts';
import { renderConnection, type TransportSpec } from './transport.ts';

/** The package whose wiring the discovery overlay rewrites. */
const DISCOVERY_PACKAGE = 'service-discovery-plugin';

/** The package whose wiring a broker transport rewrites. */
const MESSAGING_PACKAGE = 'messaging-plugin';

/**
 * Points a member's discovery wiring at its generated map.
 *
 * Applied ONLY when the member's plugin set contains the service discovery
 * plugin. A member without it — a `rest` member, or one scaffolded with no
 * template — is returned unchanged, because adding the import would put an
 * identifier in its `setu.config.ts` that no wiring reads, and a project whose
 * own config names something it does not use is worse than one that simply does
 * not consume the map. Being REACHABLE by siblings and CONSUMING their map are
 * separate properties: every member appears in every other member's map
 * regardless of what it installs.
 *
 * @param host - The member's resolved host
 * @returns The host with the discovery wiring and import, or the input unchanged
 */
export function withWorkspaceMember(
  host: ResolvedHost,
  transport: TransportSpec,
  member: string,
  profile: WorkspaceRuntimeProfile = workspaceProfile('deno'),
  endpoint?: string,
): ResolvedHost {
  return withTransport(withDiscoveryMap(host), transport, member, profile, endpoint);
}

/**
 * Points a member's discovery wiring at its generated map.
 *
 * @param host - The member's resolved host
 * @returns The host with the discovery wiring and import, or the input unchanged
 */
function withDiscoveryMap(host: ResolvedHost): ResolvedHost {
  if (!host.plugins.some((wiring) => wiring.pkg === DISCOVERY_PACKAGE)) return host;

  return {
    ...host,
    plugins: host.plugins.map((wiring) =>
      wiring.pkg === DISCOVERY_PACKAGE
        ? {
          ...wiring,
          args: `{ provider: 'static', services: ${SERVICE_ENDPOINTS_EXPORT} }`,
        }
        : wiring
    ),
    localImports: [
      ...host.localImports,
      { symbols: [SERVICE_ENDPOINTS_EXPORT], from: DISCOVERY_SPECIFIER },
    ],
  };
}

/**
 * Applies the workspace's transport to a member.
 *
 * A broker REWRITES the template's existing `MessagingPlugin` wiring rather
 * than appending one, because the microservice template already registers it
 * and the kernel refuses a duplicate plugin name at `start()` — appending would
 * scaffold a member that type-checks and then cannot boot. A member whose
 * template registers no messaging (a `rest` member, or one with no template) is
 * left alone by the broker arms: there is no wiring to rewrite, and adding one
 * would hand a service a bus its template never asked for.
 *
 * @param host - The member's resolved host
 * @param transport - The workspace's transport
 * @param override - The workspace's `transportUrl`, when it set one
 * @returns The host with the transport's plugins and arguments applied
 */
function withTransport(
  host: ResolvedHost,
  transport: TransportSpec,
  member: string,
  profile: WorkspaceRuntimeProfile,
  override?: string,
): ResolvedHost {
  const args = transport.messagingArgs;
  const connection = transport.connection;

  // Both or neither: a transport declaring arguments always declares where its
  // connection value comes from, which a unit test pins across the registry. The
  // pair is checked rather than assumed so a future arm cannot render `url:
  // undefined` into a member's config.
  const plugins = args === undefined || connection === undefined
    ? host.plugins
    : host.plugins.map((wiring) =>
      wiring.pkg === MESSAGING_PACKAGE
        ? { ...wiring, args: args(renderConnection(connection, profile, override)) }
        : wiring
    );

  return {
    ...host,
    // The transport's own plugins are appended, so a template that already
    // registers one of them would collide — none does, and a unit test pins
    // that across the registry.
    plugins: [...plugins, ...transport.plugins],
    files: [...host.files, ...(transport.memberFiles?.(member) ?? [])],
    extraTasks: { ...host.extraTasks, ...transport.memberTasks },
    extraImports: { ...host.extraImports, ...transport.memberImports },
  };
}
