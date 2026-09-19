# Milestone 99d — a composition the framework silently declines to give you

> **Status:** Planning. Branch: `feat/m99d-silent-declines`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Two places where a developer expresses a composition the framework then does not provide. One
ignores half of a class's decorators without a word; the other offers no way to express the
composition at all, so a documented code path cannot be reached outside the real cloud.

- **In scope:** a startup diagnostic when a class carries decorators the list it was given does not
  register; an endpoint option on the two cloud secrets providers that lack one.
- **NOT this milestone:** changing which list registers which family — the two-list design is M97a's
  and is correct; any change to `findExisting`, `@Gateway`'s socket categories, or the Azure and
  Vault providers, which already take an endpoint (§1).

## 1. Contracts verified from SOURCE (not names)

| Reference                               | Source (file:line)                                                                               | Verified surface / fact                                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The two class lists                     | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:66,70`                                 | `controllers?: readonly Constructor[]` and `ingress?: readonly Constructor[]` — separate, neither implying the other                                                                                                                                                   |
| The existing M64 warning                | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:786-806`                               | `warnControllersWithoutMetadata`; returns early when `ctx.logger === undefined`; fires on `!metadataStore.hasController`                                                                                                                                               |
| `hasController`                         | `packages/decorator-plugin/src/metadata/metadata-store.ts:487`                                   | the reader the existing warning uses                                                                                                                                                                                                                                   |
| Ingress metadata reader                 | `packages/decorator-plugin/src/metadata/metadata-store.ts:383,626`                               | `_ingress: Map<Constructor, IngressMetadata[]>` with a documented getter — so "does this class carry ingress metadata?" is already answerable                                                                                                                          |
| Ingress registration refusals           | `packages/decorator-plugin/src/plugin/ingress-registration.ts:26,46,69`                          | five distinct misuses already refused at `register()`, each naming class, method and alternative                                                                                                                                                                       |
| `AwsKmsProviderOptions`                 | `packages/secrets-plugin/src/providers/aws-kms.ts:32-41`                                         | `region` / `accessKeyId` / `secretAccessKey` / `client` — no endpoint                                                                                                                                                                                                  |
| `GcpSecretManagerProviderOptions`       | `packages/secrets-plugin/src/providers/gcp-secret-manager.ts:38-43`                              | `projectId` / `client` — no endpoint                                                                                                                                                                                                                                   |
| `AzureKeyVaultProviderOptions.vaultUrl` | `packages/secrets-plugin/src/providers/azure-key-vault.ts:36-37,74`                              | `vaultUrl` IS the endpoint — passed as `new SecretClient(vaultUrl, credential)`. **Azure is NOT affected**                                                                                                                                                             |
| `HashiCorpVaultProvider`                | `packages/secrets-plugin/src/providers/hashicorp-vault.ts`                                       | takes `address`; not affected                                                                                                                                                                                                                                          |
| `S3Provider.endpoint`                   | `packages/storage-plugin/src/providers/s3-provider.ts:58-59,93-95`                               | the model: `endpoint?: string`, JSDoc naming "R2, MinIO, B2, LocalStack", plus path-style handling for a custom host                                                                                                                                                   |
| AWS client construction                 | `packages/secrets-plugin/src/providers/aws-kms.ts:20,61-66,100-113`                              | `SecretsManagerClient: new (config: Record<string, unknown>)`; `buildAwsConfig` already assembles that object — so `endpoint` needs a key, not a new channel                                                                                                           |
| GCP client construction                 | `packages/secrets-plugin/src/providers/gcp-secret-manager.ts:25,70,77`                           | `SecretManagerServiceClient: new () => …` takes **no constructor argument**, and `adaptGcpModule(mod, projectId)` accepts no options — so GCP has no channel at all and both signatures must widen                                                                     |
| The GCP client's option NAME            | `google-gax` `build/src/clientInterface.d.ts:12` (4.6.1 and 6.4.0, read from the Deno npm cache) | `ClientOptions.apiEndpoint?: string`. There is **no `endpoint` member** anywhere in the chain — and `ClientStubOptions` (`grpc.d.ts`) carries `[index: string]: string \| number \| undefined \| {}`, so passing `endpoint` would type-check and be ignored at runtime |

**This corrects the originating finding.** V7-7 was filed saying three providers lacked an endpoint.
Verifying against source for this plan established it is **two** — Azure's `vaultUrl` is the
endpoint. The register, the run report and the ROADMAP row are corrected in the same change that
opens this letter.

**Measured, not inferred (V7-3).** One class carrying `@Controller` + `@Get` + `@Processor`, with a
logger attached so a warning would be visible: `controllers: [F]` gives HTTP `200` and the processor
never fires; `ingress: [F]` fires the processor and the routes answer `404`; both lists give both.
No diagnostic in any of the three.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                 | Resolution (picked side)                                           | Doc deliverable (same PR)                                                                    |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| C1 | `packages/decorator-plugin/README.md` — the page jsr.io renders — documents the `ingress` option nowhere; `docs/decorators.md:78` documents it correctly | `docs/decorators.md` is right. The README is incomplete, not wrong | the README gains an `ingress` section matching `docs/decorators.md`                          |
| C2 | `smoke/DEFECTS.md`, `smoke/V070-REGRESSION.md` and the M99d ROADMAP row each said three providers lack an endpoint                                       | Two, per §1. Azure and Vault already take one                      | all three corrected (done while writing this plan; recorded here so the change is traceable) |
| C3 | `PUBLIC_API.md` documents the secrets provider option tables                                                                                             | gains the new `endpoint` rows for AWS and GCP                      | `PUBLIC_API.md` rows updated                                                                 |

## 3. Design decisions

### 3.1 What the new diagnostic says, and when

- **Decision:** at `register()`, a class in `controllers` carrying ingress metadata warns, and a
  class in `ingress` carrying route metadata warns. Each names the class, the family that was
  ignored, and the other option. Both go through `ctx.logger.warn`.
- **Why:** the metadata is already in hand on the concrete store (§1), and the existing M64 warning
  cannot cover this case because the class legitimately HAS `@Controller` metadata. `warn` rather
  than a throw, matching M64: a class in both lists is legal and common, and refusing would break
  released compositions.
- **Test home:** `packages/decorator-plugin/test/unit/cross-family-warning.test.ts`.

### 3.2 Why not register the other family automatically

- **Decision:** the lists keep their exact meanings. Nothing is auto-registered.
- **Why:** registering ingress from `controllers` would make the two options synonyms and remove the
  developer's ability to register a class's HTTP half without its background half — a real
  composition, and the one `@Gateway`-bearing classes need. The defect is silence, not the split.
- **Test home:** the same test asserts the behaviour is byte-identical apart from the warning.

### 3.3 Where the warning is emitted from

- **Decision:** one function beside `warnControllersWithoutMetadata`, called from the same place,
  with the same `ctx.logger === undefined` early return.
- **Why:** the existing warning already establishes the timing, the sink and the no-logger
  behaviour; a second mechanism would be able to drift from it.
- **Test home:** the same test drives a real `LoggerPlugin`, because the M64 warning is invisible
  without one and a fixture asserting on a fake sink would not have caught that.

### 3.4 The shape of the secrets endpoint option

- **Decision:** `endpoint?: string | undefined` on both `AwsKmsProviderOptions` and
  `GcpSecretManagerProviderOptions` — one spelling in OUR surface — ignored when a `client` is
  injected.
- **Why one spelling:** it matches `S3Provider`, which is the in-repo model, and matches Azure's
  existing `vaultUrl` in effect. Optional, so every existing configuration compiles and behaves
  identically. Ignored under an injected client because that client is already constructed — the
  same rule `region` follows today.
- **Test home:** `packages/secrets-plugin/test/unit/provider-endpoint.test.ts`.

### 3.4a What each SDK is actually handed — they do NOT agree

- **Decision:** the option is TRANSLATED per provider, not forwarded under its own name. AWS
  receives `{ endpoint }` in the config object `buildAwsConfig` already assembles. GCP receives
  `{ apiEndpoint }`, and reaching it requires widening two signatures that today accept nothing: the
  facade becomes `SecretManagerServiceClient: new (options?: Record<string, unknown>) => …` and
  `adaptGcpModule` takes the options object rather than a bare `projectId`.
- **Why it cannot be forwarded verbatim:** `google-gax`'s `ClientOptions` declares `apiEndpoint` and
  has no `endpoint` member. Worse than a compile error, `ClientStubOptions` carries an index
  signature (`[index: string]: string | number | undefined | {}`), so `new Client({ endpoint })`
  type-checks, constructs, and silently talks to the production endpoint — a configuration the
  developer expressed and the library declines without a word, which is the defect class this
  milestone is named for. The plan's first draft said only "passed to the lazily-loaded client",
  which would have produced exactly that.
- **Why the facade widens rather than the provider constructing the client itself:** the
  `adapt(module)`/`load(module)` seam is M25's, and it is what makes the pure adapter unit-testable
  against a fake module. Widening the facade keeps the seam; bypassing it would not.
- **Test home:** the same test asserts the KEY each provider passes, per provider — `endpoint` for
  AWS and `apiEndpoint` for GCP — so forwarding the wrong one fails rather than passing silently.

### 3.5 Whether S3Provider's path-style handling is copied

- **Decision:** it is not. The endpoint is passed through and nothing else changes.
- **Why:** path-style addressing is an S3 bucket-URL concern (`<bucket>.<endpoint>`); Secrets
  Manager and Secret Manager address a service, not a bucket, so there is no equivalent to rewrite.
  Copying it would be surface with no consumer.
- **Test home:** the same test asserts the endpoint VALUE reaches the client unmodified. The key it
  arrives under is per-SDK (§3.4a); "unmodified" is about the string, never the member name.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                            | Kind   | Consumer / real code path that READS it                                                                                                          |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AwsKmsProviderOptions.endpoint`           | option | `aws-kms.ts`'s lazy client construction; and any application pointing at LocalStack or a private endpoint                                        |
| `GcpSecretManagerProviderOptions.endpoint` | option | `gcp-secret-manager.ts`'s lazy client construction, translated to the SDK's `apiEndpoint` (§3.4a); and the emulator host an application supplies |

No new function, class or token. `decorator-plugin`'s `src/index.ts` is unchanged — the warning is
internal — pinned by a `barrel-exports.test.ts`.

### 4.1 Options — every option names its consumer

| Option                                     | Consumer                                          | Behavior (per implementation)                                                                                                 |
| ------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `AwsKmsProviderOptions.endpoint`           | the lazy `@aws-sdk/client-secrets-manager` client | absent: SDK default resolution, unchanged. Present: passed as the config object's `endpoint`. With `client` injected: ignored |
| `GcpSecretManagerProviderOptions.endpoint` | the lazy `@google-cloud/secret-manager` client    | the same three arms, but present passes the SDK's `apiEndpoint` — the member `ClientOptions` declares (§3.4a)                 |

## 5. Implementation files

| File                                                          | Purpose                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/decorator-plugin/src/index.ts`                      | unchanged (pinned by test)                                                                                       |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts`    | the cross-family warning, beside `warnControllersWithoutMetadata`                                                |
| `packages/decorator-plugin/README.md`                         | C1 — the `ingress` section                                                                                       |
| `packages/secrets-plugin/src/index.ts`                        | unchanged; the option types are already exported                                                                 |
| `packages/secrets-plugin/src/providers/aws-kms.ts`            | `endpoint` option, threaded to the lazy client                                                                   |
| `packages/secrets-plugin/src/providers/gcp-secret-manager.ts` | `endpoint` option; facade constructor and `adaptGcpModule` widened to carry options; translated to `apiEndpoint` |
| `PUBLIC_API.md`                                               | C3 — the provider option rows                                                                                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                            | src covered                                               | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/decorator-plugin/test/unit/cross-family-warning.test.ts`   | `plugin/decorator-plugin.ts`                              | one class with `@Controller`+`@Get`+`@Processor`: `controllers`-only warns and names `ingress`; `ingress`-only warns and names `controllers`; BOTH lists warn about neither. Driven through a real `LoggerPlugin`, because the warning is invisible without one                                                                                                                                                                          |
| `packages/decorator-plugin/test/unit/cross-family-warning.test.ts`   | `plugin/decorator-plugin.ts`                              | registration behaviour is unchanged in all three cases — the routes and the processor fire exactly as measured in §1, so the warning is additive                                                                                                                                                                                                                                                                                         |
| `packages/decorator-plugin/test/unit/barrel-exports.test.ts`         | `src/index.ts`                                            | published surface unchanged                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/secrets-plugin/test/unit/provider-endpoint.test.ts`        | `providers/aws-kms.ts`, `providers/gcp-secret-manager.ts` | a fake SDK module records the constructor argument: absent endpoint passes none, present passes it, injected client ignores it. **The KEY is asserted per provider** — AWS's config carries `endpoint` and GCP's carries `apiEndpoint`, each also asserting the other key is ABSENT, so forwarding the wrong member fails instead of being silently dropped by gax's index signature. Types check against the widened options interfaces |
| `packages/secrets-plugin/test/integration/aws-endpoint-real.test.ts` | `providers/aws-kms.ts`                                    | **guarded real-emulator**: against `localstack/localstack:3` with `endpoint` set, `get` on an absent secret returns `null` rather than throwing — which is X28-1's actual question, unanswerable before this option existed. `ignore:`-guarded on `AWS_ENDPOINT_URL`                                                                                                                                                                     |
| `packages/secrets-plugin/test/types/provider-options.assert.ts`      | both option interfaces                                    | a compile-time fixture assigning an options object WITH `endpoint` and one without, so a narrowing of the type is a `deno check` failure rather than a silent runtime change                                                                                                                                                                                                                                                             |

Measured on `main` with `deno task test:coverage:pkg decorator-plugin secrets-plugin`:
`decorator-plugin.ts` **98.0 / 100.0 / 99.0**, `aws-kms.ts` **92.3 / 100.0 / 98.9**,
`gcp-secret-manager.ts` **93.3 / 100.0 / 98.9**. The two provider files have only two to three
points of branch headroom above the bar, so each new `endpoint` arm MUST carry its own case —
`provider-endpoint.test.ts`'s three arms per provider are sized for that, not for spare capacity.
The warning adds two arms to `decorator-plugin.ts`, both covered above.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m99d-silent-declines, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage
deno task check:docs        # C1 and C3 touch documented surface
deno task publish:check
```

Negative controls, each observed failing and reverted:

1. Remove the `controllers`-side warning — the first case reports no diagnostic, which is the
   measured pre-milestone behaviour.
2. Remove the `ingress`-side warning — the second case reports none, and that is the worse direction
   because its symptom is a `404`.
3. Drop `endpoint` from the AWS options — `provider-options.assert.ts` fails `deno check`, and the
   real-emulator test falls back to reaching AWS and fails on credentials, which is exactly the
   condition that made X20b's part (b) vacuous.
4. Forward GCP's `endpoint` under its own name instead of `apiEndpoint` — `provider-endpoint`'s key
   assertion fails. This is the control that matters most: the wrong key type-checks against gax's
   index signature and is ignored at runtime, so nothing but an explicit key assertion can see it.

## 8. Risks & mitigations

- A project already listing a class in both options now gets no warning and no change → that is the
  correct composition and the test pins it.
- A noisy warning for a class deliberately registered in one list only → the message names the
  ignored family, so the developer can move the class or split it; it is a warning, not a refusal.
- `endpoint` reaching a client that also has a `region` could conflict → the SDKs accept both and
  the endpoint wins, which is the documented AWS behaviour and what `S3Provider` already relies on.
- A plaintext local GCP emulator needs insecure channel credentials as well as `apiEndpoint` → out
  of scope and stated rather than implied: this milestone gives the composition a channel, and the
  GCP arm has no guarded emulator test (only AWS/LocalStack does), so nothing here claims a working
  local GCP round trip. `sslCreds` is a separate option and a separate decision.

## 9. Out of scope

- An endpoint option for Azure and Vault: both already have one (§1), which is what makes this
  letter two providers rather than four.
- Auto-registering the other decorator family (§3.2) — it would make the two options synonyms.
- X28-1's not-found sentinel itself: this letter makes it ANSWERABLE against an emulator for the
  first time; whether the sentinel is correct is a question for whoever reads that test's result.
