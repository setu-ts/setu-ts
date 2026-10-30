import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFieldMatcher } from '../../src/redaction/field-matcher.ts';
import { DEFAULT_SECRET_FIELD_PATTERNS } from '../../src/redaction/classification.ts';
import { createOldFieldMatcher } from '../fixtures/old-field-matcher.ts';

afterEach(() => vi.unstubAllGlobals());

describe('compiled field matcher', () => {
  it('is equivalent to the old matcher over generated paths, pattern shapes and specificity ties', () => {
    const shapes = [
      '',
      'a',
      'a.b',
      '*',
      '**',
      '**.password',
      'a.*',
      '*.b',
      'a.**',
      '**.a.**',
      'a.**.b',
      '**.*.b',
      '*.**.*',
      '**.**',
      '**.a.**.b',
      'A.B',
      '__proto__',
      '**.constructor',
      'constructor.*',
      '*.password',
      'a..b',
    ];
    // The 300-character atom makes paths too long to cache, so the uncached
    // branch is compared with the old matcher too.
    const atoms = ['', 'a', 'b', 'A', 'password', '__proto__', 'constructor', 'x'.repeat(300)];
    let paths = [''];
    let level = [''];
    for (let depth = 0; depth < 4; depth++) {
      level = level.flatMap((prefix) =>
        atoms.map((atom) => (depth === 0 ? atom : `${prefix}.${atom}`)),
      );
      paths = [...paths, ...level];
    }
    const redactor = () => 'field';
    for (const caseSensitive of [false, true]) {
      const fieldsList = [
        ...shapes.map((shape) => Object.fromEntries([[shape, shape]])),
        Object.fromEntries(
          shapes.map((shape, index) => [
            shape,
            index % 2 === 0 ? shape : { classification: shape, redactor },
          ]),
        ),
        Object.fromEntries([...shapes].reverse().map((shape) => [shape, shape])),
      ];
      for (const fields of fieldsList) {
        const old = createOldFieldMatcher(fields, caseSensitive);
        const current = createFieldMatcher(fields, caseSensitive);
        for (const path of paths) {
          const before = old(path);
          const after = current(path);
          expect(
            after?.classification,
            `${JSON.stringify(fields)} / ${path} / ${caseSensitive}`,
          ).toBe(before?.classification);
          expect(after?.redactor).toBe(before?.redactor);
        }
      }
    }
  });

  it('allocates no Map per lookup in a 100,000-lookup default-pattern loop', () => {
    const matcher = createFieldMatcher(
      Object.fromEntries(DEFAULT_SECRET_FIELD_PATTERNS.map((path) => [path, 'secret'])),
      false,
    );
    const NativeMap = Map;
    let allocations = 0;
    vi.stubGlobal(
      'Map',
      class CountingMap<K, V> extends NativeMap<K, V> {
        constructor() {
          super();
          allocations++;
        }
      },
    );
    for (let index = 0; index < 100_000; index++) {
      matcher(index % 2 === 0 ? `request${index}.headers.authorization` : `request${index}.method`);
    }
    expect(allocations).toBe(0);
  });

  it('caches misses and matches, drops the oldest of 1,024 paths, and keeps caches instance-owned', () => {
    const matcher = createFieldMatcher({ '**.password': 'secret' }, false);
    matcher('first.password');
    matcher('miss');
    const split = vi.spyOn(String.prototype, 'split');
    try {
      matcher('first.password');
      matcher('miss');
      expect(split).not.toHaveBeenCalled();
      for (let index = 0; index < 1_022; index++) matcher(`item${index}.password`);
      matcher('first.password'); // Hits do not change insertion order.
      matcher('overflow.password');
      split.mockClear();
      matcher('first.password');
      expect(split).toHaveBeenCalledTimes(1);
      expect(
        createFieldMatcher({ '**.password': 'pii' }, false)('first.password')?.classification,
      ).toBe('pii');
    } finally {
      split.mockRestore();
    }
  });

  it('does not cache a path longer than 256 characters, and still matches it exactly', () => {
    // An attacker-chosen field name must not stay pinned in a long-lived matcher
    // (security audit F1: 600 × 900 KB names retained ~1 GiB). Long paths are
    // matched exactly as before, only without the cache.
    const matcher = createFieldMatcher({ '**.password': 'secret' }, false);
    const longSecret = `${'k'.repeat(10_000)}.password`;
    const longPlain = `${'k'.repeat(10_000)}.name`;
    const boundary = `${'k'.repeat(256 - '.password'.length)}.password`;
    expect(boundary).toHaveLength(256);
    for (const path of [longSecret, longPlain, boundary]) matcher(path);
    const split = vi.spyOn(String.prototype, 'split');
    try {
      expect(matcher(longSecret)?.classification).toBe('secret');
      expect(matcher(longPlain)).toBeUndefined();
      expect(split).toHaveBeenCalledTimes(2);
      split.mockClear();
      expect(matcher(boundary)?.classification).toBe('secret');
      expect(split).not.toHaveBeenCalled();
    } finally {
      split.mockRestore();
    }
  });
});
