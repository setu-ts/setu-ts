import * as nodeFs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/** Keep the published Tier-C schema identical to the real-backend fixtures. */
describe('README Tier-C idempotency DDL', () => {
  for (const file of ['idempotency-postgres.sql', 'idempotency-sqlite.sql']) {
    it(`embeds ${file} verbatim as one SQL fence`, async () => {
      const readme = await nodeFs.readFile(new URL('../../../README.md', import.meta.url), 'utf8');
      const fixture = await nodeFs.readFile(
        new URL(`../../fixtures/${file}`, import.meta.url),
        'utf8',
      );
      const fences = [...readme.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!.trimEnd());
      expect(fences).toContain(fixture.trimEnd());
    });
  }
});
