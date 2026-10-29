# Deployment

How to package a Setu-TS application as a container image and run it under Docker Compose or
Kubernetes, plus the Cloudflare Workers path, which is not a container at all.

Everything here is exercised by `pnpm run check:deploy`, which builds the images for real,
re-renders the Kubernetes manifests from the chart, and — with `--cluster` — applies them to a live
[kind](https://kind.sigs.k8s.io/) cluster and serves a request through them.

## Contents

- [Container images](#container-images)
- [Local development with Compose](#local-development-with-compose)
- [Kubernetes](#kubernetes)
- [Graceful shutdown](#graceful-shutdown)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [Service discovery and RBAC](#service-discovery-and-rbac)
- [Cloudflare Workers](#cloudflare-workers)
- [The deployment gate](#the-deployment-gate)

## Behind a reverse proxy

Node, Deno and Bun report the socket peer in `IRequest.ip`. Behind a proxy this is the proxy; read
`ctx.state.get(CLIENT_IP_STATE_KEY)` for the resolved client. Mapped IPv4 peers are normalized
(`::ffff:10.1.2.3` becomes `10.1.2.3`). Register IP security at its default priority 120:

```typescript
app.register(HttpSecurityPlugin({
  ipSecurity: { trustProxy: true, trustedProxies: ['10.0.0.0/8'] },
  csrf: {},
}));
app.register(SessionPlugin({ secret, cookie: { secure: 'auto' } }));
```

List only your actual proxies. With `trustedProxies`, the walk starts at the peer: an unlisted
direct caller's forged headers cannot choose its client IP or public origin. The header-only path is
retained when no peer is available. IPv4 CIDR is supported; list native IPv6 proxies literally.
`proxyHops` and the leftmost default retain header-only selection and never check the peer; use
`trustedProxies` when proxy addresses are stable; only `trustedProxies` mode with a trusted socket
peer publishes a forwarded origin. Configure the proxy to overwrite `X-Forwarded-Proto` and
`X-Forwarded-Host` rather than pass a client's copy through, and restrict direct access to the
application where possible.

The default `forwardedHeader: 'x-forwarded'` uses `X-Forwarded-For`, the leftmost
`X-Forwarded-Proto`, and the leftmost `X-Forwarded-Host`. Choose `forwardedHeader: 'forwarded'` when
your proxy writes RFC 7239 `Forwarded`; this reads only that family and conflicts with `ipHeader`.
Its `proto` and `host` come from the selected client's element. A malformed element is a boundary,
not a void: the elements to its right were written by later hops and are still read, while the walk
stops at the boundary and never continues left of it. An oversized field (over 8 KiB or 64 elements)
is read from the right within those bounds instead of voiding the field, so a trusted proxy that
appends its element still resolves the client behind a padded or malformed prefix. A trusted proxy
that writes a comma inside a quoted value to the right of malformed input loses that element to the
boundary and resolves no client (fail closed). A direct client keeps its own address, and a boundary
with only trusted entries to its right yields no client rather than the proxy's own address. Unknown
and obfuscated hops cannot be returned as clients, and a `proxyHops` header too short for the chain,
or a chain of only trusted proxies, yields no client in either family; with `trustedProxies`, so
does a trusted proxy that sends no forwarding header. Only `http`/`https` protocols, and DNS-name or
bracketed-IPv6 hosts with an optional numeric port, are accepted; missing or rejected components use
the request URL.

IP security publishes one public origin, believed only when a trusted socket peer was walked and the
client came from the forwarded chain. `requestOriginOf(ctx)` and `publicRequestUrl(ctx)` from
`@setu-ts/common` expose it. Session `secure: 'auto'` sets `Secure` for that origin's HTTPS
protocol, including deletion; the default remains `true`. `'auto'` with `sameSite: 'none'` is
refused at construction because `SameSite=None` forces `Secure`. The React Router bridge passes the
public URL to loaders and actions. Without IP security these consumers use `ctx.request.url` — and
behind a TLS-terminating proxy that makes **every React Router action answer 400**, because React
Router's own origin check compares the browser's `https` origin with the internal `http` URL
(V10-41). A `setu new --template full-stack` project reads `TRUSTED_PROXIES` (a comma-separated CIDR
list of your proxies) and registers IP security from it; empty leaves it off. Set it to your proxies
only — IPv4 addresses or CIDRs, IPv6 proxies as single addresses (an IPv6 CIDR is compared literally
and matches nothing). Never `0.0.0.0/0`: it trusts every IPv4 client's forwarded headers, so any
client could choose its own address and origin.

`csrf: {}` implicitly trusts the URL origin, that published public origin, and, when the browser
sends `Sec-Fetch-Site: same-origin`, the validated leftmost `X-Forwarded-Proto`/`X-Forwarded-Host`
candidate (URL host when absent). The gate matters because scripts can set `X-Forwarded-*` on a CORS
request the server admits, and cannot set `Sec-Fetch-Site`. It grants no proxy trust to other
consumers. A request whose `Sec-Fetch-Site` is present and anything but `same-origin` is checked
against the URL origin and `trustedOrigins` only: a browser cannot send the target's real public
origin cross-site, and a trusted proxy that passes a client's `X-Forwarded-Host` through would
otherwise publish a host the attacker then matches. Cross-site origins still fail; `trustedOrigins`
adds explicit application origins.

Cloudflare Workers and plain `adapter.fetch()` calls have no socket peer. On Workers use
`ipSecurity: { trustProxy: true, ipHeader: 'CF-Connecting-IP' }`; Cloudflare overwrites that header.
That header vouches for the client address only; the public origin comes from the request URL. Build
security-sensitive links, including password resets, from a configured base URL, rather than a
request-derived host.

## Container images

Two Dockerfiles cover every example, selected with `--build-arg APP=<name>`:

| File                                                          | Base                            | Use it when                                                            |
| ------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| [`docker/Dockerfile`](../docker/Dockerfile)                   | `node:24-alpine`                | The general case. Ships Node and the app's production dependencies.    |
| [`docker/Dockerfile.compiled`](../docker/Dockerfile.compiled) | `gcr.io/distroless/cc-debian12` | You want no shell, no package manager and no interpreter in the image. |

```bash
# Any example under apps/
docker build -f docker/Dockerfile --build-arg APP=rest-api -t setu/rest-api:m39 .

# The single-binary variant
docker build -f docker/Dockerfile.compiled --build-arg APP=compiled-binary -t setu/compiled:m39 .
```

### The build context must be the repository root

Note the trailing `.` above: the context is the repo root, not the application directory, and this
is a correctness requirement rather than a convention. An example is a member of the pnpm workspace:
it depends on `@setu-ts/*` as `workspace:^`, and only the root `pnpm-workspace.yaml` and
`pnpm-lock.yaml` let `pnpm install --frozen-lockfile --filter <app>...` link those members. The
build stage compiles the members the app needs with `tsc -b`, and `pnpm deploy --prod` copies the
app with each workspace dependency's packed `dist/`, so the runtime stage runs the built framework
rather than its source.

Building from source also means an image tracks your working tree rather than a published snapshot,
which is what you want during a version bump, when the pinned version is not on npm yet.

### Dotenv files never reach an image

The generated workspace `.dockerignore` excludes `**/.env` and `**/.env.*` and keeps
`!**/.env.example`; the root `.gitignore` ignores `.env`/`.env.*` and keeps the example. The rules
cover the default `.env` and any name beginning `.env.`. A custom `--env-file name` that does not
match those patterns is **not** covered. `setu generate app` and `setu adopt` print one line naming
such a file by its path from the workspace root (for example `apps/billing/local.env`), which is the
form to add to `.dockerignore`: that file sits at the workspace root, and a pattern without a slash
matches only there. The CLI cannot edit a file you own for you.

`setu adopt` moves a configured single-segment dotenv pair into the member, where the member's
`envFilePath` reads it, and writes `apps/<member>/.gitignore` with `/<name>` for the moved dotenv
file (never its `.example`, which stays committed). The member rule matters because a root rule such
as `/.env` is anchored to the repository root and would stop matching after the move; a nested
`.gitignore` is anchored to its own directory, so the secret stays ignored. When the moved name is
not covered by the generic rules, adopt prints the same `.dockerignore` note. A multi-segment
`envFilePath` is left at the root with the step printed: move it by hand and add an ignore rule
beside it, because a pattern containing a slash is anchored to its directory and the root rule would
stop matching after the move.

### Pin the base image and pnpm

Both Dockerfiles use a `node:24` base and install the same pnpm version the root `package.json` pins
in `packageManager`. A floating tag makes a runtime upgrade arrive on an unrelated day.

### Image size

The compiled variant is a Node
[single executable application](https://nodejs.org/api/single-executable-applications.html) (SEA):
the app is bundled with esbuild and injected into a copy of the `node` binary. It does **not**
produce a small image. Measured with `docker images`:

| Image                                          | Size   |
| ---------------------------------------------- | ------ |
| Node SEA → `distroless/cc` (`compiled-binary`) | 211 MB |
| `node:24-alpine` + `tsx` (`minimal`)           | 268 MB |
| `node:24-alpine` + `tsx` (`rest-api`)          | 289 MB |

The SEA embeds the whole Node runtime, so the win over the alpine image is modest, and it is about
4.7× the 44.9 MB the Deno-compiled image measured before the move to Node. Prefer the compiled
variant for its **reduced attack surface** — no shell, no package manager, nothing to exec — not for
size.

Because the binary embeds the Node it was built with, a Node security release reaches it only
through a rebuild: build again with `--pull` after every Node patch, or the deployed binary keeps
every flaw that release fixed.

`scratch` is not an option: the binary is dynamically linked against glibc (`libc`, `libstdc++`,
`libgcc_s` and three more), so it needs a base that provides them. `distroless/cc-debian12` is the
floor. For the same reason the SEA is built on the **Debian** Node image, not Alpine — an Alpine
builder copies a musl `node` binary, which will not run on a glibc base.

### Ports are arguments, not `$PORT`

The examples read their port from `process.argv[2]`, defaulting to 3000, so the image passes it
positionally and Kubernetes overrides the container `args`. The image's `ENTRYPOINT` is
`node --import tsx` and its `CMD` is `main.ts 3000`, so the chart's `args` repeat the script name
before the port. There is no `PORT` environment variable.

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

The two never disagree: `pnpm run check:deploy --render` re-renders and fails on any difference, and
`pnpm run deploy:render` regenerates the committed copy.

Both directories are in `.prettierignore`, for different reasons. `k8s/chart/templates` is not valid
YAML before rendering — `{{ }}` and block conditionals — so a formatter cannot parse it at all.
`k8s/manifests` is a **generated artifact** compared byte-for-byte against `helm template` output;
formatting it would put the formatter and the render gate in a fight over the same file, each
undoing the other.

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

Probe HTTP bodies default to status-only checks:
`{ status, timestamp, checks: { name: { status } } }`. They omit runtime version, hostname,
indicator data, and latency. Dashboards needing full data set `HealthPlugin({ details: true })` (a
starter uses `health: { details: true }`) and should protect those detailed endpoints. Programmatic
reports retain full data; probe HTTP status rules stay the same.

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
but unreachable is `down`, not `up` — except the backplane, which stays `up` with
`data.reachable: false` because local delivery still works. The full classification of every
indicator in the framework is in [health-indicators.md](health-indicators.md).

### Nothing in the request pipeline may refuse a probe

A probe reaches the process through the **same middleware pipeline** as ordinary traffic, so any
global middleware that can short-circuit can fail a probe — and a failed liveness probe is a
container restart, not a dropped request. The consequence is asymmetric: an overloaded replica that
answers `/live` keeps serving, while one that refuses it is killed and restarted straight back into
the same load.

Two first-party middlewares therefore exempt the operational paths **by default**, and both defaults
are the same six — `/live`, `/ready`, `/health`, `/metrics`, `/openapi.json`, `/docs`:

| Middleware                                  | Option    | Why it would otherwise refuse a probe                                                                                            |
| ------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `rateLimitMiddleware` (`auth-plugin`)       | `exclude` | An exhausted bucket answers `429` — including to the kubelet, which restarts a container whose only fault is load (M90a, X32-1). |
| `tenantMiddleware` (`multi-tenancy-plugin`) | `exclude` | With `required: true` a probe carries no tenant header, so the replica never becomes ready (M70b, X4-2).                         |

A caller-supplied list **replaces** those defaults rather than extending them, so spread the
exported constant to keep them:

```typescript
import { DEFAULT_RATE_LIMIT_EXCLUDED_PATHS, rateLimitMiddleware } from '@setu-ts/auth-plugin';

app.middleware.add(
  rateLimitMiddleware({
    windowMs: 60_000,
    max: 100,
    exclude: [...DEFAULT_RATE_LIMIT_EXCLUDED_PATHS, /^\/internal\//],
  }),
);
```

If you move the probes (`HealthPlugin({ endpoints })`) or add your own operational routes, add the
new paths to every exclusion list that governs them — and to the `livenessProbe`/`readinessProbe`
paths in the manifest, which must agree. Any other global middleware that can short-circuit — an IP
allowlist, a CSRF check, an auth guard added at the pipeline level — needs the same exemption; only
these two carry it by default.

### Security context

The chart sets `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, drops all capabilities, and
requires a **numeric** `runAsUser`. Numeric is not optional: with `runAsNonRoot`, Kubernetes refuses
an image whose user is a name, because it cannot verify a name is not root —

```
container has runAsNonRoot and image has non-numeric user (node), cannot verify user is non-root
```

— and Docker resolves the name happily, so this fails **only** under Kubernetes. Match the value to
your image:

| Image                        | `podSecurityContext.runAsUser` |
| ---------------------------- | ------------------------------ |
| `docker/Dockerfile`          | `1000` (the `node` user)       |
| `docker/Dockerfile.compiled` | `65532` (distroless `nonroot`) |

Because the root filesystem is read-only, `/tmp` is mounted as an `emptyDir`. Do **not** mount a
volume over `/srv`: the image holds the app and its installed dependencies there, and an empty
volume would hide them, so the container could not start.

## Graceful shutdown

**A project scaffolded by `setu new` now installs one for you**; anything older, and any entry you
wrote yourself, needs the handler below.

The default action for `SIGTERM` ends the process immediately: measured in a container,
`docker stop` returned in 144 ms with exit code 143, meaning `app.stop()` never ran. In that state
`terminationGracePeriodSeconds` is decorative, in-flight requests are cut, and every
`onStopping`/`onShutdown` hook — service-discovery deregistration, database and broker disconnects —
is skipped. A generated project reproduced that exactly until the CLI began emitting the listener.

The framework itself still does not install it: a library that grabs process signals has a side
effect at import time. The handler goes through `IRuntimeServices.onSignal`, which is absent where
no signal can be caught (Windows, Cloudflare Workers), so the same block runs on Node, Deno and Bun.

This is what a generated `main.ts` carries, and what to add to an entry you wrote:

```typescript
const runtime = createRuntimeServices();
const app = createApp();
await app.start({ port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  runtime.onSignal?.(signal, () => {
    // A rejecting onShutdown hook makes stop() reject; without .catch the process dies with
    // an unhandled rejection instead of reporting why.
    void app
      .stop()
      .then(() => runtime.exit(0))
      .catch((error: unknown) => {
        console.error('Graceful shutdown failed:', error);
        runtime.exit(1);
      });
  });
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
workspace root, the base image tag is pinned, the user is numeric, the grace period is real because
the generated entry handles `SIGTERM`, and the start writes no lockfile — so the generated
manifest's own read-only root filesystem cannot crash it.

### Build, test and deploy from the root

Since 0.11.0 the CLI runs these across every member, reading `setu.workspace.json` each time:

```bash
npm test                                    # every member's tests (Deno: deno task --recursive test)
setu workspace build                        # one image per member, tagged with the commit
setu workspace deploy --dry-run             # every check and the plan; nothing changes
setu workspace deploy                       # build, ship, apply k8s/, wait for each rollout
```

`deploy` loads the images into a `kind-<cluster>` context's cluster, or pushes them to `--registry`
for any other context. It applies the namespace (`--namespace`, default the workspace directory
name), one Secret per member, and `k8s/members.yaml` as it is on disk with the namespace and each
member's image filled in, then waits for `kubectl rollout status` (`--timeout`, default `120s`).

**Member secrets.** A member's variables are the names its committed `.env.example` declares — a
full-stack member's `SESSION_SECRET` and `TRUSTED_PROXIES`, for instance — less those the generated
manifest already sets. Their values go in `k8s/secrets/<member>/.env`, which the root's `.env`
ignore rule and the generated `.dockerignore` keep out of git and out of every image. Deploy refuses
before building, naming every missing variable, and refuses a values file git tracks. It applies
each Secret with `kubectl apply --server-side --force-conflicts` from stdin (it owns `<member>-env`,
including one first made by hand), values base64-encoded under `data:`: measured on kind, a
client-side apply stores every value in plaintext in the `last-applied-configuration` annotation,
and `stringData` under a server-side apply keeps keys the file has dropped. Each generated
Deployment reads `<member>-env` through `envFrom`, after its explicit `env:` entries, which keep
precedence. envFrom is read when a container starts, so deploy writes each Secret's
`resourceVersion` into its member's pod-template annotation (`setu-ts.dev/secret-version`): a
changed Secret changes the template and Kubernetes rolls the member out — a rotation on a clean tree
keeps the tag and the manifest and would otherwise leave the old value live, and the annotation
keeps a re-run after a partial failure from losing the rollout. After the apply, deploy reads each
member's pod template back from the cluster and sets the annotation with `kubectl patch` wherever it
is not current — a `members.yaml` from before the annotation, a hand-edited one, or an earlier
deploy that failed part-way — so the cluster's state, not the run's history, decides what rolls out.
Deploy reads the values files, `.env.example` and `k8s/members.yaml` only as regular files inside
the workspace, never through a symbolic link: a branch that replaced `k8s/secrets/<member>` with a
link could otherwise load any dotenv file on the host into a pod its code runs in.

For production, keep the values in a secret manager —
[Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets) or
[External Secrets](https://external-secrets.io/) — and have it create the same `<member>-env`
Secret; the Deployments read it unchanged. The generated Compose stack reads each member's own
`.env` through an optional `env_file`, so local values apply there too; the optional form
(`required: false`) needs Docker Compose 2.24.0 or later. Compose follows a symbolic link there, so
`setu check` refuses a linked member `.env`; it does not check `docker/compose.yaml` itself, which a
branch can edit to name any host file — review a branch's `docker/` changes before running
`docker compose up` on it.

A registry other than npm pins its tarball URLs in the lockfile: pass
`--build-arg NPM_CONFIG_REGISTRY=<url>` (and `--network host` for one on `localhost`), with its
token in the `NPMRC` build secret rather than in a build argument.

### The default Node workspace image

`build` type-checks DI tokens; graph validation happens at boot, so run `npm test` before building
an image.

Generated Node services use a build stage with `npm ci` and `npm run build`; the latter type-checks
and runs the wiring gate before bundling. The runtime stage installs only production dependencies
and copies dist/ and the full-stack frontend build/. A standalone project has a root Dockerfile:

```sh
npm run build
npm start
docker build -t my-service .
```

Workspace builds use `docker build -f docker/Dockerfile --build-arg MEMBER=orders -t orders .`.
Shared libraries are bundled, their production dependencies stay external and are installed with the
member. A runtime import of a devDependency fails the build. `start:dev` and `start:debug` run
source; production start never rebuilds. Full-stack main.ts passes its compiled server module to
createApp so its location survives bundling. User import.meta.url paths move with the bundle:
resolve application data from process.cwd() or pass modules in explicitly.

Bun runs source with production dependencies, builds a declared frontend script first, and copies
the workspace's hoisted-linker bunfig.toml. Deno builds a declared frontend in a `frontend` stage on
`denoland/deno:debian-2.9.5` (Vite's native bundler binding has no musl build, so it cannot run on
the Alpine image), copies only `build/` into the Alpine image before caching main.ts, then retains
the frozen, scoped source run. When the root sets `nodeModulesDir: "auto"` (a workspace with a
full-stack member does), the image switches it to `"manual"` after installing: under `"auto"` every
start re-syncs `node_modules`, which a read-only root refuses. A full-stack socket server serves its
own client bundle from `build/client/assets`. Native bun build and deno compile are optional custom
packaging choices, not generated commands. Workers continues using Wrangler.

Both standalone and workspace ignore files exclude host node_modules, dist, build, coverage, git and
dotenv files, preserving .env.example, and every `.npmrc`. To use one in the image's install — a
private registry's token, or a setting such as `legacy-peer-deps` — pass it as a build secret. Every
generated install step (Node and Bun `npm ci` / `bun install`, Deno's frontend build and install)
already mounts the optional secret `npmrc` at `/root/.npmrc`, as npm's own Docker guide does:
`docker build --secret id=npmrc,src=.npmrc …`, or through the generated Compose file,
`NPMRC="$(cat .npmrc)" docker compose -f docker/compose.yaml up --build`. In CI, set `NPMRC` from
the CI's secret store rather than expanding it on a traced command line (`set -x` would print it).
The secret exists only for that step, so it never reaches a layer, the history or the cache; without
one the install runs as before. The mount needs BuildKit, Docker's default builder; the deprecated
legacy builder (`DOCKER_BUILDKIT=0`) refuses it, and Podman/Buildah document the same `--secret`
form. A Bun `bunfig.toml` is copied into the image, so it must name tokens through environment
variables. Images run as numeric UID 1000. The generated-deploy gate exercises the Deno workspace
(with a library under a root `nodeModulesDir: "auto"`), the Node workspace/library and standalone
images, and a Bun workspace member importing a library, read-only with no external network.
Full-stack images and the standalone Deno image have rendered shapes unit-tested; the gate does not
build them.

The generated workspace Dockerfile uses node:24-alpine, selects a member with ARG MEMBER and starts
with node --enable-source-maps dist/main.js from /srv/apps/${MEMBER}. Build with the workspace root
as context; the member directory alone omits shared libraries and root metadata.

### The Deno image is the member's only dependency source at runtime

The generated Deno image first removes the development-only diagnostics-plugin pin from the member
and root import maps. It accepts comments and trailing commas in `deno.json` or `deno.jsonc`, and a
member may inherit imports from the root. This changes only the copies inside the image. The parser
is pinned to an exact `@std/jsonc` version and runs through `deno run --no-config --no-lock` with
read and write granted only to the member's and the root's `deno.json`/`deno.jsonc`, in a temporary
build cache removed in the same layer: it cannot float to a newer release, touch any other file in
the image, alter the project lockfile, or add parser modules to the production cache.

The build then runs
`deno cache main.ts && deno install && deno install --frozen && deno install --entrypoint main.ts && deno install --entrypoint main.ts --frozen`.
The full-map install/frozen pair completes and verifies lazy broker npm edges; the entrypoint checks
verify the production entry too. The remaining import map is cached, including dependencies not
reachable from `main.ts`. The verified exclusion is the development connector.

Deno can record a jsr package's npm edge list incompletely on a cold cache. An entrypoint-only
frozen install can pass while lazy `amqplib`/`ioredis` imports later fail at startup. Retaining the
full-map pair after removing the development pin prevents that failure. Runtime uses `--frozen` and
the lockfile completed during the image build without modifying it.

Refusing to write is also what closes the original read-only-root failure, where the first lazy
driver registration attempted to add an edge to `deno.lock`:

```
error: Failed writing lockfile
Caused by:
    Read-only file system (os error 30) (for '/srv/deno.lock')
```

`--no-lock` is not the remedy: it ignores the lockfile the build used and can choose a later npm
transitive version that the image did not cache when a lazy driver loads. That forces an npm fetch
at startup and fails in an air-gapped deployment. The same `deno install --frozen` is a useful
diagnostic outside a build, on any checkout whose lockfile may be stale: it exits non-zero instead
of changing it.

For an existing generated workspace, regenerate the managed Dockerfile and `.dockerignore` with
`setu devtool enable <member>` or `setu workspace ports --reallocate`, then rebuild the image. New
member generation also refreshes these files. For a Dockerfile maintained by hand, keep the
following two build steps after `WORKDIR /srv/apps/${MEMBER}` (the generated image uses UID 1000):

```dockerfile
RUN printf '%s' 'import { parse } from "jsr:@std/jsonc@1.0.3"; for (const directory of [".", "/srv"]) { for (const name of ["deno.json", "deno.jsonc"]) { const path = directory + "/" + name; let source; try { source = Deno.readTextFileSync(path); } catch (error) { if (error instanceof Deno.errors.NotFound) continue; throw error; } const manifest = parse(source); if (manifest.imports) delete manifest.imports["@setu-ts/diagnostics-plugin"]; Deno.writeTextFileSync(path, JSON.stringify(manifest)); break; } }' | DENO_DIR=/srv/.setu-build-cache deno run --no-config --no-lock --no-prompt --allow-read=./deno.json,./deno.jsonc,/srv/deno.json,/srv/deno.jsonc --allow-write=./deno.json,./deno.jsonc,/srv/deno.json,/srv/deno.jsonc - && rm -rf /srv/.setu-build-cache
RUN deno cache main.ts && deno install && deno install --frozen && deno install --entrypoint main.ts && deno install --entrypoint main.ts --frozen && chown -R 1000:1000 /srv /deno-dir
```

Add `apps/*/main.dev.ts` to `.dockerignore` and keep `--frozen` on the start command.

Do not mount a volume over the image's `DENO_DIR` (the generated Deployment mounts only `/tmp` for
exactly this reason): measured, a cold cache fails identically with and without network egress,
because fetched packages have nowhere to persist under a read-only root. The cache baked into the
image IS the dependency source. The `--generated` gate installs a scaffold before building it, then
starts a real Redis-backed member under `--read-only` in a network-none namespace shared only with
its loopback broker. It proves both that a lazy driver uses the shipped lockfile and that the member
serves without external network access.

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

### A standalone project

The default standalone `setu new` emits no Dockerfile, Compose file or Kubernetes manifest. A
standalone template with `--broker` or `--queue` can additionally emit `docker/compose.yaml` for the
selected backing services; that does not supply an application image or Kubernetes manifest. Use
`setu new --workspace` for generated deployment artifacts, or `setu adopt` to bring an existing
project into a workspace. For an independently maintained image, use this repository's
[`docker/Dockerfile`](../docker/Dockerfile) pattern as a starting point and adapt its entrypoint and
dependency installation to your runtime.

## Backup and restore

Back up the database state your composition actually uses: application tables, the migration ledger,
and configured outbox, inbox, tier-C idempotency and audit tables. These stores are described in
[database migrations](../packages/database-plugin/README.md#migrations-and-readiness),
[outbox](../packages/messaging-plugin/README.md#transactional-outbox),
[inbox](../packages/messaging-plugin/README.md#consumer-inbox),
[tier C](../packages/idempotency-plugin/README.md#tier-c-the-work-and-its-record-commit-together),
and [audit row shape](../packages/audit-plugin/README.md#database-row-shape).

Database backups do not include Redis-backed sessions or caches, or broker queues. Use each
backend's own persistence and backup procedures; Setu-TS ships no backup tool. See the
[session stores](../packages/session-plugin/README.md),
[cache stores](../packages/cache-plugin/README.md), and
[broker backends](../packages/messaging-plugin/README.md).

After a restore, `/ready` detects missing applied migrations only when the application configures
`DatabasePlugin({ readiness: { migrations } })`; connection readiness alone does not verify the
schema ([migration readiness](../packages/database-plugin/README.md#migrations-and-readiness)).
Restored pending outbox rows can publish again: delivery is at least once, and only consumers using
the inbox whose markers survived the same restore can de-duplicate them
([outbox promise](../packages/messaging-plugin/README.md#the-promise),
[inbox promise](../packages/messaging-plugin/README.md#the-promise-1)). Tier-C idempotency records
written after the backup are lost, so a client or provider re-send can run that work again
([tier-C guarantee](../packages/idempotency-plugin/README.md#tier-c-the-work-and-its-record-commit-together)).
Restore related business rows and their delivery/idempotency records consistently, then check
readiness and reconcile external side effects before reopening traffic.

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
pnpm run check:deploy               # render drift + image builds + compose + generated
pnpm run check:deploy --render      # just the manifest/chart drift check
pnpm run check:deploy --cluster     # real kind cluster: apply, roll out, serve, check RBAC
pnpm run check:deploy --generated   # scaffold a workspace, build ITS image, serve it air-gapped
pnpm run check:deploy --workspace   # scaffold a workspace, root test, setu workspace deploy to kind
pnpm run deploy:render              # regenerate k8s/manifests/ from the chart
```

`--cluster` creates a kind cluster, loads the locally built image, applies the **committed**
manifests, waits for the rollout (which only completes if the readiness probe passes), serves a
request through the Service, and asserts the ServiceAccount can list and watch EndpointSlices. Set
`KEEP_CLUSTER=1` to keep the cluster for debugging.

`--generated` covers the deployment a USER gets, which no other check built: it scaffolds a
workspace with the CLI into a temporary directory, builds the workspace's **generated** Dockerfile,
and runs the image under the posture the generated manifest sets — read-only root, one writable
`/tmp`, no network. It passes only when the member **serves** `/health`: a start that dies at import
and one that boots but cannot serve must both fail. Absent Docker it exits 77 like the rest.

When the required tooling is absent the gate exits **77**, the same "reported a skip" code the apps
gate uses, so a missing prerequisite can never be mistaken for a pass.

Each check is known to discriminate — every one of these was broken deliberately and observed
failing:

| Break                                            | What fails                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Probe path → `/health/live`                      | Rollout never completes; ready replicas stay 0.                                              |
| Remove `COPY pnpm-lock.yaml` from the Dockerfile | `pnpm install --frozen-lockfile` refuses: `ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE`. |
| Restore `--no-lock` in the generated `CMD`       | The air-gapped `--generated` run dies fetching an uncached npm transitive dependency.        |
| Hand-edit a committed manifest                   | `--render` fails and names the file.                                                         |
| Drop `watch` from the discovery Role             | `kubectl auth can-i watch` answers `no`.                                                     |
| Point the Service selector at a missing label    | Endpoints go empty and the request is refused — while `kubectl apply` still succeeds.        |

The generated-image gate builds commented `deno.json`, `deno.jsonc`, and inherited-import layouts,
inspecting each image for the development entry and connector cache. It then boots a real Redis
broker under a read-only filesystem with no external network to verify lazy driver resolution and
`/health`.
