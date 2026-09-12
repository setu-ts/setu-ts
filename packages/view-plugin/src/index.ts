/**
 * @module
 *
 * View rendering plugin — server-rendered HTML as a capability.
 *
 * Registers an `IViewEngine` under `CAPABILITIES.VIEW` so a handler can
 * answer with HTML it did not concatenate by hand: a view is named by
 * reference (a component the application already has — JSX or an `html`
 * tagged template), never by path, so there is no view resolver and no
 * filesystem lookup. Two zero-new-dependency arms ship (`'hono-jsx'`,
 * `'hono-html'`) plus a `'custom'` arm for any engine that adapts its
 * templates to `Component<P>` functions.
 *
 * Every export here is public API and documented in PUBLIC_API.md
 * (AI_GUIDELINES §10).
 */
import { UnresolvedSuspenseError, ViewRenderError } from './errors.ts';
import { raw } from './html.ts';
import type { ViewPluginOptions } from './plugin/options.ts';
import { ViewPlugin } from './plugin/view-plugin.ts';
import { renderView } from './render/render-view.ts';

export { UnresolvedSuspenseError, ViewRenderError };
export { raw };
export { renderView };
export { ViewPlugin };
export type { ViewPluginOptions };
