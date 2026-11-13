# Milestone 140a — Security defaults a generated project starts with (`cli` + six framework packages)

> **Status:** Planning. Branch: `feat/m140a-security-defaults`. `develop` and `main` are protected,
> so all work, including fixes, stays on this one branch until it merges through a single PR into
> `develop`.

## 0. Objective & scope

ROADMAP M140a: the security rows of the 2026-11-12/13 generated-code review
(`smoke/GENERATED-CODE-REVIEW.md`, read on `develop` `1fa2996b9`, re-checked on `9742b3003`). Each
row is a default a freshly scaffolded project starts with that an attacker, or a careless first
commit, can use: an unbounded body, a committed secret, a shared session key, a CSRF token that
outlives sign-in, a socket with no frame limit, an install that runs every package's scripts.

Several rows cannot be fixed in the generated text alone, because the default lives in a framework
package the generated code calls (AI_GUIDELINES §13.4: security plugins default to the most secure
configuration). Those framework halves are in scope and named per row; §2 C1 corrects the ROADMAP
packages cell.

- **In scope (16 rows):**
  - **Request bodies:** V12-63.
  - **Secrets the scaffold writes or teaches:** V12-66, V12-67, V12-112 (session secret), V12-71
    (JWT secret), V12-129 (devtool session key).
  - **Files Git would commit:** V12-64, V12-108, V12-117.
  - **Session:** V12-69 (CSRF token across sign-in).
  - **Realtime:** V12-74 (framework half: decorated gateways cannot take guards), V12-75, V12-76.
  - **Destructive tooling:** V12-72 (`--down` reverses everything).
  - **Supply chain:** V12-119, V12-120.
- **NOT this milestone:**
  - **The application halves** of V12-74 (an empty gateway body), V12-94 (exposing `/metrics` and
    `/docs`) and V12-77 (an unvalidated echo placeholder): reclassified to
    `smoke/PRODUCT-DEFECTS.md` on 2026-11-13. V12-94's README sentence is M140d's.
  - **Workers/Deno/Bun output** (M140b), **images, Compose, k8s beyond the session secret** (M140c),
    **generators and brief** (M140d), **documentation beyond the lines this milestone's behaviour
    changes** (M140e).
  - **A connection cap or idle timeout default for WebSocket**: no surveyed stack caps connections
    by default, and the plugin's idle sweep reads client traffic, so a default would close quiet
    read-only clients (§3.10).

## 1. Contracts verified from SOURCE (not names)

All paths under `packages/` unless stated. Read on `9742b3003`.

| Reference                          | Source (file:line)                                                                                                                                            | Verified surface / fact                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RuntimePlugin` `maxBodyBytes`     | `runtime/src/plugin/runtime-plugin.ts:117,187,197-203`                                                                                                        | Optional, no default (unbounded); `0` refuses every body; non-negative integer checked at factory time; exceed rejects with `RequestBodyTooLargeError` (413 hint, `adapters/shared/fetch-mapping.ts:49-84`)  |
| Starter body default               | `starters/rest-starter/src/app.ts:78,87-92,103-120`                                                                                                           | `DEFAULT_STARTER_MAX_BODY_BYTES = 1_048_576`; mirrored into `HttpSecurityPlugin` `requestSize.maxBodySize` unless the caller set one or disabled it                                                          |
| `HttpSecurityPlugin` `requestSize` | `http-security-plugin/src/plugin/http-security-plugin.ts:45,101-103`; `middleware/request-size-middleware.ts:21,26,43,53-77`                                  | Opt-in block; default 1 MiB once present; checks `Content-Length` only (chunked passes); malformed header 400                                                                                                |
| CLI REST wiring                    | `cli/src/templates/rest.ts:21-25,31-58`; `minimal.ts:62`; `class-based.ts:33`; `microservice.ts:48`                                                           | `RUNTIME_WIRING` has no `args`; `HttpSecurityPlugin` has none; all four createApplication templates share them. `seam.ts:214-243` rewrites neither                                                           |
| Module schema                      | `cli/src/schematics/module-files.ts:23,32`                                                                                                                    | `name: z.string().min(1)`, `id: z.string().min(1)`, no maximum                                                                                                                                               |
| `.gitignore` builder               | `cli/src/templates/project-files.ts:2115-2130`                                                                                                                | `node_modules/` only when `runtime !== 'deno' \|\| npmBuild`; `.env` only when `manifest.envFilePath`; Workers gets `.dev.vars` only. Comment at `:2115` claims other Deno projects create no `node_modules` |
| Deno `nodeModulesDir`              | `cli/src/templates/project-files.ts:2242-2249`                                                                                                                | Every standalone Deno project gets `nodeModulesDir: 'auto'` (M111d §3.4)                                                                                                                                     |
| Start scripts load `.env`          | `cli/src/templates/project-files.ts:282-286`                                                                                                                  | M131a X88-2: local start scripts read `.env` into the process environment, minimal included                                                                                                                  |
| Env renderers                      | `cli/src/templates/project-files.ts:281-311,2340-2364`                                                                                                        | `.env` from each variable's static `develop`; `.env.example` empty values; Workers `.dev.vars` the same                                                                                                      |
| Full-stack secret                  | `cli/src/templates/full-stack.ts:164,314-332`                                                                                                                 | `SESSION_SECRET` `develop: 'dev-only-insecure-session-secret-change-me'`; read by `config.getOrThrow`                                                                                                        |
| Placeholder tests                  | `cli/test/unit/new-command.test.ts:496-498,612-613`                                                                                                           | Assert the placeholder in `.env` and `.dev.vars`, empty in `.env.example`                                                                                                                                    |
| `projectFiles`                     | `cli/src/templates/project-files.ts:2023-2028`                                                                                                                | `(projectName, runtime, host, port?)`, pure; callers `commands/new.ts:586,601`, `commands/app.ts:378`                                                                                                        |
| `NewDependencies`                  | `cli/src/commands/new.ts:102-127`                                                                                                                             | `fs, cwd, log, error, portAvailable, ask, interrupt, fetch`; no randomness seam; dry run at `:819-822`                                                                                                       |
| README Production                  | `cli/src/templates/project-files.ts:2091-2112`                                                                                                                | `docker run --rm -p 3000:3000 <name>` at `:2108`, no env                                                                                                                                                     |
| `.dockerignore`                    | `cli/src/workspace/compose.ts:289-330`                                                                                                                        | Excludes `**/.env`, `**/.env.*`, keeps `.env.example`                                                                                                                                                        |
| Compose `web`                      | `cli/src/workspace/compose.ts:464-477`                                                                                                                        | `env_file: ../apps/<m>/.env`, `required: false`; `restart: unless-stopped`                                                                                                                                   |
| Workspace README                   | `cli/src/workspace/root-files.ts:68-113`                                                                                                                      | "Run the stack" only `docker compose -f docker/compose.yaml up --build`                                                                                                                                      |
| `Session.regenerate()`             | `session-plugin/src/services/session.ts:180-188`                                                                                                              | New id; data kept, `__csrf` included                                                                                                                                                                         |
| `ISession.regenerate` contract     | `common/src/services/session.ts:159-166`                                                                                                                      | "Issues a new session id while keeping the current data"                                                                                                                                                     |
| CSRF token                         | `session-plugin/src/csrf/token.ts:31,59-74,193-196`; `csrf/verify.ts:68-85`                                                                                   | Stored under `CSRF_SESSION_KEY = '__csrf'`; minted on first `getCsrfToken`; verify reads the session's value                                                                                                 |
| `regenerate` callers               | `auth-plugin/src/sign-in/auth-session-service.ts:421,446,488,592`; `middleware/auth-middleware.ts:97-98`; `cli/src/templates/full-stack-app-files.ts:651-655` | Sign-in, pending MFA, promote, stamp revocation, template login                                                                                                                                              |
| Stale binding comments             | `common/src/services/session.ts:23-26`; `session-plugin/src/services/session-tenant-binding.ts:22-24`                                                         | Claim `regenerate()` drops `__setu_tenant`; it does not (test `session-tenant-binding.test.ts:216`)                                                                                                          |
| Session secret resolution          | `session-plugin/src/secret/secret-resolver.ts:23,48-73,107-128`                                                                                               | Option → `CAPABILITIES.SECRETS` → env `SESSION_SECRET` (comma list); each ≥ 32 characters, `SessionSecretMissingError`                                                                                       |
| `AuthPlugin` JWT check             | `auth-plugin/src/plugin/auth-plugin.ts:116-124,242,251-252`                                                                                                   | Presence only, plain `Error`; HS256 when a secret is set; no length floor                                                                                                                                    |
| `JwtService`                       | `auth-plugin/src/services/jwt-service.ts:39-40,55-66`                                                                                                         | HS256 requires a secret, any length; string → UTF-8 bytes → HMAC key                                                                                                                                         |
| `AuthPluginConfigurationError`     | `auth-plugin/src/errors.ts:18`                                                                                                                                | Exists; unused by the JWT check                                                                                                                                                                              |
| Auth/session hints                 | `cli/src/commands/add.ts:368-377`; `cli/src/schematics/guard.ts:39-42`                                                                                        | `jwt: { secret: '<your-secret>' }` and `SessionPlugin({ secret: '<your-secret>' })`                                                                                                                          |
| Plugin ordering                    | `common/src/plugin.ts:588-590`; `auth-plugin/src/plugin/auth-plugin.ts:204`; `session-plugin/src/plugin/session-plugin.ts:84-88`                              | `optionalDependencies`: used when present, tolerated when absent; auth lists only `SESSION`, session `SECRETS` and `CACHE`                                                                                   |
| Generated test scripts             | `cli/src/templates/project-files.ts:1282,1628-1663`                                                                                                           | `deno test -A …` and the npm `test` script load no `.env` into the process                                                                                                                                   |
| Workers body bound                 | `runtime/src/adapters/workers/cf-http-adapter.ts:45-49`                                                                                                       | The Workers adapter honours `maxBodyBytes`                                                                                                                                                                   |
| Dry run                            | `cli/src/utils/file-writer.ts:548-554`                                                                                                                        | Lists paths and outcomes, no contents                                                                                                                                                                        |
| `add` env writer                   | `cli/src/commands/add.ts:2409-2450,2788-2814`; `templates/env-file.ts`                                                                                        | Only the broker path writes `.env`/`.env.example` rows, through `withEnvVariable`                                                                                                                            |
| Generated `createApp`              | scaffold of `--template rest` (CLI 0.12.0)                                                                                                                    | Plugins are constructed synchronously in `createApplication({ plugins })`; no config value is in scope there                                                                                                 |
| Migration runner                   | `cli/src/schematics/migration.ts:143,158,168,184,232-252`                                                                                                     | `--down` presence check; `runMigrations('down')` reverses every applied migration, newest first                                                                                                              |
| WebSocket options                  | `websocket-plugin/src/interfaces/index.ts:53,64,79,85`; `services/websocket-service.ts:97-117,799-802`                                                        | All bounds default 0; `maxMessageBytes` checked in `onMessage` after the runtime buffered the frame (close 1009)                                                                                             |
| WebSocket sink                     | `common/src/services/websocket.ts:82-110`                                                                                                                     | `WebSocketEventSink { onOpen, onMessage, onClose }` handed to the adapter                                                                                                                                    |
| Node upgrade                       | `runtime/src/adapters/node/node-ws-upgrader.ts:100-106,366,414-422`                                                                                           | One lazily built `ws` `WebSocketServer({ noServer, handleProtocols })`; `WsModuleLike` admits only those options; no `maxPayload` (ws default 100 MiB)                                                       |
| Bun / Deno upgrade                 | `runtime/src/adapters/bun/bun-http-adapter.ts:330-335`; `deno/deno-http-adapter.ts:120-124`                                                                   | Bun: no `maxPayloadLength` (Bun default 16 MB, one per server); Deno: `Deno.upgradeWebSocket` has no payload option                                                                                          |
| `add websocket`                    | `cli/src/commands/add.ts:293`; `utils/plugin-wirings.ts:31`                                                                                                   | Bare `WebSocketPlugin()`                                                                                                                                                                                     |
| SSE                                | `sse-plugin/src/interfaces/index.ts:17-22`; `services/sse-service.ts:68-69`; `common/src/services/sse.ts:60-91,152`                                           | `heartbeatMs` no default (off); `ISseConnection { send, comment, close, result, … }`                                                                                                                         |
| `g sse`                            | `cli/src/schematics/sse.ts:89-92,109`                                                                                                                         | Returns `sse.open(ctx).result`; keeps no handle                                                                                                                                                              |
| Gateway guards                     | `decorator-plugin/src/plugin/ingress-registration.ts:166-185,367-415`; `decorators/ingress.ts:113-117`; `metadata/metadata-store.ts:206`                      | `@UseGuards` refused on ingress; `websocket.route(path, handlers)` with no options; `@Gateway` stores `{ kind, path }`; `@Roles`/`@Permissions` on a gateway are read by nothing                             |
| WS route options                   | `common/src/services/websocket.ts:260-310,358-391`                                                                                                            | `WebSocketRouteOptions { protocols?, guards?, heartbeat? }`; guard sees `user?: IPrincipal`                                                                                                                  |
| Deno full-stack tasks              | `cli/src/templates/project-files.ts:1307-1315`; `full-stack.ts:339`                                                                                           | `install: deno install --allow-scripts --min-dep-age 0`; `start: deno task build && …`                                                                                                                       |
| Server build load                  | `react-router-plugin/src/handler/server-build.ts:157-171`                                                                                                     | Missing build: "Failed to load React Router server build from …"                                                                                                                                             |
| Deno dependency age                | `cli/src/templates/root-settings.ts:45-76`                                                                                                                    | `minimumDependencyAge: 0` for the project's life                                                                                                                                                             |
| `check` task                       | `cli/src/templates/project-files.ts:1301,1343-1356`; `templates/framework-specifier.ts:16,21-30`                                                              | `deno run -A --no-lock npm:@setu-ts/cli@^0.12.0 check`; docstrings say "pinned", the value is a caret range                                                                                                  |
| Devtool entry                      | `cli/src/devtool/dev-entry.ts:40,108-136`                                                                                                                     | Reads `runtime.env['SETU_DEVTOOL_SESSION_KEY']`, then `createApp()`                                                                                                                                          |
| Env into config                    | `config-plugin/src/services/env-loader.ts:105-111`                                                                                                            | Copies the whole process environment into the config store                                                                                                                                                   |
| `IRuntimeServices.env`             | `common/src/runtime.ts:388-397`                                                                                                                               | Read-only; Deno snapshots at creation, Node/Bun pass `process.env` through                                                                                                                                   |

External facts (survey 2026-11-13, primary sources): Fastify `bodyLimit` 1 MiB; NestJS
`@nestjs/platform-ws` sets `maxPayload` 1 MiB because `ws` parses before guards run; `ws`
`maxPayload` default 100 MiB; Bun `maxPayloadLength` 16 MB; Deno has no payload option; Django
rotates the CSRF token on login, Laravel's `regenerate()` regenerates the token, Spring clears it on
authentication; `@fastify/sse` heartbeat 30 s; Knex `migrate:down`, TypeORM `migration:revert`,
Rails `db:rollback`, node-pg-migrate `down` all undo one by default; Rails, Laravel, Phoenix,
AdonisJS and Django scaffolds write a random secret per project; Deno `minimumDependencyAge` accepts
`{ "age", "exclude": ["npm:@x/*"] }`; `deno install --allow-scripts=npm:a,npm:b`.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                              | Resolution (picked side)                                                        | Doc deliverable (same PR)                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| C1  | ROADMAP M140a lists `cli`, `session-plugin`, `auth-plugin`                                                            | Framework defaults are where several rows live (§0); the code is right to widen | ROADMAP M140a Packages cell: add `common`, `runtime`, `websocket-plugin`, `sse-plugin`, `decorator-plugin`, `react-router-plugin` |
| C2  | `ISession.regenerate` says it keeps the data; V12-69 needs the CSRF token dropped                                     | §3.5: `regenerate()` keeps the data except the form-CSRF token                  | `common/src/services/session.ts` JSDoc; session-plugin README; PUBLIC_API.md `ISession`                                           |
| C3  | Two comments say `regenerate()` drops the tenant binding; it never did                                                | The code and its test are right                                                 | Fix `common/src/services/session.ts:23-26` and `session-tenant-binding.ts:22-24`                                                  |
| C4  | `framework-specifier.ts` and `project-files.ts:1343,1356` call a caret range "pinned"                                 | §3.13 adds an exact form for the `check` task and corrects the words            | The docstrings                                                                                                                    |
| C5  | diagnostics-plugin AGENT_CARD says the key is supplied "in memory"; the generated entry takes it from the environment | §3.14 removes it from the environment before the app exists                     | AGENT_CARD sentence names the entry's behaviour                                                                                   |
| C6  | `project-files.ts:2115` says standalone Deno creates no `node_modules`                                                | The code at `:2247-2249` is right                                               | The comment (§3.4)                                                                                                                |

## 3. Design decisions

### 3.1 V12-63: every createApplication template bounds the body at 1 MiB

- **Decision:** `RUNTIME_WIRING` gains `args: '{ maxBodyBytes: 1_048_576 }'` (Workers keeps
  `workersArgs: '{ env, maxBodyBytes: 1_048_576 }'`), so `minimal`, `rest`, `class-based` and
  `microservice` all bound the read. The REST plugin list's `HttpSecurityPlugin` gains
  `args: '{ requestSize: { maxBodySize: 1_048_576 } }'`, which refuses an oversized `Content-Length`
  before the read. The value is the starter's `DEFAULT_STARTER_MAX_BODY_BYTES`, spelled as a literal
  with a one-line comment naming it (the generated project does not depend on `rest-starter`). The
  module schematic's `name` gains `.max(200)`, and `id` `.max(128)`.
- **Why:** Fastify's built-in 1 MiB and the starters' #583 default; a 413 rather than a multi-GB
  read.
- **Test home:** `cli/test/unit/new-command.test.ts` (both args per template and on Workers);
  `module-files.test.ts` (`.max`); the scaffold e2e posts 1 MiB + 1 to `rest` and gets 413.

### 3.2 V12-66, V12-67, V12-112: a random session secret per project, passed explicitly in production

- **Decision:**
  - A manifest env variable can declare `generated: 'secret'` in place of a static `develop`.
    `projectFiles` takes a fifth parameter `options?: { readonly secret?: () => string }`; for a
    `generated` variable it writes `secret()` into `.env` and `.dev.vars`, and leaves `.env.example`
    empty as now. Full-stack's `SESSION_SECRET` uses it.
  - New `cli/src/templates/secret.ts` exports `generateSecret(): string` (32 bytes from
    `crypto.getRandomValues`, lowercase hex, 64 characters) — internal, not in any barrel.
    `NewDependencies` gains `secret: () => string`, defaulted to `generateSecret` by `runMain`;
    `new.ts` and `app.ts` pass it to `projectFiles`. Dry run lists paths only
    (`utils/file-writer.ts:548-554`), so no value is shown.
  - README Production: for every `generated` variable, the `docker run` line gains `-e <NAME>`
    (`docker run --rm -p 3000:3000 -e SESSION_SECRET <name>`) and a sentence: set it in the shell to
    a value of at least 32 characters; the development value in `.env` is not copied into the image.
  - Workspace Compose (maintainer decision 2026-11-13, kept in M140a): the manifest records which
    secrets each member generates, because nothing else does — `WorkspaceMember`
    (`workspace/manifest.ts:131-200`) has no template or variable list, and
    `workspaceContainerFiles` (`compose.ts:498-520`) and `renderTransportSection`
    (`root-files.ts:68-72`) see only the manifest. `WorkspaceMember` gains
    `readonly generatedSecrets?: readonly string[]`, the variable names as the member reads them
    (`SESSION_SECRET`). The member parser (`manifest.ts:360-390`) keeps it when it is an array of
    strings matching `^[A-Z][A-Z0-9_]*$` and refuses the member otherwise, as it refuses a malformed
    `devtoolPort`; an absent or empty list is dropped. `generate app` writes it from the chosen
    template's `generated: 'secret'` variables; `adopt` writes none (an adopted project's variables
    are its own). `setu add auth` or `setu add session` run inside a workspace member appends its
    variable to that member's list (once) and replans the Compose file and the README transport
    section, as `devtool.ts:684` already replans container files from a member command.
  - Compose: for each name in a member's list, the member's `environment:` block gains
    `NAME: '${<MEMBER>_NAME:?set <MEMBER>_NAME — see README, Run the stack}'`, where `<MEMBER>` is
    the member name upper-cased with `-` → `_` (`web` → `WEB_SESSION_SECRET`). The shell variable
    carries the member's name so two members never share one session or JWT key. The `environment:`
    entry wins over `env_file`, so `docker compose up` refuses to start without the variable instead
    of crash-looping on a fresh clone, and the development value in the member's `.env` is never
    what Compose runs. Members without the field are unchanged.
  - README: `renderTransportSection` takes the members' shell variable names; when any exist it
    emits `## Run the stack` (also when the broker has no Compose service, since the Compose file
    exists regardless) with one `export <MEMBER>_NAME="$(openssl rand -hex 32)"` line per variable
    before the `docker compose` command, and a sentence saying Compose refuses to start without
    them. `docs/deployment.md`, which lists the member fields, documents `generatedSecrets` and the
    export step.
- **Why:** maintainer decision 2026-11-13; every surveyed scaffold that writes a secret writes a
  random one.
- **Test home:** `new-command.test.ts` (injected `secret` → exact `.env` and `.dev.vars` value; two
  scaffolds with the default generator differ; `.env.example` empty); `project-files.test.ts`
  (README `-e SESSION_SECRET`); `compose.test.ts` (the `:?` line with the member-prefixed variable
  on a member with `generatedSecrets`, none on one without, two members with distinct variables);
  `workspace-manifest.test.ts` (the field round-trips; a lower-case or non-string entry refuses the
  member); `app-command.test.ts` (a full-stack member records `SESSION_SECRET`, a rest member none);
  `add.test.ts` (`add auth` in a member appends `JWT_SECRET` once and replans Compose);
  `root-files.test.ts` (README sentence); `secret.test.ts` (length, alphabet).

### 3.3 V12-71: the JWT secret comes from the environment, and a short one is refused

- **Decision:**
  - `AuthPlugin`'s `jwt.secret` resolves in `register()`: the option, then `CAPABILITIES.SECRETS`
    (`JWT_SECRET`), then `CAPABILITIES.CONFIG` (`config.get('JWT_SECRET')`), then
    `runtime.env.JWT_SECRET`. One internal resolver, `auth-plugin/src/secret/jwt-secret.ts`, not
    exported. `AuthPlugin` adds `SECRETS` and `CONFIG` to its `optionalDependencies` (today only
    `SESSION`, `auth-plugin.ts:204`) so it registers after both when present. With RS256 keys set
    the secret is not looked up.
  - The config step is what makes a scaffold's own tests boot: `test` scripts do not load `.env`
    into the process (`project-files.ts:1282,1628-1663`), but
    `ConfigPlugin({ envFilePath: '.env', envFileOptional: true })` does load it into config.
    session-plugin's resolver gains the same config step between the secrets manager and the
    environment (`secret-resolver.ts:58-66`), and `CONFIG` joins its `optionalDependencies`
    (`session-plugin.ts:88`); ConfigPlugin copies the environment into config, so an
    environment-only setup resolves as before.
  - An HS256 secret under 32 bytes (UTF-8 length of a string, byte length of a `Uint8Array`) is
    refused by `AuthPlugin` and by `JwtService` with `AuthPluginConfigurationError` naming
    `JWT_SECRET` and the RFC 7518 §3.2 floor. A missing secret with no RS256 keys throws the same
    class (replacing the plain `Error`).
  - `setu add auth` prints `AuthPlugin({ jwt: {}, rbac: { roles: {} } })` (the empty `jwt` turns on
    the JWT strategy, whose secret the resolver finds; without it `register()` refuses for want of a
    passive strategy, `auth-plugin.ts:515`) and writes `JWT_SECRET=<secret()>` into the project's
    env file and `JWT_SECRET=` into `.env.example`, through the existing `withEnvVariable` path; on
    Workers the files are `.dev.vars` and `.dev.vars.example`. An existing `JWT_SECRET` row is left
    as it is. `setu add session` prints `SessionPlugin()` and writes `SESSION_SECRET` the same way.
    `g guard`'s JSDoc shows `jwt: {}` and names `JWT_SECRET`.
  - Every repository literal under 32 bytes (`'test-secret'` and the others the survey counted, 18
    files, among them `apps/rest-api/src/auth/demo-token.ts:10` and
    `starters/rest-starter/README.md:92`) is lengthened.
- **Why:** the plugins are constructed where no config value is in scope, so a config read in the
  hint is not possible; session-plugin already resolves this way. RFC 7518 requires a 256-bit HS256
  key.
- **Test home:** `auth-plugin/test/unit/jwt-secret.test.ts` (each precedence step, RS256 skips, 31 →
  refused, 32 → accepted, string and bytes);
  `session-plugin/test/unit/secret/secret-resolver.test.ts` (the config step, its place in the
  order); the scaffold e2e runs `setu add auth` then the project's own `test` script, which boots;
  `jwt-service.test.ts` (short refused); `add.test.ts` (printed lines, env rows, `.env.example`
  empty).

### 3.4 V12-64, V12-108, V12-117: the `.gitignore` covers what the project creates

- **Decision:** every standalone project ignores `.env`, `.env.*` and keeps `!.env.example`
  (independent of `envFilePath`, since the start scripts load `.env` regardless). Every Deno project
  ignores `node_modules/`. Workers ignores `.dev.vars`, `.dev.vars.*` and keeps
  `!.dev.vars.example`. The `:2115` comment is corrected (C6).
- **Why:** each listed file is created or read by the generated tooling.
- **Test home:** `project-files.test.ts`, one table over minimal/rest/full-stack × node/bun/deno and
  rest on Workers, asserting the exact entry set.

### 3.5 V12-69: `regenerate()` drops the form-CSRF token

- **Decision:** `Session.regenerate()` deletes `CSRF_SESSION_KEY`; the next `getCsrfToken` mints a
  new token. Every other key is kept. Because auth-plugin's `signIn`, `promotePending` and stamp
  revocation, and the template login, all call `regenerate()`, they rotate the token with no change
  of their own. The contract and README say so (C2).
- **Why:** Django, Laravel and Spring rotate or clear on authentication; one change at the primitive
  covers every caller.
- **Test home:** `session-plugin/test/unit/services/session.test.ts` (token gone, other data kept);
  `test/integration/csrf-across-regenerate.test.ts` (a token read before `regenerate()` is refused
  with 403 after it, a fresh one passes); `auth-plugin/test/integration/sign-in-csrf.test.ts` (a
  pre-sign-in token is refused after password sign-in and after MFA promotion).

### 3.6 V12-72: `--down` reverses one migration unless told otherwise

- **Decision:** `--down` reverses the newest applied migration. `--down=<n>` (positive integer)
  reverses the newest `n`; `--down=all` reverses every applied one. Any other value exits 1 with a
  message naming the accepted forms, before touching the database. The runner prints each name it
  reverses. `runMigrations(direction, deps, count?)` takes the count; the help comment says so.
- **Why:** Knex, TypeORM, Rails, MikroORM and node-pg-migrate all undo one by default.
- **Test home:** `migration.test.ts` (generated text), and a run of the generated runner over a fake
  ledger with three applied entries for `--down`, `--down=2`, `--down=all`, `--down=0`, `--down=x`.

### 3.7 V12-74 (framework half): `@Gateway` takes route options

- **Decision:** `@Gateway(path, options?: WebSocketRouteOptions)` stores the options in gateway
  metadata, and `ingress-registration.ts` passes them as `websocket.route(path, handlers, options)`.
  `@Roles` or `@Permissions` on a gateway class or method, and `@Public` on a gateway method
  (`Public()` is a method decorator, `security.ts:144`, so a class cannot carry it), is refused at
  registration with a message naming `@Gateway(path, { guards })`, as `@UseGuards` already is. Both
  `g ws-route` arms gain a commented `guards` example, since neither has one today: the class arm
  above `@Gateway('/ws/<name>')` shows `@Gateway('/ws/<name>', { guards: [...] })`, the functional
  arm shows the third `websocket.route` argument.
- **Why:** the plugin already supports guards per route; a decorated gateway had no way to reach
  them, and authorization decorators were silently ignored.
- **Test home:** `decorator-plugin/test/integration/gateway-guards.test.ts` (a refusing guard gives
  the guard's status before the handshake; an accepting one connects; `@Roles` on a gateway
  refused); `ws-route.test.ts`.

### 3.8 V12-75: a 1 MiB WebSocket frame limit by default, enforced at the transport where it can be

- **Decision:** `maxMessageBytes` defaults to `1_048_576`; `0` still means unlimited.
  `WebSocketEventSink` gains `readonly maxMessageBytes?: number`, which websocket-plugin sets from
  its resolved option. The Node upgrader keeps one `ws` server per distinct limit, built with
  `maxPayload` equal to it, so an oversized frame is refused while it is read. Bun keeps its own
  per-server 16 MB transport cap and Deno has none; on both the plugin's existing check (close 1009)
  applies, and the README says the transport bound is Node-only.
- **Why:** NestJS's platform-ws adopted 1 MiB for exactly this reason; `ws`'s 100 MiB is read before
  any guard.
- **Test home:** `websocket-service.test.ts` (default resolves to 1 MiB, sink carries it);
  `node-ws-upgrader.test.ts` (two limits → two servers with the right `maxPayload`, `0` → ws
  default); a real `ws` test sending 1 MiB + 1 gets close 1009.

### 3.9 V12-76: SSE sends a heartbeat by default, and `g sse` keeps the connection

- **Decision:** `heartbeatMs` defaults to `30_000`; `0` disables it. `g sse` emits the README idiom:
  `const conn = sse.open(ctx); conn.send({ event: 'ready', data: {} }); return conn.result;`, with a
  comment pointing at `sse.channel(name)` for fan-out, in both arms.
- **Why:** a comment frame every 30 s (`@fastify/sse`'s default) is harmless to every client and
  keeps proxies from cutting the stream.
- **Test home:** `sse-service.test.ts` (default timer at 30 s, `0` none); `sse.test.ts`.

### 3.10 WebSocket heartbeat, idle timeout and connection cap stay off

- **Decision:** unchanged defaults. Recorded so no test or doc asserts otherwise.
- **Why:** the heartbeat is an application text frame a client must understand; the idle sweep
  closes clients that send nothing; no surveyed stack caps connections by default.
- **Test home:** none (no behaviour changes).

### 3.11 V12-119: the full-stack Deno install runs no install scripts and `start` does not build

- **Decision:** `install` becomes `deno install` (no `--allow-scripts`, no `--min-dep-age`). `start`
  becomes the run command alone. The scaffold e2e installs and builds a Deno full-stack project with
  that task; if a dependency then fails for want of a script, the task lists exactly that package as
  `--allow-scripts=npm:<pkg>` and the plan is amended. The server-build load error adds: "If the app
  has not been built, run its `build` task first."
- **Why:** maintainer decision 2026-11-13. The review found no scaffold dependency with an install
  script (vite 8's lightningcss and rolldown use platform packages).
- **Test home:** `project-files.test.ts` (task strings); `server-build.test.ts` (message);
  `scaffold-runs-e2e.test.ts` (Deno full-stack installs, builds, starts).

### 3.12 V12-120: the dependency cooldown stays on for everything but `@setu-ts/*`

- **Decision:** `deno.json` carries
  `"minimumDependencyAge": { "age": "P1D", "exclude": ["npm:@setu-ts/*"] }` instead of `0`, with the
  note rewritten to say why the framework is excluded (release-day installs of the pinned version).
- **Why:** maintainer decision 2026-11-13 ("covers only the scaffold's own install"); the exclude
  form keeps Deno's cooldown for every third-party range.
- **Test home:** `root-settings.test.ts`; the scaffold e2e installs on release day's pin.

### 3.13 V12-120 (check task): the exact CLI version

- **Decision:** `templates/framework-specifier.ts` gains `exactFrameworkSpecifier(pkg)`
  (`npm:@setu-ts/<pkg>@<VERSION>`); the Deno `check` task uses it. Other uses keep the range.
- **Test home:** `framework-specifier.test.ts` (new); `project-files.test.ts` (task string).

### 3.14 V12-129: the devtool key leaves the environment before the app exists

- **Decision:** the generated `main.dev.ts` reads the key, then deletes `SETU_DEVTOOL_SESSION_KEY`
  from the ambient environment (`Deno.env.delete` on Deno, `delete process.env[...]` on Node and
  Bun) before calling `createApp()`, so ConfigPlugin's copy and child processes never see it. The
  entry's own `runtime` (created first, `dev-entry.ts:102`) keeps a Deno snapshot with the key; it
  is never handed to the app, whose `RuntimePlugin` builds its services after the deletion.
- **Test home:** `dev-entry.test.ts` (emitted text per runtime); the devtool e2e asserts
  `config.get('SETU_DEVTOOL_SESSION_KEY')` is `undefined` in the booted dev app on Node and Deno.

### 3.16 Documentation this milestone's behaviour changes

- **Decision:** in this PR, not M140e: PUBLIC_API.md (`ISession.regenerate`,
  `WebSocketEventSink.maxMessageBytes`, `@Gateway`, `AuthPlugin` `jwt.secret` resolution and floor,
  the WebSocket and SSE defaults, session-plugin's config step); the READMEs and AGENT_CARDs of
  session-plugin, auth-plugin, websocket-plugin, sse-plugin and decorator-plugin; the
  diagnostics-plugin card (C5); `docs/upgrading.md` (the `check` task's exact CLI version is edited
  with the `@setu-ts/*` versions when a project upgrades, since there is no `setu upgrade`).
  AGENT_CARD text names only exported identifiers (the card gate refuses others).
- **Test home:** `pnpm run check:docs`; the agent-card gate.

### 3.15 CHANGELOG

One `[Unreleased]` entry per package. BREAKING: `regenerate()` drops the CSRF token; HS256 secrets
under 32 bytes refused; `maxMessageBytes` and `heartbeatMs` defaults; `AuthPlugin` throws
`AuthPluginConfigurationError`. Each names what a consumer does instead.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none (one optional member added to `WebSocketEventSink`); behaviour
changes listed in §3.15 ship in minor `0.13.0`.

| Exported symbol                      | Kind                    | Consumer / real code path that READS it                  |
| ------------------------------------ | ----------------------- | -------------------------------------------------------- |
| `WebSocketEventSink.maxMessageBytes` | optional field (common) | `runtime` Node upgrader picks the `ws` server by it      |
| `@Gateway` second parameter          | decorator parameter     | `ingress-registration.ts` passes it to `websocket.route` |

### 4.1 Options — every option names its consumer

| Option                                     | Consumer                                                  | Behavior (per implementation)                                |
| ------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------ |
| `maxMessageBytes` default 1 MiB            | websocket-service `onMessage`; Node upgrader via the sink | Node: refused at read; Bun/Deno: closed 1009 after buffering |
| `heartbeatMs` default 30 000               | sse-connection timer                                      | Comment frame per interval; `0` none                         |
| `jwt.secret` now optional                  | `jwt-secret.ts` resolver                                  | Option → `SECRETS` → env; ≥ 32 bytes                         |
| `projectFiles` `options.secret` (internal) | env renderers                                             | Value for `generated` variables                              |

## 5. Implementation files

| File                                                                                                         | Purpose                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `cli/src/templates/rest.ts`                                                                                  | Body bounds (§3.1)                                                                              |
| `cli/src/schematics/module-files.ts`                                                                         | `.max` (§3.1)                                                                                   |
| `cli/src/templates/secret.ts` (new)                                                                          | `generateSecret` (§3.2)                                                                         |
| `cli/src/templates/project-files.ts`                                                                         | Generated env values, README `-e`, `.gitignore`, Deno tasks, check task (§3.2, 3.4, 3.11, 3.13) |
| `cli/src/templates/full-stack.ts`                                                                            | `SESSION_SECRET` `generated` (§3.2)                                                             |
| `cli/src/commands/new.ts`, `commands/app.ts`                                                                 | `secret` seam (§3.2)                                                                            |
| `cli/src/workspace/compose.ts`, `workspace/root-files.ts`, `workspace/manifest.ts`, `commands/{app,add}.ts`  | Compose `:?`, README (§3.2)                                                                     |
| `cli/src/commands/add.ts`, `schematics/guard.ts`                                                             | Hints and env rows (§3.3)                                                                       |
| `cli/src/schematics/migration.ts`                                                                            | `--down` count (§3.6)                                                                           |
| `cli/src/schematics/ws-route.ts`, `schematics/sse.ts`                                                        | §3.7, §3.9                                                                                      |
| `cli/src/templates/root-settings.ts`, `templates/framework-specifier.ts`                                     | §3.12, §3.13                                                                                    |
| `cli/src/devtool/dev-entry.ts`                                                                               | §3.14                                                                                           |
| `session-plugin/src/services/session.ts`, `services/session-tenant-binding.ts`                               | §3.5, C3                                                                                        |
| `session-plugin/src/secret/secret-resolver.ts`, `plugin/session-plugin.ts`                                   | Config step and `optionalDependencies` (§3.3)                                                   |
| `common/src/services/session.ts`, `common/src/services/websocket.ts`                                         | C2, C3, §3.8                                                                                    |
| `auth-plugin/src/secret/jwt-secret.ts` (new), `plugin/auth-plugin.ts`, `services/jwt-service.ts`             | §3.3                                                                                            |
| `websocket-plugin/src/services/websocket-service.ts`, `interfaces/index.ts`                                  | §3.8                                                                                            |
| `runtime/src/adapters/node/node-ws-upgrader.ts`                                                              | §3.8                                                                                            |
| `sse-plugin/src/services/sse-service.ts`, `interfaces/index.ts`                                              | §3.9                                                                                            |
| `decorator-plugin/src/decorators/ingress.ts`, `metadata/metadata-store.ts`, `plugin/ingress-registration.ts` | §3.7                                                                                            |
| `react-router-plugin/src/handler/server-build.ts`                                                            | §3.11                                                                                           |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                              | src covered                                                  | Key assertions                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `cli/test/unit/new-command.test.ts`                                                                                    | `rest.ts`                                                    | §3.1 args on node and Workers                                                           |
| `cli/test/unit/schematics/module-files.test.ts` (new)                                                                  | `module-files.ts`                                            | `.max(200)`, `.max(128)`                                                                |
| `cli/test/unit/templates/secret.test.ts` (new)                                                                         | `secret.ts`                                                  | 64 hex characters; two calls differ                                                     |
| `cli/test/unit/templates/project-files.test.ts`                                                                        | `project-files.ts`                                           | env values, README, `.gitignore` table, Deno tasks, check task                          |
| `cli/test/unit/new-command.test.ts`                                                                                    | `new.ts`, `full-stack.ts`                                    | injected secret; default differs per scaffold; dry run                                  |
| `cli/test/unit/app-command.test.ts`                                                                                    | `app.ts`                                                     | member `.env` uses the seam                                                             |
| `cli/test/unit/workspace/compose.test.ts`, `root-files.test.ts`                                                        | `compose.ts`, `root-files.ts`                                | `:?` on `web`; README                                                                   |
| `cli/test/unit/commands/add.test.ts`, `schematics/guard.test.ts`                                                       | `add.ts`, `guard.ts`                                         | hints, env rows                                                                         |
| `cli/test/unit/schematics/migration.test.ts`                                                                           | `migration.ts`                                               | five `--down` forms over a fake ledger                                                  |
| `cli/test/unit/schematics/ws-route.test.ts`, `sse.test.ts`                                                             | `ws-route.ts`, `sse.ts`                                      | emitted text                                                                            |
| `cli/test/unit/root-settings.test.ts`, `framework-specifier.test.ts` (new)                                             | both                                                         | object form; exact specifier                                                            |
| `cli/test/unit/dev-entry.test.ts`                                                                                      | `dev-entry.ts`                                               | deletion per runtime before `createApp`                                                 |
| `cli/test/e2e/scaffold-runs-e2e.test.ts`                                                                               | generated output                                             | 413 on rest; Deno full-stack install/build/start; devtool key absent from config        |
| `session-plugin/test/unit/services/session.test.ts`, `test/integration/csrf-across-regenerate.test.ts` (new)           | `session.ts`                                                 | §3.5                                                                                    |
| `session-plugin/test/unit/secret/secret-resolver.test.ts`                                                              | `secret-resolver.ts`, `session-plugin.ts`                    | Config step between secrets manager and environment; `CONFIG` in `optionalDependencies` |
| `auth-plugin/test/unit/jwt-secret.test.ts` (new), `jwt-service.test.ts`, `test/integration/sign-in-csrf.test.ts` (new) | `jwt-secret.ts`, `auth-plugin.ts`, `jwt-service.ts`          | §3.3, §3.5                                                                              |
| `websocket-plugin/test/unit/websocket-service.test.ts`                                                                 | `websocket-service.ts`                                       | default, sink field                                                                     |
| `runtime/test/unit/node-ws-upgrader.test.ts`, guarded real-`ws` test                                                   | `node-ws-upgrader.ts`                                        | server per limit; 1 MiB + 1 → 1009                                                      |
| `sse-plugin/test/unit/sse-service.test.ts`                                                                             | `sse-service.ts`                                             | 30 s default; `0` none                                                                  |
| `decorator-plugin/test/integration/gateway-guards.test.ts` (new)                                                       | `ingress.ts`, `metadata-store.ts`, `ingress-registration.ts` | §3.7                                                                                    |
| `react-router-plugin/test/unit/server-build.test.ts`                                                                   | `server-build.ts`                                            | message                                                                                 |

## 7. Verification gates

```bash
git branch --show-current   # feat/m140a-security-defaults
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage cli session-plugin auth-plugin common runtime websocket-plugin sse-plugin decorator-plugin react-router-plugin
pnpm run test:deno-lane
pnpm run ci:local          # on the final commit
pnpm run release:publish --dry-run
pnpm run release:verify 0.12.0
```

The scaffold e2e boots every template this milestone changes (CLAUDE.md generated-output rule).

## 8a. Design security review

Completed 2026-11-13, before implementation, against the source cited in §1.

- **Reviewed flows:** F1 a large or chunked POST to a scaffolded route; F2 a scaffold's `.env`
  reaching Git, an image or a Compose service; F3 a session cookie forged with a known secret; F4 a
  JWT signed with a short or committed secret; F5 a CSRF token planted before sign-in posted after
  it; F6 a WebSocket client sending a huge frame or connecting to a guarded gateway; F7 a Deno
  install running a dependency's lifecycle script; F8 the devtool MAC key read through config.
- **Assets:** process memory; the session secret and every signed-in session; the JWT key and every
  bearer token; the CSRF binding; the database schema; the developer's machine during install; the
  diagnostics channel.
- **Attackers:** an unauthenticated client; anyone who has read the scaffold source or a public repo
  created from it; a cross-site page driving a signed-in browser; a compromised npm package; code in
  the app process reading config.
- **Obligations the audit probes** (each with a positive control):
  - **O1** A scaffolded `rest` and `minimal` app refuses 1 MiB + 1 (413 on `rest`), chunked
    included; 1 MiB passes.
  - **O2** Two scaffolds have different `SESSION_SECRET`s; neither is in `.env.example`, the image,
    or Git after `git add -A`; Compose without the variable refuses to start, with it starts.
  - **O3** `AuthPlugin` refuses a 31-byte HS256 secret and accepts 32; `setu add auth` writes the
    secret to the ignored env file only, and a scaffold's own tests still boot after it.
  - **O4** A CSRF token read before sign-in is refused after password sign-in, after MFA promotion
    and after the template login; a token read after passes.
  - **O5** On Node a 1 MiB + 1 frame closes 1009 without the plugin's `onMessage` running; 1 MiB
    passes. A `@Gateway` guard refusal gives its status before the handshake; `@Roles` on a gateway
    fails registration.
  - **O6** The Deno full-stack install runs with no `--allow-scripts`; the cooldown applies to a
    third-party range and not to `@setu-ts/*`; `check` runs the exact CLI version.
  - **O7** In the devtool app, `config.get('SETU_DEVTOOL_SESSION_KEY')` and a child process's
    environment lack the key; the connector still authenticates.
  - **O8** `--down` reverses one migration; `--down=x` touches nothing.

## 8. Risks & mitigations

- A form rendered before sign-in and posted after now fails CSRF (second tab, OTP page rendered
  before the pending-MFA regenerate) → the auth flows already fetch a token after sign-in
  (auth-plugin tests use `/_csrf` after sign-in); the README names the rule.
- Lengthening 18 files of test secrets churns many tests → mechanical, one batch.
- Deno full-stack may need one install script after all → §3.11's named fallback, proven by the e2e.
- Bun and Deno buffer a frame before the plugin's check → documented; Bun's own cap bounds it.
- The object form of `minimumDependencyAge` needs a Deno that accepts it → the e2e runs the lane's
  pinned Deno; the README's Deno minimum is that version.
- The `check` task pins the CLI that generated the project, so after an upgrade it lags until edited
  → `docs/upgrading.md` step (§3.16).
- `minimal` has no `errorHandler`, so its oversized body answers the kernel's opaque 500, not 413 →
  the read is still bounded (O1 asserts the bound, not the status, on `minimal`).

## 9. Out of scope

- A per-IP WebSocket connection cap and transport payload bounds on Bun and Deno: no seam carries a
  per-route limit to `Bun.serve`, and Deno has no option.
- Mapping the kernel's opaque 500 for a status-hinted error without `errorHandler`: a kernel change,
  not a scaffold default.
- The application halves listed in §0.
