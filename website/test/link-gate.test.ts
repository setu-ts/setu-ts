import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkBuiltLinks } from '../scripts/check-links.mjs';
import { markdownLinks } from '../src/lib/link-gate.ts';
import { rewriteDocsHtml } from '../src/lib/docs-links.ts';

const scratch = resolve('../.tmp/site-link-gate');
afterEach(() => rm(scratch, { recursive: true, force: true }));
it('does not treat highlighted source text as a real link', () => {
  const code = '<code><span>href="</span><span style="color:red">text</span></code>';
  expect(rewriteDocsHtml(code, 'docs')).toBe(code);
});
it('rewrites single-quoted raw HTML reading links', () => {
  expect(rewriteDocsHtml("<a href='../CHANGELOG.md'>Changes</a>", 'docs')).toBe(
    "<a href='/changelog/'>Changes</a>",
  );
});
it('extracts links outside code fences, including reference definitions and HTML', () => {
  expect(
    markdownLinks(
      '[inline](./a.md)\n[ref]: ./b.md\n<a href="./c.md">c</a>\n<https://example.com>\n```md\n[code](./ignore.md)\n```',
    ),
  ).toEqual(['./a.md', './b.md', './c.md', 'https://example.com']);
});
it('strips fences by CommonMark rules: longer closers and indented fences', () => {
  expect(
    markdownLinks(
      [
        '```md',
        '[in-code](./x.md)',
        '````',
        '[between](./between.md)',
        '  ~~~',
        '  [indented-code](./y.md)',
        '  ~~~',
        '``` not`a`fence [inline](./z.md)',
      ].join('\n'),
    ),
  ).toEqual(['./between.md', './z.md']);
});
it('checks emitted routes and rejects missing routes and rendered reading left on GitHub', async () => {
  await mkdir(scratch, { recursive: true });
  const dist = await mkdtemp(`${scratch}/dist-`);
  await mkdir(`${dist}/packages/kernel`, { recursive: true });
  await writeFile(`${dist}/packages/kernel/index.html`, '<a href="/">Home</a>');
  await writeFile(
    `${dist}/index.html`,
    '<a href="/packages/kernel/?q=1#heading">Kernel</a><a href="https://example.com">Outside</a>',
  );
  expect(await checkBuiltLinks(dist)).toBe(2);
  await writeFile(`${dist}/index.html`, '<a href="/packages/missing/">Missing</a>');
  await expect(checkBuiltLinks(dist)).rejects.toThrow('missing internal target');
  await writeFile(`${dist}/index.html`, '<h2 id="here">Here</h2><a href="#here">ok</a>');
  expect(await checkBuiltLinks(dist)).toBe(2);
  await writeFile(`${dist}/index.html`, '<a href="#nowhere">Dead</a>');
  await expect(checkBuiltLinks(dist)).rejects.toThrow('missing in-page target #nowhere');
  await writeFile(
    `${dist}/index.html`,
    '<a href="https://github.com/setu-ts/setu-ts/blob/main/packages/kernel/README.md">Reading</a>',
  );
  await expect(checkBuiltLinks(dist)).rejects.toThrow('reading target left on GitHub');
  await writeFile(
    `${dist}/index.html`,
    '<a href="https://github.com/setu-ts/setu-ts/tree/main/apps/minimal/setu.config.ts">Example source</a>',
  );
  await expect(checkBuiltLinks(dist)).rejects.toThrow('reading target left on GitHub');
});
