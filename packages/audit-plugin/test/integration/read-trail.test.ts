import { describe, expect, it } from 'vitest';
import { CAPABILITIES, type IAuditLogger } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuditPlugin, DatabaseAuditStorage, type IAuditDbClient } from '../../src/index.ts';

describe('reading the database audit trail', () => {
  it('reads plugin writes through a separately constructed reader over the same client/table', async () => {
    const rows: Record<string, unknown>[] = [];
    const selects: { table: string; where: Record<string, unknown> | undefined }[] = [];
    const client: IAuditDbClient = {
      insert(table, row) {
        expect(table).toBe('owner_trail');
        rows.push(structuredClone(row));
        return Promise.resolve();
      },
      select(table, where) {
        selects.push({ table, where });
        return Promise.resolve(
          rows.filter((row) =>
            Object.entries(where ?? {}).every(([key, value]) => row[key] === value),
          ),
        );
      },
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        AuditPlugin({ storage: 'database', options: { client, table: 'owner_trail' } }),
      ],
    });
    await app.start();
    try {
      const audit = app.services.get<IAuditLogger>(CAPABILITIES.AUDIT);
      await audit.log({
        action: 'order.pay',
        resource: 'order',
        resourceId: 'o1',
        userId: 'owner',
        result: 'success',
        before: { paid: false },
        after: { paid: true },
        metadata: { source: 'web' },
      });
      await audit.log({
        action: 'order.pay',
        resource: 'order',
        resourceId: 'o2',
        result: 'success',
      });
      expect(rows[0]?.before).toBe('{"paid":false}');
      expect(rows[0]?.after).toBe('{"paid":true}');
      expect(rows[0]?.metadata).toBe('{"source":"web"}');
      expect(typeof rows[0]?.timestamp).toBe('number');
      const reader = new DatabaseAuditStorage({ client, table: 'owner_trail' });
      const trail = await reader.query({ resource: 'order', userId: 'owner', from: 0, limit: 1 });
      expect(selects.at(-1)).toEqual({
        table: 'owner_trail',
        where: { resource: 'order', user_id: 'owner' },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        id: rows[0]?.id,
        timestamp: rows[0]?.timestamp,
        action: 'order.pay',
        resourceId: 'o1',
        userId: 'owner',
        before: { paid: false },
        after: { paid: true },
        metadata: { source: 'web' },
      });
      expect(Object.isFrozen(trail[0])).toBe(true);
    } finally {
      await app.stop();
    }
  });
});
