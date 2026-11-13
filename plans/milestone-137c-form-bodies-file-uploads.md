# Milestone 137c — Form bodies and file uploads (`@setu-ts/common`, `@setu-ts/validation-plugin`, `@setu-ts/openapi-plugin`, `@setu-ts/sdk`)

> **Status:** Planning. Branch: `feat/m137c-form-bodies-file-uploads`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR into `develop`.

## 0. Objective & scope

A route validated with `validateBody(schema, { forms: true })` accepts JSON, urlencoded and
multipart bodies, but its OpenAPI document says `application/json` only, a file field renders as
`{}` with an `x-setu-unrepresentable` diagnostic, and the generated client reads only
`application/json` and sends only JSON. This milestone makes the document list the media types the
route accepts, describes a file field as `format: binary`, and makes the generated client send
`FormData` for a multipart-only body — so a document and the client generated from it agree with the
route. The boundary is the request body of a validated route: response bodies, non-form encodings
and the storage plugin's upload middleware are untouched.

- **In scope:**
  - `common`: `RouteValidationMetadata.forms?: true`; a form-file schema brand
    (`FORM_FILE_METADATA`, `FormFileMetadata`, `withFormFileMetadata`, `formFileMetadataOf`).
  - `validation-plugin`: both entry points record `forms` in the brand; a new subpath
    `@setu-ts/validation-plugin/zod` exporting `formFile({ mimeTypes?, maxBytes? })`, with `zod` as
    an optional peer (user decision 2026-11-13).
  - `scripts/node-dependency-ranges.ts` + `scripts/node-manifests.ts`: an `optional-peer` override
    kind, so a value import from one subpath classifies as an optional peer.
  - `openapi-plugin`: request-body media types from the brand, `format: binary` for a branded field,
    the multipart `encoding` object.
  - `sdk`: `ClientRequest.multipart`, its `FormData` encoding in the HTTP client, codegen selecting
    JSON or multipart and mapping `format: binary` to `Blob`, an `OpenApiCodegenError` for an
    unsupported body.
  - Docs: the validation-plugin README's and `docs/cli.md`'s stated limit removed; openapi-plugin,
    sdk, validation-plugin, common READMEs, AGENT_CARDs, PUBLIC_API.md, CHANGELOG, upgrading note.
- **NOT this milestone:**
  - `application/*+json` media types in the document (accepted at runtime, listed as
    `application/json` only — unchanged, as in ASP.NET Core).
  - The storage plugin's `uploadMiddleware` (it carries no validation brand; documenting it is a
    separate concern, unowned — §9).
  - Streaming uploads or a body bound per file (the request-size bound stays the DoS control).
  - Response bodies with file content (`format: binary` responses); M137 ends here.

## 1. Contracts verified from SOURCE (not names)

| Reference                                         | Source (file:line)                                                                                    | Verified surface / fact                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RouteValidationMetadata`                         | `packages/common/src/http.ts:914-919`                                                                 | `{ readonly target: ValidationTarget; readonly schema: unknown }` — no `forms`.                                                                                                                                                                                                                        |
| `withValidationMetadata` / `validationMetadataOf` | `http.ts:947-958`, `976-984`, guard `993-1009`                                                        | in-place non-enumerable `defineProperty`; reader narrows with `isRouteValidationMetadata` (object, `'schema' in`, known `target`), foreign value → `undefined`.                                                                                                                                        |
| brand on a non-function value                     | `packages/common/src/errors/status-hint.ts:141-149`                                                   | `withHttpStatusHint<T extends Error>(error, hint)`; reader takes `unknown`. Precedent for a brand on an object; nothing in common brands a schema yet.                                                                                                                                                 |
| `FormFile`                                        | `packages/common/src/form/form-body.ts:60-67`; exported `index.ts:243`                                | `{ readonly filename: string; readonly mimeType: string; readonly data: Uint8Array }` — no `size` (use `data.byteLength`). No `isFormFile` guard exists in common.                                                                                                                                     |
| multipart file part                               | `form-body.ts:270-273`; `form/multipart-parser.ts:35, 85, 185-186`                                    | a part is a file iff it has a `filename`; `mimeType` is the part's `Content-Type`, default `application/octet-stream` — **client-claimed, never sniffed**.                                                                                                                                             |
| `ValidationMiddlewareOptions.forms`               | `packages/common/src/services/validation.ts:105-117`; `middleware` `88-92`                            | `{ readonly forms?: boolean }`, read only for `body`.                                                                                                                                                                                                                                                  |
| `forms` read                                      | `packages/validation-plugin/src/middleware/validation-middleware.ts:197`                              | `const forms = target === 'body' && options?.forms === true;`                                                                                                                                                                                                                                          |
| body media types and 415                          | `validation-middleware.ts:78-113`                                                                     | with `forms`: urlencoded / multipart (`formEncodingOf`) or JSON; otherwise 415 `Unsupported Media Type`. Without: JSON (`application/json`, `application/*+json`) or 415.                                                                                                                              |
| form → record                                     | `validation-plugin/src/middleware/form-record.ts:5-28`                                                | first value scalar, repeat → array, `name[]` always array; values `string \| FormFile`.                                                                                                                                                                                                                |
| brand sites                                       | `validation-middleware.ts:217-248` (service path), `369-401` (helper, `396`)                          | both brand `{ target, schema }`; `forms` is in neither brand. Only `validateBody(schema, options?)` (`296-301`) takes options. `ValidationService.buildMiddleware` brands the policy-applied schema (`services/validation-service.ts:142-156`).                                                        |
| decorator forms                                   | `decorator-plugin/src/decorators/validation.ts:50-52`; `plugin/decorator-plugin.ts:750-752`           | `@ValidateBody(schema, { forms: true })` reaches the middleware as `options: { forms: true }` — so the decorated path is covered once the helper/service brands `forms`.                                                                                                                               |
| validation-plugin manifest                        | `packages/validation-plugin/package.json`; `tsconfig.json`                                            | `dependencies` = `@setu-ts/common` only; `zod-v4` dev only; one export `.`; `rootDir: src`.                                                                                                                                                                                                            |
| rest project deps                                 | `packages/cli/src/templates/module-seam.ts:31-32`; `scripts/node-dependency-ranges.ts:94`             | scaffolds carry `zod: '^4.6.6'`, satisfying the optional peer; the ranges table's `zod` range is `^4.6.6`.                                                                                                                                                                                             |
| Zod in the repo                                   | every `packages/*/package.json`                                                                       | no package imports Zod at runtime; all have `zod`/`zod-v4` as a dev dependency. Zod v4 only.                                                                                                                                                                                                           |
| subpath export precedent                          | `packages/localization-plugin/package.json:30-38`, `deno.json:7`                                      | `"./format": { types, default }` + Deno `exports["./format"]`. `runtime` has `./worker`.                                                                                                                                                                                                               |
| manifest classification                           | `scripts/node-manifests.ts:20-27, 270-286, 309-345`; kinds `scripts/node-dependency-ranges.ts:98-105` | `src` value import → `dependencies`; dynamic/type import → optional peer + dev mirror. Overrides: `'regular-dependency' \| 'dev-dependency-types'` only; an override whose target is not imported is refused.                                                                                          |
| request body emission                             | `packages/openapi-plugin/src/generators/openapi-generator.ts:969-978`                                 | `{ required: true, content: { 'application/json': { schema } } }` for every body. 400 when `validated` (`:990`).                                                                                                                                                                                       |
| `OpenApiRequestBody` type                         | `openapi-generator.ts:288-296`                                                                        | `content` typed `{ 'application/json': { schema } }` only; no `encoding`.                                                                                                                                                                                                                              |
| `#effectiveSchema`                                | `openapi-generator.ts:1116-1166`                                                                      | reads `target`/`schema` of each brand; `cookies` and `schema: undefined` skipped; declared wins per target; last brand per target wins.                                                                                                                                                                |
| 415 derivation                                    | `openapi-plugin/src/generators/error-responses.ts:70, 194`                                            | any `body` brand → 415; independent of `forms`. Unchanged by this milestone.                                                                                                                                                                                                                           |
| transformer hook                                  | `openapi-plugin/src/transformers/zod-to-openapi.ts:111-114, 505-535`                                  | `SchemaNodeHook(schema, path)`; consulted per node through zod's `override`; a replacement is spliced with `replaceOwnKeys`; the root and metadata clones' parents are skipped (`isCloneOf`, `:151`). An empty node of a non-`any` type reports `zod v4 type '<t>' has no JSON Schema representation`. |
| generator hook                                    | `openapi-generator.ts:767, 1681-1700`                                                                 | `#hook` returns `undefined` for a node being hoisted; in the count pass it counts and descends once per side.                                                                                                                                                                                          |
| codegen refusals                                  | `openapi-codegen.ts:81, 381, 542-588, 865-884`; `sdk/README.md:491-507`                               | no soft diagnostics: every unsupported shape throws `OpenApiCodegenError` (`path`, `method`), listed in the README's "Codegen diagnostics" table.                                                                                                                                                      |
| codegen body read                                 | `packages/sdk/src/codegen/openapi-codegen.ts:601-611, 927-937`                                        | `getBodySchema` reads only `content['application/json']`; a non-JSON body yields no body argument, silently.                                                                                                                                                                                           |
| codegen type mapping                              | `openapi-codegen.ts:367-440`; `codegen/openapi-types.ts:112-125, 174`                                 | `rtp`: `string` → `string`; `format` is declared in `SdkOpenApiSchema` but never read; `contentMediaType` absent; `SdkOpenApiMediaType` = `{ schema? }`.                                                                                                                                               |
| generated call                                    | `openapi-codegen.ts:1363-1401`; fixture `sdk/test/fixtures/inline-shapes-client.ts:29-40`             | `client.request({ method, path, json: opts.body, ...idempotencyKey, ...signal })`. Hoisted types are `export type X = …` (`:1195`).                                                                                                                                                                    |
| `ClientRequest`                                   | `packages/sdk/src/http/contracts.ts:41-69`                                                            | `method, path, query, headers?, json?, idempotencyKey, signal` — no other body field.                                                                                                                                                                                                                  |
| body serialization                                | `packages/sdk/src/http/http-client.ts:185-204, 281-287`                                               | headers merged (defaults, then request); `json` → `JSON.stringify` + `Content-Type: application/json`; body built once and reused per attempt.                                                                                                                                                         |
| retry                                             | `sdk/src/http/retry/retry-strategy.ts:65, 136`                                                        | keyed POST is retryable — the body must be re-sendable (a `FormData` is: fetch re-extracts it each call).                                                                                                                                                                                              |
| sdk portability                                   | `packages/sdk/README.md:587-596`; `package.json:20-21`                                                | web-standard APIs only; engines include Node 22 (global `Blob`, `FormData`, `File` exist on 22 and 24).                                                                                                                                                                                                |
| outbound diagnostics                              | `sdk/src/http/observed-fetch.ts:152`                                                                  | never reads the body — a `FormData` body adds nothing to observe.                                                                                                                                                                                                                                      |
| `setu client`                                     | `packages/cli/src/client/generate.ts:65-123`; `commands/client.ts:39-166`                             | loads the project's own sdk codegen, Prettier-formats; `--input`, `--check`.                                                                                                                                                                                                                           |
| client e2e harness                                | `packages/cli/test/e2e/client-e2e.test.ts:18-109`; `test/fixtures/node-project.ts:197-221`            | `setu new api --template rest`, `add sdk`, routes spliced before `return app;`, `npm run client`, `withNodeServer`, `tsx --eval` calling the generated client.                                                                                                                                         |
| third-party generators                            | repo-wide `package.json` grep                                                                         | neither `@hey-api/openapi-ts` nor `openapi-generator` is a dependency anywhere — the §7 probe fetches them ad hoc.                                                                                                                                                                                     |
| stated limit                                      | `packages/validation-plugin/README.md:97-98`; `docs/cli.md:705`                                       | "the generated OpenAPI document still describes a validated body as `application/json`" — both deleted.                                                                                                                                                                                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                                                                       | Doc deliverable (same PR)                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| C1  | ROADMAP decision 4: validation-plugin "exports `formFile()`, a Zod schema" — but validation-plugin has no Zod dependency and no package imports Zod at runtime.                                                                                 | User decision 2026-11-13: a subpath `@setu-ts/validation-plugin/zod` exports `formFile`; `zod` is an optional peer; only the subpath imports it. Needs an `optional-peer` override kind (§3.2).                                | ROADMAP M137c decision 4 amended to name the subpath.                        |
| C2  | ROADMAP decision 5: "a file field is typed `Blob \| File` with the filename taken from `File.name` or a declared default". `File` extends `Blob`, and a `FormData` file append without a filename names a bare `Blob` `blob` by the Fetch spec. | The generated type is `Blob` (a `File` is assignable); no declared-default mechanism — the runtime's `File.name`, or `blob` for a bare `Blob`, is the filename. The server requires a filename and receives one in both cases. | ROADMAP decision 5 amended; sdk README states the `blob` filename.           |
| C3  | ROADMAP decision 1 says the brand records forms set "by both entry points (`validateBody` and `IValidationService.middleware`)". The other four helpers take no options; a route may carry two body brands.                                     | Brand `forms: true` only when the body brand's options had `forms: true`. The document lists form media types only when EVERY `body` brand on the route carries `forms` — any brand without it answers 415 to a form body.     | None (the ROADMAP is silent on two brands); recorded here and in the README. |

## 3. Design decisions

### 3.1 The validation brand records `forms`

- **Decision:** `RouteValidationMetadata` gains `readonly forms?: true`. `buildValidationMiddleware`
  (service path) and `bindHelper` (helper path) brand `{ target, schema, forms: true }` exactly when
  `target === 'body' && options?.forms === true`, and omit the key otherwise
  (`exactOptionalPropertyTypes`). `isRouteValidationMetadata` treats a present `forms` that is not
  `true` as foreign (whole brand → `undefined`), mirroring M137b's `forbids` check.
- **Why:** the brand is the generator's only view of what the route accepts (§1).
- **Test home:** `common/test/unit/validation-metadata.test.ts` (extend);
  `validation-plugin/test/unit/form-brand.test.ts` (new) — both entry points, under `forms: true`, a
  non-body target with `forms`, and no options; `decorator-plugin`
  `@ValidateBody(schema, { forms: true })` served through the openapi generator in
  `openapi-plugin/test/unit/form-bodies.test.ts`.

### 3.2 `optional-peer` override kind

- **Decision:** `ClassificationOverride.kind` gains `'optional-peer'`. Applied only when the scan
  found the dependency (a value import, so it sits in `dependencies`): move it to `peerDependencies`
  with `peerDependenciesMeta.optional`, plus the identical-range `devDependencies` mirror — the same
  shape a dynamic import already gets. One override row: `packages/validation-plugin` → `zod`,
  reason "only the `./zod` subpath imports it (M137c)". The range is the table's existing `zod`
  range.
- **Why:** C1. A value import otherwise makes Zod a hard dependency of the whole package.
- **Test home:** `test/unit/node-manifests.test.ts` (extend): a fixture member with a value import
  and the override classifies as optional peer + dev mirror; the override with no matching import is
  refused (existing rule, asserted for the new kind).

### 3.3 `formFile()` in `@setu-ts/validation-plugin/zod`

- **Decision:**
  - New entry `packages/validation-plugin/src/zod/index.ts` exporting `formFile` and the
    `FormFileOptions` type; `package.json` `exports["./zod"]` → `./dist/zod/index.{d.ts,js}`;
    `deno.json` `exports["./zod"]` → `./src/zod/index.ts`. The main entry never imports it.
  - `formFile(options?: FormFileOptions): z.ZodCustom<FormFile, FormFile>` (explicit return type,
    `isolatedDeclarations`).
    `FormFileOptions = { readonly mimeTypes?: readonly string[]; readonly maxBytes?: number }`.
  - Construction-time `TypeError` (naming the option and the value) when `mimeTypes` is empty or an
    entry is not a `type/subtype` or `type/*` essence, or `maxBytes` is not a positive safe integer.
    Entries are lower-cased once.
  - Validation, as Zod issues (so the route's 400 formatter applies): not a `FormFile`-shaped value
    (`filename` string, `mimeType` string, `data` a `Uint8Array`) → "Expected a file"; `mimeTypes`
    set and the part's media-type essence (before `;`, trimmed, lower-cased) matches no entry
    (`type/*` matches by type) → "File type <essence> is not accepted"; `maxBytes` set and
    `data.byteLength > maxBytes` → "File exceeds <maxBytes> bytes". The shape check is the
    `z.custom` predicate and the other two run in a `superRefine` on it; Zod v4 stops at a failed
    `z.custom` check, so the refinement only ever sees a `FormFile` (probed 2026-11-13: a string
    yields the single issue "Expected a file").
  - The brand: `withFormFileMetadata(schema, { mimeTypes?, maxBytes? })` applied to the FINAL
    instance returned (Zod v4 `.check`/`.refine` return a new instance).
- **Why:** C1; one helper both enforces the rules and tells the document about them.
- **Test home:** `validation-plugin/test/unit/form-file.test.ts` (new) — every issue, every
  construction refusal, `type/*`, parameters on the part's type, the brand read back; and
  `validation-plugin/test/integration/form-file-upload.test.ts` (new) — a real multipart upload
  through `app.fetch(new Request(url, { method: 'POST', body: formData }))` (the pattern
  `form-body-validation.test.ts:65-114` uses) accepted, a wrong type and an oversize file answering
  400 with the issue text.

### 3.4 The form-file brand in `common`

- **Decision:** `FORM_FILE_METADATA = Symbol.for('setu.form-file.metadata')`;
  `FormFileMetadata = { readonly mimeTypes?: readonly string[]; readonly maxBytes?: number }`;
  `withFormFileMetadata<T extends object>(schema: T, metadata: FormFileMetadata): T` (in place,
  non-enumerable, returns the same reference);
  `formFileMetadataOf(value: unknown): FormFileMetadata | undefined` (non-object, missing, or a
  foreign value — `mimeTypes` not an array of strings, `maxBytes` not a positive safe integer — →
  `undefined`). New file `packages/common/src/form/form-file-metadata.ts`.
- **Why:** ROADMAP decision 4; `common` stays dependency-free and openapi-plugin reads the brand
  without importing validation-plugin (AI_GUIDELINES §2.2).
- **Test home:** `common/test/unit/form-file-metadata.test.ts` (new).

### 3.5 Request-body media types in the document

- **Decision:** in `#createOperation`, the body schema is resolved ONCE (one `#resolveSchema` call,
  so the count pass sees one sighting) and the same object is placed under each media type:
  - no `body` brand, or any `body` brand without `forms` → `{ 'application/json' }` (unchanged);
  - every `body` brand has `forms` and the effective body schema has no file field (§3.6) →
    `application/json`, `application/x-www-form-urlencoded`, `multipart/form-data`, in that order;
  - every `body` brand has `forms` and the body has a file field → `multipart/form-data` alone, with
    `encoding` (§3.6). The file check reads the effective body schema — declared or derived — so a
    declared body with a `forms` brand is described the same way. `OpenApiRequestBody.content` is
    widened to the three optional media types, each
    `OpenApiMediaTypeObject = { schema; encoding? }`, with
    `OpenApiEncoding = { contentType?: string }`.
- **Why:** ROADMAP decisions 2, 3 and 6: the document lists exactly what the route accepts; JSON
  first so hey-api and openapi-generator send JSON; multipart alone when a file is present because
  JSON refuses a file and urlencoded cannot carry one.
- **Test home:** `openapi-plugin/test/unit/form-bodies.test.ts` (new); the live gate in §3.9.

### 3.6 File fields: `format: binary` and `encoding`

- **Decision:**
  - New internal `packages/openapi-plugin/src/generators/form-fields.ts` (NOT exported from
    `index.ts`): `fileMetadataOf(schema)` reads `formFileMetadataOf` on the node, then up its
    `_zod.parent` chain (`.describe()`/`.meta()` clones lose own properties);
    `formFileFieldsOf(bodySchema)` unwraps the root (metadata clones,
    `optional`/`nullable`/`default`/`readonly`/`catch` `innerType`, `pipe` `in`) to a Zod object,
    then maps each TOP-LEVEL `shape` key whose unwrapped value is a branded node, or an array whose
    element is one, to its `FormFileMetadata`. Non-Zod or non-object bodies → empty map. Form fields
    are flat (`form-record.ts`), so nested objects are not walked.
  - `#hook`: right after the hoisting check, before the count logic, a node with `fileMetadataOf` →
    `{ type: 'string', format: 'binary', contentMediaType: 'application/octet-stream' }` plus the
    node's own `description` when it has one. Returned in both passes, so a file node is never
    counted, hoisted or reported unrepresentable by the generator; `z.array(formFile())` therefore
    emits an array of binaries (probed: the replacement survives `.optional()`, `.describe()`,
    `.nullable()` and `z.array`). One case stays shared: the SAME `formFile()` instance used for two
    fields of one body is extracted by Zod's own `reused: 'ref'` into a `$defs` entry that the
    adapter hoists as a component — the fields become `$ref`s to a binary component. That is valid
    OpenAPI, both third-party generators dereference it, and `form-bodies.test.ts` asserts it rather
    than preventing it.
  - `encoding`: for each file field whose metadata has `mimeTypes`,
    `{ contentType: mimeTypes.join(', ') }` under the field name; omitted entirely when no field
    declares types.
- **Why:** ROADMAP decision 4 (both keywords, because hey-api and openapi-generator read different
  ones) and decision 3's `encoding`. A structural walk, not "sightings during transform", because a
  hoisted body is transformed once and later operations see only a `$ref`.
- **Test home:** `openapi-plugin/test/unit/form-fields.test.ts` (new, every unwrap branch and
  non-Zod input) and `form-bodies.test.ts` (binary node, array of files, `.optional()`,
  `.describe('…')`, no diagnostic, `encoding` present and absent).

### 3.7 SDK HTTP client: `multipart`

- **Decision:** `ClientRequest` gains `readonly multipart?: object`. In `http-client.ts` the body is
  built once:
  - `json` and `multipart` both present → `TypeError('json and multipart are mutually exclusive')`
    before any interceptor runs;
  - `multipart`: a new internal `src/http/multipart.ts` `encodeMultipart(body): FormData` appends
    each own enumerable key in insertion order: `undefined` → skipped; `Blob` (so `File`) →
    `append(key, value)` (the runtime supplies `File.name`, or `blob`); `string` → as is; `number`,
    `boolean`, `bigint` → `String(value)`; an array → each element by the same rules under the same
    key (a nested array, `null`, or any other object → `TypeError` naming the key). `Content-Type`
    is deleted from the merged headers so the runtime sets the boundary.
  - The `FormData` is reused across retry attempts (fetch re-extracts it per call).
- **Why:** ROADMAP decision 5; `multipart?: object` because a generated body type need not be
  assignable to an index-signature type, and the runtime check refuses what a form cannot carry.
- **Test home:** `sdk/test/unit/multipart.test.ts` (new) — every value rule and refusal;
  `sdk/test/unit/http-client-multipart.test.ts` (new) — the fetch receives a `FormData`, no caller
  `Content-Type` survives, a retried keyed POST re-sends the same entries, the mutual-exclusion
  refusal.

### 3.8 SDK codegen: body selection and `Blob`

- **Decision:**
  - `getBodySchema` returns `{ schema, encoding: 'json' | 'multipart' }`: `application/json` when
    present (whatever else is listed); else `multipart/form-data`; else, for a `requestBody` with
    `content`, it throws `OpenApiCodegenError` ("request body media types <list> are not supported:
    the generated method would drop the body", with `path` and `method`) — codegen has no soft
    diagnostic channel; it refuses rather than emit a client that misbehaves (sdk README "Codegen
    diagnostics"). A `requestBody` with no `content` stays bodiless, as today.
  - The generated call passes `multipart: opts.body` (or `opts?.body`) instead of `json:` for a
    multipart body; everything else in the call is unchanged.
  - `rtp`: `type: 'string'` with `format: 'binary'` → `Blob`.
- **Why:** ROADMAP decision 5; the selection is a fixed rule, not map order; a dropped body is no
  longer silent. Behaviour change: an operation whose body is only `text/plain` (or urlencoded only)
  used to generate a bodiless method and now refuses — named in the CHANGELOG.
- **Test home:** `sdk/test/unit/codegen-form-bodies.test.ts` (new) — a three-media-type body
  generates `json:`; a multipart-only body generates `multipart:` and a `Blob` field; a
  urlencoded-only and a `text/plain`-only body throw `OpenApiCodegenError` with `path`/`method`; a
  `requestBody` without `content` stays bodiless; the generated file type-checks (existing compile
  helper).

### 3.9 End-to-end and live gates

- **Decision:**
  - `openapi-plugin/test/integration/form-bodies-live.test.ts` (new): a running app with three
    routes (`forms` without a file, `forms` with `formFile`, plain JSON); the served document's
    media types are asserted, then each listed media type is SENT and accepted (2xx), and an
    unlisted one (`text/plain`) answers 415 — the document lists exactly the accepted set.
  - `packages/cli/test/e2e/client-e2e.test.ts` (extend): the rest project gains `POST /uploads`
    (`validateBody(z.object({ title: z.string(), file: formFile({ maxBytes: 1_000_000 }) }), { forms: true })`
    storing the `FormFile` in a `Map`) and `GET /uploads/:id` returning
    `{ filename, mimeType, text }`; the generated client uploads
    `new File(['hello m137c'], 'hello.txt', { type: 'text/plain' })`, then reads it back through the
    generated client and asserts filename, type and text.
- **Why:** ROADMAP gate: a fixed document alone could still yield a client that drops the body.
- **Test home:** as named.

### 3.10 Documentation

- **Decision:** validation-plugin README: `formFile` section (import from `/zod`, options, issue
  texts, `filename` and `mimeType` are client-supplied — never trust the filename for a path or the
  media type for a type decision), the stated limit deleted, the "every body brand needs `forms`"
  rule (C3). openapi-plugin README: "Form bodies and file uploads" (the three rules, `encoding`).
  sdk README: `multipart`, the value rules, `Blob` mapping, the `blob` filename, the new "Codegen
  diagnostics" refusal row, and the request-body sentence at `:143`. common README export table
  (docs:exports). `docs/cli.md:705` limit deleted. AGENT_CARDs of the four packages (≤2560 bytes,
  own identifiers only). PUBLIC_API.md for every export in §4. CHANGELOG (Added; Changed: form
  routes' documents list three media types, so `setu client --check` reports drift once; codegen now
  refuses an operation whose only request body media types it cannot send). `docs/upgrading.md`
  M137c section. ROADMAP C1/C2 amendments, 137c ✅. CLAUDE.md status entry.
- **Test home:** `check:docs`, `docs:exports`, `test/package-readme-fence-compiler.test.ts` (fence
  counts updated for every README that gains a compilable fence).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `forms` is an optional brand field; `multipart` is an optional
`ClientRequest` field; `OpenApiRequestBody.content` widens. The document change (form routes list
three media types) is a described-output change for clients, noted in the CHANGELOG and caught by
`setu client --check`.

| Exported symbol                             | Kind     | Consumer / real code path that READS it                                                    |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `RouteValidationMetadata.forms`             | field    | `openapi-generator.ts` `#createOperation` media-type choice (§3.5)                         |
| `FORM_FILE_METADATA`                        | symbol   | `withFormFileMetadata` / `formFileMetadataOf` (same file); global key shared across copies |
| `FormFileMetadata`                          | type     | `formFile` (writes), `form-fields.ts` (reads), `#hook`, `encoding`                         |
| `withFormFileMetadata`                      | function | `validation-plugin/src/zod/form-file.ts` `formFile`                                        |
| `formFileMetadataOf`                        | function | `openapi-plugin/src/generators/form-fields.ts` `fileMetadataOf`                            |
| `formFile` (`/zod`)                         | function | application route schemas; the client e2e route; the live test                             |
| `FormFileOptions` (`/zod`)                  | type     | `formFile`'s parameter                                                                     |
| `ClientRequest.multipart`                   | field    | `http-client.ts` body build; generated clients (`multipart: opts.body`)                    |
| `OpenApiMediaTypeObject`, `OpenApiEncoding` | types    | `OpenApiRequestBody.content` (exported because `OpenApiRequestBody` is)                    |

`SdkOpenApiMediaType.encoding` is NOT added: nothing in codegen would read it.

### 4.1 Options — every option names its consumer

| Option                       | Consumer                                        | Behavior (per implementation)                                                                                 |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `formFile({ mimeTypes })`    | `formFile` check; `#createOperation` `encoding` | issue "File type … is not accepted"; `encoding.<field>.contentType`                                           |
| `formFile({ maxBytes })`     | `formFile` check                                | issue "File exceeds N bytes"; recorded in the brand, not emitted (no JSON-Schema keyword for a binary's size) |
| `validateBody(…, { forms })` | middleware (existing) + brand (new)             | unchanged runtime; brand `forms: true`                                                                        |

## 5. Implementation files

| File                                                                 | Purpose                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/common/src/http.ts`                                        | `forms?: true` + guard                                     |
| `packages/common/src/form/form-file-metadata.ts` (new)               | the form-file brand                                        |
| `packages/common/src/index.ts`                                       | exports                                                    |
| `packages/validation-plugin/src/middleware/validation-middleware.ts` | brand `forms` on both paths                                |
| `packages/validation-plugin/src/zod/index.ts` (new)                  | subpath barrel                                             |
| `packages/validation-plugin/src/zod/form-file.ts` (new)              | `formFile`                                                 |
| `packages/validation-plugin/package.json`, `deno.json`               | `./zod` export; manifest regenerated (`zod` optional peer) |
| `scripts/node-dependency-ranges.ts`, `scripts/node-manifests.ts`     | `optional-peer` kind + the row                             |
| `packages/openapi-plugin/src/generators/form-fields.ts` (new)        | file-field walk                                            |
| `packages/openapi-plugin/src/generators/openapi-generator.ts`        | media types, `encoding`, binary in `#hook`, types          |
| `packages/openapi-plugin/src/index.ts`                               | export the two new types                                   |
| `packages/sdk/src/http/contracts.ts`, `http-client.ts`               | `multipart`                                                |
| `packages/sdk/src/http/multipart.ts` (new, internal)                 | `encodeMultipart`                                          |
| `packages/sdk/src/codegen/openapi-codegen.ts`                        | body selection, unsupported-body refusal, `Blob`           |
| `test/deno-lane/deno.lock`                                           | only if the lane moves (§8)                                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                    | src covered                         | Key assertions (and the signature each call type-checks against)                                 |
| ---------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/common/test/unit/validation-metadata.test.ts` (extend)             | `http.ts`                           | `forms: true` round-trips; `forms: 'yes'`/`false` → brand absent                                 |
| `packages/common/test/unit/form-file-metadata.test.ts` (new)                 | `form/form-file-metadata.ts`        | in place, non-enumerable, identity kept; every foreign shape → `undefined`                       |
| `packages/validation-plugin/test/unit/form-brand.test.ts` (new)              | `validation-middleware.ts`          | helper and service paths brand `forms` identically under `forms: true`; absent otherwise         |
| `packages/validation-plugin/test/unit/form-file.test.ts` (new)               | `zod/form-file.ts`, `zod/index.ts`  | §3.3 issues and refusals; `formFile(): z.ZodCustom<FormFile, FormFile>` usable inside `z.object` |
| `packages/validation-plugin/test/integration/form-file-upload.test.ts` (new) | same + middleware                   | real multipart through `app.fetch` with a `FormData` body accepted / 400s                        |
| `test/unit/node-manifests.test.ts` (extend)                                  | `scripts/node-manifests.ts`, ranges | `optional-peer` classification and refusal                                                       |
| `packages/openapi-plugin/test/unit/form-fields.test.ts` (new)                | `generators/form-fields.ts`         | every unwrap branch, arrays, non-Zod, non-object                                                 |
| `packages/openapi-plugin/test/unit/form-bodies.test.ts` (new)                | `openapi-generator.ts`              | §3.5/§3.6 outputs incl. two brands (one without `forms`), declared body + forms, decorated route |
| `packages/openapi-plugin/test/integration/form-bodies-live.test.ts` (new)    | same, live                          | §3.9 first bullet                                                                                |
| `packages/sdk/test/unit/multipart.test.ts` (new)                             | `http/multipart.ts`                 | §3.7 value rules                                                                                 |
| `packages/sdk/test/unit/http-client-multipart.test.ts` (new)                 | `http/http-client.ts`               | §3.7 client behaviour, retry re-send                                                             |
| `packages/sdk/test/unit/codegen-form-bodies.test.ts` (new)                   | `codegen/openapi-codegen.ts`        | §3.8                                                                                             |
| `packages/cli/test/e2e/client-e2e.test.ts` (extend)                          | end to end                          | §3.9 second bullet                                                                               |

Existing tests that pin today's output (`application/json` only on a `forms` route, the sdk README
fence count, generated-client fixtures) are updated where they change, never deleted.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m137c-form-bodies-file-uploads
pnpm run check:plan
pnpm run fmt:check && pnpm run lint && pnpm run check && pnpm run check:docs && pnpm run docs:exports
node scripts/node-manifests.ts --check
pnpm test:coverage common validation-plugin openapi-plugin sdk decorator-plugin   # per-file ≥90%
pnpm run test:deno-lane
pnpm run ci:local            # all shards, on the final commit
pnpm run release:publish --dry-run && pnpm run release:verify 0.12.0
```

Plus, recorded in the PR (not CI): the live document of the §3.9 app fed to
`npx @hey-api/openapi-ts` and to the `openapitools/openapi-generator-cli` image
(`typescript-fetch`); each generated client sends JSON for the three-media-type route and multipart
for the file route, as ROADMAP decisions 2–3 predict. Then the committed-tree **security audit** by
a freshly spawned Claude agent (`.roo/skills/security-audit/SKILL.md`): client-supplied filename and
media type, `formFile` bounds, the SDK dropping a caller `Content-Type`.

## 8. Risks & mitigations

- Zod v4 wrapper/clone behaviour hides the brand (`.optional()`, `.describe()`) → `fileMetadataOf`
  walks `_zod.parent`, `form-fields.ts` unwraps `innerType`; both have dedicated cases in §6.
- A single-value repeated field (`files: z.array(formFile())` with one file) arrives as a scalar
  (`form-record.ts`) and fails the array schema → documented in the README with the `files[]` name
  rule that already exists; not changed here.
- The Deno lane runs no validation-plugin, openapi-plugin or sdk tests (`DENO_LANE_TESTS`: cli,
  diagnostics-plugin, mcp-plugin, runtime, websocket-plugin), and the main entry never imports
  `zod`, so the lane should not move → re-run it after the manifest change anyway and update
  `test/deno-lane/deno.lock` only if it does.
- `maxBytes` runs after the whole body is parsed, so it is not a DoS control → README says the
  request-size bound (`RuntimePlugin({ maxBodyBytes })`) is.
- A third-party generator disagrees with the predicted encoding → the §7 probe records the result
  before merge; a disagreement is a finding, not a silent pass.

## 9. Out of scope

- Documenting `storage-plugin`'s `uploadMiddleware` routes (no validation brand; no milestone owns
  it yet — named here so it is not mistaken for done).
- `application/*+json` listed separately; urlencoded-only or text bodies in generated clients (they
  get the §3.8 refusal).
- A per-file streaming bound, and `format: binary` responses.
