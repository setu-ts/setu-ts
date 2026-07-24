import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

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

  it('renders both bodies, escaping only the html body', () => {
    const engine = new TemplateEngine({
      welcome: {
        html: '<h1>Hello {{ name }}</h1>',
        text: 'Hello {{ name }}',
      },
    });
    const out = engine.render('welcome', { name: 'A & B' });
    // The interpolated value is HTML-escaped in the html body ...
    expect(out.html).toBe('<h1>Hello A &amp; B</h1>');
    // ... and raw in the text body.
    expect(out.text).toBe('Hello A & B');
  });

  it('tolerates surrounding whitespace in a placeholder', () => {
    const engine = new TemplateEngine({ t: { text: 'v={{   value  }}' } });
    expect(engine.render('t', { value: 42 }).text).toBe('v=42');
  });

  it('returns only the bodies the template defines', () => {
    const engine = new TemplateEngine({ t: { text: 'only text' } });
    const out = engine.render('t', {});
    expect(out.text).toBe('only text');
    expect(out.html).toBeUndefined();
  });

  it('throws on an unknown template', () => {
    const engine = new TemplateEngine();
    expect(() => engine.render('nope', {})).toThrow('Unknown mail template: nope');
  });

  it('throws when a placeholder variable is absent from data', () => {
    const engine = new TemplateEngine({ t: { text: 'Hi {{ name }}' } });
    expect(() => engine.render('t', {})).toThrow(
      'Unknown template variable "name" in template "t"',
    );
  });

  it('accepts an explicit undefined value as present (in-operator semantics)', () => {
    const engine = new TemplateEngine({ t: { text: 'v={{ value }}' } });
    expect(engine.render('t', { value: undefined }).text).toBe('v=undefined');
  });
});
