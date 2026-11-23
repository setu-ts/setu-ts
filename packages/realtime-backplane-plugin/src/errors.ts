/** Startup refusals for backplane transports. @module */

/** A messaging broker did not confirm independent frame delivery. @since 0.14.0 */
export class BackplaneFanOutUnsupportedError extends Error {
  /**
   * @param options - Optional cause when cleanup of the refused subscription failed
   * @returns The startup refusal
   * @throws Never
   * @since 0.14.0
   */
  constructor(options?: ErrorOptions) {
    super(
      'realtime-backplane messaging transport requires fan-out; the broker returned a competing subscription. Use a broker supporting fanOut or the redis transport.',
      options,
    );
    this.name = 'BackplaneFanOutUnsupportedError';
  }
}
