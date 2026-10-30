# @setu-ts/static-plugin — files and single-page applications

**Add it:** `setu add static` adds it and prints `StaticPlugin({ root })`; put that registration in
`setu.config.ts`. It provides `CAPABILITIES.STATIC_FILES` (`IStaticFiles`).

## Serve built assets beside API routes

```ts
import { StaticPlugin } from '@setu-ts/static-plugin';

export const assets = StaticPlugin({
  root: './public',
  urlPrefix: '/assets',
  cacheControl: 'public, max-age=3600',
});
```

## Serve a single-page application

Use this instead of the asset-only registration when the client owns root routing:

```ts
import { StaticPlugin } from '@setu-ts/static-plugin';

export const frontend = StaticPlugin({
  root: './build/client',
  fallback: 'index.html',
  cacheControl: (path) => path.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
});
```

## Behaviour the types do not show

- `urlPrefix` defaults to `/`, `index` to `index.html`; an empty `index` disables index lookup.
- The plugin mounts both GET and HEAD. A root wildcard cannot share its method and path with an SSR
  catch-all; mount assets at their own prefix.
- `fallback` is used only for a missing path whose Accept header includes `text/html`.
- The `cacheControl` callback receives the full request path, including `urlPrefix`.
- `etag`, `ranges` and `compressed` default to `true`; compression negotiates `.br`/`.gz` sidecars.
- `maxBufferBytes` defaults to 1048576 bytes; larger files stream when the filesystem supports it.
  Without a filesystem, no routes are mounted and the health indicator reports up with
  `data.fs: false`.

## Other options

- Omit `cacheControl` for immutable caching of content-hashed names and revalidation otherwise.
- `root` selects the filesystem directory; `urlPrefix` selects the public mount.
- `createStaticHandler` builds a handler separately; `StaticFilesService` offers the service
  directly.
