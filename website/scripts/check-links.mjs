import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlLinks } from '../src/lib/link-gate.ts';
import { rewriteHref } from '../src/lib/docs-links.ts';
import { EXAMPLE_FILES } from '../src/lib/repository.ts';

/** Decodes a URL component, or `null` for a malformed `%` escape the gate should report. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

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
  /** Ids of an emitted page, read once per target. */
  const idsByFile = new Map();
  const idsOf = async (file) => {
    if (!idsByFile.has(file)) {
      const html = await readFile(file, 'utf8');
      idsByFile.set(
        file,
        new Set([...html.matchAll(/\sid=(["'])(.*?)\1/g)].map((match) => match[2])),
      );
    }
    return idsByFile.get(file);
  };
  for (const file of files) {
    const html = await readFile(file, 'utf8');
    // In-page fragments must name an element on the page. TypeDoc's generated pages are its own.
    if (!file.startsWith(resolve(dist, 'api'))) {
      const ids = new Set([...html.matchAll(/\sid=(["'])(.*?)\1/g)].map((match) => match[2]));
      for (const href of htmlLinks(html)) {
        if (href.startsWith('#') && href.length > 1 && !ids.has(safeDecode(href.slice(1))))
          failures.push(`${file}: missing in-page target ${href}`);
      }
    }
    for (const href of htmlLinks(html)) {
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
      const pathname = safeDecode(url.pathname);
      if (pathname === null) {
        failures.push(`${file}: malformed internal link ${href}`);
        continue;
      }
      const target = resolve(dist, `.${pathname}`);
      let targetFile = null;
      try {
        const info = await stat(target);
        if (info.isDirectory()) {
          targetFile = resolve(target, 'index.html');
          await stat(targetFile);
        } else if (target.endsWith('.html')) {
          targetFile = target;
        }
      } catch {
        try {
          targetFile = `${target.replace(/\/$/, '')}.html`;
          await stat(targetFile);
        } catch {
          failures.push(`${file}: missing internal target ${href}`);
          continue;
        }
      }
      // A cross-page fragment must name an id on the page it points at, not just
      // an existing file. TypeDoc's generated pages carry their own ids, and a
      // same-page fragment is checked above.
      if (
        targetFile !== null &&
        url.hash.length > 1 &&
        !href.startsWith('#') &&
        !url.pathname.startsWith('/api/')
      ) {
        const id = safeDecode(url.hash.slice(1));
        if (id === null || !(await idsOf(targetFile)).has(id)) {
          failures.push(`${file}: missing cross-page fragment ${href}`);
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
