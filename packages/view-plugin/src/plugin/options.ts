/**
 * {@linkcode ViewPlugin} options — a union discriminated on `engine`, so a
 * missing per-arm field is a compile error rather than a startup throw (the
 * M30 `ChannelConfig` / M50 / M52c precedent). `'custom'` is the arm name used
 * by M31 and M50, not `'external'`.
 *
 * @module
 * @since 0.5.0
 */
import type { IViewEngine } from '@setu-ts/common';

/**
 * Selects the view engine the plugin registers under `CAPABILITIES.VIEW`.
 *
 * - `'hono-jsx'` (default): components are JSX functions authored with
 *   `@hono/hono/jsx`; the application's manifest declares the `jsx` /
 *   `jsxImportSource` compiler options.
 * - `'hono-html'`: components are functions returning an `html` tagged
 *   template result; needs no `jsxImportSource`, so it works in a plain
 *   `.ts` file.
 * - `'custom'`: requires {@linkcode ViewPluginCustom.view}; the supplied
 *   engine is registered verbatim — this is how a by-name engine (Handlebars,
 *   Eta) participates: it adapts each compiled template to a
 *   `(props) => string` function, which is already a `Component<P>`.
 *
 * There is deliberately no plugin-level `layout` option: such an option
 * would wrap EVERY render — including the fragments and partial responses
 * `IResponse.html` already serves to HTMX-style callers, where a full
 * document is the wrong answer — and a page wanting no layout would then
 * need an opt-out. Compose explicitly instead: wrap the child component in
 * the layout at the call site.
 *
 * @since 0.5.0
 */
export type ViewPluginOptions =
  | {
    /** Selects the default JSX arm. */
    readonly engine?: 'hono-jsx';
  }
  | {
    /** Selects the tagged-template arm. */
    readonly engine: 'hono-html';
  }
  | {
    /** Selects the caller-supplied engine. */
    readonly engine: 'custom';
    /** The application's own engine, registered verbatim. */
    readonly view: IViewEngine;
  };
