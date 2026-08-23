# Milestone 70l — Deployment and operations (`cli`, `scheduler-plugin`, `messaging-plugin`, `metrics-plugin`, `cloudflare-plugin`)

> **Status:** Planning. Branch: `feat/m70l-deployment-operations`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The alpha-8 register's deployment workstream: nine rows that share one shape — **the framework runs
correctly on one machine and stops being correct the moment it is containerised, scaled, or
scraped.** `docker compose up` on the CLI's own generated stack crash-loops two of three services; a
scheduled job silently multiplies by replica count and the one documented remedy does not stop it; a
rolling deploy drops requests because the generated manifest omits a field the repository's own
chart ships; `/metrics` is exposed on every member and discovered by no Prometheus; and the series
it does serve are dominated by the platform's own probes. Every one of these is invisible to the
four gates by construction, because none of them runs a second replica, a scraper, or a container
built from generated output.

- **In scope:** X10-1 (RabbitMQ 4 refuses the queue shape the broker declares), X10-2 (scheduled
  jobs run once per replica; `distributedLock` does not deduplicate), X10-4 (generated
  `k8s/members.yaml` omits `preStop`), X10-5 (generated Dockerfile's `chown -R` doubles the image),
  X10-6 (no `prometheus.io/*` annotations), X10-7 (`/metrics` counts its own scrapes and probes),
  X9-2 (`SchedulerPlugin` on Workers accepts jobs that never fire), X9-5 (`WorkersCron` reports
  nothing), X9-8 (a failed boot is cached for the isolate's life and the raw stack reaches the
  client).
- **NOT this milestone:** X10-3 (the `kubernetes` discovery provider's unreachable `down`) — closed
  by **M70c**, verified: `ServiceDiscoveryService` gained `#everResolved` there. X9-1 (`waitUntil`
  dropping background tasks), X9-3, X9-4, X9-6 (closed by **M70f**), X9-7, X9-9, X9-10 — the Workers
  rows outside the deployment/operations theme, owned by **M70n**'s docs sweep except X9-1, which is
  unowned and named in §9. SDK/OpenAPI rows are **M70m**; decorator/DI rows are **M70n**.

**No `common` change and no new capability token.** Every widening this milestone needs is
plugin-local — verified in §1 — which is worth stating because eight of the eleven M70 workstreams
widened `common` and a reviewer will reasonably expect a twelfth.

## 1. Contracts verified from SOURCE (not names)

Every row below was opened and read on this branch's tree, **not** taken from the register: the
register was written against published `v0.1.0-alpha.8` and this tree has moved (M70c rewrote
`rabbitmq-broker.ts` wholesale, so the register's `:281` is now `:442`).

| Reference                          | Source (file:line)                                                    | Verified surface / fact                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RabbitMqBroker.#consumeOn`        | `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts:442`        | Declares `assertQueue(queueName, { durable: false })` — named, non-durable, non-exclusive: exactly the trio RabbitMQ 4 refuses. Shared by `subscribe` **and** the drive-mode replay, so one edit covers both.                                   |
| `RabbitMqBroker.subscribe`         | `.../rabbitmq-broker.ts:315-317`                                      | Already computes `const isExclusive = options?.queue === undefined` and uses it for delete-on-unsubscribe bookkeeping (`:345`) — **the intent exists and is simply never passed to the broker**.                                                |
| `RabbitMqBroker` ctor              | `.../rabbitmq-broker.ts:148-151`                                      | Builds its own inbox via `createTopicInbox({ subscribe: (t,h,o) => this.subscribe(t,h,o), uuid })` — the broker owns that closure, so an internal transience marker needs no `common` change.                                                   |
| `createTopicInbox`                 | `packages/messaging-plugin/src/brokers/inbox.ts:90`                   | Subscribes with `{ queue: address }` where `address` is per-instance unique. **Named but private** — so a naive "named ⇒ durable" rule would leak one durable reply queue per instance.                                                         |
| `SubscribeOptions`                 | `packages/common/src/services/messaging.ts:43-46`                     | Carries **only** `queue?: string`, documented as "Consumer group / queue name". No durability/exclusivity member exists — confirming the marker must be broker-internal, not a `common` widening.                                               |
| `RabbitMqQueue.#assertQueues`      | `packages/queue-plugin/src/adapters/rabbitmq-queue.ts:192,199`        | Declares `{ durable: true }`. **Not affected** — `queue-plugin` needs no change for X10-1.                                                                                                                                                      |
| `SchedulerService.#runWithLock`    | `packages/scheduler-plugin/src/services/scheduler-service.ts:313-355` | `acquire(lockKey, ttlMs)` then `release(...)` in a `finally` immediately after the handler. Confirms the register's mechanism verbatim.                                                                                                         |
| `SchedulerService.#fire`           | `.../scheduler-service.ts:362`                                        | `const lockKey = \`scheduler:job:${entry.name}\`` — no slot component.                                                                                                                                                                          |
| `RegistryEntryBase.nextRunAtMs`    | `packages/scheduler-plugin/src/interfaces/index.ts:104`               | Present on **every** entry variant: the epoch-ms time the fire was _intended_ for. This is the slot identity §3.2 uses.                                                                                                                         |
| `every` arming                     | `.../scheduler-service.ts:160`, re-arm `:244`, resume `:411`          | `nextRunAtMs = now + intervalMs` — **replica-relative**. Two replicas started 0.7 s apart never agree on a slot; this is why §3.3 is required and not optional polish.                                                                          |
| `cronNextMs` arming                | `.../scheduler-service.ts:126,241,408`                                | `cronNextMs(expression, now)` — a pure function of expression and clock landing on the expression's own grid, so replicas already agree. Cron needs no alignment change.                                                                        |
| `MemoryLock.acquire`               | `packages/scheduler-plugin/src/lock/memory-lock.ts:45-60`             | Deletes an expired key **only when that same key is next acquired**. With never-released slot keys (which are never reacquired) the map grows without bound — §3.4.                                                                             |
| `DistributedLockOptions.ttlMs`     | `packages/scheduler-plugin/src/interfaces/index.ts:84`                | Default `30000`, JSDoc "Must exceed the job's worst-case runtime".                                                                                                                                                                              |
| `SchedulerService` ttl default     | `.../scheduler-service.ts:61`                                         | `this.#ttlMs = options?.ttlMs ?? 30000`.                                                                                                                                                                                                        |
| `SchedulerPlugin.register`         | `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts:46-88`      | Resolves the lock, builds the service, registers `'scheduler'`. **No platform check anywhere** — confirms X9-2.                                                                                                                                 |
| `assertNotCloudflareWorkers`       | `packages/messaging-plugin/src/brokers/cloud-gate.ts:24-31`           | The committed refusal precedent: `if (runtime.platform() === 'cloudflare-workers') throw <named error>`. §3.5 follows this shape.                                                                                                               |
| `WorkersCron.dispatch` / `#runOne` | `packages/cloudflare-plugin/src/cron/workers-cron.ts:133-157`         | Both report sites are `this.#logger?.warn/error` — silent when no logger. `#runOne` swallows every rejection, so `Promise.all` **always** resolves.                                                                                             |
| `WorkersCron` JSDoc rationale      | `.../workers-cron.ts:124-127`                                         | States swallowing exists so "one failing handler must not abandon the others", and notes "the platform's only response to a thrown `scheduled` is to count the whole invocation as failed" — §3.6 preserves the first and _uses_ the second.    |
| `createScheduledHandler`           | `packages/cloudflare-plugin/src/cron/scheduled-handler.ts:49-50`      | `return (controller) => cron.dispatch(controller)` — a plain delegation, so a rejecting `dispatch` propagates to the platform with no further change.                                                                                           |
| cloudflare README contradiction    | `packages/cloudflare-plugin/README.md:368` vs `:412`                  | `:368` instructs `app.register(SchedulerPlugin({ distributedLock: { lock } }))`; `:412` promises a trigger with nothing registered "is logged every time". `:131` writes `new WorkersCron()` with no logger. All three verified present.        |
| `HttpCollector` labels             | `packages/metrics-plugin/src/collectors/http-collector.ts:76`         | `const labels = ['method', 'status']` with a comment calling them "fixed, not configurable". No path is available to filter on today.                                                                                                           |
| `HttpCollector.middleware`         | `.../http-collector.ts:116-162`                                       | Single entry point for the gauge, histogram and both counters — so one guard at the top covers every series (§3.11).                                                                                                                            |
| `MetricsPluginOptions`             | `packages/metrics-plugin/src/interfaces/index.ts:67-80`               | Plugin-local interface with `endpoint?: string` (default `'/metrics'`). The plugin already knows its own scrape path.                                                                                                                           |
| Health default paths               | `packages/health-plugin/src/plugin/health-plugin.ts:62-63`            | `live: '/live'`, `ready: '/ready'` (and `health: '/health'` at `interfaces/index.ts:63`). Literals, because §2.2 forbids `metrics-plugin` importing `health-plugin`.                                                                            |
| `IRequest.path`                    | `packages/common/src/http.ts:39`                                      | `readonly path: string` — exists, so the exclusion test in §3.11 needs no contract change.                                                                                                                                                      |
| Generated Dockerfile               | `packages/cli/src/workspace/compose.ts:145`                           | `RUN chown -R ${DENO_UID}:${DENO_UID} /srv /deno-dir` on its own line, immediately after `RUN deno cache main.ts` (`:143`).                                                                                                                     |
| Generated Deployment               | `packages/cli/src/workspace/k8s.ts:140`                               | `terminationGracePeriodSeconds: 30` and **no `lifecycle:` key anywhere in the file**.                                                                                                                                                           |
| Generated pod template metadata    | `.../k8s.ts:133-138`                                                  | Carries `labels:` only — no `annotations:` key, confirming `grep -c 'prometheus.io'` → 0.                                                                                                                                                       |
| Chart `preStop`                    | `k8s/chart/templates/deployment.yaml:105-110`                         | `lifecycle.preStop.sleep.seconds: {{ .Values.preStopSleepSeconds }}` with the kube-proxy comment §3.8 mirrors.                                                                                                                                  |
| `healthProbes` gate                | `.../k8s.ts:65,78,230`; `manifest.ts:133-134`; `commands/app.ts:462`  | An existing per-member manifest boolean, set from `typeof args.flags['template'] === 'string'`, whose JSDoc states ABSENT means "unknown, fall back to the safe option". §3.10 copies this pattern exactly.                                     |
| `REST_PLUGINS`                     | `packages/cli/src/templates/rest.ts:50`                               | Includes `{ pkg: 'metrics-plugin', symbol: 'MetricsPlugin' }`, and microservice/class-based extend it — so every templated member serves `/metrics` and every template-less one does not.                                                       |
| Workers entry template             | `packages/cli/src/templates/project-files.ts:651,671-672`             | `const bootedInit = 'booted ??= boot(env);'`, emitted into both `fetch` and every worker export. Its own comment at `:639` already **states** "Either failure is permanent, because `booted` memoises the rejection" — documented, never fixed. |
| CI RabbitMQ service                | `.github/workflows/ci.yml:58`                                         | `image: rabbitmq:3.13-management-alpine` — **the version on which X10-1 is invisible**. §3.1's gate requires moving this to 4.                                                                                                                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                     | Resolution (picked side)                                                                                                                                             | Doc deliverable (same PR)                                                                                                                                                                                    |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `cloudflare-plugin/README.md:368` tells the reader to register `SchedulerPlugin` on Workers; the same README (and `WorkersCron`'s module doc) explains that timers cannot fire there. One document says both.                                | The README is wrong. `SchedulerPlugin` must not be registered on Workers, and §3.5 makes it refuse at `register()` rather than leaving the contradiction to be read. | Rewrite the "Distributed lock" section to show the lock handed to a scheduler on a **Node/Deno replica set** — the composition it is actually for — and state that Workers use `WorkersCron`.                |
| C2 | `cloudflare-plugin/README.md:412` promises a trigger firing with nothing registered "is logged every time"; `README.md:131` constructs `new WorkersCron()` with no logger, for which it is logged **never**.                                 | The behaviour claim stays true only if the example supplies a sink. Fix the example, and make the failure observable even without one (§3.6).                        | Pass `{ logger }` in the README's Queues/Cron example; amend the "Behaviour worth knowing" bullet to say reporting requires a configured logger, and that a failing handler fails the invocation regardless. |
| C3 | `DistributedLockOptions`' JSDoc promises "multi-instance safety" and `scheduler-service.ts:326`'s comment asserts "Another instance holds the lock — it is running this fire", while the released lock deduplicates nothing across replicas. | The promise is the intended behaviour; §3.2 makes the code meet it rather than lowering the doc.                                                                     | Rewrite both JSDoc blocks to name the two distinct guarantees (per-fire dedup, per-handler overlap mutex) and state that `ttlMs` bounds the replica-skew window.                                             |
| C4 | `k8s/README.md`'s explicit "what this does NOT include, deliberately" list omits metrics scraping, while the generated manifests omit the annotations — so silence reads as an oversight rather than a decision.                             | It **was** an oversight; §3.10 emits the annotations.                                                                                                                | Add a line to the generated `k8s/README.md` naming the annotations and the member port they carry.                                                                                                           |
| C5 | `MemoryLock`'s module doc claims "a fire that overlaps a still-running previous fire of the same job is skipped" — a property §3.2 must not break while adding slot dedup.                                                                   | Preserve it. This is the reason §3.2 keeps **two** locks rather than replacing one with the other.                                                                   | No correction needed; the doc becomes true of the handler mutex specifically, and its JSDoc gains that word.                                                                                                 |

## 3. Design decisions

### 3.1 X10-1 — the RabbitMQ queue declaration carries the intent the broker already computed

- **Decision:** `#consumeOn` takes the subscription's shape and declares accordingly: a
  caller-supplied queue name (a consumer group) becomes `{ durable: true }`; an absent queue name
  (the private per-subscriber queue the broker mints) becomes
  `{ exclusive: true, autoDelete: true }`. **The generated Compose file keeps
  `rabbitmq:4-management`** — the image pin is the register's own last-resort option and it puts the
  project on the wrong side of a deprecation slated for removal.
- **Why:** both resulting shapes are permitted by RabbitMQ 4, and neither is a guess about intent:
  `subscribe` already computes `isExclusive` and already deletes the queue on unsubscribe when it is
  set. The declaration was simply never told. A durable named queue is also what a consumer group
  wants — it survives a broker restart, which is the semantics `queue` documents.
- **Test home:** `test/unit/rabbitmq-broker-queue-declaration.test.ts` (both shapes asserted on a
  recording fake) and `test/integration/rabbitmq-v4-declaration.test.ts` (real RabbitMQ 4).

### 3.2 X10-2 — two locks, because dedup and overlap are different questions

- **Decision:** `#fire` acquires a **slot lock** `scheduler:job:<name>:<slot>`, which is **never
  released** and expires on `ttlMs`; only if that succeeds does it acquire the existing **handler
  mutex** `scheduler:job:<name>`, released in `finally` exactly as today. The slot is
  `entry.nextRunAtMs` for `cron` and `every` entries, and the literal `once` for `delay` entries.
- **Why:** the register's fix 1 (slot lock, no release) deduplicates across replicas but silently
  **loses** the overlap protection `MemoryLock`'s own module doc promises, because slot N+1 is a
  different key from slot N and so cannot see a still-running slot N. Its fix 2 — keep both — is the
  only one that leaves every currently-documented property true. Keying on the _intended_ fire time
  rather than `runtime.now()` makes the slot immune to timer jitter: `#armTimer` uses
  `Math.max(0, nextRunAtMs - now)`, so a fire lands at or after its intended instant and a late
  timer still computes the slot it was armed for.
- **Test home:** `test/unit/scheduler-slot-lock.test.ts` — two `SchedulerService` instances over
  **one shared** `MemoryLock`, armed at deliberately offset times, asserting one handler run per
  slot; plus an overlap test asserting the second fire of a slow job is still skipped.

### 3.3 X10-2 — `every` arms on an absolute grid so replicas can agree on a slot

- **Decision:** `every` computes `nextRunAtMs = (Math.floor(now / intervalMs) + 1) * intervalMs` at
  registration, at re-arm, and at resume — replacing `now + intervalMs` at all three sites. Cron and
  delay arming are unchanged.
- **Why:** without this, §3.2 does not work and shipping it would be an overclaim. Two replicas
  started 0.7 s apart with a 3 s interval produce `nextRunAtMs` values 0.7 s apart forever, so slot
  keys derived from them never collide and both replicas run every tick — the exact defect, unfixed,
  behind a mechanism that looks like a fix. Quantising only the key rather than the arming leaves a
  boundary straddle proportional to skew ÷ interval (≈ 23 % for the measured 0.7 s / 3 s), which is
  a 77 % reduction reported as a fix. Grid alignment preserves the **period** exactly and changes
  only the **phase**, and it additionally makes `every` deterministic across restarts.
- **Test home:** `test/unit/scheduler-every-grid.test.ts` — asserts the first fire lands on an epoch
  multiple of the interval and that two services registered at different instants compute
  **identical** `nextRunAtMs`.

### 3.4 X10-2 — `MemoryLock` sweeps expired keys

- **Decision:** `acquire` sweeps every expired entry before its own lookup, not just the key being
  acquired.
- **Why:** slot keys are never released and never reacquired, so the existing lazy per-key delete
  can never reclaim them: the default single-process configuration would grow one map entry per job
  per fire, forever. The map is bounded by (jobs × ttlMs ÷ interval), so a full sweep is cheap and
  there is no cleverer structure worth its complexity. Left unfixed this is a memory leak that every
  gate passes.
- **Test home:** `test/unit/memory-lock-sweep.test.ts` — acquires N distinct slot keys across a
  simulated clock and asserts the held-key count stays bounded rather than growing with N.

### 3.5 X9-2 — `SchedulerPlugin` refuses to register on Workers

- **Decision:** `register()` throws a new exported `SchedulerUnavailableError` when
  `ctx.runtime.platform() === 'cloudflare-workers'`, naming `WorkersCron` and `[triggers] crons` as
  the replacement. The check runs first, before the lock is resolved or connected.
- **Why:** the plugin's entire surface is inert there — `every` and `delay` arm timers on an isolate
  that is evicted between invocations — so registering it can only produce a job that never runs and
  reports nothing. `cloud-gate.ts` is the committed precedent for exactly this refusal, and M59 made
  it viable by fixing `detectRuntime()`, which until then answered `'node'` on real workerd and
  would have made this check silently dead. Refusing at startup is also what M52b decided when it
  declined to register `CAPABILITIES.SCHEDULER` on Workers at all.
- **Test home:** `test/unit/scheduler-workers-refusal.test.ts` — a fake runtime reporting
  `'cloudflare-workers'`, asserting the throw names both replacements, plus a control on `'deno'`.

### 3.6 X9-5 — a failed cron handler fails the invocation

- **Decision:** `dispatch` runs every handler to settlement (as today), then **throws** an
  `AggregateError` if any rejected, and throws when the firing expression has no registered handler.
  `logger` stays optional and the existing report sites are unchanged.
- **Why:** the register's preferred fix — defaulting the sink to `console` — is **not available**:
  `no-console` binds every package outside `cli` and `scripts`, and a repo-wide grep confirms no
  plugin source contains a real `console.` call (the six matches are all inside `@example` blocks).
  Declining it is therefore a rule, not a preference. The platform's own reporting is the sink that
  needs no configuration: `WorkersCron`'s own JSDoc already records that "the platform's only
  response to a thrown `scheduled` is to count the whole invocation as failed", and
  `createScheduledHandler` is a bare delegation, so a rejecting `dispatch` reaches Cloudflare
  unaltered. Settling first preserves the stated rationale for swallowing — one failing handler must
  not abandon the others — while removing the silence. This is a **breaking** change to a method
  that currently never rejects.
- **Test home:** `test/unit/workers-cron-reporting.test.ts` — a throwing handler among healthy ones:
  all run, then `dispatch` rejects; an unregistered expression rejects; a logger, when supplied,
  still receives both reports.

### 3.7 X9-8 — only a successful boot is memoised, and no stack reaches the client

- **Decision:** the generated Workers entry assigns `booted` to a promise that **clears itself on
  rejection**, so the next request retries; and `fetch` wraps the boot in a `try`/`catch` that
  returns a `503` with a generic body while reporting the real error through `console.error`.
- **Why:** `??=` memoises the rejection, so one transient failure is permanent for the isolate's
  life — the template's own comment states this and treats it as acceptable because the two failures
  it had in mind are permanent anyway; a mistyped binding is not the only way boot fails.
  `console.error` is legal here and only here: this is emitted **CLI output**, not plugin source,
  and `no-console` exempts `packages/cli`. Returning the stack is a disclosure defect of the same
  family M70f closed for the kernel's fallback 500.
- **Test home:** `packages/cli/test/unit/workers-entry-boot.test.ts` asserts the emitted source
  shape; `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` drives a real Workers scaffold whose boot
  fails, asserting a `503` whose body carries no `node_modules` path and that a second request
  re-attempts boot.

### 3.8 X10-4 — the generated Deployment carries the chart's `preStop` sleep

- **Decision:** emit `lifecycle.preStop.sleep.seconds: 5` on the container, with the chart's own
  kube-proxy comment, and a note that `preStop.sleep` requires Kubernetes 1.30+.
- **Why:** the repository's chart ships it and `docs/deployment.md` names it as step 2 of graceful
  shutdown, so the generated manifest omitting it is drift between two committed artifacts, not a
  difference of opinion. The register moved the symptom both ways on that field alone across three
  runs (7 → 0 → 10 failures over ~28k requests).
- **Test home:** `packages/cli/test/unit/k8s-manifest.test.ts` — asserts the block is present with
  the sleep value and the comment.

### 3.9 X10-5 — the `chown` folds into the layer that creates the files

- **Decision:** `RUN deno cache main.ts && chown -R ${DENO_UID}:${DENO_UID} /srv /deno-dir`, one
  layer. The comment explaining why the UID is numeric stays exactly as written.
- **Why:** `chown -R` rewrites metadata on every file, so overlayfs copies up the entire module
  cache into a second layer — measured at 563 MB versus 362 MB with the fold, ~600 MB across the
  register's three-member workspace, paid on every push and every node pull. The register's
  alternative (`COPY --chown` plus caching as the unprivileged user) also works but changes who owns
  `/deno-dir` in the base image; the fold is the change that was actually measured.
- **Test home:** `packages/cli/test/unit/dockerfile.test.ts` — asserts a single `RUN` carries both
  commands and that no standalone `chown` line remains.

### 3.10 X10-6 — Prometheus annotations, gated on a manifest field of their own

- **Decision:** the pod template gains `prometheus.io/scrape: "true"`,
  `prometheus.io/port:
  "<member port>"` and `prometheus.io/path: "/metrics"` when a new
  `WorkspaceMember.metricsEndpoint` is `true`. The field is recorded by `generate app` from whether
  a template was chosen, and **ABSENT means "unknown"** — annotations are omitted, exactly as
  `healthProbes` falls back to a TCP probe.
- **Why:** a member's plugin set is knowable only at `generate app` time and the renderer has only
  the manifest, which is why `healthProbes` exists; this is the same question about a different
  capability. It gets its **own** field rather than reusing `healthProbes` because the two can
  diverge — a future template could serve health without metrics — and a boolean whose name says one
  thing while being read for another is how these drift. Annotating a member that serves no
  `/metrics` would make Prometheus report a permanently-down target, which is worse than not
  discovering it.
- **Test home:** `packages/cli/test/unit/k8s-manifest.test.ts` — annotations present for a templated
  member, absent for a template-less one and for a member whose manifest predates the field.

### 3.11 X10-7 — the metrics middleware skips its own scrape and the health probes

- **Decision:** `HttpCollector` takes an exclusion set and returns from `middleware` **before**
  touching any instrument when `ctx.request.path` matches. The default set is the plugin's own
  configured `endpoint` plus the literals `/health`, `/live` and `/ready`; a new
  `MetricsPluginOptions.excludePaths?: readonly string[]` **replaces** the health literals when
  supplied, leaving the plugin's own endpoint always excluded. The label set stays `method` +
  `status`, unchanged.
- **Why:** the plugin already knows its own endpoint (`interfaces/index.ts:73`), so excluding it
  needs no configuration at all. The health paths must be literals because §2.2 forbids
  `metrics-plugin` importing `health-plugin`; `excludePaths` is the escape hatch for an application
  that moved them. Exclusion happens before the gauge so an excluded request never perturbs
  `http_active_requests`. The register's third option — a low-cardinality `route` label — is
  **declined here** and named in §9: it needs the matched route pattern, which the middleware does
  not receive, and it changes every existing series' identity.
- **Test home:** `test/unit/http-collector-exclusions.test.ts` — a scrape of the configured endpoint
  and a `/ready` probe leave every instrument untouched; an application path still records;
  `excludePaths` replaces the defaults; and an integration test drives a real kernel app with
  `MetricsPlugin` + `HealthPlugin` asserting `http_requests_total` is unchanged across a probe and a
  scrape.

## 4. Exported surface — every symbol names its consumer

Only two packages change their barrel. `messaging-plugin`, `cli` and `cloudflare-plugin` export
nothing new — their changes are internal or behavioural — which a barrel-exports test pins.

| Exported symbol                     | Kind                            | Consumer / real code path that READS it                                                                                                                        |
| ----------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SchedulerUnavailableError`         | class (`scheduler-plugin`)      | Thrown by `SchedulerPlugin.register()` (§3.5); an application `catch`es it by identity, and `packages/cloudflare-plugin/README.md` names it in the C1 rewrite. |
| `MetricsPluginOptions.excludePaths` | option field (`metrics-plugin`) | Read by `MetricsPlugin` and passed to `HttpCollector`'s constructor (§3.11); consumed on every request in `middleware`.                                        |

### 4.1 Options — every option names its consumer

| Option                                                 | Consumer                                     | Behavior (per implementation)                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MetricsPluginOptions.excludePaths`                    | `HttpCollector.middleware`                   | When present, replaces the default `/health`, `/live`, `/ready` set. The plugin's own `endpoint` is excluded regardless, so an application cannot accidentally make `/metrics` count its own scrapes. Absent ⇒ the three health literals.                                                                                                                                   |
| `DistributedLockOptions.ttlMs` (existing, re-purposed) | `SchedulerService.#fire`                     | Now bounds **two** things: the handler mutex, as today, and how long a claimed fire slot is remembered. Documented as the replica-skew window; a value below the maximum skew between replicas lets a late replica re-run a slot. No new option — one number already governs "how long a lock lives" and splitting it would make two knobs whose right values are the same. |
| `WorkspaceMember.metricsEndpoint`                      | `packages/cli/src/workspace/k8s.ts` renderer | `true` ⇒ emit the three `prometheus.io/*` annotations with the member's own port. `false` or absent ⇒ emit none.                                                                                                                                                                                                                                                            |

## 5. Implementation files

| File                                                          | Purpose                                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts`    | §3.1 — pass the subscription shape into `#consumeOn`; declare durable or exclusive accordingly.     |
| `packages/messaging-plugin/src/brokers/inbox.ts`              | §3.1 — the reply inbox declares itself transient so a per-instance reply queue is not made durable. |
| `packages/scheduler-plugin/src/services/scheduler-service.ts` | §3.2, §3.3 — slot lock plus handler mutex; grid-aligned `every` arming at all three sites.          |
| `packages/scheduler-plugin/src/lock/memory-lock.ts`           | §3.4 — sweep expired keys on acquire.                                                               |
| `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts`    | §3.5 — refuse on Cloudflare Workers.                                                                |
| `packages/scheduler-plugin/src/errors.ts`                     | §3.5 — new `SchedulerUnavailableError`.                                                             |
| `packages/scheduler-plugin/src/index.ts`                      | §3.5 — export the error.                                                                            |
| `packages/scheduler-plugin/src/interfaces/index.ts`           | C3 — JSDoc for the two lock guarantees and the skew window.                                         |
| `packages/cloudflare-plugin/src/cron/workers-cron.ts`         | §3.6 — settle every handler, then throw.                                                            |
| `packages/metrics-plugin/src/collectors/http-collector.ts`    | §3.11 — exclusion guard ahead of every instrument.                                                  |
| `packages/metrics-plugin/src/plugin/metrics-plugin.ts`        | §3.11 — resolve the exclusion set and pass it in.                                                   |
| `packages/metrics-plugin/src/interfaces/index.ts`             | §3.11 — `excludePaths`.                                                                             |
| `packages/cli/src/workspace/compose.ts`                       | §3.9 — fold the `chown`.                                                                            |
| `packages/cli/src/workspace/k8s.ts`                           | §3.8, §3.10 — `preStop` block; Prometheus annotations.                                              |
| `packages/cli/src/workspace/manifest.ts`                      | §3.10 — `metricsEndpoint` field and its parse.                                                      |
| `packages/cli/src/commands/app.ts`                            | §3.10 — record `metricsEndpoint` at `generate app`.                                                 |
| `packages/cli/src/templates/project-files.ts`                 | §3.7 — boot retry and contained error response.                                                     |
| `.github/workflows/ci.yml`                                    | §3.1 gate — RabbitMQ service image to 4.                                                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                              | src covered                                | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messaging-plugin/test/unit/rabbitmq-broker-queue-declaration.test.ts` | `rabbitmq-broker.ts`, `inbox.ts`           | A recording fake channel captures `assertQueue` options: `subscribe(topic, h, { queue: 'g' })` ⇒ `{ durable: true }`; `subscribe(topic, h)` ⇒ `{ exclusive: true, autoDelete: true }`; the RPC inbox opened by `request()` ⇒ transient, never durable. Calls type-check against `IMessageBroker.subscribe(topic, handler, options?: SubscribeOptions)`. |
| `messaging-plugin/test/integration/rabbitmq-v4-declaration.test.ts`    | `rabbitmq-broker.ts`                       | **Guarded on `RABBITMQ_URL`**, against real RabbitMQ **4**: a group subscriber and a private subscriber both receive a published message, and an RPC round trip completes. This is the test that fails on the current code with the register's `541 INTERNAL-ERROR`.                                                                                    |
| `scheduler-plugin/test/unit/scheduler-slot-lock.test.ts`               | `scheduler-service.ts`                     | Two services over one `MemoryLock`, fires offset within a slot ⇒ exactly one handler run; offset across slots ⇒ one run each. A slow handler's second fire is skipped (overlap mutex intact).                                                                                                                                                           |
| `scheduler-plugin/test/unit/scheduler-every-grid.test.ts`              | `scheduler-service.ts`                     | `every('j', 3000)` registered at t=1000 ⇒ `nextRunAtMs === 3000`; two services registered 700 ms apart compute identical `nextRunAtMs`; re-arm and resume land on the grid. Types against `IScheduler.every(name, ms, handler, data?)`.                                                                                                                 |
| `scheduler-plugin/test/unit/memory-lock-sweep.test.ts`                 | `memory-lock.ts`                           | 100 distinct slot keys across an advancing fake clock leave a bounded held-key count; an unexpired key is still refused.                                                                                                                                                                                                                                |
| `scheduler-plugin/test/unit/scheduler-workers-refusal.test.ts`         | `scheduler-plugin.ts`, `errors.ts`         | `register()` with `platform() === 'cloudflare-workers'` rejects with `SchedulerUnavailableError` naming `WorkersCron` and `[triggers] crons`; a `'deno'` control registers normally; the refusal happens before any lock connect.                                                                                                                       |
| `cloudflare-plugin/test/unit/workers-cron-reporting.test.ts`           | `workers-cron.ts`                          | Three handlers, one throwing ⇒ all three ran **and** `dispatch` rejects with an `AggregateError`; unregistered expression rejects; with a logger both report sites still fire. Types against `dispatch(controller: IScheduledController): Promise<void>`.                                                                                               |
| `metrics-plugin/test/unit/http-collector-exclusions.test.ts`           | `http-collector.ts`                        | A request to the configured endpoint and to `/ready` leave counter, histogram and gauge untouched; `/orders` records; `excludePaths: ['/custom']` replaces the health defaults while the endpoint stays excluded.                                                                                                                                       |
| `metrics-plugin/test/integration/metrics-excludes-probes.test.ts`      | `http-collector.ts`, `metrics-plugin.ts`   | A real `createApplication` with `MetricsPlugin` + `HealthPlugin`: scrape `/metrics`, hit `/live` and `/ready`, scrape again — `http_requests_total` is byte-identical between scrapes; one application request moves it by exactly one.                                                                                                                 |
| `cli/test/unit/dockerfile.test.ts`                                     | `compose.ts`                               | One `RUN` carries `deno cache main.ts && chown -R`; no standalone `chown` line; the numeric-UID comment survives.                                                                                                                                                                                                                                       |
| `cli/test/unit/k8s-manifest.test.ts`                                   | `k8s.ts`, `manifest.ts`                    | `lifecycle.preStop.sleep.seconds: 5` present with its comment; annotations present for `metricsEndpoint: true`, absent for `false` and for a member record omitting the field.                                                                                                                                                                          |
| `cli/test/unit/workers-entry-boot.test.ts`                             | `project-files.ts`                         | The emitted entry does not contain `booted ??=`; it clears `booted` on rejection and returns a `503` rather than rethrowing.                                                                                                                                                                                                                            |
| `cli/test/e2e/scaffold-runs-e2e.test.ts` (extended)                    | `project-files.ts`, `k8s.ts`, `compose.ts` | A scaffolded Workers project whose boot fails answers `503` with no `node_modules` path in the body, and a second request re-attempts boot. Generated manifests still `kubectl apply --dry-run=client` cleanly.                                                                                                                                         |
| `test/apps-gate.test.ts` (extended)                                    | —                                          | Pins the CI RabbitMQ service image at major version **4**, so §3.1's gate cannot be silently reverted to a version where the defect is invisible.                                                                                                                                                                                                       |

**External-dep coverage.** The RabbitMQ integration suite is the guarded real-import path for §3.1;
the branching around it (which options object is built) is unit-tested through the recording fake,
per the standing rule.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70l-deployment-operations, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Plus, because this milestone changes what `packages/cli` generates and touches published packages:

```bash
deno task publish:check                  # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.8
```

And the real-backend run, which is the only place §3.1 is decidable:

```bash
docker run -d --name m70l-rabbit -p 5672:5672 rabbitmq:4-management-alpine
RABBITMQ_URL=amqp://localhost:5672 deno task test
```

### Negative controls (each must be observed failing, then reverted)

1. Restore `{ durable: false }` in `#consumeOn` ⇒ the RabbitMQ 4 integration suite fails with
   `541 INTERNAL-ERROR … transient_nonexcl_queues`.
2. Revert §3.3's grid alignment while keeping §3.2's slot key ⇒ `scheduler-slot-lock.test.ts`
   reports two runs per slot. **This is the control that matters most**: it is the difference
   between a fix and a mechanism that looks like one.
3. Remove the §3.4 sweep ⇒ `memory-lock-sweep.test.ts` shows the held-key count growing with N.
4. Drop the `preStop` block ⇒ `k8s-manifest.test.ts` fails.
5. Restore `booted ??=` ⇒ the e2e's second request replays the first failure.
6. Point CI's RabbitMQ service back at `3.13` ⇒ `test/apps-gate.test.ts` fails, and the §3.1
   integration suite passes vacuously — demonstrating that the image bump is load-bearing.

## 8. Risks & mitigations

- **`exclusive: true` binds a queue to its connection, and the M70c reconnect supervisor replaces
  the connection.** Mitigation: the supervisor's replay path already re-enters `#consumeOn`, which
  re-asserts the queue on the new channel; the integration suite includes a broker restart so the
  replay is exercised against a real server rather than reasoned about.
- **Grid-aligning `every` changes the phase of the first fire** — it happens sooner than
  `intervalMs` after registration (within `(0, intervalMs]`). A job assuming "I have been up a full
  interval" behaves differently. Mitigation: CHANGELOG entry with migration text; the period is
  unchanged and the fire is never later, only earlier.
- **Bumping CI to RabbitMQ 4 could break M70c's outage and reconnect suites** for reasons unrelated
  to this milestone. Mitigation: run the full messaging suite against a local RabbitMQ 4 container
  before touching the workflow, and treat any failure as in scope for this branch.
- **A throwing `dispatch` marks the whole Cloudflare invocation failed**, which for a cron with an
  intentionally-optional handler is noisier than today. Mitigation: it is exactly the signal the
  register asks for, it is documented as breaking, and an application that wants the old behaviour
  wraps its own handler in a `try`.
- **`excludePaths` replacing rather than extending the defaults** can silently re-admit `/live` if a
  reader assumes it extends. Mitigation: the option's JSDoc says "replaces", and a test asserts the
  replacement semantics explicitly.
- **The register's measurements come from a kind cluster this branch cannot reproduce in CI.**
  Mitigation: X10-4/5/6 are asserted at the level the repository can gate — the emitted text — and
  the plan does not claim a cluster re-measurement it did not perform.

## 9. Out of scope

- **A low-cardinality `route` label on the HTTP series** (X10-7 fix 3) — needs the matched route
  pattern, which `HttpCollector.middleware` is not given, and changes the identity of every existing
  series. A contract question for a metrics milestone, not a defect fix.
- **X9-1 (`cf.waitUntil()` dropping background tasks)** — a Workers row in this exercise but not in
  M70l's assignment; currently **unowned**, and named here so it is not assumed absorbed.
- **X10-3** — closed by M70c; verified, not re-fixed.
- **The repository's own chart gaining Prometheus annotations** — `k8s/chart` also has none, but the
  register scopes X10-6 to CLI-generated output and M39 owns the chart. Named so a reviewer does not
  read the asymmetry as an oversight.
- **A cluster-level e2e for the scheduler** — proving replica dedup against a real Deployment needs
  a kind cluster in CI, which `check:deploy --cluster` gates locally only. §3.2's two-service
  shared-lock test is the reachable equivalent and its limitation is stated rather than implied.
- **`v0.1.0-alpha.9` itself** — the release follows `docs/releasing.md` after every M70 workstream
  merges, and is not part of this branch.
