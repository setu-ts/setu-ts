/**
 * TemplateEngine — renders named `{{ variable }}` mail body templates. HTML
 * bodies escape interpolated values; text bodies substitute raw. The subject is
 * never templated (it is taken verbatim from the `sendTemplate` envelope).
 *
 * @module
 */
import type { MailTemplate } from '../interfaces/index.ts';

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
 * A registry of named body templates with `{{ variable }}` interpolation.
 *
 * @since 0.1.0
 */
export class TemplateEngine {
  readonly #templates: ReadonlyMap<string, MailTemplate>;

  /**
   * @param templates - Named templates (from `MailPluginOptions.templates`)
   */
  constructor(templates?: Readonly<Record<string, MailTemplate>>) {
    this.#templates = new Map(Object.entries(templates ?? {}));
  }

  /** Reports whether a template is registered. */
  has(name: string): boolean {
    return this.#templates.has(name);
  }

  /**
   * Renders a template's bodies with `data`.
   *
   * @param name - Template name
   * @param data - Interpolation variables
   * @returns The rendered `html`/`text` bodies that the template defines
   * @throws {Error} If the template is unknown or a placeholder key is absent
   *   from `data`
   */
  render(name: string, data: Readonly<Record<string, unknown>>): RenderedTemplate {
    const template = this.#templates.get(name);
    if (template === undefined) {
      throw new Error(`Unknown mail template: ${name}`);
    }
    const result: RenderedTemplate = {};
    if (template.html !== undefined) {
      result.html = this.#interpolate(template.html, data, name, true);
    }
    if (template.text !== undefined) {
      result.text = this.#interpolate(template.text, data, name, false);
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
