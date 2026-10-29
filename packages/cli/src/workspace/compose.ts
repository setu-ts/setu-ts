/**
 * The generated workspace's container artifacts: one parameterized Dockerfile and
 * a Compose stack covering every member plus the transport's backing service.
 *
 * M39 owns this repository's OWN deployment objects — `docker/Dockerfile` builds
 * an example under `apps/`, the Helm chart deploys one. Nothing generated anything
 * into a user's project, so a scaffolded workspace with three services and a Redis
 * transport left a developer hand-writing every one of these files, against a
 * README that named a broker endpoint nothing served.
 *
 * The Compose file is {@linkcode GeneratedFile.managed} and regenerated on every
 * `setu generate app`, for the same reason each member's discovery module is: the
 * port a member binds and the port the stack publishes are one datum, and a stack
 * that names two of the three members is worse than none.
 *
 * Five details here are M39's findings rather than choices, and each one was a
 * real failure there:
 *
 * - **The build context is the workspace root.** A member's `deno.json` is
 *   discovered as a workspace member, and the root manifest is what makes the glob
 *   resolve; a context of the member directory alone drops it.
 * - **The base image tag is pinned.** A base older than the Deno that wrote the
 *   committed lockfile fails with `Unsupported lockfile version`, and a floating
 *   tag makes that arrive on an unrelated day.
 * - **`USER` is NUMERIC.** Kubernetes' `runAsNonRoot: true` refuses an image
 *   declaring a non-numeric user (`cannot verify user is non-root`) while Docker
 *   resolves the name happily — so a named user fails only once deployed.
 * - **Permissions are explicit, not `-A`.** The set mirrors the member's own
 *   generated `start` task.
 * - **`stop_grace_period` is honoured** because the generated entry installs a
 *   SIGTERM handler. Without one the window is decorative: the process dies from
 *   the signal in milliseconds.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import { hostVariable } from './discovery-module.ts';
import { LIBS_DIR } from './library.ts';
import { MEMBERS_DIR, type WorkspaceManifest } from './manifest.ts';
import { workspaceProfile, type WorkspaceRuntimeProfile } from './runtime-profile.ts';
import type { TransportSpec } from './transport.ts';

/** Where the workspace's container artifacts live, relative to its root. */
export const DOCKER_DIR = 'docker';

/** The generated Compose file's path, relative to the workspace root. */
export const COMPOSE_FILE: string = `${DOCKER_DIR}/compose.yaml`;

/** The generated Dockerfile's path, relative to the workspace root. */
export const DOCKERFILE: string = `${DOCKER_DIR}/Dockerfile`;

/**
 * The generated ignore file's path — at the workspace ROOT, not beside the
 * Dockerfile.
 *
 * Docker reads `<context>/.dockerignore`, and the build context here is the
 * workspace root (it has to be: a member resolves its dependencies through the
 * root manifest). A `.dockerignore` under `docker/` is read by nothing.
 */
export const DOCKERIGNORE = '.dockerignore';

/**
 * The Deno image the generated Dockerfile builds on.
 *
 * Pinned deliberately — see this module's own notes. Bumping it is a one-line
 * change because both the Dockerfile and the Compose file read it from here.
 */
const DENO_IMAGE = 'denoland/deno:alpine-2.9.5';

/**
 * The optional build secret every generated install step mounts (M120b).
 *
 * `.npmrc` never reaches a build context (`.dockerignore`), so a private
 * registry's token or a setting such as `legacy-peer-deps` reaches the install
 * only this way: `docker build --secret id=npmrc,src=.npmrc …`, or `NPMRC` in the
 * generated Compose file. Mounted for that one `RUN`, so it is never in a layer,
 * the history or the cache. Optional: without `--secret` the mount is absent and
 * the install runs exactly as before (measured, BuildKit). npm, Bun and Deno all
 * read `/root/.npmrc` in these root build steps (measured). Needs BuildKit.
 */
const NPMRC_MOUNT = '--mount=type=secret,id=npmrc,target=/root/.npmrc';

/**
 * The glibc Deno image a full-stack member's frontend is built in (M120 §3.7).
 *
 * Same Deno version as {@linkcode DENO_IMAGE}. Vite's bundler ships its native
 * binding per libc, and an install on Alpine finds no musl build of it
 * (measured: \`Cannot find module './rolldown-binding.linux-x64-musl.node'\`),
 * so the frontend is built here and only its output is copied into the
 * Alpine image.
 */
const DENO_BUILD_IMAGE = 'denoland/deno:debian-2.9.5';

/**
 * The numeric uid the `denoland/deno` image's own `deno` user has.
 *
 * Named `deno` in that image; written as a number because Kubernetes cannot
 * verify a named user is non-root.
 */
const DENO_UID = '1000';

/** The Node image an npm workspace's members are built into. Pinned, not floating. */
const NODE_IMAGE = 'node:24-alpine';

/** The `node` user's uid in the official Node image. */
const NODE_UID = '1000';

/** The Bun image a Bun workspace's members are built into. */
const BUN_IMAGE = 'oven/bun:1-alpine';

/** The `bun` user's uid in the official Bun image. */
const BUN_UID = '1000';

/**
 * Builds the workspace's Dockerfile.
 *
 * One file for every member, selected with `--build-arg MEMBER=<name>`, rather
 * than one per member: AI_GUIDELINES §11.1, and it is what keeps a workspace's
 * tenth service from needing a tenth near-identical file.
 *
 * @returns The Dockerfile contents
 */
export function renderDockerfile(profile: WorkspaceRuntimeProfile, workspace = true): string {
  if (profile.manifestKind === 'npm') return npmDockerfile(profile, workspace);

  const source = `# Generated by \`setu\`. Builds ANY member of this workspace:
#
#   docker build -f ${DOCKERFILE} --build-arg MEMBER=orders -t orders .
#
# The build context MUST be the workspace root (note the trailing \`.\`). A member's
# deno.json is resolved as a workspace member, and the root manifest is what makes
# the glob resolve — a context of the member directory alone drops it.
#
# The tag is pinned, not floating: a Deno older than the one that wrote deno.lock
# fails with \`Unsupported lockfile version\`, and a floating tag makes that failure
# arrive on a day you changed nothing.

# A member with a frontend (full-stack) declares a \`build\` task, and its
# main.ts imports the server build that task writes. This stage runs it on a
# glibc image, because Vite's native bundler binding has no musl build; a member
# without the task gets an empty \`build/\`, so the copy below never fails. The
# task is detected by PARSING the member manifest with the pinned parser, never
# by matching text.
FROM ${DENO_BUILD_IMAGE} AS frontend
ARG MEMBER
WORKDIR /srv
COPY deno.json* deno.lock* ./
COPY lib[s] ./${LIBS_DIR}/
COPY ${MEMBERS_DIR}/\${MEMBER} ./${MEMBERS_DIR}/\${MEMBER}
WORKDIR /srv/${MEMBERS_DIR}/\${MEMBER}
ARG NPM_CONFIG_REGISTRY=
RUN ${NPMRC_MOUNT} printf '%s' 'import { parse } from "jsr:@std/jsonc@1.0.3"; for (const name of ["deno.json", "deno.jsonc"]) { let source; try { source = Deno.readTextFileSync(name); } catch (error) { if (error instanceof Deno.errors.NotFound) continue; throw error; } const manifest = parse(source); if (manifest.tasks && "build" in manifest.tasks) Deno.writeTextFileSync(".setu-build-task", ""); break; }' | DENO_DIR=/tmp/.setu-build-cache deno run --no-config --no-lock --no-prompt --allow-read=./deno.json,./deno.jsonc --allow-write=./.setu-build-task - && if [ -z "$NPM_CONFIG_REGISTRY" ]; then unset NPM_CONFIG_REGISTRY; fi && if [ -f .setu-build-task ]; then deno task build; else mkdir -p build; fi

FROM ${DENO_IMAGE}

# Which member to build. Redeclared after FROM because an ARG before the first
# FROM is visible only to FROM lines.
ARG MEMBER

WORKDIR /srv

# The root manifest and lockfile first: they change far less often than member
# source, so they earn their own cache layer.
COPY deno.json* deno.lock* ./

# Every shared library, because a member may import any of them by name and the
# workspace resolves that name through ${LIBS_DIR}/. The bracket glob is what makes
# this tolerate a workspace with no libraries: an ordinary \`COPY ${LIBS_DIR}\` fails
# the build outright when the directory is absent, while \`lib[s]\` matches nothing
# and copies nothing.
COPY lib[s] ./${LIBS_DIR}/

# Then only the selected member. Copying all of ${MEMBERS_DIR}/ would invalidate
# this layer whenever any unrelated member changed.
COPY ${MEMBERS_DIR}/\${MEMBER} ./${MEMBERS_DIR}/\${MEMBER}

WORKDIR /srv/${MEMBERS_DIR}/\${MEMBER}

# The frontend output, built in the stage above (empty for a member without one).
COPY --from=frontend /srv/${MEMBERS_DIR}/\${MEMBER}/buil[d] ./build/

# Three steps, and the LAST one is the guarantee. Deno records a jsr package's
# npm edge list NONDETERMINISTICALLY on a cold cache: four \`--no-cache\` builds of
# one unchanged workspace produced \`@setu-ts/messaging-plugin\` entries missing
# \`npm:amqplib\`/\`npm:ioredis\` twice and complete twice, while both packages were
# recorded in the lockfile's package section every time. Runtime \`--frozen\` does
# not write the lockfile, so against an incomplete one it REFUSES — the container
# dies at registration reporting a stale lockfile, from an image that built green.
#
# So \`deno cache main.ts\` compiles the entry's graph into the image, \`deno install\`
# completes the edge lists the frozen check compares against, and \`deno install --frozen\` VERIFIES
# it: an edge still missing fails the BUILD, loudly and once, rather than every
# container at startup. With the verify in place four consecutive cold builds were
# complete, and that is structural rather than luck — an incomplete lockfile
# cannot reach a published image.
#
# Together they are the no-external-network, no-lockfile-write guarantee that
# check:deploy --generated proves: it scaffolds a workspace, builds this file, and
# boots its real broker drivers under --read-only with no external network (shared
# loopback).
#
# The chown FOLDS into this same RUN (X10-5): a standalone \`chown -R\` rewrites
# metadata on every file the cache layer created, so overlayfs copies the
# ENTIRE module cache into a second layer — measured at 563 MB vs 362 MB with
# the fold, paid on every push and every node pull.
# Remove the development-only pin before resolving the production import map.
# Deno 2.9 needs the full-map install pair to complete lazy broker npm edges;
# an entrypoint-only frozen install can pass while the real broker later refuses.
# The parser is pinned to an exact version and may read and write only the
# member and root manifests, so this unlocked fetch cannot float or touch any
# other file in the image.
RUN printf '%s' 'import { parse } from "jsr:@std/jsonc@1.0.3"; for (const directory of [".", "/srv"]) { for (const name of ["deno.json", "deno.jsonc"]) { const path = directory + "/" + name; let source; try { source = Deno.readTextFileSync(path); } catch (error) { if (error instanceof Deno.errors.NotFound) continue; throw error; } const manifest = parse(source); if (manifest.imports) delete manifest.imports["@setu-ts/diagnostics-plugin"]; Deno.writeTextFileSync(path, JSON.stringify(manifest)); break; } }' | DENO_DIR=/srv/.setu-build-cache deno run --no-config --no-lock --no-prompt --allow-read=./deno.json,./deno.jsonc,/srv/deno.json,/srv/deno.jsonc --allow-write=./deno.json,./deno.jsonc,/srv/deno.json,/srv/deno.jsonc - && rm -rf /srv/.setu-build-cache
# The registry the install step resolves from. Unset by default, which is the
# public npm registry; a gate building against a local registry passes it with
# \`--build-arg\`. An ARG never reaches the running container's environment, but
# its value IS recorded in the image history: pass a registry URL here, never a
# credential — an authenticated registry belongs in a \`--secret\` mount.
ARG NPM_CONFIG_REGISTRY=

# After the installs, a root \`nodeModulesDir: "auto"\` (a workspace with a
# full-stack member sets it) is switched to "manual": under "auto" every
# \`deno run\` re-syncs node_modules and re-creates each workspace library's
# symlink, which the read-only root refuses (measured: \`File exists (os error
# 17), symlink '../../libs/shared'\`), so EVERY member failed to start. "manual"
# uses the node_modules this build installed. The root manifest is plain JSON
# by now, rewritten by the step above.
RUN ${NPMRC_MOUNT} if [ -z "$NPM_CONFIG_REGISTRY" ]; then unset NPM_CONFIG_REGISTRY; fi && deno cache main.ts && deno install && deno install --frozen && deno install --entrypoint main.ts && deno install --entrypoint main.ts --frozen && printf '%s' 'for (const name of ["deno.json", "deno.jsonc"]) { const path = "/srv/" + name; let source; try { source = Deno.readTextFileSync(path); } catch (error) { if (error instanceof Deno.errors.NotFound) continue; throw error; } const manifest = JSON.parse(source); if (manifest.nodeModulesDir === "auto") { manifest.nodeModulesDir = "manual"; Deno.writeTextFileSync(path, JSON.stringify(manifest)); } break; }' | deno run --no-config --no-prompt --allow-read=/srv/deno.json,/srv/deno.jsonc --allow-write=/srv/deno.json,/srv/deno.jsonc - && chown -R ${DENO_UID}:${DENO_UID} /srv /deno-dir

# NUMERIC, not \`USER deno\`: Kubernetes' runAsNonRoot refuses an image whose user
# is a name — "cannot verify user is non-root" — while Docker resolves it happily,
# so a named user fails only once deployed.
USER ${DENO_UID}:${DENO_UID}

# No EXPOSE: every member binds a DIFFERENT port, allocated by the CLI and read
# from its own generated discovery module, so there is no one number this
# parameterized file could name. The Compose stack publishes each member's port.

# Explicit permissions rather than \`-A\`: this is a security-focused framework and
# an image should not hand its process every capability. The set mirrors the
# member's own generated \`start\` task, plus \`--allow-sys\` for the hostname and
# platform probes the health and metrics plugins make.
#
# Keep build-time resolution, and fail rather than updating the shipped lock.
CMD ["run", "--frozen", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "main.ts"]
`;
  return workspace
    ? source
    : // A standalone project: the context is the project root and there is no
      // member, so the workspace-only header and comments go with the lines.
      source
        .replace(
          /^# Generated by[\s\S]*?(?=# The tag is pinned)/,
          "# Generated by `setu`. Builds this project's image from its root:\n#\n" +
            '#   docker build -t <name> .\n#\n',
        )
        .replace(/^# Which member to build\.[^\n]*\n# FROM[^\n]*\n/m, '')
        .replace(/^# Every shared library[\s\S]*?copies nothing\.\n/m, '')
        .replace(/^# Then only the selected member[\s\S]*?changed\.\n/m, '')
        .replaceAll('ARG MEMBER\n', '')
        .replaceAll('COPY deno.json* deno.lock* ./', 'COPY . .')
        .replaceAll('COPY lib[s] ./libs/', '')
        .replaceAll('COPY apps/${MEMBER} ./apps/${MEMBER}', '')
        .replaceAll('WORKDIR /srv/apps/${MEMBER}', 'WORKDIR /srv')
        .replace(
          'COPY --from=frontend /srv/apps/${MEMBER}/buil[d]',
          'COPY --from=frontend /srv/buil[d]',
        )
        .replace(/\n{3,}/g, '\n\n');
}

/**
 * Builds the workspace's `.dockerignore`.
 *
 * Two things go wrong without one, and the second is the expensive one. The whole
 * context is uploaded to the daemon, so `.git` and every `node_modules` travel
 * with every build. And `COPY apps/${'${MEMBER}'}` then lays the HOST's
 * `node_modules` over the one the image just installed — host-built native
 * binaries inside a Linux image, and the carefully separated install layer
 * invalidated by any local install.
 *
 * Both member and library locations are named, not only the root one: `bun
 * install` populates each member's own `node_modules` (measured), and npm does
 * too whenever a member needs a version the root cannot hoist.
 *
 * @returns The ignore file's contents
 */
export function renderDockerignore(): string {
  const lines = [
    '# Generated by `setu`. The build context is the workspace ROOT, so this is',
    '# what never reaches the daemon — and, for node_modules, what must never be',
    '# copied over what the image installed for itself.',
    '.git',
    '.gitignore',
    'coverage',
    '**/dist',
    '**/build',
    'main.dev.ts',
    `${MEMBERS_DIR}/*/main.dev.ts`,
    // Dotenv files never reach an image, wherever a member keeps them.
    '# Dotenv files whose names are .env or .env.*, except .env.example, which is',
    '# kept for the image. A custom --env-file name such as local.env is NOT',
    '# covered by these rules; add its path from here (apps/<member>/local.env).',
    '**/.env',
    '**/.env.*',
    '!**/.env.example',
    // Registry credentials never reach an image either (M120 audit F2): Bun and
    // Deno images copy source, so a member's .npmrc would ship. A private
    // registry's token belongs in a build secret
    // (`RUN --mount=type=secret,id=npmrc,target=/root/.npmrc`), as Docker
    // recommends. bunfig.toml is copied (its linker setting is needed), so it
    // must name tokens through environment variables, never literally.
    '# Registry credentials: pass a private registry token as a build secret.',
    '**/.npmrc',
    // The Dockerfile itself is passed with -f and read from the client, so
    // ignoring the directory costs nothing and keeps k8s/ and docker/ out of the
    // image.
    'k8s',
    '**/*.md',
    // Named for EVERY runtime, not only the npm ones: a Deno workspace holding a
    // member with a frontend build has a real `node_modules` too — that is what
    // `nodeModulesDir: auto` is for.
    'node_modules',
    `${MEMBERS_DIR}/*/node_modules`,
    `${LIBS_DIR}/*/node_modules`,
  ];

  return `${lines.join('\n')}\n`;
}

/**
 * The image a Node or Bun workspace member is built into.
 *
 * Both stages resolve through the root manifest and lockfile. The build has
 * development tools; Node's runtime installs only the selected member and
 * libraries' production dependencies. Bun keeps the workspace's hoisted layout.
 *
 * The install step is the profile's, and so is what gets copied afterwards —
 * measured: `bun install` populates the MEMBER's `node_modules` as well as the
 * root, so an image that copied only a hoisted root would start a Bun member with
 * nothing to import.
 *
 * @param profile - The workspace's runtime profile
 * @returns The Dockerfile contents
 */
function npmDockerfile(profile: WorkspaceRuntimeProfile, workspace: boolean): string {
  const image = profile.runtime === 'bun' ? BUN_IMAGE : NODE_IMAGE;
  const uid = profile.runtime === 'bun' ? BUN_UID : NODE_UID;
  const bun = profile.runtime === 'bun';
  const member = workspace ? 'apps/${MEMBER}' : '.';
  const manifests = `COPY package.json ${profile.lockfile}* ./\n${workspace ? `COPY apps/\${MEMBER}/package.json ./apps/\${MEMBER}/\nCOPY lib[s] ./libs/\n${bun ? `COPY bunfig.tom[l] ./\n` : ''}` : ''}`;
  const install = bun ? 'bun install --frozen-lockfile' : 'npm ci';
  const guard = 'if [ -z "$NPM_CONFIG_REGISTRY" ]; then unset NPM_CONFIG_REGISTRY; fi';
  const build = bun
    ? `if [ "$(bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).scripts?.build === undefined ? "" : "build")')" = build ]; then bun run build; fi`
    : `npm run build${workspace ? ' --workspace apps/${MEMBER}' : ''}`;

  return `# Generated by \`setu\`. Build from the ${workspace ? 'workspace' : 'project'} root.
FROM ${image} AS build
${workspace ? 'ARG MEMBER\n' : ''}WORKDIR /srv
${manifests}
ARG NPM_CONFIG_REGISTRY=
RUN ${NPMRC_MOUNT} ${guard} && ${install}
COPY ${member} ${workspace ? `./${member}` : '.'}
${bun ? `WORKDIR /srv${workspace ? '/apps/${MEMBER}' : ''}\n` : ''}RUN ${build}

FROM ${image} AS runtime
${workspace ? 'ARG MEMBER\n' : ''}WORKDIR /srv
${manifests}
ARG NPM_CONFIG_REGISTRY=
RUN ${NPMRC_MOUNT} ${guard} && ${install}${bun ? ' --production' : ` --omit=dev${workspace ? ' --workspace apps/${MEMBER} --workspace libs' : ''}`}
${bun ? `COPY ${member} ${workspace ? `./${member}` : '.'}\n` : ''}WORKDIR /srv${workspace ? '/apps/${MEMBER}' : ''}
${bun ? '' : `COPY --from=build /srv${workspace ? '/apps/${MEMBER}' : ''}/dist ./dist\n`}COPY --from=build /srv${workspace ? '/apps/${MEMBER}' : ''}/buil[d] ./build/
# NUMERIC, not a name: Kubernetes can verify this user is non-root.
USER ${uid}:${uid}
CMD ${bun ? '["bun", "run", "main.ts"]' : '["node", "--enable-source-maps", "dist/main.js"]'}
`;
}

/**
 * The environment one member needs to reach everything else in a cluster.
 *
 * Shared by the Compose stack and the Kubernetes objects, because the answer is
 * the same in both and for the same reason: a sibling is reachable by its SERVICE
 * NAME, never by the loopback address the generated map falls back to. Two copies
 * of this would let one deployment target keep working while the other silently
 * routed every request into the caller's own container.
 *
 * @param siblings - Every OTHER member of the workspace
 * @param transport - The workspace's transport
 * @returns Variable → value
 */
export function memberEnvironment(
  siblings: readonly WorkspaceManifest['members'][number][],
  transport: TransportSpec,
): Readonly<Record<string, string>> {
  return {
    ...Object.fromEntries(siblings.map((sibling) => [hostVariable(sibling.name), sibling.name])),
    ...transport.compose?.memberEnv,
  };
}

/**
 * Renders one member's Compose service.
 *
 * The container listens on the member's OWN allocated port and publishes it
 * unchanged, so one number describes the service everywhere: what it binds, what
 * the host reaches it on, and what every sibling's discovery map names. Remapping
 * to a fixed container port would need the entry to read a `PORT` variable it does
 * not read.
 *
 * @param name - The member's directory name
 * @param port - The port it binds
 * @param siblings - Every other member, whose host variables this service sets
 * @param transport - The workspace's transport, read for its backing service
 * @returns The service definition, indented for Compose's `services:` key
 */
function memberService(
  name: string,
  port: number,
  siblings: readonly WorkspaceManifest['members'][number][],
  transport: TransportSpec,
): string {
  const backing = transport.compose;

  // Each sibling by SERVICE NAME. Without these the member's generated map falls
  // back to loopback, which inside a container is the member itself.
  const envLines = Object.entries(memberEnvironment(siblings, transport))
    .map(([key, value]) => `      ${key}: '${value}'`)
    .join('\n');

  // Only when there is something to set (M120b §3.6): an `environment:` key with
  // nothing under it is YAML null, and Compose refuses the whole file —
  // `services.<member>.environment must be a mapping` — which is what a
  // one-member workspace on a transport adding no variables used to render.
  const environmentBlock = envLines === '' ? '' : `\n    environment:\n${envLines}`;

  const dependsOn = backing?.dependsOn ?? [];
  const dependsBlock =
    dependsOn.length === 0
      ? ''
      : `
    depends_on:
${dependsOn
  .map((service) => `      ${service}:\n        condition: ${backing?.condition}`)
  .join('\n')}`;

  return `  ${name}:
    # The name the Kubernetes manifest's comment builds, so \`docker compose build\`
    # and a hand-built image are the same image.
    image: ${name}:dev
    build:
      context: ..
      dockerfile: ${DOCKERFILE}
      args:
        MEMBER: ${name}
      # The optional npm configuration (registry token, settings) for the
      # image's install steps; see the secrets block at the end of this file.
      secrets:
        - npmrc
    ports:
      - '${port}:${port}'
    # The member's own variables (SESSION_SECRET, …) from its gitignored .env,
    # when it has one. The environment: entries below win over it, so it cannot
    # redirect a sibling host. Compose follows a link here: on a branch you did not
    # write, run \`setu check\` (it refuses a linked .env) before \`compose up\`.
    env_file:
      - path: ../${MEMBERS_DIR}/${name}/.env
        required: false${environmentBlock}${dependsBlock}
    # The messaging plugin connects to its broker during plugin registration and
    # does not retry, so a member that loses the race to a backing service whose
    # image cannot be health-probed exits. Compose brings it back until the broker
    # answers.
    restart: unless-stopped
    # Honoured because the generated entry installs a SIGTERM handler; without one
    # the process dies from the signal in milliseconds and this window is
    # decorative.
    stop_grace_period: 30s
`;
}

/**
 * Builds the container artifacts for a workspace.
 *
 * The Compose file lists every member, so it is regenerated on each
 * `generate app` exactly as the discovery modules are — and is `managed` for the
 * same reason: the CLI owns it, and refusing to overwrite it would make the second
 * member fail.
 *
 * @param manifest - The workspace as it will be after the current command
 * @param transport - The workspace's transport
 * @param profile - The runtime profile; defaults to the one the manifest records
 * @returns The files to write, relative to the workspace root
 */
export function workspaceContainerFiles(
  manifest: WorkspaceManifest,
  transport: TransportSpec,
  profile: WorkspaceRuntimeProfile = workspaceProfile(manifest.runtime),
): readonly GeneratedFile[] {
  const backing = transport.compose;

  // Sorted, so a manifest a human has reordered does not turn a no-op
  // regeneration into a diff — the same reason the discovery map sorts.
  // Two-way, not three-way: member names are unique by construction (the command
  // refuses a duplicate), so an equal-names arm would be a branch no input can
  // reach.
  const members = [...manifest.members].sort((left, right) => (left.name < right.name ? -1 : 1));

  const services = members
    .map((member) =>
      memberService(
        member.name,
        member.port,
        members.filter((other) => other.name !== member.name),
        transport,
      ),
    )
    .join('\n');

  const compose = `# Generated by \`setu generate app\`.
# The CLI owns this file and rewrites it whenever a member is added, so edits here
# are lost — the member list and the ports come from setu.workspace.json.
#
#   docker compose -f ${COMPOSE_FILE} up --build
#
# This is the LOCAL topology. A deployed one uses a real registry, a real service
# discovery backend (\`provider: 'consul'\`, \`'kubernetes'\`, \`'dns'\`), and the
# Kubernetes objects under k8s/.

name: ${'${COMPOSE_PROJECT_NAME:-setu-workspace}'}

services:
${services}${backing === undefined ? '' : `\n${backing.services}`}
# Passes the build secret every install step mounts. From an environment
# variable, not a file: unset, it is empty and the build is unchanged; a file
# source would fail every build where the file is absent (measured).
#
#   NPMRC="$(cat .npmrc)" docker compose -f ${COMPOSE_FILE} up --build
secrets:
  npmrc:
    environment: NPMRC
`;

  return [
    { path: DOCKERFILE, contents: renderDockerfile(profile), managed: true },
    { path: DOCKERIGNORE, contents: renderDockerignore(), managed: true },
    { path: COMPOSE_FILE, contents: compose, managed: true },
    ...(backing?.files ?? []).map((file) => ({ ...file, managed: true })),
  ];
}
