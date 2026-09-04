# Setu-TS — parameterized example image (M39).
#
# Builds ANY example under apps/ through one file, selected with `--build-arg APP=<name>`.
# One parameterized file rather than fifteen near-identical ones: AI_GUIDELINES §11.1.
#
#   docker build -f docker/Dockerfile --build-arg APP=rest-api -t setu/rest-api .
#
# The build context MUST be the repository root. An example's deno.json maps only the packages it
# imports DIRECTLY; `@setu-ts/common` reaches `packages/kernel` through the root workspace. Copy
# `packages/` without the root `deno.json` and the build fails with
#   Could not find version of '@setu-ts/common' that matches '^0.4.0'
# because the caret-prerelease specifier is then resolved against JSR instead of the local member.
#
# Building from source rather than from published JSR is deliberate: an image must track HEAD, and
# during a version bump the pinned version is not published yet.

# Pinned, not floating. A base older than the Deno that wrote the committed lockfiles fails with
# `Unsupported lockfile version '5'`. Both Dockerfiles read this same constant so a Deno bump is a
# one-line change; test/deploy-gate.test.ts asserts they agree.
ARG DENO_VERSION=2.9.6

FROM denoland/deno:alpine-${DENO_VERSION}

# Which example to build. Redeclared after FROM because an ARG before the first FROM is only
# visible to FROM lines.
ARG APP=minimal

WORKDIR /srv

# Workspace root first: it changes far less often than package or application source, so it earns
# its own cache layer.
COPY deno.json deno.lock ./

# Then the framework, then only the selected example. Copying all of apps/ would invalidate this
# layer whenever any unrelated example changed.
COPY packages ./packages
COPY apps/${APP} ./apps/${APP}

WORKDIR /srv/apps/${APP}

# Resolve and cache the full module graph at build time so the container starts without reaching
# the network for its own dependencies.
RUN deno cache main.ts

# Drop privileges. The base image ships a `deno` user; the cache written above lives in DENO_DIR
# and must stay readable to it.
RUN chown -R deno:deno /srv /deno-dir

# NUMERIC, not `USER deno`. Kubernetes' `runAsNonRoot: true` refuses to start a container whose
# image declares a non-numeric user:
#   container has runAsNonRoot and image has non-numeric user (deno), cannot verify user is non-root
# Docker resolves the name from /etc/passwd and runs it happily, so this fails ONLY under
# Kubernetes — which is why it took a real cluster to surface. 1000:1000 is the deno user.
USER 1000:1000

EXPOSE 3000

# Examples read their port from Deno.args[0] (defaulting to 3000), never $PORT — so the port is
# passed positionally. Kubernetes overrides the whole list via the container's `args`.
#
# Permissions are explicit rather than `-A`: this is a security-focused framework and an image
# should not hand a process every capability by default. The set below covers the examples the
# gate builds (net for the socket, env for configuration, read for the module graph and any
# projected service-account token, sys for hostname/os probes in the health and metrics plugins).
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "main.ts", "3000"]
