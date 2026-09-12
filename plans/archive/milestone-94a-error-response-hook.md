# Milestone 94a — Exceptions (`@setu-ts/exceptions`)

> **Status:** Complete (PR pending). Branch: `feat/m94a-error-response-hook`. `main` is protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Add an optional application-owned `respond` hook to `errorHandler()` so an application can turn a
caught, normalized exception into its own `HandlerResult` (for example, an HTML error view) without
`@setu-ts/exceptions` importing a view package. The hook is a narrow replacement for the
caught-error formatter path: returning `undefined` preserves the current formatter, content type,
and JSON/Problem Details behaviour byte-for-byte.

- **In scope:** `packages/exceptions`' existing `ErrorHandlerOptions` public type, catch-path
  dispatch, direct unit/integration coverage, and accurate package/API/architecture documentation.
- **NOT this milestone:** Content negotiation, kernel re-execution, and responder-produced terminals
  (unmatched-path 404, malformed-request 400, drain 503) remain on the M70f `IErrorResponder`
  formatter seam; form-body parsing and multipart CSRF are M94b; the CSRF field helper is M94c.

## 1. Contracts verified from SOURCE (not names)

| Reference                              | Source (file:line)                                                                                    | Verified surface / fact                                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HandlerResult`                        | `packages/common/src/http.ts:17-28`                                                                   | An opaque brand returned by `IResponse` terminal methods; only the kernel constructs it.                                                                          |
| `IRequestContext` and response writer  | `packages/common/src/http.ts:153-260`, `packages/common/src/http.ts:269-308`                          | `IResponse.html()` returns `HandlerResult`, and a live context carries that response builder; the catch path owns such a context at `error-handler.ts:146-153`.   |
| `HttpError` normalization              | `packages/exceptions/src/middleware/error-handler.ts:157-203`                                         | Every caught value becomes an `HttpError`; hinted errors and masked non-`HttpError` 5xx values rebuild the response error before it is served.                    |
| Serveable status resolution            | `packages/exceptions/src/middleware/error-handler.ts:205-224`                                         | `resolveResponseStatus` runs before logging and formatting, so the response error's `statusCode` is the status actually served.                                   |
| Existing formatting tail               | `packages/exceptions/src/middleware/error-handler.ts:226-262`                                         | Logging precedes `formatter(responseError, ctx)`; the formatter writes JSON bytes with the selected content type.                                                 |
| `ErrorHandlerOptions` exported surface | `packages/exceptions/src/middleware/error-handler.ts:49-93`, `packages/exceptions/src/index.ts:55-57` | The interface is already the sole public configuration type; extending it adds no barrel symbol.                                                                  |
| Formatter contract                     | `packages/exceptions/src/formatters/error-formatter.ts:33-36`                                         | Formatters return only `Record<string, unknown>`, which cannot express an HTML, stream, or other `HandlerResult`.                                                 |
| Responder seam boundary                | `packages/exceptions/src/middleware/error-responder-impl.ts:131-180`                                  | `IErrorResponder` builds/formats its own error bodies and may receive only a bare target, so it cannot honestly invoke a hook requiring a full `IRequestContext`. |
| Existing faithful response fixture     | `packages/exceptions/test/fixtures/fake-runtime.ts:70-140`                                            | The fake records status, headers, and all `json`/`text`/`html`/`send` writes, including `text/html; charset=utf-8` from `html()`.                                 |
| Real application composition           | `packages/exceptions/test/integration/error-handler-app.test.ts:24-58`                                | A test app registers the handler outermost, starts the kernel pipeline, then observes native `Response` status, headers, and body via `app.fetch`.                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                               | Resolution (picked side)                                                                                    | Doc deliverable (same PR)                                                              |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| C1 | `packages/exceptions/src/middleware/error-handler.ts:86` defines `maskInternalErrors`, but the README options table at `packages/exceptions/README.md:35-39` omits it. | Source is the contract; document the existing option and the new `respond` option together.                 | Update the README options table and explanatory text.                                  |
| C2 | `PUBLIC_API.md:9740` lists the existing option set, while the M94a source change adds `respond`.                                                                       | Extend the authoritative API description with the exact callback signature and fallback semantics.          | Update the `ErrorHandlerOptions` row and contract notes in `PUBLIC_API.md`.            |
| C3 | `ARCHITECTURE.md:2278-2291` describes the formatter seam as the whole exception response tail, but M94a permits an application result before that formatter.           | Keep the responder seam description; add the catch-path hook's explicit scope and its `undefined` fallback. | Update the Global Error Handler / Error Responder Seam narrative in `ARCHITECTURE.md`. |

## 3. Design decisions

### 3.1 One optional hook on the existing options interface

- **Decision:** Add
  `readonly respond?: (error: HttpError, ctx: IRequestContext) => HandlerResult | undefined` to
  `ErrorHandlerOptions`; do not introduce a second exported responder type or a capability token.
- **Why:** `ErrorHandlerOptions` is already exported and read by `errorHandler()`. The normalized
  error is always an `HttpError`, so an application can reliably read the served `statusCode`; the
  live context supplies the response writer that constructs the opaque `HandlerResult`. The callback
  is application code, not a dependency on `view-plugin`.
- **Test home:** `packages/exceptions/test/unit/error-handler.test.ts` and
  `packages/exceptions/test/integration/error-handler-app.test.ts`.

### 3.2 Hook placement and fallback

- **Decision:** Resolve `respond` once at middleware-factory time. In the catch path, normalize,
  apply status hint/masking, resolve a serveable status, and log exactly as today; then call
  `respond(responseError, ctx)` immediately before `formatter(responseError, ctx)`. A returned
  `HandlerResult` is returned unchanged and skips formatter serialization and exception-owned
  content-type writes. Only `undefined` falls through to the existing formatter path.
- **Why:** The hook receives the same status-safe and disclosure-safe error that would otherwise be
  formatted, while logging still records the original unmasked error. A returned result makes the
  application responsible for its body, headers, and status write; the `undefined` path is the
  compatibility guarantee. The hook is synchronous exactly as the roadmap's working shape specifies.
- **Test home:** `packages/exceptions/test/unit/error-handler.test.ts` asserts the HTML result, hook
  inputs, logging order/effect, and formatter fallback;
  `packages/exceptions/test/integration/error-handler-app.test.ts` asserts status,
  `text/html; charset=utf-8`, and body through a real kernel fetch.

### 3.3 Boundary with M70f responder terminals

- **Decision:** Do not pass `respond` into `createErrorResponder` or change `IErrorResponder`; its
  404/400/503 and short-circuit outputs keep the selected formatter.
- **Why:** The responder is used before a full request context exists and owns a different
  `ErrorResponseInit` contract. Giving it a callback that claims to receive `IRequestContext` would
  be false, while widening common/kernel would exceed M94a's `packages/exceptions` boundary.
- **Test home:** Existing `error-responder-impl.test.ts`, `error-responder-install.test.ts`,
  `short-circuit-format.test.ts`, and `error-format-agreement.test.ts` continue to prove that seam;
  the M94a regression tests prove the new hook is only in the caught-error path.

### 3.4 Callback failure

- **Decision:** Do not catch an exception thrown by `respond`; it is application code executing its
  own response path and follows ordinary middleware error propagation.
- **Why:** The specified fallback sentinel is `undefined`, not an exception. Swallowing a rendering
  failure would hide a programming error and create a second, undocumented error policy; callers
  that want the existing formatter return `undefined` before writing.
- **Test home:** No new assertion: this preserves the middleware's normal rule that errors thrown
  while handling a response are not silently swallowed. The public documentation states the only
  fallback mechanism.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                             | Kind               | Consumer / real code path that READS it                                                                                                 |
| ------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ErrorHandlerOptions` (extended)            | exported interface | `errorHandler()` reads `respond` once at factory creation; applications supply the callback in their middleware configuration.          |
| `errorHandler` (existing, changed behavior) | function           | Applications register the returned `MiddlewareFunction` in the kernel pipeline; it dispatches to the option callback on a caught error. |

### 4.1 Options — every option names its consumer

| Option                                                                             | Consumer                    | Behavior (per implementation)                                                                                                                                                |
| ---------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `respond?: (error: HttpError, ctx: IRequestContext) => HandlerResult \| undefined` | `errorHandler()` catch path | Receives the normalized, masked/hinted, status-sanitized error after normal logging; returned result bypasses formatting, `undefined` uses the existing formatter unchanged. |

## 5. Implementation files

| File                                                             | Purpose                                                                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/exceptions/src/middleware/error-handler.ts`            | Extend the options JSDoc/signature, capture the callback at factory time, and dispatch it between existing logging and formatting. |
| `packages/exceptions/test/unit/error-handler.test.ts`            | Cover hook response, input normalization, fallback, and preserved logging with the existing faithful context/response fake.        |
| `packages/exceptions/test/integration/error-handler-app.test.ts` | Drive a thrown route through a real kernel app and prove the application-owned HTML status/header/body result.                     |
| `packages/exceptions/README.md`                                  | Document all current handler options, including the existing masking option and new response hook semantics.                       |
| `PUBLIC_API.md`                                                  | Update the exceptions public contract table/notes for the widened options interface.                                               |
| `ARCHITECTURE.md`                                                | Document the explicit catch-path override and its separation from the responder seam.                                              |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                                                                                  | src covered                                           | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/exceptions/test/unit/error-handler.test.ts`                                                                                                                                                                      | `packages/exceptions/src/middleware/error-handler.ts` | `errorHandler({ respond: (error: HttpError, ctx: IRequestContext): HandlerResult => ctx.response.status(error.statusCode).html(...) })` returns the hook's result with HTML headers/body; an unhandled driver error reaches the hook as masked `500`; returning `undefined` preserves default and RFC 9457 formatter shapes/content types; the logger still records the original error. |
| `packages/exceptions/test/integration/error-handler-app.test.ts`                                                                                                                                                           | `packages/exceptions/src/middleware/error-handler.ts` | A real `app.fetch()` request that throws `notFound()` gets the application callback's status, `text/html; charset=utf-8`, and HTML body, proving the kernel transports the `HandlerResult` unchanged.                                                                                                                                                                                   |
| Existing `packages/exceptions/test/unit/error-responder-impl.test.ts`, `test/unit/error-responder-install.test.ts`, `test/integration/short-circuit-format.test.ts`, and `test/integration/error-format-agreement.test.ts` | Existing, unchanged responder sources                 | Run as regression coverage for the explicit non-goal: responder terminals retain formatter-led JSON/Problem Details behaviour.                                                                                                                                                                                                                                                          |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m94a-error-response-hook, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

After committing the milestone tree, also run:

```bash
deno task publish:check
deno task release:verify 0.5.0
```

## 8. Risks & mitigations

- A hook could accidentally bypass masking or status validation → call it only after the existing
  normalization, masking/hint, status-resolution, and logging sequence; assert the masked error it
  observes.
- A callback that writes a response but returns `undefined` could be overwritten by formatter
  fallback → document and test that only a returned `HandlerResult` claims the response.
- A hook could silently expand to responder terminals that have no full context → retain the
  existing responder API and regression-test its formatter agreement.
- A stale package/API document could misstate the new public option → update README,
  `PUBLIC_API.md`, and architecture text in the same change and run docs/export checks through the
  normal gates.

## 9. Out of scope

- Automatic HTML/JSON content negotiation and ASP.NET-style error re-execution are not implemented;
  M94a supplies an explicit application callback only.
- `IRequest.formData?()`, shared multipart parsing, and multipart CSRF verification belong to M94b.
- A CSRF hidden-field helper and global-CSRF composition documentation belong to M94c.
