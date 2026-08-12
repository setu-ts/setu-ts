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
import { rootManifestSettings } from '../templates/root-settings.ts';
import { LIBS_GLOB } from './library.ts';
import { workspaceProfile, type WorkspaceRuntimeProfile } from './runtime-profile.ts';
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
 * @param transport - The bus every member will meet on
 * @param profile - The workspace's runtime, which decides the root's shape
 * @param transportUrl - An override for the transport's local address
 * @returns The files to create, relative to the workspace root
 */
export function workspaceRootFiles(
  name: string,
  basePort: number,
  transport: TransportSpec,
  profile: WorkspaceRuntimeProfile = workspaceProfile('deno'),
  transportUrl?: string,
): readonly GeneratedFile[] {
  // BOTH globs at creation, so neither adding a service nor adding a library ever
  // rewrites this file: a glob matching nothing is valid under both toolchains
  // (measured), which is what makes writing them once correct.
  const globs = [MEMBER_GLOB, LIBS_GLOB];

  // Deno declares members under `workspace`, npm under `workspaces`, and Bun reads
  // npm's — so there are two shapes here, not three. The command that runs every
  // member differs per toolchain even where the shape does not, which is why it
  // comes from the profile rather than from this branch.
  const rootManifest = profile.manifestKind === 'deno'
    ? {
      path: 'deno.json',
      contents: `${
        JSON.stringify(
          {
            workspace: globs,
            tasks: { dev: profile.runAll },
            // Root-only, and inherited by every member: a member declaring them
            // is redundant at best and refused at worst.
            ...rootManifestSettings(),
          },
          null,
          2,
        )
      }\n`,
    }
    : {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name,
            // A root that is never published and never installed as a package:
            // npm refuses to treat a manifest as a workspace root without it.
            private: true,
            // Globs relative to the root, without the `./` Deno's take — npm
            // matches them as written.
            workspaces: globs.map((glob) => glob.replace(/^\.\//, '')),
            scripts: { dev: profile.runAll },
          },
          null,
          2,
        )
      }\n`,
    };

  const readme = `# ${name}

A [Setu-TS](https://github.com/setu-ts/setu-ts) workspace: one repository, many deployable services.

## Add a service

\`\`\`bash
${PROGRAM_NAME} generate app orders --template microservice
\`\`\`

Each service lives in \`${MEMBERS_DIR}/<name>/\`, binds a port the CLI allocates, and is registered in every
other service's static discovery map — so \`discovery.resolveUrl('orders')\` works from any sibling
with no configuration.

## Run every service

\`\`\`bash
${profile.install}
${profile.runScript('dev')}
\`\`\`

## Ports

\`${WORKSPACE_MANIFEST}\` records the port each service binds. It is the source the generated
\`src/discovery/services.ts\` modules are rendered from; change a port there and the next
\`${PROGRAM_NAME} generate app\` rewrites them all.

## Transport

Services talk over **${transport.name}** — ${transport.description}.${
    transport.connection === undefined ? '' : `

Every member reads its connection value from \`${transport.connection.variable}\`,
falling back to \`${transportUrl ?? transport.connection.localDefault}\` when that
is unset. Both halves matter: \`${profile.runScript('dev')}\` on this machine needs the local
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

The transport is a property of the whole workspace, recorded in \`${WORKSPACE_MANIFEST}\`, because
members can only meet on a bus they share. Every service added later inherits it.
`;

  return [
    rootManifest,
    // The `@jsr` scope has to be mapped for members to install framework packages
    // through npm compatibility at all — measured in a two-member workspace, where
    // without it `npm install` cannot resolve `@setu-ts/kernel`. Deno resolves
    // `jsr:` specifiers itself and needs none.
    ...(profile.manifestKind === 'npm'
      ? [{ path: '.npmrc', contents: '@jsr:registry=https://npm.jsr.io\n' }]
      : []),
    {
      path: WORKSPACE_MANIFEST,
      contents: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: profile.runtime,
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
    {
      path: '.gitignore',
      contents: profile.manifestKind === 'deno'
        ? 'coverage/\n'
        // Both locations: Bun installs into each MEMBER's node_modules as well as
        // the root, measured — an ignore listing only the root would commit them.
        : 'node_modules/\napps/*/node_modules/\nlibs/*/node_modules/\ncoverage/\n',
    },
  ];
}
