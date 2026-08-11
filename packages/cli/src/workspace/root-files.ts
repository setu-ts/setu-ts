/**
 * The workspace root — the files `setu new <name> --workspace` creates.
 *
 * Four files and no member. The root registers no plugins and starts no server;
 * it exists so Deno sees one workspace and the CLI has somewhere to record its
 * members.
 *
 * @module
 */

import { PROGRAM_NAME } from '../constants.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import {
  MEMBERS_DIR,
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
} from './manifest.ts';
import type { TransportSpec } from './transport.ts';

/**
 * The member pattern the root `deno.json` declares.
 *
 * A GLOB, not a list. Measured against Deno 2.9: `deno task --recursive` runs
 * every member a glob matches, and a root whose glob matches nothing still runs
 * — so a member is added by creating a directory, and the root manifest is
 * written once and never rewritten. That is what keeps this milestone's promise
 * that no file the developer owns is ever edited.
 */
const MEMBER_GLOB = `./${MEMBERS_DIR}/*`;

/**
 * Builds the workspace root's file set.
 *
 * Framework packages are deliberately absent from the root import map: a
 * member's `deno.json` carries its own pins, because `setu generate` detects
 * installed plugins by reading ONE directory's manifest and never walks up — so
 * pins living only here would make every gated schematic refuse inside a member.
 * Members' import maps merge with the root's rather than replacing it, so
 * per-member pins are additive and two members may legitimately install
 * different plugin sets.
 *
 * @param name - The workspace directory name, used in the README
 * @param basePort - The port the first member will bind
 * @returns The files to create, relative to the workspace root
 */
export function workspaceRootFiles(
  name: string,
  basePort: number,
  transport: TransportSpec,
  transportUrl?: string,
): readonly GeneratedFile[] {
  const denoJson = {
    workspace: [MEMBER_GLOB],
    tasks: {
      // `--recursive` runs the task in every member. Each member binds the port
      // the CLI allocated it, so the whole workspace comes up on one command
      // without a port collision.
      dev: 'deno task --recursive start',
    },
  };

  const readme = `# ${name}

A [Setu-TS](https://github.com/setu-ts/setu-ts) workspace: one repository, many
deployable services.

## Add a service

\`\`\`bash
${PROGRAM_NAME} generate app orders --template microservice
\`\`\`

Each service lives in \`${MEMBERS_DIR}/<name>/\`, binds a port the CLI allocates,
and is registered in every other service's static discovery map — so
\`discovery.resolveUrl('orders')\` works from any sibling with no configuration.

## Run every service

\`\`\`bash
deno task dev
\`\`\`

## Ports

\`${WORKSPACE_MANIFEST}\` records the port each service binds. It is the source
the generated \`src/discovery/services.ts\` modules are rendered from; change a
port there and the next \`${PROGRAM_NAME} generate app\` rewrites them all.

## Transport

Services talk over **${transport.name}** — ${transport.description}.${
    transport.connection === undefined ? '' : `

Every member reads its connection value from \`${transport.connection.variable}\`,
falling back to \`${transportUrl ?? transport.connection.localDefault}\` when that
is unset. Both halves matter: \`deno task dev\` on this machine needs the local
address, and the generated Compose stack overrides the variable with the broker's
service name, because two containers do not share a loopback interface.${
      transport.connection.note === undefined ? '' : `\n\n${transport.connection.note}`
    }`
  }${
    transport.compose === undefined ? '' : `

## Run the stack

\`\`\`bash
docker compose -f docker/compose.yaml up --build
\`\`\`

That builds every member and starts the ${transport.name} service they share.`
  }

The transport is a property of the whole workspace, recorded in
\`${WORKSPACE_MANIFEST}\`, because members can only meet on a bus they share.
Every service added later inherits it.
`;

  return [
    { path: 'deno.json', contents: `${JSON.stringify(denoJson, null, 2)}\n` },
    {
      path: WORKSPACE_MANIFEST,
      contents: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        basePort,
        transport: transport.name,
        // Recorded only when it differs from the transport's own default, so
        // the manifest states a choice rather than restating a constant that
        // already lives in the CLI.
        ...(transportUrl === undefined ? {} : { transportUrl }),
        members: [],
      }),
    },
    { path: 'README.md', contents: readme },
    { path: '.gitignore', contents: 'coverage/\n' },
  ];
}
