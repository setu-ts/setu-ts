# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-alpha.1] — 2026-07-26

**First public prerelease.** The framework's kernel, runtime layer, and 30 plugins are implemented
and tested; they publish to [JSR](https://jsr.io) under the `@hono-enterprise` scope.

This is an **alpha**. The public API is not frozen, and breaking changes may land in any subsequent
prerelease without a major-version bump. Do not use it in production.

### This release ships in two phases

A JSR scope may create only **20 new packages per rolling 7-day window**, and this release needs 35.
The first 20 — in dependency order, so the entire core is included — published on 2026-07-26. The
remaining 15 publish at the same `0.1.0-alpha.1` version once the quota clears (a request for an
increase is pending; otherwise the window rolls over around 2026-08-02).

Nothing about the published 20 is provisional: each is complete, and every cross-package dependency
they declare (`common`, `kernel`) is itself published, so they resolve and run today. Verified by
installing `kernel` + `runtime` from JSR into a clean project and serving a request.

**Live now (20):** `common`, `kernel`, `runtime`, `exceptions`, `testing`, `audit-plugin`,
`auth-plugin`, `cache-plugin`, `config-plugin`, `cqrs-plugin`, `database-plugin`,
`decorator-plugin`, `di-plugin`, `events-plugin`, `feature-flags-plugin`, `health-plugin`,
`http-security-plugin`, `logger-plugin`, `mail-plugin`, `messaging-plugin`

**Pending the quota (15):** `metrics-plugin`, `multi-tenancy-plugin`, `notification-plugin`,
`openapi-plugin`, `queue-plugin`, `react-router-plugin`, `resilience-plugin`, `scheduler-plugin`,
`secrets-plugin`, `sse-plugin`, `storage-plugin`, `telemetry-plugin`, `validation-plugin`,
`websocket-plugin`, `worker-pool-plugin`

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

### Deliberately excluded — not merely pending

Distinct from the 15 above, which are written and waiting on a quota: `@hono-enterprise/cli`,
`@hono-enterprise/sdk`, and the three starter bundles (`rest-starter`, `microservice-starter`,
`full-stack-starter`) are **not part of this release at all**. They are stubs that export nothing;
publishing them would put empty pages on JSR. They ship when their milestones land (CLI is Milestone
34).

### Runtime support

Node.js, Deno, Bun, and Cloudflare Workers, via Hono's `fetch` entry point and the runtime's HTTP
adapters. Individual plugins document their own constraints — SMTP needs raw sockets, worker pools
need real threads, and neither exists on Workers.

Optional heavy dependencies (Prisma, ioredis, amqplib, kafkajs, nodemailer, the OTel SDK, `ws`, …)
are never hard dependencies. Each is injected through plugin options or imported lazily via an
`npm:` specifier, so an application only pays for what it configures.

### Known limitations

- **`notification-plugin` FCM push is non-functional.** It implements the legacy FCM `serverKey`
  API, which Google decommissioned in 2024. FCM HTTP v1 with service-account JWT signing is a
  follow-up.
- **LaunchDarkly is unsupported** in `feature-flags-plugin`. The LaunchDarkly Node server SDK's
  `variation`/`allFlagsState` are async and cannot satisfy the synchronous committed `isEnabled`
  contract. Use the provider's `'custom'` arm as a bridge.
- **`KafkaBroker` does not support request-reply.** Kafka's consumer-group and auto-commit model
  does not fit the pattern; `request()`/`respond()` throw `MessagingNotSupportedError`.
- **Rooms and channels are in-process.** `websocket-plugin` rooms and `sse-plugin` channels are not
  shared across replicas; cross-instance fan-out is a later milestone.
- **`resilience-plugin` timeouts do not cancel.** `timeout` races the promise; the wrapped function
  keeps running.
- **Node and Bun compatibility suites have not run.** They consume the packages through JSR's npm
  compatibility layer and were therefore blocked on this publish — they are unblocked by it, and
  will run before the first stable release. Milestone 40 owns that verification, alongside
  benchmarks and the security audit.

### Milestones in this release

Milestones 0–33 and 41–46. See [ROADMAP.md](ROADMAP.md) for scope per milestone and
[PUBLIC_API.md](PUBLIC_API.md) for the full exported surface.

[0.1.0-alpha.1]: https://github.com/dkpaul91/hono-enterprise/releases/tag/v0.1.0-alpha.1
