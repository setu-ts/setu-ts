# Upgrading Setu-TS

The CHANGELOG answers "what changed in the framework"; this guide answers "what must I change in
**my** project". A release that demands reader action adds an entry here, version by version — that
is a release step ([releasing.md](./releasing.md)), not a memory exercise.

Each heading names the release that **shipped** the change, so an upgrade spanning several releases
is the union of every section between the version you are on and the one you are moving to.

`## Unreleased` holds entries written as their milestone landed, which is where the knowledge is;
cutting a release renames that heading to the version and is a rename, not a recall.

## Unreleased

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

Adopting the decorators also moves three checks from "never" to **startup**. `@HttpCode` takes an
integer in `[200, 599]` and `@Redirect` one in `[300, 399]`; a header name and value must be ones
the runtime accepts and the same header name may not be declared twice; and one handler may not
carry both `@HttpCode` and `@Redirect`, because both set the status. Each refusal names the
controller, the method and the value. There is nothing to migrate — no released code can trip these
— but a `register()` that suddenly refuses is the decorator you just added, not a regression.

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
