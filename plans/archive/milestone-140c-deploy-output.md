# Milestone 140c — Images, Compose, Kubernetes and gRPC between workspace members (`@setu-ts/cli`)

> **Status:** Complete. Branch: `feat/m140c-deploy-output`. `develop` and `main` are protected, so
> all work, including fixes, stays on this one branch until it merges through a single PR into
> `develop`.

## 0. Objective & scope

ROADMAP M140c: the deployment rows of the 2026-11-12/13 generated-code review
(`smoke/GENERATED-CODE-REVIEW.md`, read on `develop` `1fa2996b9`, every claim re-checked on
`8f4f226f2`, the M140a merge). Each row is something the generated Dockerfile, Compose stack or
Kubernetes objects do in production that the developer did not choose: SSR on React's development
build, a Bun image that installs without a lockfile on a floating base, images that skip the checks
the Node image runs, a dependency order nobody honours, a broker URL a Secret cannot override, and
gRPC between Node members that cannot connect at all.

- **In scope (9 rows + 1 follow-up):**
  - **Images:** V12-68 (`NODE_ENV`), V12-121 (Bun lockfile), V12-122 (Bun base tag), V12-123 (Bun
    and Deno check stage).
  - **Compose:** V12-113 (`--depends-on` and healthchecks), V12-115 (README broker sentence).
  - **Kubernetes:** V12-110 (transport URL overridable from the Secret), V12-116 (README on the
    hand-applied `:dev` tag), V12-113 (README on start order).
  - **gRPC between members:** V12-111.
  - **M140a follow-up:** `k8s/secrets/<member>/.env` gains a random value for each generated secret
    a member records (`setu generate app` with full-stack, `setu add auth|session` in a member).
- **NOT this milestone:**
  - **Workers/Deno/Bun project output** outside the Dockerfile (READMEs, `main.ts` env parsing,
    V12-124's empty `REDIS_URL=`): M140b, on its sibling branch.
  - **Generators and the agent brief:** M140d. **Documentation beyond CHANGELOG and the generated
    READMEs this milestone writes:** M140e (`docs/deployment.md` Kubernetes and Compose sections,
    `packages/grpc-plugin/README.md` workspace note).
  - **V12-114** (unauthenticated, unpersisted Compose Redis; floating `redis:7`/`node:24-alpine`):
    reclassified to the application on 2026-11-13 (`smoke/PRODUCT-DEFECTS.md`).
  - **TLS between workspace members:** see §3.6.

## 1. Contracts verified from SOURCE (not names)

All paths under `packages/` unless stated. Read on `8f4f226f2`.

| Reference                              | Source (file:line)                                                                                     | Verified surface / fact                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Generated Dockerfile                   | `cli/src/workspace/compose.ts:130-276` (Deno), `:357-389` (npm/Bun)                                    | One file per workspace (`MEMBER` build arg) and per standalone project (`workspace = false`). No `NODE_ENV` anywhere in `cli/src` (grep). Deno: `frontend` stage (glibc) whose `build/` is copied                                                      |
| Base images                            | `cli/src/workspace/compose.ts:75,99,110,116`                                                           | `denoland/deno:alpine-2.9.5` / `debian-2.9.5` pinned; `node:24-alpine` (comment says "Pinned, not floating" — it floats on minor); `oven/bun:1-alpine` floats                                                                                          |
| Bun install                            | `cli/src/workspace/compose.ts:362-363,374,382`                                                         | `COPY package.json bun.lock* ./` then `bun install --frozen-lockfile` in both stages; measured by the review (Bun 1.4.4): no `bun.lock` → exit 0, unpinned                                                                                             |
| Bun build stage                        | `cli/src/workspace/compose.ts:365-366,376`                                                             | Runs `bun run build` only when `scripts.build` exists (parsed with `bun -e`); nothing type-checks                                                                                                                                                      |
| Bun `check` script                     | `cli/src/templates/project-files.ts` (scaffold `bunrest`, `--template rest --runtime bun`)             | Generated Bun projects carry `check: tsc --noEmit && setu check`, `typescript` and `@setu-ts/cli` devDependencies (scaffold read)                                                                                                                      |
| Deno `check` task                      | `cli/src/templates/project-files.ts:1302-1305,1333,1394`; `cliCheckCommand` `:1356-1359`               | `deno check main.ts setu.config.ts && deno run -A --no-lock npm:@setu-ts/cli@<exact> check`; the full-stack form runs `deno task build` first                                                                                                          |
| Node build gate                        | `cli/src/templates/project-files.ts:1716-1721`                                                         | Node `build` = `[frontend &&] tsc --noEmit && setu build`; `setu build` runs `setu check` first (M120)                                                                                                                                                 |
| Node `start`                           | `cli/src/templates/project-files.ts:1675,1722-1724`                                                    | `NODE_START_BUILD_CHECK && node <preload> --env-file-if-exists=<env> --enable-source-maps dist/main.js`; the check is a cross-platform `node -e`, so the script already avoids POSIX-only syntax                                                       |
| Bun / Deno `start`                     | `cli/src/templates/project-files.ts:1722-1723` (Bun), `:1262-1270` (Deno)                              | `bun run main.ts`; Deno `deno run <perms> [envfile] <entry>`                                                                                                                                                                                           |
| `NODE_ENV` in the framework            | `exceptions/src/middleware/error-handler.ts:16,71`                                                     | Only a JSDoc example reads it, through config; no framework behaviour changes with it                                                                                                                                                                  |
| Env prefix in scripts                  | measured 2026-11-14, Bun 1.4.4 / Deno 2.9.6 / Node 24.22.1                                             | `NODE_ENV=production bun run m.ts` (package script) and `NODE_ENV=production deno run …` (task) print `production`; `node --import "data:text/javascript,process.env.NODE_ENV??='production'"` prints `production`, and keeps a preset `NODE_ENV=test` |
| Compose member service                 | `cli/src/workspace/compose.ts:430-503`                                                                 | `depends_on` only from `transport.compose.dependsOn`/`condition` (`:459-467`); no `healthcheck`; `restart: unless-stopped`                                                                                                                             |
| Member record                          | `cli/src/workspace/manifest.ts:173,187`; `commands/app.ts:791-825`                                     | `dependsOn?: string[]`, `healthProbes?: boolean` (true for every named template), `rpc?: 'grpc'`, `generatedSecrets?: string[]`                                                                                                                        |
| Kubernetes member objects              | `cli/src/workspace/k8s.ts:65-264`                                                                      | Transport and sibling-host variables as explicit `env:` (`:120-128`), then `envFrom` of `<member>-env` (`:211-214`, `secrets.ts:56-62`); `image: <m>:dev`, `IfNotPresent` (`:200-201`)                                                                 |
| Transport member env                   | `cli/src/workspace/transport.ts:120,302,331,375,424,469,520`; `compose.ts:404-412`                     | `memberEnv` per broker (`REDIS_URL`, `RABBITMQ_URL`, `NATS_URL`, `KAFKA_BROKERS`, `PUBSUB_EMULATOR_HOST`, …); `memberEnvironment()` = sibling hosts + `memberEnv`, shared by Compose and k8s                                                           |
| Declared Secret names                  | `cli/src/workspace/secrets.ts:73-78`; `commands/workspace-ops.ts:474-505`                              | `.env.example` keys minus `memberEnvironment()` keys are REQUIRED; `renderMemberSecret` (`secrets.ts:124-147`) writes EVERY key of the operator file, so a `REDIS_URL` there reaches the Secret                                                        |
| Operator values file                   | `cli/src/workspace/secrets.ts:25-27`; `workspace/root-files.ts:312,322`; `compose.ts:329`              | `k8s/secrets/<member>/.env`; root `.gitignore` lists `k8s/secrets/`, `.dockerignore` lists `k8s`. The CLI never writes it (grep: only `workspace-ops.ts` reads it)                                                                                     |
| Symlink rule on the values file        | `cli/src/commands/workspace-ops.ts:229` (doc), `docs/deployment.md:630-632`                            | Deploy reads the values files only as regular files inside the workspace, never through a link (M122 audit F2)                                                                                                                                         |
| `add auth` / `add session` in a member | `cli/src/commands/add.ts:2420,2494-2540`                                                               | `JWT_SECRET` / `SESSION_SECRET`; records it in `generatedSecrets`, rewrites Compose and `.dockerignore`; touches nothing under `k8s/`                                                                                                                  |
| Build-stage dependency                 | `cli/src/workspace/compose.ts:187` (Deno), `:384` (Bun)                                                | The final stage always copies `buil[d]` from `frontend` (Deno) or `build` (Bun), even when no build ran, so BuildKit runs that stage every time                                                                                                        |
| check:deploy workspace gate            | `scripts/check-deploy.ts:1222,1270-1400`                                                               | Node workspace `shop` (`orders` rest + `portal` full-stack) on kind; asserts deploy refuses without `k8s/secrets/portal/.env` (`portal needs`), then writes the file itself                                                                            |
| gRPC caller wiring                     | `cli/src/workspace/transport-module.ts:181-195`; `workspace/rpc.ts:152-177`                            | A caller's `--depends-on` on a `grpc` member renders `GrpcPlugin({ … clients: { <m>: { basePath: '/grpc' } } })`; client packages are connect-node's                                                                                                   |
| Client HTTP version                    | `grpc-plugin/src/client/grpc-client.ts:28-34`; `common/src/services/grpc.ts:161-165`                   | `CLIENT_DEFAULTS.httpVersion: '2'`; `'1.1'` available; native gRPC needs `'2'`                                                                                                                                                                         |
| `RuntimePlugin` `http2`                | `runtime/src/plugin/runtime-plugin.ts:118-148,188-224`                                                 | `true` = h2c + HTTP/1.1 on one port (Node); Bun switches to the Node adapter; Deno already answers h2c; `{ key, cert }` = TLS/ALPN                                                                                                                     |
| Member RuntimePlugin                   | `cli/src/templates/rest.ts:21-27`; `starters/rest-starter/src/options.ts:89`, `src/app.ts:126-132,187` | Plugin-list hosts render `RuntimePlugin({ maxBodyBytes: 1_048_576 })`; starters take `runtime?: RuntimeOptions` and merge `maxBodyBytes`; `FullStackStarterOptions` extends it                                                                         |
| `RuntimeOptions` export                | `runtime/src/index.ts:13`                                                                              | Exported type                                                                                                                                                                                                                                          |
| Transport module and planner           | `cli/src/workspace/transport-module.ts:34-39,240-339`; `workspace/rewire.ts:219-268`                   | CLI-owned `src/transport/index.ts`; config calls `messagingOptions`/`queueOptions`/`transportPlugins`/`csrfExclusions`; the planner refuses a config that lacks a call and prints the lines                                                            |
| Workspace mesh e2e                     | `cli/test/e2e/workspace-mesh-e2e.test.ts:446-500`                                                      | The gRPC mesh case runs on DENO, which answers h2c without `http2` — why no gate saw V12-111                                                                                                                                                           |
| README transport section               | `cli/src/workspace/root-files.ts:69-114`                                                               | "Members share the **<broker>** broker" and "Every member reads its connection value from `<VAR>`" — unconditional                                                                                                                                     |
| Deploy manifest rewrite                | `cli/src/workspace/deploy-manifest.ts:46,116,139,194`                                                  | `prepareDeployManifest` fills placeholders and images; `readsMemberSecret`, `stampSecretVersion`, `unreadableSlot` read per-member Deployment text                                                                                                     |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                         | Resolution (picked side)                                                                                                    | Doc deliverable (same PR)                                    |
| --- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| C1  | ROADMAP M140c lists `grpc-plugin`; the fix (§3.6) is in the generated wiring and the client already supports h2c | `cli` only. The client's HTTP/2 default is right for gRPC; the member was generated without the server half                 | ROADMAP M140c packages cell → `cli` (with a one-line reason) |
| C2  | `compose.ts:109` "Pinned, not floating" on `node:24-alpine`                                                      | It floats within Node 24 by design (security patches); the comment changes, the tag does not (V12-114 is the application's) | The comment, in this PR                                      |
| C3  | M139b plan said scaffolds would not change while its client default made generated callers need h2c              | Archived plan; declined as a doc fix. The behaviour fix is §3.6                                                             | None (archived plan, §16.5)                                  |

## 3. Design decisions

### 3.1 V12-68: production starts and images set `NODE_ENV=production`

- **Decision:** every generated image's runtime stage (Node, Bun, Deno; workspace and standalone)
  gets `ENV NODE_ENV=production` (`docker run -e` still overrides it, since every `CMD` runs the
  runtime directly). The `start` command (not `start:dev`, `start:debug` or tests) sets it too: Node
  `node --import "data:text/javascript,process.env.NODE_ENV??='production'" …`, which keeps a value
  already set (the only form that works under both `sh` and `cmd.exe` without a dependency; a
  preload, so it runs before the entry's static imports load `react-dom`; placed before the
  telemetry preload); Bun `NODE_ENV=production bun run main.ts` and Deno
  `NODE_ENV=production deno run …`, which set it unconditionally. The difference is deliberate:
  deno_task_shell has no `${VAR:-default}` expansion (measured: it prints the literal), and Bun's
  expansion is measured only on Linux, so neither is relied on; a different value on Bun or Deno
  goes through `start:dev`. The data URL gets a one-line explanation in the generated README's
  Production section, since `package.json` cannot carry a comment.
- **Why:** React, Express-style libraries and React Router's own server pick their production paths
  from `process.env.NODE_ENV`; `react-router-serve` and `next start` default it the same way (`??`),
  and the Node Docker best practices set it in the image. `setu build` keeps packages external, so a
  build-time define cannot reach `react-dom/server`.
- **Test home:** `cli/test/unit/workspace/compose.test.ts` (each runtime, both shapes);
  `cli/test/unit/templates/project-files.test.ts` (start per runtime, dev scripts unchanged; Node
  keeps a preset value, Bun and Deno set it); scaffold e2e: the `--import` token read from the
  generated full-stack Node `start` script, run as `node --import <token> -p process.env.NODE_ENV`,
  prints `production`, and `test` when `NODE_ENV=test` is preset; `check:deploy --generated`:
  `docker run` on each runtime's image prints `production` (`node -p`, `bun -e`, `deno eval`).

### 3.2 V12-121: a Bun image refuses to build without `bun.lock`

- **Decision:** both Bun stages keep `COPY package.json bun.lock* ./` and run
  `test -f bun.lock || { echo 'bun.lock is missing: run bun install and commit bun.lock' >&2; exit 1; }`
  before `bun install --frozen-lockfile` (same `RUN`). Node's `npm ci` already refuses without
  `package-lock.json`; Deno is unchanged.
- **Why:** `--frozen-lockfile` passes with no lockfile (measured), so the two stages resolve
  independently. A named refusal beats a `COPY` cache-key error.
- **Test home:** `compose.test.ts` (text); `check:deploy --generated --runtime bun` path or the Bun
  image build in the scaffold-image e2e (§7): build without `bun.lock` fails with the message, with
  it passes.

### 3.3 V12-122: the Bun base image is pinned to an exact version

- **Decision:** `oven/bun:1.4.0-alpine` (the Bun every CI job pins, `.github/workflows/ci.yml:48`),
  with the same comment Deno's pin carries. The constant is the one place to bump.
- **Why:** a floating `1-alpine` changes the lockfile reader on a day nothing changed. Docker Hub
  publishes exact `1.x.y-alpine` tags (newest `1.4.4-alpine`); the CI-tested version is chosen over
  the newest so the image matches what the suite runs.
- **Test home:** `compose.test.ts` asserts the exact tag.

### 3.4 V12-123: Bun and Deno images run the project's own check

- **Decision:** the stage whose output the final image copies runs the member's check, so BuildKit
  cannot skip it: Bun's `build` stage runs `bun run check` when `scripts.check` exists (detected
  like `build`, with `bun -e`); Deno's `frontend` stage runs `deno task check` when the `check` task
  exists (detected with the same pinned `@std/jsonc` parser it uses for `build`). A full-stack Deno
  member's `check` task rebuilds the frontend; that cost is accepted rather than hand-splitting the
  task. The check runs after `build` so a full-stack member's server build exists. (Review fix: the
  stage drops ` main.dev.ts` from its own discarded copy of the `check` task, since `.dockerignore`
  excludes that file.)
- **Why:** maintainer decision 2026-11-13 ("a check stage equivalent to Node's `tsc --noEmit` and
  `setu check`"); running the project's own task keeps one definition of "check".
- **Test home:** `compose.test.ts`; scaffold-image e2e: a Bun and a Deno member with a type error
  fail `docker build`, a clean one builds.

### 3.5 V12-113: Compose honours `--depends-on` with healthchecks; Kubernetes states why it does not order

- **Decision (Compose):** a member recorded with `healthProbes: true` gets a `healthcheck` probing
  `GET http://127.0.0.1:<port>/ready` with the image's `wget`, in exec form
  (`test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:<port>/ready"]`, so no shell is
  needed; `interval: 5s`, `timeout: 3s`, `retries: 10`, `start_period: 30s`). A member's
  `depends_on` merges the transport's entries with one entry per `dependsOn` member:
  `condition: service_healthy` when that member has `healthProbes`, otherwise `service_started`.
- **Decision (Kubernetes):** no init containers or ordering. The k8s README states that Kubernetes
  has no start order, that each member's readiness probe keeps it out of its Service until it
  answers `/ready`, and that generated callers resolve a sibling per call, so a dependent started
  first does not fail.
- **Why:** Compose's documented order mechanism is `depends_on` with `condition: service_healthy`
  (Docker's startup-order guide), and Compose errors when `service_healthy` names a service with no
  healthcheck (`docker/compose` `dependency_wait.go`), hence `service_started` for those. Spring
  Boot's Compose support and .NET Aspire's `WaitFor` likewise wait on a health check. All three base
  images are Alpine with busybox `wget` and no curl (their upstream Dockerfiles). Kubernetes has no
  ordering primitive between workloads; its docs show an init container polling DNS as one option
  and note that DNS-based discovery avoids the ordering problem. The generated members resolve
  siblings by DNS per call and gate traffic on `/ready`, so an init container would only delay
  rollout.
- **Test home:** `compose.test.ts` (healthcheck present only with `healthProbes`; both conditions;
  merged with the broker); `k8s.test.ts` (README sentence); `check:deploy --generated` gains a step:
  a Node workspace with `orders --depends-on billing` passes `docker compose config`, and
  `docker compose up --wait` reports both healthy, `billing` first.

### 3.6 V12-111: a member that serves gRPC serves HTTP/2 cleartext

- **Decision:** the CLI-owned transport module gains a fourth always-exported function,
  `runtimeOptions()`, returning `{ http2: true }` when the member serves gRPC and `{}` otherwise
  (typed `RuntimeOptions` from `@setu-ts/runtime`). Plugin-list configs render
  `RuntimePlugin({ ...runtimeOptions(), maxBodyBytes: 1_048_576 })`; app-factory (full-stack)
  configs pass `runtime: runtimeOptions()` to the starter. The planner's `missingCalls`
  (`rewire.ts`) requires the call like the other three, so `setu workspace rpc <m> grpc` flips the
  listener with no config edit. Callers keep the client's HTTP/2 default. No TLS is rendered:
  in-cluster h2c is what gRPC callers and service meshes expect; the transport module's doc comment
  names `RuntimePlugin({ http2: { key, cert } })` with discovery `secure: true` for a member that
  needs TLS.
- **Why:** a native gRPC client from any language needs HTTP/2, so the server side is the fix, not
  downgrading callers to `'1.1'` (which would also lose client and bidirectional streaming). Routing
  it through the transport module keeps the config user-owned (M138 §0).
- **Test home:** `transport-module.test.ts` (both returns, both host kinds); `rewire.test.ts` (a
  config without the call is refused with the line to add); new
  `cli/test/e2e/workspace-grpc-node-e2e.test.ts`: a NODE workspace, `billing --rpc grpc`,
  `orders --depends-on billing`, both booted, `orders` calls `billing`'s health service through the
  generated client and gets `SERVING`; with `runtimeOptions()` edited to `{}`, the same call fails
  (proves the test exercises the fix).

### 3.7 V12-110: in Kubernetes, the member's Secret overrides the transport default

- **Decision:** the transport variables (`memberEnv`) leave each Deployment's explicit `env:` and go
  into one generated ConfigMap, `setu-transport`, in `k8s/members.yaml`. Each container's `envFrom`
  lists `configMapRef: setu-transport` first and its `secretRef` second, so a key in
  `k8s/secrets/<member>/.env` wins over the default; sibling `<MEMBER>_HOST` entries stay in `env:`
  and still win over both. The transport variables stay out of the REQUIRED names
  (`declaredSecretNames`), so a member without a value deploys on the default. Compose is unchanged
  (its broker is the stack's own service). No workspace without a transport `memberEnv` gets the
  ConfigMap. Each pod template carries a generated annotation
  `setu-ts.dev/transport-config: <KEY=VALUE pairs of the ConfigMap's data, sorted, comma-joined>`
  (non-secret defaults, so safe to show): pods read `envFrom` only at start, so without it a
  `setu workspace broker` change would update the ConfigMap and leave every running pod on the old
  broker, where today's `env:` change rolls them. No hashing needed; the value changes exactly when
  the data does.
- **Why:** maintainer decision 2026-11-13. The Pod API reference (Container.envFrom): for a key in
  several sources "the value associated with the last source will take precedence", and "values
  defined by an Env with a duplicate key will take precedence".
- **Test home:** `k8s.test.ts` (ConfigMap, order, `env:` holds only hosts; the annotation changes
  when the broker changes and is absent without a ConfigMap); `deploy-manifest.test.ts`
  (placeholders filled in the ConfigMap; `readsMemberSecret` still true); `workspace-ops.test.ts`
  (an operator `REDIS_URL` reaches the Secret, absence is not refused); `check:deploy --workspace`
  unchanged behaviour on kind.

### 3.8 V12-116: the hand-applied path names its staleness

- **Decision:** the k8s README's "By hand" paragraph and the `image:` comment state that `:dev` with
  `imagePullPolicy: IfNotPresent` reuses whatever image a node already holds under that tag, so a
  rebuilt image needs a new tag, and that `setu workspace deploy` tags with the commit for that
  reason. The manifest values stay as they are (maintainer decision 2026-11-13).
- **Test home:** `k8s.test.ts`.

### 3.9 V12-115: the README says which members use the broker

- **Decision:** the transport section reads "Members that register `MessagingPlugin` or
  `QueuePlugin` share the **<broker>** broker … each reads its connection value from `<VAR>`"; a
  following sentence says a member without them (a `rest` member, for one) receives the variable but
  connects to nothing until `setu add messaging` (or `queue`) wires the generated options in.
  Compose and Kubernetes keep giving every member the variable and the broker dependency, so adding
  messaging later needs no regeneration.
- **Test home:** `root-files.test.ts`.

### 3.10 M140a follow-up: `k8s/secrets/<member>/.env` gains each generated secret

- **Decision:** whenever a member's `generatedSecrets` gains a name (`generate app` recording a
  template's generated secret, `setu add auth|session` in a member), the same command appends
  `<NAME>=<generateSecret()>` to `k8s/secrets/<member>/.env`, creating the file (and directory) when
  absent, and leaving an existing entry for that name untouched (exact-key append, M140a's
  `.gitignore` lesson). The value is independent of the member's local `.env` and of Compose's shell
  variable. The write refuses a path whose file or any directory under the workspace root is a
  symbolic link (the rule deploy's reader already applies), never prints the value, and is listed
  (name only) in `--dry-run`. Other declared names (`TRUSTED_PROXIES`, …) are not written: deploy
  keeps refusing until the operator sets them.
- **Why:** after M140a every other place a generated secret lives gets a random value at the moment
  the secret is recorded; this file was the one left for the operator to remember, and deploy's
  refusal only appears at deploy time. The file is gitignored and excluded from every image.
- **Test home:** `app-command.test.ts`, `add.test.ts` (created, appended, existing key kept, link
  refused, dry run); `check:deploy --workspace`: the refusal still names `TRUSTED_PROXIES`, not
  `SESSION_SECRET`.

### 3.11 CHANGELOG

One `[Unreleased]` `cli` entry: the image and start `NODE_ENV`; the Bun lockfile refusal and pinned
base; Bun/Deno check stages; Compose healthchecks and dependency order; the `setu-transport`
ConfigMap; `runtimeOptions()` in the transport module (BREAKING for a member config made before: the
planner refuses until the call is added, and names the line); the operator secrets file.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — no package export changes. The generated transport module's
new required call ships in minor `0.13.0` (§3.11).

| Exported symbol | Kind | Consumer / real code path that READS it                                                        |
| --------------- | ---- | ---------------------------------------------------------------------------------------------- |
| None            | —    | No `src/index.ts` changes in any package (checked: every change is inside `packages/cli/src/`) |

### 4.1 Options — every option names its consumer

| Option                                      | Consumer                                              | Behavior (per implementation)                                |
| ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| Generated `runtimeOptions()` (member code)  | the member's `RuntimePlugin` / starter `runtime`      | `{ http2: true }` when serving gRPC, `{}` otherwise          |
| `TRANSPORT_EXPORTS.runtime` (internal)      | `transport-module.ts`, `rewire.ts`, `member-host.ts`  | Names the function in the module, the planner and the config |
| `setu-transport` ConfigMap (generated YAML) | each Deployment's `envFrom`                           | Transport defaults below the member Secret                   |
| `setu-ts.dev/transport-config` annotation   | the Deployment controller (template change → rollout) | Rolls every member when the ConfigMap's data changes         |

## 5. Implementation files

| File                                                                     | Purpose                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `cli/src/workspace/compose.ts`                                           | `NODE_ENV`, Bun lockfile guard and pin, check stages, healthchecks, order                                                 |
| `cli/src/templates/project-files.ts`                                     | `start` scripts and Deno `start` task; README Production line (§3.1)                                                      |
| `cli/src/workspace/k8s.ts`, `workspace/secrets.ts`                       | ConfigMap, `envFrom` order, README (§3.5, §3.7, §3.8)                                                                     |
| `cli/src/workspace/deploy-manifest.ts`                                   | Placeholders and checks across the new document                                                                           |
| `cli/src/workspace/transport-module.ts`                                  | `runtimeOptions()` (§3.6)                                                                                                 |
| `cli/src/workspace/rewire.ts`, `workspace/member-host.ts`                | Required call, config rendering (§3.6)                                                                                    |
| `cli/src/workspace/root-files.ts`                                        | README transport sentence (§3.9)                                                                                          |
| `cli/src/workspace/operator-secrets.ts` (new)                            | Exact-key append to `k8s/secrets/<member>/.env`, link refusal (§3.10)                                                     |
| `cli/src/commands/app.ts`, `commands/add.ts`                             | Call it when `generatedSecrets` grows (§3.10)                                                                             |
| `cli/test/fixtures/template-baseline.json`, `redis-develop-outputs.json` | Regenerated with `capture-template-baseline.ts`                                                                           |
| `scripts/check-deploy.ts`                                                | Workspace refusal text (§3.10); generated gate's Compose order step and Bun/Deno check-stage negative builds (§3.4, §3.5) |
| ROADMAP.md, CHANGELOG.md, CLAUDE.md                                      | C1, §3.11, status flip                                                                                                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                   | src covered                                          | Key assertions                                                                            |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `cli/test/unit/workspace/compose.test.ts`                                                   | `compose.ts`                                         | §3.1–3.5 per runtime and shape; table of members × `healthProbes` × `dependsOn`           |
| `cli/test/unit/templates/project-files.test.ts`                                             | `project-files.ts`                                   | `start` per runtime; `start:dev`/`start:debug`/tests carry no `NODE_ENV`                  |
| `cli/test/unit/workspace/k8s.test.ts`, `secrets.test.ts`                                    | `k8s.ts`, `secrets.ts`                               | ConfigMap, `envFrom` order, `env:` hosts only, README sentences                           |
| `cli/test/unit/workspace/deploy-manifest.test.ts`                                           | `deploy-manifest.ts`                                 | ConfigMap placeholders; per-member reads unaffected                                       |
| `cli/test/unit/commands/workspace-ops.test.ts`                                              | (deploy path)                                        | operator `REDIS_URL` in the Secret; absent not refused                                    |
| `cli/test/unit/workspace/transport-module.test.ts`, `rewire.test.ts`, `member-host.test.ts` | `transport-module.ts`, `rewire.ts`, `member-host.ts` | §3.6 returns; refusal and printed line; rendered config calls                             |
| `cli/test/unit/workspace/root-files.test.ts`                                                | `root-files.ts`                                      | §3.9 sentences                                                                            |
| `cli/test/unit/workspace/operator-secrets.test.ts` (new)                                    | `operator-secrets.ts`                                | create, append, keep existing key, link at file and directory refused, no value in output |
| `cli/test/unit/app-command.test.ts`, `cli/test/unit/commands/add.test.ts`                   | `app.ts`, `add.ts`                                   | called on growth only; dry run lists names                                                |
| `cli/test/e2e/workspace-grpc-node-e2e.test.ts` (new)                                        | generated output                                     | §3.6 call succeeds on Node; fails with `{}` (negative control)                            |
| `cli/test/e2e/scaffold-runs-e2e.test.ts`                                                    | generated output                                     | full-stack Node `start`: `NODE_ENV` production, no React dev warning                      |

## 7. Verification gates

```bash
git branch --show-current   # feat/m140c-deploy-output
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run ci:local --shard cli        # plus packages/static as the diff requires; never beside the sibling's suite
pnpm run test:deno-lane
pnpm run check:deploy --generated    # Node, Bun, Deno images build and boot air-gapped (§3.1–3.4); compose order (§3.5)
pnpm run check:deploy --workspace    # kind: deploy, ConfigMap, Secret override, refusal text (§3.7, §3.10)
pnpm run release:publish --dry-run
pnpm run release:verify 0.12.0
```

The scaffold e2e boots every template this milestone changes (CLAUDE.md generated-output rule).
Before every suite run: `pgrep -af "vitest|local-ci.ts"` and `docker ps`, waiting while the M140b
session's suite runs.

## 8a. Design security review

Completed 2026-11-14, before implementation, against the source cited in §1.

- **Reviewed flows:** F1 an operator secret written by the CLI into `k8s/secrets/<member>/.env`; F2
  that file reaching Git, an image, or a terminal; F3 a Secret value overriding a generated variable
  in a pod; F4 a member serving h2c on its application port; F5 an image build that installs
  unpinned dependencies; F6 a Compose healthcheck probing the member.
- **Assets:** each member's signing secrets; the broker credentials an operator puts in the Secret;
  sibling routing (`<MEMBER>_HOST`); the supply chain of the image.
- **Attackers:** a branch author who replaces `k8s/secrets/<member>` with a link; anyone reading CLI
  output or CI logs; a compromised npm release landing between two build stages; a client on the
  member's port.
- **Obligations the audit probes** (each with a positive control):
  - **O1** The CLI never writes through a link at `k8s/secrets`, `k8s/secrets/<m>` or the file
    (refused, nothing written); a regular path is written with an existing key unchanged.
  - **O2** No generated value appears in stdout/stderr (normal and `--dry-run`); the file is matched
    by the root `.gitignore` (`git check-ignore`) and absent from a built image.
  - **O3** A Secret value overrides `REDIS_URL` in a pod; a Secret `ORDERS_HOST` does NOT override
    the generated sibling host.
  - **O4** A Bun build with no `bun.lock` fails; with one, both stages resolve the same versions.
  - **O5** The h2c listener refuses nothing it served before on HTTP/1.1 (HTTP routes, `/ready`),
    and only gRPC members get it.

## 8. Risks & mitigations

- `docker build` of a full-stack Deno member gets slower (the check rebuilds the frontend) →
  accepted (§3.4); measured in `check:deploy --generated` and reported.
- `setu check` inside a Bun/Deno image may need a file `.dockerignore` excludes (e.g. `.env`) →
  `check:deploy --generated` builds each runtime; a failure there is fixed in the check, not by
  dropping the stage.
- Bun's Node adapter path under `http2: true` needs `ws` for WebSockets → only gRPC members get it;
  the transport module's comment names it.
- busybox `wget` missing from a future base image → the base images are pinned (Deno, Bun) or Alpine
  (Node); `check:deploy --generated` runs the healthcheck for real.
- Sibling M140b edits `project-files.ts` → this branch touches only the `start` lines; the second
  branch to merge regenerates the template baselines.

## 9. Out of scope

- TLS between members and certificate distribution (a mesh or cluster concern; documented path in
  §3.6).
- An init-container or wait-for-it ordering in Kubernetes (§3.5).
- Pinning `node:24-alpine` or `redis:7` (V12-114, the application's).
- Kubernetes for the transport's backing service (unchanged: a managed service or StatefulSet).
