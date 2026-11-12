# Milestone 137a — OpenAPI document metadata, deprecation and per-route exclusion (`@setu-ts/openapi-plugin` + `common` + `decorator-plugin` + `sdk`)

> **Status:** Planning. Branch: `feat/m137a-openapi-document-metadata`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR into `develop`.

## 0. Objective & scope

The generated OpenAPI document cannot describe who owns an API, under what licence, or which
operations are on their way out, and it cannot hide one method on a path while keeping another. This
milestone adds the OpenAPI 3.1 document-level metadata objects (`contact`, `license`,
`termsOfService`, `externalDocs`, top-level `tags`), a per-operation `deprecated` flag, and a
per-route `excludeFromDocument` flag. It also makes a generated client mark a deprecated operation
`@deprecated`, so an editor flags the call site. The boundary is ROADMAP M137a: no new derivation
from middleware brands (that is M137b), and no change to request bodies (M137c).

- **In scope:** two optional `RouteSchema` fields (`deprecated`, `excludeFromDocument`) and the same
  two on `ApiOperationConfig`; five optional `OpenApiGeneratorOptions` fields (`contact`, `license`,
  `termsOfService`, `externalDocs`, `tags`) threaded through `OpenApiService` and `OpenApiPlugin`;
  one named refusal for invalid document options, raised at `register()` time and at generator
  construction; `isRouteExcluded` honouring `excludeFromDocument`; the `deprecated` field on
  `SdkOpenApiOperation` and `@deprecated` in generated clients; READMEs, PUBLIC_API.md, CHANGELOG,
  ROADMAP and CLAUDE.md status.
- **NOT this milestone:** derived 401/403/415/429 responses and declared response headers (M137b);
  form bodies and file uploads (M137c); RFC 9745 `Deprecation`/`Sunset` response headers (ROADMAP
  M137a "Out of scope" — the field is documentation, not behaviour); operation-level `externalDocs`
  (no consumer asked; not in the ROADMAP decision list).

## 1. Contracts verified from SOURCE (not names)

| Reference                                              | Source (file:line)                                                                                                                      | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RouteSchema`                                          | `packages/common/src/http.ts:538`                                                                                                       | Fields: `body`, `query`, `params`, `headers`, `response`, `tags`, `summary`, `operationId` (0.10.0), `description` (0.10.0), `security` (0.2.0, line 600). No `deprecated`, no exclusion flag.                                                                                                                                                                                                                                           |
| `isRouteExcluded(route, paths, owners)`                | `packages/openapi-plugin/src/generators/declared-operation-ids.ts:17`                                                                   | Returns `true` on an exact `route.path` match or an owner match. Internal (not exported from `src/index.ts`). Called by the generator (`#isExcluded`, `openapi-generator.ts:870`) and by the plugin's `onBootstrap` id check (`openapi-plugin.ts:240-243`).                                                                                                                                                                              |
| `claimDeclaredOperationIds(routes, isExcluded)`        | `packages/openapi-plugin/src/generators/declared-operation-ids.ts:27`                                                                   | Skips every route for which `isExcluded` returns `true`, then throws `OperationIdError` on a blank or duplicate declared id. So a predicate change in `isRouteExcluded` reaches both call sites with no other edit.                                                                                                                                                                                                                      |
| `OpenApiGenerator.generate()` exclusion                | `packages/openapi-plugin/src/generators/openapi-generator.ts:655-735`                                                                   | Both the count pass (line ~696) and the emit loop (line ~725) skip `#isExcluded(route)`; the declared-id claim at line 703 uses the same predicate.                                                                                                                                                                                                                                                                                      |
| `OpenApiDocument.info` / emitted `info`                | `openapi-generator.ts:134` (type), `:749` (emit)                                                                                        | Type and emission carry only `title`, `version`, `description`. No top-level `tags` or `externalDocs` on the type.                                                                                                                                                                                                                                                                                                                       |
| `OpenApiOperation`                                     | `openapi-generator.ts:178`                                                                                                              | Has `operationId`, `summary`, `description`, `tags`, `parameters`, `requestBody`, `responses`, `x-setu-unrepresentable`, `security`. No `deprecated`.                                                                                                                                                                                                                                                                                    |
| `#createOperation`                                     | `openapi-generator.ts:790`                                                                                                              | Builds the operation from `#effectiveSchema(route).schema`; `summary`/`description`/`tags` spread conditionally; key order `operationId, summary, description, tags, parameters, requestBody, responses, x-setu-unrepresentable, security`.                                                                                                                                                                                              |
| `OpenApiGeneratorOptions`                              | `openapi-generator.ts:276`                                                                                                              | `title`, `version`, `description`, `servers`, `securitySchemes`, `security`, `deriveSecurity`, `exclude`, `excludeOwners`, `deriveRequestSchemas`, `deriveResponseStatus`. The generator constructor (`:557`) copies each option by name — an option not listed there is dropped.                                                                                                                                                        |
| Option threading — service                             | `packages/openapi-plugin/src/services/openapi-service.ts:41`                                                                            | `#makeGeneratorOptions()` copies options **by name**; a new option not added here never reaches the generator.                                                                                                                                                                                                                                                                                                                           |
| Option threading — plugin                              | `packages/openapi-plugin/src/plugin/openapi-plugin.ts:85-101, 154-168`                                                                  | `OpenApiPlugin` destructures options **by name** and passes each to `new OpenApiService({...})`. The generator (and so its constructor) is built lazily inside `getSpec()` (`openapi-service.ts:121`), i.e. on the first `/openapi.json` request — a constructor-only refusal would surface on a request, not at startup. The plugin already validates `securitySchemes` names in `register()` (`:134-151`).                             |
| `OpenApiPluginOptions extends OpenApiGeneratorOptions` | `openapi-plugin.ts:21`                                                                                                                  | New generator options become plugin options by inheritance; only the destructure and pass-through need editing.                                                                                                                                                                                                                                                                                                                          |
| `ApiOperationConfig` / `ApiOperation`                  | `packages/decorator-plugin/src/decorators/openapi.ts:20, 64`                                                                            | Config: `operationId`, `summary`, `description`. The decorator copies each defined field into `meta.openapi` (`OpenApiMetadata`).                                                                                                                                                                                                                                                                                                        |
| `OpenApiMetadata` (internal)                           | `packages/decorator-plugin/src/metadata/metadata-store.ts:85`                                                                           | `operationId`, `summary`, `description`, `responses`, `tags`. NOT exported from `decorator-plugin/src/index.ts` (checked: index exports only `ApiOperation`, `ApiResponse`, `ApiTags`, `ApiOperationConfig`, `ApiResponseConfig` from the openapi decorators).                                                                                                                                                                           |
| `buildRouteSchema`                                     | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:669`                                                                          | Copies `summary`/`operationId`/`description` from `route.openapi` into the `RouteSchema`, and returns `undefined` early when none of a fixed list of fields is present (lines ~688-697). A new field must be added to BOTH the early-return condition and the returned object, or a route whose only OpenAPI metadata is `deprecated: true` loses it.                                                                                    |
| `SdkOpenApiOperation`                                  | `packages/sdk/src/codegen/openapi-types.ts:70`                                                                                          | Exported from `sdk/src/index.ts:57`. Fields: `operationId?`, `summary?`, `description?`, `tags?`, `parameters?`, `requestBody?`, `responses?`. No `deprecated`.                                                                                                                                                                                                                                                                          |
| Generated client shape                                 | `packages/sdk/src/codegen/openapi-codegen.ts:1300-1318, 1336`                                                                           | Pass 3 emits `export interface <Api>` with one member per operation and **no comment**; pass 4 emits each method as `/** <operationId> */ function <name>(…)`. `createApi` is declared to return the interface, so a caller's `api.foo()` resolves to the interface member — the deprecation must be on the interface member for an editor to strike it through.                                                                         |
| `escapeBlockComment`                                   | `openapi-codegen.ts:276`                                                                                                                | Collapses line breaks and escapes `*/`. Any new comment text derived from the document goes through it. `@deprecated` itself is a constant.                                                                                                                                                                                                                                                                                              |
| `setu client` formatting                               | `packages/cli/src/client/generate.ts:1-45`                                                                                              | Runs the SDK's `generateOpenApiClient` and then the project's Prettier (`formatForTarget`), so the emitted JSDoc must be Prettier-stable; `client:check` compares the formatted file.                                                                                                                                                                                                                                                    |
| CLI client e2e                                         | `packages/cli/test/e2e/client-e2e.test.ts:51-99`                                                                                        | Scaffolds a REST project, adds a `/m129` route by editing `setu.config.ts`, regenerates the client and calls it against a running server. This is where the ROADMAP gate "`setu client` output containing `@deprecated`" lands.                                                                                                                                                                                                          |
| `mcp-plugin` reads of `RouteSchema`                    | `packages/mcp-plugin/src/compile/discovery.ts`                                                                                          | Reads `operationId` to name a tool; tools come from the `mcpTool()` marker, not from the document. `excludeFromDocument` therefore does not hide an MCP tool (see §3.6).                                                                                                                                                                                                                                                                 |
| OpenAPI 3.1.0 objects                                  | OpenAPI Specification 3.1.0 §4.8.2 Info, §4.8.3 Contact, §4.8.4 License, §4.8.11 External Documentation, §4.8.22 Tag, §4.8.10 Operation | `info.termsOfService` (string), `info.contact` `{ name?, url?, email? }`, `info.license` `{ name (REQUIRED), identifier?, url? }` — "The `identifier` field is mutually exclusive of the `url` field"; top-level `externalDocs` `{ description?, url (REQUIRED) }`; top-level `tags` `[{ name (REQUIRED), description?, externalDocs? }]` — "Each tag name in the list MUST be unique"; operation `deprecated` boolean, default `false`. |
| Next release version                                   | `CHANGELOG.md` `[Unreleased]`                                                                                                           | Already carries BREAKING entries (#583), so the next release is `0.13.0`; new symbols take `@since 0.13.0`.                                                                                                                                                                                                                                                                                                                              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                      | Resolution (picked side)                                                                                                                                                                                                                                      | Doc deliverable (same PR)                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| C1  | ROADMAP M137a decision 3 says the `license` refusal happens "at construction". The generator is constructed lazily on the first spec request (§1, option threading — plugin), so construction-only would refuse on a request, not at startup. | The refusal runs through one shared validator (§3.4) in the `OpenApiService` constructor — which `OpenApiPlugin.register()` calls synchronously, so applications are refused at startup — and in the `OpenApiGenerator` constructor for direct generator use. | None needed in ROADMAP (its gate wording, "the `license` refusal", still holds); the README states startup refusal. |
| C2  | ROADMAP M137a decision 3 names only the `license` refusal. OpenAPI 3.1 also requires unique tag names in the top-level `tags` list (§1).                                                                                                      | Duplicate tag names are refused by the same validator with their own `reason`. Emitting a list the specification forbids is the same class of defect as the `license` case.                                                                                   | Note the added refusal in the PR body and CHANGELOG entry.                                                          |

## 3. Design decisions

### 3.1 `RouteSchema.deprecated` and `RouteSchema.excludeFromDocument`

- **Decision:** `packages/common/src/http.ts` `RouteSchema` gains `readonly deprecated?: boolean`
  and `readonly excludeFromDocument?: boolean`, each with JSDoc and `@since 0.13.0`. Only the value
  `true` has an effect; `false` and omission are equivalent. No new export from `common`'s index.
- **Why:** both are route metadata, like `operationId`; the functional entry point
  (`app.router.get(path, { schema })`) needs no other API.
- **Test home:** `packages/openapi-plugin/test/unit/document-metadata.test.ts`;
  `packages/openapi-plugin/test/integration/document-metadata-entry-points.test.ts`.

### 3.2 `deprecated` emission

- **Decision:** `#createOperation` adds
  `...(schema?.deprecated === true ? { deprecated: true } : {})` immediately after the `tags`
  spread. `OpenApiOperation` gains `readonly deprecated?: boolean` (`@since 0.13.0`).
  `deprecated: false` is never emitted, so a document with no deprecated route is byte-identical to
  today's.
- **Why:** OpenAPI's default is `false`; emitting it would change every existing document and every
  `client:check`.
- **Test home:** `document-metadata.test.ts` (present on a deprecated route, absent on a
  `deprecated: false` route and on an unmarked route).

### 3.3 Exclusion through the one existing predicate

- **Decision:** `isRouteExcluded` gains a first check
  `if (route.definition.schema?.excludeFromDocument === true) return true;` before the path and
  owner checks. No other call site changes: the generator's count pass, emit loop and declared-id
  claim, and the plugin's `onBootstrap` id check, all go through it (§1).
- **Why:** ROADMAP M137a decision 2. A hidden route's `operationId` can then never cause an
  `OperationIdError`, at startup or in `generate()`, because `claimDeclaredOperationIds` skips it.
- **Test home:** `declared-operation-ids.test.ts` (predicate rows: flag true, flag false, flag
  absent, path match, owner match); `document-metadata.test.ts` (hidden `DELETE` beside documented
  `GET` on `/users/:id`: the path item has `get` and no `delete`);
  `document-metadata-entry-points.test.ts` (a hidden route whose declared `operationId` duplicates a
  visible route's: plugin boots and `/openapi.json` answers 200).

### 3.4 Document-level options and the one validator

- **Decision:** `OpenApiGeneratorOptions` gains, each `@since 0.13.0`:
  - `contact?: { readonly name?: string; readonly url?: string; readonly email?: string }` →
    `info.contact`
  - `license?: { readonly name: string; readonly identifier?: string; readonly url?: string }` →
    `info.license`
  - `termsOfService?: string` → `info.termsOfService`
  - `externalDocs?: OpenApiExternalDocs` → top-level `externalDocs`
  - `tags?: readonly OpenApiTag[]` → top-level `tags`

  with two new exported types in `openapi-generator.ts`:
  `OpenApiExternalDocs { readonly url: string; readonly description?: string }` and
  `OpenApiTag { readonly name: string; readonly description?: string; readonly externalDocs?: OpenApiExternalDocs }`.
  `OpenApiDocument` gains `info.contact`, `info.license`, `info.termsOfService`, top-level `tags`
  and top-level `externalDocs`.

  Emission order inside `info`: `title, version, description, termsOfService, contact, license` (the
  specification's field order, after the three existing keys). Top-level order:
  `openapi, info, servers, security, paths, components, tags, externalDocs` — the two new keys are
  appended after the existing ones (the specification's own order also puts them last), so a
  document gaining them keeps every existing byte as its prefix. Each field is spread only when
  supplied; objects are copied with only their defined keys (no `undefined` values reach the JSON).
  An empty `tags: []` is not emitted.

  One internal module, `src/generators/document-metadata.ts` (NOT exported from `src/index.ts`),
  exports `validateDocumentMetadata(options: OpenApiGeneratorOptions): void`, which throws the new
  exported `OpenApiDocumentOptionsError` (in `src/errors.ts`, beside `OperationIdError`, same shape:
  `readonly reason`, `name`, message) when:
  - `license.identifier` and `license.url` are both defined →
    `reason: 'license-identifier-and-url'`, message names both values' keys and cites OpenAPI 3.1
    §4.8.4;
  - two `tags` entries share a `name` → `reason: 'duplicate-tag'`, message names the tag.

  `validateDocumentMetadata` is called from exactly two constructors: `OpenApiGenerator` (direct
  generator use) and `OpenApiService` (`openapi-service.ts`). `OpenApiPlugin.register()` constructs
  the service synchronously (`openapi-plugin.ts:154`), so the plugin refuses at registration with no
  extra call, and a direct `new OpenApiService(...)` user is refused at construction too rather than
  on the first `getSpec()`. The same module exports one `buildDocumentMetadata(options)` returning
  `{ info: <termsOfService/contact/license entries>, top: <tags/externalDocs entries> }`, used by
  `generate()`, so emission has one implementation.

  Options are threaded by name in `OpenApiService.#makeGeneratorOptions()` and in the
  `OpenApiPlugin` destructure / `new OpenApiService({...})` call, and copied in the generator
  constructor's `#options` object.

- **Why:** ROADMAP M137a decision 3, plus C1/C2. URL and email formats are not validated: the
  specification says "MUST be in the form of a URL", the generator is not a URL validator, and a
  refusal on an application's own metadata string would be a new failure mode with no defect behind
  it.
- **Test home:** `document-metadata.test.ts` (field-by-field `info` and top-level assertions with
  absent fields asserted absent; each refusal through the generator constructor);
  `document-metadata-entry-points.test.ts` (plugin path: every option reaches `/openapi.json`; each
  refusal rejects `app.start()` — the precedent `openapi-integration.test.ts:975` uses — before any
  request).

### 3.5 Decorator entry point

- **Decision:** `ApiOperationConfig` gains `readonly deprecated?: boolean` and
  `readonly excludeFromDocument?: boolean` (`@since 0.13.0`). `ApiOperation` copies each when
  defined into `meta.openapi`; internal `OpenApiMetadata` gains the two fields; `buildRouteSchema`
  adds both to its early-return condition and spreads each into the returned `RouteSchema` when
  `=== true`.
- **Why:** ROADMAP M137a decision 1 — both entry points write the same metadata.
- **Test home:** `packages/decorator-plugin/test/unit/openapi-decorator.test.ts` (metadata stored);
  `document-metadata-entry-points.test.ts` (one functional route and one decorated route, each
  deprecated and each hidden, produce identical operation objects and identical omission; a
  decorated route whose ONLY metadata is `@ApiOperation({ deprecated: true })` keeps it, which fails
  without the early-return edit).

### 3.6 Hidden routes stay served, and stay MCP tools

- **Decision:** `excludeFromDocument` affects only the OpenAPI document. The route is still
  registered, still answers, still appears in `router.listRoutes()`, and — when it carries an
  `mcpTool()` marker — is still an MCP tool. This is stated in the `RouteSchema` JSDoc and the
  openapi-plugin README.
- **Why:** hiding from documentation is not access control. Coupling it to MCP would be a second,
  undocumented meaning of the flag.
- **Test home:** `document-metadata-entry-points.test.ts` (a hidden route answers its request via
  `inject()`). No MCP test: no code path changes there.

### 3.7 `@deprecated` in generated clients

- **Decision:** `SdkOpenApiOperation` gains `readonly deprecated?: boolean` (`@since 0.13.0`). In
  `openapi-codegen.ts`, when `entry.operation.deprecated === true`:
  - pass 3 emits `  /** @deprecated */` on the line before that operation's interface member;
  - pass 4 replaces the `/** <operationId> */` line with the three-line block `/**`,
    ` * <operationId>`, ` * @deprecated`, ` */` at the same indent (operationId still through
    `escapeBlockComment`).

  A non-deprecated operation's output is unchanged byte for byte.

- **Why:** ROADMAP M137a decision 4. The interface member is what a call site resolves to (§1), so
  without it no editor would flag `api.foo()`.
- **Test home:** `packages/sdk/test/unit/codegen/openapi-codegen.test.ts` (text assertions; output
  for a document without `deprecated` equals the pre-change output); a TypeScript-compiler test in
  the same file that compiles the generated module plus a call site with the `typescript` compiler
  API and asserts a suggestion diagnostic with code `6385` ("is deprecated") on the call to the
  deprecated method and none on the other; `packages/cli/test/e2e/client-e2e.test.ts` (the gate:
  `setu client` output after Prettier contains `@deprecated` above the deprecated member and omits
  the hidden route's method, and `client:check` passes on the regenerated file).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Every addition is an optional field on an existing interface or
a new export; `OpenApiDocument`, `OpenApiOperation` and `SdkOpenApiOperation` are output types an
application reads, and gaining optional fields does not break a reader.

| Exported symbol                                                                             | Kind             | Consumer / real code path that READS it                                                                             |
| ------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `RouteSchema.deprecated` (common)                                                           | interface field  | `OpenApiGenerator.#createOperation` (§3.2)                                                                          |
| `RouteSchema.excludeFromDocument` (common)                                                  | interface field  | `isRouteExcluded` (§3.3) — generator passes and plugin bootstrap check                                              |
| `ApiOperationConfig.deprecated` / `.excludeFromDocument` (decorator-plugin)                 | interface fields | `ApiOperation` → `OpenApiMetadata` → `buildRouteSchema` → `RouteSchema` (§3.5)                                      |
| `OpenApiGeneratorOptions.contact/license/termsOfService/externalDocs/tags` (openapi-plugin) | options          | `validateDocumentMetadata` and the document builder in `generate()` (§3.4); see §4.1                                |
| `OpenApiExternalDocs` (openapi-plugin)                                                      | type             | Type of `OpenApiGeneratorOptions.externalDocs`, `OpenApiTag.externalDocs`, `OpenApiDocument.externalDocs`           |
| `OpenApiTag` (openapi-plugin)                                                               | type             | Type of `OpenApiGeneratorOptions.tags` and `OpenApiDocument.tags`                                                   |
| `OpenApiDocumentOptionsError` (openapi-plugin)                                              | class            | Thrown by `validateDocumentMetadata` (§3.4); applications catch it by `instanceof`/`reason` like `OperationIdError` |
| `OpenApiDocument.info.contact/license/termsOfService`, `.tags`, `.externalDocs`             | type fields      | Produced by `generate()`; read by `/openapi.json` consumers and `setu client`                                       |
| `OpenApiOperation.deprecated`                                                               | type field       | Produced by `#createOperation`; read by `sdk` codegen through `SdkOpenApiOperation.deprecated`                      |
| `SdkOpenApiOperation.deprecated` (sdk)                                                      | type field       | `openapi-codegen.ts` passes 3 and 4 (§3.7)                                                                          |

### 4.1 Options — every option names its consumer

| Option                            | Consumer                                                                      | Behavior (per implementation)                                                                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contact`                         | document builder → `info.contact`                                             | Copied with defined keys only; absent → no `contact` key.                                                                                                                                                                                |
| `license`                         | `validateDocumentMetadata`; document builder → `info.license`                 | Both `identifier` and `url` → `OpenApiDocumentOptionsError('license-identifier-and-url')`; else copied, defined keys only.                                                                                                               |
| `termsOfService`                  | document builder → `info.termsOfService`                                      | Copied verbatim; absent → no key.                                                                                                                                                                                                        |
| `externalDocs`                    | document builder → top-level `externalDocs`                                   | Copied with defined keys only; absent → no key.                                                                                                                                                                                          |
| `tags`                            | `validateDocumentMetadata`; document builder → top-level `tags`               | Duplicate `name` → `OpenApiDocumentOptionsError('duplicate-tag')`; `[]` or absent → no key; else each entry copied in order, defined keys only. Route-level tag names are NOT required to appear here (OpenAPI permits undeclared tags). |
| All five, on `OpenApiPlugin(...)` | plugin destructure → `OpenApiService` → `#makeGeneratorOptions()` → generator | Identical output to passing them to `new OpenApiGenerator(...)` directly; validated in `register()`.                                                                                                                                     |

## 5. Implementation files

| File                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Purpose                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/http.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `RouteSchema.deprecated`, `RouteSchema.excludeFromDocument` with JSDoc (§3.1, §3.6)                                                                                         |
| `packages/openapi-plugin/src/errors.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `OpenApiDocumentOptionsError`                                                                                                                                               |
| `packages/openapi-plugin/src/generators/document-metadata.ts` (new, internal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `validateDocumentMetadata`, document `info`/`tags`/`externalDocs` builder                                                                                                   |
| `packages/openapi-plugin/src/generators/declared-operation-ids.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `isRouteExcluded` reads `excludeFromDocument`                                                                                                                               |
| `packages/openapi-plugin/src/generators/openapi-generator.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | option types, `OpenApiTag`, `OpenApiExternalDocs`, document/operation type fields, constructor copy + validation, `generate()` emission, `deprecated` in `#createOperation` |
| `packages/openapi-plugin/src/services/openapi-service.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | thread the five options; call `validateDocumentMetadata` in the constructor                                                                                                 |
| `packages/openapi-plugin/src/plugin/openapi-plugin.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | destructure + pass the five options to `new OpenApiService(...)` (the service constructor validates)                                                                        |
| `packages/openapi-plugin/src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | export `OpenApiDocumentOptionsError`, `OpenApiTag`, `OpenApiExternalDocs`                                                                                                   |
| `packages/decorator-plugin/src/decorators/openapi.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `ApiOperationConfig` fields; `ApiOperation` copies them                                                                                                                     |
| `packages/decorator-plugin/src/metadata/metadata-store.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `OpenApiMetadata` fields (internal)                                                                                                                                         |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `buildRouteSchema` early-return condition and spreads                                                                                                                       |
| `packages/sdk/src/codegen/openapi-types.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `SdkOpenApiOperation.deprecated`                                                                                                                                            |
| `packages/sdk/src/codegen/openapi-codegen.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `@deprecated` on the interface member and the method                                                                                                                        |
| Docs: `packages/openapi-plugin/README.md`, `packages/decorator-plugin/README.md`, `packages/sdk/README.md` (its codegen section, `README.md:371`), the `AGENT_CARD.md` of openapi-plugin, decorator-plugin and sdk ("Behaviour the types do not show": a hidden route is still served; refusal at startup; `@deprecated` on generated members), `PUBLIC_API.md`, `CHANGELOG.md` (`### Added`, naming `OpenApiDocumentOptionsError`, `OpenApiTag`, `OpenApiExternalDocs` for `check:changelog-coverage`), the README `## Exports` tables via `pnpm run docs:exports`, `ROADMAP.md` (137a row ✅), `CLAUDE.md` status, and this plan moved to `plans/archive/` | describe each option, both flags, the refusal, the hidden-route-still-served rule                                                                                           |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                               | src covered                                                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/openapi-plugin/test/unit/document-metadata.test.ts` (new)                     | `document-metadata.ts`, `openapi-generator.ts`, `errors.ts`          | `new OpenApiGenerator(options).generate(routes)`: `info` equals exactly `{ title, version, description, termsOfService, contact, license }` with absent sub-keys absent; top-level `tags`/`externalDocs` exact; no new keys when no option is given (deep-equal to a baseline document); `tags: []` emits no key; both refusals throw `OpenApiDocumentOptionsError` with the right `reason` from the constructor; `license` with only `identifier`, only `url`, neither — accepted; `deprecated: true` present, `false`/absent omitted; hidden `DELETE` beside visible `GET` on `/users/:id`.                             |
| `packages/openapi-plugin/test/unit/declared-operation-ids.test.ts` (extend)             | `declared-operation-ids.ts`                                          | `isRouteExcluded` table rows (flag true / false / absent × path / owner); `claimDeclaredOperationIds` skips a hidden duplicate id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/openapi-plugin/test/integration/document-metadata-entry-points.test.ts` (new) | `openapi-plugin.ts`, `openapi-service.ts`, decorator path end to end | Kernel app with `OpenApiPlugin({ contact, license, termsOfService, externalDocs, tags })`: `/openapi.json` carries each; each refusal rejects `app.start()` (no request made; precedent `openapi-integration.test.ts:975`); one functional route and one `@Controller` route (DecoratorPlugin) each `deprecated` produce identical operation objects; each hidden route absent from the document and still answering `inject()`; a hidden route duplicating a visible `operationId` boots and serves 200; a decorated route with only `@ApiOperation({ deprecated: true })` is deprecated in the document.                |
| `packages/openapi-plugin/test/unit/openapi-service.test.ts` (extend)                    | `openapi-service.ts`                                                 | `new OpenApiService({ app, license: { name, identifier, url } })` throws `OpenApiDocumentOptionsError` at construction, before any `getSpec()`; valid options reach `getSpec()`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/openapi-plugin/test/unit/barrel-exports.test.ts` (extend)                     | `index.ts`                                                           | `OpenApiDocumentOptionsError` exported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/decorator-plugin/test/unit/openapi-decorator.test.ts` (extend)                | `decorators/openapi.ts`, `metadata-store.ts`                         | `@ApiOperation({ deprecated: true, excludeFromDocument: true })` stores both; omitted fields not stored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/decorator-plugin/test/integration/decorator-plugin.test.ts` (extend)          | `plugin/decorator-plugin.ts`                                         | `buildRouteSchema` is module-private and has no direct test, so it is driven through `DecoratorPlugin`: a controller method whose ONLY metadata is `@ApiOperation({ deprecated: true })` (resp. `excludeFromDocument: true`) registers a route whose `router.listRoutes()` entry has `definition.schema` equal to `{ deprecated: true }` (resp. `{ excludeFromDocument: true }`). Fails without the early-return edit.                                                                                                                                                                                                    |
| `packages/sdk/test/unit/openapi-codegen.test.ts` (extend)                               | `openapi-codegen.ts`, `openapi-types.ts`                             | `generateOpenApiClient(doc)` emits `/** @deprecated */` above the interface member and the three-line block above the method only for the deprecated operation; for a two-operation document without `deprecated`, the output equals the output of the same document with `deprecated: false` on both (and an inline expected string pinned from the pre-change generator); TypeScript compiler API (`typescript` is already a devDependency of the workspace): compiling the generated module plus a call site yields a suggestion diagnostic with `reportsDeprecated: true` on `api.oldOp()` and none on `api.newOp()`. |
| `packages/cli/test/e2e/client-e2e.test.ts` (extend)                                     | gate only (no cli `src` change)                                      | In the existing test, the edited `setu.config.ts` also registers a deprecated route and a hidden route; after `client`, `src/clientsdk/api.ts` contains `@deprecated` before the deprecated member and no method for the hidden route; `client:check`, `check`, `lint` and `format:check` pass.                                                                                                                                                                                                                                                                                                                           |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m137a-openapi-document-metadata
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run docs:exports        # regenerate the README `## Exports` tables for the three new exports
pnpm run check:docs          # since tags, CHANGELOG names every new export, generate-api-docs baseline
pnpm test:coverage packages/common packages/openapi-plugin packages/decorator-plugin packages/sdk --no-tooling
pnpm run test:deno-lane
pnpm run ci:local            # final commit, after M139g's suite is not running
pnpm run release:publish --dry-run
pnpm run release:verify 0.12.0
```

No committed-tree security audit: nothing here crosses a trust boundary (the new inputs are the
application's own options and route metadata, and the only output is the document it already
serves).

Read the ANSI-stripped per-file tables; every changed `src` file ≥90% branch/function/line. The CLI
e2e runs under `pnpm run ci:local --shard cli`.

## 8. Risks & mitigations

- **An option added to the generator but not threaded through the service or plugin is silently
  dropped** (both copy options by name, §1). → The integration test passes every new option through
  `OpenApiPlugin` and asserts it in `/openapi.json`, not only through the generator.
- **Refusal only at lazy construction would surface on the first request.** → §3.4 validates in the
  `OpenApiService` constructor, which `register()` runs; the integration test asserts that
  `app.start()` rejects with no request made.
- **Changing existing documents.** → Every emission is conditional on `=== true` or a supplied
  option; a baseline-equality test pins the no-option output for both the document and the generated
  client.
- **Prettier reshaping the emitted JSDoc** so `client:check` drifts. → The CLI e2e runs `client`,
  then `client:check` and `format:check`.
- **A decorated route whose only metadata is the new flag losing it** (the `buildRouteSchema` early
  return). → Dedicated test rows in §6.

## 9. Out of scope

- Derived 401/403/415/429 responses, idempotency headers, declared response headers — M137b.
- Form bodies and file uploads in the document and client — M137c.
- RFC 9745 `Deprecation` / `Sunset` response headers — ROADMAP M137a "Out of scope".
- Operation-level `externalDocs`, multiple documents per application, webhooks — ROADMAP M137
  deferred list.
- Validating `contact.url`, `contact.email`, `license.url`, `termsOfService` formats — §3.4 "Why".
