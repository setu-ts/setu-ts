/* eslint-disable no-console -- the filesystem seam reports the generated placeholder set. */
/** Writes the pure generator output, without publishing. @module */

import { rm, mkdir, writeFile } from 'node:fs/promises';
import { isNotFound } from './lib/run.ts';
import { placeholderFiles } from './npm-placeholders.ts';
async function main(): Promise<void> {
  const root = '.tmp/npm-placeholders';
  const files = placeholderFiles();
  // Fresh output cannot accidentally retain code from an earlier generation.
  try {
    await rm(root, { recursive: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  for (const [path, content] of files) {
    await mkdir(`${root}/${path.split('/')[0]}`, { recursive: true });
    await writeFile(`${root}/${path}`, content);
  }
  console.log(
    `Generated ${files.size / 2} README-only placeholders in ${root}; nothing published.`,
  );
}
if (import.meta.main) await main();
