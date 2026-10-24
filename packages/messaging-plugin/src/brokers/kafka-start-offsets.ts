import type { PartitionAssigner } from 'kafkajs';

/** Internal per-partition high watermarks, encoded as decimal strings. */
export type KafkaStartOffsets = Readonly<Record<string, string>>;

/**
 * Chooses first-join seeks without rewinding a partition already delivered
 * from its start. A delivery beyond the minimum still seeks to avoid loss.
 * @param assigned - This member's assigned partitions
 * @param uncommitted - Partitions without a committed offset
 * @param minimum - Group minimum start offsets
 * @param firstDelivered - First offset observed synchronously per partition
 * @returns Partition offsets to seek, in assignment order
 * @internal
 */
export function partitionsToSeek(
  assigned: readonly number[],
  uncommitted: ReadonlySet<number>,
  minimum: KafkaStartOffsets,
  firstDelivered: ReadonlyMap<number, string>,
): Array<{ partition: number; offset: string }> {
  return assigned.flatMap((partition) => {
    if (!uncommitted.has(partition) || !Object.hasOwn(minimum, partition)) return [];
    const offset = minimum[partition]!;
    const first = firstDelivered.get(partition);
    return first === undefined || BigInt(first) > BigInt(offset) ? [{ partition, offset }] : [];
  });
}

/**
 * Internal codec port. kafkajs's encoder accepts UTF-8 strings in writeBytes,
 * as well as buffers; using that path avoids a runtime-specific Buffer API.
 */
export interface IKafkaStartModule {
  PartitionAssigners: { roundRobin: PartitionAssigner };
  AssignerProtocol: {
    MemberMetadata: {
      encode(value: {
        version: number;
        topics: string[];
        userData: string;
      }): ReturnType<ReturnType<PartitionAssigner>['protocol']>['metadata'];
      decode(value: Uint8Array): { userData: Uint8Array | null } | null;
    };
  };
}

/**
 * Largest member metadata the first-join read decodes (security audit F3). The
 * whole advertisement for one topic is a few dozen bytes per partition, so
 * 64 KiB covers several thousand partitions while bounding the synchronous
 * decode and `JSON.parse` a group member can impose on every other member.
 */
export const MAX_MEMBER_METADATA_BYTES: number = 64 * 1024;

/** A Kafka offset is a signed 64-bit integer: at most 19 decimal digits. */
const OFFSET = /^\d{1,19}$/;
/** A partition id is a signed 32-bit integer: at most 10 decimal digits. */
const PARTITION = /^\d{1,10}$/;

/**
 * Delegates assignment unchanged, advertising only this member's start offsets.
 *
 * The advertisement is keyed by `topic` (security audit F2): one consumer
 * serves one topic, and a group misconfigured across topics must not apply one
 * topic's offsets to another topic's partitions.
 *
 * @param module - The kafkajs assigner and metadata codec
 * @param topic - The topic this consumer subscribes
 * @param getStart - Reads this member's captured start offsets at join time
 * @returns A partition assigner with round robin's name, version and assignment
 */
export function startAwareRoundRobin(
  module: IKafkaStartModule,
  topic: string,
  getStart: () => KafkaStartOffsets | null,
): PartitionAssigner {
  return (config) => {
    const base = module.PartitionAssigners.roundRobin(config);
    return {
      name: base.name,
      version: base.version,
      assign: (group) => base.assign(group),
      protocol: ({ topics }) => {
        const start = getStart();
        return {
          name: base.name,
          metadata: module.AssignerProtocol.MemberMetadata.encode({
            version: base.version,
            topics,
            userData: JSON.stringify(start === null ? {} : { [topic]: start }),
          }),
        };
      },
    };
  };
}

/**
 * Lowers this member's start offsets to the minimum the group's members
 * advertise for `topic`, decoding each member independently so malformed
 * metadata cannot discard the others.
 *
 * Group members are TRUSTED here: a client able to join the group can move a
 * new group's start earlier (never later), which replays history, and the
 * lowering is not logged. Joining needs only Read on the group, while
 * committing offsets also needs Read on the topic, so under split ACLs this
 * gives a principal that cannot commit a way to make a new group replay. The
 * README states the trust and that restricting group membership is the remedy.
 *
 * @param own - This member's snapshot for `topic`
 * @param topic - The topic whose advertisements are read
 * @param members - The group's current members, from `describeGroups`
 * @param module - The kafkajs metadata codec
 * @param warn - Receives each skipped member's reason
 * @returns The per-partition minimum; partitions absent from `own` are ignored
 */
export function minimumStartOffsets(
  own: KafkaStartOffsets,
  topic: string,
  members: ReadonlyArray<{ memberMetadata: Uint8Array }>,
  module: IKafkaStartModule,
  warn: (error: unknown) => void,
): KafkaStartOffsets {
  const minimum = { ...own };
  for (const member of members) {
    try {
      if (member.memberMetadata.length > MAX_MEMBER_METADATA_BYTES) {
        throw new Error(
          `Kafka group member metadata exceeds ${MAX_MEMBER_METADATA_BYTES} bytes; skipped`,
        );
      }
      const data = module.AssignerProtocol.MemberMetadata.decode(member.memberMetadata)?.userData;
      if (!data || data.length === 0) continue;
      const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid Kafka start offsets');
      }
      if (!Object.hasOwn(parsed, topic)) continue;
      const forTopic: unknown = (parsed as Record<string, unknown>)[topic];
      if (forTopic === null || typeof forTopic !== 'object' || Array.isArray(forTopic)) {
        throw new Error('Invalid Kafka start offsets');
      }
      const entries = Object.entries(forTopic);
      if (
        entries.some(
          ([partition, offset]) =>
            !PARTITION.test(partition) || typeof offset !== 'string' || !OFFSET.test(offset),
        )
      ) {
        throw new Error('Invalid Kafka start offset');
      }
      for (const [partition, offset] of entries) {
        if (
          Object.hasOwn(minimum, partition) &&
          BigInt(offset as string) < BigInt(minimum[partition]!)
        ) {
          minimum[partition] = offset as string;
        }
      }
    } catch (error) {
      warn(error);
    }
  }
  return minimum;
}

/** Optional dependency failure leaves injected clients with their own-offset fallback. */
export async function optionalKafkaStartModule(
  load: () => Promise<unknown>,
): Promise<IKafkaStartModule | null> {
  let module: unknown;
  try {
    module = await load();
  } catch {
    return null;
  }
  return isKafkaStartModule(module) ? module : null;
}

/**
 * Structural check for the two members the start-offset path reads, so a
 * kafkajs build lacking them falls back to own-offset seeks rather than
 * failing consumer construction.
 *
 * @param value - The loaded module
 * @returns `true` when both members are present with the right shapes
 */
export function isKafkaStartModule(value: unknown): value is IKafkaStartModule {
  if (value === null || typeof value !== 'object') return false;
  const { PartitionAssigners, AssignerProtocol } = value as {
    PartitionAssigners?: { roundRobin?: unknown };
    AssignerProtocol?: { MemberMetadata?: { encode?: unknown; decode?: unknown } };
  };
  return (
    typeof PartitionAssigners?.roundRobin === 'function' &&
    typeof AssignerProtocol?.MemberMetadata?.encode === 'function' &&
    typeof AssignerProtocol.MemberMetadata.decode === 'function'
  );
}
