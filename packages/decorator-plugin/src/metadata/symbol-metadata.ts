/**
 * The `Symbol.metadata` carrier Node and Bun lack (M111a plan §3.4).
 *
 * TypeScript's TC39 decorator emit reads the carrier guardedly —
 * `typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0`
 * — and on Node 24 and Bun 1.4 `Symbol.metadata` is `undefined`, so every
 * decorated class hands its decorators `context.metadata === undefined` and the
 * first member decorator write crashes with a bare `TypeError` at class
 * definition. Measured on both runtimes, with `tsc` output and with Bun's own
 * compiler (plan §1).
 *
 * The remedy is the polyfill TypeScript's own 5.2 release notes give, with one
 * deliberate difference: `Symbol.for('Symbol.metadata')` rather than
 * `Symbol(...)`, so two copies of this package in one process — and the
 * downlevel transforms (tsx, esbuild, Bun's compiler), which already use the
 * registered key — agree on one carrier. On Deno, which defines the well-known
 * symbol, {@linkcode installSymbolMetadata} is a write-if-absent no-op.
 *
 * **Approved module-level exception (C3).** AI_GUIDELINES §11.5 forbids
 * module-top-level global mutation; this module is the named exception,
 * maintainer-approved 2026-10-11: installing a spec-defined well-known symbol
 * the runtime has not shipped, write-if-absent only, is what lets a decorated
 * class compiled by `tsc` exist on Node at all. The call runs once, at module
 * top level, and every module under `src/decorators/` imports this module
 * first so the carrier exists before any decorated class is evaluated.
 *
 * Not exported from the package barrel — importing
 * `@setu-ts/decorator-plugin` at all installs it; a named export would invite
 * a second installation path nobody needs.
 *
 * @module
 */

/**
 * The shape `context.metadata` presents to a decorator. Declared structurally
 * rather than via `DecoratorMetadata` so this module does not depend on which
 * TypeScript lib version supplies it.
 *
 * @since 0.9.0
 */
export type MetadataCarrier = Record<PropertyKey, unknown>;

/**
 * Installs the decorator-metadata carrier on `target` when absent.
 *
 * Write-if-absent: a runtime that already defines `Symbol.metadata` (Deno) or
 * a target that already carries a carrier is left untouched, so this can run
 * from any number of module evaluations in any order.
 *
 * @param target - The object to receive the carrier (the `Symbol`
 *   constructor in production; a plain object in tests)
 * @since 0.9.0
 */
export function installSymbolMetadata(target: { metadata?: symbol }): void {
  target.metadata ??= Symbol.for('Symbol.metadata');
}

// The one approved top-level call (C3). Runs when this module is first
// imported — which every `src/decorators/*.ts` module does first, so the
// carrier exists before TypeScript's decorator helper reads it.
installSymbolMetadata(Symbol as unknown as { metadata?: symbol });

/**
 * The error {@linkcode requireDecoratorMetadata} throws when the carrier is
 * still absent at decoration time.
 *
 * Deliberately NOT exported from the package barrel: no consumer can act on
 * the type — only on the message, which names both remedies.
 *
 * @since 0.9.0
 */
export class DecoratorMetadataUnavailableError extends Error {
  /** A stable `name`, so a `catch` can branch without string matching. */
  override readonly name = 'DecoratorMetadataUnavailableError';

  constructor() {
    super(
      'the decorator metadata carrier is unavailable: this decorated class was evaluated ' +
        'before @setu-ts/decorator-plugin installed Symbol.metadata, or a bundler dropped ' +
        "the side-effect import that installs it. Import '@setu-ts/decorator-plugin' " +
        'before the decorated module, or compile with a toolchain that supplies the ' +
        'carrier (tsx, esbuild, Bun).',
    );
  }
}

/**
 * Reads `context.metadata` for a decorator, failing with a NAMED error instead
 * of letting TypeScript's helper crash on a bare `TypeError`.
 *
 * The plan's safeguard 1 (§3.4): when the carrier is still `undefined` — a
 * bundler dropped the side-effect import, or the decorated module was
 * evaluated before this package — the two remedies are named in the message
 * rather than discovered from a stack frame inside the compiled
 * `__esDecorate` helper.
 *
 * @param context - The decorator context whose `metadata` is read
 * @returns The carrier, present because this module installed it
 * @throws {DecoratorMetadataUnavailableError} When the carrier is absent
 * @since 0.9.0
 */
export function requireDecoratorMetadata(
  context: { readonly metadata?: MetadataCarrier },
): MetadataCarrier {
  const carrier = context.metadata;
  if (carrier === undefined || carrier === null) {
    throw new DecoratorMetadataUnavailableError();
  }
  return carrier;
}
