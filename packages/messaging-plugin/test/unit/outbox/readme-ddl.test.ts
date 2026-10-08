/**
 * The README's outbox DDL is the DDL the real suites apply (M107 §3.14).
 *
 * ONE copy of each schema exists, as a fixture in `database-plugin`: the
 * PostgreSQL file is applied by the real PostgreSQL suites and the SQLite/D1
 * file by the D1 test. This asserts each README embeds those files VERBATIM,
 * so a column renamed in the record cannot leave a README template that no
 * longer matches what the relay reads.
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

describe('README outbox DDL', () => {
  it('the messaging-plugin README embeds the PostgreSQL fixture verbatim, as one fence', async () => {
    const ddl = (await fixture('outbox-postgres.sql')).trimEnd();
    expect(sqlFences(await readme('messaging-plugin'))).toContain(ddl);
  });

  it('the messaging-plugin README embeds the SQLite/D1 fixture verbatim, as one fence', async () => {
    const ddl = (await fixture('outbox-sqlite.sql')).trimEnd();
    expect(sqlFences(await readme('messaging-plugin'))).toContain(ddl);
  });

  it('the database-plugin README embeds the PostgreSQL fixture verbatim, as one fence', async () => {
    const ddl = (await fixture('outbox-postgres.sql')).trimEnd();
    expect(sqlFences(await readme('database-plugin'))).toContain(ddl);
  });

  it('the two fixtures carry the same columns (snake_case against field names)', async () => {
    const columns = (ddl: string) =>
      [...ddl.matchAll(/^\s{2}(\w+)\s/gm)].map((m) => m[1]!.replaceAll('_', '').toLowerCase());
    expect(columns(await fixture('outbox-sqlite.sql'))).toEqual(
      columns(await fixture('outbox-postgres.sql')),
    );
  });
});
