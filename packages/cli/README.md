# @setu-ts/cli

## Production builds

Run `npm run build` then `npm start` in a generated Node service.
`setu build [--dir <member>] [--dry-run]` checks wiring and bundles main.ts and an optional
migration runner into dist/ with source maps. Libraries are inlined; npm packages remain external. A
runtime devDependency import fails with the package and importing file named. Workspace roots
refuse: select apps/<member>. Dry-run prints the plan without writing. Use the build script to
type-check before bundling.

Use start:dev for source development and start:debug for debugging. Full-stack uses dev.ts during
development and builds its frontend before production. DI graph validation runs at boot: run npm
test before building an image. Bun and Deno keep running source; Workers uses Wrangler. Native bun
build and deno compile are optional custom packaging choices.

Standalone projects include Dockerfile and .dockerignore. Workspace images use the root context and
--build-arg MEMBER=orders. Node installs production dependencies in a separate runtime stage; Bun
uses --production and a hoisted-linker bunfig.toml so members resolve shared libraries. Deno runs a
declared build task before caching source. See the
[upgrade guide](https://github.com/setu-ts/setu-ts/blob/main/docs/upgrading.md) for existing
scripts, ignore files and images.

Projects using Swagger declare `swagger-ui-dist` through their template's npm dependencies,
including the Deno import map. Node, Bun and Deno self-host the three `/docs` assets (Deno start
tasks grant read access); Workers templates select pinned CDN assets. Full-stack projects pass that
choice through the starter's `openapi` option.

The `setu` command-line tool: project scaffolding and plugin-aware code generation for the Setu-TS
framework.

## Installation

`setu` is a Node program (Node 22.23.4+, 24.22.1+ or 26.12.1+), published to npm with a `bin`. Run
it without an install, install it globally, or start through `npm create`:

```bash
npx @setu-ts/cli new my-app
npm install --global @setu-ts/cli          # then: setu new my-app
npm create @setu-ts my-app                 # the same as setu new my-app
```

It loads a project's TypeScript — `setu.config.ts` for plugin commands, a custom schematic — through
`tsx`, resolving the project's own imports from its `node_modules`. A Deno project sets
`nodeModulesDir: "auto"` so `deno install` creates that directory; run it once before
`setu <plugin-command>`.

## Scaffolding a project

```bash
setu new my-app                                  # Node, minimal (runtime plugin only)
setu new my-app --runtime deno                   # node (default) | deno | bun | cloudflare-workers — see below
setu new my-app --template rest                  # rest | microservice | class-based | full-stack
setu new my-app --template rest --style class-based   # functional | class-based (rest, microservice)
setu new my-app --template rest --env-file config/.env.local
```

`--runtime` chooses the manifest and the start command, not the code. On `deno`, `node` and `bun`
the generated `main.ts`, `setu.config.ts` and `src/` are byte-identical, and `RuntimePlugin` detects
the platform at startup, so a project can move between those three by swapping its manifest.
`cloudflare-workers` differs in its entry and factory. See
[Runtime targets](https://github.com/setu-ts/setu-ts/blob/main/docs/cli.md#runtime-targets) for the
steps.

Every project gets a `setu.config.ts` exporting `createApp()` — the one place its plugin list lives.
`main.ts` imports it to start the server, and `setu` imports it to find plugin commands, so the two
cannot disagree. The factory does **not** start the application.

The factory returns `IKernelApplication` (or `Promise<IKernelApplication>` for a starter), so it
works directly with `createTestApp({ app: await createApp() })`. Every Deno, Node, and Bun scaffold
includes `test/app.test.ts`, which starts this composition without a socket, checks `/health` (`/`
on the minimal host), and stops it. Workers needs the platform environment and emits no smoke test;
its `test` task permits an empty suite. For an existing project, `setu add testing` pins the testing
package in Deno's import map or npm's `devDependencies`.

On Deno, Node, and Bun, config-backed templates emit a gitignored `.env` and tracked `.env.example`,
and load the selected path through `ConfigPlugin({ envFilePath })`. Use `--env-file <path>` to
select another relative path. Cloudflare Workers use request bindings and therefore emit no dotenv
file or filesystem configuration; `--env-file` is refused there. Values needed while constructing a
plugin must come from this pre-construction environment source; `ConfigPlugin` cannot retroactively
configure a plugin already built.

| Template       | Plugin set                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_       | `RuntimePlugin` only.                                                                                                                                   |
| `rest`         | Runtime, Config, Logger, Validation, HttpSecurity, Health, Metrics, OpenApi + `errorHandler()`.                                                         |
| `microservice` | `rest` plus Messaging, Queue, Resilience, Telemetry.                                                                                                    |
| `class-based`  | Alias of `rest --style class-based`: `rest` plus decorators and DI, an `@Injectable` service, and a `@Controller` with a class-position `@Inject` list. |
| `full-stack`   | A React Router 8 SSR app: the full plugin set via `createFullStackAppFromConfig`, plus an `app/` skeleton.                                              |

`--style class-based` is accepted on `rest` and `microservice` and opts into decorators and
dependency injection together; `--template class-based` is the byte-identical alias of
`--template rest --style class-based`.

`--template microservice --runtime cloudflare-workers` is supported. The messaging and queue plugins
reach brokers over raw sockets, which Workers does not provide, so on that target they are swapped
for `CloudflarePlugin`, which serves both capabilities from Cloudflare Queues and a Durable Object.
The swap also contributes the `queue` module export the platform invokes, the reply-inbox class, and
the `wrangler.toml` stanzas both need. Service discovery is not part of it: the wiring selects the
`'static'` arm, which contacts no backend.

### `--template full-stack`

The only template that composes through a starter rather than inline wiring — its plugin set is
twenty-two, and a generated file a human is meant to edit should not open with twenty-two imports
they did not choose. It emits an `app/` tree with the `routes -> features -> services -> models`
layering, `flatRoutes` `_app`/`_auth` layout groups, the `~/*` alias and the `.server.ts`
convention, plus the Vite build files.

It deliberately emits **no** `lib/session.server.ts`, `lib/csrf.server.ts`, `lib/sse.server.ts`,
`lib/kv.server.ts` or `lib/service-logger.server.ts` — those are the session, SSE, secrets and
logger capabilities, reached through the service registry the SSR plugin attaches to every request.
The generated `createApp()` is `async`, and emits no hello-world route (an exact `/` handler
outranks the SSR catch-all under the M70g specificity rule, so it would shadow the application's own
index route).

It also shows the project's two middleware layers side by side, which a new reader otherwise has no
way to tell apart. `setu generate middleware` writes **kernel** middleware, which runs for every
request the application serves — health probes and API routes as well as SSR pages. React Router's
own route `middleware` export runs only for the SSR routes it is attached to and reads React
Router's context. The scaffold ships a worked example of the second:
`app/middleware/require-user.server.ts` redirects a visitor who is not signed in to `/login` and
puts the signed-in user on the context for the loader, and `/products` attaches it. The generated
`README.md` carries a table comparing the two, and a kernel middleware generated into a project that
installs `react-router-plugin` points at the route-level alternative in its own JSDoc.

The frontend build runs on npm even when the server runs on Deno. Deno and Workers targets get a
standalone `package.json` for Vite and React Router; Node and Bun get those dev dependencies merged
into the manifest they already have.

| Runtime              | Emits                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `node` (default)     | `package.json` (`@setu-ts/*` from npm), `tsconfig.json`, ESLint and Prettier config, `main.ts` |
| `bun`                | the same npm manifests as `node`, run with `bun`                                               |
| `deno`               | `deno.json` (`npm:@setu-ts/*` imports, `nodeModulesDir: "auto"`, `start` task), `main.ts`      |
| `cloudflare-workers` | `deno.json`, `package.json`, `wrangler.toml`, `src/index.ts` exporting `fetch` — no `listen`   |

No target emits an `.npmrc` or a JSR registry mapping: every target takes the framework from npm.

Every target also gets a `README.md` and a `.gitignore`.

## Adopting an existing project

```bash
setu adopt --name orders --port 8101
```

Converts a generated single-service project into a workspace whose first member is that project. It
moves only the entries the CLI emits, so `.git`, CI configuration and the lockfile stay at the root;
records whether the project's dependencies declare health and metrics support; moves the configured
dotenv pair when its path is a single segment; and rewrites `main.ts` to bind the port the workspace
allocated it. A multi-segment `envFilePath` is left in place and the step to move it by hand is
printed.

Rollback covers SIGINT (Ctrl+C) and caught errors only. SIGTERM, SIGKILL (`kill -9`) and power loss
end the command without rollback. Re-running `setu adopt` converges; an interrupted `new` or
`generate` can leave the files it wrote, which the next run lists in its overwrite refusal.

## Workspace operations

Since 0.11.0, a workspace root builds, tests and deploys every member from one place. The commands
read `setu.workspace.json` when they run, so a member added later is included without editing
anything.

```bash
setu workspace build                  # one image per member: <member>:<short commit>
setu workspace deploy --dry-run       # every check, and the plan, with nothing changed
setu workspace deploy                 # build, ship, apply k8s/, wait for each rollout
```

A workspace created with 0.11.0 or later also has root `build` and `deploy` scripts (Deno: tasks)
and, on npm and Bun, a root `test` script. It is the package manager's own recursion —
`npm run test --workspaces --if-present` or `bun run --filter '*' test` — so `npm test` runs every
member and library that has tests and fails if any fails. A Deno root has no `test` task: Deno's
recursion includes the root, so such a task would call itself without end. Run
`deno task --recursive test` from the root instead. An older root keeps its scripts; run the
commands above, or add the entries yourself.

`build` runs `docker build -f docker/Dockerfile --build-arg MEMBER=<member>` from the root for each
member, always passing the optional `NPMRC` build secret. `--tag` replaces the default tag (the
short commit; `<commit>-dirty-<UTC time>` with uncommitted changes, so each deploy of new edits
rolls out; or `build-<UTC timestamp>` outside git). `--registry <prefix>` names the images
`<prefix>/<member>:<tag>`; `build` itself never pushes. `--build-arg KEY=VALUE` (repeatable) and
`--network <name>` are passed to every build — for a registry other than npm, pass
`--build-arg NPM_CONFIG_REGISTRY=<url>`, and keep its token in `NPMRC`, never in a build argument.

`deploy` decides everything before it changes anything:

- **Secrets.** A member's variables are the names its committed `.env.example` declares, less those
  the generated manifest already sets (sibling hosts, the transport URL). Their values go in
  `k8s/secrets/<member>/.env`, read with the same parser as the app's `.env`. Deploy refuses, naming
  every missing variable, and refuses a values file that git tracks. Each member with values gets a
  `<member>-env` Secret, applied with `kubectl apply --server-side --force-conflicts` from stdin
  (deploy owns that Secret, so it takes over keys an earlier hand-made one set) with base64 `data:`
  — a client-side apply would store every value in plaintext in an annotation. Generated Deployments
  read it through `envFrom`; explicit `env:` entries still win. Deploy writes each Secret's
  `resourceVersion` into its member's pod-template annotation (`setu-ts.dev/secret-version`), so a
  changed Secret rolls the member out even when the tag and manifest are unchanged, and a deploy
  re-run after failing part-way still does. Afterwards deploy reads each member's pod template back
  from the cluster and, when it does not carry the Secret's current version (a `members.yaml` from
  before the annotation, a hand-edited one, an earlier deploy that failed part-way), sets it with
  `kubectl patch`, which rolls the member out. `--force-conflicts` takes over keys another writer
  set in `<member>-env`; keys only that writer owns are left in place, so remove them by hand (or
  delete the Secret once) when moving an existing Secret to deploy. Compose follows a symbolic link
  at `apps/<member>/.env`, so `setu check` refuses one. That is the only part of Compose it checks:
  a branch can also edit `docker/compose.yaml` to name any host file, so review a branch's `docker/`
  changes before running `docker compose up` on it. Values files, `.env.example` and
  `k8s/members.yaml` are read only as regular files of at most 1 MiB inside the workspace — never
  through a symbolic link — and a values file is refused when git cannot confirm it is uncommitted
  (a missing `git` included; outside a repository there is nothing to commit). kubectl's message for
  a failed Secret apply is never printed, because it can quote the values.
- **Where images go.** The context is `--context` or the current one. A `kind-<cluster>` context
  loads each image into that cluster; any other context needs `--registry`, and the images are
  pushed there.
- **What is applied.** The namespace (`--namespace`, default the workspace directory name), the
  Secrets, then `k8s/members.yaml` as it is on disk with `${NAMESPACE}`, `${WORKSPACE}` and each
  member's `image:` line filled in. A missing generated image line, an unknown placeholder, or a
  `members.yaml` written before 0.11.0 without `envFrom` is refused, with the lines to add.
- **Waiting.** `kubectl rollout status` per member, `--timeout` in kubectl's form (`300s`, `5m`;
  default `120s`). A rollout that does not finish names the member and the commands to inspect it.

Exit codes are the CLI's own: `1` for a refusal or a failed tool, `2` for a usage error (including
`deploy` on a non-kind context without `--registry`). A tool that is not installed is named.

## Wiring check

```bash
setu check            # exit 1 when a seam artifact, barrel or config is not wired; writes nothing
setu check --strict   # warnings fail too
setu sync             # rewrite every CLI-managed barrel from its directory
setu sync --dry-run   # print the barrels it would write
```

`setu check` reads the project and never loads or starts it. It reports an artifact its barrel does
not list (or a barrel listing one that is gone), a barrel `setu.config.ts` does not reference, an
artifact registered both by its barrel and by hand, an artifact or module the scan skips, and a
module nothing activates. Each finding has a stable id (`setu.E003`); errors exit `1`, warnings
print and exit `0` unless `--strict`. Silence an accepted finding in `.setu-ts/check.json`, by id or
by id and path. From a workspace root it checks every member. Generated projects carry
`@setu-ts/cli` as a development dependency and run `setu check` from their `check` script. See
[the CLI guide](https://github.com/setu-ts/setu-ts/blob/main/docs/cli.md#wiring-check-setu-check-and-setu-sync).

## Agent briefs

```bash
setu agents              # write or refresh this project's AGENTS.md
setu agents --check      # report a missing or stale section and exit 1, writing nothing
setu agents --check --strict  # also exit 1 when an installed package's agent card is missing
setu agents --dry-run    # print what the real run would do
setu new my-app --agents # scaffold, then write the brief
```

`setu agents` writes a framework-owned section between `<!-- setu-agents:begin -->` and
`<!-- setu-agents:end -->` in `AGENTS.md`, regenerated from the project's installed packages, style,
runtime and scripts; everything outside the markers is never touched. In a workspace it writes the
root file and every member's `apps/<name>/AGENTS.md`, run from the root or from a member's own
directory. The brief points each installed package at its `AGENT_CARD.md`, which every published
library package ships in its npm tarball, so a normal install delivers it. `setu agents --check` is
the CI step; it deliberately answers without an install, and `--strict` (valid only with `--check`)
adds card presence so a run whose cards were not delivered fails. A brief whose bytes already match
is reported `unchanged` and is not rewritten; `--dry-run` prints `would create`, `would update` or
`unchanged`, and both modes refuse an unwritable target before writing anything. After a successful
`setu add` the CLI prints a reminder to run `agents` through the project's pinned CLI invocation
(for example `npx @setu-ts/cli@<version> agents`) when the project already has a sectioned brief.

Writing a workspace on POSIX, from its root or a member, checks every target's directory chain up to
`/`: each directory must belong to the invoking user or root and must not be a symlink, the same
ownership rule as git's `safe.directory`. Permission bits are not checked, so a directory you own
but others can write is trusted. `--check` writes nothing and skips the check; `--dry-run` applies
it. A failure exits `1`, names the directory and reason, writes nothing, and names a remedy chosen
for the reason — replacing a link with the directory it points at, fixing a member path that is not
a directory, or running in a workspace you own — so it never falls back to standalone. This check is
skipped when ownership metadata or the invoking uid is unavailable (including Windows); it does not
protect against another process running as the same user. Missing directories pass ownership
validation only when their nearest existing ancestor and its chain pass; a missing member still
exits `1` with `<member>: not a project`, writing nothing. Standalone projects are unchecked.

The full behavior is in
[the CLI guide](https://github.com/setu-ts/setu-ts/blob/main/docs/cli.md#agent-briefs-setu-agents).

## Generating code

```bash
setu generate service user-profile
setu g service user-profile        # `g` is an alias, `n` aliases `new`
```

| Schematic          | Emits                                                                                                                                                     | Requires                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `plugin`           | `src/plugins/<name>.plugin.ts`                                                                                                                            | —                                                              |
| `module`           | `src/modules/<name>/` — index, service, routes (functional) or controller and module (class-based), schemas (with `validation-plugin`), test and e2e test | —                                                              |
| `controller`       | `src/controllers/<name>.controller.ts`                                                                                                                    | — (functional or class-based)                                  |
| `service`          | `src/services/<name>.service.ts`                                                                                                                          | —                                                              |
| `route`            | `src/controllers/<name>.routes.ts`                                                                                                                        | —                                                              |
| `schema`           | `src/shared/schemas/<name>.schemas.ts`; `src/modules/<module>/<name>.schemas.ts` with `--module`                                                          | `validation-plugin`                                            |
| `sse`              | `src/controllers/<name>.controller.ts`, plus an application-local React hook only when `react-router-plugin` and `sdk` are both installed                 | `sse-plugin`                                                   |
| `ws-route`         | `src/plugins/<name>.plugin.ts`; class-based: `src/ingress/<name>-ws-route.ingress.ts`                                                                     | `websocket-plugin`                                             |
| `middleware`       | `src/middleware/<name>.middleware.ts`                                                                                                                     | —                                                              |
| `job`              | `src/jobs/<name>.job.ts`; class-based: `src/ingress/<name>-job.ingress.ts`; functional + queue wires `QueuePlugin({ processors })`                        | `queue-plugin` in class-based or queue-owning starter projects |
| `guard`            | `src/guards/<name>.guard.ts` — delegates to `requirePermission`                                                                                           | `auth-plugin`                                                  |
| `health-indicator` | `src/health/<name>.indicator.ts`                                                                                                                          | `health-plugin`                                                |
| `metric`           | `src/metrics/<name>.metric.ts`                                                                                                                            | `metrics-plugin`                                               |
| `command-handler`  | `src/cqrs/<name>.command-handler.ts`; class-based: `src/ingress/<name>-command-handler.ingress.ts`                                                        | `cqrs-plugin`                                                  |
| `query-handler`    | `src/cqrs/<name>.query-handler.ts`; class-based: `src/ingress/<name>-query-handler.ingress.ts`                                                            | `cqrs-plugin`                                                  |
| `event-handler`    | `src/events/<name>.event-handler.ts`; class-based: `src/ingress/<name>-event-handler.ingress.ts`                                                          | `events-plugin`                                                |
| `migration`        | `src/migrations/<timestamp>-<name>.ts`                                                                                                                    | `database-plugin`, `common`                                    |

The name's casing does not matter — `user-profile`, `UserProfile`, `userProfile`, and `user_profile`
all produce identical output.

A decorator barrel is a registration list. When `setu.config.ts` does not reference its export,
`setu generate` prints the exact line to add — inline `DecoratorPlugin({ <key>: [...<EXPORT>] })`,
or the `decorators: { <key>: [...<EXPORT>] }` arm of the starter that composes the application. A
mention in a comment or a string does not count as wired.

In a generated full-stack configuration, `setu add events`, `setu add cqrs` and `setu add queue`
install the package, create its managed barrel and wire that barrel into the starter's `events`,
`cqrs` or `queue` arm. The starter already registers those plugins. Queue processors and a selected
`--queue redis` backend are merged in either add order. Existing properties, spreads, non-literal
arms and unfamiliar callback shapes are preserved; the CLI prints manual guidance when it cannot
safely edit them. A job in a starter that owns the queue requires `setu add queue` first; otherwise
generation refuses before writing and explains that the starter already runs the queue. Functional
jobs outside a queue-owning starter remain ungated.

Generating a route, controller or module checks React Router's resolved page tree with the project's
installed `react-router routes --json`. A kernel group that would take precedence over an existing
page is refused, naming the page file. For example, `setu g route products` conflicts with the
scaffold's `/products` page. Use another name, or run `setu g module api` followed by
`setu g route products --module api` to serve `/api/products`. If the local route-tree command is
unavailable or takes over 15 seconds, generation continues with a notice naming the paths to check
by hand. This executes the project's route configuration. `setu check` remains a file-reading wiring
gate: it does not execute React Router or detect a page added after a kernel route.

### Plugin awareness

`generate` reads the target project's `deno.json` `imports` (falling back to `package.json`
`dependencies` + `devDependencies`) to learn which `@setu-ts` packages are installed. It never
imports or boots your project. A schematic whose plugin is missing is refused, naming the package to
install, and `setu generate --help` lists only what is available here.

## Options

| Option                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`             | Prints `would create <path>` per file and writes absolutely nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--dir <path>`          | Operate on this directory instead of the working directory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--runtime <target>`    | On `new`, the entry shape and manifest (default `node`); on `generate`, passed to the schematic, detected from the project when omitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--template <name>`     | `new` only: choose a scaffold composition. Omitted yields the functional minimal plugin set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--env-file <path>`     | `new`, `generate app`: choose the emitted dotenv path for ConfigPlugin-backed non-Workers templates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--broker <name>`       | `new` and `add messaging`: the standalone project's message broker (`memory`, `redis`, `rabbitmq`, `nats`, `kafka`, `pubsub`, `service-bus`). Rewrites the template's `MessagingPlugin` wiring, adds the connection variable to the dotenv pair, and emits `docker/compose.yaml` starting the broker. Refused wherever it would be a silent no-op: Cloudflare Workers and templates registering no messaging. Full-stack receives starter options through config reads; `add` preserves existing options, creates only missing Compose files, and leaves dotenv unchanged.                                  |
| `--queue <name>`        | `new` and `add queue`: the job queue backend (`memory`, `redis`, `rabbitmq`). Same overlay as `--broker`, for the queue wiring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--redis-client <name>` | `new` and `add` with a Redis arm: `ioredis` (default) or `node-redis`. node-redis projects depend on `redis` and wire each plugin through a generated `src/node-redis.ts` (`nodeRedisClient(url)` over `fromNodeRedis`). A workspace records it as `redisClient`; members and `generate app` follow the workspace and refuse the flag. Refused without a Redis arm and on Workers.                                                                                                                                                                                                                          |
| `--logger <name>`       | `new`, `generate app`: `console` or `pino` for templates with logging. Defaults to `pino` on Node, Deno and Bun, `console` on Cloudflare Workers. Adds `pino` at `10.x` only when chosen (the same range in Deno's import map). Pino on Workers, minimal hosts and workspace roots refuse the flag by name. `--dry-run` reports the choice. Since 0.11.0.                                                                                                                                                                                                                                                   |
| `--yes`, `-y`           | `new` only: take every default and ask nothing. A no-op when no prompter is present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--depends-on <name>`   | `generate app`: repeat for prerequisites; root `dev` waits for their `/ready` endpoints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--module <name>`       | `generate`: place a `service`, `route`, `controller` or `schema` inside the named feature module. Functional: the file lands in `src/modules/<name>/` and the module's `index.ts` is regenerated; a module-scoped route or controller mounts at `/<module>/<name>`. Class-based: the file is written and the `@Module({ providers \| controllers })` line to add is printed — the declaration is never edited; a module-scoped service takes the token `<module>.<name>-service` (for example `billing.invoice-service`). `route --module` is functional-only, and the app-wide schematics refuse the flag. |
| `--config <path>`       | Load the app from this module instead of `./setu.config.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--help`, `-h`          | Prints usage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--version`, `-v`       | Prints the version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Every command refuses an option outside its own set — subcommand-aware for `generate app`,
`generate library`, `workspace ports`, `workspace build` and `workspace deploy` — with exit `2` and
nothing written, suggesting the nearest known name when one is within a small edit distance
(`--templat` suggests `--template`; `--base-port` suggests `--port`). A flag kept deliberately
recognized for a named refusal (`--di` and `--depends-on` on `new`, the transport flags and
`--runtime` on `generate app`) still reaches that specific message. Plugin-registered commands
accept only `--dir` and `--config`: a handler receives positionals only, so no plugin command can
read any other flag.

Exit codes: `0` success, `1` runtime error (plugin missing, file exists, write failed), `2` usage
error (unknown command or schematic, missing argument, unknown `--runtime`, an option the command
does not recognize, or a name that cannot form an identifier — empty after normalization, or
digit-leading such as `2fa`), and `130` interrupted or cancelled with built-in writes rolled back or
plugin application shutdown attempted. Incomplete recovery is reported; plugin handlers' external
side effects are not rolled back.

A relative `--dir` is resolved against the working directory.

## Devtool development

The devtool supports Deno and Node projects. `setu new --devtool`, `setu generate app --devtool` and
`setu devtool enable` opt a project into the
[local diagnostics connector](https://github.com/setu-ts/setu-ts/blob/main/packages/diagnostics-plugin/README.md).
They emit a runtime-neutral `main.dev.ts` development entry the production graph never imports. Node
adds the non-watching `dev` script (`tsx main.dev.ts`) and pins `@setu-ts/diagnostics-plugin` in
`devDependencies`; its existing `check` script already covers the entry. Deno adds `dev` and widens
`check`. A workspace member also records a `devtoolPort` in `setu.workspace.json`, allocated without
colliding with any member's application port (`setu workspace ports --reallocate` moves both
together).

```bash
setu new my-app --devtool               # Node by default; connector probes from 4919
setu new acme --workspace && cd acme
setu generate app orders --devtool      # member; the devtool port is allocated
setu devtool enable billing             # a member that already exists
setu devtool enable                     # a standalone project that already exists
# Use --runtime deno when creating a Deno project or workspace.
```

After a Node manifest changes, run `npm install`; the CLI prints this next step and never runs it.
The devtool launcher runs the development entry with `npm run dev` on Node or `deno task dev` on
Deno, supplying the session pair; run without it, use `start:dev` as usual. The entry reads
`SETU_DEVTOOL_SESSION_ID` and `SETU_DEVTOOL_SESSION_KEY` through the runtime services and refuses to
start when either is absent or malformed. It never generates, writes or prints a pair. Older
CLI-owned entries remain recognized and are upgraded when enabled again or reallocated.

In a workspace the launcher also names `SETU_DEVTOOL_MEMBER`. The generated `scripts/dev.mjs` (Node)
or `scripts/dev.ts` (Deno) forwards all three values only to that member and blanks them for every
sibling. On Node it selects the member's `dev` script and runs `start:dev` for the others; selected
children stay in the launcher's process group for shutdown. All three variable names are published
CLI surface. Deno's root `dev` task grants environment access to exactly those names.

`setu devtool enable` merges the member's own manifest and preserves unrelated keys. On Node it
never writes the root workspace `package.json`; it refuses mixed framework pins, a missing `tsx`
devDependency, a different existing `dev` script, or diagnostics in production dependencies. On Deno
it preserves developer-owned tasks and import pins. Running it twice is a no-op. A stale
`scripts/dev.mjs` or `scripts/dev.ts` without the handoff is refused: delete it and re-run to get
the current runner. Bun and Workers, starter-composed templates, and known legacy factories are
refused with their remedies. A legacy factory must widen its signature and pass the composition
through to `createApplication` before enablement can proceed.

```typescript
import type { IPlugin } from '@setu-ts/common';
import type { IKernelApplication, KernelDiagnosticsOptions } from '@setu-ts/kernel';

export function createApp(
  _env?: Readonly<Record<string, unknown>>,
  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },
): IKernelApplication {
  return createApplication({
    plugins: [RuntimePlugin(), ...(devtool?.plugins ?? [])],
    ...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),
  });
}
```

Keep the existing plugins in the array. The entry checks plugin registration and kernel diagnostics
after startup, stops the application and exits 1 if the factory discarded the composition. All
framework pins must match this CLI version before enabling; upgrade them together first. Workspace
connectors allocate from `devtoolBasePort` (recorded on first enable, default `basePort + 1000`,
capped at 65535). Standalone defaults probe 4919 through 5019 on first enablement; later enablement
retains the entry's recorded port, including while the connector runs. `--devtool-port` chooses
explicitly. `ports --reallocate` updates an untouched CLI entry along with the manifest; an edited
entry refuses the whole operation before writing. Production images exclude the entry and remove the
development connector pin before installing the remaining import map. See the
[deployment recipe](https://github.com/setu-ts/setu-ts/blob/main/docs/deployment.md#the-deno-image-is-the-members-only-dependency-source-at-runtime)
for the complete build sequence and JSONC support.

## Generated modules

`setu generate module <name>` is the aggregate schematic, and its shape follows the project's style.

**Functional** (the default): the whole feature lives in one folder — `src/modules/<name>/` holds
`<name>.routes.ts` (`GET /<name>`, `GET /<name>/:id`, `POST /<name>`, `PATCH /<name>/:id`),
`<name>.service.ts` (an in-memory `Map` the JSDoc says to replace with a repository),
`<name>.schemas.ts` (only when `validation-plugin` is installed), a CLI-owned `index.ts` that
exports only `register<Pascal>Module(router, services?)`, and — on socket targets — `<name>.test.ts`
and `<name>.e2e.test.ts`. Nothing is written under `src/controllers/` any more. The CLI-owned
`src/modules/index.ts` exports `registerModules(router, services?)`, and a functional
`setu.config.ts` calls `registerModules(app.router, app.services);` right after
`registerGeneratedRoutes(...)`; in a project scaffolded before that call existed, `g module` prints
the import line and the call to add.

**Class-based**: the module keeps `<name>.controller.ts`, `<name>.service.ts`, `<name>.module.ts`
(yours; never rewritten) and the `MODULES` barrel, and gains `<name>.schemas.ts` and the two tests.

`--module <name>` places a `service`, `route` (functional only), `controller` or `schema` inside an
existing module. Functional: the file is written in the module folder and the module's `index.ts` is
regenerated; a module-scoped route or controller mounts at `/<module>/<name>`, and a static path
such as `/invoices/summary` outranks `GET /invoices/:id`, so an `id` equal to `summary` is
unreachable through `/:id`. Class-based: the file is written and the CLI prints the line to add to
`@Module({ providers | controllers })` in `<module>.module.ts`; it never edits the declaration, and
a module-scoped service is registered under the token `<module>.<name>-service` (for example
`billing.invoice-service`). Every other schematic is app-wide and refuses the flag.

`setu generate schema <name>` (requires `validation-plugin`) writes
`src/shared/schemas/<name>.schemas.ts` — or `src/modules/<module>/<name>.schemas.ts` with `--module`
— and never edits an existing file; a second run is the ordinary overwrite refusal.

`setu new` emits `test/support/server.ts` (CLI-owned; boots `createApp()` on a free loopback port)
and `test/e2e/app.e2e.test.ts` on every socket target; a Cloudflare Workers scaffold emits neither.
`g module` adds `<name>.test.ts`, which drives the module in-process through
`createTestApp({ app: await createApp() })` — it boots the whole composition, so a plugin that needs
a live backend needs one in the test too (substitute it with `createTestApp`'s `overrides` or
`without`) — and `<name>.e2e.test.ts` over real HTTP on socket targets. The tasks split the two:
`test` runs every `*.test.ts` except `*.e2e.test.ts`; `test:e2e` runs only `*.e2e.test.ts` over real
HTTP.

The `rest` template's sample lives at `src/modules/greeting/`, so a new project's first files are
exactly what `g module` produces.

## Realtime starting points

`setu generate sse <name>` writes an SSE controller under `src/controllers/`. When the project
already has both `@setu-ts/react-router-plugin` (and therefore React) and `@setu-ts/sdk`, it also
writes an application-local `src/hooks/use-<name>.ts` React hook that imports `createSseClient`. Add
the SDK with `setu add sdk` before generating the hook. React belongs to the consuming application,
never a published Setu package.

`setu generate ws-route <name>` writes a WebSocket plugin under `src/plugins/`. It registers an
exact `/ws/<name>` route, joins the requested room, and broadcasts to other members.

Generated HTTP artifacts register through `registerGeneratedRoutes(app.router, app.services)`;
regenerated barrels also accept older one-argument route registrars.

In a class-based project, `setu generate module users` writes a controller, an injectable service,
and `src/modules/users/users.module.ts`. That application-owned file declares its contents with
`@Module({ controllers, providers })`; the CLI-managed `src/modules/index.ts` exports `MODULES`,
which `setu.config.ts` passes as `DecoratorPlugin({ modules: [...MODULES] })`. A root module is also
supported when the application should own activation: pass one `@Module({ imports: [...] })` class
directly to `DecoratorPlugin`.

Projects generated before this release have no `<name>.module.ts`. The next generation reports each
such directory instead of silently dropping it from `MODULES`. Its regenerated barrel retains the
deprecated `MODULE_CONTROLLERS` and `MODULE_SERVICES` exports, so an existing config continues to
compile and register its modules while it migrates. Add the declaration (or delete and regenerate
that module), then change `setu.config.ts` to import `MODULES` and pass `modules: [...MODULES]` to
`DecoratorPlugin`; do not retain the deprecated arrays in the new config.

**Nothing is ever overwritten.** A generate that would clobber any existing file writes none of them
— every planned path is checked before the first write, so a multi-file schematic cannot leave a
half-written tree.

## Plugin commands

A plugin publishes commands with `ctx.cli.register(name, handler)`. `setu` finds them by loading
your `setu.config.ts` and starting the application with **no port**, so nothing binds a socket. It
always stops the application afterwards, including when a handler throws.

```bash
setu commands          # list what this application's plugins provide
setu db:migrate up 3   # positionals after the name reach the handler
```

```typescript
import type { IPlugin, IPluginContext } from '@setu-ts/common';

// Your migration runner, invoked with the first positional (or `latest`).
const migrate = (target: string): Promise<void> => Promise.resolve();

export const MigrationsPlugin: IPlugin = {
  name: 'migrations',
  version: '1.0.0',
  register(ctx: IPluginContext): void {
    ctx.cli?.register('db:migrate', async (args) => {
      await migrate(args[0] ?? 'latest');
    });
  },
};
```

Handlers receive positionals only. `setu` consumes its own flags, so pass a plugin command's flags
after `--`:

```bash
setu db:migrate -- --verbose --dry
```

Built-in verbs (`new`, `generate`, `commands`, `help`) match **first**, so a plugin cannot shadow
them — and those paths never import your project. Only an unmatched first positional boots it.

Two plugins registering the same name is refused rather than resolved by load order.

> **Running a plugin command starts your application**, which means every plugin's init and
> bootstrap hooks run — a database plugin will connect. That is inherent to reading commands the
> plugins register at startup.

## Custom schematics

Drop a module in `.setu-ts/schematics/` and the CLI will load it with a real dynamic `import()`:

```typescript
// .setu-ts/schematics/readme.ts
import type { DerivedNames, GeneratedFile, SchematicOptions } from '@setu-ts/cli';

export function schematic(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  return [{ path: `docs/${names.kebab}.md`, contents: `# ${names.pascal}\n` }];
}
```

```bash
setu g custom readme order-item   # writes docs/order-item.md
```

`DerivedNames` carries `raw`, `kebab`, `camel`, `pascal`, and `screaming`. `SchematicOptions`
carries the target `runtime`, the detected `plugins` set, and `now()` — an injected clock, so
timestamped output stays deterministic. Schematics do no I/O; the CLI writes what they return, which
is what makes `--dry-run` exact.

## Programmatic use

```typescript
import { runCli } from '@setu-ts/cli';
import { createNodeRuntimeServices } from '@setu-ts/runtime';

const runtime = createNodeRuntimeServices();
const code = await runCli(['generate', 'service', 'billing'], {
  fs: runtime.fs!,
  cwd: process.cwd(),
  now: () => runtime.now(),
  log: console.log,
  error: console.error,
});
```

`runCli` returns an exit code and never exits the process. The dependency bundle has no default on
purpose: `src/main.ts` (`runMain` with `nodeProcess`) owns the process boundary, so every other path
stays testable.

## Interactive scaffolding

When run at an interactive terminal, `setu new` asks for the choices it already accepts as flags —
runtime and template on a standalone project, runtime and transport on a workspace. The broker and
queue questions follow only when the answers already given can actually take them: they are skipped
for a template registering no messaging (the minimal default, `rest`, `class-based`) and on
Cloudflare Workers; full-stack offers both, which are the same cases the flags themselves refuse. A
host with logging also asks `Logger?`, with the runtime's default first; Workers offers console
only. Every prompted value is expressible as a flag, so prompts are never a second way to configure
a project, and `--dry-run` stays exact.

Non-interactive by construction in three layers: `runCli`'s dependency bundle takes prompting as an
OPTIONAL `ask` member no programmatic caller passes; the installed executable supplies it only when
stdin is a terminal; and the reader answers `null` once input ends. All three fail closed to the
documented defaults. `--yes` is the explicit escape hatch.

## Not yet supported

- **A general `--starter` flag.** `full-stack` composes through `@setu-ts/full-stack-starter`, but
  the other templates emit inline wiring and there is no flag to pick a starter for them.
- **Flags for plugin commands.** Handlers receive positionals only; use `--` to forward flags.
- **Prompting inside `setu generate`.** A generate runs inside scripts and editor hooks; only
  `setu new` asks questions.

## License

MIT

## Exports

### `@setu-ts/cli`

| Export             | Kind      |
| ------------------ | --------- |
| `deriveNames`      | function  |
| `detectPlugins`    | function  |
| `runCli`           | function  |
| `PROGRAM_NAME`     | const     |
| `CliDependencies`  | interface |
| `DerivedNames`     | interface |
| `GeneratedFile`    | interface |
| `PromptChoice`     | interface |
| `Prompter`         | interface |
| `SchematicOptions` | interface |
| `AppLoader`        | type      |
| `ModuleLoader`     | type      |
| `PromptSelection`  | type      |
| `Schematic`        | type      |
| `TemplateName`     | type      |

### `@setu-ts/cli/main`

| Export          | Kind      |
| --------------- | --------- |
| `emitInterrupt` | function  |
| `nodeProcess`   | function  |
| `runMain`       | function  |
| `MainProcess`   | interface |
| `MainRuntime`   | interface |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#cli-setu-tscli).

## Development source policies and registration guidance

Opted-in Deno and Node scaffolds and `setu devtool enable` write the CLI-managed
`src/devtool/diagnostics.ts` approval module. `setu add` refreshes an existing module, using
artifact names and env-example keys rather than values. Source options activate only when the
factory receives its devtool argument; production keeps disabled defaults. Unknown source shapes
receive manual guidance, including the `DEVTOOL_SOURCES` import and the `sources` declaration those
lines read. The module is regenerated, so preserve application-specific policy outside that file.

Full-stack accepts `new --broker redis --queue redis`, and workspace full-stack members receive
`messaging` / `queue` options from their workspace transport. Standalone projects can use
`setu add messaging --broker redis` or `setu add queue --queue redis`; members use the workspace
transport and refuse per-member flags. The selected client is installed in runtime dependencies or
Deno imports. An absent generated full-stack option is inserted; missing queue transport properties
can merge with its processors. Existing values and unfamiliar configs receive the exact property to
configure manually. With no transport the starter uses memory. `add` preserves dotenv files and
existing Compose files, prints the connection variable and local default, and creates broker Compose
files only when the project has none. When `docker/compose.yaml` exists without the selected
broker's service, it prints the service block to add.

`setu add react-router` refuses projects without a full-stack factory or existing ReactRouterPlugin.
Use `setu new <name> --template full-stack` or `setu generate app <name> --template full-stack` in a
workspace to create the frontend and build setup.

Adding one of the twelve safe zero-configuration providers wires its emitted plugin-list anchor in
either style. Starter compositions instead name their option arm; configure that arm to avoid a
duplicate registration. In a functional project, `events`, `cqrs`, `health` and `metrics` are
registered with the generated-artifact barrel they consume, for example
`EventsPlugin({ handlers: EVENT_HANDLERS })`, and an empty barrel is created when absent, so a
handler a later `setu generate` writes is live. Class-based projects keep the bare call; their
handlers arrive through the ingress barrel. Manifest updates preserve existing key order. Deno
frontend projects update imports without adding unused framework dependencies to their frontend
package.json.

On a `cloudflare-workers` project, `setu add cloudflare` prints the registration that reads the
platform sink — `CloudflarePlugin({ env, ...(waitUntil ? { waitUntil } : {}) })` — because the
generated entry passes `waitUntil` to `createApp` as its second parameter (M113d §3.8). The factory
names that parameter `_waitUntil` while nothing reads it, so the command also tells you to rename
it. A project scaffolded before 0.10.0 has no such parameter, and its entry does not pass one; the
command points at
[docs/upgrading.md](https://github.com/setu-ts/setu-ts/blob/main/docs/upgrading.md) for both edits.

### Styled server-rendered views

`setu add view` adds `hono`, hono JSX compiler options, Tailwind 4's CLI and neutral shadcn tokens,
view files for `/ui`, CSS build/watch scripts, and `StaticPlugin` serving `build/assets/app.css`. A
`build` or `start:dev` script it creates or prefixes runs CSS first (one that already called `css`
is left as it was); run `npm run css:watch`, `bun run css:watch` or `deno task css:watch` separately
while editing. Existing files, pins and settings are preserved and reported; an unfamiliar config
receives manual registration instructions. `--dry-run` lists all planned changes and writes nothing.
Workers gets dependencies, JSX and example view files only; CSS there belongs to Wrangler static
assets. See
[the MVC guide](https://github.com/setu-ts/setu-ts/blob/main/docs/mvc.md#styling-server-rendered-views).

The full-stack template includes Tailwind through Vite, copied shadcn Button/Card, a fixed app shell
and a light/dark/system toggle. Run `npx shadcn add <component>` to add more components.
