# Milestone 122 — Workspace operations: build, test and deploy from the root (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m122-workspace-operations`. `develop` and `main` are protected
> — all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Closes **V10-60** (M115, Relaymark): a generated workspace root has only `dev` and a Compose file,
so its builders hand-wrote `scripts/deploy.sh` (build, `kind load`, apply, `set image`, rollout),
`scripts/bootstrap-secrets.mjs` (a generic Secret for three variables) and a root test task. This
milestone gives a workspace one command per operation: `setu workspace build` builds every member's
image, `setu workspace deploy` builds, ships the images to the cluster (kind load or registry push),
applies a Secret per member from an operator file, applies the generated manifests and waits for
every rollout, and a new root's `test` script runs every member's tests through the package
manager's own recursion. It also closes a deployment gap found while planning: a full-stack member
requires `SESSION_SECRET` (`config.getOrThrow`), and neither the generated Deployment nor the
Compose service ever sets it, so that member crashes on start in both.

- **In scope:** `setu workspace build` and `setu workspace deploy` (CLI commands reading
  `setu.workspace.json` at run time); root `test`/`build`/`deploy` scripts in a NEW workspace root;
  `envFrom` a per-member Secret in the generated Deployments; an optional `env_file` per Compose
  service; `image: <member>:dev` on each Compose service so Compose and Kubernetes name the same
  image; `parseEnv` moved from `config-plugin` to `@setu-ts/common` so the CLI and the app read a
  dotenv file the same way; a `check:deploy --workspace` mode running the root operations against a
  real kind cluster; docs.
- **NOT this milestone:** member filtering or affected-only runs (`--member`, caching) — the
  Turborepo/Nx question parked until after `v0.11.0` ([[turborepo-nx-after-0-11-0]]); the
  transport's backing service in the cluster (the generated `k8s/README.md` excludes it
  deliberately, M39); an Ingress (same README); external secret managers (sealed-secrets, External
  Secrets) — documented as the production path, not generated; watch mode in `dev`, which M120
  already delivered (each member's `start:dev`, `packages/cli/src/workspace/dev-runner.ts:243`).

## 1. Contracts verified from SOURCE (not names)

| Reference                    | Source (file:line)                                      | Verified surface / fact                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root manifest written once   | `packages/cli/src/workspace/root-files.ts:27-35,93-110` | Member and library GLOBS; "the root manifest is written once and never rewritten"; npm root `scripts: { dev }`, Deno root `tasks: { dev }`                                      |
| `profile.runAll`             | `packages/cli/src/workspace/runtime-profile.ts:87,219`  | The root `dev` command per profile (`node scripts/dev.mjs`, `bun scripts/dev.mjs`)                                                                                              |
| Dev runner watches already   | `packages/cli/src/workspace/dev-runner.ts:243`          | Spawns each member's `run start:dev` — the ROADMAP's watch question is settled by M120                                                                                          |
| `WorkspaceManifest` / reader | `packages/cli/src/workspace/manifest.ts:122,178,326`    | Members `{ name, port, dependsOn?, healthProbes?, metricsEndpoint?, devtoolPort? }`; `readWorkspaceManifest(fs, dir)` returns `{ ok, manifest }` or a problem                   |
| `reconcileMembers`           | `packages/cli/src/workspace/reconcile.ts:15`            | Verifies each member directory exists; `describeReconcileFailure` is the shared refusal                                                                                         |
| k8s container block          | `packages/cli/src/workspace/k8s.ts:123,193`             | `env:` from `memberEnvironment`; `image: <name>:dev`, `imagePullPolicy: IfNotPresent`; `${NAMESPACE}` / `${WORKSPACE}` placeholders (`k8s.ts:160,163`); no `envFrom`, no Secret |
| Compose service block        | `packages/cli/src/workspace/compose.ts:436,449`         | `build:` with `MEMBER` arg and `npmrc` secret; `environment:` only when non-empty (M120b); no `image:`, no `env_file`                                                           |
| `workspace` command          | `packages/cli/src/commands/workspace.ts:118-131`        | Only `ports --reallocate`; usage printed on anything else                                                                                                                       |
| CLI dispatch + injected deps | `packages/cli/src/cli.ts:51,68,80,301-307`              | `CliDependencies` carries `fs`, `cwd`, `now`, `portAvailable` (node-backed, injected from `main.ts:103`) — the precedent for an injected command runner                         |
| CLI invocation per runtime   | `packages/cli/src/templates/project-files.ts:1320-1324` | `cliCheckCommand`: Deno `deno run -A <pinned cli specifier> check`, otherwise `setu check` (the bin each member's devDependency installs)                                       |
| `.env.example` per member    | `packages/cli/src/templates/project-files.ts:304,2265`  | `envExampleContents` writes every declared `EnvVariable` name as `NAME=` (values never committed)                                                                               |
| `EnvVariable`                | `packages/cli/src/templates/registry.ts:163-170`        | `{ name, description, develop }` — template-level, NOT recorded in `setu.workspace.json`                                                                                        |
| Full-stack requires a secret | `packages/cli/src/templates/full-stack.ts:283`; probe   | Declares `SESSION_SECRET`, `TRUSTED_PROXIES`; generated config reads `config.getOrThrow('SESSION_SECRET')`; generated k8s and Compose set neither (measured on a scaffold)      |
| `.dockerignore`              | `packages/cli/src/workspace/compose.ts:288`             | Excludes `**/.env`, `**/.env.*` and `k8s` — so neither the operator secret file nor the member's `.env` can reach an image                                                      |
| `parseEnv`                   | `packages/config-plugin/src/parsers/env-parser.ts:19`   | Strict dotenv parser (`export` prefix, quotes, comments, last-wins, throws on malformed); NOT exported from `config-plugin`'s index; one caller `services/env-loader.ts:171`    |
| kind gate in CI              | `.github/workflows/ci.yml:637-708`                      | `deploy` job: kind cluster `setu-deploy-gate` (kind v0.31, kubectl v1.31.4), runs `check:deploy` then `check:deploy --cluster`                                                  |
| `check:deploy` helpers       | `scripts/check-deploy.ts:221,351,929,1179`              | `parseModes`, `run`, `checkGenerated` (scaffold + `startRegistryOverlay`), `checkCluster` (creates or reuses the kind cluster)                                                  |

**External tools, probed 2026-10-29 (Docker 5.6.0 Compose, Bun 1.4.2, Deno 2.9.6, npm 11):**

| Behaviour                                                                  | Measured                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose `env_file: [{ path, required: false }]`, file absent               | Config resolves; nothing added                                                                                                                                                                                       |
| Same, file present                                                         | Its keys are added; a key also under `environment:` keeps the `environment:` value                                                                                                                                   |
| `npm run test --workspaces --if-present`                                   | Runs every member (a failing first member does not stop the second), skips one without the script, exits with the failure code                                                                                       |
| `bun run --filter '*' test`                                                | Same three properties; excludes the root even when the root's own `test` is this command                                                                                                                             |
| `deno task --recursive test`                                               | Same three properties when the root has no `test` task. As the root's own `test` (or with `--filter '*'`) it INCLUDES the root and calls itself without end — corrected in verification; the first probe was misread |
| `docker build --secret id=npmrc,env=NPMRC` with `NPMRC` unset              | Builds; the secret mounts as a 0-byte file (npm ignores it)                                                                                                                                                          |
| `kubectl create secret generic --from-env-file`                            | Takes values literally (quotes kept) — differs from `parseEnv`, so it is NOT used (§3.4)                                                                                                                             |
| Client-side `kubectl apply` of a Secret with `stringData` (kind, k8s 1.31) | The value is stored in PLAINTEXT in `kubectl.kubernetes.io/last-applied-configuration` (`describe` hides it, `get -o yaml` shows it)                                                                                 |
| `kubectl apply --server-side` with `stringData`                            | No annotation, but a key removed from the file STAYS in the Secret                                                                                                                                                   |
| `kubectl apply --server-side --field-manager=setu` with `data:` (base64)   | No annotation; a removed key is removed; taking over a Secret first created client-side drops its old key and its leaked annotation                                                                                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                        | Resolution (picked side)                                                                                        | Doc deliverable (same PR)                                               |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| C1  | ROADMAP §M122 suggests "a managed script reading `setu.workspace.json`, the dev runner's pattern"               | CLI commands (maintainer, 2026-10-29): existing workspaces get them without file edits, fixes ship with the CLI | ROADMAP §M122 deliverables reworded to the commands                     |
| C2  | ROADMAP §M122 asks "whether `dev` watches (once M120 adds a `dev` script)"                                      | Already true since M120 (`dev-runner.ts:243`)                                                                   | ROADMAP §M122 notes it as delivered by M120                             |
| C3  | Workspace root README says "The root does not build all members" (`root-files.ts:189`)                          | It now does                                                                                                     | Rewritten README section in `root-files.ts`                             |
| C4  | Generated `k8s/README.md` and each Deployment comment say "push it to a registry … and put that reference here" | `setu workspace deploy` fills the reference; hand-editing remains possible                                      | Updated comment in `k8s.ts`, `k8s/README.md` text, `docs/deployment.md` |

## 3. Design decisions

### 3.1 Two CLI commands under `setu workspace`

- **Decision:** `setu workspace build` and `setu workspace deploy`, dispatched from the existing
  `runWorkspaceCommand` (`commands/workspace.ts`) to a new `commands/workspace-ops.ts`. Both find
  the root from `--dir` (default cwd), read `setu.workspace.json`, and run `reconcileMembers` first,
  refusing exactly as `workspace ports` does. The member set is the manifest's, in manifest order.
- **Why:** maintainer decision (C1); the manifest is already the single source the dev runner,
  Compose and k8s render from.
- **Test home:** `test/unit/commands/workspace-ops.test.ts`.

### 3.2 A command runner injected like the port probe

- **Decision:** `CliDependencies` gains an optional
  `runCommand(command, args, { cwd, input?, stream? }) => Promise<{ code, stdout, stderr }>`. The
  real implementation lives in `src/utils/run-command.ts` over `node:child_process` `spawn` (no
  shell): with `stream: true` (builds, rollouts) the child's output goes to the terminal and
  `stdout`/`stderr` come back empty; otherwise both are captured. `input` is written to stdin and
  the stream closed. `main.ts` only wires it in, as it wires `portAvailable`. A command not found
  (`ENOENT`) resolves to code 127 with a message naming the tool, so a missing `docker`, `kind`,
  `kubectl` or `git` is reported, not thrown. Tests pass a recorder.
- **Why:** the CLI's only node-backed seams are injected from `main.ts` (`portAvailable`,
  `cli.ts:80`); a recorder lets every argument the commands build be asserted without Docker.
- **Test home:** `workspace-ops.test.ts` (recorder); `test/unit/utils/run-command.test.ts` drives
  the real implementation against `node -e` children (exit code, stdin, captured and streamed
  output, a missing executable → 127). `main.ts` is coverage-measured, so the logic is not left in
  it.

### 3.3 `setu workspace build`

- **Decision:** first, the root must hold the profile's lockfile (`profile.lockfile`,
  `runtime-profile.ts:102`) — every generated Dockerfile installs from it — or the command refuses
  naming the install command (`profile.install`). Then, for each member, one
  `docker build -f docker/Dockerfile --build-arg MEMBER=<m> --secret id=npmrc,env=NPMRC -t <image> .`
  from the root, streamed, stopping at the first failure with that member named. `<image>` is
  `<registry>/<m>:<tag>` with `--registry` (one trailing `/` dropped) or `<m>:<tag>` without.
  `--tag` defaults to §3.6's tag. `build` never pushes; `--registry` only names the images. Prints
  each image built, and the list at the end.
- **Why:** the generated Dockerfile is one file parameterised by `MEMBER` (`compose.ts:449`);
  `--secret` is always passed because an unset `NPMRC` mounts an empty file (measured), matching
  Compose.
- **Test home:** `workspace-ops.test.ts` (exact argv per member, registry prefix with and without a
  trailing `/`, first-failure stop, missing-lockfile refusal per profile).

### 3.4 Secrets: names from `.env.example`, values from `k8s/secrets/<member>/.env`

- **Decision:** a member's declared names are the keys of its committed `apps/<m>/.env.example`,
  minus every name the generated manifest already sets for it (`memberEnvironment`, `compose.ts:393`
  — sibling hosts and the transport URL): a standalone project adopted into a workspace declares its
  broker URL (`brokerEnvVariables`, `templates/broker.ts:199`), and the generated `env:` already
  supplies it. Values come from `k8s/secrets/<m>/.env`, parsed with `parseEnv` from
  `@setu-ts/common` (§3.10). Before anything is built, deploy checks every member and refuses (exit
  1, nothing built or applied) naming each member and each declared name absent from its values file
  — an empty value (`TRUSTED_PROXIES=`) counts as present. It also refuses when a values file is
  tracked by git (`git ls-files --error-unmatch`; skipped outside a git repository). A member whose
  `.env.example` declares nothing and has no values file gets no Secret. A values file's keys are
  all applied, declared or not. The Secret is `<m>-env` (`Opaque`), its values base64-encoded under
  `data:`, rendered by the CLI and sent on **stdin** — never on argv, never logged — to
  `kubectl apply --server-side --field-manager=setu -f -`. Server-side and `data:` both matter
  (measured, §1): a client-side apply writes every value in plaintext into the
  `last-applied-configuration` annotation, and `stringData` under a server-side apply keeps keys the
  file no longer has. The path is ignored by the `.env` rule every existing workspace root already
  has (`root-files.ts:213`).
- **Why:** maintainer decision (operator env file, no generated values).
  `kubectl create secret --from-env-file` keeps quotes literally (measured), which would make a
  quoted value mean something different in the cluster than in `.env`; one parser avoids that.
- **Test home:** `workspace-ops.test.ts` (missing-name refusal lists every name, empty value
  accepted, a generated-env name not demanded, tracked-file refusal, the Secret goes to stdin of an
  `apply --server-side --field-manager=setu` call, no value in any argv or log line);
  `test/unit/workspace/secrets.test.ts` (base64 `data:` for values with `:`, `#`, quotes, newlines
  and non-ASCII; no `stringData`); `check:deploy --workspace` (the applied Secret carries no
  `last-applied-configuration` annotation).

### 3.5 Deployments read the Secret through `envFrom`

- **Decision:** every generated Deployment container gets
  `envFrom: [{ secretRef: { name: <m>-env, optional: true } }]`, unconditionally. Explicit `env:`
  entries keep precedence (Kubernetes rule), so generated sibling hosts and the transport URL cannot
  be overridden by the Secret.
- **Why:** the k8s renderer is pure over the manifest and does not see `.env.example`; `optional`
  lets a member without secrets start, and a member whose required variable is missing still fails
  loudly at `getOrThrow`, which deploy prevents up front.
- **Test home:** `test/unit/workspace/k8s.test.ts` (block present for every member, name, optional).

### 3.6 Image tag

- **Decision:** `--tag` wins. Otherwise the short git commit (`git rev-parse --short HEAD`), with
  `-dirty-<YYYYMMDDHHmmss>` (UTC) appended when `git status --porcelain` is non-empty or cannot be
  read — amended in review: a bare `-dirty` gave two deploys of different uncommitted edits one tag,
  so the second rolled nothing out; outside a git repository, `build-<YYYYMMDDHHmmss>` from
  `deps.now()` (UTC). Tags are validated against Docker's tag grammar
  (`[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`); an invalid `--tag` is a usage error.
- **Why:** Skaffold's default `gitCommit` tagger; a fixed tag (`dev`) under `IfNotPresent` makes
  Kubernetes keep running the old image after a redeploy.
- **Test home:** `workspace-ops.test.ts` (clean, dirty, no repository, invalid tag).

### 3.7 Where the images go: kind or registry

- **Decision:** the kube context is `--context` or `kubectl config current-context`. A context named
  `kind-<cluster>` loads each image with `kind load docker-image <image> --name <cluster>`, and
  `--registry` is then optional and only names the images (nothing is pushed). Any other context
  requires `--registry <prefix>` (usage error without it) and pushes each image with `docker push`.
  Every `kubectl` call passes `--context`.
- **Why:** maintainer decision (Skaffold's rule).
- **Test home:** `workspace-ops.test.ts` (kind context loads, non-kind without registry refuses,
  non-kind with registry pushes, explicit `--context` used everywhere).

### 3.8 Applying the manifests

- **Decision:** the namespace is `--namespace` or the workspace root directory's name, validated as
  a DNS-1123 label (refusal names `--namespace`). Deploy reads `k8s/members.yaml` from disk,
  replaces `${NAMESPACE}` and `${WORKSPACE}` (workspace label = root directory name), and replaces
  each member's `image: <m>:dev` line with the built image. It refuses before building when a
  member's image line is missing (the developer has taken it over), when any other `${…}`
  placeholder remains, or when a member that gets a Secret has no `envFrom` naming `<m>-env` in its
  Deployment — an existing workspace's `members.yaml` predates §3.5 and is regenerated only by
  `generate app`, `adopt` or `workspace ports --reallocate`, so the refusal prints the exact
  `envFrom` lines to add rather than applying a Secret nothing reads. Order: apply a `Namespace`
  object, then each Secret, then the rendered manifest, all via `kubectl apply -f -`; then
  `kubectl rollout status deployment/<m> -n <ns> --timeout=<duration>` per member. `--timeout` takes
  kubectl's and Helm's duration form (`300s`, `5m`, `1h`; `^[1-9][0-9]*(s|m|h)$`), default `120s`;
  anything else is a usage error. A failed rollout names the member and prints the
  `kubectl describe` and `kubectl logs` commands to run; exit 1.
- **Why:** the file on disk is applied because `k8s/README.md` tells developers to edit probe paths
  there; rendering the image into the manifest avoids `set image`'s second rollout.
- **Test home:** `workspace-ops.test.ts` (substitution, image-line refusal, leftover-placeholder
  refusal, missing-`envFrom` refusal with the lines to add, order of applies, rollout failure
  message, namespace validation, `--timeout` grammar).

### 3.9 `--dry-run`

- **Decision:** both commands accept `--dry-run`: every check in §3.4–§3.8 runs, the git and
  `kubectl config current-context` reads run, and each command that would change something is
  printed instead of run. Secret contents are printed as their key names only.
- **Why:** the CLI's other writing commands have `--dry-run`; it lets a user see the plan.
- **Test home:** `workspace-ops.test.ts` (no build/load/push/apply call recorded; no value printed).

### 3.10 One dotenv parser, in `@setu-ts/common`

- **Decision:** `parseEnv` moves unchanged from `packages/config-plugin/src/parsers/env-parser.ts`
  to `packages/common/src/env-file.ts`, exported from `@setu-ts/common` with `@since 0.11.0`.
  `config-plugin`'s env loader imports it from common; its old file and the test move with it.
  `config-plugin` never exported it, so its public surface is unchanged.
- **Why:** "one capability, one implementation" — the Secret must carry exactly what the app would
  read from the same file. Common is the shared, runtime-free home.
- **Test home:** `packages/common/test/unit/env-file.test.ts` (the moved parser tests);
  `config-plugin`'s `env-loader.test.ts` unchanged and green.

### 3.11 Compose reads the member's own `.env` and names the image

- **Decision:** each generated Compose service gains `image: <m>:dev` and
  `env_file: [{ path: ../apps/<m>/.env, required: false }]` (paths resolve from `docker/`). The
  generated `environment:` keeps precedence (measured).
- **Why:** maintainer decision; the full-stack member otherwise crashes under `docker compose up`.
  `image:` makes `docker compose build` produce the same `<m>:dev` the manifest's comment names.
- **Test home:** `test/unit/workspace/compose.test.ts`; `check:deploy`'s Compose mode resolves it.

### 3.12 Root scripts in a new workspace

- **Decision:** a new root gains `test`, `build` and `deploy` next to `dev`. `test` is the profile's
  native recursion — npm `npm run test --workspaces --if-present`, Bun `bun run --filter '*' test`.
  **Amended in verification:** a Deno root gets NO `test` task. Deno's recursion (and
  `--filter '*'`) includes the root, so a root `test` running `deno task --recursive test` calls
  itself without end — the gate's first Deno run nested dozens deep, and a probe ran thousands of
  times in 30 s. The §1 row recording "the root line repeats once" read a truncated run wrong. Deno
  users run `deno task --recursive test` from the root (`profile.testFromRoot`), which runs each
  member once. `build` and `deploy` call the CLI as each member's `check` does (`cliCheckCommand`'s
  rule, generalised to `cliCommand(runtime, args)`): `setu workspace build` /
  `setu workspace deploy` on Node and Bun, `deno run -A <pinned cli> workspace …` on Deno. Existing
  roots are not edited (the root is written once); the README and `docs/deployment.md` give the
  commands for them. The root `.gitignore` of a new workspace also lists `k8s/secrets/`.
- **Why:** the measured recursion stays in step with members through the globs; the CLI's bin is
  already installed by every member.
- **Test home:** `test/unit/workspace/root-files.test.ts` (scripts per profile);
  `check:deploy --workspace` (Node, real); a Deno root probe in the same e2e as §3.13 runs
  `deno task test`.

### 3.13 A real-cluster workspace e2e

- **Decision:** `scripts/check-deploy.ts` gains `--workspace`: scaffold a Node workspace on the
  `http` transport (no broker in the cluster) with a `rest` member and a `full-stack` member from
  the registry overlay, install it, run the root `test` script, write `k8s/secrets/portal/.env`, run
  `setu workspace deploy --tag m122 --timeout 300` into the kind cluster (`kind-setu-deploy-gate`,
  created or reused like `--cluster`), then assert both rollouts completed, that `GET /health`
  through each Service answers 200 (port-forward), and that the portal pod's environment carries
  `SESSION_SECRET` from the Secret. A second pass without the values file must refuse and leave the
  cluster unchanged. Without a cluster, the same mode also scaffolds a Deno workspace with one
  `rest` member, installs it, and runs `deno task test` from the root, asserting the member's tests
  ran exactly once and the exit code is 0. CI's cluster step runs
  `check:deploy --cluster --workspace`.
- **Why:** ROADMAP deliverable; only a real cluster shows a probe path, image reference or Secret
  defect.
- **Test home:** `scripts/check-deploy.ts` itself; `test/deploy-gate.test.ts` covers `parseModes`
  for the new flag.

### 3.14 The workspace root agent brief names the new commands

- **Decision:** `renderWorkspaceRoot` (`packages/cli/src/agents/render.ts:80`) lists the root
  `test`, `build` and `deploy` scripts under **Commands** next to `dev`, using the profile's
  `runScript`.
- **Why:** the brief is what an agent reads first; a command it does not list is one it hand-writes
  again (Relaymark).
- **Test home:** the existing workspace brief test (`test/unit/agents/workspace-brief.test.ts`).

### 3.15 Documentation deliverables

- **Decision:** `PUBLIC_API.md` (`parseEnv` in `@setu-ts/common`, with its JSDoc), `CHANGELOG.md`
  (Unreleased, with the PR number after `gh pr create`), `packages/cli/README.md` (both commands,
  their flags and exit codes, and the commands for an existing root), `docs/deployment.md` (deploy
  flow, the secrets file, kind vs registry, sealed-secrets/External Secrets as the production path),
  the generated `k8s/README.md` text (C4), ROADMAP §M122 and its Progress Tracking row, and the
  CLAUDE.md status line.
- **Why:** ROADMAP deliverables and C1–C4.
- **Test home:** `pnpm run check:docs`.

### 3.16 Build arguments and the build network (amendment, implementation)

- **Decision:** both commands accept a repeatable `--build-arg KEY=VALUE` and a `--network <name>`,
  forwarded to every `docker build` before the generated `MEMBER` argument. `parseArgs` keeps every
  `--build-arg` occurrence, as it already does for `--depends-on`. A value without `KEY=` is a usage
  error. Credentials never belong there (they reach the argument list); the npm token stays the
  `NPMRC` build secret.
- **Why:** found while writing §3.13. A workspace installed from a registry other than npm — a
  private registry, a proxy, the gate's local registry overlay — pins those tarball URLs in its
  lockfile, and the generated Dockerfile already declares `ARG NPM_CONFIG_REGISTRY` for exactly that
  case (M120b). Without forwarding, `setu workspace build` could not build such a workspace, and the
  §3.13 gate (which builds with `--network host` against `127.0.0.1`) could not run at all.
- **Test home:** `workspace-ops.test.ts` (forwarding order, refusals); `args.test.ts` (repeatable).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none.

| Exported symbol | Kind     | Consumer / real code path that READS it                                                    |
| --------------- | -------- | ------------------------------------------------------------------------------------------ |
| `parseEnv`      | function | `config-plugin` `services/env-loader.ts` (existing caller); CLI `workspace deploy` secrets |

The CLI adds no library export: the commands are reached through `bin`.

### 4.1 Options — every option names its consumer

| Option                         | Consumer           | Behavior (per implementation)                                       |
| ------------------------------ | ------------------ | ------------------------------------------------------------------- |
| `--dir`                        | both commands      | Workspace root; default cwd                                         |
| `--tag`                        | both commands      | §3.6                                                                |
| `--registry`                   | both commands      | Image prefix (§3.3); required for deploy on a non-kind context      |
| `--context`                    | `deploy`           | §3.7; every `kubectl` call                                          |
| `--namespace`                  | `deploy`           | §3.8                                                                |
| `--timeout`                    | `deploy`           | Rollout wait, kubectl duration (`300s`, `5m`, `1h`); default `120s` |
| `--dry-run`                    | both commands      | §3.9                                                                |
| `--build-arg`                  | both commands      | §3.16; repeatable, forwarded to every build                         |
| `--network`                    | both commands      | §3.16; forwarded to every build                                     |
| `runCommand` (CliDependencies) | `workspace-ops.ts` | §3.2                                                                |

## 5. Implementation files

| File                                                | Purpose                                                        |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `packages/common/src/env-file.ts`                   | `parseEnv`, moved (§3.10)                                      |
| `packages/common/src/index.ts`                      | Export `parseEnv`                                              |
| `packages/config-plugin/src/services/env-loader.ts` | Import `parseEnv` from common; `parsers/env-parser.ts` deleted |
| `packages/cli/src/commands/workspace-ops.ts`        | `build` and `deploy` (§3.3–§3.9)                               |
| `packages/cli/src/workspace/secrets.ts`             | Declared names, values reading, Secret YAML rendering (§3.4)   |
| `packages/cli/src/workspace/deploy-manifest.ts`     | Placeholder and image substitution with refusals (§3.8)        |
| `packages/cli/src/workspace/image-tag.ts`           | Tag derivation and validation (§3.6)                           |
| `packages/cli/src/commands/workspace.ts`            | Dispatch `build`/`deploy`; usage text                          |
| `packages/cli/src/cli.ts`                           | `runCommand` on `CliDependencies`; help lines                  |
| `packages/cli/src/utils/run-command.ts`             | Real `runCommand` over `node:child_process` (§3.2)             |
| `packages/cli/src/main.ts`                          | Wires `runCommand` in                                          |
| `packages/cli/src/agents/render.ts`                 | Root brief lists `test`/`build`/`deploy` (§3.14)               |
| `packages/cli/src/workspace/k8s.ts`                 | `envFrom` block; updated image comment (§3.5, C4)              |
| `packages/cli/src/workspace/compose.ts`             | `image:` and `env_file` (§3.11)                                |
| `packages/cli/src/workspace/root-files.ts`          | Root scripts, README, `.gitignore` (§3.12, C3)                 |
| `packages/cli/src/templates/project-files.ts`       | `cliCommand(runtime, args)` generalising `cliCheckCommand`     |
| `scripts/check-deploy.ts`                           | `--workspace` mode (§3.13)                                     |
| `.github/workflows/ci.yml`                          | Cluster step adds `--workspace`                                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                  | src covered                         | Key assertions                                                                                  |
| ---------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/env-file.test.ts`               | `common/src/env-file.ts`            | The moved `env-parser` cases, unchanged                                                         |
| `packages/config-plugin/test/unit/env-loader.test.ts`      | `env-loader.ts`                     | Unchanged and green (import path only)                                                          |
| `packages/cli/test/unit/commands/workspace-ops.test.ts`    | `workspace-ops.ts`, `workspace.ts`  | §3.1, §3.3, §3.4, §3.6–§3.9 against a recording `runCommand`; usage errors exit 2               |
| `packages/cli/test/unit/workspace/secrets.test.ts`         | `secrets.ts`                        | Names from `.env.example` minus generated env; missing/empty; base64 `data:` for awkward values |
| `packages/cli/test/unit/workspace/deploy-manifest.test.ts` | `deploy-manifest.ts`                | Substitution; missing image line; leftover placeholder                                          |
| `packages/cli/test/unit/workspace/image-tag.test.ts`       | `image-tag.ts`                      | Clean, dirty, no repo, timestamp format, grammar                                                |
| `packages/cli/test/unit/utils/run-command.test.ts`         | `utils/run-command.ts`              | Real child: exit code, stdin input, captured vs streamed output, missing executable → 127       |
| `packages/cli/test/unit/agents/workspace-brief.test.ts`    | `agents/render.ts`                  | Root brief lists the three scripts per profile                                                  |
| `packages/cli/test/unit/workspace/k8s.test.ts`             | `k8s.ts`                            | `envFrom` for every member                                                                      |
| `packages/cli/test/unit/workspace/compose.test.ts`         | `compose.ts`                        | `image:` and optional `env_file` per service                                                    |
| `packages/cli/test/unit/workspace/root-files.test.ts`      | `root-files.ts`, `project-files.ts` | `test`/`build`/`deploy` per profile; `.gitignore` lists `k8s/secrets/`                          |
| `test/deploy-gate.test.ts`                                 | `scripts/check-deploy.ts`           | `--workspace` parsed                                                                            |
| `scripts/check-deploy.ts --workspace` (real kind)          | the whole path                      | §3.13                                                                                           |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m122-workspace-operations
pnpm run check:plan
pnpm run ci:local           # final commit; single shards in fix rounds
pnpm run test:deno-lane
pnpm run check:deploy --cluster --workspace
pnpm run release:publish --dry-run
pnpm run release:verify 0.11.0
```

A milestone that changes what `packages/cli` generates also boots a scaffold: the
`scaffold-runs-e2e` gate and `check:deploy --generated` run in `ci:local` and the deploy job.

## 8. Risks & mitigations

- A secret value reaching a log, argv or an annotation → values only on stdin, under `data:`, with a
  server-side apply (measured); a test asserts no recorded argv or log line contains a value; the
  e2e asserts no `last-applied-configuration` annotation; `--dry-run` prints names only. The diff
  crosses a trust boundary (cluster credentials, secret values), so the PR gets the fresh-context
  security audit (CLAUDE.md).
- A values file committed by mistake → deploy refuses a git-tracked values file; the path is covered
  by the `.env` ignore rule of every existing root.
- kind node image or kubectl drift in CI → reuse the pinned `setu-deploy-gate` cluster.
- The full-stack image build is slow in the e2e → one full-stack member only; `--timeout 300`.
- Deno's root `test` line repeating looks like a loop → measured to run each member once; the e2e's
  Deno probe asserts it.

## 8a. Design security review

Added after the first committed-tree audit (fresh Claude agent, revision `f23b71f4`, verdict
**failed**) found it missing; the diff crosses a trust boundary (cluster credentials, secret values,
repository files the CLI acts on). The re-audit checks each obligation below with a positive control
and a negative one.

**Reviewed flow.** `setu workspace deploy`: read `setu.workspace.json`, each member's
`.env.example`, `k8s/secrets/<member>/.env` and `k8s/members.yaml` → validate every input → read the
git state and the kube context → build → load or push → apply Namespace → per member: read the
Secret's version, apply the Secret server-side → list Deployments → apply the manifest → restart
each running member whose Secret changed → wait for every rollout. `build` is the read, validate and
build prefix of that flow.

**Assets.** The secret values; the kube context and namespace that change; each image's contents;
the operator's other files on the same host.

**Attackers.** A1, a contributor whose branch the operator checks out and deploys (controls the
manifest, `members.yaml`, `.env.example`, committed links, member code). A2, another local user
(reads `/proc/*/cmdline`). A3, a careless operator (commits a values file, rotates a secret, runs a
dry run in a shared terminal). A4, kubectl or an admission webhook (chooses stderr text).

| #                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Threat                                                         | Obligation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Proof                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A secret value on argv, in output or in an annotation (A2, A3) | Values only on stdin, base64 under `data:`, `kubectl apply --server-side --force-conflicts` (deploy owns the Secret; a key another manager set is otherwise a conflict); dry run prints key names; kubectl's stderr for a Secret is never printed (audit F3: redaction missed overlapping and escaped forms).                                                                                                                                                                                                                                                                                                                                                                                         | `workspace-ops.test.ts` canary across argv, output and stdin; `check:deploy --workspace` asserts no `last-applied-configuration`, including over a Secret first created client-side.                                                   |
| O2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | YAML or argument injection (A1, operator typo)                 | Member names, `--namespace` are DNS labels; `--registry`, `--tag`, `--timeout` match their grammars; every tool runs without a shell, one argument per value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `workspace-ops.test.ts` refusal tables; audit NC2–NC5.                                                                                                                                                                                 |
| O3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Reading outside the workspace (A1)                             | `.env.example`, values files and `members.yaml` are read through `assertInsideProject` + `readExistingText`: no link, regular file only, at most 1 MiB; a read failure is reported, not thrown (audit F2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `test/integration/workspace-deploy-links.test.ts` on a real filesystem (linked directory, linked file, FIFO, unreadable file, linked manifest).                                                                                        |
| O4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A committed values file deployed (A3)                          | `git ls-files --error-unmatch` in the C locale, only after `git rev-parse --is-inside-work-tree` prints `true`; only git's own "not a git repository" or "not tracked" continue. A missing `git`, a repository git declines to read (dubious ownership, `safe.bareRepository`), `false`, or any other exit refuses, and git runs with every inherited `GIT_*` variable removed so `GIT_DIR`, `GIT_INDEX_FILE` or `GIT_CEILING_DIRECTORIES` cannot point it elsewhere (audit F2, re-audit N1, audit 3 L1).                                                                                                                                                                                             | `workspace-ops.test.ts` (tracked, not a repo, no git, dubious ownership, exit 129, `false`, unexpected `ls-files` exit; the C-locale env asserted).                                                                                    |
| O5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A rotated secret never reaching pods (A3)                      | Each Secret's post-apply `resourceVersion` is written into its member's pod-template annotation `setu-ts.dev/secret-version`, so a changed Secret changes the template and Kubernetes rolls out; idempotent when a deploy is re-run after failing part-way (audit F1, re-audit N2). The stamp needs exactly one owning Deployment document (a `--- # comment` separator splits correctly) and exactly one slot at the pod-template indent, else the member falls back; a `resourceVersion` outside `[0-9A-Za-z._-]{1,64}` fails the deploy (audit 3, L2, L3). A `members.yaml` without the slot falls back to comparing versions and `kubectl rollout restart` for a Deployment that already existed. | `deploy-manifest.test.ts` (own member only, re-stamp, no slot); `workspace-ops.test.ts` (stamp, re-run, fallback); `check:deploy --workspace` rotates on a clean tree and asserts only portal rolls and its pod carries the new value. |
| O6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Deploying to the wrong cluster                                 | The context is read once and passed as `--context` to every kubectl call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `workspace-ops.test.ts` explicit-context case; audit P7.                                                                                                                                                                               |
| O7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Secrets in images or Compose overriding topology               | `.dockerignore` keeps `k8s` and `**/.env` out; Compose's `environment:` wins over `env_file`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Audit P9, P10.                                                                                                                                                                                                                         |
| O8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Cost before refusal                                            | Every input, secret, git and context check runs before the first build.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `workspace-ops.test.ts` refusal cases record no `docker` call.                                                                                                                                                                         |
| O9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A host file loaded into a Compose container (A1, re-audit N4)  | Compose follows a link at `apps/<member>/.env` and the CLI cannot stop it, so `setu check` (and `sync`) refuse a linked or non-regular member `.env`. That covers the generated `env_file` only: a branch can also edit `docker/compose.yaml` itself to name any host file, so the docs say to review a branch's `docker/` changes before `docker compose up` (audit 3, L4). The dev runner is not guarded: it runs member code on the host, which already has the access.                                                                                                                                                                                                                            | `test/integration/workspace-deploy-links.test.ts` (linked, directory, regular).                                                                                                                                                        |
| O10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | A hostile `members.yaml` stalling deploy (A1, re-audit N3)     | Patterns over it use `[ \t]*`, never `\s*` across a newline: linear time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `deploy-manifest.test.ts` (200k blank lines under 1 s; the old patterns took 0.8 s at 40k).                                                                                                                                            |
| **Accepted, documented:** `--force-conflicts` takes over keys another writer set in `<member>-env`, but keys only that writer owns stay (re-audit I1; the CLI README says to remove them or delete the Secret once); the parent directories of a read are checked and then opened without no-follow, a race that needs a concurrent writer in the workspace (re-audit I3); objects in `members.yaml` that name their own namespace, or are cluster-scoped, apply as written — the file is the workspace's own (re-audit I4); `--build-arg` values are on the argument list and printed by `--dry-run` |
| (credentials belong in `NPMRC`); `parseEnv` drops a `__proto__` key (pre-existing behaviour); a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| partial failure leaves earlier objects applied; removing a values file leaves its Secret in the                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| cluster. **Not probed:** Windows executable search in the working directory (no Windows host).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Audit dispositions.** First audit (`f23b71f4`, failed): F0 design review → this section; F1 → O5;
F2 → O3/O4; F3 → O1. Re-audit (`aa80e4cd`, failed): N1 → O4; N2 → O5; N3 → O10; N4 → O9; I1, I3, I4
accepted above; I2 → the gate also searches the base64 forms of its canaries. Third audit
(`880170b9`, failed with five Low): L1 → O4; L2, L3 → O5; L4 → O9 and the docs; L5 → this table
restored.

## 9. Out of scope

- Member filtering and affected-only runs — after `v0.11.0`, with the Turborepo/Nx question.
- The transport's backing service and an Ingress in the cluster — deliberately excluded by the
  generated `k8s/README.md` (M39).
- Sealed-secrets or External Secrets wiring — documented in `docs/deployment.md` as the production
  path; generated files stay plain Kubernetes.
- Rewriting existing workspace roots — the root is written once; docs give the commands.
