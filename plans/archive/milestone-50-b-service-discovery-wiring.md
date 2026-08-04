# Milestone 50b — CLI microservice template (`@hono-enterprise/cli`)

> **Status:** Planning. Branch: `feat/m50b-service-discovery-wiring`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

M50 shipped `service-discovery-plugin`, but nothing wires it: a developer scaffolding a microservice
with `honoe new --template microservice` gets messaging, queues, resilience and telemetry — the four
plugins a service needs to talk to others — and then hard-codes the URLs of the services it calls.
This milestone adds `ServiceDiscoveryPlugin` to that one template so the capability is present from
the first commit of a generated project. It changes no default of any published library: the CLI
emits inline wiring, so only newly scaffolded projects are affected, and existing projects are
untouched.

- **In scope:** one `Wiring` entry on `MICROSERVICE_TEMPLATE`, carrying `args` because the plugin
  factory takes required options; the test coverage that proves the generated project still
  type-checks; the doc rows that name the new plugin.
- **NOT this milestone:** a `serviceDiscovery` arm on `MicroserviceStarterOptions` (see §9 — the
  starter is a published library and the arm is a separate, non-breaking addition); a gRPC or
  service-discovery **example application**, which is M37; a `honoe generate` schematic for a
  discovery-backed client, which no milestone owns yet.

## 1. Contracts verified from SOURCE (not names)

| Reference                  | Source (file:line)                                                            | Verified surface / fact                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServiceDiscoveryPlugin`   | `packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts:51` | `(options: ServiceDiscoveryPluginOptions)` — options are **required**, there is no zero-argument call. This is what forces `args`.                                              |
| `StaticDiscoveryOptions`   | `packages/service-discovery-plugin/src/options.ts:46,48`                      | `provider: 'static'` discriminant plus `services: Readonly<Record<string, readonly StaticServiceDefinition[]>>`. Nothing else is required, so `services: {}` satisfies the arm. |
| `StaticServiceDefinition`  | `packages/service-discovery-plugin/src/interfaces/index.ts:141-155`           | `host` and `port` required; `id`/`secure`/`weight`/`tags`/`metadata` optional. Only relevant to what a developer types after scaffolding — the emitted map is empty.            |
| `Wiring.args`              | `packages/cli/src/templates/registry.ts:44`                                   | Optional string rendered verbatim as the call's argument list, without enclosing parentheses. Authored in-repo, never from user input.                                          |
| `MICROSERVICE_TEMPLATE`    | `packages/cli/src/templates/microservice.ts:21`                               | Composes `REST_PLUGINS` and appends four wirings; `unsupported` already refuses `cloudflare-workers`.                                                                           |
| Generated imports / deps   | `packages/cli/src/commands/new.ts:118,312,534`                                | The import line, the Deno import-map entry and the npm `dependencies` entry are all derived from the `plugins` wirings. Adding a wiring needs no separate manifest edit.        |
| Drift-gate package mapping | `packages/cli/test/e2e/template-e2e.test.ts:103`                              | Non-starter packages map to `packages/<name>`, which is where `service-discovery-plugin` lives, so the gate resolves it from this workspace rather than JSR.                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                  | Resolution (picked side)                                                                                        | Doc deliverable (same PR)                                                             |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md:5212` records `release:create-packages` / `release:link-repos` as pending "before the next tag"; both ran for alpha.4 on 2026-08-04.                                                                          | Stale — the gate is discharged for alpha.4 and re-arms only when a package is added.                            | Reword that ROADMAP line to describe the recurring rule rather than a pending action. |
| C2 | The `microservice` template's `unsupported` reason names only "messaging and queue" as the Workers blocker; `service-discovery-plugin` is now also in the set and its DNS-SRV arm needs `runtime.dns`, absent on Workers. | Keep the refusal and widen the reason. The template was already refused, so this changes wording, not behavior. | Update the `unsupported['cloudflare-workers']` string and the template's JSDoc.       |

## 3. Design decisions

### 3.1 What the emitted `args` string contains

- **Decision:** `{ provider: 'static', services: {} }` — the static arm with an empty service map.
- **Why:** The factory takes required options, so something must be emitted. `'static'` is the only
  arm needing no infrastructure and no credential, so it is the only one that can boot an
  unconfigured project. The map is empty rather than carrying a worked sample because a sample would
  fabricate a dependency: `resolve('billing')` would hand back an instance pointing at a dead port,
  which is worse than resolving nothing. `options.ts:56` documents an unknown name resolving to
  `[]`, so an empty map is inert rather than an error.
- **Test home:** `template-e2e.test.ts` — "scaffolds a microservice whose service discovery boots".

### 3.2 Where the wiring sits in the template's plugin list

- **Decision:** Appended after `TelemetryPlugin`, at the end of `MICROSERVICE_TEMPLATE.plugins`.
- **Why:** Array position does not establish registration order — the kernel's resolver sorts by
  `priority` and only then by registration order, and `ServiceDiscoveryPlugin` is
  `PLUGIN_PRIORITY.NORMAL` like its neighbours. Position is therefore purely about reading order in
  the generated `honoe.config.ts`, and last keeps the existing four lines byte-identical.
- **Test home:** `microservice-template.test.ts` — asserts the rendered plugin order.

### 3.3 Whether the REST template also gets it

- **Decision:** No. `MICROSERVICE_TEMPLATE` only.
- **Why:** The tier boundary the repo already draws: REST carries ingress concerns, microservice
  adds the egress ones (messaging, queue, resilience, telemetry). Resolving _other_ services is
  egress. A REST project that needs it adds one `app.register(...)` line.
- **Test home:** `microservice-template.test.ts` — asserts the REST template's plugin list is
  unchanged.

## 4. Exported surface — every symbol names its consumer

No new exported symbol. This milestone adds one entry to an existing non-exported `const` array
inside `packages/cli/src/templates/microservice.ts`; `MICROSERVICE_TEMPLATE` itself is already
exported and already consumed by `TEMPLATE_REGISTRY` at `registry.ts:245`.

| Exported symbol         | Kind  | Consumer / real code path that READS it                                                                                                  |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `MICROSERVICE_TEMPLATE` | const | Already exported. Read by `TEMPLATE_REGISTRY` (`registry.ts:245`), which `getTemplate` resolves for `honoe new --template microservice`. |

### 4.1 Options — every option names its consumer

| Option               | Consumer                                                                  | Behavior (per implementation)                                                                                                               |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider: 'static'` | `resolveOptions` (`options.ts`), called eagerly by the factory at line 54 | Selects the static arm, which reads `services` and contacts no backend.                                                                     |
| `services: {}`       | `StaticProvider`, via the resolved options                                | Every `resolve(name)` returns `[]` until the developer adds entries. `pick` on an empty list follows the plugin's existing empty-pool path. |

## 5. Implementation files

| File                                         | Purpose                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/cli/src/templates/microservice.ts` | Add the `service-discovery-plugin` wiring with its `args`; widen the `unsupported` reason (C2). |

No `src/index.ts` change: the CLI's barrel does not export templates, and this milestone adds no
symbol.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

`microservice.ts` is a data module — one exported object literal, no branches — so its coverage is
driven entirely by the tests that read it. The existing suite already covers it; these tests pin the
new behavior.

| Test file                                                                 | src covered                                    | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/unit/templates/microservice-template.test.ts` (extend) | `templates/microservice.ts`                    | The template's plugin list contains `service-discovery-plugin` with `symbol: 'ServiceDiscoveryPlugin'` and the exact `args` string; the wiring is last; `REST_TEMPLATE.plugins` is unchanged (§3.3). Reads `TemplateDefinition` from `registry.ts:44`.                                                                                                                        |
| `packages/cli/test/e2e/template-e2e.test.ts` (extend)                     | `templates/microservice.ts`, `commands/new.ts` | Scaffolding `--template microservice` emits the import, the import-map entry and the npm dependency for `service-discovery-plugin`; the project `deno check`s against THIS workspace (the gate's `useWorkspacePackages`), which is what proves the emitted `args` type-checks against the real `ServiceDiscoveryPluginOptions` union rather than against a string we assumed. |
| `packages/cli/test/e2e/template-e2e.test.ts` (extend)                     | `templates/microservice.ts`                    | `--template microservice --runtime cloudflare-workers` still exits non-zero, with the widened reason (C2).                                                                                                                                                                                                                                                                    |

The `deno check` in the second row is the load-bearing one: `args` is a rendered string, so a typo
in the option shape is invisible to `deno check` of the CLI itself and only surfaces when the
generated project is type-checked.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m50b-service-discovery-wiring, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on a COMMITTED tree — the CLI is a published package
deno task release:verify 0.1.0-alpha.4
```

## 8. Risks & mitigations

- The emitted `args` string is not type-checked by the CLI's own `deno check`, because it is a
  string literal → mitigated by the e2e gate type-checking the _generated_ project against this
  workspace (§6, row 2). This is the same seam that caught `ctx.request.params` in M34.
- A future rename in `ServiceDiscoveryPluginOptions` would silently invalidate the string → same
  mitigation; the drift gate fails when the generated project stops compiling against HEAD.
- Scaffolded projects gain a dependency they may not use → accepted: it matches the four plugins the
  template already registers unconditionally, and the plugin contacts no backend on the static arm.

## 9. Out of scope

- **A `serviceDiscovery` arm on `MicroserviceStarterOptions`.** The starter is a published library
  and the CLI templates never import a starter (M36b's inline-wiring rule), so the two are separate
  surfaces with separate audiences. Adding an optional arm later is non-breaking. Owned by a
  follow-up if wanted; deliberately not folded in here to keep this milestone to one file.
- **Example applications** demonstrating discovery against a live Consul or Kubernetes — M37.
- **The three softer JSR runtime-compat calls** (`messaging-plugin`, `queue-plugin`,
  `service-discovery-plugin` marked no-edge) — a metadata decision, not a code one; owned by the
  next release's metadata pass.
