# Milestone 53 — Real-Backend CI (`.github/workflows/ci.yml` + `scripts/check-apps.ts` + guarded Redis tests)

> **Status:** Planning. Branch: `feat/53-real-backend-ci`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Make the real-backend proof path run on every pull request. Today `apps/realtime` and
`apps/microservices` both surface exit code **77** (a reported skip) unless `REDIS_URL` is set, and
no CI job sets it — so the two examples whose whole purpose is to prove cross-replica /
cross-service behaviour against a live broker are skipped in CI. The ioredis eager-connect defect
(fixed in M37b) survived three milestones precisely because every in-package test injects a fake
client and the guarded "real import" tests only assert the module imports. This milestone adds a
Redis service container to CI, exports `REDIS_URL` to the relevant steps, makes a skip that a
provided container should have covered a **regression** rather than a pass, and deepens the guarded
real-import tests so they construct a client and drive one real command (and adds the one Redis
consumer that lacks that deepened test).

**Writing the deepened queue test found the defect it was designed to find, so this milestone now
carries a `packages/queue-plugin/src` fix.** `RedisQueue.reserve()` sends `ZRANGEBYSCORE` with a
positional offset/count and no `LIMIT` keyword, so every reserve against a real Redis answers
`ERR syntax error` — `QueuePlugin({ adapter: 'redis' })` cannot dispatch a job at all. Verified two
ways (§1). An earlier draft of this plan claimed "no package in this milestone and no
plugin-behaviour source change"; that is now false, and the consequences are tracked rather than
waived: the two publish gates become mandatory (§7), the per-file coverage bar applies to the
changed `src` files, and the fix ships with a `CHANGELOG.md` entry.

- **In scope:**
  - `.github/workflows/ci.yml` — a Redis `services:` container with a **host port mapping** and
    `REDIS_URL` exported to the steps that need it (deliverables 1, 2). See §3.4: the job runs
    directly on the runner, so the service label is not a resolvable hostname.
  - `scripts/check-apps.ts` — track skipped examples by name, make a skip for a provided backend a
    failure, and report a malformed application directory by name instead of an unhandled `NotFound`
    (deliverables 3, 6).
  - `deno.json` (root) — add a scoped `--allow-net` to the `test` and `test:coverage` tasks so the
    deepened guarded Redis tests can open a TCP connection to the service container in CI, and add
    `--allow-env=ALLOW_SKIP` to `check:apps`, which otherwise cannot read its own new env var.
  - `packages/queue-plugin/src` — the `ZRANGEBYSCORE … LIMIT` fix and the client-interface widening
    that makes the correct call expressible (§3.5), plus a `CHANGELOG.md` entry.
  - `apps/README.md` — document the `ALLOW_SKIP` gate behaviour this milestone introduces (§2 C2).
  - Deepened guarded real-import tests for **all three** Redis consumers (`cache-plugin`,
    `messaging-plugin`, `queue-plugin`) that construct a client over the real `loadIoredis` path and
    drive one real command round trip (deliverable 4); `queue-plugin`'s is the one ROADMAP
    deliverable 5 names (resolved in §2).
  - `test/apps-gate.test.ts` — cover the new pure `check-apps.ts` seams.
- **NOT this milestone:**
  - Cloud-provider backends needing credentials (AWS/GCP/Azure) — cannot run from a fork PR; **M54**
    owns those brokers and decides its own verification story.
  - A Cloudflare/workerd backend in CI (`apps/cloudflare` skips on a missing `wrangler` today) —
    outside "Redis first"; M53 provides no Node/npm toolchain. See §3.1 and §9.
  - Docker Compose / Kubernetes manifests for the examples — **M39**.
  - Adding `apps/*` to the coverage gate — **deliberately never** (ROADMAP §5645–5647).
  - Any `PUBLIC_API.md` change, any new capability token, any `@hono-enterprise/common` change —
    **none**. The one `packages/*/src` change (§3.5) is a defect repair behind an already-published,
    not-barrel-exported structural type; it changes no documented surface.
  - Any second Redis defect this milestone's new tests may surface beyond §3.5. The cache and
    messaging round trips were prototyped against a real Redis 7 and both pass (§1), so §3.5 is
    expected to be the only one; a further finding is handled on this branch if small, and split out
    with a named follow-up milestone if it is not.

## 1. Contracts verified from SOURCE (not names)

| Reference                                 | Source (file:line)                                                                                               | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `classifySmokeExitCode`                   | `scripts/check-apps.ts:13`                                                                                       | Maps exit `77` → `'skipped'`; `0` → `'passed'`; else `'failed'`. Reused unchanged; the skip-tracking change collects names around it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `readAppConfig` (malformed-dir bug)       | `scripts/check-apps.ts:20`                                                                                       | `JSON.parse(await Deno.readTextFile(path))` — a missing `apps/<dir>/deno.json` throws an unhandled `Deno.errors.NotFound` that aborts the whole script. Deliverable 6 wraps this.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `run()` subprocess spawn                  | `scripts/check-apps.ts:24`                                                                                       | `new Deno.Command(...)` with **no `env` option** → the child inherits the parent process env. So a step-level/job-level `REDIS_URL` propagates to each spawned `deno task smoke` with **no permission change** to the `check:apps` task.                                                                                                                                                                                                                                                                                                                                                                           |
| CI `deno` job                             | `.github/workflows/ci.yml:11`                                                                                    | One job; `Example applications` step `ci.yml:31` runs `deno task check:apps`; `Test` `ci.yml:34`, `Test with coverage` `ci.yml:37`. No `services:`, no `REDIS_URL`, only `denoland/setup-deno@v2`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test` / `test:coverage` tasks            | `deno.json:54` / `deno.json:55`                                                                                  | Grant `--allow-read --allow-import --allow-env --allow-sys=hostname` but **NOT `--allow-net`**. Probed with `Deno.permissions.query({name:'net'})` inside all three packages: `net=prompt` (denied). The deepened tests need `--allow-net` added here.                                                                                                                                                                                                                                                                                                                                                             |
| `check:apps` task permissions             | `deno.json:52`                                                                                                   | `deno run --allow-read --allow-run` — **no `--allow-env`**. Probed: reading an env var under exactly these flags throws `NotCapable: Requires env access to "ALLOW_SKIP", run again with the --allow-env flag`. So §3.1's `ALLOW_SKIP` read requires a permission change to this task; the "no permission change" note on the `run()` row covers env _inheritance_ only, which is a different operation.                                                                                                                                                                                                           |
| `-P` flag meaning                         | `deno test --help` (Deno 2.9.4)                                                                                  | `-P, --permission-set[=<NAME>]` — **not** `--parallel`. Package manifests carry their own `test.permissions` blocks (`packages/cache-plugin/deno.json:7` has one; `queue-plugin` and `messaging-plugin` have none), so the root task string is not the only permission source. Probed both ways: adding `--allow-net` on the CLI yields `net=granted` in cache-plugin (which has a block) _and_ in queue/messaging (which do not), so §3.4's fix works for all three. Recorded because a reviewer reading only the task string will not see the per-package blocks.                                                |
| GitHub Actions service networking         | GitHub Actions docs, "About service containers"                                                                  | For a job running **directly on the runner** (no `container:` key — `ci.yml:12-14` has none), the service label is NOT a resolvable hostname: "the service running in the Docker container does not expose its ports to the job on the runner by default. You need to map ports on the service container to the Docker host", and "you can access service containers using `localhost:<port>` or `127.0.0.1:<port>`". Decisive for §3.4 — an earlier draft used `redis://redis:6379`, which would leave `REDIS_URL` set but unreachable, so `apps/realtime` would **fail** rather than take its exit-77 skip path. |
| `RedisQueue.reserve` ZRANGEBYSCORE defect | `packages/queue-plugin/src/adapters/redis-queue.ts:161`                                                          | `zrangebyscore(readyKey, '-inf', nowMs, 0, limit)` — ioredis forwards args verbatim, so Redis receives `ZRANGEBYSCORE key -inf <now> 0 <limit>` with the mandatory `LIMIT` keyword **missing**. Verified twice: the prototype of §3.2's queue test failed with `ReplyError: ERR syntax error`, and `redis-cli` reproduces standalone (`ZRANGEBYSCORE probe -inf 999 0 5` → `ERR syntax error`; `… LIMIT 0 5` → `a`). Fix verified working against real Redis 7 before being reverted. `redis-queue.ts:277` calls the same method with no offset/count and is valid — only the `reserve` call site is wrong.        |
| Why the defect survived                   | `packages/queue-plugin/test/unit/redis-queue.test.ts:25`                                                         | The fake client is `zrangebyscore: () => []` — a zero-arity stub that accepts any arguments and asserts nothing about them. The contract-violating-double root cause the pre-M18 review campaign identified, and the same shape that hid the M37b ioredis defect.                                                                                                                                                                                                                                                                                                                                                  |
| `IRedisQueueClient.zrangebyscore`         | `packages/queue-plugin/src/interfaces/index.ts:19-24`                                                            | Declares `(key, min, max, offset?: number, limit?: number)` — the interface itself encodes the defect, so the correct call is not expressible against it. §3.5 widens it. Not barrel-exported (`src/index.ts` exports `RedisQueue` and `RedisQueueOptions`, never this type or `StoredJob`), so the widening is not a documented-surface change.                                                                                                                                                                                                                                                                   |
| runtime timer-handle coercion             | `packages/messaging-plugin/src/brokers/redis-streams-broker.ts:320-321` vs `test/fixtures/fake-runtime.ts:31-35` | `#pollIntervals.set(subscriptionId, Number(intervalId))`. The real runtime returns `globalThis.setInterval`'s handle, which coerces (`Number(h)` → `1`), so production clears correctly. The fake wraps it as `{ id }`, and `Number({id})` is **NaN**, so `disconnect()` never clears the poll interval under `createFakeRuntime`. Prototyped: §3.2's messaging test still passes and trips no sanitizer, so this is a note, not a blocker (§8).                                                                                                                                                                   |
| real-backend prototype results            | driven against `redis:7` in Docker                                                                               | The §3.2 cache (`set`/`get`) and messaging (`publish`→`subscribe`) round trips both PASS as specified. `apps/realtime` and `apps/microservices` smokes both exit **0** with `REDIS_URL` set. Only the queue round trip fails, for the reason above.                                                                                                                                                                                                                                                                                                                                                                |
| realtime skip guard                       | `apps/realtime/smoke.ts:7`                                                                                       | `Deno.exit(77)` when `REDIS_URL` is undefined. Replicas are spawned with an explicit `env: { REDIS_URL: url }` (`smoke.ts:29`) from the inherited value.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| microservices skip guard                  | `apps/microservices/smoke.ts:31`                                                                                 | Sets `Deno.exitCode = 77` (after running the non-Redis HTTP path) when `REDIS_URL` is undefined — both surface as `status.code === 77` to `classifySmokeExitCode`.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| cloudflare skip guard (out of scope)      | `apps/cloudflare/smoke.ts:35`                                                                                    | `Deno.exit(77)` when `wrangler --version` fails. CI installs only Deno, so this example **skips in CI today and after M53** — decisive for §3.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| queue lazy loader                         | `packages/queue-plugin/src/adapters/redis-queue.ts:24`                                                           | `const mod = await import('npm:ioredis@5.x'); return mod.Redis;` — the real specifier this milestone's tests exercise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RedisQueue` public surface               | `packages/queue-plugin/src/adapters/redis-queue.ts:113/136/151`                                                  | `connect()` runs `resolveClient` → real `loadIoredis` + `createLazyRedisClient`; `enqueue(job)` drives `hset`+`zadd`; `reserve(...)` drives `zrangebyscore`+`zrem`+`zadd`+`hget`; `disconnect()` drives `quit`. The deepened round trip is enqueue→reserve.                                                                                                                                                                                                                                                                                                                                                        |
| `IRedisQueueClient` command surface       | `packages/queue-plugin/src/interfaces/index.ts:15`                                                               | `zadd/zrangebyscore/zrem/hset/hget/hdel/del/quit` (+ optional `connect`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| cache store surface                       | `packages/cache-plugin/src/stores/redis-store.ts:86`                                                             | `RedisStore(prefix, { url })`; `connect()` runs real `loadIoredis`; `set/get` drive `set/get`; `disconnect()` drives `quit`. `validateClient` (`redis-store.ts:42`) requires `get/set/del/exists/scan/quit`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| messaging broker surface                  | `packages/messaging-plugin/src/brokers/redis-streams-broker.ts:97`                                               | `RedisStreamsBroker(runtime, serializer, { url })`; `connect()` `:155`; `publish(topic, msg)` `:207` drives `xadd`; `subscribe(...)` `:219` drives `xgroup`/`xreadgroup`/`xack`; `disconnect()` `:172` drives `quit`. `validateClient` (`:46`) requires `xadd/xgroup/xreadgroup/xack/quit/connect`.                                                                                                                                                                                                                                                                                                                |
| existing cache guarded test               | `packages/cache-plugin/test/unit/redis-store.test.ts:176`                                                        | Only `import('npm:ioredis@5.x')` and asserts `Redis` is a function — does NOT construct a client or drive a command. This is the shallow form deliverable 4 deepens.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| existing messaging guarded test           | `packages/messaging-plugin/test/unit/redis-streams-broker.test.ts:598`                                           | Constructs a broker with no injected client, calls `connect()` against `redis://localhost:9999` and asserts it **rejects** — enters `loadIoredis` but never drives a command to completion. Kept (covers the reject branch); the new test covers the success branch.                                                                                                                                                                                                                                                                                                                                               |
| existing queue guarded test               | `packages/queue-plugin/test/unit/redis-queue.test.ts:497`                                                        | Constructs `RedisQueue({ url: 'redis://localhost:9999' })`, asserts `connect()` **rejects** — identical in form to messaging's. (See §2: ROADMAP §5659 calls queue "the only one without" a guarded test; source shows otherwise.)                                                                                                                                                                                                                                                                                                                                                                                 |
| check-apps seam test home                 | `test/apps-gate.test.ts:3`                                                                                       | Already imports `classifySmokeExitCode` from `scripts/check-apps.ts` — the home for the new pure-seam tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ioredis specifier                         | `packages/{cache,messaging,queue}-plugin/src/...` + `scheduler-plugin` + `realtime-backplane-plugin`             | The pinned real specifier is `npm:ioredis@5.x` everywhere (not invented).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Doc deliverable (same PR)                                                                                                                                                                                                             |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP §5659 says "`packages/queue-plugin` gains a guarded real-import test — the only one of the three Redis consumers without one". Source contradicts: `packages/queue-plugin/test/unit/redis-queue.test.ts:497` ALREADY has a `describe('guarded real-import')` that enters `loadIoredis`, byte-for-byte the same form as messaging's (`redis-streams-broker.test.ts:598`). The three differ only in depth: cache imports-only; messaging & queue construct-and-connect-then-reject; **none** constructs a client and drives a real command. | Source wins. Reframe deliverable 5 as: queue gains the **deepened** guarded real-import test (construct + connect + drive one command) — the same deepening deliverable 4 applies to cache and messaging. So deliverable 4 is "deepen all three"; deliverable 5 is "queue is the one the ROADMAP names, and its deepened test is new". No ROADMAP edit needed: the milestone satisfies ROADMAP §5659 (queue gains a guarded real-import test — the deepened one) AND §5657 (deepen the tests). | None — no ROADMAP/PUBLIC_API edit. The imprecision is resolved here in the plan; reviewers see `redis-queue.test.ts:497` already exists.                                                                                              |
| C2 | `apps/README.md:22` states "The root `deno task check:apps` gate type-checks every app and runs each smoke task" — a complete description of the gate that this milestone makes incomplete by adding `ALLOW_SKIP` (§3.1). No other committed doc describes the gate's skip semantics, so nothing contradicts the new behaviour; the defect is silence, not disagreement.                                                                                                                                                                          | Document it where the gate is already described, rather than only in CI YAML where an example author will not look.                                                                                                                                                                                                                                                                                                                                                                            | `apps/README.md` — one paragraph after the gate sentence: skip semantics (exit 77), `ALLOW_SKIP`'s local-vs-CI behaviour, and that a newly added example whose backend CI does not provide must be listed there or it fails the gate. |
| C3 | ROADMAP §M53 frames the whole milestone as CI plumbing and its six deliverables name no source change, which reads as "no package changes". Deliverable 4 ("construct a client and drive one command") cannot be satisfied for `queue-plugin` without the §3.5 fix — the test it mandates fails against a real Redis.                                                                                                                                                                                                                             | The deliverable wins over the framing: a deepened test that cannot pass is not a deliverable. M53 absorbs the `queue-plugin` fix. This is the milestone working as designed — it exists to catch exactly this class — so it is recorded as a finding, not smuggled in.                                                                                                                                                                                                                         | No ROADMAP edit (no deliverable changes). `CHANGELOG.md` gains a fix entry under `queue-plugin`; the CLAUDE.md "Current status" M53 entry names the defect when the status is flipped at merge.                                       |
| C4 | None other found. ARCHITECTURE.md has no CI / `check:apps` / examples section (the only `services:` matches are inside code-block illustrations, `ARCHITECTURE.md:1697/1866`), so there is no committed architecture description of the gate to conflict with. PUBLIC_API.md is untouched — §3.5 changes only a non-barrel-exported structural type.                                                                                                                                                                                              | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | None (checked ARCHITECTURE.md, PUBLIC_API.md, ROADMAP.md).                                                                                                                                                                            |

## 3. Design decisions

### 3.1 Zero-skipped assertion: an allowlist, not a global fail-on-skip

- **Decision:** `scripts/check-apps.ts` gains an env var `ALLOW_SKIP` whose value is a
  comma-separated list of application names permitted to skip. When `ALLOW_SKIP` is **unset** (local
  development), a skip is a warning — current behaviour preserved. When `ALLOW_SKIP` is **set**
  (CI), any skipped app **not** in the list makes `check:apps` exit 1, naming the regression. CI
  sets `ALLOW_SKIP: "cloudflare"` (workerd is out of scope for M53) alongside `REDIS_URL`.
- **Why:** three apps skip today, not two. `apps/cloudflare` skips on a missing `wrangler`
  (`apps/cloudflare/smoke.ts:35`) and CI installs only Deno, so it skips in CI both before and after
  this milestone. A global "any skip fails" gate would therefore break CI on cloudflare. The
  allowlist is the only mechanism that is correct **regardless** of cloudflare's status: it
  explicitly names the one app whose backend M53 does not provide. It is also the more robust
  default for the future — a newly added example that skips (its backend not yet provided)
  auto-fails CI, forcing the author to add the service container or justify the skip in
  `ALLOW_SKIP`. This is exactly ROADMAP §5655: "a skip that a container should have covered is a
  regression, not a pass".
- **Test home:** `test/apps-gate.test.ts` drives the pure seam `unexpectedSkips(skipped, allowList)`
  (§4) with: `skipped=['cloudflare'], allowList=['cloudflare']` → `[]`;
  `skipped=['realtime','cloudflare'], allowList=['cloudflare']` → `['realtime']`.

### 3.2 Deepened guarded real-import test: one per Redis consumer, drive a real command

- **Decision:** Add ONE new file per consumer —
  `packages/cache-plugin/test/unit/redis-real-import.test.ts`,
  `packages/messaging-plugin/test/unit/redis-real-import.test.ts`,
  `packages/queue-plugin/test/unit/redis-real-import.test.ts` — each guarded identically: read
  `REDIS_URL`; `await import('npm:ioredis@5.x')`; if any one is unavailable, log `SKIP:` and return
  (the existing apps/§6.7 guard pattern). When available, construct the package's own class **with
  no injected client** (so the production `loadIoredis` → `createLazyRedisClient` → `connect()` path
  runs for real), connect to `REDIS_URL`, drive **one real command round trip** through the public
  surface, assert it, and `disconnect()`:
  - cache: `new RedisStore('m53:', { url })` → `connect()` → `set('k','v')` → `get('k')` resolves
    `'v'` → `disconnect()` (real `set`/`get`).
  - messaging: `new RedisStreamsBroker(runtime, serializer, { url, pollIntervalMs: 50 })` →
    `connect()` → `subscribe(topic, handler)` → `publish(topic, payload)` → `handler` receives the
    payload → `disconnect()` (real `xadd`/`xgroup`/`xreadgroup`/`xack`).
  - queue: `new RedisQueue({ url })` → `connect()` → `enqueue(storedJob)` →
    `reserve(name, 1, nowMs)` returns the job → `ack(name, id)` → `disconnect()` (real
    `hset`/`zadd`/`zrangebyscore`/`zrem`/`hget`/`hdel`). Each uses the package's existing
    fake-runtime/serializer fixtures where the constructor needs them (messaging reuses
    `createFakeRuntime()` + `JsonSerializer`).
- **Why:** This is precisely the proof the ioredis defect needed and the shallow tests could not
  provide: a real client is constructed (the M37b defect was that construction connected eagerly and
  the explicit `connect()` then threw — invisible to any fake and to any import-only or reject-only
  test) and one command is driven against a live server. The class-with-no-injected-client route is
  the real production load path, so `loadIoredis`/`resolveClient`/`createLazyRedisClient` execute
  for real, not via the injection seam (which the existing `redis-client-factory.test.ts` unit tests
  already cover). The existing reject-path tests (`redis-queue.test.ts:497`,
  `redis-streams-broker.test.ts:598`) and cache's import-only block (`redis-store.test.ts:176`) are
  **kept** — they cover the connect-fails / module-present branches; the new files cover the
  connect-succeeds-and-drives-a-command branch. No restructuring of the existing tests is required.
- **Test home:** the three new files above. These run for real in CI (`REDIS_URL` set on the job)
  and skip locally (no `REDIS_URL`). They do not change any `src/` coverage number — the `src`
  methods they call (`enqueue`/`reserve`/`set`/`get`/`publish`/`subscribe`) are already ≥90%-covered
  by the fake-driven unit tests; the new tests add real-backend confidence, the metric ROADMAP §5647
  names.

### 3.3 Malformed application directory: catch, name, continue

- **Decision:** In `checkApps()`, wrap the `readAppConfig(`${cwd}/deno.json`)` call. On
  `Deno.errors.NotFound` report `<dir>: missing deno.json — malformed application directory`; on
  `SyntaxError` report `<dir>: deno.json is not valid JSON — malformed application directory`; any
  other error rethrows. In both named cases set `failed = true` and `continue` to the next app
  rather than aborting the script with an unhandled stack. The decision is a pure seam
  `malformedAppDirMessage(directory, error): string | null`.
- **Why:** ROADMAP §5661 wants a malformed directory "reported by name instead of throwing an
  unhandled `NotFound`". Today one bad entry kills the whole gate and hides which app was malformed.
  Catching at the loop boundary and naming the directory turns a crash into a named, recoverable
  failure that still fails the gate (a malformed app is not a pass) while letting the remaining apps
  report. The pure seam keeps the branching unit-testable without spawning subprocesses.
- **Test home:** `test/apps-gate.test.ts` drives `malformedAppDirMessage('foo', NotFound)` → the
  missing-config message; `(..., SyntaxError)` → the invalid-json message; `(..., RangeError)` →
  `null` (caller rethrows).

### 3.4 CI wiring: Redis service on a mapped host port, job-level `REDIS_URL`, two permission edits

- **Decision:** In `.github/workflows/ci.yml`, add a `services:` block to the `deno` job running
  `image: redis:7` with a `redis-cli ping` healthcheck **and an explicit `ports: ['6379:6379']` host
  mapping**, set `REDIS_URL: redis://localhost:6379` as **job-level** `env` (so `check:apps`,
  `test`, and `test:coverage` all inherit it), and set `ALLOW_SKIP: "cloudflare"` on the
  `Example
  applications` step. In `deno.json`, make two permission edits: add
  `--allow-net=127.0.0.1:6379,localhost:6379` to the `test` and `test:coverage` task strings, and
  add `--allow-env=ALLOW_SKIP` to `check:apps`.
- **Why `localhost` and not the service label:** the `deno` job has no `container:` key, so it runs
  directly on the runner host, where a service container is reachable only through a mapped port on
  `localhost` — the label `redis` does not resolve (§1, quoting the GitHub docs). This is the single
  most dangerous detail in the milestone, because getting it wrong does not produce a clean skip:
  with `REDIS_URL` set but unreachable, `apps/realtime/smoke.ts:7` takes the **non**-skip path,
  throws, and turns the new gate red on its first run. The port mapping is what makes `localhost`
  correct; the healthcheck is what makes it ready.
- **Why job-level `REDIS_URL`:** one place satisfies both the example smokes (via inherited env into
  the spawned `deno task smoke` subprocesses) and the package-level deepened tests (run by
  `deno task test`). Verified inert for everything else: no file under `packages/` or `test/` reads
  `REDIS_URL` today, so exporting it job-wide changes no existing test's behaviour.
- **Why `--allow-env=ALLOW_SKIP` on `check:apps`:** §3.1 reads that variable in the parent process,
  and the task grants no env access, so the gate would throw `NotCapable` on its first CI run (§1).
  Scoped to the one name rather than blanket `--allow-env`, so the script cannot quietly grow other
  env reads. `ALLOW_SKIP` stays step-scoped in the YAML because it is a `check-apps` concern.
- **Why `--allow-net` is required, and why it is scoped:** the test task grants no network
  permission today (probed: `net=prompt`), so a guarded test that sees `REDIS_URL` set in CI would
  throw `PermissionDenied` on connect — and since the guard only checks "url set + ioredis imports",
  that surfaces as a hard failure rather than a skip, defeating the gate. `--allow-import` (already
  present) covers fetching `npm:ioredis@5.x`; `--allow-net` covers the resulting TCP socket. It is
  **scoped to the Redis endpoint** rather than granted blanket, so the deepened tests get exactly
  the access they need and no test can silently reach an arbitrary host. Note for the implementer:
  `-P` loads each package's own `test.permissions` block (§1), but a CLI `--allow-net` was probed to
  grant net in all three packages regardless, so no per-package manifest edit is needed.
- **Test home:** the behavioural evidence (§7) — locally
  `REDIS_URL=redis://127.0.0.1:6379 deno task
  check:apps` runs the two Redis smokes to completion;
  `REDIS_URL` unset leaves them skipped (and `ALLOW_SKIP` unset keeps that a warning). The deepened
  tests run with `REDIS_URL` set and skip without it.

### 3.5 The `ZRANGEBYSCORE … LIMIT` fix in `queue-plugin`

- **Decision:** Correct `redis-queue.ts:161` to send the mandatory keyword —
  `zrangebyscore(readyKey, '-inf', nowMs, 'LIMIT', 0, limit)` — and widen
  `IRedisQueueClient.zrangebyscore` so that call is expressible, from the current
  `(key, min, max, offset?: number, limit?: number)` to a trailing rest parameter typed
  `...limitClause: readonly ['LIMIT', number, number] | readonly []`. That shape admits exactly the
  two call sites the adapter makes (`reserve` with a limit clause, `fetchRecurringDue` at
  `redis-queue.ts:277` without one) and rejects the positional form that caused the defect, so the
  type system prevents the regression rather than a comment asking future readers not to repeat it.
  `validateClient`'s required-method list is unchanged (the method name is the same).
- **Why a type change rather than only a call-site change:** the interface encodes the bug. Leaving
  `offset?: number, limit?: number` in place means the broken call keeps type-checking, and the next
  adapter method that needs a limit clause reintroduces it. The widened type is not a documented
  surface change: `IRedisQueueClient` is marked "Intentionally not barrel-exported"
  (`interfaces/index.ts:10-14`) and `src/index.ts` exports neither it nor `StoredJob`, so no
  consumer can name it and `PUBLIC_API.md` needs no edit. An application injecting its own client
  via `RedisQueueOptions.client` is structurally checked, and a real ioredis instance satisfies the
  widened signature.
- **Why it must ship in this milestone rather than a follow-up `fix/…` branch:** the defect is in
  already-merged `main`, which normally routes to a `fix/…` branch. It stays here because
  deliverable 4 is not satisfiable without it — the deepened queue test this milestone must add
  fails against a real Redis until the fix lands, so splitting them would merge a knowingly-red test
  or a knowingly weakened one.
- **Test home:** two places, because the round trip alone would not pin the regression.
  `packages/queue-plugin/test/unit/redis-queue.test.ts` gains a fake-client assertion on the
  **arguments** `reserve` passes (the existing fake asserts only that the method was called, which
  is why the defect survived — §1), and `redis-real-import.test.ts` (§3.2) proves it end to end
  against a live server. The unit assertion must be verified to fail against the unfixed call site.

## 4. Exported surface — every symbol names its consumer

No package `src/index.ts` is touched, so no JSR-published surface changes. The new exports are
internal to `scripts/check-apps.ts` (not a published package; `scripts/` is excluded from coverage
and publishing); the one package-source change is to a type no barrel exports. Every symbol names
its real reader:

| Exported symbol                             | Kind        | Consumer / real code path that READS it                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `classifySmokeExitCode` (existing)          | fn          | `checkApps()` smoke loop; tested in `test/apps-gate.test.ts:33`.                                                                                                                                                                                                                                       |
| `unexpectedSkips(skipped, allowList)`       | fn (NEW)    | `checkApps()` end-of-run enforcement (§3.1); tested in `test/apps-gate.test.ts`.                                                                                                                                                                                                                       |
| `malformedAppDirMessage(directory, error)`  | fn (NEW)    | `checkApps()` config-read catch (§3.3); tested in `test/apps-gate.test.ts`.                                                                                                                                                                                                                            |
| `IRedisQueueClient.zrangebyscore` (WIDENED) | type member | Read by `RedisQueue.reserve` (`redis-queue.ts:161`, with a limit clause) and `RedisQueue.fetchRecurringDue` (`:277`, without one) — the only two call sites, and the widened union admits exactly those two forms (§3.5). Not barrel-exported, so it has no external consumer and no PUBLIC_API entry. |

### 4.1 Options — every option names its consumer

| Option                                                       | Consumer                                                                          | Behavior (per implementation)                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOW_SKIP` (env, read by `check-apps.ts`)                  | `checkApps()`                                                                     | Unset → every skip is a warning (local-dev default). Set → a skip not listed fails the gate. CI value: `cloudflare`. Requires `--allow-env=ALLOW_SKIP` on the `check:apps` task (§3.4).  |
| `REDIS_URL` (env, inherited)                                 | `apps/realtime/smoke.ts`, `apps/microservices/smoke.ts`, the three deepened tests | Unset → those smokes exit 77 and the deepened tests SKIP. Set → they run against the live Redis. CI value: `redis://localhost:6379`, which requires the service `ports:` mapping (§3.4). |
| `--allow-net=127.0.0.1:6379,localhost:6379` (deno task flag) | `deno task test` / `test:coverage`                                                | Permits the TCP connect the deepened tests need, and nothing else; no effect when `REDIS_URL` is unset (tests skip before connecting).                                                   |
| `--allow-env=ALLOW_SKIP` (deno task flag)                    | `deno task check:apps`                                                            | Permits the one env read §3.1 adds. Without it the gate throws `NotCapable` on its first CI run.                                                                                         |

No new plugin options, no new capability token, no `common` types.

## 5. Implementation files

| File                                                            | Purpose                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                                      | Add `services: redis:` (redis:7 + `redis-cli ping` healthcheck + `ports: ['6379:6379']`) to the `deno` job; add job-level `env: REDIS_URL: redis://localhost:6379`; add step `env: ALLOW_SKIP: cloudflare` to `Example applications`. |
| `scripts/check-apps.ts`                                         | (a) collect skipped app names + print a `Skipped: N [<names>]` summary; (b) `ALLOW_SKIP` enforcement via `unexpectedSkips`; (c) malformed-dir handling via `malformedAppDirMessage`; (d) export the two new pure seams.               |
| `deno.json`                                                     | Add `--allow-net=127.0.0.1:6379,localhost:6379` to the `test` (`:54`) and `test:coverage` (`:55`) task strings; add `--allow-env=ALLOW_SKIP` to `check:apps` (`:52`).                                                                 |
| `packages/queue-plugin/src/adapters/redis-queue.ts`             | Fix the `reserve` call at `:161` to pass the `'LIMIT'` keyword (§3.5).                                                                                                                                                                |
| `packages/queue-plugin/src/interfaces/index.ts`                 | Widen `IRedisQueueClient.zrangebyscore`'s trailing parameters to the limit-clause union (§3.5).                                                                                                                                       |
| `packages/queue-plugin/test/unit/redis-queue.test.ts`           | Add the argument-level assertion on what `reserve` sends, which the existing zero-arity fake could not make (§3.5).                                                                                                                   |
| `CHANGELOG.md`                                                  | Fix entry: `queue-plugin` Redis `reserve` never worked against a real server.                                                                                                                                                         |
| `apps/README.md`                                                | Document the gate's skip semantics and `ALLOW_SKIP` (§2 C2).                                                                                                                                                                          |
| `packages/cache-plugin/test/unit/redis-real-import.test.ts`     | NEW — deepened guarded real-import: `RedisStore` set→get round trip.                                                                                                                                                                  |
| `packages/messaging-plugin/test/unit/redis-real-import.test.ts` | NEW — deepened guarded real-import: `RedisStreamsBroker` publish→subscribe round trip.                                                                                                                                                |
| `packages/queue-plugin/test/unit/redis-real-import.test.ts`     | NEW — deepened guarded real-import: `RedisQueue` enqueue→reserve round trip (ROADMAP deliverable 5).                                                                                                                                  |
| `test/apps-gate.test.ts`                                        | Add tests for `unexpectedSkips` and `malformedAppDirMessage`.                                                                                                                                                                         |

No `apps/**` source is edited (the smokes already exit 77 correctly, verified by running both
against a real Redis). No `PUBLIC_API.md` edit — the one `src` change is to a type no barrel exports
(§3.5).

## 6. Test plan (every changed file mapped; per-file 90% bar)

`scripts/check-apps.ts` lives under `scripts/`, not `packages/`, so it is outside the coverage
measurement; its new branching is covered through the pure seams exercised by
`test/apps-gate.test.ts` (the `classifySmokeExitCode` precedent). The three new package test files
test `src` methods that are already ≥90%-covered by fake-driven unit tests, so they add no new
uncovered paths; they are additive real-backend confidence. The verification bar for them is "the
round trip ran against a live Redis", not a percentage (ROADMAP §5647).

**Coverage does apply to §3.5.** `redis-queue.ts` and `interfaces/index.ts` are now changed `src`
files, so the per-file 90% branch/function/line bar applies to them and must be read from the
ANSI-stripped table after the change, not assumed. The fix alters an argument list rather than
adding a branch, so no coverage movement is expected — which is exactly why it must be confirmed
rather than predicted.

| Test file                                                             | src / surface covered                                                             | Key assertions (signature each call type-checks against)                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/queue-plugin/test/unit/redis-queue.test.ts` (edited)        | `RedisQueue.reserve` argument shape (§3.5)                                        | A recording fake captures the `zrangebyscore` arguments; asserts they are `[key, '-inf', nowMs, 'LIMIT', 0, limit]`. **Must be verified to FAIL against the unfixed call site** — the existing `zrangebyscore: () => []` fake is precisely what let the defect ship.                                                          |
| `test/apps-gate.test.ts` (edited)                                     | `unexpectedSkips`, `malformedAppDirMessage`                                       | `unexpectedSkips(['cloudflare'], ['cloudflare'])` → `[]`; `unexpectedSkips(['realtime','cloudflare'], ['cloudflare'])` → `['realtime']`; `malformedAppDirMessage('foo', new Deno.errors.NotFound(...))` → contains `missing deno.json`; `(... SyntaxError ...)` → contains `not valid JSON`; `(... RangeError ...)` → `null`. |
| `packages/cache-plugin/test/unit/redis-real-import.test.ts` (NEW)     | `RedisStore.connect/set/get/disconnect` over real `loadIoredis`                   | Guarded skip when no `REDIS_URL`/ioredis; else `get('k')` resolves `'v'` after `set('k','v')`.                                                                                                                                                                                                                                |
| `packages/messaging-plugin/test/unit/redis-real-import.test.ts` (NEW) | `RedisStreamsBroker.connect/publish/subscribe/disconnect` over real `loadIoredis` | Guarded skip; else a `subscribe` handler receives the payload published to the same topic within a bounded wait.                                                                                                                                                                                                              |
| `packages/queue-plugin/test/unit/redis-real-import.test.ts` (NEW)     | `RedisQueue.connect/enqueue/reserve/ack/disconnect` over real `loadIoredis`       | Guarded skip; else `reserve(name, 1, nowMs)` returns exactly the job `enqueue` stored, then `ack` clears it.                                                                                                                                                                                                                  |

Every call above type-checks against the verified signatures in §1 (`RedisStore(prefix, {url})`,
`RedisStreamsBroker(runtime, serializer, {url})`, `RedisQueue({url})`, `StoredJob`).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/53-real-backend-ci, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test              # now needs the scoped --allow-net (deno.json change); guarded Redis tests run when REDIS_URL set, skip otherwise
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line — check redis-queue.ts and interfaces/index.ts explicitly
```

**Both publish gates are mandatory.** An earlier draft waived them on the grounds that no package
changed; §3.5 makes that false, and CLAUDE.md requires them for any milestone that changes a
package:

```bash
deno task publish:check              # on a COMMITTED tree — it refuses a dirty one
deno task release:verify 0.1.0-alpha.4
```

`queue-plugin` is a published package, so a slow type or a broken export in the widened interface
would block the next release, and only these gates see that. The widened `zrangebyscore` uses a rest
parameter typed as a union of tuple types — a shape worth confirming through `publish:check` rather
than assuming, since JSR's `.d.ts` generation is what the Node and Bun compat jobs consume.

**Behaviour lives in CI — so local validation must reproduce it.** Before reporting done:

Start the backend the same way CI will (`docker run -d --name m53redis -p 6379:6379 redis:7`), and
remove it afterwards so a later local run cannot pass against a stale container.

1. `REDIS_URL=redis://127.0.0.1:6379 deno task check:apps` — `apps/realtime` and
   `apps/microservices` run to completion (exit 0), and `apps/cloudflare` still reports a skip (no
   wrangler). Then `ALLOW_SKIP=cloudflare REDIS_URL=redis://127.0.0.1:6379 deno task check:apps`
   exits 0; forcing a skip (e.g. `ALLOW_SKIP=cloudflare` with `REDIS_URL` unset so
   realtime/microservices skip) must exit **1** and name `realtime`/`microservices` — proving the
   assertion discriminates.
2. `REDIS_URL=redis://127.0.0.1:6379 deno task test` — the three deepened tests run the round trips
   (not SKIP). `deno task test` with `REDIS_URL` unset — they log `SKIP:` and pass vacuously,
   confirming the guard. 2b. **Prove the §3.5 fix and its unit test discriminate.** Revert the
   `'LIMIT'` argument alone and confirm the new `redis-queue.test.ts` assertion FAILS and the
   deepened queue test fails against the live server with `ReplyError: ERR syntax error`; restore it
   and confirm both pass. A fix whose test passes with and without it is not a fix.
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

- **`--allow-net` changes what two EXISTING tests do.** The earlier draft claimed it "does not
  create new calls"; that is false and was verified false. `redis-queue.test.ts:497` and
  `redis-streams-broker.test.ts:598` connect to `redis://localhost:9999` and assert a rejection —
  today they reject at the _permission_ boundary without a socket, and after the flag they make a
  real TCP attempt. Both still pass (probed), but ioredis now prints
  `[ioredis] Unhandled error event: AggregateError` to the test log. Mitigation: scope the flag to
  the Redis endpoint (§3.4) so no other host is reachable, expect that stderr line, and re-read the
  run after the change rather than only the exit code. No sanitizer trip was observed.
- **A leaked poll interval in the messaging round trip.** `RedisStreamsBroker` stores
  `Number(intervalId)`, which is `NaN` under `createFakeRuntime`'s `{ id }` handle, so
  `disconnect()` does not clear the poll loop (§1). Production is unaffected — real handles coerce
  to a number. The prototype of §3.2's messaging test passed and tripped no sanitizer, so this is
  not a blocker; the risk is a future test in the same file inheriting a still-polling interval.
  Mitigation: keep the messaging round trip in its own file (as §3.2 already specifies) and note the
  fixture defect in the PR description so it is not rediscovered as a mystery. Fixing the fixture is
  not in scope.
- **Guarded-test flakiness against a live service container.** Risk: a CI Redis slow to start, or a
  poll timing out. Mitigation: the service uses a `redis-cli ping` healthcheck so the step does not
  start before Redis is ready; the messaging round trip uses a bounded wait (`pollIntervalMs: 50` +
  a test-side timeout) and `disconnect()` in a `finally`; the examples already tolerate startup with
  retry loops (`waitForReady`).
- **`apps/cloudflare` skip status is inferred, not run.** Risk: if cloudflare is somehow made to run
  in CI later, `ALLOW_SKIP=cloudflare` still permits its skip and would not catch a regression
  there. Mitigation: that is acceptable and in-scope-correct — M53 provides no workerd; the
  allowlist names the one app whose backend is out of scope. If a future milestone provides workerd,
  it removes `cloudflare` from `ALLOW_SKIP` in the same change.
- **ROADMAP imprecision (C1).** Risk: an implementer reads "queue is the only one without a guarded
  test" and skips cache/messaging. Mitigation: §2 states plainly that all three are deepened; the
  milestone's acceptance is three new files, not one.
- **A wrong `REDIS_URL` host fails loudly but misleadingly.** Risk: with the service label used as a
  hostname, or the `ports:` mapping omitted, `REDIS_URL` is set but unreachable, so the smokes throw
  instead of skipping and the failure looks like a defect in the examples rather than in the
  workflow. Mitigation: §3.4 pins `localhost` plus an explicit port mapping and states the failure
  mode; the first CI run is read for the two smokes _running_, not merely for a green job.
- **Scope grew mid-milestone (§3.5).** Risk: absorbing a `main` defect into a CI milestone blurs the
  branch rule and expands the review surface. Mitigation: the fix is small, contained to one call
  site and one non-exported type, justified in §3.5 against the alternative of shipping a
  knowingly-failing deliverable, and carried with its own discriminating test (§7 step 2b) plus a
  CHANGELOG entry.

## 9. Out of scope

- Cloud-provider backends needing credentials (AWS SQS/SNS, GCP Pub/Sub, Azure Service Bus) and
  their CI verification — **M54** (ROADMAP §5666, §5714).
- Providing Cloudflare/workerd in CI so `apps/cloudflare` stops skipping — needs the Node/npm
  toolchain this Deno-only CI does not have; deferred (see §3.1).
- Docker Compose / Kubernetes manifests for the examples — **M39** (ROADMAP §5668).
- Adding `apps/*` to the coverage gate — **deliberately never** (ROADMAP §5669).
- Any `PUBLIC_API.md` change, any new capability token, any `@hono-enterprise/common` change. The
  §3.5 fix is the only `packages/*/src` edit and touches no documented surface.
- Fixing the `createFakeRuntime` timer-handle defect in `messaging-plugin` (§8). It is a real
  fixture bug with no production effect; correcting it touches a fixture nine test files share,
  which is a larger blast radius than this milestone should carry. Recorded in the PR description.
- (The status-flip of ROADMAP row 53 and the CLAUDE.md "Current status" entry happens in this
  milestone's own PR at merge, per CLAUDE.md "Before reporting a task done" — it is a tracking edit,
  not an implementation deliverable of this plan.)
