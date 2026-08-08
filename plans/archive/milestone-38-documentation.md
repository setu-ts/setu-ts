# Milestone 38 — Documentation

> **Status:** Complete. Branch: `feat/38-milestone`. `main` is protected — all work and all fixes
> stayed on this branch until the milestone is ready to merge.

## 0. Objective & scope

Turn the existing, fragmented documentation surface into one source-grounded reader journey without
inventing a second public contract. Curated guides under [`docs/`](../../docs/) will explain
adoption, architecture, APIs, extension, migration, examples, and runtime deployment; package
READMEs will remain the detailed per-package option references;
[`PUBLIC_API.md`](../../PUBLIC_API.md) will remain the authoritative public-surface ledger; and a
reproducible [`deno doc`](https://docs.deno.com/runtime/reference/cli/doc/) task will generate the
ignored static API site under [`docs/api/`](../../docs/api/). The milestone also adds drift gates so
the guide inventory, package catalog, local links, runtime notes, and generated API entrypoints
cannot silently fall behind the 47-package workspace.

- **In scope:** the documentation hub and nine curated guides; a source-derived package catalog
  covering every published plugin; programmatic and optional decorator API guides; custom-plugin,
  NestJS, and Fastify migration guides; examples and four-runtime deployment guides; reproducible
  HTML API generation and an API JSDoc lint **ratchet** over the measured pre-existing debt (§3.10);
  documentation-inventory and local-link checks; the named corrections in §2; and milestone tracking
  updates.
- **NOT this milestone:** a hosted documentation website or theme, which needs a separately approved
  deployment milestone; new framework behavior, exports, capability tokens, plugin options, example
  applications, Docker images, or Kubernetes manifests; and edits made only to make an inaccurate
  example compile. Source wins, and a genuine source defect is reported for its owning package
  rather than hidden in documentation work.
- **Explicitly NOT this milestone: clearing the 776 pre-existing `deno doc --lint` diagnostics.**
  They are measured, frozen, and reported by §3.10's ratchet, and the 122 `private-type-ref`
  findings among them are a public-API defect class this milestone is not allowed to fix (§3.9).
  Clearing them is a follow-up milestone (§9).

## 1. Contracts verified from SOURCE (not names)

### 1.1 Framework and documentation contracts

| Reference                                         | Source                                                                                          | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roadmap scope                                     | [`ROADMAP.md:3967`](../../ROADMAP.md:3967)                                                      | M38 requires getting started, plugin architecture, every plugin, programmatic and optional decorator APIs, custom plugins, NestJS and Fastify migrations, examples, [`deno doc`](https://docs.deno.com/runtime/reference/cli/doc/) generation, an API reference, the Hono/fetch/Workers/streaming truth, per-plugin Workers notes, and package-overview reconciliation.                                                                                          |
| Workspace inventory                               | [`deno.json:2`](../../deno.json:2)                                                              | The workspace has 47 members. The catalog and API generator must derive from this list rather than preserve an older hand-count.                                                                                                                                                                                                                                                                                                                                 |
| Published inventory                               | [`PUBLISHED_PACKAGES`](../../scripts/release-packages.ts:20)                                    | Publication is an explicit dependency-ordered allow-list; [`UNPUBLISHED_PACKAGES`](../../scripts/release-packages.ts:87) is empty. API generation covers the published allow-list and verifies it still equals the workspace set.                                                                                                                                                                                                                                |
| Runtime compatibility data                        | [`PACKAGE_METADATA`](../../scripts/jsr-metadata.ts:83)                                          | Every published package already has reviewed description and JSR runtime-compatibility data. A `true` flag means the package has a usable default path, not that every optional provider works there; provider-level caveats still belong in the catalog.                                                                                                                                                                                                        |
| Generated-doc location                            | [`AI_GUIDELINES.md:455`](../../AI_GUIDELINES.md:455) and [`.gitignore:10`](../../.gitignore:10) | HTML API output belongs in ignored [`docs/api/`](../../docs/api/), is rebuilt rather than committed, and JSR independently renders package docs at publish time.                                                                                                                                                                                                                                                                                                 |
| API JSDoc debt (MEASURED, not assumed)            | `deno doc --lint` over all 49 manifest export targets on this branch                            | **776 diagnostics: 654 `missing-jsdoc` + 122 `private-type-ref`, across 37 of 47 packages** (worst: queue-plugin 76, messaging-plugin 74, runtime 52, graphql-plugin 50, sdk 49). Ten packages are clean: `common`, `config-plugin`, `cqrs-plugin`, `exceptions`, `http-security-plugin`, `kernel`, `scheduler-plugin`, and all three starters. This is why §3.10 ratchets rather than blocks; a plan that made `--lint` blocking would have been undeliverable. |
| Subsetting inflates `private-type-ref` (MEASURED) | `deno doc --lint` over the ten clean packages alone                                             | Linting a SUBSET reports **28 errors that do not exist in the full run**, because a type exported by an unincluded package is reclassified as private (e.g. `MicroserviceStarterOptions["resilience"]` → `ResiliencePluginOptions`). The lint gate must therefore always pass the COMPLETE target set and filter diagnostics by owning package (§3.10); it must never lint an allowlisted subset.                                                                |
| Existing Markdown gate                            | [`checkDocument()`](../../scripts/check-docs.ts:297)                                            | The gate detects unclosed fences, swallowed headings, broken in-document anchors, and incomplete tables of contents. Its default scan already covers root docs, [`docs/`](../../docs/), package READMEs, and application READMEs.                                                                                                                                                                                                                                |
| Documentation-gate tests                          | [`test/docs-gate.test.ts:24`](../../test/docs-gate.test.ts:24)                                  | Fence, anchor, contents, task registration, and pull-request wiring are already discrimination-tested. M38 extends this test home rather than creating an unconnected checker.                                                                                                                                                                                                                                                                                   |
| API generator CLI                                 | [`deno doc`](https://docs.deno.com/runtime/reference/cli/doc/)                                  | Official Deno 2 documentation confirms multiple source roots, `--html`, `--output`, `--name`, and `--lint`. The generator will use local export targets, not published package specifiers, so it documents the branch being verified.                                                                                                                                                                                                                            |

### 1.2 Common, kernel, runtime, decorator, and CLI contracts used by the guides

| Reference                                                                                 | Source                                                                                                                               | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`CAPABILITIES`](../../packages/common/src/tokens.ts:39)                                  | [`packages/common/src/tokens.ts:39`](../../packages/common/src/tokens.ts:39)                                                         | The standard registry includes runtime, HTTP, DI, metadata, contribution, realtime, gRPC, Cloudflare, GraphQL, and static-file tokens. Guide examples use these constants instead of repeating their values.                                                                                                                                                                                                                                                                           |
| [`createCapabilityToken()`](../../packages/common/src/tokens.ts:181)                      | [`packages/common/src/tokens.ts:150`](../../packages/common/src/tokens.ts:150)                                                       | Custom tokens are one or more lowercase kebab-case segments separated by dots; a segment starts with a lowercase letter; colons are invalid. The custom-plugin guide uses a vendor-namespaced token such as `acme.payment-gateway`.                                                                                                                                                                                                                                                    |
| [`IPlugin`](../../packages/common/src/plugin.ts:517)                                      | [`packages/common/src/plugin.ts:517`](../../packages/common/src/plugin.ts:517)                                                       | A plugin has name, version, hard and optional dependencies, provided and lazily consumed capabilities, priority, and one registration method. There is no module class or hidden scanning contract.                                                                                                                                                                                                                                                                                    |
| [`IPluginContext`](../../packages/common/src/plugin.ts:456)                               | [`packages/common/src/plugin.ts:456`](../../packages/common/src/plugin.ts:456)                                                       | Plugins can contribute services, middleware, routes, environment declarations, health, metrics, OpenAPI schemas, decorators, CLI commands, lifecycle hooks, and can read runtime plus optional config/logger/metadata/container services.                                                                                                                                                                                                                                              |
| [`ILifecycleApi`](../../packages/common/src/plugin.ts:301)                                | [`packages/common/src/plugin.ts:301`](../../packages/common/src/plugin.ts:301)                                                       | The real phases are register, init, bootstrap, request, response, error, stopping, shutdown, and close. Shutdown phases run through [`onStopping()`](../../packages/common/src/plugin.ts:359), [`onShutdown()`](../../packages/common/src/plugin.ts:369), and [`onClose()`](../../packages/common/src/plugin.ts:375); no `onDestroy` hook exists.                                                                                                                                      |
| [`IApplication`](../../packages/common/src/plugin.ts:412)                                 | [`packages/common/src/plugin.ts:412`](../../packages/common/src/plugin.ts:412)                                                       | The application exposes router, middleware, services, plugin registration, start, stop, and web-standard fetch. [`StartOptions`](../../packages/common/src/plugin.ts:399) contains only optional port and hostname.                                                                                                                                                                                                                                                                    |
| [`IResponse.stream()`](../../packages/common/src/http.ts:175)                             | [`packages/common/src/http.ts:159`](../../packages/common/src/http.ts:159)                                                           | Streaming takes a web-standard `ReadableStream<Uint8Array>` and maps without buffer-then-send on Node, Deno, Bun, and Workers. [`IRequestContext.signal`](../../packages/common/src/http.ts:233) is the disconnect/cancellation seam.                                                                                                                                                                                                                                                  |
| [`IHttpAdapter`](../../packages/common/src/runtime.ts:376)                                | [`packages/common/src/runtime.ts:365`](../../packages/common/src/runtime.ts:365)                                                     | HTTP is fetch-centric: install a framework handler, expose universal fetch, optionally listen on a socket, close it, and optionally intercept WebSocket upgrades and RPC requests.                                                                                                                                                                                                                                                                                                     |
| [`IRuntimeServices`](../../packages/common/src/runtime.ts:252)                            | [`packages/common/src/runtime.ts:240`](../../packages/common/src/runtime.ts:240)                                                     | Runtime services expose platform, crypto, clocks, timers, environment, exit, and optional filesystem, workers, and DNS. Workers omit filesystem, worker threads, and DNS resolver services.                                                                                                                                                                                                                                                                                            |
| [`createApplication()`](../../packages/kernel/src/application/application.ts:769)         | [`packages/kernel/src/application/application.ts:41`](../../packages/kernel/src/application/application.ts:41)                       | The only creation option is an optional plugin array. The kernel-specific surface adds [`inject()`](../../packages/kernel/src/application/application.ts:88); streaming responses must be exercised through fetch, not injection.                                                                                                                                                                                                                                                      |
| Kernel startup                                                                            | [`Application.#runStartup()`](../../packages/kernel/src/application/application.ts:157)                                              | Runtime-first dependency resolution, plugin registration, environment validation, init, consumer diagnostics, pipeline compilation, bootstrap, handler installation, and optional socket listen are the actual startup order. Starting without a port still installs the fetch handler.                                                                                                                                                                                                |
| Kernel shutdown                                                                           | [`Application.#doStop()`](../../packages/kernel/src/application/application.ts:356)                                                  | Stop is idempotent; stopping hooks run while traffic is still accepted, then new traffic receives 503, in-flight requests drain, the socket closes, shutdown hooks run, and close hooks finish.                                                                                                                                                                                                                                                                                        |
| Hono routing                                                                              | [`Router`](../../packages/kernel/src/router/router.ts:55)                                                                            | Hono's [`LinearRouter`](../../packages/kernel/src/router/router.ts:45) returns overlapping candidates; the kernel keeps its static-segment and registration-order tie-break. Claims of a radix tree or logarithmic matching are false for the current implementation.                                                                                                                                                                                                                  |
| Plugin resolution                                                                         | [`resolvePluginOrder()`](../../packages/kernel/src/registry/plugin-resolver.ts:19)                                                   | The runtime provider is mandatory and first; hard dependencies fail startup, optional dependencies add ordering only when present, `consumes` produces a soft warning, duplicate plugin names and duplicate declared providers fail, and priorities break same-level ties.                                                                                                                                                                                                             |
| [`RuntimePlugin()`](../../packages/runtime/src/plugin/runtime-plugin.ts:100)              | [`packages/runtime/src/plugin/runtime-plugin.ts:82`](../../packages/runtime/src/plugin/runtime-plugin.ts:82)                         | The default HTTP-adapter map covers Deno, Node, Bun, and Cloudflare Workers. Workers string bindings enter [`runtime.env`](../../packages/runtime/src/plugin/runtime-plugin.ts:49) only when passed explicitly.                                                                                                                                                                                                                                                                        |
| Workers fetch model                                                                       | [`CloudflareWorkersHttpAdapter`](../../packages/runtime/src/adapters/workers/cf-http-adapter.ts:140)                                 | Fetch works, socket listen throws, close is a no-op, and WebSocket/RPC interception occurs before ordinary framework request mapping. The deployment guide uses a bound function rather than an unbound method reference.                                                                                                                                                                                                                                                              |
| Runtime export surface                                                                    | [`packages/runtime/src/index.ts:11`](../../packages/runtime/src/index.ts:11)                                                         | Public exports include the plugin, detector, service factories, DNS and worker hosts, WebSocket seams, all four HTTP adapters, and the RPC store. Generated API input must include manifest subpaths, not a hand-copied subset from [`PUBLIC_API.md`](../../PUBLIC_API.md).                                                                                                                                                                                                            |
| Decorator surface                                                                         | [`packages/decorator-plugin/src/index.ts:17`](../../packages/decorator-plugin/src/index.ts:17)                                       | The optional package exports metadata, controller/HTTP/request/injection/security/pipeline/validation/OpenAPI decorators, custom factories, parameter resolution, discovery, and the plugin factory.                                                                                                                                                                                                                                                                                   |
| [`DecoratorPlugin()`](../../packages/decorator-plugin/src/plugin/decorator-plugin.ts:476) | [`packages/decorator-plugin/src/plugin/decorator-plugin.ts:455`](../../packages/decorator-plugin/src/plugin/decorator-plugin.ts:455) | Decorators write plain metadata; only plugin registration translates it into routes and services. Explicit constructor tokens are required because Deno does not support emitted design metadata; parameter-level injection is preferred and the class-level token list is deprecated.                                                                                                                                                                                                 |
| CLI commands                                                                              | [`runCli()`](../../packages/cli/src/cli.ts:102)                                                                                      | The binary is `setu`; built-ins are `new`/`n`, `generate`/`g`, `commands`, and `help`. Unknown commands dispatch to plugin contributions. There is no `dev` command.                                                                                                                                                                                                                                                                                                                   |
| CLI install subpath                                                                       | [`packages/cli/deno.json:5`](../../packages/cli/deno.json:5)                                                                         | The executable entrypoint is `@setu-ts/cli/main`; docs retain the required version pin and `-n setu` install name.                                                                                                                                                                                                                                                                                                                                                                     |
| Runnable examples                                                                         | `apps/` directory listing, cross-checked against [`apps/README.md:6`](../../apps/README.md:6)                                        | **Fifteen** standalone applications exist on disk: minimal, REST, CQRS, tenancy, microservices, DI/decorators, database, plugin development, compiled binary, GraphQL, gRPC, Cloudflare, realtime, full-stack, **and `static-site`**. The examples guide links to these tested programs rather than creating decorative snippets.                                                                                                                                                      |
| Application index is STALE                                                                | [`apps/README.md`](../../apps/README.md) vs. `apps/` on disk                                                                         | The committed table lists only **fourteen** — [`apps/static-site/`](../../apps/static-site/) (M55, PR #132) is missing, though it has `main.ts`, `smoke.ts`, and a `smoke` task. [`check-apps.ts:71`](../../scripts/check-apps.ts:71) enumerates `Deno.readDir('apps')`, so the behavioral gate always covered it and no gate could see the doc gap. Conflict C16 fixes the index; §3.6 derives the completeness check from the DIRECTORY, never from the table it is meant to police. |

### 1.3 Real dependencies and specifiers

- No new package dependency is introduced. The API generator imports the existing
  [`PUBLISHED_PACKAGES`](../../scripts/release-packages.ts:20) through the relative specifier
  `./release-packages.ts`, reads each package's local manifest export map, and invokes the installed
  Deno executable through [`Deno.Command`](https://docs.deno.com/api/deno/~/Deno.Command).
- Generated API roots are the local manifest targets such as
  [`packages/kernel/src/index.ts`](../../packages/kernel/src/index.ts), whose only external runtime
  dependency is the real pinned Hono specifier `jsr:@hono/hono@^4.12.30` in
  [`packages/kernel/deno.json:8`](../../packages/kernel/deno.json:8).
- Guide installation commands use the repository's current prerelease convention,
  `jsr:@setu-ts/<package>@^0.1.0-alpha.5`, and the CLI subpath
  `jsr:@setu-ts/cli@^0.1.0-alpha.5/main`; no fictional npm alias or unversioned prerelease import is
  added.
- Migration terminology is grounded in the official [NestJS documentation](https://docs.nestjs.com/)
  and [Fastify reference](https://fastify.dev/docs/latest/Reference/). The guides map concepts onto
  current Setu-TS source; they do not promise drop-in compatibility.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                                                                             | Doc deliverable (same PR)                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | [`ARCHITECTURE.md`](../../ARCHITECTURE.md) describes M23/Workers as future in several places and omits Workers from diagrams and request flow.                                                                                                                                                                                                                                                                                                                                                                                                              | Current runtime source wins: Hono serving and all four adapters are shipped; Workers is fetch-only.                                                                                                  | Update architecture overview, lifecycle/runtime diagrams, runtime table, and future-language; reflect the same model in [`docs/runtime-deployment.md`](../../docs/runtime-deployment.md).                                                                                |
| C2  | The package overview in [`ARCHITECTURE.md:981`](../../ARCHITECTURE.md:981) omits workspace members added after its original diagram.                                                                                                                                                                                                                                                                                                                                                                                                                        | [`deno.json:2`](../../deno.json:2) is the workspace source of truth.                                                                                                                                 | Rebuild Architecture §8 so all 47 members appear in coherent tiers, satisfying the explicit M38 deliverable.                                                                                                                                                             |
| C3  | [`ARCHITECTURE.md:2561`](../../ARCHITECTURE.md:2561) lists edge runtime, SSE, static files, and other shipped capabilities as future additions.                                                                                                                                                                                                                                                                                                                                                                                                             | Shipped package source and workspace membership win.                                                                                                                                                 | Remove shipped items from Future Additions and leave only genuinely unimplemented, roadmap-owned ideas.                                                                                                                                                                  |
| C4  | Architecture performance prose claims radix-tree or logarithmic matching while kernel source installs Hono's linear router.                                                                                                                                                                                                                                                                                                                                                                                                                                 | [`Router`](../../packages/kernel/src/router/router.ts:55) wins.                                                                                                                                      | Describe Hono LinearRouter candidate matching plus the kernel tie-break; make no unsupported complexity claim.                                                                                                                                                           |
| C5  | Architecture testing prose implies the complete suite runs under Node, Deno, and Bun.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Current tasks and compat layout win: Deno runs the full suite; Node and Bun run the npm compatibility suite.                                                                                         | Correct the testing section and link the exact root and compatibility commands.                                                                                                                                                                                          |
| C6  | Both tree-shaking bullet lists ([`ARCHITECTURE.md:257`](../../ARCHITECTURE.md:257) and [`:2167`](../../ARCHITECTURE.md:2167)) make TWO false claims, not one: heavy providers are "peer dependencies" (this JSR workspace injects drivers or lazily loads pinned `npm:` specifiers), and every package sets `` `sideEffects: false` in `package.json` `` — **no `package.json` exists in any workspace package**; manifests are `deno.json`. [`README.md:78`](../../README.md:78) repeats the `sideEffects`/`package.json` claim in its feature table.      | Source and the JSR dependency rule win.                                                                                                                                                              | Replace peer-dependency wording with injection/lazy-import behavior and name Workers/provider limitations explicitly; remove the `package.json`/`sideEffects` claim from BOTH architecture lists AND the README feature row, describing JSR/ESM subpath exports instead. |
| C7  | Architecture lifecycle prose/diagram uses `onDestroy`, which does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | [`ILifecycleApi`](../../packages/common/src/plugin.ts:301) wins.                                                                                                                                     | Document register/init/bootstrap/request/response/error/stopping/shutdown/close and the real shutdown order.                                                                                                                                                             |
| C8  | Early [`PUBLIC_API.md`](../../PUBLIC_API.md) creation sections advertise application options and members wider than the authoritative kernel barrel and implementation.                                                                                                                                                                                                                                                                                                                                                                                     | [`ApplicationOptions`](../../packages/kernel/src/application/application.ts:42), [`IKernelApplication`](../../packages/kernel/src/application/application.ts:88), and the barrel win.                | Rewrite the early getting-started application contract and link the generated API rather than retaining a parallel shape.                                                                                                                                                |
| C9  | [`PUBLIC_API.md`](../../PUBLIC_API.md) advertises `setu-ts dev`/file watching, while the actual binary is `setu` and has no dev command.                                                                                                                                                                                                                                                                                                                                                                                                                    | [`runCli()`](../../packages/cli/src/cli.ts:102) wins.                                                                                                                                                | Remove the nonexistent command and document only new, generate, commands, help, and plugin command dispatch.                                                                                                                                                             |
| C10 | [`PUBLIC_API.md`](../../PUBLIC_API.md) summary calls Cloudflare Workers future despite shipped runtime and platform plugins.                                                                                                                                                                                                                                                                                                                                                                                                                                | Runtime and Cloudflare source win.                                                                                                                                                                   | Mark Workers current, separate generic fetch serving from optional Cloudflare platform bindings, and state resource omissions.                                                                                                                                           |
| C11 | [`PUBLIC_API.md`](../../PUBLIC_API.md) contents and root documentation navigation lag later GraphQL, Cloudflare, gRPC, static, testing, and SDK sections.                                                                                                                                                                                                                                                                                                                                                                                                   | Existing sections and workspace/package sources win.                                                                                                                                                 | Reconcile the full contents list; root [`README.md`](../../README.md) points readers to the new docs hub and generated API workflow.                                                                                                                                     |
| C12 | Root [`README.md`](../../README.md) repository structure and status are stale in four named places: [`:339`](../../README.md:339) calls `apps/` "empty, Milestone 37" (it holds 15 applications); [`:340`](../../README.md:340) lists an `examples/` directory that **no longer exists** (M37c deleted `examples/.gitkeep` so one concept has one directory); [`:344`](../../README.md:344) says "milestones 0–52" (M55 has shipped); and [`:410`](../../README.md:410) names "starters, examples" as remaining milestones (M36 and M37 are both complete). | The `apps/` listing, the workspace, and the ROADMAP Progress Tracking table win.                                                                                                                     | Correct repository structure (drop the `examples/` row, describe `apps/` by its real contents), documentation navigation, contributor focus, and roadmap status/counts in milestone tracking edits.                                                                      |
| C13 | Older architecture/custom-plugin samples use raw standard token strings and stale context/lifecycle shapes.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [`CAPABILITIES`](../../packages/common/src/tokens.ts:39), [`createCapabilityToken()`](../../packages/common/src/tokens.ts:181), and [`IPluginContext`](../../packages/common/src/plugin.ts:456) win. | Replace standard raw strings with constants and custom strings with validated vendor-namespaced tokens; update the extension sample and guide.                                                                                                                           |
| C14 | Some prose calls the decorator package a reflection system, while source explicitly uses plain maps without `reflect-metadata` or emitted design metadata.                                                                                                                                                                                                                                                                                                                                                                                                  | Decorator source wins.                                                                                                                                                                               | Use “metadata” consistently; explain explicit injection tokens and that decorators are inert without the plugin.                                                                                                                                                         |
| C15 | The public docs do not give every plugin a discoverable Workers capability note despite M38 requiring one.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | [`PACKAGE_METADATA`](../../scripts/jsr-metadata.ts:83), runtime optional-service contracts, and provider source are the baseline.                                                                    | Add one catalog row per published plugin with package-level status plus provider/resource caveats; gate completeness against published inventory.                                                                                                                        |
| C16 | [`apps/README.md`](../../apps/README.md) omits [`apps/static-site/`](../../apps/static-site/) (M55, PR #132) from its example table — 15 applications exist, 14 are indexed. `check:apps` enumerates the directory, so the behavioral gate never depended on the table and the omission was invisible.                                                                                                                                                                                                                                                      | The `apps/` directory listing wins; the table is documentation of it.                                                                                                                                | Add the missing `static-site` row naming what its smoke check proves, and derive the §3.6 examples-guide completeness check from `Deno.readDir('apps')` so the index is policed by the filesystem rather than by itself.                                                 |

## 3. Design decisions

### 3.1 One documentation hierarchy with explicit ownership

- **Decision:** [`docs/README.md`](../../docs/README.md) is the reader hub. Curated guides explain
  tasks and concepts; package READMEs own plugin-specific installation/options/examples;
  [`PUBLIC_API.md`](../../PUBLIC_API.md) owns the hand-maintained public contract; generated
  [`docs/api/`](../../docs/api/) owns symbol-level reference;
  [`ARCHITECTURE.md`](../../ARCHITECTURE.md) owns contributor internals. Guides link instead of
  copying large option tables.
- **Why:** This gives each fact one owner and prevents a comprehensive documentation milestone from
  creating a second 8,000-line API ledger that drifts independently.
- **Test home:** [`test/docs-gate.test.ts`](../../test/docs-gate.test.ts) asserts the required guide
  inventory and hub links.

### 3.2 Package documentation is a catalog plus existing detailed READMEs

- **Decision:** [`docs/plugins.md`](../../docs/plugins.md) has one discoverable section for every
  published plugin and starter/tooling package, grouped by the tiers in
  [`scripts/jsr-metadata.ts`](../../scripts/jsr-metadata.ts). Each row names purpose, capability,
  package-level four-runtime status, provider/resource caveats, package README, and generated API
  module. Detailed options remain in package READMEs.
- **Why:** M38's “each plugin documented” requirement is met without duplicating 47 maintained
  READMEs. The central page answers selection and portability questions that isolated READMEs cannot
  answer.
- **Test home:** [`test/docs-gate.test.ts`](../../test/docs-gate.test.ts) compares catalog package
  keys and README existence with [`PUBLISHED_PACKAGES`](../../scripts/release-packages.ts:20) and
  [`PACKAGE_METADATA`](../../scripts/jsr-metadata.ts:83).

### 3.3 Runtime status distinguishes package usability from provider limitations

- **Decision:** [`docs/runtime-deployment.md`](../../docs/runtime-deployment.md) defines the four
  server targets and optional runtime resources. The plugin catalog starts from JSR package flags,
  then adds concrete caveats: filesystem-dependent paths, SMTP/raw-socket brokers, worker threads,
  and DNS-SRV are unavailable on Workers; HTTP-backed, memory, KV/R2/D1, WebSocket, SSE, and
  ordinary fetch paths are documented where source supports them.
- **Why:** A single Workers yes/no value is misleading for multi-provider packages such as mail and
  storage. The split preserves the semantics already documented by
  [`RuntimeCompat`](../../scripts/jsr-metadata.ts:25).
- **Test home:** [`test/docs-gate.test.ts`](../../test/docs-gate.test.ts) enforces one runtime note
  per catalog entry and the presence of all four target columns.

### 3.4 Generated API input comes from local manifest export maps

- **Decision:** [`scripts/generate-api-docs.ts`](../../scripts/generate-api-docs.ts) reads the
  explicit published package paths, validates workspace parity, expands every string or
  object-valued local `exports` target, sorts/deduplicates them, and invokes `deno doc` once.
  Default mode recreates ignored [`docs/api/`](../../docs/api/) with
  `--html --name=Setu-TS --output=docs/api`; `--check` mode invokes `deno doc --lint` without
  writing output.
- **Why:** Hand-listing root barrels would miss subpaths such as the CLI executable and runtime
  worker entrypoint. Local targets document the branch, while JSR renders the published package view
  separately.
- **Test home:** [`test/api-docs-generation.test.ts`](../../test/api-docs-generation.test.ts) covers
  manifest shapes, deterministic arguments, parity failures, stale-output removal, child exit-code
  propagation, and both modes through injected filesystem/command seams.

### 3.5 Generated output stays ignored and reproducible

- **Decision:** The milestone does not force-add [`docs/api/`](../../docs/api/).
  `deno task docs:api` creates the static site; `deno task check:api-docs` runs the §3.10 JSDoc lint
  **ratchet**; `deno task check:docs` runs Markdown/inventory/link checks followed by that ratchet;
  release instructions run `deno task docs:api` to rebuild the artifact before release documentation
  is published.
- **Why:** This matches the existing ignore rule and AI guideline, avoids committing unstable HTML,
  and still makes generation and correctness mechanically verifiable.
- **Test home:** [`test/api-docs-generation.test.ts`](../../test/api-docs-generation.test.ts) and
  [`test/docs-gate.test.ts`](../../test/docs-gate.test.ts) assert task and CI/release wiring.

### 3.6 Examples are proven applications, not untested prose programs

- **Decision:** [`docs/examples.md`](../../docs/examples.md) provides learning paths and links each
  capability claim to a real application directory, its source, and its smoke task. The expected
  example set is derived from **`Deno.readDir('apps')`** — the same enumeration
  [`check-apps.ts:71`](../../scripts/check-apps.ts:71) uses — and the check asserts three-way
  agreement between the directory, the [`apps/README.md`](../../apps/README.md) table, and
  [`docs/examples.md`](../../docs/examples.md). Guide snippets are limited to source-verified
  minimum wiring and point to the full runnable application.
- **Why:** Existing smoke apps already prove behavior. Duplicated large snippets would become a
  second, non-executable example suite. Deriving the expectation from the **filesystem** rather than
  from `apps/README.md` is the load-bearing part: the table is itself stale (C16 —
  [`apps/static-site/`](../../apps/static-site/) is missing from it), so a check seeded from that
  table would have confirmed its own blind spot and passed while the example stayed undocumented. A
  gate may not take its expected set from the artifact it is policing.
- **Test home:** [`test/docs-gate.test.ts`](../../test/docs-gate.test.ts) verifies every directory
  under `apps/` appears in BOTH the application index and the examples guide, and is proven to
  discriminate by a fixture with a directory absent from each; existing `deno task check:apps`
  remains the behavioral gate.

### 3.7 Migration guides map concepts and call out semantic gaps

- **Decision:** The NestJS guide maps
  modules/providers/controllers/guards/pipes/interceptors/filters to explicit plugins, services,
  routes, middleware, validation, and exception handling; it shows the decorator option only after
  the programmatic mapping and states that design-type inference is unavailable. The Fastify guide
  maps register/encapsulation/decorate/hooks/routes/schema/reply to application registration,
  capability tokens, lifecycle/middleware, route definitions, validation, and response builders; it
  explains the web-standard fetch model and does not claim encapsulation parity.
- **Why:** Migration should teach the destination architecture, not recreate source-framework magic
  or imply API compatibility.
- **Test home:** [`test/docs-gate.test.ts`](../../test/docs-gate.test.ts) pins required concept
  mappings, source-framework official links, fetch-model language, and explicit non-parity notes.

### 3.8 Documentation checks expand without becoming a full Markdown renderer

- **Decision:** Extend [`scripts/check-docs.ts`](../../scripts/check-docs.ts) with pure helpers for
  required-guide inventory, repository-local Markdown links, package catalog completeness, runtime
  note completeness, and examples-index completeness. Retain the current CommonMark fence scanner;
  skip generated [`docs/api/`](../../docs/api/) and external URL probing.
- **Why:** These checks catch M38-specific drift deterministically without network flakes or a new
  Markdown dependency. A full documentation-site renderer remains outside scope.
- **Test home:** [`test/docs-gate.test.ts`](../../test/docs-gate.test.ts) supplies passing and
  failing fixtures for every added check and confirms pull-request wiring still invokes the
  aggregate task.

### 3.9 Documentation corrections never widen public API

- **Decision:** M38 changes no package source, manifest export, capability token, application
  option, or plugin option. When committed prose is wider than source, prose is narrowed. No
  internal type is exported merely to satisfy a documentation tool, and no `deno doc` diagnostic is
  suppressed.
- **Why:** This is a documentation milestone. Adding API to preserve stale prose would invert the
  source-of-truth rule and create dead surface.
- **Consequence, stated rather than discovered during implementation:** these two rules make the 776
  measured `deno doc --lint` diagnostics (§1.1) **unfixable inside this milestone**, and the 122
  `private-type-ref` findings are unfixable in principle here — the tool's own hint is "make the
  referenced type public or remove the reference", where the first is forbidden by this decision and
  the second is a package source change forbidden by §0. A blocking lint gate plus this rule is a
  deadlock, so the gate ratchets instead (§3.10). These findings are a genuine public-API defect
  class — the same "type unnameable by any consumer" defect M52c fixed on `NormalizedQuery` — which
  is why they are handed to a named follow-up (§9) rather than dismissed.
- **Test home:** Existing package barrel tests plus `deno task check:api-docs`, `publish:check`, and
  `release:verify` protect the unchanged publication contract.

### 3.10 API JSDoc lint is a ratchet over measured debt, never a blocking sweep

- **Decision:** `deno task check:api-docs` runs `deno doc --lint` over the **complete** set of local
  manifest export targets, parses the diagnostics, and partitions them by owning package path
  (`packages/<name>/`, `packages/starters/<name>/`). Two independent conditions fail the gate:
  1. **any** diagnostic belongs to a package on the clean allowlist — `common`, `config-plugin`,
     `cqrs-plugin`, `exceptions`, `http-security-plugin`, `kernel`, `scheduler-plugin`,
     `full-stack-starter`, `microservice-starter`, `rest-starter` (the ten measured clean in §1.1);
  2. the total diagnostic count **exceeds** the frozen baseline of `776`.

  A run below the baseline prints the new lower number and instructs the author to lower the
  constant, so debt paid down is locked in. The allowlist and the baseline live in one exported
  constant read by both the script and its test.
- **Why:** The debt is real and pre-existing (37 of 47 packages), the milestone may not fix it
  (§3.9), and a gate nothing can satisfy would simply be deleted or `|| true`'d by the first author
  who hits it. A ratchet makes the 776 **visible and non-growing** — which is the outcome a
  documentation milestone can actually deliver — while keeping the ten clean packages permanently
  clean.
- **Why the full set, never a subset:** measured in §1.1 — linting only the ten allowlisted packages
  reports **28 `private-type-ref` errors that do not exist in the full run**, because a type
  exported by an unincluded package is reclassified as private. Filtering must therefore happen on
  the _diagnostics_, never on the _inputs_. An implementation that "optimises" this by passing only
  the allowlisted targets to `deno doc` will fail with phantom errors and is wrong.
- **Test home:** [`test/api-docs-generation.test.ts`](../../test/api-docs-generation.test.ts)
  unit-tests the parser and partitioner against captured diagnostic text: a finding in an
  allowlisted package fails, the identical finding in a non-allowlisted package does not, a count
  above baseline fails, a count below baseline fails with the lower-the-constant message, and the
  argument builder is pinned to the complete target set.

## 4. Exported surface — every symbol names its consumer

No published `@setu-ts/*` symbol is added, removed, or widened.

The only new TypeScript module is a workspace script, not a package export:

| Workspace symbol                                                              | Kind                      | Consumer / real code path that reads it                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collectApiEntrypoints`                                                       | internal script function  | The generator main path builds both HTML and lint inputs; the unit test verifies manifest expansion.                                                                                           |
| `buildDenoDocArgs`                                                            | internal script function  | The generator main path constructs the exact child command for generate/check modes; the unit test pins flags and ordering.                                                                    |
| `runApiDocs`                                                                  | internal script function  | The script entrypoint executes it with real Deno hosts; tests inject filesystem and command seams.                                                                                             |
| `parseDocLintDiagnostics`                                                     | internal script function  | The §3.10 ratchet turns `deno doc --lint` stderr into `{ rule, path }` records; the unit test feeds it captured real diagnostic text.                                                          |
| `partitionDiagnostics`                                                        | internal script function  | The ratchet splits parsed records into allowlisted (fail) and known-debt (count-only) by owning package path; the unit test proves the identical finding fails in one package and not another. |
| `CLEAN_PACKAGES`                                                              | internal script constant  | The ten packages measured clean in §1.1; read by the ratchet and asserted by its test so the list cannot shrink silently.                                                                      |
| `DOC_LINT_BASELINE`                                                           | internal script constant  | The frozen `776`; the ratchet compares the total against it and the test pins both the over-baseline failure and the under-baseline lower-the-constant message.                                |
| New checker helpers in [`scripts/check-docs.ts`](../../scripts/check-docs.ts) | internal script functions | The default documentation gate uses each helper against the repository; tests import them to prove discrimination.                                                                             |

### 4.1 Options — every option names its consumer

| Option                                                                                     | Consumer                                               | Behavior (per implementation)                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--check` on [`scripts/generate-api-docs.ts`](../../scripts/generate-api-docs.ts)          | Root `check:api-docs` and aggregate `check:docs` tasks | Runs `deno doc --lint` over every local public export target — the COMPLETE set, never an allowlisted subset (§3.10) — partitions the diagnostics, and performs no output deletion/write. Exits non-zero on any allowlisted-package finding or a total above `DOC_LINT_BASELINE`. |
| No flag                                                                                    | Root `docs:api` and `release:docs` tasks               | Removes stale ignored output and regenerates the complete static HTML site at [`docs/api/`](../../docs/api/).                                                                                                                                                                     |
| Explicit Markdown paths accepted by [`scripts/check-docs.ts`](../../scripts/check-docs.ts) | Maintainers/tests debugging a subset                   | Preserves current subset behavior; repository-wide inventory checks run only for the default scan so a one-file diagnostic is not polluted by global findings.                                                                                                                    |

## 5. Implementation files

### 5.1 Source, tasks, and tests

| File                                                                         | Purpose                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`scripts/generate-api-docs.ts`](../../scripts/generate-api-docs.ts)         | New deterministic local-export discovery plus generate/check command runner with injectable hosts and actionable failures; owns the §3.10 diagnostic parser, partitioner, `CLEAN_PACKAGES`, and `DOC_LINT_BASELINE`. |
| [`scripts/check-docs.ts`](../../scripts/check-docs.ts)                       | Extend the existing Markdown gate with local-link, required-guide, package/runtime catalog, and example-index drift checks.                                                                                          |
| [`deno.json`](../../deno.json)                                               | Add `docs:api`, `check:api-docs`, and `release:docs`; make `check:docs` the aggregate Markdown plus API-lint gate while retaining the existing ignored output.                                                       |
| [`test/api-docs-generation.test.ts`](../../test/api-docs-generation.test.ts) | Named test for every branch/function in the new generator.                                                                                                                                                           |
| [`test/docs-gate.test.ts`](../../test/docs-gate.test.ts)                     | Extend existing discrimination and CI-wiring coverage for every new checker invariant and task.                                                                                                                      |
| [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)                 | Keep one `deno task check:docs` invocation; the task now includes API lint, so CI needs no duplicated command.                                                                                                       |

### 5.2 Curated documentation

| File                                                               | Purpose                                                                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`docs/README.md`](../../docs/README.md)                           | Audience-based documentation hub, guide order, package/API links, and existing operator-guide index.                                                                                 |
| [`docs/getting-started.md`](../../docs/getting-started.md)         | Version-pinned installation, minimal app, route, injection/fetch testing, socket start, Workers start, plugin addition, CLI, and next steps.                                         |
| [`docs/plugin-architecture.md`](../../docs/plugin-architecture.md) | Plugin contract, capability-token grammar, registry, dependency ordering, contributions, middleware, lifecycle, replacement, and runtime boundaries.                                 |
| [`docs/plugins.md`](../../docs/plugins.md)                         | Complete 47-package catalog, including every plugin, capability, README/API destination, runtime status, and Workers/provider note.                                                  |
| [`docs/programmatic-api.md`](../../docs/programmatic-api.md)       | Application, router, request/response, middleware, registry, runtime, lifecycle, testing, streaming, realtime/RPC interception, and generated-reference navigation.                  |
| [`docs/decorators.md`](../../docs/decorators.md)                   | Optional decorator setup/export map, inert-without-plugin behavior, explicit injection, programmatic equivalents, discovery, custom decorators, and limits.                          |
| [`docs/custom-plugins.md`](../../docs/custom-plugins.md)           | Source-valid plugin tutorial using token grammar, service registration, dependencies/consumes, route/middleware, contributions, health/metrics, lifecycle, replacement, and testing. |
| [`docs/migration-nestjs.md`](../../docs/migration-nestjs.md)       | Concept-by-concept NestJS migration, programmatic-first path, optional decorator path, fetch runtime model, and non-parity boundaries.                                               |
| [`docs/migration-fastify.md`](../../docs/migration-fastify.md)     | Concept-by-concept Fastify migration, plugin/route/hook/schema/reply mapping, fetch runtime model, and encapsulation differences.                                                    |
| [`docs/examples.md`](../../docs/examples.md)                       | Learning-path index over all runnable applications and their smoke-proven claims.                                                                                                    |
| [`docs/runtime-deployment.md`](../../docs/runtime-deployment.md)   | Node/Deno/Bun/Workers serving patterns, fetch/listen distinction, streaming/SSE, optional runtime resources, and per-provider caveats.                                               |

### 5.3 Existing authoritative and navigation docs corrected

| File                                           | Purpose                                                                                                                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`README.md`](../../README.md)                 | Point new users at the hub, correct repository/application state and milestone wording, retain the concise product overview.                                                                                                                       |
| [`ARCHITECTURE.md`](../../ARCHITECTURE.md)     | Ship C1–C7 and C13–C14, including the complete 47-member package overview.                                                                                                                                                                         |
| [`PUBLIC_API.md`](../../PUBLIC_API.md)         | Ship C8–C11 and C13–C14; narrow stale examples to source and link symbol details to generated docs.                                                                                                                                                |
| [`apps/README.md`](../../apps/README.md)       | Ship C16: add the missing [`static-site`](../../apps/static-site/) row naming what its smoke check proves, and add the examples-guide backlink. This file remains the human-readable index; `apps/` on disk is the source of truth the gate reads. |
| [`docs/releasing.md`](../../docs/releasing.md) | Add the required API-doc rebuild/lint step and explain that output is ignored while JSR renders published docs.                                                                                                                                    |
| [`ROADMAP.md`](../../ROADMAP.md)               | On implementation completion, check M38 deliverables and mark progress row 38 complete.                                                                                                                                                            |
| [`CLAUDE.md`](../../CLAUDE.md)                 | On implementation completion, record M38 evidence/status and move next-milestone guidance to M39.                                                                                                                                                  |

No package README is rewritten wholesale. The inventory gate may reveal a missing required README
section; any such targeted correction is added to this table before implementation rather than
silently broadening scope.

## 6. Test plan (every source file mapped; per-file 90% bar)

| Test file                                                                    | Source covered                                                                                                                                       | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`test/api-docs-generation.test.ts`](../../test/api-docs-generation.test.ts) | [`scripts/generate-api-docs.ts`](../../scripts/generate-api-docs.ts)                                                                                 | String and object export maps expand to local targets; every published package participates; workspace/publish mismatch fails with names; targets are sorted/deduplicated; generation args contain `--html`, name, and exact output; check args contain `--lint` and no write flag; **check args contain the COMPLETE target set, never a subset filtered to `CLEAN_PACKAGES` (§3.10)**; generation removes stale output; check mode does not; child non-zero status propagates. Calls use the explicit mode and injected host interfaces from §3.4.                                                                                                                                                                              |
| [`test/api-docs-generation.test.ts`](../../test/api-docs-generation.test.ts) | §3.10 ratchet in [`scripts/generate-api-docs.ts`](../../scripts/generate-api-docs.ts)                                                                | `parseDocLintDiagnostics` extracts rule and path from captured REAL `deno doc --lint` output (both `missing-jsdoc` and `private-type-ref` shapes, including the multi-line `--> path:line:col` form and the ANSI-coloured variant); `partitionDiagnostics` fails an allowlisted package and passes the byte-identical finding attributed to a non-allowlisted one; a total above `DOC_LINT_BASELINE` fails; a total below it fails with the lower-the-constant message; `CLEAN_PACKAGES` contains exactly the ten §1.1 packages; starters partition under `packages/starters/<name>/`, not `packages/starters/`.                                                                                                                  |
| [`test/docs-gate.test.ts`](../../test/docs-gate.test.ts)                     | [`scripts/check-docs.ts`](../../scripts/check-docs.ts), [`deno.json`](../../deno.json), [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) | Preserve all existing fence/heading/anchor behavior; local relative links accept files/directories/anchors and reject missing targets; default inventory requires every §5.2 guide; every published package has a README, metadata entry, catalog entry, API link, and runtime note; extra/duplicate catalog keys fail; all four runtime columns exist; **every directory under `apps/` appears in BOTH [`apps/README.md`](../../apps/README.md) and [`docs/examples.md`](../../docs/examples.md), with a fixture proving each side discriminates** (§3.6 — the expectation comes from `readDir`, so seeding it from the index cannot mask C16); subset mode skips global inventory; root tasks and CI invoke the aggregate gate. |
| [`test/docs-gate.test.ts`](../../test/docs-gate.test.ts)                     | Every Markdown file in §§5.2–5.3                                                                                                                     | The real repository scan is an integration assertion over fences, in-document anchors, local links, table-of-contents coverage, package catalog completeness, runtime notes, example coverage, and required hub navigation. This is the named content gate for documentation files, which contain no executable branches/functions/lines to coverage-measure.                                                                                                                                                                                                                                                                                                                                                                     |
| Existing package tests and `deno task check:apps`                            | Source snippets and runnable applications linked by guides                                                                                           | Existing compile, unit, integration, e2e, and smoke gates remain the behavioral evidence. A guide claim names its source application/package; no test-only duplicate implementation is created.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Coverage treatment:

- Both TypeScript script files are imported by tests, so they appear in the root coverage report and
  must meet the repository's per-file 90% branch/function/line bar.
- Markdown has no executable coverage metric; its mechanical equivalent is the repository-level
  integration scan in [`test/docs-gate.test.ts`](../../test/docs-gate.test.ts) plus `check:docs`.
- Generated [`docs/api/`](../../docs/api/) is excluded from formatting, Markdown scanning, Git, and
  coverage. Its source declarations are checked by `deno doc --lint`.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/38-milestone, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task check:docs
deno task docs:api
test -f docs/api/index.html
deno task check:apps
deno task test
deno task test:coverage
grep -RnE "<FILL:|setu-ts dev|setu dev|onDestroy|\*\*Edge Runtime\*\*|\*\*SSE Plugin\*\*|\*\*Static File Plugin\*\*|sideEffects|radix tree|Peer dependencies|empty, Milestone 37" \
  README.md ARCHITECTURE.md PUBLIC_API.md docs packages/*/README.md apps/README.md
git status --short --ignored docs/api
deno task audit
deno task publish:check
deno task release:verify <version>
```

Gate interpretation:

- Branch output must be exactly `feat/38-milestone`.
- `deno task check:plan` must report this one canonical plan clean before implementation begins.
- `check:docs` must report zero Markdown/inventory/link findings and zero API JSDoc diagnostics.
- `docs:api` must recreate [`docs/api/index.html`](../../docs/api/index.html) from an absent/stale
  output directory. `git status --short --ignored docs/api` must show ignored output only, never
  tracked files.
- `check:api-docs` must report zero findings in the ten `CLEAN_PACKAGES` and a total no greater than
  `DOC_LINT_BASELINE` (§3.10). It is NOT expected to report zero overall — 776 known diagnostics are
  frozen debt, not a milestone failure. If the total comes back **below** 776, lower the constant in
  the same commit; the gate says so itself.
- Read the ANSI-stripped per-file coverage table; both script sources and every package `src` file
  must be at least 90% for branch, function, and line.
- **The grep is a discrimination gate and was verified as one.** Run verbatim on the pre-fix tree it
  returns **12 matches** — `README.md:78,339,340`,
  `ARCHITECTURE.md:258,489,2130,2168,2171,2567,2568,2574`, and `PUBLIC_API.md:6072` — one or more
  for every conflict it polices (C3, C4, C6, C7, C9, C12). It must return zero current-behavior
  claims when the milestone is done. This replaces an earlier pattern set whose
  `Edge Runtime.*Future` / `SSE Plugin.*Future` / `Static File Plugin.*Future` alternations matched
  **nothing even before the fix**, because the Future Additions table rows carry no "Future" on the
  row itself — only the `### Future Additions` heading above them does. A gate that is empty before
  and after the work proves nothing; if any pattern here stops matching the pre-fix tree, it is
  broken, not satisfied.
- Review grep matches individually because legitimate historical/migration prose may quote a stale
  term while explaining its removal; no current-behavior claim may retain one.
- Run both publication gates on a committed tree because M38 edits published-package documentation
  and must not change export or package boundaries accidentally.

## 8. Risks & mitigations

- **A “comprehensive” guide set duplicates package READMEs and immediately drifts** → §3.1 assigns
  fact ownership and central guides link to detailed option tables instead of copying them.
- **The package/runtime catalog falls behind the next package** → derive expected keys from the
  explicit publish list and metadata map; fail on missing, duplicate, or extra entries.
- **A package-level Workers flag hides an unsupported provider** → every catalog entry carries a
  provider/resource caveat and the runtime guide explains optional filesystem, sockets, threads, and
  DNS.
- **Generated API documents a release rather than branch changes** → expand local manifest targets,
  not `jsr:` package URLs.
- **Generated HTML creates a huge accidental commit** → keep the established ignore/fmt exclusions,
  recreate output, and verify ignored-only status.
- **`deno doc --lint` exposes old JSDoc defects outside apparent docs scope** → it does, and the
  scale was measured rather than guessed: **776 diagnostics across 37 of 47 packages** (§1.1). Do
  not add exports or suppressions to make the gate green; ratchet instead (§3.10), freeze the
  baseline, keep the ten clean packages clean, and hand the debt to the §9 follow-up. The original
  form of this plan made the lint blocking while §3.9 forbade both available fixes, which was a
  deadlock that would have surfaced only mid-implementation.
- **The ratchet is "optimised" into a subset lint** → the plan states the measured consequence (28
  phantom `private-type-ref` errors) directly in §1.1 and §3.10, and the test pins the check args to
  the complete target set, so the shortcut fails a test rather than producing a confusing red gate.
- **A drift gate is seeded from the artifact it polices** → the examples check derives its expected
  set from `Deno.readDir('apps')`, not from `apps/README.md`; C16 exists because the committed index
  had already drifted and a table-seeded check would have ratified the gap.
- **Local-link checks reject valid URL/query/anchor forms** → unit-test normalization, URI decoding,
  directory README resolution, and same-file anchors; skip `http:`, `https:`, `mailto:`, and
  generated API targets whose tree is intentionally absent before generation.
- **Migration guides imply source-framework behavioral parity** → each mapping includes semantic
  differences and explicit non-parity boundaries, with official source-framework links.
- **Workers deployment copies an unbound application method** → show a request closure that calls
  `app.fetch(request)` after startup/configuration, preserving the application receiver.
- **Large Markdown edits reintroduce runaway fences or broken contents** → the existing
  discriminating fence/anchor gate runs over the real repository and is extended rather than
  replaced.
- **Mechanical docs pass while examples are false** → every substantial example points to source
  covered by package tests or to an application covered by `check:apps`; run both gates.

## 9. Out of scope

- A documentation-site framework, custom theme, search service, domain, CDN, and hosting pipeline.
  The generated Deno static site is the M38 API artifact; hosting needs a separately approved
  deployment milestone.
- Dockerfiles, Compose topology, Kubernetes manifests, Helm charts, and production deployment
  defaults. Milestone 39 owns those artifacts; M38 only documents the runtime serving contract and
  links existing operator material.
- New examples or changes to what an example proves. Milestone 37 owns runnable examples; a missing
  behavioral example becomes a follow-up rather than untested M38 prose.
- Public API changes, new decorators, inferred constructor tokens, Fastify encapsulation emulation,
  NestJS module emulation, hot reload, or a CLI dev server.
- **Clearing the 776 `deno doc --lint` diagnostics — a named follow-up, not a silent omission.** The
  654 `missing-jsdoc` findings are mechanical but span 37 packages; the 122 `private-type-ref`
  findings are a real public-API defect (an exported class whose interface is unnameable by any
  consumer — the defect class M52c fixed on `NormalizedQuery`) and each one needs a per-package
  decision to export the port, narrow the signature, or stop exporting the class. That is package
  API work with a `PUBLIC_API.md` consequence, so it cannot ride inside a documentation milestone
  that forbids export changes (§3.9). §3.10 freezes the number so the follow-up starts from a known,
  non-growing baseline.
- Live external-link crawling in CI. Network availability and upstream redirects make it
  nondeterministic; M38 validates repository-local links and records official external sources.
- Committing generated [`docs/api/`](../../docs/api/) HTML. The established contract is
  reproducible, ignored output plus JSR's generated package pages.
