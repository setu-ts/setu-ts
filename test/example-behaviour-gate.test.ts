/**
 * The executable behaviour gate for documented view components.
 *
 * Its own controls, because a gate that has never been observed failing is not
 * a gate. The first cut of this one PASSED against a reintroduction of the
 * exact `v0.6.0` defect — it deduplicated component names per document, so the
 * second definition in a README (the class-based one, which is where the
 * defect lived) was skipped. That case is pinned below.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  attachedComment,
  type BlindSpot,
  blindSpotFindings,
  buildProbe,
  collectComponents,
  collectUnrenderedBlindSpots,
  compare,
  type DocComponent,
  extractDefinition,
  hasSchemeInUrlAttribute,
  HOSTILE,
  parseProbe,
  renderedComponentNames,
  run,
  scanDocuments,
  skipComment,
  topLevelConsts,
  UNCHECKED_EXEMPT_MARKERS,
  URL_PAYLOAD,
} from '../scripts/check-example-behaviour.ts';

const JSX =
  '(props: { readonly users: readonly string[] }) => (\n  <ul>{props.users.map((u) => <li>{u}</li>)}</ul>\n)';
const PLAIN = '(props: { readonly name: string }) => `<p>${props.name}</p>`';

/** A document that reaches for view rendering, which is what puts it in scope. */
function doc(body: string): string {
  return `# Views\n\n\`\`\`tsx\nimport { renderView } from '@setu-ts/view-plugin';\n${body}\n\`\`\`\n`;
}

describe('hasSchemeInUrlAttribute — the scheme must be in an ATTRIBUTE (#333)', () => {
  // The first version ran one regex over the whole render, so body text reading
  // `href=javascript:alert(1)` matched although no attribute existed — a false
  // positive on a document that is merely DESCRIBING the hazard, which
  // `docs/mvc.md` does.
  const found: readonly string[] = [
    '<a href="javascript:alert(1)">x</a>',
    "<a href='javascript:alert(1)'>x</a>",
    '<a href=javascript:alert(1)>x</a>',
    '<img src="javascript:alert(1)"/>',
    '<form action="javascript:alert(1)"></form>',
    '<svg><use xlink:href="javascript:alert(1)"/></svg>',
    '<a href="  javascript:alert(1)">x</a>',
    '<a data-note="x>y" href="javascript:alert(1)">x</a>',
  ];
  for (const html of found) {
    it(`reports ${html}`, () => {
      expect(hasSchemeInUrlAttribute(html)).toBe(true);
    });
  }

  const ignored: readonly string[] = [
    '<code>href=javascript:alert(1)</code>',
    '<p>see href=javascript:alert(1) for the hazard</p>',
    '<a href="/safe">javascript:alert(1)</a>',
    '<a title="javascript:alert(1)" href="/safe">x</a>',
  ];
  for (const html of ignored) {
    it(`ignores ${html}`, () => {
      expect(hasSchemeInUrlAttribute(html)).toBe(false);
    });
  }

  // The suffix match's consequences, as DATA rather than as a sentence in the
  // JSDoc that can drift from it. Every row errs toward reporting.
  it('matches an attribute name by suffix, with the costs that buys', () => {
    // Worth having: formaction really does navigate.
    expect(hasSchemeInUrlAttribute('<button formaction="javascript:alert(1)">x</button>'))
      .toBe(true);
    // The cost: inert names ending the same way, and a tag inside a comment.
    for (
      const inert of [
        '<a data-action="javascript:alert(1)">x</a>',
        '<a data-href="javascript:alert(1)">x</a>',
        '<a myhref="javascript:alert(1)">x</a>',
        '<!-- <a href="javascript:alert(1)"> -->',
      ]
    ) {
      expect(hasSchemeInUrlAttribute(inert)).toBe(true);
    }
    // But the name must be followed by `=`, so `srcset` is not `src`.
    expect(hasSchemeInUrlAttribute('<img srcset="javascript:alert(1)">')).toBe(false);
  });
});

describe('renderedComponentNames', () => {
  it('reads a component from @Render and from renderView', () => {
    expect(renderedComponentNames('@Render(UserList)\n')).toEqual(['UserList']);
    expect(renderedComponentNames('renderView(ctx, Profile, {})')).toEqual(['Profile']);
  });

  it('ignores a lowercase identifier, which is never a component', () => {
    expect(renderedComponentNames('renderView(ctx, helper, {})')).toEqual([]);
  });

  it('deduplicates a component rendered twice', () => {
    expect(renderedComponentNames('@Render(A)\n@Render(A)')).toEqual(['A']);
  });
});

describe('extractDefinition', () => {
  it('lifts an arrow function ending at a top-level semicolon', () => {
    const code = `const A = ${PLAIN};\nconst B = 1;`;
    expect(extractDefinition(code, 'A')).toBe(`const A = ${PLAIN};`);
  });

  it('is not confused by a semicolon inside a template literal or nested call', () => {
    const code = 'const A = (p) => html`<p>a;b</p>`;\nconst B = 2;';
    expect(extractDefinition(code, 'A')).toBe('const A = (p) => html`<p>a;b</p>`;');
  });

  it('returns null for a name the fence does not define', () => {
    expect(extractDefinition('const A = 1;', 'B')).toBeNull();
  });

  it('returns null when the statement never terminates', () => {
    expect(extractDefinition('const A = (p) => (', 'A')).toBeNull();
  });
});

describe('attachedComment', () => {
  it('takes the contiguous comment block directly above', () => {
    expect(attachedComment('// one\n// two\nconst A =')).toBe('// one\n// two');
  });

  it('stops at the first non-comment line, so a label cannot leak downward', () => {
    // Two components a line apart: the first one's `// UNSAFE:` must not reach
    // the second. A fixed window of preceding lines let it, and marked a safe
    // example as a counter-example.
    expect(attachedComment('// UNSAFE\nconst Bad = 1;\nconst Good =')).toBe('');
  });

  it('returns empty when nothing precedes the definition', () => {
    expect(attachedComment('const A =')).toBe('');
  });

  it('reads a JSDoc block', () => {
    expect(attachedComment('/**\n * DO NOT USE\n */\nconst A =')).toContain('DO NOT USE');
  });
});

describe('skipComment — the scanners must not enter quote state inside a comment', () => {
  it('skips a line comment, backticks and all', () => {
    // `decorator-plugin`'s README carries exactly this shape. Without the
    // skip, the walker enters quote state on the comment's backtick, never
    // leaves, and the document silently drops out of coverage.
    const code = '// `(props) => `<li>${u}</li>`` \nconst A = 1;';
    expect(skipComment(code, 0)).toBe(code.indexOf('\n'));
  });

  it('skips a block comment', () => {
    expect(skipComment('/* a ` b */x', 0)).toBe(11);
  });

  it('leaves a non-comment offset alone', () => {
    expect(skipComment('const A = 1;', 0)).toBe(0);
  });

  it('runs to the end when a comment is unterminated', () => {
    expect(skipComment('/* never closed', 0)).toBe(15);
    expect(skipComment('// to the end', 0)).toBe(13);
  });

  it('finds a declaration AFTER a backtick-carrying comment', () => {
    const fence = '// see `<li>${u}</li>`\nconst Widget = (p) => <ul>{p.x}</ul>;';
    expect(topLevelConsts(fence).map((c) => c.name)).toEqual(['Widget']);
  });
});

describe('topLevelConsts', () => {
  it('ignores a declaration nested inside a function body', () => {
    // A handler's locals are not component scaffolding: lifting one produced
    // a ReferenceError for a helper that exists only inside the handler.
    const fence = 'const A = 1;\nasync function h(ctx) {\n  const form = await readForm(ctx);\n}';
    // `h` is itself top-level and belongs; the handler's `form` does not.
    expect(topLevelConsts(fence).map((c) => c.name)).toEqual(['A', 'h']);
  });
});

describe('declaration forms — a component is not always `const X = …`', () => {
  it('finds a function declaration and its export form', () => {
    const fence =
      'function Widget(p) { return <ul>{p.x}</ul>; }\nexport function Other(p) { return <p>{p.y}</p>; }';
    expect(topLevelConsts(fence).map((c) => c.name)).toEqual(['Widget', 'Other']);
  });

  it('extracts a function declaration whole, to its closing brace', () => {
    const fence = 'function Widget(p) { return <ul>{p.x}</ul>; }\nconst after = 1;';
    expect(extractDefinition(fence, 'Widget')).toBe(
      'function Widget(p) { return <ul>{p.x}</ul>; }',
    );
  });

  it('finds an annotated const component', () => {
    const fence = 'const Widget: Component<P> = (p) => <ul>{p.x}</ul>;';
    expect(topLevelConsts(fence).map((c) => c.name)).toEqual(['Widget']);
  });

  it('collects a function-declared component a fence renders', () => {
    // A `@Render(UserList)` naming a function declaration used to be invisible
    // to this gate, so the component was never rendered.
    const markdown = doc(
      'function UserList(p: { u: string }) { return `<li>${p.u}</li>`; }\n@Render(UserList)',
    );
    const found = collectComponents('docs/x.md', markdown);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('UserList');
  });
});

describe('collectComponents', () => {
  it('collects a component a fence renders', () => {
    const found = collectComponents(
      'docs/x.md',
      doc(`const UserList = ${JSX};\n@Render(UserList)`),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('UserList');
    expect(found[0]?.expectUnsafe).toBe(false);
  });

  it('collects BOTH definitions when one document defines a name twice', () => {
    // The regression that matters: the first cut scoped `seen` to the
    // document, so the second definition — the class-based one, where the
    // v0.6.0 defect lived — was skipped and the gate passed.
    const markdown = `# Views

\`\`\`tsx
const UserList = ${JSX};
renderView(ctx, UserList, {});
\`\`\`

\`\`\`tsx
const UserList = ${PLAIN};
@Render(UserList)
\`\`\`
`;
    const found = collectComponents('docs/x.md', markdown);
    expect(found).toHaveLength(2);
    expect(found.map((c) => c.source.includes('html') || c.source.includes('<ul>')))
      .toEqual([true, false]);
  });

  it('reads the counter-example label from the component own comment', () => {
    const markdown = doc(
      `// UNSAFE: interpolated raw.\nconst Bad = ${PLAIN};\nconst Good = ${JSX};`,
    );
    const found = collectComponents('docs/x.md', markdown);
    expect(found.find((c) => c.name === 'Bad')?.expectUnsafe).toBe(true);
    expect(found.find((c) => c.name === 'Good')?.expectUnsafe).toBe(false);
  });

  it('ignores a document that does not render views at all', () => {
    expect(collectComponents('docs/x.md', '```tsx\nconst A = () => <p>hi</p>;\n```\n')).toEqual([]);
  });

  it('ignores a generic call, which is not markup', () => {
    // `Custom<string>(…)` matched a looser pattern and sent a parameter
    // decorator through the renderer, where it threw.
    const markdown = doc("const CurrentTenant = () => Custom<string>('current-tenant');");
    expect(collectComponents('docs/x.md', markdown)).toEqual([]);
  });

  it('flags a component that opts out through raw()', () => {
    const markdown = doc(
      'const Snippet = (p) => html`<div>${raw(p.markup)}</div>`;\n@Render(Snippet)',
    );
    expect(collectComponents('docs/x.md', markdown)[0]?.usesRaw).toBe(true);
  });
});

describe('buildProbe', () => {
  const component = (over: Partial<DocComponent> = {}): DocComponent => ({
    file: 'docs/x.md',
    line: 1,
    name: 'A',
    source: `const A = ${PLAIN};`,
    expectUnsafe: false,
    usesRaw: false,
    spreads: false,
    exempt: false,
    dependencies: [],
    ...over,
  });

  it('emits the extracted source VERBATIM, since that is what is under test', () => {
    expect(buildProbe([component()])).toContain(`const A = ${PLAIN};`);
  });

  it('block-scopes each component so a repeated name does not collide', () => {
    const probe = buildProbe([component(), component()]);
    // Two declarations of `const A` at module scope would be a SyntaxError and
    // the whole probe would report nothing.
    expect(probe.split('const A =')).toHaveLength(3);
    expect(probe.split('\n{\n')).toHaveLength(3);
  });

  it('carries the hostile payload', () => {
    expect(buildProbe([component()])).toContain(JSON.stringify(HOSTILE));
  });

  it('carries both payloads and sweeps the delivery modes (#333)', () => {
    const probe = buildProbe([component()]);
    expect(probe).toContain(JSON.stringify(URL_PAYLOAD));
    expect(probe).toContain(JSON.stringify(HOSTILE));
    // Every mode delivers a real STRING where the component reads, because hono
    // escapes an attribute value only when it is one; a Proxy there renders
    // unescaped and reported a SAFE component as a defect.
    expect(probe).toContain('renderComponent(A as never, deliver(HOSTILE))');
    expect(probe).toContain('renderComponent(A as never, deliver(URL_PAYLOAD))');
    expect(probe).toContain('for (const deliver of DELIVERIES)');
    // The probe REPORTS what it rendered; the scheme verdict is decided in the
    // parent, because importing the scanner into the subprocess removed this
    // file from coverage entirely.
    expect(probe).toContain('urlRenders.push(');
    expect(probe).not.toContain("from '../../scripts/check-example-behaviour.ts'");
    // The unbounded proxy survives as a REACH probe only, never judged for
    // escaping.
    expect(probe).toContain('const reach = await renderComponent(A as never, props)');
  });
});

describe('parseProbe', () => {
  it('refuses a short batch rather than checking fewer than it collected', () => {
    expect(parseProbe('{"index":0,"ok":true,"escaped":true}', 2)).toBeNull();
  });

  it('refuses malformed output', () => {
    expect(parseProbe('not json', 1)).toBeNull();
    expect(parseProbe('{"nope":1}', 1)).toBeNull();
  });

  it('refuses a record missing the field its branch requires', () => {
    // `{"ok":true}` used to be accepted, and its missing `escaped` reached
    // `compare` as undefined — falsy, which a counter-example reads as "still
    // unsafe". A malformed batch could therefore PASS.
    expect(parseProbe('{"index":0,"ok":true}', 1)).toBeNull();
    expect(parseProbe('{"index":0,"ok":false}', 1)).toBeNull();
    expect(parseProbe('{"index":0,"ok":"yes","escaped":true}', 1)).toBeNull();
    expect(parseProbe('{"index":0,"ok":true,"escaped":"no","urlRenders":[]}', 1)).toBeNull();
    expect(parseProbe('{"index":0,"ok":false,"error":7}', 1)).toBeNull();
    // The URL verdict is part of the record: an `ok` line without it is a
    // component the URL payload never reached, which must fail the batch.
    expect(parseProbe('{"index":0,"ok":true,"escaped":true}', 1)).toBeNull();
  });

  it('refuses results that arrive out of order or duplicated', () => {
    const a =
      '{"index":0,"ok":true,"escaped":true,"urlRenders":[],"delivered":true,"reached":true}';
    const b =
      '{"index":1,"ok":true,"escaped":true,"urlRenders":[],"delivered":true,"reached":true}';
    expect(parseProbe(`${b}\n${a}`, 2)).toBeNull();
    expect(parseProbe(`${a}\n${a}`, 2)).toBeNull();
    expect(parseProbe(`${a}\n${b}`, 2)).toHaveLength(2);
  });

  it('derives the scheme verdict from the reported renders (#333)', () => {
    // The probe reports what it rendered; the scanner runs HERE. Importing it
    // into the subprocess instead removed this file from coverage entirely,
    // which the script-coverage completeness check caught.
    const hit = parseProbe(
      JSON.stringify({
        index: 0,
        ok: true,
        escaped: true,
        urlRenders: ['<a href="javascript:alert(1)">x</a>'],
        delivered: true,
        reached: true,
      }),
      1,
    );
    expect(hit?.[0]).toMatchObject({ scheme: true });

    const miss = parseProbe(
      JSON.stringify({
        index: 0,
        ok: true,
        escaped: true,
        urlRenders: ['<code>href=javascript:alert(1)</code>'],
        delivered: true,
        reached: true,
      }),
      1,
    );
    expect(miss?.[0]).toMatchObject({ scheme: false });
  });

  it('refuses a batch whose renders are not strings', () => {
    expect(parseProbe('{"index":0,"ok":true,"escaped":true,"urlRenders":[7]}', 1)).toBeNull();
    expect(parseProbe('{"index":0,"ok":true,"escaped":true,"urlRenders":"x"}', 1)).toBeNull();
  });

  it('accepts a complete batch', () => {
    expect(
      parseProbe(
        '{"index":0,"ok":true,"escaped":true,"urlRenders":[],"delivered":true,"reached":true}',
        1,
      ),
    )
      .toEqual([{
        index: 0,
        ok: true,
        escaped: true,
        scheme: false,
        delivered: true,
        reached: true,
      }]);
  });

  it('treats empty output as a batch of none', () => {
    expect(parseProbe('', 0)).toEqual([]);
    expect(parseProbe('', 1)).toBeNull();
  });
});

describe('compare', () => {
  const base: DocComponent = {
    file: 'docs/x.md',
    line: 7,
    name: 'A',
    source: 'const A = …;',
    expectUnsafe: false,
    usesRaw: false,
    spreads: false,
    exempt: false,
    dependencies: [],
  };

  it('passes a safe component', () => {
    expect(
      compare([base], [{
        index: 0,
        ok: true,
        escaped: true,
        scheme: false,
        delivered: true,
        reached: true,
      }]),
    ).toEqual([]);
  });

  it('fails an unlabelled component that does not escape', () => {
    const [finding] = compare([base], [{
      index: 0,
      ok: true,
      escaped: false,
      scheme: false,
      delivered: true,
      reached: true,
    }]);
    expect(finding?.message).toContain('UNESCAPED');
    expect(finding?.line).toBe(7);
  });

  it('fails a labelled counter-example that HAS started escaping', () => {
    const labelled = { ...base, expectUnsafe: true };
    const [finding] = compare([labelled], [{
      index: 0,
      ok: true,
      escaped: true,
      scheme: false,
      delivered: true,
      reached: true,
    }]);
    expect(finding?.message).toContain('no longer unsafe');
  });

  it('passes a labelled counter-example that is still unsafe', () => {
    const labelled = { ...base, expectUnsafe: true };
    expect(
      compare([labelled], [{
        index: 0,
        ok: true,
        escaped: false,
        scheme: false,
        delivered: true,
        reached: true,
      }]),
    )
      .toEqual([]);
  });

  it('reports a render failure rather than reading it as a pass', () => {
    const [finding] = compare([base], [{ index: 0, ok: false, error: 'boom' }]);
    expect(finding?.message).toContain('boom');
  });

  it('reports a missing result rather than reading it as a pass', () => {
    expect(compare([base], [])[0]?.message).toContain('no result');
  });

  it('fails a component that carries the scheme into a URL attribute', () => {
    const [finding] = compare([base], [{
      index: 0,
      ok: true,
      escaped: true,
      scheme: true,
      delivered: true,
      reached: true,
    }]);
    expect(finding?.message).toContain(JSON.stringify(URL_PAYLOAD));
    expect(finding?.message).toContain('href, src or action');
  });

  it('does not ask a labelled counter-example to demonstrate the URL hazard', () => {
    // The label owns the ESCAPE direction; the URL verdict is not reversed
    // for it, so a warning about template literals is not failed for
    // lacking a javascript: link.
    const labelled = { ...base, expectUnsafe: true };
    expect(
      compare([labelled], [{
        index: 0,
        ok: true,
        escaped: false,
        scheme: true,
        delivered: true,
        reached: true,
      }]),
    )
      .toEqual([]);
  });

  it('reports UNCHECKED for a component whose source routes through raw()', () => {
    const rawUser = { ...base, usesRaw: true };
    const findings = compare([rawUser], [{
      index: 0,
      ok: true,
      escaped: true,
      scheme: false,
      delivered: true,
      reached: true,
    }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('UNCHECKED');
    expect(findings[0]?.message).toContain('`raw()`');
    expect(findings[0]?.message).toContain(UNCHECKED_EXEMPT_MARKERS[0]);
  });

  it('reports UNCHECKED when no delivery mode reached the component (#333)', () => {
    // The mode sweep delivers a real STRING at a bounded set of prop shapes, so
    // escaping is judged on the value type production renders. A component
    // reading past all of them would have every payload resolve to `undefined`,
    // render nothing, and score ESCAPED — a false PASS. The unbounded reach
    // proxy answers a read at any depth, so the two disagreeing IS that case.
    const [finding] = compare([base], [{
      index: 0,
      ok: true,
      escaped: true,
      scheme: false,
      delivered: false,
      reached: true,
    }]);
    expect(finding?.message).toContain('UNCHECKED');
    expect(finding?.message).toContain('no delivery mode reaches');
  });

  it('does not report a component that simply never touches its props', () => {
    // Neither probe delivered, so there is nothing to judge and nothing to warn
    // about — a static component is not a blind spot.
    expect(compare([base], [{
      index: 0,
      ok: true,
      escaped: true,
      scheme: false,
      delivered: false,
      reached: false,
    }])).toEqual([]);
  });

  it('reports UNCHECKED for an element spread', () => {
    const spreader = { ...base, spreads: true };
    const [finding] = compare([spreader], [{
      index: 0,
      ok: true,
      escaped: true,
      scheme: false,
      delivered: true,
      reached: true,
    }]);
    expect(finding?.message).toContain('element spread');
  });

  it('passes an exempted raw() component, which is the only way past UNCHECKED', () => {
    const exempted = { ...base, usesRaw: true, exempt: true };
    expect(compare([exempted], [{
      index: 0,
      ok: true,
      escaped: true,
      scheme: false,
      delivered: true,
      reached: true,
    }])).toEqual([]);
  });

  it('can emit the UNCHECKED and UNESCAPED verdicts together', () => {
    const rawAndUnsafe = { ...base, usesRaw: true };
    const findings = compare([rawAndUnsafe], [{
      index: 0,
      ok: true,
      escaped: false,
      scheme: false,
      delivered: true,
      reached: true,
    }]);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.message).toContain('UNCHECKED');
    expect(findings[1]?.message).toContain('UNESCAPED');
  });
});

describe('the gate covers the repository it is meant to cover', () => {
  it('finds the documents that actually carry view components', async () => {
    // Non-vacuity: the gate reporting a clean pass while collecting nothing
    // is the failure this suite exists to prevent, so the corpus is pinned.
    const documents = await scanDocuments(['docs', 'packages', '.']);
    const collected: DocComponent[] = [];
    for (const file of documents) {
      collected.push(...collectComponents(file, await Deno.readTextFile(file)));
    }
    const files = [...new Set(collected.map((c) => c.file))].sort();

    expect(files).toContain('docs/mvc.md');
    expect(files).toContain('docs/migration-nestjs.md');
    expect(files).toContain('docs/upgrading.md');
    expect(files).toContain('packages/view-plugin/README.md');
    expect(files).toContain('packages/decorator-plugin/README.md');

    // Both directions are exercised against the real corpus.
    expect(collected.some((c) => c.expectUnsafe)).toBe(true);
    expect(collected.some((c) => !c.expectUnsafe)).toBe(true);

    // And the view-plugin README's SECOND definition is present, which is the
    // one the original defect lived in.
    expect(collected.filter((c) => c.file === 'packages/view-plugin/README.md').length)
      .toBeGreaterThan(1);
  });

  it('leaves no component in the corpus unchecked', async () => {
    // The probe stubs raw() and cannot deliver a payload through an element
    // spread, so a component using either is UNCHECKED — failing the gate
    // unless its own comment carries the exemption. Every such component in
    // the corpus must be exempt, and the three known sites are pinned by
    // name, so dropping a label is a failing test rather than a silent gap.
    const documents = await scanDocuments(['docs', 'packages', '.']);
    const collected: DocComponent[] = [];
    const spots: BlindSpot[] = [];
    for (const file of documents) {
      const markdown = await Deno.readTextFile(file);
      collected.push(...collectComponents(file, markdown));
      spots.push(...collectUnrenderedBlindSpots(file, markdown));
    }
    const rawComponents = collected
      .filter((c) => c.usesRaw || c.spreads)
      .map((c) => `${c.file} ${c.name}${c.exempt ? '' : ' UNEXEMPTED'}`)
      .sort();
    expect(rawComponents).toEqual([
      'docs/mvc.md Page',
      'packages/view-plugin/README.md Snippet',
    ]);
    expect(spots.map((s) => `${s.file} ${s.name}${s.exempt ? '' : ' UNEXEMPTED'}`))
      .toEqual(['packages/session-plugin/README.md LoginForm']);
    expect(blindSpotFindings(spots)).toEqual([]);
  });
});

describe('run — end to end, through the real renderer', () => {
  const dir = '.tmp/example-behaviour-fixtures';

  async function write(name: string, body: string): Promise<string> {
    await Deno.mkdir(dir, { recursive: true });
    const path = `${dir}/${name}`;
    await Deno.writeTextFile(path, doc(body));
    return path;
  }

  it('passes a JSX component, which the rendering runtime escapes', async () => {
    const path = await write('safe.md', `const Safe = ${JSX};\n@Render(Safe)`);
    expect(await run([path])).toEqual([]);
  });

  it('FAILS a plain template literal, which escapes nothing', async () => {
    // The v0.6.0 defect, reduced. It type-checks, and every other gate in this
    // repository passes it.
    const path = await write('unsafe.md', `const Bad = ${PLAIN};\n@Render(Bad)`);
    const findings = await run([path]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('UNESCAPED');
  });

  it('passes a labelled counter-example precisely because it is unsafe', async () => {
    const path = await write(
      'labelled.md',
      `// UNSAFE: interpolated raw.\nconst Bad = ${PLAIN};\n@Render(Bad)`,
    );
    expect(await run([path])).toEqual([]);
  });

  it('FAILS an unlabelled raw() component as UNCHECKED, and passes it labelled', async () => {
    // The old behaviour — a silent pass — is the defect finding 9 describes:
    // the raw() stub hides the prop's data path, so a clean render means
    // nothing. The blind spot must be loud, and the exemption label the only
    // way past it.
    const raw =
      'const Snippet = (p: { m: string }) => html`<div>${raw(p.m)}</div>`;\n@Render(Snippet)';
    const failing = await write('raw-unlabelled.md', raw);
    const findings = await run([failing]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('UNCHECKED');
    expect(findings[0]?.message).toContain(UNCHECKED_EXEMPT_MARKERS[0]);
    const exemptPath = await write(
      'raw-labelled.md',
      `// ${UNCHECKED_EXEMPT_MARKERS[0]}: documents the opt-out itself.\n${raw}`,
    );
    expect(await run([exemptPath])).toEqual([]);
  });

  it('refuses a bare marker and an incidental mention as exemptions', async () => {
    // The exemption is the ONLY way past an unchecked verdict, so what counts
    // as one is a security decision. `includes(marker)` accepted the marker
    // with no reason, and accepted prose that merely names it — a comment
    // reading "never write UNCHECKED-EXEMPT here" exempted the component below
    // it. That suppresses the finding, which is the dangerous direction.
    const raw =
      'const Snippet = (p: { m: string }) => html`<div>${raw(p.m)}</div>`;\n@Render(Snippet)';
    const bare = await write(
      'raw-bare-marker.md',
      `// ${UNCHECKED_EXEMPT_MARKERS[0]}\n${raw}`,
    );
    expect(await run([bare])).toHaveLength(1);
    const mention = await write(
      'raw-mention.md',
      `// never write ${UNCHECKED_EXEMPT_MARKERS[0]} here\n${raw}`,
    );
    expect(await run([mention])).toHaveLength(1);
    // Carrying the colon AND a reason is still a mention, which requiring the
    // documented form alone does not catch — the marker has to OPEN its comment
    // line. Caught by a second review pass on the first version of this fix.
    const withColon = await write(
      'raw-mention-colon.md',
      `// Never write ${UNCHECKED_EXEMPT_MARKERS[0]}: without review\n${raw}`,
    );
    expect(await run([withColon])).toHaveLength(1);
    // And a JSDoc line legitimately opens with `*`, so that form must still exempt.
    const jsdoc = await write(
      'raw-jsdoc-exempt.md',
      `/**\n * ${UNCHECKED_EXEMPT_MARKERS[0]}: documents the opt-out itself.\n */\n${raw}`,
    );
    expect(await run([jsdoc])).toEqual([]);
    const blank = await write(
      'raw-blank-reason.md',
      `// ${UNCHECKED_EXEMPT_MARKERS[0]}:   \n${raw}`,
    );
    expect(await run([blank])).toHaveLength(1);
  });

  it('reports nothing for a safe component whose payload IS delivered (#333)', async () => {
    // This is what pins `escapeHtml` against hono's real escaping, and it does
    // it through the consequence rather than by reimplementing the escaper. The
    // probe decides a payload was DELIVERED by finding it raw or in that
    // escaped form; if the two disagreed, `delivered` would read false here,
    // the reach guard would fire, and this component would be reported
    // UNCHECKED although it is both safe and reached.
    const safe = 'const Attr = (p: { t: string }) => <span title={p.t}>x</span>;\n@Render(Attr)';
    expect(await run([await write('safe-attr.md', safe)])).toEqual([]);
  });

  it('FAILS a component that renders a prop into href', async () => {
    // The X46-1 shape, through the real renderer: escaping cannot stop a
    // metacharacter-free scheme, so the rendered href keeps it verbatim.
    const path = await write(
      'href.md',
      'const Link = (p: { url: string }) => <a href={p.url}>open</a>;\n@Render(Link)',
    );
    const findings = await run([path]);
    // The HOSTILE verdict fires too — hono's JSX leaves `<` unescaped in
    // attribute position — so the scheme verdict is asserted by name rather
    // than by count.
    const scheme = findings.find((f) => f.message.includes('href, src or action'));
    expect(scheme?.message).toContain(JSON.stringify(URL_PAYLOAD));
    expect(scheme?.file).toBe(path);
  });

  it('passes the URL payload landing in a text child', async () => {
    // A scheme outside a URL attribute is inert in a browser — the verdict
    // is decided on the output's ATTRIBUTE positions, not on substring luck.
    const path = await write(
      'text-child.md',
      'const Text = (p: { url: string }) => <p>{p.url}</p>;\n@Render(Text)',
    );
    expect(await run([path])).toEqual([]);
  });

  it('reports a ctx-taking helper that routes a value through raw()', async () => {
    // Such a helper is never rendered by the probe — exclusion by signature
    // is right for rendering and wrong for coverage — so the blind-spot
    // sweep reports it instead of letting it pass unseen.
    const path = await write(
      'helper.md',
      `const Widget = (p: { x: string }) => <p>{p.x}</p>;\nrenderView(ctx, Widget, {});\n` +
        'const Helper = (ctx: IRequestContext) => html`<div>${raw(ctx.token)}</div>`;',
    );
    const findings = await run([path]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('Helper');
    expect(findings[0]?.message).toContain('UNCHECKED');
  });

  it('propagates an I/O failure rather than omitting a directory', async () => {
    // Only a missing root is tolerable. Anything else would silently drop a
    // directory's documents and let the gate pass with partial coverage.
    await expect(scanDocuments(['deno.json'])).rejects.toThrow();
  });

  it('reports a document it cannot read', async () => {
    const findings = await run([`${dir}/absent.md`]);
    expect(findings[0]?.message).toContain('could not be read');
  });

  it('reports a component that throws while rendering', async () => {
    const path = await write(
      'throws.md',
      'const Broken = (p: { n: string }) => html`<p>${noSuchHelper(p.n)}</p>`;\n@Render(Broken)',
    );
    const findings = await run([path]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('could not be rendered');
  });

  it('fails closed when the probe cannot run at all', async () => {
    // A short batch must fail rather than silently verify fewer components
    // than were collected. Reached here by a definition that extracts cleanly
    // and does not PARSE, so the probe module dies before printing anything.
    const path = await write(
      'unparseable.md',
      'const Broken = (p: ) => <p>x</p>;\n@Render(Broken)',
    );
    const findings = await run([path]);
    expect(findings).toHaveLength(1);
    // Either guard may catch it first — the non-zero exit or the short batch.
    // What must not happen is a pass.
    expect(findings[0]?.message).toMatch(/exited non-zero|did not report/);
  });

  it('reports a probe that outruns its budget', async () => {
    const path = await write('slow.md', `const Safe = ${JSX};\n@Render(Safe)`);
    const findings = await run([path], { timeoutMs: 1 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('timed out');
  });

  it('returns nothing when a document carries no components', async () => {
    const path = await write('empty.md', 'const x = renderView;');
    expect(await run([path])).toEqual([]);
  });
});

describe('scanDocuments', () => {
  it('finds Markdown under a root and skips ignored directories', async () => {
    const found = await scanDocuments(['docs']);
    expect(found).toContain('docs/mvc.md');
    expect(found.every((f) => f.endsWith('.md'))).toBe(true);
  });

  it('tolerates a root that does not exist', async () => {
    expect(await scanDocuments(['no-such-root-here'])).toEqual([]);
  });
});
