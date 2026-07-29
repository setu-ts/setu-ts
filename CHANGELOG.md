# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

**Closes three of the known limitations recorded against `0.1.0-alpha.1`.** Each was a real
capability gap rather than a documentation problem, so each is fixed in code and its entry removed
from that release's list rather than reworded.

### Added

- **`@hono-enterprise/realtime-backplane-plugin`** — cross-replica fan-out for WebSocket rooms and
  SSE channels, bringing the published total to **37 packages**. It registers an
  `IRealtimeBackplane` under the new `CAPABILITIES.REALTIME_BACKPLANE` token, which
  `websocket-plugin` and `sse-plugin` resolve **optionally** — so adding the plugin is the entire
  change needed to make `ws.room('lobby')` and `sse.channel('news')` reach clients on other
  replicas, and removing it restores in-process behavior with no application change. Four
  transports: `'memory'` (the default, and a real single-process bus rather than a no-op),
  `'messaging'` (over whatever broker is registered under `CAPABILITIES.MESSAGING`, reusing all five
  existing brokers with no new dependency), `'redis'` (pub/sub over an inject-or-lazy `ioredis`),
  and `'custom'`.
- **A LaunchDarkly provider** for `@hono-enterprise/feature-flags-plugin`
  (`provider: 'launchdarkly'`), plus an optional `IFeatureFlags.isEnabledAsync` for callers that can
  await an answer carrying no cold-context caveat.
- **Real cancellation** in `@hono-enterprise/resilience-plugin`: `wrap` hands the protected call an
  `AbortSignal`, and the returned callable accepts an optional caller-owned one.

### Changed

- **`IResilienceService.wrap` and `ICircuitBreaker.execute` widened.** `wrap<T>` now takes a
  `ResilientCall<T>` (`(signal: AbortSignal) => Promise<T>`) and returns a `HardenedCall<T>`
  (`(signal?: AbortSignal) => Promise<T>`). **Source-compatible for callers** — a zero-argument
  `() => Promise<T>` is still accepted and `await guarded()` still works — but **breaking for
  implementors**, because `fn` sits in a contravariant position, so an object literal declaring
  `wrap<T>(fn: () => Promise<T>)` no longer satisfies the interface. Implementors add the parameter.
- **`websocket-plugin` and `sse-plugin` `register()` are now async**, awaiting the optional
  backplane subscription. The kernel already awaited an async `register`, so applications are
  unaffected; a test calling `plugin.register(ctx)` directly must now await it.

### Fixed

- **Resilience timeouts cancel the work they bound.** `timeout` raced the protected call against a
  timer and left it running; it now aborts the call's signal with the same `TimeoutError` instance
  it rejects with, so a call that forwards the signal to its I/O genuinely stops. Retry stops
  looping on abort and wakes its backoff early — that sleep also no longer leaks a timer handle on
  every attempt — and a bulkhead waiter cancelled while queued leaves the queue and never runs its
  call.

### Notes

Two real-time limitations are structural and remain, documented rather than silently approximated:
`Room.size` / `SseChannel.size` report **local** membership, and `RoomBroadcastOptions.except` is
honored only on the originating replica, because it names a live in-process connection with no
cross-process identity. Cluster-wide presence is a later milestone.

A call that ignores its `AbortSignal` still runs to completion; cancellation is cooperative, and the
widened JSDoc says so.

## [0.1.0-alpha.2] — 2026-07-28

**Adds the CLI.** `@hono-enterprise/cli` publishes for the first time, bringing the total to **36
packages**. Every other package is version-bumped so the scope stays on one version — the CLI needs
this, because `honoe new` stamps generated projects with its OWN version as the range for `kernel`,
`runtime`, `common`, and every template plugin. A CLI at `alpha.2` alongside a framework at
`alpha.1` would scaffold projects pinning versions that do not exist.

### Added

- **`@hono-enterprise/cli`** — the `honoe` command: project scaffolding (`honoe new`, with
  `--template rest|microservice` and `--runtime deno|node|bun|cloudflare-workers`), 13 plugin-aware
  code-generation schematics, custom schematics, and dispatch of plugin-registered commands
  (`honoe commands`, `honoe db:migrate`).

### Fixed

- **Package READMEs linked `PUBLIC_API.md` relatively** (`../../PUBLIC_API.md`). JSR resolves a
  README's relative links against `jsr.io/@hono-enterprise/`, so every such link 400'd with
  _"package name must contain only lowercase ascii alphanumeric characters and hyphens"_. All 44
  relative links across 28 package READMEs now use absolute GitHub URLs.
- **`ICliApi`'s JSDoc** described a contract with no consumer; the CLI now reads it.

All 36 packages are live on JSR at `0.1.0-alpha.2`.

Verified after publishing by installing `honoe` from JSR into a clean directory — not the workspace,
whose import map resolves locally — scaffolding a `rest` project with it, generating a controller,
type-checking the result against the published packages, then starting it and serving `/` (`200`),
`/health` (`status: up`), and `/metrics`.

### The release pipeline, which had never worked

This was the first release published by CI. `0.1.0-alpha.1` went out by hand from a terminal,
because the tag-triggered workflow failed on every attempt. Three separate causes, each only visible
by running it:

1. **The publish step lacked `--allow-env`.** `publish-packages.ts` reads `JSR_TOKEN` at startup
   (left unset in CI so the runner's OIDC identity authenticates instead) and died before touching a
   package. The root cause was duplication: `deno.json`'s `release:publish` task always carried the
   right permissions, but the workflow inlined its own `deno run` and that copy drifted. The
   workflow now calls the task.
2. **It also lacked `--allow-net`.** The already-published check that makes a resumed release
   idempotent fetches jsr.io — and it is skipped under `--dry-run`, so a passing dry run proves
   nothing about a real run.
3. **No package was linked to the GitHub repository.** JSR accepts a GitHub Actions OIDC identity
   only for a package it knows belongs to the repo; without the link, `deno publish` uploads and
   then fails with `actorNotAuthorized`. Token-based publishing does not need the link, which is why
   `0.1.0-alpha.1` never surfaced it. `deno task release:link-repos` now does all 36 through the
   API.

None of the three published anything, so the tag stayed re-runnable throughout.

### Installing

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.2
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.2/main
```

Within 24 hours of a release, Deno's minimum-dependency-age policy refuses the version unless you
pass `--min-dep-age 0`.

## [0.1.0-alpha.1] — 2026-07-26

**First public prerelease.** The framework's kernel, runtime layer, and 30 plugins are implemented
and tested; they publish to [JSR](https://jsr.io) under the `@hono-enterprise` scope.

This is an **alpha**. The public API is not frozen, and breaking changes may land in any subsequent
prerelease without a major-version bump. Do not use it in production.

All 35 packages are live on JSR at `0.1.0-alpha.1`.

Verified after publishing by installing `kernel`, `runtime`, `metrics-plugin`, and
`telemetry-plugin` from JSR into a clean project — not the workspace, whose import map resolves
locally — starting an application, serving a request (`200`), and scraping the `/metrics` endpoint.

The release took two attempts. A JSR scope may create only 20 new packages per rolling 7-day window
by default; the first run created 20 and stopped. JSR raised the quota to 40 on request, and the
remaining 15 followed. Both halves carry the same version, and the publish order guarantees `common`
and `kernel` land before anything that depends on them, so the intermediate state was never
inconsistent.

### Installing a prerelease

JSR does not tag a prerelease as `latest`, so **every specifier must be version-pinned**:

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.1
```

A bare `deno add jsr:@hono-enterprise/kernel` fails with _"has only pre-release versions
available"_. Within 24 hours of a release, Deno's minimum-dependency-age policy additionally refuses
the version unless you pass `--min-dep-age 0`.

### All packages in this release

35 packages, all at `0.1.0-alpha.1`:

**Core** — `common`, `kernel`, `runtime`, `exceptions`, `testing`

**Request path** — `logger-plugin`, `config-plugin`, `validation-plugin`, `http-security-plugin`,
`auth-plugin`

**Data** — `database-plugin`, `cache-plugin`, `storage-plugin`, `multi-tenancy-plugin`

**Messaging & work** — `events-plugin`, `cqrs-plugin`, `messaging-plugin`, `queue-plugin`,
`scheduler-plugin`, `worker-pool-plugin`

**Real-time** — `sse-plugin`, `websocket-plugin`, `react-router-plugin`

**Operations** — `metrics-plugin`, `health-plugin`, `telemetry-plugin`, `audit-plugin`,
`resilience-plugin`, `secrets-plugin`

**Delivery** — `mail-plugin`, `notification-plugin`, `feature-flags-plugin`

**Optional ergonomics** — `di-plugin`, `decorator-plugin`, `openapi-plugin`

### Deliberately excluded

`@hono-enterprise/cli`, `@hono-enterprise/sdk`, and the three starter bundles (`rest-starter`,
`microservice-starter`, `full-stack-starter`) are **not part of this release**. They are stubs that
export nothing; publishing them would put empty pages on JSR, where versions are immutable. They
ship when their milestones land (the CLI is Milestone 34).

### Runtime support

Node.js, Deno, Bun, and Cloudflare Workers, via Hono's `fetch` entry point and the runtime's HTTP
adapters. Individual plugins document their own constraints — SMTP needs raw sockets, worker pools
need real threads, and neither exists on Workers.

Optional heavy dependencies (Prisma, ioredis, amqplib, kafkajs, nodemailer, the OTel SDK, `ws`, …)
are never hard dependencies. Each is injected through plugin options or imported lazily via an
`npm:` specifier, so an application only pays for what it configures.

### Known limitations

> Three entries from this list — LaunchDarkly support, cross-replica rooms and channels, and
> non-cancelling resilience timeouts — were closed after this release; see **[Unreleased]**.

- **`notification-plugin` FCM push is non-functional.** It implements the legacy FCM `serverKey`
  API, which Google decommissioned in 2024. FCM HTTP v1 with service-account JWT signing is a
  follow-up.
- **`KafkaBroker` does not support request-reply.** Kafka's consumer-group and auto-commit model
  does not fit the pattern; `request()`/`respond()` throw `MessagingNotSupportedError`.
- **Node and Bun compatibility suites have not run.** They consume the packages through JSR's npm
  compatibility layer and were therefore blocked on this publish — they are unblocked by it, and
  will run before the first stable release. Milestone 40 owns that verification, alongside
  benchmarks and the security audit.

### Milestones in this release

Milestones 0–33 and 41–46. See [ROADMAP.md](ROADMAP.md) for scope per milestone and
[PUBLIC_API.md](PUBLIC_API.md) for the full exported surface.

[0.1.0-alpha.1]: https://github.com/dkpaul91/hono-enterprise/releases/tag/v0.1.0-alpha.1
