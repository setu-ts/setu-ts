/**
 * The products module's data. Plain types, safe to import from a page with
 * `import type` through the `~kernel/*` alias.
 */

/** A product in the catalogue. */
export interface Product {
  /** Stable identifier. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Price in minor units. */
  readonly priceCents: number;
}

/** A product's fields before it has an id: what `parse` returns and `create` takes. */
export type ProductInput = Omit<Product, 'id'>;
