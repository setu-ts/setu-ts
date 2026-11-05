import { describe, expect, it } from 'vitest';
import { AssignerProtocol, PartitionAssigners } from 'kafkajs';
import type { PartitionAssigner } from 'kafkajs';
import {
  extendSkipWindow,
  minimumStartOffsets,
  partitionsToSeek,
  MAX_MEMBER_METADATA_BYTES,
  isKafkaStartModule,
  optionalKafkaStartModule,
  startAwareRoundRobin,
} from '../../src/brokers/kafka-start-offsets.ts';
import type { IKafkaStartModule, KafkaSkipWindow } from '../../src/brokers/kafka-start-offsets.ts';

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
        ).seeks,
      ).toEqual(first === undefined || BigInt(first) > 10n ? [{ partition: 0, offset: '10' }] : []);
    },
  );
  it('ignores unassigned, committed, and missing-minimum partitions', () => {
    expect(
      partitionsToSeek([0, 1, 2], new Set([1, 2, 3]), { '0': '0', '1': '12', '3': '0' }, new Map())
        .seeks,
    ).toEqual([{ partition: 1, offset: '12' }]);
  });
});

it('M131b 3.14 computes and consumes per-partition skip windows without numeric truncation', async () => {
  const { skipDeliveredOffset } = await import('../../src/brokers/kafka-start-offsets.ts');
  const decision = partitionsToSeek(
    [0, 1, 2],
    new Set([0, 1, 2]),
    { 0: '0', 1: '9007199254740993', 2: '0' },
    new Map([
      [0, '2'],
      [1, '9007199254740995'],
      [2, '5'],
    ]),
    new Map([
      [0, '3'],
      [1, '9007199254740996'],
    ]),
  );
  expect(decision.seeks).toEqual([
    { partition: 0, offset: '0' },
    { partition: 1, offset: '9007199254740993' },
    { partition: 2, offset: '0' },
  ]);
  expect([...decision.skipThrough]).toEqual([
    [0, { from: '2', to: '3' }],
    [1, { from: '9007199254740995', to: '9007199254740996' }],
    // First delivery still in flight (or failed): an empty window.
    [2, { from: '5', to: '4' }],
  ]);
  for (const [partition, offset, skip] of [
    [0, '0', false],
    [0, '1', false],
    [0, '2', true],
    [0, '3', true],
    [1, '9007199254740994', false],
    [1, '9007199254740995', true],
    [2, '5', false],
    [0, '4', false],
    [0, '2', false],
  ] as const) {
    expect(skipDeliveredOffset(decision.skipThrough, partition, offset)).toBe(skip);
  }
  expect(decision.skipThrough.has(0)).toBe(false);
  expect(decision.skipThrough.has(1)).toBe(true);
  expect(decision.skipThrough.has(2)).toBe(false);
});

describe('M131b review extendSkipWindow', () => {
  it('widens a live window, never narrows one, and never recreates a cleared one', () => {
    const windows = new Map<number, KafkaSkipWindow>([[0, { from: '2', to: '2' }]]);
    extendSkipWindow(windows, 0, '3');
    expect(windows.get(0)).toEqual({ from: '2', to: '3' });
    extendSkipWindow(windows, 0, '1');
    expect(windows.get(0)).toEqual({ from: '2', to: '3' });
    extendSkipWindow(windows, 1, '9');
    expect(windows.has(1)).toBe(false);
  });
});
