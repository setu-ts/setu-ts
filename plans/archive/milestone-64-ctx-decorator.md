# Milestone 64 — `@Ctx()` (`@setu-ts/decorator-plugin`)

> **Status:** Complete (PR pending). Branch: `feat/m64-ctx-decorator`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Ship `@Ctx()` as the decorator plugin's built-in request-context parameter decorator. It captures a
`custom` parameter with the built-in `context` custom type and resolves it to the live
`IRequestContext`, allowing a decorated handler to set status and headers or return a streaming
`HandlerResult` without falling back to programmatic routing. The change is an additive export in
the existing decorator package: no common-contract change, plugin option, token, dependency, or
resolver-registration side effect.

- **In scope:** Built-in `@Ctx()` capture and resolution, barrel export, package README and
  `PUBLIC_API.md` updates, metadata/resolver unit coverage, and a real decorator-plugin application
  test proving a controller returns `201` and a `Location` header through the injected context.
- **NOT this milestone:** M65 owns switching generator defaults and any generated-controller shape;
  M68 owns unrelated common/kernel contract gaps. This milestone does not alter
  `createParameterDecorator`, the custom resolver registry, `IRequestContext`, or the behavior of
  existing parameter decorators.

## 1. Contracts verified from SOURCE (not names)

| Reference                        | Source (file:line)                                                       | Verified surface / fact                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IRequestContext`                | `packages/common/src/http.ts:205-234`                                    | The live per-request context exposes readonly `request`, `response`, `services`, `params`, `query`, `state`, `startTime`, and `signal`; `response` is the response builder a decorated handler needs.                                            |
| `IResponse`                      | `packages/common/src/http.ts:91-197`                                     | `status(code)` and `header(name, value)` chain, while terminal methods such as `json`, `send`, and `stream` return `HandlerResult`.                                                                                                              |
| `ParameterMetadata`              | `packages/decorator-plugin/src/metadata/metadata-store.ts:25-44`         | Built-ins store an index plus a `ParameterType`; `custom` parameters carry `customType?: string` and optional metadata. No new metadata field or type-union member is needed.                                                                    |
| Existing request decorators      | `packages/decorator-plugin/src/decorators/request.ts:20-96`              | Each returns a `ParameterDecorator` and writes parameter metadata through `metadataStore.storeParam(protoToCtor(target), String(propertyKey), ...)`.                                                                                             |
| Existing `current-user` built-in | `packages/decorator-plugin/src/decorators/security.ts:58-73`             | `@CurrentUser()` uses `type: 'custom'` and `customType: 'current-user'`; it is the precedent for a built-in custom parameter type.                                                                                                               |
| Parameter resolution             | `packages/decorator-plugin/src/resolvers/parameter-resolver.ts:90-127`   | `resolveParameter` delegates `custom` values to `resolveCustom`; that function resolves `current-user` directly, then delegates other types to a registered custom resolver, otherwise returns `undefined`.                                      |
| Decorated handler execution      | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:288-305`       | The plugin awaits `resolveParameters(ctx, route.params)` and invokes the controller method with that argument array; it never passes context positionally. A context decorator must therefore resolve the same `ctx` instance through that path. |
| Public barrel                    | `packages/decorator-plugin/src/index.ts:28-36`                           | Request parameter decorators and `CurrentUser` are published named exports; adding `Ctx` is an additive public API change requiring JSDoc and `PUBLIC_API.md`.                                                                                   |
| Existing behavioral test harness | `packages/decorator-plugin/test/e2e/decorator-application.test.ts:19-96` | A real kernel application uses a fake runtime provider, `DecoratorPlugin({ controllers })`, `app.start()`, and `app.inject()`; it can prove both routing and response behavior.                                                                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                            | Resolution (picked side)                                                                                 | Doc deliverable (same PR)                                                                                                                  |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | None found: ROADMAP, `PUBLIC_API.md`, and the package README all correctly describe the currently missing context decorator and source confirms it. | Preserve the documented existing behavior and describe the new additive built-in exactly as implemented. | Add `Ctx` to the decorator-plugin export/reference tables and usage guidance in `PUBLIC_API.md` and `packages/decorator-plugin/README.md`. |

## 3. Design decisions

### 3.1 Built-in context metadata

- **Decision:** `Ctx()` will live beside `CurrentUser()` in `src/decorators/security.ts` and store
  `{ index, type: 'custom', customType: 'context' }` through the existing metadata store.
- **Why:** The established built-in custom-parameter mechanism already carries the required behavior
  without expanding `ParameterType` or creating an application-visible registration. Keeping both
  built-ins together makes the direct resolution rule discoverable in one place.
- **Test home:** `test/unit/security-decorator.test.ts` asserts the captured metadata and
  `test/e2e/decorator-application.test.ts` proves it reaches a handler at runtime.

### 3.2 Resolver behavior and precedence

- **Decision:** `resolveCustom` will recognize `customType === 'context'` and return the exact
  `IRequestContext` instance before consulting the registered custom-resolver map; `current-user`,
  registered custom types, and unknown types retain their current behavior.
- **Why:** A built-in must work when an application has registered nothing and must not be
  replaceable accidentally by a registry entry of the same name. This mirrors the existing direct
  `current-user` branch and keeps custom resolver extension behavior unchanged for all other names.
- **Test home:** `test/unit/parameter-resolver.test.ts` checks identity equality for `context`,
  including when a resolver named `context` is registered; existing tests pin the non-context paths.

### 3.3 Handler-level response behavior

- **Decision:** The integration scenario will type its `@Ctx()` argument as `IRequestContext`, set
  `201`, set `Location`, and return `ctx.response.json(...)` from a decorated `POST` handler.
- **Why:** It exercises the user-visible gap rather than only metadata or a resolver in isolation: a
  decorator must place the correct context at the correct parameter index and the handler result
  must preserve its configured response state.
- **Test home:** `test/e2e/decorator-application.test.ts` boots the real plugin and asserts status,
  header, and JSON body from `app.inject()`, whose committed `InjectResponse` includes the live
  response headers.

### 3.4 Public documentation and compatibility

- **Decision:** Publish one named `Ctx` function with full JSDoc and list it as a request parameter
  decorator in the barrel, README, and `PUBLIC_API.md`; no option or capability token is added.
- **Why:** `src/index.ts` defines public API. Adding an export is backward-compatible and is
  explicitly the M64 deliverable; an option would be unread dead surface because resolution has no
  configuration.
- **Test home:** A barrel import in the e2e test ensures the published export is usable;
  documentation gates check the generated README export table.

## 4. Exported surface — every symbol names its consumer

| Exported symbol | Kind     | Consumer / real code path that READS it                                                                                                                                   |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctx`           | function | Application controller method parameter declarations; `DecoratorPlugin` reads its stored metadata through `resolveParameters`, which supplies the handler's live context. |

### 4.1 Options — every option names its consumer

None (checked): `Ctx()` accepts no options, and this milestone adds no configuration surface.

## 5. Implementation files

| File                                  | Purpose                                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/decorators/security.ts`          | Add the documented `Ctx()` parameter decorator alongside the existing `CurrentUser()` built-in.                                                |
| `src/resolvers/parameter-resolver.ts` | Resolve the `context` built-in custom type to the active request context before custom resolver lookup.                                        |
| `src/index.ts`                        | Re-export `Ctx` from the public decorator-plugin barrel.                                                                                       |
| `README.md`                           | Add `Ctx` to the package's parameter/export documentation.                                                                                     |
| `PUBLIC_API.md`                       | Add `Ctx` to the authoritative decorator-plugin values table and explain that it injects `IRequestContext` for response control and streaming. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                          | src covered                                                            | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/decorator-plugin/test/unit/security-decorator.test.ts`   | `src/decorators/security.ts`                                           | A controller method `create(@Ctx() ctx: IRequestContext)` stores one parameter record at its declared index with `type: 'custom'` and `customType: 'context'`.                                                                                             |
| `packages/decorator-plugin/test/unit/parameter-resolver.test.ts`   | `src/resolvers/parameter-resolver.ts`                                  | `resolveParameter(ctx, { index: 0, type: 'custom', customType: 'context' })` returns the same `IRequestContext`; a registered `context` resolver cannot replace the built-in. Existing custom and unknown-type tests preserve all other branches.          |
| `packages/decorator-plugin/test/e2e/decorator-application.test.ts` | `src/index.ts`; end-to-end path through the three changed source files | Imports `Ctx` from the package barrel, boots a decorated controller, then its `create(@Ctx() ctx: IRequestContext)` returns `ctx.response.status(201).header('Location', '/users/2').json({ id: '2' })`; `app.inject()` asserts 201, `Location`, and body. |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m64-ctx-decorator, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
```

After the implementation is committed, run:

```bash
deno task publish:check
deno task release:verify 0.1.0-alpha.7
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/decorator-plugin/src
```

## 8. Risks & mitigations

- The e2e test could prove only serialization while hiding lost response headers → assert `Location`
  explicitly through `app.inject()`, whose `InjectResponse.headers` exposes them.
- A registry entry accidentally overriding the built-in would make application behavior
  order-dependent → test direct built-in precedence with a deliberately registered resolver of the
  same name.
- A barrel omission can leave internal tests green → import `Ctx` from `src/index.ts` in the
  behavioral test and run the documentation export check.

## 9. Out of scope

- Generator changes that start emitting `@Ctx()` in controllers belong to M65, which owns the two
  generator worlds.
- New context fields or a common-package widening belong to M68 if a future need cannot be served by
  the committed `IRequestContext` contract.
- Application-defined custom parameter decorators remain supported by the existing
  `createParameterDecorator` and `registerParameterResolver` APIs and are not changed here.
