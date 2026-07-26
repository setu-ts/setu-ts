# @hono-enterprise/storage-plugin

File and object storage. Registers an `IStorage` under `CAPABILITIES.STORAGE` (`'storage'`).

Five providers ship: `MemoryProvider` (zero-dependency default), `LocalStorageProvider` (over
`runtime.fs`), `S3Provider`, `GcsProvider`, and `AzureBlobProvider`. Backblaze B2 is a first-class
`'b2'` provider type reusing `S3Provider` over B2's S3-compatible endpoint.

## Installation

```typescript
import { StoragePlugin } from '@hono-enterprise/storage-plugin';
```

## Usage

```typescript
import {
  createUploadMiddleware,
  getUploadedFile,
  StoragePlugin,
} from '@hono-enterprise/storage-plugin';
import { CAPABILITIES, type IStorage } from '@hono-enterprise/common';

app.register(StoragePlugin({
  provider: 's3',
  options: { bucket: 'uploads', region: 'us-east-1' },
}));

const storage = app.services.get<IStorage>(CAPABILITIES.STORAGE);

await storage.put('avatars/ada.png', bytes);
const data = await storage.get('avatars/ada.png');
const url = await storage.getSignedUrl('avatars/ada.png', { expiresIn: 3600 });
```

## Uploads

```typescript
app.router.post('/upload', {
  middleware: [createUploadMiddleware({ maxFileSize: 5_000_000 })],
  handler: async (ctx) => {
    const file = getUploadedFile(ctx, 'avatar');
    await storage.put(`avatars/${file.filename}`, file.data);
    return ctx.response.json({ ok: true });
  },
});
```

The multipart parser is implemented in this package — no dependency.

## Options

| Option     | Type                                                      | Default    | Description                      |
| ---------- | --------------------------------------------------------- | ---------- | -------------------------------- |
| `provider` | `'memory' \| 'local' \| 's3' \| 'b2' \| 'gcs' \| 'azure'` | `'memory'` | Backend.                         |
| `options`  | `StorageProviderOptions`                                  | —          | Provider-specific configuration. |

## Signed URLs

`getSignedUrl` semantics differ by provider, deliberately:

| Provider      | Behaviour                             |
| ------------- | ------------------------------------- |
| Memory        | synthetic URL                         |
| Local         | **throws** — there is nothing to sign |
| S3 / B2 / GCS | real presigned URL                    |
| Azure Blob    | real SAS URL                          |

## Streaming

The optional `getStream?` reads an object as a `ReadableStream<Uint8Array>`, wired through
`IResponse.stream()` for zero-copy downloads.

## Full API

Every export and option is documented in [PUBLIC_API.md](../../PUBLIC_API.md).
