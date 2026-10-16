import type { PartitionAssigner } from 'kafkajs';

/** Internal per-partition high watermarks, encoded as decimal strings. */
export type KafkaStartOffsets = Readonly<Record<string, string>>;

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

/** Delegates assignment unchanged, advertising only this member's start offsets. */
export function startAwareRoundRobin(
  module: IKafkaStartModule,
  getStart: () => KafkaStartOffsets | null,
): PartitionAssigner {
  return (config) => {
    const base = module.PartitionAssigners.roundRobin(config);
    return {
      name: base.name,
      version: base.version,
      assign: (group) => base.assign(group),
      protocol: ({ topics }) => ({
        name: base.name,
        metadata: module.AssignerProtocol.MemberMetadata.encode({
          version: base.version,
          topics,
          userData: JSON.stringify(getStart() ?? {}),
        }),
      }),
    };
  };
}

/** Decodes each member independently; malformed metadata cannot discard other members. */
export function minimumStartOffsets(
  own: KafkaStartOffsets,
  members: ReadonlyArray<{ memberMetadata: Uint8Array }>,
  module: IKafkaStartModule,
  warn: (error: unknown) => void,
): KafkaStartOffsets {
  const minimum = { ...own };
  for (const member of members) {
    try {
      const data = module.AssignerProtocol.MemberMetadata.decode(member.memberMetadata)?.userData;
      if (!data || data.length === 0) continue;
      const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid Kafka start offsets');
      }
      const entries = Object.entries(parsed);
      if (
        entries.some(
          ([partition, offset]) =>
            !/^\d+$/.test(partition) || typeof offset !== 'string' || !/^\d+$/.test(offset),
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
  try {
    return (await load()) as IKafkaStartModule;
  } catch {
    return null;
  }
}
