/** Serial handler dispatch per Pub/Sub ordering key. @module */

/** Minimal delivery identity and nack operation owned by the gate. @since 0.14.0 */
export interface IOrderedDelivery {
  /** Native ordering key, absent for concurrent delivery. @since 0.14.0 */
  readonly orderingKey?: string;
  /** Platform delivery identity, used to recognize redelivery. @since 0.14.0 */
  readonly messageId?: string;
  /**
   * Returns the message to the platform.
   * @returns Nothing
   * @throws When the transport refuses settlement
   * @since 0.14.0
   */
  nack(): void;
}

/** Per-stream ordering state, cleared on stream closure. @since 0.14.0 */
export class PubSubOrdering {
  readonly #keys = new Map<string, { tail: Promise<void>; nacked: Set<string> }>();
  #generation = 0;

  /**
   * Runs one delivery after its key's earlier work settles.
   * @param message - Platform delivery
   * @param dispatch - Handler and settlement; true means successful processing
   * @returns Completion of this delivery, or of dropping a buffered delivery
   * @throws When dispatch or settlement fails
   * @since 0.14.0
   */
  run(message: IOrderedDelivery, dispatch: () => Promise<boolean>): Promise<void> {
    const key = message.orderingKey;
    if (key === undefined || key === '') return dispatch().then(() => {});
    const state = this.#keys.get(key) ?? { tail: Promise.resolve(), nacked: new Set<string>() };
    this.#keys.set(key, state);
    const generation = this.#generation;
    const task = state.tail.then(async () => {
      if (generation !== this.#generation) return;
      if (message.messageId !== undefined && state.nacked.has(message.messageId))
        state.nacked.clear();
      if (state.nacked.size > 0) {
        if (message.messageId !== undefined) state.nacked.add(message.messageId);
        message.nack();
        return;
      }
      const success = await dispatch();
      if (!success && message.messageId !== undefined) state.nacked.add(message.messageId);
    });
    state.tail = task.catch(() => {});
    void state.tail.then(() => {
      if (this.#keys.get(key) === state && state.tail === tail && state.nacked.size === 0)
        this.#keys.delete(key);
    });
    const tail = state.tail;
    return task;
  }

  /**
   * Drops buffered callbacks without settling messages on a closed stream.
   * @returns Nothing
   * @throws Never
   * @since 0.14.0
   */
  clear(): void {
    this.#generation++;
    this.#keys.clear();
  }
}
