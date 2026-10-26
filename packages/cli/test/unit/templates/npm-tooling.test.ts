import { describe, expect, it } from 'vitest';
import { NPM_TOOLING_SCRIPTS, npmToolingFiles } from '../../../src/templates/npm-tooling.ts';

/** Reads one emitted file's contents. */
function contentsOf(files: readonly { path: string; contents: string }[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  expect(file).toBeDefined();
  return file?.contents ?? '';
}

describe('npm tooling files', () => {
  it('excludes every generated directory from ESLint and Prettier', () => {
    // `generatedOutputDirs` hands the build output FIRST and any typegen
    // directory after it (V9-11). Both are generated source, so both are
    // ignored by the linter and the formatter alike.
    const files = npmToolingFiles(['build', '.react-router']);
    const eslint = contentsOf(files, 'eslint.config.js');
    expect(eslint).toContain(`'build/'`);
    expect(eslint).toContain(`'.react-router/'`);

    const prettierignore = contentsOf(files, '.prettierignore').split('\n');
    expect(prettierignore).toContain('build/');
    expect(prettierignore).toContain('.react-router/');
  });

  it('emits no generated-directory ignore when a template has none', () => {
    const eslint = contentsOf(npmToolingFiles([]), 'eslint.config.js');
    // The fixed ignores are still present; nothing else is.
    expect(eslint).toContain(`'node_modules/'`);
    expect(eslint).not.toContain('build/');
    const prettierignore = contentsOf(npmToolingFiles([]), '.prettierignore');
    expect(prettierignore).toContain('node_modules/');
    expect(prettierignore).not.toContain('build/');
  });

  it('ships the scripts the emitted package.json advertises', () => {
    expect(NPM_TOOLING_SCRIPTS['check']).toBe('tsc --noEmit && setu check');
    expect(NPM_TOOLING_SCRIPTS['lint']).toBe('eslint .');
  });
});
