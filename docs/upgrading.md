# Upgrading Setu-TS

The CHANGELOG answers "what changed in the framework"; this guide answers "what must I change in
**my** project". A release that demands reader action adds an entry here, version by version — that
is a release step ([releasing.md](./releasing.md)), not a memory exercise.

Each heading names the release that **shipped** the change, so an upgrade spanning several releases
is the union of every section between the version you are on and the one you are moving to.

`## Unreleased` holds entries written as their milestone landed, which is where the knowledge is;
cutting a release renames that heading to the version and is a rename, not a recall.

## Unreleased

### Handle `409` for a duplicate key, where it used to be `500`

A write that duplicates a primary key or a unique index now rejects with `DuplicateKeyError` from
`@setu-ts/common` and answers `409 Conflict`. Before, every backend answered a masked `500`. Nothing
in your code has to change for the new status to be correct, but a test or a client matching `500`
for a duplicate stops matching. `instanceof DuplicateKeyError` replaces matching driver codes or
message text. Do not retry it: unlike `SerializationConflictError`, the same write fails the same
way.

### Make RabbitMQ handlers idempotent and configure `consumerRetry`

Durable consumer groups now retry handler failures with five total attempts and delays
`[5000, 30000, 120000, 600000]` ms. Make handlers idempotent: retries and a crash between confirmed
copy and original ack can repeat side effects. Deserialize and integration-event rejections
dead-letter immediately; `consumerRetry.isRetryable` can return false for other deterministic
failures. Set `consumerRetry: false` to retain the existing operator DLX policy.

Allow the application to declare durable `Q.retry.<delay>ms` quorum queues and `Q.dead`. Extend
vhost permissions before upgrading: the RabbitMQ user needs configure permission on `Q.dead` and
`Q.retry.<delay>ms`, read permission on `Q.retry.<delay>ms`, and write permission on the default
exchange, `amq.default`, which carries every retry and dead-letter copy (measured on RabbitMQ 4:
without them `subscribe()` fails with `403 ACCESS_REFUSED` on the first helper declaration, and a
copy published without `amq.default` write closes the channel). Changing delays is safe; changing
`deadLetterMaxLength` (default 10000) requires draining and deleting `Q.dead` before restart,
because RabbitMQ rejects changed queue arguments. Inspect `x-setu-attempts`, `x-setu-topic` and the
bounded `x-setu-error` in dead letters, and apply access/retention policy for their data. Default
prefetch is now 32 per consumer; configure `prefetch` for handler concurrency and latency. Injected
channels should implement `prefetch`. Private exclusive queues and RPC reply inboxes retain discard
behavior. A failed copy leaves the original unacked; the broker then closes that channel, which
returns it to `Q`, and reconnects, re-declaring the retry and dead queues before consuming again.

`ConsumerRetryOptions` now names the shared RabbitMQ/Redis retry object type; Redis behavior and its
existing option shape are unchanged.

Group names ending in `.dead` or `.retry.<digits>ms` are reserved when retries are enabled, and
generated helper names must fit 255 UTF-8 bytes. Rename conflicting groups, or set
`consumerRetry: false` to retain existing names. Migrate queues already occupying helper names in
the same vhost before enabling retries. Invalid names fail before declaration, so they cannot close
the shared consumer channel with a 406. Injected recovery channels must support publisher confirms,
`on`/`off` return listeners and `close()`; otherwise `subscribe()` on a retrying group now rejects,
so supply `createConfirmChannel()` or set `consumerRetry: false`. Mandatory retry/dead publishes
reject unroutable returns and leave the original unacked; `x-setu-disposition-id` is framework-owned
and replaced on each copy.

### Update `IRedisStreamsClient` facades and Redis consumer handlers

Injected messaging Redis facades must implement the required `xpending`, `xclaim`, and `xinfo`
methods using ioredis 5 RESP2 reply shapes, and accept `xgroup('DELCONSUMER', ...)`. A facade
missing a method now fails connection. Redis 6.2 or newer is required for `XPENDING IDLE`; its
trimmed-entry `XCLAIM` reply contains a null slot, which the facade must preserve.

Failed messages now redeliver, including pending entries from before an app restart. Make handlers
idempotent. Set `consumerRetry.delaysMs[0]` above the longest handler runtime to prevent another
replica claiming a slow handler's entry. Defaults are five total attempts, delays
`[30000, 60000, 300000, 600000]`, and a 5000 ms reclaim interval. `consumerRetry.isRetryable` can
return `false` for immediate dead-lettering; deserialize and integration-event rejections
dead-letter immediately regardless. There is no `consumerRetry: false` option.

Inspect failed messages in `<topic>.dead.<group>`; each carries its original fields,
`x-setu-source-id`, and `x-setu-deliveries`. Configure `deadLetterMaxLen` (default 10000,
approximate trimming) and suitable Redis access/retention policy for payload data.
`consumerIdleSweepMs` defaults to one hour. Clean consumers are removed on stop; consumers with
pending entries remain until their work is recovered.

### Set `referrerPolicy` for native full-stack forms (M101g)

Existing full-stack starter compositions should configure
`httpSecurity: { headers: { referrerPolicy: 'same-origin' } }` in `setu.config.ts`. The default
`no-referrer` policy can make Chromium send `Origin: null` on a native form post, which React Router
refuses. The full-stack scaffold now sets `same-origin`: cross-origin referrers remain suppressed,
and session CSRF and React Router origin checks remain enabled.

### Enable development policies with `setu devtool enable` (M101g)

Run `setu devtool enable` on an eligible Deno project to generate the CLI-managed
`src/devtool/diagnostics.ts` policy and wire recognized plugin calls. Manual configurations receive
guidance. Source options activate only when `createApp` receives its devtool argument. The module
contains approved names, never environment values, and is refreshed by `setu add`; keep
application-specific policies in application-owned configuration. Empty approval maps approve no
observations.

### Return `IKernelApplication` from scaffold factories (M101g, V8-12)

In `setu.config.ts`, replace `createApp`'s `IApplication` return annotation with
`IKernelApplication`, imported as a type from `@setu-ts/kernel`. For an async starter factory, use
`Promise<IKernelApplication>`. Remove the old common type import if nothing else reads it. The value
already has this type; the old annotation hid `inject`, `unregister`, and `hasPlugin` from
`createTestApp({ app: await createApp() })`. Workers' `boot` and `ensureBooted` helpers follow the
same type change in new scaffolds.

`setu add testing` now accepts `@setu-ts/testing`, putting it in Deno's import map or npm's
`devDependencies`. New socket-target scaffolds include `test/app.test.ts`; an existing project can
add the same composition-root smoke test using its runtime's test harness.

### Replace links inside a project before running a writing `setu` command

`setu` now refuses to write through, or `adopt` to move, a path reached through a symbolic link
inside the project or workspace, and refuses a dangling link, with nothing written. If you link a
file into a project on purpose (a shared `deno.json`, for example), replace the link with a copy
before running `generate`, `add`, `devtool enable`, `workspace ports --reallocate` or `adopt`. A
project reached through a linked parent directory needs no change.

### Refresh `main.dev.ts` and production images (M101f)

Upgrade every `@setu-ts/*` pin together before `setu devtool enable`; mixed versions are refused.
Apply the complete factory edit in the CLI README: the second parameter AND both usage spreads. The
development entry now stops when composition is discarded. Restore an edited entry before
`ports --reallocate`; only CLI-rendered entries are rewritten, and an unedited 0.8.0 entry counts as
one — the next reallocation or `devtool enable` upgrades it. Workspace manifests record
`devtoolBasePort` on first allocation, defaulting to `basePort + 1000` (capped at 65535). Standalone
defaults probe 4919–5019; read the reported port or pass `--devtool-port`.

Regenerate managed deployment files with `generate app`, `devtool enable`, or `ports --reallocate`
and rebuild production images to exclude the development entry and connector cache. Replace aliases
containing Unicode format characters (bidi controls, zero-width format characters) or the line and
paragraph separators U+2028/U+2029 with printable ones; these now fail at construction and wire
validation. Code matching the old "contains a control character" refusal text should match "contains
a control, format or line-separator character".

The devtool extension release must re-pin the framework to this milestone merge commit and retain
previous recipe renderings in its catalog. Until that cross-repository update, an older launcher may
refuse newly generated entries with `PREPARATION_FAILED`.

### Update programmatic CLI `Prompter` implementations

`Prompter.select` now returns `PromptSelection`. Replace a string result with
`{ kind: 'answer', value }`, inability to prompt with `{ kind: 'unavailable' }`, and user
cancellation with `{ kind: 'cancelled' }`. Cancellation stops scaffolding and exits `130`. This is a
breaking change for programmatic `Prompter` implementors and ships in `0.9.0`.

The four M101a entries (`acquireTimeoutMs`, `SecretProviderUnavailableError`, the `database` and
`queue` health data, `commandTimeoutMs`) do not fail to compile; each is a default that now applies
to a running application. The three M102 mail entries can. The three M101b messaging entries do not
fail to compile; each changes what a running broker names or refuses. The two M101c entries do not
fail to compile: one changes a documented recipe that otherwise refuses an IdP posting
`Origin: null`, the other makes the memory adapter refuse writes it used to accept. The RabbitMQ
durability entry does not fail to compile; it makes `publish()` and `add()` wait for the broker.

### Handle a rejecting RabbitMQ publish (`publishTimeoutMs`)

With `broker: 'rabbitmq'` (`messaging-plugin`) or `adapter: 'rabbitmq'` (`queue-plugin`),
`publish()` and `queue.add()` now resolve only once RabbitMQ has accepted the message, and reject
when it refuses it, when the channel closes first, or when `publishTimeoutMs` (default `15000`)
expires. Before, they resolved before RabbitMQ had stored anything and never rejected — which is
also why a broker restart could lose messages without any caller noticing. Code that published
without handling a rejection should now handle it. A rejection is not proof the message was dropped:
retrying can deliver it twice, so a retried message needs an idempotent consumer.

Messages are also published persistent now, so they survive a broker restart. To keep the old
transient publishes for deliberately ephemeral traffic, pass `persistentMessages: false`. An
injected AMQP connection without `createConfirmChannel()` still works, unconfirmed, and logs one
warning; a real amqplib connection always has the method.

### Give memory-adapter rows distinct keys, and do not change a key by `update` (M101c)

The memory adapter now refuses a `create` whose caller-supplied primary key is already stored, and
an `update` whose payload changes a primary-key value — every real backend already refuses both. A
test that inserted the same key twice, or renamed a row's id through `update`, now rejects: give
each row its own key (or let the adapter generate one), and delete and recreate a row to change its
id.

### Change the SAML CSRF recipe to use `CsrfOptions.exclude` instead of trusting the IdP origin (M101c)

If you run a SAML provider behind both CSRF defences, the documented recipe now exempts the ACS path
on **both** plugins rather than trusting the IdP's origin on `http-security-plugin`:

```diff
  SessionPlugin({
    secret: '…',
    csrf: { exclude: ['/auth/corp/acs'] },
  });
- HttpSecurityPlugin({ csrf: { trustedOrigins: ['https://sts.example.com'] } });
+ HttpSecurityPlugin({ csrf: { exclude: ['/auth/corp/acs'] } });
```

Why the change: an IdP that serves `Referrer-Policy: no-referrer` (Keycloak does) makes the browser
post the ACS with `Origin: null`. The old recipe's `trustedOrigins` admits only a REAL origin, so
under `Origin: null` the ACS answers `403` and sign-in is broken. The one allowlist answer —
`trustedOrigins: ['null']` — is worse than the exemption, because it admits every opaque-origin
`POST` on every route. `exclude` is path-scoped: it exempts the ACS, whose signed assertion,
single-use request and binding cookie are the defences the CSRF check would otherwise add. Nothing
to do if you do not run both CSRF defences in front of a SAML ACS, or if your IdP sends a real
origin and you keep `trustedOrigins` for it.

### Regenerate clients whose OpenAPI document declares `3xx` responses

Generated SDK clients keep an error arm for every declared `3xx`, including the statuses `fetch`
follows automatically (`301`, `302`, `303`, `307`, and `308`), since an unfollowed one — no
`Location` — still throws `HttpClientError`. Regenerate affected clients; any operation declaring an
auto-follow redirect or the OpenAPI `3XX` range now returns `unknown`, representing the follow
target body the document does not name. This also applies when the operation declares a `2xx`
response alongside the redirect.

### Keep `acquireTimeoutMs` below each scheduled job's interval

Every distributed-lock acquire is now bounded by `distributedLock.acquireTimeoutMs`, default `5000`.
An acquire still unsettled at the bound skips that fire. If a job runs more often than every five
seconds, set `acquireTimeoutMs` below its interval. If you set `commandTimeoutMs`, it must not
exceed a non-zero `acquireTimeoutMs`, or `SchedulerPlugin(...)` throws `RangeError`. `0` restores
the old unbounded wait, which leaves the schedule parked while the lock backend is unreachable.

### Catch `SecretProviderUnavailableError` where you handled a Vault error

A Vault request that fails on the network or times out (default `requestTimeoutMs: 5000`) now
rejects with `SecretProviderUnavailableError`, answered `503` through `errorHandler`, instead of a
plain `Error` answered as a masked `500`. Catch it by identity if you handled the old error, and
raise `requestTimeoutMs` if a slow Vault legitimately takes longer.

### Review alerts keyed on the `database` and `queue` health data

A Drizzle pool connection timeout now reports `degraded` instead of `down`, and, with `poolStats`
supplied, a saturated pool reports `up` with `reachable: 'unknown'` while its queries keep
completing through the adapter (a full pool with no completed query in 10 seconds reports
`degraded`; queries run on your own Drizzle instance are not counted, while once the typed
`getDrizzleDatabase`/`getDrizzleTransaction` seam is used progress is unobservable and saturation
reads `up`). An alert that paged on `down` for pool exhaustion should watch `degraded` or
`data.capacity` instead. Separately, a queue depth row the latest diagnostics cycle could not read
is now absent rather than repeating the previous count; a dashboard should read `depthCoverage`
instead of assuming every name has a row.

### Raise `commandTimeoutMs` for a slow Redis network

Cache and queue Redis commands are now bounded at `15000` ms through `commandTimeoutMs`. An injected
client is unaffected. Set `commandTimeoutMs` higher, or `0` to disable, if a command legitimately
takes longer.

### Await `TemplateEngine.render` if you call the mail template engine directly

`@setu-ts/mail-plugin`'s exported `TemplateEngine.render(name, data)` now returns a
`Promise<RenderedTemplate>` (M102), so a direct caller adds an `await`; unknown-template and
missing-placeholder refusals arrive as rejections rather than synchronous throws. Nothing to do if
you only ever reached templates through `IMailer.sendTemplate`, which already returned a promise.
The constructor's new second parameter (a view engine) is optional and only needed for the new
component-template arm, which `MailPlugin` supplies for you.

### Extend `MailStringTemplate`, not `MailTemplate`

`MailTemplate` is now the union `MailStringTemplate | MailComponentTemplate` (M102). TypeScript
refuses to extend or implement a union, so `interface X extends MailTemplate` (`TS2312`) and
`class Y implements MailTemplate` (`TS2422`) stop compiling. Name `MailStringTemplate` instead — it
carries the released `{ html?, text? }` shape. Anything that only holds or assigns a `MailTemplate`
value needs no change.

### Connect a `LogProvider` before sending through it directly

`@setu-ts/mail-plugin`'s `LogProvider` and `SendGridProvider` now reject a send while not connected,
matching the SMTP and SES providers. Through `MailPlugin` nothing changes, because the plugin
connects the provider during `register()`. A test that constructs `new LogProvider()` and sends on
it without connecting must add `await provider.connect()` first.

### Drain the old shared `messaging-consumers` Pub/Sub subscription

A Pub/Sub subscription with no `queue` is now named per topic, `messaging-consumers.<topic>`
(M101b). On upgrade every topic gets a new subscription, and an existing `messaging-consumers`
subscription keeps any backlog with no consumer. Pass
`SubscribeOptions.queue: 'messaging-consumers'` on the ONE topic that owns it until its backlog is
drained, then delete it. A subscription whose name is already bound to another topic now rejects
`subscribe()` with `PubSubSubscriptionBoundElsewhereError` instead of being attached to.

### Run NATS 2.10 or later for `setu.queue` consumer metadata

A NATS consumer now records its raw queue as `setu.queue` metadata (M101b), which the server accepts
from 2.10. On an older server every `subscribe()` rejects. If you use request-reply, the JetStream
stream must also cover `rr.req.<topic>` and `rr.inbox.>`.

### Pre-create Kafka topics, or expect `KafkaTopicUnavailableError`

A subscription to an unknown Kafka topic now retries for about 9 s (`retry`), then rejects with
`KafkaTopicUnavailableError` (M101b) — so on a broker without `auto.create.topics.enable`, `start()`
for a declared subscription to a missing topic fails after that budget rather than at once. Create
the topic first, or set `retry: { retries: 0 }` to fail immediately.

## 0.8.0

The two `app.inject()` changes below are silent — they compile, so the compiler will not point at
them. Neither affects a served request.

### Check a test that asserts no `content-type` for a `Blob` body

`inject()` now defaults the request's content type from a non-empty `Blob.type`, which is what the
platform already does for `new Request(url, { body: blob })`. Before, a `Blob` was treated as bare
bytes and contributed nothing, so an injected multipart upload answered `500` with an error claiming
the body was not multipart — while the same bytes through `app.fetch` answered `200`.

Nothing to do if you pass an untyped `Blob`, a `Uint8Array` or an `ArrayBuffer`: those still carry
no default, because bytes alone say nothing about their encoding. Two cases DO change. A test that
asserted the header's absence for a typed `Blob` now sees the type and should assert it instead. And
a route that BRANCHES on the content type now takes the branch the blob declares — if the type does
not describe the bytes, either correct the type or set `headers['content-type']` explicitly, which
still wins over the default.

### Stop catching the eleven storage provider methods in a synchronous `try`/`catch`

`@setu-ts/storage-plugin`'s cloud providers guard every operation with a connection check that
throws. Ten of the methods — `S3Provider` `get`/`delete`/`exists`/`getSignedUrl`/`getStream`,
`GcsProvider` `put`/`getStream`, and `AzureBlobProvider` `delete`/`exists`/`getSignedUrl` — are
typed `Promise<...>` but were not `async`, so that throw escaped **synchronously**:
`provider.get('k').catch(handleIt)` never ran, and the error was uncaught instead of handled. The
methods are now `async`, so the "not connected" precondition arrives as a REJECTION, matching the
`IStorage` contract and the providers' own `async` methods (which always rejected).
`AzureBlobProvider.getSignedUrl`'s second refusal — the resolved client has no account key to sign
with — rejects for the same reason.

`LocalStorageProvider.getSignedUrl` is the eleventh. Its refusal is permanent rather than a
lifecycle precondition — local storage cannot presign at all — but it escaped the same way, and it
escaped further: `StorageService.getSignedUrl` passes the provider's promise straight through
without awaiting it, so the throw came out of the `IStorage` you resolve from
`CAPABILITIES.STORAGE`, not just out of the provider class. If you configured
`StoragePlugin({ provider: 'local' })` and called `storage.getSignedUrl(...).catch(...)`, the
`catch` never ran. It now rejects with the same message.

If you pass your OWN provider to the exported `StorageService`, its `delete`, `exists` and
`getSignedUrl` used to hand your provider's promise straight back without awaiting it, so a
synchronous throw from your provider escaped `IStorage` too. They are now `async`. Nothing changes
for the five built-in providers, which all return promises.

No source change is needed in either case, but the two differ in what they observe. An `await`
caller sees exactly what it saw before: the operand is evaluated inside the surrounding
`try`/`catch`, so a synchronous throw and a rejection were already caught the same way. A `.catch()`
caller sees a real difference, and it is the point of the fix — `provider.get('k').catch(handleIt)`
evaluated `provider.get('k')` BEFORE `.catch` was attached, so the throw escaped and `handleIt`
never ran; now the promise rejects and `handleIt` runs.

What does need a source change is code that wrapped one of the eleven calls in a synchronous
`try`/`catch` without awaiting — `try { const p = provider.get(k); } catch { … }` — which now never
catches, because the throw no longer happens at the call. Move the handling onto the promise:
`await` the call inside an `async` function with a `try`/`catch` around the `await`, or attach
`.catch(...)`.

### Stop relying on `inject()` mutating a `Headers` instance you passed

`inject()` used to write its content-type default onto the caller's own object when
`InjectRequest.headers` was a `Headers` rather than a plain record. Reusing one instance across two
requests — the ordinary way to hoist a shared auth header into a fixture — therefore carried the
first request's content type into the second, where it suppressed the correct default: a
`URLSearchParams` body following a JSON body arrived as JSON. The default is now written onto a
copy.

Nothing to do in the normal case, and a test that was silently getting the wrong content type starts
getting the right one. The one thing to change is code that READ the header back off its own
`Headers` object after calling `inject()`, expecting to find what `inject()` had put there. That
object is now untouched, and `InjectResponse.headers` is no substitute — those are the RESPONSE
headers. Either set the request's `content-type` explicitly, in which case it is both what you
passed and what the handler sees, or read `ctx.request.headers` inside the handler and report it.

<!-- version:history -->

### Create a new application instead of retrying a failed `start()`

If your code catches a rejected `app.start()` and calls `start()` again on the same application,
that retry now works only when the failure came before any plugin ran `register()` — plugin
resolution: a missing runtime provider, an unsatisfied dependency, a dependency cycle. Once
registration has begun, a second `start()` throws
`Cannot retry start() after plugins have registered … Create a new application instead.`

Most such retries already failed, with the misleading `Capability 'runtime' is already registered`.
One case used to succeed and is now refused: the first plugin to run threw before writing any state,
such as a runtime provider rejecting its options. In every case, rebuild the application (call your
`createApp()` again) and start that one.

### Remove hand-added global `authMiddleware()` calls

`AuthPlugin` now registers `authMiddleware()` globally at priority 300. Remove any existing global
`app.middleware.add(authMiddleware(), ...)` call; leaving it in place remains correct but executes
every passive strategy twice. If the old application deliberately attached authentication only to
selected routes, configure `middleware: false` and keep those route-level copies.

The `jwt` option is now optional. A configuration must still supply at least one passive request
strategy through `jwt`, `apiKey`, `session`, or `strategies`; `local` alone only verifies login
credentials and is refused at startup.

### Add `pending()` to a hand-written `IAuthSessionService`, and handle the new sign-in outcome

`IAuthSessionService` (`@setu-ts/common`) gains a REQUIRED member,
`pending(ctx): PendingSignIn | null`, so a class or object literal implementing the interface by
hand no longer type-checks. Add the member; a service that never holds a sign-in back can return
`null`. Applications that only consume the service `AuthPlugin` registers have nothing to add.

`SignInOutcome` also widens from one arm to two: `signIn` now resolves
`{ status: 'second-factor-required' }` when `signIn.mfa.required` answers `true`. Code that treated
every resolved `signIn` as a completed sign-in must branch on `status` — on that arm the session
holds a pending record, not the principal, so `requireAuth()` routes stay closed until the second
factor is completed through `TotpService.completeSignIn`. Without an `mfa` option the second arm is
never produced.

<!-- version:history -->

## 0.7.0

### Regenerate your client if you adopt `@HttpCode` or `@Redirect`

Nothing changes if you change nothing: `@setu-ts/decorator-plugin` gains `@HttpCode`,
`@ResponseHeader` and `@Redirect`, and `@setu-ts/openapi-plugin` gains `deriveResponseStatus`
(default `true`) — but the brand the derivation reads is new surface, so no handler written before
this release carries one and an untouched application produces a byte-identical document.

What DOES change the document is adopting the decorator, and that is the point of it. A route that
gains `@HttpCode(201)` is documented under `201` instead of the assumed `200`, so a client generated
from that document types its success body under `201` — a compile-time break for a call site reading
the success body under the old key, and the fix is to regenerate the client and read the new one.
Declaring `schema.response` (or `@ApiResponse`) still wins over the derivation, and
`OpenApiPlugin({ deriveResponseStatus: false })` restores the assumed `200` for every branded route.

Adopting the decorators also moves several checks from "never" to **startup**. `@HttpCode` takes an
integer in `[200, 599]`; `@Redirect` takes one in `[300, 399]` plus a non-blank target the runtime
will carry as a `Location` header; a header name and value must be ones the runtime accepts and the
same header name may not be declared twice; and one handler may not carry both `@HttpCode` and
`@Redirect`, because both set the status. Each refusal names the controller, the method and the
value. There is nothing to migrate — no released code can trip these — but a `register()` that
suddenly refuses is the decorator you just added, not a regression.

### Stop reading a multipart field named `unknown`

A multipart part whose `Content-Disposition` carries no `name` parameter is now DROPPED, where it
used to be delivered as a real field literally named `unknown` — colliding with any legitimate field
of that name. An EMPTY value in either spelling — `name=""` or `name=` — is still a field, with an
empty name. If you read a form field named `unknown`, you were reading parts no correct client sends
(the platform discards them); read the part's real name now. In exchange, a part your client sends
with the unquoted form — `name=x` rather than `name="x"` — now arrives under its REAL name instead
of `unknown`, and an upload sent with an unquoted `filename=a.txt` now reaches `getUploadedFile()`
instead of arriving as a text field. The full table of accepted spellings is pinned by
`packages/common/test/unit/form/multipart-platform-parity.test.ts`.

### Drop the cast around an injected `MongoClient`

`IMongoClient` (the `DatabasePlugin({ type: 'mongodb' })` injection seam) now admits the real
`mongodb` driver structurally: `connect()` returns `Promise<unknown>` because the driver's
`connect(): Promise<this>` is not assignable to `Promise<void>`. An application that wrote
`new MongoClient(url) as unknown as IMongoClient` to satisfy the option can now assign directly —
and the compile-time fixture `packages/database-plugin/test/types/mongo-seam.assert.ts` fails the
build if the seam drifts from the driver again.

### `inject()` refuses non-plain-object bodies (JavaScript callers)

`app.inject()` used to JSON-stringify whatever body it was handed; it now carries the documented
shapes verbatim (`Uint8Array`, `ArrayBuffer`, `Blob`, `URLSearchParams`, plain object, string) and
REFUSES every other shape with a `TypeError` naming the received type. TypeScript callers are
compile-checked; a JavaScript caller passing an array, `Date`, class instance or number must convert
first — arrays and plain data to a plain object, `Date` to a string or number, binary data to
`Uint8Array`. A byte body now also sets NO default content type, so an injected multipart test
request must pass its own `multipart/form-data; boundary=…` header, exactly as a served request
does.

<!-- version:history -->

### Check any view component you copied from the `0.6.0` docs

`@setu-ts/view-plugin`'s README and `docs/migration-nestjs.md` showed the class-based example with a
PLAIN template literal:

```typescript
// DO NOT USE — a plain template literal is a `string`, so nothing escapes it.
const UserList = (props: { readonly users: readonly string[] }) =>
  `<ul>${props.users.map((user) => `<li>${user}</li>`).join('')}</ul>`;
```

Escaping belongs to the rendering runtime, and a component that is already a `string` is returned
unchanged — so any value reaching it is written to the page verbatim. With a user-supplied name of
`<script>alert(1)</script>` that example emits the script tag, where JSX and hono's `html` tag both
emit `&lt;script&gt;`.

Nothing in the plugin changed and no version is affected — the engine always behaved this way. What
changed is the documentation. If you copied that shape, switch to either escaping form:

```tsx
// JSX — what `ViewPlugin()` selects with no options.
const UserList = (props: { readonly users: readonly string[] }) => (
  <ul>{props.users.map((user) => <li>{user}</li>)}</ul>
);
```

```typescript
// Or hono's `html` tag, for a project with no JSX toolchain.
import { html } from '@hono/hono/html';

const UserList = (props: { readonly users: readonly string[] }) =>
  html`<ul>${props.users.map((user) => html`<li>${user}</li>`)}</ul>`;
```

`raw()` remains the documented opt-out when you genuinely intend to emit trusted markup.

<!-- version:history -->

## 0.6.0

One change fails `deno check`, and only for a hand-written stand-in. Two change behaviour silently —
they compile, so the compiler will not point at them: check whether you upload files without a
`filename`, and whether anything reads a `415` response body.

### Check uploads posted without a `filename`

`@setu-ts/storage-plugin`'s `createUploadMiddleware` now delivers only the parts that declared a
`filename`, because it reads the request through M94b's shared form accessor and a part with no
`filename` is a plain form value in the web standard's terms. It used to report such a part as an
`UploadedFile` whose `filename` fell back to the field name.

**A browser file input always sends a `filename`, even an empty one for an empty input, so ordinary
uploads are unaffected** — and `filename=""` still arrives as a file. What changes is a non-browser
client (a hand-built `curl -F`, an SDK, a test fixture) posting a plain value under the upload field
name: `getUploadedFile(ctx)` now returns `undefined` for it, with no error and no log line.

Two ways forward, depending on what the part actually is:

```typescript
// It is a file: have the client declare a filename on the part.
//   Content-Disposition: form-data; name="file"; filename="report.csv"

// It is a plain field: read it as one, which is now possible on any request.
const form = await ctx.request.formData!();
const note = form.get('note'); // string | FormFile | undefined
if (typeof note === 'string') { /* … */ }
```

Relatedly, a `multipart/form-data` content-type carrying no `boundary=` now passes through the
upload middleware unparsed instead of being answered `400`: it cannot be parsed as a form at all, so
the shared classifier treats it as not-a-form. A handler that calls `formData()` on such a request
gets a `415`.

### A `415` response body's title changed under the Problem Details formats

`@setu-ts/exceptions` had no `STATUS_TITLES` row for `415`, so a `415` served through
`errorHandler({ format: 'rfc9457' })` (or `'rfc7807'`) carried `"title": "Error"`. It now carries
`"title": "Unsupported Media Type"`, matching what the same error already reported as `"message"`
under the `'default'` format. No action is needed unless something asserts or branches on that
string — a contract test with a recorded fixture, or a client mapping titles to messages.

### Add `unregister` to a hand-written `IKernelApplication`

`@setu-ts/kernel`'s `IKernelApplication` gained a required `unregister(name: string): boolean`,
which removes every pending plugin carrying that name before `start()` and throws once startup has
begun, plus a required `hasPlugin(name: string): boolean` — a pure read reporting whether such a
plugin is pending. It exists because overriding a capability is a _post-hoc_ substitution: by the
time an override replaces a service, the real plugin's `register()` has already run, so an eager
side effect inside it — `DatabasePlugin` calls `adapter.connect()` there — has already happened.
Only removing the plugin prevents that.

`createApplication` and all three starters return an implementation, so callers are unaffected. If
you wrote your own stand-in:

```typescript
// TS2741 Property 'unregister' is missing in type '…' but required in type 'IKernelApplication'.
const app: IKernelApplication = {
  // …router, middleware, services, register, start, stop, fetch, inject…
  unregister: (_name) => false, // see the note below
  hasPlugin: (_name) => false,
};
```

`false` is correct for a stand-in that holds no plugins of its own — there is never one to remove.
It is NOT a complete implementation of the contract: a stand-in that can be started must also throw
once startup has begun, since a plugin that already registered cannot be un-run.

The intended caller is `@setu-ts/testing`:

```typescript
import { createTestApp, overrideCapability } from '@setu-ts/testing';
import { CAPABILITIES } from '@setu-ts/common';
import { createApp } from '../setu.config.ts';

const app = await createTestApp({
  app: createApp(), // the composition production uses
  without: ['database'], // never connects
  overrides: [overrideCapability(CAPABILITIES.MAIL, fakeMailer)],
});
```

Nothing about existing tests changes: `createTestApp({ plugins: [...] })` behaves exactly as it did.

<!-- version:history -->

## 0.5.0

<!-- version:history -->

0.5.0 is a breaking release across several packages. Two changes fail `deno check`; the rest change
a status code, a response body, a Redis key, a consumer-group name or a CLI exit code, and are
listed here because each one can pass a type-checker and fail in production.

### Add `ping()` to an injected `IRedisClient`

`@setu-ts/cache-plugin`'s Redis store gained a reachability probe, so `IRedisClient` gained a
required `ping(): Promise<string>` member. If you pass your own client — the commonest case being a
test double — supply it:

```typescript
// TS2741 Property 'ping' is missing in type '…' but required in type 'IRedisClient'.
const client: IRedisClient = {
  // …get, set, del, exists, scan, quit…
  ping: () => Promise.resolve('PONG'),
};
```

`ioredis` already has it, so an application passing a real client needs no change. The probe treats
a rejection as unreachability rather than an error, so a double that rejects reports
`reachable:
false` on `/health` and nothing else.

### Add `rotate` and `revokeFamily` to a custom `RefreshTokenStore`

`@setu-ts/auth-plugin` now revokes a whole credential family when a refresh token is replayed or a
session is logged out, which a store must implement:

```typescript
class MyStore implements RefreshTokenStore {
  // …existing members…

  /**
   * Must be ATOMIC: two concurrent refreshes of one token may not both succeed.
   * `rotated` says whether the presented token was live when `successor` was
   * stored — the loser of a race gets `{ record, rotated: false }`, which the
   * service reads as a replay.
   */
  async rotate(
    jti: string,
    successor: RefreshTokenRecord,
  ): Promise<IRefreshTokenRotation> {/* … */}

  /** Revokes the token and every descendant, and RETURNS what it revoked. */
  async revokeFamily(jti: string): Promise<readonly RefreshTokenRecord[]> {/* … */}
}
```

`revokeFamily` returns the records rather than `void` because their `accessTokenJti` values are what
the service revokes alongside them. Your records must also persist the optional lineage fields on
`RefreshTokenRecord` (`familyId`, `accessTokenJti`, `accessTokenExpiresAt`), or `revokeFamily` has
no chain to walk and a replayed token revokes only itself. `MemoryRefreshTokenStore` implements both
and is the in-repo reference.

Policy refusals also stopped disclosing the required role or permission: a `403` now reads
`Insufficient privileges`. Update tests asserting the old detail.

### Errors that were `500` now carry their real status

Every condition below is one a caller caused, or one a caller can retry, and all of them were
reaching clients as a masked `500`. They now answer honestly. Nothing about **your** code has to
change for these to be correct — but a `catch` or a test matching `500` will stop matching:

| Condition                                                              | Was | Now   |
| ---------------------------------------------------------------------- | --- | ----- |
| A malformed JSON request body (`IRequest.json()`)                      | 500 | `400` |
| A backend serialization conflict (`SerializationConflictError`)        | 500 | `409` |
| A transiently unreachable database (`DatabaseUnavailableError`)        | 500 | `503` |
| Bulkhead full / circuit open (`BulkheadFullError`, `CircuitOpenError`) | 500 | `503` |
| A resilience timeout (`TimeoutError`)                                  | 500 | `504` |
| A write to a read-only secret provider (`ReadOnlySecretProviderError`) | 500 | `501` |
| Memory-adapter raw SQL and `migrate()`                                 | 500 | `501` |

`instanceof SerializationConflictError` is the retry signal for optimistic concurrency, which the
masked `500` made unusable. None of these carries `Retry-After`.

One is also a call-shape change: `DatabaseService.query()` on the memory adapter used to throw
**synchronously** from a method typed `Promise`, so a caller using `.catch()` never saw it. It
rejects now. A synchronous `try`/`catch` around an un-awaited `query()` no longer catches — `await`
it, or use `.catch()`.

### The rate limiter's `429` body and Redis keys both change

`@setu-ts/auth-plugin`'s `rateLimitMiddleware` wrote its own `{ error, message }` body, ignoring
`errorHandler`'s configured format. It now answers in that format like every other refusal, so a
client reading `body.message` should read `body.detail` (or `body.details.detail` under
`format: 'default'`). The `Retry-After` and `RateLimit-*` headers are unchanged.

It also stopped refusing the operational probes. `exclude` now defaults to `/live`, `/ready`,
`/health`, `/metrics`, `/openapi.json` and `/docs` — an exhausted limiter used to answer `/live`
with `429`, which a kubelet reads as a failed liveness probe and restarts a container whose only
fault was load. A caller list **replaces** the defaults, so spread
`DEFAULT_RATE_LIMIT_EXCLUDED_PATHS` to extend them, or pass `exclude: []` for the previous
behaviour.

Finally, `RedisRateLimitStore` now namespaces its keys under `DEFAULT_RATE_LIMIT_KEY_PREFIX`
(`'setu:ratelimit:'`). Two applications sharing one managed Redis were previously counting against
each other's budget. In-flight counters under the old keys are orphaned but TTL-bounded, so the
blast radius is one window; pass `keyPrefix: ''` for the previous keys byte for byte.

### Kafka's shared `messaging-consumers` group is derived per topic

A subscription with no `queue` used to join one shared `messaging-consumers` group. Members of a
Kafka consumer group must subscribe the same topics, so an application subscribing two topics ended
with empty assignments and **no delivery at all**. The group is now `<defaultQueue>:<topic>`. If you
have tooling, dashboards or ACLs keyed on the literal `messaging-consumers`, repoint them at the
derived names. A caller-supplied `queue` still names the group itself and is unaffected.

### `CAPABILITIES.LOGGER` resolves to a wrapper

The registered `ILogger` is now a trace-enriching decorator around your configured transport, so
`logger instanceof ConsoleLogger` no longer holds. Every `ILogger` method behaves identically and
`level` passes through. Branch on behaviour or on your own configuration instead — `ILogger` is the
contract and the concrete class never was.

### The `setu` CLI refuses unknown flags, and bare `setu generate` exits 0

`setu` collected every flag and positional and consulted neither, so `setu new app --templat rest`
scaffolded the **minimal** project and reported success. Unknown flags and extra positionals now
exit `2` with nothing written. In the other direction, bare `setu generate` now exits `0` and lists
the schematics, where it printed the same guidance and exited `2`. A script branching on either exit
code needs updating; a script passing a stray flag was already misbehaving silently.

### Health indicators run concurrently under `indicatorTimeoutMs`

`/health` used to await each selected indicator in registration order, so a 2-second outage across
six dependency indicators held the endpoint for 12+ seconds and one never-settling indicator held it
forever. Indicators now run concurrently under `HealthPluginOptions.indicatorTimeoutMs` (default
5,000). Report shape and key order are unchanged; a timeout records
`{ status: 'down', data: { reason: 'timeout' } }`. If a test asserted wall-clock interleaving
between two indicators, assert on the report instead.

<!-- version:history -->

## 0.2.0

### Add `findPage` to a hand-written `IRepository`

<!-- version:history -->

`IRepository` gained a **required** `findPage(options: PageOptions): Promise<Page<Entity>>` member
in 0.2.0 (keyset cursor pagination). The `IDataSource.findPage?` the CHANGELOG's Added entry
describes is optional — a different type. If you implement `IRepository` by hand rather than
extending `BaseRepository` — the commonest case being a test double — you must now supply it:

<!-- version:history -->

```typescript
// Before — compiles until 0.2.0, then:
// TS2741 Property 'findPage' is missing in type '…' but required in type 'IRepository<UserRow, string>'.
class UserRepo implements IRepository<UserRow, string> {
  // …findById, findAll, findOne, create, update, delete, exists, count…
}

// After — the member is required on the interface.
class UserRepo implements IRepository<UserRow, string> {
  // …
  async findPage(options: PageOptions): Promise<Page<UserRow>> {
    // `nextCursor` is non-null IF AND ONLY IF the page is non-terminal, and is
    // never derived from `rows.length`: a page that returns exactly `limit`
    // rows may still be the last one. The row-based mechanism is to fetch one
    // more row than asked for and let the extra row be the signal.
    const limit = options.limit ?? 50;
    const rows = await this.load({ ...options, limit: limit + 1 });
    return rows.length > limit
      ? { rows: rows.slice(0, limit), nextCursor: this.cursorAfter(rows[limit - 1]) }
      : { rows, nextCursor: null };
  }
}
```

`load` and `cursorAfter` above stand for your own storage and sort key — the block is a **sketch of
the member**, not a file that compiles on its own, which is also why the class body is elided. For
one that does compile, and is type-checked and tested on every run, the in-repo reference
implementation is
[`repository-implementor.ts`](../packages/database-plugin/test/fixtures/repository-implementor.ts),
a hand-written `IRepository` that doubles as a compile-time tripwire: adding a required member to
the interface without updating it fails `deno check`.

<!-- version:history -->

## 0.1.0-alpha.10

### Remove `experimentalDecorators` from your own manifest

The decorator surface moved to TC39 standard decorators and the legacy form was removed. The
framework removed the option from all of **its own** declaration sites — that part is done for you.
What the release entry does not do for you: a project scaffolded by an earlier CLI still carries
`"compilerOptions": { "experimentalDecorators": true }` in its own `deno.json` (or the equivalent in
a generated Node `tsconfig.json`), and a migrated project that keeps it compiles its decorators
under the **legacy** semantics and fails `deno check` with `TS1238`/`TS1241` on every decorated
member.

The errors point at the decorators, not the option, which is exactly why this step needs to be
written down:

```text
TS1238  Unable to resolve signature of class decorator when called as an expression.
        The runtime will invoke the decorator with 1 arguments, but the decorator expects 2.
TS1241  Unable to resolve signature of method decorator when called as an expression.
```

Remove **that one key** from your project's manifest. Leave the rest of your `compilerOptions`
alone: Deno applies its own defaults to every option you do not specify, so declaring one option
does not disturb the others (measured on Deno 2.9.6 — a manifest declaring only
`experimentalDecorators` still type-checks under `strict`). If `experimentalDecorators` was the only
option you had, the whole `compilerOptions` object can go.

<!-- version:history -->

## 0.1.0-alpha.8

### Add `findOne` to a hand-written `IRepository`

The same class of change as `findPage` above, two releases earlier: `IRepository` gained a required
`findOne` member. A class implementing `IRepository` without extending `BaseRepository` must now
implement `findOne`.
