/** Five minutes in JetStream's nanosecond units. @internal */
export const INBOX_INACTIVE_THRESHOLD_NS = 300_000_000_000;

/** Consumer fields used to recognize durables leaked by earlier releases. @internal */
export interface ILeakedConsumer {
  readonly name: string;
  readonly config: {
    readonly durable_name?: string;
    readonly inactive_threshold?: number;
    readonly metadata?: Readonly<Record<string, string>>;
  };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const LEAKED_NAME = new RegExp(`^(messaging-|rr_2einbox_2e)(${UUID})$`);

/**
 * Recognizes only legacy durable names with absent or matching queue metadata
 * and no active reaping threshold.
 * @param consumer - Listed JetStream consumer
 * @returns Whether its inactive threshold should be installed
 * @internal
 */
export function isLeakedConsumer(consumer: ILeakedConsumer): boolean {
  const { config, name } = consumer;
  if (!config.durable_name || (config.inactive_threshold ?? 0) !== 0) return false;
  const match = LEAKED_NAME.exec(name);
  if (!match) return false;
  const queue = `${match[1] === 'messaging-' ? 'messaging-' : 'rr.inbox.'}${match[2]}`;
  const recorded = config.metadata?.['setu.queue'];
  return recorded === undefined || recorded === queue;
}

/** Management operations needed by the legacy-consumer sweep. @internal */
export interface ILeakedConsumerManager {
  list(stream: string): AsyncIterable<ILeakedConsumer>;
  update(stream: string, name: string, config: { inactive_threshold: number }): Promise<unknown>;
}

/**
 * Installs a reaping threshold without deleting a rolling deployment's live
 * consumers. Reports at most one failure and stops when its connection closes.
 * @param consumers - JetStream consumer management API
 * @param stream - Stream to sweep
 * @param active - Whether this connection still owns the sweep
 * @param report - Receives one list or update failure
 * @returns Resolves after the sweep or its first failure
 * @internal
 */
export async function sweepLeakedConsumers(
  consumers: ILeakedConsumerManager,
  stream: string,
  active: () => boolean,
  report: (error: unknown) => void,
): Promise<void> {
  try {
    for await (const consumer of consumers.list(stream)) {
      if (!active()) return;
      if (isLeakedConsumer(consumer)) {
        await consumers.update(stream, consumer.name, {
          inactive_threshold: INBOX_INACTIVE_THRESHOLD_NS,
        });
      }
    }
  } catch (error) {
    report(error);
  }
}
