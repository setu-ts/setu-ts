import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PUBLISHED_PACKAGES } from '../../../scripts/release-packages.ts';

/** Repository inputs are read in place; only Astro's output/cache receives rendered content. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Reads a canonical repository file. */
export function readSource(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

const { stdout } = await promisify(execFile)('git', ['ls-files', '-z'], { cwd: REPO_ROOT });
/** Tracked paths exclude installed dependencies and generated output. */
export const TRACKED_FILES = stdout.split('\0').filter(Boolean);

/** Package metadata from the release allowlist and each package's own manifest. */
export const PACKAGES = PUBLISHED_PACKAGES.map((directory) => {
  const manifest = JSON.parse(readSource(`${directory}/package.json`)) as {
    name: string;
    description: string;
  };
  return {
    directory,
    slug: directory.split('/').at(-1)!,
    ...manifest,
    card: TRACKED_FILES.includes(`${directory}/AGENT_CARD.md`),
    group: directory.includes('/starters/')
      ? 'Starters'
      : directory.endsWith('-plugin')
        ? 'Plugins'
        : ['cli', 'create', 'sdk', 'testing'].includes(directory.split('/').at(-1)!)
          ? 'Tools'
          : 'Core',
  };
});

/** The canonical app READMEs determine the example routes. */
export const APPS = TRACKED_FILES.filter((file) => /^apps\/[^/]+\/README\.md$/.test(file)).map(
  (file) => file.split('/')[1],
);

/** Expands the guide's ordered reading list, sorting tracked files within directory entries. */
export function exampleFiles(guide: string, app: string, tracked: readonly string[]): string[] {
  const section = guide.split(`### ${app}\n`)[1]?.split(/\n#{2,3} /)[0] ?? '';
  const reading = section.split('**Read, in order:**')[1]?.split('\n---')[0] ?? '';
  const prefix = `apps/${app}/`;
  const paths = [...reading.matchAll(/\]\(\.\.\/(apps\/[^)#]+)\)/g)].flatMap((match) => {
    const target = match[1].replace(/\/$/, '');
    if (!target.startsWith(prefix)) return [];
    return tracked.filter((file) => file === target || file.startsWith(`${target}/`)).sort();
  });
  if (tracked.includes(`${prefix}smoke.ts`)) paths.push(`${prefix}smoke.ts`);
  return [...new Set(paths)].map((file) => file.slice(prefix.length));
}

/** Files displayed below each example README, consumed by routes and link rewriting. */
export const EXAMPLE_FILES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  APPS.map((app) => [app, exampleFiles(readSource('docs/examples.md'), app, TRACKED_FILES)]),
);

/** Keeps every level-two PUBLIC_API section naming the exact package, including shared headings. */
export function publicApiSections(markdown: string, packageName: string): string {
  const rendered = markdown.includes('<h2');
  return markdown
    .split(rendered ? /(?=<h2\b)/ : /(?=^## )/m)
    .filter((section) => {
      const heading = rendered ? section.split('</h2>')[0] : section.split('\n')[0];
      return (
        (rendered ? heading.startsWith('<h2') : heading.startsWith('## ')) &&
        [...heading.matchAll(/@setu-ts\/[\w-]+/g)].some((match) => match[0] === packageName)
      );
    })
    .join('\n');
}
