# Milestone 70e — Default branches of injectable seams (`@setu-ts/sdk`, `@setu-ts/grpc-plugin`, `@setu-ts/telemetry-plugin`)

> **Status:** Planning. Branch: `feat/m70e-seam-defaults`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Three packages offer an injection seam so tests can supply a fake, and because **every** test
injects, the `?? <the real thing>` fallback is the one line no suite runs. Two published defects sit
on exactly that line. `@setu-ts/sdk` stores the global `fetch` on a private field and calls it as
`this.#fetch(...)`, so in a browser — the first environment its own README names — the receiver is
the `HttpClient` instance and every request throws `Illegal invocation` (X11-1). `grpc-plugin` and
`telemetry-plugin` route their lazy `npm:` specifiers through a variable rather than passing them as
literals to `import()`, and JSR's npm-compatibility rewrite is **static** — it reaches only a
literal — so the `npm:` string ships verbatim and the plugin cannot load on Node or Bun at all,
which also leaves M24b's auto-instrumentation enabled on no runtime (X7-3). This milestone fixes
both, and adds the gate that makes the shape non-recurring: a source scanner that refuses a computed
`import()` specifier without a stated reason.

The register's general prescription is the milestone's method: **construct the default and drive it
once**, as `packages/runtime/test/integration/read-stream-real.test.ts` already does for
`IFileSystem.readStream` and as nothing does for `fetch` or for the two lazy loaders.

- **In scope:** X11-1 (`sdk` fetch receiver) and X7-3 (`grpc-plugin` + `telemetry-plugin` `npm:`
  literals, and the install-command text that tells a Bun user to run a Deno command). The default
  path of each of those seams driven by a test that fails without the fix. A recurrence gate
  (`scripts/npm-specifier-audit.ts`) wired into a repo-wide audit test and into
  `deno task release:verify`. Surfacing `InstrumentationOutcome[]`, which today is built and read by
  nothing, through `ctx.logger` — without it a loader failure stays as silent after this milestone
  as before it. Doc corrections C1–C5 and the C7 ROADMAP reassignment in the same PR.
- **NOT this milestone:** the rest of `grpc-plugin`'s viability — X7-1 (documented registration
  snippets throw), X7-2 (default `basePath` unreachable by a native client) and X7-4 (native
  gRPC-binary works on no runtime it can run on) belong to **M70i**, which takes the
  repair-versus-withdraw decision. This milestone is a **prerequisite** for that decision rather
  than a competitor to it: repair-versus-withdraw cannot be judged on Node or Bun while the package
  cannot load there. The remaining `sdk` rows (X11-3 through X11-9) are **M70m**'s; X11-2 (the
  kernel's fallback 500) is **M70f**'s; X2-6 is **M70n**'s.

## 1. Contracts verified from SOURCE (not names)

Every row was opened and read. Where a claim concerns a **published artifact** rather than source,
the artifact under `compat/node_modules/` was read directly — that tree holds real JSR npm-compat
builds and is the only place in the repository where the rewrite's output is observable.

| Reference                                    | Source (file:line)                                                                                                  | Verified surface / fact                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HttpClient` fetch capture                   | `packages/sdk/src/http/http-client.ts:115`                                                                          | `this.#fetch = options.fetch ?? fetch` — the global is stored bare, with no binding                                                                                                                                                                                      |
| `HttpClient` fetch call site                 | `packages/sdk/src/http/http-client.ts:231`                                                                          | `await this.#fetch(url.toString(), fetchInit)` — the receiver is the `HttpClient` instance                                                                                                                                                                               |
| `ClientOptions.fetch`                        | `packages/sdk/src/http/contracts.ts` (`fetch?:`)                                                                    | `(input: RequestInfo, init?: RequestInit) => Promise<Response>` — a plain function type, no receiver requirement, which is why an injected fake never reproduces the fault                                                                                               |
| `createClient` timing default                | `packages/sdk/src/sdk.ts:30`                                                                                        | `options.timing ?? createDefaultClientTiming()`; the default uses `performance.now()` and a bare `setTimeout(...)` — a member access and a bare call, so **neither loses its receiver**                                                                                  |
| `HttpClient.request` path rule               | `packages/sdk/src/http/http-client.ts:132`                                                                          | throws `ClientRequest.path must be relative (no leading slash).` — relevant to C1                                                                                                                                                                                        |
| grpc specifier map                           | `packages/grpc-plugin/src/transports/connect-loader.ts:28-32`                                                       | `SPECIFIERS` holds four `npm:` strings; two are **subpaths** (`…/protocol`, `…/wkt`)                                                                                                                                                                                     |
| grpc import site                             | `packages/grpc-plugin/src/transports/connect-loader.ts:147,164`                                                     | `defaultImporter = (specifier) => import(specifier)` and `loaded[key] = await importer(SPECIFIERS[key])` — the `import()` argument is a parameter, never a literal                                                                                                       |
| grpc install text                            | `packages/grpc-plugin/src/transports/connect-loader.ts:35-40`                                                       | `INSTALL_COMMANDS` hardcodes `deno add …` for all four keys, on every runtime                                                                                                                                                                                            |
| grpc loader consumer                         | `packages/grpc-plugin/src/plugin/grpc-plugin.ts:40`                                                                 | `options.connectModule ?? await loadConnectModule()` — the only production call, with no arguments, so the injected-importer path never runs outside tests                                                                                                               |
| grpc barrel                                  | `packages/grpc-plugin/src/index.ts:46-47`                                                                           | exports **only** `adaptConnectModule` and `ConnectModuleLike` from the loader module; `loadConnectModule`, `ModuleImporter` and `defaultImporter` are **internal**, so reshaping their signatures is not a public-API change                                             |
| telemetry instrumentation import sites       | `http-instrumentation.ts:18,49,83`, `database-instrumentation.ts:11,39`, `queue-instrumentation.ts:12,40,71`        | five loaders, each `await importFn('npm:…')` where `importFn` defaults to `(spec) => import(spec)` — the literal is passed to the **seam**, never to `import()`                                                                                                          |
| telemetry loader consumers                   | `packages/telemetry-plugin/src/instrumentation/instrumentation-registry.ts:161-186`                                 | the registry calls `loader(configArg)` with **one** argument, so `importFn` is only ever its default in production                                                                                                                                                       |
| telemetry barrel                             | `packages/telemetry-plugin/src/index.ts`                                                                            | exports **nothing** from `src/instrumentation/` — all five loaders and the registry are internal                                                                                                                                                                         |
| `InstrumentationOutcome[]`                   | `instrumentation-registry.ts:31-33`, `telemetry-plugin.ts:96`                                                       | `InstrumentationHandle.outcomes` is populated on every branch and the plugin reads only `.shutdown()`; `grep` finds no other reader — dead surface, and the reason a load failure is invisible                                                                           |
| node-only instrumentation gate               | `instrumentation-registry.ts:36-42`                                                                                 | `isInstrumentationSupported` returns `platform === 'node'` for every kind — so Deno is gated off by design and Node was failing to load, which is the register's "enabled on no runtime"                                                                                 |
| `IPluginContext.logger`                      | `packages/common/src/plugin.ts` (`logger`)                                                                          | present on the plugin context — the correct sink, unlike `IRequestContext`, which has no `logger` member (the M51 defect)                                                                                                                                                |
| **Published** grpc artifact                  | `compat/node_modules/@jsr/setu-ts__grpc-plugin/src/transports/connect-loader.js:74`                                 | ships `export const defaultImporter = (specifier)=>import(specifier)` and `npm:@connectrpc/connect@^2.1.2` **intact** — the defect confirmed first-hand, not inferred                                                                                                    |
| **Published** telemetry artifact             | `compat/node_modules/@jsr/setu-ts__telemetry-plugin/src/instrumentation/*.js`                                       | all three files ship `const defaultImport = (spec)=>import(spec)` — same shape                                                                                                                                                                                           |
| **Published** control (literal is rewritten) | `…__logger-plugin/src/loggers/pino-logger.js`, `…__queue-plugin/src/adapters/redis-queue.js`                        | `import("pino")` and `import("ioredis")` — a literal `import('npm:pino@10.x')` **is** rewritten. This asymmetry is the mechanism, measured in one tree                                                                                                                   |
| **Published** dependency consequence         | `…__logger-plugin/package.json:8`, `…__messaging-plugin/package.json:7-13`, `…__telemetry-plugin/package.json:8-11` | JSR turns every recognised `npm:` specifier into a **hard** npm dependency (`pino`, seven brokers, four `@opentelemetry` packages). See §3.9                                                                                                                             |
| **Published** grpc dependency list           | `compat/node_modules/@jsr/setu-ts__grpc-plugin/package.json:6-8`                                                    | `@jsr/setu-ts__common` **only** — because the `npm:` strings were data in a map, JSR never saw them as specifiers. §3.9 covers what changes                                                                                                                              |
| subpath reachability                         | probed against the real packages                                                                                    | `createFetchHandler` is **absent** from `@connectrpc/connect`'s root and present on `/protocol`; `FileDescriptorSetSchema` / `FileDescriptorProtoSchema` are absent from `@bufbuild/protobuf`'s root and present on `/wkt`. The two subpaths are unavoidable — see §8 R1 |
| default-path precedent                       | `packages/runtime/test/integration/read-stream-real.test.ts:1-14`                                                   | the shape this milestone copies: drive each adapter's **default** host, "rather than an injected fake … the unit tests inject a host that supplies `createReadStream`, so they pass whether or not the default host can actually produce a stream"                       |
| zero-argument-hook precedent                 | `packages/react-router-plugin/src/handler/server-build.ts:166`                                                      | `options?.rrImportHook ? await options.rrImportHook() : await import('npm:react-router@8')` — the in-repo package that already gets this right: a **zero-argument** hook beside a **literal** import                                                                     |
| `test.permissions` precedent                 | `packages/grpc-plugin/deno.json:7-10`                                                                               | a package declares its own `net: true` for real-socket tests; the root task passes `-P` (`--permission-set`) and no `--allow-net`, and per M53 a CLI `--allow-net=<list>` **replaces** a package block rather than unioning with it                                      |
| `release:verify` structure                   | `scripts/verify-release.ts:60-190`                                                                                  | five checks as straight-line top-level loops over `PUBLISHED_PACKAGES`; `leadingJsDoc` is a local helper, not exported                                                                                                                                                   |
| `SCRIPT_TARGETS`                             | `scripts/script-coverage.ts:47-55`                                                                                  | three entries; `verify-release.ts` is **absent**, so nothing enforces a coverage bar on it — which is why the new check's decidable half must be its own pure module (§3.8)                                                                                              |
| compat suite entry                           | `compat/compat.test.mjs:1-33`, `compat/package.json`                                                                | consumes the **published** packages on Node and Bun; `PENDING_FIRST_PUBLISH` is the existing pattern for "a check that cannot pass until the next release"; installed grpc/telemetry are at `0.1.0-alpha.5`                                                              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                  | Resolution (picked side)                                                                                                                                                                                                                                                                                                         | Doc deliverable (same PR)                                                                                                                                                                                                                |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md:8133` documents `createClient()` with `path: '/users/123'`. Run against the committed source it **throws** `ClientRequest.path must be relative (no leading slash).` — verified by executing the documented snippet. Not a register row; found by reading the source this milestone edits.                 | The code is right (the leading-slash rule is what makes the per-origin breaker and limiter meaningful, and `http-client.ts:126-131` says so). The example is wrong.                                                                                                                                                              | `PUBLIC_API.md` — the SDK `createClient()` example uses `path: 'users/123'`, and the surrounding prose states the rule.                                                                                                                  |
| C2 | `packages/sdk/README.md:371-376` lists browsers **first** under Portability and describes `fetch` as a testing seam — "tests inject a fake; production defaults to the global" — so a browser consumer had no reason to set the one option that made the SDK work there.                                                  | Keep the seam's testing role, but stop implying the default needs help. After §3.1 the default works in a browser unchanged.                                                                                                                                                                                                     | `packages/sdk/README.md` — Portability re-worded; the `fetch` row in both option tables says the default is bound to the global realm and needs no browser-specific value.                                                               |
| C3 | `packages/grpc-plugin/README.md` claims "Works on **Node, Deno, Bun**, and Cloudflare Workers without modification", while `connect-loader.ts:35-40` answers a Node or Bun failure with `deno add …`.                                                                                                                     | Fix the code (§3.3, §3.4). The portability claim becomes true **for module loading**, which is all this milestone settles.                                                                                                                                                                                                       | `packages/grpc-plugin/README.md` — install guidance names the three package managers; a scoped note that native gRPC-binary transport remains limited, pointing at M70i (X7-4) rather than leaving the blanket claim to imply otherwise. |
| C4 | `instrumentation-registry.ts:31-33` documents `outcomes` as "Records of what happened during registry build", and nothing reads it — a marker no code branches on, which §4's dead-surface rule forbids. Combined with "any loader failure degrades to a documented no-op and NEVER throws", a failure is unobservable.   | Wire it to a real path (§3.6) rather than delete it: the value is genuinely wanted, it simply had no consumer.                                                                                                                                                                                                                   | `PUBLIC_API.md` Telemetry section + `packages/telemetry-plugin/README.md` — document that instrumentation outcomes are reported through the plugin's logger, and that a failure remains a no-op rather than a throw.                     |
| C5 | `packages/grpc-plugin/test/unit/connect-loader.test.ts:206-210` asserts `String(defaultImporter)` contains `'import('`, titled "exposes a real dynamic import as the default importer, not a global hook". It pins the **defect's** shape: a stringified non-literal `import()` is exactly what does not survive publish. | The intent (no global hook) is right and is kept; the assertion is replaced by one that also requires the argument to be a **literal**, which is the property that matters.                                                                                                                                                      | The rewritten test is itself the deliverable; the plan records why the old assertion passed while the package was broken.                                                                                                                |
| C6 | Observation, **not** fixed here: JSR's transform makes every recognised `npm:` specifier a hard npm dependency of the published package (measured on five packages, §1), which sits in tension with AI_GUIDELINES §12.2 "must never be hard dependencies".                                                                | Out of scope — it is uniform, pre-existing and framework-wide, and §3.9 explains why this milestone's fix makes the two packages _consistent_ with it rather than introducing something new.                                                                                                                                     | Recorded in §9 for the maintainer to raise as its own item; no doc edit claimed here.                                                                                                                                                    |
| C7 | **The ROADMAP assigns X7-3 twice.** `ROADMAP.md:6951-6957` names it as M70e's row, while `ROADMAP.md:6892-6895` lists it among the three rows (X7-2, X7-3, X7-4) that feed M70i's repair-versus-withdraw decision — so as committed, two workstreams own it and neither text acknowledges the other.                      | **M70e owns X7-3.** It is a self-contained module-loading fix with a known mechanism, and it is a _precondition_ for M70i rather than an input to it: whether `grpc-plugin` is worth repairing cannot be judged on Node or Bun while it cannot load there at all. M70i keeps X7-2 and X7-4, which are genuinely about viability. | `ROADMAP.md` — the "Scope realities" bullet drops X7-3 from the M70i list and states that M70e closes it first, so the viability decision is taken against a package that loads. The M70e workstream row is unchanged.                   |

## 3. Design decisions

### 3.1 SDK default `fetch` — a late-resolving wrapper, not `bind` at capture

- **Decision:** `packages/sdk/src/http/http-client.ts:115` becomes
  `this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))`. An injected
  `fetch` is untouched.
- **Why:** both candidates fix the receiver, and the difference between them was **measured** rather
  than argued. With a receiver-checking stand-in installed: the wrapper answered `200`, and
  `fetch.bind(globalThis)` answered `200`. Then, with a second stand-in installed **after** the
  client was constructed, the wrapper picked it up (`299`) and the bound form did not (`200`). That
  matters for consumers: a module-scope client constructed at import time, with `globalThis.fetch`
  replaced later by a mocking library or a polyfill, is served by the wrapper and bypassed by
  `bind`. It is also the exact form the smoke run verified in a real browser — `x11-check.mjs`
  scores 3/7 with the shipped default and **7/7** with
  `fetch: (input, init) => globalThis.fetch(input, init)` injected — so the chosen shape is the one
  with browser evidence behind it. Reading the global at call time rather than capture time is the
  M52b lesson applied one level down.
- **Test home:** `test/unit/fetch-receiver.test.ts` (§6).

### 3.2 Proving the SDK default — a receiver-strict stand-in **and** a real socket

- **Decision:** two tests, because they prove different things. (a) A unit test installs a `fetch`
  reproducing the browser's WebIDL receiver rule — `undefined`/global receiver allowed, anything
  else throws — constructs a client with **no** `fetch` option, and asserts a successful request; it
  restores the global in `afterEach`. (b) An e2e test starts a real `Deno.serve` on an unused port
  and drives a **default** client against it, so the genuine platform `fetch` is exercised end to
  end. Both drive `createClient` rather than `new HttpClient`.
- **Why:** the stand-in is what reproduces the browser without a browser (the register's probe case
  A) and is the regression guard. It cannot, on its own, prove the default reaches a network at all
  — and the SDK's existing "e2e" test injects a fake `fetch`, so **no test in the package has ever
  made a real request**. Two of the three checks that "passed" in the smoke's default case did so
  vacuously, both being assertions phrased as absences; a real socket is the answer to that class.
- **Test home:** `test/unit/fetch-receiver.test.ts` and `test/e2e/default-transport.test.ts`.

### 3.3 grpc loader seam — a record of zero-argument importers, with the literal at each import site

- **Decision:** `SPECIFIERS` stays, used **only** for error text. The four imports become four
  literals inside a module-level record:

  ```ts
  const DEFAULT_IMPORTERS: ConnectImporters = {
    connect: () => import('npm:@connectrpc/connect@^2.1.2'),
    protocol: () => import('npm:@connectrpc/connect@^2.1.2/protocol'),
    protobuf: () => import('npm:@bufbuild/protobuf@^2.7.0'),
    wkt: () => import('npm:@bufbuild/protobuf@^2.7.0/wkt'),
  };
  ```

  `loadConnectModule(importers: Partial<ConnectImporters> = {})` merges over the defaults, so a test
  overrides one key and the other three still take the real path. `ModuleImporter` (a
  specifier-taking function) and the exported `defaultImporter` are **removed**, not deprecated.
- **Why:** the rewrite is static, so the literal has to sit at the `import()` call — a specifier
  reaching `import()` through a parameter, a constant, a map lookup, or a `(spec) => import(spec)`
  indirection is invisible to it, which is why the published artifact ships `npm:` verbatim while
  `logger-plugin`'s literal ships as `import("pino")`. A per-key record rather than one thunk keeps
  the property the current design exists for: each of the four failure branches stays independently
  drivable without uninstalling a package, so no coverage is lost. §9.2's deprecate-then-remove
  applies to _published_ surface, and `packages/grpc-plugin/src/index.ts:46-47` exports neither
  symbol, so removal is correct rather than breaking. The zero-argument-hook shape is
  `react-router-plugin`'s, which is the one package in the repository that already had this right.
- **Test home:** `test/unit/connect-loader.test.ts` (rewritten, §6) and
  `test/unit/connect-real-import.test.ts`.

### 3.4 grpc install guidance — name all three package managers, with no runtime detection

- **Decision:** `INSTALL_COMMANDS` becomes one line per specifier naming the three commands, e.g.
  `deno add npm:@connectrpc/connect@^2.1.2 · npm i @connectrpc/connect · bun add @connectrpc/connect`.
- **Why:** the row's second half is that a Bun project is told to run a Deno command. The precise
  fix would be to select on `runtime.platform()`, but `grpc-plugin`'s `register()` resolves only
  `logger` and `health` (`grpc-plugin.ts:37-47`) and does not resolve `CAPABILITIES.RUNTIME`; adding
  that resolution to reach a **string in an error message** introduces a plugin-ordering dependency
  for no behavioural gain, and `loadConnectModule` is a free function with no context at all. Naming
  all three is correct on every runtime, costs nothing, and cannot be wrong.
- **Test home:** `test/unit/connect-loader.test.ts` — the per-specifier failure assertions check the
  message names all three managers.

### 3.5 telemetry loaders — the same shape, zero-argument `importFn`

- **Decision:** each of the five loaders keeps its seam and changes its arity: `importFn` becomes
  `() => Promise<Record<string, unknown>>`, defaulting to a literal import at the call site, e.g.
  `importFn: () => Promise<Record<string, unknown>> = () => import('npm:@opentelemetry/instrumentation-http@^0.220.0')`.
  The module-level `defaultImport` helper in all three files is deleted. The returned `specifier`
  field keeps the same string, read from the existing constant so the literal and the reported name
  cannot drift.
- **Why:** identical mechanism, identical fix; the seam's purpose (unit-test the failure branch
  without uninstalling a package) is preserved by a zero-argument hook, and the registry already
  calls `loader(configArg)` with one argument (`instrumentation-registry.ts:161-186`) so no consumer
  changes. The five loaders are internal — the barrel exports nothing from `src/instrumentation/` —
  so this is not a public-API change.
- **Test home:** `test/unit/http-instrumentation.test.ts`,
  `test/unit/database-instrumentation.test.ts`, `test/unit/queue-instrumentation.test.ts`,
  `test/integration/instrumentation-real-import.test.ts`.

### 3.6 Instrumentation outcomes — reported through `ctx.logger`, still never thrown

- **Decision:** `TelemetryPlugin.register` passes a reporter into
  `buildInstrumentationRegistry(...)` and, for each returned outcome, logs one line: `debug` for an
  enabled instrumentation, `warn` for a failure, carrying `kind` and `reason`. The reporter is read
  from `ctx.logger` **at call time**, not captured at plugin construction. `outcomes` remains on the
  handle. A failure remains a no-op and is never rethrown.
- **Why:** without this, the fix is unobservable — the register's point is that a loader failure "is
  silently recorded as a no-op" and "nothing surfaces that", which stays literally true after the
  literals are fixed if the array still has no reader. It also closes C4's dead surface by wiring an
  existing value into a real path rather than deleting a value that is genuinely wanted.
  Warn-not-throw is M24b's decision and is deliberately unchanged: the documented contract is that
  auto-instrumentation degrades. Reading the logger at call time is M52b's
  `WorkersQueueOptions.logger` lesson — a logger registered imperatively after this plugin would
  otherwise be silenced.
- **Test home:** `test/unit/instrumentation-registry.test.ts` and
  `test/unit/telemetry-plugin.test.ts`.

### 3.7 The recurrence gate — every `import()` in `packages/*/src` takes a string literal, unless the site says why

- **Decision:** a pure scanner refuses any dynamic `import()` in `packages/*/src/**/*.ts` whose
  first argument is not a string literal, **unless** the call carries the in-source marker
  `/* computed-specifier: <reason> */`. Three sites are legitimately computed and each gets a marker
  naming why the specifier is an application-supplied module path rather than a package name:
  `packages/cli/src/schematics/custom.ts:32`,
  `packages/decorator-plugin/src/discovery/controller-discovery.ts:166`, and
  `packages/react-router-plugin/src/handler/server-build.ts:152` (which already carries
  `/* @vite-ignore */` inside the parentheses, so a second inline comment is a proven shape there).
- **Why:** the rule targets the **cause**, so it needs no reasoning about which strings are `npm:`
  specifiers. Two narrower formulations were considered and rejected by checking them against the
  tree. "An `npm:` literal must be the direct argument of `import()`" fires on the legitimate
  install-command text and on each loader's returned `specifier` field. "A file containing a
  non-literal `import()` must contain no `npm:` literal" is precise for `cli` and `decorator-plugin`
  (zero `npm:` occurrences each) but **false-positives on
  `react-router-plugin/src/handler/server-build.ts`**, which correctly combines a literal
  `import('npm:react-router@8')` with a computed import of the application's own build path. The
  marker convention follows §17.3's documented-exemption pattern and puts the justification at the
  site rather than in a central list that rots.
- **Test home:** `test/unit/npm-specifier-audit.test.ts` (the scanner's branches, in
  `scripts/`-adjacent root tests) and `test/npm-specifier-gate.test.ts` (the whole tree is clean).

### 3.8 Where the gate lives — a pure module, a repo-wide test, and `release:verify`

- **Decision:** the decidable half is `scripts/npm-specifier-audit.ts`, exporting
  `findComputedImports(source: string): readonly ComputedImport[]` plus a thin
  `auditPackageSources(root)` walker. It is added to `SCRIPT_TARGETS` in
  `scripts/script-coverage.ts`, so it carries the 90% bar. `test/npm-specifier-gate.test.ts` runs it
  over `packages/` on every suite run, and `scripts/verify-release.ts` gains check 6 calling the
  same function, so a release cannot ship the shape.
- **Why:** the register nominated `release:verify` as "the only gate positioned to see this, since
  the fault exists only in the published artifact" — that is right about the _artifact_ and wrong
  about the _cause_, which is visible in source and therefore catchable on every pull request rather
  than once per release. Both homes are cheap and the release check is the backstop. The module goes
  into `SCRIPT_TARGETS` because it is genuinely pure, unlike `check-apps.ts` and `check-deploy.ts`,
  which are excluded because they are mostly subprocess orchestration (M39's precedent). Nothing
  enforces coverage on `verify-release.ts` itself, which is exactly why the logic must not live
  inline there.

### 3.9 The hard-dependency consequence of fixing the literals — accepted, and uniform

- **Decision:** accept that the published `grpc-plugin` and `telemetry-plugin` npm artifacts gain
  hard `dependencies` entries (`@connectrpc/connect`, `@bufbuild/protobuf`, and the five
  `@opentelemetry/instrumentation-*` packages), and record it in the CHANGELOG entry.
- **Why:** JSR's transform derives `package.json` dependencies from the `npm:` specifiers it
  recognises — measured on five published artifacts: `logger-plugin` ships `pino`,
  `messaging-plugin` ships seven brokers, `database-plugin` ships `@prisma/client` and
  `drizzle-orm`, `telemetry-plugin` already ships four `@opentelemetry` packages. `grpc-plugin`
  currently ships `@jsr/setu-ts__common` **alone**, and that is not a virtue — it is the defect's
  own side effect, because the `npm:` strings were never seen as specifiers. So the fix makes both
  packages consistent with every other package in the framework rather than introducing a new
  property, and there is no alternative: a specifier the transform cannot see is a specifier Node
  and Bun cannot resolve. The §12.2 tension this exposes is framework-wide and pre-existing, so it
  is recorded in §9 rather than resolved here.

### 3.10 `packages/sdk/deno.json` gains a `test.permissions` block

- **Decision:** add `"test": { "permissions": { "net": true } }` to `packages/sdk/deno.json`, which
  today has no `test` block at all.
- **Why:** §3.2's e2e binds a real loopback socket, and the root task passes `-P` with no
  `--allow-net`. `packages/grpc-plugin/deno.json:7-10` is the precedent — `net: true` beside real
  socket tests. An endpoint-scoped list is not usable here because the port is chosen at run time;
  M53's reason for scoping (an ioredis retry loop hanging the runner on `ECONNREFUSED`) does not
  apply to a server this test starts itself.

### 3.11 What the compat suite can and cannot prove on this branch

- **Decision:** add a compat check that reads the installed published artifacts and asserts no
  `npm:` string survives inside an `import(` call, guarded by a **version comparison** rather than a
  bare skip: while the installed `@jsr/setu-ts__grpc-plugin` / `__telemetry-plugin` is at or below
  `0.1.0-alpha.8` the check reports `pending — fixed in 0.1.0-alpha.9, not yet published`; once a
  newer version is installed the guard lifts and a surviving `npm:` **fails**.
- **Why:** the compat suite consumes `latest` from the registry, so on this branch it necessarily
  tests alpha.8, which is broken by definition — a hard check would turn this PR red for the defect
  it fixes, the deadlock `PENDING_FIRST_PUBLISH` already exists to describe. A bare skip would be
  the false-pass this repository keeps finding in its own harnesses (M39's `--version` probe, M53's
  silent Redis skips), so the guard is tied to an observable fact that changes on its own at the
  next release. This is the check that will actually prove X7-3 fixed; the source gate (§3.7)
  prevents the shape, and only the artifact settles the rewrite.

## 4. Exported surface — every symbol names its consumer

**No package barrel changes.** `packages/{sdk,grpc-plugin,telemetry-plugin}/src/index.ts` are
untouched, so each package's existing `barrel-exports.test.ts` stays green and every `PUBLIC_API.md`
edit in §2 is a correction rather than a new entry.

| Exported symbol                     | Kind              | Consumer / real code path that READS it                                                                                                             |
| ----------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none added to any barrel)_        | —                 | The three defects are all on internal default branches; nothing new needs to be public to fix them.                                                 |
| `findComputedImports`               | function (script) | `test/npm-specifier-gate.test.ts`, `test/unit/npm-specifier-audit.test.ts`, and `scripts/verify-release.ts` check 6 — three real readers.           |
| `auditPackageSources`               | function (script) | `test/npm-specifier-gate.test.ts` and `scripts/verify-release.ts` check 6.                                                                          |
| `ComputedImport`                    | type (script)     | The return type both readers destructure (`file`, `line`, `snippet`) to build their failure messages.                                               |
| `ConnectImporters`                  | type (internal)   | `loadConnectModule`'s parameter, and `test/unit/connect-loader.test.ts` builds partial records against it. **Not** barrel-exported.                 |
| `ModuleImporter`, `defaultImporter` | **removed**       | Neither is barrel-exported (§1) and neither has a `src` consumer after §3.3; leaving them would be dead surface. C5 covers the test that read them. |

### 4.1 Options — every option names its consumer

No new option on any package. Three existing ones change shape or documentation:

| Option                                    | Consumer                                          | Behavior (per implementation)                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClientOptions.fetch` (`sdk`)             | `HttpClient` constructor → `HttpClient.request`   | Unchanged when supplied. When omitted, the default is now a wrapper that resolves `globalThis.fetch` **at call time** with the global as receiver (§3.1). Doc-only surface change (C2). |
| `GrpcPluginOptions.connectModule`         | `grpc-plugin.ts:40`                               | Unchanged. Still the primary inject path; `loadConnectModule()` is the fallback and now reaches four literal imports.                                                                   |
| `TelemetryPluginOptions.instrumentations` | `buildInstrumentationRegistry` → the five loaders | Unchanged in shape. `true` now actually loads on Node instead of recording a silent no-op, and every outcome is reported through `ctx.logger` (§3.6).                                   |

## 5. Implementation files

| File                                                                        | Purpose                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sdk/src/http/http-client.ts`                                      | X11-1: the default `fetch` becomes a late-resolving wrapper (§3.1); JSDoc on the field states why it is not a bare reference.                                           |
| `packages/sdk/deno.json`                                                    | `test.permissions.net` for the real-socket e2e (§3.10).                                                                                                                 |
| `packages/grpc-plugin/src/transports/connect-loader.ts`                     | X7-3: four literal imports in `DEFAULT_IMPORTERS`, `ConnectImporters` seam, `ModuleImporter`/`defaultImporter` removed, install text names three managers (§3.3, §3.4). |
| `packages/telemetry-plugin/src/instrumentation/http-instrumentation.ts`     | X7-3: zero-argument `importFn` defaults with literal imports for `http` and `fetch` (§3.5).                                                                             |
| `packages/telemetry-plugin/src/instrumentation/database-instrumentation.ts` | X7-3: same for `ioredis`.                                                                                                                                               |
| `packages/telemetry-plugin/src/instrumentation/queue-instrumentation.ts`    | X7-3: same for `amqplib` and `kafkajs`.                                                                                                                                 |
| `packages/telemetry-plugin/src/instrumentation/instrumentation-registry.ts` | Accepts a reporter and invokes it per outcome (§3.6).                                                                                                                   |
| `packages/telemetry-plugin/src/plugin/telemetry-plugin.ts`                  | Passes a `ctx.logger`-backed reporter, read at call time (§3.6).                                                                                                        |
| `packages/cli/src/schematics/custom.ts`                                     | `/* computed-specifier: … */` marker — an application-supplied schematic module URL (§3.7).                                                                             |
| `packages/decorator-plugin/src/discovery/controller-discovery.ts`           | Same marker — an application-supplied controller module path.                                                                                                           |
| `packages/react-router-plugin/src/handler/server-build.ts`                  | Same marker — the application's own compiled server build path.                                                                                                         |
| `scripts/npm-specifier-audit.ts`                                            | **New.** Pure scanner: `findComputedImports`, `auditPackageSources`, `ComputedImport` (§3.7, §3.8).                                                                     |
| `scripts/verify-release.ts`                                                 | Check 6 calls `auditPackageSources` (§3.8).                                                                                                                             |
| `scripts/script-coverage.ts`                                                | `scripts/npm-specifier-audit.ts` added to `SCRIPT_TARGETS` (§3.8).                                                                                                      |
| `compat/compat.test.mjs`                                                    | Artifact check with the self-clearing version guard (§3.11).                                                                                                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                   | src covered                                       | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sdk/test/unit/fetch-receiver.test.ts` **(new)**                                   | `src/http/http-client.ts`                         | Against a stand-in enforcing the WebIDL receiver rule: `createClient({ baseUrl })` with **no** `fetch` completes a request (fails with the current source — reproduced, `Illegal invocation`); an explicitly injected `fetch` still wins; a stand-in installed **after** construction is used (§3.1's D1/D2 discriminator); `globalThis.fetch` restored in `afterEach`. Types against `createClient(options: ClientOptions): IHttpClient`.                                                                                |
| `packages/sdk/test/e2e/default-transport.test.ts` **(new)**                                 | `src/http/http-client.ts`, `src/sdk.ts`           | A real `Deno.serve` on an unused port; a **default** client (no `fetch`, no `timing`) performs `GET` and `POST`, reads a typed body back, and a non-2xx surfaces as `HttpClientError`. This is the first test in the package to make a real network request.                                                                                                                                                                                                                                                              |
| `packages/sdk/test/unit/http-client.test.ts` (existing)                                     | `src/http/http-client.ts`                         | Unchanged, and deliberately kept: it is the injected-seam suite, and the point of §3.2 is that it cannot see this class of fault. No assertions removed.                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/grpc-plugin/test/unit/connect-loader.test.ts` (rewritten)                         | `src/transports/connect-loader.ts`                | All four failure branches driven through `Partial<ConnectImporters>` with one key rejecting; each message names its specifier **and all three install commands** (§3.4); `adaptConnectModule` branches unchanged; C5's replacement asserts each default importer's source contains an `import(` whose argument is a **quoted literal beginning `npm:`** — the property that survives publish, verified to fail against the old `(specifier) => import(specifier)` form.                                                   |
| `packages/grpc-plugin/test/unit/connect-real-import.test.ts` (existing)                     | `src/transports/connect-loader.ts`                | Retained; re-checked against the new no-argument signature. It proves the four specifiers resolve **on Deno**, which is precisely why it never saw X7-3 — recorded in its module doc so the next reader does not mistake it for coverage of the published artifact.                                                                                                                                                                                                                                                       |
| `packages/telemetry-plugin/test/unit/http-instrumentation.test.ts`                          | `src/instrumentation/http-instrumentation.ts`     | Injected zero-argument `importFn` resolving and rejecting for both kinds; `specifier` in the result equals the literal in the import. The existing `try { … } catch { /* not installed */ }` pair at lines 92-110 is **replaced** — it passes whether or not the real package loads, which is the vacuous-assertion trap the register names.                                                                                                                                                                              |
| `packages/telemetry-plugin/test/unit/database-instrumentation.test.ts`                      | `src/instrumentation/database-instrumentation.ts` | Same for `ioredis`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/telemetry-plugin/test/unit/queue-instrumentation.test.ts`                         | `src/instrumentation/queue-instrumentation.ts`    | Same for `amqplib` and `kafkajs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/telemetry-plugin/test/unit/instrumentation-registry.test.ts`                      | `src/instrumentation/instrumentation-registry.ts` | Reporter invoked once per outcome with `kind` and `reason`; a rejecting loader reports at `warn` and the registry still resolves (never throws); a reporter that itself throws does not break the build (the M45b lesson: an observation path must not become the failure path); no-provider path reports nothing.                                                                                                                                                                                                        |
| `packages/telemetry-plugin/test/unit/telemetry-plugin.test.ts`                              | `src/plugin/telemetry-plugin.ts`                  | The reporter reads `ctx.logger` at call time — a logger registered after `register()` still receives the lines (§3.6).                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/telemetry-plugin/test/integration/instrumentation-real-import.test.ts` (existing) | the five loaders                                  | Retained and driven through the **default** importers with no injection, guarded on the packages being present; same Deno-only caveat recorded as for grpc.                                                                                                                                                                                                                                                                                                                                                               |
| `test/unit/npm-specifier-audit.test.ts` **(new)**                                           | `scripts/npm-specifier-audit.ts`                  | Literal single-quoted, double-quoted and template-literal arguments accepted; identifier, member-expression and concatenated arguments rejected; multi-line `await import(\n 'npm:…'\n)` accepted (the `otlp-exporter.ts:31-32` shape); an `import()` inside a line comment, a block comment and a string ignored; `import.meta` never matched; the `/* computed-specifier: … */` marker accepted inline and on the preceding line; a marker with an empty reason **rejected**. Carries the 90% bar via `SCRIPT_TARGETS`. |
| `test/npm-specifier-gate.test.ts` **(new)**                                                 | the whole `packages/` tree                        | `auditPackageSources('packages')` returns empty. Vacuity guard: the walker visited a non-zero number of files and found the three marked sites, so a broken walker cannot pass by scanning nothing.                                                                                                                                                                                                                                                                                                                       |
| `compat/compat.test.mjs`                                                                    | published artifacts on Node and Bun               | No `npm:` inside an `import(` in each package's shipped `.js`, behind §3.11's version guard; prints `pending` with the version it saw while the fix is unpublished.                                                                                                                                                                                                                                                                                                                                                       |

**Negative controls** — each is applied, observed failing, and reverted, with the result recorded in
the PR:

1. Restore `this.#fetch = options.fetch ?? fetch` → `fetch-receiver.test.ts` fails with
   `Illegal invocation`; the injected-seam suite and the e2e still pass, which is the point.
2. Restore `fetch.bind(globalThis)` instead of the wrapper → only the after-construction case fails,
   discriminating between the two candidates rather than merely between broken and fixed.
3. Restore `(specifier) => import(specifier)` in `connect-loader.ts` → the C5 replacement assertion
   and the gate test both fail, and `connect-real-import.test.ts` still **passes** — which
   demonstrates in one run why a Deno real-import test could never have caught X7-3.
4. Remove one `/* computed-specifier: … */` marker → `test/npm-specifier-gate.test.ts` fails naming
   that file and line.
5. Add a `(spec) => import(spec)` indirection to any package → the gate fails, proving the rule
   catches the shape rather than the two known instances.
6. Point the telemetry reporter at a logger captured during `register()` rather than read at call
   time → the late-logger test fails.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70e-seam-defaults, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Plus, because this milestone changes package source in three published packages and adds a release
check, on a **committed** tree:

```bash
deno task publish:check              # deno publish --dry-run; refuses a dirty tree
deno task release:verify 0.1.0-alpha.8   # the six checks, including the new check 6
```

And the constructs the gates do not catch:

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" \
  packages/sdk/src packages/grpc-plugin/src packages/telemetry-plugin/src
```

## 8. Risks & mitigations

- **R1 — the two subpath specifiers are the first in the repository, and the rewrite's handling of
  them is unverified.** `npm:@connectrpc/connect@^2.1.2/protocol` and
  `npm:@bufbuild/protobuf@^2.7.0/wkt` are unavoidable: probed against the real packages,
  `createFetchHandler` is absent from `@connectrpc/connect`'s root and `FileDescriptorSetSchema` /
  `FileDescriptorProtoSchema` are absent from `@bufbuild/protobuf`'s root. No package in this
  repository has ever published an `npm:` subpath specifier, static or dynamic, so there is no local
  precedent for the rewrite's output. What supports it: JSR documents the canonical grammar as
  `npm:<name>@<version>/<path>`, so the subpath is part of the specifier the transform parses; the
  transform demonstrably preserves a subpath on the sibling `jsr:` arm
  (`@jsr/hono__hono/router/linear-router` in our own published `kernel`); and it must parse the
  specifier anyway to derive the `package.json` dependency entry (§3.9). **Mitigation:** this is the
  one claim the source gate cannot settle, so §3.11's compat check is the proof, and the alpha.9
  release must not be announced before it has run against the published artifact — a line for
  `docs/releasing.md` in this PR. Fallback if a subpath is not rewritten: map each subpath in
  `packages/grpc-plugin/deno.json`'s `imports` and import the **bare** aliased specifier, which
  needs no rewrite on Node or Bun because it is already the resolvable form; §3.9 establishes that
  an `imports` entry produces the same dependency entry, so the fallback costs nothing new.
- **R2 — reshaping a loader seam invites deleting the tests that used the old shape.** M65 lost ~530
  lines of unit coverage exactly this way. **Mitigation:** the four `connect-loader` failure
  branches and every instrumentation branch are enumerated in §6 as _rewritten_, never dropped; the
  per-file coverage table is compared before and after for all six touched `src` files, and control
  3 exists to prove the rewritten assertion is stronger than the one it replaces.
- **R3 — a test that swaps `globalThis.fetch` leaks into neighbouring tests.** **Mitigation:** the
  original is captured in `beforeEach` and restored in `afterEach`; the e2e uses the real global and
  never replaces it, so the two suites cannot interfere.
- **R4 — the new `test.permissions` block on `packages/sdk/deno.json` narrows rather than widens.**
  M53 established that a CLI `--allow-net=<list>` replaces a package block; the inverse risk is that
  adding a `test` block to a package that had none changes what its existing tests may do.
  **Mitigation:** run the sdk suite alone before and after adding the block and compare the pass
  count, not just the exit code.
- **R5 — the gate's marker becomes a rubber stamp.** Three exemptions today, each an
  application-supplied path. **Mitigation:** an empty or missing reason is rejected (§6), so a new
  exemption has to say something; and the gate test asserts the count of marked sites, so a fourth
  one is visible in the diff.
- **R6 — `warn`-level reporting on every boot becomes noise for applications that configure
  instrumentation they know is unavailable.** **Mitigation:** enabled outcomes report at `debug`;
  only a failure reports at `warn`, and a failure is precisely the case that was invisible.

## 9. Out of scope

- **X7-1, X7-2, X7-4** — `grpc-plugin`'s documented registration snippets throwing, the default
  `basePath` being unreachable by a native client, and native gRPC-binary working on no runtime the
  plugin can run on. **M70i** owns them together with the repair-versus-withdraw decision. This
  milestone deliberately unblocks that decision instead of pre-empting it.
- **X11-2** (the kernel's fallback 500 discarding the error) — **M70f**.
- **X11-3 through X11-9** (`sdk` codegen, the inferred `createApi` return type, the OpenAPI-side
  rows) — **M70m**.
- **X2-6** — **M70n**.
- **The `isInstrumentationSupported` node-only gate.** It remains `platform === 'node'` for all five
  kinds. Whether Deno's `node:` compatibility can host `@opentelemetry/instrumentation-http` is a
  real question and an M24b decision to revisit; widening it here would ship an untested platform
  branch on the back of a loader fix.
- **A guard for an environment with no `globalThis.fetch` at all.** The current `?? fetch` has no
  such guard, and adding one changes when the failure surfaces (construction rather than first
  request) for no row in the register.
- **The framework-wide §12.2 tension recorded as C6.** JSR's transform makes every recognised `npm:`
  specifier a hard npm dependency of the published package — measured on `logger-plugin` (`pino`),
  `messaging-plugin` (seven brokers), `database-plugin` (`@prisma/client`, `drizzle-orm`) and
  `telemetry-plugin` (four `@opentelemetry` packages). AI_GUIDELINES §12.2 says heavy dependencies
  "must never be hard dependencies of a plugin", so the guideline means the Deno/JSR side only and
  should say so, or ten published packages violate it. It is uniform, pre-existing, and affects far
  more than these three packages; it wants its own item and a maintainer decision, not a side-effect
  of a defect fix.
- **Committing or exporting `smoke/DEFECTS.md`.** The register remains outside this repository and
  outside this branch; this plan carries its two rows inline so it stands alone, per M70's own note.
