# graphql-demo

A runnable application exercising `@setu-ts/graphql-plugin` end to end, and an interop suite that
drives it with **real third-party GraphQL clients**.

> **Scope.** This is an example app, not a published package. It is deliberately **outside the Deno
> workspace** — it resolves the framework through relative paths in its own `deno.json`, and it
> depends on npm client libraries (`graphql-ws`, `@apollo/client`) that must never enter a published
> package's dependency graph. Milestone 37 owns the broader `apps/*` examples story; this one landed
> early because M51b needed interop evidence the in-repo suite structurally cannot give.

## Running it

```bash
cd apps/graphql-demo

deno task start          # http://localhost:4000/graphql — open in a browser for GraphiQL
deno task start 4100     # or pick a port

deno task interop        # the interop suite; exits non-zero on any failure
```

`deno task interop` boots its own application on an ephemeral port, so it needs no running server
and leaves nothing behind.

## What the demo serves

| Endpoint                     | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `POST/GET /graphql`          | Queries, mutations, batching, Automatic Persisted Queries      |
| `GET /graphql` (`text/html`) | GraphiQL                                                       |
| `ws://…/graphql/ws`          | Subscriptions over `graphql-transport-ws`                      |
| `POST/GET /graphql/stream`   | Subscriptions over GraphQL-over-SSE, distinct-connections mode |

The schema is deliberately small but covers the awkward cases: a `countdown` subscription that
terminates on its own, a `bookAdded` subscription pushed by a mutation on a _different_ transport,
and a `boom` field that throws an error carrying a fake connection string so masking is observable
rather than asserted.

## Why an interop suite exists

The package's own tests drive our frame codec against our own state machine. That cannot tell us
whether a conformant client agrees with us — and the protocol implementations here are hand-written
from the specifications. So the suite uses the authorities instead:

- **`npm:graphql-ws`** is the reference implementation of the protocol the plugin implements.
- **`@apollo/client`'s persisted-query link** defines the APQ handshake `PUBLIC_API.md` claims to
  interoperate with.

### The cold-cache requirement

Each run boots a fresh application because the APQ cache must start **cold**. With a warm cache
Apollo skips the miss → retry handshake entirely and every check still passes — a result
indistinguishable from a real one. This was observed, not theorised: an early run reported a clean
pass while both requests went out hash-only.

The persisted-query check therefore asserts the **wire sequence** rather than the returned data:

```
["hash-only", "document", "hash-only"]   cold cache — the handshake ran
["hash-only", "hash-only"]               warm cache — the assertion fails
```

Both shapes were produced and observed, so the guard is known to discriminate rather than assumed
to.

## What is covered in-repo instead

The package's own real-socket e2e suite now covers the socket lifecycle, so those properties are
gated by CI and do not depend on this app: two subscriptions multiplexed on one connection without
cross-talk, completing one while the other keeps streaming, `onConnect` refusing a real client with
`4403`, and `WebSocketRouteOptions.heartbeat` proven against a live sweeper with a control
connection on an ordinary route that MUST be swept. This app's remaining unique value is interop
with third-party clients, which is the part that cannot move in-repo.

## Relationship to the gates

The app is not a workspace member, so `deno task check`, `deno task test`, `test:coverage`,
`publish:check`, and `release:verify` do not see it. `deno fmt` and `deno lint` do, and it is kept
clean under both. The trade-off is deliberate and worth stating plainly: **the interop suite is not
run by CI**, so a framework change can break it without turning anything red. Run
`deno task interop` by hand when changing the GraphQL transports.
