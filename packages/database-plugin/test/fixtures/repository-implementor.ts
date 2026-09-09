/**
 * A hand-written `IRepository` implementation — the compile-time tripwire
 * (M90h §3.2).
 *
 * X26-2: `IRepository` gained a REQUIRED `findPage` member (0.2.0) that was
 * announced nowhere, while the sibling `findOne` addition was announced twice.
 * Anything implementing the interface by hand — the commonest case being a
 * test double — must supply every required member, and a convention that
 * depends on remembering fails the way this did. This fixture turns "a
 * required member was added to `IRepository`" into a COMPILE ERROR inside the
 * repository, at the moment it is added: `deno task check` covers `test/`, so
 * dropping one member from this class (or adding a required member to the
 * interface without updating it) fails the gate, which no reviewer has to
 * notice.
 *
 * Deliberately does NOT extend `BaseRepository` — that class inherits the
 * members and would hide the contract from this file.
 *
 * @module
 */
import type {
  CountOptions,
  EntityKey,
  FindOptions,
  IRepository,
  Page,
  PageOptions,
} from '../../src/index.ts';

/**
 * The row shape the in-memory implementor manages. A type alias rather than an
 * interface: the alias's object-literal members give it an implicit index
 * signature, so the generic filter/sort below can read it as
 * `Record<string, unknown>` without a cast the compiler would refuse.
 */
export type Row = {
  readonly id: string;
  readonly name: string;
};

/**
 * The smallest honest `IRepository<Row, string>`: an in-memory row list with
 * the full required surface. Every member is implemented for real — a stub
 * that returned `Promise.resolve(undefined as never)` would type-check and
 * rot, which is what this file exists to prevent.
 */
export class InMemoryRowRepository implements IRepository<Row, string> {
  #rows: Row[] = [];

  findById(id: EntityKey): Promise<Row | null> {
    return Promise.resolve(this.#rows.find((row) => row.id === (id as string)) ?? null);
  }

  findAll(options?: FindOptions): Promise<Row[]> {
    let rows = [...this.#rows];
    const where = options?.where;
    if (where !== undefined) {
      rows = rows.filter((row) =>
        Object.entries(where).every(([key, value]) =>
          (row as Record<string, unknown>)[key] === value
        )
      );
    }
    const orderBy = options?.orderBy;
    if (orderBy !== undefined) {
      const [field, direction] = Object.entries(orderBy)[0] ?? ['id', 'asc'];
      rows.sort((a, b) => {
        const left = (a as Record<string, unknown>)[field] as string | number;
        const right = (b as Record<string, unknown>)[field] as string | number;
        const order = left < right ? -1 : left > right ? 1 : 0;
        return direction === 'desc' ? -order : order;
      });
    }
    if (options?.offset !== undefined) rows = rows.slice(options.offset);
    if (options?.limit !== undefined) rows = rows.slice(0, options.limit);
    return Promise.resolve(rows);
  }

  async findOne(options?: FindOptions): Promise<Row | null> {
    const [first] = await this.findAll({ ...options, limit: 1 });
    return first ?? null;
  }

  create(data: Partial<Row>): Promise<Row> {
    const row: Row = { id: data.id ?? `row-${this.#rows.length + 1}`, name: data.name ?? '' };
    this.#rows.push(row);
    return Promise.resolve(row);
  }

  update(id: EntityKey, data: Partial<Row>): Promise<Row> {
    const index = this.#rows.findIndex((row) => row.id === (id as string));
    // Reject rather than throw: the contract returns a Promise, so a missing
    // row must REJECT — a synchronous throw would bypass a caller using
    // `.catch()`, the defect class this repository has flagged (M52b/M52c).
    if (index === -1) return Promise.reject(new Error(`Row not found: ${String(id)}`));
    const updated: Row = { ...this.#rows[index], ...data, id: this.#rows[index].id };
    this.#rows[index] = updated;
    return Promise.resolve(updated);
  }

  delete(id: EntityKey): Promise<boolean> {
    const index = this.#rows.findIndex((row) => row.id === (id as string));
    if (index === -1) return Promise.resolve(false);
    this.#rows.splice(index, 1);
    return Promise.resolve(true);
  }

  exists(id: EntityKey): Promise<boolean> {
    return Promise.resolve(this.#rows.some((row) => row.id === (id as string)));
  }

  count(options?: CountOptions): Promise<number> {
    const where = options?.where;
    if (where === undefined) return Promise.resolve(this.#rows.length);
    return Promise.resolve(
      this.#rows.filter((row) =>
        Object.entries(where).every(([key, value]) =>
          (row as Record<string, unknown>)[key] === value
        )
      ).length,
    );
  }

  async findPage(options: PageOptions): Promise<Page<Row>> {
    // `PageResult`'s guarantee is that `nextCursor` is non-null IF AND ONLY IF
    // the page is non-terminal, and that it is never derived from
    // `rows.length`. This is the row-based mechanism the contract names: fetch
    // `limit + 1` and treat the extra row as the signal, so a page that
    // returns exactly `limit` rows and a page that exhausts the store are
    // distinguishable. Returning a constant `null` would satisfy the types and
    // report every page as the last one — the kind of member this fixture
    // exists to refuse.
    //
    // The cursor is an offset because this store has no sort key of its own.
    // That is a property of the fixture, NOT of the contract: a cursor is
    // OPAQUE to callers, so a consumer must round-trip the token it was given
    // rather than construct or parse one.
    const start = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    if (!Number.isSafeInteger(start) || start < 0) {
      return Promise.reject(new Error(`Malformed cursor: ${String(options.cursor)}`));
    }
    const limit = options.limit;
    const window = await this.findAll({
      ...options,
      offset: start,
      ...(limit === undefined ? {} : { limit: limit + 1 }),
    });
    if (limit === undefined || window.length <= limit) {
      return { rows: window, nextCursor: null };
    }
    return { rows: window.slice(0, limit), nextCursor: String(start + limit) };
  }
}
