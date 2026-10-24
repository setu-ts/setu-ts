import { describe, expect, it } from 'vitest';
import { AssignerProtocol, PartitionAssigners } from 'kafkajs';
import type { PartitionAssigner } from 'kafkajs';
import {
  minimumStartOffsets,
  partitionsToSeek,
  MAX_MEMBER_METADATA_BYTES,
  isKafkaStartModule,
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
    const wrapper = startAwareRoundRobin(module, 'orders', () => start)(config);
    const base = PartitionAssigners.roundRobin(config);
    expect([wrapper.name, wrapper.version]).toEqual([base.name, base.version]);
    for (const offsets of [null, { 0: '9007199254740995', 1: '23' }]) {
      start = offsets;
      const protocol = wrapper.protocol({ topics: ['orders'] });
      expect(protocol.name).toBe(base.name);
      const decoded = AssignerProtocol.MemberMetadata.decode(protocol.metadata)!;
      expect(decoded.version).toBe(base.version);
      expect(decoded.topics).toEqual(['orders']);
      expect(JSON.parse(decoded.userData.toString())).toEqual(
        start === null ? {} : { orders: start },
      );
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
      'orders',
      [
        member('{"orders":{"0":"9007199254740992","1":"24","2":"0"}}'),
        member('{"orders":{"0":"9007199254740994","1":"21"}}'),
        member(''),
        member('{}'),
        member('null'),
        member('[]'),
        member('bad'),
        member('{"orders":{"0":3}}'),
        member('{"orders":{"0":"-1"}}'),
        member('{"orders":{"x":"0"}}'),
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
      minimumStartOffsets(own, 'orders', [member('{}')], nullCodec, () => {
        throw new Error('unexpected warning');
      }),
    ).toEqual(own);
  });

  it('ignores other topics and refuses an over-long offset or oversized metadata (audit F2, F3)', () => {
    const own = { 0: '50', 1: '50' };
    const warnings: unknown[] = [];
    const result = minimumStartOffsets(
      own,
      'orders',
      [
        // Another topic's offsets never reach this topic's partitions.
        member('{"billing":{"0":"0","1":"0"}}'),
        // A 20-digit offset exceeds a signed 64-bit integer and is refused before BigInt.
        member('{"orders":{"0":"00000000000000000001"}}'),
        // A partition id longer than a 32-bit integer is refused.
        member('{"orders":{"12345678901":"0"}}'),
        // Metadata above the cap is skipped before it is decoded or parsed.
        member(`{"orders":{"1":"0"},"pad":"${'x'.repeat(MAX_MEMBER_METADATA_BYTES)}"}`),
        member('{"orders":{"1":"7"}}'),
      ],
      module,
      (error) => warnings.push(error),
    );
    expect(result).toEqual({ 0: '50', 1: '7' });
    expect(warnings).toHaveLength(3);
    expect(String(warnings[2])).toContain(`${MAX_MEMBER_METADATA_BYTES} bytes`);
  });

  it('accepts a 19-digit offset and a member whose metadata is exactly at the cap', () => {
    const big = '9223372036854775806';
    expect(
      minimumStartOffsets(
        { 0: '9223372036854775807' },
        'orders',
        [member(`{"orders":{"0":"${big}"}}`)],
        module,
        () => {
          throw new Error('unexpected warning');
        },
      ),
    ).toEqual({ 0: big });
  });

  it('loads the optional module once per attempt or returns the injected-client fallback', async () => {
    expect(await optionalKafkaStartModule(() => Promise.resolve(module))).toBe(module);
    expect(
      await optionalKafkaStartModule(() => Promise.reject(new Error('not installed'))),
    ).toBeNull();
    // A loadable module without the two members falls back instead of failing consumers later.
    expect(await optionalKafkaStartModule(() => Promise.resolve({ Kafka: class {} }))).toBeNull();
  });

  it.each([
    [null, false],
    ['kafkajs', false],
    [
      {
        PartitionAssigners: {},
        AssignerProtocol: { MemberMetadata: { encode() {}, decode() {} } },
      },
      false,
    ],
    [{ PartitionAssigners: { roundRobin() {} }, AssignerProtocol: {} }, false],
    [
      {
        PartitionAssigners: { roundRobin() {} },
        AssignerProtocol: { MemberMetadata: { encode() {} } },
      },
      false,
    ],
    [module, true],
  ] as const)('recognises a usable kafkajs module shape (%#)', (value, expected) => {
    expect(isKafkaStartModule(value)).toBe(expected);
  });
});

describe('M119a partitionsToSeek', () => {
  it.each([undefined, '9', '10', '11', '9007199254740993'])(
    'first delivered %s against minimum 10',
    (first) => {
      expect(
        partitionsToSeek(
          [0],
          new Set([0]),
          { '0': '10' },
          first === undefined ? new Map() : new Map([[0, first]]),
        ),
      ).toEqual(first === undefined || BigInt(first) > 10n ? [{ partition: 0, offset: '10' }] : []);
    },
  );
  it('ignores unassigned, committed, and missing-minimum partitions', () => {
    expect(
      partitionsToSeek([0, 1, 2], new Set([1, 2, 3]), { '0': '0', '1': '12', '3': '0' }, new Map()),
    ).toEqual([{ partition: 1, offset: '12' }]);
  });
});
