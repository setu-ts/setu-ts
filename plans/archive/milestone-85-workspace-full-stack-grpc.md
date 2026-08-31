# Milestone 85 — Workspace Full-Stack gRPC (`@setu-ts/cli`)

> **Status:** Complete (PR pending). Branch: `fix/x14-1-full-stack-grpc`. This is a repair to
> behavior already merged on `main`; it remains isolated in this worktree until review and merge.

## 0. Objective & scope

Close smoke finding X14-1: permit `setu generate app <name> --template full-stack` in a workspace
whose transport is `grpc`, and render the transport's `GrpcPlugin()` registration after the
full-stack starter factory has created the application. The repair is confined to the CLI renderer,
its regression coverage, and the public CLI contract that describes the supported composition.

- **In scope:** app-factory rendering of appended transport plugin wirings; lifting the gRPC-only
  refusal; generated-project regression coverage; the public transport documentation.
- **NOT this milestone:** X14-2's CSRF path exemption and a full-stack gRPC default exemption;
  broker transports, whose contribution rewrites starter-owned `MessagingPlugin` arguments; native
  gRPC-binary support, which Milestone 70i deliberately withdrew.

## 1. Contracts verified from SOURCE (not names)

| Reference               | Source (file:line)                                | Verified surface / fact                                                                                                   |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `TransportSpec.plugins` | `packages/cli/src/workspace/transport.ts:132`     | A transport contributes `Wiring` records containing a package and plugin-factory symbol.                                  |
| gRPC transport          | `packages/cli/src/workspace/transport.ts:276`     | The `grpc` arm contributes exactly `{ pkg: 'grpc-plugin', symbol: 'GrpcPlugin' }`; it has no messaging-argument rewrite.  |
| workspace overlay       | `packages/cli/src/workspace/member-host.ts:116`   | The overlay appends transport wirings to the resolved host, including an app-factory host.                                |
| app-factory renderer    | `packages/cli/src/templates/project-files.ts:347` | The current branch awaits the factory and returns without consuming `host.plugins`, which drops the appended gRPC wiring. |
| plugin registration     | `packages/common/src/interfaces/plugin.ts:195`    | `IApplication.register(plugin)` adds a plugin before `start()` resolves registrations.                                    |
| full-stack factory      | `packages/cli/src/templates/full-stack.ts:158`    | The template uses `createFullStackAppFromConfig` and has no template-owned direct plugin wirings.                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                    | Resolution (picked side)                                                                                                                            | Doc deliverable (same PR)                                                                     |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| C1 | The workspace transport table says every `grpc` member gets `GrpcPlugin`, while `planMember` rejects a full-stack member before it can receive that plugin. | Restore the documented behavior for gRPC only. Broker arms stay refused because their option rewrites cannot be represented by the starter factory. | Add the full-stack gRPC registration detail to the `PUBLIC_API.md` workspace transport table. |

## 3. Design decisions

### 3.1 App-factory transport plugin registration

- **Decision:** The config renderer will emit `app.register(<transport-plugin-factory>());` after
  awaiting the starter factory, once for every resolved direct `Wiring` in `host.plugins`.
- **Why:** The workspace overlay already supplies the only supported gRPC wiring in the same data
  structure used by non-factory templates. Registering it before `createApp()` returns preserves the
  starter's owned plugin set and lets the kernel resolve dependency order at startup.
- **Test home:** `packages/cli/test/unit/app-command.test.ts` checks the generated full-stack gRPC
  config; `packages/cli/test/e2e/workspace-e2e.test.ts` type-checks that generated config.

### 3.2 Refusal boundary

- **Decision:** `planMember` will refuse an app-factory template only when the workspace transport
  supplies `messagingArgs`, not merely when it appends direct plugin wirings.
- **Why:** gRPC is an append-only plugin contribution and the renderer can preserve it. Broker arms
  modify the starter-owned messaging configuration; accepting one would still produce a member that
  appears configured while using the wrong broker.
- **Test home:** `packages/cli/test/unit/app-command.test.ts` proves gRPC succeeds and Redis retains
  the existing no-write refusal.

## 4. Exported surface — every symbol names its consumer

| Exported symbol | Kind                 | Consumer / real code path that READS it                                           |
| --------------- | -------------------- | --------------------------------------------------------------------------------- |
| None (checked)  | No new public export | This repair consumes existing `Wiring` and `IApplication.register` surfaces only. |

### 4.1 Options — every option names its consumer

| Option         | Consumer      | Behavior (per implementation)                                              |
| -------------- | ------------- | -------------------------------------------------------------------------- |
| None (checked) | No new option | The existing workspace `transport` field selects the existing gRPC wiring. |

## 5. Implementation files

| File                                          | Purpose                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/cli/src/templates/project-files.ts` | Register resolved direct plugins after an app factory returns an application.                        |
| `packages/cli/src/commands/app.ts`            | Restrict the starter-template refusal to transports requiring messaging-argument rewrites.           |
| `packages/cli/src/templates/registry.ts`      | Correct the `TemplateHost.plugins` documentation to describe supported factory-time registrations.   |
| `packages/cli/test/unit/app-command.test.ts`  | Prove a full-stack gRPC workspace member is generated and brokers remain refused.                    |
| `packages/cli/test/e2e/workspace-e2e.test.ts` | Type-check a real generated full-stack member on the gRPC transport.                                 |
| `PUBLIC_API.md`                               | Document that the full-stack factory registers the workspace gRPC plugin before application startup. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                     | src covered                                                              | Key assertions (and the signature each call type-checks against)                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/unit/app-command.test.ts`  | `commands/app.ts`, `templates/project-files.ts`, `templates/registry.ts` | `runAppCommand()` accepts the gRPC/full-stack pair, emits the `GrpcPlugin` import and `app.register(GrpcPlugin())`, and preserves the Redis refusal with no filesystem writes.                 |
| `packages/cli/test/e2e/workspace-e2e.test.ts` | `commands/app.ts`, `templates/project-files.ts`                          | A real CLI-created gRPC workspace accepts a full-stack member; its generated `main.ts` and `setu.config.ts` pass `deno check` using the emitted `createApp(): Promise<IApplication>` contract. |

## 7. Verification gates

```bash
git branch --show-current   # MUST be fix/x14-1-full-stack-grpc, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task publish:check
deno task release:verify <version>
```

## 8. Risks & mitigations

- App-factory hosts could register a plugin already included by their starter → cover the full-stack
  gRPC output specifically, retain its empty base template plugin list, and rely on the existing
  transport registry collision test for non-factory hosts.
- Broadening the refusal could permit broker transports that still lose their rewritten arguments →
  key the refusal on `messagingArgs` and retain the Redis negative-control assertion.

## 9. Out of scope

- X14-2, which needs an explicit CSRF path-exclusion design across session, gRPC, and the full-stack
  starter; it remains a separate defect and is not hidden by enabling the CLI composition.
