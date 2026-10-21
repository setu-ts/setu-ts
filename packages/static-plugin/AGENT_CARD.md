# @setu-ts/static-plugin — serve files from a directory

`setu add static` adds the dependency and prints the registration line; add `StaticPlugin({ root })`
to the `plugins` array in `setu.config.ts`. `root` is required. The plugin mounts `<urlPrefix>/*`
for GET and HEAD.

```ts
import { StaticPlugin } from '@setu-ts/static-plugin';

export const assets = StaticPlugin({
  root: './public',
  urlPrefix: '/assets',
  fallback: 'index.html',
  cacheControl: (requestPath) =>
    requestPath.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
});
```

- `root` is the directory to serve; `urlPrefix` defaults to `'/'` and `index` to `'index.html'`
  (`''` disables index resolution).
- A root mount claims `GET /*`. An application serving SSR at the root cannot also mount static
  files there — give them their own `urlPrefix`; the kernel refuses a duplicate method and path.
- `fallback` serves the SPA shell when the path is missing and Accept includes `text/html`.
- `cacheControl` takes a string or a per-path function. The function's argument is the full
  leading-slash request path INCLUDING `urlPrefix`, never the filesystem path or a sidecar's.
  Defaults: immutable for content-hashed names, `public, max-age=0, must-revalidate` otherwise.
- `etag`, `ranges` and `compressed` default to `true`: conditional requests, Range responses, and
  `.br`/`.gz` sidecar negotiation, which sends the matching Content-Encoding header.
- `maxBufferBytes` defaults to `1048576`; larger files stream. On a runtime with no filesystem
  (Workers) no route is registered and the `static-files` health indicator reports `up` with
  `data.fs: false`.
