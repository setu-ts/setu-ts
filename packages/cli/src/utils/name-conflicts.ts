/**
 * Detection of generated artifacts that cannot coexist under one name.
 *
 * This check exists BECAUSE the artifacts are now wired. Before the seams, two
 * artifacts sharing a name were two inert files; nothing registered either, so nothing
 * collided. Registering them makes two collisions real, and both were observed against
 * a booted application rather than reasoned about:
 *
 * - **DI token.** `setu g service widget` and `setu g module widget` both emit
 *   `@Injectable({ token: 'widget-service' })`. `DecoratorPlugin.registerService` skips
 *   a token already present, so the FIRST wins — and since the standalone barrel is
 *   spread before the module barrel, the module's controller received the standalone
 *   service and answered `500` (`this.widgets.list is not a function`) on every request.
 * - **HTTP path.** `route`, `controller` and `module` all mount `/<name>`. The kernel's
 *   router keys its entry map on `${method} ${path}`, so a duplicate OVERWRITES rather
 *   than throwing: one of the two artifacts is silently unreachable.
 *
 * Refusing beats warning for both. A silent 500 and a silently-dropped route are worse
 * than a command that will not run, and the fix is always the same — pick a different
 * name — so there is nothing the developer loses by being told now.
 *
 * @module
 */

import type { SeamArtifacts } from '../seams/seam-spec.ts';

/** One reason two artifacts cannot share a name, and the artifacts that share it. */
interface ConflictGroup {
  /** Schematics whose output collides when two of them use one name. */
  readonly schematics: readonly string[];
  /** What collides, rendered into the refusal. */
  readonly resource: (kebab: string) => string;
  /** What goes wrong if both are generated anyway. */
  readonly consequence: string;
}

/**
 * The collision groups, each verified against a booted application.
 *
 * `module` appears in both: it emits a controller mounted at `/<name>` AND a service
 * registered under `<name>-service`, so it can collide with either family.
 */
const CONFLICT_GROUPS: readonly ConflictGroup[] = [
  {
    schematics: ['route', 'controller', 'module'],
    resource: (kebab) => `the HTTP path /${kebab}`,
    consequence:
      'the kernel keys routes by method and path, so one of the two would be silently unreachable',
  },
  {
    schematics: ['service', 'module'],
    resource: (kebab) => `the injection token '${kebab}-service'`,
    consequence:
      'the decorator plugin registers the first class under a token and skips the rest, ' +
      'so the wrong service would be injected',
  },
];

/** A generated artifact already present that the requested one cannot coexist with. */
export interface NameConflict {
  /** The schematic that produced the existing artifact. */
  readonly schematic: string;
  /** What the two artifacts would both claim. */
  readonly resource: string;
  /** What goes wrong if both exist. */
  readonly consequence: string;
}

/**
 * Reports an existing artifact the requested one would collide with.
 *
 * Only fires when the collision is REAL. The DI-token group depends on
 * `decorator-plugin`; functional modules instead share a route filename with a
 * same-named route, and the ordinary overwrite check refuses that exact path.
 * Checking the decorator composition here keeps class-only collision advice off
 * functional projects.
 *
 * A schematic never conflicts with ITSELF: a second `setu g route widget` is the
 * ordinary overwrite refusal, which reports the file rather than a name clash.
 *
 * @param schematic - The schematic about to run
 * @param kebab - The artifact's kebab-case name
 * @param plugins - The `@setu-ts` packages detected in the target project
 * @param artifacts - Artifact names already present, by schematic name
 * @param modules - Domain module names already present
 * @returns The conflict, or `undefined` when the name is free
 */
export function findNameConflict(
  schematic: string,
  kebab: string,
  plugins: ReadonlySet<string>,
  artifacts: SeamArtifacts,
  modules: readonly string[],
): NameConflict | undefined {
  if (!plugins.has('decorator-plugin')) return undefined;

  for (const group of CONFLICT_GROUPS) {
    if (!group.schematics.includes(schematic)) continue;
    for (const other of group.schematics) {
      if (other === schematic) continue;
      // Modules are scanned separately from the flat families, because a module is a
      // directory that must hold two specific files rather than one suffixed file.
      const present = other === 'module' ? modules : artifacts[other] ?? [];
      if (present.includes(kebab)) {
        return {
          schematic: other,
          resource: group.resource(kebab),
          consequence: group.consequence,
        };
      }
    }
  }
  return undefined;
}
