# @setu-ts/storage-plugin — file and object storage

`setu add storage` installs it and registers `StoragePlugin()` in a recognized functional config;
otherwise add that line in `setu.config.ts`. A full-stack starter's `storage` arm owns that
registration; do not add a second instance. The default provider is memory; `CAPABILITIES.STORAGE`
resolves after `app.start`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IStorage } from '@setu-ts/common';
import { StoragePlugin } from '@setu-ts/storage-plugin';

app.register(
  StoragePlugin({ provider: 's3', options: { bucket: 'uploads', region: 'us-east-1' } }),
);

await app.start();
const storage = app.services.get<IStorage>(CAPABILITIES.STORAGE);
await storage.put('avatars/ada.png', new Uint8Array([137, 80, 78, 71]), {
  contentType: 'image/png',
});
const bytes = await storage.get('avatars/ada.png');
const url = await storage.getSignedUrl('avatars/ada.png', { expiresIn: 3600 });
```

Accept an upload with the bundled multipart middleware:

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IStorage } from '@setu-ts/common';
import { createUploadMiddleware, getUploadedFile } from '@setu-ts/storage-plugin';

app.router.post('/upload', {
  middleware: [createUploadMiddleware({ fieldname: 'avatar', maxSize: 5_000_000 })],
  handler: async (ctx) => {
    const file = getUploadedFile(ctx, 'avatar');
    if (!file) return ctx.response.status(400).json({ error: 'No file' });
    const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
    await storage.put(`avatars/${file.filename}`, file.data, { contentType: file.mimeType });
    return ctx.response.json({ ok: true });
  },
});
```

- `provider` is `'memory'` (default), `'local'` (`options.rootDir`, default `'.'`), `'s3'` or `'b2'`
  (`options.bucket`; `region`), `'gcs'` (`options.bucket`) or `'azure'` (`options.containerName`).
- The upload `fieldname` must match what `getUploadedFile` reads. The size cap is `maxSize` (not
  `maxFileSize`); `maxBodyBytes`, `allowedMimeTypes` and `maxFiles` also shape the parse. Too large
  answers 413; a bad type or body answers 400.
- Memory/local persist bytes only: `contentType`/`metadata` are accepted and dropped, and local
  `getSignedUrl` rejects. Only S3/B2 streams with bounded memory.
- `provider: 'local'` needs write permission; on Deno add `--allow-write`, or startup refuses.
- `storage.put/get/delete/exists/getSignedUrl` are the capability methods; `getStream` returns a
  readable stream.
