# Milestone 120b — npm configuration as a build secret in generated images (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m120b-npmrc-build-secret`, stacked on
> `feat/m120-production-build` (maintainer decision, 2026-10-27); its PR targets `develop` and opens
> after M120 merges. All work and fixes stay on this branch.

## 0. Objective & scope

M120 (§8b F2) keeps every `.npmrc` out of generated build contexts, so a registry token never
reaches an image — and documents mounting `.npmrc` as a build secret by hand. This milestone puts
that mount into the generated files, so a project with a private registry or a setting such as
`legacy-peer-deps` builds its image with `docker build --secret id=npmrc,src=.npmrc …` (or
`NPMRC="$(cat .npmrc)" docker compose build`) and no Dockerfile edit, while a project without one
builds exactly as before.

- **In scope:** the one-member Compose fix (§3.6); the secret mount on every package install step of
  the generated Node, Bun and Deno Dockerfiles (workspace and standalone); the generated workspace
  `docker/compose.yaml` passing the secret from an environment variable; docs; tests; the deploy
  gate proving the no-secret build.
- **NOT this milestone:** Kaniko and Podman verification beyond their documentation (no local
  builder; recorded in §8); a `syntax=` directive (not needed — measured, §1); root workspace builds
  (M122).

## 1. Contracts verified from SOURCE (not names)

| Reference                                        | Source (file:line)                                                        | Verified surface / fact                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node/Bun Dockerfile renderer                     | `packages/cli/src/workspace/compose.ts:333-373` (`npmDockerfile`)         | Two install `RUN`s per file: build stage `${guard} && ${install}`, runtime stage `${guard} && ${install} --omit=dev …` (Node) / `--production` (Bun); `install` is `npm ci` or `bun install --frozen-lockfile`.           |
| Deno Dockerfile renderer                         | `compose.ts:111-260` (`renderDockerfile`)                                 | Frontend stage `RUN … deno task build` (via `.setu-build-task`), final stage `RUN … deno cache main.ts && deno install && …`; standalone variant derived by string replacement.                                           |
| Standalone Dockerfile                            | `packages/cli/src/templates/project-files.ts:2054`                        | `renderDockerfile(workspaceProfile(runtime), false)` — the same renderer, so one change covers standalone.                                                                                                                |
| Compose file                                     | `compose.ts:488-503` (`workspaceContainerFiles`), member block `:430-450` | Each member has `build: { context, dockerfile, args: { MEMBER } }`; no top-level `secrets:` today.                                                                                                                        |
| `.dockerignore`                                  | `compose.ts:275-…` (`renderDockerignore`)                                 | Excludes `**/.npmrc` (M120 F2) — the file never reaches a context, so a secret mount is the only route in.                                                                                                                |
| Mounted file read by each client (measured)      | probe 2026-10-27, scratchpad `npmrc-probe/`                               | npm 11.19.1, Bun 1.4.4 and Deno 2.9.5 each read `/root/.npmrc` (HOME=/root in the build stages): requests reached the custom registry with `Authorization: Bearer <token>`; npm applied `legacy-peer-deps=true`.          |
| Optional secret (measured)                       | same probe                                                                | `docker build` (BuildKit, Docker 29.8.2) without `--secret`: build succeeds, mount absent, default registry. The file is absent in the next layer in every case. No `syntax=` line needed.                                |
| Legacy builder (measured)                        | same probe                                                                | `DOCKER_BUILDKIT=0`: "the --mount option requires BuildKit" — build fails. The legacy builder is deprecated in Docker 29.                                                                                                 |
| Compose secret sources (measured, Compose 5.6.0) | same probe                                                                | `secrets.npmrc.file: ./.npmrc` FAILS the build when the file is absent ("failed to stat"); `secrets.npmrc.environment: NPMRC` succeeds with the variable unset (empty mount, default registry) and set (custom registry). |
| npm's own guidance                               | https://docs.npmjs.com/docker-and-private-modules                         | `RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm install`; runtime-only `ENV` cannot install private packages.                                                                                                   |
| Podman / Buildah                                 | `Containerfile(5)`; Red Hat "sensitive data in containers"                | Support `RUN --mount=type=secret` with `--secret id=…,src=…` (documentation, not measured here).                                                                                                                          |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                  | Resolution (picked side)                                      | Doc deliverable (same PR)                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| C1  | `docs/deployment.md` (M120) tells the reader to EDIT the install line to add the mount; after this milestone it is there. | The generated files carry the mount; docs say how to pass it. | `docs/deployment.md` paragraph rewritten; `docs/upgrading.md`. |

## 3. Design decisions

### 3.1 The mount on every install step

- **Decision:** every generated `RUN` that installs packages carries
  `--mount=type=secret,id=npmrc,target=/root/.npmrc`, placed directly after `RUN`:
  - Node and Bun (`npmDockerfile`): the build-stage install and the runtime-stage install.
  - Deno (`renderDockerfile`): the frontend stage's single `RUN` (its build-task detection and
    `deno task build`, whose `install` task fetches npm packages, are one step) and the final
    stage's install `RUN` (`deno cache main.ts && deno install …`).
  - Standalone files inherit it (same renderer, §1).
  - Not on `RUN` lines that install nothing: the final stage's diagnostics-pin parse step and the
    Bun/Node build steps (`bun run build`, `npm run build`).
- **Why:** measured that all three clients read `/root/.npmrc` in these stages, and that an absent
  secret is a no-op (§1); npm's guidance uses exactly this line. One id (`npmrc`) for all runtimes,
  since Bun and Deno read the same file format.
- **Test home:** `test/unit/workspace/compose.test.ts`, `test/unit/dockerfile.test.ts` (each install
  `RUN` carries the mount; non-install `RUN`s do not; standalone and workspace);
  `test/unit/project-files-scripts.test.ts` (standalone per runtime).

### 3.2 Compose passes the secret from an environment variable

- **Decision:** each member's `build:` gains `secrets: [npmrc]`, and the generated
  `docker/compose.yaml` gains a top-level `secrets: { npmrc: { environment: NPMRC } }`. Usage:
  `NPMRC="$(cat .npmrc)" docker compose -f docker/compose.yaml up --build`.
- **Why:** measured (§1): a `file:` source breaks every build when the file is absent; an
  `environment:` source is empty when unset, which is the no-op.
- **Test home:** `test/unit/workspace/compose.test.ts` (both blocks present, `environment: NPMRC`,
  never `file:`).

### 3.3 No other change

- **Decision:** no `# syntax=` line (BuildKit's built-in frontend accepts the mount, measured);
  `required` stays unset (optional is the no-op); `NPM_CONFIG_REGISTRY` build argument unchanged (a
  set environment value still overrides the file's `registry`, which is what the deploy gate relies
  on).
- **Why:** smallest change that delivers the capability; each omitted item is measured or existing.
- **Test home:** the deploy gate (§3.4).

### 3.4 Gates

- **Decision:** `check:deploy --generated` keeps building every generated image WITHOUT a secret —
  that is the no-op proof for Node, Bun and Deno. Template baseline re-captured with the capture
  script (never reversed in the test).
- **Why:** the change must not alter a no-secret build.
- **Test home:** `scripts/check-deploy.ts` run (unchanged code); `style-baseline.test.ts`.

### 3.5 Docs

- **Decision:** `docs/deployment.md` (replace M120's "change the install line" with "pass the
  secret": `docker build --secret id=npmrc,src=.npmrc …`, the Compose form, BuildKit required,
  `bunfig.toml` note kept); `docs/upgrading.md` (existing generated Dockerfiles: add the mount by
  hand or regenerate); CHANGELOG Unreleased entry.
- **Why:** C1.
- **Test home:** `pnpm run check:docs`.

### 3.6 A one-member workspace's Compose file is valid (merged-code defect, folded in)

- **Decision:** a member with no environment variables to render (a one-member workspace on a
  transport that adds none) gets no `environment:` key in `docker/compose.yaml`; members that have
  variables are unchanged.
- **Why:** found while validating §3.2, and reproduced with the M120 CLI (so it predates this
  milestone): a one-member `http` workspace renders `environment:` with nothing under it, which
  Compose reads as `null` and refuses — `docker compose config` fails with
  `services.<member>.environment must be a mapping`, so `docker compose up` cannot run at all. The
  maintainer asked for the fix here (2026-10-27).
- **Test home:** `test/unit/workspace/compose.test.ts` (a one-member `http` workspace renders no
  `environment:` key; a two-member one still renders each sibling's host); by hand,
  `docker compose config` on a generated one-member workspace succeeds.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Generated output changes: the Dockerfiles require BuildKit
(Docker's default builder); a legacy-builder build now fails. Ships in minor 0.11.0 with M120.

| Exported symbol                          | Kind | Consumer / real code path that READS it |
| ---------------------------------------- | ---- | --------------------------------------- |
| None (checked: no `src/index.ts` change) | —    | —                                       |

### 4.1 Options — every option names its consumer

| Option                   | Consumer                     | Behavior (per implementation)                                  |
| ------------------------ | ---------------------------- | -------------------------------------------------------------- |
| Build secret id `npmrc`  | every install `RUN` (§3.1)   | Mounted at `/root/.npmrc` for that `RUN` only; absent → no-op. |
| Compose variable `NPMRC` | `docker/compose.yaml` (§3.2) | Its value becomes the secret; unset → empty secret → no-op.    |

## 5. Implementation files

| File                                                      | Purpose                                                 |
| --------------------------------------------------------- | ------------------------------------------------------- |
| `packages/cli/src/index.ts`                               | Unchanged barrel.                                       |
| `packages/cli/src/workspace/compose.ts`                   | Mount on install `RUN`s (§3.1); Compose secrets (§3.2). |
| `packages/cli/test/fixtures/template-baseline.json`       | Re-captured (§3.4).                                     |
| `docs/deployment.md`, `docs/upgrading.md`, `CHANGELOG.md` | §3.5.                                                   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                         | src covered            | Key assertions                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/workspace/compose.test.ts` (extend)                    | `workspace/compose.ts` | One table over Node/Bun/Deno × workspace/standalone (`renderDockerfile(…, false)` is the standalone path `project-files.ts:2054` calls): exactly the install `RUN`s mount, no other does, no `required=`; the shared install-line guard now includes the mount; Compose `secrets` blocks from `environment: NPMRC`, never `file:`; a one-member workspace renders no member `environment:` key (§3.6). |
| `test/unit/workspace/runtime-profile.test.ts` (adjust)            | `workspace/compose.ts` | "No `.npmrc` is copied" narrowed to no `COPY` of it (the mount target names the file).                                                                                                                                                                                                                                                                                                                 |
| `test/unit/templates/style-baseline.test.ts` (fixture re-capture) | templates              | Only `Dockerfile` hashes change (verified before re-capture).                                                                                                                                                                                                                                                                                                                                          |

## 7. Verification gates

```bash
git branch --show-current   # feat/m120b-npmrc-build-secret
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm test:coverage cli --no-tooling   # per-file ≥90%; gate on no other suite running first
pnpm run check:docs
pnpm run check:deploy --generated     # every generated image builds WITHOUT a secret
pnpm run release:publish --dry-run
pnpm run release:verify 0.10.0
```

Plus, by hand: one Node, one Bun and one Deno generated image built WITH
`--secret id=npmrc,src=<file>` against a local logging registry, showing the install reached it with
the token, and `docker history`/a filesystem search showing no `.npmrc` in any layer; and the
generated Compose file built with `NPMRC` unset and set.

## 8. Risks & mitigations

- **A builder without secret mounts (legacy builder, older Kaniko) fails to build.** → Documented as
  "requires BuildKit"; Docker's default builder is BuildKit; Podman/Buildah support the mount per
  their documentation; the maintained Kaniko fork (`osscontainertools/kaniko` v1.28.0) added it. Not
  measured here (no local builder) — stated as such in the docs.
- **A user passes `--secret` with a file that is not an npmrc.** → It is only read by the package
  client for that `RUN`; nothing persists.

## 8a. Design security review

- **Reviewed flows:** (1) building a generated image with a secret passed (CLI and Compose); (2)
  building without one; (3) running the resulting image.
- **Assets:** the registry token in the user's `.npmrc`; the image's layers, history and cache.
- **Attackers:** anyone who can pull the image or read its history; a CI log reader. Out of scope:
  whoever controls the build host (they have the token anyway).
- **Decisions:**
  - **D-S1 The token never enters a layer, history or cache key.** Only a BuildKit secret mount
    carries it — no `ARG`, `ENV`, `COPY` or echoed command; `.npmrc` stays in `.dockerignore`.
  - **D-S2 Absence is a no-op.** No `required=true`; the Compose source is an environment variable,
    so a missing token never breaks a build that does not need one.
  - **D-S3 Nothing else changes.** Image posture (numeric user, read-only root, no network) and the
    `NPM_CONFIG_REGISTRY` handling are untouched.
- **Audit obligations:**
  1. Build Node, Bun and Deno images (workspace and standalone) with a canary-token secret: the
     install reaches the local registry with the token; the token string appears in no image layer
     (`docker save` + search), no `docker history` entry, and no build-cache export. Positive
     control: the same token placed in an `ARG` IS found in history.
  2. Without a secret: each build succeeds and installs from the default registry, and its
     filesystem listing matches an image built from the M120 Dockerfile of the same project.
  3. Compose: `NPMRC` unset → build succeeds; set → the install reaches the registry with the token,
     and the token appears in no layer or history entry (as in 1).
  4. No generated `RUN` other than the install steps mounts the secret.

## 9. Out of scope

- Measuring Kaniko and Podman/Buildah: no local builder; documentation only (§8).
- Making `required=true` an option: an absent secret must stay a no-op (D-S2).
- Root workspace build/deploy commands that would pass the secret for every member — M122.
