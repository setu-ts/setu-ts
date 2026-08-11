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
setu new my-app --template rest --di           # add a DI container
setu new my-app --dry-run                      # print the plan, write nothing
```

### Templates

| Template       | Plugins it registers                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| _(none)_       | `RuntimePlugin` only                                                                                                     |
| `rest`         | Runtime, Config, Logger, Validation, HttpSecurity, Health, Metrics, OpenAPI, Decorator + the `errorHandler()` middleware |
| `microservice` | The REST set + Messaging, Queue, Resilience, Telemetry, CQRS, Events, ServiceDiscovery                                   |
| `nest`         | The REST set + `DiPlugin`, with a decorated controller and an injected service already written                           |
| `full-stack`   | Composed through `@setu-ts/full-stack-starter`, plus a React Router 8 framework-mode app skeleton                        |

`exceptions` ships middleware rather than a plugin, which is why `rest` registers nine plugins and
adds `errorHandler()` to the pipeline separately.

Every scaffolded project — templated or not — exports `createApp()` from `setu.config.ts`. `main.ts`
imports it to start the server and the CLI imports it to discover plugin-contributed commands, so
the plugin list has exactly one home. The factory does not start the app: importing a module that
binds a socket would make command discovery bind one too.

### Decorators and DI are independent choices

Decorators are optional, dependency injection is optional, and the two are separate axes. The
template decides decorators; `--di` decides the container.

| You want                    | Scaffold with                       | You get                                                                                                                      |
| --------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Neither                     | `setu new app`                      | The runtime plugin alone. `g route`, `g middleware`, `g plugin`, `g service` and `g job` all work.                           |
| Decorators, no container    | `setu new app --template rest`      | `DecoratorPlugin`, so `g controller` and `g module` work. `@Injectable` classes resolve from the kernel's `ServiceRegistry`. |
| A container, no decorators  | `setu new app --di`                 | `DiPlugin` on the minimal set. Nothing generated changes shape; there is simply a container present.                         |
| Both                        | `setu new app --template rest --di` | `@Injectable` classes are constructed through the container and their `scope` is honored.                                    |
| Both, plus a worked example | `setu new app --template nest`      | The above, with the decorated controller and injected service written for you.                                               |

`--di` changes the **composition**, never the generated source: `DecoratorPlugin` branches on the
container's presence, so the same `@Injectable` class works either way — what changes is the
lifecycle it gets. Adding `--di` to `--template nest` is a no-op, because that template already
registers `DiPlugin` and the kernel refuses a duplicate plugin name at `start()`.

One consequence worth knowing before you reach for it: `DecoratorPlugin.registerService` registers a
provider on the container when one is present and never touches the kernel registry, so
`services.get('<name>-service')` resolves a decorated service **only in a project without `--di`**.
See [Decorators — Injectable Classes](./decorators.md#injectable-classes).

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

`setu generate module` is the one aggregate schematic. It emits five files and rewrites the
aggregate barrel:

```bash
setu g module orders
```

```
src/modules/
├── index.ts                      # managed: MODULE_CONTROLLERS, MODULE_SERVICES
└── orders/
    ├── index.ts                  # the module's own barrel
    ├── orders.controller.ts      # @Controller, injecting the service by token
    ├── orders.service.ts         # @Injectable
    └── orders.service.test.ts    # describe/it + expect
```

`setu.config.ts` already spreads both aggregate arrays into `DecoratorPlugin`, so the module serves
requests immediately. It needs `@setu-ts/decorator-plugin`, so scaffold with `--template rest`,
`microservice` or `nest`.

**A decorated handler receives only its decorated parameters.** The plugin builds the argument list
from parameter metadata alone and never passes the request context positionally, so a `ctx`
parameter would arrive `undefined`. Return a plain value and the plugin serializes it as JSON; reach
for `setu generate route` when a handler needs the context itself — to set a status code or stream a
response. See
[Decorators — The Authenticated Principal](./decorators.md#the-authenticated-principal).

## Monorepos

One repository, many deployable services. The root is a Deno workspace; each member is a full
project with its own manifest and its own port.

```bash
setu new acme --workspace                          # the root, no member yet
setu new acme --workspace --port 4100              # base port for its members
setu new acme --workspace --transport redis        # how members talk to each other
cd acme
setu generate app orders --template microservice    # apps/orders
setu generate app billing --template microservice   # apps/billing
```

```
acme/
├── deno.json               # "workspace": ["./apps/*"]
├── setu.workspace.json     # members, their ports, the transport
└── apps/
    ├── orders/
    └── billing/
```

The root declares its members by **glob**, so adding one rewrites no manifest and
`deno task
--recursive` reaches every member. Framework pins live in each member's own `deno.json`
rather than at the root, because plugin detection reads one directory's manifest and never walks up
— root-only pins would make every gated schematic refuse inside a member.

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
directory it already has. A non-Deno `--runtime` is refused, as is `--template full-stack` — its
Vite build needs `nodeModulesDir`, which Deno accepts only in a workspace **root**.
`new --workspace` refuses `--template` and a non-Deno runtime rather than ignoring them.

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
