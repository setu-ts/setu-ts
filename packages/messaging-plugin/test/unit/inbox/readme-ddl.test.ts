/**
 * The README's inbox DDL is the DDL the real suites apply (M108 §3.14): ONE
 * copy of each schema exists, as a fixture in `database-plugin`, and each
 * README embeds it VERBATIM, so a column renamed in the record cannot leave a
 * template that no longer matches what the bridge writes.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const fixture = (name: string): Promise<string> =>
  Deno.readTextFile(
    new URL(`../../../../database-plugin/test/fixtures/${name}`, import.meta.url),
  );

const readme = (pkg: string): Promise<string> =>
  Deno.readTextFile(new URL(`../../../../${pkg}/README.md`, import.meta.url));

/** The fenced SQL blocks of a Markdown document, trailing newline normalized. */
function sqlFences(markdown: string): string[] {
  return [...markdown.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!.trimEnd());
}

describe('README inbox DDL', () => {
  for (const file of ['inbox-postgres.sql', 'inbox-sqlite.sql']) {
    it(`the messaging-plugin README embeds ${file} verbatim, as one fence`, async () => {
      expect(sqlFences(await readme('messaging-plugin'))).toContain(
        (await fixture(file)).trimEnd(),
      );
    });
  }

  it('the database-plugin README embeds the PostgreSQL fixture verbatim', async () => {
    expect(sqlFences(await readme('database-plugin'))).toContain(
      (await fixture('inbox-postgres.sql')).trimEnd(),
    );
  });

  it('the two fixtures carry the same columns, and the record fields', async () => {
    const columns = (ddl: string) =>
      [...ddl.matchAll(/^\s{2}(\w+)\s/gm)].map((m) => m[1]!.replaceAll('_', '').toLowerCase());
    const postgres = columns(await fixture('inbox-postgres.sql'));
    expect(columns(await fixture('inbox-sqlite.sql'))).toEqual(postgres);
    expect(postgres).toEqual([
      'id',
      'kind',
      'consumer',
      'topic',
      'envelopeid',
      'status',
      'attempts',
      'updatedat',
      'lasterror',
      'envelope',
    ]);
  });
});
