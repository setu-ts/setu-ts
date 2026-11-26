/**
 * Prisma conditional writes under `relationMode = "prisma"`: refused on the
 * count path, read from the client's datasource block at `connect()`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IPluginContext } from '@setu-ts/common';
import type { IDatabaseService } from '../../src/index.ts';
import {
  createPrismaDataSource,
  PrismaAdapter,
  relationModeOf,
} from '../../src/adapters/prisma/prisma-adapter.ts';
import {
  DatabasePlugin,
  deleteVersioned,
  UnsupportedRelationModeError,
  updateVersioned,
} from '../../src/index.ts';
import { DatabaseService } from '../../src/services/database-service.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';

/** A generated client's datasource block, as Prisma writes it into `inlineSchema`. */
function schemaWith(datasourceLines: readonly string[]): string {
  return [
    'generator client {',
    '  provider = "prisma-client"',
    '}',
    '',
    'datasource db {',
    ...datasourceLines,
    '}',
    '',
    'model User {',
    '  id   String  @id',
    '  name String?',
    '}',
    '',
  ].join('\n');
}

const PRISMA_MODE = schemaWith(['  provider     = "mysql"', '  relationMode = "prisma"']);

/** The fake client with the generated client's `_engineConfig.inlineSchema`. */
function clientWith(
  provider: string,
  inlineSchema?: string,
): ReturnType<typeof createFakePrismaClient> & { _engineConfig?: { inlineSchema: string } } {
  return createFakePrismaClient({ activeProvider: provider, inlineSchema: inlineSchema ?? null });
}

describe('relationModeOf', () => {
  const cases: readonly [string, unknown, string | undefined][] = [
    ['an explicit "prisma"', { _engineConfig: { inlineSchema: PRISMA_MODE } }, 'prisma'],
    [
      'an explicit "foreignKeys"',
      {
        _engineConfig: {
          inlineSchema: schemaWith(['  provider = "mysql"', '  relationMode = "foreignKeys"']),
        },
      },
      'foreignKeys',
    ],
    [
      'a datasource block without the setting (the default)',
      { _engineConfig: { inlineSchema: schemaWith(['  provider = "mysql"']) } },
      'foreignKeys',
    ],
    [
      'a commented-out setting and a trailing comment',
      {
        _engineConfig: {
          inlineSchema: schemaWith([
            '  provider = "mysql" // relationMode = "prisma"',
            '  // relationMode = "prisma"',
          ]),
        },
      },
      'foreignKeys',
    ],
    [
      'a setting outside the datasource block',
      {
        _engineConfig: {
          inlineSchema:
            '// relationMode = "prisma"\nmodel A {\n  relationMode = "prisma"\n}\n' +
            'datasource db {\r\n  provider = "mysql"\r\n}\r\nmodel B {\n  relationMode = "prisma"\n}\n',
        },
      },
      'foreignKeys',
    ],
    [
      'the deprecated referentialIntegrity name',
      {
        _engineConfig: {
          inlineSchema: schemaWith(['  provider = "mysql"', '  referentialIntegrity = "prisma"']),
        },
      },
      'prisma',
    ],
    [
      'a header carrying a trailing comment',
      {
        _engineConfig: {
          inlineSchema:
            'datasource db { // primary\n  provider = "mysql"\n  relationMode = "prisma"\n}\n',
        },
      },
      'prisma',
    ],
    [
      'a header whose brace is on the next line (unreadable)',
      {
        _engineConfig: { inlineSchema: 'datasource db\n{\n  relationMode = "prisma"\n}\n' },
      },
      undefined,
    ],
    [
      'a datasource key outside the known list (unreadable)',
      {
        _engineConfig: {
          inlineSchema: schemaWith(['  provider = "mysql"', '  someFutureKey = "x"']),
        },
      },
      undefined,
    ],
    [
      'a relationMode value that is not a plain string (unreadable)',
      { _engineConfig: { inlineSchema: schemaWith(['  relationMode = env("MODE")']) } },
      undefined,
    ],
    [
      'a schema with no datasource block',
      { _engineConfig: { inlineSchema: 'model A {}' } },
      undefined,
    ],
    ['a non-string inlineSchema', { _engineConfig: { inlineSchema: 42 } }, undefined],
    ['a null _engineConfig', { _engineConfig: null }, undefined],
    ['no _engineConfig', {}, undefined],
    ['a null client', null, undefined],
  ];
  for (const [label, client, expected] of cases)
    it(`reads ${label}`, () => expect(relationModeOf(client)).toBe(expected));

  it('reads through an extended client, which forwards to the base client', () => {
    const base = { _engineConfig: { inlineSchema: PRISMA_MODE } };
    const extended = new Proxy(Object.create(null) as object, {
      get: (_target, key) => Reflect.get(base, key),
    });
    expect(relationModeOf(extended)).toBe('prisma');
  });
});

describe('Prisma conditional writes under relationMode "prisma"', () => {
  for (const provider of ['mysql', 'sqlite', 'sqlserver', 'cockroachdb', 'unknown'] as const) {
    it(`refuses all four conditional writes by name on ${provider}, before any I/O`, async () => {
      const client = clientWith(provider, PRISMA_MODE);
      const adapter = new PrismaAdapter({ prismaClient: client });
      await adapter.connect();
      const database = new DatabaseService(
        adapter,
        (entity) => adapter.createDataSource(entity),
        'prisma',
      );
      const repo = database.getRepository<{ id: string; name: string; version?: number }>('User');
      await repo.create({ id: 'a', name: 'old', version: 1 });
      const calls = [
        () => repo.updateWhere!('a', { name: 'old' }, { name: 'new' }),
        () => repo.deleteWhere!('a', { name: 'old' }),
        () => updateVersioned(repo, 'a', 1, { name: 'new' }),
        () => deleteVersioned(repo, 'a', 1),
      ];
      for (const call of calls) {
        const error = await call().then(
          () => undefined,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(UnsupportedRelationModeError);
        const refusal = error as UnsupportedRelationModeError;
        expect(refusal.name).toBe('UnsupportedRelationModeError');
        expect(refusal.relationMode).toBe('prisma');
        expect(refusal.message).toContain('relationMode = "prisma"');
        expect(refusal.message).toContain('a lost race would read as success');
        expect(refusal.message).toContain('relationMode = "foreignKeys"');
        expect(refusal.message).toContain('prisma/orm#30758');
        expect(refusal.message).toContain('prisma-engines#5868');
        expect(refusal.message).toContain(
          provider === 'unknown' ? "connector 'undetermined'" : `connector '${provider}'`,
        );
      }
      expect(
        client.recordedCalls.filter((call) => ['updateMany', 'deleteMany'].includes(call.action)),
      ).toEqual([]);
      expect(await repo.findById('a')).toEqual({ id: 'a', name: 'old', version: 1 });
      await database.close();
    });
  }

  it('names the call and the entity', async () => {
    const adapter = new PrismaAdapter({ prismaClient: clientWith('mysql', PRISMA_MODE) });
    await adapter.connect();
    const source = adapter.createDataSource('User');
    await expect(source.updateWhere!('a', { name: 'x' }, { name: 'y' })).rejects.toThrow(
      "Prisma updateWhere on 'User' is refused",
    );
    await expect(source.deleteWhere!('a', { name: 'x' })).rejects.toThrow(
      "Prisma deleteWhere on 'User' is refused",
    );
    await adapter.disconnect();
  });

  it('refuses on a unit of work data source too', async () => {
    const client = clientWith('mysql', PRISMA_MODE);
    const adapter = new PrismaAdapter({ prismaClient: client });
    await adapter.connect();
    const handle = await adapter.beginTransaction();
    const source = handle.createDataSource('User');
    await expect(source.updateWhere!('a', { name: 'x' }, { name: 'y' })).rejects.toBeInstanceOf(
      UnsupportedRelationModeError,
    );
    await expect(source.deleteWhere!('a', { name: 'x' })).rejects.toBeInstanceOf(
      UnsupportedRelationModeError,
    );
    await handle.rollback();
    await adapter.disconnect();
  });

  it('reads the mode from an injected extended client', async () => {
    const base = clientWith('mysql', PRISMA_MODE);
    const extended = new Proxy(base, {});
    const adapter = new PrismaAdapter({ prismaClient: extended });
    await adapter.connect();
    await expect(
      adapter.createDataSource('User').deleteWhere!('a', { name: 'x' }),
    ).rejects.toBeInstanceOf(UnsupportedRelationModeError);
    await adapter.disconnect();
  });

  it('refuses through createPrismaDataSource on the count path only', async () => {
    const mysql = clientWith('mysql', PRISMA_MODE);
    await expect(
      createPrismaDataSource(mysql, 'User', 'mysql').updateWhere!(
        'a',
        { name: 'x' },
        { name: 'y' },
      ),
    ).rejects.toBeInstanceOf(UnsupportedRelationModeError);
    const postgres = clientWith('postgresql', PRISMA_MODE);
    const source = createPrismaDataSource(postgres, 'User', 'postgresql');
    await source.create({ id: 'a', name: 'x' });
    expect(await source.updateWhere!('a', { name: 'x' }, { name: 'y' })).toEqual({
      id: 'a',
      name: 'y',
    });
  });

  for (const provider of ['postgresql', 'postgres'] as const) {
    it(`leaves the single-statement path on ${provider} unaffected, with no warn`, async () => {
      for (const client of [clientWith(provider, PRISMA_MODE), clientWith(provider)]) {
        const warnings: string[] = [];
        const adapter = new PrismaAdapter({ prismaClient: client }, (m) => warnings.push(m));
        await adapter.connect();
        const source = adapter.createDataSource('User');
        await source.create({ id: 'a', name: 'old' });
        expect(await source.updateWhere!('a', { name: 'old' }, { name: 'new' })).toEqual({
          id: 'a',
          name: 'new',
        });
        expect(await source.deleteWhere!('a', { name: 'new' })).toBe(true);
        expect(warnings).toEqual([]);
        await adapter.disconnect();
      }
    });
  }

  it('lets an explicit provider decide the path', async () => {
    const client = clientWith('mysql', PRISMA_MODE);
    const adapter = new PrismaAdapter({ prismaClient: client, provider: 'postgresql' });
    await adapter.connect();
    const source = adapter.createDataSource('User');
    await source.create({ id: 'a', name: 'old' });
    expect(await source.deleteWhere!('a', { name: 'old' })).toBe(true);
    await adapter.disconnect();
  });
});

describe('Prisma conditional writes under the default relationMode', () => {
  for (const lines of [
    ['  provider = "mysql"'],
    ['  provider = "mysql"', '  relationMode = "foreignKeys"'],
  ]) {
    it(`run on the count path with ${lines.length === 1 ? 'no setting' : 'foreignKeys'}`, async () => {
      const warnings: string[] = [];
      const client = clientWith('mysql', schemaWith(lines));
      const adapter = new PrismaAdapter({ prismaClient: client }, (m) => warnings.push(m));
      await adapter.connect();
      const source = adapter.createDataSource('User');
      await source.create({ id: 'a', name: 'old' });
      expect(await source.updateWhere!('a', { name: 'old' }, { name: 'new' })).toEqual({
        id: 'a',
        name: 'new',
      });
      expect(await source.deleteWhere!('a', { name: 'new' })).toBe(true);
      expect(client.recordedCalls.map((call) => call.action)).toContain('updateMany');
      expect(warnings).toEqual([]);
      await adapter.disconnect();
    });
  }

  it('refuses all four conditional writes when the mode cannot be read, warning once', async () => {
    const warnings: string[] = [];
    const client = clientWith('mysql');
    const adapter = new PrismaAdapter({ prismaClient: client }, (m) => warnings.push(m));
    await adapter.connect();
    await adapter.disconnect();
    await adapter.connect();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('could not read');
    expect(warnings[0]).toContain(
      "They are refused until the options assert relationMode: 'foreignKeys'",
    );
    const database = new DatabaseService(
      adapter,
      (entity) => adapter.createDataSource(entity),
      'prisma',
    );
    const repo = database.getRepository<{ id: string; name: string; version?: number }>('User');
    await repo.create({ id: 'a', name: 'old', version: 1 });
    for (const call of [
      () => repo.updateWhere!('a', { name: 'old' }, { name: 'new' }),
      () => repo.deleteWhere!('a', { name: 'old' }),
      () => updateVersioned(repo, 'a', 1, { name: 'new' }),
      () => deleteVersioned(repo, 'a', 1),
    ]) {
      const error = (await call().then(
        () => undefined,
        (reason: unknown) => reason,
      )) as UnsupportedRelationModeError;
      expect(error).toBeInstanceOf(UnsupportedRelationModeError);
      expect(error.relationMode).toBeUndefined();
      expect(error.message).toContain('relationMode could not be read');
      expect(error.message).toContain(
        "add relationMode: 'foreignKeys' to the Prisma adapter options",
      );
      expect(error.message).toContain(
        'set relationMode = "foreignKeys" in a schema the adapter can read',
      );
    }
    expect(client.recordedCalls.some((call) => call.action === 'updateMany')).toBe(false);
    await database.close();
  });

  it('refuses an unreadable mode on an adapter with no warn sink', async () => {
    const adapter = new PrismaAdapter({ prismaClient: clientWith('sqlite') });
    await adapter.connect();
    await expect(
      adapter.createDataSource('User').updateWhere!('a', { name: 'x' }, { name: 'y' }),
    ).rejects.toBeInstanceOf(UnsupportedRelationModeError);
    const handle = await adapter.beginTransaction();
    await expect(
      handle.createDataSource('User').deleteWhere!('a', { name: 'x' }),
    ).rejects.toBeInstanceOf(UnsupportedRelationModeError);
    await handle.rollback();
    await adapter.disconnect();
  });

  it("runs conditional writes on an unreadable mode once the options assert 'foreignKeys'", async () => {
    const warnings: string[] = [];
    const client = clientWith('mysql');
    const adapter = new PrismaAdapter({ prismaClient: client, relationMode: 'foreignKeys' }, (m) =>
      warnings.push(m),
    );
    await adapter.connect();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "They run because the options assert relationMode: 'foreignKeys'",
    );
    const source = adapter.createDataSource('User');
    await source.create({ id: 'a', name: 'old' });
    expect(await source.updateWhere!('a', { name: 'old' }, { name: 'new' })).toEqual({
      id: 'a',
      name: 'new',
    });
    expect(await source.deleteWhere!('a', { name: 'new' })).toBe(true);
    await adapter.disconnect();
  });

  it('keeps a schema read as "prisma" refused under the \'foreignKeys\' assertion', async () => {
    const adapter = new PrismaAdapter({
      prismaClient: clientWith('mysql', PRISMA_MODE),
      relationMode: 'foreignKeys',
    });
    await adapter.connect();
    const error = (await adapter.createDataSource('User').deleteWhere!('a', { name: 'x' }).catch(
      (reason: unknown) => reason,
    )) as UnsupportedRelationModeError;
    expect(error).toBeInstanceOf(UnsupportedRelationModeError);
    expect(error.relationMode).toBe('prisma');
    await adapter.disconnect();
    await expect(
      createPrismaDataSource(
        clientWith('mysql', PRISMA_MODE),
        'User',
        'mysql',
        undefined,
        undefined,
        {
          relationMode: 'foreignKeys',
        },
      ).updateWhere!('a', { name: 'x' }, { name: 'y' }),
    ).rejects.toBeInstanceOf(UnsupportedRelationModeError);
  });

  it('applies the unreadable-mode rule on createPrismaDataSource', async () => {
    await expect(
      createPrismaDataSource(clientWith('mysql'), 'User', 'mysql').deleteWhere!('a', { name: 'x' }),
    ).rejects.toThrow('relationMode could not be read');
    const source = createPrismaDataSource(
      clientWith('mysql'),
      'User',
      'mysql',
      undefined,
      undefined,
      {
        relationMode: 'foreignKeys',
      },
    );
    await source.create({ id: 'a', name: 'x' });
    expect(await source.deleteWhere!('a', { name: 'x' })).toBe(true);
    expect(
      await createPrismaDataSource(clientWith('postgresql'), 'User', 'postgresql').deleteWhere!(
        'a',
        {
          name: 'x',
        },
      ),
    ).toBe(false);
  });

  it('carries the assertion through DatabasePlugin', async () => {
    const { createApplication } = await import('@setu-ts/kernel');
    const { RuntimePlugin } = await import('@setu-ts/runtime');
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DatabasePlugin({
          type: 'prisma',
          options: { prismaClient: clientWith('mysql'), relationMode: 'foreignKeys' },
        }),
      ],
    });
    await app.start();
    const database = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    const repo = database.getRepository<{ id: string; name: string }>('User');
    await repo.create({ id: 'a', name: 'x' });
    expect(await repo.deleteWhere!('a', { name: 'x' })).toBe(true);
    await app.stop();
  });

  it('clears an earlier refusal when the client is read again at connect', async () => {
    const client = clientWith('mysql', PRISMA_MODE);
    const adapter = new PrismaAdapter({ prismaClient: client });
    await adapter.connect();
    await expect(
      adapter.createDataSource('User').deleteWhere!('a', { name: 'x' }),
    ).rejects.toBeInstanceOf(UnsupportedRelationModeError);
    await adapter.disconnect();
    client._engineConfig!.inlineSchema = schemaWith(['  provider = "mysql"']);
    await adapter.connect();
    expect(await adapter.createDataSource('User').deleteWhere!('a', { name: 'x' })).toBe(false);
    await adapter.disconnect();
  });

  it('logs the unread-mode warn through the plugin logger', async () => {
    const { createApplication } = await import('@setu-ts/kernel');
    const { RuntimePlugin } = await import('@setu-ts/runtime');
    const logs: string[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        {
          name: 'logger',
          version: '1.0.0',
          provides: [CAPABILITIES.LOGGER],
          register(ctx: IPluginContext) {
            ctx.services.register(CAPABILITIES.LOGGER, {
              warn: (message: string) => logs.push(message),
            } as unknown as ILogger);
          },
        },
        DatabasePlugin({ type: 'prisma', options: { prismaClient: clientWith('mysql') } }),
      ],
    });
    await app.start();
    expect(logs.filter((message) => message.includes('relationMode'))).toHaveLength(1);
    await app.stop();
  });
});
