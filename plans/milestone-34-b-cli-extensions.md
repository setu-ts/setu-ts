# Milestone 34b — CLI extensions (`@hono-enterprise/cli`)

> **Status:** Planning. Branch: `feat/m34b-cli-extensions`, rebased onto `main` after M34 merged (PR
> #88, merge commit `004f49f`), so it carries M34's six code-review fixes — notably `resolveDir`,
> which §3.4/§3.5 build on. `main` is protected — all work (implementation + fixes) stays on this
> one branch until it merges via a single PR.

## 0. Objective & scope

Add the two capabilities M34 deferred, as pure additions to the existing `honoe` binary: a
`--template` flag on `honoe new` that scaffolds an opinionated multi-plugin project, and discovery
and dispatch of **plugin-contributed CLI commands** registered through the committed `ICliApi`. The
second is the reason this is a separate milestone: reading a plugin's commands requires importing
and booting the user's application, which brings entry-point discovery, a no-socket boot, and
teardown — none of which the M34 "emit source text, never run anything" boundary allowed.

- **In scope:** `honoe new --template rest|microservice` emitting inline plugin wiring; a
  `honoe.config.ts` app seam emitted by `new` and consumed by the CLI; `honoe <plugin>:<command>`
  dispatch to plugin-registered handlers; a `honoe commands` verb that lists them; the doc
  corrections these two make necessary.
- **NOT this milestone:**
  - Templates backed by the `@hono-enterprise/*-starter` packages — those packages export nothing
    today (§1) and **Milestone 36** owns them. §3.1 explains why this milestone does not wait.
  - The client SDK (**Milestone 35**) and example applications (**Milestone 37**).
  - Interactive prompts, plugin installation, and dependency management (§9).

## 1. Contracts verified from SOURCE (not names)

| Reference                        | Source (file:line)                                                                                                                     | Verified surface / fact                                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ICliApi`                        | `packages/common/src/plugin.ts:275`                                                                                                    | Exactly one method: `register(name: string, handler: CliCommandHandler): void`. Its JSDoc states the convention `plugin:command`. No list/introspect method — the CLI reads the registry, not this interface.                      |
| `CliCommandHandler`              | `packages/common/src/plugin.ts:261`                                                                                                    | `(args: readonly string[]) => void \| Promise<void>`. Takes positionals only — **no flags object and no exit code**. A handler signals failure by throwing; §3.9 maps that to an exit code.                                        |
| `CAPABILITIES.CLI_COMMAND`       | `packages/common/src/tokens.ts:115`                                                                                                    | `'cli-command'`. Already committed; this milestone adds no token.                                                                                                                                                                  |
| Kernel `ctx.cli.register`        | `packages/kernel/src/application/application.ts:214-222`                                                                               | Registers the object literal `{ name, handler }` under `CAPABILITIES.CLI_COMMAND` with `{ multi: true }`. The registration SHAPE is `{ name, handler }` — this is the exact type the consumption site must re-declare.             |
| Multi-token consumption          | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:294`                                                                         | Precedent: `ctx.services.getAll<{ name: string; handler: DecoratorHandler }>(TOKEN)`. The shape is re-declared structurally at the reader; no shared registration type is exported. This milestone follows that precedent exactly. |
| `IServiceRegistry.getAll`        | `packages/common/src/registry.ts:105`                                                                                                  | `getAll<T extends object>(token: CapabilityToken): readonly T[]`. Returns an array; does not throw when the token is unregistered.                                                                                                 |
| `IApplication`                   | `packages/common/src/plugin.ts:376`                                                                                                    | `router`, `middleware`, `services`, `register`, `start(options?)`, `stop()`, `fetch(request)`. `services` is reachable WITHOUT starting — but the registry is only populated by `start()` (see next row).                          |
| `StartOptions`                   | `packages/common/src/plugin.ts:363`                                                                                                    | `{ port?: number; hostname?: string }` — **both optional**, so `start()` with no argument is legal.                                                                                                                                |
| `start()` binds no socket        | `packages/kernel/src/application/application.ts:325-336`                                                                               | Step 9 is gated on `options?.port !== undefined`. With no port, no `listen` happens. This is what makes booting for command discovery safe.                                                                                        |
| `start()` DOES run hooks         | `packages/kernel/src/application/application.ts:300-322`                                                                               | Steps 4-7 run env validation, `runInit()`, pipeline compile, and `runBootstrap()` UNCONDITIONALLY. A database plugin's connect therefore happens during discovery — a real cost, not avoidable via the committed surface (§8).     |
| `stop()` is safe and idempotent  | `packages/kernel/src/application/application.ts:338-352`                                                                               | No-op when never started; a cached promise makes repeat calls run shutdown once. Safe to call unconditionally in a `finally` (§3.10).                                                                                              |
| Starters export nothing          | `packages/starters/rest-starter/src/index.ts:10`                                                                                       | The file's only statement is `export {};`. Identical in `microservice-starter` and `full-stack-starter`. A generated import of these packages would resolve to an empty module — the reason §3.1 does not use them.                |
| M36 owns starters, as a library  | `ROADMAP.md:3543-3559`                                                                                                                 | M36 ships `createRestApp()` / `createMicroserviceApp()` factory functions — a runtime library, not a scaffold. Non-overlapping with a template that emits wiring as source (§3.1).                                                 |
| Every plugin factory is 0-arg    | `packages/{config,logger,validation,openapi,health,http-security,metrics,messaging,queue,resilience,telemetry}-plugin/src/plugin/*.ts` | Each exports `XxxPlugin(options?)` / `XxxPlugin(options = {})` — **all options optional**, so template wiring compiles with no required configuration. Verified factory-by-factory, not assumed.                                   |
| `exceptions` ships no plugin     | `packages/exceptions/src/middleware/error-handler.ts:89`                                                                               | `errorHandler(options?: ErrorHandlerOptions): MiddlewareFunction`. The package exports middleware, NOT an `IPlugin`; template wiring must use `app.middleware.add(errorHandler())`, never `ExceptionsPlugin()`.                    |
| M34 `runCli` / `CliDependencies` | `packages/cli/src/cli.ts:23,78`                                                                                                        | `runCli(argv, deps)`; `deps` is REQUIRED and carries `fs`, `cwd`, `now`, `log`, `error`, `load?`. This milestone adds one optional member (§4.1), keeping the shape backward compatible.                                           |
| M34 `ModuleLoader` is unexported | `packages/cli/src/schematics/custom.ts:23`                                                                                             | `export type ModuleLoader = (url: string) => Promise<Record<string, unknown>>` — exported from its module but **absent from `src/index.ts`**, so `CliDependencies.load` names a type a consumer cannot import. Conflict C3.        |
| M34 generated `main.ts`          | `packages/cli/src/commands/new.ts:58`                                                                                                  | Emits top-level `await app.start({ port: 3000 })`. Importing this module WOULD bind a socket — the direct reason the CLI must not use `main.ts` as its app seam (§3.4).                                                            |
| Plan file naming                 | `scripts/plan-lint.ts:41`                                                                                                              | `CANONICAL_ROOT = /^(?:milestone-\d+-[a-z0-9.-]+\|TEMPLATE\|README)\.md$/` — a `milestone-34b-…` name FAILS the check. Hence this file is `milestone-34-b-cli-extensions.md`, matching the archived M14b/M15b/M24b convention.     |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                              | Resolution (picked side)                                                                                                                                                                     | Doc deliverable (same PR)                                                                                         |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| C1 | M34 shipped an `ICliApi` JSDoc saying the CLI "does NOT yet consume this" and records it as registration-only. This milestone consumes it.                                            | Consume it. The JSDoc becomes accurate again: describe the contract AND name `honoe` as the reader, without re-introducing M34's overclaim (it must say discovery requires booting the app). | Reword the `ICliApi` doc comment in `packages/common/src/plugin.ts`.                                              |
| C2 | M34's PUBLIC_API "Not in this release" section lists BOTH `--template` and plugin-contributed commands as absent; M34's README and CLAUDE.md status say the same.                     | Both ship here. Remove them from the deferral list rather than leaving a shipped feature documented as missing.                                                                              | Update the PUBLIC_API CLI section, `packages/cli/README.md`, and the CLAUDE.md M34 entry to point at M34b.        |
| C3 | `CliDependencies.load?: ModuleLoader` is a public member whose type is not exported from `src/index.ts` (§1), so a consumer cannot name it. This milestone adds a second such member. | Export both `ModuleLoader` and the new `AppLoader` from the barrel. A public interface member whose type cannot be imported is an incomplete surface, not a style choice.                    | Add both types to `src/index.ts` and to the PUBLIC_API programmatic-API table.                                    |
| C4 | PUBLIC_API (pre-M34) documented `--template rest\|microservice` as producing starter-based projects; the starter packages export nothing (§1).                                        | `--template` emits **inline plugin wiring**, not starter imports (§3.1). Starter-backed templates remain M36's option, not a promise made here.                                              | State the inline-wiring semantics explicitly in PUBLIC_API and the package README, and note the M36 relationship. |
| C5 | ROADMAP M34's command block documents `honoe new … [--runtime …]` with no `--template`, and lists no `commands` verb.                                                                 | Add both to the ROADMAP M34 block under a M34b sub-heading, so the single CLI surface is documented in one place rather than split across two milestone sections.                            | Extend the ROADMAP M34 command list and add the M34b deliverables checklist and Progress Tracking row.            |

## 3. Design decisions

### 3.1 What `--template` generates

- **Decision:** A template emits **inline plugin wiring as source** in the generated
  `honoe.config.ts` — a `createApplication({ plugins: [...] })` call listing the template's plugins
  explicitly, plus the matching `imports` entries in the generated manifest. It does **not** import
  any `@hono-enterprise/*-starter` package.
- **Why:** The starter packages' `src/index.ts` is `export {};` (§1), so a generated starter import
  would resolve to an empty module and the project would not compile — the exact failure C4 exists
  to prevent. Waiting for M36 would block this milestone on another. Inline wiring is also better
  scaffolding: the user can see and edit the plugin list, which is the point of a scaffold, whereas
  M36's `createRestApp()` is a library for people who do not want to. The two are complementary, not
  competing.
- **Test home:** `test/unit/new-command.test.ts` asserts a `--template rest` project's
  `honoe.config.ts` contains each expected `XxxPlugin()` call and that its manifest declares a
  matching import; and asserts NO generated file mentions `-starter`.

### 3.2 The template set and its exact plugin list

- **Decision:** Two templates. `rest` wires `RuntimePlugin`, `ConfigPlugin`, `LoggerPlugin`,
  `ValidationPlugin`, `HttpSecurityPlugin`, `HealthPlugin`, `MetricsPlugin`, `OpenApiPlugin`, plus
  `app.middleware.add(errorHandler())` from `@hono-enterprise/exceptions`. `microservice` is `rest`
  plus `MessagingPlugin`, `QueuePlugin`, `ResiliencePlugin`, `TelemetryPlugin`. Omitting
  `--template` keeps M34's current minimal output byte-for-byte.
- **Why:** Every factory listed takes optional options (§1), so the emitted wiring compiles with no
  configuration — a scaffold that requires editing before it builds is a broken scaffold.
  `exceptions` is middleware and not a plugin (§1), so it is added through `middleware.add`; getting
  this wrong would emit `ExceptionsPlugin()`, which does not exist. `database-plugin` and
  `auth-plugin` are deliberately excluded despite M36's REST list: both need real credentials to do
  anything, so scaffolding them produces code that starts and then fails at first use.
- **Test home:** `test/unit/schematics/templates.test.ts` asserts each template's exact plugin list
  and that `microservice` is a strict superset of `rest`; `test/e2e/template-e2e.test.ts`
  type-checks the generated project.

### 3.3 Template and runtime compatibility

- **Decision:** `--template` and `--runtime` are orthogonal except for one refusal: `microservice`
  with `--runtime cloudflare-workers` is a usage error (exit `2`) naming the incompatible plugins.
  Every other pairing is generated.
- **Why:** `MessagingPlugin` and `QueuePlugin` reach brokers and queues over raw sockets, which
  Cloudflare Workers does not provide; emitting that combination produces a project that deploys and
  then fails at runtime. Refusing at scaffold time, with the reason named, is strictly better than a
  runtime surprise. `rest` is refused nowhere because each of its plugins is Workers-portable.
- **Test home:** `test/unit/new-command.test.ts` asserts exit `2` with zero writes for that pairing,
  and exit `0` for `rest` on all four runtimes.

### 3.4 The application seam: `honoe.config.ts`

- **Decision:** The CLI locates the user's application at `<dir>/honoe.config.ts`, which must export
  `createApp(): IApplication | Promise<IApplication>`. `--config <path>` overrides the location.
  `honoe new` emits this file for every template including the default, and the generated `main.ts`
  becomes `import { createApp } from './honoe.config.ts'` followed by
  `await (await createApp()).start({ port: 3000 })`.
- **Why:** M34's generated `main.ts` calls `await app.start({ port: 3000 })` at module scope (§1),
  so importing it to discover commands would bind a socket — the CLI cannot use it. A factory export
  is the only shape that lets the CLI obtain an unstarted application. Emitting it from `new` means
  the plugin list has ONE home that both the server entry and the CLI read, so they can never
  disagree.
- **Test home:** `test/unit/new-command.test.ts` asserts `honoe.config.ts` exports `createApp` and
  that `main.ts` imports from it rather than re-declaring the plugin list;
  `test/e2e/template-e2e.test.ts` type-checks both files together.

### 3.5 Loading the application module

- **Decision:** An `AppLoader` seam, `(url: string) => Promise<Record<string, unknown>>`, defaulting
  to a real dynamic `await import(url)`. It reuses the M34 `importModule` implementation rather than
  adding a second loader. Absence of the config file, a module without `createApp`, a `createApp`
  that is not a function, and a `createApp` that throws are four distinct errors, each naming the
  resolved path and what was expected.
- **Why:** CLAUDE.md forbids fake lazy imports; the M34 custom-schematic loader established exactly
  this pattern with a guarded real-import test, and a second mechanism for the same job would be the
  duplication AI_GUIDELINES §11.1 forbids.
- **Test home:** `test/unit/app-loader.test.ts` drives the four failure branches plus success
  through an injected loader; `test/integration/app-loader-real-import.test.ts` writes a real config
  module to a temp directory and loads it through the **real** default loader.

### 3.6 Booting without a socket

- **Decision:** Command discovery calls `createApp()`, then `await app.start()` with **no
  argument**, reads the registry, and always tears down (§3.10). It never passes a port.
- **Why:** `start()` skips `listen` when `options?.port` is undefined (§1, `application.ts:325`), so
  the plugin registry is populated with no socket bound and no port conflict. There is no lighter
  path on the committed surface: registration, init hooks, and bootstrap hooks are one sequence
  inside `#runStartup`, so this milestone cannot register plugins without also running their hooks.
  That cost is documented, not hidden (§8).
- **Test home:** `test/integration/plugin-commands.test.ts` boots a real kernel application carrying
  a plugin that registers a command, and asserts the command runs while no socket was bound.

### 3.7 Reading and dispatching plugin commands

- **Decision:** Read
  `services.getAll<{ name: string; handler: CliCommandHandler }>(
  CAPABILITIES.CLI_COMMAND)` — the
  shape re-declared structurally at the call site, matching the decorator-plugin precedent (§1).
  Built-in verbs (`new`, `n`, `generate`, `g`, `commands`, `help`) are matched FIRST and always win;
  only an unmatched first positional triggers a boot. The handler receives the positionals after the
  command name, per `CliCommandHandler` (§1).
- **Why:** Built-in precedence means a third-party plugin can never shadow `honoe new`, and matching
  before booting means the common path stays fast — `honoe g service x` must not import the user's
  application. Re-declaring the shape follows the one existing precedent rather than inventing a
  shared exported type that `common` does not have.
- **Test home:** `test/unit/plugin-commands.test.ts` asserts a plugin command named `new` does not
  shadow the built-in and that no boot is attempted for a built-in verb.

### 3.8 Duplicate command names

- **Decision:** Two plugins registering the same command name is an error (exit `1`) naming the
  command and the count, refusing to run any of them. Detected when the command list is read.
- **Why:** The kernel registers CLI commands with `{ multi: true }` (§1), so it accepts duplicates
  silently; `getAll` returns both. Picking the first would make which plugin wins depend on
  registration order, which is dependency-resolution order — a behavior no user can predict.
  Refusing is the only defensible choice.
- **Test home:** `test/unit/plugin-commands.test.ts` drives two registrations of one name and
  asserts exit `1` with neither handler invoked.

### 3.9 The `commands` verb and exit codes

- **Decision:** `honoe commands` boots the application and lists every discovered command with its
  providing plugin, exit `0` — including when the list is empty, which prints an explanatory line
  rather than nothing. Dispatch exit codes: a handler that returns normally is `0`; a handler that
  throws is `1` with its message; an unmatched command with no config file present is `2` naming
  `honoe.config.ts`; an unmatched command WITH a config file present is `2` listing the available
  commands.
- **Why:** Listing needs its own verb because it is expensive — folding it into `honoe help` would
  make the cheapest command boot the user's application. `CliCommandHandler` returns
  `void | Promise<void>` with no exit code (§1), so throwing is the only failure channel a handler
  has, and mapping it to `1` matches M34's "runtime error" code. Distinguishing the two unmatched
  cases turns "unknown command" into an actionable message.
- **Test home:** `test/unit/plugin-commands.test.ts` covers each code; `test/unit/cli.test.ts`
  asserts `commands` is reachable and that the empty list still exits `0`.

### 3.10 Teardown

- **Decision:** Every path that starts an application calls `await app.stop()` in a `finally`,
  including when the handler throws and when duplicate detection refuses to dispatch.
- **Why:** `start()` runs bootstrap hooks that may hold connections, timers, or pools (§1); leaving
  them open would hang the process after the command finishes. `stop()` is a no-op when the
  application never started and is idempotent (§1, `application.ts:338`), so calling it
  unconditionally is safe on every path including a failed `start()`.
- **Test home:** `test/unit/plugin-commands.test.ts` asserts `stop` was called after a successful
  command, after a throwing handler, and after a failed `start`.

## 4. Exported surface — every symbol names its consumer

Additions to the existing nine M34 exports. Nothing else is added, and nothing existing is removed
or renamed — `runCli`'s signature is unchanged.

| Exported symbol | Kind | Consumer / real code path that READS it                                                                                                                                      |
| --------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppLoader`     | type | The type of the new `CliDependencies.loadApp` member (§4.1) — a public member whose type must be importable (conflict C3). Injected by every `plugin-commands` unit test.    |
| `ModuleLoader`  | type | Pre-existing type of `CliDependencies.load`, currently unexported (§1). Same justification; this is the C3 correction, not new surface.                                      |
| `TemplateName`  | type | The `--template` value union. Read by `runCli` callers building argv programmatically and asserted by `test/unit/schematics/templates.test.ts` against the generated wiring. |

`createApp`, `honoe.config.ts`, and the command names are user-project conventions, not exports. The
template definitions stay **internal** — they are reached through `runCli` and never imported by a
consumer, so exporting them would be surface with no reader.

### 4.1 Options — every option names its consumer

| Option                          | Consumer                      | Behavior (per implementation)                                                                                                                                                    |
| ------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--template rest\|microservice` | `commands/new.ts`             | Selects the plugin set written into the generated `honoe.config.ts` and the manifest imports (§3.2). Omitted keeps M34's minimal output unchanged. An unknown value is exit `2`. |
| `--config <path>`               | `commands/plugin-commands.ts` | Overrides the `honoe.config.ts` location the app is loaded from (§3.4). Consumed by `commands` and by plugin-command dispatch; ignored by `new` and `generate`.                  |
| `CliDependencies.loadApp?`      | `cli.ts` → dispatch           | Injectable {@linkcode AppLoader}; defaults to the real dynamic import (§3.5). Every unit test in `plugin-commands.test.ts` supplies it.                                          |

No option is stored without a reader; each row names the file that branches on it. `--dry-run` and
`--dir` keep their M34 behavior and gain no new meaning here.

## 5. Implementation files

| File                              | Purpose                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/index.ts`                    | Barrel: the three additions in §4, each with JSDoc.                                                |
| `src/cli.ts`                      | Built-in-verb match first, `commands` verb, fall through to plugin dispatch (§3.7); `loadApp` dep. |
| `src/constants.ts`                | `TEMPLATES` / `TemplateName`, the `config` value flag, and the new exit-code call sites.           |
| `src/commands/new.ts`             | `--template` handling, `honoe.config.ts` emission, `main.ts` importing it (§3.1, §3.2, §3.4).      |
| `src/commands/plugin-commands.ts` | `commands` listing, discovery, duplicate detection, dispatch, teardown (§3.7-§3.10).               |
| `src/templates/rest.ts`           | The `rest` plugin set and its generated wiring.                                                    |
| `src/templates/microservice.ts`   | The `microservice` plugin set, composed from `rest`.                                               |
| `src/templates/registry.ts`       | Name → template map; the single source `new` and the help text read.                               |
| `src/app-loader.ts`               | `AppLoader` seam, config-path resolution, and the four load-failure errors (§3.5).                 |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                         | src covered                                     | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/app-loader.test.ts`                    | `src/app-loader.ts`                             | `loadApp(dir, config, load?): Promise<IApplication>` — missing file, module without `createApp`, `createApp` not a function, `createApp` throws, success; `--config` overrides the resolved path.                                                                                      |
| `test/unit/plugin-commands.test.ts`               | `src/commands/plugin-commands.ts`               | Dispatch passes the trailing positionals; duplicate name exits `1` with neither handler run; unknown-with-config exits `2` listing commands; unknown-without-config exits `2` naming `honoe.config.ts`; `stop` called in every case including a throwing handler and a failed `start`. |
| `test/unit/new-command.test.ts` (extended)        | `src/commands/new.ts`                           | Each template writes its plugin set into `honoe.config.ts`; `main.ts` imports `createApp`; no file mentions `-starter`; `microservice` + `cloudflare-workers` exits `2` with zero writes; unknown template exits `2`; omitting `--template` reproduces M34's output.                   |
| `test/unit/schematics/templates.test.ts`          | `src/templates/{rest,microservice,registry}.ts` | `template(names, options): readonly GeneratedFile[]` — exact plugin list per template, `microservice` ⊃ `rest`, `errorHandler()` added via `middleware.add` and never as a plugin, registry lookup misses cleanly on inherited property names.                                         |
| `test/unit/cli.test.ts` (extended)                | `src/cli.ts`, `src/constants.ts`                | A plugin command named `new` does not shadow the built-in; no boot is attempted for a built-in verb; `commands` exits `0` on an empty list; `loadApp` is forwarded from `CliDependencies`.                                                                                             |
| `test/unit/barrel-exports.test.ts` (extended)     | `src/index.ts`                                  | The three §4 additions are importable and nothing beyond the committed set is exported.                                                                                                                                                                                                |
| `test/integration/app-loader-real-import.test.ts` | `src/app-loader.ts` (default loader)            | Writes a real `honoe.config.ts` to a temp directory and loads it via the **real** `import()` — the guarded real-path test CLAUDE.md requires for a lazy import.                                                                                                                        |
| `test/integration/plugin-commands.test.ts`        | discovery against a real kernel app             | Boots a REAL `createApplication` carrying a plugin that calls `ctx.cli.register`, asserts the handler runs with the right args, that no socket was bound, and that `stop()` ran.                                                                                                       |
| `test/e2e/template-e2e.test.ts`                   | `new --template` end-to-end                     | Scaffolds each template into a real temp directory, reads the files back, and runs `deno check` on the generated project against the real published packages — the §8 drift gate, automated. Generation runs over the **hostile name set** of §6.1, never one happy-path name.         |

Every new `src/` file above has a named test file. `src/main.ts` remains excluded from the bar for
the M34 reason: it is the process-terminating wrapper §3.12 of the M34 plan exists to isolate.

### 6.1 The hostile name set — generation is exercised over all of it

Every `deno check` in the e2e gate runs generation over this set, not a single name:

| Name            | What it would have caught                                                          |
| --------------- | ---------------------------------------------------------------------------------- |
| `order-item`    | The ordinary multi-word path.                                                      |
| `class`         | A reserved word in a binding position — M34 emitted `(class) => {`, a SyntaxError. |
| `new`           | A reserved word that is also a CLI verb.                                           |
| `2fa`           | A digit-leading name — M34 emitted `class 2faService`, an invalid identifier.      |
| `API`           | An all-caps segment, whose Pascal form is `Api` rather than `API`.                 |
| `oauth2-client` | Digits inside a word, which must not trip the digit-leading guard.                 |
| `user`          | A single word, the degenerate case of every casing transform.                      |

**Why this is a named plan item rather than an implementation detail.** M34's drift gate ran
`deno check` against the real packages and still shipped two defects that made generated code fail
to parse — because it only ever generated the name `order-item`. A gate that exercises one input
proves one input. The set above is the minimum that would have failed on both M34 defects.
`isIdentifierSafe` (shipped in M34) makes `2fa` an expected REFUSAL rather than a crash, so the gate
asserts exit codes alongside `deno check`.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m34b-cli-extensions, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Additionally, because this milestone's product is generated text and a boot path:

```bash
# Every template must produce a project that type-checks against the real packages.
deno run --allow-all packages/cli/src/main.ts new smoke-rest --template rest --dir /tmp/m34b
deno check --config /tmp/m34b/smoke-rest/deno.json /tmp/m34b/smoke-rest/main.ts \
  /tmp/m34b/smoke-rest/honoe.config.ts

# A plugin-contributed command must actually run, end to end.
deno run --allow-all packages/cli/src/main.ts commands --dir /tmp/m34b/smoke-rest
```

## 8. Risks & mitigations

- **Booting the user's application executes their code.** Discovery imports `honoe.config.ts` and
  runs every plugin's init and bootstrap hooks (§1) — a database plugin will connect. → Booting
  happens only for `commands` and for a first positional that matches no built-in verb, never on the
  `new` / `generate` path; teardown is guaranteed (§3.10); and the README documents that a command
  invocation starts the application.
- **A template's wiring drifts from the framework's real API.** A stale plugin name or a renamed
  export type-checks fine here — it is a string. → `test/e2e/template-e2e.test.ts` runs `deno check`
  on the generated project against the real published packages, over the §6.1 hostile name set, so
  drift fails the suite. The same gate caught two real defects in M34 (`ctx.request.params`, missing
  `experimentalDecorators`) — and MISSED two more (a reserved word in a binding position, a
  digit-leading identifier) precisely because it ran a single name. §6.1 exists to close that.
- **`honoe.config.ts` changes M34's generated project shape**, so a project scaffolded by M34 has no
  config file and cannot serve plugin commands. → M34 is unreleased, so no published artifact
  depends on the old shape; and the "no config file" case is an explicit, tested exit-`2` message
  naming the file to add (§3.9), not a crash.
- **A hostile or broken `createApp` can hang** (an infinite loop, a never-resolving promise). → Out
  of scope to sandbox; the CLI is a developer tool run against the developer's own project. Noted in
  the README rather than mitigated in code, because a timeout would break legitimately slow
  startups.
- **Coverage on the boot path.** The real-import and real-kernel paths are the hardest to cover
  deterministically. → The decidable logic (path resolution, export validation, duplicate detection,
  dispatch, exit-code mapping) lives in `src/app-loader.ts` and `src/commands/plugin-commands.ts`
  behind the injectable `AppLoader`, and is unit-tested directly; only the one-line real `import()`
  sits behind the guarded integration test.

## 9. Out of scope

- **Starter-backed templates** (`--template` resolving to `@hono-enterprise/*-starter`) —
  **Milestone 36** owns those packages, which export nothing today (§1). This milestone's inline
  wiring neither blocks nor duplicates that work.
- **A `full-stack` template** — it would need the M44 React Router plugin's app structure, which
  ROADMAP assigns to M36's Full-Stack Starter.
- **Plugin installation and dependency management** (`honoe add auth-plugin` editing the manifest
  and the plugin list) — a separate concern from generation, deferred.
- **Flags for plugin commands.** `CliCommandHandler` takes positionals only (§1); giving handlers a
  parsed flag record would widen a committed `common` contract, which this milestone does not do.
- **Interactive prompts.** All input stays flags and positionals, so every path remains scriptable
  and testable without a TTY.
