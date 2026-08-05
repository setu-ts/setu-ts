# Milestone 53 — Real-Backend CI (`.github/workflows/ci.yml` + `scripts/check-apps.ts` + guarded Redis tests)

> **Status:** Planning. Branch: `feat/53-real-backend-ci`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Make the real-backend proof path run on every pull request. Today `apps/realtime` and
`apps/microservices` both surface exit code **77** (a reported skip) unless `REDIS_URL` is set, and
no CI job sets it — so the two examples whose whole purpose is to prove cross-replica / cross-service
behaviour against a live broker are skipped in CI. The ioredis eager-connect defect (fixed in M37b)
survived three milestones precisely because every in-package test injects a fake client and the
guarded "real import" tests only assert the module imports. This milestone adds a Redis service
container to CI, exports `REDIS_URL` to the relevant steps, makes a skip that a provided container
should have covered a **regression** rather than a pass, and deepens the guarded real-import tests so
they construct a client and drive one real command (and adds the one Redis consumer that lacks that
deepened test). There is **no package in this milestone** and **no plugin-behaviour source change**.

- **In scope:**
  - `.github/workflows/ci.yml` — a Redis `services:` container and `REDIS_URL` exported to the steps
    that need it (deliverables 1, 2).
  - `scripts/check-apps.ts` — track skipped examples by name, make a skip for a provided backend a
    failure, and report a malformed application directory by name instead of an unhandled `NotFound`
    (deliverables 3, 6).
  - `deno.json` (root) — add `--allow-net` to the `test` and `test:coverage` tasks so the deepened
    guarded Redis tests can actually open a TCP connection to the service container in CI.
  - Deepened guarded real-import tests for **all three** Redis consumers (`cache-plugin`,
    `messaging-plugin`, `queue-plugin`) that construct a client over the real `loadIoredis` path and
    drive one real command round trip (deliverable 4); `queue-plugin`'s is the one ROADMAP deliverable
    5 names (resolved in §2).
  - `test/apps-gate.test.ts` — cover the new pure `check-apps.ts` seams.
- **NOT this milestone:**
  - Cloud-provider backends needing credentials (AWS/GCP/Azure) — cannot run from a fork PR; **M54**
    owns those brokers and decides its own verification story.
  - A Cloudflare/workerd backend in CI (`apps/cloudflare` skips on a missing `wrangler` today) —
    outside "Redis first"; M53 provides no Node/npm toolchain. See §3.1 and §9.
  - Docker Compose / Kubernetes manifests for the examples — **M39**.
  - Adding `apps/*` to the coverage gate — **deliberately never** (ROADMAP §5645–5647).
  - Any `packages/*/src` plugin-behaviour change, any `PUBLIC_API.md` change, any new capability
    token, any `@hono-enterprise/common` change — **none**. Reviewers: `packages/*` source is
    untouched; the behavioural change lives entirely in CI YAML, the `check-apps` script, and test
    files.

## 1. Contracts verified from SOURCE (not names)

| Reference | Source (file:line) | Verified surface / fact |
| --------- | ------------------ | ----------------------- |
| `classifySmokeExitCode` | `scripts/check-apps.ts:13` | Maps exit `77` → `'skipped'`; `0` → `'passed'`; else `'failed'`. Reused unchanged; the skip-tracking change collects names around it. |
| `readAppConfig` (malformed-dir bug) | `scripts/check-apps.ts:20` | `JSON.parse(await Deno.readTextFile(path))` — a missing `apps/<dir>/deno.json` throws an unhandled `Deno.errors.NotFound` that aborts the whole script. Deliverable 6 wraps this. |
| `run()` subprocess spawn | `scripts/check-apps.ts:24` | `new Deno.Command(...)` with **no `env` option** → the child inherits the parent process env. So a step-level/job-level `REDIS_URL` propagates to each spawned `deno task smoke` with **no permission change** to the `check:apps` task. |
| CI `deno` job | `.github/workflows/ci.yml:11` | One job; `Example applications` step `ci.yml:31` runs `deno task check:apps`; `Test` `ci.yml:34`, `Test with coverage` `ci.yml:37`. No `services:`, no `REDIS_URL`, only `denoland/setup-deno@v2`. |
| `test` / `test:coverage` tasks | `deno.json:54` / `deno.json:55` | Grant `--allow-read --allow-import --allow-env --allow-sys=hostname` but **NOT `--allow-net`**. A TCP connect to Redis throws `PermissionDenied`; the deepened tests need `--allow-net` added here. |
| realtime skip guard | `apps/realtime/smoke.ts:7` | `Deno.exit(77)` when `REDIS_URL` is undefined. Replicas are spawned with an explicit `env: { REDIS_URL: url }` (`smoke.ts:29`) from the inherited value. |
| microservices skip guard | `apps/microservices/smoke.ts:31` | Sets `Deno.exitCode = 77` (after running the non-Redis HTTP path) when `REDIS_URL` is undefined — both surface as `status.code === 77` to `classifySmokeExitCode`. |
| cloudflare skip guard (out of scope) | `apps/cloudflare/smoke.ts:35` | `Deno.exit(77)` when `wrangler --version` fails. CI installs only Deno, so this example **skips in CI today and after M53** — decisive for §3.1. |
| queue lazy loader | `packages/queue-plugin/src/adapters/redis-queue.ts:24` | `const mod = await import('npm:ioredis@5.x'); return mod.Redis;` — the real specifier this milestone's tests exercise. |
| `RedisQueue` public surface | `packages/queue-plugin/src/adapters/redis-queue.ts:113/136/151` | `connect()` runs `resolveClient` → real `loadIoredis` + `createLazyRedisClient`; `enqueue(job)` drives `hset`+`zadd`; `reserve(...)` drives `zrangebyscore`+`zrem`+`zadd`+`hget`; `disconnect()` drives `quit`. The deepened round trip is enqueue→reserve. |
| `IRedisQueueClient` command surface | `packages/queue-plugin/src/interfaces/index.ts:15` | `zadd/zrangebyscore/zrem/hset/hget/hdel/del/quit` (+ optional `connect`). |
| cache store surface | `packages/cache-plugin/src/stores/redis-store.ts:86` | `RedisStore(prefix, { url })`; `connect()` runs real `loadIoredis`; `set/get` drive `set/get`; `disconnect()` drives `quit`. `validateClient` (`redis-store.ts:42`) requires `get/set/del/exists/scan/quit`. |
| messaging broker surface | `packages/messaging-plugin/src/brokers/redis-streams-broker.ts:97` | `RedisStreamsBroker(runtime, serializer, { url })`; `connect()` `:155`; `publish(topic, msg)` `:207` drives `xadd`; `subscribe(...)` `:219` drives `xgroup`/`xreadgroup`/`xack`; `disconnect()` `:172` drives `quit`. `validateClient` (`:46`) requires `xadd/xgroup/xreadgroup/xack/quit/connect`. |
| existing cache guarded test | `packages/cache-plugin/test/unit/redis-store.test.ts:176` | Only `import('npm:ioredis@5.x')` and asserts `Redis` is a function — does NOT construct a client or drive a command. This is the shallow form deliverable 4 deepens. |
| existing messaging guarded test | `packages/messaging-plugin/test/unit/redis-streams-broker.test.ts:598` | Constructs a broker with no injected client, calls `connect()` against `redis://localhost:9999` and asserts it **rejects** — enters `loadIoredis` but never drives a command to completion. Kept (covers the reject branch); the new test covers the success branch. |
| existing queue guarded test | `packages/queue-plugin/test/unit/redis-queue.test.ts:497` | Constructs `RedisQueue({ url: 'redis://localhost:9999' })`, asserts `connect()` **rejects** — identical in form to messaging's. (See §2: ROADMAP §5659 calls queue "the only one without" a guarded test; source shows otherwise.) |
| check-apps seam test home | `test/apps-gate.test.ts:3` | Already imports `classifySmokeExitCode` from `scripts/check-apps.ts` — the home for the new pure-seam tests. |
| ioredis specifier | `packages/{cache,messaging,queue}-plugin/src/...` + `scheduler-plugin` + `realtime-backplane-plugin` | The pinned real specifier is `npm:ioredis@5.x` everywhere (not invented). |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict | Resolution (picked side) | Doc deliverable (same PR) |
| -- | -------- | ------------------------ | ------------------------- |
| C1 | ROADMAP §5659 says "`packages/queue-plugin` gains a guarded real-import test — the only one of the three Redis consumers without one". Source contradicts: `packages/queue-plugin/test/unit/redis-queue.test.ts:497` ALREADY has a `describe('guarded real-import')` that enters `loadIoredis`, byte-for-byte the same form as messaging's (`redis-streams-broker.test.ts:598`). The three differ only in depth: cache imports-only; messaging & queue construct-and-connect-then-reject; **none** constructs a client and drives a real command. | Source wins. Reframe deliverable 5 as: queue gains the **deepened** guarded real-import test (construct + connect + drive one command) — the same deepening deliverable 4 applies to cache and messaging. So deliverable 4 is "deepen all three"; deliverable 5 is "queue is the one the ROADMAP names, and its deepened test is new". No ROADMAP edit needed: the milestone satisfies ROADMAP §5659 (queue gains a guarded real-import test — the deepened one) AND §5657 (deepen the tests). | None — no ROADMAP/PUBLIC_API edit. The imprecision is resolved here in the plan; reviewers see `redis-queue.test.ts:497` already exists. |
| C2 | None other found. ARCHITECTURE.md has no CI / `check:apps` / examples section (the only `services:` matches are inside code-block illustrations, `ARCHITECTURE.md:1697/1866`), so there is no committed architecture description of the gate to conflict with. PUBLIC_API.md is untouched (no `src/index.ts` change). | n/a | None (checked ARCHITECTURE.md, PUBLIC_API.md, ROADMAP.md). |

## 3. Design decisions

### 3.1 Zero-skipped assertion: an allowlist, not a global fail-on-skip

- **Decision:** `scripts/check-apps.ts` gains an env var `ALLOW_SKIP` whose value is a comma-separated
  list of application names permitted to skip. When `ALLOW_SKIP` is **unset** (local development), a
  skip is a warning — current behaviour preserved. When `ALLOW_SKIP` is **set** (CI), any skipped app
  **not** in the list makes `check:apps` exit 1, naming the regression. CI sets
  `ALLOW_SKIP: "cloudflare"` (workerd is out of scope for M53) alongside `REDIS_URL`.
- **Why:** three apps skip today, not two. `apps/cloudflare` skips on a missing `wrangler`
  (`apps/cloudflare/smoke.ts:35`) and CI installs only Deno, so it skips in CI both before and after
  this milestone. A global "any skip fails" gate would therefore break CI on cloudflare. The allowlist
  is the only mechanism that is correct **regardless** of cloudflare's status: it explicitly names the
  one app whose backend M53 does not provide. It is also the more robust default for the future — a
  newly added example that skips (its backend not yet provided) auto-fails CI, forcing the author to
  add the service container or justify the skip in `ALLOW_SKIP`. This is exactly ROADMAP §5655:
  "a skip that a container should have covered is a regression, not a pass".
- **Test home:** `test/apps-gate.test.ts` drives the pure seam `unexpectedSkips(skipped, allowList)`
  (§4) with: `skipped=['cloudflare'], allowList=['cloudflare']` → `[]`; `skipped=['realtime','cloudflare'], allowList=['cloudflare']` → `['realtime']`.

### 3.2 Deepened guarded real-import test: one per Redis consumer, drive a real command

- **Decision:** Add ONE new file per consumer —
  `packages/cache-plugin/test/unit/redis-real-import.test.ts`,
  `packages/messaging-plugin/test/unit/redis-real-import.test.ts`,
  `packages/queue-plugin/test/unit/redis-real-import.test.ts` — each guarded identically: read
  `REDIS_URL`; `await import('npm:ioredis@5.x')`; if any one is unavailable, log `SKIP:` and return
  (the existing apps/§6.7 guard pattern). When available, construct the package's own class **with no
  injected client** (so the production `loadIoredis` → `createLazyRedisClient` → `connect()` path runs
  for real), connect to `REDIS_URL`, drive **one real command round trip** through the public surface,
  assert it, and `disconnect()`:
  - cache: `new RedisStore('m53:', { url })` → `connect()` → `set('k','v')` → `get('k')` resolves
    `'v'` → `disconnect()` (real `set`/`get`).
  - messaging: `new RedisStreamsBroker(runtime, serializer, { url, pollIntervalMs: 50 })` →
    `connect()` → `subscribe(topic, handler)` → `publish(topic, payload)` → `handler` receives the
    payload → `disconnect()` (real `xadd`/`xgroup`/`xreadgroup`/`xack`).
  - queue: `new RedisQueue({ url })` → `connect()` → `enqueue(storedJob)` →
    `reserve(name, 1, nowMs)` returns the job → `ack(name, id)` → `disconnect()` (real
    `hset`/`zadd`/`zrangebyscore`/`zrem`/`hget`/`hdel`).
  Each uses the package's existing fake-runtime/serializer fixtures where the constructor needs them
  (messaging reuses `createFakeRuntime()` + `JsonSerializer`).
- **Why:** This is precisely the proof the ioredis defect needed and the shallow tests could not
  provide: a real client is constructed (the M37b defect was that construction connected eagerly and
  the explicit `connect()` then threw — invisible to any fake and to any import-only or reject-only
  test) and one command is driven against a live server. The class-with-no-injected-client route is the
  real production load path, so `loadIoredis`/`resolveClient`/`createLazyRedisClient` execute for real,
  not via the injection seam (which the existing `redis-client-factory.test.ts` unit tests already
  cover). The existing reject-path tests (`redis-queue.test.ts:497`,
  `redis-streams-broker.test.ts:598`) and cache's import-only block (`redis-store.test.ts:176`) are
  **kept** — they cover the connect-fails / module-present branches; the new files cover the
  connect-succeeds-and-drives-a-command branch. No restructuring of the existing tests is required.
- **Test home:** the three new files above. These run for real in CI (`REDIS_URL` set on the job) and
  skip locally (no `REDIS_URL`). They do not change any `src/` coverage number — the `src` methods they
  call (`enqueue`/`reserve`/`set`/`get`/`publish`/`subscribe`) are already ≥90%-covered by the
  fake-driven unit tests; the new tests add real-backend confidence, the metric ROADMAP §5647 names.

### 3.3 Malformed application directory: catch, name, continue

- **Decision:** In `checkApps()`, wrap the `readAppConfig(`${cwd}/deno.json`)` call. On
  `Deno.errors.NotFound` report `<dir>: missing deno.json — malformed application directory`; on
  `SyntaxError` report `<dir>: deno.json is not valid JSON — malformed application directory`; any
  other error rethrows. In both named cases set `failed = true` and `continue` to the next app rather
  than aborting the script with an unhandled stack. The decision is a pure seam
  `malformedAppDirMessage(directory, error): string | null`.
- **Why:** ROADMAP §5661 wants a malformed directory "reported by name instead of throwing an
  unhandled `NotFound`". Today one bad entry kills the whole gate and hides which app was malformed.
  Catching at the loop boundary and naming the directory turns a crash into a named, recoverable
  failure that still fails the gate (a malformed app is not a pass) while letting the remaining apps
  report. The pure seam keeps the branching unit-testable without spawning subprocesses.
- **Test home:** `test/apps-gate.test.ts` drives `malformedAppDirMessage('foo', NotFound)` → the
  missing-config message; `(..., SyntaxError)` → the invalid-json message; `(..., RangeError)` →
  `null` (caller rethrows).

### 3.4 CI wiring: Redis service + job-level `REDIS_URL` + `--allow-net` on the test tasks

- **Decision:** In `.github/workflows/ci.yml`, add a `services:` block to the `deno` job running
  `image: redis:7` with a `redis-cli ping` healthcheck (the service is reachable at host `redis`), set
  `REDIS_URL: redis://redis:6379` as **job-level** `env` (so `check:apps`, `test`, and `test:coverage`
  all inherit it), and set `ALLOW_SKIP: "cloudflare"` on the `Example applications` step. Separately,
  add `--allow-net` to the `test` and `test:coverage` task strings in `deno.json` so the deepened
  guarded tests (§3.2) can open the TCP connection.
- **Why:** Job-level `REDIS_URL` is the single place that satisfies both the example smokes (via
  inherited env into the spawned `deno task smoke` subprocesses) and the package-level deepened tests
  (run by `deno task test`). `ALLOW_SKIP` is step-scoped to `check:apps` because it is a `check-apps`
  concern. `--allow-net` is required: the test task today grants no network permission
  (`deno.json:54`), so without it a guarded test that sees `REDIS_URL` set in CI would throw
  `PermissionDenied` on connect — and since the guard only checks "url set + ioredis imports", that
  would surface as a hard failure rather than a skip, defeating the gate. `--allow-import` (already
  present) covers fetching `npm:ioredis@5.x`; `--allow-net` covers the resulting TCP socket.
- **Test home:** the behavioural evidence (§7) — locally `REDIS_URL=redis://127.0.0.1:6379 deno task
  check:apps` runs the two Redis smokes to completion; `REDIS_URL` unset leaves them skipped (and
  `ALLOW_SKIP` unset keeps that a warning). The deepened tests run with `REDIS_URL` set and skip
  without it.

## 4. Exported surface — every symbol names its consumer

No package `src/index.ts` is touched, so no JSR-published surface changes. The only new exports are
internal to `scripts/check-apps.ts` (not a published package; `scripts/` is excluded from coverage and
publishing). Every new symbol names its real reader:

| Exported symbol | Kind | Consumer / real code path that READS it |
| --------------- | ---- | --------------------------------------- |
| `classifySmokeExitCode` (existing) | fn | `checkApps()` smoke loop; tested in `test/apps-gate.test.ts:33`. |
| `unexpectedSkips(skipped, allowList)` | fn (NEW) | `checkApps()` end-of-run enforcement (§3.1); tested in `test/apps-gate.test.ts`. |
| `malformedAppDirMessage(directory, error)` | fn (NEW) | `checkApps()` config-read catch (§3.3); tested in `test/apps-gate.test.ts`. |

### 4.1 Options — every option names its consumer

| Option | Consumer | Behavior (per implementation) |
| ------ | -------- | ----------------------------- |
| `ALLOW_SKIP` (env, read by `check-apps.ts`) | `checkApps()` | Unset → every skip is a warning (local-dev default). Set → a skip not listed fails the gate. CI value: `cloudflare`. |
| `REDIS_URL` (env, inherited) | `apps/realtime/smoke.ts`, `apps/microservices/smoke.ts`, the three deepened tests | Unset → those smokes exit 77 and the deepened tests SKIP. Set → they run against the live Redis. CI value: `redis://redis:6379`. |
| `--allow-net` (deno task flag) | `deno task test` / `test:coverage` | Permits the TCP connect the deepened tests need; no effect when `REDIS_URL` unset (tests skip before connecting). |

No new plugin options, no new capability token, no `common` types.

## 5. Implementation files

| File | Purpose |
| ---- | ------- |
| `.github/workflows/ci.yml` | Add `services: redis:` (redis:7 + healthcheck) to the `deno` job; add job-level `env: REDIS_URL: redis://redis:6379`; add step `env: ALLOW_SKIP: cloudflare` to `Example applications`. |
| `scripts/check-apps.ts` | (a) collect skipped app names + print a `Skipped: N [<names>]` summary; (b) `ALLOW_SKIP` enforcement via `unexpectedSkips`; (c) malformed-dir handling via `malformedAppDirMessage`; (d) export the two new pure seams. |
| `deno.json` | Add `--allow-net` to the `test` (`:54`) and `test:coverage` (`:55`) task strings. |
| `packages/cache-plugin/test/unit/redis-real-import.test.ts` | NEW — deepened guarded real-import: `RedisStore` set→get round trip. |
| `packages/messaging-plugin/test/unit/redis-real-import.test.ts` | NEW — deepened guarded real-import: `RedisStreamsBroker` publish→subscribe round trip. |
| `packages/queue-plugin/test/unit/redis-real-import.test.ts` | NEW — deepened guarded real-import: `RedisQueue` enqueue→reserve round trip (ROADMAP deliverable 5). |
| `test/apps-gate.test.ts` | Add tests for `unexpectedSkips` and `malformedAppDirMessage`. |

No `packages/*/src/**` file is created or edited. No `apps/**` source is edited (the smokes already
exit 77 correctly). No `PUBLIC_API.md` edit (no published-surface change).

## 6. Test plan (every changed file mapped; per-file 90% bar)

`scripts/check-apps.ts` lives under `scripts/`, not `packages/`, so it is outside the coverage
measurement; its new branching is covered through the pure seams exercised by `test/apps-gate.test.ts`
(the `classifySmokeExitCode` precedent). The three new package test files test `src` methods that are
already ≥90%-covered by fake-driven unit tests, so no `src` coverage regression is possible; they are
additive real-backend confidence. The verification bar for them is "the round trip ran against a live
Redis", not a percentage (ROADMAP §5647).

| Test file | src / surface covered | Key assertions (signature each call type-checks against) |
| --------- | --------------------- | -------------------------------------------------------- |
| `test/apps-gate.test.ts` (edited) | `unexpectedSkips`, `malformedAppDirMessage` | `unexpectedSkips(['cloudflare'], ['cloudflare'])` → `[]`; `unexpectedSkips(['realtime','cloudflare'], ['cloudflare'])` → `['realtime']`; `malformedAppDirMessage('foo', new Deno.errors.NotFound(...))` → contains `missing deno.json`; `(... SyntaxError ...)` → contains `not valid JSON`; `(... RangeError ...)` → `null`. |
| `packages/cache-plugin/test/unit/redis-real-import.test.ts` (NEW) | `RedisStore.connect/set/get/disconnect` over real `loadIoredis` | Guarded skip when no `REDIS_URL`/ioredis; else `get('k')` resolves `'v'` after `set('k','v')`. |
| `packages/messaging-plugin/test/unit/redis-real-import.test.ts` (NEW) | `RedisStreamsBroker.connect/publish/subscribe/disconnect` over real `loadIoredis` | Guarded skip; else a `subscribe` handler receives the payload published to the same topic within a bounded wait. |
| `packages/queue-plugin/test/unit/redis-real-import.test.ts` (NEW) | `RedisQueue.connect/enqueue/reserve/ack/disconnect` over real `loadIoredis` | Guarded skip; else `reserve(name, 1, nowMs)` returns exactly the job `enqueue` stored, then `ack` clears it. |

Every call above type-checks against the verified signatures in §1 (`RedisStore(prefix, {url})`,
`RedisStreamsBroker(runtime, serializer, {url})`, `RedisQueue({url})`, `StoredJob`).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/53-real-backend-ci, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test              # now needs --allow-net (deno.json change); guarded Redis tests run when REDIS_URL set, skip otherwise
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file — no src file changed, so no regression expected
```

This milestone adds/changes **no package**, so the two publish gates (`deno task publish:check`,
`deno task release:verify <version>`) are **not** required (no `deno.json` package version or export
graph moves — only root task flags). They remain green by construction; run `publish:check` only if a
reviewer wants belt-and-braces evidence the YAML/script/test edits did not disturb the workspace graph.

**Behaviour lives in CI — so local validation must reproduce it.** Before reporting done:

1. With a local Redis on `127.0.0.1:6379`:
   `REDIS_URL=redis://127.0.0.1:6379 deno task check:apps` — `apps/realtime` and `apps/microservices`
   run to completion (exit 0), and `apps/cloudflare` still reports a skip (no wrangler). Then
   `ALLOW_SKIP=cloudflare REDIS_URL=redis://127.0.0.1:6379 deno task check:apps` exits 0; forcing a
   skip (e.g. `ALLOW_SKIP=cloudflare` with `REDIS_URL` unset so realtime/microservices skip) must exit
   **1** and name `realtime`/`microservices` — proving the assertion discriminates.
2. `REDIS_URL=redis://127.0.0.1:6379 deno task test` — the three deepened tests run the round trips
   (not SKIP). `deno task test` with `REDIS_URL` unset — they log `SKIP:` and pass vacuously,
   confirming the guard.
3. Malformed-dir proof: point a scratch dir or temporarily rename one `apps/*/deno.json` and run
   `check:apps`; it must print `<dir>: missing deno.json — malformed application directory`, set the
   other apps' results, and exit 1 — not crash with an unhandled `NotFound`. (Do this in `.tmp/` or
   revert before committing; never `git add` it.)

**CI evidence shape (what green proves):** the `deno` job's `Example applications` step has a Redis
service container, `REDIS_URL` is in the step env, and the log shows `apps/realtime` +
`apps/microservices` smokes running (not `SKIP:`); `apps/cloudflare` alone logs a skip and the gate
stays green because `ALLOW_SKIP=cloudflare`. The `Test`/`Test with coverage` logs show the three
`redis-real-import` tests passing (not skipping).

## 8. Risks & mitigations

- **`--allow-net` widens permissions for the whole test task.** Risk: another test that asserted
  permission-denied behaviour breaks, or a test silently reaches the network. Mitigation: the repo's
  package tests inject fakes / injected `fetch` and do not make real network calls, so granting the
  permission does not create new calls — only the guarded Redis tests connect, and only when
  `REDIS_URL` is set. Verify by running `deno task test` with `REDIS_URL` unset (no new network paths)
  before and after the flag change.
- **Guarded-test flakiness against a live service container.** Risk: a CI Redis slow to start, or a
  poll timing out. Mitigation: the service uses a `redis-cli ping` healthcheck so the step does not
  start before Redis is ready; the messaging round trip uses a bounded wait (`pollIntervalMs: 50` +
  a test-side timeout) and `disconnect()` in a `finally`; the examples already tolerate startup with
  retry loops (`waitForReady`).
- **`apps/cloudflare` skip status is inferred, not run.** Risk: if cloudflare is somehow made to run
  in CI later, `ALLOW_SKIP=cloudflare` still permits its skip and would not catch a regression there.
  Mitigation: that is acceptable and in-scope-correct — M53 provides no workerd; the allowlist names
  the one app whose backend is out of scope. If a future milestone provides workerd, it removes
  `cloudflare` from `ALLOW_SKIP` in the same change.
- **ROADMAP imprecision (C1).** Risk: an implementer reads "queue is the only one without a guarded
  test" and skips cache/messaging. Mitigation: §2 states plainly that all three are deepened; the
  milestone's acceptance is three new files, not one.

## 9. Out of scope

- Cloud-provider backends needing credentials (AWS SQS/SNS, GCP Pub/Sub, Azure Service Bus) and their
  CI verification — **M54** (ROADMAP §5666, §5714).
- Providing Cloudflare/workerd in CI so `apps/cloudflare` stops skipping — needs the Node/npm
  toolchain this Deno-only CI does not have; deferred (see §3.1).
- Docker Compose / Kubernetes manifests for the examples — **M39** (ROADMAP §5668).
- Adding `apps/*` to the coverage gate — **deliberately never** (ROADMAP §5669).
- Any `packages/*/src` plugin-behaviour change, any `PUBLIC_API.md` change, any new capability token,
  any `@hono-enterprise/common` change. (The status-flip of ROADMAP row 53 and the CLAUDE.md "Current
  status" entry happens in this milestone's own PR at merge, per CLAUDE.md "Before reporting a task
  done" — it is a tracking edit, not an implementation deliverable of this plan.)
