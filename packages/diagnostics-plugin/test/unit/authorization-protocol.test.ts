import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  isAuthorizationBatchProjection,
  projectAuthorizationBatch,
  readAuthorizationSourceBatch,
} from '../../src/protocol/authorization-protocol.ts';

const INSTANCE = 'instance-uuid';

/** Reads the decisions list of a batch fixture with a known element type. */
function decisionsOf(batch: Record<string, unknown>): Array<Record<string, unknown>> {
  return batch.decisions as Array<Record<string, unknown>>;
}

/** One well-formed single-check decision. */
function decision(
  sequence: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sequence,
    id: `d${sequence}`,
    operation: 'role',
    result: true,
    ruleAliases: ['A'],
    steps: [{ ruleAlias: 'A', reason: 'direct-role' }],
    stepsEvaluated: 1,
    stepsTruncated: false,
    reason: 'direct-role',
    ageMs: 0,
    ...overrides,
  };
}

/** One well-formed compound decision. */
function compoundDecision(
  sequence: number,
  steps: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sequence,
    id: `d${sequence}`,
    operation: 'any-role',
    result: false,
    ruleAliases: steps.map((step) => step.ruleAlias),
    steps,
    stepsEvaluated: steps.length,
    stepsTruncated: false,
    reason: 'compound-unsatisfied',
    ageMs: 0,
    ...overrides,
  };
}

/** One well-formed source batch. */
function sourceBatch(
  after: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const decisions: Array<Record<string, unknown>> = after === 0
    ? [
      decision(1),
      compoundDecision(2, [
        { ruleAlias: 'A', reason: 'not-held' },
        { ruleAlias: 'E', reason: 'direct-role' },
      ]),
    ]
    : [];
  const last = decisions.length > 0 ? (decisions[decisions.length - 1]!.sequence as number) : after;
  const first = decisions.length > 0 ? (decisions[0]!.sequence as number) : after;
  return {
    version: 1,
    instanceId: INSTANCE,
    state: decisions.length > 0 ? 'ready' : 'no-data',
    decisions,
    next: last,
    lost: decisions.length > 0 ? first - after - 1 : 0,
    closed: false,
    droppedUnapproved: 0,
    ...overrides,
  };
}

describe('readAuthorizationSourceBatch — the exact source validator', () => {
  it('accepts a well-formed ready batch and copies it field by field', () => {
    const batch = sourceBatch(0);
    const validated = readAuthorizationSourceBatch(batch, INSTANCE, 0, 128);
    expect(validated).not.toBeNull();
    expect(validated!.state).toBe('ready');
    expect(validated!.decisions).toHaveLength(2);
    expect(validated!.next).toBe(2);
    expect(validated!.lost).toBe(0);
    // The copy is independent of the source object.
    expect(validated!.decisions).not.toBe(batch.decisions);
  });

  it('accepts an empty batch that echoes the cursor', () => {
    const validated = readAuthorizationSourceBatch(sourceBatch(7), INSTANCE, 7, 128);
    expect(validated).not.toBeNull();
    expect(validated!.decisions).toHaveLength(0);
    expect(validated!.next).toBe(7);
    expect(validated!.lost).toBe(0);
  });

  it('accepts an unsupported batch with a fixed coverage', () => {
    const validated = readAuthorizationSourceBatch(
      sourceBatch(7, { state: 'unsupported', coverage: 'custom-provider' }),
      INSTANCE,
      7,
      128,
    );
    expect(validated).not.toBeNull();
    expect(validated!.coverage).toBe('custom-provider');
  });

  it('refuses an unsupported batch without coverage', () => {
    expect(
      readAuthorizationSourceBatch(
        sourceBatch(7, { state: 'unsupported' }),
        INSTANCE,
        7,
        128,
      ),
    ).toBeNull();
  });

  it('refuses a non-unsupported batch that carries coverage', () => {
    expect(
      readAuthorizationSourceBatch(
        sourceBatch(0, { coverage: 'unknown' }),
        INSTANCE,
        0,
        128,
      ),
    ).toBeNull();
  });

  it('refuses a disabled or unsupported batch carrying decisions', () => {
    // A disabled batch with no decisions is valid (the source observes nothing).
    expect(
      readAuthorizationSourceBatch(
        sourceBatch(7, { state: 'disabled' }),
        INSTANCE,
        7,
        128,
      ),
    ).not.toBeNull();
    // The same state carrying decisions is refused.
    expect(
      readAuthorizationSourceBatch(
        sourceBatch(0, { state: 'disabled' }),
        INSTANCE,
        0,
        128,
      ),
    ).toBeNull();
  });

  it('refuses a closed batch carrying decisions', () => {
    expect(
      readAuthorizationSourceBatch(
        sourceBatch(0, { closed: true, decisions: [decision(1)] }),
        INSTANCE,
        0,
        128,
      ),
    ).toBeNull();
  });

  it('refuses an unknown, missing or extra batch key', () => {
    const extra = { ...sourceBatch(0), unknown: true };
    expect(readAuthorizationSourceBatch(extra, INSTANCE, 0, 128)).toBeNull();
    const missing = { ...sourceBatch(0) };
    delete missing.droppedUnapproved;
    expect(readAuthorizationSourceBatch(missing, INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses the wrong version or instance', () => {
    expect(readAuthorizationSourceBatch(sourceBatch(0, { version: 2 }), INSTANCE, 0, 128))
      .toBeNull();
    expect(readAuthorizationSourceBatch(sourceBatch(0), 'other', 0, 128)).toBeNull();
  });

  it('refuses a state outside the fixed vocabulary', () => {
    expect(readAuthorizationSourceBatch(sourceBatch(0, { state: 'bogus' }), INSTANCE, 0, 128))
      .toBeNull();
  });

  it('refuses more decisions than the requested limit', () => {
    expect(
      readAuthorizationSourceBatch(
        sourceBatch(0, { decisions: [decision(1), decision(2)], next: 2 }),
        INSTANCE,
        0,
        1,
      ),
    ).toBeNull();
  });

  it('refuses sequences that do not increase past the cursor', () => {
    expect(
      readAuthorizationSourceBatch(
        sourceBatch(0, { decisions: [decision(1), decision(1)], next: 1 }),
        INSTANCE,
        0,
        128,
      ),
    ).toBeNull();
    // A sequence at or below the cursor.
    expect(
      readAuthorizationSourceBatch(
        sourceBatch(3, { decisions: [decision(3)], next: 3, lost: 0 }),
        INSTANCE,
        3,
        128,
      ),
    ).toBeNull();
  });

  it('refuses a next/lost pair that disagrees with the decisions', () => {
    expect(
      readAuthorizationSourceBatch(
        sourceBatch(0, { next: 99 }),
        INSTANCE,
        0,
        128,
      ),
    ).toBeNull();
    expect(
      readAuthorizationSourceBatch(
        sourceBatch(0, { lost: 99 }),
        INSTANCE,
        0,
        128,
      ),
    ).toBeNull();
  });

  it('refuses a decision with an unknown key or a bad id grammar', () => {
    const badId = sourceBatch(0);
    decisionsOf(badId)[0]!.id = 'd0';
    expect(readAuthorizationSourceBatch(badId, INSTANCE, 0, 128)).toBeNull();
    const extraKey = sourceBatch(0);
    decisionsOf(extraKey)[0]!.extra = true;
    expect(readAuthorizationSourceBatch(extraKey, INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses an alias outside the display shape', () => {
    const control = sourceBatch(0);
    decisionsOf(control)[0]!.ruleAliases = ['a\nb'];
    expect(readAuthorizationSourceBatch(control, INSTANCE, 0, 128)).toBeNull();
    const tooLong = sourceBatch(0);
    decisionsOf(tooLong)[0]!.ruleAliases = ['x'.repeat(65)];
    expect(readAuthorizationSourceBatch(tooLong, INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses a reason or operation outside the fixed vocabulary', () => {
    const badReason = sourceBatch(0);
    decisionsOf(badReason)[0]!.reason = 'bogus';
    expect(readAuthorizationSourceBatch(badReason, INSTANCE, 0, 128)).toBeNull();
    const badOperation = sourceBatch(0);
    decisionsOf(badOperation)[0]!.operation = 'bogus';
    expect(readAuthorizationSourceBatch(badOperation, INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses a single decision with more than one step or truncation', () => {
    const multiStep = sourceBatch(0);
    decisionsOf(multiStep)[0]!.steps = [
      { ruleAlias: 'A', reason: 'direct-role' },
      { ruleAlias: 'B', reason: 'direct-role' },
    ];
    expect(readAuthorizationSourceBatch(multiStep, INSTANCE, 0, 128)).toBeNull();
    const truncated = sourceBatch(0);
    decisionsOf(truncated)[0]!.stepsTruncated = true;
    expect(readAuthorizationSourceBatch(truncated, INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses a compound decision whose count contradicts its steps', () => {
    const undercount = sourceBatch(0);
    const compound = decisionsOf(undercount)[1]!;
    compound.stepsEvaluated = 1;
    expect(readAuthorizationSourceBatch(undercount, INSTANCE, 0, 128)).toBeNull();
  });

  it('accepts a truncated compound decision with a saturating count', () => {
    const steps = Array.from({ length: 16 }, (_value, index) => ({
      ruleAlias: `r${index}`,
      reason: 'not-held',
    }));
    const truncated = sourceBatch(0, {
      decisions: [
        compoundDecision(1, steps, {
          ruleAliases: Array.from({ length: 20 }, (_value, index) => `r${index}`),
          stepsEvaluated: 20,
          stepsTruncated: true,
        }),
      ],
      next: 1,
      lost: 0,
    });
    const validated = readAuthorizationSourceBatch(truncated, INSTANCE, 0, 128);
    expect(validated).not.toBeNull();
    expect(validated!.decisions[0]!.stepsTruncated).toBe(true);
    expect(validated!.decisions[0]!.stepsEvaluated).toBe(20);
  });

  describe('step-count invariants — a partial trace can never pass as complete', () => {
    const sixteen = Array.from({ length: 16 }, (_value, index) => ({
      ruleAlias: `r${index}`,
      reason: 'not-held',
    }));
    const twenty = Array.from({ length: 20 }, (_value, index) => `r${index}`);
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      [
        'an untruncated compound that evaluated more steps than it retains',
        compoundDecision(1, sixteen.slice(0, 2), { ruleAliases: twenty, stepsEvaluated: 5 }),
      ],
      [
        'a compound claiming truncation at 16 or fewer evaluated steps',
        compoundDecision(1, sixteen, { stepsEvaluated: 16, stepsTruncated: true }),
      ],
      [
        'a truncated compound retaining fewer than 16 steps',
        compoundDecision(1, sixteen.slice(0, 10), {
          ruleAliases: twenty,
          stepsEvaluated: 20,
          stepsTruncated: true,
        }),
      ],
      [
        'a compound that names no rule yet claims evaluated steps',
        compoundDecision(1, [], { ruleAliases: [], stepsEvaluated: 1 }),
      ],
      [
        'an evaluated count above 16 with truncation denied',
        compoundDecision(1, sixteen, { ruleAliases: twenty, stepsEvaluated: 20 }),
      ],
      ['a single check naming two rules', decision(1, { ruleAliases: ['A', 'B'] })],
    ];
    for (const [label, bad] of cases) {
      it(`refuses ${label} on both validators`, () => {
        const batch = sourceBatch(0, { decisions: [bad], next: 1, lost: 0 });
        expect(readAuthorizationSourceBatch(batch, INSTANCE, 0, 128)).toBeNull();
        expect(isAuthorizationBatchProjection({ ...batch })).toBe(false);
      });
    }

    it('accepts an empty compound (hasAnyRole over no roles) with zero steps', () => {
      const batch = sourceBatch(0, {
        decisions: [compoundDecision(1, [], { ruleAliases: [] })],
        next: 1,
        lost: 0,
      });
      const validated = readAuthorizationSourceBatch(batch, INSTANCE, 0, 128);
      expect(validated!.decisions[0]!.stepsEvaluated).toBe(0);
      expect(isAuthorizationBatchProjection(projectAuthorizationBatch(validated!, INSTANCE)))
        .toBe(true);
    });

    it('accepts a compound whose repeated rule evaluated more steps than distinct rules', () => {
      // `requireAnyRole(['a', 'a', …])` evaluates each occurrence while the
      // collector names the rule once (Finding #2, round 3).
      const repeated = Array.from({ length: 16 }, () => ({ ruleAlias: 'A', reason: 'not-held' }));
      const batch = sourceBatch(0, {
        decisions: [
          compoundDecision(1, repeated, {
            ruleAliases: ['A'],
            stepsEvaluated: 129,
            stepsTruncated: true,
          }),
        ],
        next: 1,
        lost: 0,
      });
      const validated = readAuthorizationSourceBatch(batch, INSTANCE, 0, 128);
      expect(validated).not.toBeNull();
      expect(isAuthorizationBatchProjection(projectAuthorizationBatch(validated!, INSTANCE)))
        .toBe(true);
    });

    it('refuses a single check naming no rule', () => {
      const batch = sourceBatch(0, {
        decisions: [decision(1, { ruleAliases: [] })],
        next: 1,
        lost: 0,
      });
      expect(readAuthorizationSourceBatch(batch, INSTANCE, 0, 128)).toBeNull();
      expect(isAuthorizationBatchProjection({ ...batch })).toBe(false);
    });

    it('accepts a complete compound that evaluated exactly 16 steps', () => {
      const batch = sourceBatch(0, {
        decisions: [compoundDecision(1, sixteen, { ruleAliases: twenty, stepsEvaluated: 16 })],
        next: 1,
        lost: 0,
      });
      const validated = readAuthorizationSourceBatch(batch, INSTANCE, 0, 128);
      expect(validated!.decisions[0]!.stepsTruncated).toBe(false);
      expect(isAuthorizationBatchProjection(projectAuthorizationBatch(validated!, INSTANCE)))
        .toBe(true);
    });
  });

  it('reads result and coverage exactly once, so a flipping getter cannot reach the copy', () => {
    let resultReads = 0;
    const flippingDecision = decision(1);
    Object.defineProperty(flippingDecision, 'result', {
      enumerable: true,
      get: () => (resultReads++ === 0 ? true : 'CANARY'),
    });
    const withFlip = sourceBatch(0, { decisions: [flippingDecision], next: 1, lost: 0 });
    const validated = readAuthorizationSourceBatch(withFlip, INSTANCE, 0, 128);
    expect(validated!.decisions[0]!.result).toBe(true);
    expect(resultReads).toBe(1);

    let coverageReads = 0;
    const unsupported = sourceBatch(5, { state: 'unsupported' });
    Object.defineProperty(unsupported, 'coverage', {
      enumerable: true,
      get: () => (coverageReads++ === 0 ? 'unknown' : 'CANARY'),
    });
    expect(readAuthorizationSourceBatch(unsupported, INSTANCE, 5, 128)!.coverage).toBe('unknown');
    expect(coverageReads).toBe(1);
  });

  it('accepts a truncated compound whose complete rule set exceeds the 16-step budget', () => {
    // Plan §3.3: ruleAliases is the COMPLETE requested rule set (bounded by the
    // approved-map ceiling of 128), not by the 16-step retention budget that
    // bounds steps. A hasAnyRole over 20 requested roles that short-circuits at
    // step 20 is retained with its full 20-alias list and stepsTruncated: true
    // — it must pass the wire, not poison the batch as collection-failed.
    const steps = Array.from({ length: 16 }, (_value, index) => ({
      ruleAlias: `r${index}`,
      reason: index === 15 ? 'direct-role' : 'not-held',
    }));
    const ruleAliases = Array.from({ length: 20 }, (_value, index) => `r${index}`);
    const truncated = sourceBatch(0, {
      decisions: [
        compoundDecision(1, steps, {
          ruleAliases,
          result: true,
          reason: 'compound-satisfied',
          stepsEvaluated: 20,
          stepsTruncated: true,
        }),
      ],
      next: 1,
      lost: 0,
    });
    const validated = readAuthorizationSourceBatch(truncated, INSTANCE, 0, 128);
    expect(validated).not.toBeNull();
    expect(validated!.decisions[0]!.ruleAliases).toHaveLength(20);
    expect(validated!.decisions[0]!.steps).toHaveLength(16);
    expect(validated!.decisions[0]!.stepsTruncated).toBe(true);
    expect(validated!.decisions[0]!.stepsEvaluated).toBe(20);
    // The projection validator (run by the connector before signing and by the
    // client before parsing) accepts the same decision.
    const projected = projectAuthorizationBatch(validated!, INSTANCE);
    expect(isAuthorizationBatchProjection(projected)).toBe(true);
    const projectedDecisions = projected.decisions as Array<Record<string, unknown>>;
    expect(projectedDecisions[0]!.ruleAliases).toHaveLength(20);
  });

  it('refuses a decision whose rule-alias list exceeds the 128 approved-rule ceiling', () => {
    const steps = Array.from({ length: 16 }, (_value, index) => ({
      ruleAlias: `r${index}`,
      reason: 'not-held',
    }));
    const overCeiling = sourceBatch(0, {
      decisions: [
        compoundDecision(1, steps, {
          ruleAliases: Array.from({ length: 129 }, (_value, index) => `r${index}`),
          stepsEvaluated: 20,
          stepsTruncated: true,
        }),
      ],
      next: 1,
      lost: 0,
    });
    expect(readAuthorizationSourceBatch(overCeiling, INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses a step with a viaRoleAlias outside the display shape', () => {
    const badVia = sourceBatch(0);
    decisionsOf(badVia)[0]!.steps = [
      { ruleAlias: 'A', reason: 'inherited-role', viaRoleAlias: 'x'.repeat(65) },
    ];
    expect(readAuthorizationSourceBatch(badVia, INSTANCE, 0, 128)).toBeNull();
  });

  it('treats a throwing getter as a refusal', () => {
    const hostile: Record<string, unknown> = { ...sourceBatch(0) };
    Object.defineProperty(hostile, 'decisions', {
      get() {
        throw new Error('boom');
      },
    });
    expect(readAuthorizationSourceBatch(hostile, INSTANCE, 0, 128)).toBeNull();
  });

  it('never iterates a hostile list beyond the budget', () => {
    // An array subclass that reports one length but iterates forever.
    class HostileArray extends Array {
      override get length(): number {
        return 1;
      }
    }
    const hostile = sourceBatch(0);
    const evil = new HostileArray() as unknown as unknown[];
    evil[0] = decision(1);
    Object.defineProperty(evil, Symbol.iterator, {
      value: function* () {
        while (true) {
          yield decision(1);
        }
      },
    });
    hostile.decisions = evil;
    // Must not hang: the validator reads by index and refuses.
    expect(readAuthorizationSourceBatch(hostile, INSTANCE, 0, 1)).toBeNull();
  });
});

describe('projectAuthorizationBatch — the wire projection', () => {
  it('projects a validated batch into the exact wire record', () => {
    const validated = readAuthorizationSourceBatch(sourceBatch(0), INSTANCE, 0, 128)!;
    const projected = projectAuthorizationBatch(validated, INSTANCE);
    expect(projected).toEqual({
      version: 1,
      instanceId: INSTANCE,
      state: 'ready',
      decisions: [
        {
          sequence: 1,
          id: 'd1',
          operation: 'role',
          result: true,
          ruleAliases: ['A'],
          steps: [{ ruleAlias: 'A', reason: 'direct-role' }],
          stepsEvaluated: 1,
          stepsTruncated: false,
          reason: 'direct-role',
          ageMs: 0,
        },
        {
          sequence: 2,
          id: 'd2',
          operation: 'any-role',
          result: false,
          ruleAliases: ['A', 'E'],
          steps: [
            { ruleAlias: 'A', reason: 'not-held' },
            { ruleAlias: 'E', reason: 'direct-role' },
          ],
          stepsEvaluated: 2,
          stepsTruncated: false,
          reason: 'compound-unsatisfied',
          ageMs: 0,
        },
      ],
      next: 2,
      lost: 0,
      closed: false,
      droppedUnapproved: 0,
    });
  });

  it('omits coverage from a non-unsupported batch and includes it from an unsupported one', () => {
    const ready = projectAuthorizationBatch(
      readAuthorizationSourceBatch(sourceBatch(0), INSTANCE, 0, 128)!,
      INSTANCE,
    );
    expect(Object.hasOwn(ready, 'coverage')).toBe(false);
    const unsupported = projectAuthorizationBatch(
      readAuthorizationSourceBatch(
        sourceBatch(7, { state: 'unsupported', coverage: 'unknown' }),
        INSTANCE,
        7,
        128,
      )!,
      INSTANCE,
    );
    expect(unsupported.coverage).toBe('unknown');
  });

  it('includes viaRoleAlias and policyRevision only when present', () => {
    const withVia = sourceBatch(0, {
      decisions: [decision(1, { viaRoleAlias: 'A', policyRevision: 'rev-1' })],
      next: 1,
    });
    const projected = projectAuthorizationBatch(
      readAuthorizationSourceBatch(withVia, INSTANCE, 0, 128)!,
      INSTANCE,
    );
    const projectedDecision = decisionsOf(projected)[0]!;
    expect(projectedDecision.viaRoleAlias).toBe('A');
    expect(projectedDecision.policyRevision).toBe('rev-1');
  });
});

describe('isAuthorizationBatchProjection — the shared wire validator', () => {
  it('accepts a well-formed projection', () => {
    const validated = readAuthorizationSourceBatch(sourceBatch(0), INSTANCE, 0, 128)!;
    expect(isAuthorizationBatchProjection(projectAuthorizationBatch(validated, INSTANCE))).toBe(
      true,
    );
  });

  it('refuses a projection with an extra key', () => {
    const projected = projectAuthorizationBatch(
      readAuthorizationSourceBatch(sourceBatch(0), INSTANCE, 0, 128)!,
      INSTANCE,
    );
    expect(isAuthorizationBatchProjection({ ...projected, extra: true })).toBe(false);
  });

  it('refuses a projection with an empty instance', () => {
    const projected = projectAuthorizationBatch(
      readAuthorizationSourceBatch(sourceBatch(0), INSTANCE, 0, 128)!,
      INSTANCE,
    );
    expect(isAuthorizationBatchProjection({ ...projected, instanceId: '' })).toBe(false);
  });

  it('refuses a projection whose sequences do not increase', () => {
    const projected = projectAuthorizationBatch(
      readAuthorizationSourceBatch(sourceBatch(0), INSTANCE, 0, 128)!,
      INSTANCE,
    );
    const decisions = decisionsOf(projected);
    decisions[1]!.sequence = 1;
    expect(isAuthorizationBatchProjection(projected)).toBe(false);
  });

  it('refuses a projection with more than 128 decisions', () => {
    const decisions = Array.from({ length: 129 }, (_value, index) => decision(index + 1));
    expect(
      isAuthorizationBatchProjection({
        version: 1,
        instanceId: INSTANCE,
        state: 'ready',
        decisions,
        next: 129,
        lost: 0,
        closed: false,
        droppedUnapproved: 0,
      }),
    ).toBe(false);
  });
});
