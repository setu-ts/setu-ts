# REST API example

An in-memory todo API built with the REST starter. It enables the starter's auth and OpenAPI arms
and adds `POST /todos` and `GET /todos/:id`.

```bash
cd apps/rest-api
deno task start
deno task smoke
```

The smoke check writes a todo, reads it back through the same API, and verifies the route appears in
`/openapi.json`.
