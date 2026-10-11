// deno-lint-ignore-file no-console -- the filesystem seam reports the generated placeholder set.
/** Writes the pure generator output, without publishing. @module */
import { placeholderFiles } from './npm-placeholders.ts';
const root = '.tmp/npm-placeholders';
const files = placeholderFiles();
// Fresh output cannot accidentally retain code from an earlier generation.
try {
  await Deno.remove(root, { recursive: true });
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
for (const [path, content] of files) {
  await Deno.mkdir(`${root}/${path.split('/')[0]}`, { recursive: true });
  await Deno.writeTextFile(`${root}/${path}`, content);
}
console.log(`Generated ${files.size / 2} README-only placeholders in ${root}; nothing published.`);
