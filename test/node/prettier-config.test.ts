// The repository's Prettier config must never rewrite the contents of a template literal (M111e1):
// embedded formatting of an `html` tagged template changes what a component renders, and
// `prettier --debug-check` does not compare template contents, so only a test like this sees it.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const root = fileURLToPath(new URL('../../', import.meta.url));
const TEMPLATE =
  'const List = () =>\n  html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`;\n';

async function format(source: string, file: string): Promise<string> {
  const options = await prettier.resolveConfig(`${root}${file}`, { editorconfig: false });
  return prettier.format(source, { ...options, filepath: `${root}${file}` });
}

describe('Prettier configuration', () => {
  it('leaves a tagged template in a code file untouched', async () => {
    expect(await format(TEMPLATE, 'packages/sample/src/view.ts')).toContain(
      'html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`',
    );
  });

  it('leaves a tagged template in a Markdown code fence untouched', async () => {
    const markdown = `# Sample\n\n\`\`\`ts\n${TEMPLATE}\`\`\`\n`;
    expect(await format(markdown, 'docs/sample.md')).toContain(
      'html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`',
    );
  });
});
