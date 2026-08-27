# @setu-ts/cli

The `setu` command-line tool: project scaffolding and plugin-aware code generation for the Setu-TS
framework.

## Installation

```bash
deno install -g -A --min-dep-age 0 -n setu jsr:@setu-ts/cli@^0.1.0-alpha.9/main
```

The `-n setu` is required, not decorative: Deno derives the binary name from the package, which for
a package called `cli` would install a binary named `cli`. All help text shows `setu`.

## Scaffolding a project

```bash
setu new my-app                                  # Deno, minimal (runtime plugin only)
setu new my-app --runtime node                   # deno | node | bun | cloudflare-workers
setu new my-app --template rest                  # rest | microservice | class-based | full-stack
setu new my-app --template rest --env-file config/.env.local
```

Every project gets a `setu.config.ts` exporting `createApp()` — the one place its plugin list lives.
`main.ts` imports it to start the server, and `setu` imports it to find plugin commands, so the two
cannot disagree. The factory does **not** start the application.

On Deno, Node, and Bun, config-backed templates emit a gitignored `.env` and tracked `.env.example`,
and load the selected path through `ConfigPlugin({ envFilePath })`. Use `--env-file <path>` to
select another relative path. Cloudflare Workers use request bindings and therefore emit no dotenv
file or filesystem configuration; `--env-file` is refused there. Values needed while constructing a
plugin must come from this pre-construction environment source; `ConfigPlugin` cannot retroactively
configure a plugin already built.

| Template       | Plugin set                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| _(none)_       | `RuntimePlugin` only.                                                                                         |
| `rest`         | Runtime, Config, Logger, Validation, HttpSecurity, Health, Metrics, OpenApi + `errorHandler()`.               |
| `microservice` | `rest` plus Messaging, Queue, Resilience, Telemetry.                                                          |
| `class-based`  | `rest` plus decorators and DI, an `@Injectable` service, and a `@Controller` using parameter-level `@Inject`. |
| `full-stack`   | A React Router 8 SSR app: the full plugin set via `createFullStackAppFromConfig`, plus an `app/` skeleton.    |

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

The frontend build runs on npm even when the server runs on Deno. Deno and Workers targets get a
standalone `package.json` for Vite and React Router; Node and Bun get those dev dependencies merged
into the manifest they already have.

| Runtime              | Emits                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `deno`               | `deno.json` (JSR imports, `start` task), `main.ts` binding a port via `app.start()`       |
| `node` / `bun`       | `package.json` (npm-compat JSR deps), `.npmrc` mapping `@jsr`, `tsconfig.json`, `main.ts` |
| `cloudflare-workers` | `deno.json`, `wrangler.toml`, `src/index.ts` exporting `fetch` — no `listen`              |

Every target also gets a `README.md` and a `.gitignore`.

## Generating code

```bash
setu generate service user-profile
setu g service user-profile        # `g` is an alias, `n` aliases `new`
```

| Schematic          | Emits                                  | Requires           |
| ------------------ | -------------------------------------- | ------------------ |
| `plugin`           | `src/plugins/<name>.ts`                | —                  |
| `controller`       | `src/controllers/<name>.controller.ts` | `decorator-plugin` |
| `service`          | `src/services/<name>.service.ts`       | —                  |
| `route`            | `src/routes/<name>.routes.ts`          | —                  |
| `middleware`       | `src/middleware/<name>.middleware.ts`  | —                  |
| `job`              | `src/jobs/<name>.job.ts`               | —                  |
| `guard`            | `src/guards/<name>.guard.ts`           | `auth-plugin`      |
| `health-indicator` | `src/health/<name>.indicator.ts`       | `health-plugin`    |
| `metric`           | `src/metrics/<name>.metric.ts`         | `metrics-plugin`   |
| `command-handler`  | `src/cqrs/<name>.command-handler.ts`   | `cqrs-plugin`      |
| `query-handler`    | `src/cqrs/<name>.query-handler.ts`     | `cqrs-plugin`      |
| `event-handler`    | `src/events/<name>.event-handler.ts`   | `events-plugin`    |
| `migration`        | `src/migrations/<timestamp>-<name>.ts` | `database-plugin`  |

The name's casing does not matter — `user-profile`, `UserProfile`, `userProfile`, and `user_profile`
all produce identical output.

### Plugin awareness

`generate` reads the target project's `deno.json` `imports` (falling back to `package.json`
`dependencies` + `devDependencies`) to learn which `@setu-ts` packages are installed. It never
imports or boots your project. A schematic whose plugin is missing is refused, naming the package to
install, and `setu generate --help` lists only what is available here.

## Options

| Option                | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`           | Prints `would create <path>` per file and writes absolutely nothing.                                                                                                                                                                                                                                                                                                                                                        |
| `--dir <path>`        | Operate on this directory instead of the working directory.                                                                                                                                                                                                                                                                                                                                                                 |
| `--runtime <target>`  | On `new`, the entry shape and manifest; on `generate`, passed to the schematic. Default `deno`.                                                                                                                                                                                                                                                                                                                             |
| `--template <name>`   | `new` only: choose a scaffold composition. Omitted yields the functional minimal plugin set.                                                                                                                                                                                                                                                                                                                                |
| `--env-file <path>`   | `new`, `generate app`: choose the emitted dotenv path for ConfigPlugin-backed non-Workers templates.                                                                                                                                                                                                                                                                                                                        |
| `--broker <name>`     | `new` only: the standalone project's message broker (`memory`, `redis`, `rabbitmq`, `nats`, `kafka`, `pubsub`, `service-bus`). Rewrites the template's `MessagingPlugin` wiring, adds the connection variable to the dotenv pair, and emits `docker/compose.yaml` starting the broker. Refused wherever it would be a silent no-op: Cloudflare Workers, starter-composed templates, and templates registering no messaging. |
| `--queue <name>`      | `new` only: the job queue backend (`memory`, `redis`, `rabbitmq`). Same overlay as `--broker`, for the queue wiring.                                                                                                                                                                                                                                                                                                        |
| `--yes`, `-y`         | `new` only: take every default and ask nothing. A no-op when no prompter is present.                                                                                                                                                                                                                                                                                                                                        |
| `--depends-on <name>` | `generate app`: repeat for prerequisites; root `dev` waits for their `/ready` endpoints.                                                                                                                                                                                                                                                                                                                                    |
| `--config <path>`     | Load the app from this module instead of `./setu.config.ts`.                                                                                                                                                                                                                                                                                                                                                                |
| `--help`, `-h`        | Prints usage.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--version`, `-v`     | Prints the version.                                                                                                                                                                                                                                                                                                                                                                                                         |

Exit codes: `0` success, `1` runtime error (plugin missing, file exists, write failed), `2` usage
error (unknown command or schematic, missing argument, unknown `--runtime`, or a name that cannot
form an identifier — empty after normalization, or digit-leading such as `2fa`).

A relative `--dir` is resolved against the working directory.

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
register(ctx: IPluginContext): void {
  ctx.cli.register('db:migrate', async (args) => {
    await migrate(args[0] ?? 'latest');
  });
}
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
import { createDenoRuntimeServices } from '@setu-ts/runtime';

const runtime = createDenoRuntimeServices();
const code = await runCli(['generate', 'service', 'billing'], {
  fs: runtime.fs!,
  cwd: Deno.cwd(),
  now: () => runtime.now(),
  log: console.log,
  error: console.error,
});
```

`runCli` returns an exit code and never calls `Deno.exit`. The dependency bundle has no default on
purpose: `src/main.ts` owns the process boundary, so every other path stays testable.

## Interactive scaffolding

When run at an interactive terminal, `setu new` asks for the choices it already accepts as flags —
runtime and template on a standalone project, runtime and transport on a workspace. The broker and
queue questions follow only when the answers already given can actually take them: they are skipped
for a template registering no messaging (the minimal default, `rest`, `class-based`), for the
starter-composed `full-stack`, and on Cloudflare Workers, which are the same cases the flags
themselves refuse. So `--template microservice` is asked four questions and the default is asked
two. Every prompted value is expressible as a flag, so prompts are never a second way to configure a
project, and `--dry-run` stays exact.

Non-interactive by construction in three layers: `runCli`'s dependency bundle takes prompting as an
OPTIONAL `ask` member no programmatic caller passes; the installed executable supplies it only when
stdin is a terminal; and Deno's own prompt returns `null` on a non-terminal. All three fail closed
to the documented defaults. `--yes` is the explicit escape hatch.

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

| Export | Kind |
| --- | --- |
| `deriveNames` | function |
| `detectPlugins` | function |
| `runCli` | function |
| `PROGRAM_NAME` | const |
| `CliDependencies` | interface |
| `DerivedNames` | interface |
| `GeneratedFile` | interface |
| `PromptChoice` | interface |
| `Prompter` | interface |
| `SchematicOptions` | interface |
| `AppLoader` | type |
| `ModuleLoader` | type |
| `Schematic` | type |
| `TemplateName` | type |

### `@setu-ts/cli/main`

| Export | Kind |
| --- | --- |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#cli-setu-tscli).
