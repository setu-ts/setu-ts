import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { EntityKey, WritePrecondition } from '@setu-ts/common';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { DatabaseService } from '../../src/services/database-service.ts';

describe('DatabaseService conditional members', () => {
  for (const logQueries of [true, false]) {
    it(`binds prototype members with logQueries=${logQueries} without logging values`, async () => {
      const adapter = new MemoryAdapter();
      const inner = adapter.createDataSource('User');
      class Source {
        readonly token = 'receiver';
        updateWhere(id: EntityKey, where: WritePrecondition, data: Record<string, unknown>) {
          expect(this.token).toBe('receiver');
          return inner.updateWhere!(id, where, data);
        }
        deleteWhere(id: EntityKey, where: WritePrecondition) {
          expect(this.token).toBe('receiver');
          return inner.deleteWhere!(id, where);
        }
      }
      const { updateWhere: _update, deleteWhere: _delete, ...plain } = inner;
      const source = Object.assign(new Source(), plain);
      const logs: { message: string; context: unknown }[] = [];
      const service = new DatabaseService(adapter, () => source, 'memory', { logQueries }, {
        debug: (message, context) => logs.push({ message, context }),
      }, () => 42);
      await inner.create({ id: 'a', name: 'secret' });
      const repo = service.getRepository('User');
      expect(await repo.updateWhere!('a', { name: 'secret' }, { name: 'private' })).toMatchObject({
        name: 'private',
      });
      expect(await repo.deleteWhere!('a', { name: 'private' })).toBe(true);
      expect(logs.length).toBe(logQueries ? 2 : 0);
      expect(JSON.stringify(logs)).not.toMatch(/secret|private/);
      if (logQueries) {
        expect(logs.map((log) => log.context)).toEqual([
          { operation: 'updateWhere', durationMs: 0 },
          { operation: 'deleteWhere', durationMs: 0 },
        ]);
      }
    });
  }
  it('keeps absent members absent and propagates classified failures', async () => {
    const adapter = new MemoryAdapter();
    const source = adapter.createDataSource('User');
    const error = new Error('disk');
    const service = new DatabaseService(
      adapter,
      () => ({
        ...source,
        updateWhere: () => Promise.reject(error),
        deleteWhere: () => Promise.reject(error),
      }),
      'memory',
    );
    const repo = service.getRepository('User');
    await expect(repo.updateWhere!('a', { name: 'x' }, { name: 'y' })).rejects.toBe(error);
    await expect(repo.deleteWhere!('a', { name: 'x' })).rejects.toBe(error);
  });
});
