import { describe, expect, it } from 'vitest';
import { AssignerProtocol, PartitionAssigners } from 'kafkajs';
import type { PartitionAssigner } from 'kafkajs';
import {
  minimumStartOffsets,
  optionalKafkaStartModule,
  startAwareRoundRobin,
} from '../../src/brokers/kafka-start-offsets.ts';
import type { IKafkaStartModule } from '../../src/brokers/kafka-start-offsets.ts';

const module = { AssignerProtocol, PartitionAssigners } as unknown as IKafkaStartModule;
const member = (json: string) => ({
  memberMetadata: AssignerProtocol.MemberMetadata.encode({
    version: 0,
    topics: ['orders'],
    userData: Buffer.from(json),
  }),
});

describe('Kafka start-offset internal seams against real kafkajs', () => {
  it('keeps round robin name/version/assignment and round trips current start offsets', async () => {
    const config = {
      cluster: { findTopicPartitionMetadata: () => [{ partitionId: 0 }, { partitionId: 1 }] },
    } as unknown as Parameters<PartitionAssigner>[0];
    let start: Record<string, string> | null = null;
    const wrapper = startAwareRoundRobin(module, () => start)(config);
    const base = PartitionAssigners.roundRobin(config);
    expect([wrapper.name, wrapper.version]).toEqual([base.name, base.version]);
    for (const offsets of [null, { 0: '9007199254740995', 1: '23' }]) {
      start = offsets;
      const protocol = wrapper.protocol({ topics: ['orders'] });
      expect(protocol.name).toBe(base.name);
      const decoded = AssignerProtocol.MemberMetadata.decode(protocol.metadata)!;
      expect(decoded.version).toBe(base.version);
      expect(decoded.topics).toEqual(['orders']);
      expect(JSON.parse(decoded.userData.toString())).toEqual(start ?? {});
      const group = {
        members: [
          { memberId: 'a', memberMetadata: protocol.metadata },
          { memberId: 'b', memberMetadata: protocol.metadata },
        ],
        topics: ['orders'],
      };
      expect(await wrapper.assign(group)).toEqual(await base.assign(group));
    }
  });

  it('takes the BigInt minimum, skips bad members independently and accepts legacy empty metadata', () => {
    const warnings: unknown[] = [];
    const own = { 0: '9007199254740993', 1: '23' };
    const result = minimumStartOffsets(
      own,
      [
        member('{"0":"9007199254740992","1":"24","2":"0"}'),
        member('{"0":"9007199254740994","1":"21"}'),
        member(''),
        member('{}'),
        member('null'),
        member('[]'),
        member('bad'),
        member('{"0":3}'),
        member('{"0":"-1"}'),
        member('{"x":"0"}'),
        { memberMetadata: Buffer.from([0]) },
      ],
      module,
      (error) => warnings.push(error),
    );
    expect(result).toEqual({ 0: '9007199254740992', 1: '21' });
    expect(own).toEqual({ 0: '9007199254740993', 1: '23' });
    expect(warnings).toHaveLength(7);
    const nullCodec = {
      ...module,
      AssignerProtocol: {
        MemberMetadata: { ...module.AssignerProtocol.MemberMetadata, decode: () => null },
      },
    };
    expect(
      minimumStartOffsets(own, [member('{}')], nullCodec, () => {
        throw new Error('unexpected warning');
      }),
    ).toEqual(own);
  });

  it('loads the optional module once per attempt or returns the injected-client fallback', async () => {
    expect(await optionalKafkaStartModule(() => Promise.resolve(module))).toBe(module);
    expect(
      await optionalKafkaStartModule(() => Promise.reject(new Error('not installed'))),
    ).toBeNull();
  });
});
