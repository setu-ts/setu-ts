# gRPC workspace example

Two members of a Setu workspace calling each other over gRPC: `billing` serves
`billing.v1.BillingService/Quote`, and `orders` finds billing through its generated discovery map
and calls it with a Connect client. The contract is one `.proto` in the `libs/contracts` library.
Everything else is what the CLI generated, with the differences listed below.

```bash
pnpm --dir apps/grpc-workspace run smoke   # both members as separate processes, real RPCs
pnpm --dir apps/grpc-workspace run start   # the generated dev runner: billing, then orders
```

The smoke starts billing on 3410 and orders on 3411, quotes an order through orders, calls `Quote`
directly over Connect, checks the `400` answers for an unknown SKU and a zero quantity, and checks
that orders answers `503` once billing has stopped.

## How it was generated

```bash
setu new grpc-workspace --workspace --runtime node --port 3410
cd grpc-workspace
setu generate library contracts
setu generate app billing --template microservice --rpc grpc
setu generate app orders --template microservice --depends-on billing
cd apps/orders
setu generate controller orders
setu generate service orders
setu generate schema orders
```

## What differs from the generated workspace

`test/grpc-workspace-example.test.ts` regenerates the workspace with these commands and fails on any
difference missing from its four lists (changed, deleted, renamed and added files, each with its
reason). In short:

- **The contract** lives in `libs/contracts`: `proto/billing/v1/billing.proto`, buf's configuration
  (moved from the members), the committed protoc-gen-es output in `src/gen/`, a `tsconfig.json`, and
  an `index.ts`, test and README that use `BillingService` instead of the generated stub. Its
  `proto:gen` script runs buf through `npx`, with protoc-gen-es pinned to the locked
  `@bufbuild/protobuf`, so no install fetches buf. billing's stub proto, `proto/README.md`, buf
  files and `proto:gen` script are removed.
- **billing**, the one member generated with `--rpc grpc`, implements `Quote` in
  `src/modules/billing/billing.grpc.ts`, in a module whose `index.ts` and barrel are what
  `setu sync` writes. The CLI owns `GrpcPlugin` (in `src/transport/index.ts`), so the same file
  exports `BillingGrpcPlugin`, which adds the service through `IGrpcService.addService`;
  `setu.config.ts` registers it after `transportPlugins()` and calls `registerModules`.
- **orders** is an HTTP member: it adds `@connectrpc/connect` and `@connectrpc/connect-web`, which
  an HTTP member does not ship, and a client in `src/clients/billing.client.ts`. It has one feature,
  so it stays flat, as a new service does until its first `setu generate module`: the generated
  `src/controllers/orders.controller.ts`, `src/services/orders.service.ts` and
  `src/shared/schemas/orders.schemas.ts` now create, list and read orders, quoting each new one
  through billing. Its tests use a fake billing.
- **In this repository**, framework packages are `workspace:^`, the library is linked with
  `workspace:*`, each member's `tsconfig.json` extends the repository's `tsconfig.apps.json`, member
  `check` is `tsc` only (`setu check` runs in the conformance test), `eslint.config.js` is named
  `lint.config.js`, each `main.ts` allows `console`, and `.env` is not committed. The root
  `package.json` adds `start`, `smoke` and `check`, replaces the npm-only `test` with one that runs
  every member's tests, and declares `tsx` and `@types/node`.

## The generated workspace README

A [Setu-TS](https://setu-ts.dev/) workspace: one repository, many deployable services.

## Add a service

```bash
npx @setu-ts/cli@0.11.0 generate app orders --template microservice
```

Each service lives in `apps/<name>/`, binds a port the CLI allocates, and is registered in every
other service's static discovery map — so `discovery.resolveUrl('orders')` works from any sibling
with no configuration.

## Run every service

```bash
npm install
npm run dev
```

When a service needs another one during startup, declare it as it is added:

```bash
npx @setu-ts/cli@0.11.0 generate app billing --template microservice --depends-on orders
```

The generated dev runner starts prerequisites first and waits for each prerequisite's `/ready`
endpoint before it starts a dependent. Dependencies are explicit because a discovery map describes
where a service is, not whether this service must wait for it at startup.

## Ports

`setu.workspace.json` records the port each service binds. It is the source the generated
`src/discovery/services.ts` modules are rendered from; change a port there and the next
`npx @setu-ts/cli@0.11.0 generate app` rewrites them all.

If a local process occupies a port, the CLI skips it during allocation. To repair existing
assignments, stop the services and run `npx @setu-ts/cli@0.11.0 workspace ports --reallocate`; it
rewrites the manifest, maps, and deployment artifacts together. It assigns from the base port
upward, so a service still running holds its own port and is moved off it.

<!-- setu:transport -->

## Transport

Members share the **memory** broker — In-process broker — messages never leave one service
(single-service testing).

The broker is a property of the whole workspace, recorded in `setu.workspace.json`, because members
can only meet on a bus they share. Every service added later inherits it. How a service is called is
its own choice: `npx @setu-ts/cli@0.11.0 generate app <name> --rpc grpc` adds Connect/gRPC beside
its HTTP routes.

<!-- /setu:transport -->

## Test, build and deploy

```bash
npm test     # every member's and library's tests
npm run build    # one container image per member, tagged with the current commit
npm run deploy   # build, ship to the cluster, apply k8s/, wait for every rollout
```

Deploy loads the images into a `kind-*` context's cluster, or pushes them to `--registry` for any
other context. A member's variables are the names its `.env.example` declares; put their values in
`k8s/secrets/<member>/.env`, which git ignores and no image copies. See `k8s/README.md` for every
flag, and run deploy with `--dry-run` to see the plan first.

## Build and start one member

```bash
cd apps/orders
npm run build
npm start
```

Full-stack Bun members also run `bun run build` before starting. Node builds inline shared libraries
and keep npm dependencies external.
