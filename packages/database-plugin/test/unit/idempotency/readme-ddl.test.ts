import * as nodeFs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function readmeSqlFences(): Promise<string[]> {
  const readme = await nodeFs.readFile(new URL('../../../README.md', import.meta.url), 'utf8');
  return [...readme.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!.trimEnd());
}

async function fixture(file: string): Promise<string> {
  const text = await nodeFs.readFile(new URL(`../../fixtures/${file}`, import.meta.url), 'utf8');
  return text.trimEnd();
}

/** Keep the published Tier-C schema identical to the real-backend fixtures. */
describe('README Tier-C idempotency DDL', () => {
  for (const file of ['idempotency-postgres.sql', 'idempotency-sqlite.sql']) {
    it(`embeds ${file} verbatim as one SQL fence`, async () => {
      expect(await readmeSqlFences()).toContain(await fixture(file));
    });
  }
});

/** The MySQL tables the store conformance suite creates are the ones the README publishes. */
describe('README MySQL store DDL', () => {
  for (const file of ['outbox-mysql.sql', 'inbox-mysql.sql', 'idempotency-mysql.sql']) {
    it(`embeds ${file} verbatim as one SQL fence`, async () => {
      expect(await readmeSqlFences()).toContain(await fixture(file));
    });
  }
});
