/**
 * The outbox's one ordering column and its per-key blocking identity
 * (M107 §3.2).
 *
 * @module
 */

/** Digits of the millisecond segment of a position. */
const MS_DIGITS = 15;

/** The largest millisecond value the fixed-width segment can hold. */
const MAX_MS = 10 ** MS_DIGITS - 1;

/** An envelope id once its hyphens are removed: 32 lowercase hex characters. */
const ID_HEX = /^[0-9a-f]{32}$/;

/**
 * Hands out positions for ONE outbox instance.
 *
 * A position is `<ms, 15 decimal digits><id, 32 lowercase hex>` with no
 * separators. The millisecond segment is clamped to `max(now, last + 1)`, so
 * two writes in one millisecond keep write order and a backwards wall-clock
 * step never makes this instance's positions decrease. It orders positions
 * from ONE instance only: across instances each writer's clock decides.
 *
 * @internal
 */
export class PositionClock {
  #last = -1;

  /**
   * Builds the next position.
   *
   * @param nowMs - The wall clock (`runtime.now()`), epoch milliseconds
   * @param envelopeId - The envelope id (a UUID; hyphens are removed)
   * @returns The position string
   * @throws {TypeError} When the clock reading is not a finite non-negative
   *   number, the clamped value overflows 15 digits, or the id is not a UUID
   */
  next(nowMs: number, envelopeId: string): string {
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new TypeError('outbox position: the runtime clock returned an invalid time');
    }
    const hex = envelopeId.replaceAll('-', '').toLowerCase();
    if (!ID_HEX.test(hex)) {
      throw new TypeError('outbox position: the envelope id is not a 128-bit hex UUID');
    }
    const ms = Math.max(Math.floor(nowMs), this.#last + 1);
    if (ms > MAX_MS) {
      throw new TypeError('outbox position: the clamped clock exceeds 15 digits');
    }
    this.#last = ms;
    return `${String(ms).padStart(MS_DIGITS, '0')}${hex}`;
  }
}

/**
 * The identity a keyed row blocks: its tenant and ordering key, JSON-encoded
 * so no tenant or key value can contain a separator that makes two pairs
 * collide.
 *
 * @internal
 * @param tenantId - The row's tenant, `undefined` when none
 * @param orderingKey - The row's ordering key
 * @returns The block key
 */
export function blockKey(tenantId: string | undefined, orderingKey: string): string {
  return JSON.stringify([tenantId ?? null, orderingKey]);
}
