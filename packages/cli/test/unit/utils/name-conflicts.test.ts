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
      expect(conflict?.claimedBy).toBe('the controller of the same name');
      expect(conflict?.resource).toBe('the HTTP path /widget');
      expect(conflict?.consequence).toContain('silently unreachable');
    });

    it('refuses a controller whose name a route already mounts', () => {
      // Both directions: the guard is symmetric, so the order the developer generates in
      // cannot leave one pair unguarded.
      expect(
        findNameConflict('controller', 'widget', WITH_DECORATORS, { route: ['widget'] }, [])
          ?.claimedBy,
      ).toBe('the route of the same name');
    });

    it('refuses a route whose name a domain module already mounts', () => {
      // Modules arrive through a separate scan, because a module is a directory holding
      // two specific files rather than one suffixed file.
      expect(
        findNameConflict('route', 'widget', WITH_DECORATORS, {}, ['widget'])?.claimedBy,
      ).toBe('the module of the same name');
    });

    it('refuses a module whose name a controller already mounts', () => {
      expect(
        findNameConflict('module', 'widget', WITH_DECORATORS, { controller: ['widget'] }, [])
          ?.claimedBy,
      ).toBe('the controller of the same name');
    });
  });

  describe('the injection-token group', () => {
    it('refuses a service whose token a domain module already registers', () => {
      // The defect that motivated the guard: both emit `token: 'widget-service'`, the
      // decorator plugin keeps the FIRST, and the module's controller was handed the
      // standalone service — a 500 on every request to that module.
      const conflict = findNameConflict('service', 'widget', WITH_DECORATORS, {}, ['widget']);
      expect(conflict?.claimedBy).toBe('the module of the same name');
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

    // The injection-token group is genuinely decorator-only: a functional service is a
    // plain function registered under no token, so there is nothing to collide over.
    it('allows a service/module token clash in a project without decorator-plugin', () => {
      expect(
        findNameConflict('service', 'widget', new Set(), {}, ['widget']),
      ).toBeUndefined();
    });
  });

  // This whole block is a regression suite. The guard used to return early for ANY
  // project without `decorator-plugin`, and a test here asserted that — with a comment
  // claiming `controller` and `module` were "refused by their own gates". M65 ungated
  // `module`, this milestone ungated `controller`, and E8 merged `src/routes/` into
  // `src/controllers/`, so by the time the guard ran the premise was false three times
  // over. Measured against a real scaffold: `g route widget` then `g controller widget`
  // both reported success and left a barrel with
  // `import { registerWidgetRoutes } from './widget.controller.ts';` beside
  // `import { registerWidgetRoutes } from './widget.routes.ts';` — TS2300, twice, so the
  // generated project did not compile.
  describe('the HTTP path group in a FUNCTIONAL project', () => {
    /** A functional project: no decorator-plugin, so only the path group applies. */
    const FUNCTIONAL: ReadonlySet<string> = new Set(['runtime']);

    it('refuses a controller whose name a route already mounts', () => {
      const conflict = findNameConflict('controller', 'widget', FUNCTIONAL, {
        route: ['widget'],
      }, []);

      expect(conflict?.claimedBy).toBe('the route of the same name');
      expect(conflict?.resource).toBe('the HTTP path /widget');
      // The functional failure is louder than the decorator one and the refusal says so:
      // both files export `registerWidgetRoutes` into one barrel.
      expect(conflict?.consequence).toContain('would not compile');
    });

    it('refuses a route whose name a controller already mounts', () => {
      // Symmetric, so the order the developer generates in cannot leave a pair unguarded.
      expect(
        findNameConflict('route', 'widget', FUNCTIONAL, { controller: ['widget'] }, [])
          ?.claimedBy,
      ).toBe('the controller of the same name');
    });

    it('refuses a controller whose name a domain module already mounts', () => {
      // `module` is ungated since M65, and its functional arm emits a route module into
      // the same merged directory.
      expect(
        findNameConflict('controller', 'widget', FUNCTIONAL, {}, ['widget'])?.claimedBy,
      ).toBe('the module of the same name');
    });

    it('still allows a distinct name', () => {
      // The fix must not over-refuse: widening the group to every mode would be worse
      // than the defect if it blocked ordinary generation.
      expect(
        findNameConflict('controller', 'gadget', FUNCTIONAL, { route: ['widget'] }, []),
      ).toBeUndefined();
    });

    it('still allows a service beside a same-named route', () => {
      // Different families entirely — the path group does not list `service`.
      expect(
        findNameConflict('service', 'widget', FUNCTIONAL, { route: ['widget'] }, []),
      ).toBeUndefined();
    });
  });

  describe('what it must NOT refuse (continued)', () => {
    it('allows a family whose scan reported nothing', () => {
      expect(findNameConflict('route', 'widget', WITH_DECORATORS, {}, [])).toBeUndefined();
    });
  });
});
