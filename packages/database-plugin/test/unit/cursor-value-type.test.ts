/**
 * M113g plan §3.5a: a well-formed cursor carrying a value of the wrong type
 * for its sort column is the client's cursor, so the backend's type refusal
 * answers `InvalidCursorError` (400) — on the Drizzle and Prisma keyset pages
 * only when a cursor was supplied. A page without a cursor keeps the driver
 * error exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { encodeCursor, InvalidCursorError, sortFingerprint } from '@setu-ts/common';
import type { NormalizedQuery } from '@setu-ts/common';
import { createDrizzleDataSource } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createPrismaDataSource } from '../../src/adapters/prisma/prisma-adapter.ts';
import { isValueTypeRefusal } from '../../src/errors/classify.ts';
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';

// Drizzle's real operators over a real table: the keyset predicate is built
// for real, and only the select itself is replaced by a rejecting fake.
const operators = { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql };
const item = pgTable('item', { id: text('id').primaryKey(), value: integer('value') });

const PRIVATE = 'private-not-a-number';
const orderBy = { id: 'asc' as const };
const forged = encodeCursor({
  orderedValues: [PRIVATE],
  keyValues: [PRIVATE],
  sortFingerprint: sortFingerprint(orderBy, { entity: 'item', keyColumns: ['id'] }),
});

function page(cursor?: string): NormalizedQuery {
  return {
    where: {},
    orderBy,
    limit: 2,
    offset: 0,
    select: [],
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** A node-postgres `22P02` inside drizzle's `Failed query` wrapper, both quoting the value. */
function dataException(): Error {
  const pg = Object.assign(new Error(`invalid input syntax for type integer: "${PRIVATE}"`), {
    code: '22P02',
  });
  return Object.assign(new Error(`Failed query: select … params: ${PRIVATE}`, { cause: pg }), {
    query: 'select …',
    params: [PRIVATE],
  });
}

/** A Drizzle instance whose every select rejects with `error`. */
function rejectingDrizzle(error: unknown): never {
  const chain: Record<string, unknown> = {};
  for (const step of ['where', 'orderBy', 'limit', 'offset']) chain[step] = () => chain;
  chain['then'] = (_resolve: unknown, reject: (reason: unknown) => void) => reject(error);
  return { select: () => ({ from: () => chain }) } as never;
}

function drizzleSource(error: unknown) {
  return createDrizzleDataSource(rejectingDrizzle(error), 'item', { item }, operators as never);
}

function prismaSource(error: unknown) {
  const client = { item: { findMany: () => Promise.reject(error) } };
  return createPrismaDataSource(client as never, 'item', 'postgresql');
}

function messagesOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    parts.push(current.message, String(current.stack));
    current = current.cause;
  }
  return parts.join('\n');
}

describe('Drizzle page: a mistyped cursor value', () => {
  it('answers InvalidCursorError with no private value in it or its cause', async () => {
    const error: unknown = await drizzleSource(dataException()).findPage!(page(forged)).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(InvalidCursorError);
    expect(messagesOf(error)).not.toContain(PRIVATE);
  });

  it('keeps the driver error unchanged on a page without a cursor', async () => {
    const original = dataException();
    await expect(drizzleSource(original).findPage!(page())).rejects.toBe(original);
  });

  it('passes a non-type error through unchanged even with a cursor', async () => {
    const outage = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    await expect(drizzleSource(outage).findPage!(page(forged))).rejects.toBe(outage);
  });
});

describe('Prisma page: a mistyped cursor value', () => {
  it('answers InvalidCursorError for a client-side validation refusal, with no cause', async () => {
    const validation = Object.assign(new Error(`Invalid value "${PRIVATE}" for Int`), {
      name: 'PrismaClientValidationError',
    });
    const error: unknown = await prismaSource(validation).findPage!(page(forged)).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(InvalidCursorError);
    expect((error as Error).cause).toBeUndefined();
    expect(messagesOf(error)).not.toContain(PRIVATE);
  });

  it('answers InvalidCursorError for a class 22 code from PostgreSQL', async () => {
    await expect(prismaSource(dataException()).findPage!(page(forged))).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });

  it('keeps the error unchanged on a page without a cursor', async () => {
    const original = dataException();
    await expect(prismaSource(original).findPage!(page())).rejects.toBe(original);
  });
});

describe('isValueTypeRefusal', () => {
  it.each([
    ['a class 22 code', Object.assign(new Error('x'), { code: '22P02' }), true],
    ['a class 22 code in the cause', new Error('x', { cause: { code: '22003' } }), true],
    [
      'Prisma validation',
      Object.assign(new Error('x'), { name: 'PrismaClientValidationError' }),
      true,
    ],
    ['a unique violation', Object.assign(new Error('x'), { code: '23505' }), false],
    [
      'division by zero, a server data fault',
      Object.assign(new Error('x'), { code: '22012' }),
      false,
    ],
    ['an out-of-range value', Object.assign(new Error('x'), { code: '22003' }), true],
    ['an invalid datetime', Object.assign(new Error('x'), { code: '22007' }), true],
    ['a datetime overflow', Object.assign(new Error('x'), { code: '22008' }), true],
    ['a bare class prefix', Object.assign(new Error('x'), { code: '22' }), false],
    ['a numeric code', Object.assign(new Error('x'), { code: 22001 }), false],
    ['an errno', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), false],
    ['a plain error', new Error('22P02'), false],
    ['not an error', 'boom', false],
  ])('%s → %s', (_label, value, expected) => {
    expect(isValueTypeRefusal(value)).toBe(expected);
  });
});
