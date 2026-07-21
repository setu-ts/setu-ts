# Milestone 24c — Telemetry OTel Collector Trace Fan-Out (config + docs)

> **Status:** Planning. Branch: `feat/24-c-collector-fanout`. `main` is protected — all work
> (config + docs + fixes) stays on this one branch until it merges via a single PR.

> **Nature of this milestone:** it ships **no code package** — no `packages/*`, no `src/`, no
> export, no capability token, no tests with a coverage bar. It delivers a reference OpenTelemetry
> Collector configuration and an operator guide that extend the already-complete M24/M24b telemetry
> plugin (sub-milestone convention, as with 16b/24b). The template's code-centric tables (§1
> contract surface, §4 exported surface, §6 per-file 90% test plan) are therefore filled with "None
> (checked) — why", per the TEMPLATE instruction, and the verification in §7 is config validation +
> fmt, not `deno test`.

## 0. Objective & scope

Provide the canonical way to send one OTLP trace stream from a Hono Enterprise app to **multiple
observability backends at once** — Datadog, New Relic, and Azure Application Insights — without
coupling the app to any vendor. The telemetry plugin already exports a single OTLP/HTTP stream
(`exporter: 'otlp'`, `endpoint`); this milestone supplies the OpenTelemetry Collector configuration
that receives that stream and fans it out to N vendor exporters, plus the operator guide to run and
extend it. Routing, sampling, and credentials live in the collector, so the app stays vendor-neutral
and backends change without an app redeploy.

- **In scope:**
  - `docker/otel-collector/collector-config.yaml` — OTLP/HTTP receiver on `:4318`, the
    `memory_limiter` and `batch` processors, and three trace exporters (`datadog`, `otlphttp` for
    New Relic OTLP, `azuremonitor`) on one `traces` pipeline. Credentials via `${env:...}` only.
  - `docs/telemetry-collector-fanout.md` — app-side wiring, per-vendor env/secrets, config
    validation, add/remove-a-backend, and the credential-security note.
  - `ROADMAP.md` — the M24c section (added on this branch) and the `24c` progress row flipped ✅ in
    this milestone's PR.
- **NOT this milestone:**
  - **Native in-app multi-exporter** (`exporters: [...]` on `TelemetryPlugin`) — a future telemetry
    _code_ milestone if ever wanted; the plugin's single-exporter seam is untouched here.
  - **Runnable `docker-compose`, an example app, Kubernetes manifests** — broader containerization
    is owned by **M39 (Docker and Kubernetes)**, which will reference this config, not redefine it.
  - **The general documentation site** — owned by **M38 (Documentation)**, which links this guide.
  - **Metrics/logs fan-out** — this milestone is traces only (the telemetry plugin is a tracing
    plugin; metrics are Prometheus via metrics-plugin, logs via logger-plugin).

## 1. Contracts verified from SOURCE (not names)

The only "contract" this config depends on is the wire format + endpoint the telemetry plugin emits.
Verified against the M24 telemetry-plugin source on `main` (M24 is merged, PR #49; M24b is not a
dependency — fan-out is independent of what generates the spans):

| Reference                                                      | Source (file:line)                                                                                                                                                                             | Verified surface / fact                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OTLP exporter is **HTTP** (not gRPC)                           | [`packages/telemetry-plugin/src/exporters/otlp-exporter.ts:32`](packages/telemetry-plugin/src/exporters/otlp-exporter.ts)                                                                      | Lazy-loads `npm:@opentelemetry/exporter-trace-otlp-http@^0.220.0`, returns `OTLPTraceExporter`. → the collector receiver must accept **OTLP/HTTP**; the reference port is `:4318`.                                                                                                                                                |
| Endpoint shape                                                 | [`packages/telemetry-plugin/src/exporters/otlp-exporter.ts:21`](packages/telemetry-plugin/src/exporters/otlp-exporter.ts) + [`tracer.ts:251`](packages/telemetry-plugin/src/tracing/tracer.ts) | JSDoc + `url: endpoint` — the plugin sends to a full traces URL, e.g. `http://otel:4318/v1/traces`. `endpoint` is required when `exporter: 'otlp'` (validated at [`tracer.ts:380`](packages/telemetry-plugin/src/tracing/tracer.ts)). → the guide instructs pointing `endpoint` at the collector's `:4318`.                       |
| Exporter enum is single-valued                                 | [`packages/telemetry-plugin/src/interfaces/index.ts:25`](packages/telemetry-plugin/src/interfaces/index.ts)                                                                                    | `SpanExporterKind = 'otlp' \| 'console'`; the plugin wires ONE exporter/processor. → in-app multi-backend is not available; the collector is the fan-out point (motivates this milestone).                                                                                                                                        |
| Collector exporters exist in the **contrib** distro (not core) | OpenTelemetry Collector Contrib registry (read 2026-07-21)                                                                                                                                     | `datadog` and `azuremonitor` trace exporters ship in `otelcol-contrib`, not the core `otelcol` build; `otlphttp` (used for New Relic OTLP) is in both. → the guide/config require `otelcol-contrib`. New Relic's OTLP endpoint is `https://otlp.nr-data.net` with an `api-key` header (US region; EU is `otlp.eu01.nr-data.net`). |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                     | Resolution (picked side)                                                                                                                                                                                                                                                                  | Doc deliverable (same PR)                                                                                                  |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| C1 | **Scope overlap with M39 (Docker and Kubernetes)** — M39 ([`ROADMAP.md`](ROADMAP.md) §Milestone 39) lists "Docker Compose", "ConfigMaps, Secrets", which could be read to include a collector deployment.                                                                                                                    | M24c owns ONLY the telemetry collector **config file + operator guide** (no compose, no manifests). M39 owns broad app containerization and, when built, **references** this config rather than duplicating it. The M24c ROADMAP section states this boundary explicitly ("NOT in M24c"). | ROADMAP.md §Milestone 24c "NOT in M24c" names M39 as the owner of compose/manifests and M38 as the owner of the docs site. |
| C2 | **Multi-backend expectation already recorded against M44** — the M44 tracing note (added in the M24b PR) says multi-destination export "is via an OTLP→OpenTelemetry-Collector deployment … noted so M44 does not assume multi-destination tracing exists." That note promises a collector path this milestone now delivers. | M24c **is** that collector path. No edit to the M44 note is required (it correctly points at the collector approach); this plan records the linkage so the two are consistent. (The M44 note lives on the M24b branch; no cross-branch edit here.)                                        | None beyond the M24c section — the M44 note already describes this path correctly.                                         |

## 3. Design decisions

### 3.1 Fan-out point is the Collector, not the app

- **Decision:** The app emits a single OTLP/HTTP stream; the OpenTelemetry Collector holds the three
  vendor exporters on one `traces` pipeline and fans out. The app config is unchanged
  (`TelemetryPlugin({ exporter: 'otlp', endpoint: 'http://<collector>:4318/v1/traces' })`).
- **Why:** keeps the app vendor-neutral and dependency-free (no vendor SDKs, aligned with the
  framework's zero-heavy-dep philosophy), centralizes sampling/batching/credential handling, and
  lets backends be added/removed by editing collector config with no app redeploy. It is also the
  vendor-recommended production pattern.
- **Test home:** N/A (config, not code). Validated per §7 (`otelcol-contrib validate`).

### 3.2 Contrib distribution + `otlphttp` for New Relic

- **Decision:** Target `otelcol-contrib`. Use the `datadog` exporter (API key + site), the
  `azuremonitor` exporter (App Insights connection string), and the generic `otlphttp` exporter
  pointed at New Relic's OTLP endpoint with an `api-key` header (New Relic ingests OTLP natively, so
  no NR-specific exporter is needed).
- **Why:** `datadog` and `azuremonitor` exporters are contrib-only; `otlphttp` avoids a fourth
  vendor-specific component for New Relic. Verified in §1.
- **Test home:** N/A. The `otelcol-contrib validate` step in §7 fails if any exporter/component name
  is wrong or a required field is missing.

### 3.3 Credentials via `${env:...}`, never committed

- **Decision:** Every secret — `DD_API_KEY`, `DD_SITE`, `NEW_RELIC_LICENSE_KEY`,
  `APPLICATIONINSIGHTS_CONNECTION_STRING` — is referenced as `${env:NAME}` in the YAML; the guide
  documents each and shows sourcing them from a container secret / env, not the file.
- **Why:** committing vendor keys is a security defect; `${env:...}` is the collector's supported
  interpolation and keeps the reference config safe to publish.
- **Test home:** N/A. A `grep` in §7 asserts no literal key material appears in the committed YAML.

## 4. Exported surface — every symbol names its consumer

None (checked) — this milestone ships no `src/` and no `packages/*`; there is no `index.ts`, no
exported symbol, and no capability token. The deliverables are a collector YAML and a Markdown
guide, consumed by operators/deployers, not imported by any package.

### 4.1 Options — every option names its consumer

None (checked) — no `TelemetryPluginOptions` change. The config relies only on the EXISTING M24
options `exporter: 'otlp'` and `endpoint` (§1); no option is added, widened, or removed.

## 5. Implementation files

| File                                                | Purpose                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker/otel-collector/collector-config.yaml` (NEW) | OTLP/HTTP receiver (`:4318`) → `memory_limiter` + `batch` → `datadog` + `otlphttp` (New Relic) + `azuremonitor` exporters on one `traces` pipeline; all credentials `${env:...}`.                                                                 |
| `docs/telemetry-collector-fanout.md` (NEW)          | Operator guide: the pattern + a diagram, app wiring snippet, per-vendor env/secrets table, `otelcol-contrib validate` step, add/remove-a-backend recipe, credential-security note, and a pointer that M39 owns compose/k8s and M38 the docs site. |
| `ROADMAP.md` (MODIFY)                               | M24c section (added on this branch) + flip the `24c` progress row ⬜ → ✅ in this PR.                                                                                                                                                             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

None (no `src/`) — there is no code to unit-test and the 90% branch/function/line bar does not
apply. Verification is mechanical instead (§7): the collector config is checked with
`otelcol-contrib validate --config docker/otel-collector/collector-config.yaml` (fails on an unknown
component, a malformed pipeline, or a missing required field), `deno fmt` covers the Markdown guide,
and a `grep` asserts no literal credential appears in the YAML. The guide's app-wiring snippet is
copied verbatim from the M24 PUBLIC_API example so it cannot drift from the real option shape.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/24-c-collector-fanout, never main
deno task check:plan        # this plan lints clean
deno fmt                    # formats the guide + ROADMAP; then:
deno task fmt:check

# Config validation (requires the contrib collector binary or its container image):
otelcol-contrib validate --config docker/otel-collector/collector-config.yaml
#   → "Valid" ; fails on unknown component / bad pipeline / missing required field
# If the binary is unavailable locally, validate via the image:
#   docker run --rm -v "$PWD/docker/otel-collector:/cfg" \
#     otel/opentelemetry-collector-contrib:latest validate --config /cfg/collector-config.yaml

# Security: no literal credential material committed (only ${env:...} references):
grep -nE "api[-_]?key|license|connection[-_]?string|password|secret" \
  docker/otel-collector/collector-config.yaml
#   → every hit must be an ${env:...} reference or a header NAME, never a literal value
```

> The repo code gates (`deno task lint` / `check` / `test` / `test:coverage`) are unaffected — this
> milestone adds no TypeScript. They must still pass repo-wide (they do; nothing under `packages/`
> changes), but there is no new `src` file for the coverage table to measure.

## 8. Risks & mitigations

- **Vendor component/endpoint drift.** Exporter names, New Relic OTLP hostnames, and Azure
  connection string formats change over time. **Mitigation:** §1 records the verified facts (contrib
  exporters, NR US/EU OTLP hosts) as of the read date; the `otelcol-contrib validate` gate catches
  an unknown component or malformed config before it ships; the guide links each vendor's current
  OTLP doc rather than hard-asserting fields that may move.
- **Credential leakage.** A copy-pasted config could inline a real key. **Mitigation:** `${env:...}`
  everywhere + the §7 `grep` gate + an explicit security note in the guide.
- **Version skew between core and contrib collectors.** A user running core `otelcol` will fail on
  `datadog`/`azuremonitor`. **Mitigation:** the config header comment and the guide state
  `otelcol-contrib` is required and why.
- **Reader assumes this includes runtime deployment.** **Mitigation:** the "NOT in M24c" scope in
  the guide and ROADMAP points at M39 (compose/k8s) and M38 (docs site) as the owners.

## 9. Out of scope

- **In-app native multi-exporter** (`exporters: [...]` on `TelemetryPlugin`) — would be a telemetry
  _code_ milestone changing the single-exporter seam; not attempted here.
- **`docker-compose`, example app, Kubernetes manifests, Helm** — owned by **M39 (Docker and
  Kubernetes)**; M39 references this config.
- **Metrics and logs fan-out** — traces only; metrics are owned by metrics-plugin (Prometheus), logs
  by logger-plugin.
- **A managed OTel `ContextManager` / cross-`await` span nesting** — a telemetry-plugin runtime
  concern (documented M24/M24b limitation), unrelated to collector routing.
