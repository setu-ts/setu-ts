/* eslint-disable no-console -- a setup script reports what it did. */
/**
 * Applies `schema.sql` to the PostgreSQL database in `DATABASE_URL`: the
 * example's tables, the idempotency and agent-run tables, and the three
 * demonstration orders. Safe to run again.
 */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('Set DATABASE_URL to a PostgreSQL URL first; the memory database needs no setup.');
  process.exit(1);
}
const pool = new Pool({ connectionString: url, max: 1 });
try {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  console.log('Schema applied.');
} finally {
  await pool.end();
}
