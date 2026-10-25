import { describe, expect, it } from 'vitest';
import { repositoryFileUrl } from '../../../src/utils/repository-links.ts';
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
