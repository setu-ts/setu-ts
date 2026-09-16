/** M96 recurrence gate: classifications are allowed; regulation claims are not. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DATA_CLASSIFICATIONS } from '@setu-ts/common';

describe('M96 vocabulary boundary', () => {
  it('ships standard field classifications without claiming a regulation', async () => {
    expect(DATA_CLASSIFICATIONS).toEqual({
      PII: 'pii',
      PHI: 'phi',
      PCI: 'pci',
      SECRET: 'secret',
    });

    const forbidden = /\b(?:HIPAA|GDPR|DSS)\b/;
    async function scan(directory: string): Promise<void> {
      for await (const file of Deno.readDir(directory)) {
        const path = `${directory}/${file.name}`;
        if (file.isDirectory) {
          await scan(path);
        } else if (file.isFile && file.name.endsWith('.ts')) {
          expect(forbidden.test(await Deno.readTextFile(path))).toBe(false);
        }
      }
    }

    for await (const packageEntry of Deno.readDir('packages')) {
      if (!packageEntry.isDirectory) continue;
      const sourceDir = `packages/${packageEntry.name}/src`;
      try {
        await scan(sourceDir);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  });
});
