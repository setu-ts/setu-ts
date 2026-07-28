# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-alpha.2] — unreleased

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
