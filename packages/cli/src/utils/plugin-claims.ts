/**
 * Health-indicator names the installed `@setu-ts` plugins already claim.
 *
 * `setu generate health-indicator database` wrote a file, the project type-checked,
 * and `app.start()` threw `Duplicate health indicator name: "database"` — because
 * `HealthService.registerIndicator` refuses a name twice and `DatabasePlugin`
 * registers under its own capability token. The table below covers every plugin that
 * registers an indicator; fifteen of them claim exactly the names a developer reaches
 * for first (`database`, `cache`, `storage`, `session`, `events`, `mail`, `audit`, …),
 * so this is the common case rather than an unlucky one (register row A1).
 *
 * The check is a static table rather than a probe of the target project: `generate`
 * must never boot the project (M34b), and a zero-dependency CLI cannot import a
 * plugin to ask it. The table is kept honest by `test/plugin-claims-gate.test.ts` at
 * the repository root, which reads every health-indicator registration site in each
 * plugin's `src` directory and fails when a name is missing here.
 *
 * That gate's own scan is why this comment does not spell the registration call out:
 * `test/health-indicator-audit.test.ts` (M70c) matches the literal call text anywhere
 * under a package's `src`, so writing it here — in prose, in a package that holds no
 * plugin context and can register nothing — made this file read as an unclassified
 * indicator site.
 *
 * @module
 */

/**
 * Bare package name → the health-indicator names that plugin registers.
 *
 * Names a plugin DERIVES from an instance token (`cache.<name>`, `database.<name>`,
 * `messaging`, `queue`) appear here in their DEFAULT spelling only. A named instance
 * cannot collide with a generated indicator anyway, because `deriveNames` produces a
 * kebab-case identifier and a dotted token is not one.
 */
export const PLUGIN_HEALTH_INDICATORS: ReadonlyMap<string, readonly string[]> = new Map([
  ['audit-plugin', ['audit']],
  ['cache-plugin', ['cache']],
  ['cloudflare-plugin', ['cloudflare']],
  ['cqrs-plugin', ['cqrs']],
  ['database-plugin', ['database']],
  ['events-plugin', ['events']],
  ['feature-flags-plugin', ['feature-flags']],
  ['graphql-plugin', ['graphql']],
  ['grpc-plugin', ['grpc']],
  ['mail-plugin', ['mail']],
  ['messaging-plugin', ['messaging']],
  ['multi-tenancy-plugin', ['multi-tenancy']],
  ['notification-plugin', ['notification']],
  ['queue-plugin', ['queue']],
  ['react-router-plugin', ['react-router']],
  ['realtime-backplane-plugin', ['realtime-backplane']],
  ['scheduler-plugin', ['scheduler']],
  ['secrets-plugin', ['secrets']],
  ['service-discovery-plugin', ['service-discovery']],
  ['session-plugin', ['session']],
  ['sse-plugin', ['sse']],
  ['static-plugin', ['static-files']],
  ['storage-plugin', ['storage']],
  ['websocket-plugin', ['websocket']],
  ['worker-pool-plugin', ['worker-pool']],
]);

/**
 * Reports the installed plugin that already claims a health-indicator name.
 *
 * @param name - The indicator name the developer asked to generate (kebab-case)
 * @param plugins - The `@setu-ts` packages detected in the target project
 * @returns The bare package name of the claiming plugin, or `undefined` when free
 */
export function findPluginIndicatorClaim(
  name: string,
  plugins: ReadonlySet<string>,
): string | undefined {
  for (const [pkg, claimed] of PLUGIN_HEALTH_INDICATORS) {
    if (plugins.has(pkg) && claimed.includes(name)) return pkg;
  }
  return undefined;
}
