import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlLinks } from '../src/lib/link-gate.ts';
import { rewriteHref } from '../src/lib/docs-links.ts';
import { EXAMPLE_FILES } from '../src/lib/repository.ts';

/** Checks the files actually emitted, after the TypeDoc graft. */
export async function checkBuiltLinks(dist) {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.html')) files.push(path);
    }
  };
  await walk(dist);
  const failures = [];
  for (const file of files) {
    for (const href of htmlLinks(await readFile(file, 'utf8'))) {
      if (/^https:\/\/github\.com\/setu-ts\/setu-ts\/(blob|tree)\/main\//.test(href)) {
        const rewritten = rewriteHref(href, '', EXAMPLE_FILES);
        if (rewritten.startsWith('/'))
          failures.push(`${file}: reading target left on GitHub: ${href}`);
      }
      const url = new URL(
        href.replaceAll('&amp;', '&'),
        `https://setu-ts.dev/${file.slice(dist.length + 1)}`,
      );
      if (url.origin !== 'https://setu-ts.dev') continue;
      const target = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
      try {
        const info = await stat(target);
        if (info.isDirectory()) await stat(resolve(target, 'index.html'));
      } catch {
        try {
          await stat(`${target.replace(/\/$/, '')}.html`);
        } catch {
          failures.push(`${file}: missing internal target ${href}`);
        }
      }
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return files.length;
}

if (import.meta.main) {
  await checkBuiltLinks(resolve(dirname(fileURLToPath(import.meta.url)), '../dist'));
}
