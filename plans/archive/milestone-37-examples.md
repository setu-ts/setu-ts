# Milestone 37 — Example Applications (`apps/*`)

> **Status:** Planning. Branch: `feat/m37-examples`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Every capability the framework ships is proven by unit and integration tests inside `packages/`, and
by nothing a reader can run. This milestone adds runnable applications under `apps/`, each
demonstrating one composition end to end, plus the CI gate that keeps them compiling. The ROADMAP's
example list predates 22 shipped milestones and names none of the capabilities added since M34 — it
is corrected here rather than implemented as written.

The bar for an example is **it runs and proves something**, not that it exists. Examples are not
coverage-gated (coverage measures `packages`), so a committed smoke check is the only thing standing
between a working example and a decorative one.

- **In scope:** ten example applications under `apps/`; adopting the existing `apps/graphql-demo`
  into the set; resolving the `examples/` vs `apps/` directory split; a CI gate that type-checks and
  smoke-runs every app.
- **NOT this milestone:** per-plugin prose documentation and the deploy matrix — M38. Dockerfiles,
  `docker-compose`, and Kubernetes manifests for the examples — M39; this milestone's Cloudflare
  example carries only its own `wrangler.toml`, which is the app's config rather than a deploy
  manifest.

## 1. Contracts verified from SOURCE (not names)

| Reference                          | Source (file:line)                                                        | Verified surface / fact                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/` is outside the workspace   | `deno.json:2-49`                                                          | The `workspace` array lists only `./packages/*` members. `apps/graphql-demo` is therefore not a workspace member, and its npm dependencies never enter a published package's dependency graph.                                                             |
| `apps/` IS already fmt- and linted | `deno.json` `fmt.exclude` / `lint`; `deno lint apps/` → "Checked 4 files" | Neither config excludes `apps/`, so the existing `fmt:check` and `lint` gates already cover it. **Only `check` and `test` are scoped** (`"check": "deno check packages"`).                                                                                 |
| Example app shape                  | `apps/graphql-demo/deno.json`, `main.ts`, `src/app.ts`, `interop.ts`      | Local `deno.json` with `tasks` + an `imports` map pointing every `@hono-enterprise/*` at `../../packages/<name>/src/index.ts`, plus npm specifiers. `main.ts` is the runnable entry; `interop.ts` is a separate real-client suite.                         |
| Connect runtime specifiers         | `packages/grpc-plugin/src/transports/connect-loader.ts:28-31`             | `npm:@connectrpc/connect@^2.1.2`, `…@^2.1.2/protocol`, `npm:@bufbuild/protobuf@^2.7.0`, `…@^2.7.0/wkt`. The gRPC example must pin these EXACT ranges or the plugin's lazy import resolves a second copy.                                                   |
| Real gRPC service definition       | `packages/grpc-plugin/test/fixtures/echo-descriptors.ts:1-12`             | A genuine `DescService` comes from a base64 `FileDescriptorSet` revived through the plugin's `ConnectRuntime` port (`reviveDescriptorSet` + `getService`), generated from a `.proto` with protoc. There is no codegen step in this repo and none is added. |
| Backplane transports               | `packages/realtime-backplane-plugin/src/interfaces/index.ts:116,126,152`  | `'messaging'`, `'redis'`, `'custom'`, plus the default `'memory'`. Only `'redis'` and `'messaging'` cross a process boundary — `'memory'` is a single-process bus, so a two-replica demo MUST NOT use it.                                                  |
| Cloudflare bindings are injected   | `packages/cloudflare-plugin` — no `cloudflare:workers` import anywhere    | The application passes `env` in; nothing under `packages/` imports the unresolvable specifier. The Workers example therefore wires `CloudflarePlugin({ env })` from its own `fetch(request, env)`.                                                         |
| Scaffolded Workers compat flags    | `packages/cli/src/commands/new.ts:567-568`                                | `compatibility_date = "2025-09-01"`, `compatibility_flags = ["nodejs_compat"]`. The Workers example's `wrangler.toml` matches these rather than inventing its own.                                                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                               | Resolution (picked side)                                                                                                                           | Doc deliverable (same PR)                                                      |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| C1 | Two directories exist for one concept: `ROADMAP.md:288-296` diagrams examples under `apps/`, while `ROADMAP.md:416` has M0 creating both `apps/` and `examples/`. Both are tracked; `examples/` holds only `.gitkeep`. | **`apps/` wins** — the structure diagram and the existing `apps/graphql-demo` both use it.                                                         | Delete `examples/.gitkeep`; correct the M0 directory list at `ROADMAP.md:416`. |
| C2 | `ROADMAP.md:3809-3817` lists seven examples naming no capability added after M34 (no Workers, gRPC, GraphQL, realtime, sessions, SDK).                                                                                 | Replace the list with the ten in §3.4. The M22/M23 note already asks for a Workers example and streaming/SSE; this makes that concrete.            | Rewrite the M37 example list and deliverables in `ROADMAP.md`.                 |
| C3 | `apps/graphql-demo` exists and is not mentioned by the M37 list, so the milestone would appear to deliver zero of the examples that already work.                                                                      | Adopt it as example 8. It already meets this milestone's bar (runnable, real-client interop) and needs only the gate and a row in the apps README. | Add it to the `apps/README.md` index and the ROADMAP list.                     |
| C4 | `CLAUDE.md`'s M51b entry says the graphql-demo interop suite is "**Not run by CI** — the gates are scoped to `packages`". §3.3 changes that.                                                                           | Gate the type-check and smoke run; leave the npm-client interop suite ungated (it needs `graphql-ws`/Apollo installs CI does not do).              | Amend that CLAUDE.md sentence to say which part is now gated and which is not. |

## 3. Design decisions

### 3.1 Directory

- **Decision:** every example lives under `apps/<name>/`. `examples/.gitkeep` is deleted.
  `kubernetes/.gitkeep` is left alone — M39 owns it.
- **Why:** C1. One concept, one directory, and `apps/graphql-demo` already set the precedent.
- **Test home:** none needed — a deleted empty directory has no behavior. The ROADMAP correction is
  the deliverable.

### 3.2 Examples stay OUT of the Deno workspace

- **Decision:** no `apps/*` entry is added to `deno.json`'s `workspace` array. Each app carries its
  own `deno.json` mapping `@hono-enterprise/*` to `../../packages/<name>/src/index.ts`.
- **Why:** the `graphql-demo` precedent, and it is load-bearing rather than stylistic: an example
  pulling `npm:@connectrpc/connect` or `npm:ioredis` into the workspace would put those in the
  dependency graph resolution of published packages. Pointing at `src/` rather than JSR is also more
  correct for a gate — drift means disagreement with HEAD, not with a published snapshot (the M34b
  drift-gate reasoning).
- **Test home:** `apps-gate.test.ts` — asserts no `apps/` path appears in the root `workspace`
  array.

### 3.3 The gate: type-check and smoke-run, never coverage

- **Decision:** a new root task `check:apps` walks every `apps/*/deno.json`, runs `deno check` on
  its entry points, and executes its `smoke` task where one is declared. A CI step runs it. Examples
  are **not** added to `deno task test` and **not** coverage-measured.
- **Why:** coverage measures `packages` and the 90% bar is a library standard; applying it to demo
  code would produce tests written to satisfy a number. What an example must not do is stop
  compiling or stop running, and those are exactly what `check` + `smoke` catch. `fmt` and `lint`
  already cover `apps/` with no change (§1), so this closes the whole remaining gap.
- **Test home:** `apps-gate.test.ts` — asserts every `apps/*` directory declares both a `start` and
  a `smoke` task, so a new example cannot join the tree ungated.

### 3.4 The ten examples, and what each must PROVE

Each `smoke` task exits non-zero unless its stated proof holds. A README claim is not a proof.

| #  | `apps/<name>`        | Proves (the smoke assertion)                                                                                                                                 |
| -- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1  | `minimal`            | Kernel + runtime only, one route, `200`.                                                                                                                     |
| 2  | `rest-api`           | CRUD through the REST starter with auth and OpenAPI; a **written row reads back** through the same API; `/openapi.json` validates against the served routes. |
| 3  | `microservices`      | Two services; A resolves B through `service-discovery-plugin`'s `'static'` arm and calls it; a brokered `request`/`respond` round-trips.                     |
| 4  | `cqrs`               | A command mutates and a query reads the mutation back through separate buses.                                                                                |
| 5  | `multi-tenant`       | Two tenants; tenant A's write is **not** visible to tenant B (the isolation assertion, not just resolution).                                                 |
| 6  | `plugin-development` | A custom plugin registers a capability and a route resolves it; includes its own test using `@hono-enterprise/testing`.                                      |
| 7  | `compiled-binary`    | `deno compile` produces a binary that serves a request.                                                                                                      |
| 8  | `graphql-demo`       | **Exists.** Adopted; gains `smoke` and a README index row.                                                                                                   |
| 9  | `grpc`               | A Connect client calls a real service over the same port as an ordinary Hono route, and both answer.                                                         |
| 10 | `cloudflare`         | `wrangler dev` serves a request, reads and writes KV, and runs a scheduled handler — the committed harness M52b/M52d used and threw away.                    |
| 11 | `realtime`           | **Two** replicas behind a `'redis'` backplane; a message published to replica A reaches a client connected to replica B.                                     |

Eleven rows for "ten examples": `graphql-demo` is adopted rather than built.

### 3.5 gRPC example — how a real service descriptor is obtained

- **Decision:** the example commits a base64 `FileDescriptorSet` and revives it through the plugin's
  `ConnectRuntime` port, adapting `packages/grpc-plugin/test/fixtures/echo-descriptors.ts`. The
  `.proto` it was generated from is committed beside it for readability; **no protoc step and no
  generated TypeScript** enter the build.
- **Why:** this is the repo's established mechanism (M49 shipped its reflection and health services
  the same way) and the only one that needs no codegen toolchain. Protobuf-ES represents a oneof as
  `{ case, value }`, not flat sibling fields — the flat form type-checks and serializes to an EMPTY
  body, which is the single most likely way this example silently half-works.
- **Test home:** the example's `smoke` task, which drives a real Connect client.

### 3.6 Cloudflare example — a committed workerd harness

- **Decision:** `apps/cloudflare` carries its own `wrangler.toml` (matching the CLI's
  `compatibility_date`/`nodejs_compat` from §1) and a `smoke` task driving `wrangler dev`. Its CI
  step is **allowed to be skipped** when `wrangler` is unavailable, but the skip is reported, never
  silent.
- **Why:** the whole Cloudflare surface is marked "not verified against a live Worker" across four
  milestones, and the only thing that ever exercised it was a manual `wrangler dev` that was never
  committed — it was still running, orphaned, 41 hours later. That harness caught a kernel defect
  (module-scope `AbortController`, PR #112) that broke every Workers application while all gates
  stayed green. Committing it converts a one-off into an asset.
- **Test home:** the example's own `smoke` task.

### 3.7 Realtime example — two replicas, never the memory transport

- **Decision:** `apps/realtime` starts **two** app processes on different ports sharing a `'redis'`
  backplane, and its smoke check asserts a message published to A reaches a subscriber on B. It is
  skipped-with-a-report when no Redis is reachable.
- **Why:** cross-replica fan-out is the one M47 capability no in-package test can reach, and the
  default `'memory'` transport is a single-process bus — an example using it would demonstrate
  nothing while appearing to pass. This is the same overstatement the alpha.3 notes had to be
  corrected for.
- **Test home:** the example's `smoke` task.

## 4. Exported surface — every symbol names its consumer

**None (checked).** No `apps/*` module is published, none is a workspace member, and nothing under
`packages/` imports one. The only new symbol outside `apps/` is the `check:apps` task in the root
`deno.json`, whose consumer is the CI workflow step added in the same PR.

### 4.1 Options — every option names its consumer

**None (checked).** This milestone adds no plugin, no factory, and no option bag. Each example
configures existing plugins through their committed option types.

## 5. Implementation files

| File                              | Purpose                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/<name>/deno.json`           | Per-app tasks (`start`, `smoke`) and the `../../packages/*/src` import map.        |
| `apps/<name>/main.ts`             | Runnable entry point.                                                              |
| `apps/<name>/src/*.ts`            | The composition the example demonstrates.                                          |
| `apps/<name>/smoke.ts`            | The proof from §3.4; exits non-zero when it fails.                                 |
| `apps/<name>/README.md`           | What it shows, how to run it, what it deliberately omits.                          |
| `apps/README.md`                  | Index of every example with its one-line proof.                                    |
| `apps/grpc/service.proto`         | Readable source of the committed descriptor (§3.5).                                |
| `apps/cloudflare/wrangler.toml`   | Bindings and compat flags (§3.6).                                                  |
| `scripts/check-apps.ts`           | Walks `apps/*`, type-checks entry points, runs each `smoke`; reports skips loudly. |
| `deno.json` (edit)                | Adds the `check:apps` task.                                                        |
| `.github/workflows/ci.yml` (edit) | Adds the `check:apps` step.                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

**The 90% per-file bar does not apply to `apps/*`** — coverage measures `packages`, and these are
demo applications rather than library code (§3.3). It DOES apply to the one new file under a
measured path, `scripts/check-apps.ts`, which is a script rather than a package `src/` file and is
covered by its own test.

| Test file                            | src covered             | Key assertions (and the signature each call type-checks against)                                                                                                                                                                        |
| ------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/…` — unchanged    | —                       | No package source changes in this milestone.                                                                                                                                                                                            |
| `test/apps-gate.test.ts` (root, new) | `scripts/check-apps.ts` | Every `apps/*` declares `start` and `smoke` tasks (§3.3); no `apps/` path appears in the root `workspace` array (§3.2); the walker reports a skip rather than passing silently when a `smoke` task exits with the documented skip code. |
| each `apps/<name>/smoke.ts`          | that example            | The §3.4 proof for that row. These are the milestone's real tests; they run under `check:apps`, not under `deno task test`.                                                                                                             |

Each smoke check must be verified to **discriminate**: break the thing it proves, confirm it fails,
restore it. A smoke check that passes against a broken example is worse than none.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m37-examples, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:apps        # NEW — type-checks and smoke-runs every example
deno task publish:check     # no package changes expected, but the tree must still publish
deno task release:verify 0.1.0-alpha.4
```

## 8. Risks & mitigations

- An example silently rots because nothing runs it → `check:apps` in CI (§3.3), and every example
  must declare a `smoke` task to be in the tree at all.
- A skipped smoke check (no Redis, no wrangler) reads as a pass → the walker reports skips
  explicitly and the CI log names every skipped example; a silent skip is the failure mode this
  milestone exists to remove.
- The gRPC example half-works because a Protobuf-ES oneof was written flat → §3.5 names the exact
  trap; the smoke check drives a real client, which an empty body fails.
- An example's npm dependency reaches a published package's graph → §3.2 keeps `apps/` out of the
  workspace; the gate test asserts it.
- Eleven applications is a large surface for one PR → they are independent by construction (each is
  one directory plus one row in the index), so they can land in any order and a blocked example does
  not hold the others.

## 9. Out of scope

- **Dockerfiles, `docker-compose`, Kubernetes manifests** for the examples — M39. The Cloudflare
  example's `wrangler.toml` is its own configuration, not a deploy manifest.
- **Per-plugin prose docs and the runtime/deploy matrix** — M38.
- **Running the graphql-demo npm-client interop suite in CI** — it installs `graphql-ws` and Apollo,
  which CI does not do; only the type-check and smoke run are gated (C4).
- **A `serviceDiscovery` arm on the starters** — deferred by M50b, unowned.
