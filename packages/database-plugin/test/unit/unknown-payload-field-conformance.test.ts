import { describe, expect, it } from 'vitest';
import { UnknownPayloadFieldError as CommonUnknown } from '@setu-ts/common';
import { UnknownPayloadFieldError } from '../../src/index.ts';
import { sources } from '../fixtures/conditional-sources.ts';

it('re-exports the identical portable error class', () => {
  expect(UnknownPayloadFieldError).toBe(CommonUnknown);
});
for (const fixture of sources.filter((source) => source.name !== 'prisma')) {
  describe(`${fixture.name} unknown payload fields`, () => {
    it('pins create, update and conditional update behaviour with readbacks', async () => {
      const source = fixture.make();
      const refused = fixture.name === 'drizzle' || fixture.name === 'd1';
      await source.create({ id: '1', name: 'before', role: 'owner' });
      for (const write of [
        () => source.create({ id: '2', extra: 'created' }),
        () => source.update('1', { extra: 'updated' }),
        () => source.updateWhere!('1', { role: 'owner' }, { extra: 'conditional' }),
      ]) {
        if (refused) await expect(write()).rejects.toThrow(CommonUnknown);
        else await expect(write()).resolves.toHaveProperty('extra');
      }
      expect(await source.findById('1')).toMatchObject(
        refused ? { name: 'before' } : { extra: 'conditional' },
      );
      expect(await source.findById('2')).toEqual(
        refused ? null : expect.objectContaining({ extra: 'created' }),
      );
    });
  });
}
