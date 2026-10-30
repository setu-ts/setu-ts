# REST API example

An in-memory todo API built with the REST starter. It enables the starter's auth and OpenAPI arms
and adds `POST /todos` and `GET /todos/:id`.

```bash
pnpm --dir apps/rest-api run start
pnpm --dir apps/rest-api run smoke
```

The smoke check writes a todo, reads it back through the same API, and then verifies the OpenAPI
document is actually usable: it declares the `bearerAuth` scheme (so Swagger UI renders an
**Authorize** button and the protected routes can be tried), it carries a document-level security
requirement, it does **not** list `/openapi.json` and `/docs` as API operations, and its `id` path
parameter is typed as a string rather than rendering as `any`.

Open http://localhost:3000/docs after `pnpm --dir apps/rest-api run start` to exercise the API from
the browser: click **Authorize**, paste a token, and call `GET /todos/{id}`.

Read the [example deep dive](../../docs/examples.md#rest-api) for the concept and source
walkthrough.
