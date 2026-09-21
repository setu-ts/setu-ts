# @setu-ts/storage-plugin

File and object storage. Registers an `IStorage` under `CAPABILITIES.STORAGE` (`'storage'`).

Five providers ship: `MemoryProvider` (zero-dependency default), `LocalStorageProvider` (over
`runtime.fs`), `S3Provider`, `GcsProvider`, and `AzureBlobProvider`. Backblaze B2 is a first-class
`'b2'` provider type reusing `S3Provider` over B2's S3-compatible endpoint.

## Installation

```typescript
import { StoragePlugin } from '@setu-ts/storage-plugin';
```

## Usage

```typescript
import { createUploadMiddleware, getUploadedFile, StoragePlugin } from '@setu-ts/storage-plugin';
import { CAPABILITIES, type IStorage } from '@setu-ts/common';

app.register(StoragePlugin({
  provider: 's3',
  options: { bucket: 'uploads', region: 'us-east-1' },
}));

const storage = app.services.get<IStorage>(CAPABILITIES.STORAGE);

const bytes = new Uint8Array([137, 80, 78, 71]);
await storage.put('avatars/ada.png', bytes, { contentType: 'image/png' });
const data = await storage.get('avatars/ada.png');
const url = await storage.getSignedUrl('avatars/ada.png', { expiresIn: 3600 });
```

## Uploads

```typescript
import { createUploadMiddleware, getUploadedFile } from '@setu-ts/storage-plugin';
import { CAPABILITIES, type IStorage } from '@setu-ts/common';

const storage = app.services.get<IStorage>(CAPABILITIES.STORAGE);

app.router.post('/upload', {
  middleware: [createUploadMiddleware({ fieldname: 'avatar', maxSize: 5_000_000 })],
  handler: async (ctx) => {
    const file = getUploadedFile(ctx, 'avatar');
    if (!file) return ctx.response.status(400).json({ error: 'No file' });

    await storage.put(`avatars/${file.filename}`, file.data, {
      contentType: file.mimeType,
    });
    return ctx.response.json({ ok: true });
  },
});
```

Three things this snippet gets right that an earlier version did not, each of which failed at a
different point:

- **`fieldname` must name the field you read back.** The middleware defaults it to `'file'` and
  FILTERS parts to it, so without this line `getUploadedFile(ctx, 'avatar')` is guaranteed to return
  `undefined`.
- **The option is `maxSize`, not `maxFileSize`** — and the compiler's suggestion for the misspelling
  is `maxFiles`, a file-COUNT cap, so taking it silently changes the meaning.
- **`getUploadedFile` returns `UploadedFile | undefined`**, so it needs the guard before
  `file.filename` is read.

Passing `contentType` is what makes a signed URL render the image rather than download it; the field
on `UploadedFile` is `mimeType`.

Size limits answer **413**; a malformed body, a disallowed MIME type and too many files answer
**400**. That includes a body the runtime refused before this middleware ran: `maxBodyBytes` on
`RuntimePlugin` rejects the read with a `413`-hinted error, and the middleware serves that hint
rather than reporting a malformed multipart.

The multipart parser is implemented in this package — no dependency.

## Options

`StoragePluginOptions` is a union discriminated on `provider`, so each backend's `options` are
checked against that backend's own shape and an unknown key is reported by name. `provider` is
optional only on the memory arm, which is the default.

| `provider`      | `options`                     | Required fields |
| --------------- | ----------------------------- | --------------- |
| omitted         | —                             | —               |
| `'memory'`      | —                             | —               |
| `'local'`       | `LocalStorageProviderOptions` | —               |
| `'s3'` / `'b2'` | `S3ProviderOptions`           | `bucket`        |
| `'gcs'`         | `GcsProviderOptions`          | `bucket`        |
| `'azure'`       | `AzureBlobProviderOptions`    | `containerName` |

### Upload middleware options

| Option             | Type       | Default   | Description                                                |
| ------------------ | ---------- | --------- | ---------------------------------------------------------- |
| `fieldname`        | `string`   | `'file'`  | Form field to extract. Parts with other names are dropped. |
| `maxSize`          | `number`   | 10 MB     | Per-file limit. Exceeding it answers `413`.                |
| `maxBodyBytes`     | `number`   | 50 MB     | Ceiling on the body that will be PARSED; see below.        |
| `allowedMimeTypes` | `string[]` | —         | Allow-list. A disallowed type answers `400`.               |
| `maxFiles`         | `number`   | unlimited | File-count cap. Exceeding it answers `400`.                |

The effective parse bound is `min(maxSize * 2 + framing, maxBodyBytes)`. It bounds parsing and the
per-part copies the parse makes, **not** the initial read: the HTTP adapter buffers the whole body
before any middleware runs and `IRequest` exposes no body stream, so no middleware can decline to
read it.

## Object metadata

`storage.put(path, data, { contentType, metadata })` records attributes on the stored object.
Backends differ in what they can hold, and that is a property of the backend rather than a gap:

| Provider   | `contentType`                     | `metadata`              |
| ---------- | --------------------------------- | ----------------------- |
| S3 / B2    | `ContentType`                     | `Metadata`              |
| GCS        | `contentType`                     | `metadata`              |
| Azure Blob | `blobHTTPHeaders.blobContentType` | `metadata`              |
| Memory     | accepted, not persisted           | accepted, not persisted |
| Local      | accepted, not persisted           | accepted, not persisted |

Memory and local store bytes only: `IStorage.get` returns bytes, the local provider's `getSignedUrl`
throws, and the memory provider's URL is synthetic, so nothing could read an attribute back.

## Signed URLs

`getSignedUrl` semantics differ by provider, deliberately:

| Provider      | Behaviour                             |
| ------------- | ------------------------------------- |
| Memory        | synthetic URL                         |
| Local         | **throws** — there is nothing to sign |
| S3 / B2 / GCS | real presigned URL                    |
| Azure Blob    | real SAS URL                          |

A presigned URL serves the object under whatever content type it was stored with, which is why `put`
takes one — see [Object metadata](#object-metadata).

## The `local` provider needs write permission

`LocalStorageProvider` writes through `runtime.fs`, so on Deno the process must be started with
`--allow-write`. The generated `start` task in a scaffolded project requests
`--allow-net --allow-env --allow-read --allow-sys` and not that, so a project switched to
`provider: 'local'` needs the flag added.

The provider proves the root is writable at `connect()` and refuses to start with the flag named,
rather than letting every upload fail against a health check that reports `up` — a `stat` probe only
proves the root is READABLE.

## Streaming

The optional `getStream?` reads an object as a `ReadableStream<Uint8Array>`, wired through
`IResponse.stream()` for zero-copy downloads.

### Backpressure — per provider

Demand-driven streaming is **not** a property of `getStream?` in general. It holds for `S3Provider`
and is measured there; the other providers reach the object differently, and two of them read as
fast as the backend will send regardless of what the consumer is doing.

| Provider                      | Streaming                | Bounded memory for a slow consumer                                      |
| ----------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `S3Provider` (and the B2 arm) | Native, demand-driven    | **Yes** — measured; cancelling releases the upstream connection.        |
| `GcsProvider`                 | Native, but eager        | **No** — enqueues eagerly; cancelling now releases the upstream stream. |
| `AzureBlobProvider`           | Native, but eager        | **No** — drains eagerly; cancelling now releases the upstream stream.   |
| `MemoryProvider`              | None — buffered fallback | **No** — the whole object is already in memory.                         |
| `LocalStorageProvider`        | None — buffered fallback | **No** — `StorageService` reads it whole, then emits one chunk.         |

For the two eager providers and the two fallbacks, a large object is resident in memory regardless
of how slowly the client reads, and an aborted download does not stop the upstream transfer. Only
the S3 path should be relied on for a large-object relay today.

Measured for `S3Provider` against real MinIO: it stays 2-3 MiB ahead of the reader — 3.1 MiB at 1
MiB/s, 1.9-2.5 MiB at 2 MiB/s — and that figure is constant, moving by at most 0.30 MiB over an
eight-second window while delivered bytes grow four-fold. A consumer that stops reading altogether
stops the wire. `test/integration/stream-backpressure-real.test.ts` pins all of that at both rates
against a byte-counting relay in front of the backend. (The same figure was observed once on a 256
MiB object; that is provenance for the size-independence claim, not something the guard re-checks —
it runs against 64 MiB.)

**Process RSS does not measure it.** A large download raises the allocator high-water mark without
retaining anything: forcing GC mid-transfer returns `heapUsed` and `external` to baseline while RSS
stays up, and importing the AWS SDK alone costs ~29 MiB before any object is touched. A generated
`ReadableStream` is therefore not a like-for-like control for an SDK-backed one, and comparing the
two on RSS reports a difference that is mostly the SDK. Count bytes at the socket instead.

## Health indicator

Registered under the `storage` capability. Since M70c it reports two signals: the provider's
lifecycle (`isReady()`) and its reachability (`isHealthy()`).

| Status | Meaning                                                                                    |
| ------ | ------------------------------------------------------------------------------------------ |
| `up`   | The provider is connected and reachable, or cannot be probed (`reachable` is `'unknown'`). |
| `down` | The provider is not connected, or is connected but unreachable.                            |

`data` reports `{ provider, reachable }`, where `reachable` is `true`, `false`, or `'unknown'` when
the provider has no liveness check.

## Exports

| Export                        | Kind      |
| ----------------------------- | --------- |
| `IAwsS3Client`                | reference |
| `canSign`                     | function  |
| `createUploadMiddleware`      | function  |
| `getUploadedFile`             | function  |
| `StoragePlugin`               | function  |
| `AzureBlobProvider`           | class     |
| `GcsProvider`                 | class     |
| `LocalStorageProvider`        | class     |
| `MemoryProvider`              | class     |
| `S3Provider`                  | class     |
| `StorageService`              | class     |
| `AzureBlobProviderOptions`    | interface |
| `AzureStorageOptions`         | interface |
| `GcsProviderOptions`          | interface |
| `GcsStorageOptions`           | interface |
| `IAzureBlobClient`            | interface |
| `IGcsClient`                  | interface |
| `IS3Backend`                  | interface |
| `IStorage`                    | interface |
| `LocalStorageOptions`         | interface |
| `LocalStorageProviderOptions` | interface |
| `MemoryStorageOptions`        | interface |
| `PutObjectOptions`            | interface |
| `S3ProviderOptions`           | interface |
| `S3StorageOptions`            | interface |
| `SignedUrlOptions`            | interface |
| `UploadedFile`                | interface |
| `UploadMiddlewareOptions`     | interface |
| `StoragePluginOptions`        | type      |
| `StorageProviderOptions`      | type      |
| `StorageProviderType`         | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#storage-setu-tsstorage-plugin).
