/**
 * Options shared by {@linkcode ConfigPlugin} and {@linkcode loadConfig}.
 *
 * They live in their own module because both entry points take the same
 * options object: the plugin registers what the standalone loader produces, so
 * one type describing one behaviour keeps them from drifting apart.
 *
 * @module
 */

import type { IConfig } from '@setu-ts/common';

import type { ConfigSection } from './sections/config-section.ts';
import type { StructuralSchema } from './validators/config-validator.ts';

/**
 * Options for {@linkcode ConfigPlugin} and {@linkcode loadConfig}.
 *
 * @since 0.1.0
 */
export interface ConfigPluginOptions {
  /**
   * Path or paths to `.env` files to load. Defaults to no file loading.
   * When supplied, the runtime must provide `fs` (absent on edge platforms).
   *
   * Ignored when {@linkcode ConfigPluginOptions.instance} is set.
   */
  readonly envFilePath?: string | readonly string[];

  /**
   * When `true`, a path in {@linkcode ConfigPluginOptions.envFilePath} that
   * does not exist is skipped instead of throwing. Defaults to `false`, which
   * is the behaviour released in 0.1.0.
   *
   * This exists for the layered-dotenv arrangement a scaffolded project uses: a
   * gitignored `.env` beside a tracked `.env.example`. The file is present on
   * the machine that generated it and absent on every fresh clone, in CI, and
   * in a container built from the repository — so requiring it would make the
   * project fail to start everywhere except its author's machine. A file that
   * EXISTS but cannot be read still throws; only absence is tolerated.
   *
   * Ignored when {@linkcode ConfigPluginOptions.instance} is set.
   *
   * @since 0.1.0
   */
  readonly envFileOptional?: boolean;

  /**
   * A structural schema (e.g., a Zod schema) for validating configuration at
   * startup. When provided, the schema's `parse()` is called once after
   * merging and expansion, and the parsed output is stored as the
   * configuration snapshot. This preserves Zod coercions and defaults.
   *
   * Ignored when {@linkcode ConfigPluginOptions.instance} is set — the supplied
   * snapshot has already been through whatever validation produced it.
   */
  readonly validationSchema?: StructuralSchema<unknown>;

  /**
   * Typed sections to validate at startup after `validationSchema` has parsed
   * the whole snapshot. Each section reads only its declared prefix-plus-key
   * entries, then caches its schema output for `getConfigSection`.
   *
   * Sections are also validated when `instance` is supplied. This keeps a
   * preloaded snapshot and the application using it on the same safe path.
   *
   * @since 0.6.0
   */
  readonly sections?: readonly ConfigSection<unknown>[];

  /**
   * When `true` (default), expand `${NAME}` references in values.
   * Set to `false` to disable variable expansion.
   *
   * Ignored when {@linkcode ConfigPluginOptions.instance} is set.
   */
  readonly expandVariables?: boolean;

  /**
   * An already-loaded configuration snapshot to use verbatim.
   *
   * Present → nothing is read from the environment or from disk;
   * `envFilePath`, `envFileOptional`, `validationSchema`, and
   * `expandVariables` are ignored. Declared `sections` still validate through
   * named reads on this exact object before it becomes the application's
   * `CAPABILITIES.CONFIG` service. Absent → configuration is loaded normally.
   *
   * This exists so configuration can be resolved BEFORE plugins are
   * constructed — deciding which plugins to register from a value in the
   * environment — without the application then loading a second snapshot. Two
   * snapshots read at different moments can disagree, and the one the composer
   * branched on would not be the one handlers read.
   *
   * @example Composing from configuration, then reusing the same snapshot
   * ```typescript
   * import { createRuntimeServices } from '@setu-ts/runtime';
   * import { ConfigPlugin, loadConfig } from '@setu-ts/config-plugin';
   *
   * const config = await loadConfig(createRuntimeServices());
   * const plugins = [ConfigPlugin({ instance: config })];
   * ```
   * @since 0.2.0
   */
  readonly instance?: IConfig;

  /**
   * The opt-in value-free configuration provenance policy (M98e).
   *
   * Present only when the developer explicitly opts in. An omitted option
   * builds no provenance metadata, and the plugin registers an inert source
   * whose snapshots report `disabled`. When present, the loader records, at
   * the existing resolution steps, value-free provenance for the approved
   * keys only: source category and approved source aliases, evidenced
   * precedence overrides and `${NAME}` expansion references, and schema
   * input/output presence effects. No value, value hash, value length, file
   * content, or validation payload is ever retained, and provenance adds no
   * read to the configuration object.
   *
   * `loadConfig(runtime, { diagnostics })` builds the metadata with the
   * snapshot; `ConfigPlugin({ instance, diagnostics })` adopts the record
   * when its exact instance was produced by this loader, and otherwise
   * reports every approved alias with an `unknown` origin and schema effect.
   *
   * @since 0.8.0
   */
  readonly diagnostics?: ConfigDiagnosticsOptions;
}

/**
 * The opt-in configuration provenance policy (M98e).
 *
 * Key names and file paths are treated as sensitive: only the explicitly
 * approved mappings are retained, aliases are unique and bounded, and
 * anything unapproved is never named in a snapshot — an unapproved file
 * origin is reduced to its category, and an unapproved key produces no entry
 * at all (no counter discloses that it exists). Every option is validated
 * when `loadConfig` or `ConfigPlugin(...)` is called, with fixed messages
 * that never echo a supplied value.
 *
 * @since 0.8.0
 */
export interface ConfigDiagnosticsOptions {
  /**
   * The explicit opt-in, and deliberately the LITERAL `true` rather than a
   * `boolean`: this is an acknowledgement, not a toggle. An absent option is
   * the disabled path; `enabled: false` (or any value other than `true`) is
   * refused, so a half-configured composition fails loudly instead of
   * silently opting in.
   */
  readonly enabled: true;
  /**
   * The exact configuration key to display-alias allowlist. At most 128
   * entries. Each alias must be unique, `1`–`64` UTF-8 bytes, and contain no
   * control characters. A key not approved here is never observed: it
   * produces no entry, and its existence is not counted anywhere.
   */
  readonly keys: Readonly<Record<string, string>>;
  /**
   * The exact configured `.env` path to source-alias allowlist, at most
   * eight entries. Each alias must be unique, `1`–`64` UTF-8 bytes, and
   * contain no control characters. A file whose exact configured path is not
   * approved here contributes only the category `file` — never its path,
   * name, or count.
   */
  readonly files?: Readonly<Record<string, string>>;
}
