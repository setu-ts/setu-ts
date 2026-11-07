# Semantic search

Available from **0.12.0**. Upload a document, index it in the background, and search it by meaning
inside the caller's tenant. The example composes `@setu-ts/vector-store-plugin` with the AI SDK,
multi-tenancy and the queue plugin.

Run from the repository root after installing dependencies:

```bash
pnpm --dir apps/semantic-search run check
pnpm --dir apps/semantic-search run smoke
pnpm --dir apps/semantic-search run test
pnpm --dir apps/semantic-search run test:e2e
pnpm --dir apps/semantic-search run build
pnpm --dir apps/semantic-search run start
```

Build before start: `start` runs `dist/main.js` with `instrumentation.mjs` and reads `.env`.
`build` bundles against the framework packages' compiled output, and the `setu` command it calls is
itself one of them. In this repository, compile them once from the repository root with
`pnpm exec tsc -b` before `build`; otherwise `build` cannot find `setu` and `start` cannot find the
packages. A downloaded copy installs published packages, so it needs no compile step. `start:dev`
runs the source with tsx and needs no build.

## What it serves

At `http://localhost:3000` (set `PORT` to change it):

- `POST /documents` — queue `{ "id": "doc-1", "text": "...", "tag": "pets" }` and answer `202` with
  `{ "id": "doc-1", "status": "queued" }`. The id is 1–128 characters of `A-Z a-z 0-9 . _ -`; `text`
  is 1–65,536 characters; `tag` is optional and up to 64 characters.
- `GET /documents/search?q=cats&tag=pets&limit=5` — embed the query and return the closest chunks.
  `q` is required and up to 1,000 characters; `limit` is 1–20 and defaults to 5; `tag` filters on
  the collection's one declared field.
- `GET /` — the hello-world route.
- `GET /health`, `/live`, `/ready`, `/metrics`, `/docs` and `/openapi.json`.

Both document routes take the tenant from `x-tenant-id`. The example registers the fixed tenants
`acme` and `globex`. A request without the header answers `400`; an unknown tenant answers `404`.
Each tenant has its own vector scope, so a search never returns another tenant's chunks. The header
is declared with `validateHeaders`, so Swagger UI at `/docs` shows an `x-tenant-id` field for
"Try it out".

The header resolver trusts the caller: any client can name either tenant. That keeps the example
runnable without sign-in. A deployed application resolves the tenant from the signed-in principal
instead; [Retrieval](../../docs/retrieval.md#search) shows where that check goes.

## How ingestion works

`POST /documents` queues the `ingest-document` job and returns before embedding starts. The job looks
the tenant up again and drops the write if it no longer exists. It splits the text into
800-character chunks on word boundaries, embeds them with the configured model, and calls
`replaceSource('documents', tenant, document.id, records)`. That call writes the new chunks and
removes the document's other chunks, so re-ingesting a shorter text leaves no stale chunk behind.

The queue is the plugin's in-process default. A queued job runs in the same process and is lost on
restart, like the memory vector store.

Jobs for the same document are not ordered against each other, so each submission carries a
version: the time `POST /documents` accepted it, bumped past the previous one so two submissions in
one millisecond still order. The job passes it to `replaceSource`, which refuses an older version
than the one stored. A late retry of an older submission is then logged as superseded and dropped
instead of replacing the newer text. Versions come from each process's clock, so replicas need
synchronised clocks.

## Configuration

`.env.example` lists the defaults; copy it to `.env`, which `start` reads.

| Variable           | Default                    | Purpose                                                                        |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------ |
| `EMBED_BASE_URL`   | `http://localhost:8081/v1` | Any OpenAI-compatible embeddings server (llama.cpp, vLLM, Ollama, OpenAI).     |
| `EMBED_MODEL`      | `qwen3-embedding-0.6b`     | The model name that server serves.                                             |
| `EMBED_DIMENSIONS` | `1024`                     | Vector length, which must match the model. The `documents` collection uses it. |
| `EMBED_API_KEY`    | unset                      | API key when the server requires one.                                          |
| `PGVECTOR_URL`     | unset                      | PostgreSQL URL with pgvector 0.8+. Unset keeps vectors in process memory.      |
| `PORT`             | `3000`                     | HTTP port.                                                                     |

Without `PGVECTOR_URL` the vectors live in process memory, are lost on restart and serve one
process. With it, `PgVectorStore` uses a pool of five connections and closes it on shutdown.

## Smoke checks

`smoke.ts` runs the application through its real composition with `MockEmbeddingModelV4`, so no
model server is needed. It proves background indexing, tenant isolation, replacement after a shorter
re-ingest, a query filter on the declared field, a refused filter on an undeclared field, and a
dimension mismatch. The pgvector scenarios run only when `PGVECTOR_URL` is set. A final block runs
only when `EMBED_BASE_URL` answers `/models`; it checks that a cooking document ranks above a
networking one for a pasta query.

The unit test also mocks the model and needs no service. The end-to-end test posts over HTTP and
checks validation, tenant refusal and the OpenAPI document; it does not embed anything.

See [Retrieval (vector search)](../../docs/retrieval.md) for the plugin, its adapters, filters and
limits, and [Examples](../../docs/examples.md#semantic-search) for the surrounding learning path.
