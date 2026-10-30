# @setu-ts/storage-plugin — file and object storage

**Add it:** `setu add storage` adds it and wires `StoragePlugin()` in a recognized functional
config. It provides `CAPABILITIES.STORAGE` (`IStorage`); the default provider is memory.

## Accept a multipart upload in a route

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, IRuntimeServices, IStorage } from '@setu-ts/common';
import { createUploadMiddleware, getUploadedFile } from '@setu-ts/storage-plugin';

export function registerUploadRoutes(router: IRouterApi): void {
  router.post('/upload', {
    middleware: [createUploadMiddleware({ fieldname: 'avatar', maxSize: 5_000_000 })],
    handler: async (ctx) => {
      const file = getUploadedFile(ctx, 'avatar');
      if (!file) return ctx.response.status(400).json({ error: 'missing file' });
      const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
      const key = `avatars/${ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME).uuid()}`;
      await storage.put(key, file.data, { contentType: file.mimeType });
      return ctx.response.status(201).json({ key });
    },
  });
}
```

## Read an object or create a download link

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IStorage } from '@setu-ts/common';

const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
const bytes = await storage.get('avatars/user-1');
const url = await storage.getSignedUrl('avatars/user-1', { expiresIn: 3600 });
```

## Behaviour the types do not show

- `maxSize` is bytes per file and defaults to 10485760; oversized files or bodies answer 413.
  Disallowed types and too many files answer 400.
- Upload field names must match; the default `fieldname` is `'file'`. Non-multipart requests pass
  through without uploading anything.
- `get` rejects for a missing key. Memory stores bytes only, dropping content type and metadata; its
  signed URLs are synthetic and cannot be fetched outside the process.
- Signed URL `expiresIn` is seconds. Local storage rejects signed URL requests.
- The capability is ready after startup; inside handlers `ctx.services` is ready.

## Other options

- `provider` selects `'local'`, `'s3'`, `'b2'`, `'gcs'` or `'azure'` instead of memory.
- `allowedMimeTypes`, `maxFiles` and `maxBodyBytes` constrain upload parsing.
- `getStream` streams reads; providers without native streaming wrap buffered bytes.
