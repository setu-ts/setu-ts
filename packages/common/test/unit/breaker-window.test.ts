/**
 * The shared circuit-breaker trip rule: a conformance table over both arms of
 * `CircuitBreakerPolicy` and a refusal table for `breakerPolicyRangeError`.
 *
 * Both tables are data: a rule's behaviour is a row, so a comment or README
 * claim about the rule cannot drift from what one `it.each` drives.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { breakerPolicyRangeError, createBreakerWindow } from '@setu-ts/common/breaker-window';
import type {
  CircuitBreakerCountPolicy,
  CircuitBreakerPolicy,
  CircuitBreakerRatePolicy,
} from '../../src/index.ts';

type Step = readonly [at: number, op: 'S' | 'F' | 'R'];

interface ConformanceRow {
  readonly name: string;
  readonly policy: CircuitBreakerPolicy;
  readonly steps: readonly Step[];
  /** What each `F` step's `recordFailure()` returned, in order. */
  readonly trips: readonly boolean[];
  /** `[clock, failures]`: the `failures` read at that clock after the steps. */
  readonly failuresAt?: readonly [number, number];
}

const COUNT: CircuitBreakerCountPolicy = { threshold: 3, timeout: 1000, resetTimeout: 500 };
const RATE: CircuitBreakerRatePolicy = {
  failureRateThreshold: 50,
  minimumCalls: 4,
  timeout: 1000,
  resetTimeout: 500,
};

/** One failing call in three, `rounds` times, one millisecond apart. */
function oneInThree(rounds: number): Step[] {
  const steps: Step[] = [];
  for (let round = 0; round < rounds; round++) {
    steps.push([round * 3, 'S'], [round * 3 + 1, 'S'], [round * 3 + 2, 'F']);
  }
  return steps;
}

const CONFORMANCE: readonly ConformanceRow[] = [
  // Count arm: exact timestamps.
  {
    name: 'count: below threshold does not trip',
    policy: COUNT,
    steps: [
      [0, 'F'],
      [10, 'F'],
    ],
    trips: [false, false],
    failuresAt: [10, 2],
  },
  {
    name: 'count: at threshold trips',
    policy: COUNT,
    steps: [
      [0, 'F'],
      [10, 'F'],
      [20, 'F'],
    ],
    trips: [false, false, true],
  },
  {
    name: 'count: a failure exactly timeout old has left the window',
    policy: COUNT,
    steps: [
      [0, 'F'],
      [10, 'F'],
      [1000, 'F'],
    ],
    trips: [false, false, false],
    failuresAt: [1000, 2],
  },
  {
    name: 'count: a failure one millisecond younger than timeout still counts',
    policy: COUNT,
    steps: [
      [0, 'F'],
      [10, 'F'],
      [999, 'F'],
    ],
    trips: [false, false, true],
  },
  {
    name: 'count: a success between failures does not clear them',
    policy: COUNT,
    steps: [
      [0, 'F'],
      [5, 'S'],
      [10, 'F'],
      [15, 'S'],
      [20, 'F'],
    ],
    trips: [false, false, true],
  },
  {
    name: 'count: the window keeps at most threshold failures and still trips',
    policy: { threshold: 2, timeout: 1000, resetTimeout: 0 },
    steps: [
      [0, 'F'],
      [1, 'F'],
      [2, 'F'],
      [3, 'F'],
    ],
    trips: [false, true, true, true],
    failuresAt: [3, 2],
  },
  {
    name: 'count: failures read later have aged',
    policy: COUNT,
    steps: [
      [0, 'F'],
      [500, 'F'],
    ],
    trips: [false, false],
    failuresAt: [1200, 1],
  },
  // Rate arm: ten buckets of timeout / 10.
  {
    name: 'rate: below minimumCalls never trips, even at 100 %',
    policy: RATE,
    steps: [
      [0, 'F'],
      [1, 'F'],
      [2, 'F'],
    ],
    trips: [false, false, false],
    failuresAt: [2, 3],
  },
  {
    name: 'rate: at minimumCalls and at the rate trips',
    policy: RATE,
    steps: [
      [0, 'S'],
      [1, 'S'],
      [2, 'F'],
      [3, 'F'],
    ],
    trips: [false, true],
  },
  {
    name: 'rate: just under the rate does not trip',
    policy: RATE,
    steps: [
      [0, 'S'],
      [1, 'S'],
      [2, 'S'],
      [3, 'F'],
      [4, 'F'],
    ],
    trips: [false, false],
  },
  {
    name: 'rate: failureRateThreshold 100 trips when every call failed',
    policy: { failureRateThreshold: 100, minimumCalls: 2, timeout: 1000, resetTimeout: 0 },
    steps: [
      [0, 'F'],
      [1, 'F'],
    ],
    trips: [false, true],
  },
  {
    name: 'rate: failureRateThreshold 100 does not trip with one success in the window',
    policy: { failureRateThreshold: 100, minimumCalls: 2, timeout: 1000, resetTimeout: 0 },
    steps: [
      [0, 'F'],
      [1, 'S'],
      [2, 'F'],
      [3, 'F'],
    ],
    trips: [false, false, false],
  },
  {
    name: 'rate: one failing call in three at high volume stays under 50 %',
    policy: { failureRateThreshold: 50, minimumCalls: 10, timeout: 1000, resetTimeout: 0 },
    steps: oneInThree(30),
    trips: new Array<boolean>(30).fill(false),
    failuresAt: [89, 30],
  },
  {
    name: 'rate: a bucket nine widths old is still in the window',
    policy: { failureRateThreshold: 50, minimumCalls: 2, timeout: 1000, resetTimeout: 0 },
    steps: [
      [0, 'F'],
      [900, 'F'],
    ],
    trips: [false, true],
  },
  {
    name: 'rate: a bucket ten widths old has left the window',
    policy: { failureRateThreshold: 50, minimumCalls: 2, timeout: 1000, resetTimeout: 0 },
    steps: [
      [0, 'F'],
      [1000, 'F'],
    ],
    trips: [false, false],
    failuresAt: [1000, 1],
  },
  {
    name: 'rate: a slot reused after wrap-around starts from zero',
    policy: { failureRateThreshold: 50, minimumCalls: 3, timeout: 1000, resetTimeout: 0 },
    steps: [
      [0, 'F'],
      [1, 'F'],
      [1000, 'S'],
      [1001, 'F'],
    ],
    trips: [false, false, false],
    failuresAt: [1001, 1],
  },
  {
    name: 'rate: a non-integer bucket width (timeout 15) keeps nine widths',
    policy: { failureRateThreshold: 50, minimumCalls: 2, timeout: 15, resetTimeout: 0 },
    steps: [
      [0, 'F'],
      [13, 'F'],
    ],
    trips: [false, true],
  },
  {
    name: 'rate: a non-integer bucket width (timeout 15) drops the tenth width',
    policy: { failureRateThreshold: 50, minimumCalls: 2, timeout: 15, resetTimeout: 0 },
    steps: [
      [0, 'F'],
      [15, 'F'],
    ],
    trips: [false, false],
  },
  {
    name: 'rate: a success reaching minimumCalls over the rate does not trip; the next failure does',
    policy: { failureRateThreshold: 50, minimumCalls: 3, timeout: 1000, resetTimeout: 0 },
    steps: [
      [0, 'F'],
      [1, 'F'],
      [2, 'S'],
      [3, 'F'],
    ],
    trips: [false, false, true],
  },
  {
    name: 'rate: a negative clock reading lands in a valid slot',
    policy: { failureRateThreshold: 50, minimumCalls: 2, timeout: 1000, resetTimeout: 0 },
    steps: [
      [-50, 'F'],
      [-10, 'F'],
    ],
    trips: [false, true],
  },
  // Both arms: reset.
  {
    name: 'count: reset empties the window',
    policy: { threshold: 2, timeout: 1000, resetTimeout: 0 },
    steps: [
      [0, 'F'],
      [1, 'R'],
      [2, 'F'],
    ],
    trips: [false, false],
    failuresAt: [2, 1],
  },
  {
    name: 'rate: reset empties the window',
    policy: { failureRateThreshold: 50, minimumCalls: 2, timeout: 1000, resetTimeout: 0 },
    steps: [
      [0, 'F'],
      [1, 'R'],
      [2, 'F'],
    ],
    trips: [false, false],
    failuresAt: [2, 1],
  },
];

describe('createBreakerWindow — conformance', () => {
  it.each(CONFORMANCE)('$name', (row) => {
    let clock = 0;
    const window = createBreakerWindow(row.policy, () => clock);
    const trips: boolean[] = [];
    for (const [at, op] of row.steps) {
      clock = at;
      if (op === 'S') window.recordSuccess();
      else if (op === 'F') trips.push(window.recordFailure());
      else window.reset();
    }
    expect(trips).toEqual(row.trips);
    if (row.failuresAt !== undefined) {
      clock = row.failuresAt[0];
      expect(window.failures).toBe(row.failuresAt[1]);
    }
  });

  it('reads the clock only when the count arm records a failure or reports failures', () => {
    let reads = 0;
    const window = createBreakerWindow(COUNT, () => {
      reads++;
      return 0;
    });
    window.recordSuccess();
    expect(reads).toBe(0);
    window.recordFailure();
    expect(reads).toBe(1);
    expect(window.failures).toBe(1);
    expect(reads).toBe(2);
  });

  it('copies the policy, so mutating the caller object later changes nothing', () => {
    const policy = { threshold: 2, timeout: 1000, resetTimeout: 0 };
    const window = createBreakerWindow(policy, () => 0);
    policy.threshold = 100;
    window.recordFailure();
    expect(window.recordFailure()).toBe(true);

    const rate = { failureRateThreshold: 50, minimumCalls: 2, timeout: 1000, resetTimeout: 0 };
    const rateWindow = createBreakerWindow(rate, () => 0);
    rate.minimumCalls = 100;
    rateWindow.recordFailure();
    expect(rateWindow.recordFailure()).toBe(true);
  });

  it('reads each field once, so a getter cannot pass the check and then change', () => {
    let reads = 0;
    const policy = {
      get threshold(): number {
        reads++;
        return reads === 1 ? 2 : Number.NaN;
      },
      timeout: 1000,
      resetTimeout: 0,
    };
    const window = createBreakerWindow(policy, () => 0);
    expect(reads).toBe(1);
    window.recordFailure();
    expect(window.recordFailure()).toBe(true);
  });

  it('throws the same RangeError breakerPolicyRangeError returns', () => {
    const policy = { threshold: 0, timeout: 1000, resetTimeout: 0 };
    const expected = breakerPolicyRangeError(policy);
    expect(expected).toBeInstanceOf(RangeError);
    expect(() => createBreakerWindow(policy, () => 0)).toThrow(RangeError);
    expect(() => createBreakerWindow(policy, () => 0)).toThrow(expected!.message);
  });
});

interface RefusalRow {
  readonly name: string;
  readonly policy: unknown;
  /** The exact message, or `null` for a valid policy. */
  readonly message: string | null;
}

const BOTH = 'circuitBreaker must set either threshold or failureRateThreshold, not both';
const NEITHER =
  'circuitBreaker must set either threshold or failureRateThreshold, received neither';
const MAX = 2_147_483_647;
const count = (overrides: Record<string, unknown>): unknown => ({
  threshold: 1,
  timeout: 1000,
  resetTimeout: 0,
  ...overrides,
});
const rate = (overrides: Record<string, unknown>): unknown => ({
  failureRateThreshold: 50,
  minimumCalls: 1,
  timeout: 1000,
  resetTimeout: 0,
  ...overrides,
});

const REFUSALS: readonly RefusalRow[] = [
  {
    name: 'both arms',
    policy: count({ failureRateThreshold: 50, minimumCalls: 1 }),
    message: BOTH,
  },
  { name: 'threshold with minimumCalls', policy: count({ minimumCalls: 2 }), message: BOTH },
  {
    name: 'threshold with failureRateThreshold',
    policy: count({ failureRateThreshold: 50 }),
    message: BOTH,
  },
  {
    name: 'minimumCalls alone',
    policy: { minimumCalls: 2, timeout: 1000, resetTimeout: 0 },
    message: NEITHER,
  },
  { name: 'no arm', policy: { timeout: 1000, resetTimeout: 0 }, message: NEITHER },
  {
    name: 'failureRateThreshold without minimumCalls',
    policy: { failureRateThreshold: 50, timeout: 1000, resetTimeout: 0 },
    message: 'circuitBreaker.minimumCalls must be a positive safe integer; received undefined',
  },
  {
    name: 'threshold 0',
    policy: count({ threshold: 0 }),
    message: 'circuitBreaker.threshold must be a positive safe integer; received 0',
  },
  {
    name: 'threshold 1.5',
    policy: count({ threshold: 1.5 }),
    message: 'circuitBreaker.threshold must be a positive safe integer; received 1.5',
  },
  {
    name: 'threshold NaN',
    policy: count({ threshold: Number.NaN }),
    message: 'circuitBreaker.threshold must be a positive safe integer; received NaN',
  },
  {
    name: 'threshold as a string',
    policy: count({ threshold: '3' }),
    message: 'circuitBreaker.threshold must be a positive safe integer; received "3"',
  },
  {
    name: 'threshold beyond the safe integers',
    policy: count({ threshold: Number.MAX_SAFE_INTEGER + 1 }),
    message: 'circuitBreaker.threshold must be a positive safe integer; received 9007199254740992',
  },
  {
    name: 'an unprintable threshold',
    policy: count({ threshold: Object.create(null) as unknown }),
    message:
      'circuitBreaker.threshold must be a positive safe integer; received an unprintable value',
  },
  {
    name: 'failureRateThreshold 0.5',
    policy: rate({ failureRateThreshold: 0.5 }),
    message:
      'circuitBreaker.failureRateThreshold must be a finite number from 1 to 100; received 0.5',
  },
  {
    name: 'failureRateThreshold 101',
    policy: rate({ failureRateThreshold: 101 }),
    message:
      'circuitBreaker.failureRateThreshold must be a finite number from 1 to 100; received 101',
  },
  {
    name: 'failureRateThreshold Infinity',
    policy: rate({ failureRateThreshold: Number.POSITIVE_INFINITY }),
    message:
      'circuitBreaker.failureRateThreshold must be a finite number from 1 to 100; received Infinity',
  },
  {
    name: 'minimumCalls 0',
    policy: rate({ minimumCalls: 0 }),
    message: 'circuitBreaker.minimumCalls must be a positive safe integer; received 0',
  },
  {
    name: 'minimumCalls 2.5',
    policy: rate({ minimumCalls: 2.5 }),
    message: 'circuitBreaker.minimumCalls must be a positive safe integer; received 2.5',
  },
  {
    name: 'count timeout 0',
    policy: count({ timeout: 0 }),
    message: `circuitBreaker.timeout must be a finite number greater than 0 and at most ${MAX}; received 0`,
  },
  {
    name: 'count timeout above the timer range',
    policy: count({ timeout: MAX + 1 }),
    message: `circuitBreaker.timeout must be a finite number greater than 0 and at most ${MAX}; received 2147483648`,
  },
  {
    name: 'count timeout missing',
    policy: { threshold: 1, resetTimeout: 0 },
    message: `circuitBreaker.timeout must be a finite number greater than 0 and at most ${MAX}; received undefined`,
  },
  {
    name: 'rate timeout under 10',
    policy: rate({ timeout: 9.99 }),
    message: `circuitBreaker.timeout must be a finite number from 10 to ${MAX}; received 9.99`,
  },
  {
    name: 'rate timeout Infinity',
    policy: rate({ timeout: Number.POSITIVE_INFINITY }),
    message: `circuitBreaker.timeout must be a finite number from 10 to ${MAX}; received Infinity`,
  },
  {
    name: 'resetTimeout -1',
    policy: count({ resetTimeout: -1 }),
    message: `circuitBreaker.resetTimeout must be a finite number from 0 to ${MAX}; received -1`,
  },
  {
    name: 'resetTimeout above the timer range',
    policy: rate({ resetTimeout: MAX + 1 }),
    message: `circuitBreaker.resetTimeout must be a finite number from 0 to ${MAX}; received 2147483648`,
  },
  // Valid boundaries.
  { name: 'count lower bounds', policy: count({ timeout: 0.001, resetTimeout: 0 }), message: null },
  { name: 'count upper bounds', policy: count({ timeout: MAX, resetTimeout: MAX }), message: null },
  {
    name: 'rate lower bounds',
    policy: rate({ failureRateThreshold: 1, minimumCalls: 1, timeout: 10 }),
    message: null,
  },
  {
    name: 'rate upper bounds',
    policy: rate({
      failureRateThreshold: 100,
      minimumCalls: Number.MAX_SAFE_INTEGER,
      timeout: MAX,
      resetTimeout: MAX,
    }),
    message: null,
  },
  { name: 'rate with threshold: undefined', policy: rate({ threshold: undefined }), message: null },
  {
    name: 'count with rate fields undefined',
    policy: count({ failureRateThreshold: undefined, minimumCalls: undefined }),
    message: null,
  },
];

describe('breakerPolicyRangeError — refusals', () => {
  it.each(REFUSALS)('$name', (row) => {
    const error = breakerPolicyRangeError(row.policy as CircuitBreakerPolicy);
    if (row.message === null) {
      expect(error).toBeNull();
    } else {
      expect(error).toBeInstanceOf(RangeError);
      expect(error?.message).toBe(row.message);
    }
  });
});

describe('CircuitBreakerPolicy — type rows', () => {
  it('refuses a literal with fields of both arms, and a rate literal missing minimumCalls', () => {
    // @ts-expect-error — a rate field on the count arm
    const both: CircuitBreakerPolicy = {
      threshold: 1,
      failureRateThreshold: 50,
      timeout: 1000,
      resetTimeout: 0,
    };
    // @ts-expect-error — the rate arm requires minimumCalls
    const partial: CircuitBreakerPolicy = {
      failureRateThreshold: 50,
      timeout: 1000,
      resetTimeout: 0,
    };
    expect(breakerPolicyRangeError(both)?.message).toBe(BOTH);
    expect(breakerPolicyRangeError(partial)).toBeInstanceOf(RangeError);
  });
});
