/**
 * Domain model. Plain data, shared by server modules and components — so it
 * must not import anything server-only.
 */

/** A product in the catalogue. */
export interface Product {
  /** Stable identifier, and the repository's primary key. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Price in minor units. */
  readonly priceCents: number;
}

/** Formats a price for display. */
export function formatPrice(product: Product): string {
  return `$${(product.priceCents / 100).toFixed(2)}`;
}
