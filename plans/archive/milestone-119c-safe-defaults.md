# Milestone 119c — Safe framework, broken default (`@setu-ts/cli` and five plugins)

> **Status:** Planning. Branch: `feat/m119c-safe-defaults`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR into
> `develop`.

## 0. Objective & scope

Each row is a setup the framework handles correctly once configured, but a default, a generated file
or a documented example leaves broken, with the fix a setting nothing points to. Every row is fixed
by changing the default, making the generator or `setu add` write the setting, or making the failure
or the documentation name it.

- **In scope:** V10-17 + V10-41 (full-stack behind a TLS proxy), V10-1 (same-origin form POST under
  `no-referrer`, maintainer decision 2026-10-24), V10-3 (CORS + CSRF README example), V10-36
  (`swagger-ui-dist` range), V10-6 (`setu add telemetry` peers), V10-29 (generated e2e never exits),
  V10-44 (Kubernetes discovery outside a cluster), V10-14 (bearer exemption beats `csrf.exclude`),
  and two generator gaps (`setu add cache` installs no `ioredis`; in a Redis-transport workspace
  `setu add cache|scheduler|realtime-backplane` insert in-memory defaults).
- **NOT this milestone:** the forwarded-identity rows V10-19/V10-28 (M119d, also
  `http-security-plugin`, different middleware); telemetry-plugin's own `@opentelemetry/api` peer
  range, which admits the conflicting `1.10` (optional peers are M119f's subject); a runtime hint
  when React Router rejects an action (the check and its 400 belong to React Router; this milestone
  names the setting in the template and the docs instead); Kafka/RabbitMQ/NATS equivalents of the
  Redis generator gap (no row; the transport spec gains the hooks so they can follow).

## 1. Contracts verified from SOURCE (not names)

| Reference                                | Source (file:line)                                                                                                       | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full-stack template composition          | `packages/cli/src/templates/full-stack.ts:150-158`                                                                       | Passes `httpSecurity: { headers: { referrerPolicy: 'same-origin' } }` to the full-stack starter; no `ipSecurity`. Session `csrf` is configured.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Starter pass-through                     | `packages/starters/rest-starter/src/options.ts:92`, `src/app.ts:95`                                                      | `httpSecurity?: HttpSecurityPluginOptions` is handed to `HttpSecurityPlugin(options.httpSecurity)`; the full-stack starter builds on these options.                                                                                                                                                                                                                                                                                                                                                                                              |
| IP security options                      | `packages/http-security-plugin/src/middleware/ip-security-middleware.ts:36`, `:73`, `:230-236`                           | `trustProxy?: boolean` (default `false`), `trustedProxies?: readonly string[]` (CIDRs, malformed entries refused).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| V10-17 mechanism                         | X78-1 (`smoke/X75-X82-FINDINGS.md:169-182`)                                                                              | React Router's own action origin check compares the browser's `https` `Origin` with the internal `http` URL that `publicRequestUrl(ctx)` returns when no trusted IP security published an origin → 400. Fixed by `ipSecurity: { trustProxy: true, trustedProxies }` (measured, `21-browser-trusted.txt`).                                                                                                                                                                                                                                        |
| CSRF origin check                        | `packages/http-security-plugin/src/middleware/csrf-middleware.ts:109-159`, `:163-181`                                    | `extractOrigin` returns the raw `Origin` value (`'null'` included). The request passes when the source origin equals the request origin, the published public origin (when `Sec-Fetch-Site` is absent or `same-origin`), the forwarded candidate (only `same-origin`), or a `trustedOrigins` entry; otherwise 403. `Origin: null` matches none. `Sec-Fetch-Site` is already read (`:126`).                                                                                                                                                       |
| V10-1 mechanism                          | V10-1 (`smoke/V0100-REGRESSION.md`)                                                                                      | Under the plugin's default `Referrer-Policy: no-referrer`, Chrome sends `Origin: null` on a navigation POST; `referrerPolicy: 'same-origin'` → 200.                                                                                                                                                                                                                                                                                                                                                                                              |
| **External frameworks (2026-10-24)**     | Go, Hono, Rails, Django, SvelteKit, Helmet docs (sources in the PR)                                                      | Go `CrossOriginProtection` allows `Sec-Fetch-Site: same-origin`/`none` regardless of `Origin`; Hono `csrf` has an opt-in `secFetchSite` taking priority over `Origin`. Rails' origin check raises on `"null"`, Django rejects it (both also rely on a token); SvelteKit `checkOrigin` returns 403. Helmet also defaults to `no-referrer`.                                                                                                                                                                                                        |
| README CORS + CSRF example               | `packages/http-security-plugin/README.md:46-63`                                                                          | `cors.allowedHeaders: ['content-type', 'authorization', 'idempotency-key']` while `csrf.customHeader: 'X-CSRF-Token'` → a cross-origin POST without the header gets 403, and with it fails preflight. V10-3 confirmed.                                                                                                                                                                                                                                                                                                                           |
| Swagger assets                           | `packages/openapi-plugin/src/ui/swagger-ui.ts:15-37`, `:194-204`                                                         | SRI hashes are for `swagger-ui-dist@5.33.3`; `'self'` adds no `integrity`, `'cdn'` uses the pinned unpkg URL, `{ baseUrl }` adds the 5.33.3 hashes to the application's own copy. JSDoc: "A custom base must serve the pinned, unmodified files."                                                                                                                                                                                                                                                                                                |
| CLI-installed range                      | `packages/cli/src/templates/full-stack.ts:273`, `templates/module-seam.ts:38`                                            | `'swagger-ui-dist': '^5'` (resolved 5.34.0 in the run → blank page under `baseUrl`). V10-36 confirmed.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `setu add` registry                      | `packages/cli/src/commands/add.ts:93-160`, `:197-217`, `:260-272`, `:525-540`                                            | `ADDABLE` entries may carry `peers: { runtimes, packages }`; `peerPackagesFor` reads each range from `CLIENT_RANGES` and throws if absent. `telemetry` has no `peers`; `registrationLine('telemetry-plugin')` prints `TelemetryPlugin({ serviceName, exporter: 'console' })`. `cache`, `scheduler`, `realtime-backplane` are zero-config wirings (bare call).                                                                                                                                                                                    |
| Client ranges                            | `packages/cli/src/templates/client-dependencies.ts:19-30`                                                                | `CLIENT_RANGES` record (`ioredis: '5.x'`, AWS SDK, …); no OpenTelemetry entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **OTel resolution, measured 2026-10-24** | `npm view` + `npm install --dry-run` in scratch                                                                          | `sdk-trace-base`, `resources`, `context-async-hooks` 2.12.0 require `@opentelemetry/api` `<1.10.0`; `resources` 3.0.0 requires `>=1.10.0`. Bare names → ERESOLVE. `api@~1.9.0` + `sdk-trace-base@^2.9.0` + `resources@^2.9.0` + `context-async-hooks@^2.0.0` install (api 1.9.1).                                                                                                                                                                                                                                                                |
| Telemetry peer requirements              | `packages/telemetry-plugin/README.md:13-27`                                                                              | Console exporter needs `sdk-trace-base`, `resources`, `api`; `contextPropagation` (default with an exporter) needs `context-async-hooks`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Generated Node test scripts              | `packages/cli/src/templates/project-files.ts:1556-1567`, `:1611`                                                         | `test`: `tsx --test '**/!(*.e2e).test.ts'`; `test:e2e`: `tsx --test '**/*.e2e.test.ts'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **V10-29 measured, 2026-10-24**          | the run's `x79-ws-redis/apps/orders` on published 0.10.0                                                                 | `test:e2e` with Redis absent: killed at 45 s (exit 124). The generated `startTestServer` already calls `app.stop()` after a failed start. Run outside `node --test`, the failed start + stop leaves only stdio pipes (no socket, no timer); inside the test child likewise; each Redis-using plugin alone (messaging, queue, cache, scheduler lock, backplane) and messaging+queue in both orders leave nothing. With `--test-force-exit` the same run exits 1 after 1 s. The hang is in the `tsx --test` runner, not a leaked framework client. |
| Kubernetes provider token                | `packages/service-discovery-plugin/src/providers/kubernetes-provider.ts:11-12`, `:105-134`, `:194-210`                   | Without `token`, `authHeader()` reads `/var/run/secrets/kubernetes.io/serviceaccount/token`; outside a pod the read rejects `ENOENT`, `isHealthy()` swallows it and returns `false` (no log). Provider has no logger; the plugin does (`plugin/service-discovery-plugin.ts:160`). `IRuntimeServices.fs.stat` exists (`common/src/runtime.ts:97`).                                                                                                                                                                                                |
| M119g overlap                            | branch `fix/m119g-failure-reasons`                                                                                       | M119g edits `service-discovery-service.ts` only (V10-34); this plan edits `kubernetes-provider.ts` and the plugin file — no shared file.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Bearer exemption                         | `packages/session-plugin/src/csrf/exclude.ts:128-138`; `src/middleware/session-middleware.ts:89-95`                      | The bearer exemption is checked before `exclude` and marks the request; the session middleware then skips the commit (M113e anti-planting rule). `exemptBearer: false` restores the 0.9.0 behaviour. `sessionMiddleware(service, tenantBinding)` is exported and takes no logger.                                                                                                                                                                                                                                                                |
| Workspace transport                      | `packages/cli/src/workspace/transport.ts:134-136`, `:335-363`; `commands/workspace.ts:96`; `workspace/root-files.ts:197` | The workspace manifest records `transport`; `TransportSpec` carries `messagingArgs`/`queueArgs(connection)`, `messagingClients`/`queueClients`, and the connection variable (`REDIS_URL`, local default `redis://127.0.0.1:6379`).                                                                                                                                                                                                                                                                                                               |
| Redis arm option shapes                  | `cache-plugin`, `scheduler-plugin`, `realtime-backplane-plugin` interfaces; the run's member config                      | `CachePlugin({ store: 'redis', options: { url } })`; `SchedulerPlugin({ distributedLock: { enabled: true, storage: 'redis', url } })`; `RealtimeBackplanePlugin({ transport: 'redis', url })` — all three booted against Redis in the run.                                                                                                                                                                                                                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                             | Resolution (picked side) | Doc deliverable (same PR)                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| C1  | http-security README example (CORS + CSRF) cannot serve its own cross-origin POST                                                                                                    | The example is wrong     | Add `'x-csrf-token'` to the example's `allowedHeaders`; the fence is compiled and a test serves the example (§3.3) |
| C2  | service-discovery README lists `token` as Consul-only; the `kubernetes` arm needs it outside a cluster                                                                               | The README is wrong      | README Kubernetes section: `token` (and `apiServer`) required outside a pod                                        |
| C3  | react-router-plugin README and `docs/deployment.md` say actions use the original URL without IP security, but not that every action then answers 400 behind TLS termination (V10-41) | Docs incomplete          | Both name the 400 and the `TRUSTED_PROXIES` setting the template now reads                                         |
| C4  | session-plugin README and upgrade guide state the bearer rule but not that it overrides `csrf.exclude`                                                                               | Docs incomplete          | Both state it and name `exemptBearer: false`                                                                       |

## 3. Design decisions

### 3.1 Full-stack template reads `TRUSTED_PROXIES` (V10-17, V10-41)

- **Decision:** the full-stack template's `setu.config.ts` reads
  `config.get<string>('TRUSTED_PROXIES', { default: '' })` (`common/src/services/config.ts:37`) and
  composes `httpSecurity` as today plus, when the value is non-empty,
  `ipSecurity: { trustProxy: true, trustedProxies }` from the comma-separated CIDR list (trimmed,
  empty entries dropped). Empty leaves IP security off (today's behaviour). The template's
  `envVariables` (`templates/registry.ts:163-170`) gains
  `{ name: 'TRUSTED_PROXIES', description: <one line naming the TLS-proxy 400>, develop: '' }`, so
  both dotenv files carry it, and the generated README gains a "Behind a TLS proxy" section. The
  react-router-plugin README and `docs/deployment.md` say the same (C3).
- **Why:** the finding's own fix. A default of "trust nothing" stays safe; the template now offers
  the setting in the one place a deployer edits.
- **Test home:** `packages/cli/test/unit/` full-stack template test (rendered config contains the
  `TRUSTED_PROXIES` branch; `.env.example` line); `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`
  extended for full-stack: boot the scaffold with `TRUSTED_PROXIES=127.0.0.1/32`, POST a React
  Router action with `Origin: https://<host>`, `X-Forwarded-Proto: https`,
  `X-Forwarded-Host: <host>` → not 400; the same request without the variable → 400 (reproduces the
  broken setup).

### 3.2 CSRF accepts `Origin: null` only with `Sec-Fetch-Site: same-origin` (V10-1)

- **Decision:** in `csrf-middleware.ts`, after `extractOrigin`, a source origin of exactly `null`
  (the string the browser sends) is accepted when `Sec-Fetch-Site` is `same-origin`, and refused
  otherwise as today. Nothing else in the origin check changes; `trustedOrigins` is untouched, and
  `null` is never implied for a request without `Sec-Fetch-Site`. The `referrerPolicy` default stays
  `no-referrer`. A new `CsrfOptions.acceptNullOriginSameOrigin?: boolean` (default `true`; a
  non-boolean throws `TypeError` when the middleware is built) set to `false` restores the
  pre-0.11.0 refusal — added after the audit's L2, maintainer decision 2026-10-25.
- **Why:** maintainer decision 2026-10-24, the Fetch Metadata rule of Go's `CrossOriginProtection`
  and Hono's `secFetchSite`, narrowed to the one case the default header policy produces. A
  cross-site page or a sandboxed iframe carries `Sec-Fetch-Site: cross-site`, which page scripts
  cannot set.
- **Test home:** `packages/http-security-plugin/test/unit/csrf-middleware.test.ts` (a table:
  `null` + `same-origin` → pass; `null` + `cross-site`, `same-site`, `none`, absent → 403; a real
  foreign origin + `same-origin` → unchanged); `test/integration/` an app with the plugin's DEFAULT
  headers serving a form POST carrying the Chrome header set → 200, plus the response's
  `Referrer-Policy` asserted as `no-referrer` (reproduces V10-1's exact setup).

### 3.3 README CORS + CSRF example fixed (V10-3)

- **Decision:** the example's `cors.allowedHeaders` adds `'x-csrf-token'`. No code change.
- **Test home:** `packages/http-security-plugin/test/integration/` a test that composes the README
  example's options verbatim and serves a cross-origin preflight (with
  `Access-Control-Request-Headers: x-csrf-token`) and the POST with the header → both pass; the
  README fence compiler already type-checks the block.

### 3.4 The CLI installs `swagger-ui-dist` at `5.33.3` (V10-36)

- **Decision:** every CLI site that installs `swagger-ui-dist` writes the exact version `5.33.3`
  (one constant in its own import-free module `templates/swagger-version.ts`, read by
  `full-stack.ts` and `module-seam.ts`; a constant beside `SWAGGER_ASSET_PACKAGE` would create an
  import cycle through `registry.ts`), and a test asserts that constant equals the version in the
  openapi-plugin's `cdn` URL, so the hashes, the CDN URL and the installed copy cannot drift apart.
  The openapi-plugin README states the `baseUrl` mode needs exactly that version.
- **Why:** the SRI hashes are fixed to 5.33.3, and SRI for a remote base cannot be computed at
  runtime; pinning is the only setup in which every mode works.
- **Test home:** `packages/cli/test/unit/` (rendered manifests carry `5.33.3`; the drift test);
  `scaffold-runs-e2e.test.ts` asserts the installed `swagger-ui-dist/package.json` version is
  5.33.3.

### 3.5 `setu add telemetry` installs its peers (V10-6)

- **Decision:** the `telemetry` `ADDABLE` entry gains
  `peers: { runtimes: ['node', 'bun', 'deno'], packages: ['@opentelemetry/api', '@opentelemetry/sdk-trace-base', '@opentelemetry/resources', '@opentelemetry/context-async-hooks'] }`
  — the set the printed console-exporter registration needs — and `CLIENT_RANGES` gains
  `'@opentelemetry/api': '~1.9.0'`, `'@opentelemetry/sdk-trace-base': '^2.9.0'`,
  `'@opentelemetry/resources': '^2.9.0'`, `'@opentelemetry/context-async-hooks': '^2.0.0'` (measured
  to resolve together, §1). The `api` range carries a comment naming the upstream `<1.10.0` peer
  constraint.
- **Test home:** `packages/cli/test/unit/` add-command test (the four peers recorded with those
  ranges; an existing pin left alone); `packages/cli/test/e2e/` a scaffold + `setu add telemetry` +
  install + boot with the printed registration → starts (reproduces V10-6).

### 3.6 Generated Node test scripts force exit (V10-29)

- **Decision:** the generated Node `test` and `test:e2e` scripts pass `--test-force-exit`
  (`tsx --test --test-force-exit …`). Bun and Deno scripts are unchanged (no hang observed). The
  generated e2e helper is unchanged.
- **Why:** measured (§1): the hang is the `node --test` runner waiting after a failed start, not a
  leaked framework client; with the flag the same run fails in 1 s. A CI job then fails instead of
  running to its own timeout.
- **Test home:** `packages/cli/test/unit/` (rendered scripts contain the flag for Node only);
  `packages/cli/test/e2e/` a Redis-transport workspace member whose `REDIS_URL` points at a closed
  port: `npm run test:e2e` exits non-zero within 30 s (reproduces V10-29).

### 3.7 Kubernetes discovery outside a cluster names `token` (V10-44)

- **Decision:** `KubernetesProvider.authHeader()` turns a failed read of the projected token file
  into `DiscoveryUnavailableError` whose message names the `token` and `apiServer` options for use
  outside a pod (the original error as `cause`). `ServiceDiscoveryPlugin`, for the `kubernetes` arm
  with no `token`, checks at registration (through `runtime.fs.stat`) that the token file exists and
  logs one warning naming the same options when it does not. The README Kubernetes section is
  corrected (C2).
- **Test home:** `packages/service-discovery-plugin/test/unit/` provider test (ENOENT →
  `DiscoveryUnavailableError` with the remedy, `cause` kept; explicit `token` never reads the file)
  and plugin test (missing file → one warning; present file or explicit `token` → none).

### 3.8 Bearer exemption documented (V10-14)

- **Decision:** documentation only (C4). No code change: the middleware is an exported function with
  no logger, and the behaviour is M113e's deliberate anti-planting rule.
- **Test home:** none beyond the existing M113e tests; the docs are covered by the docs gate.

### 3.9 Redis-transport workspaces get Redis arms from `setu add` (generator gaps)

- **Decision:** `TransportSpec` gains optional `cacheArgs`, `schedulerArgs` and `backplaneArgs`
  builders, defined for `redis` only and built from the same connection expression `messagingArgs`
  uses: `{ store: 'redis', options: { url } }`,
  `{ distributedLock: { enabled: true, storage: 'redis', url } }`, `{ transport: 'redis', url }`.
  `setu add cache|scheduler|realtime-backplane` in a member of a workspace whose manifest transport
  has the builder writes that call instead of the bare zero-config one, and adds `ioredis` from
  `CLIENT_RANGES`. Outside such a workspace, or with another transport, behaviour is unchanged.
  Where a plugin already receives a seam argument, the transport argument is merged into it, not
  substituted (the scheduler has no generated job seam today, so its call carries the lock alone).
- **Test home:** `packages/cli/test/unit/` add-command tests (redis workspace member → Redis arm +
  `ioredis`; plain project and other transports → unchanged); a scaffolded Redis workspace member
  after the three `setu add` calls type-checks and boots against a real Redis (guarded `REDIS_URL`).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Behaviour changes for `0.11.0`, recorded in CHANGELOG and
`docs/upgrading.md`: the CSRF check accepts `Origin: null` with `Sec-Fetch-Site: same-origin`;
generated Node test scripts force exit; `setu add` writes Redis arms in a Redis workspace.

| Exported symbol                          | Kind                                     | Consumer / real code path that READS it                                         |
| ---------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| `CsrfOptions.acceptNullOriginSameOrigin` | optional member of an exported interface | Read by `csrfMiddleware` (§3.2); reached through `HttpSecurityPlugin({ csrf })` |

### 4.1 Options — every option names its consumer

| Option                                     | Consumer                                                               | Behavior (per implementation)                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `TRUSTED_PROXIES` (generated config value) | the full-stack template's `setu.config.ts` → `httpSecurity.ipSecurity` | Non-empty CIDR list → `trustProxy: true`, `trustedProxies`; empty → IP security off                              |
| `CsrfOptions.acceptNullOriginSameOrigin`   | `csrfMiddleware` (and `HttpSecurityPlugin({ csrf })`)                  | `true` (default) accepts `Origin: null` + `same-origin`; `false` refuses every `null` origin; non-boolean throws |

## 5. Implementation files

| File                                                                                                                                                                         | Purpose                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/cli/src/templates/full-stack.ts`                                                                                                                                   | §3.1 `TRUSTED_PROXIES`; §3.4 pinned `swagger-ui-dist`                                   |
| `packages/cli/src/templates/module-seam.ts`                                                                                                                                  | §3.4 pinned version                                                                     |
| `packages/cli/src/templates/project-files.ts`                                                                                                                                | §3.4 version constant; §3.6 `--test-force-exit`; §3.1 `.env.example` and README section |
| `packages/cli/src/templates/client-dependencies.ts`                                                                                                                          | §3.5 OpenTelemetry ranges                                                               |
| `packages/cli/src/commands/add.ts`                                                                                                                                           | §3.5 telemetry peers; §3.9 transport-aware arms                                         |
| `packages/cli/src/workspace/transport.ts`                                                                                                                                    | §3.9 `cacheArgs`/`schedulerArgs`/`backplaneArgs` for redis                              |
| `packages/http-security-plugin/src/middleware/csrf-middleware.ts`                                                                                                            | §3.2                                                                                    |
| `packages/service-discovery-plugin/src/providers/kubernetes-provider.ts`, `src/plugin/service-discovery-plugin.ts`                                                           | §3.7                                                                                    |
| READMEs of http-security, react-router, openapi, service-discovery, session, telemetry; `docs/deployment.md`; `CHANGELOG.md`; `docs/upgrading.md`; `ROADMAP.md`; `CLAUDE.md` | C1–C4, the 0.11.0 changes, the status flip; plan archived                               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                            | src covered                                             | Key assertions                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/cli/test/unit/` full-stack, project-files, module-seam, client-dependencies, add, transport tests (extend) | the six CLI files                                       | §3.1, §3.4, §3.5, §3.6, §3.9 rendered output and recorded dependencies                                                                                 |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (extend) + a workspace/add e2e (extend `workspace-e2e.test.ts`)    | generated projects                                      | §3.1 action behind a forwarded `https` origin; §3.4 installed version; §3.5 add telemetry boots; §3.6 Redis-down e2e exits; §3.9 Redis workspace boots |
| `packages/http-security-plugin/test/unit/csrf-middleware.test.ts` + `test/integration/` (extend)                     | `csrf-middleware.ts`                                    | §3.2 table and default-header app; §3.3 README example served                                                                                          |
| `packages/service-discovery-plugin/test/unit/` provider + plugin tests (extend)                                      | `kubernetes-provider.ts`, `service-discovery-plugin.ts` | §3.7                                                                                                                                                   |

Every row's test reproduces the broken setup through a generated project or the documented example
(the ROADMAP gate), and fails without its fix.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m119c-safe-defaults
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% branch/function/line every src file
pnpm run test:deno-lane
pnpm run check:docs
# CLI e2e (scaffolds, installs, boots) — never in parallel with another suite
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

This milestone changes what `packages/cli` generates, so the scaffold-runs e2e gate is mandatory.
Security audit: required by CLAUDE.md, because §3.2 changes a CSRF decision and §3.1 the trust in
forwarded headers. It checks the committed tree against §8a, in a fresh Claude agent, never Codex,
never the implementing context.

## 8. Risks & mitigations

- §3.2 widens what the CSRF check accepts → only `null` with a browser-set `same-origin`; the audit
  probes cross-site, same-site, sandboxed and header-less variants as negative controls.
- §3.5's `api` range will need moving when OpenTelemetry's 2.x line accepts api 1.10 → the comment
  names the constraint; M119f owns the plugin's own peer ranges.
- §3.6 could hide a genuine leak in a user's own test → the flag only ends the runner after the
  tests finished; failures still fail. Measured: no framework client leaked (§1).
- `setu add` reading the workspace manifest from a member → follow the existing project detector; a
  member outside any workspace behaves as today.

## 8a. Design security review

> Written by the planner before implementation (maintainer request, 2026-10-24). The committed-tree
> audit checks the implementation against this section; it runs in a fresh Claude agent, never
> Codex, never the implementing context.

- **Reviewed flows:**
  - **F1 (§3.2):** an unsafe-method request (`POST`/`PUT`/`PATCH`/`DELETE`) carrying `Origin: null`
    reaching `csrf-middleware.ts`, with every `Sec-Fetch-Site` value and with the header absent.
  - **F2 (§3.1):** the generated full-stack app turning the `TRUSTED_PROXIES` configuration value
    into `ipSecurity`, and what that changes downstream: the client IP (rate limits, audit, logs),
    the published public origin (React Router's request URL and the CSRF forwarded candidates), and
    the `Secure` cookie decision.
  - **F3 (§3.7):** the Kubernetes provider's token-file read failing, and the plugin's startup
    check, reaching an error message and a log line.
  - **F4 (§3.4, §3.5, §3.9):** the versions the CLI writes into a generated project's manifest
    (`swagger-ui-dist`, OpenTelemetry, `ioredis`) and the generated Redis-arm configuration.
- **Assets:** the victim's authenticated session (CSRF); the integrity of the client identity and
  public origin the framework derives from forwarded headers; the service-account token and
  in-cluster topology; the generated project's dependency set and install-time behaviour; Redis
  credentials carried in `REDIS_URL`.
- **Attackers:** a cross-site web page loaded in the victim's browser (forms, fetch, sandboxed and
  opaque-origin frames, `data:`/`file:` documents, redirect chains); a direct HTTP client forging
  `Origin`, `Sec-Fetch-Site` and `X-Forwarded-*`/`Forwarded`; an operator misconfiguring
  `TRUSTED_PROXIES`; a compromised or drifting npm package within a recorded range.
- **Budgets:** no new per-request state, map, cache or log line. §3.7 adds at most ONE warning per
  application start; nothing request-driven logs.

### 8a.1 Audit obligations (each a probe with a positive control)

1. **F1, the accepted case:** an app with `HttpSecurityPlugin`'s DEFAULT headers serves a `POST`
   with `Origin: null` + `Sec-Fetch-Site: same-origin` → passes the CSRF check (positive control),
   and its response still carries `Referrer-Policy: no-referrer`.
2. **F1, every refused case (negative controls):** `Origin: null` with `Sec-Fetch-Site`
   `cross-site`, `same-site`, `none`, absent, empty, a combined value (`same-origin, cross-site`),
   and duplicated header lines → 403; `Origin` spelled `NULL` or `"null"` with `same-origin` → 403
   (surrounding whitespace never reaches the middleware: Web `Headers` strips it, so ` null` arrives
   as `null`; the test asserts that normalization rather than a refusal). A table the test iterates,
   not prose.
3. **F1, no widening elsewhere:** a real foreign `Origin` with `Sec-Fetch-Site: same-origin` keeps
   today's result; `trustedOrigins` behaviour is byte-identical (an unchanged-table test against
   develop's cases); `Origin: null` never passes through the `trustedOrigins` path unless the
   operator listed `'null'` explicitly (today's behaviour, unchanged).
4. **F1, the browser half:** the audit records the Fetch Metadata spec rule it relies on, that a
   request whose initiator origin is opaque (sandboxed frame, `data:` URL, `file:`) and a redirect
   chain crossing sites both produce `Sec-Fetch-Site: cross-site`, and runs one real-browser probe
   (Chrome, local app): a same-origin `<form method=post>` under the default headers succeeds; the
   same form posted from a `sandbox` iframe and from a second local origin is refused.
5. **F2, the generated config never trusts the client:** `TRUSTED_PROXIES` unset, `""`, `","`,
   `" , "` → the rendered composition contains NO `ipSecurity` (never `trustProxy: true` without a
   non-empty `trustedProxies`, which would fall back to the client-controlled leftmost entry). With
   it set, a request whose socket peer is NOT in the list and which sends `X-Forwarded-For`,
   `X-Forwarded-Host` and `X-Forwarded-Proto` resolves to the socket peer and the internal origin
   (negative control); the same request from a listed peer resolves the forwarded client and the
   `https` origin (positive control).
6. **F2, fail closed on bad input** (corrected after implementation: the parser was read, not
   assumed): a CIDR width that is not plain digits (`10.0.0.1/`, `10.0.0.0/0x20`) is refused with
   the named `malformed CIDR width` error before the app serves; any other unparseable entry
   (`example`, `10.0.0.0/33`, `::1/129`) is compared literally, as the plugin documents, matches no
   address and trusts nothing — the socket peer stays the client. Neither path ever widens trust.
7. **F2, documented blast radius:** the generated `.env` description and README name what the
   setting trusts, warn that `0.0.0.0/0` trusts every IPv4 client's forwarded headers, and say IPv6
   proxies must be listed as single addresses (corrected after the audit, L1: `::/0` is compared
   literally and trusts nothing).
8. **F3, no disclosure:** the `DiscoveryUnavailableError` message and the startup warning contain
   the option names and the fixed token path only. With a planted canary in an explicit `token` and
   in `apiServer`, neither value appears in any error message, `cause` rendering or log line; the
   warning is emitted once per start, and never on a request.
9. **F4, supply chain:** generated manifests record `swagger-ui-dist` at exactly `5.33.3` (a
   tightening) and still disable Scarf's install-time analytics (`scarfSettings`); the OpenTelemetry
   ranges stay within their current majors (`~1.9.0`, `^2.x`) and add no package beyond the four
   named; `ioredis` keeps its existing `CLIENT_RANGES` entry. No generated file contains a
   credential: `REDIS_URL` is read from the environment, and its local default carries no password.

### 8a.2 Threats and resolutions

| Threat                                                                             | Resolution                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A cross-site page forges a same-origin form POST that carries `Origin: null`       | `Sec-Fetch-Site` is set by the browser and cannot be written by page script; a cross-site or opaque initiator yields `cross-site` (obligations 2, 4)                    |
| A direct client sends `Origin: null` + `Sec-Fetch-Site: same-origin`               | ACCEPTED: CSRF defends browsers; a non-browser client can already send a matching `Origin`, so the rule grants it nothing new (obligation 3 shows no other path widens) |
| An old browser sends `Origin: null` without `Sec-Fetch-Site`                       | Refused as today (fail closed); the template's `referrerPolicy: 'same-origin'` avoids the case for generated apps                                                       |
| `trustProxy` enabled with an empty list trusts the leftmost, client-chosen address | The template composes `ipSecurity` only with ≥ 1 trusted entry (obligation 5)                                                                                           |
| A broad `TRUSTED_PROXIES` (`0.0.0.0/0`) lets any client choose its IP and origin   | Operator choice, documented where it is set (obligation 7); the default is off                                                                                          |
| A malformed `TRUSTED_PROXIES` silently disables or widens trust                    | A non-digit width is refused before serving; any other bad entry is compared literally and trusts nothing (obligation 6)                                                |
| The Kubernetes error or warning leaks a token or the API server address            | Messages built from option names and the fixed path only (obligation 8)                                                                                                 |
| A drifting dependency range installs an incompatible or unexpected package         | Exact pin for `swagger-ui-dist`; OpenTelemetry ranges bounded to the measured-compatible line (obligation 9)                                                            |

### 8a.3 Defect classes (the audit's Step 4) this design expects to apply

Classes 4 (values into a log line: §3.7's warning), 5 (disclosure: F3), 7 (client-controlled
identity: F1, F2), 8 (fail-open when a header or dependency is absent: F1 without `Sec-Fetch-Site`,
F2 with an empty list), 14 (secure defaults: `TRUSTED_PROXIES` off, `Referrer-Policy` unchanged) and
15 (deployment surface: generated env, manifests and README). The audit addresses all fifteen and
states each N/A with its reason.

## 9. Out of scope

- V10-19, V10-28 — M119d.
- telemetry-plugin's own OpenTelemetry peer ranges — M119f.
- A React Router action-rejection hint — the check belongs to React Router.
- Transport-aware `setu add` arms for Kafka, RabbitMQ, NATS, Pub/Sub, Service Bus — no row.
