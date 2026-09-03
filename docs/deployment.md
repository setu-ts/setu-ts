# Deployment

How to package a Setu-TS application as a container image and run it under Docker Compose or
Kubernetes, plus the Cloudflare Workers path, which is not a container at all.

Everything here is exercised by `deno task check:deploy`, which builds the images for real,
re-renders the Kubernetes manifests from the chart, and — with `--cluster` — applies them to a live
[kind](https://kind.sigs.k8s.io/) cluster and serves a request through them.

## Contents

- [Container images](#container-images)
- [Local development with Compose](#local-development-with-compose)
- [Kubernetes](#kubernetes)
- [Graceful shutdown](#graceful-shutdown)
- [Service discovery and RBAC](#service-discovery-and-rbac)
- [Cloudflare Workers](#cloudflare-workers)
- [The deployment gate](#the-deployment-gate)

## Container images

Two Dockerfiles cover every example, selected with `--build-arg APP=<name>`:

| File                                                          | Base                            | Use it when                                                            |
| ------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| [`docker/Dockerfile`](../docker/Dockerfile)                   | `denoland/deno:alpine`          | The general case. Ships the Deno runtime and the module cache.         |
| [`docker/Dockerfile.compiled`](../docker/Dockerfile.compiled) | `gcr.io/distroless/cc-debian12` | You want no shell, no package manager and no interpreter in the image. |

```bash
# Any example under apps/
docker build -f docker/Dockerfile --build-arg APP=rest-api -t setu/rest-api:m39 .

# The single-binary variant
docker build -f docker/Dockerfile.compiled --build-arg APP=compiled-binary -t setu/compiled:m39 .
```

### The build context must be the repository root

Note the trailing `.` above: the context is the repo root, not the application directory, and this
is a correctness requirement rather than a convention. An example's `deno.json` maps only the
packages it imports **directly** — `@setu-ts/common` reaches `@setu-ts/kernel` through the root
workspace. Build without the root `deno.json` and Deno resolves that specifier against JSR instead
of the local workspace member:

```
error: Could not find version of '@setu-ts/common' that matches specified version constraint '^0.3.0'
```

Building from source also means an image tracks your working tree rather than a published snapshot,
which is what you want during a version bump, when the pinned version is not on JSR yet.

### Pin the base image to your Deno version

Both Dockerfiles read one `ARG DENO_VERSION`. It must be at least the version that wrote your
committed lockfiles — an older base fails with `Unsupported lockfile version '5'`, and a floating
tag makes that failure arrive on an unrelated day.

### Image size

`deno compile` does **not** produce a small image. Measured on the `compiled-binary` example:

| Image                               | Size    |
| ----------------------------------- | ------- |
| `deno compile` → `distroless/cc`    | 44.9 MB |
| `denoland/deno:alpine` + `deno run` | 52.4 MB |

The compiled binary embeds the whole Deno runtime, so the win is modest. Prefer the compiled variant
for its **reduced attack surface** — no shell, no package manager, nothing to exec — not for size.

`scratch` is not an option: the compiled binary is dynamically linked against glibc (`libc.so.6`,
`libgcc_s.so.1`, and four more), so it needs a base that provides it. `distroless/cc-debian12` is
the floor. For the same reason the compile stage uses the **Debian** Deno image, not Alpine — an
Alpine build links against musl and the result will not run on a glibc base.

### Ports are arguments, not `$PORT`

The examples read their port from `Deno.args[0]`, defaulting to 3000, so the image passes it
positionally and Kubernetes overrides the container `args`. There is no `PORT` environment variable.

## Local development with Compose

[`docker/compose.yaml`](../docker/compose.yaml) brings up an example with Redis:

```bash
docker compose -f docker/compose.yaml up --build             # realtime + redis
APP=rest-api docker compose -f docker/compose.yaml up --build # any other example
APP_PORT=13000 docker compose -f docker/compose.yaml up       # if 3000 is taken
```

The OpenTelemetry collector sits behind a **profile**, because the reference configuration
([`docker/otel-collector/collector-config.yaml`](../docker/otel-collector/collector-config.yaml),
owned by the telemetry fan-out guide) requires Datadog, New Relic and Azure credentials and would
crash-loop without them:

```bash
export DD_API_KEY=... NEW_RELIC_LICENSE_KEY=... APPLICATIONINSIGHTS_CONNECTION_STRING=...
docker compose -f docker/compose.yaml --profile telemetry up
```

It runs the **contrib** distribution; the `datadog` and `azuremonitor` exporters are not in the core
collector build. See [the fan-out guide](./telemetry-collector-fanout.md).

## Kubernetes

**Requires Kubernetes 1.30 or newer**, declared as `kubeVersion` in the chart so `helm install`
refuses an older cluster with a clear message rather than failing obscurely. The constraint comes
from `lifecycle.preStop.sleep`, which is beta and enabled by default only from 1.30: a 1.28 API
server rejects the Deployment outright (`unknown field "…lifecycle.preStop.sleep"`), and on 1.29 the
field parses while the action stays inert behind the `PodLifecycleSleepAction` gate — which would
silently remove the drain window. To run on an older cluster, set `preStopSleepSeconds` aside and
replace the `preStop` block with an `exec` sleep (note the distroless image has no shell).

The chart in [`k8s/chart/`](../k8s/chart) is the single authored source. The plain YAML in
[`k8s/manifests/`](../k8s/manifests) is **rendered from it** and committed, so you can read and
apply the objects without installing Helm:

```bash
kubectl create namespace setu
kubectl apply -f k8s/manifests/
```

Or install the chart directly, which is what you want for anything but a quick look:

```bash
helm install setu k8s/chart --namespace setu --create-namespace \
  --set image.repository=my-registry/my-app --set image.tag=1.0.0
```

The two never disagree: `deno task check:deploy --render` re-renders and fails on any difference,
and `deno task deploy:render` regenerates the committed copy.

Both directories are in `deno.json`'s `fmt.exclude`, for different reasons. `k8s/chart/templates` is
not valid YAML before rendering — `{{ }}` and block conditionals — so `deno fmt` cannot parse it at
all. `k8s/manifests` is a **generated artifact** compared byte-for-byte against `helm template`
output; formatting it would put the formatter and the render gate in a fight over the same file,
each undoing the other.

### The manifests pin their namespace

Every rendered object carries `metadata.namespace: setu`. That is deliberate. The RoleBinding below
must name its ServiceAccount's namespace explicitly, so a namespace-agnostic render would produce a
binding that applies cleanly into any namespace and grants permission in exactly one. To target a
different namespace, re-render:

```bash
helm template setu k8s/chart -f k8s/render-values.yaml --namespace my-namespace --output-dir out
```

### What the chart renders

| Object                  | Gated by                      | Notes                                                             |
| ----------------------- | ----------------------------- | ----------------------------------------------------------------- |
| Deployment              | always                        | Probes, graceful shutdown, security context, env projection.      |
| Service                 | always                        | Also the object Kubernetes generates EndpointSlices from.         |
| ServiceAccount          | `serviceAccount.create`       |                                                                   |
| Role + RoleBinding      | `serviceDiscovery.enabled`    | EndpointSlice read access; **off** by default.                    |
| ConfigMap               | `config` non-empty            | Projected with `envFrom`.                                         |
| Secret                  | `secrets` non-empty           | Projected with `envFrom`. Prefer a real secret manager.           |
| Ingress                 | `ingress.enabled`             | Off by default; no cloud-specific annotations shipped.            |
| HorizontalPodAutoscaler | `autoscaling.enabled`         | Needs metrics-server, or it reports `<unknown>` and never scales. |
| PodDisruptionBudget     | `podDisruptionBudget.enabled` | Voluntary disruption only.                                        |

### Probe paths

`livenessProbe` and `readinessProbe` point at **`/live`** and **`/ready`** — the paths
`HealthPlugin` actually registers, alongside `/health`.

`/health/live` and `/health/ready` do **not** exist. They 404, and a 404 liveness probe makes the
kubelet restart a perfectly healthy pod forever. If you change `probes.live`/`probes.ready`, change
them to something your application serves.

This also means the application must register `HealthPlugin` at all. `apps/minimal` does not — it
imports only the kernel and runtime and serves a single `/` route — so a Deployment of it never
passes readiness. The committed manifests reference `apps/rest-api`, which reaches HealthPlugin
through `rest-starter`.

### What the probes measure

The three endpoints aggregate the registered indicators differently:

| Endpoint  | `200` when                  | `503` when                                                   |
| --------- | --------------------------- | ------------------------------------------------------------ |
| `/live`   | the process responds at all | (never — liveness is always `200` while the process answers) |
| `/ready`  | **every** indicator is `up` | any indicator is `down` **or `degraded`**                    |
| `/health` | no indicator is `down`      | any indicator is `down`                                      |

A `degraded` replica is therefore **withdrawn from its Service** by `/ready` while still answering
`/health` with `200` — it is impaired, not dead. Since M70c the gRPC health bridge agrees: a
`degraded` process reports `NOT_SERVING` on `grpc.health.v1.Health/Check` rather than `SERVING`, so
gRPC load balancers stop routing to it at the same moment Kubernetes does (before M70c the two faces
disagreed — X7-8).

Since M70c the plugin indicators for `messaging`, `realtime-backplane`, `storage`, `mail`, `queue`,
and `service-discovery` report **reachability** as well as lifecycle — a backend that is configured
but unreachable is `down` (or `degraded` for the backplane, whose local delivery still works), not
`up`. The full classification of every indicator in the framework is in
[health-indicators.md](health-indicators.md).

### Security context

The chart sets `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, drops all capabilities, and
requires a **numeric** `runAsUser`. Numeric is not optional: with `runAsNonRoot`, Kubernetes refuses
an image whose user is a name, because it cannot verify a name is not root —

```
container has runAsNonRoot and image has non-numeric user (deno), cannot verify user is non-root
```

— and Docker resolves the name happily, so this fails **only** under Kubernetes. Match the value to
your image:

| Image                        | `podSecurityContext.runAsUser` |
| ---------------------------- | ------------------------------ |
| `docker/Dockerfile`          | `1000` (the `deno` user)       |
| `docker/Dockerfile.compiled` | `65532` (distroless `nonroot`) |

Because the root filesystem is read-only, `/tmp` is mounted as an `emptyDir`. Do **not** add an
`emptyDir` at `/deno-dir`: the image caches its entire module graph there at build time, and
mounting an empty volume over it masks the cache, so the container tries to re-resolve from jsr.io
and npm at startup and dies with `JSR package manifest for '@hono/hono' failed to load` — fatal in
an air-gapped cluster.

## Graceful shutdown

**A project scaffolded by `setu new` now installs one for you**; anything older, and any entry you
wrote yourself, needs the handler below.

Deno's default action for `SIGTERM` ends the process immediately: measured in a container,
`docker stop` returned in 144 ms with exit code 143, meaning `app.stop()` never ran. In that state
`terminationGracePeriodSeconds` is decorative, in-flight requests are cut, and every
`onStopping`/`onShutdown` hook — service-discovery deregistration, database and broker disconnects —
is skipped. A generated project reproduced that exactly until the CLI began emitting the listener.

The framework itself still does not install it: a library that grabs process signals has a side
effect at import time, and the API is runtime-specific — the CLI emits `Deno.addSignalListener` or
`process.on` depending on the target, and nothing at all for Cloudflare Workers, which has no
process to signal.

This is what a generated `main.ts` carries, and what to add to an entry you wrote:

```typescript
const app = createApp();
await app.start({ port });

if (Deno.build.os !== 'windows') {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    Deno.addSignalListener(signal, () => {
      // A rejecting onShutdown hook makes stop() reject; without .catch the process dies with
      // an unhandled rejection instead of reporting why.
      void app.stop()
        .then(() => Deno.exit(0))
        .catch((error: unknown) => {
          console.error('Graceful shutdown failed:', error);
          Deno.exit(1);
        });
    });
  }
}
```

With the handler in place the same container exits **0** rather than 143. Every example the
deployment gate builds carries it.

### How the pieces line up

1. The pod is removed from the Service's endpoints, and `preStop` starts.
2. `preStopSleepSeconds` (default 5) elapses. This covers the delay before every node's kube-proxy
   notices — without it, traffic still arrives at a pod that is shutting down.
3. `SIGTERM` is delivered; your handler calls `app.stop()`.
4. `stop()` runs `onStopping` hooks **before** closing the socket, so a service deregisters while it
   can still be reached, then drains, then runs `onShutdown`.
5. If the process has not exited after `terminationGracePeriodSeconds` (default 30), it is killed.

Keep `preStopSleepSeconds` comfortably below `terminationGracePeriodSeconds`.

## Service discovery and RBAC

`ServiceDiscoveryPlugin({ provider: 'kubernetes' })` reads EndpointSlices from the API server and
authenticates with the pod's projected ServiceAccount token. It therefore needs RBAC that nothing in
the framework can grant itself. Set `serviceDiscovery.enabled=true` and the chart renders:

```yaml
rules:
  - apiGroups: ['discovery.k8s.io']
    resources: ['endpointslices']
    verbs: ['get', 'list', 'watch']
```

Those verbs are what the provider actually issues: it LISTs
`/apis/discovery.k8s.io/v1/namespaces/{ns}/endpointslices` and re-LISTs on every watch event. The
Role is namespace-scoped because the provider takes a single `namespace` option and never reads
across namespaces.

The gate verifies this with `kubectl auth can-i` rather than by reading the YAML, because a wrong
apiGroup or a missing verb renders and applies perfectly cleanly and only fails at runtime.

It is **off by default**: an application that does not use the provider should not carry cluster
read permission. Leave it off and the Deployment also sets `automountServiceAccountToken: false`.

RBAC alone is not enough: the API server presents a cluster-internal CA that `fetch` rejects, and no
code change fixes that from inside the process. Point the runtime at the CA bundle Kubernetes mounts
into every pod at the fixed service-account path:

- Deno: `DENO_CERT=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`
- Node: `NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`

A reader who gets the RBAC above right but omits the CA still fails — on a TLS error rather than a
`403`, which is easy to misread as a permissions problem. The `http` option is the alternative:
supply your own `IDiscoveryHttp` over a TLS-configured client. The full in-cluster setup, including
token rotation, is documented in the
[service-discovery plugin](../packages/service-discovery-plugin/README.md#kubernetes-in-cluster-tls).

> **Scope.** These are the platform objects. Resolving a name to instances, load-balancing across
> them, watching for changes and ejecting outliers are the plugin's job, documented with the service
> discovery plugin.

## Deploying a project the CLI scaffolded

Everything above is about **this repository's** images and objects, which build the examples under
[`apps/`](../apps/). A workspace created with `setu new --workspace` gets its own, generated and
regenerated for every member:

| Path                  | What it is                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `docker/Dockerfile`   | One parameterized image: `docker build -f docker/Dockerfile --build-arg MEMBER=orders -t orders:dev .` |
| `docker/compose.yaml` | Every member plus the transport's broker, each member on its allocated port                            |
| `k8s/members.yaml`    | A Deployment and a Service per member                                                                  |

```bash
docker compose -f docker/compose.yaml up --build
NAMESPACE=acme WORKSPACE=acme envsubst < k8s/members.yaml | kubectl apply -f -
```

They carry the findings on this page rather than repeating the mistakes: the build context is the
workspace root, the base image tag is pinned, the user is numeric, permissions are explicit, and the
grace period is real because the generated entry handles `SIGTERM`.

### Sibling addresses come from the environment

A member's generated discovery map reads each sibling's host from `<MEMBER>_HOST` and falls back to
`127.0.0.1`. Inside a container loopback is the container **itself**, so a fixed address would have
every service dial itself on its sibling's port. The generated Compose stack and Kubernetes objects
set those variables to the service names; a deployment you write by hand must do the same, or use a
real discovery provider (`consul`, `kubernetes`, `dns`) instead of the static map.

The same applies to the broker: every transport with a connection value reads it from a variable
(`REDIS_URL`, `KAFKA_BROKERS`, `PUBSUB_PROJECT_ID`, `SERVICE_BUS_CONNECTION_STRING`) with the local
address as the fallback.

### What is deliberately not generated

- **An Ingress.** Which controller, host and TLS issuer are cluster decisions; a guessed Ingress
  applies cleanly and routes nothing.
- **The broker, in Kubernetes.** For a cluster that is a managed service or a StatefulSet with
  storage, not the single dev container Compose runs.
- **HTTP probes.** The generated probes are `tcpSocket`, because `/live` and `/ready` exist only
  when the member registers `HealthPlugin`. Switch them once it does — it is the better signal,
  since it waits for the plugins rather than for the socket.

## Cloudflare Workers

A Worker is not a container. It has no `listen()`, so there is no image to build; it deploys with
Wrangler:

```bash
cd apps/cloudflare
npx wrangler deploy
```

Bindings (KV, R2, D1, Queues, Durable Objects) are declared in `wrangler.toml` and reach the
application through `CloudflarePlugin`. Nothing on this page — probes, graceful shutdown, RBAC, HPA
— applies; the platform handles all of it.

## The deployment gate

```bash
deno task check:deploy              # render drift + image builds + compose model
deno task check:deploy --render     # just the manifest/chart drift check
deno task check:deploy --cluster    # real kind cluster: apply, roll out, serve, check RBAC
deno task deploy:render             # regenerate k8s/manifests/ from the chart
```

`--cluster` creates a kind cluster, loads the locally built image, applies the **committed**
manifests, waits for the rollout (which only completes if the readiness probe passes), serves a
request through the Service, and asserts the ServiceAccount can list and watch EndpointSlices. Set
`KEEP_CLUSTER=1` to keep the cluster for debugging.

When the required tooling is absent the gate exits **77**, the same "reported a skip" code the apps
gate uses, so a missing prerequisite can never be mistaken for a pass.

Each check is known to discriminate — every one of these was broken deliberately and observed
failing:

| Break                                         | What fails                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Probe path → `/health/live`                   | Rollout never completes; ready replicas stay 0.                                       |
| Remove `COPY deno.json` from the Dockerfile   | Build fails resolving `@setu-ts/common`.                                              |
| Hand-edit a committed manifest                | `--render` fails and names the file.                                                  |
| Drop `watch` from the discovery Role          | `kubectl auth can-i watch` answers `no`.                                              |
| Point the Service selector at a missing label | Endpoints go empty and the request is refused — while `kubectl apply` still succeeds. |
