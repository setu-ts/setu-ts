/**
 * Inject-or-lazy loading of the SAML library (M100f plan §3.1). Internal.
 *
 * XML signature verification is where SAML implementations fail — through
 * signature-wrapping attacks that verify one element and trust another — so
 * the plugin does not hand-write it. `@node-saml/node-saml` is loaded through a
 * literal `npm:` import, awaited in `register()`, so a missing package or a
 * Workers deployment without `nodejs_compat` fails at startup rather than at
 * the first login.
 *
 * @module
 */

import { SamlRuntimeLoadError } from '../errors.ts';
import type { SamlModule } from '../interfaces/index.ts';
import type { SamlConstructor } from './engine.ts';

/** The specifier the lazy import loads; named in every load failure. */
export const SAML_SPECIFIER = 'npm:@node-saml/node-saml@^5';

/** Imports the real library. A literal specifier, so JSR's npm rewrite reaches it. */
export function importSamlModule(): Promise<unknown> {
  return import('npm:@node-saml/node-saml@^5');
}

/**
 * Checks a loaded or injected module and returns its `SAML` constructor.
 *
 * @param module - The module namespace or the injected object
 * @returns The `SAML` class
 * @throws {SamlRuntimeLoadError} When the module carries no `SAML` constructor
 */
export function adaptSamlModule(module: unknown): SamlConstructor {
  const candidate = typeof module === 'object' && module !== null
    ? (module as Record<string, unknown>).SAML
    : undefined;
  if (typeof candidate !== 'function') {
    throw new SamlRuntimeLoadError(
      SAML_SPECIFIER,
      new TypeError('the module does not export a SAML class'),
    );
  }
  return candidate as SamlConstructor;
}

/**
 * Loads the SAML library: the injected module when given, otherwise the lazy
 * import.
 *
 * @param injected - The provider's `module` option, if any
 * @param load - The importer; the real `npm:` import unless a test substitutes one
 * @returns The `SAML` constructor
 * @throws {SamlRuntimeLoadError} When the import fails or the module is unusable
 */
export async function loadSaml(
  injected: SamlModule | undefined,
  load: () => Promise<unknown> = importSamlModule,
): Promise<SamlConstructor> {
  if (injected !== undefined) {
    return adaptSamlModule(injected);
  }
  let module: unknown;
  try {
    module = await load();
  } catch (error) {
    throw new SamlRuntimeLoadError(SAML_SPECIFIER, error);
  }
  return adaptSamlModule(module);
}
