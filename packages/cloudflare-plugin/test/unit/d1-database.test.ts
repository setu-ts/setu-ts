import { expect, it } from 'vitest';
import { encodeCursor, InvalidCursorError, PrimaryKeyChangeError } from '@setu-ts/common';
import { createD1DataSource } from '../../src/database/d1-data-source.ts';
import { SqliteD1 } from '../d1-fakes.ts';
import { D1Adapter } from '../../src/database/d1-adapter.ts';

it('D1 binds cursors to entity names even when both entities share a table', async () => {
  const adapter = new D1Adapter(new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY)'), {
    tables: { First: { table: 'users' }, Second: { table: 'users' } },
  });
  await adapter.connect();
  try {
    const first = adapter.createDataSource('First');
    const second = adapter.createDataSource('Second');
    await first.create({ id: '1' });
    await first.create({ id: '2' });
    const query = { where: {}, orderBy: { id: 'asc' as const }, select: [], limit: 1, offset: 0 };
    const page = await first.findPage!(query);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = { ...query, cursor: page.nextCursor! };
    expect((await first.findPage!(next)).rows).toEqual([{ id: '2' }]);
    await expect(second.findPage!(next)).rejects.toBeInstanceOf(InvalidCursorError);
  } finally {
    await adapter.disconnect();
  }
});

for (const transactional of [false, true]) {
  for (const safeReads of [1, 2]) {
    it(`D1 ${transactional ? 'transaction' : 'direct'} update snapshots a getter payload once (${safeReads} safe reads)`, async () => {
      const adapter = new D1Adapter(
        new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)'),
        { tables: { User: { table: 'users' } } },
      );
      await adapter.connect();
      const committed = adapter.createDataSource('User');
      await committed.create({ id: '5', name: 'before' });
      const tx = transactional ? await adapter.beginTransaction() : undefined;
      try {
        let reads = 0;
        const updated = await (tx?.createDataSource('User') ?? committed).update('5', {
          get id() {
            reads += 1;
            return reads <= safeReads ? '5' : 'private-new';
          },
          name: 'after',
        });
        expect(updated).toEqual({ id: '5', name: 'after' });
        await tx?.commit();
        expect(await committed.findById('5')).toEqual({ id: '5', name: 'after' });
        expect(await committed.findById('private-new')).toBeNull();
        expect(reads).toBe(1);
      } catch (error) {
        await tx?.rollback().catch(() => {});
        throw error;
      } finally {
        await adapter.disconnect();
      }
    });
  }
}

it('D1 refuses changed primary keys on real SQLite and leaves the row unmoved', async () => {
  const source = createD1DataSource(
    new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)'),
    { entity: 'users', table: 'users', primaryKey: ['id'] },
  );
  await source.create({ id: '5', name: 'before' });
  await expect(source.update('5', { id: 'private-new', name: 'after' })).rejects.toBeInstanceOf(
    PrimaryKeyChangeError,
  );
  await expect(
    source.updateWhere!('5', { name: 'before' }, { id: 'private-new' }),
  ).rejects.toBeInstanceOf(PrimaryKeyChangeError);
  expect(await source.findById('5')).toEqual({ id: '5', name: 'before' });
  expect(await source.findById('private-new')).toBeNull();
});

it('D1 cursor content errors are InvalidCursorError', async () => {
  const source = createD1DataSource(new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY)'), {
    entity: 'users',
    table: 'users',
    primaryKey: ['id'],
  });
  for (const cursor of [
    'private-token',
    encodeCursor({ orderedValues: ['5'], keyValues: ['5'], sortFingerprint: 'private-sort' }),
    encodeCursor({ orderedValues: [], keyValues: [], sortFingerprint: '' }),
  ]) {
    await expect(
      source.findPage!({ where: {}, orderBy: {}, select: [], limit: 1, offset: 0, cursor }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  }
});

it('M119e refuses unknown payload fields and STRICT values with fixed 400 details', async () => {
  const { UnknownPayloadFieldError, InvalidFieldValueError, httpStatusHintOf } =
    await import('@setu-ts/common');
  const source = createD1DataSource(
    new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY, age INTEGER) STRICT'),
    { entity: 'users', table: 'users', primaryKey: ['id'] },
  );
  await source.create({ id: '1', age: 1 });
  for (const payload of [
    { missing: 'canary-value' },
    { 'invalid-canary-field!': 'canary-value' },
  ]) {
    for (const write of [
      () => source.create({ id: '2', ...payload }),
      () => source.update('1', payload),
      () => source.updateWhere!('1', { age: 1 }, payload),
    ]) {
      const error: unknown = await write().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(UnknownPayloadFieldError);
      expect(httpStatusHintOf(error)).toEqual({
        status: 400,
        title: 'Bad Request',
        detail: 'The request names a field this resource does not have.',
      });
      expect(JSON.stringify(httpStatusHintOf(error))).not.toContain('canary');
      expect((error as Error).message).not.toContain('canary-value');
    }
  }
  for (const write of [
    () => source.create({ id: '2', age: 'canary-value' }),
    () => source.update('1', { age: 'canary-value' }),
    () => source.updateWhere!('1', { age: 1 }, { age: 'canary-value' }),
  ]) {
    const error: unknown = await write().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(InvalidFieldValueError);
    expect(httpStatusHintOf(error)).toEqual({
      status: 400,
      title: 'Bad Request',
      detail: 'A supplied value does not fit the type of its field.',
    });
    expect((error as Error).message).not.toContain('canary-value');
  }
  expect(await source.findById('1')).toEqual({ id: '1', age: 1 });
  expect(await source.findById('2')).toBeNull();
});

it('M119e limits SQLite unknown-column mapping to payload keys for both message forms', async () => {
  const { D1_UNKNOWN_COLUMN_PATTERNS } = await import('../../src/database/d1-data-source.ts');
  const { UnknownPayloadFieldError } = await import('@setu-ts/common');
  const { RecordingD1 } = await import('../d1-fakes.ts');
  const messages = [
    'D1_ERROR: table users has no column named missing',
    'D1_ERROR: no such column: missing',
  ];
  expect(D1_UNKNOWN_COLUMN_PATTERNS).toHaveLength(messages.length);
  for (const [index, message] of messages.entries()) {
    expect(D1_UNKNOWN_COLUMN_PATTERNS[index]!.exec(message)?.[1]).toBe('missing');
    const db = new RecordingD1();
    const error = new Error(message);
    db.prepare = () => {
      throw error;
    };
    const source = createD1DataSource(db, { entity: 'users', table: 'users', primaryKey: ['id'] });
    await expect(source.create({ missing: 'private' })).rejects.toThrow(UnknownPayloadFieldError);
    await expect(source.updateWhere!('1', { missing: 'private' }, { age: 2 })).rejects.toBe(error);
  }
  for (const error of [
    new Error('connection unavailable'),
    'foreign rejection',
    new Error('no such column: not_payload'),
  ]) {
    const db = new RecordingD1();
    db.prepare = () => {
      throw error;
    };
    await expect(
      createD1DataSource(db, { entity: 'users', table: 'users', primaryKey: ['id'] }).create({
        age: 2,
      }),
    ).rejects.toBe(error);
  }
});

it('M119e maps a refusal raised at transaction commit like a direct write (audit F-1)', async () => {
  const { UnknownPayloadFieldError, InvalidFieldValueError, httpStatusHintOf } =
    await import('@setu-ts/common');
  const adapter = new D1Adapter(
    new SqliteD1('CREATE TABLE users (id TEXT PRIMARY KEY, age INTEGER) STRICT'),
    { tables: { User: { table: 'users' } } },
  );
  await adapter.connect();
  try {
    const commitWith = async (
      write: (source: ReturnType<typeof adapter.createDataSource>) => Promise<unknown>,
    ): Promise<unknown> => {
      const transaction = await adapter.beginTransaction();
      await write(transaction.createDataSource('User'));
      return transaction.commit().then(
        () => undefined,
        (error: unknown) => error,
      );
    };
    await adapter.createDataSource('User').create({ id: '1', age: 1 });

    const unknown = await commitWith((source) =>
      source.create({ id: '2', missing: 'canary-value' }),
    );
    expect(unknown).toBeInstanceOf(UnknownPayloadFieldError);
    expect((unknown as Error).message).toContain("Entity 'User'");
    expect(httpStatusHintOf(unknown)?.status).toBe(400);

    const strict = await commitWith((source) => source.update('1', { age: 'canary-value' }));
    expect(strict).toBeInstanceOf(InvalidFieldValueError);
    expect((strict as Error).message).not.toContain('canary-value');
    expect(httpStatusHintOf(strict)?.status).toBe(400);

    // The batch is atomic: neither refused write landed. Positive control: a
    // clean transaction still commits through the same path.
    expect(await adapter.createDataSource('User').findById('2')).toBeNull();
    expect(await commitWith((source) => source.create({ id: '3', age: 3 }))).toBeUndefined();
    expect(await adapter.createDataSource('User').findById('1')).toEqual({ id: '1', age: 1 });
    expect(await adapter.createDataSource('User').findById('3')).toEqual({ id: '3', age: 3 });
  } finally {
    await adapter.disconnect();
  }
});

it('M119e attributes a D1 refusal to the write whose payload it names', async () => {
  const { d1WriteRefusal } = await import('../../src/database/d1-data-source.ts');
  const { UnknownPayloadFieldError, InvalidFieldValueError } = await import('@setu-ts/common');
  const writes = [
    { entity: 'User', table: 'users', keys: ['id', 'age'] },
    { entity: 'Order', table: 'orders', keys: ['id', 'total'] },
  ];
  const unknown = d1WriteRefusal(new Error('D1_ERROR: no such column: total'), writes);
  expect(unknown).toBeInstanceOf(UnknownPayloadFieldError);
  expect(unknown?.message).toContain("Entity 'Order'");
  const strict = d1WriteRefusal(
    new Error(
      'D1_ERROR: cannot store TEXT value in INTEGER column orders.total: SQLITE_CONSTRAINT',
    ),
    writes,
  );
  expect(strict).toBeInstanceOf(InvalidFieldValueError);
  expect(strict?.message).toContain("Entity 'Order'");
  // No table.column in the message: attributable only when one write was sent.
  const bare = new Error('cannot store TEXT value in INTEGER column');
  expect(d1WriteRefusal(bare, writes)).toBeUndefined();
  expect(d1WriteRefusal(bare, [writes[0]!])).toBeInstanceOf(InvalidFieldValueError);
  // A STRICT refusal on a column no write carried, an unknown column no payload
  // names, and a non-Error rejection all stay unmapped.
  expect(
    d1WriteRefusal(new Error('cannot store TEXT value in INTEGER column users.total'), writes),
  ).toBeUndefined();
  expect(d1WriteRefusal(new Error('no such column: other'), writes)).toBeUndefined();
  expect(d1WriteRefusal('rejection', writes)).toBeUndefined();
});
