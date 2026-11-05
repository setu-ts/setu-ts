# MCP tools

Available from **0.12.0**. Four explicitly marked HTTP routes are exposed as scoped MCP tools at
`POST /mcp`: `list_items`, `read_item`, `create_item` and `archive_item`.
This app was generated with `setu new --template rest --runtime node` and
`setu generate module items --adopt-controllers`. The generated factory and CLI-owned barrels
retain their signatures; `setu sync` owns the barrels.

Run from the repository root after installing dependencies:

```bash
pnpm --dir apps/mcp-tools run check
pnpm --dir apps/mcp-tools run smoke
pnpm --dir apps/mcp-tools run test
pnpm --dir apps/mcp-tools run test:e2e
pnpm --dir apps/mcp-tools run build
pnpm --dir apps/mcp-tools run start
```

The repository scripts run source through the app tsconfig. A downloaded example installs published
packages; its `check` script is rewritten to `tsc --noEmit`. Build before start: the generated
start command runs `dist/main.js` with `instrumentation.mjs`.
In this repository, `build` bundles against the framework packages' compiled output, and the
`setu` command it calls is itself one of them. In a fresh clone, compile them once from the
repository root with `pnpm exec tsc -b` before `build`; otherwise `build` cannot find `setu` and
`start` cannot find the packages. `start:dev` runs the source with tsx and needs no build.

Use `JWT_SECRET` to replace the clearly named local demo default. **The default is public**: anyone
can mint a token it accepts. The app still starts without `JWT_SECRET`, including from `npm start`
and the Docker image, so every deployment must set it. `MCP_RESOURCE` defaults to
`http://localhost:3000`; `MCP_RATE_MAX` defaults to 60 requests per principal, per tool, per minute.
After starting with the chosen secret, run `npm run token -- "items:read items:write"` in this
directory with the same environment to print a five-minute operator credential. Like `start`, it
reads `.env`, so a secret kept there signs tokens the server accepts. Never log it.
To try the HTTP routes from Swagger UI, open `http://localhost:3000/docs`, click **Authorize** and
paste the token. Each operation lists the scope it needs, and `POST /items` and
`POST /items/{id}/archive` take an `Idempotency-Key` header: any new value per create or archive.
Configure a desktop client's Streamable HTTP URL as `http://localhost:3000/mcp` with a Bearer header.
The default empty `allowedOrigins` list accepts non-browser requests with no Origin; browser UIs
need an explicitly listed exact origin.

The smoke uses the official MCP client in-process and over one real socket. It proves exact scope
visibility, response/query/path schemas, create/read, idempotent retries, validation, hidden/unknown
calls, rate refusals, Origin rejection and archive quota accounting. If the optional SDK is absent,
it exits 77. No external service is needed.

Archive costs two of three units per principal per UTC day. Identical retries replay before quota
middleware and are not charged twice; refused archives release their reservation. Rate refusals
become `Quota Exceeded: Rate limit exceeded`, and quota refusals become
`Quota Exceeded: The quota for this request is spent.`. MCP does not surface Retry-After.
Items, idempotency records and quotas are process-local demonstration state. Replace the unbounded
item map with a repository and use shared idempotency/quota stores across replicas before deployment.
The demo grants all authenticated writers access to the shared collection; it does not implement
per-item ownership.

Follow the [complete MCP guide](../../docs/mcp.md) for installation, full code, scopes, limits,
testing and desktop setup, and the [AI guide](../../docs/ai.md) for weighted quotas.
