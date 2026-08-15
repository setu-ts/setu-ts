/**
 * The per-member discovery module — how a workspace member learns its siblings.
 *
 * This is M58's mechanism applied to a CROSS-FILE write: a module the CLI owns
 * outright, which the member's `setu.config.ts` and `main.ts` already import, so
 * adding a service registers it with its callers without editing anything the
 * developer wrote. Every member's copy is regenerated on every
 * `setu generate app`.
 *
 * The map is honest in a way M50b's would not have been. That milestone wired
 * `ServiceDiscoveryPlugin({ provider: 'static', services: {} })` into the
 * microservice template with a deliberately EMPTY map, because a sample entry
 * would name an instance at a dead port. Here the sibling exists in this same
 * repository and its port was allocated by the same command, so the entry
 * resolves to something that is actually there.
 *
 * @module
 */

import { CONFIG_MODULE } from '../constants.ts';
import type { WorkspaceMember } from './manifest.ts';
import { workspaceProfile, type WorkspaceRuntimeProfile } from './runtime-profile.ts';

/** The module's path, relative to a member's own root. */
export const DISCOVERY_MODULE = 'src/discovery/services.ts';

/** The specifier a member's own modules import {@linkcode DISCOVERY_MODULE} by. */
export const DISCOVERY_SPECIFIER = `./${DISCOVERY_MODULE}`;

/** The exported constant carrying the member's own port. */
export const SERVICE_PORT_EXPORT = 'SERVICE_PORT';

/** The exported constant carrying every sibling's address. */
export const SERVICE_ENDPOINTS_EXPORT = 'SERVICE_ENDPOINTS';

/**
 * The host a generated endpoint falls back to.
 *
 * The members run on one machine during development, and that is the only
 * topology the CLI can know. A deployed topology comes from a real provider arm
 * (`consul`, `kubernetes`, `dns`), not from this file.
 */
const LOCAL_HOST = '127.0.0.1';

/**
 * Builds the environment variable that overrides one sibling's host.
 *
 * Needed because `127.0.0.1` is the wrong answer the moment members stop sharing
 * a machine — and the generated Compose stack is exactly that case. Each member
 * runs in its own container, where loopback is the container itself, so a map
 * naming `127.0.0.1` would have every service dial ITSELF on its sibling's port
 * and time out. The stack sets these variables to the siblings' service names.
 *
 * Same shape as a transport's connection value: an environment read with the
 * local address as its fallback, so `deno task dev` on one machine is unchanged.
 *
 * @param name - The sibling's member name
 * @returns The variable name
 */
export function hostVariable(name: string): string {
  return `${name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_HOST`;
}

/**
 * Folds an environment read onto one line.
 *
 * The profile renders it wrapped for the deep indentation of a plugin argument in
 * `setu.config.ts`; here it sits inside a short object literal, where the wrap
 * would read as a stray blank column.
 *
 * @param expression - The rendered read
 * @returns The same expression on one line
 */
function collapse(expression: string): string {
  return expression.replace(/\s*\n\s*/g, ' ');
}

/**
 * Renders one member's discovery module.
 *
 * `SERVICE_ENDPOINTS` deliberately EXCLUDES the member itself: discovery is for
 * reaching other services, and a self-entry invites a service to route a
 * request back into its own process. Sibling keys are sorted, because the
 * caller's member order comes from a manifest a human may reorder, and an
 * unsorted map would turn a no-op regeneration into a diff.
 *
 * Both constants are emitted for every member, including one whose plugin set
 * has no service discovery: `main.ts` reads the port on every member, and a
 * member that gains the plugin later needs no shape change here.
 *
 * @param member - The member this module belongs to
 * @param all - Every member of the workspace, including `member`
 * @returns The module contents
 */
export function renderDiscoveryModule(
  member: WorkspaceMember,
  all: readonly WorkspaceMember[],
  profile: WorkspaceRuntimeProfile = workspaceProfile('deno'),
): string {
  // Plain `.sort()`, like every other determinism sort in this package
  // (`seamNames`, `readArtifactNames`, `readModuleNames`). `localeCompare`
  // would order by the collation of whatever locale the machine happens to run
  // under, which is the opposite of the property this sort exists for.
  const siblings = all
    .filter((other) => other.name !== member.name)
    .map((other) => other.name)
    .sort();

  const portOf = new Map(all.map((other) => [other.name, other.port]));
  const entries = siblings
    .map((name) =>
      `  '${name}': [{\n` +
      // The profile's reader, not a literal `Deno.env.get`: this module is emitted
      // into Node and Bun members too, where that name does not exist. Its own
      // line breaks are for the deeper indentation of a plugin argument, so they
      // collapse here.
      `    host: ${collapse(profile.envRead(hostVariable(name), LOCAL_HOST))},\n` +
      `    port: ${portOf.get(name)},\n` +
      `  }],\n`
    )
    .join('');

  const endpoints = entries === '' ? '{}' : `{\n${entries}}`;

  return `// Generated by \`setu generate app\`.
// The CLI owns this file and rewrites it whenever a workspace member is added,
// so edits here are lost — add them with the CLI.
//
// \`main.ts\` always consumes ${SERVICE_PORT_EXPORT}. ${SERVICE_ENDPOINTS_EXPORT} is
// consumed by \`${CONFIG_MODULE}\` only when this member's template registers
// \`ServiceDiscoveryPlugin\` — the microservice and full-stack templates do; the
// rest and class-based ones deliberately do not, because a service that is
// REACHABLE and one that RESOLVES its siblings are different properties, and an
// unused import is worse than an absent one. Where it is consumed:
//
//   import { ${SERVICE_ENDPOINTS_EXPORT} } from '${DISCOVERY_SPECIFIER}';
//   ServiceDiscoveryPlugin({ provider: 'static', services: ${SERVICE_ENDPOINTS_EXPORT} })
//
// Otherwise the map is exported for this member to use directly — the endpoints
// are correct either way.
//
//   import { ${SERVICE_PORT_EXPORT} } from '${DISCOVERY_SPECIFIER}';
//   await app.start({ port: ${SERVICE_PORT_EXPORT} });
//
// Each sibling's host falls back to ${LOCAL_HOST} — right when every member runs
// on this machine, wrong the moment they do not, so it is overridable per service
// (\`<MEMBER>_HOST\`). The generated Compose stack sets those variables to the
// siblings' service names, because inside a container loopback is the container
// itself: a fixed ${LOCAL_HOST} would have every service dial ITSELF on its
// sibling's port.
//
// This is still only a LOCAL topology. A deployed one comes from a real discovery
// backend (\`provider: 'consul'\`, \`'kubernetes'\`, \`'dns'\`), not from this file.

/** The port this workspace member binds. */
export const ${SERVICE_PORT_EXPORT} = ${member.port};

/** Every OTHER member of this workspace, by service name. */
export const ${SERVICE_ENDPOINTS_EXPORT} = ${endpoints};
`;
}
