import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { placeholderFiles } from '../../scripts/npm-placeholders.ts';
import { PUBLISHED_PACKAGES } from '../../scripts/release-packages.ts';
import { REPOSITORY_URL } from '../../scripts/npm-release-gate.ts';

describe('README-only placeholders', () => {
  it('generates exactly the release set with metadata and no code or lifecycle surface', () => {
    const files = placeholderFiles();
    expect(files.size).toBe(PUBLISHED_PACKAGES.length * 2);
    for (const dir of PUBLISHED_PACKAGES) {
      const leaf = dir.split('/').at(-1)!;
      const pkg = JSON.parse(files.get(`${leaf}/package.json`)!);
      expect(Object.keys(pkg).sort()).toEqual([
        'description',
        'license',
        'name',
        'publishConfig',
        'repository',
        'version',
      ]);
      expect(pkg.name).toBe(`@setu-ts/${leaf}`);
      expect(pkg.version).toBe('0.0.0-bootstrap.0');
      expect(pkg.publishConfig.access).toBe('public');
      expect(pkg.repository.url).toBe(REPOSITORY_URL);
      expect(pkg.repository.directory).toBe(dir);
      expect(pkg.description.length).toBeGreaterThan(0);
      expect(files.get(`${leaf}/README.md`)).toContain('placeholder');
      expect(files.get(`${leaf}/README.md`)).toContain('0.9.0');
    }
  });

  it('names a member that has no metadata entry instead of failing on an undefined read', () => {
    expect(() => placeholderFiles(['packages/no-such-member'], {})).toThrow(
      'No package metadata for @setu-ts/no-such-member',
    );
    // An inherited key is not an entry.
    expect(() => placeholderFiles(['packages/constructor'], {})).toThrow('@setu-ts/constructor');
  });
});
