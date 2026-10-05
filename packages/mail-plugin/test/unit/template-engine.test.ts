import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { Component, IViewEngine } from '@setu-ts/common';

import { escapeHtml, TemplateEngine } from '../../src/templates/template-engine.ts';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters as literal entities', () => {
    expect(escapeHtml(`Tom & Jerry <b>"quote"</b> 'x'`)).toBe(
      'Tom &amp; Jerry &lt;b&gt;&quot;quote&quot;&lt;/b&gt; &#39;x&#39;',
    );
  });

  it('leaves a safe string unchanged', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});

describe('TemplateEngine', () => {
  it('reports whether a template is registered', () => {
    const engine = new TemplateEngine({ welcome: { text: 'hi' } });
    expect(engine.has('welcome')).toBe(true);
    expect(engine.has('missing')).toBe(false);
  });

  it('renders both bodies, escaping only the html body', async () => {
    const engine = new TemplateEngine({
      welcome: {
        html: '<h1>Hello {{ name }}</h1>',
        text: 'Hello {{ name }}',
      },
    });
    const out = await engine.render('welcome', { name: 'A & B' });
    // The interpolated value is HTML-escaped in the html body ...
    expect(out.html).toBe('<h1>Hello A &amp; B</h1>');
    // ... and raw in the text body.
    expect(out.text).toBe('Hello A & B');
  });

  it('tolerates surrounding whitespace in a placeholder', async () => {
    const engine = new TemplateEngine({ t: { text: 'v={{   value  }}' } });
    expect((await engine.render('t', { value: 42 })).text).toBe('v=42');
  });

  it('returns only the bodies the template defines', async () => {
    const engine = new TemplateEngine({ t: { text: 'only text' } });
    const out = await engine.render('t', {});
    expect(out.text).toBe('only text');
    expect(out.html).toBeUndefined();
  });

  it('rejects (never throws synchronously) on an unknown template', async () => {
    const engine = new TemplateEngine();
    // Observed through `.catch` on purpose: a method typed `Promise` that threw
    // synchronously would bypass this handler (the M52b class).
    let caught: unknown;
    await engine.render('nope', {}).catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('Unknown mail template: nope');
  });

  it('rejects when a placeholder variable is absent from data', async () => {
    const engine = new TemplateEngine({ t: { text: 'Hi {{ name }}' } });
    await expect(engine.render('t', {})).rejects.toThrow(
      'Unknown template variable "name" in template "t"',
    );
  });

  it('accepts an explicit undefined value as present (in-operator semantics)', async () => {
    const engine = new TemplateEngine({ t: { text: 'v={{ value }}' } });
    expect((await engine.render('t', { value: undefined })).text).toBe('v=undefined');
  });
});

/** Records every render and answers a fixed string, sync or async by option. */
function fakeViewEngine(async = false): IViewEngine & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    render<P>(component: Component<P>, props: P): string | Promise<string> {
      calls.push([component, props]);
      const out = String(component(props));
      return async ? Promise.resolve(out) : out;
    },
  };
}

interface GreetingProps {
  readonly name: string;
}
const Greeting: Component<GreetingProps> = (p) => `<p>${p.name}</p>`;
const GreetingText: Component<GreetingProps> = (p) => `Hi ${p.name}`;

describe('TemplateEngine — component arm (M102)', () => {
  it('renders view into html and text into text through the ONE view engine', async () => {
    const view = fakeViewEngine();
    const engine = new TemplateEngine({ welcome: { view: Greeting, text: GreetingText } }, view);
    const out = await engine.render('welcome', { name: 'Ada' });
    expect(out).toEqual({ html: '<p>Ada</p>', text: 'Hi Ada' });
    // Both components were handed `data` verbatim as their props.
    expect(view.calls).toEqual([[Greeting, { name: 'Ada' }], [GreetingText, { name: 'Ada' }]]);
  });

  it('omits text when the template defines no text component', async () => {
    const engine = new TemplateEngine({ welcome: { view: Greeting } }, fakeViewEngine());
    const out = await engine.render('welcome', { name: 'Ada' });
    expect(out.html).toBe('<p>Ada</p>');
    expect('text' in out).toBe(false);
  });

  it('awaits an asynchronous engine so a body is never "[object Promise]"', async () => {
    const engine = new TemplateEngine(
      { welcome: { view: Greeting, text: GreetingText } },
      fakeViewEngine(true),
    );
    const out = await engine.render('welcome', { name: 'Ada' });
    expect(typeof out.html).toBe('string');
    expect(out.html).toBe('<p>Ada</p>');
    expect(out.text).toBe('Hi Ada');
  });

  it('performs NO missing-key check: an absent prop renders as undefined, never throws', async () => {
    // §3.4 — the asymmetry with the string arm is deliberate and pinned.
    const engine = new TemplateEngine({ welcome: { view: Greeting } }, fakeViewEngine());
    const out = await engine.render('welcome', {});
    expect(out.html).toBe('<p>undefined</p>');
  });

  it('serves string and component templates side by side from one registry', async () => {
    const engine = new TemplateEngine(
      { plain: { text: 'Hi {{ name }}' }, fancy: { view: Greeting } },
      fakeViewEngine(),
    );
    expect((await engine.render('plain', { name: 'Ada' })).text).toBe('Hi Ada');
    expect((await engine.render('fancy', { name: 'Ada' })).html).toBe('<p>Ada</p>');
    expect(engine.has('fancy')).toBe(true);
  });

  it('refuses at CONSTRUCTION a component template with no view engine, naming both remedies', () => {
    expect(() => new TemplateEngine({ plain: { text: 'x' }, welcome: { view: Greeting } }))
      .toThrow(
        'Mail template "welcome" is a view component, but no CAPABILITIES.VIEW provider is ' +
          'registered. Register ViewPlugin from @setu-ts/view-plugin (or any other provider of ' +
          'CAPABILITIES.VIEW) so the body can be rendered, or remove the component templates.',
      );
  });

  it('constructs with no view engine when every template is a string template', () => {
    expect(() => new TemplateEngine({ plain: { text: 'x', html: '<b>x</b>' } })).not.toThrow();
  });

  it('propagates a component that throws, unwrapped, as a rejection', async () => {
    const boom = new Error('component exploded');
    const Throwing: Component<GreetingProps> = () => {
      throw boom;
    };
    const engine = new TemplateEngine({ welcome: { view: Throwing } }, fakeViewEngine());
    let caught: unknown;
    await engine.render('welcome', { name: 'Ada' }).catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBe(boom);
  });
});
