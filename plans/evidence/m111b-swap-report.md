# M111b test-suite swap evidence

Generated once by `node scripts/codemods/swap-report.ts` (§3.7 of the M111b plan). Inputs: the
pre-swap Deno run of the package tests (a 4 MB local log, not committed), the Deno per-file coverage
baseline, the reviewed gain causes in `m111b-swap-dispositions.json`, the Deno-lane run, and the
converted Node run against real Redis, RabbitMQ 4, MinIO, Mailpit, ElasticMQ, NATS, Kafka,
PostgreSQL, MongoDB (replica set), DynamoDB Local and the Bigtable emulator. `added-proof` is a new,
independently asserted test written during the conversion; `deno-uncounted` is a guarded
real-backend suite that Deno skipped as a whole and so printed no leaves for.

Failures: **0**. Coverage columns: branch / function / line.

| Test file                                                                                | Deno leaves | Converted leaves | Gain cause     |
| ---------------------------------------------------------------------------------------- | ----------: | ---------------: | -------------- |
| packages/audit-plugin/test/integration/audit-integration.test.ts                         |           5 |                5 | —              |
| packages/audit-plugin/test/unit/audit-health.test.ts                                     |          11 |               11 | —              |
| packages/audit-plugin/test/unit/audit-plugin.test.ts                                     |          12 |               12 | —              |
| packages/audit-plugin/test/unit/audit-record.test.ts                                     |          27 |               27 | —              |
| packages/audit-plugin/test/unit/audit-service.test.ts                                    |           6 |                6 | —              |
| packages/audit-plugin/test/unit/barrel-exports.test.ts                                   |          14 |               14 | —              |
| packages/audit-plugin/test/unit/database-audit.test.ts                                   |          12 |               12 | —              |
| packages/audit-plugin/test/unit/file-audit.test.ts                                       |          19 |               19 | —              |
| packages/audit-plugin/test/unit/log-audit.test.ts                                        |           7 |                7 | —              |
| packages/audit-plugin/test/unit/memory-audit.test.ts                                     |           8 |                8 | —              |
| packages/auth-plugin/test/e2e/keycloak-issuer-real.test.ts                               |           4 |                4 | —              |
| packages/auth-plugin/test/e2e/keycloak-saml-real.test.ts                                 |           3 |                3 | —              |
| packages/auth-plugin/test/e2e/keycloak-sign-in-real.test.ts                              |           2 |                2 | —              |
| packages/auth-plugin/test/integration/auth-behavior-probe.test.ts                        |           1 |                1 | —              |
| packages/auth-plugin/test/integration/auth-integration.test.ts                           |          13 |               13 | —              |
| packages/auth-plugin/test/integration/auth-middleware-registration.test.ts               |           5 |                5 | —              |
| packages/auth-plugin/test/integration/auth-session-mfa.test.ts                           |          11 |               11 | —              |
| packages/auth-plugin/test/integration/auth-session-strategy.test.ts                      |          11 |               11 | —              |
| packages/auth-plugin/test/integration/callback-flow.test.ts                              |          21 |               21 | —              |
| packages/auth-plugin/test/integration/connection-errors-real.test.ts                     |           2 |                2 | —              |
| packages/auth-plugin/test/integration/documented-rate-limit-key.test.ts                  |           1 |                1 | —              |
| packages/auth-plugin/test/integration/federated-mfa.test.ts                              |           4 |                4 | —              |
| packages/auth-plugin/test/integration/issuers-health.test.ts                             |           3 |                3 | —              |
| packages/auth-plugin/test/integration/issuers-lifecycle.test.ts                          |           2 |                2 | —              |
| packages/auth-plugin/test/integration/jwt-optional.test.ts                               |           3 |                3 | —              |
| packages/auth-plugin/test/integration/login-flow.test.ts                                 |           8 |                8 | —              |
| packages/auth-plugin/test/integration/logout.test.ts                                     |          10 |               10 | —              |
| packages/auth-plugin/test/integration/passkey-routes.test.ts                             |          11 |               11 | —              |
| packages/auth-plugin/test/integration/policy-openapi.test.ts                             |           1 |                1 | —              |
| packages/auth-plugin/test/integration/policy-plugin.test.ts                              |          10 |               10 | —              |
| packages/auth-plugin/test/integration/policy-refusal-parity.test.ts                      |           2 |                2 | —              |
| packages/auth-plugin/test/integration/policy-startup-scan.test.ts                        |           5 |                5 | —              |
| packages/auth-plugin/test/integration/rate-limit-error-format.test.ts                    |           6 |                6 | —              |
| packages/auth-plugin/test/integration/realtime-auth.test.ts                              |           5 |                5 | —              |
| packages/auth-plugin/test/integration/refresh-rate-limit-integration.test.ts             |           4 |                4 | —              |
| packages/auth-plugin/test/integration/require-mfa.test.ts                                |           7 |                7 | —              |
| packages/auth-plugin/test/integration/saml-acs.test.ts                                   |          29 |               29 | —              |
| packages/auth-plugin/test/integration/saml-csrf-composition.test.ts                      |           5 |                5 | —              |
| packages/auth-plugin/test/integration/saml-real-import.test.ts                           |           1 |                1 | —              |
| packages/auth-plugin/test/integration/saml-routes.test.ts                                |          28 |               28 | —              |
| packages/auth-plugin/test/integration/scoped-scenarios.test.ts                           |          13 |               13 | —              |
| packages/auth-plugin/test/integration/scoped-sign-in.test.ts                             |           8 |                8 | —              |
| packages/auth-plugin/test/integration/scoped-startup-scan.test.ts                        |           6 |                6 | —              |
| packages/auth-plugin/test/integration/scoped-tenant-consistency.test.ts                  |           6 |                6 | —              |
| packages/auth-plugin/test/integration/second-factor-passkey.test.ts                      |           4 |                4 | —              |
| packages/auth-plugin/test/integration/webauthn-differential.test.ts                      |           5 |                5 | —              |
| packages/auth-plugin/test/unit/access-token-revocation-store.test.ts                     |           7 |                7 | —              |
| packages/auth-plugin/test/unit/api-key-strategy.test.ts                                  |           7 |                7 | —              |
| packages/auth-plugin/test/unit/auth-http.test.ts                                         |           9 |               10 | added-proof    |
| packages/auth-plugin/test/unit/auth-middleware.test.ts                                   |           6 |                6 | —              |
| packages/auth-plugin/test/unit/auth-plugin-options.test.ts                               |          34 |               34 | —              |
| packages/auth-plugin/test/unit/auth-service.test.ts                                      |           6 |                6 | —              |
| packages/auth-plugin/test/unit/auth-session-service.test.ts                              |          25 |               25 | —              |
| packages/auth-plugin/test/unit/authentication.test.ts                                    |          15 |               15 | —              |
| packages/auth-plugin/test/unit/authenticator-data.test.ts                                |           7 |                9 | added-proof    |
| packages/auth-plugin/test/unit/authorization-diagnostics-options.test.ts                 |           4 |                4 | —              |
| packages/auth-plugin/test/unit/authorization-observation-collector.test.ts               |          33 |               35 | added-proof    |
| packages/auth-plugin/test/unit/barrel-exports.test.ts                                    |          25 |               25 | —              |
| packages/auth-plugin/test/unit/base32.test.ts                                            |           6 |                6 | —              |
| packages/auth-plugin/test/unit/base64url.test.ts                                         |          13 |               13 | —              |
| packages/auth-plugin/test/unit/buffer.test.ts                                            |           5 |                5 | —              |
| packages/auth-plugin/test/unit/cbor.test.ts                                              |          12 |               13 | added-proof    |
| packages/auth-plugin/test/unit/challenge.test.ts                                         |           7 |                7 | —              |
| packages/auth-plugin/test/unit/claims.test.ts                                            |           5 |                5 | —              |
| packages/auth-plugin/test/unit/cose-key.test.ts                                          |          13 |               14 | added-proof    |
| packages/auth-plugin/test/unit/discovery.test.ts                                         |           7 |                7 | —              |
| packages/auth-plugin/test/unit/duration.test.ts                                          |          16 |               16 | —              |
| packages/auth-plugin/test/unit/guard-format.test.ts                                      |          17 |               17 | —              |
| packages/auth-plugin/test/unit/guard-security-metadata.test.ts                           |          10 |               10 | —              |
| packages/auth-plugin/test/unit/guards.test.ts                                            |          24 |               24 | —              |
| packages/auth-plugin/test/unit/issuer-strategy.test.ts                                   |          17 |               17 | —              |
| packages/auth-plugin/test/unit/jwt-service.test.ts                                       |          28 |               28 | —              |
| packages/auth-plugin/test/unit/jwt-strategy.test.ts                                      |          15 |               15 | —              |
| packages/auth-plugin/test/unit/jwt-verifier.test.ts                                      |          14 |               14 | —              |
| packages/auth-plugin/test/unit/key-selection.test.ts                                     |          14 |               14 | —              |
| packages/auth-plugin/test/unit/key-set-cache.test.ts                                     |          17 |               17 | —              |
| packages/auth-plugin/test/unit/local-strategy.test.ts                                    |           4 |                4 | —              |
| packages/auth-plugin/test/unit/memory-passkey-store.test.ts                              |          17 |               17 | —              |
| packages/auth-plugin/test/unit/memory-rate-limit-store.test.ts                           |           5 |                5 | —              |
| packages/auth-plugin/test/unit/memory-refresh-token-store.test.ts                        |          13 |               13 | —              |
| packages/auth-plugin/test/unit/memory-totp-store.test.ts                                 |          19 |               19 | —              |
| packages/auth-plugin/test/unit/passkey-ceremonies-edge.test.ts                           |           7 |                7 | —              |
| packages/auth-plugin/test/unit/passkey-options.test.ts                                   |          15 |               15 | —              |
| packages/auth-plugin/test/unit/password-hasher.test.ts                                   |          21 |               21 | —              |
| packages/auth-plugin/test/unit/pem.test.ts                                               |          11 |               11 | —              |
| packages/auth-plugin/test/unit/pending-state.test.ts                                     |           8 |                8 | —              |
| packages/auth-plugin/test/unit/pkce.test.ts                                              |           3 |                3 | —              |
| packages/auth-plugin/test/unit/policies/define-policy.test.ts                            |          21 |               21 | —              |
| packages/auth-plugin/test/unit/policies/policy-service.test.ts                           |          49 |               49 | —              |
| packages/auth-plugin/test/unit/policies/require-policy.test.ts                           |          21 |               21 | —              |
| packages/auth-plugin/test/unit/policies/startup-scan.test.ts                             |           8 |                8 | —              |
| packages/auth-plugin/test/unit/rate-limit-exclude.test.ts                                |          10 |               10 | —              |
| packages/auth-plugin/test/unit/rate-limit-middleware.test.ts                             |          14 |               14 | —              |
| packages/auth-plugin/test/unit/rbac-service.test.ts                                      |          27 |               27 | —              |
| packages/auth-plugin/test/unit/recovery-codes.test.ts                                    |           9 |                9 | —              |
| packages/auth-plugin/test/unit/redis-rate-limit-prefix.test.ts                           |           7 |                7 | —              |
| packages/auth-plugin/test/unit/redis-rate-limit-store.test.ts                            |          17 |               17 | —              |
| packages/auth-plugin/test/unit/refresh-token-service.test.ts                             |          29 |               30 | added-proof    |
| packages/auth-plugin/test/unit/registration.test.ts                                      |          24 |               24 | —              |
| packages/auth-plugin/test/unit/return-to.test.ts                                         |           7 |                7 | —              |
| packages/auth-plugin/test/unit/saml-describe-error.test.ts                               |           2 |                2 | —              |
| packages/auth-plugin/test/unit/saml-loader.test.ts                                       |           6 |                6 | —              |
| packages/auth-plugin/test/unit/saml-options.test.ts                                      |          23 |               23 | —              |
| packages/auth-plugin/test/unit/saml-store-and-cookie.test.ts                             |          18 |               18 | —              |
| packages/auth-plugin/test/unit/scoped/custom-roles.test.ts                               |          13 |               13 | —              |
| packages/auth-plugin/test/unit/scoped/fail-closed.test.ts                                |          17 |               17 | —              |
| packages/auth-plugin/test/unit/scoped/grant-cache.test.ts                                |          21 |               21 | —              |
| packages/auth-plugin/test/unit/scoped/grant-sources.test.ts                              |          15 |               15 | —              |
| packages/auth-plugin/test/unit/scoped/scope-chain.test.ts                                |          14 |               14 | —              |
| packages/auth-plugin/test/unit/scoped/scoped-guards.test.ts                              |          14 |               14 | —              |
| packages/auth-plugin/test/unit/scoped/scoped-options.test.ts                             |          24 |               24 | —              |
| packages/auth-plugin/test/unit/scoped/scoped-policy.test.ts                              |          13 |               13 | —              |
| packages/auth-plugin/test/unit/session-strategy.test.ts                                  |           5 |                5 | —              |
| packages/auth-plugin/test/unit/sign-in-attempt.test.ts                                   |           2 |                2 | —              |
| packages/auth-plugin/test/unit/sign-in-config.test.ts                                    |          19 |               19 | —              |
| packages/auth-plugin/test/unit/signature-edge.test.ts                                    |          10 |               10 | —              |
| packages/auth-plugin/test/unit/signature.test.ts                                         |          11 |               11 | —              |
| packages/auth-plugin/test/unit/token-exchange.test.ts                                    |          13 |               13 | —              |
| packages/auth-plugin/test/unit/totp-codes.test.ts                                        |           6 |                6 | —              |
| packages/auth-plugin/test/unit/totp-lockout.test.ts                                      |           5 |                5 | —              |
| packages/auth-plugin/test/unit/totp-service.test.ts                                      |          35 |               35 | —              |
| packages/auth-plugin/test/unit/trusted-issuer-options.test.ts                            |          10 |               10 | —              |
| packages/cache-plugin/test/integration/cache-integration.test.ts                         |           4 |                4 | —              |
| packages/cache-plugin/test/integration/cache-stampede.test.ts                            |           2 |                2 | —              |
| packages/cache-plugin/test/integration/coalesce-streaming.test.ts                        |           1 |                1 | —              |
| packages/cache-plugin/test/integration/connection-errors-real.test.ts                    |           2 |                2 | —              |
| packages/cache-plugin/test/integration/logger-binding-regression.test.ts                 |           1 |                1 | —              |
| packages/cache-plugin/test/integration/outage-real.test.ts                               |           1 |                1 | —              |
| packages/cache-plugin/test/integration/tenant-cache-isolation.test.ts                    |           2 |                2 | —              |
| packages/cache-plugin/test/unit/barrel-exports.test.ts                                   |           3 |                3 | —              |
| packages/cache-plugin/test/unit/cache-key.test.ts                                        |          22 |               22 | —              |
| packages/cache-plugin/test/unit/cache-middleware.test.ts                                 |          22 |               22 | —              |
| packages/cache-plugin/test/unit/cache-observations.test.ts                               |          45 |               45 | —              |
| packages/cache-plugin/test/unit/cache-payload.test.ts                                    |           9 |                9 | —              |
| packages/cache-plugin/test/unit/cache-plugin.test.ts                                     |          29 |               29 | —              |
| packages/cache-plugin/test/unit/cache-service.test.ts                                    |          13 |               13 | —              |
| packages/cache-plugin/test/unit/coalescer.test.ts                                        |           5 |                5 | —              |
| packages/cache-plugin/test/unit/memory-store.test.ts                                     |          18 |               18 | —              |
| packages/cache-plugin/test/unit/noop-store.test.ts                                       |           8 |                8 | —              |
| packages/cache-plugin/test/unit/redis-client-factory.test.ts                             |          11 |               11 | —              |
| packages/cache-plugin/test/unit/redis-real-import.test.ts                                |           1 |                1 | —              |
| packages/cache-plugin/test/unit/redis-store.test.ts                                      |          26 |               26 | —              |
| packages/cli/test/e2e/adopted-route-e2e.test.ts                                          |           1 |                1 | —              |
| packages/cli/test/e2e/broker-scaffold-e2e.test.ts                                        |           5 |                5 | —              |
| packages/cli/test/e2e/dev-runner-e2e.test.ts                                             |           7 |                7 | —              |
| packages/cli/test/e2e/devtool-e2e.test.ts                                                |           7 |                7 | —              |
| packages/cli/test/e2e/generate-e2e.test.ts                                               |          19 |               19 | —              |
| packages/cli/test/e2e/scaffold-interrupted.test.ts                                       |          10 |               10 | —              |
| packages/cli/test/e2e/scaffold-runs-e2e.test.ts                                          |          28 |               28 | —              |
| packages/cli/test/e2e/seam-probe.test.ts                                                 |           8 |                8 | —              |
| packages/cli/test/e2e/shutdown-e2e.test.ts                                               |           2 |                2 | —              |
| packages/cli/test/e2e/sigint-scaffold.test.ts                                            |           2 |                2 | —              |
| packages/cli/test/e2e/template-e2e.test.ts                                               |          50 |               50 | —              |
| packages/cli/test/e2e/workers-install-e2e.test.ts                                        |           4 |                4 | —              |
| packages/cli/test/e2e/workspace-e2e.test.ts                                              |          20 |               20 | —              |
| packages/cli/test/e2e/workspace-mesh-e2e.test.ts                                         |           7 |                7 | —              |
| packages/cli/test/integration/adopt-dangling-symlink.test.ts                             |           2 |                2 | —              |
| packages/cli/test/integration/app-loader-real-import.test.ts                             |           7 |                7 | —              |
| packages/cli/test/integration/custom-schematic-real-import.test.ts                       |           6 |                6 | —              |
| packages/cli/test/integration/discovery.test.ts                                          |           3 |                3 | —              |
| packages/cli/test/integration/middleware-bands.test.ts                                   |           9 |                9 | —              |
| packages/cli/test/integration/plugin-commands.test.ts                                    |           9 |                9 | —              |
| packages/cli/test/integration/symlink-containment.test.ts                                |           8 |                8 | —              |
| packages/cli/test/integration/zero-config-wirings.test.ts                                |          12 |               12 | —              |
| packages/cli/test/unit/adopt-command.test.ts                                             |          35 |               42 | added-proof    |
| packages/cli/test/unit/adopt-entry-rewrite.test.ts                                       |           3 |                3 | —              |
| packages/cli/test/unit/allocate-port.test.ts                                             |           5 |                5 | —              |
| packages/cli/test/unit/app-command.test.ts                                               |          66 |               66 | —              |
| packages/cli/test/unit/app-loader.test.ts                                                |          28 |               28 | —              |
| packages/cli/test/unit/args.test.ts                                                      |          22 |               23 | added-proof    |
| packages/cli/test/unit/argv-echo-escaped.test.ts                                         |          34 |               34 | —              |
| packages/cli/test/unit/barrel-exports.test.ts                                            |           9 |                9 | —              |
| packages/cli/test/unit/broker-flags.test.ts                                              |          17 |               17 | —              |
| packages/cli/test/unit/cli.test.ts                                                       |          35 |               35 | —              |
| packages/cli/test/unit/commands/add.test.ts                                              |          88 |               88 | —              |
| packages/cli/test/unit/config-module.test.ts                                             |           8 |                8 | —              |
| packages/cli/test/unit/custom-schematic.test.ts                                          |          11 |               11 | —              |
| packages/cli/test/unit/deno-tasks.test.ts                                                |           4 |                4 | —              |
| packages/cli/test/unit/dev-entry.test.ts                                                 |           9 |                9 | —              |
| packages/cli/test/unit/dev-runner-grant.test.ts                                          |           6 |                6 | —              |
| packages/cli/test/unit/devtool-lifecycle.test.ts                                         |          14 |               14 | —              |
| packages/cli/test/unit/devtool-manifest-merge.test.ts                                    |           8 |                8 | —              |
| packages/cli/test/unit/devtool-output-escaping.test.ts                                   |          23 |               23 | —              |
| packages/cli/test/unit/devtool-planner.test.ts                                           |           3 |                3 | —              |
| packages/cli/test/unit/devtool-refusals.test.ts                                          |          58 |               60 | added-proof    |
| packages/cli/test/unit/devtool-sources.test.ts                                           |          30 |               30 | —              |
| packages/cli/test/unit/dockerfile.test.ts                                                |           6 |                6 | —              |
| packages/cli/test/unit/env-file.test.ts                                                  |           3 |                3 | —              |
| packages/cli/test/unit/file-writer.test.ts                                               |          39 |               39 | —              |
| packages/cli/test/unit/filesystem-errors.test.ts                                         |           1 |                1 | —              |
| packages/cli/test/unit/flags.test.ts                                                     |          56 |               56 | —              |
| packages/cli/test/unit/full-stack-template.test.ts                                       |          51 |               51 | —              |
| packages/cli/test/unit/generate-command.test.ts                                          |          85 |               85 | —              |
| packages/cli/test/unit/generate-module-command.test.ts                                   |          11 |               11 | —              |
| packages/cli/test/unit/generate-seam-command.test.ts                                     |          21 |               21 | —              |
| packages/cli/test/unit/generator-mode.test.ts                                            |           2 |                2 | —              |
| packages/cli/test/unit/handler-class-header.test.ts                                      |          37 |               37 | —              |
| packages/cli/test/unit/help.test.ts                                                      |          11 |               11 | —              |
| packages/cli/test/unit/ingress-schematics.test.ts                                        |           8 |                8 | —              |
| packages/cli/test/unit/k8s-manifest.test.ts                                              |           6 |                6 | —              |
| packages/cli/test/unit/library-command.test.ts                                           |          17 |               20 | added-proof    |
| packages/cli/test/unit/module-seam.test.ts                                               |           5 |                5 | —              |
| packages/cli/test/unit/names.test.ts                                                     |          83 |               83 | —              |
| packages/cli/test/unit/new-command.test.ts                                               |         157 |              157 | —              |
| packages/cli/test/unit/new-interactive.test.ts                                           |          18 |               23 | added-proof    |
| packages/cli/test/unit/plugin-args.test.ts                                               |           7 |                7 | —              |
| packages/cli/test/unit/plugin-commands.test.ts                                           |          37 |               37 | —              |
| packages/cli/test/unit/plugin-detector.test.ts                                           |          10 |               10 | —              |
| packages/cli/test/unit/positional-refusal.test.ts                                        |          27 |               27 | —              |
| packages/cli/test/unit/process-boundary.test.ts                                          |           6 |                6 | —              |
| packages/cli/test/unit/prompt.test.ts                                                    |          13 |               13 | —              |
| packages/cli/test/unit/reallocate.test.ts                                                |           3 |                3 | —              |
| packages/cli/test/unit/root-settings.test.ts                                             |           8 |                8 | —              |
| packages/cli/test/unit/scaffold-permissions.test.ts                                      |          13 |               13 | —              |
| packages/cli/test/unit/schematics/command-handler.test.ts                                |          11 |               11 | —              |
| packages/cli/test/unit/schematics/controller.test.ts                                     |          10 |               10 | —              |
| packages/cli/test/unit/schematics/event-handler.test.ts                                  |          11 |               11 | —              |
| packages/cli/test/unit/schematics/guard.test.ts                                          |           8 |                8 | —              |
| packages/cli/test/unit/schematics/health-indicator.test.ts                               |          19 |               19 | —              |
| packages/cli/test/unit/schematics/job.test.ts                                            |           7 |                7 | —              |
| packages/cli/test/unit/schematics/metric.test.ts                                         |          10 |               10 | —              |
| packages/cli/test/unit/schematics/middleware.test.ts                                     |          11 |               11 | —              |
| packages/cli/test/unit/schematics/migration.test.ts                                      |          11 |               11 | —              |
| packages/cli/test/unit/schematics/module-barrel.test.ts                                  |           9 |                9 | —              |
| packages/cli/test/unit/schematics/module.test.ts                                         |          21 |               21 | —              |
| packages/cli/test/unit/schematics/plugin.test.ts                                         |           9 |                9 | —              |
| packages/cli/test/unit/schematics/query-handler.test.ts                                  |          11 |               11 | —              |
| packages/cli/test/unit/schematics/registry.test.ts                                       |          11 |               11 | —              |
| packages/cli/test/unit/schematics/route.test.ts                                          |          12 |               12 | —              |
| packages/cli/test/unit/schematics/service.test.ts                                        |          21 |               21 | —              |
| packages/cli/test/unit/schematics/sse.test.ts                                            |           3 |                3 | —              |
| packages/cli/test/unit/schematics/test-harness.test.ts                                   |           9 |                9 | —              |
| packages/cli/test/unit/schematics/ws-route.test.ts                                       |           1 |                1 | —              |
| packages/cli/test/unit/seam-wiring.test.ts                                               |          27 |               27 | —              |
| packages/cli/test/unit/seams/cqrs.test.ts                                                |           5 |                5 | —              |
| packages/cli/test/unit/seams/events.test.ts                                              |           5 |                5 | —              |
| packages/cli/test/unit/seams/health.test.ts                                              |           6 |                6 | —              |
| packages/cli/test/unit/seams/ingress.test.ts                                             |           1 |                1 | —              |
| packages/cli/test/unit/seams/seam-registry.test.ts                                       |          25 |               25 | —              |
| packages/cli/test/unit/style-flag.test.ts                                                |          20 |               20 | —              |
| packages/cli/test/unit/templates.test.ts                                                 |          62 |               62 | —              |
| packages/cli/test/unit/templates/choice.test.ts                                          |          19 |               19 | —              |
| packages/cli/test/unit/templates/di.test.ts                                              |           3 |                3 | —              |
| packages/cli/test/unit/templates/full-stack-app-files.test.ts                            |           1 |                1 | —              |
| packages/cli/test/unit/templates/minimal.test.ts                                         |          12 |               12 | —              |
| packages/cli/test/unit/templates/project-files.test.ts                                   |          47 |               47 | —              |
| packages/cli/test/unit/templates/runtime-swaps.test.ts                                   |          12 |               12 | —              |
| packages/cli/test/unit/templates/style-baseline.test.ts                                  |          15 |               15 | —              |
| packages/cli/test/unit/templates/style.test.ts                                           |          11 |               11 | —              |
| packages/cli/test/unit/templates/test-deps.test.ts                                       |          14 |               14 | —              |
| packages/cli/test/unit/utils/artifact-scanner-adoption.test.ts                           |          10 |               10 | —              |
| packages/cli/test/unit/utils/artifact-scanner.test.ts                                    |          17 |               17 | —              |
| packages/cli/test/unit/utils/interruption.test.ts                                        |           6 |                6 | —              |
| packages/cli/test/unit/utils/legacy-layout.test.ts                                       |          12 |               12 | —              |
| packages/cli/test/unit/utils/manifest-reader.test.ts                                     |           4 |                4 | —              |
| packages/cli/test/unit/utils/module-scanner.test.ts                                      |          11 |               12 | added-proof    |
| packages/cli/test/unit/utils/name-conflicts.test.ts                                      |          16 |               16 | —              |
| packages/cli/test/unit/utils/plugin-claims.test.ts                                       |           7 |                7 | —              |
| packages/cli/test/unit/utils/project-detector.test.ts                                    |           4 |                4 | —              |
| packages/cli/test/unit/utils/runtime-detector.test.ts                                    |          18 |               18 | —              |
| packages/cli/test/unit/utils/wrap-prose.test.ts                                          |           9 |                9 | —              |
| packages/cli/test/unit/workers-entry-boot.test.ts                                        |          15 |               15 | —              |
| packages/cli/test/unit/workspace-command.test.ts                                         |          13 |               13 | —              |
| packages/cli/test/unit/workspace-manifest.test.ts                                        |           5 |                5 | —              |
| packages/cli/test/unit/workspace/compose.test.ts                                         |          24 |               24 | —              |
| packages/cli/test/unit/workspace/dev-runner.test.ts                                      |           2 |                2 | —              |
| packages/cli/test/unit/workspace/discovery-module.test.ts                                |          10 |               10 | —              |
| packages/cli/test/unit/workspace/k8s.test.ts                                             |          15 |               15 | —              |
| packages/cli/test/unit/workspace/manifest.test.ts                                        |          39 |               39 | —              |
| packages/cli/test/unit/workspace/member-host.test.ts                                     |          18 |               18 | —              |
| packages/cli/test/unit/workspace/port-probe.test.ts                                      |           1 |                1 | —              |
| packages/cli/test/unit/workspace/proto-toolchain.test.ts                                 |          11 |               11 | —              |
| packages/cli/test/unit/workspace/root-files.test.ts                                      |          12 |               12 | —              |
| packages/cli/test/unit/workspace/root-manifest.test.ts                                   |          12 |               12 | —              |
| packages/cli/test/unit/workspace/runtime-profile.test.ts                                 |          46 |               46 | —              |
| packages/cli/test/unit/workspace/transport.test.ts                                       |          24 |               24 | —              |
| packages/cli/test/unit/write-files-rollback.test.ts                                      |          16 |               16 | —              |
| packages/cloudflare-plugin/test/e2e/durable-object-realtime-e2e.test.ts                  |           2 |                2 | —              |
| packages/cloudflare-plugin/test/e2e/worker-exports.test.ts                               |           4 |                4 | —              |
| packages/cloudflare-plugin/test/integration/cache-api-middleware.test.ts                 |           5 |                5 | —              |
| packages/cloudflare-plugin/test/integration/d1-database.test.ts                          |          14 |               14 | —              |
| packages/cloudflare-plugin/test/integration/durable-object-plugin.test.ts                |          10 |               10 | —              |
| packages/cloudflare-plugin/test/integration/durable-object-wiring.test.ts                |          12 |               12 | —              |
| packages/cloudflare-plugin/test/integration/kernel-app.test.ts                           |          12 |               12 | —              |
| packages/cloudflare-plugin/test/integration/messaging-arm.test.ts                        |          12 |               12 | —              |
| packages/cloudflare-plugin/test/integration/queue-plugin.test.ts                         |           9 |                9 | —              |
| packages/cloudflare-plugin/test/integration/rpc-round-trip.test.ts                       |          10 |               10 | —              |
| packages/cloudflare-plugin/test/integration/session-store.test.ts                        |           3 |                3 | —              |
| packages/cloudflare-plugin/test/unit/background/wait-until.test.ts                       |           6 |                6 | —              |
| packages/cloudflare-plugin/test/unit/barrel-exports.test.ts                              |           3 |                3 | —              |
| packages/cloudflare-plugin/test/unit/bindings/binding-registry.test.ts                   |          14 |               14 | —              |
| packages/cloudflare-plugin/test/unit/bindings/facades.test.ts                            |          18 |               18 | —              |
| packages/cloudflare-plugin/test/unit/cache-api/cache-api-middleware.test.ts              |          40 |               40 | —              |
| packages/cloudflare-plugin/test/unit/cache-api/cache-api.test.ts                         |           6 |                6 | —              |
| packages/cloudflare-plugin/test/unit/cache-api/cacheability.test.ts                      |          14 |               14 | —              |
| packages/cloudflare-plugin/test/unit/cron/scheduled-handler.test.ts                      |           3 |                3 | —              |
| packages/cloudflare-plugin/test/unit/cron/workers-cron.test.ts                           |          13 |               13 | —              |
| packages/cloudflare-plugin/test/unit/d1-conditional-write.test.ts                        |           3 |                3 | —              |
| packages/cloudflare-plugin/test/unit/database/d1-adapter.test.ts                         |          17 |               17 | —              |
| packages/cloudflare-plugin/test/unit/database/d1-data-source.test.ts                     |          34 |               34 | —              |
| packages/cloudflare-plugin/test/unit/database/d1-sql.test.ts                             |          43 |               43 | —              |
| packages/cloudflare-plugin/test/unit/database/d1-transaction.test.ts                     |          15 |               15 | —              |
| packages/cloudflare-plugin/test/unit/durable-objects/distributed-lock-object.test.ts     |          10 |               10 | —              |
| packages/cloudflare-plugin/test/unit/durable-objects/do-facades.test.ts                  |           5 |                5 | —              |
| packages/cloudflare-plugin/test/unit/durable-objects/do-websocket-host.test.ts           |           4 |                4 | —              |
| packages/cloudflare-plugin/test/unit/durable-objects/frame-dispatch.test.ts              |           9 |                9 | —              |
| packages/cloudflare-plugin/test/unit/durable-objects/idempotency-object.test.ts          |           9 |                9 | —              |
| packages/cloudflare-plugin/test/unit/durable-objects/realtime-backplane-object.test.ts   |          12 |               12 | —              |
| packages/cloudflare-plugin/test/unit/durable-objects/reply-inbox-object.test.ts          |          15 |               15 | —              |
| packages/cloudflare-plugin/test/unit/health/indicator.test.ts                            |           5 |                5 | —              |
| packages/cloudflare-plugin/test/unit/instance-token.test.ts                              |           4 |                4 | —              |
| packages/cloudflare-plugin/test/unit/lock/durable-object-lock.test.ts                    |          11 |               11 | —              |
| packages/cloudflare-plugin/test/unit/lock/scheduler-compatibility.test.ts                |           1 |                1 | —              |
| packages/cloudflare-plugin/test/unit/messaging/message-envelope.test.ts                  |          29 |               29 | —              |
| packages/cloudflare-plugin/test/unit/messaging/messaging-handler.test.ts                 |           6 |                6 | —              |
| packages/cloudflare-plugin/test/unit/messaging/reply-delivery.test.ts                    |           6 |                6 | —              |
| packages/cloudflare-plugin/test/unit/messaging/reply-inbox.test.ts                       |          10 |               10 | —              |
| packages/cloudflare-plugin/test/unit/messaging/request-correlation.test.ts               |          11 |               11 | —              |
| packages/cloudflare-plugin/test/unit/messaging/subscription-table.test.ts                |          13 |               13 | —              |
| packages/cloudflare-plugin/test/unit/messaging/workers-broker-dispatch.test.ts           |          20 |               20 | —              |
| packages/cloudflare-plugin/test/unit/messaging/workers-broker-publish.test.ts            |          39 |               39 | —              |
| packages/cloudflare-plugin/test/unit/plugin/cloudflare-plugin.test.ts                    |          10 |               10 | —              |
| packages/cloudflare-plugin/test/unit/queues/bounded-map.test.ts                          |           8 |                8 | —              |
| packages/cloudflare-plugin/test/unit/queues/job-envelope.test.ts                         |          10 |               10 | —              |
| packages/cloudflare-plugin/test/unit/queues/queue-handler.test.ts                        |           6 |                6 | —              |
| packages/cloudflare-plugin/test/unit/queues/workers-queue.test.ts                        |          30 |               30 | —              |
| packages/cloudflare-plugin/test/unit/realtime/durable-object-backplane.test.ts           |          24 |               24 | —              |
| packages/cloudflare-plugin/test/unit/storage/r2-storage.test.ts                          |          10 |               10 | —              |
| packages/cloudflare-plugin/test/unit/stores/durable-object-idempotency-store.test.ts     |          13 |               13 | —              |
| packages/cloudflare-plugin/test/unit/stores/kv-cache-store.test.ts                       |          17 |               17 | —              |
| packages/cloudflare-plugin/test/unit/stores/kv-envelope.test.ts                          |          12 |               12 | —              |
| packages/cloudflare-plugin/test/unit/stores/kv-session-store.test.ts                     |          12 |               12 | —              |
| packages/common/test/unit/alias.test.ts                                                  |           1 |                1 | —              |
| packages/common/test/unit/application-diagnostics-contracts.test.ts                      |           6 |                6 | —              |
| packages/common/test/unit/authorization-policies-contract.test.ts                        |           4 |                4 | —              |
| packages/common/test/unit/authorization-responder.test.ts                                |          10 |               10 | —              |
| packages/common/test/unit/barrel-exports.test.ts                                         |          58 |               58 | —              |
| packages/common/test/unit/cloudflare.test.ts                                             |           6 |                6 | —              |
| packages/common/test/unit/compose-behavior-chain.test.ts                                 |          11 |               11 | —              |
| packages/common/test/unit/connection-errors.test.ts                                      |          13 |               13 | —              |
| packages/common/test/unit/content-types.test.ts                                          |           4 |                4 | —              |
| packages/common/test/unit/contract-types.test.ts                                         |           4 |                4 | —              |
| packages/common/test/unit/contracts.test.ts                                              |           4 |                4 | —              |
| packages/common/test/unit/cookie.test.ts                                                 |          22 |               22 | —              |
| packages/common/test/unit/cursor-codec.test.ts                                           |          58 |               58 | —              |
| packages/common/test/unit/database-contract-types.test.ts                                |          13 |               13 | —              |
| packages/common/test/unit/database-filter-contract.test.ts                               |           1 |                1 | —              |
| packages/common/test/unit/diagnostics-contract.test.ts                                   |          19 |               19 | —              |
| packages/common/test/unit/error-responder.test.ts                                        |           6 |                7 | added-proof    |
| packages/common/test/unit/event-diagnostics-contracts.test.ts                            |           6 |                6 | —              |
| packages/common/test/unit/form-body.test.ts                                              |          13 |               13 | —              |
| packages/common/test/unit/form-encoding.test.ts                                          |           9 |                9 | —              |
| packages/common/test/unit/form-review-defects.test.ts                                    |          35 |               35 | —              |
| packages/common/test/unit/form-shape.test.ts                                             |           1 |                1 | —              |
| packages/common/test/unit/form/multipart-platform-parity.test.ts                         |          11 |               11 | —              |
| packages/common/test/unit/grpc-contract.test.ts                                          |           6 |                6 | —              |
| packages/common/test/unit/health/deadline.test.ts                                        |          18 |               18 | —              |
| packages/common/test/unit/health/probe.test.ts                                           |          19 |               19 | —              |
| packages/common/test/unit/idempotency-contract.test.ts                                   |          14 |               14 | —              |
| packages/common/test/unit/inbox-contract.test.ts                                         |           4 |                4 | —              |
| packages/common/test/unit/index.test.ts                                                  |          13 |               13 | —              |
| packages/common/test/unit/ingress-contract.test.ts                                       |          13 |               13 | —              |
| packages/common/test/unit/metrics.test.ts                                                |           5 |                5 | —              |
| packages/common/test/unit/multipart-parser.test.ts                                       |          28 |               28 | —              |
| packages/common/test/unit/option.test.ts                                                 |          11 |               11 | —              |
| packages/common/test/unit/outbox-contract.test.ts                                        |           3 |                3 | —              |
| packages/common/test/unit/parse-json-body.test.ts                                        |           6 |                6 | —              |
| packages/common/test/unit/path-containment.test.ts                                       |          12 |               12 | —              |
| packages/common/test/unit/path-matcher.test.ts                                           |          11 |               11 | —              |
| packages/common/test/unit/publish-options.test.ts                                        |          15 |               18 | added-proof    |
| packages/common/test/unit/queue-contract.test.ts                                         |           5 |                5 | —              |
| packages/common/test/unit/realtime-codec.test.ts                                         |           9 |                9 | —              |
| packages/common/test/unit/realtime-observations.test.ts                                  |          33 |               33 | —              |
| packages/common/test/unit/redaction-default-patterns.test.ts                             |           1 |                1 | —              |
| packages/common/test/unit/redaction-service.test.ts                                      |          19 |               19 | —              |
| packages/common/test/unit/registry-contract.test.ts                                      |           3 |                3 | —              |
| packages/common/test/unit/registry-factory.test.ts                                       |           6 |                6 | —              |
| packages/common/test/unit/request-identity.test.ts                                       |          11 |               11 | —              |
| packages/common/test/unit/resolve-response-status.test.ts                                |          13 |               13 | —              |
| packages/common/test/unit/response-metadata.test.ts                                      |           9 |                9 | —              |
| packages/common/test/unit/result.test.ts                                                 |           8 |                8 | —              |
| packages/common/test/unit/runtime-contracts.test.ts                                      |           6 |                6 | —              |
| packages/common/test/unit/scope-sources.test.ts                                          |           9 |                9 | —              |
| packages/common/test/unit/scoped-grants.test.ts                                          |          18 |               18 | —              |
| packages/common/test/unit/security-metadata.test.ts                                      |          10 |               10 | —              |
| packages/common/test/unit/serialize-error.test.ts                                        |          33 |               33 | —              |
| packages/common/test/unit/serialized-error-contract.test.ts                              |           1 |                1 | —              |
| packages/common/test/unit/session-tenant-binding.test.ts                                 |           7 |                7 | —              |
| packages/common/test/unit/state-keys.test.ts                                             |           1 |                1 | —              |
| packages/common/test/unit/static-modules.test.ts                                         |          11 |               11 | —              |
| packages/common/test/unit/status-hint.test.ts                                            |          18 |               18 | —              |
| packages/common/test/unit/telemetry.test.ts                                              |           7 |                7 | —              |
| packages/common/test/unit/tokens.test.ts                                                 |          12 |               12 | —              |
| packages/common/test/unit/trace-context.test.ts                                          |           4 |                4 | —              |
| packages/common/test/unit/type-contracts.test.ts                                         |          10 |               10 | —              |
| packages/common/test/unit/types.test.ts                                                  |          22 |               22 | —              |
| packages/common/test/unit/upgrade-detection.test.ts                                      |          11 |               11 | —              |
| packages/common/test/unit/validated-state-key.test.ts                                    |           3 |                3 | —              |
| packages/common/test/unit/validation-metadata.test.ts                                    |          14 |               14 | —              |
| packages/common/test/unit/view-contract.test.ts                                          |           6 |                6 | —              |
| packages/common/test/unit/websocket-guard-types.test.ts                                  |           5 |                5 | —              |
| packages/common/test/unit/websocket.test.ts                                              |           7 |                7 | —              |
| packages/common/test/unit/worker-pool.test.ts                                            |          12 |               12 | —              |
| packages/common/test/unit/write-precondition.test.ts                                     |          29 |               29 | —              |
| packages/config-plugin/test/e2e/config-application.test.ts                               |           8 |                8 | —              |
| packages/config-plugin/test/integration/config-plugin.test.ts                            |          23 |               23 | —              |
| packages/config-plugin/test/unit/barrel-exports.test.ts                                  |           2 |                2 | —              |
| packages/config-plugin/test/unit/config-section-cache.test.ts                            |           3 |                3 | —              |
| packages/config-plugin/test/unit/config-section-ordering.test.ts                         |           1 |                1 | —              |
| packages/config-plugin/test/unit/config-section-startup.test.ts                          |           4 |                4 | —              |
| packages/config-plugin/test/unit/config-section.test.ts                                  |           1 |                3 | added-proof    |
| packages/config-plugin/test/unit/config-service.test.ts                                  |          16 |               16 | —              |
| packages/config-plugin/test/unit/config-validator.test.ts                                |           3 |                3 | —              |
| packages/config-plugin/test/unit/env-loader.test.ts                                      |           7 |                7 | —              |
| packages/config-plugin/test/unit/env-parser.test.ts                                      |          12 |               12 | —              |
| packages/config-plugin/test/unit/load-config.test.ts                                     |          25 |               25 | —              |
| packages/config-plugin/test/unit/options.test.ts                                         |           7 |                7 | —              |
| packages/config-plugin/test/unit/provenance.test.ts                                      |          23 |               23 | —              |
| packages/config-plugin/test/unit/variable-expander.test.ts                               |           9 |                9 | —              |
| packages/cqrs-plugin/test/integration/cqrs-integration.test.ts                           |           8 |                8 | —              |
| packages/cqrs-plugin/test/integration/handler-factories.test.ts                          |           1 |                1 | —              |
| packages/cqrs-plugin/test/unit/barrel-exports.test.ts                                    |           6 |                6 | —              |
| packages/cqrs-plugin/test/unit/behavior-factories.test.ts                                |           2 |                2 | —              |
| packages/cqrs-plugin/test/unit/command-bus.test.ts                                       |          10 |               10 | —              |
| packages/cqrs-plugin/test/unit/cqrs-plugin.test.ts                                       |          13 |               13 | —              |
| packages/cqrs-plugin/test/unit/handler-factories.test.ts                                 |           6 |                6 | —              |
| packages/cqrs-plugin/test/unit/handler-not-found.test.ts                                 |           5 |                5 | —              |
| packages/cqrs-plugin/test/unit/pipeline-delegation.test.ts                               |           2 |                2 | —              |
| packages/cqrs-plugin/test/unit/query-bus.test.ts                                         |          11 |               11 | —              |
| packages/database-plugin/test/e2e/database-application.test.ts                           |           6 |                6 | —              |
| packages/database-plugin/test/integration/database-plugin.test.ts                        |          28 |               28 | —              |
| packages/database-plugin/test/integration/drizzle-query-sqlite.test.ts                   |           2 |                2 | —              |
| packages/database-plugin/test/integration/duplicate-key-status.test.ts                   |           5 |                5 | —              |
| packages/database-plugin/test/integration/grant-source-real.test.ts                      |           2 |                2 | —              |
| packages/database-plugin/test/integration/logger-binding-regression.test.ts              |           1 |                1 | —              |
| packages/database-plugin/test/integration/outage-real.test.ts                            |           1 |                1 | —              |
| packages/database-plugin/test/integration/outbox-store-real.test.ts                      |           3 |               14 | deno-uncounted |
| packages/database-plugin/test/integration/pool-saturation-health.test.ts                 |           3 |                3 | —              |
| packages/database-plugin/test/integration/real-bigtable-adapter.test.ts                  |          25 |               25 | —              |
| packages/database-plugin/test/integration/real-cosmos-adapter.test.ts                    |          12 |               12 | —              |
| packages/database-plugin/test/integration/real-drizzle-adapter.test.ts                   |          17 |               17 | —              |
| packages/database-plugin/test/integration/real-dynamo-adapter.test.ts                    |          13 |               13 | —              |
| packages/database-plugin/test/integration/real-import.test.ts                            |           5 |                5 | —              |
| packages/database-plugin/test/integration/real-mongo-adapter.test.ts                     |          18 |               18 | —              |
| packages/database-plugin/test/integration/real-prisma-adapter.test.ts                    |           9 |                9 | —              |
| packages/database-plugin/test/integration/refusal-status.test.ts                         |          14 |               14 | —              |
| packages/database-plugin/test/integration/tenant-store-memory-adapter.test.ts            |           4 |                4 | —              |
| packages/database-plugin/test/integration/tenant-store-race-real.test.ts                 |           1 |                1 | —              |
| packages/database-plugin/test/unit/adapter-contract.test.ts                              |           7 |                7 | —              |
| packages/database-plugin/test/unit/adapter-reachability.test.ts                          |          17 |               17 | —              |
| packages/database-plugin/test/unit/barrel-exports.test.ts                                |          28 |               28 | —              |
| packages/database-plugin/test/unit/base-repository-conditional.test.ts                   |           2 |                2 | —              |
| packages/database-plugin/test/unit/base-repository.test.ts                               |          25 |               25 | —              |
| packages/database-plugin/test/unit/bigtable-adapter.test.ts                              |          16 |               17 | added-proof    |
| packages/database-plugin/test/unit/bigtable-client-seam.test.ts                          |          10 |               12 | added-proof    |
| packages/database-plugin/test/unit/bigtable-conditional-write.test.ts                    |           3 |                3 | —              |
| packages/database-plugin/test/unit/bigtable-data-source.test.ts                          |          28 |               28 | —              |
| packages/database-plugin/test/unit/bigtable-mapping.test.ts                              |          13 |               13 | —              |
| packages/database-plugin/test/unit/bigtable-page.test.ts                                 |          14 |               14 | —              |
| packages/database-plugin/test/unit/bigtable-row-key.test.ts                              |          19 |               19 | —              |
| packages/database-plugin/test/unit/bigtable-scan.test.ts                                 |          33 |               33 | —              |
| packages/database-plugin/test/unit/bigtable-transaction.test.ts                          |          22 |               22 | —              |
| packages/database-plugin/test/unit/bigtable-value.test.ts                                |           8 |                8 | —              |
| packages/database-plugin/test/unit/cause-chain-audit.test.ts                             |           2 |                2 | —              |
| packages/database-plugin/test/unit/classify-driver-error.test.ts                         |          37 |               37 | —              |
| packages/database-plugin/test/unit/conditional-write-conformance.test.ts                 |          56 |               56 | —              |
| packages/database-plugin/test/unit/conditional-write-helper.test.ts                      |           2 |                2 | —              |
| packages/database-plugin/test/unit/cosmos-adapter.test.ts                                |          17 |               17 | —              |
| packages/database-plugin/test/unit/cosmos-client-seam.test.ts                            |           3 |                3 | —              |
| packages/database-plugin/test/unit/cosmos-conditional-write.test.ts                      |           7 |                7 | —              |
| packages/database-plugin/test/unit/cosmos-data-source.test.ts                            |          36 |               36 | —              |
| packages/database-plugin/test/unit/cosmos-mapping.test.ts                                |          15 |               15 | —              |
| packages/database-plugin/test/unit/cosmos-page.test.ts                                   |           8 |                8 | —              |
| packages/database-plugin/test/unit/cosmos-partition-key.test.ts                          |          13 |               13 | —              |
| packages/database-plugin/test/unit/cosmos-query.test.ts                                  |          30 |               30 | —              |
| packages/database-plugin/test/unit/cosmos-transaction.test.ts                            |          30 |               30 | —              |
| packages/database-plugin/test/unit/cosmos-update.test.ts                                 |          19 |               19 | —              |
| packages/database-plugin/test/unit/cursor-codec.test.ts                                  |          11 |               11 | —              |
| packages/database-plugin/test/unit/database-indicator-mapping.test.ts                    |           9 |                9 | —              |
| packages/database-plugin/test/unit/database-plugin-custom-arm.test.ts                    |           9 |                9 | —              |
| packages/database-plugin/test/unit/database-pool-capacity.test.ts                        |          16 |               16 | —              |
| packages/database-plugin/test/unit/database-service-conditional.test.ts                  |           5 |                5 | —              |
| packages/database-plugin/test/unit/database-service-coverage.test.ts                     |          15 |               15 | —              |
| packages/database-plugin/test/unit/database-service.test.ts                              |          19 |               19 | —              |
| packages/database-plugin/test/unit/database-tenant-data-store.test.ts                    |          24 |               24 | —              |
| packages/database-plugin/test/unit/drizzle-adapter-columns.test.ts                       |          24 |               24 | —              |
| packages/database-plugin/test/unit/drizzle-adapter-coverage.test.ts                      |          35 |               35 | —              |
| packages/database-plugin/test/unit/drizzle-adapter-probe-saturation.test.ts              |          32 |               32 | —              |
| packages/database-plugin/test/unit/drizzle-adapter.test.ts                               |          38 |               38 | —              |
| packages/database-plugin/test/unit/drizzle-isolation-bridge.test.ts                      |           3 |                3 | —              |
| packages/database-plugin/test/unit/drizzle-query.test.ts                                 |          13 |               13 | —              |
| packages/database-plugin/test/unit/drizzle-repository.test.ts                            |          10 |               10 | —              |
| packages/database-plugin/test/unit/dynamo-access-path.test.ts                            |          13 |               13 | —              |
| packages/database-plugin/test/unit/dynamo-adapter.test.ts                                |          21 |               21 | —              |
| packages/database-plugin/test/unit/dynamo-client-seam.test.ts                            |           9 |                9 | —              |
| packages/database-plugin/test/unit/dynamo-data-source.test.ts                            |          10 |               10 | —              |
| packages/database-plugin/test/unit/dynamo-expression.test.ts                             |          36 |               36 | —              |
| packages/database-plugin/test/unit/dynamo-key.test.ts                                    |           3 |                3 | —              |
| packages/database-plugin/test/unit/dynamo-mapping.test.ts                                |          19 |               19 | —              |
| packages/database-plugin/test/unit/dynamo-marshal.test.ts                                |          51 |               51 | —              |
| packages/database-plugin/test/unit/dynamo-order.test.ts                                  |           5 |                5 | —              |
| packages/database-plugin/test/unit/dynamo-page.test.ts                                   |           9 |                9 | —              |
| packages/database-plugin/test/unit/dynamo-transaction-buffer.test.ts                     |           2 |                3 | added-proof    |
| packages/database-plugin/test/unit/dynamo-transaction.test.ts                            |          11 |               11 | —              |
| packages/database-plugin/test/unit/entity-key.test.ts                                    |           9 |                9 | —              |
| packages/database-plugin/test/unit/error-status-hints.test.ts                            |           8 |                8 | —              |
| packages/database-plugin/test/unit/errors.test.ts                                        |           3 |                3 | —              |
| packages/database-plugin/test/unit/fake-prisma-where.test.ts                             |           9 |                9 | —              |
| packages/database-plugin/test/unit/filter-conformance.test.ts                            |          66 |               66 | —              |
| packages/database-plugin/test/unit/grant-source.test.ts                                  |          14 |               14 | —              |
| packages/database-plugin/test/unit/idempotency/backend-probe.test.ts                     |           8 |                8 | —              |
| packages/database-plugin/test/unit/idempotency/idempotency-store.test.ts                 |          27 |               27 | —              |
| packages/database-plugin/test/unit/idempotency/idempotency-verify.test.ts                |           7 |                7 | —              |
| packages/database-plugin/test/unit/inbox-store-conditional.test.ts                       |           5 |                5 | —              |
| packages/database-plugin/test/unit/inbox/inbox-columns.test.ts                           |           3 |                3 | —              |
| packages/database-plugin/test/unit/inbox/inbox-discriminator.test.ts                     |           1 |                1 | —              |
| packages/database-plugin/test/unit/inbox/inbox-store-contract.test.ts                    |           6 |                6 | —              |
| packages/database-plugin/test/unit/inbox/inbox-store-ops.test.ts                         |          17 |               17 | —              |
| packages/database-plugin/test/unit/inbox/inbox-verify.test.ts                            |          11 |               11 | —              |
| packages/database-plugin/test/unit/json-path.test.ts                                     |           7 |                7 | —              |
| packages/database-plugin/test/unit/like-escape.test.ts                                   |           5 |                5 | —              |
| packages/database-plugin/test/unit/memory-adapter-columns.test.ts                        |          18 |               18 | —              |
| packages/database-plugin/test/unit/memory-adapter-composite.test.ts                      |          33 |               33 | —              |
| packages/database-plugin/test/unit/memory-adapter-coverage.test.ts                       |          22 |               22 | —              |
| packages/database-plugin/test/unit/memory-adapter.test.ts                                |          49 |               49 | —              |
| packages/database-plugin/test/unit/memory-isolation.test.ts                              |           5 |                5 | —              |
| packages/database-plugin/test/unit/mongo-adapter.test.ts                                 |          24 |               27 | added-proof    |
| packages/database-plugin/test/unit/mongo-client-seam.test.ts                             |           5 |                5 | —              |
| packages/database-plugin/test/unit/mongo-data-source.test.ts                             |          57 |               57 | —              |
| packages/database-plugin/test/unit/mongo-mapping.test.ts                                 |          28 |               28 | —              |
| packages/database-plugin/test/unit/mongo-numeric-id.test.ts                              |           8 |                8 | —              |
| packages/database-plugin/test/unit/mongo-query.test.ts                                   |          31 |               31 | —              |
| packages/database-plugin/test/unit/outbox-store-conditional.test.ts                      |           8 |                8 | —              |
| packages/database-plugin/test/unit/outbox-write-scope.test.ts                            |           1 |                1 | —              |
| packages/database-plugin/test/unit/outbox/outbox-bigint-columns.test.ts                  |           6 |                6 | —              |
| packages/database-plugin/test/unit/outbox/outbox-columns.test.ts                         |           6 |                6 | —              |
| packages/database-plugin/test/unit/outbox/outbox-discriminator.test.ts                   |           5 |                5 | —              |
| packages/database-plugin/test/unit/outbox/outbox-store-contract.test.ts                  |           8 |                8 | —              |
| packages/database-plugin/test/unit/outbox/outbox-store-ops.test.ts                       |          29 |               29 | —              |
| packages/database-plugin/test/unit/outbox/outbox-verify.test.ts                          |          19 |               19 | —              |
| packages/database-plugin/test/unit/page-result.test.ts                                   |          10 |               10 | —              |
| packages/database-plugin/test/unit/plugin-coverage.test.ts                               |          14 |               14 | —              |
| packages/database-plugin/test/unit/plugin-options-types.test.ts                          |           4 |                4 | —              |
| packages/database-plugin/test/unit/plugin.test.ts                                        |          13 |               13 | —              |
| packages/database-plugin/test/unit/prisma-adapter-coverage.test.ts                       |          26 |               26 | —              |
| packages/database-plugin/test/unit/prisma-adapter.test.ts                                |          67 |               68 | added-proof    |
| packages/database-plugin/test/unit/prisma-conditional-write.test.ts                      |           3 |                3 | —              |
| packages/database-plugin/test/unit/prisma-repository.test.ts                             |          12 |               12 | —              |
| packages/database-plugin/test/unit/proto-field-guards.test.ts                            |           6 |                6 | —              |
| packages/database-plugin/test/unit/query-builder.test.ts                                 |          31 |               31 | —              |
| packages/database-plugin/test/unit/raw-statement.test.ts                                 |          38 |               38 | —              |
| packages/database-plugin/test/unit/repository-implementor-contract.test.ts               |           5 |                5 | —              |
| packages/database-plugin/test/unit/tenant-store-race.test.ts                             |           5 |                5 | —              |
| packages/database-plugin/test/unit/unit-of-work.test.ts                                  |           9 |                9 | —              |
| packages/decorator-plugin/test/e2e/decorator-application.test.ts                         |           8 |                8 | —              |
| packages/decorator-plugin/test/integration/decorator-plugin.test.ts                      |          18 |               18 | —              |
| packages/decorator-plugin/test/integration/decorator-validation.test.ts                  |           5 |                5 | —              |
| packages/decorator-plugin/test/integration/di-interop.test.ts                            |           8 |                8 | —              |
| packages/decorator-plugin/test/integration/idempotent-registration.test.ts               |           4 |                4 | —              |
| packages/decorator-plugin/test/integration/ingress-registration.test.ts                  |           7 |                7 | —              |
| packages/decorator-plugin/test/integration/policy-parity.test.ts                         |           8 |                8 | —              |
| packages/decorator-plugin/test/integration/rbac-absent-decorated.test.ts                 |           1 |                1 | —              |
| packages/decorator-plugin/test/integration/render-e2e.test.ts                            |           5 |                5 | —              |
| packages/decorator-plugin/test/integration/render-missing-provider.test.ts               |           2 |                2 | —              |
| packages/decorator-plugin/test/integration/render-redirect.test.ts                       |           3 |                3 | —              |
| packages/decorator-plugin/test/integration/render-service-engine.test.ts                 |           2 |                2 | —              |
| packages/decorator-plugin/test/integration/render-with-status.test.ts                    |           3 |                3 | —              |
| packages/decorator-plugin/test/integration/require-policy-e2e.test.ts                    |          10 |               10 | —              |
| packages/decorator-plugin/test/integration/roles-enforced.test.ts                        |           7 |                7 | —              |
| packages/decorator-plugin/test/integration/scoped-rbac-e2e.test.ts                       |          11 |               11 | —              |
| packages/decorator-plugin/test/integration/startup-warnings.test.ts                      |           6 |                6 | —              |
| packages/decorator-plugin/test/type/ingress-behavior-typing.test.ts                      |           2 |                2 | —              |
| packages/decorator-plugin/test/type/params-typing.test.ts                                |           6 |                6 | —              |
| packages/decorator-plugin/test/unit/barrel-exports.test.ts                               |          10 |               10 | —              |
| packages/decorator-plugin/test/unit/context-marker-copies.test.ts                        |           6 |                6 | —              |
| packages/decorator-plugin/test/unit/controller-decorator.test.ts                         |           4 |                4 | —              |
| packages/decorator-plugin/test/unit/controller-discovery.test.ts                         |          19 |               22 | added-proof    |
| packages/decorator-plugin/test/unit/create-decorator.test.ts                             |           5 |                5 | —              |
| packages/decorator-plugin/test/unit/cross-family-warning.test.ts                         |           5 |                5 | —              |
| packages/decorator-plugin/test/unit/http-decorator.test.ts                               |           4 |                4 | —              |
| packages/decorator-plugin/test/unit/idempotent-decorator.test.ts                         |           4 |                4 | —              |
| packages/decorator-plugin/test/unit/ingress-decorator.test.ts                            |           5 |                5 | —              |
| packages/decorator-plugin/test/unit/ingress-registration.test.ts                         |          14 |               14 | —              |
| packages/decorator-plugin/test/unit/injection-decorator.test.ts                          |          11 |               11 | —              |
| packages/decorator-plugin/test/unit/internal.test.ts                                     |          12 |               12 | —              |
| packages/decorator-plugin/test/unit/metadata-shape.test.ts                               |           7 |                7 | —              |
| packages/decorator-plugin/test/unit/metadata-store.test.ts                               |          17 |               17 | —              |
| packages/decorator-plugin/test/unit/module-decorator.test.ts                             |           2 |                2 | —              |
| packages/decorator-plugin/test/unit/openapi-decorator.test.ts                            |           9 |                9 | —              |
| packages/decorator-plugin/test/unit/optional-injection.test.ts                           |           6 |                6 | —              |
| packages/decorator-plugin/test/unit/parameter-resolver.test.ts                           |          20 |               20 | —              |
| packages/decorator-plugin/test/unit/params.test.ts                                       |          10 |               10 | —              |
| packages/decorator-plugin/test/unit/pending.test.ts                                      |           8 |                8 | —              |
| packages/decorator-plugin/test/unit/pipeline-decorator.test.ts                           |          11 |               11 | —              |
| packages/decorator-plugin/test/unit/plugin-internals.test.ts                             |          14 |               14 | —              |
| packages/decorator-plugin/test/unit/plugin/authorization-enforcement.test.ts             |          16 |               16 | —              |
| packages/decorator-plugin/test/unit/plugin/enforce-roles-option.test.ts                  |           5 |                5 | —              |
| packages/decorator-plugin/test/unit/plugin/public-decorator-docs.test.ts                 |           2 |                2 | —              |
| packages/decorator-plugin/test/unit/plugin/validation-enforcement.test.ts                |           6 |                6 | —              |
| packages/decorator-plugin/test/unit/policy-decorators.test.ts                            |           6 |                6 | —              |
| packages/decorator-plugin/test/unit/policy-registration.test.ts                          |          21 |               21 | —              |
| packages/decorator-plugin/test/unit/render-decorator.test.ts                             |           3 |                3 | —              |
| packages/decorator-plugin/test/unit/resolvers/validated-parameters.test.ts               |          13 |               13 | —              |
| packages/decorator-plugin/test/unit/response-shaping-order.test.ts                       |           3 |                3 | —              |
| packages/decorator-plugin/test/unit/response-shaping.test.ts                             |           8 |                8 | —              |
| packages/decorator-plugin/test/unit/response-status-validation.test.ts                   |          22 |               22 | —              |
| packages/decorator-plugin/test/unit/scoped-decorators.test.ts                            |          19 |               19 | —              |
| packages/decorator-plugin/test/unit/security-decorator.test.ts                           |          10 |               10 | —              |
| packages/decorator-plugin/test/unit/symbol-metadata.test.ts                              |           8 |                8 | —              |
| packages/decorator-plugin/test/unit/validation-decorator.test.ts                         |           4 |                5 | added-proof    |
| packages/di-plugin/test/integration/di-plugin.test.ts                                    |          14 |               14 | —              |
| packages/di-plugin/test/unit/circular-detector.test.ts                                   |           9 |                9 | —              |
| packages/di-plugin/test/unit/container-builder.test.ts                                   |          13 |               13 | —              |
| packages/di-plugin/test/unit/container.test.ts                                           |          32 |               32 | —              |
| packages/di-plugin/test/unit/provider-registry.test.ts                                   |           9 |                9 | —              |
| packages/di-plugin/test/unit/scope-manager.test.ts                                       |           8 |                8 | —              |
| packages/diagnostics-plugin/test/e2e/authorization-explanations.test.ts                  |           4 |                4 | —              |
| packages/diagnostics-plugin/test/e2e/cache-observations.test.ts                          |           1 |                1 | —              |
| packages/diagnostics-plugin/test/e2e/config-provenance.test.ts                           |           1 |                1 | —              |
| packages/diagnostics-plugin/test/e2e/distributed-tracing.test.ts                         |           3 |                3 | —              |
| packages/diagnostics-plugin/test/e2e/event-observations.test.ts                          |           6 |                6 | —              |
| packages/diagnostics-plugin/test/e2e/health-observations.test.ts                         |           3 |                3 | —              |
| packages/diagnostics-plugin/test/e2e/local-connector.test.ts                             |           4 |                4 | —              |
| packages/diagnostics-plugin/test/e2e/outbound-http-observations.test.ts                  |           2 |                2 | —              |
| packages/diagnostics-plugin/test/e2e/queue-observations.test.ts                          |           3 |                3 | —              |
| packages/diagnostics-plugin/test/e2e/realtime-observations.test.ts                       |           4 |                4 | —              |
| packages/diagnostics-plugin/test/e2e/scheduler-observations.test.ts                      |           2 |                2 | —              |
| packages/diagnostics-plugin/test/e2e/storage-observations.test.ts                        |           1 |                1 | —              |
| packages/diagnostics-plugin/test/index.test.ts                                           |           4 |                4 | —              |
| packages/diagnostics-plugin/test/integration/activation.test.ts                          |           5 |                5 | —              |
| packages/diagnostics-plugin/test/integration/core-conformance.test.ts                    |           4 |                4 | —              |
| packages/diagnostics-plugin/test/integration/lifecycle.test.ts                           |           6 |                6 | —              |
| packages/diagnostics-plugin/test/integration/security.test.ts                            |           6 |                6 | —              |
| packages/diagnostics-plugin/test/unit/authentication.test.ts                             |          10 |               10 | —              |
| packages/diagnostics-plugin/test/unit/authorization-protocol.test.ts                     |          43 |               43 | —              |
| packages/diagnostics-plugin/test/unit/cache-observations.test.ts                         |          49 |               49 | —              |
| packages/diagnostics-plugin/test/unit/client.test.ts                                     |         147 |              166 | added-proof    |
| packages/diagnostics-plugin/test/unit/connector-handler.test.ts                          |          93 |               99 | added-proof    |
| packages/diagnostics-plugin/test/unit/core-validators.test.ts                            |          57 |               57 | —              |
| packages/diagnostics-plugin/test/unit/event-protocol.test.ts                             |          15 |               16 | added-proof    |
| packages/diagnostics-plugin/test/unit/limits.test.ts                                     |          10 |               10 | —              |
| packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts                 |          67 |               67 | —              |
| packages/diagnostics-plugin/test/unit/plugin.test.ts                                     |          19 |               19 | —              |
| packages/diagnostics-plugin/test/unit/protocol.test.ts                                   |          30 |               30 | —              |
| packages/diagnostics-plugin/test/unit/queue-merger.test.ts                               |          16 |               16 | —              |
| packages/diagnostics-plugin/test/unit/queue-protocol.test.ts                             |          54 |               54 | —              |
| packages/diagnostics-plugin/test/unit/realtime-observations.test.ts                      |          72 |               72 | —              |
| packages/diagnostics-plugin/test/unit/scheduler-observations.test.ts                     |          37 |               37 | —              |
| packages/diagnostics-plugin/test/unit/session.test.ts                                    |          12 |               12 | —              |
| packages/diagnostics-plugin/test/unit/storage-observations.test.ts                       |          58 |               58 | —              |
| packages/diagnostics-plugin/test/unit/trace-protocol.test.ts                             |          20 |               21 | added-proof    |
| packages/events-plugin/test/integration/events-integration.test.ts                       |           6 |                6 | —              |
| packages/events-plugin/test/integration/handler-factories.test.ts                        |           1 |                1 | —              |
| packages/events-plugin/test/unit/barrel-exports.test.ts                                  |           4 |                4 | —              |
| packages/events-plugin/test/unit/domain-event.test.ts                                    |          18 |               18 | —              |
| packages/events-plugin/test/unit/domain-events.test.ts                                   |           7 |                7 | —              |
| packages/events-plugin/test/unit/event-handler.test.ts                                   |           2 |                2 | —              |
| packages/events-plugin/test/unit/event-observations.test.ts                              |          54 |               54 | —              |
| packages/events-plugin/test/unit/events-plugin.test.ts                                   |          12 |               12 | —              |
| packages/events-plugin/test/unit/handler-factories.test.ts                               |           4 |                4 | —              |
| packages/events-plugin/test/unit/handler-failure-logging.test.ts                         |           1 |                1 | —              |
| packages/events-plugin/test/unit/in-memory-event-bus.test.ts                             |          12 |               12 | —              |
| packages/events-plugin/test/unit/integration-event.test.ts                               |           4 |                4 | —              |
| packages/exceptions/test/integration/error-format-agreement.test.ts                      |           5 |                5 | —              |
| packages/exceptions/test/integration/error-handler-app.test.ts                           |          20 |               20 | —              |
| packages/exceptions/test/integration/short-circuit-format.test.ts                        |           2 |                2 | —              |
| packages/exceptions/test/integration/status-title-served.test.ts                         |          12 |               12 | —              |
| packages/exceptions/test/integration/unserveable-status.test.ts                          |           8 |                8 | —              |
| packages/exceptions/test/unit/barrel-exports.test.ts                                     |           3 |                3 | —              |
| packages/exceptions/test/unit/error-formatter.test.ts                                    |          14 |               14 | —              |
| packages/exceptions/test/unit/error-handler.test.ts                                      |          40 |               40 | —              |
| packages/exceptions/test/unit/error-responder-impl.test.ts                               |           7 |                7 | —              |
| packages/exceptions/test/unit/error-responder-install.test.ts                            |           7 |                7 | —              |
| packages/exceptions/test/unit/exceptions.test.ts                                         |          23 |               23 | —              |
| packages/exceptions/test/unit/http-error.test.ts                                         |          10 |               10 | —              |
| packages/exceptions/test/unit/problem-details.test.ts                                    |          13 |               13 | —              |
| packages/exceptions/test/unit/rfc7807-formatter.test.ts                                  |          15 |               15 | —              |
| packages/exceptions/test/unit/rfc9457-formatter.test.ts                                  |          14 |               14 | —              |
| packages/exceptions/test/unit/status-hint.test.ts                                        |          11 |               11 | —              |
| packages/feature-flags-plugin/test/e2e/feature-flags-e2e.test.ts                         |           3 |                3 | —              |
| packages/feature-flags-plugin/test/integration/feature-flags-integration.test.ts         |           5 |                5 | —              |
| packages/feature-flags-plugin/test/integration/launchdarkly-real-import.test.ts          |           2 |                2 | —              |
| packages/feature-flags-plugin/test/unit/barrel-exports.test.ts                           |          10 |               10 | —              |
| packages/feature-flags-plugin/test/unit/config-provider.test.ts                          |           7 |                7 | —              |
| packages/feature-flags-plugin/test/unit/database-provider.test.ts                        |          12 |               12 | —              |
| packages/feature-flags-plugin/test/unit/feature-flag-middleware.test.ts                  |          12 |               12 | —              |
| packages/feature-flags-plugin/test/unit/feature-flags-plugin.test.ts                     |          15 |               15 | —              |
| packages/feature-flags-plugin/test/unit/feature-flags-service.test.ts                    |          10 |               10 | —              |
| packages/feature-flags-plugin/test/unit/flag-evaluator.test.ts                           |          27 |               27 | —              |
| packages/feature-flags-plugin/test/unit/launchdarkly-module.test.ts                      |           8 |                8 | —              |
| packages/feature-flags-plugin/test/unit/launchdarkly-provider.test.ts                    |          31 |               31 | —              |
| packages/feature-flags-plugin/test/unit/memory-provider.test.ts                          |           8 |                8 | —              |
| packages/graphql-plugin/test/e2e/graphql-body-cap-e2e.test.ts                            |           5 |                5 | —              |
| packages/graphql-plugin/test/e2e/graphql-http-e2e.test.ts                                |          17 |               17 | —              |
| packages/graphql-plugin/test/e2e/graphql-real-subscription-e2e.test.ts                   |           4 |                4 | —              |
| packages/graphql-plugin/test/e2e/graphql-schema-first-e2e.test.ts                        |          11 |               11 | —              |
| packages/graphql-plugin/test/e2e/graphql-security-e2e.test.ts                            |          10 |               10 | —              |
| packages/graphql-plugin/test/e2e/graphql-sse-e2e.test.ts                                 |           4 |                4 | —              |
| packages/graphql-plugin/test/e2e/graphql-ws-e2e.test.ts                                  |           3 |                3 | —              |
| packages/graphql-plugin/test/e2e/graphql-ws-lifecycle-e2e.test.ts                        |           4 |                4 | —              |
| packages/graphql-plugin/test/integration/graphql-integration.test.ts                     |          10 |               10 | —              |
| packages/graphql-plugin/test/integration/graphql-subscriptions-http.test.ts              |           5 |                5 | —              |
| packages/graphql-plugin/test/integration/graphql-ws-context.test.ts                      |           2 |                2 | —              |
| packages/graphql-plugin/test/unit/apq-resolver.test.ts                                   |          14 |               14 | —              |
| packages/graphql-plugin/test/unit/attach-resolvers.test.ts                               |          16 |               16 | —              |
| packages/graphql-plugin/test/unit/barrel-exports.test.ts                                 |           9 |                9 | —              |
| packages/graphql-plugin/test/unit/batch-handler.test.ts                                  |           7 |                7 | —              |
| packages/graphql-plugin/test/unit/body-refusal.test.ts                                   |           9 |                9 | —              |
| packages/graphql-plugin/test/unit/build-schema.test.ts                                   |           7 |                7 | —              |
| packages/graphql-plugin/test/unit/depth-limit.test.ts                                    |           9 |                9 | —              |
| packages/graphql-plugin/test/unit/document-cache.test.ts                                 |          10 |               10 | —              |
| packages/graphql-plugin/test/unit/executor.test.ts                                       |          17 |               17 | —              |
| packages/graphql-plugin/test/unit/graphiql.test.ts                                       |           5 |                5 | —              |
| packages/graphql-plugin/test/unit/graphql-errors.test.ts                                 |           7 |                7 | —              |
| packages/graphql-plugin/test/unit/graphql-handler-apq.test.ts                            |          20 |               20 | —              |
| packages/graphql-plugin/test/unit/graphql-handler.test.ts                                |          18 |               18 | —              |
| packages/graphql-plugin/test/unit/graphql-loader.test.ts                                 |           5 |                5 | —              |
| packages/graphql-plugin/test/unit/graphql-plugin-wiring.test.ts                          |          15 |               15 | —              |
| packages/graphql-plugin/test/unit/graphql-plugin.test.ts                                 |          25 |               25 | —              |
| packages/graphql-plugin/test/unit/graphql-real-import.test.ts                            |           2 |                2 | —              |
| packages/graphql-plugin/test/unit/graphql-runtime-types.test.ts                          |           1 |                1 | —              |
| packages/graphql-plugin/test/unit/graphql-service.test.ts                                |          31 |               31 | —              |
| packages/graphql-plugin/test/unit/graphql-sse-handler.test.ts                            |          26 |               26 | —              |
| packages/graphql-plugin/test/unit/graphql-ws-handler.test.ts                             |          35 |               39 | added-proof    |
| packages/graphql-plugin/test/unit/mask-errors.test.ts                                    |          10 |               10 | —              |
| packages/graphql-plugin/test/unit/max-nodes.test.ts                                      |          24 |               24 | —              |
| packages/graphql-plugin/test/unit/media-type.test.ts                                     |           9 |                9 | —              |
| packages/graphql-plugin/test/unit/persisted-query.test.ts                                |          17 |               17 | —              |
| packages/graphql-plugin/test/unit/request-parser.test.ts                                 |          18 |               18 | —              |
| packages/graphql-plugin/test/unit/scalar-resolvers.test.ts                               |           7 |                7 | —              |
| packages/graphql-plugin/test/unit/sse-frame.test.ts                                      |           7 |                7 | —              |
| packages/graphql-plugin/test/unit/subscribe.test.ts                                      |          10 |               10 | —              |
| packages/graphql-plugin/test/unit/ws-protocol.test.ts                                    |          20 |               20 | —              |
| packages/grpc-plugin/test/e2e/grpc-half-open-e2e.test.ts                                 |           6 |                6 | —              |
| packages/grpc-plugin/test/e2e/grpc-handler-logging-e2e.test.ts                           |           5 |                5 | —              |
| packages/grpc-plugin/test/e2e/grpc-reflection-e2e.test.ts                                |          14 |               14 | —              |
| packages/grpc-plugin/test/e2e/grpc-streaming-e2e.test.ts                                 |           3 |                3 | —              |
| packages/grpc-plugin/test/e2e/grpc-unary-e2e.test.ts                                     |           3 |                3 | —              |
| packages/grpc-plugin/test/integration/grpc-integration.test.ts                           |          10 |               10 | —              |
| packages/grpc-plugin/test/integration/grpc-pipeline.test.ts                              |           8 |                8 | —              |
| packages/grpc-plugin/test/integration/handler-error-logging.test.ts                      |           3 |                3 | —              |
| packages/grpc-plugin/test/integration/health-agreement.test.ts                           |           2 |                2 | —              |
| packages/grpc-plugin/test/unit/barrel-exports.test.ts                                    |           5 |                5 | —              |
| packages/grpc-plugin/test/unit/connect-loader.test.ts                                    |          13 |               13 | —              |
| packages/grpc-plugin/test/unit/connect-real-import.test.ts                               |           5 |                5 | —              |
| packages/grpc-plugin/test/unit/connect-router-builder.test.ts                            |          18 |               18 | —              |
| packages/grpc-plugin/test/unit/descriptor-registry.test.ts                               |          12 |               12 | —              |
| packages/grpc-plugin/test/unit/embedded-descriptors.test.ts                              |           7 |                7 | —              |
| packages/grpc-plugin/test/unit/grpc-binary-refusal.test.ts                               |           7 |                7 | —              |
| packages/grpc-plugin/test/unit/grpc-health-bridge.test.ts                                |          14 |               14 | —              |
| packages/grpc-plugin/test/unit/grpc-plugin.test.ts                                       |          10 |               10 | —              |
| packages/grpc-plugin/test/unit/grpc-reflection.test.ts                                   |          17 |               17 | —              |
| packages/grpc-plugin/test/unit/grpc-service.test.ts                                      |          18 |               18 | —              |
| packages/grpc-plugin/test/unit/handler-streaming-error-logging.test.ts                   |          14 |               15 | added-proof    |
| packages/grpc-plugin/test/unit/no-rpc-handler.test.ts                                    |           3 |                3 | —              |
| packages/grpc-plugin/test/unit/rpc-dispatcher.test.ts                                    |          18 |               18 | —              |
| packages/health-plugin/test/integration/health-integration.test.ts                       |           9 |                9 | —              |
| packages/health-plugin/test/integration/indicator-factories.test.ts                      |           1 |                1 | —              |
| packages/health-plugin/test/unit/barrel-exports.test.ts                                  |           4 |                4 | —              |
| packages/health-plugin/test/unit/health-observation-collector.test.ts                    |          21 |               21 | —              |
| packages/health-plugin/test/unit/health-observation-options.test.ts                      |          12 |               12 | —              |
| packages/health-plugin/test/unit/health-plugin-factories.test.ts                         |           5 |                5 | —              |
| packages/health-plugin/test/unit/health-plugin.test.ts                                   |          28 |               28 | —              |
| packages/health-plugin/test/unit/health-service.test.ts                                  |          51 |               51 | —              |
| packages/health-plugin/test/unit/health-status.test.ts                                   |           6 |                6 | —              |
| packages/health-plugin/test/unit/http-indicator.test.ts                                  |          13 |               13 | —              |
| packages/health-plugin/test/unit/self-indicator.test.ts                                  |           6 |                6 | —              |
| packages/http-security-plugin/test/integration/http-security-integration.test.ts         |           6 |                6 | —              |
| packages/http-security-plugin/test/unit/barrel-exports.test.ts                           |           7 |                7 | —              |
| packages/http-security-plugin/test/unit/cors-middleware.test.ts                          |          31 |               31 | —              |
| packages/http-security-plugin/test/unit/csrf-middleware.test.ts                          |          21 |               21 | —              |
| packages/http-security-plugin/test/unit/http-security-plugin.test.ts                     |          12 |               12 | —              |
| packages/http-security-plugin/test/unit/ip-security-middleware.test.ts                   |           9 |                9 | —              |
| packages/http-security-plugin/test/unit/ip-security-proxy.test.ts                        |          29 |               29 | —              |
| packages/http-security-plugin/test/unit/request-size-middleware.test.ts                  |          12 |               12 | —              |
| packages/http-security-plugin/test/unit/security-headers-middleware.test.ts              |          16 |               16 | —              |
| packages/idempotency-plugin/test/integration/crash-redelivery.test.ts                    |           1 |                1 | —              |
| packages/idempotency-plugin/test/integration/decorator.test.ts                           |           2 |                2 | —              |
| packages/idempotency-plugin/test/integration/http-kernel.test.ts                         |           8 |                8 | —              |
| packages/idempotency-plugin/test/integration/idempotency-roundtrip.test.ts               |           2 |                2 | —              |
| packages/idempotency-plugin/test/integration/messaging-fanout.test.ts                    |           3 |                3 | —              |
| packages/idempotency-plugin/test/integration/messaging-ingress.test.ts                   |           1 |                1 | —              |
| packages/idempotency-plugin/test/integration/queue-ingress.test.ts                       |           3 |                3 | —              |
| packages/idempotency-plugin/test/integration/redis-real.test.ts                          |          13 |               19 | deno-uncounted |
| packages/idempotency-plugin/test/integration/within-d1.test.ts                           |           3 |                3 | —              |
| packages/idempotency-plugin/test/integration/within-kernel.test.ts                       |           5 |                5 | —              |
| packages/idempotency-plugin/test/integration/within-plugin.test.ts                       |          14 |               14 | —              |
| packages/idempotency-plugin/test/integration/within-real.test.ts                         |           7 |               26 | deno-uncounted |
| packages/idempotency-plugin/test/unit/barrel-exports.test.ts                             |           4 |                4 | —              |
| packages/idempotency-plugin/test/unit/errors.test.ts                                     |           3 |                3 | —              |
| packages/idempotency-plugin/test/unit/fingerprint.test.ts                                |          18 |               18 | —              |
| packages/idempotency-plugin/test/unit/hash.test.ts                                       |           5 |                5 | —              |
| packages/idempotency-plugin/test/unit/http-middleware-extra.test.ts                      |          11 |               11 | —              |
| packages/idempotency-plugin/test/unit/http-middleware.test.ts                            |          19 |               19 | —              |
| packages/idempotency-plugin/test/unit/idempotency-plugin.test.ts                         |           8 |                8 | —              |
| packages/idempotency-plugin/test/unit/idempotency-service.test.ts                        |           3 |                3 | —              |
| packages/idempotency-plugin/test/unit/idempotent-ingress.test.ts                         |           3 |                3 | —              |
| packages/idempotency-plugin/test/unit/idempotent.test.ts                                 |           8 |                8 | —              |
| packages/idempotency-plugin/test/unit/indicator.test.ts                                  |           5 |                5 | —              |
| packages/idempotency-plugin/test/unit/ingress-behavior-extra.test.ts                     |           7 |                7 | —              |
| packages/idempotency-plugin/test/unit/ingress-behavior.test.ts                           |          12 |               13 | added-proof    |
| packages/idempotency-plugin/test/unit/key.test.ts                                        |           6 |                6 | —              |
| packages/idempotency-plugin/test/unit/memory-store.test.ts                               |          20 |               20 | —              |
| packages/idempotency-plugin/test/unit/no-exactly-once.test.ts                            |           2 |                2 | —              |
| packages/idempotency-plugin/test/unit/options.test.ts                                    |          26 |               26 | —              |
| packages/idempotency-plugin/test/unit/record-extra.test.ts                               |           4 |                4 | —              |
| packages/idempotency-plugin/test/unit/record.test.ts                                     |          15 |               15 | —              |
| packages/idempotency-plugin/test/unit/redis-client.test.ts                               |           6 |                6 | —              |
| packages/idempotency-plugin/test/unit/redis-store.test.ts                                |          12 |               12 | —              |
| packages/idempotency-plugin/test/unit/resolve-store.test.ts                              |           6 |                7 | added-proof    |
| packages/idempotency-plugin/test/unit/result-codec.test.ts                               |           9 |                9 | —              |
| packages/idempotency-plugin/test/unit/safe-log.test.ts                                   |           4 |                4 | —              |
| packages/idempotency-plugin/test/unit/within-errors.test.ts                              |          13 |               13 | —              |
| packages/idempotency-plugin/test/unit/within-options.test.ts                             |          10 |               10 | —              |
| packages/idempotency-plugin/test/unit/within.test.ts                                     |          20 |               20 | —              |
| packages/kernel/test/e2e/form-handler.test.ts                                            |           2 |                2 | —              |
| packages/kernel/test/integration/application-stop.test.ts                                |           7 |                8 | added-proof    |
| packages/kernel/test/integration/application.test.ts                                     |          80 |               82 | added-proof    |
| packages/kernel/test/integration/catchall-vs-plugin-routes.test.ts                       |           3 |                3 | —              |
| packages/kernel/test/integration/detached-fetch.test.ts                                  |           2 |                2 | —              |
| packages/kernel/test/integration/diagnostics-activation.test.ts                          |           6 |                6 | —              |
| packages/kernel/test/integration/diagnostics-canaries.test.ts                            |           3 |                3 | —              |
| packages/kernel/test/integration/diagnostics-equivalence.test.ts                         |           4 |                4 | —              |
| packages/kernel/test/integration/diagnostics-execution.test.ts                           |          10 |               10 | —              |
| packages/kernel/test/integration/diagnostics-fault-isolation.test.ts                     |           4 |                4 | —              |
| packages/kernel/test/integration/diagnostics-lifecycle.test.ts                           |           7 |                9 | added-proof    |
| packages/kernel/test/integration/diagnostics-protocol-boundaries.test.ts                 |           5 |                5 | —              |
| packages/kernel/test/integration/diagnostics-registration.test.ts                        |           7 |                7 | —              |
| packages/kernel/test/integration/error-format-terminal.test.ts                           |           4 |                4 | —              |
| packages/kernel/test/integration/form-body-producers.test.ts                             |           3 |                3 | —              |
| packages/kernel/test/integration/hono-dispatch-parity.test.ts                            |           6 |                6 | —              |
| packages/kernel/test/integration/inject-multipart-blob.test.ts                           |           1 |                1 | —              |
| packages/kernel/test/integration/inject-multipart-form.test.ts                           |           1 |                1 | —              |
| packages/kernel/test/integration/malformed-body.test.ts                                  |           3 |                3 | —              |
| packages/kernel/test/integration/missing-capability-message.test.ts                      |           5 |                5 | —              |
| packages/kernel/test/integration/pipeline-runs-for-upgrade.test.ts                       |          10 |               10 | —              |
| packages/kernel/test/integration/pre-pipeline-error-format.test.ts                       |          14 |               14 | —              |
| packages/kernel/test/integration/registry-seal.test.ts                                   |           3 |                3 | —              |
| packages/kernel/test/integration/request-identity.test.ts                                |           1 |                1 | —              |
| packages/kernel/test/integration/route-ownership.test.ts                                 |           1 |                1 | —              |
| packages/kernel/test/integration/thenable-handler.test.ts                                |           2 |                2 | —              |
| packages/kernel/test/integration/unhandled-error-logging.test.ts                         |           1 |                1 | —              |
| packages/kernel/test/integration/upgrade-principal.test.ts                               |           3 |                3 | —              |
| packages/kernel/test/unit/application-unregister.test.ts                                 |          11 |               11 | —              |
| packages/kernel/test/unit/barrel-exports.test.ts                                         |           2 |                2 | —              |
| packages/kernel/test/unit/diagnostics-buffer.test.ts                                     |          12 |               12 | —              |
| packages/kernel/test/unit/diagnostics-contract.test.ts                                   |          26 |               26 | —              |
| packages/kernel/test/unit/diagnostics-projection.test.ts                                 |          18 |               18 | —              |
| packages/kernel/test/unit/execute-chain.test.ts                                          |          10 |               10 | —              |
| packages/kernel/test/unit/hono-router-bridge.test.ts                                     |          11 |               11 | —              |
| packages/kernel/test/unit/inject-body-shapes.test.ts                                     |          18 |               18 | —              |
| packages/kernel/test/unit/lifecycle-manager.test.ts                                      |          10 |               10 | —              |
| packages/kernel/test/unit/middleware-pipeline.test.ts                                    |          11 |               11 | —              |
| packages/kernel/test/unit/plugin-resolver.test.ts                                        |          15 |               15 | —              |
| packages/kernel/test/unit/registry/service-registry-current.test.ts                      |          10 |               10 | —              |
| packages/kernel/test/unit/registry/service-registry-seal.test.ts                         |           3 |                3 | —              |
| packages/kernel/test/unit/request-context-raw.test.ts                                    |           5 |                5 | —              |
| packages/kernel/test/unit/request-context.test.ts                                        |           9 |               10 | added-proof    |
| packages/kernel/test/unit/response.test.ts                                               |          24 |               24 | —              |
| packages/kernel/test/unit/route-matcher.test.ts                                          |          10 |               10 | —              |
| packages/kernel/test/unit/router-fast-path.test.ts                                       |           7 |                7 | —              |
| packages/kernel/test/unit/router-wildcard-precedence.test.ts                             |          10 |               10 | —              |
| packages/kernel/test/unit/router.test.ts                                                 |          37 |               37 | —              |
| packages/kernel/test/unit/service-registry.test.ts                                       |          30 |               30 | —              |
| packages/kernel/test/unit/upgrade-intent.test.ts                                         |           5 |                5 | —              |
| packages/localization-plugin/test/e2e/format-browser-safe.test.ts                        |           3 |                3 | —              |
| packages/localization-plugin/test/integration/cache-vary.test.ts                         |           5 |                5 | —              |
| packages/localization-plugin/test/integration/catalogue-route.test.ts                    |           5 |                5 | —              |
| packages/localization-plugin/test/integration/headers.test.ts                            |           7 |                7 | —              |
| packages/localization-plugin/test/integration/render.test.ts                             |           3 |                3 | —              |
| packages/localization-plugin/test/integration/with-tenancy.test.ts                       |           3 |                3 | —              |
| packages/localization-plugin/test/unit/accept-language.test.ts                           |           8 |                8 | —              |
| packages/localization-plugin/test/unit/barrel-exports.test.ts                            |           3 |                3 | —              |
| packages/localization-plugin/test/unit/catalogue-validation.test.ts                      |          21 |               21 | —              |
| packages/localization-plugin/test/unit/format.test.ts                                    |          20 |               20 | —              |
| packages/localization-plugin/test/unit/locale-middleware.test.ts                         |          25 |               25 | —              |
| packages/localization-plugin/test/unit/localization-plugin.test.ts                       |          17 |               17 | —              |
| packages/localization-plugin/test/unit/localizer.test.ts                                 |          21 |               21 | —              |
| packages/localization-plugin/test/unit/negotiate.test.ts                                 |          13 |               13 | —              |
| packages/logger-plugin/test/integration/log-trace-join.test.ts                           |           1 |                1 | —              |
| packages/logger-plugin/test/integration/logger-plugin.test.ts                            |          16 |               16 | —              |
| packages/logger-plugin/test/integration/no-telemetry-unchanged.test.ts                   |           4 |                4 | —              |
| packages/logger-plugin/test/integration/pino-error-metadata.test.ts                      |           3 |                3 | —              |
| packages/logger-plugin/test/unit/barrel-exports.test.ts                                  |           7 |                7 | —              |
| packages/logger-plugin/test/unit/console-logger-error-metadata.test.ts                   |           3 |                3 | —              |
| packages/logger-plugin/test/unit/console-logger.test.ts                                  |          34 |               34 | —              |
| packages/logger-plugin/test/unit/noop-logger.test.ts                                     |           6 |                6 | —              |
| packages/logger-plugin/test/unit/normalize-metadata.test.ts                              |           8 |                8 | —              |
| packages/logger-plugin/test/unit/pino-logger.test.ts                                     |          16 |               16 | —              |
| packages/logger-plugin/test/unit/redaction-defaults-casing.test.ts                       |           3 |                3 | —              |
| packages/logger-plugin/test/unit/redaction-per-field.test.ts                             |           1 |                1 | —              |
| packages/logger-plugin/test/unit/request-logger.test.ts                                  |          13 |               13 | —              |
| packages/logger-plugin/test/unit/safe-stringify.test.ts                                  |          13 |               13 | —              |
| packages/logger-plugin/test/unit/trace-enriched-logger.test.ts                           |          13 |               13 | —              |
| packages/mail-plugin/test/integration/mail-integration.test.ts                           |           2 |                2 | —              |
| packages/mail-plugin/test/integration/mail-view-rendering.test.ts                        |           6 |                6 | —              |
| packages/mail-plugin/test/integration/outage-real.test.ts                                |           1 |                1 | —              |
| packages/mail-plugin/test/unit/barrel-exports.test.ts                                    |           1 |                1 | —              |
| packages/mail-plugin/test/unit/log-provider.test.ts                                      |           3 |                3 | —              |
| packages/mail-plugin/test/unit/mail-plugin.test.ts                                       |          12 |               12 | —              |
| packages/mail-plugin/test/unit/mail-service-health.test.ts                               |          10 |               10 | —              |
| packages/mail-plugin/test/unit/mail-service.test.ts                                      |           7 |                7 | —              |
| packages/mail-plugin/test/unit/providers/log-health.test.ts                              |           1 |                1 | —              |
| packages/mail-plugin/test/unit/providers/sendgrid-health.test.ts                         |           4 |                4 | —              |
| packages/mail-plugin/test/unit/providers/ses-health.test.ts                              |           4 |                4 | —              |
| packages/mail-plugin/test/unit/providers/smtp-health.test.ts                             |           4 |                4 | —              |
| packages/mail-plugin/test/unit/sendgrid-provider.test.ts                                 |           6 |                6 | —              |
| packages/mail-plugin/test/unit/ses-provider.test.ts                                      |          10 |               10 | —              |
| packages/mail-plugin/test/unit/shape.test.ts                                             |           2 |                2 | —              |
| packages/mail-plugin/test/unit/smtp-provider.test.ts                                     |          10 |               10 | —              |
| packages/mail-plugin/test/unit/template-engine.test.ts                                   |          17 |               17 | —              |
| packages/mail-plugin/test/unit/template-shape.test.ts                                    |           1 |                1 | —              |
| packages/messaging-plugin/test/e2e/pubsub-emulator.test.ts                               |           8 |                8 | —              |
| packages/messaging-plugin/test/e2e/service-bus-emulator.test.ts                          |           6 |                6 | —              |
| packages/messaging-plugin/test/integration/connection-errors-real.test.ts                |           2 |                2 | —              |
| packages/messaging-plugin/test/integration/consumer-retry-real.test.ts                   |          14 |               14 | —              |
| packages/messaging-plugin/test/integration/declared-subscription-failure.test.ts         |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/durability-real.test.ts                       |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/header-conformance.test.ts                    |          46 |               46 | —              |
| packages/messaging-plugin/test/integration/inbox-backends-real.test.ts                   |           4 |                4 | —              |
| packages/messaging-plugin/test/integration/inbox-plugin.test.ts                          |           9 |                9 | —              |
| packages/messaging-plugin/test/integration/inbox-real.test.ts                            |           3 |               13 | deno-uncounted |
| packages/messaging-plugin/test/integration/inbox-workers.test.ts                         |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/integration-events-rabbitmq-real.test.ts      |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/integration-events.test.ts                    |           7 |                7 | —              |
| packages/messaging-plugin/test/integration/kafka-real.test.ts                            |           5 |                5 | —              |
| packages/messaging-plugin/test/integration/messaging-integration.test.ts                 |          11 |               11 | —              |
| packages/messaging-plugin/test/integration/messaging-telemetry.test.ts                   |           7 |                7 | —              |
| packages/messaging-plugin/test/integration/nats-real.test.ts                             |           9 |                9 | —              |
| packages/messaging-plugin/test/integration/no-options-unchanged.test.ts                  |           4 |                4 | —              |
| packages/messaging-plugin/test/integration/outage-real.test.ts                           |           5 |                5 | —              |
| packages/messaging-plugin/test/integration/outbox-backends-real.test.ts                  |           5 |                8 | deno-uncounted |
| packages/messaging-plugin/test/integration/outbox-fencing-real.test.ts                   |           3 |                9 | deno-uncounted |
| packages/messaging-plugin/test/integration/outbox-plugin.test.ts                         |          22 |               22 | —              |
| packages/messaging-plugin/test/integration/outbox-real.test.ts                           |           2 |                6 | deno-uncounted |
| packages/messaging-plugin/test/integration/outbox-trace-real.test.ts                     |           3 |                3 | —              |
| packages/messaging-plugin/test/integration/outbox-watermark-real.test.ts                 |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/outbox-workers.test.ts                        |           6 |                6 | —              |
| packages/messaging-plugin/test/integration/rabbitmq-confirm-window-real.test.ts          |           2 |                2 | —              |
| packages/messaging-plugin/test/integration/rabbitmq-retry-options.test.ts                |           2 |                2 | —              |
| packages/messaging-plugin/test/integration/rabbitmq-trace-real.test.ts                   |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/rabbitmq-v4-declaration.test.ts               |           2 |                2 | —              |
| packages/messaging-plugin/test/integration/redis-redelivery-real.test.ts                 |           5 |                5 | —              |
| packages/messaging-plugin/test/integration/redis-retry-options.test.ts                   |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/redis-trace-real.test.ts                      |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/register-time-publish.test.ts                 |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/service-bus-health-race.test.ts               |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/service-bus-outage-real.test.ts               |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/subscription-registration.test.ts             |          12 |               12 | —              |
| packages/messaging-plugin/test/integration/tenant-behaviour.test.ts                      |           1 |                1 | —              |
| packages/messaging-plugin/test/integration/trace-continuity-real.test.ts                 |           2 |                2 | —              |
| packages/messaging-plugin/test/unit/barrel-exports.test.ts                               |           7 |                7 | —              |
| packages/messaging-plugin/test/unit/brokers/custom-adapter-health.test.ts                |           6 |                6 | —              |
| packages/messaging-plugin/test/unit/brokers/in-memory-broker-health.test.ts              |           3 |                3 | —              |
| packages/messaging-plugin/test/unit/brokers/kafka-broker-health.test.ts                  |           4 |                4 | —              |
| packages/messaging-plugin/test/unit/brokers/nats-broker-health.test.ts                   |           7 |                7 | —              |
| packages/messaging-plugin/test/unit/brokers/pubsub-broker-health.test.ts                 |           4 |                4 | —              |
| packages/messaging-plugin/test/unit/brokers/rabbitmq-broker-health.test.ts               |          22 |               22 | —              |
| packages/messaging-plugin/test/unit/brokers/reconnect.test.ts                            |          17 |               17 | —              |
| packages/messaging-plugin/test/unit/brokers/redis-streams-broker-health.test.ts          |           4 |                4 | —              |
| packages/messaging-plugin/test/unit/brokers/service-bus-broker-health.test.ts            |           8 |                8 | —              |
| packages/messaging-plugin/test/unit/chain-gate-timeout.test.ts                           |           6 |                6 | —              |
| packages/messaging-plugin/test/unit/custom-adapter.test.ts                               |          14 |               14 | —              |
| packages/messaging-plugin/test/unit/describe-error.test.ts                               |           7 |                7 | —              |
| packages/messaging-plugin/test/unit/events-messaging-bridge.test.ts                      |          21 |               21 | —              |
| packages/messaging-plugin/test/unit/header-normalize.test.ts                             |          11 |               11 | —              |
| packages/messaging-plugin/test/unit/in-memory-broker.test.ts                             |          15 |               16 | added-proof    |
| packages/messaging-plugin/test/unit/in-memory-dispatch-timing.test.ts                    |          11 |               11 | —              |
| packages/messaging-plugin/test/unit/inbox.test.ts                                        |           7 |                7 | —              |
| packages/messaging-plugin/test/unit/inbox/barrel-exports.test.ts                         |           3 |                3 | —              |
| packages/messaging-plugin/test/unit/inbox/inbox-delivery.test.ts                         |          14 |               14 | —              |
| packages/messaging-plugin/test/unit/inbox/inbox-failure.test.ts                          |          13 |               13 | —              |
| packages/messaging-plugin/test/unit/inbox/inbox-health.test.ts                           |           4 |                4 | —              |
| packages/messaging-plugin/test/unit/inbox/inbox-key.test.ts                              |           8 |                8 | —              |
| packages/messaging-plugin/test/unit/inbox/inbox-options.test.ts                          |          13 |               13 | —              |
| packages/messaging-plugin/test/unit/inbox/inbox-release.test.ts                          |          11 |               11 | —              |
| packages/messaging-plugin/test/unit/inbox/inbox-subscribe.test.ts                        |           9 |                9 | —              |
| packages/messaging-plugin/test/unit/inbox/inbox-types.test.ts                            |           5 |                5 | —              |
| packages/messaging-plugin/test/unit/inbox/readme-ddl.test.ts                             |           4 |                4 | —              |
| packages/messaging-plugin/test/unit/integration/definition.test.ts                       |          15 |               15 | —              |
| packages/messaging-plugin/test/unit/integration/envelope.test.ts                         |          31 |               31 | —              |
| packages/messaging-plugin/test/unit/integration/publish.test.ts                          |          15 |               15 | —              |
| packages/messaging-plugin/test/unit/integration/subscribe.test.ts                        |          12 |               12 | —              |
| packages/messaging-plugin/test/unit/json-serializer.test.ts                              |           7 |                7 | —              |
| packages/messaging-plugin/test/unit/kafka-broker.test.ts                                 |          65 |               65 | —              |
| packages/messaging-plugin/test/unit/kafka-real-import.test.ts                            |           1 |                1 | —              |
| packages/messaging-plugin/test/unit/messaging-errors.test.ts                             |           8 |                8 | —              |
| packages/messaging-plugin/test/unit/messaging-plugin.test.ts                             |          58 |               58 | —              |
| packages/messaging-plugin/test/unit/nats-broker.test.ts                                  |          59 |               59 | —              |
| packages/messaging-plugin/test/unit/nats-consumer-name.test.ts                           |          15 |               15 | —              |
| packages/messaging-plugin/test/unit/nats-real-import.test.ts                             |           1 |                1 | —              |
| packages/messaging-plugin/test/unit/outbox/barrel-exports.test.ts                        |           3 |                3 | —              |
| packages/messaging-plugin/test/unit/outbox/lap.test.ts                                   |           5 |                5 | —              |
| packages/messaging-plugin/test/unit/outbox/outbox-collector.test.ts                      |           5 |                5 | —              |
| packages/messaging-plugin/test/unit/outbox/outbox-crash.test.ts                          |           6 |                6 | —              |
| packages/messaging-plugin/test/unit/outbox/outbox-dispatch.test.ts                       |           8 |                8 | —              |
| packages/messaging-plugin/test/unit/outbox/outbox-health.test.ts                         |          13 |               13 | —              |
| packages/messaging-plugin/test/unit/outbox/outbox-options.test.ts                        |          85 |               85 | —              |
| packages/messaging-plugin/test/unit/outbox/outbox-overlap.test.ts                        |          12 |               12 | —              |
| packages/messaging-plugin/test/unit/outbox/outbox-release.test.ts                        |           4 |                4 | —              |
| packages/messaging-plugin/test/unit/outbox/outbox-retention.test.ts                      |           7 |                7 | —              |
| packages/messaging-plugin/test/unit/outbox/outbox-tenancy.test.ts                        |           6 |                6 | —              |
| packages/messaging-plugin/test/unit/outbox/outbox-write.test.ts                          |           8 |                8 | —              |
| packages/messaging-plugin/test/unit/outbox/position.test.ts                              |           8 |                8 | —              |
| packages/messaging-plugin/test/unit/outbox/precedence-parity.test.ts                     |           2 |                2 | —              |
| packages/messaging-plugin/test/unit/outbox/readme-ddl.test.ts                            |           4 |                4 | —              |
| packages/messaging-plugin/test/unit/outbox/record-codec.test.ts                          |          41 |               41 | —              |
| packages/messaging-plugin/test/unit/outbox/relay-blocking.test.ts                        |          19 |               19 | —              |
| packages/messaging-plugin/test/unit/outbox/relay-budget.test.ts                          |           9 |                9 | —              |
| packages/messaging-plugin/test/unit/outbox/relay-claim.test.ts                           |          23 |               23 | —              |
| packages/messaging-plugin/test/unit/outbox/relay-multi.test.ts                           |           2 |                2 | —              |
| packages/messaging-plugin/test/unit/outbox/relay-paging.test.ts                          |           9 |                9 | —              |
| packages/messaging-plugin/test/unit/outbox/relay-store-failure.test.ts                   |           6 |                6 | —              |
| packages/messaging-plugin/test/unit/pipelined-broker-consumer.test.ts                    |           4 |                4 | —              |
| packages/messaging-plugin/test/unit/pipelined-broker.test.ts                             |          13 |               13 | —              |
| packages/messaging-plugin/test/unit/plugin/messaging-plugin-health.test.ts               |           7 |                7 | —              |
| packages/messaging-plugin/test/unit/publish-options-validation.test.ts                   |          87 |               88 | added-proof    |
| packages/messaging-plugin/test/unit/pubsub-adapter.test.ts                               |          29 |               29 | —              |
| packages/messaging-plugin/test/unit/pubsub-broker-b6-lifecycle.test.ts                   |           5 |                5 | —              |
| packages/messaging-plugin/test/unit/pubsub-broker.test.ts                                |          40 |               40 | —              |
| packages/messaging-plugin/test/unit/rabbitmq-broker-queue-declaration.test.ts            |           4 |                4 | —              |
| packages/messaging-plugin/test/unit/rabbitmq-broker.test.ts                              |          31 |               31 | —              |
| packages/messaging-plugin/test/unit/rabbitmq-consumer-retry.test.ts                      |          68 |               68 | —              |
| packages/messaging-plugin/test/unit/rabbitmq-durability.test.ts                          |          20 |               20 | —              |
| packages/messaging-plugin/test/unit/raw-error-interpolation-audit.test.ts                |           1 |                1 | —              |
| packages/messaging-plugin/test/unit/redis-client-factory.test.ts                         |           1 |                1 | —              |
| packages/messaging-plugin/test/unit/redis-real-import.test.ts                            |           1 |                1 | —              |
| packages/messaging-plugin/test/unit/redis-redelivery.test.ts                             |          19 |               19 | —              |
| packages/messaging-plugin/test/unit/redis-streams-broker-timers.test.ts                  |           2 |                2 | —              |
| packages/messaging-plugin/test/unit/redis-streams-broker.test.ts                         |          35 |               37 | added-proof    |
| packages/messaging-plugin/test/unit/request-reply-core.test.ts                           |          27 |               27 | —              |
| packages/messaging-plugin/test/unit/service-bus-adapter.test.ts                          |          36 |               36 | —              |
| packages/messaging-plugin/test/unit/service-bus-broker-b6-lifecycle.test.ts              |           4 |                4 | —              |
| packages/messaging-plugin/test/unit/service-bus-broker.test.ts                           |          37 |               38 | added-proof    |
| packages/messaging-plugin/test/unit/service-bus-probe-tristate.test.ts                   |           4 |                4 | —              |
| packages/messaging-plugin/test/unit/service-bus-reachability.test.ts                     |          20 |               20 | —              |
| packages/messaging-plugin/test/unit/settlement-behavior.test.ts                          |           7 |                7 | —              |
| packages/messaging-plugin/test/unit/traced-broker.test.ts                                |          10 |               10 | —              |
| packages/metrics-plugin/test/integration/metrics-excludes-probes.test.ts                 |           1 |                1 | —              |
| packages/metrics-plugin/test/integration/metrics-integration.test.ts                     |           7 |                7 | —              |
| packages/metrics-plugin/test/unit/barrel-exports.test.ts                                 |          17 |               17 | —              |
| packages/metrics-plugin/test/unit/base-metric.test.ts                                    |          18 |               18 | —              |
| packages/metrics-plugin/test/unit/counter.test.ts                                        |           8 |                8 | —              |
| packages/metrics-plugin/test/unit/gauge.test.ts                                          |          24 |               24 | —              |
| packages/metrics-plugin/test/unit/histogram.test.ts                                      |          32 |               32 | —              |
| packages/metrics-plugin/test/unit/http-collector-exclusions.test.ts                      |           5 |                5 | —              |
| packages/metrics-plugin/test/unit/http-collector.test.ts                                 |          10 |               10 | —              |
| packages/metrics-plugin/test/unit/metrics-plugin.test.ts                                 |          17 |               17 | —              |
| packages/metrics-plugin/test/unit/metrics-registry.test.ts                               |           7 |                7 | —              |
| packages/metrics-plugin/test/unit/metrics-service.test.ts                                |          37 |               37 | —              |
| packages/metrics-plugin/test/unit/prometheus-renderer.test.ts                            |          50 |               51 | added-proof    |
| packages/metrics-plugin/test/unit/summary.test.ts                                        |          18 |               18 | —              |
| packages/multi-tenancy-plugin/test/integration/database-bridge.test.ts                   |           1 |                1 | —              |
| packages/multi-tenancy-plugin/test/integration/multi-tenancy-integration.test.ts         |           3 |                3 | —              |
| packages/multi-tenancy-plugin/test/integration/multi-tenancy-kernel.test.ts              |           5 |                5 | —              |
| packages/multi-tenancy-plugin/test/integration/required-tenant-probes.test.ts            |           1 |                1 | —              |
| packages/multi-tenancy-plugin/test/integration/tenant-binding-order.test.ts              |           3 |                3 | —              |
| packages/multi-tenancy-plugin/test/unit/barrel-exports.test.ts                           |           3 |                3 | —              |
| packages/multi-tenancy-plugin/test/unit/column-strategy.test.ts                          |           3 |                3 | —              |
| packages/multi-tenancy-plugin/test/unit/ctx-free-members.test.ts                         |           3 |                3 | —              |
| packages/multi-tenancy-plugin/test/unit/database-strategy.test.ts                        |           3 |                3 | —              |
| packages/multi-tenancy-plugin/test/unit/errors.test.ts                                   |           5 |                5 | —              |
| packages/multi-tenancy-plugin/test/unit/header-resolver.test.ts                          |          10 |               10 | —              |
| packages/multi-tenancy-plugin/test/unit/isolation-strategy-warning.test.ts               |           5 |                5 | —              |
| packages/multi-tenancy-plugin/test/unit/jwt-resolver-warning.test.ts                     |           5 |                5 | —              |
| packages/multi-tenancy-plugin/test/unit/jwt-resolver.test.ts                             |           7 |                7 | —              |
| packages/multi-tenancy-plugin/test/unit/memory-tenant-store.test.ts                      |          24 |               24 | —              |
| packages/multi-tenancy-plugin/test/unit/multi-tenancy-plugin.test.ts                     |          31 |               31 | —              |
| packages/multi-tenancy-plugin/test/unit/multi-tenancy-service.test.ts                    |          11 |               11 | —              |
| packages/multi-tenancy-plugin/test/unit/path-resolver.test.ts                            |          11 |               11 | —              |
| packages/multi-tenancy-plugin/test/unit/schema-strategy.test.ts                          |           3 |                3 | —              |
| packages/multi-tenancy-plugin/test/unit/subdomain-resolver.test.ts                       |          15 |               15 | —              |
| packages/multi-tenancy-plugin/test/unit/tenant-middleware.test.ts                        |          23 |               23 | —              |
| packages/multi-tenancy-plugin/test/unit/tenant-repository.test.ts                        |          13 |               13 | —              |
| packages/notification-plugin/test/integration/notification-integration.test.ts           |           4 |                4 | —              |
| packages/notification-plugin/test/unit/barrel-exports.test.ts                            |          14 |               14 | —              |
| packages/notification-plugin/test/unit/default-http.test.ts                              |           2 |                2 | —              |
| packages/notification-plugin/test/unit/email-channel.test.ts                             |           3 |                3 | —              |
| packages/notification-plugin/test/unit/fcm-provider.test.ts                              |           7 |                7 | —              |
| packages/notification-plugin/test/unit/notification-health.test.ts                       |           9 |                9 | —              |
| packages/notification-plugin/test/unit/notification-plugin.test.ts                       |          18 |               18 | —              |
| packages/notification-plugin/test/unit/notification-service.test.ts                      |           7 |                7 | —              |
| packages/notification-plugin/test/unit/pem.test.ts                                       |           6 |                6 | —              |
| packages/notification-plugin/test/unit/push-channel.test.ts                              |           3 |                3 | —              |
| packages/notification-plugin/test/unit/send-settled.test.ts                              |           6 |                6 | —              |
| packages/notification-plugin/test/unit/service-account-token-source.test.ts              |          11 |               11 | —              |
| packages/notification-plugin/test/unit/slack-channel.test.ts                             |           3 |                3 | —              |
| packages/notification-plugin/test/unit/slack-provider.test.ts                            |           6 |                6 | —              |
| packages/notification-plugin/test/unit/sms-channel.test.ts                               |           2 |                2 | —              |
| packages/notification-plugin/test/unit/twilio-provider.test.ts                           |           5 |                5 | —              |
| packages/openapi-plugin/test/integration/derive-request-schemas.test.ts                  |           7 |                7 | —              |
| packages/openapi-plugin/test/integration/derive-response-status.test.ts                  |           8 |                8 | —              |
| packages/openapi-plugin/test/integration/openapi-integration.test.ts                     |          23 |               23 | —              |
| packages/openapi-plugin/test/integration/openapi-zod4-integration.test.ts                |           2 |                2 | —              |
| packages/openapi-plugin/test/integration/zod4-request-io.test.ts                         |           5 |                5 | —              |
| packages/openapi-plugin/test/unit/barrel-exports.test.ts                                 |           8 |                8 | —              |
| packages/openapi-plugin/test/unit/derive-request-schemas.test.ts                         |          23 |               23 | —              |
| packages/openapi-plugin/test/unit/openapi-generator.test.ts                              |          42 |               42 | —              |
| packages/openapi-plugin/test/unit/openapi-plugin.test.ts                                 |          12 |               12 | —              |
| packages/openapi-plugin/test/unit/openapi-service.test.ts                                |          27 |               27 | —              |
| packages/openapi-plugin/test/unit/schema-dedup.test.ts                                   |           9 |                9 | —              |
| packages/openapi-plugin/test/unit/swagger-ui.test.ts                                     |          23 |               23 | —              |
| packages/openapi-plugin/test/unit/zod-to-openapi.test.ts                                 |          58 |               59 | added-proof    |
| packages/openapi-plugin/test/unit/zod4-dedup.test.ts                                     |          22 |               22 | —              |
| packages/openapi-plugin/test/unit/zod4-to-openapi.test.ts                                |          40 |               40 | —              |
| packages/queue-plugin/test/e2e/sqs-elasticmq.test.ts                                     |           4 |                4 | —              |
| packages/queue-plugin/test/integration/connection-errors-real.test.ts                    |           2 |                2 | —              |
| packages/queue-plugin/test/integration/dead-letter-visibility.test.ts                    |           2 |                2 | —              |
| packages/queue-plugin/test/integration/declared-processor-tracing.test.ts                |           5 |                5 | —              |
| packages/queue-plugin/test/integration/durability-real.test.ts                           |           1 |                1 | —              |
| packages/queue-plugin/test/integration/header-conformance.test.ts                        |          12 |               12 | —              |
| packages/queue-plugin/test/integration/no-options-unchanged.test.ts                      |           5 |                5 | —              |
| packages/queue-plugin/test/integration/outage-real.test.ts                               |           3 |                3 | —              |
| packages/queue-plugin/test/integration/processor-declared-order.test.ts                  |           2 |                2 | —              |
| packages/queue-plugin/test/integration/queue-behaviors.test.ts                           |           6 |                6 | —              |
| packages/queue-plugin/test/integration/queue-diagnostics.test.ts                         |          10 |               10 | —              |
| packages/queue-plugin/test/integration/queue-integration.test.ts                         |          14 |               14 | —              |
| packages/queue-plugin/test/integration/queue-plugin-logger-ordering.test.ts              |           5 |                5 | —              |
| packages/queue-plugin/test/integration/rabbitmq-name-limit-real.test.ts                  |           1 |                1 | —              |
| packages/queue-plugin/test/integration/redis-atomic-transitions-real.test.ts             |           2 |                2 | —              |
| packages/queue-plugin/test/integration/sqs-arm-integration.test.ts                       |           4 |                4 | —              |
| packages/queue-plugin/test/integration/trace-continuity-real.test.ts                     |           2 |                2 | —              |
| packages/queue-plugin/test/unit/adapters/memory-health.test.ts                           |           1 |                1 | —              |
| packages/queue-plugin/test/unit/adapters/rabbitmq-health.test.ts                         |           6 |                6 | —              |
| packages/queue-plugin/test/unit/adapters/redis-health.test.ts                            |           5 |                5 | —              |
| packages/queue-plugin/test/unit/adapters/sqs-health.test.ts                              |           4 |                4 | —              |
| packages/queue-plugin/test/unit/barrel-exports.test.ts                                   |           6 |                6 | —              |
| packages/queue-plugin/test/unit/cron-calculator.test.ts                                  |          14 |               14 | —              |
| packages/queue-plugin/test/unit/job-processor.test.ts                                    |          15 |               15 | —              |
| packages/queue-plugin/test/unit/memory-queue.test.ts                                     |          26 |               26 | —              |
| packages/queue-plugin/test/unit/processor-registration.test.ts                           |           9 |                9 | —              |
| packages/queue-plugin/test/unit/queue-diagnostics-options.test.ts                        |          10 |               10 | —              |
| packages/queue-plugin/test/unit/queue-failure-surface.test.ts                            |           8 |                8 | —              |
| packages/queue-plugin/test/unit/queue-header-channel.test.ts                             |           8 |                8 | —              |
| packages/queue-plugin/test/unit/queue-metrics.test.ts                                    |           5 |                5 | —              |
| packages/queue-plugin/test/unit/queue-observation-collector.test.ts                      |          34 |               34 | —              |
| packages/queue-plugin/test/unit/queue-plugin.test.ts                                     |          21 |               21 | —              |
| packages/queue-plugin/test/unit/queue-service-coverage.test.ts                           |          31 |               31 | —              |
| packages/queue-plugin/test/unit/queue-service-isolation.test.ts                          |           4 |                4 | —              |
| packages/queue-plugin/test/unit/queue-service-reporting.test.ts                          |           7 |                7 | —              |
| packages/queue-plugin/test/unit/queue-service.test.ts                                    |          25 |               25 | —              |
| packages/queue-plugin/test/unit/rabbitmq-durability.test.ts                              |          22 |               22 | —              |
| packages/queue-plugin/test/unit/rabbitmq-queue.test.ts                                   |          36 |               36 | —              |
| packages/queue-plugin/test/unit/redis-atomic-transitions.test.ts                         |           6 |                6 | —              |
| packages/queue-plugin/test/unit/redis-client-factory.test.ts                             |          11 |               11 | —              |
| packages/queue-plugin/test/unit/redis-dead-letter.test.ts                                |          15 |               15 | —              |
| packages/queue-plugin/test/unit/redis-queue.test.ts                                      |          37 |               37 | —              |
| packages/queue-plugin/test/unit/redis-real-import.test.ts                                |           1 |                1 | —              |
| packages/queue-plugin/test/unit/retry-strategy.test.ts                                   |           9 |                9 | —              |
| packages/queue-plugin/test/unit/sns-publisher.test.ts                                    |          14 |               14 | —              |
| packages/queue-plugin/test/unit/sqs-adapter.test.ts                                      |           6 |                6 | —              |
| packages/queue-plugin/test/unit/sqs-queue.test.ts                                        |          64 |               65 | added-proof    |
| packages/queue-plugin/test/unit/traced-queue.test.ts                                     |          11 |               11 | —              |
| packages/react-router-plugin/test/integration/react-router-integration.test.ts           |           5 |                5 | —              |
| packages/react-router-plugin/test/integration/real-request-handler.test.ts               |           3 |                3 | —              |
| packages/react-router-plugin/test/integration/server-build-load-request-handler.test.ts  |           6 |                6 | —              |
| packages/react-router-plugin/test/integration/server-build-real-import.test.ts           |           3 |                3 | —              |
| packages/react-router-plugin/test/integration/static-assets-real-files.test.ts           |           7 |                7 | —              |
| packages/react-router-plugin/test/unit/assets/public-files.test.ts                       |          17 |               17 | —              |
| packages/react-router-plugin/test/unit/barrel-exports.test.ts                            |          12 |               12 | —              |
| packages/react-router-plugin/test/unit/context-key-for.test.ts                           |           6 |                6 | —              |
| packages/react-router-plugin/test/unit/load-context.test.ts                              |           3 |                3 | —              |
| packages/react-router-plugin/test/unit/react-router-plugin.test.ts                       |           9 |                9 | —              |
| packages/react-router-plugin/test/unit/request-bridge.test.ts                            |          13 |               14 | added-proof    |
| packages/react-router-plugin/test/unit/server-build.test.ts                              |          16 |               16 | —              |
| packages/react-router-plugin/test/unit/ssr-service.test.ts                               |           4 |                4 | —              |
| packages/react-router-plugin/test/unit/static-assets.test.ts                             |          10 |               10 | —              |
| packages/react-router-plugin/test/unit/vite-dev-externals.test.ts                        |           8 |                8 | —              |
| packages/realtime-backplane-plugin/test/integration/connection-errors-plugin.test.ts     |           2 |                2 | —              |
| packages/realtime-backplane-plugin/test/integration/connection-errors-real.test.ts       |           2 |                2 | —              |
| packages/realtime-backplane-plugin/test/integration/outage-real.test.ts                  |           2 |                2 | —              |
| packages/realtime-backplane-plugin/test/integration/plugin.test.ts                       |           5 |                5 | —              |
| packages/realtime-backplane-plugin/test/integration/realtime-observations-redis.test.ts  |           1 |                1 | —              |
| packages/realtime-backplane-plugin/test/integration/redis-real-import.test.ts            |           1 |                1 | —              |
| packages/realtime-backplane-plugin/test/unit/backplane-factory.test.ts                   |           8 |                8 | —              |
| packages/realtime-backplane-plugin/test/unit/dispatch.test.ts                            |           6 |                6 | —              |
| packages/realtime-backplane-plugin/test/unit/memory-backplane.test.ts                    |          10 |               11 | added-proof    |
| packages/realtime-backplane-plugin/test/unit/messaging-backplane.test.ts                 |          16 |               16 | —              |
| packages/realtime-backplane-plugin/test/unit/plugin/health-indicator.test.ts             |           4 |                4 | —              |
| packages/realtime-backplane-plugin/test/unit/plugin/memory-notice.test.ts                |           5 |                5 | —              |
| packages/realtime-backplane-plugin/test/unit/realtime-backplane-plugin.test.ts           |           7 |                7 | —              |
| packages/realtime-backplane-plugin/test/unit/realtime-observations.test.ts               |          16 |               16 | —              |
| packages/realtime-backplane-plugin/test/unit/redis-backplane.test.ts                     |          42 |               42 | —              |
| packages/realtime-backplane-plugin/test/unit/redis-module.test.ts                        |           9 |                9 | —              |
| packages/realtime-backplane-plugin/test/unit/transports/memory-health.test.ts            |           1 |                1 | —              |
| packages/realtime-backplane-plugin/test/unit/transports/messaging-health.test.ts         |           3 |                3 | —              |
| packages/realtime-backplane-plugin/test/unit/transports/redis-health.test.ts             |           5 |                5 | —              |
| packages/resilience-plugin/test/integration/cancellation.test.ts                         |           3 |                3 | —              |
| packages/resilience-plugin/test/integration/resilience-integration.test.ts               |           1 |                1 | —              |
| packages/resilience-plugin/test/integration/shed-status.test.ts                          |           3 |                3 | —              |
| packages/resilience-plugin/test/unit/abort.test.ts                                       |          11 |               12 | added-proof    |
| packages/resilience-plugin/test/unit/barrel-exports.test.ts                              |           3 |                3 | —              |
| packages/resilience-plugin/test/unit/bulkhead.test.ts                                    |           7 |                8 | added-proof    |
| packages/resilience-plugin/test/unit/circuit-breaker.test.ts                             |           7 |                7 | —              |
| packages/resilience-plugin/test/unit/errors.test.ts                                      |           7 |                7 | —              |
| packages/resilience-plugin/test/unit/resilience-plugin.test.ts                           |           4 |                4 | —              |
| packages/resilience-plugin/test/unit/resilience-service.test.ts                          |          25 |               25 | —              |
| packages/resilience-plugin/test/unit/retry.test.ts                                       |          10 |               10 | —              |
| packages/resilience-plugin/test/unit/timeout.test.ts                                     |           7 |                7 | —              |
| packages/runtime/test/e2e/worker-host-real.test.ts                                       |           1 |                1 | —              |
| packages/runtime/test/integration/deno-http-adapter.test.ts                              |           1 |                1 | —              |
| packages/runtime/test/integration/malformed-body-real.test.ts                            |           2 |                2 | —              |
| packages/runtime/test/integration/max-body-bytes.test.ts                                 |           4 |                4 | —              |
| packages/runtime/test/integration/node-http-adapter.test.ts                              |           1 |                1 | —              |
| packages/runtime/test/integration/node-remove-real.test.ts                               |           0 |                1 | added-proof    |
| packages/runtime/test/integration/null-body-status.test.ts                               |           3 |                3 | —              |
| packages/runtime/test/integration/read-stream-real.test.ts                               |           7 |                7 | —              |
| packages/runtime/test/integration/runtime-plugin.test.ts                                 |           4 |                4 | —              |
| packages/runtime/test/integration/signal-real.test.ts                                    |           5 |                5 | —              |
| packages/runtime/test/integration/streaming.test.ts                                      |           3 |                3 | —              |
| packages/runtime/test/integration/upgrade-real-socket.test.ts                            |           4 |                4 | —              |
| packages/runtime/test/integration/worker-exit-real.test.ts                               |           2 |                2 | —              |
| packages/runtime/test/unit/adapter-fetch-order.test.ts                                   |           2 |                2 | —              |
| packages/runtime/test/unit/barrel-exports.test.ts                                        |          18 |               18 | —              |
| packages/runtime/test/unit/bun-http-adapter-rpc.test.ts                                  |           8 |                8 | —              |
| packages/runtime/test/unit/bun-http-adapter.test.ts                                      |           9 |                9 | —              |
| packages/runtime/test/unit/bun-runtime.test.ts                                           |          38 |               38 | —              |
| packages/runtime/test/unit/bun-upgrade-order.test.ts                                     |           4 |                4 | —              |
| packages/runtime/test/unit/bun-ws-upgrader.test.ts                                       |          11 |               11 | —              |
| packages/runtime/test/unit/cf-http-adapter-rpc.test.ts                                   |           4 |                4 | —              |
| packages/runtime/test/unit/cf-http-adapter.test.ts                                       |           6 |                6 | —              |
| packages/runtime/test/unit/cf-runtime.test.ts                                            |          18 |               18 | —              |
| packages/runtime/test/unit/cf-upgrade-order.test.ts                                      |           4 |                4 | —              |
| packages/runtime/test/unit/cf-ws-upgrader.test.ts                                        |          16 |               16 | —              |
| packages/runtime/test/unit/create-runtime-services.test.ts                               |          15 |               15 | —              |
| packages/runtime/test/unit/cross-runtime.test.ts                                         |          14 |               14 | —              |
| packages/runtime/test/unit/define-worker-task.test.ts                                    |          10 |               10 | —              |
| packages/runtime/test/unit/deno-dns-resolver.test.ts                                     |           8 |                8 | —              |
| packages/runtime/test/unit/deno-http-adapter-rpc.test.ts                                 |           4 |                4 | —              |
| packages/runtime/test/unit/deno-http-adapter.test.ts                                     |           7 |                9 | added-proof    |
| packages/runtime/test/unit/deno-read-stream.test.ts                                      |           6 |                6 | —              |
| packages/runtime/test/unit/deno-runtime.test.ts                                          |          28 |               28 | —              |
| packages/runtime/test/unit/deno-upgrade-order.test.ts                                    |           4 |                4 | —              |
| packages/runtime/test/unit/deno-ws-upgrader.test.ts                                      |          13 |               13 | —              |
| packages/runtime/test/unit/extract-path.test.ts                                          |           4 |                4 | —              |
| packages/runtime/test/unit/fetch-mapping.test.ts                                         |          32 |               32 | —              |
| packages/runtime/test/unit/local-diagnostics-listener.test.ts                            |           9 |                9 | —              |
| packages/runtime/test/unit/node-dns-resolver.test.ts                                     |           9 |                9 | —              |
| packages/runtime/test/unit/node-http-adapter-rpc.test.ts                                 |           4 |                4 | —              |
| packages/runtime/test/unit/node-http-adapter.test.ts                                     |          10 |               10 | —              |
| packages/runtime/test/unit/node-runtime.test.ts                                          |          43 |               43 | —              |
| packages/runtime/test/unit/node-serve-defaults.test.ts                                   |           2 |                2 | —              |
| packages/runtime/test/unit/node-upgrade-order.test.ts                                    |           4 |                4 | —              |
| packages/runtime/test/unit/node-worker-host.test.ts                                      |          13 |               13 | —              |
| packages/runtime/test/unit/node-ws-real-import.test.ts                                   |           2 |                2 | —              |
| packages/runtime/test/unit/node-ws-upgrader.test.ts                                      |          40 |               40 | —              |
| packages/runtime/test/unit/read-body-bound.test.ts                                       |          17 |               17 | —              |
| packages/runtime/test/unit/rpc-interceptor-store.test.ts                                 |           6 |                6 | —              |
| packages/runtime/test/unit/runtime-detector.test.ts                                      |          12 |               12 | —              |
| packages/runtime/test/unit/runtime-plugin.test.ts                                        |          19 |               19 | —              |
| packages/runtime/test/unit/runtime-workers-wiring.test.ts                                |           6 |                6 | —              |
| packages/runtime/test/unit/upgrade-detection.test.ts                                     |          10 |               10 | —              |
| packages/runtime/test/unit/upgrade-router-store.test.ts                                  |           3 |                3 | —              |
| packages/runtime/test/unit/upgrade-with-body.test.ts                                     |           5 |                5 | —              |
| packages/runtime/test/unit/web-socket-transport.test.ts                                  |          11 |               11 | —              |
| packages/runtime/test/unit/web-worker-host.test.ts                                       |          22 |               22 | —              |
| packages/scheduler-plugin/test/integration/connection-errors-real.test.ts                |           2 |                2 | —              |
| packages/scheduler-plugin/test/integration/no-options-unchanged.test.ts                  |           4 |                4 | —              |
| packages/scheduler-plugin/test/integration/outage-real.test.ts                           |           2 |                2 | —              |
| packages/scheduler-plugin/test/integration/scheduler-behaviors.test.ts                   |           9 |                9 | —              |
| packages/scheduler-plugin/test/integration/scheduler-integration.test.ts                 |           3 |                3 | —              |
| packages/scheduler-plugin/test/unit/barrel-exports.test.ts                               |           4 |                4 | —              |
| packages/scheduler-plugin/test/unit/cron-parser.test.ts                                  |          37 |               37 | —              |
| packages/scheduler-plugin/test/unit/distributed-lock.test.ts                             |          14 |               14 | —              |
| packages/scheduler-plugin/test/unit/job-executor.test.ts                                 |          10 |               10 | —              |
| packages/scheduler-plugin/test/unit/job-registration.test.ts                             |          19 |               19 | —              |
| packages/scheduler-plugin/test/unit/job-registry.test.ts                                 |          16 |               16 | —              |
| packages/scheduler-plugin/test/unit/memory-lock-sweep.test.ts                            |           2 |                2 | —              |
| packages/scheduler-plugin/test/unit/memory-lock.test.ts                                  |           6 |                6 | —              |
| packages/scheduler-plugin/test/unit/redis-lock-real-import.test.ts                       |           1 |                1 | —              |
| packages/scheduler-plugin/test/unit/redis-lock.test.ts                                   |          34 |               34 | —              |
| packages/scheduler-plugin/test/unit/retry-handler.test.ts                                |           4 |                4 | —              |
| packages/scheduler-plugin/test/unit/scheduler-every-grid.test.ts                         |           5 |                5 | —              |
| packages/scheduler-plugin/test/unit/scheduler-lock-bound.test.ts                         |          13 |               13 | —              |
| packages/scheduler-plugin/test/unit/scheduler-observations.test.ts                       |          47 |               47 | —              |
| packages/scheduler-plugin/test/unit/scheduler-plugin.test.ts                             |          10 |               10 | —              |
| packages/scheduler-plugin/test/unit/scheduler-service.test.ts                            |          79 |               79 | —              |
| packages/scheduler-plugin/test/unit/scheduler-slot-lock.test.ts                          |           6 |                6 | —              |
| packages/scheduler-plugin/test/unit/scheduler-workers-refusal.test.ts                    |           4 |                4 | —              |
| packages/sdk/test/e2e/default-transport.test.ts                                          |           3 |                3 | —              |
| packages/sdk/test/e2e/generated-client.test.ts                                           |          11 |               11 | —              |
| packages/sdk/test/e2e/realtime-client-socket.test.ts                                     |           1 |                1 | —              |
| packages/sdk/test/e2e/sse-client-runtime.test.ts                                         |           1 |                1 | —              |
| packages/sdk/test/e2e/trace-propagation.test.ts                                          |           1 |                1 | —              |
| packages/sdk/test/integration/client-resilience.test.ts                                  |          10 |               10 | —              |
| packages/sdk/test/unit/auth-interceptor.test.ts                                          |          10 |               10 | —              |
| packages/sdk/test/unit/barrel-exports.test.ts                                            |           2 |                2 | —              |
| packages/sdk/test/unit/circuit-breaker.test.ts                                           |          11 |               11 | —              |
| packages/sdk/test/unit/codegen-name-collision.test.ts                                    |          21 |               21 | —              |
| packages/sdk/test/unit/errors.test.ts                                                    |          14 |               14 | —              |
| packages/sdk/test/unit/fetch-receiver.test.ts                                            |           3 |                3 | —              |
| packages/sdk/test/unit/http-client.test.ts                                               |          36 |               36 | —              |
| packages/sdk/test/unit/http-contracts.test.ts                                            |           8 |                8 | —              |
| packages/sdk/test/unit/idempotency-key.test.ts                                           |          16 |               16 | —              |
| packages/sdk/test/unit/observed-fetch-plugin.test.ts                                     |          23 |               23 | —              |
| packages/sdk/test/unit/observed-fetch-transparency.test.ts                               |          16 |               16 | —              |
| packages/sdk/test/unit/openapi-codegen.test.ts                                           |         132 |              132 | —              |
| packages/sdk/test/unit/outbound-http-observations.test.ts                                |          47 |               47 | —              |
| packages/sdk/test/unit/random-hex.test.ts                                                |           3 |                3 | —              |
| packages/sdk/test/unit/rate-limiter.test.ts                                              |           9 |               11 | added-proof    |
| packages/sdk/test/unit/realtime-client.test.ts                                           |          11 |               11 | —              |
| packages/sdk/test/unit/realtime-module-imports.test.ts                                   |           2 |                2 | —              |
| packages/sdk/test/unit/retry-keyed.test.ts                                               |           6 |                6 | —              |
| packages/sdk/test/unit/retry-strategy.test.ts                                            |          24 |               24 | —              |
| packages/sdk/test/unit/sdk.test.ts                                                       |          28 |               28 | —              |
| packages/sdk/test/unit/sse-client.test.ts                                                |          12 |               13 | added-proof    |
| packages/sdk/test/unit/sse-frame-parser.test.ts                                          |          10 |               10 | —              |
| packages/sdk/test/unit/timing.test.ts                                                    |          14 |               14 | —              |
| packages/sdk/test/unit/trace-context-interceptor.test.ts                                 |           3 |                3 | —              |
| packages/sdk/test/unit/type-only-common.test.ts                                          |           2 |                2 | —              |
| packages/secrets-plugin/test/integration/aws-endpoint-real.test.ts                       |           1 |                1 | —              |
| packages/secrets-plugin/test/integration/gcp-endpoint-real.test.ts                       |           3 |                3 | —              |
| packages/secrets-plugin/test/integration/plugin-endpoint-real.test.ts                    |           1 |                1 | —              |
| packages/secrets-plugin/test/integration/readonly-status.test.ts                         |           5 |                5 | —              |
| packages/secrets-plugin/test/integration/secrets-integration.test.ts                     |           2 |                2 | —              |
| packages/secrets-plugin/test/integration/vault-outage-real.test.ts                       |           1 |                1 | —              |
| packages/secrets-plugin/test/integration/vault-unavailable-status.test.ts                |           1 |                1 | —              |
| packages/secrets-plugin/test/unit/aws-kms.test.ts                                        |           8 |                8 | —              |
| packages/secrets-plugin/test/unit/azure-key-vault.test.ts                                |           9 |                9 | —              |
| packages/secrets-plugin/test/unit/barrel-exports.test.ts                                 |           4 |                4 | —              |
| packages/secrets-plugin/test/unit/cloud-facade-health.test.ts                            |           6 |                6 | —              |
| packages/secrets-plugin/test/unit/env-provider.test.ts                                   |           7 |                7 | —              |
| packages/secrets-plugin/test/unit/gcp-secret-manager.test.ts                             |           9 |                9 | —              |
| packages/secrets-plugin/test/unit/provider-endpoint.test.ts                              |          16 |               16 | —              |
| packages/secrets-plugin/test/unit/secret-name.test.ts                                    |           7 |                7 | —              |
| packages/secrets-plugin/test/unit/secrets-plugin.test.ts                                 |          15 |               15 | —              |
| packages/secrets-plugin/test/unit/secrets-service.test.ts                                |           5 |                5 | —              |
| packages/secrets-plugin/test/unit/shape.test.ts                                          |           2 |                2 | —              |
| packages/secrets-plugin/test/unit/vault.test.ts                                          |          41 |               42 | added-proof    |
| packages/service-discovery-plugin/test/e2e/service-discovery-e2e.test.ts                 |           3 |                3 | —              |
| packages/service-discovery-plugin/test/integration/plugin-registration.test.ts           |          14 |               14 | —              |
| packages/service-discovery-plugin/test/integration/self-registration.test.ts             |           6 |                6 | —              |
| packages/service-discovery-plugin/test/unit/consul-provider.test.ts                      |          22 |               22 | —              |
| packages/service-discovery-plugin/test/unit/consul-watch.test.ts                         |          13 |               13 | —              |
| packages/service-discovery-plugin/test/unit/default-http.test.ts                         |           6 |                6 | —              |
| packages/service-discovery-plugin/test/unit/dns-provider.test.ts                         |          18 |               18 | —              |
| packages/service-discovery-plugin/test/unit/ejection-tracker.test.ts                     |          11 |               11 | —              |
| packages/service-discovery-plugin/test/unit/errors.test.ts                               |           3 |                3 | —              |
| packages/service-discovery-plugin/test/unit/instance-url.test.ts                         |           8 |                8 | —              |
| packages/service-discovery-plugin/test/unit/kubernetes-provider.test.ts                  |          25 |               25 | —              |
| packages/service-discovery-plugin/test/unit/kubernetes-watch.test.ts                     |          12 |               12 | —              |
| packages/service-discovery-plugin/test/unit/load-balancer.test.ts                        |          12 |               12 | —              |
| packages/service-discovery-plugin/test/unit/ndjson.test.ts                               |           8 |                9 | added-proof    |
| packages/service-discovery-plugin/test/unit/options.test.ts                              |          10 |               10 | —              |
| packages/service-discovery-plugin/test/unit/plugin/health-indicator.test.ts              |           4 |                4 | —              |
| packages/service-discovery-plugin/test/unit/provider-factory.test.ts                     |          19 |               19 | —              |
| packages/service-discovery-plugin/test/unit/providers/consul-health.test.ts              |           3 |                3 | —              |
| packages/service-discovery-plugin/test/unit/providers/dns-health.test.ts                 |           1 |                1 | —              |
| packages/service-discovery-plugin/test/unit/providers/kubernetes-health.test.ts          |           3 |                3 | —              |
| packages/service-discovery-plugin/test/unit/providers/static-health.test.ts              |           1 |                1 | —              |
| packages/service-discovery-plugin/test/unit/service-discovery-service.test.ts            |          24 |               24 | —              |
| packages/service-discovery-plugin/test/unit/static-provider.test.ts                      |           9 |                9 | —              |
| packages/session-plugin/test/e2e/session-flow.test.ts                                    |          15 |               15 | —              |
| packages/session-plugin/test/integration/concurrent-writes.test.ts                       |           2 |                2 | —              |
| packages/session-plugin/test/integration/csrf-field-name.test.ts                         |           3 |                3 | —              |
| packages/session-plugin/test/integration/documented-csrf-sequence.test.ts                |           4 |                4 | —              |
| packages/session-plugin/test/integration/plugin-registration.test.ts                     |          14 |               14 | —              |
| packages/session-plugin/test/integration/session-tenant-cross-write.test.ts              |           1 |                1 | —              |
| packages/session-plugin/test/unit/barrel-exports.test.ts                                 |          20 |               20 | —              |
| packages/session-plugin/test/unit/codec/crypto.test.ts                                   |          23 |               23 | —              |
| packages/session-plugin/test/unit/codec/envelope.test.ts                                 |           9 |                9 | —              |
| packages/session-plugin/test/unit/codec/timing-safe.test.ts                              |          11 |               11 | —              |
| packages/session-plugin/test/unit/csrf/csrf-multipart.test.ts                            |           6 |                6 | —              |
| packages/session-plugin/test/unit/csrf/csrf.test.ts                                      |          36 |               36 | —              |
| packages/session-plugin/test/unit/errors.test.ts                                         |           5 |                5 | —              |
| packages/session-plugin/test/unit/middleware/session-middleware.test.ts                  |          12 |               12 | —              |
| packages/session-plugin/test/unit/options.test.ts                                        |          14 |               14 | —              |
| packages/session-plugin/test/unit/secret/secret-resolver.test.ts                         |          18 |               18 | —              |
| packages/session-plugin/test/unit/services/session-service.test.ts                       |          40 |               40 | —              |
| packages/session-plugin/test/unit/services/session.test.ts                               |          25 |               25 | —              |
| packages/session-plugin/test/unit/session-from-headers.test.ts                           |          14 |               14 | —              |
| packages/session-plugin/test/unit/session-tenant-binding.test.ts                         |           9 |                9 | —              |
| packages/session-plugin/test/unit/stores/cache-session-store.test.ts                     |          10 |               10 | —              |
| packages/session-plugin/test/unit/stores/memory-session-store.test.ts                    |          13 |               13 | —              |
| packages/sse-plugin/test/integration/backplane.test.ts                                   |           9 |                9 | —              |
| packages/sse-plugin/test/integration/peek-presence.test.ts                               |           3 |                3 | —              |
| packages/sse-plugin/test/integration/sse-integration.test.ts                             |           5 |                5 | —              |
| packages/sse-plugin/test/unit/barrel-exports.test.ts                                     |           5 |                5 | —              |
| packages/sse-plugin/test/unit/channel-registry.test.ts                                   |          16 |               16 | —              |
| packages/sse-plugin/test/unit/realtime-observations.test.ts                              |          15 |               15 | —              |
| packages/sse-plugin/test/unit/sse-connection.test.ts                                     |          29 |               30 | added-proof    |
| packages/sse-plugin/test/unit/sse-frame.test.ts                                          |          15 |               15 | —              |
| packages/sse-plugin/test/unit/sse-nonserializable.test.ts                                |           6 |                6 | —              |
| packages/sse-plugin/test/unit/sse-plugin.test.ts                                         |          17 |               17 | —              |
| packages/sse-plugin/test/unit/sse-service.test.ts                                        |          19 |               19 | —              |
| packages/starters/full-stack-starter/test/integration/app-integration.test.ts            |           6 |                6 | —              |
| packages/starters/full-stack-starter/test/integration/auth-user-context.test.ts          |           1 |                1 | —              |
| packages/starters/full-stack-starter/test/integration/from-config.test.ts                |          14 |               14 | —              |
| packages/starters/full-stack-starter/test/unit/app.test.ts                               |          13 |               13 | —              |
| packages/starters/full-stack-starter/test/unit/barrel-exports.test.ts                    |           5 |                5 | —              |
| packages/starters/full-stack-starter/test/unit/static-arm.test.ts                        |           3 |                3 | —              |
| packages/starters/full-stack-starter/test/unit/workers-scheduler.test.ts                 |           5 |                5 | —              |
| packages/starters/microservice-starter/test/integration/app-integration.test.ts          |           3 |                3 | —              |
| packages/starters/microservice-starter/test/unit/app.test.ts                             |           9 |                9 | —              |
| packages/starters/microservice-starter/test/unit/barrel-exports.test.ts                  |           4 |                4 | —              |
| packages/starters/rest-starter/test/integration/app-integration.test.ts                  |          12 |               12 | —              |
| packages/starters/rest-starter/test/unit/app.test.ts                                     |          27 |               27 | —              |
| packages/starters/rest-starter/test/unit/barrel-exports.test.ts                          |           3 |                3 | —              |
| packages/starters/rest-starter/test/unit/validation-format.test.ts                       |           2 |                2 | —              |
| packages/static-plugin/test/e2e/static-application.test.ts                               |           8 |                8 | —              |
| packages/static-plugin/test/integration/static-integration.test.ts                       |          10 |               10 | —              |
| packages/static-plugin/test/unit/barrel-exports.test.ts                                  |           5 |                5 | —              |
| packages/static-plugin/test/unit/cache-control-path.test.ts                              |           4 |                4 | —              |
| packages/static-plugin/test/unit/cache-control.test.ts                                   |          11 |               11 | —              |
| packages/static-plugin/test/unit/conditional.test.ts                                     |          12 |               12 | —              |
| packages/static-plugin/test/unit/health.test.ts                                          |           3 |                3 | —              |
| packages/static-plugin/test/unit/precompressed.test.ts                                   |          23 |               23 | —              |
| packages/static-plugin/test/unit/range.test.ts                                           |          29 |               29 | —              |
| packages/static-plugin/test/unit/review-regressions.test.ts                              |          16 |               16 | —              |
| packages/static-plugin/test/unit/static-files-service.test.ts                            |           5 |                6 | added-proof    |
| packages/static-plugin/test/unit/static-handler.test.ts                                  |          36 |               36 | —              |
| packages/static-plugin/test/unit/static-plugin.test.ts                                   |           8 |                8 | —              |
| packages/static-plugin/test/unit/two-entry-points.test.ts                                |           2 |                2 | —              |
| packages/storage-plugin/test/integration/outage-real.test.ts                             |           1 |                1 | —              |
| packages/storage-plugin/test/integration/storage-integration.test.ts                     |           3 |                3 | —              |
| packages/storage-plugin/test/integration/stream-backpressure-real.test.ts                |           2 |                2 | —              |
| packages/storage-plugin/test/integration/upload-body-cap-e2e.test.ts                     |           3 |                3 | —              |
| packages/storage-plugin/test/integration/upload-csrf-one-parse.test.ts                   |           2 |                2 | —              |
| packages/storage-plugin/test/integration/upload-error-passthrough.test.ts                |           4 |                4 | —              |
| packages/storage-plugin/test/unit/assert-connected-rejects.test.ts                       |          15 |               15 | —              |
| packages/storage-plugin/test/unit/azure-provider.test.ts                                 |          49 |               49 | —              |
| packages/storage-plugin/test/unit/barrel-exports.test.ts                                 |          13 |               13 | —              |
| packages/storage-plugin/test/unit/gcs-provider.test.ts                                   |          52 |               52 | —              |
| packages/storage-plugin/test/unit/local-provider.test.ts                                 |          20 |               22 | added-proof    |
| packages/storage-plugin/test/unit/memory-provider.test.ts                                |          11 |               11 | —              |
| packages/storage-plugin/test/unit/options-typing.test.ts                                 |           7 |                7 | —              |
| packages/storage-plugin/test/unit/provider-stream.test.ts                                |          32 |               32 | —              |
| packages/storage-plugin/test/unit/providers/azure-health.test.ts                         |           4 |                4 | —              |
| packages/storage-plugin/test/unit/providers/gcs-health.test.ts                           |           4 |                4 | —              |
| packages/storage-plugin/test/unit/providers/local-health.test.ts                         |           8 |                8 | —              |
| packages/storage-plugin/test/unit/providers/memory-health.test.ts                        |           1 |                1 | —              |
| packages/storage-plugin/test/unit/providers/s3-health.test.ts                            |           3 |                3 | —              |
| packages/storage-plugin/test/unit/put-object-metadata.test.ts                            |          14 |               14 | —              |
| packages/storage-plugin/test/unit/s3-provider.test.ts                                    |          46 |               46 | —              |
| packages/storage-plugin/test/unit/shape.test.ts                                          |           6 |                6 | —              |
| packages/storage-plugin/test/unit/storage-observations.test.ts                           |          54 |               54 | —              |
| packages/storage-plugin/test/unit/storage-plugin.test.ts                                 |          18 |               18 | —              |
| packages/storage-plugin/test/unit/storage-service.test.ts                                |          16 |               16 | —              |
| packages/storage-plugin/test/unit/upload-body-bound.test.ts                              |          14 |               14 | —              |
| packages/storage-plugin/test/unit/upload-fallback.test.ts                                |           2 |                2 | —              |
| packages/storage-plugin/test/unit/upload-middleware.test.ts                              |          23 |               23 | —              |
| packages/storage-plugin/test/unit/upload-refusal-status.test.ts                          |           3 |                3 | —              |
| packages/telemetry-plugin/test/e2e/telemetry-outcome-reporting.test.ts                   |           2 |                2 | —              |
| packages/telemetry-plugin/test/e2e/trace-continuity-real.test.ts                         |           1 |                1 | —              |
| packages/telemetry-plugin/test/integration/context-manager-real.test.ts                  |           2 |                2 | —              |
| packages/telemetry-plugin/test/integration/diagnostic-span-processor-real-import.test.ts |           2 |                2 | —              |
| packages/telemetry-plugin/test/integration/instrumentation-real-import.test.ts           |           6 |                6 | —              |
| packages/telemetry-plugin/test/integration/otlp-real-import.test.ts                      |           3 |                3 | —              |
| packages/telemetry-plugin/test/integration/telemetry-integration.test.ts                 |           2 |                2 | —              |
| packages/telemetry-plugin/test/unit/active-span-context.test.ts                          |           6 |                6 | —              |
| packages/telemetry-plugin/test/unit/barrel-exports.test.ts                               |          16 |               16 | —              |
| packages/telemetry-plugin/test/unit/console-exporter.test.ts                             |           2 |                2 | —              |
| packages/telemetry-plugin/test/unit/context-manager.test.ts                              |           5 |                6 | added-proof    |
| packages/telemetry-plugin/test/unit/database-instrumentation.test.ts                     |           4 |                4 | —              |
| packages/telemetry-plugin/test/unit/diagnostic-span-processor.test.ts                    |          14 |               14 | —              |
| packages/telemetry-plugin/test/unit/http-instrumentation.test.ts                         |           7 |                7 | —              |
| packages/telemetry-plugin/test/unit/instrumentation-literals.test.ts                     |           6 |                6 | —              |
| packages/telemetry-plugin/test/unit/instrumentation-registry.test.ts                     |          48 |               48 | —              |
| packages/telemetry-plugin/test/unit/otlp-exporter.test.ts                                |           3 |                3 | —              |
| packages/telemetry-plugin/test/unit/queue-instrumentation.test.ts                        |           8 |                8 | —              |
| packages/telemetry-plugin/test/unit/sanitize-url.test.ts                                 |           5 |                6 | added-proof    |
| packages/telemetry-plugin/test/unit/span-activation.test.ts                              |           4 |                4 | —              |
| packages/telemetry-plugin/test/unit/span-observation-collector.test.ts                   |          13 |               13 | —              |
| packages/telemetry-plugin/test/unit/span-processor-factory.test.ts                       |           4 |                4 | —              |
| packages/telemetry-plugin/test/unit/span-root.test.ts                                    |           2 |                2 | —              |
| packages/telemetry-plugin/test/unit/telemetry-middleware.test.ts                         |          18 |               18 | —              |
| packages/telemetry-plugin/test/unit/telemetry-plugin.test.ts                             |          41 |               43 | added-proof    |
| packages/telemetry-plugin/test/unit/telemetry-service-root.test.ts                       |           4 |                4 | —              |
| packages/telemetry-plugin/test/unit/telemetry-service.test.ts                            |          24 |               24 | —              |
| packages/telemetry-plugin/test/unit/trace-diagnostics-options.test.ts                    |          18 |               18 | —              |
| packages/telemetry-plugin/test/unit/tracer-active-span.test.ts                           |          14 |               14 | —              |
| packages/telemetry-plugin/test/unit/tracer-delegates-codec.test.ts                       |           1 |                1 | —              |
| packages/telemetry-plugin/test/unit/tracer.test.ts                                       |          49 |               51 | added-proof    |
| packages/testing/test/e2e/testing-e2e.test.ts                                            |           2 |                2 | —              |
| packages/testing/test/integration/composition-root.test.ts                               |           9 |                9 | —              |
| packages/testing/test/integration/inject.test.ts                                         |           5 |                5 | —              |
| packages/testing/test/integration/override-provider.test.ts                              |           4 |                4 | —              |
| packages/testing/test/integration/test-app.test.ts                                       |           3 |                3 | —              |
| packages/testing/test/unit/barrel-exports.test.ts                                        |           4 |                4 | —              |
| packages/testing/test/unit/fixture-manager.test.ts                                       |           6 |                6 | —              |
| packages/testing/test/unit/inject.test.ts                                                |          11 |               11 | —              |
| packages/testing/test/unit/mock-context.test.ts                                          |          68 |               68 | —              |
| packages/testing/test/unit/mock-plugin.test.ts                                           |           6 |                6 | —              |
| packages/testing/test/unit/mock-registry.test.ts                                         |          10 |               10 | —              |
| packages/testing/test/unit/override-capability.test.ts                                   |          14 |               14 | —              |
| packages/testing/test/unit/override-provider.test.ts                                     |           7 |                7 | —              |
| packages/testing/test/unit/test-app-arms.test.ts                                         |          13 |               13 | —              |
| packages/testing/test/unit/test-app.test.ts                                              |           6 |                6 | —              |
| packages/validation-plugin/test/e2e/validation-application.test.ts                       |           5 |                5 | —              |
| packages/validation-plugin/test/integration/validation-integration.test.ts               |          13 |               13 | —              |
| packages/validation-plugin/test/unit/barrel-exports.test.ts                              |           3 |                3 | —              |
| packages/validation-plugin/test/unit/formatters.test.ts                                  |          25 |               25 | —              |
| packages/validation-plugin/test/unit/helper-format-regression.test.ts                    |           2 |                2 | —              |
| packages/validation-plugin/test/unit/helpers.test.ts                                     |           5 |                5 | —              |
| packages/validation-plugin/test/unit/plugin.test.ts                                      |           8 |                8 | —              |
| packages/validation-plugin/test/unit/sanitizer.test.ts                                   |          19 |               19 | —              |
| packages/validation-plugin/test/unit/validation-metadata-brand.test.ts                   |           6 |                6 | —              |
| packages/validation-plugin/test/unit/validation-middleware.test.ts                       |          25 |               25 | —              |
| packages/validation-plugin/test/unit/validation-service.test.ts                          |          16 |               16 | —              |
| packages/view-plugin/test/integration/both-entry-points.test.ts                          |           2 |                2 | —              |
| packages/view-plugin/test/unit/barrel-exports.test.ts                                    |           5 |                5 | —              |
| packages/view-plugin/test/unit/custom-engine.test.ts                                     |           2 |                2 | —              |
| packages/view-plugin/test/unit/errors.test.ts                                            |           5 |                5 | —              |
| packages/view-plugin/test/unit/escaping.test.ts                                          |           4 |                4 | —              |
| packages/view-plugin/test/unit/falsy-returns.test.ts                                     |           8 |                8 | —              |
| packages/view-plugin/test/unit/normalize.test.ts                                         |           6 |                6 | —              |
| packages/view-plugin/test/unit/suspense-refusal.test.ts                                  |           4 |                4 | —              |
| packages/view-plugin/test/unit/view-engine-html.test.ts                                  |           1 |                1 | —              |
| packages/view-plugin/test/unit/view-engine-jsx.test.ts                                   |           2 |                2 | —              |
| packages/view-plugin/test/unit/view-plugin.test.ts                                       |           5 |                5 | —              |
| packages/websocket-plugin/test/e2e/cookie-auth-socket.test.ts                            |           3 |                3 | —              |
| packages/websocket-plugin/test/e2e/declarative-route.test.ts                             |           2 |                2 | —              |
| packages/websocket-plugin/test/e2e/websocket-e2e.test.ts                                 |           5 |                5 | —              |
| packages/websocket-plugin/test/integration/backplane.test.ts                             |          19 |               19 | —              |
| packages/websocket-plugin/test/integration/frame-behaviors.test.ts                       |           8 |                8 | —              |
| packages/websocket-plugin/test/integration/guarded-upgrade.test.ts                       |           4 |                4 | —              |
| packages/websocket-plugin/test/integration/no-options-unchanged.test.ts                  |           4 |                4 | —              |
| packages/websocket-plugin/test/integration/peek-presence.test.ts                         |           3 |                3 | —              |
| packages/websocket-plugin/test/integration/upgrade-body-cap-slot.test.ts                 |           3 |                3 | —              |
| packages/websocket-plugin/test/integration/upgrade-guards.test.ts                        |           9 |                9 | —              |
| packages/websocket-plugin/test/integration/websocket-integration.test.ts                 |           9 |                9 | —              |
| packages/websocket-plugin/test/unit/barrel-exports.test.ts                               |           4 |                4 | —              |
| packages/websocket-plugin/test/unit/heartbeat.test.ts                                    |           9 |                9 | —              |
| packages/websocket-plugin/test/unit/realtime-observations.test.ts                        |          15 |               15 | —              |
| packages/websocket-plugin/test/unit/room-registry.test.ts                                |          32 |               32 | —              |
| packages/websocket-plugin/test/unit/route-registration.test.ts                           |          10 |               10 | —              |
| packages/websocket-plugin/test/unit/websocket-connection.test.ts                         |           9 |                9 | —              |
| packages/websocket-plugin/test/unit/websocket-plugin.test.ts                             |          16 |               16 | —              |
| packages/websocket-plugin/test/unit/websocket-service-upgrade-user.test.ts               |          14 |               14 | —              |
| packages/websocket-plugin/test/unit/websocket-service.test.ts                            |          36 |               36 | —              |
| packages/websocket-plugin/test/unit/ws-route-table.test.ts                               |          14 |               14 | —              |
| packages/worker-pool-plugin/test/e2e/real-worker.test.ts                                 |           9 |                9 | —              |
| packages/worker-pool-plugin/test/integration/metrics-absent.test.ts                      |           3 |                3 | —              |
| packages/worker-pool-plugin/test/integration/worker-pool-metrics-app.test.ts             |           6 |                6 | —              |
| packages/worker-pool-plugin/test/integration/worker-pool-plugin.test.ts                  |           2 |                2 | —              |
| packages/worker-pool-plugin/test/unit/barrel-exports.test.ts                             |           2 |                2 | —              |
| packages/worker-pool-plugin/test/unit/errors.test.ts                                     |           6 |                6 | —              |
| packages/worker-pool-plugin/test/unit/metrics-failure-isolation.test.ts                  |           7 |                7 | —              |
| packages/worker-pool-plugin/test/unit/sizing.test.ts                                     |          33 |               33 | —              |
| packages/worker-pool-plugin/test/unit/task-pool-budget.test.ts                           |          16 |               16 | —              |
| packages/worker-pool-plugin/test/unit/task-pool-clone-failure.test.ts                    |           6 |                6 | —              |
| packages/worker-pool-plugin/test/unit/task-pool-exit.test.ts                             |          12 |               12 | —              |
| packages/worker-pool-plugin/test/unit/task-pool-lifecycle.test.ts                        |           7 |                7 | —              |
| packages/worker-pool-plugin/test/unit/task-pool-startup.test.ts                          |           7 |                7 | —              |
| packages/worker-pool-plugin/test/unit/task-pool-unsettled-error.test.ts                  |           5 |                5 | —              |
| packages/worker-pool-plugin/test/unit/task-pool.test.ts                                  |          23 |               23 | —              |
| packages/worker-pool-plugin/test/unit/worker-budget.test.ts                              |           5 |                5 | —              |
| packages/worker-pool-plugin/test/unit/worker-pool-metrics.test.ts                        |          15 |               15 | —              |
| packages/worker-pool-plugin/test/unit/worker-pool-plugin.test.ts                         |          23 |               23 | —              |
| packages/worker-pool-plugin/test/unit/worker-pool-service.test.ts                        |          15 |               15 | —              |

Coverage drops show the leaf counts of the owning member, since a source file can be reached by
several suites.

| Source file                                                                 | Deno %             | Converted %           | Deno member leaves | Converted member leaves |
| --------------------------------------------------------------------------- | ------------------ | --------------------- | -----------------: | ----------------------: |
| packages/audit-plugin/src/plugin/audit-plugin.ts                            | 96.7 / 100 / 97.1  | 92.3 / 100 / 96.36    |                121 |                     121 |
| packages/audit-plugin/src/storage/audit-record.ts                           | 97.5 / 100 / 96    | 97.56 / 100 / 94.87   |                121 |                     121 |
| packages/audit-plugin/src/storage/database-audit.ts                         | 97 / 100 / 98      | 95.83 / 100 / 100     |                121 |                     121 |
| packages/auth-plugin/src/issuers/key-selection.ts                           | 98.4 / 100 / 98.6  | 98 / 100 / 98.18      |               1340 |                    1348 |
| packages/auth-plugin/src/issuers/key-set-cache.ts                           | 96.7 / 100 / 97.4  | 94.66 / 100 / 97.27   |               1340 |                    1348 |
| packages/auth-plugin/src/mfa/totp-service.ts                                | 95.8 / 100 / 95.9  | 94.18 / 100 / 96.24   |               1340 |                    1348 |
| packages/auth-plugin/src/passkeys/ceremonies.ts                             | 93.2 / 96 / 92.3   | 91.01 / 96.55 / 92.28 |               1340 |                    1348 |
| packages/auth-plugin/src/passkeys/routes.ts                                 | 96.9 / 100 / 98.1  | 93.75 / 100 / 97.87   |               1340 |                    1348 |
| packages/auth-plugin/src/passkeys/signature.ts                              | 98.3 / 100 / 97.2  | 93.93 / 100 / 96.61   |               1340 |                    1348 |
| packages/auth-plugin/src/plugin/auth-plugin.ts                              | 99.1 / 100 / 100   | 98.61 / 100 / 100     |               1340 |                    1348 |
| packages/auth-plugin/src/saml/routes.ts                                     | 98.4 / 100 / 99.1  | 97.69 / 100 / 98.85   |               1340 |                    1348 |
| packages/auth-plugin/src/scoped/grant-resolver.ts                           | 99 / 100 / 100     | 98.26 / 100 / 100     |               1340 |                    1348 |
| packages/auth-plugin/src/scoped/model.ts                                    | 97.4 / 100 / 98.2  | 97.29 / 100 / 100     |               1340 |                    1348 |
| packages/auth-plugin/src/scoped/options.ts                                  | 98.1 / 100 / 100   | 97.54 / 100 / 100     |               1340 |                    1348 |
| packages/auth-plugin/src/scoped/scoped-guards.ts                            | 96.8 / 100 / 100   | 95.55 / 100 / 100     |               1340 |                    1348 |
| packages/auth-plugin/src/scoped/scoped-policy.ts                            | 100 / 100 / 100    | 98.83 / 100 / 100     |               1340 |                    1348 |
| packages/auth-plugin/src/services/jwt-service.ts                            | 96.6 / 100 / 97.6  | 94.91 / 100 / 97.77   |               1340 |                    1348 |
| packages/auth-plugin/src/services/rbac-service.ts                           | 100 / 100 / 100    | 98.07 / 100 / 100     |               1340 |                    1348 |
| packages/auth-plugin/src/services/refresh-token-service.ts                  | 94 / 100 / 96.5    | 91.48 / 100 / 95.94   |               1340 |                    1348 |
| packages/auth-plugin/src/sign-in/auth-session-service.ts                    | 96.7 / 100 / 97.1  | 94.5 / 100 / 97.39    |               1340 |                    1348 |
| packages/auth-plugin/src/sign-in/config.ts                                  | 95.6 / 100 / 93.1  | 94.89 / 91.66 / 93    |               1340 |                    1348 |
| packages/auth-plugin/src/sign-in/return-to.ts                               | 97.2 / 100 / 100   | 96 / 100 / 100        |               1340 |                    1348 |
| packages/auth-plugin/src/sign-in/routes.ts                                  | 95.8 / 100 / 98.2  | 94.11 / 100 / 98.07   |               1340 |                    1348 |
| packages/auth-plugin/src/stores/access-token-revocation-store.ts            | 95.8 / 100 / 97.5  | 93.1 / 100 / 98.03    |               1340 |                    1348 |
| packages/auth-plugin/src/stores/passkey-store.ts                            | 97.6 / 100 / 97.5  | 96.42 / 100 / 97.72   |               1340 |                    1348 |
| packages/auth-plugin/src/stores/refresh-token-store.ts                      | 97.3 / 100 / 97.1  | 95.83 / 100 / 97.61   |               1340 |                    1348 |
| packages/auth-plugin/src/stores/totp-store.ts                               | 98.3 / 100 / 100   | 97.05 / 100 / 100     |               1340 |                    1348 |
| packages/auth-plugin/src/strategies/issuer-strategy.ts                      | 97.6 / 100 / 97.1  | 96 / 100 / 97.36      |               1340 |                    1348 |
| packages/auth-plugin/src/strategies/jwt-strategy.ts                         | 98.1 / 100 / 97.8  | 97.22 / 100 / 97.43   |               1340 |                    1348 |
| packages/auth-plugin/src/utils/duration.ts                                  | 92.9 / 100 / 92.9  | 90 / 100 / 93.75      |               1340 |                    1348 |
| packages/cache-plugin/src/middleware/cache-middleware.ts                    | 100 / 100 / 100    | 96.96 / 100 / 100     |                225 |                     225 |
| packages/cache-plugin/src/plugin/cache-plugin.ts                            | 95.8 / 100 / 93.8  | 92.3 / 100 / 95.89    |                225 |                     225 |
| packages/cache-plugin/src/services/cache-service.ts                         | 97.1 / 100 / 96.6  | 94.44 / 100 / 93.02   |                225 |                     225 |
| packages/cache-plugin/src/stores/memory-store.ts                            | 100 / 100 / 100    | 95 / 100 / 100        |                225 |                     225 |
| packages/cache-plugin/src/stores/redis-store.ts                             | 98.8 / 100 / 98.8  | 96.07 / 100 / 98.73   |                225 |                     225 |
| packages/cli/src/app-loader.ts                                              | 95.9 / 100 / 96.6  | 93.54 / 90 / 96.66    |               2350 |                    2369 |
| packages/cli/src/cli.ts                                                     | 94 / 100 / 96.8    | 91.17 / 100 / 94.52   |               2350 |                    2369 |
| packages/cli/src/commands/add.ts                                            | 98.4 / 100 / 97.7  | 94.38 / 100 / 97.64   |               2350 |                    2369 |
| packages/cli/src/commands/adopt.ts                                          | 94.6 / 100 / 100   | 94.54 / 100 / 100     |               2350 |                    2369 |
| packages/cli/src/commands/app.ts                                            | 96.8 / 100 / 97.6  | 93.98 / 100 / 96.63   |               2350 |                    2369 |
| packages/cli/src/commands/devtool.ts                                        | 93.9 / 100 / 91.9  | 90.13 / 100 / 96.78   |               2350 |                    2369 |
| packages/cli/src/commands/generate.ts                                       | 95.9 / 100 / 97.5  | 92.68 / 100 / 96.73   |               2350 |                    2369 |
| packages/cli/src/commands/new.ts                                            | 96.4 / 100 / 94.4  | 93.17 / 100 / 96.38   |               2350 |                    2369 |
| packages/cli/src/commands/workspace.ts                                      | 97.8 / 100 / 99.4  | 95.65 / 100 / 100     |               2350 |                    2369 |
| packages/cli/src/main.ts                                                    | 100 / 100 / 100    | 93.8 / 100 / 96.1     |               2350 |                    2369 |
| packages/cli/src/seams/seam-spec.ts                                         | 100 / 100 / 100    | 95.45 / 100 / 100     |               2350 |                    2369 |
| packages/cli/src/templates/broker.ts                                        | 96.8 / 100 / 100   | 95.83 / 100 / 100     |               2350 |                    2369 |
| packages/cli/src/templates/project-files.ts                                 | 94.9 / 100 / 99.5  | 90.16 / 97.29 / 98.63 |               2350 |                    2369 |
| packages/cli/src/templates/seam.ts                                          | 96.7 / 100 / 100   | 90.32 / 100 / 100     |               2350 |                    2369 |
| packages/cli/src/utils/file-writer.ts                                       | 99.1 / 100 / 99.5  | 97.34 / 100 / 99.5    |               2350 |                    2369 |
| packages/cli/src/utils/manifest-reader.ts                                   | 95.9 / 100 / 100   | 94.23 / 100 / 100     |               2350 |                    2369 |
| packages/cli/src/utils/plugin-detector.ts                                   | 100 / 100 / 100    | 95.65 / 100 / 100     |               2350 |                    2369 |
| packages/cli/src/utils/project-detector.ts                                  | 96 / 100 / 97.7    | 94.44 / 100 / 100     |               2350 |                    2369 |
| packages/cli/src/utils/render-declaration.ts                                | 100 / 100 / 100    | 97.05 / 100 / 100     |               2350 |                    2369 |
| packages/cli/src/utils/runtime-detector.ts                                  | 97.9 / 100 / 100   | 96.15 / 100 / 100     |               2350 |                    2369 |
| packages/cli/src/workspace/adopt.ts                                         | 93.5 / 100 / 99.3  | 90.9 / 100 / 100      |               2350 |                    2369 |
| packages/cli/src/workspace/manifest.ts                                      | 98.7 / 100 / 96.6  | 98.36 / 100 / 98.01   |               2350 |                    2369 |
| packages/cloudflare-plugin/src/database/d1-adapter.ts                       | 96.7 / 100 / 99    | 95.83 / 100 / 100     |                693 |                     693 |
| packages/cloudflare-plugin/src/database/d1-data-source.ts                   | 97.6 / 100 / 100   | 90.74 / 100 / 100     |                693 |                     693 |
| packages/cloudflare-plugin/src/database/d1-sql.ts                           | 97.4 / 100 / 96.7  | 91.54 / 100 / 98.43   |                693 |                     693 |
| packages/cloudflare-plugin/src/messaging/workers-broker.ts                  | 96.5 / 100 / 99.3  | 97.05 / 100 / 99.05   |                693 |                     693 |
| packages/cloudflare-plugin/src/plugin/cloudflare-plugin.ts                  | 98.6 / 100 / 100   | 97.91 / 100 / 100     |                693 |                     693 |
| packages/cloudflare-plugin/src/realtime/durable-object-backplane.ts         | 100 / 100 / 100    | 95 / 100 / 100        |                693 |                     693 |
| packages/cloudflare-plugin/src/stores/durable-object-idempotency-store.ts   | 94.7 / 100 / 99.2  | 91.48 / 100 / 97.82   |                693 |                     693 |
| packages/common/src/errors/serialize-error.ts                               | 96.9 / 100 / 98.1  | 90.74 / 100 / 100     |                866 |                     870 |
| packages/common/src/form/content-type.ts                                    | 96.7 / 100 / 100   | 95.83 / 100 / 100     |                866 |                     870 |
| packages/common/src/form/multipart-parser.ts                                | 97.1 / 100 / 97.5  | 94.68 / 100 / 99.03   |                866 |                     870 |
| packages/common/src/redaction/field-matcher.ts                              | 95.7 / 100 / 97.4  | 94.73 / 100 / 95.12   |                866 |                     870 |
| packages/common/src/request-identity.ts                                     | 100 / 100 / 100    | 95 / 100 / 96.72      |                866 |                     870 |
| packages/common/src/services/cursor.ts                                      | 96.1 / 100 / 100   | 92.96 / 100 / 100     |                866 |                     870 |
| packages/common/src/trace-context.ts                                        | 100 / 100 / 100    | 95.23 / 100 / 100     |                866 |                     870 |
| packages/config-plugin/src/diagnostics/provenance.ts                        | 97.5 / 100 / 97.3  | 96.2 / 100 / 97.14    |                144 |                     146 |
| packages/config-plugin/src/services/env-loader.ts                           | 98.5 / 100 / 100   | 97.5 / 100 / 100      |                144 |                     146 |
| packages/config-plugin/src/services/variable-expander.ts                    | 100 / 100 / 100    | 92.85 / 100 / 100     |                144 |                     146 |
| packages/database-plugin/src/adapters/bigtable/bigtable-adapter.ts          | 92.5 / 100 / 98.5  | 93.61 / 100 / 98.21   |               1952 |                    1971 |
| packages/database-plugin/src/adapters/bigtable/bigtable-data-source.ts      | 98.3 / 100 / 100   | 97.52 / 100 / 100     |               1952 |                    1971 |
| packages/database-plugin/src/adapters/bigtable/bigtable-scan.ts             | 97.7 / 100 / 100   | 96.92 / 100 / 100     |               1952 |                    1971 |
| packages/database-plugin/src/adapters/cosmos/cosmos-adapter.ts              | 90.5 / 100 / 97.5  | 92.59 / 100 / 96.22   |               1952 |                    1971 |
| packages/database-plugin/src/adapters/cosmos/cosmos-data-source.ts          | 98 / 100 / 99.8    | 97.1 / 100 / 100      |               1952 |                    1971 |
| packages/database-plugin/src/adapters/cosmos/cosmos-partition-key.ts        | 95.7 / 100 / 100   | 92.85 / 100 / 100     |               1952 |                    1971 |
| packages/database-plugin/src/adapters/cosmos/cosmos-transaction.ts          | 97.6 / 100 / 100   | 96.66 / 100 / 100     |               1952 |                    1971 |
| packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts            | 96.1 / 94.8 / 96   | 91.43 / 95.89 / 96.53 |               1952 |                    1971 |
| packages/database-plugin/src/adapters/dynamo/dynamo-data-source.ts          | 94.3 / 100 / 94.2  | 92.56 / 100 / 96.8    |               1952 |                    1971 |
| packages/database-plugin/src/adapters/memory/memory-adapter.ts              | 97.2 / 100 / 98.3  | 94.56 / 100 / 98.14   |               1952 |                    1971 |
| packages/database-plugin/src/adapters/mongo/mongo-adapter.ts                | 93.2 / 100 / 90.4  | 97.5 / 92.85 / 98.66  |               1952 |                    1971 |
| packages/database-plugin/src/adapters/mongo/mongo-data-source.ts            | 94.4 / 100 / 98.3  | 92.07 / 100 / 98.03   |               1952 |                    1971 |
| packages/database-plugin/src/adapters/mongo/mongo-mapping.ts                | 100 / 100 / 100    | 97.14 / 100 / 100     |               1952 |                    1971 |
| packages/database-plugin/src/adapters/prisma/prisma-adapter.ts              | 93.6 / 95.7 / 96.2 | 92.07 / 96.36 / 96.83 |               1952 |                    1971 |
| packages/database-plugin/src/authorization/database-grant-source.ts         | 97.5 / 100 / 100   | 96.49 / 100 / 100     |               1952 |                    1971 |
| packages/database-plugin/src/inbox/database-inbox-store.ts                  | 98.6 / 100 / 99.2  | 94.44 / 100 / 99.17   |               1952 |                    1971 |
| packages/database-plugin/src/outbox/database-outbox-store.ts                | 99.2 / 100 / 98.2  | 98.71 / 100 / 99      |               1952 |                    1971 |
| packages/database-plugin/src/plugin/database-plugin.ts                      | 96.3 / 100 / 98.6  | 93.61 / 100 / 99.03   |               1952 |                    1971 |
| packages/database-plugin/src/query/query-builder.ts                         | 94.4 / 100 / 97.2  | 92.85 / 100 / 96.38   |               1952 |                    1971 |
| packages/database-plugin/src/services/database-service.ts                   | 94.9 / 100 / 97    | 96.66 / 100 / 96.83   |               1952 |                    1971 |
| packages/decorator-plugin/src/metadata/metadata-store.ts                    | 99.2 / 100 / 100   | 98.97 / 100 / 100     |                465 |                     469 |
| packages/decorator-plugin/src/plugin/decorator-plugin.ts                    | 98.6 / 100 / 99.2  | 96.05 / 100 / 98.96   |                465 |                     469 |
| packages/decorator-plugin/src/plugin/ingress-registration.ts                | 95.8 / 100 / 99    | 94.66 / 100 / 99.17   |                465 |                     469 |
| packages/decorator-plugin/src/resolvers/parameter-resolver.ts               | 98.4 / 100 / 99.1  | 97.67 / 100 / 97.77   |                465 |                     469 |
| packages/diagnostics-plugin/src/client/client.ts                            | 94 / 100 / 93.9    | 90.45 / 95.83 / 94.54 |                868 |                     895 |
| packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts                | 99.3 / 100 / 99    | 92.13 / 92.3 / 95.96  |                868 |                     895 |
| packages/diagnostics-plugin/src/protocol/authorization-protocol.ts          | 91.4 / 100 / 93.3  | 90.29 / 100 / 90.85   |                868 |                     895 |
| packages/diagnostics-plugin/src/protocol/cache-protocol.ts                  | 98.6 / 100 / 98.7  | 99.01 / 100 / 98.16   |                868 |                     895 |
| packages/diagnostics-plugin/src/protocol/outbound-http-protocol.ts          | 97.8 / 100 / 97.5  | 98.07 / 100 / 97.27   |                868 |                     895 |
| packages/diagnostics-plugin/src/protocol/protocol.ts                        | 99.4 / 100 / 99.3  | 99.22 / 100 / 98.96   |                868 |                     895 |
| packages/diagnostics-plugin/src/protocol/queue-protocol.ts                  | 98.9 / 100 / 99    | 98.81 / 100 / 98.21   |                868 |                     895 |
| packages/diagnostics-plugin/src/protocol/realtime-protocol.ts               | 99 / 100 / 98.6    | 98.78 / 100 / 98.54   |                868 |                     895 |
| packages/diagnostics-plugin/src/protocol/scheduler-protocol.ts              | 94.4 / 100 / 94.1  | 94.11 / 100 / 93.51   |                868 |                     895 |
| packages/diagnostics-plugin/src/protocol/storage-protocol.ts                | 97.8 / 100 / 98.1  | 97.9 / 100 / 97.87    |                868 |                     895 |
| packages/diagnostics-plugin/src/transport/connector-handler.ts              | 92 / 100 / 93.5    | 90.79 / 100 / 95.37   |                868 |                     895 |
| packages/diagnostics-plugin/src/transport/limits.ts                         | 93.9 / 100 / 96.4  | 92 / 100 / 96.15      |                868 |                     895 |
| packages/diagnostics-plugin/src/transport/queue-merger.ts                   | 98.6 / 100 / 100   | 97.22 / 100 / 100     |                868 |                     895 |
| packages/events-plugin/src/bus/in-memory-event-bus.ts                       | 100 / 100 / 100    | 100 / 93.75 / 97.18   |                125 |                     125 |
| packages/events-plugin/src/diagnostics/event-observations.ts                | 95.9 / 100 / 96.6  | 95.79 / 100 / 95.51   |                125 |                     125 |
| packages/exceptions/src/middleware/error-handler.ts                         | 98.4 / 100 / 100   | 95.83 / 100 / 100     |                204 |                     204 |
| packages/exceptions/src/middleware/error-responder-impl.ts                  | 95.5 / 100 / 100   | 94.11 / 100 / 100     |                204 |                     204 |
| packages/feature-flags-plugin/src/providers/launchdarkly-module.ts          | 93.8 / 100 / 94.4  | 100 / 100 / 93.33     |                150 |                     150 |
| packages/feature-flags-plugin/src/providers/launchdarkly-provider.ts        | 95.9 / 100 / 99.2  | 92.85 / 100 / 100     |                150 |                     150 |
| packages/graphql-plugin/src/apq/apq-resolver.ts                             | 100 / 100 / 100    | 95.83 / 100 / 100     |                485 |                     489 |
| packages/graphql-plugin/src/execution/document-cache.ts                     | 100 / 100 / 100    | 90 / 100 / 100        |                485 |                     489 |
| packages/graphql-plugin/src/execution/executor.ts                           | 98.6 / 100 / 99.4  | 98 / 100 / 100        |                485 |                     489 |
| packages/graphql-plugin/src/http/graphql-handler.ts                         | 94.7 / 100 / 97.7  | 92.38 / 100 / 97.56   |                485 |                     489 |
| packages/graphql-plugin/src/http/request-parser.ts                          | 98.4 / 100 / 95.6  | 97.91 / 100 / 94.73   |                485 |                     489 |
| packages/graphql-plugin/src/schema/build-schema.ts                          | 96.7 / 100 / 100   | 94.44 / 100 / 100     |                485 |                     489 |
| packages/graphql-plugin/src/security/mask-errors.ts                         | 97.1 / 100 / 96.7  | 96.66 / 100 / 96.87   |                485 |                     489 |
| packages/graphql-plugin/src/services/graphql-service.ts                     | 94.6 / 100 / 97.9  | 93.5 / 100 / 98.63    |                485 |                     489 |
| packages/graphql-plugin/src/transports/sse/graphql-sse-handler.ts           | 94.4 / 100 / 97.7  | 91.48 / 100 / 97.9    |                485 |                     489 |
| packages/graphql-plugin/src/transports/ws/graphql-ws-handler.ts             | 94.8 / 100 / 96.6  | 90.74 / 100 / 99.25   |                485 |                     489 |
| packages/graphql-plugin/src/transports/ws/ws-protocol.ts                    | 96.7 / 100 / 96.4  | 94.73 / 100 / 97.56   |                485 |                     489 |
| packages/grpc-plugin/src/transports/connect-router-builder.ts               | 93.2 / 100 / 100   | 90.24 / 100 / 100     |                215 |                     216 |
| packages/health-plugin/src/diagnostics/health-observation-collector.ts      | 98.4 / 100 / 98.9  | 97.32 / 92.85 / 98.96 |                156 |                     156 |
| packages/health-plugin/src/plugin/health-plugin.ts                          | 97.8 / 100 / 98.7  | 90 / 100 / 98.38      |                156 |                     156 |
| packages/http-security-plugin/src/middleware/cors-middleware.ts             | 96.6 / 100 / 95.4  | 95.08 / 100 / 95.08   |                143 |                     143 |
| packages/http-security-plugin/src/middleware/security-headers-middleware.ts | 95.5 / 100 / 97.8  | 92.68 / 100 / 97.91   |                143 |                     143 |
| packages/idempotency-plugin/src/core/fingerprint.ts                         | 97 / 100 / 99      | 96 / 100 / 98.21      |                321 |                     348 |
| packages/idempotency-plugin/src/core/options.ts                             | 96.4 / 100 / 93.7  | 94.83 / 100 / 93.1    |                321 |                     348 |
| packages/idempotency-plugin/src/core/record.ts                              | 93.6 / 100 / 94.5  | 91.66 / 100 / 96.11   |                321 |                     348 |
| packages/idempotency-plugin/src/middleware/http-middleware.ts               | 98.2 / 100 / 100   | 97.14 / 100 / 98.96   |                321 |                     348 |
| packages/idempotency-plugin/src/middleware/idempotent.ts                    | 95.5 / 100 / 100   | 92.85 / 100 / 100     |                321 |                     348 |
| packages/idempotency-plugin/src/stores/memory-store.ts                      | 93.8 / 93.3 / 97.1 | 93.42 / 92.85 / 96.93 |                321 |                     348 |
| packages/idempotency-plugin/src/within/transactional-runtime.ts             | 98.2 / 100 / 97.7  | 97.5 / 100 / 98.36    |                321 |                     348 |
| packages/kernel/src/application/application.ts                              | 95.2 / 100 / 97.2  | 90.47 / 98.19 / 97.28 |                492 |                     498 |
| packages/kernel/src/application/inject-body.ts                              | 95.1 / 100 / 100   | 92.59 / 100 / 100     |                492 |                     498 |
| packages/kernel/src/context/response.ts                                     | 100 / 100 / 100    | 100 / 95.83 / 98.7    |                492 |                     498 |
| packages/kernel/src/diagnostics/buffer.ts                                   | 96.4 / 100 / 97.6  | 96 / 100 / 97.43      |                492 |                     498 |
| packages/kernel/src/diagnostics/collector.ts                                | 93 / 100 / 94.9    | 90.22 / 100 / 92.22   |                492 |                     498 |
| packages/kernel/src/pipeline/execute-chain.ts                               | 97.8 / 100 / 100   | 96.55 / 100 / 100     |                492 |                     498 |
| packages/kernel/src/pipeline/middleware-pipeline.ts                         | 95 / 100 / 100     | 93.75 / 100 / 100     |                492 |                     498 |
| packages/kernel/src/registry/plugin-resolver.ts                             | 100 / 100 / 100    | 97.36 / 100 / 100     |                492 |                     498 |
| packages/kernel/src/router/router.ts                                        | 95.3 / 93.5 / 93.2 | 91.42 / 93.54 / 93.25 |                492 |                     498 |
| packages/logger-plugin/src/plugin/logger-plugin.ts                          | 98 / 100 / 100     | 90.24 / 100 / 100     |                141 |                     141 |
| packages/mail-plugin/src/providers/sendgrid-provider.ts                     | 100 / 100 / 100    | 95.83 / 90.9 / 100    |                101 |                     101 |
| packages/mail-plugin/src/providers/ses-provider.ts                          | 96.2 / 100 / 100   | 92.85 / 100 / 100     |                101 |                     101 |
| packages/mail-plugin/src/providers/smtp-provider.ts                         | 97.2 / 100 / 100   | 96.66 / 100 / 100     |                101 |                     101 |
| packages/mail-plugin/src/templates/template-engine.ts                       | 100 / 100 / 100    | 95.45 / 100 / 100     |                101 |                     101 |
| packages/messaging-plugin/src/brokers/describe-error.ts                     | 100 / 100 / 100    | 98.24 / 100 / 100     |               1560 |                    1588 |
| packages/messaging-plugin/src/brokers/in-memory-broker.ts                   | 97.8 / 100 / 98.9  | 96.15 / 100 / 98.75   |               1560 |                    1588 |
| packages/messaging-plugin/src/brokers/kafka-broker.ts                       | 97 / 100 / 99.3    | 96.33 / 96.42 / 100   |               1560 |                    1588 |
| packages/messaging-plugin/src/brokers/nats-broker.ts                        | 95.4 / 95.2 / 97.2 | 92.23 / 100 / 99.13   |               1560 |                    1588 |
| packages/messaging-plugin/src/brokers/pubsub-broker.ts                      | 95.7 / 100 / 98.1  | 92.39 / 100 / 98.81   |               1560 |                    1588 |
| packages/messaging-plugin/src/brokers/reconnect.ts                          | 95.7 / 100 / 96.4  | 93.93 / 100 / 96.82   |               1560 |                    1588 |
| packages/messaging-plugin/src/brokers/redis-streams-broker.ts               | 96.2 / 97.5 / 98.4 | 92.48 / 96.15 / 98.71 |               1560 |                    1588 |
| packages/messaging-plugin/src/brokers/request-reply-core.ts                 | 100 / 100 / 100    | 96.42 / 100 / 100     |               1560 |                    1588 |
| packages/messaging-plugin/src/brokers/service-bus-broker.ts                 | 94.9 / 100 / 98.6  | 90.9 / 100 / 99.12    |               1560 |                    1588 |
| packages/messaging-plugin/src/inbox/inbox-service.ts                        | 99.2 / 100 / 100   | 98.59 / 100 / 100     |               1560 |                    1588 |
| packages/messaging-plugin/src/outbox/outbox-collector.ts                    | 93.8 / 100 / 100   | 90 / 100 / 100        |               1560 |                    1588 |
| packages/messaging-plugin/src/outbox/outbox-health.ts                       | 95.3 / 100 / 100   | 94.59 / 100 / 100     |               1560 |                    1588 |
| packages/messaging-plugin/src/outbox/outbox-service.ts                      | 100 / 100 / 100    | 98.57 / 100 / 100     |               1560 |                    1588 |
| packages/messaging-plugin/src/outbox/record-codec.ts                        | 98.4 / 100 / 99    | 97.91 / 100 / 100     |               1560 |                    1588 |
| packages/messaging-plugin/src/outbox/relay.ts                               | 98.3 / 100 / 99.3  | 94.33 / 100 / 100     |               1560 |                    1588 |
| packages/messaging-plugin/src/pipeline/pipelined-broker.ts                  | 100 / 100 / 100    | 94.73 / 100 / 100     |               1560 |                    1588 |
| packages/messaging-plugin/src/plugin/messaging-plugin.ts                    | 97.8 / 96 / 98     | 95.41 / 100 / 98.9    |               1560 |                    1588 |
| packages/metrics-plugin/src/metrics/base-metric.ts                          | 96.3 / 100 / 100   | 94.73 / 100 / 100     |                251 |                     252 |
| packages/metrics-plugin/src/metrics/summary.ts                              | 97 / 100 / 98.2    | 93.75 / 100 / 98.46   |                251 |                     252 |
| packages/metrics-plugin/src/services/metrics-service.ts                     | 98.1 / 100 / 98.2  | 96.61 / 100 / 97.95   |                251 |                     252 |
| packages/multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts            | 96.1 / 100 / 97.4  | 92.94 / 100 / 96      |                188 |                     188 |
| packages/multi-tenancy-plugin/src/resolvers/jwt-resolver.ts                 | 94.7 / 100 / 96.6  | 94.44 / 100 / 100     |                188 |                     188 |
| packages/multi-tenancy-plugin/src/resolvers/subdomain-resolver.ts           | 92.9 / 100 / 100   | 90.9 / 100 / 100      |                188 |                     188 |
| packages/multi-tenancy-plugin/src/stores/memory-tenant-store.ts             | 96.2 / 100 / 98.5  | 94.28 / 100 / 98.46   |                188 |                     188 |
| packages/notification-plugin/src/providers/token-source.ts                  | 97.3 / 100 / 98.1  | 95 / 100 / 98.11      |                106 |                     106 |
| packages/openapi-plugin/src/generators/openapi-generator.ts                 | 98.4 / 100 / 100   | 97.32 / 97.36 / 100   |                309 |                     310 |
| packages/openapi-plugin/src/transformers/zod-to-openapi.ts                  | 96.7 / 100 / 98.7  | 94.56 / 100 / 99.59   |                309 |                     310 |
| packages/queue-plugin/src/adapters/memory-queue.ts                          | 100 / 100 / 100    | 97.61 / 96 / 100      |                551 |                     552 |
| packages/queue-plugin/src/adapters/rabbitmq-queue.ts                        | 96.7 / 100 / 95.5  | 96.39 / 97.61 / 98.19 |                551 |                     552 |
| packages/queue-plugin/src/adapters/redis-queue.ts                           | 98.8 / 100 / 98.2  | 96.8 / 100 / 98.99    |                551 |                     552 |
| packages/queue-plugin/src/adapters/sqs-queue.ts                             | 93.2 / 100 / 95.2  | 90.25 / 100 / 96.17   |                551 |                     552 |
| packages/queue-plugin/src/diagnostics/queue-observation-collector.ts        | 99.6 / 100 / 100   | 99.36 / 93.93 / 100   |                551 |                     552 |
| packages/queue-plugin/src/scheduler/cron-calculator.ts                      | 92.5 / 100 / 91.9  | 90.32 / 100 / 93.38   |                551 |                     552 |
| packages/queue-plugin/src/services/queue-service.ts                         | 97.1 / 100 / 97.1  | 94.82 / 100 / 96.5    |                551 |                     552 |
| packages/queue-plugin/src/sns/sns-publisher.ts                              | 100 / 100 / 100    | 93.75 / 100 / 100     |                551 |                     552 |
| packages/react-router-plugin/src/assets/static-assets.ts                    | 97.7 / 100 / 100   | 95.45 / 100 / 100     |                122 |                     123 |
| packages/react-router-plugin/src/handler/server-build.ts                    | 95.8 / 100 / 100   | 91.66 / 100 / 100     |                122 |                     123 |
| packages/react-router-plugin/src/plugin/react-router-plugin.ts              | 100 / 100 / 100    | 94.44 / 100 / 100     |                122 |                     123 |
| packages/realtime-backplane-plugin/src/transports/memory-backplane.ts       | 97 / 100 / 100     | 94.73 / 100 / 100     |                145 |                     146 |
| packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts    | 97.5 / 100 / 100   | 96.29 / 100 / 100     |                145 |                     146 |
| packages/realtime-backplane-plugin/src/transports/redis-backplane.ts        | 96.2 / 100 / 96.3  | 95.52 / 94.44 / 97.7  |                145 |                     146 |
| packages/realtime-backplane-plugin/src/transports/redis-module.ts           | 94.4 / 100 / 95    | 100 / 100 / 94.44     |                145 |                     146 |
| packages/resilience-plugin/src/patterns/retry.ts                            | 95.7 / 100 / 95.7  | 90 / 100 / 96         |                 88 |                      90 |
| packages/runtime/src/adapters/bun/bun-http-adapter.ts                       | 95.2 / 100 / 98.6  | 92.3 / 100 / 98.33    |                567 |                     570 |
| packages/runtime/src/adapters/deno/deno-runtime.ts                          | 94.9 / 100 / 94.9  | 94.4 / 100 / 94.9     |                567 |                     570 |
| packages/runtime/src/adapters/node/node-http-adapter.ts                     | 95 / 100 / 96.2    | 91.66 / 96.15 / 95.65 |                567 |                     570 |
| packages/runtime/src/adapters/shared/fetch-mapping.ts                       | 100 / 100 / 100    | 100 / 94.73 / 100     |                567 |                     570 |
| packages/runtime/src/adapters/workers/cf-http-adapter.ts                    | 95 / 100 / 98.9    | 90 / 100 / 100        |                567 |                     570 |
| packages/runtime/src/worker/task-port.ts                                    | 95.5 / 100 / 100   | 91.66 / 100 / 100     |                567 |                     570 |
| packages/scheduler-plugin/src/cron/cron-parser.ts                           | 98.2 / 100 / 95.2  | 98.59 / 100 / 94.48   |                331 |                     331 |
| packages/scheduler-plugin/src/diagnostics/scheduler-observations.ts         | 96.4 / 100 / 95.9  | 96.58 / 100 / 95.1    |                331 |                     331 |
| packages/scheduler-plugin/src/jobs/job-executor.ts                          | 96.6 / 100 / 100   | 92.3 / 92.85 / 100    |                331 |                     331 |
| packages/scheduler-plugin/src/plugin/scheduler-plugin.ts                    | 100 / 90 / 99.6    | 97.61 / 100 / 100     |                331 |                     331 |
| packages/scheduler-plugin/src/services/scheduler-service.ts                 | 96 / 100 / 99.1    | 94.28 / 100 / 100     |                331 |                     331 |
| packages/sdk/src/codegen/openapi-codegen.ts                                 | 97.3 / 100 / 98.8  | 95.38 / 100 / 98.83   |                490 |                     493 |
| packages/sdk/src/http/http-client.ts                                        | 97.7 / 100 / 99.6  | 96.55 / 100 / 99.15   |                490 |                     493 |
| packages/sdk/src/http/idempotency-key.ts                                    | 97.6 / 100 / 96.5  | 97.36 / 100 / 97.05   |                490 |                     493 |
| packages/sdk/src/http/observed-fetch.ts                                     | 96.3 / 100 / 97.5  | 93.93 / 100 / 96.66   |                490 |                     493 |
| packages/sdk/src/http/rate-limiter.ts                                       | 95.2 / 100 / 100   | 91.66 / 100 / 100     |                490 |                     493 |
| packages/sdk/src/realtime/realtime-client.ts                                | 96.1 / 95 / 98.6   | 95.23 / 94.73 / 100   |                490 |                     493 |
| packages/sdk/src/realtime/sse-frame-parser.ts                               | 92.3 / 100 / 97.6  | 91.66 / 100 / 100     |                490 |                     493 |
| packages/sdk/src/retry/retry-strategy.ts                                    | 99 / 100 / 99.1    | 100 / 100 / 98.21     |                490 |                     493 |
| packages/secrets-plugin/src/providers/aws-kms.ts                            | 96.7 / 100 / 100   | 96.15 / 100 / 100     |                143 |                     144 |
| packages/secrets-plugin/src/providers/azure-key-vault.ts                    | 92.3 / 100 / 98.9  | 91.3 / 100 / 97.43    |                143 |                     144 |
| packages/secrets-plugin/src/providers/gcp-secret-manager.ts                 | 95.7 / 100 / 99.1  | 94.87 / 100 / 98      |                143 |                     144 |
| packages/secrets-plugin/src/providers/vault.ts                              | 99.1 / 100 / 97.7  | 98.18 / 100 / 100     |                143 |                     144 |
| packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts    | 97.4 / 100 / 99    | 96.15 / 100 / 100     |                235 |                     236 |
| packages/service-discovery-plugin/src/providers/dns-provider.ts             | 96.2 / 100 / 100   | 93.75 / 100 / 100     |                235 |                     236 |
| packages/service-discovery-plugin/src/providers/kubernetes-provider.ts      | 98.4 / 100 / 100   | 97.22 / 100 / 100     |                235 |                     236 |
| packages/service-discovery-plugin/src/providers/kubernetes-watch.ts         | 97.8 / 100 / 97.9  | 95 / 100 / 98.27      |                235 |                     236 |
| packages/service-discovery-plugin/src/providers/static-provider.ts          | 100 / 100 / 100    | 92.85 / 100 / 100     |                235 |                     236 |
| packages/service-discovery-plugin/src/services/ejection-tracker.ts          | 94.6 / 100 / 97.5  | 92.85 / 100 / 97.56   |                235 |                     236 |
| packages/service-discovery-plugin/src/services/service-discovery-service.ts | 95.5 / 100 / 98.6  | 95.65 / 100 / 98.48   |                235 |                     236 |
| packages/session-plugin/src/codec/crypto.ts                                 | 100 / 100 / 100    | 94.44 / 100 / 100     |                304 |                     304 |
| packages/session-plugin/src/csrf/verify.ts                                  | 100 / 100 / 100    | 95.65 / 100 / 100     |                304 |                     304 |
| packages/session-plugin/src/services/session-service.ts                     | 98.9 / 100 / 100   | 98.07 / 100 / 100     |                304 |                     304 |
| packages/sse-plugin/src/channels/channel-registry.ts                        | 100 / 93.8 / 95.7  | 100 / 92.85 / 96.42   |                139 |                     140 |
| packages/sse-plugin/src/connection/sse-connection.ts                        | 95.3 / 100 / 98.4  | 92 / 100 / 100        |                139 |                     140 |
| packages/sse-plugin/src/services/sse-service.ts                             | 97.3 / 100 / 99.1  | 95.23 / 100 / 100     |                139 |                     140 |
| packages/starters/rest-starter/src/app.ts                                   | 95.2 / 100 / 100   | 94.73 / 100 / 100     |                 44 |                      44 |
| packages/static-plugin/src/handler/static-handler.ts                        | 97 / 100 / 98.1    | 94.02 / 100 / 98.33   |                172 |                     173 |
| packages/static-plugin/src/http/precompressed.ts                            | 100 / 100 / 100    | 92.85 / 100 / 100     |                172 |                     173 |
| packages/static-plugin/src/plugin/static-plugin.ts                          | 95.2 / 100 / 98.4  | 94.28 / 100 / 95      |                172 |                     173 |
| packages/storage-plugin/src/diagnostics/storage-observations.ts             | 99 / 100 / 98.7    | 100 / 100 / 98.16     |                430 |                     432 |
| packages/storage-plugin/src/middleware/upload-middleware.ts                 | 95.1 / 100 / 98    | 90 / 100 / 97.14      |                430 |                     432 |
| packages/storage-plugin/src/providers/azure-provider.ts                     | 100 / 96.9 / 100   | 98.36 / 97.14 / 99.14 |                430 |                     432 |
| packages/storage-plugin/src/providers/gcs-provider.ts                       | 95.7 / 100 / 99.5  | 94 / 100 / 100        |                430 |                     432 |
| packages/storage-plugin/src/providers/provider-stream.ts                    | 98.6 / 100 / 100   | 95.91 / 100 / 100     |                430 |                     432 |
| packages/storage-plugin/src/providers/s3-provider.ts                        | 96.2 / 100 / 98.4  | 98.07 / 100 / 97.75   |                430 |                     432 |
| packages/storage-plugin/src/services/storage-service.ts                     | 95.5 / 100 / 96.8  | 94.87 / 100 / 95.18   |                430 |                     432 |
| packages/telemetry-plugin/src/diagnostics/diagnostic-span-processor.ts      | 95.5 / 100 / 98.5  | 93.75 / 100 / 98.3    |                334 |                     340 |
| packages/telemetry-plugin/src/diagnostics/span-observation-collector.ts     | 96.6 / 100 / 97.3  | 95.53 / 100 / 95.96   |                334 |                     340 |
| packages/telemetry-plugin/src/instrumentation/instrumentation-registry.ts   | 97.3 / 100 / 99.3  | 90 / 100 / 100        |                334 |                     340 |
| packages/telemetry-plugin/src/middleware/telemetry-middleware.ts            | 100 / 100 / 100    | 90 / 100 / 100        |                334 |                     340 |
| packages/telemetry-plugin/src/services/telemetry-service.ts                 | 100 / 100 / 100    | 95 / 100 / 100        |                334 |                     340 |
| packages/testing/src/mock-context.ts                                        | 97.6 / 100 / 100   | 97.4 / 100 / 100      |                168 |                     168 |
| packages/websocket-plugin/src/heartbeat/heartbeat.ts                        | 100 / 100 / 100    | 92.85 / 100 / 96.15   |                228 |                     228 |
| packages/websocket-plugin/src/plugin/websocket-plugin.ts                    | 100 / 100 / 100    | 95.83 / 100 / 100     |                228 |                     228 |
| packages/websocket-plugin/src/services/websocket-service.ts                 | 96 / 100 / 96.8    | 93.33 / 94.59 / 97.51 |                228 |                     228 |
| packages/worker-pool-plugin/src/pool/task-pool.ts                           | 98.1 / 100 / 99.2  | 92.15 / 100 / 99.52   |                202 |                     202 |
