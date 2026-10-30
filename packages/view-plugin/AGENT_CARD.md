# @setu-ts/view-plugin — render HTML from components

**Add it:** `setu add view` adds it and inserts `ViewPlugin()` into `setu.config.ts`. It provides
`CAPABILITIES.VIEW` (`IViewEngine`); the default authoring mode is `hono-jsx`.

## Render a page from a module route

A fixed template with a numeric prop needs no JSX compiler setup:

```ts
import type { IRouterApi } from '@setu-ts/common';
import { renderView } from '@setu-ts/view-plugin';

const receipt = (props: { count: number }) => `<p>Items: ${Number(props.count)}</p>`;

export function registerReceiptRoutes(router: IRouterApi): void {
  router.get('/receipt', {
    handler: (ctx) => renderView(ctx, receipt, { count: 3 }),
  });
}
```

## Replace the renderer

Put the returned plugin in the config's plugin list:

```ts
import type { IViewEngine } from '@setu-ts/common';
import { ViewPlugin } from '@setu-ts/view-plugin';

export function views(view: IViewEngine) {
  return ViewPlugin({ engine: 'custom', view });
}
```

## Behaviour the types do not show

- `renderView` resolves the engine per request and returns `text/html; charset=utf-8`.
- Rendering buffers the complete result; it does not stream.
- Plain string components are returned unchanged. Escape dynamic text in the producer; the numeric
  conversion above is deliberate. JSX and the template runtime perform their own escaping.
- `null`, `false`, `true` and an empty string render empty; `undefined` throws `ViewRenderError`.
- A pending suspense boundary throws `UnresolvedSuspenseError` instead of serving a permanent
  fallback.

## Other options

- `engine: 'hono-html'` selects template authoring in plain TypeScript; both built-in modes use one
  engine.
- `engine: 'hono-jsx'` selects JSX authoring; configure the application's JSX runtime accordingly.
- Compose layouts as components receiving children; there is no plugin-level layout option.
