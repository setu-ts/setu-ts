# Milestone 95a — CLI (`@setu-ts/cli`) + `docs/deployment.md`

> **Status:** Planning. Branch: `feat/m95a-generated-deployment-start`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A `setu`-scaffolded microservice, built with its own generated `docker/Dockerfile` and deployed with
its own generated Kubernetes manifest, crash-loops before it serves a request:

```
error: Failed writing lockfile
Caused by:
    Read-only file system (os error 30) (for '/srv/deno.lock')
```

The message names no dependency, no plugin and no driver. This is the only **High** row in the
`v0.6.0` regression run and the only one that stops an application running at all. The milestone
makes a generated Deno workspace member start under the security posture its own generated manifest
sets (`readOnlyRootFilesystem: true`), with no network, and makes the failure impossible to
reintroduce silently.

- **In scope:** the generated Deno-arm `docker/Dockerfile`
  (`packages/cli/src/workspace/compose.ts`); a recurrence gate that builds a scaffolded workspace's
  image and runs it under `--read-only --network none`; the `docs/deployment.md` correction that
  gives an operator the `--frozen` diagnostic, because the runtime error points at the wrong thing.
- **NOT this milestone:** the npm/Bun arm of the generated Dockerfile (`npmDockerfile`), which
  resolves through `node_modules` and writes no `deno.lock` — §1 R7 records that it cannot reach
  this failure. Whether a lazy import should need a lockfile write at all when the package is
  already in `DENO_DIR` is an upstream Deno question, recorded in §9 as an open question for the
  maintainer rather than a deliverable. The `v0.6.0` reachability row is M95b; the three
  contract-fidelity rows are M95c.

## 1. Contracts verified from SOURCE (not names)

Every row below was opened, and every row marked **measured** was reproduced on this machine on Deno
2.9.6 rather than inferred. R2–R6 are the reason §3.1 differs from the ROADMAP's stated mechanism.

| Reference                                     | Source (file:line)                                            | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1 generated Deno Dockerfile                  | `packages/cli/src/workspace/compose.ts:100-161`               | `dockerfile(profile)` takes the runtime profile and NOTHING else — not the transport, not the member set. Its build step is a bare `RUN deno cache main.ts && chown …`; its `CMD` is `["run","--allow-net","--allow-env","--allow-read","--allow-sys","main.ts"]`, with no `--no-lock`.                                                                                                          |
| R2 `deno cache` follows dynamic imports       | **measured** (probe, Deno 2.9.6)                              | `deno cache main.ts` over a module whose only reference to a package is `await import('npm:leftpad@0.0.1')` DOES resolve it and DOES record it in `deno.lock`. A literal dynamic import is part of the static graph.                                                                                                                                                                             |
| R3 framework drivers are declared deps        | **measured** (probe against published `0.6.0`)                | Caching `jsr:@setu-ts/messaging-plugin@^0.6.0` records `npm:amqplib@0.10`, `npm:ioredis@5`, `npm:kafkajs@2`, `npm:nats@2`, `npm:@azure/service-bus@7`, `npm:@google-cloud/pubsub@6`. Deleting the amqplib rows makes Deno refuse the file with `Invalid jsr dependency 'npm:amqplib' for '@setu-ts/messaging-plugin@0.6.0'` — so they are DECLARED JSR dependencies, not merely dynamic imports. |
| R4 OTel / AWS sub-dependencies captured       | **measured** (probe over `telemetry-plugin` + `queue-plugin`) | `import-in-the-middle`, `@aws-sdk/credential-provider-web-identity`, `@opentelemetry/instrumentation`, `@aws-sdk/client-sqs` and `ioredis` all land in `deno.lock` from `deno cache main.ts` alone. All three families the ROADMAP names are captured by the step the generated Dockerfile already runs.                                                                                         |
| R5 the write happens only for a MISSING entry | **measured** (workspace probe, read-only tree)                | A read-only workspace whose lockfile already carries the specifier runs the lazy import fine. Removing the entry, or reaching a specifier never cached, reproduces the exact shape: `error: Failed writing lockfile` / `Caused by: Permission denied (os error 13) (for '…/deno.lock')` — the same failure as the ROADMAP's `os error 30`, differing only in why the path is unwritable.         |
| R6 the remedy, both halves                    | **measured**                                                  | `--no-lock` + warm cache + read-only tree → runs. `--no-lock` + warm cache + read-only + `--cached-only` (no network) → runs. `--no-lock` + **cold** `DENO_DIR` + no network → fails with `npm package not found in cache: "leftpad", --cached-only is specified`. Confirms the ROADMAP's table: `--no-lock` alone is worse than the defect.                                                     |
| R7 the npm/Bun arm cannot reach this          | `packages/cli/src/workspace/compose.ts:220-265`               | `npmDockerfile` builds on the Node/Bun image, runs `profile.install`, and resolves through `node_modules`. It writes no `deno.lock`, so `readOnlyRootFilesystem` cannot produce this failure there.                                                                                                                                                                                              |
| R8 the manifest sets the read-only posture    | `packages/cli/src/workspace/k8s.ts:197`, `:208-216`           | The generated Deployment sets `readOnlyRootFilesystem: true` and mounts exactly one `emptyDir`, at `/tmp`. The file's own header (`:16-18`) records WHY nothing is mounted at the module-cache directory: an `emptyDir` there masks the build-time cache.                                                                                                                                        |
| R9 the Dockerfile is CLI-managed              | `packages/cli/src/workspace/compose.ts:411`                   | Emitted with `managed: true`, so regenerating it is exempt from the overwrite refusal (`findExisting`) and an existing workspace picks the fix up on its next `generate app`.                                                                                                                                                                                                                    |
| R10 one Dockerfile serves every member        | `packages/cli/src/workspace/compose.ts:107`                   | `docker build --build-arg MEMBER=orders` — ONE parameterized file for the whole workspace. Any list baked into it is therefore workspace-wide, never per-member. This is what §3.3 turns on.                                                                                                                                                                                                     |
| R11 the deploy gate's skip protocol           | `scripts/check-deploy.ts:23`, `deno.json:63`                  | `SKIP_EXIT_CODE = 77`, and `check:deploy` already runs `docker build` against `docker/Dockerfile` for four apps. A mode whose tooling is absent exits 77 rather than passing.                                                                                                                                                                                                                    |
| R12 the scaffold gate's shape                 | `packages/cli/test/e2e/workspace-e2e.test.ts`                 | The workspace e2e already scaffolds a real workspace and runs `deno fmt`/`lint`/`check` over it. It does not build an image, and no gate anywhere builds a GENERATED Dockerfile — only this repository's own.                                                                                                                                                                                    |

**What R2–R6 change.** The ROADMAP records the mechanism as "the framework loads driver packages
lazily … so they are **not in the static graph** the generated Dockerfile's `RUN deno cache main.ts`
walks". Measured, that is not so: literal dynamic imports ARE walked (R2), the drivers are declared
JSR dependencies anyway (R3), and every package from all three named families is captured by the
step the Dockerfile already runs (R4). What IS confirmed is the failure's trigger (R5) and the
remedy (R6). So the defect is real and the remedy is right, while the stated cause does not
reproduce — which means the milestone cannot begin by writing the fix. §3.1 makes reproduction the
first deliverable, for the reason CLAUDE.md records under M63-D3: a flagged-but-unverified claim
propagated into nine sites because each new use cited the entry rather than the measurement.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                       | Resolution (picked side)                                                                                                                                                                                                            | Doc deliverable (same PR)                                                                                                                                                                                                                    |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `docs/deployment.md:366-368` states that the generated artifacts "carry the findings on this page rather than repeating the mistakes", listing the build context, the pinned tag, the numeric user, explicit permissions and the real grace period. A generated member that cannot start under the generated manifest falsifies that sentence. | The sentence stays and gains the finding this milestone adds, so the claim describes the artifacts as they will then be.                                                                                                            | `docs/deployment.md` — extend the "Deploying a project the CLI scaffolded" section with the lockfile-write finding, the `--frozen` diagnostic, and the rule that the image's module cache is the member's only dependency source at runtime. |
| C2 | The generated Dockerfile's own comment (`compose.ts:139-140`) promises the container "starts without reaching the network for its own dependencies", while `readOnlyRootFilesystem` makes an incomplete cache a hard crash rather than a slow start — so the promise was untested.                                                             | The comment is correct as INTENT and becomes true once §3.2 lands and §3.4 proves it. It is rewritten to name the guarantee (no network, no lockfile write) rather than only the cache.                                             | `packages/cli/src/workspace/compose.ts` — the comment above the build step and the `CMD`, rewritten to state both halves and cite the gate that proves them.                                                                                 |
| C3 | ROADMAP M95a states the mechanism as a static-graph gap; §1 R2–R4 measure otherwise.                                                                                                                                                                                                                                                           | The plan records the measurements and makes reproduction deliverable D1. The ROADMAP section is corrected in the same PR rather than left to propagate — a wrong cause cited by a later milestone is how M63-D3 reached nine sites. | `ROADMAP.md` M95a — replace the static-graph paragraph with the measured trigger (R5) and remedy (R6), and record that the specific missing specifier is identified by D1.                                                                   |

## 3. Design decisions

### 3.1 Reproduction is the first deliverable, before any fix

- **Decision:** D1 reproduces the crash from a freshly scaffolded workspace — `setu new --workspace`
  plus a `microservice` member, re-pinned so the lockfile is regenerated from static resolution
  alone, image built with the generated Dockerfile, run with `--read-only --network none` — and
  records the exact specifier Deno tries to add. The fix is written against that specifier. No `src`
  change lands before D1 has produced a failing run.
- **Why:** §1 R2–R4 show the recorded cause does not reproduce, while R5 shows the failure needs a
  specifier genuinely absent from the lockfile. Writing the warm list first would produce a list
  aimed at packages that are already cached, which passes every gate and fixes nothing — and a gate
  asserting that list would then certify it.
- **Test home:** D1 is a recorded reproduction in the PR body plus the gate in §3.4, which is
  written to fail on the reproduction and pass after the fix.

### 3.2 `--no-lock` in the generated `CMD` is the fix; the warm cache is the existing `deno cache` step

- **Decision:** the generated Deno `CMD` gains `--no-lock`. The warm half is the
  `RUN deno cache
  main.ts` the Dockerfile already runs (R2–R4), extended by D1's finding only if
  D1 names a specifier that step demonstrably misses.
- **Why:** R5 measures that the runtime write happens only for an entry the lockfile lacks, and R6
  measures that `--no-lock` removes the write while the warm cache keeps the start offline. A
  lockfile is a reproducibility artifact for RESOLUTION; an image has already resolved, and its
  cache is immutable, so the lockfile has no job left to do inside the container. Adding specifiers
  to the image without `--no-lock` was measured not to fix it (the ROADMAP's own remedy table, row
  1), so `--no-lock` is the load-bearing half.
- **Test home:** `packages/cli/test/unit/workspace/compose.test.ts` asserts the flag is present in
  the Deno arm and absent from the npm arm; the §3.4 gate proves it end to end.

### 3.3 Any warm list is workspace-wide and derived, never per-member and never hand-written

- **Decision:** if D1 shows a specifier the existing cache step misses, the extra warm specifiers
  are contributed by the same `TransportSpec` arm that rewrites the member's `MessagingPlugin` and
  `QueuePlugin` arguments, unioned across the workspace and rendered into the one parameterized
  Dockerfile. No hand-maintained constant list.
- **Why:** R10 — one Dockerfile serves every member, so a per-member list is not expressible. And
  `TransportSpec` already carries this exact rationale for `compose`: "the arm that rewrites
  `MessagingPlugin`'s arguments is the same arm that says what has to be running for those arguments
  to mean anything" (`transport.ts:186-193`). A warm specifier is the same kind of fact, so it gets
  the same owner; a renderer-side switch would let a transport be added whose driver nothing warms.
- **Test home:** `packages/cli/test/unit/workspace/transport.test.ts` — every arm carrying a
  messaging or queue rewrite also names its warm specifiers, asserted by iterating `TRANSPORT_SPECS`
  rather than by naming arms, so a tenth transport cannot be added without one.

### 3.4 The gate builds and runs the image; it never asserts a list

- **Decision:** a new `check:deploy` mode scaffolds a workspace into a temporary directory, builds
  its generated Dockerfile, and runs the image with `--read-only --network none`, asserting the
  member reaches a serving state. Absent Docker it exits `SKIP_EXIT_CODE` (77).
- **Why:** the ROADMAP's own warning, and it is the decisive point of the milestone: "A fixed warm
  list in the Dockerfile is exactly what this finding shows cannot be complete, so a gate that
  asserts a hard-coded list would pass while the defect persists." Running under `--read-only`
  reproduces the lockfile write, and `--network none` reproduces the air-gapped cluster, so the two
  halves of R6 are each discriminating: dropping `--no-lock` fails the first, emptying `DENO_DIR`
  fails the second.
- **Test home:** `scripts/check-deploy.ts` (the new mode) plus `test/deploy-gate.test.ts`, which
  pins that the mode exists and is reachable, so it cannot be quietly dropped (the M37c `ALLOW_SKIP`
  precedent).

### 3.5 `--cached-only` is considered and rejected for the generated `CMD`

- **Decision:** the generated `CMD` does not gain `--cached-only`. The gate gets the equivalent
  guarantee from `--network none`.
- **Why:** R6 measures that `--cached-only` turns a missing specifier into a named error instead of
  a silent npm fetch, which is attractive. But in a cluster WITH egress it converts a working (if
  slow) start into a crash, so shipping it in generated output trades this milestone's defect for a
  narrower one. The gate needs no such flag: `--network none` already makes an unwarmed specifier
  fail, and it fails the way a real air-gapped cluster does.
- **Test home:** the compose unit test asserts the flag's ABSENCE, so a later "harden the CMD" edit
  has to read this decision.

### 3.6 Existing workspaces pick the fix up without a migration step

- **Decision:** no migration command, no version check. The Dockerfile is regenerated on the next
  `generate app`, and the PR's CHANGELOG entry tells an operator holding an already-scaffolded
  workspace to re-run it (or to add the one flag by hand).
- **Why:** R9 — the file is `managed: true`, so regeneration is already exempt from the overwrite
  refusal. Inventing a migration verb for a one-flag change would be surface with one use.
- **Test home:** `packages/cli/test/e2e/workspace-e2e.test.ts` — a second `generate app` over an
  existing workspace rewrites the Dockerfile and the rewritten file carries the flag.

## 4. Exported surface — every symbol names its consumer

**No change to `packages/cli/src/index.ts`.** Every symbol below is package-internal; the barrel is
unchanged, pinned by the existing `packages/cli/test/unit/barrel-exports.test.ts` assertion (the M56
defect class — a re-export file is fully covered merely by being loaded, so only an explicit
assertion sees a change).

| Exported symbol                 | Kind             | Consumer / real code path that READS it                                                                                                                                                                                                                                                    |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TransportSpec.warmSpecifiers?` | interface field  | `dockerfile()` in `compose.ts`, which renders the union across the workspace's transports into the generated build step. Added only if D1 shows the existing cache step misses a specifier (§3.3); absent that finding it is NOT added, because a field no renderer reads is dead surface. |
| `SKIP_EXIT_CODE`                | const (existing) | Already exported from `scripts/check-deploy.ts`; the new mode reuses it rather than declaring a second skip code.                                                                                                                                                                          |

### 4.1 Options — every option names its consumer

No new CLI flag and no new plugin option. The change is to generated output, which is selected by
flags that already exist (`--workspace`, `--transport`, `--runtime`).

| Option                          | Consumer                               | Behavior (per implementation)                                                                                                                                                    |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--runtime deno` (existing)     | `WorkspaceRuntimeProfile.manifestKind` | Selects the Deno arm of `dockerfile()`, the only arm this milestone changes. `node`/`bun` take `npmDockerfile`, which R7 establishes cannot reach this failure and is untouched. |
| `--transport <name>` (existing) | `TransportSpec`                        | Selects which arm contributes warm specifiers under §3.3. `http`, `grpc` and `memory` contribute none, because they have no broker driver to warm.                               |

## 5. Implementation files

| File                                      | Purpose                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/index.ts`               | Unchanged — no barrel export moves (§4).                                                                                                    |
| `packages/cli/src/workspace/compose.ts`   | `dockerfile()` gains `--no-lock` in the Deno `CMD` (§3.2), the C2 comment rewrite, and — conditional on D1 — the rendered warm step (§3.3). |
| `packages/cli/src/workspace/transport.ts` | `TransportSpec.warmSpecifiers?` and its per-arm values, conditional on D1 (§3.3).                                                           |
| `scripts/check-deploy.ts`                 | The new scaffold-build-run mode (§3.4), reusing `SKIP_EXIT_CODE`.                                                                           |
| `docs/deployment.md`                      | C1 — the lockfile-write finding, the `--frozen` diagnostic, and the runtime dependency-source rule.                                         |
| `ROADMAP.md`                              | C3 — the measured mechanism replaces the static-graph paragraph; the M95a status row flips in this same PR.                                 |
| `CHANGELOG.md`                            | The generated-output change plus the re-run instruction for an existing workspace (§3.6).                                                   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                | src covered                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/unit/workspace/compose.test.ts`       | `workspace/compose.ts`               | `workspaceContainerFiles(manifest, transport, profile)` renders a Deno `CMD` containing `--no-lock` and NOT containing `--cached-only` (§3.5); the npm arm's `CMD` contains neither; the rendered file is byte-identical to the pre-change output in every other respect, so the diff is exactly the flag. |
| `packages/cli/test/unit/workspace/transport.test.ts`     | `workspace/transport.ts`             | Iterating `TRANSPORT_SPECS`, every arm declaring `messagingArgs` or `queueArgs` also declares `warmSpecifiers` (§3.3) — iterated, never a named list, so a tenth transport cannot be added without one. Skipped entirely if D1 shows no warm list is needed.                                               |
| `packages/cli/test/e2e/workspace-e2e.test.ts` (extended) | the generated Dockerfile, end to end | A scaffolded workspace's `docker/Dockerfile` carries the flag; a second `generate app` rewrites it and it still does (§3.6). Runs with no Docker — it reads the emitted text.                                                                                                                              |
| `test/deploy-gate.test.ts` (extended)                    | `scripts/check-deploy.ts`            | The new mode is registered and reachable, and is NOT in any skip allowlist, so removing it fails a test rather than silently narrowing the gate (the M37c precedent).                                                                                                                                      |
| `scripts/check-deploy.ts` (the gate itself)              | the generated image, end to end      | Builds a scaffolded workspace's image and runs it `--read-only --network none`; asserts the member serves. Exits 77 when Docker is absent (R11). This is the only check that discriminates, per §3.4.                                                                                                      |

**Coverage.** `compose.ts` and `transport.ts` are pure renderers already at the per-file bar; every
new branch is a rendered string reachable from `workspaceContainerFiles`, so the unit tables above
cover them. `scripts/check-deploy.ts` is deliberately NOT in `script-coverage.ts`'s `SCRIPT_TARGETS`
— M39 recorded that decision and its reason (the file is mostly `docker`/`kind` orchestration a test
may not spawn); its decidable logic is exported and unit-tested instead, and the new mode follows
that split.

**Negative controls** (each observed failing, then reverted, and the result recorded in the PR):

1. Drop `--no-lock` from the rendered `CMD` → the §3.4 gate fails with `Failed writing lockfile`.
2. Run the gate's container with an emptied `DENO_DIR` → it fails with the R6 cold-cache error,
   proving `--network none` discriminates rather than passing vacuously.
3. Remove the new mode from `check-deploy.ts` → `test/deploy-gate.test.ts` fails by name.
4. If §3.3 lands: empty one arm's `warmSpecifiers` → the iterated transport test fails naming it.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m95a-generated-deployment-start, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task check:deploy      # includes the new mode; 77 when Docker is absent
deno task check:docs        # docs/deployment.md edits
deno task publish:check     # committed tree
deno task release:verify 0.6.0
```

## 8. Risks & mitigations

- **D1 may not reproduce on this machine.** The ROADMAP run used a re-pinned project against live
  registries, and §1 R2–R4 already failed to reproduce the stated cause. Mitigation: the gate in
  §3.4 is written to be discriminating by construction — it reproduces the failure with an
  artificially unrecorded specifier (R5's technique) if a natural one cannot be found, so the fix is
  still proven rather than assumed. If no natural reproduction exists, that is itself a finding and
  goes in the PR body rather than being papered over.
- **The warm list cannot be complete.** Stated by the ROADMAP and accepted. Mitigation: `--no-lock`
  is the load-bearing half (§3.2) and is complete on its own for the lockfile write; the warm list
  only affects whether a start needs the network, and the gate measures exactly that.
- **`--no-lock` weakens reproducibility inside the image.** Mitigation: the image has already
  resolved at build time against a committed lockfile, and its `DENO_DIR` is immutable, so nothing
  inside the container can resolve differently. The doc deliverable (C1) says this explicitly so an
  operator does not read the flag as a loosening.
- **The gate is slow and needs Docker.** Mitigation: it lives in `check:deploy`, which is already
  opt-in and already exits 77 without Docker (R11), rather than in the default `deno task test`.

## 9. Out of scope

- **Whether a lazy import should need a lockfile write at all when the package is already in
  `DENO_DIR`.** The ROADMAP records this as an open question for the maintainer, not a deliverable;
  it is an upstream Deno behaviour and no change here can settle it. Recorded so a reader does not
  read its absence as an oversight.
- **The npm/Bun arm of the generated Dockerfile.** R7 establishes it cannot reach this failure.
- **This repository's own `docker/Dockerfile`.** It builds `apps/*` from source, is already
  exercised by `check:deploy`, and is not what a scaffolded project deploys. M39 owns it.
- **HTTP probes and an Ingress in generated Kubernetes output.** `docs/deployment.md:387-394`
  records both as deliberate omissions; neither is a start-up defect.
- **M95b** (Service Bus reachability failing open) and **M95c** (three contract-fidelity rows) —
  separate letters, separate branches.
