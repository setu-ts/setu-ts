# Milestone 76 — Standard Decorators (`@setu-ts/decorator-plugin`)

> **Status:** Planning. Branch: `feat/m76-standard-decorators`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Migrate the framework's entire decorator surface from legacy TypeScript experimental decorators to
**TC39 standard decorators**, delete the legacy form, and remove `experimentalDecorators` from every
package manifest and every scaffolded project. The compiler option the whole surface is built on is
deprecated in Deno with no removal date and a per-run warning; its removal would not degrade the
parameter surface, it would make it **unparseable**, so the migration is done deliberately now
rather than under time pressure later. Parameter decorators have no standard equivalent at all, so
they are replaced by a positional, compile-time-checked `@Params(...)` method decorator — which is
strictly more type-safe than what it replaces.

- **In scope:** the standard-decorator rewrite of `decorator-plugin` (class, method and
  parameter-source surface, the metadata bridge, the plugin's resolution path); dropping the flag
  from the `decorator-plugin`, `openapi-plugin` and `starters/rest-starter` manifests and migrating
  the decorated classes in their test suites; the `cli` templates and schematics that stamp the flag
  and emit decorated source; `apps/di-decorators`; the eleven documentation sites; `PUBLIC_API.md`,
  `ARCHITECTURE.md` §12 and a `CHANGELOG.md` entry carrying migration text for every removed symbol.
- **NOT this milestone:** retiring the decorator surface itself — M65 already made the functional
  style the default and decorators are opt-in; this keeps the opt-in working. Type-inferred
  injection stays impossible (`emitDecoratorMetadata` is unsupported by Deno and absent repo-wide),
  so every token and every parameter source remains explicit. Broker trace propagation is M75.

## 1. Contracts verified from SOURCE (not names)

Every row below was opened and read in this worktree, or established by running a probe on Deno
2.9.5 (the version `deno --version` reports here). No row is taken from the ROADMAP's prose.

| Reference | Source (file:line) | Verified surface / fact |
| --------- | ------------------ | ----------------------- |
| `IMetadataStore` | `packages/common/src/plugin.ts:406` | Exactly three readonly `Map`s — `controllers`, `services`, `routes` — every one keyed by `Constructor`. Values are `Readonly<Record<string, unknown>>`. This is a committed contract and the migration must keep satisfying it. |
| `CAPABILITIES.METADATA_STORE` | `packages/common/src/tokens.ts:129` | Token value is `'metadata-store'`. The store is published under it, so its key type is observable by any other plugin. |
| `Constructor<T>` | `packages/common/src/container.ts:16` | `new (...args: never[]) => T`. The store's key is the constructor, never the prototype. |
| `protoToCtor` | `packages/decorator-plugin/src/internal.ts:98` | Reads `target.constructor`. Exists solely because **legacy** method and parameter decorators receive the prototype. Under standard decorators nothing receives a prototype, so this helper loses its only reason to exist. |
| `storeParam` / `mutateMethod` | `packages/decorator-plugin/src/metadata/metadata-store.ts:531,515` | Both take `(target: Constructor, handler: string, …)`. The store's write API is already constructor-keyed and handler-name-keyed, which is exactly what a standard class decorator can supply. |
| `mergeCtorParam` / `mergeCtorOptional` / `ctorInject` / `ctorOptional` | `packages/decorator-plugin/src/metadata/metadata-store.ts:382,399,426,411` | The parameter-position `@Inject` / `@Optional` path. `ctorInject` returns `readonly string[] | undefined`; `ctorOptional` returns a `ReadonlySet<number>`. The class-position positional list writes through `mergeService({ inject })` instead. |
| Class-position `@Inject` | `packages/decorator-plugin/src/decorators/injection.ts:112` | Already ships and is currently marked deprecated in favour of the parameter form. It is the **working replacement** this milestone needs, so the deprecation is reversed rather than a new API invented. |
| `Symbol.metadata` support | Probe, Deno 2.9.5, `deno.json` = `{}` | `typeof Symbol.metadata === 'symbol'`. `context.metadata` is a live object at **decoration time**, and the same object is readable as `Class[Symbol.metadata]` after the class is defined and **before any instance exists**. |
| Decorator ordering | Probe, Deno 2.9.5 | Member decorators run before the class decorator, and the class decorator receives the **same** `metadata` object the members wrote into, alongside the constructor. This is the bridge that keeps `IMetadataStore` constructor-keyed. |
| Metadata inheritance | Probe, Deno 2.9.5 | `Object.getPrototypeOf(Sub[Symbol.metadata]) === Base[Symbol.metadata]` is **false**, and a subclass member decorator sees no inherited key. Each class gets an independent metadata object — which matches the legacy constructor-keyed `Map` exactly, so inheritance behaviour does not change. |
| Standard method decorator reach | Probe, Deno 2.9.5 | A method decorator cannot reach the constructor at decoration time; `context.addInitializer` runs **per instance**. This is why the design uses `context.metadata` and not `addInitializer` — the plugin reads the store during `register()`, before any controller is constructed. |
| Legacy `ClassDecorator` type in a standard position | Probe, `deno check` | **Accepted** — `declare const D: ClassDecorator; @D class A {}` type-checks with no flag. |
| Legacy `MethodDecorator` type in a standard position | Probe, `deno check` | **Rejected** — TS1241 (`runtime will invoke the decorator with 2 arguments, but the decorator expects 3`) and TS1270. Every `@Get`/`@Post`/`@ApiOperation`/`@Validate*`/`@Use*` fails to type-check unmigrated. |
| Parameter decorator without the flag | Probe, Deno 2.9.5 | `SyntaxError: Invalid or unexpected token` — a **parse** error, not a type error. Confirms the ROADMAP's third fact. |
| Positional `@Params` type safety | Probe, `deno check` | A source tuple mapped onto the method signature type-checks the good case cleanly and rejects a mismatched case with `Type 'string' is not assignable to type 'number'`. Legacy parameter decorators checked nothing. |
| Flag declaration sites | `grep`, this worktree | `packages/decorator-plugin/deno.json:7`, `packages/openapi-plugin/deno.json:7`, `packages/starters/rest-starter/deno.json:7`, `apps/di-decorators/deno.json:14`, `packages/cli/src/templates/module-seam.ts:48`, `packages/cli/src/templates/minimal.ts:80`, `packages/cli/src/templates/project-files.ts:979` (the Node `tsconfig.json`). The ROADMAP named four of these seven. |
| `openapi-plugin` flag reason | `grep` over `packages/openapi-plugin/src` | Its `src` mentions decorators only in comments; it never imports `decorator-plugin` (§2.2 forbids it) and reads route metadata instead. The manifest flag exists **only** for its integration test's decorated classes, so the flag can be dropped once that test migrates. |
| `rest-starter` flag reason | `grep` over `packages/starters/rest-starter` | Same shape — decorated classes appear in `test/`, and `src/options.ts` / `src/app.ts` reference the plugin by type only. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| # | Conflict | Resolution (picked side) | Doc deliverable (same PR) |
| - | -------- | ------------------------ | ------------------------- |
| C1 | `ARCHITECTURE.md:2075` says decorators require "`experimentalDecorators` or the new TC39 decorators proposal", presenting both as live options. After this milestone only the TC39 form exists. | TC39 only. The sentence becomes a statement that the framework uses standard decorators and needs no compiler option. | Rewrite of the `ARCHITECTURE.md` §12 opening and its "Programmatic API Equivalents" table row for `@Body()`. |
| C2 | `PUBLIC_API.md:8250` states the decorator surface "Requires `experimentalDecorators` compiler support (enabled in the package `deno.json`). Legacy…". That becomes false the moment the flag is dropped. | Replace with the standard-decorator statement and the explicit "no `compilerOptions` entry is required" claim, which the probe establishes. | `PUBLIC_API.md` decorator section rewrite, plus the `@Params` surface and the removed-symbol rows. |
| C3 | `PUBLIC_API.md:5758` and `CHANGELOG.md:1870-1872` describe the generated **Node** project's `tsconfig.json` enabling `experimentalDecorators` and `tsx` reading it. After the migration the generated Node project needs no such option. | The generated `tsconfig.json` drops the option. `tsx` still transpiles standard decorators, which is verified by a real `npm install` + `npm start` boot rather than assumed. | `PUBLIC_API.md` runtime-notes correction; `CHANGELOG.md` entry recording the generated-output change. |
| C4 | `packages/cli/src/templates/minimal.ts:74-80` justifies stamping the flag on a host that emits **nothing decorated**, so that a developer adding `decorator-plugin` by hand does not hit a compile error from a manifest they did not write. That justification disappears entirely — the plugin will need no flag. | The stamp is deleted from the minimal host, and the comment with it. | Comment removal at the site; the reasoning is recorded in this plan and the CHANGELOG, not left as a stale comment. |
| C5 | `injection.ts:112` documents the class-position `@Inject` as deprecated in favour of the parameter position, while the parameter position is exactly what this milestone deletes. | The class position becomes the supported form and its `@deprecated` marker is removed; the parameter position is deleted with migration text. | JSDoc rewrite on `Inject`; `PUBLIC_API.md` row; `CHANGELOG.md` migration entry. |

## 3. Design decisions

### 3.1 Where member decorators accumulate metadata

- **Decision:** Member decorators (`@Get`, `@ApiOperation`, `@ValidateBody`, `@UseGuards`, `@Params`,
  …) write into the standard `context.metadata` object under one package-owned key. The class
  decorator (`@Controller` / `@Injectable`) then transfers the whole accumulation into the existing
  constructor-keyed `metadataStore` through its current `merge*` / `store*` / `mutateMethod` write
  API, which is unchanged.
- **Why:** `IMetadataStore` (`common/src/plugin.ts:406`) is a committed contract keyed by
  `Constructor` and published under `CAPABILITIES.METADATA_STORE`, so the key type is observable
  outside this package. A standard method decorator never receives the constructor, but the class
  decorator does, and the probe establishes that it receives the **same** metadata object its
  members wrote into. Bridging in the class decorator keeps `common` unchanged — no widening, no new
  token. The rejected alternative is `context.addInitializer`, which the probe shows runs per
  instance, long after the plugin has already read the store during `register()`.
- **Test home:** `test/unit/metadata-bridge.test.ts`, plus the existing plugin integration suites,
  which read the store through the unchanged public path.

### 3.2 What replaces parameter injection

- **Decision:** A single method decorator, `@Params(...sources)`, listing one source per handler
  argument in positional order. The existing exported names are retained and change **kind** from
  parameter decorator to source descriptor: `Body<T>()`, `Query(name?)`, `Param(name)`,
  `Header(name)`, `Cookie(name)`, `CurrentUser()`, `Ctx()`, and `Custom(name, metadata?)` replacing
  `createParameterDecorator`.
- **Why:** The Stage 3 proposal has no parameter position, so nothing can be salvaged in place. A
  positional list needs no parameter syntax, preserves the injection feature that is the whole
  reason the decorated style exists, and the probe shows it gains compile-time checking of the
  handler's parameter types that the legacy form never had. Keeping the names makes the migration
  mechanical to document and makes every stale call site a loud compile error rather than a silent
  behaviour change, because the returned type is no longer a decorator.
- **Test home:** `test/unit/params.test.ts` for capture order and source shapes;
  `test/type/params-typing.test.ts` for the `@ts-expect-error` control proving a mismatched
  signature is rejected.

### 3.3 What replaces constructor-parameter injection

- **Decision:** The class-position positional `@Inject('database', 'logger')` becomes the supported
  form and its deprecation is reversed. `@Optional` changes kind the same way §3.2 does: it becomes
  a token wrapper used inside that list, `@Inject('database', Optional('cache'))`.
- **Why:** The class-position form already ships and already works (`injection.ts:112`), so §9.2's
  requirement of a **working** replacement is satisfied by code that exists rather than by new
  surface. Wrapping the optional marker into the same list collapses the two-decorator dance into
  one registration site, which removes the mixed-form and index-hole failure modes M36b had to throw
  on. Type inference remains impossible, so a token stays mandatory in every position.
- **Test home:** `test/unit/injection.test.ts`, and `test/integration/di-construction.test.ts`
  driving both construction paths — with a DI container present and with only the service registry.

### 3.4 Preserving the observable metadata shape

- **Decision:** The shapes the store holds — `ControllerMetadata`, `RouteMetadata`,
  `ParameterMetadata`, `ServiceMetadata` — keep their current fields and semantics, including
  `ParameterMetadata.index`. The index is now assigned from the source's position in the `@Params`
  tuple rather than captured from the parameter position.
- **Why:** `openapi-plugin` and the plugin's own handler builder read these shapes, and
  `resolveParameters` is published API. Changing the storage shape at the same time as the capture
  mechanism would make any regression impossible to attribute to one of the two.
- **Test home:** `test/unit/metadata-shape.test.ts`, asserting the stored records field by field
  against a baseline captured from the legacy implementation before it is deleted.

### 3.5 How the legacy behaviour is proven unchanged

- **Decision:** Before deleting the legacy implementation, capture its stored metadata for a
  representative decorated controller as a committed fixture, then assert the standard
  implementation produces the same records.
- **Why:** This is a rewrite of 3,136 lines whose output is consumed by another package. A test
  written only against the new code cannot tell "correct" from "consistently wrong". The captured
  baseline is the only artefact that can, and it must be captured while the legacy code still runs.
- **Test home:** `test/unit/metadata-shape.test.ts` reads the fixture; the capture step is a
  one-time script whose output is committed, not a gate.

### 3.6 The `@Ctx()` marker survives the kind change

- **Decision:** `CONTEXT_PARAMETER_MARKER` keeps its `Symbol.for` identity and its
  `PARAMETER_KIND_KEY` metadata carrier. `Ctx()` returns a source descriptor carrying the same
  frozen metadata object, and `isContextParameter` is unchanged.
- **Why:** M64 established by building a real two-copy scenario that a copy-local symbol misses on
  every read when two copies of the package share a process. Nothing about that reasoning depends on
  the decorator form, and the marker is recognised by **value**, so the change of kind does not
  touch it.
- **Test home:** the existing M64 cross-copy test, retained and re-pointed at the new call shape.

### 3.7 Where the flag is removed

- **Decision:** All seven declaration sites from §1 lose the option: three package manifests, one
  app manifest, and three CLI emission sites (the class-based module manifest, the minimal host, and
  the generated Node `tsconfig.json`). No manifest gains a replacement compiler option.
- **Why:** The probe shows standard decorators run with `deno.json` = `{}` — no flag and no
  `compilerOptions` key at all. Adding nothing back is what makes M63's D3 trap unreachable here:
  the trap is that declaring **any** compiler option replaces Deno's default set, and these
  manifests will declare none.
- **Test home:** `packages/cli/test/unit/scaffold-permissions.test.ts` (inverted — asserts the key
  is absent everywhere), plus the M63 `scaffold-runs-e2e` gate which formats, lints, installs,
  type-checks and boots each template.

### 3.8 The generated-output migration is proven by booting, not by reading

- **Decision:** The CLI change is verified by scaffolding both decorator-using templates, generating
  one of every gated artifact into them, type-checking against this workspace, and **booting** them
  to drive a real request through a generated controller and a generated module.
- **Why:** M58's review found `setu generate controller` had emitted a controller answering 500 on
  every request through five releases, because its tests asserted decorator **presence** rather than
  behaviour. This milestone rewrites exactly that emitted source. A string assertion cannot see the
  failure it is most likely to cause.
- **Test home:** `packages/cli/test/e2e/generate-e2e.test.ts` and the M60/M61 seam-probe hosts.

## 4. Exported surface — every symbol names its consumer

Every symbol below is exported from `packages/decorator-plugin/src/index.ts`. Rows marked **removed**
disappear in this milestone and each carries CHANGELOG migration text naming its replacement.

| Exported symbol | Kind | Consumer / real code path that READS it |
| --------------- | ---- | --------------------------------------- |
| `Controller` | class decorator | `DecoratorPlugin.register` reads the controller record it bridges into the store; the CLI's `controller` and `module` schematics emit it. |
| `Version` | class decorator | `joinPaths` in the plugin's route registration builds the effective path from it. |
| `Get` `Post` `Put` `Patch` `Delete` `Head` `Options` | method decorators | The plugin's route registration reads each `RouteBinding`; `openapi-plugin` reads the resulting `RouteInfo`. |
| `Params` | method decorator | **New.** `resolveParameters` reads the captured `ParameterMetadata[]` at request time to build the handler argument list. |
| `Body` `Query` `Param` `Header` `Cookie` | source descriptors (**kind change**) | Consumed by `Params`, which writes their `ParameterMetadata` into the store. |
| `CurrentUser` `Ctx` | source descriptors (**kind change**) | Same path; `Ctx` additionally carries `CONTEXT_PARAMETER_METADATA`, read by `isContextParameter` in the resolver. |
| `Custom` | source descriptor factory (**new, replaces `createParameterDecorator`**) | `resolveParameter` dispatches on `customType` to a resolver registered by `registerParameterResolver`. |
| `Injectable` | class decorator | The plugin's `registerService` / `registerInContainer` read the service record and its `token` and `scope`. |
| `Inject` | class decorator (**parameter position removed**) | `effectiveInject` reads the positional token list and `resolveDeps` resolves each token. |
| `Optional` | token wrapper (**kind change**) | `effectiveOptional` reads the optional index set derived from the wrapped tokens. |
| `Roles` `Permissions` `Public` | class / method decorators | Stored on the route record; read by auth guard middleware through `RouteInfo`. |
| `UseGuards` `UseInterceptors` `UseFilters` | class / method decorators | `composeMiddleware` in the plugin builds the per-route chain from them. |
| `ValidateBody` `ValidateQuery` `ValidateParams` | method decorators | M70n's enforcement path resolves `CAPABILITIES.VALIDATION` and appends the validation middleware; `openapi-plugin` derives request schemas from the same records. |
| `ApiTags` `ApiOperation` `ApiResponse` | class / method decorators | `openapi-plugin`'s generator reads the `OpenApiMetadata` off the route. |
| `createDecorator` | factory | Custom decorator handlers registered under `CAPABILITIES.DECORATOR_HANDLER` are replayed against the stored records by the plugin. |
| `MetadataStore` `metadataStore` | class / instance | Published under `CAPABILITIES.METADATA_STORE`; read by the plugin and by any consumer resolving that token. |
| `ParameterMetadata` `ParameterType` `HttpMethodDecorator` `MiddlewareLike` `InjectableOptions` | types | Consumed by the plugin, by `resolveParameter`'s signature, and by application code annotating its own values. |
| `ParamSource` | type (**new**) | The element type of the `Params` tuple; consumed by application code writing a custom source and by `Custom`'s return type. |
| `registerParameterResolver` `getParameterResolver` `clearParameterResolvers` `resolveParameter` `resolveParameters` `parseCookies` `CustomParameterResolver` | resolver surface | Unchanged. `resolveParameters` is called per request by the plugin's handler builder. |
| `discoverControllers` `DiscoveryOptions` `DiscoveryResult` `ModuleImporter` | discovery surface | Unchanged. Read by `DecoratorPlugin` when `autoDiscover` is configured. |
| `DecoratorPlugin` `DecoratorPluginOptions` | plugin factory / options | The kernel registers it; the CLI's class-based template and `rest-starter` wire it. |
| `createParameterDecorator` | **removed** | Replaced by `Custom(name, metadata?)` used inside `@Params`. |

### 4.1 Options — every option names its consumer

`DecoratorPluginOptions` is unchanged by this milestone; no option is added, removed or repurposed.

| Option | Consumer | Behavior (per implementation) |
| ------ | -------- | ----------------------------- |
| `controllers` | `DecoratorPlugin.register` | Unchanged. Each listed class is bridged and registered; a class carrying no controller record still warns (M64) rather than throwing. |
| `services` | `registerService` / `registerInContainer` | Unchanged. Registered on the container when one is present, on the service registry otherwise. |
| `autoDiscover` / `controllersPath` | `discoverControllers` | Unchanged. Still filters to decorated classes, so a non-decorated module is not a developer mistake. |
| `enforceSchemas` | M70n's validation enforcement path | Unchanged, still defaulting on. |

## 5. Implementation files

| File | Purpose |
| ---- | ------- |
| `packages/decorator-plugin/src/index.ts` | Barrel: adds `Params`, `Custom`, `ParamSource`; removes `createParameterDecorator`. |
| `packages/decorator-plugin/src/metadata/context-bridge.ts` | **New.** Owns the `context.metadata` accumulator key, the per-member write helpers, and the single `bridgeIntoStore(ctor, metadata)` transfer the class decorators call. |
| `packages/decorator-plugin/src/decorators/params.ts` | **New.** `Params`, the `ParamSource` type, and the source descriptors `Body` `Query` `Param` `Header` `Cookie` `Custom`. |
| `packages/decorator-plugin/src/decorators/request.ts` | Deleted — its five exports move to `params.ts` as descriptors. |
| `packages/decorator-plugin/src/decorators/controller.ts` | `Controller` / `Version` become standard class decorators and call `bridgeIntoStore`. |
| `packages/decorator-plugin/src/decorators/http.ts` | Verb decorators become standard method decorators writing through the bridge. |
| `packages/decorator-plugin/src/decorators/injection.ts` | `Injectable` becomes a standard class decorator; `Inject` loses its parameter position; `Optional` becomes a token wrapper. |
| `packages/decorator-plugin/src/decorators/security.ts` | `Roles` / `Permissions` / `Public` migrate; `CurrentUser` / `Ctx` become descriptors; the M64 marker surface is untouched. |
| `packages/decorator-plugin/src/decorators/pipeline.ts` | `UseGuards` / `UseInterceptors` / `UseFilters` migrate, keeping the dual class-and-method position. |
| `packages/decorator-plugin/src/decorators/validation.ts` | `ValidateBody` / `ValidateQuery` / `ValidateParams` migrate. |
| `packages/decorator-plugin/src/decorators/openapi.ts` | `ApiTags` / `ApiOperation` / `ApiResponse` migrate. |
| `packages/decorator-plugin/src/decorators/custom.ts` | `createDecorator` migrates to the dual standard position; `createParameterDecorator` is deleted. |
| `packages/decorator-plugin/src/internal.ts` | `protoToCtor` is deleted — nothing receives a prototype any more. `normalizeMiddleware`, `joinPaths`, `isHandlerResult`, `className` are unchanged. |
| `packages/decorator-plugin/src/metadata/metadata-store.ts` | Write API unchanged. The `IMetadataStore` implementation and every stored shape stay as they are (§3.4). |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts` | `effectiveInject` / `effectiveOptional` collapse to the single class-position path; the mixed-form and index-hole throws they guarded are removed with the form that caused them. |
| `packages/decorator-plugin/deno.json` | Drops `compilerOptions` entirely. |
| `packages/openapi-plugin/deno.json` | Drops `compilerOptions` entirely. |
| `packages/starters/rest-starter/deno.json` | Drops `compilerOptions` entirely. |
| `apps/di-decorators/deno.json` + its source | Drops the flag; migrates its decorated service and controller. |
| `packages/cli/src/templates/module-seam.ts` | Drops the `denoCompilerOptions` stamp from the class-based module manifest. |
| `packages/cli/src/templates/minimal.ts` | Drops the stamp and the comment justifying it (C4). |
| `packages/cli/src/templates/project-files.ts` | Drops `experimentalDecorators` from the generated Node `tsconfig.json` (C3). |
| `packages/cli/src/schematics/*` (controller, module, service) | Emit standard-decorator source, including `@Params` on every generated write handler. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file | src covered | Key assertions (and the signature each call type-checks against) |
| --------- | ----------- | ---------------------------------------------------------------- |
| `test/unit/context-bridge.test.ts` | `metadata/context-bridge.ts` | Members accumulate into one object; `bridgeIntoStore(ctor, metadata)` writes exactly the records the legacy `merge*` calls produced; a class with members but no class decorator writes nothing, matching today. |
| `test/unit/params.test.ts` | `decorators/params.ts` | `Params(Param('id'), Body())` stores two `ParameterMetadata` records with `index` 0 and 1 in tuple order; `Query()` with no name stores no `name` field, honouring `exactOptionalPropertyTypes`; `Custom('x', {…})` stores `type: 'custom'` and `customType: 'x'`. |
| `test/type/params-typing.test.ts` | `decorators/params.ts` | A `@ts-expect-error` control on a handler whose parameter type disagrees with its source — self-validating, since an unused directive is itself a compile error. Proves the probe's result holds against the real exported types. |
| `test/unit/metadata-shape.test.ts` | `metadata/metadata-store.ts`, all decorator files | Field-by-field comparison of the stored records against the committed legacy baseline fixture (§3.5), including the fields that must be **absent**. |
| `test/unit/controller.test.ts` | `decorators/controller.ts` | `@Controller` / `@Version` compose into the effective path; the class decorator receives the constructor and the members' metadata together. |
| `test/unit/http.test.ts` | `decorators/http.ts` | Each verb records its binding; two verb decorators on one method produce two routes sharing the method's other metadata. |
| `test/unit/injection.test.ts` | `decorators/injection.ts` | `@Inject('a', Optional('b'))` yields the token list `['a','b']` and the optional index set `{1}`; `@Injectable({ token, scope })` records both. |
| `test/unit/security.test.ts` | `decorators/security.ts` | `@Roles` / `@Permissions` at class and method level; `@Public` precedence; `Ctx()` carries the M64 marker and `isContextParameter` still recognises it. |
| `test/unit/pipeline.test.ts` | `decorators/pipeline.ts` | Class-level and method-level application; a class implementing `IMiddleware` is normalised per invocation. |
| `test/unit/validation.test.ts` | `decorators/validation.ts` | Each schema lands on the route record in the field M70n's enforcement path reads. |
| `test/unit/openapi.test.ts` | `decorators/openapi.ts` | Operation, response and tag records match the shapes `openapi-plugin`'s generator reads. |
| `test/unit/custom.test.ts` | `decorators/custom.ts` | `createDecorator` in both the class and the method position; the removal of `createParameterDecorator` is pinned by the barrel test below. |
| `test/unit/barrel-exports.test.ts` | `src/index.ts` | Compile-time assertions declared **against the barrel**, so a dropped export fails `deno check` rather than leaving every runtime assertion green (the M56 defect class). Pins `createParameterDecorator` absent and `Params` / `Custom` / `ParamSource` present. |
| `test/integration/decorator-plugin.test.ts` | `plugin/decorator-plugin.ts` | A real `createApplication` + `inject` app: a decorated controller serves a request, `@Params` values arrive in the right order, and a generated write handler answers its intended status through `Ctx()`. |
| `test/integration/di-construction.test.ts` | `plugin/decorator-plugin.ts` | Both construction paths — DI container present, and service registry only — resolve the same `@Inject` list, with `Optional` yielding `undefined` for an absent provider and propagating a throwing factory. |
| `test/e2e/cross-copy-context.test.ts` | `decorators/security.ts` | The retained M64 test: two genuinely separate module instances under distinct URLs, with the vacuity guard asserting the copies really are distinct. |
| `packages/openapi-plugin/test/integration/openapi-integration.test.ts` | consumer | Migrated to the new call shape; asserts the generated document is unchanged, which is what proves the storage shape held (§3.4). |
| `packages/starters/rest-starter/test/**` | consumer | Migrated; the starter's default composition stays byte-identical. |
| `packages/cli/test/e2e/generate-e2e.test.ts` | CLI emission | Scaffold, generate every gated artifact, type-check against this workspace, and **boot** — a real request through a generated controller and a generated module (§3.8). |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` | CLI emission | The M63 gate: format, lint, install, type-check and boot each template, without a blanket permission grant. |
| `packages/cli/test/unit/scaffold-permissions.test.ts` | CLI manifests | Inverted — asserts no template stamps `experimentalDecorators` anywhere. |

**Negative controls** (each observed failing, then reverted): restore `experimentalDecorators` to a
package manifest and confirm nothing depends on it; break the `@Params` tuple order and watch the
integration request receive its arguments transposed; drop the `bridgeIntoStore` call from
`@Controller` and watch every route vanish; and delete a barrel export to confirm the compile-time
barrel assertion fails rather than the suite staying green.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m76-standard-decorators, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint              # the experimentalDecorators warning must be GONE from this run
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:apps        # apps/di-decorators migrated and still passing its smoke
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.9
```

## 8. Risks & mitigations

- **The rewrite is large and its output is read by another package.** 3,136 lines change and
  `openapi-plugin` consumes the stored shapes. Mitigated by §3.5's captured legacy baseline and by
  keeping the storage shape frozen (§3.4), so a regression is attributable to the capture mechanism
  alone.
- **Generated output changes for already-scaffolded projects.** A project generated before this
  milestone carries decorated source that no longer parses once its manifest loses the flag.
  Mitigated by CHANGELOG migration text naming the exact edit per decorator, and by keeping the
  removal loud — every stale call site is a compile error, never a silent behaviour change.
- **M63's D3 trap (declaring any compiler option replaces Deno's default set).** Probed here and it
  did not reproduce on Deno 2.9.5 for the JSX default, so the mechanism recorded in M63 needs
  re-establishing rather than trusting. Mitigated by removing compiler options rather than adding
  any, which makes the trap unreachable regardless of which reading is correct, and by the
  `full-stack` template being untouched — it already declares the flag deliberately absent.
- **`tsx` on the generated Node target.** It currently reads the `experimentalDecorators` the
  generated `tsconfig.json` sets. Whether it transpiles standard decorators without it is a fact
  about a third-party tool. Mitigated by a real `npm install` + `npm start` boot of a generated Node
  project, per M61's precedent, rather than by reading its documentation.
- **A consumer outside this repository.** The published alpha carries the legacy surface. Mitigated
  by the CHANGELOG entry and by the prerelease scope note in AI_GUIDELINES §9, which permits removal
  with migration text during `0.x`.

## 9. Out of scope

- **Retiring the decorator surface.** M65 made the functional style the default; decorators remain
  opt-in and this milestone keeps that opt-in working.
- **Type-inferred injection.** `emitDecoratorMetadata` is unsupported by Deno and absent repo-wide,
  so tokens and sources stay explicit. Nothing here changes that calculus.
- **Broker trace propagation** — M75.
- **A dual legacy-and-standard surface.** Considered and rejected at plan time in favour of the full
  migration, on the maintainer's decision; the legacy form is deleted rather than deprecated.
