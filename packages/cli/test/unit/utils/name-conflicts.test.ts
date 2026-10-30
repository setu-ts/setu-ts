import { describe, expect, it } from 'vitest';
import { findNameConflict } from '../../../src/utils/name-conflicts.ts';

describe('one controller family name conflicts', () => {
  for (const plugins of [new Set<string>(), new Set(['decorator-plugin'])]) {
    for (const name of ['orders', 'invoices']) {
      for (const schematic of ['controller', 'route']) {
        it(`${schematic} ${name} uses the ordinary overwrite refusal for the same controller file (${[...plugins]})`, () => {
          expect(
            findNameConflict(schematic, name, plugins, { controller: [name] }, []),
          ).toBeUndefined();
          expect(
            findNameConflict(schematic, name, plugins, { controller: [name] }, [], 'shipment'),
          ).toBeUndefined();
        });
        it(`${schematic} ${name} refuses the same base name in a subfolder (${[...plugins]})`, () => {
          for (const module of [undefined, 'shipment']) {
            expect(
              findNameConflict(
                schematic,
                name,
                plugins,
                { controller: [`nested/${name}`] },
                [],
                module,
              ),
            ).toEqual({
              claimedBy: `the controller at nested/${name}`,
              resource: `the generated binding for ${name}`,
              consequence: 'each artifact in a family must have a unique base name',
              remedy: `rename or remove nested/${name}`,
            });
          }
        });
        it(`${schematic} ${name} refuses a module that already mounts the same HTTP path (${[...plugins]})`, () => {
          expect(findNameConflict(schematic, name, plugins, {}, [name])).toMatchObject({
            claimedBy: 'the module of the same name',
            resource: `the HTTP path /${name}`,
          });
        });
      }
      it(`module ${name} refuses a controller with that path (${[...plugins]})`, () => {
        expect(
          findNameConflict('module', name, plugins, { controller: [`nested/${name}`] }, []),
        ).toMatchObject({
          claimedBy: 'the controller of the same name',
          resource: `the HTTP path /${name}`,
        });
      });
      it(`SSE ${name} shares the controller filename namespace (${[...plugins]})`, () => {
        expect(
          findNameConflict('sse', name, plugins, { controller: [`nested/${name}`] }, [])?.claimedBy,
        ).toBe(`the controller at nested/${name}`);
        expect(findNameConflict('sse', name, plugins, {}, [name])).toBeUndefined();
      });
    }
  }

  it('keeps injection-token collisions specific to class-based services', () => {
    for (const name of ['orders', 'invoices']) {
      const decorated = new Set(['decorator-plugin']);
      expect(findNameConflict('service', name, decorated, {}, [name])?.resource).toBe(
        `the injection token '${name}-service'`,
      );
      expect(findNameConflict('module', name, decorated, { service: [name] }, [])?.resource).toBe(
        `the injection token '${name}-service'`,
      );
      expect(findNameConflict('service', name, new Set(), {}, [name])).toBeUndefined();
    }
  });

  it('allows unrelated families, names and empty scans', () => {
    expect(
      findNameConflict(
        'metric',
        'orders',
        new Set(),
        { controller: ['orders'], service: ['orders'] },
        ['orders'],
      ),
    ).toBeUndefined();
    expect(
      findNameConflict('controller', 'tracking', new Set(), { controller: ['orders'] }, [
        'shipment',
      ]),
    ).toBeUndefined();
    expect(findNameConflict('route', 'tracking', new Set(), {}, [])).toBeUndefined();
    expect(
      findNameConflict('service', 'orders', new Set(), { controller: ['orders'] }, []),
    ).toBeUndefined();
  });
});
