/**
 * Unit tests for the name-collision guard.
 *
 * Both collisions this covers were observed as real failures against a booted
 * application, not reasoned about — see `src/utils/name-conflicts.ts`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { findNameConflict } from '../../../src/utils/name-conflicts.ts';

/** The plugin set both collision groups require to be present. */
const WITH_DECORATORS: ReadonlySet<string> = new Set(['decorator-plugin']);

describe('findNameConflict', () => {
  describe('the HTTP path group', () => {
    it('refuses a route whose name a controller already mounts', () => {
      const conflict = findNameConflict(
        'route',
        'widget',
        WITH_DECORATORS,
        { controller: ['widget'] },
        [],
      );
      expect(conflict?.schematic).toBe('controller');
      expect(conflict?.resource).toBe('the HTTP path /widget');
      expect(conflict?.consequence).toContain('silently unreachable');
    });

    it('refuses a controller whose name a route already mounts', () => {
      // Both directions: the guard is symmetric, so the order the developer generates in
      // cannot leave one pair unguarded.
      expect(
        findNameConflict('controller', 'widget', WITH_DECORATORS, { route: ['widget'] }, [])
          ?.schematic,
      ).toBe('route');
    });

    it('refuses a route whose name a domain module already mounts', () => {
      // Modules arrive through a separate scan, because a module is a directory holding
      // two specific files rather than one suffixed file.
      expect(
        findNameConflict('route', 'widget', WITH_DECORATORS, {}, ['widget'])?.schematic,
      ).toBe('module');
    });

    it('refuses a module whose name a controller already mounts', () => {
      expect(
        findNameConflict('module', 'widget', WITH_DECORATORS, { controller: ['widget'] }, [])
          ?.schematic,
      ).toBe('controller');
    });
  });

  describe('the injection-token group', () => {
    it('refuses a service whose token a domain module already registers', () => {
      // The defect that motivated the guard: both emit `token: 'widget-service'`, the
      // decorator plugin keeps the FIRST, and the module's controller was handed the
      // standalone service — a 500 on every request to that module.
      const conflict = findNameConflict('service', 'widget', WITH_DECORATORS, {}, ['widget']);
      expect(conflict?.schematic).toBe('module');
      expect(conflict?.resource).toBe("the injection token 'widget-service'");
      expect(conflict?.consequence).toContain('wrong service would be injected');
    });

    it('refuses a module whose token a service already registers', () => {
      expect(
        findNameConflict('module', 'widget', WITH_DECORATORS, { service: ['widget'] }, [])
          ?.resource,
      ).toBe("the injection token 'widget-service'");
    });
  });

  describe('what it must NOT refuse', () => {
    it('allows a second artifact of the same schematic', () => {
      // A repeat `setu g route widget` is the ordinary overwrite refusal, which reports
      // the file rather than a name clash — reporting both would be misleading.
      expect(findNameConflict('route', 'widget', WITH_DECORATORS, { route: ['widget'] }, []))
        .toBeUndefined();
    });

    it('allows a family in no collision group', () => {
      expect(
        findNameConflict('metric', 'widget', WITH_DECORATORS, {
          controller: ['widget'],
          service: ['widget'],
        }, ['widget']),
      ).toBeUndefined();
    });

    it('allows a name no other artifact claims', () => {
      expect(
        findNameConflict('route', 'widget', WITH_DECORATORS, { controller: ['gadget'] }, ['other']),
      ).toBeUndefined();
    });

    // Without `decorator-plugin` neither collision can exist: the service emits no
    // token at all, and `controller` and `module` are refused by their own gates. Firing
    // here would refuse a command in a project where the artifacts are inert.
    it('allows everything in a project without decorator-plugin', () => {
      expect(
        findNameConflict('service', 'widget', new Set(), {}, ['widget']),
      ).toBeUndefined();
      expect(
        findNameConflict('route', 'widget', new Set(), { controller: ['widget'] }, []),
      ).toBeUndefined();
    });

    it('allows a family whose scan reported nothing', () => {
      expect(findNameConflict('route', 'widget', WITH_DECORATORS, {}, [])).toBeUndefined();
    });
  });
});
