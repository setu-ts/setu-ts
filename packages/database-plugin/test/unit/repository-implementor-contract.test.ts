/**
 * The hand-written `IRepository` implementor (M90h §3.2).
 *
 * X26-2: `IRepository.findPage` became REQUIRED in 0.2.0 without a CHANGELOG
 * entry, while its sibling `findOne` addition was announced twice. The
 * implementor that breaks first in the real world is a hand-written test
 * double — exactly where the finding surfaced (17 errors to 3 after the
 * decorator migration, one of the survivors being the missing `findPage`).
 *
 * The tripwire is the fixture itself: `test/fixtures/repository-implementor.ts`
 * is type-checked by `deno task check` (which covers `test/`), so adding a
 * REQUIRED member to `IRepository` without updating the fixture fails the gate
 * at the moment it happens — no reviewer has to notice, and the convention
 * that depends on remembering cannot fail the way this one did.
 *
 * This file drives the fixture's behaviour so the fixture is not dead weight:
 * a tripwire that type-checks but does nothing would be deleted as such.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { InMemoryRowRepository } from '../fixtures/repository-implementor.ts';

describe('hand-written IRepository implementor (X26-2 tripwire)', () => {
  it('satisfies the full required surface', async () => {
    const repo = new InMemoryRowRepository();
    const row = await repo.create({ name: 'alpha' });

    expect(await repo.findById(row.id)).toEqual(row);
    expect(await repo.exists(row.id)).toBe(true);
    expect(await repo.findOne()).toEqual(row);
    expect(await repo.findAll()).toEqual([row]);
    expect(await repo.count()).toBe(1);
  });

  it('answers findPage, the member X26-2 found announced nowhere', async () => {
    const repo = new InMemoryRowRepository();
    await repo.create({ name: 'alpha' });
    await repo.create({ name: 'beta' });

    // `PageResult`'s guarantee: non-null IF AND ONLY IF the page is
    // non-terminal. Two rows and `limit: 1` is a NON-terminal first page, so a
    // `null` cursor here would tell a caller it had seen everything and lose
    // the second row silently.
    const first = await repo.findPage({ limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.name).toBe('alpha');
    expect(first.nextCursor).not.toBeNull();

    // The walk terminates, and reaches the row the first page did not carry —
    // asserting the cursor is non-null alone would pass for a cursor that
    // pages forever or returns the same row again.
    const second = await repo.findPage({ limit: 1, cursor: first.nextCursor as string });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.name).toBe('beta');
    expect(second.nextCursor).toBeNull();
  });

  it('reports a page that exactly exhausts the store as terminal', async () => {
    const repo = new InMemoryRowRepository();
    await repo.create({ name: 'alpha' });

    // The case a `rows.length < limit` heuristic gets wrong: one row and
    // `limit: 1` fills the page exactly and is still the last page. The
    // contract forbids deriving the cursor from `rows.length`, which is why
    // the fixture fetches `limit + 1` instead.
    const page = await repo.findPage({ limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects every non-canonical cursor rather than paging from the wrong row', async () => {
    const repo = new InMemoryRowRepository();
    await repo.create({ name: 'alpha' });
    await repo.create({ name: 'beta' });

    // A cursor is opaque: the only valid value is one the repository issued.
    // `'1junk'` is the case a `Number.parseInt` guard lets through — it parses
    // to `1` and pages from the wrong row while reporting success — and the
    // rest coerce to a valid offset the caller was never given.
    const refused = [
      // Three groups, one per refusal path — measured, not assumed.
      //
      // Coerce to `NaN`, so either clause refuses them on its own. `'1junk'`
      // is the sharpest value in the file: a `Number.parseInt` guard reads it
      // as `1` and pages from the wrong row while reporting success.
      'not-a-cursor',
      '1junk',
      // Coerce to a valid offset the caller was never given, so ONLY the
      // canonical round-trip refuses them.
      '',
      ' 1 ',
      '01',
      '1e2',
      '0x10',
      // Round-trip cleanly, so ONLY `isSafeInteger`/`>= 0` refuses them.
      // Groups two and three are why both clauses are kept.
      '-1',
      '1.9',
      'Infinity',
    ];
    for (const cursor of refused) {
      await expect(
        repo.findPage({ limit: 1, cursor }),
        `cursor ${JSON.stringify(cursor)} must be refused`,
      ).rejects.toThrow('Malformed cursor');
    }

    // The cursor the repository DID issue still works — without this the loop
    // above would pass for a findPage that refuses everything.
    const first = await repo.findPage({ limit: 1 });
    const second = await repo.findPage({ limit: 1, cursor: first.nextCursor as string });
    expect(second.rows[0]?.name).toBe('beta');
  });

  it('refuses an update of a missing row', async () => {
    const repo = new InMemoryRowRepository();
    await expect(repo.update('missing', { name: 'x' })).rejects.toThrow('Row not found');
  });
});
