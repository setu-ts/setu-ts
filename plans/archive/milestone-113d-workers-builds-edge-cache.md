# Milestone 113d — Workers Builds and the Edge Cache (optional-peer loaders, `@setu-ts/cloudflare-plugin`, `@setu-ts/react-router-plugin`, `@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m113d-workers-builds-edge-cache`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR into `develop`.

## 0. Objective & scope

A Cloudflare Worker that imports a Setu-TS package builds, deploys, and serves, whether or not that
package's optional peers are installed. Every Workers template the CLI scaffolds starts under
`npx wrangler dev` from a pristine scaffold. The edge cache stores the body it serves, whether or
not the application passes `waitUntil`. Three register rows from the `v0.9.0` smoke programme:

- **V9-1 (High, the only `0.9.0` regression).** M111a turned every lazy driver import into
  `import('<bare peer>')`. Wrangler bundles with esbuild, which resolves a string-literal `import()`
  at build time, so a Worker importing `database-plugin` fails with `Could not resolve "mongodb"`
  (and four more) although it never loads one. Two of the five CLI Workers templates cannot start
  from a pristine scaffold, and `tsc` passes, so nothing says so before deploy.
- **V9-23 (High).** `cacheApiMiddleware` caches an EMPTY body unless `CloudflarePlugin` receives
  `waitUntil`, and the scaffold offers no working way to pass it.
- **V9-4 (Low, docs).** The cloudflare README says an unmatched cron trigger is silent without a
  logger. Since M70l it throws, which is the intended behaviour.

**The investigation the ROADMAP asked for came first, and it keeps this a design letter.** V9-1 is
not one import. Eighteen published packages carry a literal `import('<bare peer>')` (inventory in
§1), so the fix is a repository-wide rule plus a gate, not a `fix/…` branch.

**V9-1 also hid three more defects in the full-stack Workers template, found by building and booting
it (§1, "Full-stack Workers probe").** With every import guarded, the template builds, then fails at
startup (`TypeError: Invalid URL string` — the server build is located with
`new URL(…, import.meta.url)`, which a bundled Worker cannot resolve), then on a missing
`SESSION_SECRET` (the Workers target emits no local variables file), then serves pages whose client
bundle answers 404 (no `[assets]` stanza). Fixing only the build would move the template from
"cannot build" to "answers 503", so all three are in scope (§3.10).

- **In scope:** the guarded-import rule and its source gate (§3.1, §3.2); converting every unguarded
  bare `import()` in `packages/*/src` and `packages/starters/*/src`; one shared error class in
  `common` (§3.3); a Workers bundle leg in `check:node-build` (§3.4); a CLI e2e that builds every
  Workers template and boots two under real workerd (§3.5); the `cacheApiMiddleware` hostless-write
  fix and the registration warning (§3.6, §3.7); the generated Workers factory and entry always
  threading `waitUntil`, and `setu add cloudflare`'s guidance (§3.8); the V9-4 README correction
  (§3.9); the full-stack Workers template fixes and the `ReactRouterPluginOptions` option they need
  (§3.10); and the doc deliverables in §2.
- **NOT this milestone:** whether a peer can actually RUN on workerd (ioredis, amqplib and friends
  need raw TCP — a Worker that selects them fails at `register()` with the named error, which is
  correct); `SchedulerPlugin` on Workers (refused since M70l; `setu add scheduler` refuses it on a
  Workers project, `add.ts:142-145`); per-package Workers support matrices (M113l owns documentation
  drift); `cloudflare-plugin` off Workers (unchanged); the M113a–M113n rows.

## 1. Contracts verified from SOURCE (not names)

| Reference                                | Source (file:line)                                                                  | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bare `import()` sites                    | `grep -rnE "import\(\s*['\"][^.'\"#]" packages/*/src packages/starters/*/src`       | 52 call sites in 18 packages, plus 2 in `cli` (prettier, tsx — regular dependencies): auth (ioredis, @node-saml/node-saml), cache, database (mongodb, @aws-sdk/client-dynamodb, @azure/cosmos, @google-cloud/bigtable, drizzle-orm), feature-flags, graphql, grpc (4), idempotency, logger, mail (2), messaging (7), queue (4), react-router, realtime-backplane, runtime (@hono/node-server, ws), scheduler, secrets (4), storage (4), telemetry (10). At least one is already guarded (`react-router-plugin/src/handler/server-build.ts:165-167`); the §3.2 gate, not this count, decides which still need converting. No `.tsx` file exists under any `src`.                      |
| Current loader shape                     | `packages/scheduler-plugin/src/lock/redis-lock.ts:92-95`                            | `async function loadIoredis() { const mod = await import('ioredis'); return mod.Redis; }` — no `try`; callers that wrap do so in a different function (e.g. `packages/auth-plugin/src/saml/loader.ts:22-24` returns the bare promise).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| No loader classifies by error code       | `grep -rn "ERR_MODULE_NOT_FOUND\|MODULE_NOT_FOUND" packages/*/src`                  | Empty. A workerd rejection (`No such module "ioredis"`) reaches the same paths a Node `ERR_MODULE_NOT_FOUND` does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| esbuild tolerance rule                   | Probe with root `esbuild@0.28.2` (`package.json:57`), 2026-10-16                    | Unresolvable `import('x')` is NOT an error when it is the operand of `await` (through parentheses and erased TypeScript assertions) lexically inside the `try` or `catch` block of the SAME function — wherever that `await` sits in the expression (assignment, return, call argument, array element, object property) — or when it is the target of a `.catch(…)` / two-argument `.then(…)`. It IS an error when UNAWAITED even inside the `try` (`const p = import('x')`, `return import('x')`, `Promise.all([import('x')])`; re-measured 2026-10-17 at implementation, correcting this row's first version), inside a `try` of an ENCLOSING function, inside `finally`, or bare. |
| Same rule under real wrangler + workerd  | Probe with `wrangler 4.114.0`, 2026-10-16                                           | Peer absent: `deploy --dry-run` succeeds, the call rejects at runtime with `No such module "ioredis"`. Peer installed: bundled (marker present once). Node: unchanged (`Cannot find package 'ioredis'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Template probe, 0.9.0 tree packed        | Scaffold via `runCli` + the M111d registry overlay + `wrangler 4.148.0`, 2026-10-16 | Before guarding: `rest` builds; `microservice` fails with 11 `Could not resolve`; `full-stack` with 40. After wrapping every bare import in the installed dist in a same-function `try`: all three build (`microservice` 888 KiB, `full-stack` 2919 KiB); `microservice` serves `/` 200 and `/health` `up` under `wrangler dev`.                                                                                                                                                                                                                                                                                                                                                     |
| Full-stack Workers probe                 | Same scaffold, `react-router build` (Vite 8.3.4) then `wrangler dev`                | Vite succeeds BEFORE any fix — the server build is 24 KB because `vite.config.ts` marks every `@setu-ts/*` package external (`full-stack-build-files.ts:177-191`), so Rollup never sees their imports; every failure is wrangler's esbuild pass. After the guard: startup throws `TypeError: Invalid URL string` at `setu.config.ts:43` (`new URL('./build/server/index.js', import.meta.url)`). With a statically imported build: `Configuration key "SESSION_SECRET" is not set`. With `.dev.vars`: `/` and `/login` 200 HTML, `/health` `up`, `/products` 302 — but `/assets/entry.client-*.js` 404. With `[assets] directory = "./build/client"`: 200 `text/javascript`.         |
| Default server-build loader              | `packages/react-router-plugin/src/handler/server-build.ts:140-160`                  | `await import(serverBuildPath)` under a `computed-specifier` marker — esbuild cannot bundle a computed path, so on Workers the build must arrive as a module, not a path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ReactRouterPluginOptions`               | `packages/react-router-plugin/src/interfaces/index.ts:110-140`                      | `serverBuildPath: string` (required); `loadRequestHandler?(serverBuildPath, mode): Promise<SsrRuntime>`. No way to pass a build object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Starter pass-through                     | `packages/starters/full-stack-starter/src/options.ts:75`; `app.ts:78`               | `reactRouter?: ReactRouterPluginOptions`, passed verbatim to `ReactRouterPlugin(...)` — a new plugin option needs no starter change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Workers dotenv                           | `packages/cli/src/templates/project-files.ts:169-173,203-262`                       | On Workers the manifest's `envFilePath` is removed (`withoutEnvFilePath`), and with it the `envVariables` (`SESSION_SECRET`, `full-stack.ts:223-228`): no local variables file is emitted. `.gitignore` adds `.wrangler/` on Workers only (`:1745`).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ws` on Workers                          | Probe project, `npm ls ws`                                                          | Installed through `@setu-ts/runtime`, which declares `ws` as a NON-optional peer, so npm installs it. Its import is covered by the rule anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `try` survives `tsc` emit                | `tsconfig.base.json` (`target: es2024`)                                             | No down-levelling of `try`/`await`; the emitted `dist/` keeps the guard where the source put it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Import audit                             | `scripts/npm-specifier-audit.ts:1-30,127,139,501`                                   | Regex/masking scanner over `.ts` files: refuses computed `import()` specifiers (unless `computed-specifier:` marked) and `npm:`/`jsr:` specifiers. Runs on every suite run and as `release:verify` check 6. It has no notion of a guard.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Pack-and-install gate                    | `scripts/check-node-build.ts:1-24,100-140`; `ci.yml:555`                            | Packs every member, installs all of them in `.tmp/node-boot` with a PLAIN `npm install` — optional peers are therefore absent, exactly a Worker author's tree. CI runs it with `--require-all`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| No test bundles a Worker                 | `packages/cli/test/e2e/workers-install-e2e.test.ts:1-80`                            | The only Workers e2e is an `npm install --dry-run` resolution check; nothing runs wrangler or esbuild over a scaffold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `resolveWaitUntil`                       | `packages/cloudflare-plugin/src/background/wait-until.ts:56-68`                     | Attaches a rejection handler, then `host?.(reported)`. With no host the promise is not awaited by anyone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Cache write path                         | `packages/cloudflare-plugin/src/cache-api/cache-api-middleware.ts:389-409`          | `store()`: if `CAPABILITIES.CLOUDFLARE` is registered → `bindings.waitUntil(put)` and return; otherwise `await put`. So a registered plugin with no host abandons the write — the V9-23 mechanism.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ICloudflareBindings.waitUntil`          | `packages/cloudflare-plugin/src/bindings/binding-registry.ts:137,148-166,228`       | `waitUntil(promise): void`; `BindingRegistry` holds the resolved sink in `#waitUntil`. The interface carries no "has a platform sink" signal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `CloudflarePlugin.register`              | `packages/cloudflare-plugin/src/plugin/cloudflare-plugin.ts:120-147,253`            | `optionalDependencies: ['logger']`; builds `BindingRegistry` with `resolveWaitUntil(options.waitUntil, …)`; the health payload reports `waitUntil: options.waitUntil !== undefined`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `IPluginContext.runtime`                 | `packages/common/src/plugin.ts:521-525`; `runtime.ts:309`                           | Non-optional `IRuntimeServices`; `platform()` answers `'cloudflare-workers'` on workerd (M59 fixed detection; the probe's `/health` payload shows it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Generated Workers factory                | `packages/cli/src/templates/project-files.ts:477-495,567-569`                       | Declares `waitUntil?` (second parameter) ONLY when a wiring's `workersArgs` mentions it (`consumesWaitUntil`); otherwise `(env, _devtool)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Generated Workers entry                  | `packages/cli/src/templates/project-files.ts:765-787,944-947`                       | Imports `waitUntil` from `cloudflare:workers` and calls `createApp(env, waitUntil)` only when `wantsWaitUntil`; the import lives only in `src/index.ts` because `setu` loads `setu.config.ts` and cannot resolve `cloudflare:`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Starter-composed factory                 | `packages/cli/src/templates/project-files.ts:399-440`; `full-stack.ts:183-188`      | Full-stack factory is `(env?, _devtool?, ssr?)`; `ssr: Pick<ReactRouterPluginOptions, 'loadRequestHandler' \| 'mode'>` is read on deno/node/bun only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Microservice Workers swap                | `packages/cli/src/templates/microservice.ts:118-137`                                | Already renders `CloudflarePlugin({ env, ...(waitUntil ? { waitUntil } : {}), … })` — the spread is required under `exactOptionalPropertyTypes` because `setu commands` calls the factory with no `waitUntil`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `setu add` on Workers                    | `packages/cli/src/commands/add.ts:137-145,253`                                      | `cloudflare-plugin` prints `CloudflarePlugin({ env })` — no `waitUntil`. `scheduler-plugin` is refused on `cloudflare-workers` ("the scheduler is unavailable on Cloudflare Workers").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Microservice telemetry on Workers        | `packages/cli/src/templates/microservice.ts:30`; `telemetry-plugin.ts:234-250`      | `TelemetryPlugin()` with no `exporter` never calls the OTel loaders, so the build fix is sufficient for it to serve (confirmed by the template probe).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Cron dispatch                            | `packages/cloudflare-plugin/src/cron/workers-cron.ts:139-155`                       | An unmatched trigger warns through an optional logger AND throws (M70l X9-5, deliberate). README lines 135-137 and 429-432 say "without one that path is silent".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Generated `compatibility_date`           | `packages/cli/src/templates/project-files.ts:1945`                                  | `"2025-09-01"`, with `nodejs_compat` — after `waitUntil` became importable from `cloudflare:workers` (2025-08-08).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `vi.doMock` reaches a literal `import()` | Probe in `packages/scheduler-plugin`, 2026-10-16                                    | A throwing `vi.doMock('ioredis', …)` factory makes `await import('ioredis')` reject — the technique for covering each new `catch` at its real site (§6). Not yet shown for an import inside a `src` module; §8 names the fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                              | Resolution (picked side)                                                                                             | Doc deliverable (same PR)                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | AI_GUIDELINES §12.2 and §14.4 mandate a bare literal `import('<pkg>')` and nothing more — the exact shape that breaks every Worker.                                                                                   | The literal stays (Node bundlers and the M70e audit still need it), and it must sit in a same-function `try` (§3.1). | Amend AI_GUIDELINES §12.2 and §14.4; amend the CLAUDE.md pitfall "A lazily-loaded optional dep must ACTUALLY load".                                     |
| C2  | ROADMAP M113d says "Investigate first: if the cause is one import, the fix is a `fix/…` branch", and lists `database`, `scheduler`, `cloudflare`, `cli`.                                                              | Not one import — 18 packages plus `cli`, plus `react-router-plugin` and `common` for §3.3/§3.10.                     | ROADMAP M113d section: record the finding and the three full-stack defects; correct the `Package(s)` line and the summary-table row; Progress row 113d. |
| C3  | cloudflare README (lines 135-137, 429-432) says an unmatched cron trigger is silent without a logger; `WorkersCron.dispatch` throws (M70l).                                                                           | The code is right (V9-4: "behaviour right, sentence wrong").                                                         | Correct both README sites; state that the invocation fails and a logger adds a structured warning.                                                      |
| C4  | cloudflare README and `PUBLIC_API.md` (Cloudflare section, "The cache write rides `waitUntil` when the plugin is registered") imply a registered plugin is enough for the cache write to land.                        | After §3.6 the write lands with or without a host; `waitUntil` decides only whether it delays the response.          | Correct the README cache section and the `PUBLIC_API.md` note; add the §3.7 warning to the options table.                                               |
| C5  | `setu add cloudflare` prints `CloudflarePlugin({ env })` while the README's only working form passes `waitUntil` — the X9-1 defect, closed in alpha.9 on README wording, still reachable from the CLI's own guidance. | The CLI prints the `waitUntil` form on a Workers project (§3.8).                                                     | `packages/cli/README.md` `setu add` section; `docs/upgrading.md` entry for projects scaffolded before this change.                                      |
| C6  | `ReactRouterPluginOptions.serverBuildPath` JSDoc (`interfaces/index.ts:~105-118`) recommends `new URL('./build/server/index.js', import.meta.url).href` as the general form; it cannot work in a bundled Worker.      | Correct for socket targets; on Workers the build is passed as a module (§3.10).                                      | `serverBuildPath` and new `serverBuild` JSDoc; react-router-plugin README "Cloudflare Workers" section; `PUBLIC_API.md` React Router options.           |

## 3. Design decisions

### 3.1 The guarded-import rule

- **Decision:** every dynamic `import()` in `packages/*/src` and `packages/starters/*/src` whose
  specifier is a bare package name (not `node:` and not `@setu-ts/*`) is written as a literal and
  AWAITED inside the `try` block of a `try`/`catch` in the SAME function
  (`mod = await import('ioredis')`). The `catch` throws `OptionalDependencyUnavailableError` (§3.3),
  or the package's own existing named load error when it has one (react-router's descriptive
  `Error`, `GrpcRuntimeLoadError`, `SamlRuntimeLoadError`), with the original rejection as `cause`
  in both cases. The `.catch()` chain form is not used — one shape, so the gate and a reader have
  one thing to recognise.
- **Why:** it is the one shape that satisfies all three consumers at once, each measured (§1):
  esbuild (and so wrangler) leaves an unresolvable guarded import as a runtime import and bundles an
  installed one; Node resolves it unchanged; and the specifier stays a literal, which the M70e audit
  and every Node bundler need. The rule covers every bare dynamic import, not a hand-kept list of
  "Worker-relevant" ones: whether a package reaches a Worker is the application's choice, and a list
  would be the drift this milestone exists to remove. Vite needs nothing: the full-stack server
  build externalises every `@setu-ts/*` package, so their imports never pass through Rollup (§1).
- **Rejected:** a `#peer/…` package `imports` map with a `workerd` condition (measured to work, but
  it REMOVES capability on Workers — `graphql`, `@connectrpc/connect`, `react-router`, and
  `drizzle-orm` over D1 run there, and a stub would refuse them); a computed specifier (hides the
  dependency from every bundler, including Node users who bundle); subpath exports per backend (a
  breaking public-API change for the same result).
- **Test home:** `test/unit/npm-specifier-audit.test.ts` (rule); the bundle leg (§3.4) and the e2e
  (§3.5) prove the effect.

### 3.2 The source gate

- **Decision:** `scripts/npm-specifier-audit.ts` gains `findUnguardedImports(source)`, built on the
  TypeScript compiler API (already a tooling dependency), and the walker visits `.tsx` as well as
  `.ts`. For each `CallExpression` whose callee is `ImportKeyword` and whose first argument is a
  string literal naming a bare package other than `node:*` and `@setu-ts/*`: the call is guarded
  only when it is the operand of an `AwaitExpression` (skipping parentheses and type assertions) and
  the walk from that `await` to the first function-like node passes through the `tryBlock` of a
  `TryStatement`. A `catch` block and a `.catch()` chain are NOT accepted although esbuild accepts
  both (§3.1 has one shape). Correction at implementation: the first version of this decision
  omitted the `await` condition and walked from the call itself, which admitted an unawaited
  variable initializer that esbuild refuses; the shipped gate uses the rule above.
  `auditPackageSources` reports unguarded sites in a new `unguarded` field, the gate fails when it
  is non-empty, and the existing vacuity guards (`filesVisited`, `srcRootsVisited`) apply. It runs
  wherever the audit already runs (every suite run, `release:verify` check 6), so there is no new
  command.
- **Why:** the regex scanner cannot see lexical nesting; the AST can, and it is the decision esbuild
  itself makes. The gate catches the defect at the source line, where the bundle leg (§3.4) can only
  say "something does not build".
- **Test home:** `test/unit/npm-specifier-audit.test.ts`: an awaited import passes in each measured
  position; an unawaited one (initializer, `return`, `Promise.all`, array, object property), a bare
  one, an enclosing-function `try`, `finally`, `catch`-block and `.catch()`-chain each refused;
  `node:` and `@setu-ts/*` exempt; a type-position `typeof import('x')` ignored; plus the real-tree
  audit asserting zero unguarded sites.

### 3.3 One error class for an unavailable optional dependency

- **Decision:** `@setu-ts/common` exports `OptionalDependencyUnavailableError extends Error` with
  `readonly dependency: string`, `name = 'OptionalDependencyUnavailableError'`, and the original
  rejection as `cause`. Message:
  `Optional dependency '<name>' could not be loaded. Install it in the application, or choose an option that does not need it on this runtime.`
- **Why:** inside a `try`, ESLint's `no-useless-catch` forbids a bare rethrow, so each `catch` must
  say something, and ~50 hand-written messages would violate §11.1. A class in `common` is the only
  place 19 packages can share it (§2.2). It is a pure, zero-dependency error type, like
  `DuplicateKeyError` beside it. Not branded with an HTTP status hint: it is a startup/configuration
  fault, and every site runs at `register()` or first use, not inside a request a responder would
  answer.
- **Approval:** a new `common` export needs explicit maintainer approval (AI_GUIDELINES §10.2),
  recorded in the PR description.
- **Test home:** `packages/common/test/unit/optional-dependency-error.test.ts`; barrel-exports test.

### 3.4 A Workers bundle leg in `check:node-build`

- **Decision:** after the existing `npm install` of every packed member into `.tmp/node-boot`, the
  gate writes an entry module that imports every published member's barrel (the `cli` and `create`
  executables excluded — they are not libraries) and bundles it with the repository's esbuild JS API
  using wrangler's resolution: `format: 'esm'`, `platform: 'neutral'`,
  `conditions: ['workerd', 'worker', 'browser']`, `mainFields: ['browser', 'module', 'main']`,
  `external: ['node:*', 'cloudflare:*']`. It must succeed. The entry and the option set are produced
  by a pure function in `scripts/node-build-gate.ts` so they are unit-tested.
- **Why:** it is a Worker author's exact situation — published tarballs, a plain `npm install`, no
  optional peers — and it runs in CI already, with no new service and no new dependency (esbuild is
  a root dev dependency). It sees what the source gate cannot: an unguarded import entering through
  a path the audit does not scan, or a regular dependency that does not resolve for `workerd`. Its
  first run is itself a measurement — anything further it finds is a V9-1 instance, fixed here.
- **Test home:** `test/unit/node-build-gate.test.ts` (entry and options); the gate run itself in CI,
  with a negative control (§6).

### 3.5 Build and boot the CLI's own Workers templates

- **Decision:** a new `packages/cli/test/e2e/workers-bundle-e2e.test.ts` scaffolds each Workers
  template (`rest`, `microservice`, `class-based`, `full-stack`) against the registry overlay (the
  M111d mechanism every Node e2e uses), installs it, and runs
  `npx wrangler deploy --dry-run --outdir` — which, for `full-stack`, runs the project's build
  through the §3.10 `[build]` stanza. Two projects are booted under `wrangler dev`:
  - `rest`, with `setu add database` and `setu add cloudflare` applied and a route behind
    `cacheApiMiddleware`: `/` and `/health` answer 200, and the cached route answers its full body
    on a second request with `X-Cache-Api: HIT` (V9-1's CLI reproduction plus V9-23);
  - `full-stack`, pristine: `/` answers SSR HTML, `/health` reports `up`, and the client entry chunk
    under `/assets/` answers 200 `text/javascript` (§3.10).

  Guarded like `workers-install-e2e`: skips without `npm` off CI, fails on CI.

- **Why:** V9-1 reached users through these templates, and §3.4 bundles packages, not projects — the
  generated entry, Vite's server build and `wrangler.toml` are only exercised here. V9-23 and the
  full-stack startup failures are properties of real workerd; no fake can show them.
- **Test home:** that file.

### 3.6 The cache write never depends on a sink that is not there

- **Decision:** `cloudflare-plugin` records, in a module-private `WeakSet` in
  `background/wait-until.ts`, each `BindingRegistry` built with no `waitUntil` host. `store()` in
  `cacheApiMiddleware` hands the write to `bindings.waitUntil` only when the resolved bindings are
  NOT in that set; otherwise it awaits `put` exactly as the no-plugin branch already does (one
  shared await-and-report path). A bindings object from a replacement provider (`override: true`) is
  not in the set and is trusted to have a sink — its contract, not ours.
- **Why:** this is the library half of V9-23, and it makes the cache correct for EVERY existing
  project, including those scaffolded before §3.8, at the cost of the write delaying the response
  only when the application gave no sink. No public surface changes; the marker is internal to the
  package that both writes and reads it.
- **Test home:** `packages/cloudflare-plugin/test/unit/cache-api/cache-api-middleware.test.ts`.

### 3.7 Warn when `waitUntil` is missing on Workers

- **Decision:** `CloudflarePlugin.register()` logs one `warn` when `ctx.runtime.platform()` is
  `'cloudflare-workers'` and `options.waitUntil` is absent, naming the consequence (work passed to
  `bindings.waitUntil()` may be cut off when the response is sent) and the remedy
  (`import { waitUntil } from 'cloudflare:workers'` in the Worker entry, passed through the
  factory). Off Workers, nothing is logged — running the promise to completion is correct there
  (`wait-until.ts:45-50`).
- **Why:** §3.6 fixes the cache, but `bindings.waitUntil()` is public and an application's own
  background work still needs a sink. Refusing to start was rejected: the documented
  `CloudflarePlugin({ env })` registration must keep booting.
- **Test home:** `packages/cloudflare-plugin/test/unit/plugin/cloudflare-plugin.test.ts`.

### 3.8 The generated Workers project always threads `waitUntil`

- **Decision:** on the `cloudflare-workers` target, every generated factory takes `waitUntil?` as
  its SECOND parameter — the plugin-list factory becomes `(env = {}, waitUntil?, _devtool?)`, and
  the starter-composed factory `(env?, waitUntil?, _devtool?, ssr?)` — and the entry always imports
  `waitUntil` from `cloudflare:workers` and passes it. `consumesWaitUntil` and the `wantsWaitUntil`
  branches are deleted. The parameter is underscore-prefixed where nothing in the factory reads it,
  so a project that never registers `CloudflarePlugin` passes its own lint. Off Workers, the
  signatures are unchanged. `setu add cloudflare` on a Workers project prints
  `CloudflarePlugin({ env, ...(waitUntil ? { waitUntil } : {}) })` (the microservice form, which
  `setu commands`'s argument-less call requires under `exactOptionalPropertyTypes`), followed by one
  line pointing a pre-0.10 project to the `docs/upgrading.md` entry for adding the parameter.
- **Why:** this is the CLI half of V9-23 — the scaffold offered no working channel, and the
  `cloudflare:workers` import cannot live in `setu.config.ts` (`setu` loads it). Printing the remedy
  rather than detecting the old signature avoids another text classifier over `setu.config.ts` (the
  M101g lesson).
- **Test home:** `packages/cli/test/unit/templates/project-files.test.ts`,
  `packages/cli/test/unit/commands/add.test.ts`, and the §3.5 e2e.

### 3.9 V9-4

- **Decision:** documentation only — the two README sites state that an unmatched trigger fails the
  invocation, and a logger adds a structured warning naming the registered expressions.
- **Why:** the ROADMAP row and the register both classify the behaviour as right; the existing
  `workers-cron` tests already pin the throw.
- **Test home:** existing `packages/cloudflare-plugin/test/unit/cron/workers-cron.test.ts`
  (unchanged).

### 3.10 The full-stack Workers template starts and hydrates

- **Decision:** three changes, each the cause of one measured failure (§1, "Full-stack Workers
  probe").
  1. **The server build arrives as a module.** `ReactRouterPluginOptions` gains
     `serverBuild?: unknown` (the namespace of the app's compiled server build). Exactly one of
     `serverBuildPath` and `serverBuild` is supplied, expressed as a union so supplying neither or
     both is a compile error (the M30/M50 discriminated-union precedent). The default loader uses
     `serverBuild` directly instead of `import(serverBuildPath)`; every other step — the
     `default`-unwrap, the `react-router` import, `createRequestHandler`, the
     `RouterContextProvider` factory — is the existing single implementation in `server-build.ts`.
     `loadRequestHandler` keeps its signature and is passed `serverBuildPath ?? '<serverBuild>'`.
     The union makes `ReactRouterPluginOptions` a `type` alias rather than an `interface`; nothing
     in the repository extends it, and its one other consumer, the CLI's generated
     `Pick<ReactRouterPluginOptions, …>`, stays valid because both arms declare every key. On
     Workers, the generated `src/index.ts` adds
     `import * as serverBuild from '../build/server/index.js'` and passes `{ serverBuild }` as the
     factory's `ssr` argument (whose type widens to include `serverBuild`, now read on
     `cloudflare-workers` too). The generated config chooses the arm at runtime:
     `ssr?.serverBuild !== undefined ? { serverBuild: ssr.serverBuild } : { serverBuildPath: new URL('./build/server/index.js', import.meta.url).href }`.
     The entry always supplies the module, so on workerd the `new URL` branch is never evaluated;
     `setu commands` loads the config under Node WITHOUT the entry, so discovery keeps exactly
     today's `serverBuildPath` behaviour. The import lives in the entry, never in `setu.config.ts`,
     because `setu` and `tsc` load the config before any build exists.
  2. **Local variables.** On Workers, the manifest's `envVariables` render `.dev.vars` (the file
     `wrangler dev` reads) and a committed `.dev.vars.example`, from the same `envVariables` the
     other targets render into `.env`/`.env.example`; `.gitignore` adds `.dev.vars`. The generated
     README's Workers section names `npx wrangler secret put SESSION_SECRET` for deployment. The dev
     value is the existing fixed, labelled-insecure string (the M67 precedent).
  3. **Static assets and the build.** The full-stack Workers `wrangler.toml` gains
     `[assets] directory = "./build/client"` and `[build] command = "npm run build"`, so
     `wrangler dev`/`deploy` build the client and server before bundling the Worker — the static
     import in (1) cannot resolve until the server build exists.
- **Why:** each is required for the template to serve, and V9-1's own record says the template
  "fails `npx wrangler dev` from a pristine scaffold"; closing only the build would leave it
  answering 503. A plugin option is chosen over generated code that calls `createRequestHandler`
  itself through `loadRequestHandler`: the generated route would duplicate the plugin's
  React-Router-8 export checks and its one-module invariant (`interfaces/index.ts:66-75`), which is
  the second-implementation defect class.
- **Approval:** a new public option on `ReactRouterPluginOptions` needs explicit maintainer approval
  (AI_GUIDELINES §10.2).
- **Test home:** `packages/react-router-plugin/test/unit/server-build.test.ts` (module path: the
  same handler and provider as the path form, driven under both); a type-level test that neither /
  both is refused; `packages/cli/test/unit/templates/project-files.test.ts` (entry import, config,
  `.dev.vars`, `.dev.vars.example`, `.gitignore`, `wrangler.toml`); the §3.5 e2e.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** `ReactRouterPluginOptions` changes from an `interface` to a union
`type` (§3.10), so an application that `extends` it or merges a declaration into it stops compiling;
a caller passing `serverBuildPath` is unaffected. Ships in minor `0.10.0`. Behavioural changes,
CHANGELOG'd under `Changed` and shipping in minor `0.10.0`: a missing optional dependency now
rejects with `OptionalDependencyUnavailableError` (the original error as `cause`) instead of the
runtime's raw error; a newly scaffolded Workers project's factory takes `waitUntil` as its second
parameter, and a full-stack Workers project passes its server build from the entry.

| Exported symbol                                                         | Kind   | Consumer / real code path that READS it                                                                                                                          |
| ----------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OptionalDependencyUnavailableError` (`@setu-ts/common`)                | class  | Thrown by every converted loader `catch` (18 packages and `cli`); read by the named-error wrappers in grpc, auth (SAML), graphql, feature-flags through `cause`. |
| `ReactRouterPluginOptions.serverBuild` (`@setu-ts/react-router-plugin`) | option | The default loader in `server-build.ts`; supplied by the generated full-stack Workers entry (§3.10).                                                             |

No other barrel changes. The §3.6 marker and the §3.4 gate helpers are not exported from any
`src/index.ts`.

### 4.1 Options — every option names its consumer

| Option                                         | Consumer                                              | Behavior (per implementation)                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CloudflarePluginOptions.waitUntil` (existing) | `resolveWaitUntil`; the §3.6 marker; the §3.7 warning | Present: delegated to, cache writes ride it. Absent: cache writes are awaited (§3.6); on Workers one startup warning (§3.7).                         |
| `ReactRouterPluginOptions.serverBuild` (new)   | `server-build.ts` default loader                      | Used as the server build instead of importing `serverBuildPath`; mutually exclusive with it at the type level. Passed through the starter unchanged. |

## 5. Implementation files

| File                                                                                                                                                                                                                                               | Purpose                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/common/src/errors/optional-dependency.ts`                                                                                                                                                                                                | `OptionalDependencyUnavailableError` (§3.3)                                                          |
| `packages/common/src/index.ts`                                                                                                                                                                                                                     | Barrel export                                                                                        |
| The bare `import()` sites in §1 that the §3.2 gate reports                                                                                                                                                                                         | Convert to the §3.1 shape                                                                            |
| `scripts/npm-specifier-audit.ts`                                                                                                                                                                                                                   | `findUnguardedImports`, `unguarded` in `AuditResult`, `.tsx` walk (§3.2)                             |
| `scripts/node-build-gate.ts`                                                                                                                                                                                                                       | Pure Workers-bundle entry and esbuild options (§3.4)                                                 |
| `scripts/check-node-build.ts`                                                                                                                                                                                                                      | Runs the bundle leg                                                                                  |
| `packages/cloudflare-plugin/src/background/wait-until.ts`                                                                                                                                                                                          | Hostless marker (§3.6)                                                                               |
| `packages/cloudflare-plugin/src/cache-api/cache-api-middleware.ts`                                                                                                                                                                                 | `store()` consults the marker (§3.6)                                                                 |
| `packages/cloudflare-plugin/src/plugin/cloudflare-plugin.ts`                                                                                                                                                                                       | Records the marker; the §3.7 warning                                                                 |
| `packages/react-router-plugin/src/interfaces/index.ts`, `src/handler/server-build.ts`                                                                                                                                                              | `serverBuild` option and its use in the default loader (§3.10)                                       |
| `packages/cli/src/templates/project-files.ts`, `full-stack.ts`                                                                                                                                                                                     | `waitUntil` threading (§3.8); full-stack Workers entry, config, `.dev.vars`, `wrangler.toml` (§3.10) |
| `packages/cli/src/commands/add.ts`                                                                                                                                                                                                                 | Workers guidance for `cloudflare-plugin` (§3.8)                                                      |
| Docs: `AI_GUIDELINES.md`, `CLAUDE.md`, `PUBLIC_API.md`, `ROADMAP.md`, `CHANGELOG.md`, `docs/upgrading.md`, `packages/cloudflare-plugin/README.md`, `packages/react-router-plugin/README.md`, `packages/cli/README.md`, `packages/common/README.md` | §2 deliverables, the two new public symbols, the upgrade steps                                       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                    | src covered                                                     | Key assertions                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/optional-dependency-error.test.ts`                                | `errors/optional-dependency.ts`                                 | `dependency`, `name`, `cause` identity, message names the dependency; `instanceof Error`.                                                                                                                                                                                                               |
| `packages/common/test/unit/barrel-exports.test.ts` (extend)                                  | `index.ts`                                                      | The class is exported from the barrel.                                                                                                                                                                                                                                                                  |
| Each converted package's existing loader test file (extend)                                  | the converted loader files                                      | With `vi.doMock('<peer>', () => { throw … })` the loader rejects with `OptionalDependencyUnavailableError` (or the package's named error) whose `dependency`/`cause` is set; the installed path still loads (existing tests).                                                                           |
| `test/unit/npm-specifier-audit.test.ts` (extend)                                             | `scripts/npm-specifier-audit.ts`                                | §3.2 cases; the real tree has zero unguarded sites and the vacuity guards hold.                                                                                                                                                                                                                         |
| `test/unit/node-build-gate.test.ts` (extend)                                                 | `scripts/node-build-gate.ts`                                    | The entry imports every published library member and excludes `cli`/`create`; the options carry the workerd conditions and the two externals.                                                                                                                                                           |
| `packages/cloudflare-plugin/test/unit/cache-api/cache-api-middleware.test.ts` (extend)       | `cache-api/cache-api-middleware.ts`, `background/wait-until.ts` | Plugin registered without a host: `store` awaits `put` (a never-settling `put` holds the middleware); with a host: handed to it and not awaited; replacement bindings: handed to them.                                                                                                                  |
| `packages/cloudflare-plugin/test/unit/plugin/cloudflare-plugin.test.ts` (extend)             | `plugin/cloudflare-plugin.ts`                                   | One warn on `cloudflare-workers` without `waitUntil`; none with it; none off Workers.                                                                                                                                                                                                                   |
| `packages/react-router-plugin/test/unit/server-build.test.ts` (extend) and a type-level case | `handler/server-build.ts`, `interfaces/index.ts`                | `serverBuild` and `serverBuildPath` produce the same handler and context provider for the same build; a `default`-export module is unwrapped; neither/both is a compile error (`@ts-expect-error`).                                                                                                     |
| `packages/cli/test/unit/templates/project-files.test.ts` (extend)                            | `templates/project-files.ts`, `templates/full-stack.ts`         | Every Workers factory declares `waitUntil?` second and its entry imports and passes it; full-stack Workers entry imports the server build and passes `{ serverBuild }`; `.dev.vars`/`.dev.vars.example`/`.gitignore`/`wrangler.toml` contents; socket targets unchanged against the committed baseline. |
| `packages/cli/test/unit/commands/add.test.ts` (extend)                                       | `commands/add.ts`                                               | A Workers project prints the spread form and the upgrade pointer.                                                                                                                                                                                                                                       |
| `packages/cli/test/e2e/workers-bundle-e2e.test.ts` (new)                                     | (e2e)                                                           | §3.5.                                                                                                                                                                                                                                                                                                   |

**Negative controls, each observed failing then reverted:** (1) unguard one database loader → the
audit names the file and line, the §3.4 leg fails with `Could not resolve`, and the e2e's `rest`
build fails; (2) move one guard into the caller's function → the audit refuses it (the same-function
rule is the one enforced); (3) revert §3.6 → the e2e's second cached request answers an empty body;
(4) revert §3.8 for `rest` → the printed `setu add cloudflare` line no longer type-checks in the
generated project; (5) revert each of the three §3.10 changes in turn → the full-stack boot fails
with the matching §1 symptom (`Invalid URL string`, `SESSION_SECRET is not set`, asset 404).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m113d-workers-builds-edge-cache
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test
pnpm run test:deno-lane
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% branch/function/line every changed src file
pnpm run check:node-build --require-all
pnpm run release:publish --dry-run
pnpm run release:verify 0.9.0
```

## 8. Risks & mitigations

- **A wrangler release changes esbuild's tolerance** → the rule is esbuild's long-standing try/catch
  behaviour, measured on esbuild 0.28.2 and on the esbuild inside wrangler 4.114 and 4.148; the §3.5
  e2e uses the template's pinned wrangler, and the weekly dependency-drift job runs the CLI e2e.
- **The bundle leg (§3.4) or the e2e finds a defect beyond the three known full-stack ones** → it is
  recorded in this plan and fixed here if it blocks a template from serving; otherwise filed as a
  register row.
- **`vi.doMock` does not intercept an import made inside a `src` module** → each loader gets an
  internal importer seam instead (the grpc `DEFAULT_IMPORTERS` precedent); the installed path is
  still tested.
- **`[build] command` runs the frontend build on every `wrangler dev` start** → acceptable for a
  scaffold (seconds, measured at ~0.2 s for this template); the README notes it.
- **`[assets]` is served before the Worker runs** (wrangler's default), so a client file shadows an
  application route of the same path → the client build emits only under `/assets/` plus a manifest;
  documented in the README.
- **The awaited cache write (§3.6) adds latency for applications without a sink** → bounded by
  `Cache.put`, documented, and removed by passing `waitUntil`, which §3.7 tells the operator to do.

## 9. Out of scope

- Making ioredis, amqplib, kafkajs, nats, mongodb or the gRPC-based Google clients work on Workers —
  they need sockets or HTTP/2 the platform does not offer; they now fail at `register()` with a
  named error rather than at build time.
- Rewriting `setu.config.ts` or `src/index.ts` in existing Workers projects (the CLI does not edit a
  developer-owned file; `docs/upgrading.md` carries the steps).
- A per-package "runs on Workers" matrix — documentation drift, M113l.

## 10. Design security review (recorded after implementation, before the audit)

The plan did not schedule an audit. Verification showed the diff crossing two trust boundaries the
plan did not review: the generated project now writes a local secrets file and publishes a directory
to the open internet, and the edge-cache path now logs request data for hostless applications. This
review is recorded after implementation (the M101a/M98h precedent), so it is not presented as having
guided the design; it fixes what the committed-tree audit must hold the code to.

**Flows reviewed.**

1. A request to a Worker that reaches `cacheApiMiddleware` with `CloudflarePlugin` registered and no
   `waitUntil` host: the cache key is built from the request URL, tenant and locale, the write is
   awaited on the response path, and a failed write is logged.
2. The generated `full-stack` Workers project's local and deployed secrets: `.dev.vars` (a fixed,
   published development `SESSION_SECRET`), `.dev.vars.example`, `.gitignore`, and
   `npx wrangler secret put` for production.
3. The generated `[assets] directory = "./build/client"`: every file the client build writes is
   served before the Worker runs, so framework middleware never sees those requests.
4. The generated `[build] command = "npm run build"`, run by `wrangler dev` and `wrangler deploy`.
5. A missing optional dependency, now rejected with `OptionalDependencyUnavailableError` (the
   original rejection as `cause`), on the paths where a loader runs during a request.
6. The `check:node-build` bundle leg: a temporary directory, a `node_modules` symlink, a generated
   entry, and its removal.

**Assets.** The production `SESSION_SECRET` (it signs and encrypts session cookies); server-only
code and configuration (`setu.config.ts`, `.server.ts` modules, `build/server`, `.dev.vars`);
request data that can carry credentials (query strings, the tenant id); the availability of a
Worker's request path; the integrity of edge-cache entries.

**Attackers.**

- An internet client of a deployed Worker: chooses paths, query strings and headers, and can request
  any path the asset directory might hold.
- Anyone who has read this repository or a scaffolded project: knows the development
  `SESSION_SECRET` value, since it is a published constant.
- An operator mistake: deploying without `wrangler secret put SESSION_SECRET`, placing a private
  file in `public/`, committing `.dev.vars` with a real value.
- A reader of the application's logs who should not see end-user request data.

**Approved budgets.** None new. The hostless await adds the duration of `Cache.put` to the response
of a cache MISS, only when the application passes no `waitUntil` host; with a host nothing is added.

**Obligations for the committed-tree audit.** Each is driven against a scaffolded project or a
kernel application this run starts locally, with a positive control.

1. **The development secret never reaches a deployment.** The `wrangler deploy --dry-run` output
   contains no part of the `.dev.vars` value, and the generated `wrangler.toml` declares no `[vars]`
   entry for it. With `.dev.vars` removed and no secret set, a full-stack Worker fails closed: `/`
   answers 503 from the boot failure and no response carries `Set-Cookie`. Positive control: with
   `.dev.vars` present, `/login` sets a session cookie.
2. **`.dev.vars` is ignored by Git** in a scaffolded project (`git check-ignore .dev.vars` succeeds)
   and `.dev.vars.example` is not.
3. **The asset directory holds only client output.** After `react-router build`, plant a canary
   string in a `.server.ts` module and in `setu.config.ts`, rebuild, and show the canary in no file
   under `build/client`. Under `wrangler dev`, `/.dev.vars`, `/setu.config.ts`,
   `/build/server/index.js`, `/wrangler.toml`, `/src/index.ts` and an encoded `..` path do not
   return those files' contents. Positive control: a hashed asset under `/assets/` answers 200.
4. **The asset bypass is stated where a developer reads it.** A request served from `[assets]` does
   not pass through the application's middleware (security headers, authentication); the generated
   `wrangler.toml` comment and the full-stack README say so. Observe an asset response under
   `wrangler dev` without the headers `HttpSecurityPlugin` adds to an application route, so the
   statement describes measured behaviour.
5. **A failed edge-cache write logs no query string, fragment or tenant id.** Drive a write failure
   with a URL carrying `?token=canary` under a tenant and show the canary absent from every log
   record. Positive control: the record still names the failing route's path.
6. **A missing optional dependency is opaque to a client.** Make one loader that runs during a
   request fail, and show the response body names neither the package nor the remedy text under the
   default `errorHandler` and under no `errorHandler`. Positive control: the log record carries
   both.
7. **The bundle leg touches only its own directory.** It creates its directory with `mkdtemp`,
   removes only that path, and writes package names only into a generated entry file, never into a
   command line.

**Findings.**

| #   | Finding                                                                                                                                                                                                                                                                                                        | Disposition                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The edge-cache write-failure log carries the full cache key: the request URL with its query string, plus the tenant id and locale. Pre-existing on the no-plugin path since M52b; this milestone routes hostless `CloudflarePlugin` applications to it, where before their failure was logged without the key. | Fixed in `91707435`: the record names `ctx.request.path`, on both branches (obligation 5)                                                                 |
| D2  | `[assets]` serves the client build before the Worker, so security headers and authentication middleware do not apply to those files. Correct for public bundles, and stated nowhere.                                                                                                                           | Fixed in `9f57acd6`: stated in the generated `wrangler.toml` comment and README (obligation 4)                                                            |
| D3  | `.dev.vars` carries a published constant as `SESSION_SECRET`.                                                                                                                                                                                                                                                  | Accepted, the M67 precedent: the value is labelled insecure, the file is ignored by Git, and a deployment without a secret fails closed (obligations 1–2) |
| D4  | The hostless await holds the response for as long as `Cache.put` takes; a custom `ICacheApi` that never settles holds it forever.                                                                                                                                                                              | Accepted: identical to the no-plugin path since M52b, and `Cache.put` on Workers is platform storage; `waitUntil` removes the wait                        |
| D5  | `.vite/manifest.json` was assumed public under `[assets]`.                                                                                                                                                                                                                                                     | Withdrawn: the audit found this template's client build emits no manifest, and the generated `wrangler.toml` comment no longer names one                  |
| D6  | The `react-router` health indicator reports `serverBuildPath`, an absolute file URL, on the socket targets.                                                                                                                                                                                                    | Pre-existing since M44, not changed here (Workers reports `'<serverBuild>'`); out of scope, noted for M113f                                               |

**Committed-tree audit.** One fresh-context round, on `06f8ce76`, verdict failed on one Low finding.

| #   | Finding                                                                                                                                                                                                                                                                 | Resolution                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | The write-failure record copies the cache rejection's message verbatim, so a custom `ICacheApi` whose rejection quotes its key carries the query string and tenant back into the log. With a `waitUntil` host the same message reached the generic background reporter. | Fixed in `8788a905`: every write path catches its own rejection before awaiting it or handing it to `waitUntil`, and reports the error class only; the generic reporter keeps its behaviour for an application's own tasks. Not re-audited, at the maintainer's direction (Low). |
