/**
 * TemplateEngine — renders named mail body templates. Two arms share one
 * registry and one lookup: `{{ variable }}` strings (HTML bodies escape
 * interpolated values; text bodies substitute raw) and view components
 * rendered through the `IViewEngine` registered under `CAPABILITIES.VIEW`
 * (M102). The subject is never templated — it is taken verbatim from the
 * `sendTemplate` envelope.
 *
 * `render` is asynchronous because `IViewEngine.render` answers
 * `string | Promise<string>` and an async component's render genuinely is a
 * promise; the string arm shares the signature so a caller has one shape to
 * await. Being `async`, every refusal is a rejection, never a synchronous
 * throw from a method typed `Promise` (the M52b class).
 *
 * @module
 */
import type { IViewEngine } from '@setu-ts/common';
import type {
  MailComponentTemplate,
  MailStringTemplate,
  MailTemplate,
} from '../interfaces/index.ts';

/** Matches a `{{ key }}` placeholder with any surrounding inner whitespace. */
const PLACEHOLDER = /\{\{\s*([\w.$-]+)\s*\}\}/g;

/** A rendered template body. Only present bodies are returned. */
export interface RenderedTemplate {
  html?: string;
  text?: string;
}

/**
 * Escapes the five HTML-significant characters so interpolated user data cannot
 * inject markup into an HTML body.
 *
 * @param value - The raw value
 * @returns The HTML-escaped value
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Discriminates the component arm of {@linkcode MailTemplate}. The one
 * definition both `MailPlugin` (deciding whether to resolve an engine) and
 * this class (deciding how to render) read, so the two cannot disagree about
 * which templates need one. Internal: not exported from the package barrel.
 *
 * @param template - The template to classify
 * @returns `true` for a component template
 */
export function isComponentTemplate(template: MailTemplate): template is MailComponentTemplate {
  return 'view' in template && template.view !== undefined;
}

/**
 * A registry of named body templates: `{{ variable }}` strings and view
 * components, rendered through one `render`.
 *
 * @since 0.1.0
 */
export class TemplateEngine {
  readonly #templates: ReadonlyMap<string, MailTemplate>;
  readonly #viewEngine: IViewEngine | undefined;

  /**
   * @param templates - Named templates (from `MailPluginOptions.templates`)
   * @param viewEngine - The engine the component arm renders through; required
   *   when any template is a component template, and resolved by `MailPlugin`
   *   from `CAPABILITIES.VIEW` at `register()`
   * @throws {Error} If a component template is configured and `viewEngine` is
   *   absent — refused here, at construction, so the failure is a startup
   *   failure naming the template and both remedies rather than a throw on the
   *   first `sendTemplate` (the M92 `@Render` precedent)
   */
  constructor(templates?: Readonly<Record<string, MailTemplate>>, viewEngine?: IViewEngine) {
    this.#templates = new Map(Object.entries(templates ?? {}));
    this.#viewEngine = viewEngine;
    if (viewEngine === undefined) {
      for (const [name, template] of this.#templates) {
        if (isComponentTemplate(template)) {
          throw new Error(
            `Mail template "${name}" is a view component, but no CAPABILITIES.VIEW provider is ` +
              'registered. Register ViewPlugin from @setu-ts/view-plugin (or any other provider ' +
              'of CAPABILITIES.VIEW) so the body can be rendered, or remove the component ' +
              'templates.',
          );
        }
      }
    }
  }

  /** Reports whether a template is registered. */
  has(name: string): boolean {
    return this.#templates.has(name);
  }

  /**
   * Renders a template's bodies with `data`.
   *
   * A string template substitutes `{{ key }}` placeholders and refuses a key
   * absent from `data`. A component template passes `data` to each component
   * VERBATIM as its props and performs no missing-key check — a component
   * reads whatever it reads, so an absent key renders as `undefined`; the
   * compile-time route is `engine.render(Component, props)` by hand.
   *
   * @param name - Template name
   * @param data - Interpolation variables, or the component's props
   * @returns The rendered `html`/`text` bodies that the template defines
   * @throws {Error} If the template is unknown, or (string arm) a placeholder
   *   key is absent from `data`; a component that throws rejects with the
   *   engine's own error unwrapped
   */
  async render(name: string, data: Readonly<Record<string, unknown>>): Promise<RenderedTemplate> {
    const template = this.#templates.get(name);
    if (template === undefined) {
      throw new Error(`Unknown mail template: ${name}`);
    }
    if (isComponentTemplate(template)) {
      return await this.#renderComponent(template, data);
    }
    return this.#renderString(template, data, name);
  }

  /** The string arm: `{{ key }}` substitution, escaping the html body. */
  #renderString(
    template: MailStringTemplate,
    data: Readonly<Record<string, unknown>>,
    name: string,
  ): RenderedTemplate {
    const result: RenderedTemplate = {};
    if (template.html !== undefined) {
      result.html = this.#interpolate(template.html, data, name, true);
    }
    if (template.text !== undefined) {
      result.text = this.#interpolate(template.text, data, name, false);
    }
    return result;
  }

  /**
   * The component arm: each body through the ONE view engine. Both `await`s
   * are load-bearing — the engine's return is `string | Promise<string>`, and
   * skipping one would write the literal text `[object Promise]` into a mail
   * body for exactly the async components the port's promise arm exists for.
   */
  async #renderComponent(
    template: MailComponentTemplate,
    data: Readonly<Record<string, unknown>>,
  ): Promise<RenderedTemplate> {
    // `#viewEngine` is present whenever a component template exists: the
    // constructor refused the other combination, and the template map is a
    // private copy taken at construction, so no later edit to the caller's
    // object can add a component template the check never saw.
    const engine = this.#viewEngine as IViewEngine;
    // `data` is typed `Record<string, unknown>` by the committed
    // `IMailer.sendTemplate` contract, and `Component<never>` is the one type
    // every component is assignable to; the cast is the only way to hand the
    // untyped bag to the component, and it is confined to these two lines.
    const result: RenderedTemplate = { html: await engine.render(template.view, data as never) };
    if (template.text !== undefined) {
      result.text = await engine.render(template.text, data as never);
    }
    return result;
  }

  /** Replaces every `{{ key }}` with `data[key]`, escaping for HTML when asked. */
  #interpolate(
    body: string,
    data: Readonly<Record<string, unknown>>,
    name: string,
    escape: boolean,
  ): string {
    return body.replace(PLACEHOLDER, (_match, key: string): string => {
      if (!(key in data)) {
        throw new Error(`Unknown template variable "${key}" in template "${name}"`);
      }
      const value = String(data[key]);
      return escape ? escapeHtml(value) : value;
    });
  }
}
