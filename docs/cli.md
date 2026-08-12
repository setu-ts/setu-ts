# CLI Guide

The `setu` CLI does two things: it scaffolds projects, and it generates code that is already wired
into a registration site. This guide covers both, plus monorepo workspaces.

[`PUBLIC_API.md`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#cli-setu-tscli) is the
authoritative reference for flags, options and exit codes. This guide explains the choices behind
them.

## Install

```bash
deno install -g -A -n setu jsr:@setu-ts/cli@^0.1.0-alpha.7/main
```

Install it with an explicit binary name (`-n setu`): Deno's default inference would name the
executable after the package, so you would be typing `cli new my-app`.

## Scaffolding a project

```bash
setu new my-app                                # minimal: the runtime plugin alone
setu new my-app --template rest                # a REST composition
setu new my-app --runtime node                 # deno | node | bun | cloudflare-workers
setu new my-app --template class-based         # decorators and a DI container
setu new my-app --dry-run                      # print the plan, write nothing
```

### Templates

| Template       | Plugins it registers                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| _(none)_       | `RuntimePlugin` only                                                                                                 |
| `rest`         | Runtime, Config, Logger, Validation, HttpSecurity, Health, Metrics, OpenAPI + the `errorHandler()` middleware        |
| `microservice` | The REST set + Messaging, Queue, Resilience, Telemetry, CQRS, Events, ServiceDiscovery                               |
| `class-based`  | The REST set + `DecoratorPlugin` and `DiPlugin`, with a decorated controller and an injected service already written |
| `full-stack`   | Composed through `@setu-ts/full-stack-starter`, plus a React Router 8 framework-mode app skeleton                    |

`exceptions` ships middleware rather than a plugin, which is why `rest` registers eight plugins and
adds `errorHandler()` to the pipeline separately. `class-based` was previously called `nest`; the
old name is refused with a message naming the new one.

Every scaffolded project — templated or not — exports `createApp()` from `setu.config.ts`. `main.ts`
imports it to start the server and the CLI imports it to discover plugin-contributed commands, so
the plugin list has exactly one home. The factory does not start the app: importing a module that
binds a socket would make command discovery bind one too.

### Decorators and DI are one choice, and functional is the default

Decorators are optional and dependency injection is optional — and they are one axis with two
complete positions rather than a spectrum. The default is **functional**: no `DecoratorPlugin`, no
`DiPlugin`, `ctx`-first handlers, plain exported functions for services. `--template class-based` is
the opt-in, and it always brings both plugins together.

| You want    | Scaffold with                         | You get                                                                                                        |
| ----------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Neither     | `setu new app`                        | The runtime plugin alone. `g route`, `g middleware`, `g plugin`, `g service`, `g module` and `g job` all work. |
| Functional  | `setu new app --template rest`        | The REST plugin set. `g module` writes a plain service and a registered route with `GET` and `POST` handlers.  |
| Class-based | `setu new app --template class-based` | `DecoratorPlugin` + `DiPlugin`, decorated controllers, `@Injectable` services, and class module barrels.       |

The choice **persists**. `setu generate` reads the target project's manifest, so a project holding
`@setu-ts/decorator-plugin` gets class output and one without it gets functional output — a later
generate cannot silently emit the other style. That is also why `g controller` is refused in a
functional project: its emitted source imports `@setu-ts/decorator-plugin`, so an ungated one could
not resolve its own import. The refusal names `setu generate route`, which registers handlers on the
router API and needs no decorators.

**The independent `--di` flag was removed.** It is refused with a message pointing at
`--template class-based`; there is no longer a decorator-only or container-only composition, because
those are the incoherent middle of the axis. A project scaffolded with the old flag keeps working —
generation reads the packages it actually has.

One consequence worth knowing before you reach for it: `DecoratorPlugin.registerService` registers a
provider on the container when one is present and never touches the kernel registry, so
`services.get('<name>-service')` resolves a decorated service **only in a project without
`DiPlugin`**. In a `class-based` project, resolve through the container instead. See
[Decorators — Injectable Classes](./decorators.md#injectable-classes).

### Runtime targets

| `--runtime`          | Entry                         | Manifests                                                 | Start command       |
| -------------------- | ----------------------------- | --------------------------------------------------------- | ------------------- |
| `deno` (default)     | `main.ts` → `app.start()`     | `deno.json`                                               | `deno task start`   |
| `node`               | `main.ts` → `app.start()`     | `package.json` + `.npmrc` + `tsconfig.json`               | `npm start` (`tsx`) |
| `bun`                | `main.ts` → `app.start()`     | `package.json` + `.npmrc` + `tsconfig.json`               | `bun run main.ts`   |
| `cloudflare-workers` | `src/index.ts` `fetch` export | `deno.json` + `package.json` + `.npmrc` + `wrangler.toml` | `npx wrangler dev`  |

**The Node target runs TypeScript through `tsx`, not through type stripping.** Node's built-in
support (`--experimental-strip-types`) erases types without transforming code, so it cannot run a
legacy decorator — a bare `SyntaxError` — or the constructor parameter property
`setu generate
module` emits (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). `--experimental-transform-types`
handles the parameter property and still rejects the decorator, because it does not enable
`experimentalDecorators`. A generated Node project therefore declares `tsx` in `devDependencies` and
starts with `tsx main.ts`, reading the `experimentalDecorators` its own `tsconfig.json` already
sets. Bun compiles TypeScript outright and Deno and Workers never invoke a runner, so no other
target carries the dependency.

**The Workers target carries an npm manifest as well as `deno.json`.** `wrangler` bundles
`src/index.ts` with esbuild, which resolves neither `jsr:` specifiers nor a Deno import map, so the
project emits `package.json` (npm-compat `@jsr/…` dependencies, `wrangler` pinned) plus `.npmrc`,
and `npm install && npx wrangler dev` works as printed. The Deno target does **not** get one: it
resolves through the import map, and a `package.json` switches Deno to `node_modules` resolution.

`--template microservice --runtime cloudflare-workers` is supported. The template swaps
`messaging-plugin` and `queue-plugin` — both need a socket — for `@setu-ts/cloudflare-plugin`, and
emits the `queue` module handlers the platform invokes (`createMessagingHandler`,
`createQueueHandler`). See
[Runtime Deployment — Cloudflare Workers](./runtime-deployment.md#cloudflare-workers-deployment).

## Generating code

```bash
setu generate service billing
setu g service billing            # alias
setu g service billing --dry-run  # print the plan, write nothing
```

Any casing of the name produces identical output: `setu g controller user-profile` and
`setu g controller UserProfile` emit the same file.

Eleven of the fourteen schematics land in a barrel the generated `setu.config.ts` already imports,
so a generated artifact reaches its registration site with **no edit to a file you own**:

| Schematic          | Requires           | Emits into         | Reaches                                           |
| ------------------ | ------------------ | ------------------ | ------------------------------------------------- |
| `module`           | `decorator-plugin` | `src/modules/`     | `DecoratorPlugin({ controllers, services })`      |
| `controller`       | `decorator-plugin` | `src/controllers/` | `DecoratorPlugin({ controllers })`                |
| `service`          | —                  | `src/services/`    | `DecoratorPlugin({ services })`, when installed   |
| `route`            | —                  | `src/routes/`      | A `register…Routes(router)` call in `createApp()` |
| `middleware`       | —                  | `src/middleware/`  | The global middleware pipeline                    |
| `plugin`           | —                  | `src/plugins/`     | The `plugins: [...]` array                        |
| `health-indicator` | `health-plugin`    | `src/health/`      | `HealthPlugin({ indicators })` → `GET /health`    |
| `metric`           | `metrics-plugin`   | `src/metrics/`     | `MetricsPlugin({ customMetrics })` → `/metrics`   |
| `command-handler`  | `cqrs-plugin`      | `src/cqrs/`        | `CqrsPlugin({ commandHandlers })`                 |
| `query-handler`    | `cqrs-plugin`      | `src/cqrs/`        | `CqrsPlugin({ queryHandlers })`                   |
| `event-handler`    | `events-plugin`    | `src/events/`      | `EventsPlugin({ handlers })`                      |
| `guard`            | `auth-plugin`      | `src/guards/`      | Nothing — attach it per route                     |
| `job`              | —                  | `src/jobs/`        | Nothing — transport-agnostic by design            |
| `migration`        | `database-plugin`  | `src/migrations/`  | Nothing — no framework code reads migrations      |

The last three are unwired deliberately, not by omission. A `guard` answers `401` when
`ctx.request.user` is absent, so registering it globally would 401 `/health`, `/metrics` and `/` —
turning a generated file into an outage; its positions are per route (`@UseGuards`, a route's
`middleware` list). A `job` is transport-agnostic: registering it as a queue processor would start a
worker loop polling for a name nothing enqueues, and scheduling it needs a cron expression the
artifact does not carry. Nothing in the framework reads migration files at all.

A schematic gated on a plugin refuses rather than emitting source whose own import cannot resolve,
and names the decorator-free alternative when there is one:

```
The "controller" schematic requires @setu-ts/decorator-plugin, which is not installed in /path/to/app.
Install it, then run this command again.
Or run `setu generate route user-profile` — it registers handlers on the router API, so it needs no decorators.
```

### Managed barrels

Each family's barrel is **managed**: the CLI owns it and rewrites it on every generate, which is the
one exemption from the refusal that protects an existing file. Two consequences:

- A barrel admits a file only when that file actually exports every symbol the barrel will import.
  An artifact that does not is **skipped and reported**, never silently unwired.
- Two artifacts that would claim the same DI token or the same `METHOD /path` are refused before
  anything is written, naming the conflict. `DecoratorPlugin.registerService` is first-wins on a
  token and the kernel's route map overwrites on a duplicate, so the second artifact would otherwise
  be silently unreachable.

### Custom schematics

A schematic is a pure `(names, options) => GeneratedFile[]`, which is what makes `--dry-run` exact
rather than a prediction. Author your own under `.setu-ts/schematics/<name>.ts` and run it with:

```bash
setu generate custom my-schematic order-item
```

`SchematicOptions` carries the target project's `runtime`, its detected `plugins`, and — for the
schematics that render a barrel — the `modules` and `artifacts` already present.

## Domain modules

`setu generate module` is the aggregate schematic, and its output follows the project's style.

```bash
setu g module orders
```

In a **functional** project it writes a plain service, its test, a module barrel, and a route module
the managed routes barrel already registers — so the module serves requests with no edit to
`setu.config.ts`:

```
src/modules/orders/
├── index.ts                      # the module's own barrel
├── orders.service.ts             # export function listOrders()
└── orders.service.test.ts        # describe/it + expect
src/routes/
├── index.ts                      # managed: registerGeneratedRoutes(app.router)
└── orders.routes.ts              # registerOrdersRoutes — GET / and POST / (201)
```

In a **class-based** project it writes the decorated aggregate and rewrites the module barrel, which
the scaffolded `setu.config.ts` already spreads into `DecoratorPlugin`:

```
src/modules/
├── index.ts                      # managed: MODULE_CONTROLLERS, MODULE_SERVICES
└── orders/
    ├── index.ts                  # the module's own barrel
    ├── orders.controller.ts      # @Controller, injecting the service by token
    ├── orders.service.ts         # @Injectable
    └── orders.service.test.ts    # describe/it + expect
```

The schematic is **ungated**: it works in every project shape, including one scaffolded with no
template at all. Which of the two shapes you get is decided by whether `@setu-ts/decorator-plugin`
is installed.

**A decorated handler receives only its decorated parameters.** The plugin builds the argument list
from parameter metadata alone and never passes the request context positionally, so a bare `ctx`
parameter would arrive `undefined` — a `500` on every request. Use `@Ctx()`, the built-in parameter
decorator, when a handler needs the context itself; that is how the generated `create` method sets a
real `201`. Return a plain value and the plugin serializes it as JSON. See
[Decorators — The Authenticated Principal](./decorators.md#the-authenticated-principal).

## Monorepos

One repository, many deployable services. The root is a Deno workspace by default and an npm
workspace under `--runtime node|bun`; each member is a full project with its own manifest and its
own port.

```bash
setu new acme --workspace                          # the root, no member yet
setu new acme --workspace --port 4100              # base port for its members
setu new acme --workspace --transport redis        # how members talk to each other
setu new acme --workspace --runtime node           # npm workspaces instead of a Deno one
cd acme
setu generate app orders --template microservice    # apps/orders
setu generate app billing --template microservice   # apps/billing
```

```
acme/
├── deno.json               # "workspace": ["./apps/*"]   (package.json on the npm arm)
├── setu.workspace.json     # members, their ports, the transport, the runtime
└── apps/
    ├── orders/
    └── billing/
```

The root declares its members by **glob**, so adding one rewrites no manifest and
`deno task
--recursive` reaches every member. Framework pins live in each member's own manifest
rather than at the root, because plugin detection reads one directory's manifest and never walks up
— root-only pins would make every gated schematic refuse inside a member.

Under `--runtime node|bun` the root is a `package.json` carrying `"workspaces": ["apps/*"]` instead,
the members are npm packages, and the install and run-all commands become `npm install` /
`bun install` and `npm run dev`. Everything else about a workspace is the same. See
[Node and Bun workspaces](../PUBLIC_API.md#node-and-bun-workspaces).

Ports come from `setu.workspace.json` and are allocated above the highest one in use, so adding a
name that sorts earlier cannot move a running service's port. `--transport` picks how members reach
each other (`http`, `grpc`, `memory`, `redis`, `rabbitmq`, `nats`, `kafka`); it is recorded once and
every member added later inherits it, because services can only meet on a bus they share.

### The discovery map

Every member carries a CLI-owned `src/discovery/services.ts`, regenerated for **all** members on
each `setu generate app`:

```typescript
/** The port this workspace member binds. */
export const SERVICE_PORT = 3000;

/** Every OTHER member of this workspace, by service name. */
export const SERVICE_ENDPOINTS = {
  'billing': [{ host: '127.0.0.1', port: 3001 }],
};
```

`main.ts` binds `SERVICE_PORT` and `setu.config.ts` hands `SERVICE_ENDPOINTS` to
`ServiceDiscoveryPlugin({ provider: 'static', … })`, so the port a member binds and the port its
siblings dial are one datum rather than two that drift. The self-entry is excluded deliberately: a
self-address invites a service to route a request back into its own process.

This is the **local development** topology. A deployed one comes from a real provider arm —
`consul`, `kubernetes` or `dns` — not from this file. See
[`@setu-ts/service-discovery-plugin`](./plugins.md#setu-tsservice-discovery-plugin).

### Refusals

`generate app` outside a workspace names `setu new <name> --workspace`. A duplicate member names the
directory it already has. A member's runtime is the workspace's, so `generate app --runtime` is
refused when it **disagrees** with the root rather than when it is not Deno — members share one
manifest and one lockfile, and the root is what installs them. `--template full-stack` is refused
only on a **broker** transport, because that template composes its whole plugin set through a
starter factory, so a transport's contribution would be silently dropped; on `http` and `memory` it
is allowed, and the root gains `nodeModulesDir` when such a member arrives.

`new --workspace` refuses `--template` rather than ignoring it, and refuses
`--runtime cloudflare-workers` — each Worker is its own deploy unit with its own `wrangler.toml`, so
several in one repository are several deployments rather than members of one.

## Plugin-contributed commands

A plugin can register its own verb under `CAPABILITIES.CLI_COMMAND`. Discovery imports the project's
`createApp()` and starts it with **no port** — the kernel skips `listen` without one, but init and
bootstrap hooks do run, so a database plugin connects and teardown is unconditional:

```bash
setu commands          # list what this project's plugins provide
```

Built-in verbs match first and never boot the project. Two plugins claiming one command name is
refused rather than resolved by load order.

## Exit codes

| Code | Meaning                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success, including `--help` and `--version`.                                                                                                                              |
| `1`  | Runtime error: a gated schematic's plugin is absent, a target file exists, a write failed, the application failed to load or start, or a handler threw.                   |
| `2`  | Usage error: unknown command or schematic, missing argument, unknown `--runtime`, or a name that cannot form an identifier (empty after normalization, or digit-leading). |

## Next Steps

- [Getting Started](./getting-started.md) — the framework itself
- [Decorators Guide](./decorators.md) — what the decorated schematics emit
- [Plugin Catalog](./plugins.md) — every plugin a template can register
- [Runtime Deployment](./runtime-deployment.md) — shipping what you scaffolded
