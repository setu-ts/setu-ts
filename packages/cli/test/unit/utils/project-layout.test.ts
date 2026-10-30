import { describe, expect, it } from 'vitest';
import { projectLayout } from '../../../src/utils/project-layout.ts';
import { diagnoseProject } from '../../../src/diagnostics/diagnose.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

describe('projectLayout', () => {
  it('starts flat without admitted modules, including old empty module barrels', async () => {
    for (const seed of [
      {},
      { '/app/src/modules/index.ts': '' },
      { '/app/src/modules/helpers/util.ts': '' },
      { '/app/src/controllers/orders.controller.ts': '' },
      { '/app/src/services/orders.service.ts': '' },
    ]) {
      expect(await projectLayout(createFakeFs(seed), '/app')).toBe('flat');
    }
  });

  for (const style of ['functional', 'class-based'] as const) {
    const declaration =
      style === 'functional'
        ? { '/app/src/modules/shipment/index.ts': 'export function registerShipmentModule() {}' }
        : { '/app/src/modules/shipment/shipment.module.ts': 'export class ShipmentModule {}' };
    const manifest = {
      '/app/package.json': JSON.stringify({
        dependencies: style === 'functional' ? {} : { '@setu-ts/decorator-plugin': '^0.10.0' },
      }),
    };
    const seed = { ...declaration, ...manifest };

    it(`detects ${style} modules by declaration, with empty flat barrels ignored`, async () => {
      const fs = createFakeFs({
        ...seed,
        '/app/src/controllers/index.ts': '// empty',
        '/app/src/services/index.ts': '// empty',
      });
      expect(await projectLayout(fs, '/app')).toBe('modular');
      const diagnosis = await diagnoseProject(
        fs,
        '/app',
        new Set(style === 'functional' ? [] : ['decorator-plugin']),
      );
      expect(diagnosis.layout).toBe('modular');
      expect(diagnosis.modules).toEqual(['shipment']);
      expect(fs.writes).toEqual([]);
    });

    for (const file of [
      'src/controllers/orders.controller.ts',
      'src/controllers/billing/invoices.controller.ts',
      'src/services/orders.service.ts',
      'src/services/billing/invoices.service.ts',
    ]) {
      it(`detects mixed ${style} layout with ${file}, even before export admission`, async () => {
        const fs = createFakeFs({ ...seed, [`/app/${file}`]: '// user file' });
        expect(await projectLayout(fs, '/app')).toBe('mixed');
        const diagnosis = await diagnoseProject(
          fs,
          '/app',
          new Set(style === 'functional' ? [] : ['decorator-plugin']),
        );
        expect(diagnosis.layout).toBe('mixed');
      });
    }

    it(`does not mistake unrelated files for a mixed ${style} layout`, async () => {
      expect(
        await projectLayout(
          createFakeFs({
            ...seed,
            '/app/src/controllers/README.md': '',
            '/app/src/services/helper.ts': '',
          }),
          '/app',
        ),
      ).toBe('modular');
    });
  }
});
