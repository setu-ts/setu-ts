/**
 * The workspace root — the files `setu new <name> --workspace` creates.
 *
 * Root metadata, a dev runner, and no member. The root registers no plugins and starts no server;
 * it exists so Deno sees one workspace and the CLI has somewhere to record its
 * members.
 *
 * @module
 */

import { cliCommand, cliInvocation } from '../templates/project-files.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import {
  MEMBERS_DIR,
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
} from './manifest.ts';
import { rootManifestSettings } from '../templates/root-settings.ts';
import { LIBS_GLOB, BUNFIG_FILE, BUN_WORKSPACE_CONFIG } from './library.ts';
import { workspaceProfile, type WorkspaceRuntimeProfile } from './runtime-profile.ts';
import { workspaceDevRunner } from './dev-runner.ts';
import type { TransportSpec } from './transport.ts';
import { wrapProse } from '../utils/wrap-prose.ts';

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
  profile: WorkspaceRuntimeProfile = workspaceProfile('node'),
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
  const rootManifest =
    profile.manifestKind === 'deno'
      ? {
          path: 'deno.json',
          contents: `${JSON.stringify(
            {
              workspace: globs,
              // No `test` task: Deno's recursion includes the root, so a root `test` running it
              // would call itself without end (measured, M122). `deno task --recursive test`
              // from the root is the command, as the README says.
              tasks: {
                dev: profile.runAll,
                ...(profile.rootTestTask ? { test: profile.testAll } : {}),
                build: cliCommand(profile.runtime, 'workspace build'),
                deploy: cliCommand(profile.runtime, 'workspace deploy'),
              },
              // Root-only, and inherited by every member: a member declaring them
              // is redundant at best and refused at worst.
              ...rootManifestSettings(),
              // So the Node `setu` CLI can import a member's `setu.config.ts`:
              // `deno install` links every member's npm packages, and each
              // library declaring a `package.json`, into this `node_modules`
              // (M111d §3.4).
              nodeModulesDir: 'auto',
            },
            null,
            2,
          )}\n`,
        }
      : {
          path: 'package.json',
          contents: `${JSON.stringify(
            {
              name,
              // A root that is never published and never installed as a package:
              // npm refuses to treat a manifest as a workspace root without it.
              private: true,
              // Globs relative to the root, without the `./` Deno's take — npm
              // matches them as written.
              workspaces: globs.map((glob) => glob.replace(/^\.\//, '')),
              scripts: {
                dev: profile.runAll,
                ...(profile.rootTestTask ? { test: profile.testAll } : {}),
                build: cliCommand(profile.runtime, 'workspace build'),
                deploy: cliCommand(profile.runtime, 'workspace deploy'),
              },
              // Scarf (pulled in by a member's `swagger-ui-dist`) reads its
              // opt-out from the package.json at npm's INIT_CWD — this root —
              // and ignores a member's own setting (M113f audit R2-F6).
              scarfSettings: { enabled: false },
            },
            null,
            2,
          )}\n`,
        };

  const readme = `# ${name}

A [Setu-TS](https://github.com/setu-ts/setu-ts) workspace: one repository, many deployable services.

## Add a service

\`\`\`bash
${cliInvocation(profile.runtime)} generate app orders --template microservice
\`\`\`

Each service lives in \`${MEMBERS_DIR}/<name>/\`, binds a port the CLI allocates, and is registered in every
other service's static discovery map — so \`discovery.resolveUrl('orders')\` works from any sibling
with no configuration.

## Run every service

\`\`\`bash
${profile.install}
${profile.runScript('dev')}
\`\`\`

When a service needs another one during startup, declare it as it is added:

\`\`\`bash
${cliInvocation(profile.runtime)} generate app billing --template microservice --depends-on orders
\`\`\`

The generated dev runner starts prerequisites first and waits for each prerequisite's \`/ready\`
endpoint before it starts a dependent. Dependencies are explicit because a discovery map describes
where a service is, not whether this service must wait for it at startup.

## Ports

\`${WORKSPACE_MANIFEST}\` records the port each service binds. It is the source the generated
\`src/discovery/services.ts\` modules are rendered from; change a port there and the next
\`${cliInvocation(profile.runtime)} generate app\` rewrites them all.

${wrapProse(`If a local process occupies a port, the CLI skips it during allocation. To repair existing
assignments, stop the services and run \`${cliInvocation(profile.runtime)} workspace ports --reallocate\`; it rewrites the
manifest, maps, and deployment artifacts together. It assigns from the base port upward, so a
service still running holds its own port and is moved off it.`)}

## Transport

Services talk over **${transport.name}** — ${transport.description}.${
    transport.connection === undefined
      ? ''
      : `

${wrapProse(
  `Every member reads its connection value from \`${transport.connection.variable}\`, ` +
    `falling back to \`${transportUrl ?? transport.connection.localDefault}\` when that ` +
    `is unset. Both halves matter: \`${profile.runScript('dev')}\` on this machine needs ` +
    `the local address, and the generated Compose stack overrides the variable with the ` +
    `broker's service name, because two containers do not share a loopback interface.`,
)}${transport.connection.note === undefined ? '' : `\n\n${wrapProse(transport.connection.note)}`}`
  }${
    transport.compose === undefined
      ? ''
      : `

## Run the stack

\`\`\`bash
docker compose -f docker/compose.yaml up --build
\`\`\`

That builds every member and starts the ${transport.name} service they share.`
  }

The transport is a property of the whole workspace, recorded in \`${WORKSPACE_MANIFEST}\`, because
members can only meet on a bus they share. Every service added later inherits it.

## Test, build and deploy

\`\`\`bash
${profile.testFromRoot}     # every member's and library's tests
${profile.runScript('build')}    # one container image per member, tagged with the current commit
${profile.runScript('deploy')}   # build, ship to the cluster, apply k8s/, wait for every rollout
\`\`\`

${wrapProse(
  "Deploy loads the images into a `kind-*` context's cluster, or pushes them to `--registry` for any " +
    "other context. A member's variables are the names its `.env.example` declares; put their values " +
    'in `k8s/secrets/<member>/.env`, which git ignores and no image copies. See ' +
    '`k8s/README.md` for every flag, and run deploy with `--dry-run` to see the plan first.',
)}

## Build and start one member

\`\`\`bash
cd apps/orders
${profile.runtime === 'node' ? 'npm run build\nnpm start' : profile.runtime === 'bun' ? 'bun run start' : 'deno task start'}
\`\`\`

${wrapProse('Full-stack Bun members also run `bun run build` before starting. Node builds inline shared libraries and keep npm dependencies external.')}
`;

  return [
    rootManifest,
    workspaceDevRunner(profile),
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
    ...(profile.runtime === 'bun' ? [{ path: BUNFIG_FILE, contents: BUN_WORKSPACE_CONFIG }] : []),
    {
      path: '.gitignore',
      contents:
        profile.manifestKind === 'deno'
          ? 'node_modules/\ncoverage/\napps/*/build/\n.react-router/\n.env\n.env.*\n!.env.example\nk8s/secrets/\n'
          : // Both locations: Bun installs into each MEMBER's node_modules as well as
            // the root, measured — an ignore listing only the root would commit them.
            // `.react-router/` is unanchored, so it covers a full-stack member's
            // typegen directory as well as the root's. The dotenv rules are
            // unanchored too, so they cover each member's own `.env`.
            'node_modules/\napps/*/node_modules/\nlibs/*/node_modules/\ncoverage/\n' +
            'apps/*/dist/\napps/*/build/\n.react-router/\n.env\n.env.*\n!.env.example\n' +
            // Operator values for `setu workspace deploy`; each file is named `.env`, so the rule
            // above already covers it in an older root (M122).
            'k8s/secrets/\n',
    },
  ];
}
