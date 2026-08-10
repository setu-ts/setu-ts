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

/** The package whose wiring the overlay rewrites. */
const DISCOVERY_PACKAGE = 'service-discovery-plugin';

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
export function withWorkspaceMember(host: ResolvedHost): ResolvedHost {
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
