# Milestone 99c — two first-party components that must agree, and do not

> **Status:** Planning. Branch: `feat/m99c-first-party-disagreement`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

In both rows a producer and its intended first-party consumer disagree about a shape they both own,
so a documented loop cannot be completed. `openapi-plugin` emits a document its own `sdk` refuses to
generate from; `kernel`'s `inject()` produces a request its own request contract cannot parse.

- **In scope:** the generated-name collision between the component namer and the response-body
  hoister; the content-type a `Blob` body contributes through `inject()`.
- **NOT this milestone:** the object-schema query parameter the generator refuses to emit
  (pre-existing, recorded as unowned in M70m); `deriveResponseStatus` itself, verified correct this
  run; the rest of the `InjectBody` union, verified correct this run.

## 1. Contracts verified from SOURCE (not names)

| Reference                     | Source (file:line)                                                 | Verified surface / fact                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `TypeNameRegistry.claim`      | `packages/sdk/src/codegen/openapi-codegen.ts:78-87`                | `claim(name, origin)`; throws `OpenApiCodegenError` when another origin already holds `name`. The refusal is correct                       |
| Component claim site          | `packages/sdk/src/codegen/openapi-codegen.ts:1028`                 | `types.claim(sanitizeTypeName(name), \`component schema '\${name}'\`)` — claims FIRST                                                      |
| Response-body claim site      | `packages/sdk/src/codegen/openapi-codegen.ts:903-906`              | `types.claim(\`\${sanitizeTypeName(operationId)}Response\${s}\`, "the \${s} response body of operation …")`                                |
| `hoistMultiline`              | `packages/sdk/src/codegen/openapi-codegen.ts:654-663`              | hoists only when `rendered.includes('\n')`; calls `name()` ONLY when hoisting, so the claim is conditional                                 |
| The plugin's component name   | `packages/openapi-plugin/src/generators/openapi-generator.ts:1061` | `` `${operationId}Response${statusCode}` `` — the SAME derivation the SDK uses for a response body                                         |
| `coerceInjectBody` Blob arm   | `packages/kernel/src/application/inject-body.ts:86-88`             | `{ bytes: new Uint8Array(await body.arrayBuffer()), defaultContentType: undefined }`                                                       |
| `coerceInjectBody` other arms | `packages/kernel/src/application/inject-body.ts:62-94`             | string and plain object default `application/json`; `URLSearchParams` defaults urlencoded; `Uint8Array`/`ArrayBuffer` copy with no default |
| `CoercedInjectBody`           | `packages/kernel/src/application/inject-body.ts:57-59`             | `{ bytes, defaultContentType }` — the field already exists, so the Blob fix sets a value rather than adding surface                        |

**Measured, not inferred (V7-6).** With a component named `GetOrdersResponse200` and `get-orders`'s
own 200 body inline, codegen throws `Duplicate generated name 'GetOrdersResponse200'`. The `0.6.0`
SDK throws identically, so this is not a regression. A `$ref` body is the passing control.

**Measured, not inferred (V7-1).** One `Blob` carrying `multipart/form-data; boundary=…`:
`app.fetch` answers `200` with the form parsed; `app.inject` answers `500`, the handler seeing
`UnsupportedFormEncodingError`. The platform's own `new Request(url, { body: blob })` sets
`Content-Type` from `blob.type`.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                            | Resolution (picked side)                                                                                                 | Doc deliverable (same PR)                                                      |
| -- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| C1 | `CHANGELOG.md` `0.7.0` describes the byte-ish `inject()` shapes as carrying no content-type default because "only the caller knows" | True for `Uint8Array`/`ArrayBuffer`, false for `Blob`, which carries `.type`. Narrow the sentence to the two byte shapes | The `0.7.0` entry is corrected in place with a `Fixed` note under `Unreleased` |
| C2 | `PUBLIC_API.md` documents `inject()`'s per-shape content-type table                                                                 | The table gains the `Blob` row's new behaviour                                                                           | `PUBLIC_API.md` row updated                                                    |
| C3 | M70m's X11-6 and X11-9 entries each describe a naming fix without reference to the other                                            | Both are correct individually; the collision is the interaction. Neither entry is rewritten                              | `CHANGELOG.md` `Unreleased` names the interaction, citing both                 |

## 3. Design decisions

### 3.1 Which producer yields the colliding name

- **Decision:** the SDK's response-body hoister suffixes its alias — `…Response200Body` — and the
  component namer is left alone.
- **Why:** the component name is published surface of the DOCUMENT, read by every consumer of that
  document including non-Setu ones, so changing it is a wire-visible break. The hoisted alias is an
  implementation detail of one generated file, so renaming it costs nobody. Choosing the other side
  would also not fix documents already published.
- **Test home:** `packages/sdk/test/unit/codegen-name-collision.test.ts`.

### 3.2 Whether the hoister should instead reuse the component

- **Decision:** it does not. A structurally identical shape is emitted twice under two names.
- **Why:** reuse means structural comparison of two rendered schemas at generation time, which is a
  new equality notion the generator does not have and would have to keep correct as schema features
  grow. The duplicate alias is a few lines of emitted text. This is deliberately the smaller fix.
- **Test home:** the same test asserts BOTH names appear, so a later dedupe is a conscious change.

### 3.3 What `Blob` contributes as a content type

- **Decision:** `defaultContentType` is `body.type` when that string is non-empty, and `undefined`
  otherwise.
- **Why:** it matches the platform exactly — `new Request(url, { body: blob })` sets the header from
  `blob.type` and omits it when the blob has none. `Uint8Array` and `ArrayBuffer` keep `undefined`,
  because those genuinely carry no declared type, so the CHANGELOG's stated reasoning remains true
  for the shapes it actually describes.
- **Test home:** `packages/kernel/test/unit/inject-body-shapes.test.ts` (extending the existing
  file).

### 3.4 Precedence against an explicit header

- **Decision:** an explicit `headers['content-type']` on the `InjectRequest` still wins, unchanged.
- **Why:** `defaultContentType` is already a DEFAULT in the existing code path; this decision only
  changes what that default is for one shape. Making a blob's type override an explicit header would
  be a new and surprising precedence.
- **Test home:** the same test asserts the override.

## 4. Exported surface — every symbol names its consumer

Neither package's `src/index.ts` gains a symbol. Both changes are to the behaviour of existing
exports.

| Exported symbol             | Kind     | Consumer / real code path that READS it                                                     |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `generateOpenApiClient`     | function | `x11-consumer`'s `generate.ts` and any application generating a client; signature unchanged |
| `IKernelApplication.inject` | method   | every `inject()`-based test in the repo and in applications; `InjectBody` union unchanged   |

A `barrel-exports.test.ts` in both packages pins the published surface.

### 4.1 Options — every option names its consumer

| Option         | Consumer | Behavior (per implementation)                                                                                                                                                                                                         |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None (checked) | —        | Neither change adds nor alters an option. The collision fix is unconditional, because a generator that aborts has no configuration worth preserving, and the `Blob` default is unconditional for the same reason `URLSearchParams` is |

## 5. Implementation files

| File                                             | Purpose                                        |
| ------------------------------------------------ | ---------------------------------------------- |
| `packages/sdk/src/index.ts`                      | unchanged (pinned by test)                     |
| `packages/sdk/src/codegen/openapi-codegen.ts`    | the response-body alias claims a suffixed name |
| `packages/kernel/src/index.ts`                   | unchanged (pinned by test)                     |
| `packages/kernel/src/application/inject-body.ts` | the `Blob` arm reads `body.type`               |
| `PUBLIC_API.md`                                  | C2 — the `inject()` shape table                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                        | src covered                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sdk/test/unit/codegen-name-collision.test.ts`          | `codegen/openapi-codegen.ts` | a document with component `GetItemsResponse200` AND an inline multi-line 200 body on `get-items` GENERATES; both names appear in the output; a `$ref` body still generates (the control that passed before the fix) |
| `packages/sdk/test/fixtures/` (third committed fixture)          | `codegen/openapi-codegen.ts` | a fixture generated from that shape, type-checked by `deno task check` and format-checked — the M70m X11-9 precedent that keeps emitted output under the repo's own gates                                           |
| `packages/kernel/test/unit/inject-body-shapes.test.ts`           | `application/inject-body.ts` | a typed `Blob` contributes its `type`; a typeless `Blob` contributes nothing; an explicit header still wins; `Uint8Array`/`ArrayBuffer` unchanged. Calls typed against `InjectBody`                                 |
| `packages/kernel/test/integration/inject-multipart-blob.test.ts` | `application/inject-body.ts` | the SAME multipart `Blob` through `app.inject` and `app.fetch` yields the same parsed form — the end-to-end disagreement V7-1 names                                                                                 |
| `packages/sdk/test/unit/barrel-exports.test.ts`                  | `src/index.ts`               | unchanged                                                                                                                                                                                                           |
| `packages/kernel/test/unit/barrel-exports.test.ts`               | `src/index.ts`               | unchanged                                                                                                                                                                                                           |

`openapi-codegen.ts` and `inject-body.ts` are both pure, so the per-file bar is met by the unit
tests; each change adds one branch, and each has a named case above plus its negative control.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m99c-first-party-disagreement, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage
deno task publish:check
```

Negative controls, each observed failing and reverted:

1. Revert the alias suffix — `codegen-name-collision` throws the verbatim duplicate-name error.
2. Revert the `Blob` arm — `inject-multipart-blob` fails with the two producers disagreeing,
   `inject` answering `500` where `fetch` answers `200`.
3. Delete the third codegen fixture — `deno task check` stops covering the emitted shape, which is
   the M70m lesson about fixtures being the only thing that keeps generated output gated.

Beyond the gates: regenerate a client from a RUNNING application's `/openapi.json` (the Part 12 X53
exercise does exactly this and currently fails) and confirm it now completes.

## 8. Risks & mitigations

- A consumer pinning the old alias name in hand-written code breaks → the alias is emitted output,
  regenerated with the client, and was unreachable before this fix because generation aborted.
- A `Blob` whose `type` disagrees with its bytes now sets a misleading header → that is the
  platform's behaviour too, and the caller supplied the type.
- The third fixture grows the repo's generated-output surface → it is the smallest document that
  carries the shape, and M70m established the precedent for exactly this reason.

## 9. Out of scope

- Structural dedupe of identical schemas in the generator (§3.2) — a larger equality notion, and the
  duplicate alias costs only emitted text.
- The object-schema query parameter the generator refuses (`TS2322` on `ClientRequest.query`),
  recorded as unowned in M70m and unchanged here.
- `deriveResponseStatus` and the rest of the `InjectBody` union: both verified correct this run.
