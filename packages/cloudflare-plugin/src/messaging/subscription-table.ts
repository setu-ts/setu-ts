/**
 * Topic → subscriber routing for {@linkcode WorkersBroker}.
 *
 * Held in memory in the isolate that registered the subscriptions, because a
 * Cloudflare queue consumer is a module-level export rather than a callback the
 * runtime holds open: `subscribe()` records intent here, and the `queue` export
 * `createMessagingHandler` builds is what turns a delivered batch into handler
 * calls.
 *
 * The selection semantics are not invented. They are the ones
 * `InMemoryBroker` already documents and the repository therefore already
 * means by `SubscribeOptions.queue`: fan out to every subscriber that named no
 * queue, and deliver to exactly one member of each named queue group,
 * round-robin.
 *
 * @module
 * @since 0.2.0
 */

/** One registered subscriber. */
export interface Subscription<THandler> {
  /** Identity, so `remove` drops exactly one entry. */
  readonly id: string;
  /** The topic this subscriber listens on. */
  readonly topic: string;
  /** The registered callback. */
  readonly handler: THandler;
  /** Consumer group; members of one group share a delivery. */
  readonly queue?: string;
}

/**
 * Routes a delivered message to the subscribers that should see it.
 *
 * @typeParam THandler - The callback type; `MessageHandler` for `subscribe`
 * and a responder for `respond`
 * @since 0.2.0
 */
export class SubscriptionTable<THandler> {
  readonly #byTopic = new Map<string, Subscription<THandler>[]>();
  /** topic → queue group → next index, so round-robin survives across batches. */
  readonly #cursors = new Map<string, Map<string, number>>();

  /**
   * Registers a subscriber.
   *
   * @param subscription - The subscriber to add
   * @since 0.2.0
   */
  add(subscription: Subscription<THandler>): void {
    const existing = this.#byTopic.get(subscription.topic);
    if (existing === undefined) {
      this.#byTopic.set(subscription.topic, [subscription]);
    } else {
      existing.push(subscription);
    }
  }

  /**
   * Removes one subscriber by identity.
   *
   * @param topic - The topic it was registered on
   * @param id - The subscription id
   * @returns Whether an entry was removed
   * @since 0.2.0
   */
  remove(topic: string, id: string): boolean {
    const entries = this.#byTopic.get(topic);
    if (entries === undefined) return false;

    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) return false;

    entries.splice(index, 1);
    if (entries.length === 0) {
      this.#byTopic.delete(topic);
      // Dropped with the topic: a cursor kept for a topic with no subscribers
      // would resume mid-rotation if the topic were later re-subscribed, which
      // is state the caller has no way to reason about.
      this.#cursors.delete(topic);
    }
    return true;
  }

  /** Drops every subscriber and every cursor. */
  clear(): void {
    this.#byTopic.clear();
    this.#cursors.clear();
  }

  /**
   * Whether any subscriber is registered on a topic.
   *
   * @param topic - The topic to test
   * @returns Whether the topic has at least one subscriber
   * @since 0.2.0
   */
  has(topic: string): boolean {
    return (this.#byTopic.get(topic)?.length ?? 0) > 0;
  }

  /** Every topic carrying at least one subscriber, for diagnostics. */
  topics(): readonly string[] {
    return [...this.#byTopic.keys()];
  }

  /**
   * Selects the subscribers one delivery of a topic goes to.
   *
   * Every queue-less subscriber is selected, plus exactly one member of each
   * named queue group. **Advances the round-robin cursors**, so two calls with
   * the same table select different members of a group — which is why this is
   * called once per delivered message and never for a dry run.
   *
   * @param topic - The delivered topic
   * @returns The subscribers to invoke, in registration order
   * @since 0.2.0
   */
  select(topic: string): readonly Subscription<THandler>[] {
    const entries = this.#byTopic.get(topic);
    if (entries === undefined || entries.length === 0) return [];

    const selected: Subscription<THandler>[] = [];
    const groups = new Map<string, Subscription<THandler>[]>();

    for (const entry of entries) {
      if (entry.queue === undefined) {
        selected.push(entry);
        continue;
      }
      const group = groups.get(entry.queue);
      if (group === undefined) {
        groups.set(entry.queue, [entry]);
      } else {
        group.push(entry);
      }
    }

    for (const [queue, members] of groups) {
      selected.push(
        members[this.#nextIndex(topic, queue, members.length)] as Subscription<THandler>,
      );
    }

    return selected;
  }

  /** Reads and advances one group's cursor. */
  #nextIndex(topic: string, queue: string, size: number): number {
    let cursors = this.#cursors.get(topic);
    if (cursors === undefined) {
      cursors = new Map<string, number>();
      this.#cursors.set(topic, cursors);
    }
    const current = cursors.get(queue) ?? 0;
    // Modulo on read rather than on write: a group that shrinks between
    // deliveries would otherwise leave a cursor past its end, and the read
    // would be `undefined` rather than a member.
    const index = current % size;
    cursors.set(queue, index + 1);
    return index;
  }
}
