# Milestone 99b — what the CLI writes cannot then be used

> **Status:** Planning. Branch: `feat/m99b-cli-write-path`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The CLI's two headline outputs each leave the developer with something they cannot proceed from. A
generated container reaches the npm registry at startup and dies under its own generated security
posture; an interrupted scaffold leaves debris that the next run refuses, blaming the developer for
files the CLI wrote seconds earlier.

Rows: **V7-5** (the generated deployment) and **V7-8** (the interrupted scaffold). V7-8 was reported
by `kantorcodes1` on r/SideProject from a source reading, and the same-shape sweep it prompted is
what found the six-command blast radius below.

- **In scope:** the generated Dockerfile's runtime flag; transactional behaviour for the one writer
  behind six commands; the third, non-`writeFiles` write phase in `adopt`.
- **NOT this milestone:** the `check:deploy --generated` gate's missing `deno install` step is IN
  scope (it is what let V7-5 ship); `--dry-run` exactness is already correct and unchanged; the
  Kubernetes manifest content (M39/M70l, verified this run).

## 1. Contracts verified from SOURCE (not names)

| Reference                  | Source (file:line)                                                                                                                                                                                                                                             | Verified surface / fact                                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `writeFiles`               | `packages/cli/src/utils/file-writer.ts:193-208`                                                                                                                                                                                                                | bare `for` loop of `mkdir`/`writeFile`; already tracks a `created: Set<string>` for directories; no rollback                                                                                                             |
| `IFileSystem.rm`           | `packages/common/src/runtime.ts:118`                                                                                                                                                                                                                           | `rm(path, options?: { recursive?: boolean }): Promise<void>` — a REQUIRED member, so rollback needs no widening                                                                                                          |
| The CLI's filesystem type  | `packages/cli/src/cli.ts:45`                                                                                                                                                                                                                                   | `readonly fs: IFileSystem` — the same interface, so `rm` is already reachable from every command                                                                                                                         |
| `GeneratedFile.managed`    | `packages/cli/src/utils/file-writer.ts:16-35,172`                                                                                                                                                                                                              | read ONLY by `findExisting`, which `continue`s past it — so a managed path that already exists is NOT reported and IS overwritten. **31 sites across 19 files set it**, not the "exactly one" its own JSDoc still claims |
| `writeFiles` call sites    | `packages/cli/src/commands/new.ts:618`, `packages/cli/src/commands/generate.ts:429`, `packages/cli/src/commands/app.ts:538`, `packages/cli/src/commands/library.ts:179`, `packages/cli/src/commands/workspace.ts:98`, `packages/cli/src/commands/adopt.ts:249` | six commands share the one writer                                                                                                                                                                                        |
| `adopt` phase 1 (move)     | `packages/cli/src/commands/adopt.ts:227-238`                                                                                                                                                                                                                   | loops `moveFile`; on failure prints "Stopped part-way … nothing is lost — finish or undo the move by hand"                                                                                                               |
| `moveFile`                 | `packages/cli/src/workspace/adopt.ts:170-196`                                                                                                                                                                                                                  | copy → verify byte length → `rm` original, with the ordering reasoned in a comment                                                                                                                                       |
| `adopt` phase 3 (entry)    | `packages/cli/src/commands/adopt.ts:259-269`                                                                                                                                                                                                                   | `try { read; rewrite; writeFile } catch { }` — a BARE catch whose comment covers the missing-entry case only                                                                                                             |
| `setu add` edit loop       | `packages/cli/src/commands/add.ts:366-369`                                                                                                                                                                                                                     | recomputes `edits` from current file contents each run and pushes only a changed file — idempotent by recomputation                                                                                                      |
| `publish-packages.ts`      | `scripts/publish-packages.ts:18,82-85`                                                                                                                                                                                                                         | skips already-published versions so a failed run resumes; its header states the property                                                                                                                                 |
| Generated Dockerfile `CMD` | CLI template output, verified by scaffolding `0.7.0`                                                                                                                                                                                                           | `CMD ["run", "--no-lock", …]`, with `COPY deno.json* deno.lock* ./` and a single `RUN deno cache main.ts` above it                                                                                                       |

**Measured, not inferred (V7-5).** One image, `--read-only --network none`: with `--no-lock` it
fetches `redis-errors` and `buffer-more-ints` and dies; without the flag it resolves everything from
the image cache and reaches only `ECONNREFUSED` on the broker; with `--frozen` it serves `/health`
`200`. The packages it reaches for are transitive dependencies of the lazily imported drivers.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                         | Resolution (picked side)                                                                               | Doc deliverable (same PR)                                                               |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| C1 | `docs/deployment.md` states the image's module cache is the member's only runtime dependency source; with `--no-lock` the container fetches from npm                                             | The doc states the intended guarantee. Change the flag so the doc becomes true                         | `docs/deployment.md` gains the `--frozen` reasoning and drops any `--no-lock` rationale |
| C2 | The generated Dockerfile's own comment says the lockfile "has no job left inside an image"                                                                                                       | False: the lockfile is exactly what makes the build-time cache and the runtime resolution agree        | The emitted comment is rewritten in `packages/cli/src/templates/`                       |
| C4 | V7-8 came from outside the project and the repository has no convention for crediting an external reporter — the nearest precedents are `Reported in code review before merge` and an issue link | Credit the reporter by handle in the entry that ships the fix, as the durable public record            | `CHANGELOG.md`'s V7-8 entry names `kantorcodes1` and links the thread                   |
| C3 | M95a's ROADMAP section records V6-5 as closed                                                                                                                                                    | It is not; the error moved. M95a's mechanism paragraph stays (it was correct about the lockfile write) | The M95a section gains a note pointing at M99b, rather than being rewritten             |

## 3. Design decisions

### 3.1 The generated runtime flag

- **Decision:** the generated `CMD` runs `--frozen` in place of `--no-lock`.
- **Why:** `--frozen` uses the shipped lockfile, so build and runtime resolve identically, and it
  never writes, so M95a's original read-only lockfile write remains impossible. Measured to serve
  `/health` `200` under `ReadonlyRootfs=true` with `--network none`.
- **Test home:** `packages/cli/test/e2e/generated-deployment.test.ts` and the `check:deploy`
  `--generated` mode below.

### 3.2 Making the gate able to see it

- **Decision:** `check:deploy --generated` runs `deno install` in the scaffolded workspace before
  building its image.
- **Why:** the gate scaffolds, builds and runs without ever installing, so it ships the 1,361-byte
  stub lockfile, build and runtime coincidentally agree, and the defect is structurally invisible.
  Measured: the same scaffold's lockfile reaches 65,275 bytes after `deno install`, and the image
  built from that one fails.
- **Test home:** `scripts/check-deploy.ts` itself, exercised by `test/unit/check-deploy.test.ts`.

### 3.3 How `writeFiles` becomes safe to interrupt

- **Decision:** immediately before each write, `writeFiles` reads the path it is about to write and
  keeps the prior bytes when one exists. On any failure it walks its record in reverse: a path that
  pre-existed is RESTORED to its captured bytes, a path it genuinely created is removed, and each
  directory it created is removed non-recursively. Then it rethrows.
- **Why:** unlinking every written path would be wrong, and the plan's first draft said so for a
  reason that does not survive the source. `findExisting` `continue`s past a `managed` file
  (`file-writer.ts:172`), so a managed path that already exists is neither reported nor refused — it
  is silently overwritten. That set is not one barrel: 31 sites across 19 files emit `managed`, and
  `setu generate app` into an existing workspace rewrites the Dockerfile, `.dockerignore`,
  `compose.yaml`, the Kubernetes manifests and their README, the root manifest, and EVERY member's
  discovery module (`workspace/compose.ts:423-426`, `workspace/k8s.ts:323-325`,
  `workspace/root-manifest.ts:119,187`, `commands/app.ts:280,287`). A path-only rollback after a
  failure on the last member would delete the workspace's entire deployment surface — strictly worse
  than the debris this milestone exists to remove, and it would leave `setu.config.ts` importing
  barrels that no longer exist. Reading immediately before the write is also what closes the
  preflight window: `findExisting` runs at the command layer and `writeFiles` writes
  unconditionally, so a path created in between is captured as pre-existing and restored rather than
  deleted. Non-recursive directory removal is the remaining safety property: a directory the CLI
  created is empty at rollback time, and one it did not create is not in the set.
- **Cost, stated rather than hidden:** one extra read per planned path. `findExisting` already
  `stat`s every unmanaged path, and on `setu new` every read misses and fails fast, so the added
  cost lands only where there is something to protect.
- **Test home:** `packages/cli/test/unit/write-files-rollback.test.ts`.

### 3.4 What a rollback failure does

- **Decision:** a failure DURING rollback is reported alongside the original error and does not
  replace it; the command still exits non-zero.
- **Why:** the original write failure is the diagnosis the developer needs. A rollback that cannot
  complete leaves partial debris, which is the pre-milestone behaviour, so the outcome is no worse
  than today and the message says which paths remain.
- **Test home:** `packages/cli/test/unit/write-files-rollback.test.ts` drives a fake whose `rm`
  rejects.

### 3.5 `adopt`'s third phase

- **Decision:** the bare `catch` narrows to the missing-entry case — a failure to READ the entry is
  swallowed as today, a failure to WRITE it is reported and the command exits non-zero.
- **Why:** the two are different outcomes with the same catch today, so a genuine write failure is
  reported as "your entry does not carry the port literal" and the developer is told to act by hand
  without being told anything failed. Splitting read from write is the smallest change that
  distinguishes them.
- **Test home:** `packages/cli/test/unit/adopt-entry-rewrite.test.ts`.

### 3.6 What `adopt`'s first phase does NOT get

- **Decision:** the move loop is left exactly as it is.
- **Why:** it is already correct for its shape — `moveFile` is copy → verify → delete so nothing is
  lost, and the loop's failure message names the exact state and the remedy. It is the model this
  milestone copies, not a defect.
- **Test home:** no new test; the existing move tests stand.

## 4. Exported surface — every symbol names its consumer

No symbol is added to `packages/cli/src/index.ts`. `writeFiles` is already exported within the
package and its signature does not change.

| Exported symbol | Kind     | Consumer / real code path that READS it                                                     |
| --------------- | -------- | ------------------------------------------------------------------------------------------- |
| `writeFiles`    | function | the six command modules listed in §1; signature `(fs, files) => Promise<void>` is unchanged |

A `packages/cli/test/unit/barrel-exports.test.ts` pins that the published surface is unchanged.

### 4.1 Options — every option names its consumer

| Option                     | Consumer                  | Behavior (per implementation)                                                     |
| -------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `check:deploy --generated` | `scripts/check-deploy.ts` | now installs before building, so the image under test carries a resolved lockfile |

No new CLI flag. A `--force` was considered and rejected in M58 for `findExisting`; nothing here
reopens it.

## 5. Implementation files

| File                                       | Purpose                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `packages/cli/src/index.ts`                | unchanged (pinned by test)                                                 |
| `packages/cli/src/utils/file-writer.ts`    | `writeFiles` records written paths and created directories, and rolls back |
| `packages/cli/src/commands/adopt.ts`       | phase 3's catch narrows to the read case; a write failure is reported      |
| `packages/cli/src/templates/` (Dockerfile) | `--frozen` in the emitted `CMD`; the lockfile comment rewritten            |
| `scripts/check-deploy.ts`                  | `--generated` installs before building                                     |
| `docs/deployment.md`                       | C1 — the guarantee and the `--frozen` reasoning                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                             | src covered                       | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/cli/test/unit/write-files-rollback.test.ts` | `utils/file-writer.ts`            | a fake `IFileSystem` whose Nth `writeFile` rejects leaves no NEW file behind, restores every pre-existing file to its ORIGINAL bytes (the `managed` case), and removes only directories it created; a pre-existing directory survives; a path created between preflight and write is restored, not deleted; a rejecting `rm` reports both errors. Calls typed against `writeFiles(fs: IFileSystem, files: readonly GeneratedFile[])` |
| `packages/cli/test/unit/adopt-entry-rewrite.test.ts`  | `commands/adopt.ts`               | a missing entry is still silent and exits `0`; an entry whose WRITE rejects exits non-zero and the message names the write, not the port literal                                                                                                                                                                                                                                                                                     |
| `packages/cli/test/e2e/scaffold-interrupted.test.ts`  | `utils/file-writer.ts` end to end | `setu new` into a target whose nested directory is read-only leaves nothing behind, and an immediate retry SUCCEEDS. `setu generate app` into a two-member workspace, failing on the last write, leaves `compose.yaml`, the k8s manifests and the first member's discovery module byte-identical to their pre-run contents                                                                                                           |
| `packages/cli/test/e2e/generated-deployment.test.ts`  | the Dockerfile template           | a scaffolded workspace, `deno install`ed, built from its own generated Dockerfile, serves `/health` `200` under `--read-only --network none`                                                                                                                                                                                                                                                                                         |
| `test/unit/check-deploy.test.ts`                      | `scripts/check-deploy.ts`         | the `--generated` path invokes `deno install` before `docker build` — asserted on the command sequence, so removing the step fails                                                                                                                                                                                                                                                                                                   |
| `packages/cli/test/unit/barrel-exports.test.ts`       | `src/index.ts`                    | published surface unchanged                                                                                                                                                                                                                                                                                                                                                                                                          |

`scripts/check-deploy.ts` is deliberately NOT in `script-coverage.ts`'s target set (M39's recorded
deviation: it is mostly `docker`/`kind` orchestration a test may not spawn); its decidable logic is
exported and unit-tested, which is what `test/unit/check-deploy.test.ts` covers.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m99b-cli-write-path, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage
deno task check:deploy --generated
deno task publish:check
```

Negative controls, each observed failing and reverted:

1. Restore `--no-lock` — `generated-deployment` fails with the npm fetch under `--network none`.
2. Remove the `deno install` step from `--generated` — the gate goes GREEN with `--no-lock`
   restored, which is the proof that the gate could not see V7-5.
3. Remove the rollback entirely — `scaffold-interrupted` fails on the retry for both `new` and
   `generate`.
4. Keep the rollback but unlink every recorded path instead of restoring pre-existing ones — the
   `generate app` case loses `compose.yaml` and the k8s manifests, which is the defect the restore
   half exists for. Run separately from control 3, because a tree with no rollback at all cannot
   show it.
5. Widen `adopt`'s catch back — `adopt-entry-rewrite` reports a write failure as a port-literal
   miss.

Control 2 is the important one: it must be run WITH control 1 applied, because a gate that cannot
see the defect proves nothing on a healthy tree.

## 8. Risks & mitigations

- `--frozen` fails a build whose lockfile is stale relative to its manifests → that is the intended
  loud failure, and it surfaces at build time in CI rather than at container start in a cluster.
- Rollback could remove a file this invocation did not create → it cannot: a path is unlinked only
  when the read taken immediately before its write found nothing there. `findExisting` is NOT the
  guarantee — it skips `managed` paths entirely — so the read, not the preflight, is what makes the
  distinction, and the window between them is one `await`.
- An existing scaffolded project keeps `--no-lock` until its Dockerfile is regenerated → documented
  in `docs/deployment.md` with the one-line edit, matching how M95a handled the same situation.

## 9. Out of scope

- A `--force` flag on `findExisting` — rejected in M58 and not reopened; rollback removes the need.
- Making `setu add` transactional: it is idempotent by recomputation, which is the other correct
  answer to this shape, and needs no change.
- `workspace ports --reallocate`'s own multi-artifact consistency beyond what the shared writer
  gives it; it writes through one `writeFiles` call, so it inherits the fix.
