# Milestone 74 — Realtime registry reads and the SSE contract (`@setu-ts/websocket-plugin`, `@setu-ts/sse-plugin`, `@setu-ts/common`)

> **Status:** Planning. Branch: `feat/m74-realtime-registry-reads`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Two realtime registries can only be read by writing to them, and one committed contract advertises a
guarantee its own type does not hold. `IWebSocketService.room(name)` and `ISseService.channel(name)`
are get-or-create with no non-creating counterpart, so a presence endpoint that reports
`room(callerSupplied).size` **allocates one registry entry per distinct name polled** — the X3-8
exposure, whose documentation half M70n closed and whose read M70n did not add. Separately,
`SseMessage.data` is documented as accepting "any JSON-serializable value" while its union admits
`bigint`, symbols and functions, none of which `JSON.stringify` can serialize. This milestone adds
the non-mutating read to both plugins and narrows the SSE payload type to a recursive JSON-safe
type, so the documented guarantee becomes the one the compiler enforces.

- **In scope:** a required `peek(name)` member on `IWebSocketService` and `ISseService` returning
  the live room/channel when one exists and `undefined` when none does, backed by a `peek` on each
  plugin's internal registry; a new `JsonValue` type in `@setu-ts/common` and the narrowing of
  `SseMessage.data` to it (breaking, with CHANGELOG migration text); the four committed-doc
  corrections in §2; `PUBLIC_API.md` rows for all three new public symbols (§10.2 approval recorded
  in the PR).
- **NOT this milestone:** a cookie-reading auth strategy for the two realtime transports (M73, whose
  branch is independent of this one); `traceparent` propagation across the message broker (M75); an
  enumeration API such as `rooms()` / `channels()` (§9 — no reader); reclaiming empty SSE channels
  (§9 — a behaviour change that risks silent partial delivery, deliberately not folded in); making
  `ISseConnection.send` generic to accept named interfaces (§9).

## 1. Contracts verified from SOURCE (not names)

| Reference                     | Source (file:line)                                                                                                      | Verified surface / fact                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IWebSocketService`           | `packages/common/src/services/websocket.ts:395,413,415`                                                                 | Declares `route`, `room(name): WebSocketRoom`, optional `routeUpgrade?`, and the readonly `available` / `connectionCount` / `roomCount`. There is no non-creating lookup and no enumeration member.                                                                                                          |
| `ISseService`                 | `packages/common/src/services/sse.ts:151,153`                                                                           | Declares exactly `open(ctx)`, `channel(name): SseChannel`, and readonly `connectionCount`. No non-creating lookup.                                                                                                                                                                                           |
| `SseMessage.data`             | `packages/common/src/services/sse.ts:33`                                                                                | `string \| number \| boolean \| null \| readonly unknown[] \| Record<string, unknown>`. The last two arms admit values `JSON.stringify` throws on. Widened by M70n from `string \| Record<string, unknown>` (commit `84f590e9`).                                                                             |
| `RoomRegistry.get`            | `packages/websocket-plugin/src/rooms/room-registry.ts:260`                                                              | Get-or-create. A newly created room is added to `#neverJoined` (line 296); membership is tracked by the listener the registry supplies.                                                                                                                                                                      |
| `RoomRegistry.#neverJoined`   | `packages/websocket-plugin/src/rooms/room-registry.ts:247,364`                                                          | Rooms looked up but never joined are reclaimed by `#reclaimNeverJoined`, which runs only from `evict` — so an idle application never reclaims. This is the documented tradeoff.                                                                                                                              |
| `ChannelRegistry.get`         | `packages/sse-plugin/src/channels/channel-registry.ts:128`                                                              | Get-or-create. **`#channels` has no delete path anywhere** — `grep` for `delete` in `packages/sse-plugin/src` finds only `#members.delete` (line 62) and `#connections.delete`. An SSE channel therefore lives until `clear()` at shutdown.                                                                  |
| `SseChannelImpl.publishLocal` | `packages/sse-plugin/src/channels/channel-registry.ts:84,89`                                                            | Wraps each member `send` in a `try`/`catch` that swallows. An `encodeSseMessage` throw is therefore invisible to the publisher on the local path.                                                                                                                                                            |
| SSE backplane publisher       | `packages/sse-plugin/src/services/sse-service.ts:77`                                                                    | Builds the frame with `data: JSON.stringify(msg)` **outside** any `try`, so with a backplane registered a non-serializable payload throws synchronously out of `publish()`. Without one it is silently dropped. Verified divergence, pinned by a planned test.                                               |
| `encodeSseMessage`            | `packages/sse-plugin/src/utils/sse-frame.ts:33`                                                                         | `typeof data === 'string'` is written literally; anything else goes through `JSON.stringify`. Confirms the type is the only thing that can reject a non-serializable payload.                                                                                                                                |
| `type-contracts.test.ts`      | `packages/common/test/unit/type-contracts.test.ts:19-30`                                                                | Already states the accurate account of interface assignability: "TypeScript only grants implicit index signatures to object-literal types, never to interfaces". Its `NamedSsePayload extends Record<string, unknown>` fixture **will stop compiling** under the narrowing and is updated by this milestone. |
| README fence gate             | `test/package-readme-fence-compiler.test.ts:71-72`                                                                      | Pins exact compilable-fence counts: `sse-plugin/README.md` 5, `websocket-plugin/README.md` 8. Any fence added to those READMEs must compile and must move the count.                                                                                                                                         |
| In-repo implementors          | `packages/websocket-plugin/src/services/websocket-service.ts:112`, `packages/sse-plugin/src/services/sse-service.ts:31` | Exactly one real implementor each. Every test stand-in (`packages/kernel/test/integration/pipeline-runs-for-upgrade.test.ts:82`, `packages/graphql-plugin/test/unit/graphql-plugin-wiring.test.ts:53`) is built with `as unknown as`, so a required member costs no in-repo fake a change.                   |
| No existing JSON type         | `packages/common/src`                                                                                                   | `grep` for `JsonValue`/`JsonObject`/`JsonPrimitive` across every package's `src` returns nothing. `JsonValue` is genuinely new surface, not a duplicate (§11.1).                                                                                                                                             |
| `common/src/types.ts`         | `packages/common/src/types.ts:1-8`                                                                                      | Module doc: "Shared primitive types used across the framework." The home for `JsonValue`.                                                                                                                                                                                                                    |

### 1.1 Measured type-assignability facts

Probed with `deno check` under the repository's own `deno.json` (`strict`,
`exactOptionalPropertyTypes`), not inferred. Each row is the reason a design decision in §3 reads
the way it does.

| Value shape                                   | Current union | Strict JSON type (no `undefined` arm) | Chosen `JsonValue` | `JSON.stringify` at runtime |
| --------------------------------------------- | ------------- | ------------------------------------- | ------------------ | --------------------------- |
| Object-literal type alias                     | accepts       | accepts                               | accepts            | serializes                  |
| Named `interface`                             | **rejects**   | rejects                               | rejects            | would serialize             |
| `class` instance, `Date`                      | **rejects**   | rejects                               | rejects            | would serialize             |
| `{ name: string; note?: string }`             | accepts       | accepts                               | accepts            | serializes                  |
| `{ name: string; note: string \| undefined }` | accepts       | **rejects**                           | accepts            | serializes (key dropped)    |
| `{ x: 10n }`, `[10n]`                         | accepts       | rejects                               | **rejects**        | **throws `TypeError`**      |
| Function value, symbol value                  | accepts       | rejects                               | rejects            | silently drops the key      |
| Circular structure                            | accepts       | accepts                               | accepts            | **throws `TypeError`**      |

Two facts settle §3.5 and §3.6. First, a named `interface` is **already** rejected by today's
`Record<string, unknown>` arm, so the narrowing imports no new interface-ergonomics regression — the
`PUBLIC_API.md` sentence claiming M70n fixed that is wrong, which is conflict C2. Second, the strict
form (object values typed `JsonValue`) rejects `{ note: string | undefined }`, a shape
`JSON.stringify` handles perfectly; adding `| undefined` to the object arm accepts it again while
still rejecting `bigint` in both object and array positions.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                                                                                                               | Doc deliverable (same PR)                                                                                                                                                                                |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md:2034` states "**`SseMessage.data` accepts any JSON-serializable value**" and then prints a union admitting `bigint`, functions and symbols. The prose and the type disagree.                                                                                                                                                                                                     | The prose is the intent worth keeping; the type is corrected to match it. Narrowing `data` to `JsonValue` makes the sentence true rather than aspirational.                                                                                                            | Rewrite the `PUBLIC_API.md` SSE note to print the new union, name `JsonValue`, and state the one hazard a type cannot catch (a circular structure).                                                      |
| C2 | `PUBLIC_API.md:2036-2038` says the M70n widening addressed the case where "a named interface failed to assign while an inline literal passed and every real application cast". Probed false: an `interface` is not assignable to `Record<string, unknown>` before or after that widening (§1.1). `packages/common/test/unit/type-contracts.test.ts:19-30` already records the accurate account. | The test file is right; `PUBLIC_API.md` is stale. Interface assignability is an unchanged TypeScript limitation of index-signature types, and the workaround is a `type` alias.                                                                                        | Correct that sentence to say what the widening actually bought (arrays, primitives, `null`) and name the `type`-alias workaround for interfaces.                                                         |
| C3 | `packages/sse-plugin/README.md:52-55` and `PUBLIC_API.md:2003-2005` both state that a never-published SSE channel "is reclaimed only when another connection closes somewhere in this process". `ChannelRegistry` contains **no delete path at all** (§1) — nothing reclaims an SSE channel before shutdown. The claim was inherited from the WebSocket registry, which does reclaim.           | The source is right and the docs describe a mechanism that does not exist. State the truth: an SSE channel created by `channel(name)` lives until the process stops, which makes the read path strictly worse than the WebSocket one and is exactly why `peek` exists. | Correct both sites to state that SSE channels are never reclaimed before shutdown, and point at `peek` as the non-allocating read.                                                                       |
| C4 | `packages/websocket-plugin/README.md:211-217` and `PUBLIC_API.md:2172-2176` both state "There is no non-creating lookup" for rooms, and `PUBLIC_API.md:2003` says the same for channels. This milestone makes all three false.                                                                                                                                                                  | Ship the read, then rewrite the three notes around it: get-or-create stays the behaviour of `room`/`channel`, and `peek` is the documented way to report presence without allocating.                                                                                  | Rewrite the WebSocket README note, the `PUBLIC_API.md` WebSocket note, and the `PUBLIC_API.md` SSE interface-reference row; add a `peek` row to each package's Interface Reference and Exports coverage. |

## 3. Design decisions

### 3.1 The read is `peek(name)`, returning the live object or `undefined`

- **Decision:** `IWebSocketService.peek(name: string): WebSocketRoom | undefined` and
  `ISseService.peek(name: string): SseChannel | undefined`. One name on both services, matching the
  register's own suggested spelling.
- **Why:** the presence use case reads `size`, so a boolean `hasRoom` would force a second call and
  a `rooms(): readonly string[]` would force the caller to filter a whole list to answer one
  question. Returning the same object `room()` returns keeps one type per registry, so
  `ws.peek(name)?.size ?? 0` is the whole presence endpoint. `peek` reads as "look without
  touching", which is the property being added; `getRoom` beside an existing `room` would leave two
  near-identical names whose difference is invisible at the call site.
- **Test home:** `peek-room.test.ts` (`returns the same instance a prior room() call created`),
  `peek-channel.test.ts` (same for channels).

### 3.2 `peek` is a REQUIRED member on both contracts, not optional

- **Decision:** declare `peek` as a required member of `IWebSocketService` and `ISseService`.
  Recorded in `CHANGELOG.md` as breaking for anyone implementing those contracts outside this
  repository, with migration text.
- **Why:** an optional `peek?` returning `undefined` conflates two different answers — "this
  implementation does not offer the read" and "no such room" — and the caller cannot tell them
  apart, which is precisely the ambiguity M70k's `IWorkerHost.reportsExit?` flag had to be invented
  to resolve. The optional-member precedents in this repository (`fs?`, `workers?`, `dns?`,
  `onSignal?`, `routeUpgrade?`) are all platform-capability ports where absence is a real,
  reportable state; `peek` is a service method every implementation of a registry can answer. M51b's
  required `IGraphqlService.subscribe` is the matching precedent. The in-repo cost is nil: both
  stand-ins are built with `as unknown as` (§1), so nothing in the workspace needs a change to keep
  compiling.
- **Test home:** `packages/common/test/unit/type-contracts.test.ts` — a conditional type asserting
  the member is required with the committed signature, decided by `deno task check`.

### 3.3 `peek` returns the live object, never a snapshot

- **Decision:** `peek` hands back the same `Room` / `SseChannelImpl` instance that `room()` /
  `channel()` would return, with its full mutating surface.
- **Why:** a read-only projection would be a second type for the same thing and would have to be
  rebuilt per call; the milestone's property is that the _lookup_ does not allocate a registry
  entry, not that the returned handle is inert. A caller who already holds the name can call
  `room(name)` anyway, so withholding the mutators buys no safety.
- **Test home:** `peek-room.test.ts` asserts `peek(n)` is reference-identical to `room(n)`.

### 3.4 `peek` must leave `#neverJoined` and the room map untouched

- **Decision:** `RoomRegistry.peek` is a bare `#rooms.get(name)`. It does not add to `#neverJoined`,
  does not remove from it, and does not run `#reclaimNeverJoined`.
- **Why:** the whole point is that the registry is not mutated. Touching `#neverJoined` has two
  wrong outcomes: it resurrects an abandoned room past its reclaim point when the peeked name
  exists, and it reclaims on a read path that promises to change nothing.
- **Test home:** `peek-room.test.ts` — `roomCount` is unchanged across 50 `peek` calls for distinct
  names, and a room created by `room()` and never joined is still reclaimed on the next `evict`
  after being peeked.

### 3.5 `JsonValue` lives in `common/src/types.ts` and its object arm admits `undefined`

- **Decision:**

  ```ts
  export type JsonValue =
    | string
    | number
    | boolean
    | null
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue | undefined };
  ```

  Exported from the `@setu-ts/common` barrel. No `JsonObject` / `JsonArray` / `JsonPrimitive`
  companions.
- **Why:** `types.ts` is the module whose own doc says it holds "shared primitive types used across
  the framework", and nothing named `JsonValue` exists anywhere in the workspace (§1), so this
  duplicates nothing. The `| undefined` on the object arm is decided by measurement, not taste:
  without it the type rejects `{ name: string; note: string | undefined }`, a shape `JSON.stringify`
  serializes correctly by dropping the key, while with it the type still rejects `bigint` in both
  object and array positions (§1.1). The companion aliases are omitted under the dead-surface rule —
  nothing would read them.
- **Test home:** `packages/common/test/unit/type-contracts.test.ts` — accepted and rejected shapes,
  the rejections pinned with `@ts-expect-error` so an over-wide type stops compiling.

### 3.6 Only `SseMessage.data` is narrowed

- **Decision:** `SseMessage.data: JsonValue`. `RealtimeFrame.data`, `IWebSocketConnection.data` and
  `Room.broadcastJson`'s `payload` are left exactly as they are.
- **Why:** `RealtimeFrame.data` is already a `string` on the wire, so it cannot carry a
  non-serializable value. `IWebSocketConnection.data` is a `Map<string, unknown>` of per-connection
  application state that is never serialized. `broadcastJson<T>` is generic over an arbitrary
  payload and constraining it to `JsonValue` is a separate breaking change with its own consumers
  (§9). Narrowing exactly the one member whose documented guarantee is false keeps the breaking
  surface to what C1 names.
- **Test home:** `packages/common/test/unit/type-contracts.test.ts` asserts the other three are
  unconstrained.

### 3.7 The `NamedSsePayload` fixture migrates to the JSON-safe index signature

- **Decision:** `packages/common/test/unit/type-contracts.test.ts`'s
  `interface NamedSsePayload extends Record<string, unknown>` becomes
  `extends Record<string, JsonValue | undefined>`, and the CHANGELOG names this as the migration for
  any application that opted into `Record<string, unknown>` for the same reason.
- **Why:** an interface extending `Record<string, unknown>` has an `unknown`-valued index signature,
  which is not assignable to `JsonValue | undefined`. This is the concrete migration an application
  following the current documentation will hit, so the repository's own fixture performing it is
  both the fix and the worked example.
- **Test home:** the fixture itself; the file stops compiling if the migration is wrong.

### 3.8 The publish-path divergence is pinned, not repaired

- **Decision:** add a test recording that a non-serializable payload is silently swallowed by
  `publishLocal` with no backplane and throws synchronously out of `publish` with one, and state
  that the narrowing is what removes the case at compile time. No `try`/`catch` is added around the
  backplane publisher and no reporting is added to `publishLocal`.
- **Why:** the type is the fix — after the narrowing, reaching that divergence requires deliberately
  defeating the compiler. Adding runtime reporting to a swallow that is correct for its actual
  purpose (one unwritable member must never abort a fan-out) would change behaviour for the case the
  swallow exists to serve, which is out of this milestone's scope.
- **Test home:** `sse-nonserializable.test.ts`.

### 3.9 Empty SSE channels are still never reclaimed

- **Decision:** do not add reclamation to `ChannelRegistry`. Correct the two documents that claim it
  exists (C3), and document the consequence in the SSE README beside `peek`.
- **Why:** the WebSocket registry's `#neverJoined` design carries a latent trap — a caller holding a
  reference to a reclaimed entry publishes to a detached object while a new one serves the name —
  and importing it into SSE would convert the documented "hold a channel reference at startup"
  pattern into silent partial delivery, which is a worse defect than the growth it fixes. `peek`
  closes the read path X3-8 names, which is this milestone's scope; a safe reclamation design is
  named in §9.
- **Test home:** `peek-channel.test.ts` asserts channel count is unchanged across `peek` calls, and
  the doc correction is checked by the README/`PUBLIC_API.md` drift gates.

### 3.10 README fences and their pinned counts

- **Decision:** add one compilable fence to each README (a presence endpoint using `peek`), and move
  `test/package-readme-fence-compiler.test.ts`'s counts from 5 to 6 for `sse-plugin` and from 8 to 9
  for `websocket-plugin`.
- **Why:** the gate pins exact counts, so a new fence that does not move the number fails the suite;
  and a fence that does not compile fails it too, which is what makes the documented example real
  rather than plausible.
- **Test home:** `test/package-readme-fence-compiler.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                               | Kind             | Consumer / real code path that READS it                                                                                                                                                                                       |
| ------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JsonValue` (`@setu-ts/common`)                               | type             | `SseMessage.data` declares it (`packages/common/src/services/sse.ts`); application code annotates a payload variable with it before passing it to `publish`. Documented in `PUBLIC_API.md` and exercised by the README fence. |
| `IWebSocketService.peek` (`@setu-ts/common`, member)          | interface member | Implemented by `WebSocketService.peek`; called by application presence endpoints (README fence) and by the planned integration test through a real kernel application.                                                        |
| `ISseService.peek` (`@setu-ts/common`, member)                | interface member | Implemented by `SseService.peek`; same consumers on the SSE side.                                                                                                                                                             |
| `WebSocketService.peek` (`@setu-ts/websocket-plugin`, member) | class member     | The `IWebSocketService.peek` implementation; reached by every resolve of `CAPABILITIES.WEBSOCKET`.                                                                                                                            |
| `SseService.peek` (`@setu-ts/sse-plugin`, member)             | class member     | The `ISseService.peek` implementation; reached by every resolve of `CAPABILITIES.SSE`.                                                                                                                                        |

No package's `src/index.ts` export **list** changes: `JsonValue` is a new entry in the `common`
barrel, and the two `peek` members ride interfaces and classes both barrels already export. The
`common` barrel addition is pinned by `packages/common/test/unit/barrel-exports.test.ts`.

### 4.1 Options — every option names its consumer

None (checked). No plugin option is added, removed or changed: `WebSocketPluginOptions` and
`SsePluginOptions` are untouched, and `peek` needs no configuration. `deno.json` manifests,
capability tokens and plugin `provides` lists are all unchanged.

## 5. Implementation files

| File                                                          | Purpose                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/types.ts`                                | Adds the `JsonValue` recursive type (§3.5).                                                                             |
| `packages/common/src/index.ts`                                | Barrel: exports `JsonValue`.                                                                                            |
| `packages/common/src/services/sse.ts`                         | `SseMessage.data` narrowed to `JsonValue`; `ISseService.peek` declared; JSDoc restated so the type and the prose agree. |
| `packages/common/src/services/websocket.ts`                   | `IWebSocketService.peek` declared with JSDoc naming the allocation the read avoids.                                     |
| `packages/websocket-plugin/src/rooms/room-registry.ts`        | `RoomRegistry.peek(name): Room \| undefined` — a bare map read (§3.4).                                                  |
| `packages/websocket-plugin/src/services/websocket-service.ts` | `WebSocketService.peek` delegating to the registry.                                                                     |
| `packages/sse-plugin/src/channels/channel-registry.ts`        | `ChannelRegistry.peek(name): SseChannelImpl \| undefined`.                                                              |
| `packages/sse-plugin/src/services/sse-service.ts`             | `SseService.peek` delegating to the registry.                                                                           |
| `packages/websocket-plugin/README.md`                         | C4 correction plus the presence fence (§3.10).                                                                          |
| `packages/sse-plugin/README.md`                               | C3 and C4 corrections plus the presence fence.                                                                          |
| `PUBLIC_API.md`                                               | C1–C4 corrections; `peek` rows in both Interface References; `JsonValue` row in the `common` section.                   |
| `CHANGELOG.md`                                                | Two breaking entries with migration text (required `peek`; narrowed `SseMessage.data`), plus the doc corrections.       |
| `ROADMAP.md`                                                  | Milestone 74 section marked complete and its Progress Tracking row flipped to `✅`.                                     |
| `CLAUDE.md`                                                   | Current-status entry for M74; "Next milestone" repointed.                                                               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                  | src covered                                                                             | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/type-contracts.test.ts` (extended)              | `common/src/types.ts`, `common/src/services/sse.ts`, `common/src/services/websocket.ts` | `JsonValue` accepts a type alias, nested arrays/objects, `{ note?: string }` and `{ note: string \| undefined }`; `@ts-expect-error` pins rejection of `{ x: 10n }`, `[10n]`, a function value and a symbol value against `SseMessage.data`. Conditional types assert `peek` is REQUIRED on both services with `(name: string) => WebSocketRoom \| undefined` and `(name: string) => SseChannel \| undefined`. `NamedSsePayload` migrated per §3.7. |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)              | `common/src/index.ts`                                                                   | `JsonValue` resolves from the barrel (declared against the barrel, never the concrete module — the M70m/M56 pattern), so dropping the re-export stops the file compiling.                                                                                                                                                                                                                                                                           |
| `packages/websocket-plugin/test/unit/room-registry.test.ts` (extended)     | `websocket-plugin/src/rooms/room-registry.ts`                                           | `peek` on an unknown name returns `undefined` and leaves `size` at 0; `peek` after `get` returns the identical instance; 50 `peek` calls for distinct names leave `size` unchanged; a room created by `get` and never joined is still reclaimed by the next `evict` after being peeked (§3.4).                                                                                                                                                      |
| `packages/websocket-plugin/test/unit/websocket-service.test.ts` (extended) | `websocket-plugin/src/services/websocket-service.ts`                                    | `service.peek(n)` is `undefined` before `room(n)` and reference-identical to it afterwards; `roomCount` is unchanged across peeks of unknown names.                                                                                                                                                                                                                                                                                                 |
| `packages/sse-plugin/test/unit/channel-registry.test.ts` (extended)        | `sse-plugin/src/channels/channel-registry.ts`                                           | Mirror of the room-registry assertions, minus reclamation (§3.9): `peek` returns `undefined` / the identical instance, and `size` is unchanged across peeks.                                                                                                                                                                                                                                                                                        |
| `packages/sse-plugin/test/unit/sse-service.test.ts` (extended)             | `sse-plugin/src/services/sse-service.ts`                                                | `service.peek(n)` before and after `channel(n)`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/sse-plugin/test/unit/sse-nonserializable.test.ts` (new)          | `sse-plugin/src/channels/channel-registry.ts`, `sse-plugin/src/utils/sse-frame.ts`      | With the compiler defeated by a cast, `encodeSseMessage` throws on a `bigint` payload; `publishLocal` swallows it so no member receives and nothing is reported; the backplane publisher throws synchronously out of `publish` (§3.8). Records why the type is the fix.                                                                                                                                                                             |
| `packages/websocket-plugin/test/integration/peek-presence.test.ts` (new)   | service + registry through a real kernel application                                    | A `createApplication` app resolving `CAPABILITIES.WEBSOCKET` serves a presence route built on `peek`; 50 requests for distinct unknown names leave `roomCount` at its starting value, and a name with a live member reports its size. This is the X3-8 regression guard, driven at the surface the register measured.                                                                                                                               |
| `packages/sse-plugin/test/integration/peek-presence.test.ts` (new)         | service + registry through a real kernel application                                    | The SSE mirror of the above.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/package-readme-fence-compiler.test.ts` (extended)                    | both README fences                                                                      | Counts moved to 6 and 9; each new presence fence compiles (§3.10).                                                                                                                                                                                                                                                                                                                                                                                  |

No external dependency is added, so no guarded real-import test applies. Every `src` file this
milestone touches already carries a test file above; each gains branches rather than a new file, and
the per-file 90% branch/function/line bar is re-read ANSI-stripped after the change.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m74-realtime-registry-reads, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs        # README / PUBLIC_API drift and link gates
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.9
```

### 7.1 Negative controls (each observed failing, then reverted)

1. Revert `RoomRegistry.peek` to `this.#rooms.get(name) ?? this.get(name)` — the presence
   integration test must fail with a grown `roomCount`.
2. Widen `JsonValue`'s object arm to `unknown` — every `@ts-expect-error` in
   `type-contracts.test.ts` becomes an unused-directive compile error.
3. Make `peek` optional on `IWebSocketService` — the required-member conditional type must fail.
4. Drop `JsonValue` from the `common` barrel — `barrel-exports.test.ts` must stop compiling.
5. Leave the README fence counts at 5 and 8 — the fence gate must fail naming both files.

## 8. Risks & mitigations

- **The narrowing breaks an application that passes a non-JSON payload today.** Mitigated by the
  CHANGELOG migration text naming both cases measured in §1.1 (a `bigint` payload, and an interface
  extending `Record<string, unknown>`), and by the repository's own fixture performing the migration
  as the worked example (§3.7).
- **A required `peek` breaks an external replacement implementation of one of the two services.**
  Mitigated by the CHANGELOG entry stating the one-line addition, and bounded by the fact that both
  contracts have exactly one in-repo implementor and every stand-in is structurally cast (§1).
- **`peek` invites the impression that the registries self-limit.** Mitigated by C3: the SSE README
  and `PUBLIC_API.md` state plainly that a channel created by `channel(name)` is never reclaimed
  before shutdown, so `peek` is documented as the fix for the read path only.
- **A circular structure still throws at runtime, and no type can catch it.** Mitigated by stating
  it in the `SseMessage.data` JSDoc and the `PUBLIC_API.md` note rather than implying the type makes
  every payload safe.

## 9. Out of scope

- **An enumeration API (`rooms()` / `channels()`).** No reader exists: the health indicators report
  counts, and a presence endpoint answers one name at a time.

  **Amended during implementation.** This bullet originally justified itself with "which `roomCount`
  and `connectionCount` already serve"; that did not survive contact. `IWebSocketService` publishes
  `roomCount` and its indicator reports `rooms`, but the SSE indicator reported `connections` alone
  and `ISseService` had no channel count at all — so the never-reclaimed growth this milestone
  documents had no operator-visible signal, and the SSE integration guard had to read the registry
  through `peek` itself for want of one. A required `ISseService.channelCount`, reported as
  `channels`, was added at the maintainer's direction. The decision recorded here still stands: no
  enumeration API shipped, only a count. Adding it now would be dead surface. A future milestone
  that ships a realtime presence endpoint owns it.
- **Reclaiming empty SSE channels.** §3.9 — a behaviour change that risks silent partial delivery
  for an application holding a channel reference. A safe design (reference-stable channels, or an
  explicit `release(name)`) is a separate change; the growth is documented rather than half-fixed.
- **Making `ISseConnection.send` generic so named interfaces assign.** The interface/index-signature
  limitation is TypeScript's and predates this milestone (§1.1). A generic `send` would change the
  signature of a released method for an ergonomics gain the `type`-alias workaround already
  provides.
- **Constraining `WebSocketRoom.broadcastJson<T>` to `JsonValue`.** A second breaking change with
  its own consumers; the WebSocket path has no equivalent false documented guarantee driving it.
- **A cookie-reading realtime auth strategy** — Milestone 73, developed independently on its own
  branch.
- **`traceparent` propagation across the brokers** — Milestone 75.
