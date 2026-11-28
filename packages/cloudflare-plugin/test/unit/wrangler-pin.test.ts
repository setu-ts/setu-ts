/**
 * The workerd e2e suites run on the wrangler a generated Workers project
 * installs: this package's `wrangler` devDependency must stay the CLI
 * scaffold's pin, or a bump there would leave the suites proving an older
 * toolchain. The realtime-clients example pins the same one: npm sees this
 * package's wrangler through the workspace links, so the example needs a bin
 * of its own for `npx wrangler`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the wrangler the workerd e2e suites run', () => {
  it("is the CLI Workers scaffold's pin", async () => {
    const template = await readFile(
      join(root, '..', 'cli', 'src', 'templates', 'project-files.ts'),
      'utf8',
    );
    const scaffold = /^\s*wrangler: '([^']+)',$/m.exec(template)?.[1];
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };

    expect(scaffold).toMatch(/^~\d+\.\d+\.\d+$/);
    expect(manifest.devDependencies?.['wrangler']).toBe(scaffold);
  });

  it("is also the realtime-clients example's pin, which its workerd smoke runs", async () => {
    const template = await readFile(
      join(root, '..', 'cli', 'src', 'templates', 'project-files.ts'),
      'utf8',
    );
    const scaffold = /^\s*wrangler: '([^']+)',$/m.exec(template)?.[1];
    const example = JSON.parse(
      await readFile(join(root, '..', '..', 'apps', 'realtime-clients', 'package.json'), 'utf8'),
    ) as { devDependencies?: Record<string, string> };

    expect(example.devDependencies?.['wrangler']).toBe(scaffold);
  });
});
