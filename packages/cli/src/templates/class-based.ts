/**
 * The class-based project template — now the alias of `rest --style class-based`.
 *
 * Before this milestone the style and the plugin set were one choice, and this
 * was the only class-based template. M99e made style its own axis: the class-based
 * VARIANT of `rest` is built from the SAME recipe as its functional form by
 * {@linkcode composeHost}, and this template is that variant under its published
 * name. The output is byte-identical to the pre-refactor template — proven by
 * `test/fixtures/template-baseline.json` — and the name is public surface, so it
 * stays.
 *
 * @module
 */
import type { TemplateDefinition, Wiring } from './registry.ts';
import { REST_RECIPE } from './rest.ts';
import { composeHost } from './style.ts';

/**
 * The class-based host, built from the REST recipe.
 *
 * This is the SAME object `rest` carries as its `classBased` variant, so
 * `--template class-based` and `--template rest --style class-based` render
 * identically by construction rather than by care.
 */
const CLASS_BASED_HOST = composeHost(REST_RECIPE, 'class-based');

/**
 * The class-based plugin set, exported for the DI test.
 *
 * Derived from the composed host rather than re-listed: the host is the source
 * of truth, and a hand-copied list would drift the moment the recipe changes.
 */
export const CLASS_BASED_PLUGINS: readonly Wiring[] = CLASS_BASED_HOST.plugins;

/**
 * `class-based` — `rest` with the decorator and DI pair, a decorated controller,
 * and an injected service.
 *
 * It is an ALIAS, not a peer: the canonical spelling is
 * `--template rest --style class-based`, and the `aliasOf` field is what the
 * help text, the interactive prompt and the resolver notice read. It is not
 * deprecated — nothing is refused or scheduled for removal.
 *
 * Nothing here needs raw sockets, so all four runtime targets work.
 */
export const CLASS_BASED_TEMPLATE: TemplateDefinition = {
  name: 'class-based',
  description: 'Class-based API — decorators, constructor injection, and modules',
  ...CLASS_BASED_HOST,
  aliasOf: '--template rest --style class-based',
};
