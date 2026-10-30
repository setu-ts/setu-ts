import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import type { NewDependencies } from '../commands/new.ts';
import { EXIT_ERROR, EXIT_INTERRUPTED, EXIT_OK, EXIT_USAGE, VERSION } from '../constants.ts';
import { EXAMPLES, EXCLUDED_EXAMPLES, exampleTemplate } from './catalog.ts';
import type { ExampleName } from './catalog.ts';
import { EXAMPLE_MANIFEST } from './manifest.ts';
import {
  exampleTsconfig,
  rewriteExamplePackage,
  rewriteExampleSource,
  rewriteSmokeHelper,
} from './rewrite.ts';
import { deriveNames, escapeName, isPathSegmentSafe, PROJECT_NAME_RULE } from '../utils/names.ts';
import {
  findExisting,
  joinPath,
  reportDryRunPlan,
  resolveDir,
  writeFiles,
} from '../utils/file-writer.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import { interruptionMessage, throwIfInterrupted } from '../utils/interruption.ts';
import { runAgentsCommand } from '../commands/agents.ts';

/** Flags that cannot alter an example's fixed composition. */
const CONFLICTS = [
  'template',
  'workspace',
  'style',
  'broker',
  'queue',
  'redis-client',
  'devtool',
  'devtool-port',
  'logger',
  'env-file',
  'transport',
  'transport-url',
  'port',
  'depends-on',
  'di',
] as const;

/**
 * Plans every output path without contacting the network.
 * @param example - An offered example.
 * @returns The relative paths of downloaded and generated files.
 */
export function examplePaths(example: ExampleName): readonly string[] {
  const entry = EXAMPLE_MANIFEST[example];
  return [...entry.files, ...(entry.smokeHelper ? ['smoke-helpers.ts'] : []), '.gitignore'];
}

/**
 * Downloads and rewrites all inputs before handing any bytes to the shared transactional writer.
 * @param rawName - The project name as typed.
 * @param args - Parsed flags including the example selection.
 * @param deps - Filesystem, fetch and output boundaries.
 * @returns The CLI exit status.
 */
export async function runExampleNew(
  rawName: string,
  args: ParsedArgs,
  deps: NewDependencies,
): Promise<number> {
  const conflict = CONFLICTS.find((flag) => args.flags[flag] !== undefined);
  if (conflict !== undefined) {
    deps.error(
      `--example cannot be combined with --${conflict}; examples keep their own composition.`,
    );
    return EXIT_USAGE;
  }
  if (args.flags['runtime'] !== undefined && args.flags['runtime'] !== 'node') {
    deps.error('--example supports --runtime node only.');
    return EXIT_USAGE;
  }
  const rawExample = args.flags['example'];
  if (typeof rawExample !== 'string' || !(EXAMPLES as readonly string[]).includes(rawExample)) {
    deps.error(
      typeof rawExample === 'string' && Object.hasOwn(EXCLUDED_EXAMPLES, rawExample)
        ? `Example ${escapeName(rawExample)} is excluded: ${EXCLUDED_EXAMPLES[rawExample]}.`
        : `Unknown example ${typeof rawExample === 'string' ? escapeName(rawExample) : '(missing name)'}. Offered: ${EXAMPLES.join(', ')}.`,
    );
    return EXIT_ERROR;
  }
  const example = rawExample as ExampleName;
  const names = deriveNames(rawName);
  if (/\p{Cc}/u.test(rawName) || !isPathSegmentSafe(names)) {
    deps.error(`Invalid project name: "${escapeName(rawName)}". ${PROJECT_NAME_RULE}`);
    return EXIT_USAGE;
  }
  const root = joinPath(resolveDir(deps.cwd, stringFlag(args.flags, 'dir')), names.kebab);
  const paths = examplePaths(example);
  const placeholders = paths.map((path) => ({ path: joinPath(root, path), contents: '' }));
  if (args.flags['dry-run'] === true) return reportDryRunPlan(deps, placeholders);
  const existing = await findExisting(deps.fs, placeholders);
  if (existing.length > 0) {
    deps.error('Refusing to overwrite existing files:');
    for (const path of existing) deps.error(`  ${escapeName(path)}`);
    return EXIT_ERROR;
  }
  const fetchFile = deps.fetch ?? globalThis.fetch;
  const files: GeneratedFile[] = [];
  let currentUrl = '';
  try {
    for (const path of paths) {
      throwIfInterrupted(deps.interrupt);
      let file: GeneratedFile;
      if (path === '.gitignore') file = { path, contents: 'node_modules\ndist\n.env\n' };
      // Replaced wholesale, so the repository's copy is never downloaded.
      else if (path === 'tsconfig.json') file = { path, contents: exampleTsconfig() };
      else {
        const source =
          path === 'smoke-helpers.ts' ? 'apps/smoke-helpers.ts' : `apps/${example}/${path}`;
        currentUrl = `https://raw.githubusercontent.com/setu-ts/setu-ts/v${VERSION}/${source}`;
        const response = await fetchFile(
          currentUrl,
          deps.interrupt === undefined ? {} : { signal: deps.interrupt },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (EXAMPLE_MANIFEST[example].binary.includes(path)) {
          file = { path, contents: '', bytes: new Uint8Array(await response.arrayBuffer()) };
        } else {
          let contents = await response.text();
          if (path === 'package.json') contents = rewriteExamplePackage(contents, names.kebab);
          else if (path === 'smoke-helpers.ts') contents = rewriteSmokeHelper(contents);
          else if (path === 'README.md')
            contents += `\nWalkthrough: https://setu-ts.dev/examples/${example}/\n`;
          else contents = rewriteExampleSource(contents);
          file = { path, contents };
        }
      }
      files.push({ ...file, path: joinPath(root, path) });
    }
  } catch (cause) {
    const interrupted = interruptionMessage(cause);
    if (interrupted !== undefined) {
      deps.error(interrupted);
      return EXIT_INTERRUPTED;
    }
    deps.error(
      `Failed to fetch ${currentUrl}: ${escapeName(cause instanceof Error ? cause.message : String(cause))}. Nothing was written. Try setu new ${names.kebab} --template ${exampleTemplate(example)}.`,
    );
    return EXIT_ERROR;
  }
  try {
    const outcomes = await writeFiles(deps.fs, files, {
      root,
      ...(deps.interrupt === undefined ? {} : { signal: deps.interrupt }),
    });
    for (const outcome of outcomes) deps.log(`${outcome.outcome} ${escapeName(outcome.path)}`);
    if (args.flags['agents'] === true) {
      const code = await runAgentsCommand({ positionals: [], flags: {} }, { ...deps, cwd: root });
      if (code !== EXIT_OK) return code;
    }
  } catch (cause) {
    const interrupted = interruptionMessage(cause);
    deps.error(
      interrupted ??
        `Failed to write: ${escapeName(cause instanceof Error ? cause.message : String(cause))}`,
    );
    return interrupted === undefined ? EXIT_ERROR : EXIT_INTERRUPTED;
  }
  deps.log(`Created ${names.kebab} from ${example}. Next:`);
  deps.log(`  cd ${names.kebab} && npm install && npm start`);
  deps.log('  npm run smoke');
  return EXIT_OK;
}
