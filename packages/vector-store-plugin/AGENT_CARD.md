# @setu-ts/vector-store-plugin — tenant-scoped vector retrieval

**Add it:** `setu add vector-store` installs the package and prints the registration; collections
are required, so it never inserts one. `VectorStorePlugin` provides `CAPABILITIES.VECTOR_STORE`
(`IVectorStore`).

## Register

```ts
import { MemoryVectorStore, VectorStorePlugin } from '@setu-ts/vector-store-plugin';

export const vectorStore = VectorStorePlugin({
  adapter: new MemoryVectorStore(),
  collections: [{ name: 'documents', dimensions: 1024, filterable: { tag: 'string' } }],
});
```

An adapter may be a factory `(runtime) => adapter | Promise<adapter>`. Collections are validated at
construction; the adapter creates or verifies them during registration, so a bad backend fails
startup rather than the first request.

## Behavior

- The scope is a required second argument of every data method, never a filter key.
  `IVectorStore.scopeFor` returns the request's tenant id, or the `{ fixed }` scope for every
  request. Tenancy defaults to `'required'`; a tenant-less request refuses with
  `VectorScopeRequiredError` before any adapter call.
- Methods: `upsert`, `replaceSource`, `query`, `delete`, `deleteScope`. `replaceSource` writes the
  source's new records, then deletes its stale ones in the same scope, so a re-run leaves one copy.
- Cosine similarity only, in `[-1, 1]`. Results are ordered by score descending, then id ascending.
  `topK` is 1–50 and an adapter may return fewer.
- Filters use `eq`, `in`, `gt`, `gte`, `lt`, `lte` and `and` over declared `filterable` fields.
  Ranges need a `number` field; string values are at most 64 UTF-8 bytes; `in` takes 1–100 values;
  `and` nests at most 4 deep, 32 clauses total. No `or`, substring match or negation. Anything else
  throws `VectorFilterError` naming the clause — never dropped.
- Limits: 4,096 dimensions, 10 filterable fields, 500 records per write, 1,000 ids per delete,
  64-byte scope, 256-byte ids, 8 KiB content.
- Adapters: `MemoryVectorStore`, `PgVectorStore`, `QdrantVectorStore`; `VectorizeVectorStore` is in
  `@setu-ts/cloudflare-plugin` and refuses `replaceSource` and `deleteScope` by name.
- The store does not embed text. Build vectors with the AI SDK and pass them in; keep one model per
  collection.

See the README for adapter setup, the errors table and the full capability matrix.
