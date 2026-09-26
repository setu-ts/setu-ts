/**
 * The core M98a snapshot and batch validators, driven as tables: each hostile
 * case is exactly ONE change from a baseline the validator accepts, so a
 * refusal can only come from the change under test. The baselines exercise
 * every node kind with every optional field and every optional event field,
 * so a contract check cannot pass merely because the field was absent.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { isBatchProjection, isSnapshotProjection } from '../../src/protocol/protocol.ts';
import { TEST_INSTANCE_ID } from '../fixtures/helpers.ts';

type Json = Record<string, unknown>;

/**
 * A snapshot carrying every node kind with every field its kind admits.
 *
 * @returns A fresh, fully populated snapshot
 */
function fullSnapshot(): Json {
  return {
    version: 1,
    instanceId: TEST_INSTANCE_ID,
    state: 'running',
    failureCode: null,
    nodes: [
      { id: 'p1', kind: 'plugin', label: 'catalog', version: '1.2.3-rc.1+build.7' },
      { id: 'c1', kind: 'capability', label: 'catalog-items', registered: true },
      { id: 'r1', kind: 'route', label: '/items/:id', method: 'GET' },
      { id: 'm1', kind: 'middleware', label: 'audit', priority: -2.5, position: 1 },
      { id: 'm2', kind: 'middleware', position: 2 },
      { id: 'p2', kind: 'plugin' },
    ],
    edges: [
      { from: 'p1', to: 'c1', kind: 'provides' },
      { from: 'p1', to: 'c1', kind: 'owns' },
      { from: 'p1', to: 'r1', kind: 'owns' },
      { from: 'p2', to: 'c1', kind: 'requires' },
      { from: 'p2', to: 'c1', kind: 'optional' },
      { from: 'p2', to: 'c1', kind: 'consumes' },
    ],
    truncated: false,
    droppedEvents: 0,
  };
}

/**
 * One event carrying every optional field.
 *
 * @param sequence - The event sequence
 * @returns A fresh, fully populated event
 */
function fullEvent(sequence: number): Json {
  return {
    sequence,
    operationId: `op${sequence}`,
    parentOperationId: 'op1',
    kind: 'handler',
    stage: 'handler',
    nodeId: 'r1',
    outcome: 'ok',
    atMs: 1.5,
    durationMs: 0,
    statusCode: 201,
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
  };
}

/**
 * A three-event batch starting at `first`.
 *
 * @param first - The first sequence
 * @returns A fresh batch
 */
function fullBatch(first = 5): Json {
  return {
    version: 1,
    instanceId: TEST_INSTANCE_ID,
    events: [fullEvent(first), fullEvent(first + 1), fullEvent(first + 2)],
    next: first + 2,
    lost: 4,
    closed: false,
  };
}

/** Applies a mutation to a fresh structured copy of a baseline. */
function mutated(base: () => Json, change: (value: Json) => void): Json {
  const copy = structuredClone(base());
  change(copy);
  return copy;
}

/** Shorthand for the snapshot's nodes array. */
function nodesOf(value: Json): Json[] {
  return value.nodes as Json[];
}

/** Shorthand for the snapshot's edges array. */
function edgesOf(value: Json): Json[] {
  return value.edges as Json[];
}

/** Shorthand for the batch's events array. */
function eventsOf(value: Json): Json[] {
  return value.events as Json[];
}

/** Each case is ONE change from `fullSnapshot()` that the contract refuses. */
const HOSTILE_SNAPSHOTS: ReadonlyArray<readonly [string, (value: Json) => void]> = [
  ['an extra top-level key', (v) => {
    v.extra = 1;
  }],
  ['a missing top-level key', (v) => {
    delete v.truncated;
  }],
  ['an empty instance string', (v) => {
    v.instanceId = '';
  }],
  ['a state outside the vocabulary', (v) => {
    v.state = 'exploded';
  }],
  ['a failure code outside the vocabulary', (v) => {
    v.failureCode = 'kernel-panic';
  }],
  ['a fractional drop count', (v) => {
    v.droppedEvents = 1.5;
  }],
  ['a negative drop count', (v) => {
    v.droppedEvents = -1;
  }],
  ['more than 1,024 nodes', (v) => {
    v.nodes = Array.from({ length: 1025 }, (_, i) => ({ id: `p${i + 1}`, kind: 'plugin' }));
    v.edges = [];
  }],
  ['more than 4,096 edges (all distinct and joining present nodes)', (v) => {
    // 65 plugins x 64 capabilities = 4,160 distinct `owns` edges, so the
    // refusal can only come from the edge bound.
    const plugins = Array.from({ length: 65 }, (_, i) => ({ id: `p${i + 1}`, kind: 'plugin' }));
    const capabilities = Array.from({ length: 64 }, (_, i) => ({
      id: `c${i + 1}`,
      kind: 'capability',
    }));
    v.nodes = [...plugins, ...capabilities];
    v.edges = plugins.flatMap((p) =>
      capabilities.map((c) => ({ from: p.id, to: c.id, kind: 'owns' }))
    )
      .slice(0, 4097);
  }],
  ['a node kind outside the vocabulary', (v) => {
    nodesOf(v)[5] = { id: 'p2', kind: 'service' };
  }],
  ['a node id prefix that disagrees with its kind', (v) => {
    nodesOf(v)[0].id = 'c9';
  }],
  ['a non-canonical node id', (v) => {
    nodesOf(v)[5].id = 'p02';
  }],
  ['a duplicate node id', (v) => {
    nodesOf(v)[5].id = 'p1';
  }],
  ['a field outside the node kind (method on a plugin)', (v) => {
    nodesOf(v)[0].method = 'GET';
  }],
  ['an unknown node field', (v) => {
    nodesOf(v)[1].health = 'up';
  }],
  ['a label over 160 UTF-8 bytes', (v) => {
    nodesOf(v)[0].label = 'é'.repeat(81);
  }],
  ['a label carrying a control character', (v) => {
    nodesOf(v)[0].label = 'cat\u001balog';
  }],
  ['a version outside the bounded grammar', (v) => {
    nodesOf(v)[0].version = 'git-9f1c2e';
  }],
  ['a method outside the vocabulary', (v) => {
    nodesOf(v)[2].method = 'TRACE';
  }],
  ['a non-numeric priority', (v) => {
    nodesOf(v)[3].priority = '1';
  }],
  ['a zero position', (v) => {
    nodesOf(v)[4].position = 0;
  }],
  ['a non-boolean registered flag', (v) => {
    nodesOf(v)[1].registered = 'yes';
  }],
  ['an edge kind outside the vocabulary', (v) => {
    edgesOf(v)[0].kind = 'calls';
  }],
  ['an edge to a node not in the snapshot', (v) => {
    edgesOf(v)[0].to = 'c7';
  }],
  ['an edge from a malformed id', (v) => {
    edgesOf(v)[0].from = 'plugin-1';
  }],
  ['a duplicate edge', (v) => {
    edgesOf(v)[1] = { from: 'p1', to: 'c1', kind: 'provides' };
  }],
  ['an extra edge field', (v) => {
    edgesOf(v)[0].weight = 1;
  }],
];

/** Each case is ONE change from `fullBatch()` that the contract refuses. */
const HOSTILE_BATCHES: ReadonlyArray<readonly [string, (value: Json) => void]> = [
  ['an extra top-level key', (v) => {
    v.cursor = 0;
  }],
  ['an empty instance string', (v) => {
    v.instanceId = '';
  }],
  ['more than 128 events', (v) => {
    v.events = Array.from({ length: 129 }, (_, i) => fullEvent(i + 1));
    v.next = 129;
  }],
  ['a negative next', (v) => {
    v.events = [];
    v.next = -1;
  }],
  ['a fractional lost count', (v) => {
    v.lost = 0.5;
  }],
  ['a non-boolean closed flag', (v) => {
    v.closed = 'no';
  }],
  ['next that is not the last returned sequence', (v) => {
    v.next = 99;
  }],
  ['non-consecutive sequences', (v) => {
    eventsOf(v)[2].sequence = 9;
    v.next = 9;
  }],
  ['descending sequences', (v) => {
    eventsOf(v).reverse();
    v.next = 5;
  }],
  ['a zero sequence', (v) => {
    v.events = [fullEvent(0)];
    v.next = 0;
  }],
  ['an extra event field', (v) => {
    eventsOf(v)[0].message = 'boom';
  }],
  ['a missing required event field', (v) => {
    delete eventsOf(v)[0].outcome;
  }],
  ['a malformed operation id', (v) => {
    eventsOf(v)[0].operationId = 'request-5';
  }],
  ['a malformed parent operation id', (v) => {
    eventsOf(v)[0].parentOperationId = 'op01';
  }],
  ['an event kind outside the vocabulary', (v) => {
    eventsOf(v)[0].kind = 'database';
  }],
  ['an event stage outside the vocabulary', (v) => {
    eventsOf(v)[0].stage = 'sql';
  }],
  ['an outcome outside the vocabulary', (v) => {
    eventsOf(v)[0].outcome = 'panicked';
  }],
  ['a malformed node id', (v) => {
    eventsOf(v)[0].nodeId = 'route:1';
  }],
  ['a negative start offset', (v) => {
    eventsOf(v)[0].atMs = -1;
  }],
  ['a string status code', (v) => {
    eventsOf(v)[0].statusCode = '200';
  }],
  ['a non-numeric duration', (v) => {
    eventsOf(v)[0].durationMs = '3';
  }],
  ['an uppercase trace id', (v) => {
    eventsOf(v)[0].traceId = '0AF7651916CD43DD8448EB211C80319C';
  }],
  ['an all-zero trace id', (v) => {
    eventsOf(v)[0].traceId = '0'.repeat(32);
  }],
  ['a short span id', (v) => {
    eventsOf(v)[0].spanId = 'b7ad';
  }],
  ['an all-zero span id', (v) => {
    eventsOf(v)[0].spanId = '0'.repeat(16);
  }],
];

describe('Core snapshot validator — the full M98a contract (F02)', () => {
  it('accepts the fully populated baseline and its nullable/minimal variants', () => {
    // Vacuity guard: every hostile case below mutates THIS object.
    expect(isSnapshotProjection(fullSnapshot())).toBe(true);
    expect(isSnapshotProjection(mutated(fullSnapshot, (v) => {
      v.instanceId = null;
    }))).toBe(true);
    expect(isSnapshotProjection(mutated(fullSnapshot, (v) => {
      v.state = 'failed';
      v.failureCode = 'startup-failed';
      v.nodes = [];
      v.edges = [];
      v.truncated = true;
      v.droppedEvents = Number.MAX_SAFE_INTEGER;
    }))).toBe(true);
    // A middleware priority is recorded verbatim; NaN/Infinity serialize to
    // `null` (audit F-A).
    for (const priority of [null, 1e300, -0.5]) {
      expect(isSnapshotProjection(mutated(fullSnapshot, (v) => {
        nodesOf(v)[3].priority = priority;
      }))).toBe(true);
    }
    // An approved empty label is honest: the allowlist accepts an empty entry.
    expect(isSnapshotProjection(mutated(fullSnapshot, (v) => {
      nodesOf(v)[0].label = '';
    }))).toBe(true);
    // Exactly at the bounds.
    expect(isSnapshotProjection(mutated(fullSnapshot, (v) => {
      nodesOf(v)[0].label = 'é'.repeat(80);
      v.nodes = [
        ...nodesOf(v),
        ...Array.from({ length: 1024 - 6 }, (_, i) => ({ id: `p${i + 3}`, kind: 'plugin' })),
      ];
    }))).toBe(true);
  });

  for (const [label, change] of HOSTILE_SNAPSHOTS) {
    it(`refuses ${label}`, () => {
      expect(isSnapshotProjection(mutated(fullSnapshot, change))).toBe(false);
    });
  }
});

describe('Core batch validator — the full M98a event contract (F02)', () => {
  it('accepts the fully populated baseline and its nullable/minimal variants', () => {
    // Vacuity guard: every hostile case below mutates THIS object.
    expect(isBatchProjection(fullBatch())).toBe(true);
    expect(isBatchProjection(mutated(fullBatch, (v) => {
      v.instanceId = null;
      v.events = [];
      v.next = 17;
      v.lost = 0;
      v.closed = true;
    }))).toBe(true);
    // Every optional field absent, every nullable field null.
    expect(isBatchProjection(mutated(fullBatch, (v) => {
      v.events = [{
        sequence: 1,
        operationId: 'op0',
        parentOperationId: null,
        kind: 'lifecycle',
        stage: 'resolve',
        nodeId: null,
        outcome: 'error',
        atMs: null,
        durationMs: null,
      }];
      v.next = 1;
      v.lost = 0;
    }))).toBe(true);
    // The kernel records a response status verbatim, so any JSON number is
    // honest — and a non-finite status serializes to `null` (audit F-A).
    for (const statusCode of [99, 1000, 200.5, null]) {
      expect(isBatchProjection(mutated(fullBatch, (v) => {
        eventsOf(v)[0].statusCode = statusCode;
      }))).toBe(true);
    }
    // Exactly 128 events.
    expect(isBatchProjection(mutated(fullBatch, (v) => {
      v.events = Array.from({ length: 128 }, (_, i) => fullEvent(i + 1));
      v.next = 128;
    }))).toBe(true);
  });

  for (const [label, change] of HOSTILE_BATCHES) {
    it(`refuses ${label}`, () => {
      expect(isBatchProjection(mutated(fullBatch, change))).toBe(false);
    });
  }

  it('refuses non-record inputs outright', () => {
    for (const value of [null, [], 'batch', 1]) {
      expect(isBatchProjection(value)).toBe(false);
      expect(isSnapshotProjection(value)).toBe(false);
    }
  });
});
