/**
 * Live-backend exercise for the Prisma adapter against PostgreSQL 16 — the
 * §6.1 behavioural commit of the §1A probes (P1, P2, P6, P7, P9, P10, P11).
 *
 * Guarded on `POSTGRES_URL`. The guard is the BDD `ignore` option, never an
 * early return inside the test body: with the variable unset the suite is
 * reported as IGNORED, and the ignored count in the summary is the only tell
 * that nothing ran (the M70c trap). §1B carries the container command.
 *
 * Prisma 7 fixture layout (recorded per §6.1, all under `test/fixtures/`):
 * - Schema:           `test/fixtures/prisma/schema.prisma` — carries BOTH
 *                     compound-key models, because the two behave
 *                     differently (P2: the named `@@id` rejects the derived
 *                     name its unnamed sibling would derive).
 * - CLI config:       `test/fixtures/prisma.config.ts` — schema,
 *                     migrations.path and datasource.url (a `url` in the
 *                     schema file fails validation with P1012).
 * - Generated client: `test/fixtures/prisma-client-generated/` — GIT-IGNORED;
 *                     the M70j precedent commits no generated client.
 * - Setup, run from `test/fixtures`:
 *   `DATABASE_URL=<POSTGRES_URL> npx prisma@7.10.0 db push && npx prisma@7.10.0 generate`
 *
 * The generated client is imported through a RUNTIME path (a variable dynamic
 * import) so `deno check` passes on a fresh clone where it has not been
 * generated yet; `PrismaPg` arrives through the same driver-adapter seam the
 * plan records — `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { FilterExpression, NormalizedQuery } from '@setu-ts/common';
import { PrismaAdapter } from '../../src/adapters/prisma/prisma-adapter.ts';
import { PrismaRepository } from '../../src/adapters/prisma/prisma-repository.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';
import type { PrismaAdapterOptions } from '../../src/interfaces/index.ts';

const postgresUrl = Deno.env.get('POSTGRES_URL');
/**
 * Whether the live cases run. Declared with the BDD `ignore` option rather
 * than an early `return`, so an unset `POSTGRES_URL` is reported as
 * **ignored** instead of as a passing test that exercised nothing (§6.1).
 */
const skipReal = postgresUrl === undefined;
/** The URL, narrowed for the guarded bodies; unused when `skipReal`. */
const url = postgresUrl ?? '';

/** The generated client's output path (relative to THIS file). */
const GENERATED_CLIENT_URL = new URL(
  '../fixtures/prisma-client-generated/client.ts',
  import.meta.url,
);

/** The structural surface of a generated model delegate this suite drives. */
interface ModelDelegate {
  findUnique(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

/** The structural surface of the generated client this suite drives. */
interface GeneratedPrismaClient {
  tenantMember: ModelDelegate;
  enrollment: ModelDelegate;
  auditEvent: ModelDelegate;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
}

/** The generated module's export this suite constructs. */
interface GeneratedClientModule {
  PrismaClient: new (options: { adapter: unknown }) => GeneratedPrismaClient;
}

/** A per-run discriminator keeping rows of one run out of another's asserts. */
const suffix = crypto.randomUUID().replaceAll('-', '');

function query(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return {
    where: partial.where ?? {},
    orderBy: partial.orderBy ?? {},
    limit: partial.limit ?? -1,
    offset: partial.offset ?? 0,
    select: partial.select ?? [],
    ...(partial.filter === undefined ? {} : { filter: partial.filter }),
    ...(partial.cursor === undefined ? {} : { cursor: partial.cursor }),
  };
}

/**
 * Construct and connect the REAL Prisma 7 client over the pg driver adapter.
 * Called inside each guarded body so a fresh clone (no generated client, no
 * container) never loads either import.
 */
async function connectPrisma(): Promise<GeneratedPrismaClient> {
  const [{ PrismaPg }, generated] = await Promise.all([
    import('npm:@prisma/adapter-pg@^7.10.0'),
    import(GENERATED_CLIENT_URL.href) as Promise<GeneratedClientModule>,
  ]);
  const client = new generated.PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  await client.$connect();
  return client;
}

describe('PrismaAdapter against live PostgreSQL (guarded)', () => {
  it(
    'round-trips a composite key through the repository surface on the unnamed-@@id model (P1/P6)',
    {
      ignore: skipReal,
    },
    async () => {
      const client = await connectPrisma();
      // P1: the derived compound-key field for an unnamed @@id is the column
      // names joined by `_` — `tenantId_userId`. Naming that derived field in
      // the options IS the P1 assertion; any other name misses the model.
      const options: PrismaAdapterOptions = {
        prismaClient: client,
        entities: {
          TenantMember: {
            compositeKeyName: 'tenantId_userId',
            keyColumns: ['tenantId', 'userId'],
          },
        },
      };
      const adapter = new PrismaAdapter(options);
      await adapter.connect();
      try {
        type TenantMemberId = { tenantId: string; userId: string };
        const repo = new PrismaRepository<
          { tenantId: string; userId: string; role: string },
          TenantMemberId
        >(adapter.createDataSource('TenantMember'));

        const key: TenantMemberId = { tenantId: `t-${suffix}`, userId: 'u1' };
        await repo.create({ tenantId: key.tenantId, userId: key.userId, role: 'admin' });

        const found = await repo.findById(key);
        expect(found?.role).toBe('admin');
        expect(found?.tenantId).toBe(key.tenantId);

        // P6: update returns the UPDATED ROW — not a count and not the old row.
        const updated = await repo.update(key, { role: 'owner' });
        expect(updated.role).toBe('owner');
        expect(updated.tenantId).toBe(key.tenantId);
        expect(updated.userId).toBe(key.userId);
        const reread = await repo.findById(key);
        expect(reread?.role).toBe('owner');

        // …and delete reports true (P6's delete half).
        expect(await repo.delete(key)).toBe(true);
        expect(await repo.findById(key)).toBeNull();
      } finally {
        await adapter.disconnect();
        await client.$disconnect();
      }
    },
  );

  it('refuses the named-@@id model without compositeKeyName and succeeds with it (P2)', {
    ignore: skipReal,
  }, async () => {
    const client = await connectPrisma();

    // The schema fact behind the refusal, probed on the raw delegate: the
    // derived `courseId_personId` field does not exist on the named-@@id
    // model, so addressing it that way is rejected by Prisma itself.
    await expect(
      client.enrollment.findUnique({
        where: { courseId_personId: { courseId: `c-${suffix}`, personId: 'p1' } },
      }),
    ).rejects.toThrow();

    // Without the override the adapter refuses BY NAME — the composite key
    // has no addressable field on this model.
    const bare = new PrismaAdapter({ prismaClient: client });
    await bare.connect();
    const bareSource = bare.createDataSource('Enrollment');
    await expect(
      bareSource.findById({ courseId: `c-${suffix}`, personId: 'p1' }),
    ).rejects.toThrow(UnsupportedQueryFeatureError);
    await bare.disconnect();

    // With the override the named key addresses the model — P2's fix.
    const configuredOptions: PrismaAdapterOptions = {
      prismaClient: client,
      entities: {
        Enrollment: { compositeKeyName: 'enrollmentKey', keyColumns: ['courseId', 'personId'] },
      },
    };
    const configured = new PrismaAdapter(configuredOptions);
    await configured.connect();
    try {
      type EnrollmentId = { courseId: string; personId: string };
      const repo = new PrismaRepository<
        { courseId: string; personId: string; grade: string },
        EnrollmentId
      >(configured.createDataSource('Enrollment'));
      const key: EnrollmentId = { courseId: `c-${suffix}`, personId: 'p1' };
      await repo.create({ courseId: key.courseId, personId: key.personId, grade: 'A' });
      expect((await repo.findById(key))?.grade).toBe('A');
      expect(await repo.delete(key)).toBe(true);
      expect(await repo.findById(key)).toBeNull();
    } finally {
      await configured.disconnect();
      await client.$disconnect();
    }
  });

  it(
    'matches a nested-path filter against real JSONB rows (P7)',
    { ignore: skipReal },
    async () => {
      const client = await connectPrisma();
      const adapter = new PrismaAdapter({ prismaClient: client });
      await adapter.connect();
      try {
        const source = adapter.createDataSource('AuditEvent');
        const run = `jsonb-${suffix}`;
        const cities = ['Kolkata', 'Kolkata', 'Kolkata', 'Mumbai'];
        for (const [i, city] of cities.entries()) {
          await source.create({
            id: `${run}-${i + 1}`,
            run,
            userId: `u${i + 1}`,
            createdAt: new Date('2026-01-15T10:00:00Z'),
            profile: { address: { city } },
          });
        }

        // P7: the two-segment path under the `profile` JSONB column matches the
        // three Kolkata rows and nothing else.
        const found = await source.findAll(query({
          where: { run },
          filter: {
            type: 'comparison',
            field: ['profile', 'address', 'city'],
            operator: 'eq',
            value: 'Kolkata',
          },
        }));
        expect(found.map((row) => row.id).sort()).toEqual([
          `${run}-1`,
          `${run}-2`,
          `${run}-3`,
        ]);
      } finally {
        await adapter.disconnect();
        await client.$disconnect();
      }
    },
  );

  it('filters a Date range over real timestamptz rows (P9)', { ignore: skipReal }, async () => {
    const client = await connectPrisma();
    const adapter = new PrismaAdapter({ prismaClient: client });
    await adapter.connect();
    try {
      const source = adapter.createDataSource('AuditEvent');
      const run = `dates-${suffix}`;
      const times = [
        new Date('2026-03-01T00:00:00Z'),
        new Date('2026-03-02T00:00:00Z'),
        new Date('2026-03-03T00:00:00Z'),
      ];
      for (const [i, createdAt] of times.entries()) {
        await source.create({
          id: `${run}-${i + 1}`,
          run,
          userId: `u${i + 1}`,
          createdAt,
          profile: {},
        });
      }

      // P9: the ordered arm carries a Date natively — `gte` from day two.
      const from = await source.findAll(query({
        where: { run },
        filter: {
          type: 'comparison',
          field: 'createdAt',
          operator: 'gte',
          value: new Date('2026-03-02T00:00:00Z'),
        },
      }));
      expect(from.map((row) => row.id).sort()).toEqual([`${run}-2`, `${run}-3`]);

      // …and strictly before day two.
      const before = await source.findAll(query({
        where: { run },
        filter: {
          type: 'comparison',
          field: 'createdAt',
          operator: 'lt',
          value: new Date('2026-03-02T00:00:00Z'),
        },
      }));
      expect(before.map((row) => row.id)).toEqual([`${run}-1`]);
    } finally {
      await adapter.disconnect();
      await client.$disconnect();
    }
  });

  it('walks a tied fixture across three pages returning every row exactly once (P10/P11)', {
    ignore: skipReal,
  }, async () => {
    const client = await connectPrisma();
    const adapter = new PrismaAdapter({ prismaClient: client });
    await adapter.connect();
    try {
      const source = adapter.createDataSource('AuditEvent');
      const run = `walk-${suffix}`;
      // The P11 fixture shape: six rows over only TWO distinct createdAt
      // values. The original P10 walk seeded distinct values, so the
      // tiebreaker branch never executed and the test would have passed
      // against a builder that omitted it entirely — ties are deliberate.
      const createdAt = [
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
      ];
      const ids = createdAt.map((_, i) => `w${i + 1}-${suffix}`);
      for (const [i, when] of createdAt.entries()) {
        await source.create({
          id: ids[i],
          run,
          userId: `u${i + 1}`,
          createdAt: when,
          profile: {},
        });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (let page = 0; page < 10; page++) {
        const result = await source.findPage!(query({
          where: { run },
          orderBy: { createdAt: 'desc' },
          limit: 2,
          ...(cursor === null ? {} : { cursor }),
        }));
        pages += 1;
        seen.push(...result.rows.map((row) => String(row.id)));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }

      // Every row exactly once: no duplicates, none skipped — 6 rows at limit
      // 2 is exactly 3 pages, and the last reports a null cursor.
      expect([...seen].sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(6);
      expect(pages).toBe(3);
    } finally {
      await adapter.disconnect();
      await client.$disconnect();
    }
  });

  it('LOSES rows on the tied fixture when the key tiebreaker is omitted (P11 negative control)', {
    ignore: skipReal,
  }, async () => {
    const client = await connectPrisma();
    const adapter = new PrismaAdapter({ prismaClient: client });
    await adapter.connect();
    try {
      const source = adapter.createDataSource('AuditEvent');
      const run = `naive-${suffix}`;
      const createdAt = [
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
      ];
      const ids = createdAt.map((_, i) => `n${i + 1}-${suffix}`);
      for (const [i, when] of createdAt.entries()) {
        await source.create({
          id: ids[i],
          run,
          userId: `u${i + 1}`,
          createdAt: when,
          profile: {},
        });
      }

      // The naive walk a builder WITHOUT the key appendix would produce: one
      // `createdAt < cursor` comparison per page, no key tiebreaker. P11's
      // poison is silence — the walk must complete without error AND lose
      // rows, asserted as a loss so a future change that makes the naive walk
      // correct by accident fails here.
      const seen: string[] = [];
      let cursorDate: Date | null = null;
      for (let page = 0; page < 10; page++) {
        const found = await source.findAll(query({
          where: { run },
          orderBy: { createdAt: 'desc' },
          limit: 2,
          ...(cursorDate === null ? {} : {
            filter: {
              type: 'comparison',
              field: 'createdAt',
              operator: 'lt',
              value: cursorDate,
            } as FilterExpression,
          }),
        }));
        if (found.length === 0) break;
        seen.push(...found.map((row) => String(row.id)));
        cursorDate = found[found.length - 1].createdAt as Date;
      }

      // Three late rows share one timestamp: page one takes two of them and
      // `createdAt < late` then hides the third forever. Page two takes two of
      // the three early rows, and `createdAt < early` hides the last one. Four
      // seen, two lost — one from each tie group.
      expect(seen.length).toBe(4);
      expect(new Set(seen).size).toBe(4);
      expect(ids.filter((id) => !seen.includes(id)).length).toBe(2);
    } finally {
      await adapter.disconnect();
      await client.$disconnect();
    }
  });
});
