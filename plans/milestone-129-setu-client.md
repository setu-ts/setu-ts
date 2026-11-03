# Milestone 129 — `setu client`: the typed client as a command (`@setu-ts/cli`, `@setu-ts/common`, `@setu-ts/openapi-plugin`)

> **Status:** Planning. Branch: `feat/m129-setu-client`. `main` and `develop` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Every project that ships a typed client today writes the same fifteen-line script around the sdk's
`generateOpenApiClient` (the CMS demo's `cms/scripts/gen-client.ts` is the real instance), and
nothing notices when the generated file no longer matches the API. M129 makes that a CLI verb:
`setu client` loads the project's OpenAPI document (by booting the application with no port, or from
`--input <file|url>`), generates the client with the project's OWN `@setu-ts/sdk`, writes it as a
CLI-owned file, and `setu client --check` is a CI drift gate that exits 1 when the file on disk
differs from what would be generated. `IOpenApiService` moves to `common` so the CLI resolves the
capability by its documented interface.

- **In scope:** any type, lint or format error the e2e gate finds in sdk-generated output, fixed in
  `packages/sdk`'s codegen (not by patching the output in the CLI); the `client` verb with
  `--output`, `--input`, `--factory`, `--type-name`, `--dir`, `--config`, `--dry-run`, `--check`;
  the `IOpenApiService` promotion; `setu add sdk` adding `client` and `client:check` scripts; help,
  flag inventory, agent briefs, docs; the e2e gate the ROADMAP names.
- **NOT this milestone:**
  - The full-stack `/openapi.json` listing the page catch-all `/*`, `/assets/*` and `/__vite/*`
    (X91-6 / V11-7): a client generated from a full-stack app gets `get()`/`put()`/… for them until
    **M130** lands. §8 records it; M129 does not filter the document.
  - A reused schema named after its first operation slot (V11-6, `PostOrdersBody2`): **M131b**. Its
    fix renames components, so the first `setu client --check` after M131b reports drift once.
  - Running across workspace members (`forEachProject`): a later milestone if asked; M129 refuses a
    workspace root with guidance (§3.9).
  - Sending headers or credentials to a `--input` URL: a protected document is read from a file.

## 1. Contracts verified from SOURCE (not names)

All line numbers read on `develop` at `9886d5a64`.

| Reference                         | Source (file:line)                                                      | Verified surface / fact                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateOpenApiClient`           | `packages/sdk/src/codegen/openapi-codegen.ts:1106-1109`                 | `(document: SdkOpenApiDocument, options?: OpenApiCodegenOptions): string`; pure. Options (`:22-41`): `factoryName` (default `createApi`), `sdkImport` (default `@setu-ts/sdk`), `apiTypeName` (default `Api`; a component named `Api` clashes and throws). |
| `OpenApiCodegenError`             | `openapi-codegen.ts:541-546`; exported `sdk/src/index.ts:50`            | Thrown for an operation with no `operationId` (carries path and method) and for a name clash.                                                                                                                                                              |
| Generated header                  | `openapi-codegen.ts:1166`                                               | The output already opens with `/** Auto-generated SDK client. Do not edit manually. */`; M129 prepends its own marker line above it (§3.5).                                                                                                                |
| `@setu-ts/sdk` package shape      | `packages/sdk/package.json` `exports`                                   | `{ ".": { types, default } }`, `type: module`; no `require` condition, so resolution must go through an ESM resolver from the project (§3.3).                                                                                                              |
| operationId always present        | `packages/openapi-plugin/src/generators/openapi-generator.ts:717-718`   | openapi-plugin derives an id when a route declares none, so its documents satisfy the codegen precondition.                                                                                                                                                |
| Document needs a STARTED app      | `openapi-plugin/src/plugin/openapi-plugin.ts:174-183, 240-244`          | Contributed schemas drain in `onInit`; declared operation ids are claimed in `onBootstrap`. `getSpec()` before `start()` is incomplete.                                                                                                                    |
| `IOpenApiService`                 | `openapi-plugin/src/interfaces/openapi-service.ts:12-28`                | `getSpec(): Readonly<Record<string, unknown>>`; `addSchema(name, schema): void`. Exported as a type from `openapi-plugin/src/index.ts:17`; registered under `CAPABILITIES.OPENAPI` at `openapi-plugin.ts:171`.                                             |
| `CAPABILITIES.OPENAPI`            | `packages/common/src/tokens.ts:89`                                      | `'openapi'`. `IServiceRegistry.has(token)` exists (`common/src/registry.ts:148`).                                                                                                                                                                          |
| Boot with no port + teardown      | `packages/cli/src/commands/plugin-commands.ts:87-125`                   | `withPluginCommands`: `denoInstallRefusal` → `loadApp` → `start()` (no port, binds nothing, runs init/bootstrap — a database plugin connects) → use → `stop()` in `finally`, a failing stop reported without changing the outcome.                         |
| `loadApp`                         | `packages/cli/src/app-loader.ts:312-371`                                | Imports `setu.config.ts` through tsx, calls `createApp(discoveryEnv())`. Its factory-threw message (`:350-356`) says "Plugin commands are unavailable" — wrong wording for `client` (§3.2).                                                                |
| Inert Workers bindings            | `app-loader.ts:43-78`                                                   | Bindings are inert proxies at boot; a plugin that READS one at construction fails.                                                                                                                                                                         |
| `denoInstallRefusal`              | `app-loader.ts:268-296`                                                 | Refuses a Deno project whose packages are not installed where Node can import them.                                                                                                                                                                        |
| Project-relative import           | `packages/cli/src/utils/ts-loader.ts:86-100`                            | `importProjectModule(url, root)` = `await import('tsx/esm/api')` in try/catch → `tsImport(url, { parentURL: url, tsconfig })`. tsx's `tsImport` resolves a bare specifier from `parentURL`.                                                                |
| Write safety                      | `packages/cli/src/utils/file-writer.ts:66-90, 536, 603, 685`            | `GeneratedFile { path, contents, managed? }`; `managed: true` skips the overwrite refusal in `findExisting` (`:336-350`); `reportDryRunPlan`, `writeFiles` (links refused, batch rollback), `withFileTransaction`.                                         |
| Existing-file read bound          | `file-writer.ts:427`                                                    | `MAX_EXISTING_FILE_BYTES = 1 MiB`; the writer refuses to read (and so to replace) a larger existing file.                                                                                                                                                  |
| Formatting                        | `packages/cli/src/utils/prettier-format.ts:95-97, 213-226`              | `formatForTarget(files, runtime, root, report)` formats with the project's Prettier config on every npm-manifest target; a Deno project is left to `deno fmt`.                                                                                             |
| Exit codes                        | `packages/cli/src/constants.ts:30-38`                                   | `EXIT_OK 0`, `EXIT_ERROR 1`, `EXIT_USAGE 2`, `EXIT_INTERRUPTED 130`.                                                                                                                                                                                       |
| Dispatch: built-ins win           | `packages/cli/src/cli.ts:244-336`                                       | Built-in verbs are matched first; anything else goes to `dispatchPluginCommand`. A plugin command named `client` would be shadowed; no first-party plugin registers one (grep of `*/src` for CLI_COMMAND registrations).                                   |
| Flag inventory                    | `packages/cli/src/flags.ts:220-240, 346`                                | `spec(name, flags, positionals, …)` per command; `test/unit/flags.test.ts` checks help ↔ inventory both ways.                                                                                                                                              |
| `setu add sdk`                    | `packages/cli/src/commands/add.ts:208`                                  | `['sdk', { pkg: 'sdk' }]`: adds the dependency only; no script today.                                                                                                                                                                                      |
| Adding scripts without clobbering | `cli/src/commands/add-view.ts:127-140`; `devtool/npm-manifest.ts:79-97` | `scripts`/`tasks` by runtime; an existing script of the same name is noted and left alone.                                                                                                                                                                 |
| Runner prefix per runtime         | `cli/src/templates/project-files.ts:70-73`                              | `cliInvocation(runtime)`: `deno run -A npm:@setu-ts/cli@V`, `bunx @setu-ts/cli@V`, `npx @setu-ts/cli@V`. npm-manifest scaffolds also carry `@setu-ts/cli` as a devDependency and call bare `setu` (`templates/npm-tooling.ts:32`).                         |
| Workspace detection               | `cli/src/commands/check.ts:71-110`                                      | `detectProject` → `project` / `workspace` / `none` / `unreadable`; `setu check` fans out over members.                                                                                                                                                     |
| Real consumer                     | `~/Projects/setu-cms-demo/cms/scripts/gen-client.ts`                    | Fetches `http://localhost:3000/openapi.json`, calls `generateOpenApiClient(doc, { factoryName: 'createApi' })`, writes `client/api.ts` with a one-line header. Its output includes `get()`/`put()`/… from the full-stack catch-all (X91-6).                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                      | Resolution (picked side)                                                                     | Doc deliverable (same PR)                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| C1  | PUBLIC_API.md shows `ctx.services.get<IOpenApiService>('openapi')` (l.10319) with the interface owned by openapi-plugin, while the CLI (a non-plugin consumer) must type the token without depending on the plugin.           | The interface moves to `common/src/services/openapi.ts`; openapi-plugin re-exports the type. | PUBLIC_API.md: `IOpenApiService` under the common services section; openapi-plugin section says "re-exported from common". |
| C2  | The ROADMAP M129 section and the working note say `--from <file\|url>` and `--out src/api.ts`; the survey (§3.10) moves the flags to `--input` and `--output`, and this plan writes `src/clientsdk/api.ts` by default (§3.6). | This plan.                                                                                   | ROADMAP M129 decision 1 reads `--input <file\|url>`.                                                                       |

## 3. Design decisions

### 3.1 The verb and its flags

- **Decision:**
  `setu client [--output <path>] [--input <file|url>] [--factory <name>] [--type-name <name>] [--dir <path>] [--config <path>] [--dry-run] [--check]`.
  No positional. `--dry-run` and `--check` together are a usage error (exit 2). `--factory` and
  `--type-name` must be TypeScript identifiers (`/^[A-Za-z_$][A-Za-z0-9_$]*$/`), else exit 2.
- **Why:** see §3.10 for the survey of real tools that fixed these names.
- **Test home:** `test/unit/client-command.test.ts` (flags), `test/unit/flags.test.ts` (inventory ↔
  help).

### 3.2 Loading the document — boot path

- **Decision:** without `--input`, the command reuses the plugin-command boot sequence, extracted
  from `withPluginCommands` into one internal helper
  `withStartedApp(deps, dir, config, purpose, use)` in `commands/plugin-commands.ts` that both
  callers use (one implementation): `denoInstallRefusal` → `loadApp` → `start()` with no port →
  `use(app)` → `stop()` in `finally` (a failing stop is reported as a warning and never changes the
  exit code). `loadApp` gains a `purpose` argument used in its factory-threw message: plugin
  commands keep "Plugin commands are unavailable in this project"; `client` says "`setu client`
  cannot read the OpenAPI document by booting the application" and adds "pass `--input <file|url>`
  to read a saved or served document instead". Inside `use`:
  `app.services.has(CAPABILITIES.OPENAPI)` false → exit 1, "openapi-plugin is not registered in this
  application. Add it with `setu add openapi`, or pass `--input`." Otherwise
  `get<IOpenApiService>(CAPABILITIES.OPENAPI).getSpec()`.
- **Why:** the document is complete only after `onInit`/`onBootstrap` (§1). One boot helper means
  the Deno install refusal, interruption checks and teardown rules cannot diverge between the two
  verbs. An interrupt (SIGINT) mid-boot exits 130 with the app stopped, as plugin commands do.
- **Test home:** `client-command.test.ts` (fake loader: no openapi → refusal; stop called on
  success, on a thrown `getSpec`, and when `start()` throws; a failing stop does not change exit 0);
  `plugin-commands.test.ts` keeps its existing assertions through the shared helper.

### 3.3 Loading the document — `--input`

- **Decision:** a value starting `http://` or `https://` is fetched with the web `fetch`, a 30 s
  `AbortSignal.timeout`, `accept: application/json`; a non-2xx answer is exit 1 naming the status.
  Anything else is a path resolved against the CWD (not `--dir`) and read through the CLI
  filesystem. Both reads are capped at 16 MiB (stream counted; over the cap → exit 1 "larger than 16
  MiB"). The body must parse as JSON and be an object whose `openapi` is a string starting `3.` and
  whose `paths` is an object; otherwise exit 1 naming which check failed. Other URL schemes
  (`file:`, `ftp:`) are refused as usage errors (exit 2). YAML is not accepted (named in the error).
  With `--input`, the application is NOT loaded at all, so `--config` with `--input` is a usage
  error.
- **Why:** Workers projects (inert bindings) and apps whose `start()` needs a live database need a
  path that never boots. The cap and timeout bound a hostile or wedged server.
- **Test home:** `test/unit/client-document-source.test.ts` (injected fetch and fs: each refusal,
  the cap on both arms, timeout abort, success).

### 3.4 Generating with the project's own sdk

- **Decision:** a new internal loader `importFromProject(specifier, root)` in `utils/ts-loader.ts`
  (also used for Prettier, §3.5): `await import('tsx/esm/api')` inside try/catch (the existing
  pattern), then
  `tsImport('@setu-ts/sdk', { parentURL: <file URL of root/package.json or deno.json> })`, so the
  specifier resolves from the PROJECT's `node_modules`, never the CLI's. The specifier is the
  literal `'@setu-ts/sdk'` at the single call site in `client/generate.ts`, awaited inside a
  try/catch whose catch throws
  `OptionalDependencyUnavailableError('@setu-ts/sdk', { requiredBy: 'setu client' })` with "run
  `setu add sdk`". A loaded module whose `generateOpenApiClient` is not a function → exit 1 "the
  installed @setu-ts/sdk has no generateOpenApiClient; update it". An `OpenApiCodegenError` → exit 1
  with its message (e.g. the `Api` clash names `--type-name`). The CLI gains NO dependency on
  `@setu-ts/sdk`.
- **Why:** a bare `import('@setu-ts/sdk')` from the CLI resolves next to the CLI (global `npx`, or a
  different version in the workspace), so generated imports could mismatch the installed sdk. The
  project's copy guarantees they match. tsx is already the CLI's project loader.
- **Test home:** `client-command.test.ts` (injected loader: missing, wrong shape, codegen error);
  `test/unit/ts-loader.test.ts` (resolution from a fixture project with its own
  `node_modules/@setu-ts/sdk` stub — the guarded REAL-import test, no fake loader).

### 3.5 The managed file and its marker

- **Decision:** the written file is a fixed header followed by the generated text. The header's
  first line is the marker,
  ``// Generated by `setu client`. Do not edit; run `setu client` to regenerate.`` The lines after
  it depend on the target:
  - npm-manifest projects (Node, Bun, Workers): `/* eslint-disable */`. The whole text is then
    formatted with Prettier using the project's config, through `formatForTarget`. The Prettier
    module is the PROJECT's, loaded with `importFromProject('prettier', root)` (§3.4). The CLI's own
    copy is used only when the project has none.
  - Deno projects: `// deno-fmt-ignore-file` and `// deno-lint-ignore-file`. The text is not
    formatted.

  It is written as a `managed: true` `GeneratedFile` inside `withFileTransaction`; `--dry-run`
  prints `reportDryRunPlan` and writes nothing. **Overwrite refusal:** `managed` lifts the CLI's
  generic refusal, so the command adds its own. An existing file at `--output` whose first line is
  not the marker is refused with exit 1: "… was not written by `setu client`; move it or choose
  another `--output`". There is no `--force`.

- **Why:**
  - Without the marker check, `setu client --output src/routes.ts` would replace hand-written code.
  - The project's lint has no business with generated code, so the file opts out of it.
  - The project's own Prettier, with its own config, is what its `format:check` runs. Formatting
    with the CLI's copy could differ by a Prettier minor version, so `format:check` and `--check`
    would disagree about the same file.
  - Deno has no in-process formatter here, so the file opts out of `deno fmt` instead of churning.
- **Test home:** `client-command.test.ts`:
  - marker present → replaced; marker absent → refused, file untouched;
  - dry-run writes nothing;
  - header lines per target;
  - project Prettier preferred, CLI fallback when it is missing, Prettier called with the project
    root.

### 3.6 `--output` default and validation

- **Decision:** default `src/clientsdk/api.ts`, relative to the project directory. `--output` must
  end in `.ts`, be relative, and stay inside the project (`assertInsideProject`; a link anywhere on
  the path is refused by `writeFiles`). Anything else is exit 2.
- **Why:** under `src/`, the project's own `tsc --noEmit` (`check` script) type-checks the client,
  so a document change that breaks it is caught by the gate the project already runs. The directory
  is `clientsdk`, not `client`, so it is not mistaken for browser-side code (maintainer decision,
  2026-11-03).
- **Test home:** `client-command.test.ts`.

### 3.7 `--check`

- **Decision:** loads and generates exactly as a write would (same marker, header lines,
  formatting), then compares with the bytes at `--output`. Equal → exit 0, "src/clientsdk/api.ts is
  up to date". Missing file → exit 1, "… does not exist; run `setu client`". Different → exit 1, "…
  is out of date; run `setu client`" plus the first differing line number. Any load or generation
  failure is also exit 1 (distinguished by message). Never writes.
- **Why:** §3.10 (CI convention: one nonzero code, message says why).
- **Test home:** `client-command.test.ts` (in sync, drifted, missing, failure).

### 3.8 `setu add sdk` scripts

- **Decision:** `setu add sdk` adds `client` and `client:check` scripts (`tasks` on Deno), using the
  same runner the project's `check` script uses for `setu check`: bare `setu client` /
  `setu client --check` where `@setu-ts/cli` is a devDependency,
  `cliInvocation(runtime) + ' client'` otherwise. An existing `client` or `client:check` script is
  left alone and noted (the `add-view.ts` rule). The generated `check` script is NOT changed:
  `--check` boots the app, which may connect to a database, so it is opt-in for CI.
- **Why:** the ROADMAP names the script; booting inside every `npm run check` would make `check`
  need live services.
- **Test home:** `test/unit/commands/add.test.ts` (npm, Bun, Deno; existing script kept).

### 3.9 Projects the command refuses

- **Decision:** `detectProject` on the target dir: `none`/`unreadable` → exit 1 with the
  `setu check` wording; `workspace` → exit 1 "run `setu client` in a member, or pass
  `--dir <member>`".
- **Test home:** `client-command.test.ts`.

### 3.10 Naming, from the survey of real tools

- **Decision:** the verb stays `setu client`; the flags are `--output`, `--input`, `--factory`,
  `--type-name`, `--dry-run`, `--check`; exit codes stay the CLI's 0 ok / 1 drift or failure / 2
  usage. Not adopted: stdout when `--output` is absent (this file is managed, so it has a default
  path), a separate drift code, and a tool version or timestamp in the header.
- **Why:** survey (2026-11-03, sources in the PR):

  | Tool               | Verb                                             | Input                 | Output        | Drift check                                 | Exit codes              |
  | ------------------ | ------------------------------------------------ | --------------------- | ------------- | ------------------------------------------- | ----------------------- |
  | openapi-typescript | `openapi-typescript <in>`                        | file or URL           | `-o/--output` | `--check`, compares in memory, never writes | 0 current, 1 stale      |
  | Kiota              | `kiota generate`                                 | `-d/--openapi`        | `-o`          | none (`kiota-lock.json` hash)               | not documented          |
  | Orval              | `orval`                                          | `-i` or config        | `-o`          | none                                        | not documented          |
  | hey-api            | `openapi-ts`                                     | `-i`                  | `-o`          | none; `--dry-run`                           | not documented          |
  | openapi-generator  | `generate`                                       | `-i`                  | `-o`          | none; `--dry-run`                           | not documented          |
  | Encore             | `encore gen client`                              | the running app       | `-o/--output` | none                                        | not documented          |
  | ASP.NET build-time | `dotnet build`                                   | boots the entry point | file          | none                                        | not documented          |
  | Prisma, buf        | `migrate diff --exit-code`, `format --exit-code` | —                     | —             | `--exit-code`                               | Prisma 0/1 error/2 diff |

  No tool uses `client` as a top-level verb, so it is free; Encore's `gen client` is the closest.
  `--check` is the name used for "is this generated file current" (openapi-typescript, Prettier,
  `prisma format`); `--exit-code` belongs to diff commands. `--input`/`--output` are what every
  generator uses (as `-i`/`-o`). The CLI has no short flags beyond `-h`, so none are added. Prisma's
  distinct drift code would collide with this CLI's `2` for usage, and openapi-typescript collapses
  stale and error into 1, as `setu check` does; the message tells them apart. Orval's versioned
  header would make a CLI upgrade alone report drift. ASP.NET boots the app for generation and
  documents that startup code runs, which is this CLI's existing plugin-command behaviour (§8).

- **Test home:** none (naming); `flags.test.ts` pins the inventory.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `IOpenApiService` keeps its shape and openapi-plugin keeps
exporting it (as a re-export); ships in minor `0.12.0`.

| Exported symbol                               | Kind           | Consumer / real code path that READS it                                                                        |
| --------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `IOpenApiService` (`@setu-ts/common`)         | type           | `cli/src/client/document-source.ts` (`services.get<IOpenApiService>`); openapi-plugin's service implements it. |
| `IOpenApiService` (`@setu-ts/openapi-plugin`) | type re-export | existing importers of the plugin barrel (`barrel-exports.test.ts`, README examples).                           |

The CLI adds no `src/index.ts` export: the command is reached through `bin`.

### 4.1 Options — every option names its consumer

| Option        | Consumer                          | Behavior (per implementation)              |
| ------------- | --------------------------------- | ------------------------------------------ |
| `--output`    | `client.ts` → write and `--check` | §3.6                                       |
| `--input`     | `document-source.ts`              | §3.3; with it the app is never loaded      |
| `--factory`   | `generate.ts` → `factoryName`     | default `createApi`                        |
| `--type-name` | `generate.ts` → `apiTypeName`     | default `Api`                              |
| `--dir`       | `client.ts` → project root        | as every command                           |
| `--config`    | boot path → `loadApp`             | refused with `--input`                     |
| `--dry-run`   | write path                        | `reportDryRunPlan`; refused with `--check` |
| `--check`     | §3.7                              | never writes                               |

## 5. Implementation files

| File                                                        | Purpose                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/openapi.ts`                   | `IOpenApiService` (moved, JSDoc kept, `@since 0.1.0`)                                                                                                          |
| `packages/common/src/index.ts`                              | export the type                                                                                                                                                |
| `packages/openapi-plugin/src/interfaces/openapi-service.ts` | becomes a type re-export from common                                                                                                                           |
| `packages/cli/src/commands/client.ts`                       | `runClientCommand`: flags, project refusal, orchestration, exit codes                                                                                          |
| `packages/cli/src/client/document-source.ts`                | boot path and `--input` path, validation, caps                                                                                                                 |
| `packages/cli/src/client/generate.ts`                       | project sdk import, marker, header lines, formatting                                                                                                           |
| `packages/cli/src/commands/plugin-commands.ts`              | `withStartedApp` extracted; `withPluginCommands` calls it                                                                                                      |
| `packages/cli/src/app-loader.ts`                            | `purpose` argument in the factory-threw message                                                                                                                |
| `packages/cli/src/utils/ts-loader.ts`                       | `importFromProject(specifier, root)`                                                                                                                           |
| `packages/cli/src/cli.ts`, `flags.ts`, help text            | dispatch `client`, flag spec, `printHelp` line                                                                                                                 |
| `packages/cli/src/commands/add.ts`                          | `sdk` scripts                                                                                                                                                  |
| `packages/cli/src/agents/facts.ts`, `agents/render.ts`      | the command in agent briefs; it must fit the current 13312-byte budget by tightening wording, and a raise goes to the maintainer                               |
| Docs                                                        | `packages/cli/README.md`, `packages/sdk/README.md` (replace the hand-written script), `docs/` CLI reference, `PUBLIC_API.md`, `CHANGELOG.md`, website CLI page |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                  | src covered                                | Key assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/unit/client-command.test.ts`            | `commands/client.ts`, `client/generate.ts` | §3.1, §3.2, §3.4–§3.7, §3.9 with injected loader, sdk module and fs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/cli/test/unit/client-document-source.test.ts`    | `client/document-source.ts`                | §3.2 refusal and teardown; every §3.3 refusal and cap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/cli/test/unit/ts-loader.test.ts`                 | `importFromProject`                        | real tsx resolution from a fixture project's own `node_modules` (no fake)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/cli/test/unit/plugin-commands.test.ts`           | `withStartedApp`                           | existing assertions unchanged; purpose wording per caller                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/cli/test/unit/app-loader.test.ts`                | `purpose` message                          | both wordings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/cli/test/unit/commands/add.test.ts`              | sdk scripts                                | §3.8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/cli/test/unit/flags.test.ts`                     | `flags.ts`                                 | inventory ↔ help both ways, including `client`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/common/test/unit/barrel-exports.test.ts`         | common barrel                              | type exported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/openapi-plugin/test/unit/barrel-exports.test.ts` | re-export                                  | still exported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/cli/test/e2e/client-e2e.test.ts` (**the gate**)  | everything, end to end                     | Uses the registry overlay and `npmInstall` from `build-e2e.test.ts`. (1) `--template rest`, which already registers OpenApiPlugin through `createRestApp`: `setu add sdk`, install, `npm run client`, then the project's `check`, `lint` and `format:check` pass; boot the app and call one endpoint through `createApi`; `npm run client:check` exits 0; add a route and it exits 1; `setu client` again, then it exits 0; `--input` a saved `/openapi.json` gives byte-identical output. (2) The minimal template: `setu client` exits 1 with the openapi-plugin refusal; after `setu add openapi` it succeeds. |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m129-setu-client
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run ci:local           # final commit; CLI shards include the new e2e
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

Per-file coverage (ANSI-stripped) for every touched `src` file, ≥90% branch/function/line.

## 8. Risks & mitigations

- **Full-stack output carries page-route operations until M130 (X91-6).** → The cli README says so
  and points at `openapi.exclude`; M130 removes the cause.
- **V11-6's fix (M131b) renames components** → one expected drift report after upgrading; CHANGELOG
  of M131b says to rerun `setu client`.
- **Booting runs bootstrap hooks** (a database connects, a scheduler may start jobs) → documented as
  the plugin-command behaviour; `--input` is the no-boot path.
- **A client over 1 MiB** cannot be replaced by the writer's existing-file bound → named error from
  the writer; a document that large is out of reach for now (§1).
- **Prettier differs between machines** → the project's installed Prettier is loaded (§3.5), so the
  lockfile decides the version; CI and laptops agree when the lockfile is committed.
- **The booted document can differ from the deployed one** when routes depend on environment the CLI
  process lacks (a `.env` not loaded, a feature flag) → documented; `--input` against the running
  service is the exact path.

## 9. Out of scope

- Filtering page or asset routes from the document (M130).
- Workspace fan-out, `--header` for `--input`, YAML documents, languages other than TypeScript.
