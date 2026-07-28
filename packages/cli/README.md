# @hono-enterprise/cli

The `honoe` command-line tool: project scaffolding and plugin-aware code generation for the Hono
Enterprise framework.

## Installation

```bash
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.1/main
```

The `-n honoe` is required, not decorative: Deno derives the binary name from the package, which for
a package called `cli` would install a binary named `cli`. All help text shows `honoe`.

## Scaffolding a project

```bash
honoe new my-app                                  # Deno, minimal (runtime plugin only)
honoe new my-app --runtime node                   # deno | node | bun | cloudflare-workers
honoe new my-app --template rest                  # rest | microservice
```

Every project gets a `honoe.config.ts` exporting `createApp()` — the one place its plugin list
lives. `main.ts` imports it to start the server, and `honoe` imports it to find plugin commands, so
the two cannot disagree. The factory does **not** start the application.

| Template       | Plugin set                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| _(none)_       | `RuntimePlugin` only.                                                                                      |
| `rest`         | Runtime, Config, Logger, Validation, HttpSecurity, Health, Metrics, OpenApi, Decorator + `errorHandler()`. |
| `microservice` | `rest` plus Messaging, Queue, Resilience, Telemetry.                                                       |

`--template microservice --runtime cloudflare-workers` is refused: the messaging and queue plugins
need raw sockets, which Workers does not provide.

| Runtime              | Emits                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `deno`               | `deno.json` (JSR imports, `start` task), `main.ts` binding a port via `app.start()`       |
| `node` / `bun`       | `package.json` (npm-compat JSR deps), `.npmrc` mapping `@jsr`, `tsconfig.json`, `main.ts` |
| `cloudflare-workers` | `deno.json`, `wrangler.toml`, `src/index.ts` exporting `fetch` — no `listen`              |

Every target also gets a `README.md` and a `.gitignore`.

## Generating code

```bash
honoe generate service user-profile
honoe g service user-profile        # `g` is an alias, `n` aliases `new`
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
`dependencies` + `devDependencies`) to learn which `@hono-enterprise` packages are installed. It
never imports or boots your project. A schematic whose plugin is missing is refused, naming the
package to install, and `honoe generate --help` lists only what is available here.

## Options

| Option               | Behavior                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `--dry-run`          | Prints `would create <path>` per file and writes absolutely nothing.                            |
| `--dir <path>`       | Operate on this directory instead of the working directory.                                     |
| `--runtime <target>` | On `new`, the entry shape and manifest; on `generate`, passed to the schematic. Default `deno`. |
| `--template <name>`  | `new` only: `rest` or `microservice`. Omitted yields the minimal plugin set.                    |
| `--config <path>`    | Load the app from this module instead of `./honoe.config.ts`.                                   |
| `--help`, `-h`       | Prints usage.                                                                                   |
| `--version`, `-v`    | Prints the version.                                                                             |

Exit codes: `0` success, `1` runtime error (plugin missing, file exists, write failed), `2` usage
error (unknown command or schematic, missing argument, unknown `--runtime`, or a name that cannot
form an identifier — empty after normalization, or digit-leading such as `2fa`).

A relative `--dir` is resolved against the working directory.

**Nothing is ever overwritten.** A generate that would clobber any existing file writes none of them
— every planned path is checked before the first write, so a multi-file schematic cannot leave a
half-written tree.

## Plugin commands

A plugin publishes commands with `ctx.cli.register(name, handler)`. `honoe` finds them by loading
your `honoe.config.ts` and starting the application with **no port**, so nothing binds a socket. It
always stops the application afterwards, including when a handler throws.

```bash
honoe commands          # list what this application's plugins provide
honoe db:migrate up 3   # positionals after the name reach the handler
```

```typescript
register(ctx: IPluginContext): void {
  ctx.cli.register('db:migrate', async (args) => {
    await migrate(args[0] ?? 'latest');
  });
}
```

Handlers receive positionals only. `honoe` consumes its own flags, so pass a plugin command's flags
after `--`:

```bash
honoe db:migrate -- --verbose --dry
```

Built-in verbs (`new`, `generate`, `commands`, `help`) match **first**, so a plugin cannot shadow
them — and those paths never import your project. Only an unmatched first positional boots it.

Two plugins registering the same name is refused rather than resolved by load order.

> **Running a plugin command starts your application**, which means every plugin's init and
> bootstrap hooks run — a database plugin will connect. That is inherent to reading commands the
> plugins register at startup.

## Custom schematics

Drop a module in `.hono-enterprise/schematics/` and the CLI will load it with a real dynamic
`import()`:

```typescript
// .hono-enterprise/schematics/readme.ts
import type { DerivedNames, GeneratedFile, SchematicOptions } from '@hono-enterprise/cli';

export function schematic(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  return [{ path: `docs/${names.kebab}.md`, contents: `# ${names.pascal}\n` }];
}
```

```bash
honoe g custom readme order-item   # writes docs/order-item.md
```

`DerivedNames` carries `raw`, `kebab`, `camel`, `pascal`, and `screaming`. `SchematicOptions`
carries the target `runtime`, the detected `plugins` set, and `now()` — an injected clock, so
timestamped output stays deterministic. Schematics do no I/O; the CLI writes what they return, which
is what makes `--dry-run` exact.

## Programmatic use

```typescript
import { runCli } from '@hono-enterprise/cli';
import { createDenoRuntimeServices } from '@hono-enterprise/runtime';

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

## Not yet supported

- **Starter-backed templates.** `--template` emits inline wiring; templates that resolve to
  `@hono-enterprise/*-starter` wait on Milestone 36, which owns those packages.
- **Flags for plugin commands.** Handlers receive positionals only; use `--` to forward flags.
- **Plugin installation.** `honoe` generates and dispatches; it does not edit your manifest.

## License

MIT
