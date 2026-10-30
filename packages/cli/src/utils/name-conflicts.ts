/**
 * Detection of generated artifacts that cannot coexist under one name.
 *
 * The check exists because generated artifacts are wired. Three collisions were
 * observed against a booted application:
 *
 * - **DI token.** `setu g service widget` and `setu g module widget` both emit
 *   `@Injectable({ token: 'widget-service' })`. `DecoratorPlugin` keeps the first
 *   token it sees, so the module's controller received the wrong service and
 *   answered `500`.
 * - **HTTP path.** A controller (class or function) and a module both mount
 *   `/<name>`, so one of them is unreachable or startup fails on the duplicate.
 *   `g route` and `g sse` write into the controller family, so a second file of
 *   one name is refused by the overwrite guard before this check runs.
 * - **Plugin claim.** A generated health indicator whose name an installed plugin
 *   already registers makes `app.start()` throw, so it is looked up in
 *   `plugin-claims.ts` (register row A1).
 *
 * Refusing beats warning: the fix is always to pick another name.
 *
 * @module
 */
import type { SeamArtifacts } from '../seams/seam-spec.ts';
import { artifactNames } from './artifact-path.ts';
import { findPluginIndicatorClaim } from './plugin-claims.ts';

/** One reason two artifacts cannot share a name, and the artifacts that share it. */
interface ConflictGroup {
  /** Schematics whose output collides when two of them use one name. */
  readonly schematics: readonly string[];
  /** What collides, rendered into the refusal. */
  readonly resource: (kebab: string) => string;
  /** What goes wrong if both are generated anyway. */
  readonly consequence: string;
  /** Whether this resource exists only in a decorator project. */
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
    schematics: ['controller', 'module'],
    resource: (kebab) => `the HTTP path /${kebab}`,
    consequence:
      'they mount the same HTTP path, so one controller would be unreachable or application startup would fail',
    // Class controllers and function controllers both declare HTTP paths.
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

/** Something already present that the requested artifact cannot coexist with. */
export interface NameConflict {
  /**
   * The other claimant, already rendered — `the route of the same name`, or
   * `the installed plugin @setu-ts/database-plugin`.
   *
   * Rendered here rather than in the command layer because the two kinds of
   * claimant read differently, and the command has one message for both.
   */
  readonly claimedBy: string;
  /** What the two would both claim. */
  readonly resource: string;
  /** What goes wrong if both exist. */
  readonly consequence: string;
  /** The way out other than renaming. */
  readonly remedy: string;
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
 * Functional modules live in their own folders. Their admitted names must be
 * supplied separately: a same-named top-level route no longer shares a file,
 * but still claims the same HTTP path. Scoped callers supply only that module's
 * artifacts and no application-wide module names.
 *
 * @param schematic - The schematic about to run
 * @param kebab - The artifact's kebab-case name
 * @param plugins - The `@setu-ts` packages detected in the target project — read both to
 *   gate the DI-token group and to resolve a health-indicator name against the plugins
 *   that already claim one
 * @param artifacts - Artifact names already present, by schematic name
 * @param modules - Domain module names already present
 * @param module - Feature scope, when the supplied artifacts are module-local
 * @returns The conflict, or `undefined` when the name is free
 */
export function findNameConflict(
  schematic: string,
  kebab: string,
  plugins: ReadonlySet<string>,
  artifacts: SeamArtifacts,
  modules: readonly string[],
  module?: string,
): NameConflict | undefined {
  const family = ['route', 'sse'].includes(schematic) ? 'controller' : schematic;
  const requested = schematic === 'route' ? 'controller' : schematic;
  const nested = (artifacts[family] ?? []).find(
    (path) => path !== kebab && artifactNames(path).kebab === kebab,
  );
  if (nested !== undefined)
    return {
      claimedBy: `the ${family} at ${nested}`,
      resource: `the generated binding for ${kebab}`,
      consequence: 'each artifact in a family must have a unique base name',
      remedy: `rename or remove ${nested}`,
    };
  if (module !== undefined) return undefined;
  const decorated = plugins.has('decorator-plugin');

  // A1: the other claimant is a plugin, not a generated artifact, so it is reported
  // with the plugin's package name in place of a schematic name.
  if (schematic === 'health-indicator') {
    const claimant = findPluginIndicatorClaim(kebab, plugins);
    if (claimant !== undefined) {
      return {
        claimedBy: `the installed plugin @setu-ts/${claimant}`,
        resource: `the health-indicator name '${kebab}'`,
        consequence:
          'the health service refuses a duplicate indicator name, so the application ' +
          'would type-check and then throw at app.start()',
        remedy: `remove @setu-ts/${claimant} from the project`,
      };
    }
  }

  for (const group of CONFLICT_GROUPS) {
    if (group.requiresDecorators && !decorated) continue;
    if (!group.schematics.includes(requested)) continue;
    for (const other of group.schematics) {
      if (other === requested) continue;
      // Modules are scanned separately from the flat families, because a module is a
      // directory admitted by its declaration rather than one controller file.
      const present = other === 'module' ? modules : (artifacts[other] ?? []);
      if (present.some((path) => artifactNames(path).kebab === kebab)) {
        return {
          claimedBy: `the ${other} of the same name`,
          resource: group.resource(kebab),
          consequence: group.consequence,
          remedy: `remove the existing ${other}`,
        };
      }
    }
  }
  return undefined;
}
