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
 *   Since E8 this group has a second, LOUDER failure, in the mode the check used to skip
 *   entirely. `src/routes/` merged into `src/controllers/`, so a functional `route` and a
 *   functional `controller` share one directory and one barrel while both exporting
 *   `register<Pascal>Routes` — the barrel imports that name from two files and the
 *   generated project does not compile (`TS2300`, twice). Measured against a real
 *   scaffold: both commands reported success.
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
  /**
   * Whether this collision only exists in a decorator project.
   *
   * Per-group rather than per-call, and that distinction is the fix for a real
   * defect: the check used to return early for any project without
   * `decorator-plugin`, on the reasoning that a functional `module` shares a
   * FILENAME with a same-named `route` and the ordinary overwrite refusal
   * catches it. That was true while `route` wrote to `src/routes/` and
   * `controller` was gated — and E8 ended both. A functional `route` and a
   * functional `controller` now land in ONE directory under different
   * filenames while exporting the SAME `register<Pascal>Routes` symbol into
   * ONE barrel, so nothing caught them.
   */
  readonly requiresDecorators: boolean;
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
      'they mount the same path, and in a functional project they also export the same ' +
      'symbol into one barrel — so the project would not compile, and if it did, one of ' +
      'the two routes would be silently unreachable',
    // Every generator mode. In a decorator project the two register the same
    // `METHOD path`; in a functional one the merged `src/controllers/` barrel
    // imports `register<Pascal>Routes` from both files, which is TS2300.
    requiresDecorators: false,
  },
  {
    schematics: ['service', 'module'],
    resource: (kebab) => `the injection token '${kebab}-service'`,
    consequence:
      'the decorator plugin registers the first class under a token and skips the rest, ' +
      'so the wrong service would be injected',
    // Genuinely decorator-only: the token exists because `@Injectable` declares
    // it, and a functional service is a plain function registered under nothing.
    requiresDecorators: true,
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
 * Only fires when the collision is REAL, which is decided PER GROUP rather than
 * once for the whole call. The DI-token group depends on `decorator-plugin`,
 * because a functional service is a plain function registered under no token.
 * The HTTP-path group does not: it fires in every generator mode.
 *
 * A schematic never conflicts with ITSELF: a second `setu g route widget` is the
 * ordinary overwrite refusal, which reports the file rather than a name clash.
 * That refusal is also what still catches a functional `module` against a
 * same-named `route` — they share the filename `<name>.routes.ts`, so the
 * command never reaches this check.
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
  const decorated = plugins.has('decorator-plugin');

  for (const group of CONFLICT_GROUPS) {
    if (group.requiresDecorators && !decorated) continue;
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
