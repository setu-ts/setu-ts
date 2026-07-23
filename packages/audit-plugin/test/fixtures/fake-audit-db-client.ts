/**
 * Fake {@linkcode IAuditDbClient} for unit tests.
 */
import type { IAuditDbClient } from '../../src/interfaces/index.ts';

export class FakeAuditDbClient implements IAuditDbClient {
  readonly inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  readonly selects: Array<{ table: string; criteria?: Record<string, unknown> }> = [];
  private _rows: Record<string, Record<string, unknown>[]> = {};

  insert(table: string, row: Record<string, unknown>): Promise<void> {
    this.inserts.push({ table, row });
    if (!this._rows[table]) this._rows[table] = [];
    this._rows[table] = [...this._rows[table], row];
    return Promise.resolve();
  }

  select(
    table: string,
    criteria?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    if (criteria) {
      this.selects.push({ table, criteria });
    } else {
      this.selects.push({ table });
    }
    let rows = this._rows[table] ?? [];
    if (criteria) {
      rows = rows.filter((row) => {
        for (const [key, val] of Object.entries(criteria)) {
          if (row[key] !== val) return false;
        }
        return true;
      });
    }
    return Promise.resolve(rows);
  }
}
