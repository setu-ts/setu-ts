/**
 * The `'custom'` arm — a by-name engine reaches the capability by adapting
 * each template to a `(props) => string` function, which is already a
 * `Component<P>` (M92 §3.6). The port gains no second, by-name method: a
 * plain-function engine renders through the IDENTICAL path as the default
 * arms.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp, inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPluginContext, IViewEngine } from '@setu-ts/common';

import { renderView, ViewPlugin } from '../../src/index.ts';

/**
 * What a Handlebars-style engine looks like through this port: each compiled
 * template becomes a plain function from props to string, and the engine
 * funnels it through the same render the default arms use.
 */
const greetingTemplate = (props: { readonly name: string }): string =>
  `<p>Greetings, ${props.name}.</p>`;

const CustomTemplateEngine: IViewEngine = {
  render: (component, props) => String(component(props)),
};

describe("the 'custom' engine arm", () => {
  it('registers the supplied engine verbatim under CAPABILITIES.VIEW', async () => {
    const registered = new Map<string, unknown>();
    const ctx = {
      services: {
        register: (token: string, service: unknown) => {
          registered.set(token, service);
        },
        has: (token: string) => registered.has(token),
        get: <T>(token: string) => registered.get(token) as T,
      },
      health: { register: () => {} },
    } as unknown as IPluginContext;

    await ViewPlugin({ engine: 'custom', view: CustomTemplateEngine }).register(ctx);

    expect(ctx.services.has(CAPABILITIES.VIEW)).toBe(true);
    // Verbatim — the plugin must not wrap or substitute the supplied engine.
    expect(registered.get(CAPABILITIES.VIEW)).toBe(CustomTemplateEngine);
  });

  it('a plain-function engine renders through the identical path', async () => {
    const app = await createTestApp({
      plugins: [
        RuntimePlugin(),
        ViewPlugin({ engine: 'custom', view: CustomTemplateEngine }),
      ],
    });
    app.router.get('/greet', (ctx) => renderView(ctx, greetingTemplate, { name: 'ada' }));

    const response = await inject(app, '/greet');

    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.body).toBe('<p>Greetings, ada.</p>');
    await app.stop();
  });
});
