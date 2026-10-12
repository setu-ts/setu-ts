/**
 * Compile-time pin for audit round 6 (T-R6): a configuration written while a row
 * existed keeps type-checking after the CLI stops emitting that row. Reached by
 * `deno check`; nothing executes it.
 * @module
 */
import { DEVTOOL_SOURCES } from './devtool-sources-absent.ts';

const sources: Partial<typeof DEVTOOL_SOURCES> = DEVTOOL_SOURCES;
/** The CLI's own backplane call shape, against a module with no backplane row. */
export const backplaneOptions: { readonly transport?: string } = { ...sources.backplane };
/** A row the module does emit keeps its precise type. */
export const cacheAlias: string | undefined = sources.cache?.diagnostics.alias;
