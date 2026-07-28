# @hono-enterprise/cli

The `honoe` command-line tool: project scaffolding and plugin-aware code generation for the Hono
Enterprise framework.

## Installation

```bash
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.2/main
```

The `-n honoe` is required, not decorative: Deno derives the binary name from the package, which for
a package called `cli` would install a binary named `cli`. All help text shows `honoe`.

## Scaffolding a project

```bash
honoe new my-app                                  # Deno (default)
honoe new my-app --runtime node                   # deno | node | bun | cloudflare-workers
```

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

| Schematic          | Emits                                  | Requires          |
| ------------------ | -------------------------------------- | ----------------- |
| `plugin`           | `src/plugins/<name>.ts`                | —                 |
| `controller`       | `src/controllers/<name>.controller.ts` | —                 |
| `service`          | `src/services/<name>.service.ts`       | —                 |
| `route`            | `src/routes/<name>.routes.ts`          | —                 |
| `middleware`       | `src/middleware/<name>.middleware.ts`  | —                 |
| `job`              | `src/jobs/<name>.job.ts`               | —                 |
| `guard`            | `src/guards/<name>.guard.ts`           | `auth-plugin`     |
| `health-indicator` | `src/health/<name>.indicator.ts`       | `health-plugin`   |
| `metric`           | `src/metrics/<name>.metric.ts`         | `metrics-plugin`  |
| `command-handler`  | `src/cqrs/<name>.command-handler.ts`   | `cqrs-plugin`     |
| `query-handler`    | `src/cqrs/<name>.query-handler.ts`     | `cqrs-plugin`     |
| `event-handler`    | `src/events/<name>.event-handler.ts`   | `events-plugin`   |
| `migration`        | `src/migrations/<timestamp>-<name>.ts` | `database-plugin` |

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
| `--help`, `-h`       | Prints usage.                                                                                   |
| `--version`, `-v`    | Prints the version.                                                                             |

Exit codes: `0` success, `1` runtime error (plugin missing, file exists, write failed), `2` usage
error (unknown command or schematic, missing argument, unknown `--runtime`, or a name that cannot
form an identifier — empty after normalization, or digit-leading such as `2fa`).

A relative `--dir` is resolved against the working directory.

**Nothing is ever overwritten.** A generate that would clobber any existing file writes none of them
— every planned path is checked before the first write, so a multi-file schematic cannot leave a
half-written tree.

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

- **Plugin-contributed commands.** `ICliApi` / `CAPABILITIES.CLI_COMMAND` let a plugin register
  commands, but discovering them requires booting your application — deferred to a later milestone.
- **`new --template rest|microservice`.** The starter packages arrive in Milestone 36.

## License

MIT
