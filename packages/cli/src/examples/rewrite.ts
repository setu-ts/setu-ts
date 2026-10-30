import { FRAMEWORK_RANGE } from '../templates/framework-specifier.ts';
import { NPM_TOOLING_DEV_DEPENDENCIES } from '../templates/npm-tooling.ts';

/**
 * Rewrites an example manifest without retaining workspace dependency ranges.
 * @param source - The downloaded package.json text.
 * @param name - The validated project name.
 * @returns A standalone JSON manifest.
 * @throws {SyntaxError} If the source is invalid JSON.
 */
export function rewriteExamplePackage(source: string, name: string): string {
  const manifest = JSON.parse(source) as Record<string, unknown>;
  for (const key of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const dependencies = manifest[key] as Record<string, string> | undefined;
    if (dependencies === undefined) continue;
    manifest[key] = Object.fromEntries(
      Object.entries(dependencies).map(([pkg, range]) => [
        pkg,
        range === 'workspace:^' ? FRAMEWORK_RANGE : range,
      ]),
    );
  }
  const dev = manifest['devDependencies'] as Record<string, string> | undefined;
  const scripts = manifest['scripts'] as Record<string, string> | undefined;
  return (
    JSON.stringify(
      {
        ...manifest,
        name,
        devDependencies: {
          ...dev,
          typescript: NPM_TOOLING_DEV_DEPENDENCIES['typescript'],
          '@types/node': '^24.0.0',
        },
        scripts: { ...scripts, check: 'tsc --noEmit' },
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * Standalone Node configuration for the offered examples, including TC39 decorators.
 * @returns The tsconfig.json text, with no repository paths or extends.
 */
export function exampleTsconfig(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          lib: ['ESNext', 'DOM', 'DOM.Iterable'],
          strict: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          exactOptionalPropertyTypes: true,
          allowImportingTsExtensions: true,
          noEmit: true,
          types: ['node'],
        },
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * Relocates the shared smoke helper's imports into the standalone project.
 * @param source - A downloaded text file.
 * @returns Text with the helper import resolved from the project root.
 */
export function rewriteExampleSource(source: string): string {
  return source.replaceAll('../smoke-helpers.ts', './smoke-helpers.ts');
}

/**
 * Removes the repository source loader; installed projects resolve packed packages normally.
 * @param source - The repository smoke helper.
 * @returns The standalone helper and its corrected loader comment.
 */
export function rewriteSmokeHelper(source: string): string {
  return source
    .replace(
      / {2}'--import',\s*new URL\('\.\.\/scripts\/lib\/source-register\.ts', import\.meta\.url\)\.href,?\s*/g,
      '',
    )
    .replace(
      "Node/tsx arguments that preserve the caller's source redirect for a child example.",
      'Node/tsx arguments for a child example using installed packages.',
    );
}
