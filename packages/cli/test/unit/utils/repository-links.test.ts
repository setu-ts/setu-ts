import { describe, expect, it } from 'vitest';
import { repositoryFileUrl, siteUrl } from '../../../src/utils/repository-links.ts';
import { VERSION } from '../../../src/version.ts';

describe('repositoryFileUrl', () => {
  it('pins a repository file to the CLI version tag', () => {
    expect(repositoryFileUrl('packages/database-plugin/README.md')).toBe(
      `https://github.com/setu-ts/setu-ts/blob/v${VERSION}/packages/database-plugin/README.md`,
    );
    expect(repositoryFileUrl('packages/database-plugin/README.md')).not.toContain('/develop/');
  });

  it('keeps an anchor after the file path', () => {
    expect(repositoryFileUrl('README.md#migrations-and-readiness')).toBe(
      `https://github.com/setu-ts/setu-ts/blob/v${VERSION}/README.md#migrations-and-readiness`,
    );
  });
});

describe('siteUrl', () => {
  it('names the rendered site, with a trailing slash for the home page', () => {
    expect(siteUrl('')).toBe('https://setu-ts.dev/');
    expect(siteUrl('docs/cli/')).toBe('https://setu-ts.dev/docs/cli/');
    expect(siteUrl('/docs/cli/')).toBe('https://setu-ts.dev/docs/cli/');
  });
});
