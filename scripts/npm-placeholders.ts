/** Generates README-only name placeholders; never publishes. @module */
import { PACKAGE_METADATA } from './jsr-metadata.ts';
import { REPOSITORY_URL } from './npm-release-gate.ts';
import { PUBLISHED_PACKAGES } from './release-packages.ts';

/** Generates one manifest and README per release member, without executable content. */
export function placeholderFiles(): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const dir of PUBLISHED_PACKAGES) {
    const leaf = dir.split('/').at(-1) as string;
    const name = `@setu-ts/${leaf}`;
    const pkg = {
      name,
      version: '0.0.0-bootstrap.0',
      description: PACKAGE_METADATA[leaf].description,
      license: 'MIT',
      repository: { type: 'git', url: REPOSITORY_URL, directory: dir },
      publishConfig: { access: 'public' },
    };
    files.set(`${leaf}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
    files.set(
      `${leaf}/README.md`,
      `# ${name}\n\nThis version is a name placeholder. It contains no framework code.\nThe first real release is 0.9.0, published through GitHub Actions with npm provenance.\n`,
    );
  }
  return files;
}
