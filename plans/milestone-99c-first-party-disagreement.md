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

- **Decision:** the component namer is left alone; the SDK's hoisted alias yields. It asks the
  registry for its PREFERRED name first (`…Response200`, unchanged from today) and takes
  `…Response200Body` only when the preferred one is already claimed; if that is taken too, a numeric
  suffix is appended until one is free. The component name is never renamed.
- **Why the component yields nothing:** it is published surface of the DOCUMENT, read by every
  consumer including non-Setu ones, so changing it is a wire-visible break — and it would not fix
  documents already published.
- **Why preference rather than an unconditional suffix:** the hoisted alias is emitted as
  `export type PlaceOrderResponse201 = …`, so it IS importable, and a consumer can hold it.
  Suffixing every alias would rename a working export in every generated client to fix the one
  document that collides. The plan's first draft argued this was safe because "the alias was
  unreachable before this fix, since generation aborted" — that is true only of the colliding
  document; every other document generates the alias today. The repository already pins this:
  `openapi-codegen.test.ts:1009` compares the committed `inline-shapes-client.ts` fixture
  byte-for-byte and `:1027-1029` asserts `PlaceOrderResponse201` by name in three positions, so the
  unconditional form would have failed both of those tests at implementation time.
- **Why the fallback is allocated rather than assumed free:** `Body` is a suffix, not a namespace. A
  document may legally declare a component named `GetOrdersResponse200Body`, and
  `TypeNameRegistry.claim` (`openapi-codegen.ts:78-86`) THROWS on a second claim — so an
  unconditional suffix moves the abort rather than removing it, and the milestone's own negative
  control (rename the component to the suffixed form) would reproduce V7-6.
- **Determinism:** names are claimed in a fixed order — SDK imports, `apiTypeName`, `factoryName`,
  component schemas, then operations in document order (`openapi-codegen.ts:1005-1033`) — so the
  same document always yields the same names. That is already true of every other claimed name.
- **Test home:** `packages/sdk/test/unit/codegen-name-collision.test.ts`.

### 3.1a Which hoisted names get the preference-and-fallback treatment

- **Decision:** all four — the request body (`…Body`), a parameter (`…<Name>Param`), a success
  response (`…Response<status>`) and an error body (`…Error<status>Body`) — through one allocation
  path in `hoistMultiline`. Component schemas, `*Args`, `*Error`, the guard, `apiTypeName` and
  `factoryName` keep the hard throw.
- **The candidate list:** today's name first, always. The success-response arm alone gets
  `…Response<status>Body` as its second candidate; the other three go straight to a numeric suffix.
  That asymmetry is deliberate rather than an oversight: `…Body` reads correctly beside a component
  of the same name, which is the measured V7-6 case, while `…ParamBody` would not, and the numeric
  form on this arm (`…Response2002`) reads as a status code. Every arm then falls back to `2`, `3`,
  … on its last candidate.
- **Why:** the boundary is whether the DOCUMENT named the shape. A hoisted alias names an anonymous
  inline schema the document never named, so the generator may pick any identifier for it and a
  collision is the generator's problem to solve. Every other claimed name derives from something the
  caller wrote — a component name, an `operationId`, an option — so a collision there is a real
  problem the developer must see, and silently renaming an `Args` interface would be worse than
  aborting.
- **Why not just the response arm the finding names:** `${operationId}Body` collides with a
  component named `PlaceOrderBody` in exactly the same way, so fixing one arm leaves the same defect
  in three others. `hoistMultiline`'s own source says why that split is the trap: "splitting
  emission per source is what let the multi-line indent defect survive in three of them while the
  fourth was correct" (`openapi-codegen.ts:1060-1063`). Widening costs no consumer, because
  preference keeps every name that generates today.
- **Test home:** the same test, one case per hoist site.

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

| File                                             | Purpose                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `packages/sdk/src/index.ts`                      | unchanged (pinned by test)                                                                                          |
| `packages/sdk/src/codegen/openapi-codegen.ts`    | `TypeNameRegistry` gains a preference-and-fallback allocator; `hoistMultiline` uses it for all four hoisted aliases |
| `packages/kernel/src/index.ts`                   | unchanged (pinned by test)                                                                                          |
| `packages/kernel/src/application/inject-body.ts` | the `Blob` arm reads `body.type`                                                                                    |
| `PUBLIC_API.md`                                  | C2 — the `inject()` shape table                                                                                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                        | src covered                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sdk/test/unit/codegen-name-collision.test.ts`          | `codegen/openapi-codegen.ts` | a document with component `GetItemsResponse200` AND an inline multi-line 200 body on `get-items` GENERATES, the alias falling back to `GetItemsResponse200Body` while the component keeps its name; a document ALSO declaring `GetItemsResponse200Body` generates, the alias falling back once more; with NO collision the alias is `GetItemsResponse200`, unsuffixed; the same three cases for a request body, a parameter and an error body; a `$ref` body still generates (the control that passed before the fix) |
| `packages/sdk/test/fixtures/` (third committed fixture)          | `codegen/openapi-codegen.ts` | a fixture generated from that shape, type-checked by `deno task check` and format-checked — the M70m X11-9 precedent that keeps emitted output under the repo's own gates                                                                                                                                                                                                                                                                                                                                             |
| `packages/kernel/test/unit/inject-body-shapes.test.ts`           | `application/inject-body.ts` | a typed `Blob` contributes its `type`; a typeless `Blob` contributes nothing; an explicit header still wins; `Uint8Array`/`ArrayBuffer` unchanged. Calls typed against `InjectBody`                                                                                                                                                                                                                                                                                                                                   |
| `packages/kernel/test/integration/inject-multipart-blob.test.ts` | `application/inject-body.ts` | the SAME multipart `Blob` through `app.inject` and `app.fetch` yields the same parsed form — the end-to-end disagreement V7-1 names                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/sdk/test/unit/openapi-codegen.test.ts` (existing)      | `codegen/openapi-codegen.ts` | UNCHANGED and re-run as the compatibility guard: the `inline-shapes-client.ts` byte-for-byte comparison and the three `PlaceOrderResponse201` assertions must still pass, which is what proves no existing alias is renamed                                                                                                                                                                                                                                                                                           |
| `packages/sdk/test/unit/barrel-exports.test.ts`                  | `src/index.ts`               | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/kernel/test/unit/barrel-exports.test.ts`               | `src/index.ts`               | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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

1. Revert the fallback — `codegen-name-collision` throws the verbatim duplicate-name error.
2. Make the suffix unconditional instead of preferred — the existing `inline-shapes-client.ts` byte
   comparison and the three `PlaceOrderResponse201` assertions fail, which is the consumer-visible
   rename the preference exists to avoid.
3. Apply the fallback to the response arm only — the request-body case in `codegen-name-collision`
   still throws, showing the fix had closed one of four instances of the same defect.
4. Revert the `Blob` arm — `inject-multipart-blob` fails with the two producers disagreeing,
   `inject` answering `500` where `fetch` answers `200`.
5. Delete the third codegen fixture — `deno task check` stops covering the emitted shape, which is
   the M70m lesson about fixtures being the only thing that keeps generated output gated.

Beyond the gates: regenerate a client from a RUNNING application's `/openapi.json` (the Part 12 X53
exercise does exactly this and currently fails) and confirm it now completes.

## 8. Risks & mitigations

- A consumer pinning an alias name in hand-written code breaks → it does not, for any document that
  generates today: the preferred name is the name already emitted, and the fallback is reached only
  where generation previously aborted outright. The existing fixture comparison is the guard.
- A document collides on every candidate, so the alias ends in a numeric suffix → it generates and
  compiles, which is the point; the name is an implementation detail of an anonymous shape, and the
  numbering is deterministic for a given document.
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
