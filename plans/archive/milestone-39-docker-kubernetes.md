# Milestone 39 — Docker and Kubernetes (`docker/`, `k8s/`, `scripts/`, `docs/`)

> **Status:** Complete (PR pending). Branch: `feat/m39-docker-kubernetes`. Archived on completion
> per the milestone-plan convention.

## 0. Objective & scope

The framework can be _served_ on four runtimes and _found_ by an orchestrator (M50), but it cannot
be _shipped_ to one: `git ls-files` returns exactly one deployment artifact — M24c's
`docker/otel-collector/collector-config.yaml` — and no Dockerfile, no Compose file, no Kubernetes
object, and no deploy guide exist anywhere in the tree. Every example is run with `deno task start`
on a developer's machine. This milestone supplies the container image path, the orchestration
objects, and a gate that proves both actually work rather than merely parse.

- **In scope:** one parameterized multi-stage `Dockerfile` (any example, via `ARG APP`) plus a
  `Dockerfile.compiled` `deno compile` → distroless variant; a local-dev Compose stack wiring Redis
  and the M24c collector; a Helm chart as the single authored source for the Kubernetes objects
  (Deployment, Service, Ingress, ConfigMap, Secret, HPA, PDB, ServiceAccount + RBAC) with **rendered
  manifests committed** beside it and a gate proving they match; the Cloudflare Workers deploy path
  (`wrangler`, explicitly not a container, per the ROADMAP note); an operator guide; and a
  `check:deploy` gate that builds real images, re-renders the chart, and applies the manifests to a
  real **kind** cluster and serves a request through them.
- **NOT this milestone:**
  - App-side discovery — resolving a name to instances, balancing, watching, outlier ejection —
    **M50**, per the boundary the ROADMAP already draws. M39 owns only the platform objects (the
    `Service`, the `EndpointSlice`s it produces, and the RBAC that lets a pod read them).
  - Deployment to a live cloud (EKS/GKE/AKS/Cloudflare account). CI holds no cloud credentials; the
    proof here is a local kind cluster. Stated as a limitation, not implied.
  - Release/publish mechanics and the runtime-portability matrix — **M40**.
  - Changing any application's port handling. Examples read `Deno.args[0] ?? 3000` (§1); making them
    read `$PORT` would touch 12 `main.ts` files for no capability gain, so the image passes the port
    as an argument instead (§3.4).
  - `packages/` source. This milestone adds **no** package source, no capability token, no plugin
    option, and no `src/index.ts` export.

## 1. Contracts verified from SOURCE (not names)

| Reference                              | Source (file:line)                                                                     | Verified surface / fact                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Health endpoint paths                  | `packages/health-plugin/src/plugin/health-plugin.ts:52,114,119,124`                    | Defaults are `{ health: '/health', live: '/live', ready: '/ready' }` and each is registered with `ctx.router.get(...)`. Probes use **`/live` and `/ready`** — NOT `/health/live`, the shape a hand-written manifest usually guesses.             |
| k8s discovery API path                 | `packages/service-discovery-plugin/src/providers/kubernetes-provider.ts:103-104`       | Reads `${apiServer}/apis/discovery.k8s.io/v1/namespaces/{ns}/endpointslices`. RBAC therefore needs apiGroup `discovery.k8s.io`, resource `endpointslices`, verbs `list` + `watch` (it LISTs and re-LISTs on watch events).                       |
| k8s projected token path               | `packages/service-discovery-plugin/src/providers/kubernetes-provider.ts:11-12,114-129` | `TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'`, re-read periodically; absent an explicit `token` option it needs `IRuntimeServices.fs`. So the pod needs a real ServiceAccount, not `automountServiceAccountToken: false`. |
| Graceful-shutdown phase                | `packages/common/src/plugin.ts:359,364`                                                | `ILifecycleApi.onStopping(fn)` runs at the very start of `stop()`, **before** the socket closes; `onShutdown` runs after. This is what makes a `terminationGracePeriodSeconds` meaningful rather than decorative.                                |
| Example port binding                   | `apps/minimal/main.ts:4` (and 9 more, same shape)                                      | `const port = Number(Deno.args[0] ?? 3000)` — the port is an **argv**, never `$PORT`. `graphql-demo` defaults 4000, `grpc` 5000, `static-site` and `full-stack` hardcode 8000/3000.                                                              |
| Example import maps are partial        | `apps/minimal/deno.json` (probed, §3.1)                                                | Maps only the packages the app imports DIRECTLY (`kernel`, `runtime`); transitive `@setu-ts/common` is NOT mapped. It resolves via the **root workspace**, not the app config — the fact that dictates the Docker build context.                 |
| Root workspace membership              | `deno.json:1-24`                                                                       | `workspace: [./packages/common, ./packages/kernel, ...]`. Deno resolves member→member deps to local source; without this file `packages/kernel/deno.json`'s `jsr:@setu-ts/common@^0.1.0-alpha.6` goes to the registry.                           |
| M24c collector config                  | `docker/otel-collector/collector-config.yaml:7-9,15-22`                                | Requires the **contrib** distribution (`otel/opentelemetry-collector-contrib`) — `datadog`/`azuremonitor` are absent from core. OTLP receiver on `:4318` (HTTP) and `:4317` (gRPC). Compose mounts this file rather than redefining it.          |
| M24c ↔ M39 ownership                   | `ROADMAP.md:2740-2742`                                                                 | "Runnable `docker-compose` … and Kubernetes manifests — broader containerization is owned by **M39**, which references this collector config rather than redefining it." Confirms the reference-don't-copy direction.                            |
| M50 ↔ M39 boundary                     | `ROADMAP.md:4011-4014`                                                                 | M39 owns "the Kubernetes `Service` and `EndpointSlice` objects, and any Consul deployment"; M50 owns resolution/balancing/watching/ejection.                                                                                                     |
| RBAC is documented nowhere             | `grep` over `docs/*.md`, root `*.md`, plugin README (excl. generated `docs/api/`)      | Zero hits for `endpointslices` or `RoleBinding`. M50 shipped a provider that cannot work without RBAC no committed doc describes → C4.                                                                                                           |
| ARCHITECTURE has no deployment section | `grep '^## ' ARCHITECTURE.md`                                                          | §§8–18 cover packages…future evolution; no deployment/ops section exists → C5.                                                                                                                                                                   |

### 1.1 Facts established by PROBING the real toolchain (not inferred)

Each of these was measured on this machine, and three of them contradict the ROADMAP.

| #  | Probe                                                    | Result                                                                                                                                                                                                                                            |
| -- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 | `docker build` copying only `packages/` + `apps/minimal` | **FAILS**: `Could not find version of '@setu-ts/common' that matches '^0.1.0-alpha.6'`. Without the workspace root the caret-prerelease range is resolved against JSR and does not match. Copying root `deno.json` + `deno.lock` fixes it. → §3.1 |
| P2 | Base image `denoland/deno:alpine-2.1.4`                  | **FAILS**: `Unsupported lockfile version '5'`. The committed lockfiles are v5 (local Deno 2.9.5), so the base tag must track the Deno that writes them. → §3.3                                                                                    |
| P3 | Built image run, `curl localhost:18080/`                 | **200** `{"hello":"world"}` from a real container.                                                                                                                                                                                                |
| P4 | `ldd` on the `deno compile` output                       | **Dynamically linked** — `libc.so.6`, `libgcc_s.so.1`, `libm`, `libpthread`, `librt`, `libdl`. `scratch` is therefore **impossible**; `gcr.io/distroless/cc-debian12` is the floor. → C2                                                          |
| P5 | Size, compiled/distroless vs deno-runtime image          | **44.9 MB vs 52.4 MB**. A real but modest win — the compiled binary embeds the whole Deno runtime, so "minimal" oversells it. → C2                                                                                                                |
| P6 | Compiled distroless image run, `curl /health`            | **200** `{"status":"ok"}`.                                                                                                                                                                                                                        |
| P7 | `kind create cluster` on this host                       | **Works** (k8s v1.31.2), after removing a leftover control-plane container. Confirms the chosen cluster gate is runnable locally, not CI-only.                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                     | Resolution (picked side)                                                                                                                                                                                             | Doc deliverable (same PR)                                                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| C1 | ROADMAP §M39 "Dockerfiles for each example" — 15 examples would mean 15 near-identical files, which §11.1 forbids.                                           | **ONE parameterized `docker/Dockerfile`** (`ARG APP`) that builds any example, plus the compiled variant. Every example is still containerizable; only the duplication is gone. Maintainer-approved.                 | Rewrite the ROADMAP Docker bullet to the parameterized form and state which examples the gate builds.                          |
| C2 | ROADMAP §M39 "`deno compile` multi-stage builds producing minimal **distroless/scratch** images".                                                            | **`scratch` is impossible** (P4 — the binary is dynamically linked against glibc); `distroless/cc-debian12` is the floor, and the size win is 44.9 MB vs 52.4 MB (P5), not an order of magnitude.                    | Correct the ROADMAP bullet to `distroless/cc` and replace "minimal" with the measured numbers.                                 |
| C3 | ROADMAP §M39 deliverable "Helm chart (optional)" leaves chart-vs-raw-manifests unowned — two sources of truth that drift.                                    | **The chart is the single authored source; `k8s/manifests/` are rendered artifacts committed beside it**, with a gate re-rendering and diffing. Maintainer-chosen.                                                   | Promote the Helm deliverable from "(optional)" to required and state the render-drift relationship.                            |
| C4 | M50 shipped a `kubernetes` discovery provider that reads `endpointslices` with a projected SA token, and **no committed doc states the RBAC it needs** (§1). | M39 owns the platform side, so the ServiceAccount + Role + RoleBinding ship **here**, in the chart, gated behind a value, and the required rules are documented.                                                     | New RBAC subsection in `docs/deployment.md`; a pointer from the service-discovery-plugin README's Kubernetes provider section. |
| C5 | `ARCHITECTURE.md` has no deployment/operations section, so the container and orchestration model is described nowhere in the architecture doc.               | Add a short **§19 Deployment** covering the image model, the workspace-root build-context constraint (P1), and the M39/M50 boundary. Kept short — the operator detail lives in `docs/deployment.md`, not duplicated. | New `ARCHITECTURE.md` §19 + Conclusion/TOC touch-up.                                                                           |
| C6 | ROADMAP §M39 note asks to "add a Workers deploy path rather than forcing it into the Docker/k8s model", but lists no deliverable for it.                     | Ship it as a documented `wrangler deploy` path in `docs/deployment.md` driven by the existing `apps/cloudflare`, and **exclude** `cloudflare` from the image build matrix by name rather than silently.              | ROADMAP deliverable list gains the Workers path; `docs/deployment.md` carries the section.                                     |

## 3. Design decisions

### 3.1 Docker build context is the REPO ROOT, and the image carries the workspace root

- **Decision:** every image builds from the repo root as context and copies root `deno.json` +
  `deno.lock`, then `packages/`, then only the selected `apps/${APP}/`. A `.dockerignore` excludes
  `.git`, `coverage/`, `docs/api/`, `node_modules`, `apps/*/build`, and `.claude/`.
- **Why:** P1 proved this is a correctness requirement, not a preference. An app's `deno.json` maps
  only its direct dependencies; `@setu-ts/common` reaches `packages/kernel` through the **root
  workspace**. Without that file the `jsr:` specifier resolves against the registry and the build
  fails outright. Building from source rather than from published JSR is also the right target for a
  gate — drift means disagreement with **HEAD** (the M34b drift-gate reasoning), and it is what lets
  this milestone's images track a version that is not published yet.
- **Test home:** `check:deploy --build` matrix; `test/deploy-gate.test.ts` pins that the Dockerfile
  copies the workspace root (a regression here fails only at image-build time, which is slow, so the
  cheap structural assertion earns its place beside the real build).

### 3.2 One parameterized Dockerfile, not one per example

- **Decision:** `docker/Dockerfile` takes `ARG APP` and is invoked as
  `docker build -f docker/Dockerfile --build-arg APP=rest-api .`. The gate builds a representative
  **four**: `minimal` (baseline), `rest-api` (full REST stack + OpenAPI), `realtime` (a long-running
  server with a real external dependency — Redis — so the Compose and k8s env wiring is exercised),
  and `compiled-binary` (through `Dockerfile.compiled`).
- **Why:** C1/§11.1. The four are chosen because each exercises a distinct build property; the other
  examples differ only in which plugins they import, which the build path does not branch on.
  `microservices` was the obvious candidate for the external-dependency slot and was **rejected on
  reading its source**: `apps/microservices/main.ts` starts both services, makes its calls and then
  `stop()`s in a `finally`, so it is a self-terminating script, not a server — an image of it would
  exit immediately and could not back a Deployment. `realtime` has the same Redis dependency in a
  long-running shape. The RBAC deliverable (§3.7) does not need that example, because it is asserted
  at the cluster level with `kubectl auth can-i` rather than through an application.
- **Test home:** `check:deploy --build`; the excluded-by-name list is asserted in
  `test/deploy-gate.test.ts` so an example can never fall out of coverage silently.

### 3.3 Base image tag is pinned and asserted against the committed lockfile

- **Decision:** pin `denoland/deno:alpine-2.9.5` (and `denoland/deno:2.9.5` for the compile stage,
  which needs a non-alpine toolchain for a glibc-linked binary matching distroless/cc). The version
  lives in ONE place — a `DENO_VERSION` build arg — read by both Dockerfiles.
- **Why:** P2. A too-old base cannot read a v5 lockfile and every build fails; a floating tag makes
  that failure arrive on an unrelated day. One constant means a Deno bump is a one-line change.
- **Test home:** the real build IS the assertion (a mismatched pin cannot produce a working image);
  `test/deploy-gate.test.ts` additionally pins that both Dockerfiles read the same constant.

### 3.4 Port is an argument, not an environment variable

- **Decision:** the image's `CMD` passes the port positionally (`… main.ts 3000`), `EXPOSE 3000`,
  and the chart sets `containerPort: 3000`, overridable through a chart value that rewrites the
  container `args`.
- **Why:** §1 — examples read `Deno.args[0] ?? 3000`. Two `$PORT` routes were considered and both
  rejected: editing 12 `main.ts` files is app churn outside this milestone, and wrapping the
  entrypoint in a shell adds a PID-1 signal-forwarding problem to a milestone whose whole point is
  graceful shutdown. Passing argv is the honest mapping of what the apps actually accept.
- **Test home:** kind e2e serves through the Service on the chart's configured port.

### 3.5 Kubernetes probes use `/live` and `/ready`, and the chart refuses to guess

- **Decision:** `livenessProbe` → `/live`, `readinessProbe` → `/ready`, both chart values defaulting
  to those paths; `startupProbe` on `/live` so a slow first boot does not trip liveness.
- **Why:** §1 verified the health plugin registers exactly those paths. `/health/live` — the shape a
  reviewer expects — 404s, and a 404 liveness probe means the pod is killed and restarted forever
  while every YAML linter stays green. This is precisely the defect class the kind gate exists for.
- **Test home:** kind e2e asserts the Deployment reaches `Available` (which requires readiness to
  pass) and that a request served through the Service returns 200.

### 3.6 Helm chart is authored; `k8s/manifests/` are rendered and committed

- **Decision:** `k8s/chart/` is the only hand-edited Kubernetes source. `k8s/manifests/` is produced
  by `helm template` against a committed `k8s/render-values.yaml` and committed.
  `check:deploy
  --render` re-renders into a temp dir and diffs; a mismatch fails and names the
  file.
- **Why:** maintainer-chosen (C3). A reader gets plain YAML without installing Helm, and the drift
  gate makes "two sources of truth" false — there is one source and one artifact.
- **Test home:** the render-drift comparison is a pure function unit-tested in
  `test/deploy-gate.test.ts`; the gate runs the real `helm template`.

### 3.7 The RBAC that M50's discovery provider needs ships here, behind a value

- **Decision:** the chart renders a `ServiceAccount`, and — when `serviceDiscovery.enabled` is true
  — a `Role` granting `list`/`watch` on `discovery.k8s.io/endpointslices` plus a `RoleBinding`. The
  Deployment mounts the default projected token (i.e. does not disable automounting) only in that
  case.
- **Why:** §1/C4. Those exact verbs and that exact apiGroup come from the provider's own request URL
  and its re-LIST-on-watch behaviour, not from convention. Defaulting it **off** keeps least
  privilege for the common case where an app does not use the provider.
- **Test home:** kind e2e applies the discovery-enabled overlay and asserts a pod can actually read
  endpointslices with its projected token (a `kubectl auth can-i --as=system:serviceaccount:…`
  check, which fails if the apiGroup or verb is wrong — a schema validator cannot see this).

### 3.8 Graceful shutdown — the SIGTERM gap, found by deploying

**Nothing in the framework or any example handles SIGTERM.** `grep` over `packages/*/src` and
`apps/*/main.ts` for `SIGTERM`/`addSignalListener` returns **zero** hits, and the behaviour was then
measured rather than inferred: a running container stopped in **144 ms with exit code 143** (killed
by SIGTERM, not the 137 of a post-grace SIGKILL). So `app.stop()` never runs in a container — M50's
`onStopping` deregistration, database and broker disconnects, and in-flight requests are all cut. A
`terminationGracePeriodSeconds` written against that is decorative, and manifests advertising
graceful shutdown would be shipping a lie the gates cannot see.

- **Decision:** fix it at the **application** layer (maintainer-chosen). Each example the images run
  registers a SIGTERM (and SIGINT) handler that calls `app.stop()`; `docs/deployment.md` documents
  this as the recommended pattern rather than leaving it folklore. The chart supplies
  `terminationGracePeriodSeconds` (default 30) and a `preStop` sleep shorter than it, which covers
  the endpoint-removal propagation delay before SIGTERM arrives.
- **Why:** `packages/` stays untouched and the layering stays correct — a library grabbing process
  signals unasked is a side effect at import time (§11.5), and signal APIs are runtime-specific
  (§4.1), so a framework-level fix needs an `IRuntimeServices` seam and a `common` widening. That is
  a genuine capability addition, not this milestone's business; it is named in §9 as a follow-up so
  it is a deferral rather than an omission. The application layer is also where a real user does
  this, which is precisely why the framework exposes `stop()` programmatically.
- **Why the ordering then works:** §1 verified `onStopping` precedes socket close. Without the
  `preStop` window, kube-proxy can still route to a pod that has begun shutting down.
- **Test home:** documented in `docs/deployment.md`; the kind e2e asserts a rolling update completes
  with no failed request (a small request loop across the rollout).

### 3.9 Compose references the M24c collector rather than redefining it

- **Decision:** `docker/compose.yaml` runs the built app plus `redis:7` and
  `otel/opentelemetry-collector-contrib`, the latter **bind-mounting**
  `docker/otel-collector/collector-config.yaml`.
- **Why:** ROADMAP:2740-2742 assigns exactly this direction, and the contrib distribution is a hard
  requirement of that config (§1). Copying the config would create the duplicate M24c's note exists
  to prevent.
- **Test home:** `check:deploy --compose` runs `docker compose config` (which resolves and validates
  the full merged model) and, in the default local run, brings the stack up and curls the app.

### 3.10 The gate is one script with explicit modes and check-apps' skip semantics

- **Decision:** `scripts/check-deploy.ts` with `--render`, `--build`, `--compose`, `--cluster`, and
  a default that runs render + build + compose. `--cluster` requires `kind`/`kubectl`/`helm`; when
  absent it exits **77** (the code `check-apps.ts:4` already reserves for a reported skip) so an
  unavailable prerequisite can never read as a pass. CI runs all modes and does not permit the skip.
- **Why:** mirrors the established `check-apps` contract rather than inventing a second convention.
  Splitting modes keeps the fast structural checks usable on every run while the slow cluster proof
  is opt-in locally and mandatory in CI.
- **Test home:** `test/deploy-gate.test.ts` for the pure helpers; the script's own execution is the
  gate.

### 3.11 Cloudflare Workers gets a documented deploy path, not a container

- **Decision:** `docs/deployment.md` carries a Workers section driven by the existing
  `apps/cloudflare` + `wrangler deploy`, and `cloudflare` appears in the build matrix's
  **excluded-by-name** list with that reason.
- **Why:** C6 / the ROADMAP note. A Worker has no `listen`, so a container image of it would be a
  fiction that builds green.
- **Test home:** `test/deploy-gate.test.ts` asserts `cloudflare` is excluded **and** that the
  exclusion carries a reason string, so it cannot be dropped silently.

## 4. Exported surface — every symbol names its consumer

This milestone adds no package source and therefore no `packages/*/src/index.ts` export. The only
exported symbols are the pure helpers in `scripts/check-deploy.ts`, which exist to be unit-tested
(the `check-apps.ts` precedent, whose `classifySmokeExitCode`/`unexpectedSkips`/
`malformedAppDirMessage` are exported for exactly this reason).

| Exported symbol     | Kind     | Consumer / real code path that READS it                                                                                           |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `renderDrift`       | function | `checkRender()` in the same script calls it on every `--render` run to compare rendered vs committed manifests and name the file. |
| `parseModes`        | function | `main()` reads it to turn `Deno.args` into the mode set; an unknown flag is refused rather than ignored.                          |
| `missingTools`      | function | `checkCluster()` calls it to decide the exit-77 skip; returns the tool names so the skip message says which is absent.            |
| `buildMatrix`       | const    | `checkBuild()` iterates it; `test/deploy-gate.test.ts` asserts its membership and the excluded-by-name reasons.                   |
| `EXCLUDED_EXAMPLES` | const    | `test/deploy-gate.test.ts` and the `docs/deployment.md` table; each entry carries a `reason` (§3.11).                             |

### 4.1 Options — every option names its consumer

Chart values (`k8s/chart/values.yaml`). Every value below is READ by a template in this milestone; a
value no template reads is dead surface and is not added.

| Option                                                  | Consumer                                    | Behavior (per implementation)                                                                         |
| ------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `image.repository` / `.tag`                             | `templates/deployment.yaml`                 | Container image reference; the gate overrides `tag` to the locally built one for the kind run.        |
| `image.args`                                            | `templates/deployment.yaml`                 | Container `args`; carries the positional port (§3.4).                                                 |
| `service.port` / `.type`                                | `templates/service.yaml`                    | Service port and type; `containerPort` is derived from the same value so they cannot disagree.        |
| `probes.live` / `.ready`                                | `templates/deployment.yaml`                 | Probe paths, defaulting to `/live` and `/ready` (§3.5).                                               |
| `ingress.enabled` / `.host`                             | `templates/ingress.yaml`                    | Whole object is gated; absent when disabled (no empty Ingress rendered).                              |
| `config`                                                | `templates/configmap.yaml` + Deployment env | Non-secret env as a ConfigMap, projected with `envFrom`.                                              |
| `secrets`                                               | `templates/secret.yaml` + Deployment env    | Secret env, projected with `envFrom`; documented as a dev convenience, with the external-secret note. |
| `autoscaling.*`                                         | `templates/hpa.yaml`                        | Gated HPA with min/max/target CPU; when disabled the Deployment keeps its `replicas`.                 |
| `pdb.enabled` / `.minAvailable`                         | `templates/pdb.yaml`                        | Gated PodDisruptionBudget.                                                                            |
| `serviceDiscovery.enabled`                              | `templates/rbac.yaml` + Deployment          | Gates the Role/RoleBinding granting endpointslice `list`/`watch` (§3.7).                              |
| `terminationGracePeriodSeconds` / `preStopSleepSeconds` | `templates/deployment.yaml`                 | Graceful-shutdown window (§3.8).                                                                      |

## 5. Implementation files

| File                                      | Purpose                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `.dockerignore`                           | Keeps `.git`, `coverage/`, `docs/api/`, `node_modules`, build output out of the root context. |
| `docker/Dockerfile`                       | Parameterized multi-stage image (`ARG APP`, `ARG DENO_VERSION`) for any example.              |
| `docker/Dockerfile.compiled`              | `deno compile` → `gcr.io/distroless/cc-debian12` variant (§3.3, C2).                          |
| `docker/compose.yaml`                     | Local dev stack: app + `redis:7` + collector-contrib mounting the M24c config.                |
| `k8s/chart/Chart.yaml`                    | Chart metadata.                                                                               |
| `k8s/chart/values.yaml`                   | Documented default values (§4.1).                                                             |
| `k8s/chart/templates/_helpers.tpl`        | Name/label helpers so selectors are generated once and cannot drift between objects.          |
| `k8s/chart/templates/deployment.yaml`     | Deployment: probes, resources, graceful shutdown, env projection, SA.                         |
| `k8s/chart/templates/service.yaml`        | Service (the object M50's provider discovers through).                                        |
| `k8s/chart/templates/ingress.yaml`        | Gated Ingress.                                                                                |
| `k8s/chart/templates/configmap.yaml`      | Non-secret config.                                                                            |
| `k8s/chart/templates/secret.yaml`         | Secret env.                                                                                   |
| `k8s/chart/templates/hpa.yaml`            | Gated HPA.                                                                                    |
| `k8s/chart/templates/pdb.yaml`            | Gated PDB.                                                                                    |
| `k8s/chart/templates/serviceaccount.yaml` | ServiceAccount.                                                                               |
| `k8s/chart/templates/rbac.yaml`           | Gated Role + RoleBinding for endpointslices (§3.7, C4).                                       |
| `k8s/render-values.yaml`                  | The values the committed manifests are rendered from (§3.6).                                  |
| `k8s/manifests/*.yaml`                    | Rendered, committed artifacts.                                                                |
| `scripts/check-deploy.ts`                 | The gate (§3.10).                                                                             |
| `docs/deployment.md`                      | Operator guide: images, Compose, Kubernetes, RBAC, graceful shutdown, Workers path.           |

Modified: `deno.json` (add `check:deploy` task), `scripts/script-coverage.ts` (add the new script to
`SCRIPT_TARGETS`), `.github/workflows/ci.yml` (deploy job), `ROADMAP.md` (C1/C2/C3/C6 + progress
row), `ARCHITECTURE.md` (C5), `docs/examples.md` + `apps/README.md` (pointer), `CLAUDE.md` (status),
`packages/service-discovery-plugin/README.md` (C4 pointer).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

No `packages/*/src/` file changes, so the per-package 90% bar is untouched.

**Deviation from the original plan, taken deliberately.** This section first said the new script
would join `scripts/script-coverage.ts`'s `SCRIPT_TARGETS`. Checking that file's actual contents
showed `SCRIPT_TARGETS` is exactly `['scripts/check-docs.ts', 'scripts/generate-api-docs.ts']` — the
two M38 **documentation** scripts — and that `scripts/check-apps.ts`, the closest analogue to this
one, is NOT in it. `check-apps.ts` instead exports its decidable logic (`classifySmokeExitCode`,
`unexpectedSkips`, `malformedAppDirMessage`) and unit-tests it from `test/apps-gate.test.ts` while
the process orchestration stays uncovered. `check-deploy.ts` is mostly orchestration whose branches
are `docker`/`kind`/`helm` invocations that a test may not even spawn (`deno task test` grants
`--allow-run=deno,git`), so adding it would put the file under a bar it cannot clear for reasons
that have nothing to do with test quality. It follows the `check-apps.ts` precedent instead: every
decidable branch is an exported pure function with unit tests, and the I/O orchestration is proven
by running the gate for real.

`deno task test` grants `--allow-run=deno,git` only, so no test may spawn `docker`/`kind`/`helm`.
The split is therefore: pure helpers unit-tested, real tool execution done by the gate.

| Test file                  | src covered               | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/deploy-gate.test.ts` | `scripts/check-deploy.ts` | `renderDrift(rendered: Map<string,string>, committed: Map<string,string>): DriftReport` reports added/removed/changed and is empty for identical input; `parseModes(args: string[]): ModeSet` refuses an unknown flag; `missingTools(present: string[]): string[]` drives the exit-77 skip; `buildMatrix` contains the four of §3.2; `EXCLUDED_EXAMPLES` contains `cloudflare` **with a reason**. |
| `test/deploy-gate.test.ts` | manifests/Dockerfiles     | Structural invariants a slow build would otherwise be the only detector of: both Dockerfiles pin the same `DENO_VERSION`; `docker/Dockerfile` copies the workspace root (`deno.json`) before `packages/` (§3.1); the chart's probe defaults are `/live` and `/ready` (§3.5); the RBAC template names apiGroup `discovery.k8s.io` and verbs `list`+`watch` (§3.7).                                 |
| `test/apps-gate.test.ts`   | (extended)                | `cloudflare` remains excluded from the image matrix, matching how the file already pins `full-stack` out of `ALLOW_SKIP`.                                                                                                                                                                                                                                                                         |

### 6.1 Negative controls (each observed failing, then reverted)

A gate that only exercises the path its author believed worked is not coverage (the M37c lesson).
Each of these will be broken deliberately, observed failing, and restored:

1. Change the liveness probe to `/health/live` → the kind rollout must fail (proves the probe path
   is actually exercised, not just rendered).
2. Drop `COPY deno.json` from the Dockerfile → the build must fail with the P1 error.
3. Edit one committed manifest by hand → `--render` must fail and name that file.
4. Remove the `endpointslices` verb from the Role → the `kubectl auth can-i` check must fail.
5. Point the Service selector at a label no pod carries → the e2e request must fail while
   `kubectl apply` and schema validation both stay green.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m39-docker-kubernetes, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% every src file + the new script
deno task check:deploy      # render drift + image builds + compose
deno task check:deploy --cluster   # real kind apply + serve
deno task check:docs        # the new guide must satisfy the M38 doc gate
```

Publish gates are **not** required: this milestone adds no package and changes no manifest export.
That claim is verified rather than assumed — `git status` at hand-off must show no `packages/*/src`
or `packages/*/deno.json` change.

## 8. Risks & mitigations

- **The kind gate is slow and could become a CI bottleneck.** → Modes are separable; `--cluster` is
  its own CI job running in parallel with the Deno job, and images are loaded with `kind load` from
  the build step rather than pushed to a registry.
- **A base-image Deno bump silently diverges from the lockfile version.** → One `DENO_VERSION`
  constant read by both Dockerfiles, asserted equal in `test/deploy-gate.test.ts`; P2 is the failure
  mode this prevents.
- **`kind load docker-image` on a ~50 MB image may be slow enough to time out the gate.** → Measure
  during implementation; if slow, load only the single image the e2e needs rather than the matrix.
- **The rendered-manifest drift gate could pass vacuously if `helm template` writes nothing.** → The
  helper treats an empty render as drift against a non-empty committed set, and negative control 3
  proves the comparison discriminates.
- **A cloud-specific Ingress annotation would make the chart untestable on kind.** → The chart ships
  no cloud-specific annotations by default; `ingress.annotations` is a pass-through value and the
  kind e2e runs with Ingress disabled, testing through the Service.

## 9. Out of scope

- **Live cloud deployment and a published image registry** — no credentials in CI; M40 owns release
  mechanics.
- **App-side discovery/balancing/watch/ejection** — M50, per the ROADMAP boundary.
- **Consul deployment objects.** The ROADMAP names them under M39's platform side, but M50's Consul
  provider is exercised by its own suite and a Consul StatefulSet would add a second orchestration
  story to a milestone that already spans Docker, Compose, Helm and kind. Deferred and named here so
  it is a decision, not an omission; the Kubernetes EndpointSlice path is the one M39 proves.
- **Making the examples read `$PORT`** — §3.4; would touch 12 apps for no capability gain.
- **A framework-level signal seam.** §3.8 fixes the SIGTERM gap in application code. Teaching
  `packages/runtime` to install a signal handler behind an `IRuntimeServices` member — so every app
  drains without writing the handler itself — is a `common` widening and a real capability addition.
  Named here as a follow-up milestone, with the measured evidence (144 ms, exit 143) recorded in
  §3.8 so the case does not have to be rediscovered.
- **A `full-stack` image.** Its build needs the React Router/Vite step, which is a genuinely
  different image shape; the parameterized Dockerfile supports the others and this one is called out
  as excluded-by-name with a reason rather than quietly skipped.
