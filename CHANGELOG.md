# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.7] — 2026-08-12

**A deployment release.** A generated workspace now emits the artifacts that ship it — a
parameterized Dockerfile, a Compose stack carrying every member plus the broker its transport needs,
and a Deployment and Service per member, all regenerated whenever a member is added. This repository
gained the same for itself: one image that builds any example, a Helm chart with its rendered
manifests committed beside it, and a deployment guide that finally writes down the RBAC the
`kubernetes` service-discovery provider has always needed. A workspace is also no longer Deno-only
(`--runtime node|bun` builds one on npm workspaces), an existing single-service project can become
one with `setu adopt`, members can share code through `libs/`, and two more transports carry a
workspace's internal traffic.

Deploying for real is what found the defect that would have undermined all of it: **nothing handled
`SIGTERM`**. A generated `main.ts` installed no signal handler, so `docker stop` and every pod
eviction killed the process outright — measured at exit 143 after 1 ms, with `app.stop()` never run:
no drain, no service-discovery deregistration, no database or broker disconnect, and a
`terminationGracePeriodSeconds` that did nothing. Fixed in the generator and in every example here.

All 47 packages move as one version, because the CLI stamps its own version as the dependency range
for every project it scaffolds. Installs still need an explicit version
(`jsr:@setu-ts/kernel@^0.1.0-alpha.7`) — JSR does not point `latest` at a prerelease — and Deno
refuses dependencies younger than 24 hours unless you pass `--min-dep-age 0`.

### Fixed

- **A scaffolded project now survives `SIGTERM`.** A generated `main.ts` installed no signal
  handler, so `docker stop` and every pod eviction killed it: measured at **exit 143 after 1 ms**,
  with `app.stop()` never run — no drain, no service-discovery deregistration, no database or broker
  disconnect. M39 found and fixed this in this repository's own examples and documented the pattern
  as recommended; the generator kept emitting the defect. `main.ts` now catches `SIGTERM` and
  `SIGINT` — `Deno.addSignalListener` (Windows-guarded, where it throws) or `process.on` for Node
  and Bun, nothing on Cloudflare Workers, which has no process. Both npm targets declare the type
  package their `process` reference needs.
- **`setu new --template full-stack` served a blank home page.** `app/routes.ts` wraps two
  `flatRoutes` groups in `layout()` calls and neither had an `_index`, so `/` matched a layout with
  no child: `<Outlet />` rendered nothing and the server answered **200 with an empty `<body>`** —
  not a 404, not an error. Measured on a scaffolded project: `/products` and `/login` rendered while
  `/` returned 2761 bytes of shell and no visible text. M37c found and fixed exactly this in
  `apps/full-stack`; the template kept emitting it, because every check requested `/products` and
  `/login` explicitly and nothing ever requested `/`.
- **Install snippets named versions the workspace no longer shipped.** Six of them, with
  `packages/sdk/README.md` two releases behind — and a package README is the first thing a new user
  runs, rendered on jsr.io. Nothing could see it: `release:verify` reads manifests and cross-package
  specifiers, not prose, and a stale-but-real version still resolves, so the command works and
  installs something old. `deno task check:docs` now compares every `@setu-ts` specifier in markdown
  against the shipping version, exempting the changelog and the release runbook, whose old versions
  are a record; it found two more on its first run. Also corrected: `packages/cli/README.md` still
  called the framework Hono Enterprise, the name dropped in `v0.1.0-alpha.5`, and three
  `github.com/setu-ts/hono-enterprise` links 404'd — the repository is `setu-ts/setu-ts`.

### Added

- **Container and Kubernetes artifacts for a generated workspace.** `setu generate app` emits
  `docker/Dockerfile` (one parameterized image per member), `.dockerignore` (at the workspace root,
  where Docker reads it — without one the host's `node_modules` is copied over the one the image
  installed), `docker/compose.yaml` (every member plus the transport's broker) and
  `k8s/members.yaml` (a Deployment and a Service per member), all regenerated for the whole
  workspace whenever a member is added. M39 owns this repository's own deployment objects; nothing
  produced any for a user's project.
- **Containerization and Kubernetes orchestration for the framework itself** (M39). The framework
  could be served on four runtimes and found by an orchestrator, but nothing here showed how to ship
  it to one: a single collector config was the only deployment artifact in the repository. Now
  [`docker/Dockerfile`](docker/Dockerfile) builds **any** example through one file
  (`--build-arg APP=<name>`, rather than fifteen near-copies),
  [`docker/Dockerfile.compiled`](docker/Dockerfile.compiled) offers a `deno compile` → distroless
  variant, [`docker/compose.yaml`](docker/compose.yaml) runs the stack, and
  [`k8s/chart/`](k8s/chart/) is a Helm chart — Deployment, Service, Ingress, ConfigMap/Secret
  projection, HPA, PodDisruptionBudget, and the ServiceAccount + RBAC — with its rendered manifests
  committed beside it in [`k8s/manifests/`](k8s/manifests/) and `deno task check:deploy` failing on
  any drift between the two.

  [`docs/deployment.md`](docs/deployment.md) is the guide, and it documents the thing that was
  written down nowhere: the exact Role the `kubernetes` service-discovery provider needs to read
  EndpointSlices. Two things a reader might expect are corrected there rather than left implied —
  `scratch` is impossible, because the compiled binary is dynamically linked against glibc, and the
  distroless win is 44.9 MB against 52.4 MB rather than an order of magnitude, since the binary
  embeds the whole Deno runtime. The reason to prefer it is the absent shell, not the size.

  The build context **must** be the repository root: an example's `deno.json` maps only its direct
  dependencies, so `@setu-ts/common` reaches `kernel` through the root workspace, and an image built
  without the root manifest fails resolution against JSR instead. Three defects only a real cluster
  surfaced are fixed in what ships: `runAsNonRoot` refuses a non-numeric image user (both images
  declare numeric UIDs), an `emptyDir` at `/deno-dir` masks the build-time module cache and makes
  every pod re-resolve from jsr.io at startup, and `helm template` defaults `.Release.Namespace`, so
  the RoleBinding named a ServiceAccount in the wrong namespace and granted nothing while applying
  cleanly.
- **`--transport pubsub` and `--transport service-bus`.** Both were previously refused because each
  needs a value no scaffold can invent. Every transport with a connection value now reads it from
  the environment with a local fallback, and for these two that fallback is the vendor's own
  local-emulator setting — so a scaffolded workspace runs against an emulator unconfigured and
  against the real service with one variable set.
- **`setu generate library <name>`.** Shared code as a workspace member under `libs/`, importable by
  every sibling as `@<scope>/<name>` with no import-map entry anywhere.
- **`setu adopt`.** Converts an existing single-service project into a workspace holding it as the
  first member. It moves only the files the CLI emits, so `.git`, CI configuration and `deno.lock`
  stay at the repository root.
- **`setu generate app --port <n>`.** A member can be given a specific port; one another member
  already binds is refused.
- **`--template full-stack` as a workspace member.** Its Vite build needs `node_modules`, which only
  the workspace root may enable, so the root gains `nodeModulesDir` when such a member arrives — and
  not before, because with it set an ordinary member's first `deno check` materialises every npm
  package the framework lazily imports.
- **Node and Bun workspaces.** `setu new --workspace --runtime node|bun` builds a monorepo on npm
  workspaces instead of a Deno one — the framework claims runtime independence, and only the
  monorepo was Deno-only. The runtime is recorded in `setu.workspace.json` (absent means `deno`, so
  nothing existing changes) and every later command reads it back: root manifest shape, environment
  reads in generated source, library manifest and test runner, base image, and install and run
  commands. Cloudflare Workers is refused, because each Worker is its own deploy unit.
- **A proto toolchain for `--transport grpc` members.** An example proto, both `buf` manifests and a
  `proto:gen` task. Both the compiler and the codegen plugin run through Deno's npm compatibility,
  so nothing needs `buf` or `protoc` on a PATH.

### Changed

- **A workspace transport's connection value is an environment read, not a literal.** A generated
  member's `MessagingPlugin` wiring was `url: 'redis://127.0.0.1:6379'`, which is unreachable from
  inside a container — two Compose services do not share a loopback interface, so the member dialled
  its own container. It is now `Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379'`.
- **The generated discovery map reads each sibling's host from `<MEMBER>_HOST`**, falling back to
  `127.0.0.1`, for the same reason: inside a container loopback is the container itself, so a fixed
  address had every member dial ITSELF on its sibling's port. The generated Compose stack and
  Kubernetes objects set those variables to the service names.
- **A new workspace's root declares both member globs** (`./apps/*` and `./libs/*`) at creation, so
  neither a service nor a library ever rewrites it. A workspace created earlier gets the second glob
  added when its first library arrives.

## [0.1.0-alpha.6] — 2026-08-11

**A generator release.** Eleven of the fourteen artifacts `setu generate` emits now reach a
registration site with no edit to a file you own — the other three have a stated reason they have
none. Decorators and dependency injection became independent choices, a repository can hold more
than one deployable service, and Cloudflare Workers gained the last capability it was missing.
Alongside that: a documentation hub with nine curated guides, RFC 9457 Problem Details, and an
OpenAPI document derived from the guards that enforce authentication.

All 47 packages move as one version, because the CLI stamps its own version as the dependency range
for every project it scaffolds. Installs still need an explicit version
(`jsr:@setu-ts/kernel@^0.1.0-alpha.6`) — JSR does not point `latest` at a prerelease — and Deno
refuses dependencies younger than 24 hours unless you pass `--min-dep-age 0`.

**One behavior change to already-generated code**: `setu generate controller` emitted a controller
that answered `500` on every request, in every release since the CLI first shipped in
`v0.1.0-alpha.2`. The fix changes the shape of what it emits — see _Changed_ below for the
migration.

### Added

- **Workers-native messaging: the last edge capability gap** (M59). `cloudflare-plugin` already
  served `QUEUE`, `CACHE`, `STORAGE`, `DATABASE` and `REALTIME_BACKPLANE` on Cloudflare Workers.
  `CAPABILITIES.MESSAGING` was the one token it could not: all ten `messaging-plugin` brokers need a
  socket or a socket-bound SDK. A new `messaging` arm serves it from the platform itself.

  ```typescript
  app.register(CloudflarePlugin({
    env,
    messaging: { binding: 'MESSAGES', rpc: { binding: 'REPLY_INBOX' } },
  }));

  // Consuming is a MODULE export — no plugin option can declare one.
  export default { fetch: app.fetch, queue: createMessagingHandler(app) };
  ```

  `publish` is a Queues producer call; `subscribe` registers into a dispatch table the `queue`
  export drives, matching `InMemoryBroker`'s fan-out and round-robin group semantics. Two limits are
  documented rather than papered over: Cloudflare allows **exactly one active consumer per queue**,
  so cross-service fan-out needs one queue per consumer, and a publish nobody subscribed to is
  **acked** rather than retried — retrying ordinary pub/sub would dead-letter every fire-and-forget
  message.

  `request`/`respond` ship behind the opt-in `rpc` arm. A queue reaches its one consumer Worker and
  never the caller, so the reply travels through a Durable Object the caller holds a WebSocket to
  while its request is in flight (`ReplyInboxObjectCore`, which the application exports as its own
  DO class). Without the arm both throw, naming the binding to add. A queue carrying RPC **must**
  set `max_batch_timeout = 0`: the platform default of 5s alone exhausts the default reply budget.

  `CloudflareRequestTimeoutError` and `CloudflareRemoteHandlerError` mirror `messaging-plugin`'s two
  RPC errors as distinct classes, because §2.2 forbids a plugin importing another plugin. Exactly
  one provider of `CAPABILITIES.MESSAGING` can be registered, so which to catch is never ambiguous.

- **`setu new --template microservice --runtime cloudflare-workers`** (M59). The template refused
  that target unconditionally. The refusal was right about `MessagingPlugin` and `QueuePlugin`
  needing raw sockets and wrong about the capabilities, which the platform serves itself. A new
  declarative `TemplateDefinition.runtimeSwaps` replaces those two with `CloudflarePlugin` on
  Workers only, and contributes the `queue` module export, the Durable Object class, and the
  wrangler stanzas — including `max_batch_timeout = 0`. The other three runtimes are byte-identical.
  Because Cloudflare invokes ONE `queue` export for every consumed queue, the emitted handler routes
  on the queue name and both queues get a consumer: one handler for both would feed the messaging
  broker its job batches, and an unconsumed producer discards every `IQueue.add()` silently.
  `TemplateDefinition.unsupported` and its refusal branch are **removed**: `microservice` held the
  last entry, so both became unreachable. CLI-internal, never a published export.

- **Monorepos: one repository, many deployable services** (M62). The CLI had no workspace concept at
  all, so a second service meant `setu new other --dir .` — a fully independent project with its own
  manifest, its own lockfile, and no knowledge of its sibling. The sharp edge was discovery: the
  microservice template wires `ServiceDiscoveryPlugin({ provider: 'static', services: {} })` with a
  deliberately EMPTY map, because a sample entry would have named a dead port, so every caller's map
  was hand-edited in every service and nothing propagated a new name.

  ```bash
  setu new acme --workspace                          # the root, no member yet
  cd acme
  setu generate app orders --template microservice   # apps/orders, port 3000
  setu generate app billing --template microservice  # apps/billing, port 3001
  deno task dev                                      # runs every member
  ```

  A workspace is a **Deno workspace** whose root declares members by GLOB
  (`"workspace":
  ["./apps/*"]`), so adding a service creates a directory and rewrites no manifest
  — no file you own is ever edited. Each member is an ordinary scaffolded project with its own
  framework pins, because plugin detection reads one directory's manifest and never walks up; two
  members may install different plugin sets.

  **Adding a service registers it with its callers.** Every member carries a CLI-owned
  `src/discovery/services.ts`, regenerated for all members on each `setu generate app`, exporting
  `SERVICE_PORT` (its own) and `SERVICE_ENDPOINTS` (every sibling). The member's `main.ts` binds the
  former and its `setu.config.ts` hands the latter to `ServiceDiscoveryPlugin`, so the port a member
  binds and the port its siblings dial are one datum and `discovery.resolveUrl('billing')` works
  from any sibling with no configuration. The map is the LOCAL development topology; a deployed one
  comes from a real backend (`consul`, `kubernetes`, `dns`).

  **The workspace chooses how its services talk.**
  `--transport http|grpc|memory|redis|rabbitmq|
  nats|kafka` is recorded in `setu.workspace.json`
  and inherited by every member, because services can only meet on a bus they share; `generate app`
  refuses the flag and names the workspace-level one. `http` stays the default, so an upgrade
  changes nothing. This closes a silent failure the workspace itself made reachable: the
  microservice template registers `MessagingPlugin()`, whose default broker is in-process, so two
  generated services publishing and subscribing on one topic exchanged nothing while both reported
  success. `--transport tcp` is refused with an explanation rather than aliased to HTTP — there is
  no raw-TCP transport here.

  Refusals rather than silent surprises: `generate app` outside a workspace names
  `setu new <name> --workspace`; a duplicate member names the directory it already has; a non-Deno
  `--runtime` names the standalone alternative; `--template full-stack` is refused because its Vite
  build needs `nodeModulesDir`, which Deno accepts only in a workspace ROOT; and `new --workspace`
  refuses `--template` because a root registers no plugins.

- **Decorators and DI are independently selectable in the generator** (M61). AI_GUIDELINES states
  that decorators are optional, DI is optional, and that no feature requires either — but the CLI
  offered one coarse control. No template gave you neither and refused `g controller`/`g module`;
  `rest`/`microservice` gave decorators without a container; only `nest` gave both, along with a
  worked NestJS-style example you may not have wanted.

  `setu new --di` adds `DiPlugin` to any template, so a container is now a choice of its own:

  ```bash
  setu new app --di                       # a container, no decorators
  setu new app --template rest --di       # decorators and a container
  setu new app --template nest --di       # a no-op — nest already registers DiPlugin
  ```

  It changes the composition, never the generated source: `DecoratorPlugin` branches on the
  container's presence, so the same `@Injectable` class works either way and what changes is the
  lifecycle it gets. On `--template full-stack` the flag reaches the starter's own `di` arm rather
  than a plugin wiring, because a starter-composed template owns its whole plugin set. Adding it to
  a template that already registers `DiPlugin` is deliberately a no-op — the kernel refuses a
  duplicate plugin name at `start()`, so a second registration would scaffold a project that
  type-checks and then cannot boot.

- **`setu generate route` is now a first-class decorator-free path.** A project scaffolded with no
  template registers the runtime plugin alone, so `g route` is the only HTTP handler it can generate
  — and it used to land unwired: the schematic wrote `src/routes/<name>.routes.ts` and a
  `src/routes/index.ts` barrel while the generated `setu.config.ts` imported neither, so the route
  answered `404` until you edited the config by hand. The no-template path is now a seam host for
  the three families that need no plugin (`route`, `middleware`, `plugin`), so a generated route,
  middleware or plugin is wired from scaffold time exactly as it is under `--template rest`.

  Existing projects are unaffected — nothing rewrites a scaffolded `setu.config.ts`. Each barrel's
  header states the two lines to add; add them once and every later generate is wired.

- **Generated code is now wired** (M60). `setu generate` emitted fourteen artifacts and exactly one
  of them — the M58 domain module — reached a registration site. The other thirteen compiled and did
  nothing: `g service` emitted a class nothing constructed, `g health-indicator` an indicator
  nothing registered, `g command-handler` a handler no bus dispatched to. Eleven now reach a
  registration site with no edit to a file you own, and three are documented as having none.

  Each wired schematic emits its artifact plus a CLI-owned `index.ts` seam barrel for its family,
  and the `rest`, `microservice` and `nest` templates scaffold a `setu.config.ts` that already
  imports every barrel they can consume. See PUBLIC_API "Generated code is wired" for the
  per-schematic table.

  ```bash
  setu new shop --template microservice
  setu g health-indicator external-api --dir shop   # appears in GET /health
  setu g metric orders-placed --dir shop            # appears in GET /metrics at boot
  setu g command-handler create-user --dir shop     # the command bus dispatches to it
  ```

  `guard`, `job` and `migration` are deliberately unwired, and their emitted JSDoc now names the
  real call instead of implying a site is waiting: a guard belongs on one route (a global one would
  answer `401` for `/health`), a job's transport is a choice between `queue.process` and the
  scheduler that the artifact cannot make for you, and nothing in the framework reads migration
  files — there is no `setu db:migrate`.

- **`CqrsPluginOptions.commandHandlers` / `.queryHandlers`, and `EventsPluginOptions.handlers`** —
  declarative handler registration, as `{ type, handler }` pairs. Pure additions: omitting them
  behaves exactly as before. The events option subscribes through the same exported
  `subscribeHandler` a caller would use by hand, so the two routes cannot diverge. Needed because
  `IApplication` exposes no lifecycle hook, so application code has no phase in which to reach a bus
  that does not exist until its plugin has registered. `CommandHandlerRegistration`,
  `QueryHandlerRegistration` and `EventHandlerRegistration` are exported alongside them.

- **`NamedMetricConfig` is exported from `@setu-ts/metrics-plugin`.**
  `MetricsPluginOptions.customMetrics` is typed as an array of it, so without the export that option
  could take an inline literal but a caller could not declare its own array in a variable.

- **`CqrsPlugin` and `EventsPlugin` join `setu new --template microservice`.** Both are in-memory
  and construct with no configuration, so the tier's rule that a scaffolded plugin needs no
  credentials holds, and neither needs a socket so the Cloudflare Workers refusal is unchanged. They
  are also the only host a scaffolded project can have for `g command-handler`, `g query-handler`
  and `g event-handler`, all three of which were gated on plugins no template installed.

- **A documentation hub, and gates that keep it true** (M38). Nine curated guides under
  [`docs/`](docs/) — getting started, plugin architecture, the plugin catalog, the programmatic API,
  decorators, writing custom plugins, migrating from NestJS and from Fastify, the examples index,
  and runtime deployment — plus a reproducible `deno doc` API-site generator (`deno task docs:api`).
  Every package README now links to its own `PUBLIC_API.md` section.

  The guides are mechanically checked rather than trusted: committed fixtures representing all nine
  are type-checked against the workspace, a Markdown gate validates the package catalog and every
  cross-file anchor, and a JSDoc lint ratchet freezes the measured diagnostic count so documentation
  debt can only be paid down, never added to. A below-baseline run fails and names the constant to
  lower. No package source, manifest export, capability token, or plugin option changed.

  `PUBLIC_API.md` section anchors now carry their package name, which **breaks external deep links**
  (`#storage` is now `#storage-setu-tsstorage-plugin`).

### Fixed

- **Every Cloudflare Worker misdetected its own runtime as `node`** (found while booting a
  CLI-scaffolded Workers project in M59). `detectRuntime()` tested
  `navigator.userAgent.includes('cloudflare')` — lowercase — and workerd reports
  `'Cloudflare-Workers'`, so the check never matched and detection fell through to `'node'` on every
  real deployment. That answer selects the runtime adapter, so a Worker built through
  `RuntimePlugin()` ran the **Node** adapter on Cloudflare, and the `cloudflare` health indicator
  reported `degraded` with a misleading detail. It also silently disabled every
  `runtime.platform() === 'cloudflare-workers'` guard, including `messaging-plugin`'s cloud gate —
  so Pub/Sub and Service Bus attempted their gRPC/AMQP SDK load instead of failing with the named
  `CloudBrokerUnavailableError`.

  The comparison is now case-insensitive. No test caught this because the unit fakes sent
  `'cloudflare-workers/v1'` and `'cloudflare'`, strings the platform never sends — a test double
  that violated the real contract, so the suite tested the double. The fakes now use the real
  string, and `apps/cloudflare` asserts `detectRuntime()` against **real workerd** in its smoke,
  which is the only place the platform sends its own user agent. Both were verified to fail without
  the fix.

- **A mistyped Queues binding now fails at `register()`, not at the first send** (M59).
  `BindingRegistry.queue()` cast its binding unvalidated, so a missing `[[queues.producers]]` stanza
  or a name typo let an application boot clean, report `up` from the `cloudflare` health indicator,
  and fail on the first `add()` with a bare `TypeError` pointing at nothing. A new `isQueueProducer`
  guard closes the last hole in that family — the same defect M52c fixed on D1 and M52d on Durable
  Objects. **Behaviour change** for anyone whose queue binding was already wrong: the failure now
  arrives at startup, naming the binding.

- **`setu new --runtime cloudflare-workers` produced a project that could not be built or
  deployed.** `wrangler` bundles `src/index.ts` with esbuild, which resolves neither `jsr:`
  specifiers nor a Deno import map — and the Workers target declared its framework packages only in
  `deno.json`, emitting no `package.json` and no `.npmrc`. So the flow the CLI itself prints,
  `npm install && npx wrangler dev`, failed with one `Could not resolve "@setu-ts/…"` per package.
  There was nothing to install.

  Workers projects now also emit `package.json` (the npm-compat `@jsr/…` dependencies, plus
  `wrangler` pinned in `devDependencies` and `dev`/`deploy` scripts) and `.npmrc`. Verified against
  real workerd through `wrangler dev`: a scaffolded project serves `/`, `/health`, `/metrics`, and
  every generated route, controller and module. The Deno target deliberately still gets no
  `package.json` — that would switch it to node_modules resolution.

  **Existing Workers projects are not rewritten.** Add a `package.json` declaring the same
  `@setu-ts/*` packages your `deno.json` lists, using their `npm:@jsr/setu-ts__<name>` form, plus an
  `.npmrc` containing `@jsr:registry=https://npm.jsr.io`.

- **`setu new --runtime node` could not run any decorated code.** Generated Node projects started
  with `node --experimental-strip-types main.ts`, and Node's built-in TypeScript support erases
  types without transforming code — so a legacy decorator was a bare
  `SyntaxError: Invalid or unexpected token`, and the constructor parameter property
  `setu generate module` emits was `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. In practice a scaffolded
  Node project booted until the first `setu generate service`, `generate controller` or
  `generate module`, and `setu new --template nest --runtime node` never booted at all. Deno, Bun
  and Cloudflare Workers were unaffected.

  Node projects now declare `tsx` in `devDependencies` and start with `tsx main.ts`, which reads the
  `experimentalDecorators` the generated `tsconfig.json` already sets.
  `--experimental-transform-types` was evaluated and rejected: it handles the parameter property but
  still refuses the decorator, because it does not enable `experimentalDecorators`. No other target
  carries the dependency — Bun compiles TypeScript outright, and Deno and Workers never invoke it.

  **Existing Node projects are not rewritten.** To pick this up, add `tsx` to your `devDependencies`
  and change the `start` script from `node --experimental-strip-types main.ts` to `tsx main.ts`.

### Changed

- **The `controller` and `module` gate refusals now name `setu generate route`** as the
  decorator-free alternative. The gate itself is unchanged (those schematics emit `@Controller`, so
  an ungated project would get source whose own import cannot resolve), but refusing with only
  "install `@setu-ts/decorator-plugin`" read as though decorators were required to serve HTTP, which
  is the opposite of what the framework promises.

  ```
  The "controller" schematic requires @setu-ts/decorator-plugin, which is not installed in /path/to/app.
  Install it, then run this command again.
  Or run `setu generate route user-profile` — it registers handlers on the router API, so it needs no decorators.
  ```

- **`setu generate plugin` now writes `src/plugins/<name>.plugin.ts`**, not `src/plugins/<name>.ts`.
  The seam barrel is regenerated from a directory scan, and a suffix of `.ts` would admit any module
  you hand-wrote in that folder — the barrel would then import a `<Pascal>Plugin` symbol you never
  wrote, and your project would fail to compile naming a file you never generated. Existing
  generated files are untouched; only new generates take the new path.

- **`setu generate service` emits an `@Injectable` when `@setu-ts/decorator-plugin` is installed**,
  registered under the token `<name>-service` and listed in `src/services/index.ts`. Without that
  package the output is unchanged, byte for byte, and the schematic stays **ungated** — so it keeps
  working in a project with no plugins at all.

- **An artifact generated before its family gained a second export is skipped and reported**, rather
  than listed in a barrel that cannot compile. `middleware` gained a
  `<SCREAMING>_MIDDLEWARE_PRIORITY` constant and `metric` a `<SCREAMING>_METRIC` declaration in this
  release; an artifact generated earlier has the right filename and lacks that export, so a barrel
  regenerated over it named a symbol the file did not have and the project stopped compiling — from
  a command that reported success. The scan now admits a file only when it exports everything the
  barrel will name, prints what it skipped and why, and tells you to regenerate. The same rule keeps
  a hand-written module in a scanned directory out of the barrel.

- **`setu generate` refuses a name that would collide with an existing artifact** (exit `1`), naming
  the conflict and the consequence. `route`, `controller` and `module` all mount `/<name>`, and the
  kernel's router keys routes by method and path — so a duplicate silently overwrites and one
  artifact becomes unreachable. `service` and `module` both register
  `@Injectable({ token: '<name>-service' })`, and the decorator plugin keeps the first class under a
  token — so the wrong service would be injected, which was observed as a `500` on every request to
  the affected module. Both checks apply only when `decorator-plugin` is installed, since neither
  collision can exist without it.

- **Fixed: `setu generate controller` emitted a controller that answered 500 on every request.**
  `DecoratorPlugin` builds a handler's argument list from parameter metadata alone and never passes
  the request context positionally, so the emitted `list(ctx: IRequestContext)` received `undefined`
  and threw on the first `ctx.response`. Handlers now take only decorated parameters and return
  plain values, which the plugin serializes as JSON; `create` takes `@Body()`. The `201` on create
  is gone rather than faked — a decorated handler cannot set a status code, so a handler that needs
  the context belongs on `app.router.get(...)` (`setu generate route`).

  Regenerate any controller produced by an earlier release, or drop its `ctx` parameter and return a
  plain value. Shipped alongside the module schematic below because it is the same package and the
  same one-line class of defect.

- **`setu generate module <name>` scaffolds a whole domain sub-module and wires it in** (M58),
  instead of requiring `g controller` + `g service` plus a hand edit of `setu.config.ts`. Emits an
  `@Injectable` service, a `@Controller` injecting it by token, a service test, a per-module barrel,
  and a regenerated aggregate barrel at `src/modules/index.ts` exporting `MODULE_CONTROLLERS` /
  `MODULE_SERVICES`. The `rest`, `microservice` and `nest` templates now scaffold a `setu.config.ts`
  that already imports both and passes them to `DecoratorPlugin`, so nothing the developer owns is
  ever edited by the CLI.

  ```bash
  setu new shop --template rest
  setu g module orders --dir shop   # wired; no edit to setu.config.ts
  ```

  Gated on `@setu-ts/decorator-plugin`, like `g controller`. `--template full-stack` is not a host:
  its layering is `routes → features → services` and it has no `src/modules/` concept. A project
  scaffolded before this release adds the barrel import once; every later `g module` is automatic.

  A directory counts as a module only when it holds both canonical files, so an unrelated folder
  under `src/modules/` is skipped instead of producing a barrel that imports files which do not
  exist. The host templates declare `@std/testing` and `@std/expect` (a `deno.json` import on
  Deno/Workers, an `npm:@jsr/std__*` alias on Node/Bun), so the emitted test runs with no further
  setup.

  `GeneratedFile` gains an optional `managed` flag and `SchematicOptions` an optional `modules`
  list. Both are additive — existing custom schematics compile unchanged. A managed file is exempt
  from the overwrite refusal, which previously covered every path without exception; only
  `src/modules/index.ts` is managed today, and the exemption is per file rather than a `--force`
  flag so a mistyped `g service` still cannot clobber hand-written work.

- **The OpenAPI document can be derived from the guards that enforce authentication** (M57), instead
  of requiring every route to declare a requirement a second time. `@setu-ts/common` gains a
  `SECURITY_METADATA` symbol, a `RouteSecurityMetadata` type, and the pure `withSecurityMetadata` /
  `securityMetadataOf` helpers; every guard `@setu-ts/auth-plugin` ships is branded with them, and
  `@setu-ts/openapi-plugin` reads the brand off a route's middleware.

  ```typescript
  app.register(OpenApiPlugin({
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    deriveSecurity: { scheme: 'bearerAuth' },
  }));

  app.router.get('/todos/:id', { middleware: [requireAuth()], handler }); // → requires bearerAuth
  app.router.post('/login', { middleware: [publicRoute()], handler }); // → public
  ```

  **Opt-in and non-breaking.** Without `deriveSecurity` nothing is derived and the document is
  byte-identical, and a requirement declared on `schema.security` always wins over a derived one.
  The brand is symbol-keyed and non-enumerable, so guard identity and behaviour are unchanged;
  `Symbol.for` is used so two copies of `common` in one process resolve the same key.

  Three limits are documented rather than left to discovery: only route-level middleware is
  inspected (`app.middleware.add()` is invisible to a route, which is correct for `authMiddleware()`
  — it populates the principal and never rejects); roles and permissions cannot be expressed,
  because an OpenAPI requirement names a scheme and none can be inferred from `'admin'`; and the
  scheme name is configured rather than inferred, with an undeclared name refused at `register()`.

- **`RouteSchema.security` and a document-level `security` option describe which operations need
  authentication.** `@setu-ts/openapi-plugin` accepted `securitySchemes` and emitted them under
  `components`, but nothing ever declared a **requirement** — `OpenApiOperation.security` existed in
  the generator's types with no assignment anywhere — so no operation was marked protected and
  generated clients had no signal that a route needed a token.

  `RouteSchema` in `@setu-ts/common` gains an optional `security`, alongside the `tags` and
  `summary` it already carried, plus a new exported `SecurityRequirement` type. The addition is
  optional, so existing routes and existing implementors are unaffected.

  ```typescript
  app.register(OpenApiPlugin({
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    security: [{ bearerAuth: [] }], // document-level default
  }));

  app.router.post('/login', { schema: { security: [] }, handler }); // explicitly public
  ```

  An **empty** `security` array is meaningful and is not the same as omitting the field: per the
  OpenAPI specification it declares the operation public, which is how a route opts out of the
  document-level default. Omitting the field leaves the operation inheriting it. Declaring this
  enforces nothing — authentication is still enforced by middleware and guards; this describes the
  route for documentation and client generation.

- **`OpenApiPluginOptions.exclude` keeps operational endpoints out of the document.** Paths are
  matched exactly against the fully-resolved router pattern — router-style (`/todos/:id`, not the
  OpenAPI template `/todos/{id}`) and including any `router.group()` prefix — and every method on a
  matched path is omitted.

- **`@Public` reaches the OpenAPI document.** A decorated route marked public is now documented with
  an empty `security` array, so it opts out of a document-level requirement. Without this the
  opt-out was reachable only from a programmatic `schema`, and a decorated login route would have
  been documented as requiring the token it issues. `@Roles`/`@Permissions` are deliberately not
  mapped: a role is not a security scheme, and no declared scheme can be inferred from one.

- **A `security` requirement naming an undeclared scheme is refused at `register()`,** naming the
  offending scheme and the declared ones. Emitting it produced a document that is invalid per the
  specification — Swagger UI renders a lock on every operation with no Authorize button to satisfy
  it, and strict validators and client generators reject it — while the spec endpoint still answered
  `200`, so nothing downstream could detect it.

### Fixed

- **The OpenAPI document no longer lists its own delivery endpoints.** `GET /openapi.json` and
  `GET /docs` were generated as API operations, so every consumer of the spec — Swagger UI readers
  and generated clients alike — was handed the documentation machinery as part of the API. Both are
  now excluded automatically, honoring `endpoint`/`specEndpoint` when they are customized. The
  routes are still served; only the document entries are gone.

- **Path parameters are typed as strings instead of rendering as `any`.** A path parameter with no
  entry in the route's `params` schema was emitted as `schema: {}`, which OpenAPI reads as "any
  type" — Swagger UI rendered an untyped box and client generators produced `unknown` arguments.
  Every path segment arrives as a string, so an undescribed path parameter now defaults to
  `{ type: 'string' }`. A declared `params` schema still wins, per parameter.

### Changed

- **Problem Details move from RFC 7807 to RFC 9457** (M56). RFC 7807 was obsoleted by
  [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) in July 2023, and the framework advertised
  the withdrawn specification in two packages, a public format alias, an exported symbol in each,
  the three starters, and every documentation site.

  `@setu-ts/exceptions` and `@setu-ts/validation-plugin` each gain an `'rfc9457'` format arm and an
  `rfc9457Formatter` export. `'rfc7807'` and `rfc7807Formatter` are **deprecated, not removed**
  (AI_GUIDELINES §9.2), and are scheduled for removal in v1.0.0.

  RFC 9457 changed very little on the wire — Appendix D lists three changes, none touching the five
  core members or the `application/problem+json` media type — so the bodies were already
  structurally valid. One 7807-era habit did need correcting, and that is the only behavior change
  here.

  > **⚠️ Breaking: `type` is now `about:blank` for status-only problems.** `@setu-ts/exceptions`
  > previously minted a URI from the status code for every error (`https://setu-ts.dev/errors/404`),
  > which identifies nothing the `status` member does not already carry. RFC 9457 §4.2 registers
  > `about:blank` for precisely that case, and that is what the `'rfc9457'` format now emits.
  > Clients matching on `type` to distinguish errors should read `status` instead. The one error
  > carrying an extension member, `validationError()`, keeps a concrete type URI —
  > `https://setu-ts.dev/errors/validation`, the same URI `@setu-ts/validation-plugin` emits for the
  > same problem type.
  >
  > ```jsonc
  > // Before                                   After
  > { "type": "https://setu-ts.dev/errors/404", { "type": "about:blank",
  >   "title": "Not Found",                       "title": "Not Found",
  >   "status": 404,                              "status": 404,
  >   "detail": "User 42 does not exist" }        "detail": "User 42 does not exist" }
  > ```
  >
  > Two escape hatches, in order of preference: read `status`, which is what it is for; or keep the
  > deprecated `format: 'rfc7807'`, which is **unchanged** and still emits the status-derived URI —
  > a deprecated symbol must not silently change behavior (§9.4).

  `@setu-ts/validation-plugin` has **no wire change at all**: its `type` was always a semantic URI
  rather than a status-derived one, so `rfc7807Formatter` there is a deprecated alias bound to the
  same object and the emitted body is byte-identical.

  The three starters (`rest`, `microservice`, `full-stack`) now compose `errorHandler` with
  `format: 'rfc9457'`, so an application built on one of them picks up the new `type` on upgrade.
  Applications wiring `errorHandler` themselves are unaffected until they change the format string.

### Fixed

- **The Problem Details media type survives a second formatter.** Both packages keyed
  `application/problem+json` off a single formatter **reference**, so that passing a formatter
  directly (`format: rfc9457Formatter`) agreed with passing the alias (`format: 'rfc9457'`). Adding
  a second formatter to that check without generalizing it would have served a Problem Details body
  as `application/json` — which generic problem-details clients ignore — while the string alias
  tested fine. The check is now a membership test over every Problem Details formatter, covered by
  tests that drive each spelling **by reference**.

- **`ARCHITECTURE.md` documented a `type` URI the code never emitted.** The Problem Details example
  showed `https://setu-ts.dev/errors/not-found`; the formatter emitted
  `https://setu-ts.dev/errors/404`. Corrected along with the rest of the section.

## [0.1.0-alpha.5] — 2026-08-08

**This release renames the project and moves every package to a new JSR scope.** It is the first
release published under `@setu-ts`; the `@hono-enterprise` packages are **archived** and receive no
further versions. Because the scope changes, **every consumer must update their imports and their
manifest** — there is no upgrade path that leaves specifiers untouched.

Two things about a prerelease under a brand-new scope, both of which will otherwise surprise you:
JSR does not point `latest` at a prerelease, so every install instruction must carry an explicit
version (`jsr:@setu-ts/kernel@^0.1.0-alpha.5`); and Deno refuses dependencies younger than 24 hours
unless you pass `--min-dep-age 0`, which affects the maintainer verifying the release rather than
ordinary users.

**The project is renamed from Hono Enterprise to Setu-TS, and every package moves to a new JSR
scope.** The old name asserted an association with the Hono project that does not exist: this
framework is not built, endorsed, or maintained by the Hono team, and its actual use of Hono is one
file — the kernel's router delegates matching to `jsr:@hono/hono`. That dependency is unchanged and
unaffected. The rename removes the false signal, nothing else.

> **⚠️ Breaking 1 of 5: every import specifier changes.** `@hono-enterprise/<pkg>` becomes
> `@setu-ts/<pkg>`, published under the `@setu-ts` JSR scope. On the npm compatibility path,
> `@jsr/hono-enterprise__<pkg>` becomes `@jsr/setu-ts__<pkg>`. This is a find-and-replace across
> your imports and your manifest; no API changes with it. The `@hono-enterprise` packages are
> **archived** on JSR — hidden from search and closed to new versions, but every published version
> stays installable and existing pinned builds keep resolving. They are deliberately **not yanked**:
> yanking signals a defective release and would break range resolution, and these versions are
> superseded rather than broken.

> **⚠️ Breaking 2 of 5: existing session cookies are invalidated.** The HKDF `info` parameters
> behind `@setu-ts/session-plugin` carried the old project name, so the derived encryption, signing,
> and key-id values all change. Every previously issued cookie fails to open and is treated as
> absent, signing users out once. No configuration changes and no key rotation is required — this
> happens on deploy and does not repeat.

> **⚠️ Breaking 3 of 5: the realtime backplane default topic changes.** `DEFAULT_TOPIC` moves from
> `hono-enterprise.realtime` to `setu-ts.realtime`, so replicas on either side of the upgrade **do
> not see each other's frames**. Restart all replicas together rather than rolling them, or pin the
> old value explicitly via the `topic` option to upgrade in stages. This mirrors the alpha.3
> request-reply wire change; if you do not use the backplane, nothing here applies to you.

> **⚠️ Breaking 4 of 5: RFC 7807 `type` URIs change.** The error-document base moves from
> `https://hono-enterprise.dev/errors` to `https://setu-ts.dev/errors`, affecting every Problem
> Details body from `@setu-ts/exceptions` and `@setu-ts/validation-plugin`. Clients matching on the
> `type` field need updating. Per RFC 7807 these URIs are identifiers and are not required to
> resolve.

> **⚠️ Breaking 5 of 5: the CLI binary is renamed.** `honoe` becomes `setu` — `setu new`,
> `setu generate`, and so on. Reinstall the CLI to pick up the new executable name; scaffolded
> projects are otherwise unchanged apart from the scope in their generated manifests.

Two further identifiers change with the rename and are noted for completeness rather than as
breaking: the exported `SESSION_STATE_KEY` is now `setu-ts:session`, and the GitHub repository moved
to `setu-ts/setu-ts`. Released sections below this one deliberately retain the `@hono-enterprise`
names, because they record what those releases actually shipped.

### Added

- **`@setu-ts/static-plugin` — static file serving as a capability** (M55). Registers `IStaticFiles`
  under a new `CAPABILITIES.STATIC_FILES` token and mounts one handler on both `GET` and `HEAD`.

  The framework previously had exactly one static file server, inside `react-router-plugin`, written
  for content-hashed SSR bundles: an unconditional `immutable` `Cache-Control` on every response, no
  directory-index resolution, no conditional requests, and a whole-file read into memory. That
  handler is unchanged and still correct for its job; this package is for everything else.

  Ships configurable `cacheControl` (a string, or a function receiving the root-relative path,
  defaulting to immutable-for-hashed and `must-revalidate` otherwise), `index` and `fallback` as
  separate options, conditional requests, single-range `206`/`416`, `.br`/`.gz` sidecar negotiation,
  a `static-files` health indicator, and streaming for files above `maxBufferBytes`.

  The SPA `fallback` fires only when `Accept` includes `text/html`. Without that guard a missing
  `.js` returns the HTML shell under a JavaScript content type, which browsers surface as an opaque
  syntax error.

  `ETag` is **strong** (`"<size>-<mtimeMs>"`) when the runtime reports an `mtime`, and degrades to a
  weak size-only validator when it does not. This is load-bearing rather than cosmetic: `If-Range`
  MUST be ignored for a weak validator (RFC 9110 §13.1.5), so a weak ETag makes every interrupted
  download restart from byte zero. `size`+`mtime` is what nginx and Apache emit as strong for static
  files.

  On Cloudflare Workers `runtime.fs` is absent, so the plugin registers its capability, reports
  `degraded`, and mounts no route. Use Workers Assets or R2 via `@setu-ts/cloudflare-plugin` there.

- **`IFileSystem.readStream?(path, { start, end })`** in `@setu-ts/common` — optional and additive,
  so no existing implementor breaks and every current caller is untouched. `end` is **inclusive**,
  matching both `node:fs` and the `Range` wire format, so no off-by-one translation exists.
  Implemented by the Node, Deno, and Bun runtime adapters and omitted on Workers, where callers
  degrade to a whole-file read exactly as they already do for `realPath`.

- **`contentTypeFor`, `isLexicallyContained`, `assertRealPathContained`** in `@setu-ts/common` —
  pure helpers shared by `static-plugin` and `react-router-plugin`, which now delegates to them. Its
  emitted headers are unchanged and pinned by a regression test.

- **`@Optional` constructor-parameter decorator** in `@setu-ts/decorator-plugin`. Pairs with
  `@Inject` on the same parameter (either order) and injects `undefined` when that token has no
  provider, so a class can depend on a capability the application may not have registered without
  the author hand-writing a container lookup.

  It means the dependency is **absent**, not that construction may fail: a token that IS provided is
  resolved normally, so a circular dependency or a throwing factory still surfaces instead of
  becoming `undefined`. Both construction paths honor it identically — the DI container when one is
  registered, the kernel's service registry otherwise.

  Three misuses are refused rather than silently misinjected: `@Optional` with no `@Inject` on the
  same parameter, `@Optional` combined with the deprecated class-level `@Inject(...)` list, and
  `@Optional` on a method parameter.

  On the container path a class carrying `@Optional` now registers as a `useFactory` provider
  instead of `useClass`, because `ClassProvider.inject` is a bare token list with nowhere to record
  optionality; its own `scope` is still honored, but its dependencies resolve from the registering
  container rather than the resolving scope. Classes without `@Optional` are unchanged. No `common`
  contract change and no new capability token.

- **`apps/full-stack` — a runnable React Router 8 SSR example** (M37c). The framework's full-stack
  story shipped in three places — the SSR plugin, the full-stack starter, and
  `honoe new --template full-stack` — and none of them had an application a reader could run. This
  one is served by the kernel through `react-router-plugin`, composed through
  `createFullStackAppFromConfig`, and its `smoke` task asserts that an SSR-rendered page contains
  rows **written through the database capability** — evidence that `populateLoadContext` bridges the
  kernel's service registry into a React Router loader, rather than that a server started. It then
  signs in through a `<Form>`, so the session and its synchronizer CSRF token round-trip too.

  Its routes are `/` (a landing page that reports session state), `/products` and `/login`.

  The example also makes the framework's distinguishing claim executable: `test/removal.test.ts`
  asserts that none of `lib/{session,csrf,sse,kv,service-logger}.server.ts` exists, and that
  `app/config/services.server.ts` holds no module-level cache — because the kernel's service
  registry is that cache.

  **The frontend build runs for real in CI, with no Node toolchain.** `deno install` plus the
  `@react-router/dev` CLI run the identical Vite build under Deno's own npm support (measured: ~4 s
  install, <1 s build), so no `ServerBuild` fixture is committed and `full-stack` is deliberately
  not in `ALLOW_SKIP`. No published package changed; the frontend build remains an app-level,
  build-time concern outside every published dependency graph (AI_GUIDELINES §12.2).
- **`@setu-ts/messaging-plugin`** — GCP Pub/Sub (`GcpPubSubBroker`) and Azure Service Bus
  (`ServiceBusBroker`) backends implementing `IMessageBroker` with request-reply over a shared reply
  topic + per-instance subscription. `MessagingPluginOptions` is now a **discriminated union on
  `broker`** with a `'custom'` arm (inject any `IMessageBroker`) and a default memory arm so
  `MessagingPlugin()` / `MessagingPlugin({})` remain valid. `MessagingBrokerType` widened to 8
  literals. Both cloud brokers throw `CloudBrokerUnavailableError` on Cloudflare Workers. **Verified
  against the vendors' own local emulators** — Google's Pub/Sub emulator and Microsoft's Service Bus
  emulator — covering publish/subscribe over real gRPC/AMQP, ack/nack settlement producing genuine
  redelivery, receiver teardown, and on Pub/Sub the RPC reply subscription's create/delete cycle.
  See `docs/messaging-emulators.md`. **Service Bus RPC is unverified**: that emulator supports no
  management operations, so the per-instance reply subscription cannot be created there — the suite
  asserts the refusal surfaces `ReplyInboxUnavailableError` instead. Neither backend has run against
  a live cloud account.
- **`@setu-ts/queue-plugin`** — SQS `SqsQueue` adapter (`QueueAdapter` seam, wrapped by
  `QueueService`) with per-name queue URLs, receipt-handle bookkeeping, `ApproximateReceiveCount`
  attempt ladder, visibility-timeout backoff, and dead-letter ordering. `SnsPublisher` for SNS
  fan-out. `QueueAdapterType` widened to include `'sqs'`. `QueueBackendUnavailableError` thrown on
  Cloudflare Workers. **The SQS adapter is verified against ElasticMQ** in CI (that suite drives
  `SqsQueue` directly; the `QueuePlugin` → `QueueService` wiring is covered separately by
  `sqs-arm-integration.test.ts` over a contract-honouring transport fake). SNS is fake-driven.

### Changed

- Node and Bun compatibility is now verified on every pull request, retiring the known limitation
  recorded in `0.1.0-alpha.1`. The `Node compatibility` and `Bun compatibility` CI jobs were
  placeholders blocked on the first JSR publish; they now install the published packages through
  JSR's npm compatibility layer and run `compat/compat.test.mjs`. **All 46 published packages are
  installed and imported** on each runtime — a package whose ESM output or transitive dependency
  does not resolve there is broken for every consumer and nothing else in CI would see it — and the
  suite then boots a kernel application, resolves a capability, and serves a request over a real
  socket. The expected package list is derived from the Deno workspace, so a new package that is
  never added to the compat suite fails the job rather than quietly shrinking coverage. The suite
  tracks the latest published release rather than `HEAD`, because Node and Bun cannot resolve this
  repo's `jsr:` and `npm:` specifiers from source.
- **⚠️ Breaking 1 of 1: `MessagingPluginOptions` is now a discriminated union.** A caller holding a
  widened variable (e.g. `let opts: MessagingPluginOptions = getOptions()`) must narrow before
  passing to the factory. Single-arm literals, `MessagingPlugin()`, `MessagingPlugin({})`, and the
  factory's own `= {}` default are unaffected. `MessagingBrokerType` includes `'pubsub'`,
  `'service-bus'`, and `'custom'`.
- **`@setu-ts/queue-plugin`** — the INTERNAL `QueueAdapter` seam gained a `claimToken` argument on
  `ack`/`requeue`/`deadLetter`, and `StoredJob` an optional `claimToken?`. It identifies one
  delivery, so an adapter can refuse a settle belonging to a superseded one — SQS needs this because
  a requeued message returns with a new `ReceiptHandle`. Adapters without a transport-level claim
  (memory, redis, rabbitmq) accept and ignore it. Neither type is barrel-exported, so **no published
  surface changes**; listed because it alters a contract shared by every adapter.

### Fixed

- **`@setu-ts/queue-plugin`** — the SQS backend settled nothing through `QueuePlugin`. The job
  runner passed the job id where the adapter expected the `claimToken` minted by `reserve`, so every
  `ack`/`requeue`/`deadLetter` failed its own claim check and returned without calling SQS: a
  processed job was never deleted and redelivered after each visibility timeout, forever. Adapter
  tests and the ElasticMQ e2e passed because both settle the adapter directly, supplying the token
  the real caller did not. Now covered through a real kernel application.
- **`@setu-ts/messaging-plugin`** — `ServiceBusBroker` leaked an AMQP receiver link per
  `unsubscribe()`. Teardown closed only the subscriber handle returned by `receiver.subscribe(...)`
  and never the receiver itself; it also closed the most recently opened receiver rather than the
  one being unsubscribed, so cancelling one of two subscriptions on the same topic stopped the wrong
  delivery.
- **`@setu-ts/messaging-plugin`** — `GcpPubSubBroker` and `ServiceBusBroker` constructed standalone
  with neither credentials nor an injected transport now fail at `connect()` naming the missing
  option, instead of building a client on an empty `projectId` / connection string and failing later
  inside the SDK.

- Redis-backed cache, queue, and messaging plugins now create ioredis clients with `lazyConnect`.
  Their explicit startup `connect()` call no longer fails because ioredis connected eagerly during
  construction.
- `@setu-ts/queue-plugin` — `RedisQueue.reserve()` now sends the mandatory `LIMIT` keyword in the
  `ZRANGEBYSCORE` command, so reserve works against a real Redis server. Previously the call sent
  positional offset/count arguments without the keyword, which caused Redis to return
  `ERR syntax error` on every reserve attempt.
- `@setu-ts/messaging-plugin` — `RedisStreamsBroker` now hands a timer handle back to
  `clearInterval` exactly as `setInterval` returned it. It previously stored the handle as a
  `number`, and `TimerHandle` is deliberately opaque (`unknown`), so a runtime returning an
  object-shaped handle had it coerced to `NaN` — making the cancel a silent no-op and leaking a poll
  loop that kept issuing commands after `unsubscribe()` and `disconnect()`. The bundled Node, Deno,
  and Bun runtimes were unaffected, because their handles happen to coerce to a numeric id; a custom
  `IRuntimeServices` whose handle does not coerce leaked outright.

## [0.1.0-alpha.4] — 2026-08-04

**The largest release so far: eight packages publish for the first time, bringing the scope to 46.**
The three starters (`rest-starter`, `microservice-starter`, `full-stack-starter`) ship at last,
along with `session-plugin`, `service-discovery-plugin`, `grpc-plugin`, `graphql-plugin`, and
`cloudflare-plugin`. Every other package is version-bumped so the scope stays on one version — the
CLI requires this, because `honoe new` stamps generated projects with its own version as the range
for every package it wires.

**Two changes can alter behavior you already depend on.** Both are narrow, and neither is a
capability regression, but the first is silent at compile time.

> **⚠️ Breaking 1 of 2: `@Cookie` and `parseCookies` return different values.** Cookie values are
> now percent-decoded, one layer of RFC 6265 quoting is stripped, and a repeated cookie name
> resolves to the **first** occurrence rather than the last. Nothing stops compiling, so this
> changes at runtime rather than at build time — if you were decoding values yourself after calling
> `parseCookies`, remove that step, because double-decoding will corrupt any value containing a
> literal `%`. Each difference is a defect fix; see _Changed_ for why they are being corrected
> during `0.1.x` rather than frozen.

> **⚠️ Breaking 2 of 2: `IGraphqlService` gains a required `subscribe` method.** Source-compatible
> for every caller and **breaking only for anyone who implements the interface**. The framework's
> own `GraphqlService` is the only implementor in this repository, so if you have not written your
> own GraphQL service, nothing here applies to you.

**Cloudflare is now a first-class target rather than merely a runtime that boots.** Four milestones
add KV, R2, D1, Queues, Cron Triggers, the Cache API, and Durable Objects behind typed accessors
that name a missing binding instead of handing you `undefined` — and they fixed the reason
`runtime.env` was empty on Workers, which had left `ConfigPlugin` and the secrets `EnvProvider`
reading nothing on the edge.

Alongside that: gRPC, Connect, and gRPC-Web co-served on the same port as ordinary routes; a GraphQL
plugin with subscriptions over both WebSocket and SSE; service discovery over Consul, Kubernetes,
DNS-SRV and static configuration, with load balancing and outlier ejection; cookie sessions with
form CSRF; and the starter and template work that makes all of it composable in one call.

### Added

- **GraphQL subscriptions, batching, and persisted queries** (Milestone 51b).
  `@hono-enterprise/graphql-plugin` gains two subscription transports — the `graphql-transport-ws`
  protocol over the OPTIONAL `CAPABILITIES.WEBSOCKET`, and GraphQL-over-SSE in distinct-connections
  mode over M42's `IResponse.stream()`, which needs no other plugin — plus request batching,
  Automatic Persisted Queries with server-side hash verification, and custom scalar resolvers in the
  schema-first arm.

  **Every new behaviour is opt-in.** `subscriptions`, `apq`, and `maxBatchSize` all default to off,
  so an application that upgrades without changing its options registers exactly the routes it did
  before and answers byte-identically. In particular the HTTP endpoint **still refuses a
  subscription** with `400 SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP`; subscriptions are reachable only
  on the dedicated WebSocket and SSE routes, which default to the endpoint path plus `/ws` and
  `/stream`.

  A subscription is declared in the schema-first resolver map as `{ subscribe, resolve? }` — the new
  exported `SubscriptionResolver` arm on `ResolverMap`. APQ verifies that a submitted hash matches
  the submitted document before persisting it, so a shared `ICacheStore` cannot be poisoned with a
  document under another client's hash; a mismatch answers `PERSISTED_QUERY_HASH_MISMATCH`. Resolver
  errors raised inside a live subscription are masked by the same `maskInternalErrors` path the HTTP
  transport uses.

  Three `@hono-enterprise/common` widenings: `GraphqlRequestParams.extensions` (read by APQ),
  `IGraphqlService.subscribe` with `GraphqlSubscriptionOutcome` / `GraphqlOperationContext` /
  `GraphqlConnectionInfo`, and `WebSocketRouteOptions.heartbeat` (below).

### Changed

- **`IGraphqlService` gains a required `subscribe` method** (Milestone 51b) — source-compatible for
  every CALLER, and **breaking for anyone who implements the interface**. The framework's own
  `GraphqlService` is the only implementor in this repository. An external implementation adds:

  ```typescript
  subscribe(
    params: GraphqlRequestParams,
    context?: GraphqlOperationContext,
  ): Promise<GraphqlSubscriptionOutcome>;
  ```

  The second parameter is deliberately NOT an `IRequestContext`: a WebSocket connection has none,
  and reusing `execute`'s parameter is what would hand a subscription resolver an empty service
  registry.

- **`WebSocketRouteOptions.heartbeat`** (Milestone 51b). A route may now opt out of
  `websocket-plugin`'s shared heartbeat sweep with `heartbeat: false`, which excludes its
  connections from both the payload send and the idle eviction. Defaults to `true`, so no existing
  route changes. This exists because the sweeper sends a raw text frame to every connection on every
  route: a `graphql-transport-ws` client that receives one must close with `4400`, so
  `WebSocketPlugin({ heartbeatMs })` would otherwise have broken every GraphQL subscription in the
  application. The GraphQL WS route claims the opt-out and runs its own protocol `ping`/`pong`.

- **Durable Objects: a realtime backplane and a distributed lock** (Milestone 52d).
  `@hono-enterprise/cloudflare-plugin` gains a `durableObject` arm registering
  **`DurableObjectBackplane`** under the committed `CAPABILITIES.REALTIME_BACKPLANE`, so
  `websocket-plugin` and `sse-plugin` reach clients on other replicas with no application change —
  and **`DurableObjectLock`**, which structurally satisfies `scheduler-plugin`'s `IDistributedLock`
  and is handed to `SchedulerPlugin({ distributedLock: { lock } })` (an injected lock wins outright;
  `enabled: true` is not required). No `common` change and no new capability token: both contracts
  were already committed. Register **either** this arm or `RealtimeBackplanePlugin`, never both —
  the kernel rejects two providers of one token.

  Both need a Durable Object class the **application** exports, plus a wrangler stanza; the package
  ships the behaviour as two plain cores (**`RealtimeBackplaneObjectCore`**,
  **`DistributedLockObjectCore`**) that the exported class delegates to. A mixin taking the base
  class would read better but cannot be typed without `any`, and delegation additionally keeps
  `cloudflare:workers` — unresolvable off a Worker toolchain — out of the package.

  Two platform facts shaped the implementation rather than being worked around. Sockets are accepted
  with `ctx.acceptWebSocket`, the **hibernation** API, which lets the runtime evict the object and
  re-run its constructor while connections stay open; the fan-out core therefore holds **zero**
  in-memory state and treats `getWebSockets()` as the only membership, because a `Set` in a field
  would empty itself on the first hibernation while every non-hibernating test still passed. And a
  Worker isolate cannot be relied on to hold a long-lived outbound WebSocket, so the socket opens
  lazily and reopens after any failure; the guarantee is stated rather than overstated — a
  subscription lives exactly as long as the isolate holding the members it serves, and since those
  members are client sockets in the same isolate, losing one loses both together. The lock persists
  its holder in the object's storage, never a field, because an object is evicted after 70–140
  seconds idle; correctness comes from the platform's input gate ("while a storage operation is
  executing, no events shall be delivered to the object"), which makes the read-compare-write atomic
  with no transaction. A non-2xx from the lock object **throws** rather than reporting "not
  acquired", since a 404 means the binding names the wrong class and folding that into contention
  would silently disable every scheduled job.

  Also closes the last hole in the binding-guard family: `BindingRegistry.durableObject` cast its
  binding **unvalidated**, so a missing `durable_objects` stanza or a mistyped `class_name` let an
  application boot clean and fail on the first `idFromName` with a bare `TypeError` — the defect
  M52c's review found on D1. Adds the exported **`isDurableObjectNamespace`** guard and constructor
  validation. Verified against real workerd via `wrangler dev` (12/12 checks), which also settled
  the design question the milestone could not answer from docs: **a plain Durable Object class
  without `extends DurableObject` is accepted**, so the delegation design is correct and not merely
  convenient. Not verified against a deployed Worker — CI holds no Cloudflare account.

### Fixed

- **A listen-only replica received nothing from a realtime backplane.**
  `IRealtimeBackplane.connect()` had exactly one caller — `RealtimeBackplanePlugin.register()` — and
  `websocket-plugin` / `sse-plugin` relied on the provider having connected before they subscribed.
  `subscribe()` registers a handler; it does not open a transport. Any provider that cannot connect
  at registration therefore left every replica that only listens silently receiving nothing, which a
  Cloudflare Durable Object backplane is the first transport to hit: a Worker runs `register()` at
  module scope, where the platform forbids the I/O `connect()` performs.

  Both consumers now open the transport on first local use, inside a request context on every
  runtime — `WebSocketService` when a connection joins its first room, `SseService` when a client
  connects. The call is fire-and-forget so an upgrade never waits on the transport, idempotent per
  the committed contract, and retried on the next join if it fails. Applications registering
  `RealtimeBackplanePlugin` are unaffected: its provider still connects at registration, and the
  extra call is a no-op.

- **Cloudflare D1 as a first-class database backend, and the `common` data-access promotion that
  made it possible** (Milestone 52c). The seam a database backend implements was `IDatabaseAdapter`,
  declared **inside** `@hono-enterprise/database-plugin` and never exported, while `common` shipped
  only the lifecycle-shaped `IOrmAdapter` — so a backend living in any other package was literally
  inexpressible, because AI_GUIDELINES §2.2 forbids one plugin importing another.
  `@hono-enterprise/common` now exports **`IDatabaseAdapter`, `IAdapterTransaction`, `IDataSource`,
  `NormalizedQuery` and `OrderDirection`**. The promoted port is the old shape plus one member — a
  non-transactional `createDataSource(entity)` — and that addition is the substance of the change:
  the plugin previously reached each adapter's data-source factory by **casting to the concrete
  class**, which is what actually kept the seam closed. That cast is gone, all three built-in
  adapters carry `createDataSource`, and `createDataSourceForEntity` is **deprecated, not removed**
  (§9.2). `DatabasePluginOptions` is now a union discriminated on `type` with a **`'custom'` arm**
  requiring an `adapter`, so registering an external backend without one is a compile error rather
  than a startup throw; every existing registration compiles unchanged. `DataSource` is retained as
  a deprecated alias of `IDataSource`. The promotion also repairs a latent public-API defect: the
  barrel exported `DataSource`, whose `findAll` parameter is `NormalizedQuery`, while
  `NormalizedQuery` itself was not exported — no consumer could name the type.

  `@hono-enterprise/cloudflare-plugin` gains **`D1Adapter`** (plus `D1AdapterOptions`,
  `D1EntityMapping`), constructed by the application from its D1 binding and handed to
  `DatabasePlugin({ type: 'custom', adapter })` — the `KvSessionStore` precedent, since those plugin
  options are read before any application exists. **D1 has no interactive transaction**: it rejects
  `BEGIN TRANSACTION` outright, and `batch()` is its only unit of atomicity. `beginTransaction()`
  therefore **buffers every write and flushes the whole buffer as one `batch()` at commit**;
  `rollback()` discards it and sends nothing. Atomicity is genuine, and the two costs are documented
  and tested rather than left to discovery: there is **no read-your-own-writes** inside a
  transaction (reads run against committed state), and an in-transaction `create()` **requires an
  explicit primary key**, throwing `CloudflareUnsupportedError` when absent — a deferred `INSERT`
  cannot report a generated key to a caller that awaits `create()` before the flush. Outside a
  transaction `create()` uses `RETURNING *` and returns the real persisted row. Values are always
  bound (`?N`); identifiers cannot be, so table and column names are validated against
  `[A-Za-z_][A-Za-z0-9_]*` and double-quoted, and every builder refuses a statement that would
  exceed D1's documented **100-bound-parameter** limit. Not verified against live D1 — CI holds no
  Cloudflare account — though the whole surface is driven against a real SQLite engine, the engine
  D1 runs, including batch rollback.

- **Cloudflare Queues, Cron Triggers, and the Cache API in `@hono-enterprise/cloudflare-plugin`**
  (Milestone 52b) — the three platform features that need a **module-level handler export** from the
  application's Worker rather than anything reachable through `fetch`. No `common` change and no new
  capability token. `WorkersQueue` satisfies the committed `IQueue` over a Queues producer binding,
  opt-in through a `queue` arm and registered under `CAPABILITIES.QUEUE` (or `queue.<name>`); the
  job's **name and id travel in a `{ v, name, id, data, maxAttempts? }` envelope**, because a
  Cloudflare message body is arbitrary JSON carrying neither and `producer.send()` resolves to
  `void`, so the id `add` returns is the id the processor sees as `job.id`.
  `createQueueHandler(app)` builds the `queue` export. A message whose body is not a readable
  envelope, or whose name has no processor, is **retried rather than acked** — acking would discard
  it permanently and silently, the failure a queue exists to prevent — and
  `AddJobOptions.maxAttempts` is enforced at dispatch, since Cloudflare's `max_retries` is
  queue-wide configuration rather than per message. `addRecurring` throws, naming Cron Triggers as
  the platform's own mechanism. Cron Triggers ship as `WorkersCron` plus
  `createScheduledHandler(cron)`, and **deliberately do not register `CAPABILITIES.SCHEDULER`**: of
  `IScheduler`'s eight methods only `cron` is expressible on Workers — `every` and `delay` arm
  timers across an isolate eviction (the same reason `scheduler-plugin` cannot run there),
  `pause`/`resume`/`remove` need state that does not survive an invocation, and `getNextRun` is
  owned by the `wrangler.toml` `[triggers]` block. An implementation where six of eight methods
  throw would violate Liskov substitution, so a small honest surface was chosen instead. An
  expression is matched against `ScheduledController.cron` **exactly**, and `expressions()` exists
  so an application can assert its own coverage against `wrangler.toml`, which no code in the
  process can read. `cacheApiMiddleware` caches responses in `caches.default`. It is a **different
  layer** from `cache-plugin`'s `cacheMiddleware` and composes with it, so it reports under
  **`X-Cache-Api`** rather than `X-Cache`. The platform's own refusals — non-GET, status 206,
  `Vary: *`, and an uncleared `Set-Cookie` — are checked first through the pure exported
  `assessCacheability` rather than discovered from a thrown `put`; the 206 and `Vary: *` rules are
  unconditional, because an operator may legitimately configure `cacheableStatuses: [200, 206]` and
  only the explicit rule then stops the platform throwing. The write rides
  `ICloudflareBindings.waitUntil` when the plugin is registered and is awaited inline when it is
  not, so it is never simply abandoned; with no cache handle at all the middleware passes through
  rather than throwing, so an application composed for several targets still serves off Workers. A
  HIT is replayed with `IResponse.stream`, so a cached response of any size reaches the client
  unbuffered — which means `app.inject()` cannot read it and cached routes are tested with
  `app.fetch`. `caches.default` is **per-datacenter**: a latency optimisation, not a shared store.
  D1 as a database backend moved to **Milestone 52c** (it needs the `IDatabaseAdapter` seam promoted
  from `database-plugin` into `common`, plus reconciling `ITransaction` with D1's batch-only
  atomicity) and Durable Objects to **Milestone 52d** (both the realtime backplane and the
  distributed lock need the application to export a DO class, and Durable Objects expose no pub/sub
  primitive, so a backplane means each replica holding a WebSocket to the object).

- **`@hono-enterprise/cloudflare-plugin`** (Milestone 52) — a new package registering
  `ICloudflareBindings` under a new `CAPABILITIES.CLOUDFLARE` token. The framework has served
  traffic on Workers since the Hono migration but could not reach a single platform binding; this
  publishes them as one typed accessor (`kv`, `r2`, `d1`, `queue`, `service`, `durableObject`,
  `get<T>`, `vars`, `waitUntil`), and optionally serves the committed cache and storage capabilities
  from KV and R2. **Zero npm dependencies**, and nothing in the package imports `cloudflare:workers`
  — the application passes `env` (and `waitUntil`) in, which keeps the package type-checkable on
  every runtime. `KvCacheStore` reconciles `ICacheStore`'s unbounded TTL with KV's 60-second
  `expirationTtl` floor by carrying a logical deadline inside the value, so a 5-second entry expires
  in 5 seconds rather than surviving a minute. The decoder reports three outcomes rather than two —
  live, _this store's_ expired entry, and neither — so a read never deletes a key the store does not
  own and a deliberately cached `null` survives; `clear()` additionally requires a key prefix,
  because the binding has no bulk delete and an unprefixed sweep would remove foreign keys.
  `R2Storage` implements the optional `getStream`, heads before `delete` so its committed
  `Promise<boolean>` is honest, and **throws** from `getSignedUrl` — the R2 Workers binding has no
  presign operation. `KvSessionStore` is constructed by the application and handed to
  `SessionPlugin({ store })`, since that option is read before any application exists. No binding
  I/O happens at registration, where the platform forbids it, and the `cloudflare` health indicator
  performs none either.
- **`splitWorkerEnv` and `SplitWorkerEnv` in `@hono-enterprise/common`** (Milestone 52) — the pure
  partition of a Workers `env` record into string variables and object bindings. In `common` because
  both `runtime` and `cloudflare-plugin` need the identical rule and no plugin may import another.

- **`@hono-enterprise/service-discovery-plugin`** (Milestone 50) — a new package registering an
  `IServiceDiscovery` under a new `CAPABILITIES.SERVICE_DISCOVERY` token, so an application can turn
  a logical service name into a reachable address. Five provider arms — `'static'`, `'consul'`,
  `'kubernetes'` (EndpointSlices), `'dns'` (`SRV` and address records), and `'custom'` — behind one
  `DiscoveryProvider` port, with the option type a **union discriminated on `provider`** so a
  missing per-arm credential is a compile error rather than a startup throw. Zero npm dependencies:
  the HTTP providers run on web-standard `fetch` and the DNS provider on the new optional
  `IRuntimeServices.dns`. Adds a monotonic-clock read-through cache with per-service in-flight
  coalescing and stale-on-failure; push-based `watch()` over Consul blocking queries (both
  documented index hazards handled — a backwards index resets to zero, an index of `0` becomes `1`
  to avoid busy-looping older servers) and Kubernetes watch streams (used as a change **signal**
  rather than a delta log, with `410 Gone` resync); three balancing strategies over
  `IRuntimeServices.randomBytes`; and outlier ejection with a panic-threshold cap and an all-ejected
  fallback. Ejection is deliberately **not** a second circuit breaker: `wrap` breaks a call site,
  ejection removes a pool member while the call site stays open.
- **`IServiceDiscovery`, `ServiceInstance`, `PickOptions`, `LoadBalanceStrategy`, `ServiceOutcome`
  and `CAPABILITIES.SERVICE_DISCOVERY` in `@hono-enterprise/common`** (Milestone 50) — the contract
  a consumer types the resolved capability as, without importing the plugin.
- **`IRuntimeServices.dns?: IDnsResolver`** and `SrvRecord` in `@hono-enterprise/common`, with
  `createNodeDnsResolver` (Node + Bun, over `node:dns/promises`) and `createDenoDnsResolver` (over
  `Deno.resolveDns`) exported from `@hono-enterprise/runtime` (Milestone 50). Purely additive,
  following the `fs?` / `workers?` precedent; **Cloudflare Workers omits the key entirely**, since
  its network access is `fetch`, which resolves names internally and exposes no lookup surface.
  `SrvRecord.host` is a normalized name on purpose — Deno spells the field `target`, Node spells it
  `name`, and passing either through unchanged would type-check on both runtimes while producing
  `undefined` hostnames on one.
- **`ILifecycleApi.onStopping`** in `@hono-enterprise/common` and `@hono-enterprise/kernel`
  (Milestone 50) — a new lifecycle phase running at the very start of `stop()`, **before** the
  application begins refusing new requests and before the socket closes. It is the only hook that
  fires while the application is still serving normally, which is what makes it correct for
  deregistering from a service registry: doing that in `onShutdown` leaves callers routed at a
  closed port for up to one health-check interval on every rolling deploy. Listed under Added rather
  than Changed because no existing behavior moves — `Application.#doStop()` skips the phase entirely
  when no hook is registered, so `stop()` is byte-for-byte unchanged for every application that does
  not opt in. (Awaiting an already-resolved promise instead would still defer when the shutting-down
  flag flips, handing a 404 to a request that used to get a 503 — a pre-existing kernel test caught
  exactly that.)

- **`honoe new --template full-stack`** (Milestone 36c) — scaffolds a React Router 8 SSR
  application: the `routes → features → services → models` layering, `flatRoutes` `_app`/`_auth`
  layout groups, the `~/*` alias, the `.server.ts` convention, one worked feature, and the Vite
  build files. What it deliberately does **not** emit is as important as what it does: no
  `lib/session.server.ts`, `lib/csrf.server.ts`, `lib/sse.server.ts`, `lib/kv.server.ts` or
  `lib/service-logger.server.ts`, because those are the session, SSE, secrets and logger
  capabilities, reached through the service registry the SSR plugin attaches to every request. The
  session reaches loaders through a context key the **application** declares and
  `populateLoadContext` fills, so no plugin imports another. Every runtime target is supported;
  Cloudflare Workers omits `assetsDir` and leaves assets to the platform binding. This is the only
  template that composes through a starter rather than inline wiring — its plugin set is twenty-two,
  and a generated file a human is meant to edit should not open with twenty-two imports they did not
  choose.
- **`contextKeyFor` in `@hono-enterprise/react-router-plugin`** (Milestone 36c) — creates React
  Router context keys by name, memoised, so the same name always yields the same object. Keys are
  matched by identity, and in a framework-mode application the module declaring them exists twice:
  Vite inlines application modules into the server build, while the runtime loads `honoe.config.ts`
  from source. Two hand-written `{ defaultValue }` literals then match nothing, and every read
  silently returns the default — a session that is always `null`, a CSRF token that is always empty,
  with no error raised. Requires the server build to treat `@hono-enterprise/*` as external
  (`environments.ssr.build.rollupOptions.external`), which the `full-stack` template configures. The
  `serverBuildPath` JSDoc now also states that the path must be **absolute**: the loader does
  `await import(serverBuildPath)`, so a relative specifier resolves against the plugin's own module
  and can never find the application's build.
- **`createFullStackAppFromConfig` in `@hono-enterprise/full-stack-starter`** (Milestone 36c) —
  `(build: (config: IConfig) => FullStackStarterOptions, options?: FromConfigOptions) =>
  Promise<IKernelApplication>`,
  where `FromConfigOptions` carries `config` (loading options) and `env`. **`env` is required on
  Cloudflare Workers**, where bindings arrive per request rather than process-wide, so without it
  the application composes from an empty configuration and fails on every request; the `full-stack`
  template threads the handler's `env` through automatically. Plugin options must be decided before
  the plugins are constructed, which is before `ConfigPlugin` has registered anything; this loads
  configuration once, hands the snapshot to the resolver, and passes that same object into the
  application, so the values the composition branched on are the values handlers read. It applies to
  every option uniformly, which is why no plugin option carries a `urlFromConfig`-style config-key
  field — such a field would need its value at the same impossible moment. Secrets remain out of
  reach by construction: they are served by a plugin that exists only after registration.
- **`loadConfig` and `ConfigPluginOptions.instance` in `@hono-enterprise/config-plugin`** (Milestone
  36c) — `loadConfig(runtime, options?)` is the same implementation `ConfigPlugin` registers,
  reachable without an application; `instance` registers a supplied snapshot verbatim, reading
  nothing from the environment. `ConfigPlugin.register` now delegates to `loadConfig`, so merging,
  expansion, and validation cannot drift between the two paths.
- **`createRuntimeServices` in `@hono-enterprise/runtime`** (Milestone 36c) — builds
  `IRuntimeServices` for the detected platform without an application. The barrel previously
  exported `detectRuntime` and four per-platform factories but nothing joining them, so the platform
  → adapter map was unreachable outside `RuntimePlugin.register`; that method now delegates here,
  leaving one implementation behind two entry points. `RuntimeAdapterFactories` and
  `CreateRuntimeServicesOptions` are exported alongside it.
- **Gated `session` arm on the three starters** (Milestone 36c) — `RestStarterOptions.session`
  registers `SessionPlugin`, inherited by the microservice and full-stack tiers. M48 shipped after
  the starters, so no tier could previously register a session at all. Gated because the plugin
  throws during `register()` without an adequate secret; **no default changes**.
- **Parameter-level `@Inject` in `@hono-enterprise/decorator-plugin`** (Milestone 36b) — `Inject`
  now works on a constructor parameter as well as on the class, binding one token to that argument
  by position, which is the form a developer arriving from NestJS expects:
  `constructor(@Inject(CAPABILITIES.DATABASE) private db: IDatabase) {}`. The class-level positional
  list is **deprecated, not removed** (AI_GUIDELINES §9.2) and keeps working for the whole `0.x`
  line. A token is still always required — inferring it from the parameter's type needs
  `emitDecoratorMetadata`, which Deno does not support — so three ambiguous cases throw at startup
  rather than misinjecting silently: mixing the two forms on one class, leaving a constructor
  parameter undecorated below the last injected one, and applying `@Inject` to a _method_ parameter.
- **Gated `realtime` and `di` arms on the three starters** (Milestone 36b) — `realtime` groups
  `websocket`, `sse`, and `backplane` sub-arms; `di` adds `DiPlugin`. Added to `RestStarterOptions`,
  so the microservice and full-stack tiers inherit them. **No default changes**: with no arm
  supplied the plugin set of all three tiers is byte-identical to the previous release. Supplying
  `di` does change how decorated services are constructed (`DecoratorPlugin` switches to its
  container path), which is why it is opt-in. `RealtimeArm` is exported from all three starter
  barrels.
- **`honoe new --template nest`** (Milestone 36b) — the REST plugin set plus `DiPlugin`, an
  `@Injectable` service, and a `@Controller` using parameter-level `@Inject`. Emits inline wiring
  like the other templates, and refuses no runtime target.
- **`Wiring.args`, `TemplateDefinition.localImports`, and `TemplateDefinition.files` in
  `@hono-enterprise/cli`** — the template contract could previously express neither a plugin call
  argument nor an extra emitted source file. All three are optional and every existing template
  renders byte-identically (`args` absent → `Symbol()`).
- **`@hono-enterprise/session-plugin`** (Milestone 48) — cookie-backed sessions and session-backed
  form CSRF, registering an `ISessionService` under the new `CAPABILITIES.SESSION` token. The
  default is a self-contained encrypted cookie (AES-256-GCM under an HKDF-SHA256 derived key,
  entirely through `runtime.subtle`), so the package has **zero npm dependencies** and works on
  Cloudflare Workers. Setting `store` (`'memory'`, `'cache'`, or a custom `ISessionStore`) moves the
  payload server-side and leaves an opaque id in the cookie, which is what makes immediate
  revocation possible. Secret rotation goes through a key list — index 0 seals, every entry opens —
  with an HKDF-derived non-secret `kid` in the envelope so opening is a lookup rather than trial
  decryption. Ships `getSession`, `getCsrfToken`, `verifyCsrfToken`, `csrfFormMiddleware`,
  `sessionMiddleware`, both stores, and four error types. Note that `mode: 'sign'` protects
  integrity only and leaves the payload readable by the client; `'encrypt'` is the default so that
  choice is never accidental.
- **`parseCookie` / `serializeCookie` / `CookieAttributes` in `@hono-enterprise/common`** — the
  framework's single cookie codec. It lives in `common` because the session plugin and the decorator
  plugin's `@Cookie` both need it and no plugin may import another (the `encodeFrameData`
  precedent).
- **`ISessionService` / `ISession` / `ISessionStore` / `SessionData` contracts** and
  `CAPABILITIES.SESSION` in `@hono-enterprise/common`. No `IRequest` widening was needed: the
  session middleware parks the session in `ctx.state`, so a `cookies` field with no consumer was
  declined.
- **`scalingNotice` option on `WebSocketPluginOptions` and `SsePluginOptions`** (`boolean`, default
  `true`) — set `false` to silence the startup notice described below, for a deployment where you
  have decided single-replica fan-out is correct and do not want the line on every boot. It
  suppresses the message only: room and channel delivery are identical either way, and the notice
  never appears once a backplane is registered.

### Changed

- **`runtime.env` is now populated on Cloudflare Workers** (Milestone 52). `RuntimePlugin` and
  `createRuntimeServices` gain an `env` option; passing the Worker's `env` makes `ConfigPlugin` and
  the secrets `EnvProvider` work on the edge, where previously they read an empty record. Only
  **string** entries reach `runtime.env`, which is contracted as a string record — object bindings
  are filtered out rather than stringified to `[object Object]`. Behaviour on Deno, Node, and Bun is
  unchanged; the option is ignored there.
- **`honoe new --runtime cloudflare-workers`** (Milestone 52) now threads `env` from the `fetch`
  handler into `createApp(env)` and renders `RuntimePlugin({ env })` on that target, bumps the
  scaffolded `compatibility_date` to `2025-09-01` (`import { waitUntil } from 'cloudflare:workers'`
  shipped 2025-08-08, so the previous `2024-09-23` could not import it), and emits commented
  `[[kv_namespaces]]` / `[[r2_buckets]]` stanzas in `wrangler.toml`. Generated output for the Deno,
  Node, and Bun targets is unchanged.

- **`DecoratorPlugin` now prefers the DI container for any class registered in it, with or without
  `@Injectable`.** `instantiate()` required service metadata before consulting the container, so a
  `@Controller` — which carries no `@Injectable` — took the service-registry path even in an
  application with `DiPlugin`, where its dependencies live in the container and not the registry,
  and construction failed outright with "No service registered for capability". The guard
  contradicted the function's own documented behavior. Reachable before this release only for a
  controller whose constructor took arguments; parameter-level `@Inject` makes that composition
  ordinary, which is how it surfaced.
- **`decorator-plugin`'s exported `parseCookies` now delegates to `common`'s `parseCookie`, which
  changes its output in three cases.** The signature is unchanged and no call site needs editing,
  but the values it returns can differ, so read this if you use `@Cookie` or call `parseCookies`
  directly. Each difference is a defect fix rather than a preference:
  - **Values are percent-decoded.** A cookie written by any standards-compliant server (including
    this framework's own `serializeCookie`) was previously returned still-encoded — `@Cookie('x')`
    handed you `a%20b` where the value was `a b`. If you were decoding the result yourself, remove
    that step; double-decoding will now corrupt a value containing a literal `%`.
  - **One layer of RFC 6265 quoting is stripped**, so `sid="abc"` yields `abc` rather than `"abc"`.
  - **A repeated cookie name resolves to the first occurrence, not the last.** Browsers send the
    most specific cookie first, so the first is the one that was meant.

  The alternative was two cookie parsers in the tree, which AI_GUIDELINES §11.1 forbids. Shipping
  the correction during `0.1.x` pre-release rather than freezing the defect follows the precedent of
  the Milestone 14d wire change and the Milestone 30b FCM replacement.

- **`websocket-plugin` and `sse-plugin` now say at startup that rooms and channels are
  process-local** when no realtime backplane is registered — one `info` line naming the limitation,
  the plugin that lifts it, and the transport it needs (`'redis'` or `'messaging'`; the backplane
  plugin's default `'memory'` transport is a single-process bus, so registering it bare would
  silence the notice without fanning anything out). Cross-replica fan-out has shipped since
  `0.1.0-alpha.3`, but a single-replica app and a three-replica app behave identically right up to
  the point where two thirds of your clients silently stop receiving broadcasts, with no error
  raised anywhere. Both READMEs gain a **Scaling beyond one replica** section for the same reason.
  If you run a single replica the line is informational and safe to ignore; registering a backplane
  under the `REALTIME_BACKPLANE` token removes it.

### Fixed

- **`DatabasePlugin({ options: { logQueries: true } })` threw on every repository call whenever a
  real logger was registered** (found in Milestone 52c). `resolveLogger` extracted `logger.debug`
  into a local and invoked it **detached**, so `this` was `undefined` at the call. Both loggers
  `logger-plugin` ships — `ConsoleLogger` and `PinoLogger` — implement `debug` in terms of a private
  `#` field, and a private-field access on an unbound method throws `TypeError`, so the documented
  `logQueries` option could not be used at all with `LoggerPlugin` present. Every existing test
  injected a plain-object logger, where a detached method works fine, which is exactly why no gate
  saw it. `cache-plugin` carries a regression test for the identical bug; `database-plugin` now has
  one too, driving the real `ConsoleLogger` through a running kernel application.

- **Every application failed to boot on Cloudflare Workers** — `packages/kernel`'s request-context
  factory built its never-aborting `ctx.signal` sentinel from a **module-scope**
  `new AbortController()`. workerd refuses that with
  `Disallowed operation called within global
  scope`, because an `AbortController` is bound to an
  I/O context, so the isolate threw at import time and no handler ever ran. Introduced with
  `IRequestContext.signal` in Milestone 42 and invisible to every gate: the whole suite runs on
  Deno, where a module-scope controller is legal, and the Workers path had only ever been exercised
  through `app.fetch` under Deno rather than under the real runtime. Found by driving the framework
  under `wrangler dev` (workerd) for the first time. The sentinel is now constructed **per
  request**; caching one lazily would not have been a fix either, since workerd then refuses to use
  a controller created for one request on behalf of another. A regression test pins that two
  contexts never share a fallback signal — it fails against the previous code.
- **`@hono-enterprise/cloudflare-plugin` queue reporting reaches a logger registered after the
  plugin** (Milestone 52b) — `WorkersQueueOptions.logger` is a thunk rather than an `ILogger`, for
  the reason `resolveWaitUntil` already takes one: `ctx.logger` resolves lazily through a Proxy that
  answers `undefined` until a logger is registered, and a capability may be registered imperatively
  with no `provides` declaration for the resolver to order against. Capturing the value during
  `register()` would silence every dispatch report in an application whose logger registers later.

- **`honoe new` now refuses a project plan containing the same path twice** (Milestone 36c). The
  overwrite check probes the filesystem, so it could not see a duplicate inside one plan: both files
  were written and the last silently won. A template emitting `deno.json` would have overwritten the
  framework manifest with no warning.
- **The CLI drift gate resolved starter packages to the wrong directory** (Milestone 36c). It mapped
  `@hono-enterprise/<name>` to `packages/<name>`, but the three starters live under
  `packages/starters/`, so any template importing one could not be type-checked. It also rewrote
  every import-map entry, mangling a template's project-local alias (`~/`) into a package path.
- **`websocket-plugin`'s README no longer claims cross-replica fan-out is unimplemented.** It stated
  "fan-out across replicas is a follow-up milestone; today two instances behind a load balancer do
  not share rooms", which stopped being true when `realtime-backplane-plugin` shipped in
  `0.1.0-alpha.3`.
- **`sse-plugin`'s README named a method that does not exist.** Its named-channels example called
  `channel.broadcast(...)`; the committed `SseChannel` contract exposes `publish(...)` and no
  `broadcast`, so the snippet would not compile.
- **`realtime-backplane-plugin`: `RedisBackplane.connect()` no longer leaks a connection on a failed
  open, and is safe to call concurrently.** The connected guard was only set after both connections
  had been constructed, so two overlapping calls each built their own pair — and if the second
  construction threw, the first connection was already live with nothing holding a reference to
  close it. The open is now memoized, so overlapping callers join one attempt and none of them
  returns before `SUBSCRIBE` has actually landed; a failed attempt quits whatever it built, removes
  its own listener from injected clients but does not close them (they belong to the caller), and
  clears the memo so a later call retries. A `close()` arriving mid-open now wins as well: the open
  retires whatever it built instead of publishing two live connections onto a backplane that has
  already shut down, which is what a shutdown during startup would otherwise strand.
  `RealtimeBackplanePlugin` calls `connect()` exactly once and `close()` only from `onClose`, so no
  application behavior changes — this closes the seam for callers driving the transport directly.

### Known limitations

**The Cloudflare surface has not been verified against a deployed Worker.** CI holds no Cloudflare
account, so nothing in the pipeline reaches the platform. It was driven against real **workerd** via
`wrangler dev` during development — Queues with a real `MessageBatch`, a real `ScheduledController`,
`caches.default`, KV, R2, D1, and both Durable Object classes including a real `WebSocketPair`
upgrade and the storage input gate — and that harness is what caught a kernel defect that broke
every application on Workers (fixed here). But those runs were manual and the harness is not
committed, so treat the edge story as well-exercised rather than continuously gated, and verify
against your own account before you depend on it.

**FCM push still has not been exercised against live FCM**, unchanged from `0.1.0-alpha.3`. The HTTP
v1 request is asserted field by field and its RS256 assertion is signed and verified with real Web
Crypto, but no test reaches Google.

**D1 transactions are deferred batches, with two consequences worth knowing before you use them.**
D1 rejects `BEGIN TRANSACTION` outright and `batch()` is its only unit of atomicity, so writes
buffer until commit and flush as one batch. Inside a transaction there is **no
read-your-own-writes** — reads see committed state — and `create()` **requires an explicit primary
key**, because a deferred insert cannot report a generated key to a caller awaiting it before the
flush. Both are documented in PUBLIC_API.md and covered by tests; neither applies outside a
transaction.

All 46 packages are live on JSR at `0.1.0-alpha.4`, published by CI from the tag.

Verified after publishing by querying every package on the registry, then installing `kernel` and
`runtime` from JSR into a throwaway directory — not the workspace, whose import map resolves locally
and would mask a broken published dependency — and serving a request (`200 {"ok":true}`). `common`
resolved transitively at `0.1.0-alpha.4`, which is the only real evidence that the cross-package
specifier bump landed inside the published tarballs: a dry run resolves those from the workspace and
so cannot show it.

Every package also carries a description and runtime-compat flags for the first time. Neither
setting lives in a published version — `deno publish` never touches them — so all 46 pages had shown
an empty description and "Compatibility unknown" through four releases. They are now set from
`scripts/jsr-metadata.ts` and reapplied by `deno task release:set-metadata`, which is idempotent and
refuses to run when a published package has no entry.

### Installing

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.4
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.4/main
```

Within 24 hours of a release, Deno's minimum-dependency-age policy refuses the version unless you
pass `--min-dep-age 0`.

## [0.1.0-alpha.3] — 2026-07-30

**Two breaking changes ship in this release.** Both are narrow, but you meet them in production
rather than in this file, so they are stated here in full and again under _Changed_.

> **⚠️ Breaking 1 of 2: brokered request-reply changes on the wire.** `request()`/`respond()` move
> from `<topic>` to a derived `rr.req.<topic>` channel, so a responder running `0.1.0-alpha.2` and a
> caller running this version **will not talk to each other**. RPC callers and responders must be
> restarted together, not rolled one at a time. Fire-and-forget `publish`/`subscribe` are
> unaffected, as is every other plugin. If you do not use `request`/`respond`, nothing here applies
> to you.

> **⚠️ Breaking 2 of 2: the FCM push channel takes service-account credentials.**
> `FcmProviderOptions.serverKey` is **replaced** by `{ projectId, clientEmail, privateKey }`, so
> existing config stops compiling. That is deliberate rather than a deprecation: `serverKey`
> addressed the legacy endpoint Google switched off in 2024, so every push sent through it already
> failed. A compile error is the only honest signal. If you do not configure a `push` channel,
> nothing here applies to you.

**Kafka gains request-reply, and five of the known limitations recorded against `0.1.0-alpha.1` are
closed.** Every entry below was a real capability gap rather than a documentation problem, so each
is fixed in code; the alpha.1 list annotates them in place rather than deleting them, because that
section records what was true of that release.

Kafka was not the reason Kafka lacked request-reply: the shared request-reply core minted its own
inbox topic and imposed it on every broker, which only works where topics are cheap and
per-instance-addressable. Brokers now supply their own reply inbox, so Kafka can read a shared reply
topic under a per-instance consumer group instead. The same seam is where a future native AMQP
`replyTo` or NATS JetStream reply-subject transport would plug in. Two defects in the M14c
implementation are fixed alongside it, both consequences of RPC sharing a topic with ordinary
pub/sub.

Alongside that, WebSocket rooms and SSE channels gain cross-replica fan-out, `feature-flags-plugin`
gains a LaunchDarkly provider, and `resilience-plugin` timeouts finally cancel the work they bound.

### Added

- **Kafka now supports brokered request-reply.** `KafkaBroker.request`/`respond` previously rejected
  outright; all five brokers are now reply-capable. Replies travel on a shared reply topic — the new
  `replyTopic` option, default `'messaging.replies'` — read by a consumer group unique to each
  broker instance, so delivery is exclusive to the caller rather than load-balanced across the
  shared default group. **The reply topic must already exist**: `IKafkaFactory` exposes no admin
  surface, so the broker creates no topics. Every instance receives every reply and discards those
  it did not originate; give a high-traffic service its own `replyTopic` to bound that fan-out.
- Each broker now supplies its own reply inbox through an internal seam, rather than having a topic
  string imposed on it by the shared request-reply core. The four brokers that were already
  reply-capable pass a shared helper and are behaviourally unchanged.
- **`notification-plugin` push delivery works again, on FCM HTTP v1.** `FcmProvider` now posts to
  `/v1/projects/{projectId}/messages:send` with an OAuth2 bearer token minted from a service
  account: it signs an RS256 JWT assertion with `runtime.subtle` and caches the token until shortly
  before expiry, so a send costs one request in the steady state. Zero npm dependencies and
  Workers-portable, like the other HTTP providers. A new `FcmTokenSource` export lets you source
  tokens elsewhere (a GCP metadata server, a key-holding broker) instead of from a local key.
- **`@hono-enterprise/realtime-backplane-plugin`** — cross-replica fan-out for WebSocket rooms and
  SSE channels. It registers an `IRealtimeBackplane` under the new `CAPABILITIES.REALTIME_BACKPLANE`
  token, which `websocket-plugin` and `sse-plugin` resolve **optionally** — so adding the plugin is
  the entire change needed to make `ws.room('lobby')` and `sse.channel('news')` reach clients on
  other replicas, and removing it restores in-process behavior with no application change. Four
  transports: `'memory'` (the default, and a real single-process bus rather than a no-op),
  `'messaging'` (over whatever broker is registered under `CAPABILITIES.MESSAGING`, reusing all five
  existing brokers with no new dependency), `'redis'` (pub/sub over an inject-or-lazy `ioredis`),
  and `'custom'`.

  > **Correction, made in `0.1.0-alpha.4`.** "Adding the plugin is the entire change needed" is
  > wrong, and the sentence is left in place because this section records what the release said.
  > `RealtimeBackplanePlugin()` defaults to `transport: 'memory'`, a **single-process** bus, so
  > registering it bare fans nothing out across replicas. You must also choose `'redis'` or
  > `'messaging'`. The memory-default caveat did appear two sentences later, but the headline is
  > what a reader acts on. The same looseness was corrected in the plugin log messages and both
  > plugin READMEs by PR #102; this was the last remaining copy.
- **A LaunchDarkly provider** for `@hono-enterprise/feature-flags-plugin`
  (`provider: 'launchdarkly'`), plus an optional `IFeatureFlags.isEnabledAsync` for callers that can
  await an answer carrying no cold-context caveat.
- **Real cancellation** in `@hono-enterprise/resilience-plugin`: `wrap` hands the protected call an
  `AbortSignal`, and the returned callable accepts an optional caller-owned one.
- **`@hono-enterprise/sdk`** — the client SDK publishes for the first time. Together with the
  realtime backplane above, that brings the published total to **38 packages**. A portable,
  zero-npm-dependency HTTP client for consuming a Hono Enterprise API from a browser or a server:
  `createClient()` returns an `IHttpClient` with one `request<TResponse, TBody>()` method, plus
  bearer and API-key request-interceptor factories, request/response interceptors, retry with
  fixed/exponential backoff honoring a delta-seconds `Retry-After`, a rolling-window circuit
  breaker, and a sliding-window rate limiter. Both the transport (`fetch`) and time
  (`IClientTiming`) are injectable seams, so nothing needs a network or a real clock to test. It
  registers no plugin and resolves no capability token — its only in-repo import is type-level from
  `@hono-enterprise/common`, which re-exports `RetryPolicy`, `CircuitBreakerPolicy`, and
  `BackoffStrategy` through the SDK barrel so consumers need not depend on `common` directly.
  `generateOpenApiClient(document, options?)` is a pure function turning an OpenAPI 3.1 document
  into type-checked TypeScript client source; it throws `OpenApiCodegenError` with the offending
  path and method rather than emitting a client that misbehaves or will not compile.

### Changed

- **BREAKING: `FcmProviderOptions.serverKey` is replaced by service-account fields.** The push
  channel now takes `{ projectId, clientEmail, privateKey }` (or a `tokenSource`) instead of
  `serverKey`. This is not a deprecation: `serverKey` addressed an endpoint Google switched off in
  2024, so every send through it already failed. Existing config becomes a compile error, which is
  the intended signal.

  ```typescript
  // Before — never reached a live endpoint
  push: { provider: 'fcm', options: { serverKey: config.get('FCM_SERVER_KEY') } }

  // After — values come from the service-account JSON
  push: {
    provider: 'fcm',
    options: {
      projectId: config.get('FCM_PROJECT_ID'),
      clientEmail: config.get('FCM_CLIENT_EMAIL'),
      privateKey: config.get('FCM_PRIVATE_KEY'),
    },
  }
  ```

  A `push` channel using the default signer now needs `CAPABILITIES.RUNTIME` (for Web Crypto and the
  clock) and throws during `register` without it, rather than failing on the first notification.
- **BREAKING (wire format): request-reply traffic moved to a derived channel.** `request(topic, …)`
  now publishes to, and `respond(topic, …)` subscribes to, `rr.req.<topic>` instead of `<topic>`. A
  `0.1.0-alpha.2` responder and a later requester **do not interoperate** — during an upgrade,
  restart RPC responders and callers together rather than rolling them one at a time.
  Fire-and-forget `publish`/`subscribe` are unaffected.
- **`IResilienceService.wrap` and `ICircuitBreaker.execute` widened.** `wrap<T>` now takes a
  `ResilientCall<T>` (`(signal: AbortSignal) => Promise<T>`) and returns a `HardenedCall<T>`
  (`(signal?: AbortSignal) => Promise<T>`). **Source-compatible for callers** — a zero-argument
  `() => Promise<T>` is still accepted and `await guarded()` still works — but **breaking for
  implementors**, because `fn` sits in a contravariant position, so an object literal declaring
  `wrap<T>(fn: () => Promise<T>)` no longer satisfies the interface. Implementors add the parameter.
- **`websocket-plugin` and `sse-plugin` `register()` are now async**, awaiting the optional
  backplane subscription. The kernel already awaited an async `register`, so applications are
  unaffected; a test calling `plugin.register(ctx)` directly must now await it.

### Fixed

- **Request envelopes leaked into plain subscribers.** A responder shared the raw topic with
  pub/sub, so a `subscribe('orders', …)` handler received the raw `rr-request` envelope instead of
  the payload. Separate channels fix this at the routing layer.
- **A responder could swallow a competing consumer's message.** Where a responder and an ordinary
  subscriber shared a topic _and_ a queue (competing-consumer delivery), the responder consumed its
  share of the round-robin and its envelope guard discarded anything that was not a request — the
  message vanished with no signal. Fan-out subscribers were unaffected.
- **The reply inbox subscribed without a queue name**, so on a broker that falls back to a shared
  consumer group (Kafka) replies could be delivered to a different instance than the caller, which
  then discarded them by correlation-id lookup — surfacing as an unexplained timeout. Each inbox now
  claims its own queue.
- **Resilience timeouts cancel the work they bound.** `timeout` raced the protected call against a
  timer and left it running; it now aborts the call's signal with the same `TimeoutError` instance
  it rejects with, so a call that forwards the signal to its I/O genuinely stops. Retry stops
  looping on abort and wakes its backoff early — that sleep also no longer leaks a timer handle on
  every attempt — and a bulkhead waiter cancelled while queued leaves the queue and never runs its
  call.
- **Six package pages on jsr.io now show their README.** `cli`, `feature-flags-plugin`,
  `multi-tenancy-plugin`, `openapi-plugin`, `queue-plugin`, and `storage-plugin` rendered a one-line
  blurb instead in `0.1.0-alpha.2`. Not a packaging fault — `/README.md` was in every published
  tarball. JSR's `readmeSource` defaults to `jsdoc` and falls back to README.md only when the
  entrypoint's module doc has no description; deno_doc drops prose that _follows_ a tag, so a block
  opening with `@module` has no description and the README renders, while one whose description
  comes first and ends with `@module` replaces the whole page. Those six were the only
  description-first entrypoints. `deno task release:verify` now enforces `@module`-first, because
  nothing else sees this: the README ships in the tarball, so every gate and
  `deno publish
  --dry-run` stay green and the loss shows up only on jsr.io.

### Deprecated

- **`MessagingNotSupportedError`** — no broker throws it now that Kafka implements request-reply.
  The export is retained so `instanceof` checks written against `alpha.1`/`alpha.2` keep compiling,
  and will be removed in the next major. Nothing replaces it; delete the branch.

### Notes

One real-time limitation remains, documented rather than silently approximated: `Room.size` /
`SseChannel.size` report **local** membership. A cluster-wide count is inherently asynchronous — it
needs a scatter-gather across replicas — so it cannot satisfy the synchronous committed `size`
getter and wants a separate async method. That is a later milestone.

`RoomBroadcastOptions.except` **is** honored cluster-wide: connection IDs come from `runtime.uuid()`
and are globally unique, so the frame carries the excluded ID and every replica skips it.

A call that ignores its `AbortSignal` still runs to completion; cancellation is cooperative, and the
widened JSDoc says so.

**FCM push has not been exercised against live FCM.** The HTTP v1 rewrite is asserted field by field
— request URL, headers, and body shape — and its RS256 assertion is signed and verified with real
Web Crypto, but no test reaches Google: CI holds no Firebase project. The endpoint and auth scheme
follow Google's documented HTTP v1 contract, and the previous `serverKey` path was provably dead, so
this is strictly an improvement — but if you depend on push, verify it against your own project
before you rely on it, and please report what you find.

All 38 packages are live on JSR at `0.1.0-alpha.3`.

Verified after publishing by querying every package on the registry, then installing `kernel` and
`runtime` from JSR into a throwaway directory — not the workspace, whose import map resolves locally
and would mask a broken published dependency — and serving a request (`200 {"ok":true}`). `common`
resolved transitively at `0.1.0-alpha.3`, which is the only real evidence that the cross-package
specifier bump landed inside the published tarballs: a dry run resolves those from the workspace and
so cannot show it.

The six package pages that shipped `0.1.0-alpha.2` without a visible README were re-checked and now
render theirs. The same check run against their `0.1.0-alpha.2` pages still finds no README content,
so it distinguishes the two rather than passing vacuously.

### Installing

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.3
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.3/main
```

Within 24 hours of a release, Deno's minimum-dependency-age policy refuses the version unless you
pass `--min-dep-age 0`.

## [0.1.0-alpha.2] — 2026-07-28

**Adds the CLI.** `@hono-enterprise/cli` publishes for the first time, bringing the total to **36
packages**. Every other package is version-bumped so the scope stays on one version — the CLI needs
this, because `honoe new` stamps generated projects with its OWN version as the range for `kernel`,
`runtime`, `common`, and every template plugin. A CLI at `alpha.2` alongside a framework at
`alpha.1` would scaffold projects pinning versions that do not exist.

### Added

- **`@hono-enterprise/cli`** — the `honoe` command: project scaffolding (`honoe new`, with
  `--template rest|microservice` and `--runtime deno|node|bun|cloudflare-workers`), 13 plugin-aware
  code-generation schematics, custom schematics, and dispatch of plugin-registered commands
  (`honoe commands`, `honoe db:migrate`).

### Fixed

- **Package READMEs linked `PUBLIC_API.md` relatively** (`../../PUBLIC_API.md`). JSR resolves a
  README's relative links against `jsr.io/@hono-enterprise/`, so every such link 400'd with
  _"package name must contain only lowercase ascii alphanumeric characters and hyphens"_. All 44
  relative links across 28 package READMEs now use absolute GitHub URLs.
- **`ICliApi`'s JSDoc** described a contract with no consumer; the CLI now reads it.

All 36 packages are live on JSR at `0.1.0-alpha.2`.

Verified after publishing by installing `honoe` from JSR into a clean directory — not the workspace,
whose import map resolves locally — scaffolding a `rest` project with it, generating a controller,
type-checking the result against the published packages, then starting it and serving `/` (`200`),
`/health` (`status: up`), and `/metrics`.

### The release pipeline, which had never worked

This was the first release published by CI. `0.1.0-alpha.1` went out by hand from a terminal,
because the tag-triggered workflow failed on every attempt. Three separate causes, each only visible
by running it:

1. **The publish step lacked `--allow-env`.** `publish-packages.ts` reads `JSR_TOKEN` at startup
   (left unset in CI so the runner's OIDC identity authenticates instead) and died before touching a
   package. The root cause was duplication: `deno.json`'s `release:publish` task always carried the
   right permissions, but the workflow inlined its own `deno run` and that copy drifted. The
   workflow now calls the task.
2. **It also lacked `--allow-net`.** The already-published check that makes a resumed release
   idempotent fetches jsr.io — and it is skipped under `--dry-run`, so a passing dry run proves
   nothing about a real run.
3. **No package was linked to the GitHub repository.** JSR accepts a GitHub Actions OIDC identity
   only for a package it knows belongs to the repo; without the link, `deno publish` uploads and
   then fails with `actorNotAuthorized`. Token-based publishing does not need the link, which is why
   `0.1.0-alpha.1` never surfaced it. `deno task release:link-repos` now does all 36 through the
   API.

None of the three published anything, so the tag stayed re-runnable throughout.

### Installing

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.2
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.2/main
```

Within 24 hours of a release, Deno's minimum-dependency-age policy refuses the version unless you
pass `--min-dep-age 0`.

## [0.1.0-alpha.1] — 2026-07-26

**First public prerelease.** The framework's kernel, runtime layer, and 30 plugins are implemented
and tested; they publish to [JSR](https://jsr.io) under the `@hono-enterprise` scope.

This is an **alpha**. The public API is not frozen, and breaking changes may land in any subsequent
prerelease without a major-version bump. Do not use it in production.

All 35 packages are live on JSR at `0.1.0-alpha.1`.

Verified after publishing by installing `kernel`, `runtime`, `metrics-plugin`, and
`telemetry-plugin` from JSR into a clean project — not the workspace, whose import map resolves
locally — starting an application, serving a request (`200`), and scraping the `/metrics` endpoint.

The release took two attempts. A JSR scope may create only 20 new packages per rolling 7-day window
by default; the first run created 20 and stopped. JSR raised the quota to 40 on request, and the
remaining 15 followed. Both halves carry the same version, and the publish order guarantees `common`
and `kernel` land before anything that depends on them, so the intermediate state was never
inconsistent.

### Installing a prerelease

JSR does not tag a prerelease as `latest`, so **every specifier must be version-pinned**:

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.1
```

A bare `deno add jsr:@hono-enterprise/kernel` fails with _"has only pre-release versions
available"_. Within 24 hours of a release, Deno's minimum-dependency-age policy additionally refuses
the version unless you pass `--min-dep-age 0`.

### All packages in this release

35 packages, all at `0.1.0-alpha.1`:

**Core** — `common`, `kernel`, `runtime`, `exceptions`, `testing`

**Request path** — `logger-plugin`, `config-plugin`, `validation-plugin`, `http-security-plugin`,
`auth-plugin`

**Data** — `database-plugin`, `cache-plugin`, `storage-plugin`, `multi-tenancy-plugin`

**Messaging & work** — `events-plugin`, `cqrs-plugin`, `messaging-plugin`, `queue-plugin`,
`scheduler-plugin`, `worker-pool-plugin`

**Real-time** — `sse-plugin`, `websocket-plugin`, `react-router-plugin`

**Operations** — `metrics-plugin`, `health-plugin`, `telemetry-plugin`, `audit-plugin`,
`resilience-plugin`, `secrets-plugin`

**Delivery** — `mail-plugin`, `notification-plugin`, `feature-flags-plugin`

**Optional ergonomics** — `di-plugin`, `decorator-plugin`, `openapi-plugin`

### Deliberately excluded

`@hono-enterprise/cli`, `@hono-enterprise/sdk`, and the three starter bundles (`rest-starter`,
`microservice-starter`, `full-stack-starter`) are **not part of this release**. They are stubs that
export nothing; publishing them would put empty pages on JSR, where versions are immutable. They
ship when their milestones land (the CLI is Milestone 34).

### Runtime support

Node.js, Deno, Bun, and Cloudflare Workers, via Hono's `fetch` entry point and the runtime's HTTP
adapters. Individual plugins document their own constraints — SMTP needs raw sockets, worker pools
need real threads, and neither exists on Workers.

Optional heavy dependencies (Prisma, ioredis, amqplib, kafkajs, nodemailer, the OTel SDK, `ws`, …)
are never hard dependencies. Each is injected through plugin options or imported lazily via an
`npm:` specifier, so an application only pays for what it configures.

### Known limitations

> Five entries in this list have since been closed; each is annotated in place rather than deleted,
> because this section records what was true of **this** release. See **[0.1.0-alpha.3]** for the
> work that closed them.

- **`notification-plugin` FCM push is non-functional.** It implements the legacy FCM `serverKey`
  API, which Google decommissioned in 2024. FCM HTTP v1 with service-account JWT signing is a
  follow-up. _(True of this release. Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30),
  where the provider moves to HTTP v1 and push delivery works.)_
- **LaunchDarkly is unsupported** in `feature-flags-plugin`. The LaunchDarkly Node server SDK's
  `variation`/`allFlagsState` are async and cannot satisfy the synchronous committed `isEnabled`
  contract. Use the provider's `'custom'` arm as a bridge. _(True of this release. Superseded — see
  [0.1.0-alpha.3](#010-alpha3--2026-07-30), which adds a `'launchdarkly'` provider and an optional
  `isEnabledAsync`.)_
- **`KafkaBroker` does not support request-reply.** Kafka's consumer-group and auto-commit model
  does not fit the pattern; `request()`/`respond()` throw `MessagingNotSupportedError`. _(True of
  this release. Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30), where Kafka becomes
  reply-capable; the limitation was in the shared request-reply core, not in Kafka.)_
- **Rooms and channels are in-process.** `websocket-plugin` rooms and `sse-plugin` channels are not
  shared across replicas; cross-instance fan-out is a later milestone. _(True of this release.
  Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30), which adds `realtime-backplane-plugin`.
  `Room.size` / `SseChannel.size` remain local-only.)_
- **`resilience-plugin` timeouts do not cancel.** `timeout` races the promise; the wrapped function
  keeps running. _(True of this release. Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30),
  where `wrap` hands the protected call an `AbortSignal` and the timeout aborts it.)_
- **Node and Bun compatibility suites have not run.** They consume the packages through JSR's npm
  compatibility layer and were therefore blocked on this publish — they are unblocked by it, and
  will run before the first stable release. Milestone 40 owns that verification, alongside
  benchmarks and the security audit.

### Milestones in this release

Milestones 0–33 and 41–46. See [ROADMAP.md](ROADMAP.md) for scope per milestone and
[PUBLIC_API.md](PUBLIC_API.md) for the full exported surface.

[0.1.0-alpha.7]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/setu-ts/setu-ts/releases/tag/v0.1.0-alpha.1
