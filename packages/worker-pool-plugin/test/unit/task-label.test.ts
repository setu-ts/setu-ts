/**
 * Task labels: the operator-facing name of a pool, derived from its specifier
 * without carrying the specifier's path.
 */
import { describe, expect, it } from 'vitest';

import { assertTaskLabel, deriveTaskLabel, TaskLabels } from '../../src/metrics/task-label.ts';

describe('deriveTaskLabel', () => {
  // specifier → label, as data: every shape a `run()` caller can pass.
  const CASES: readonly (readonly [string, string])[] = [
    ['file:///home/someone/app/src/tasks/resize-image.ts', 'resize-image'],
    ['file:///C:/Users/someone/app/tasks/thumb.mjs', 'thumb'],
    ['https://cdn.example/workers/encode.js?v=3#x', 'encode'],
    ['./tasks/a.b.mjs', 'a.b'],
    ['tasks\\win\\job.ts', 'job'],
    ['@scope/pkg/task', 'task'],
    ['bare', 'bare'],
    ['.hidden', '.hidden'],
    ['file:///tasks/%E2%9C%93.js', '_'],
    ['file:///tasks/bad%E2.js', 'bad_E2'],
    ['file:///tasks/with space.ts', 'with_space'],
    ['data:text/javascript,export default 1', 'inline'],
    ['blob:https://app.example/1234', 'inline'],
    ['', 'task'],
    ['file:///', 'task'],
    [`file:///tasks/${'n'.repeat(200)}.ts`, 'n'.repeat(64)],
    // A directory or a query names no module: neither may become the label
    // (security audit finding 4).
    ['file:///home/bob/', 'task'],
    ['./tasks/', 'task'],
    ['C:\\Users\\bob\\', 'task'],
    ['./x.ts?home=/home/bob', 'x'],
    ['./x.ts#/home/bob', 'x'],
    ['file:///app/x.ts?home=/home/bob', 'x'],
  ];
  for (const [specifier, label] of CASES) {
    it(`labels ${JSON.stringify(specifier.slice(0, 50))} as ${JSON.stringify(label.slice(0, 20))}`, () => {
      const derived = deriveTaskLabel(specifier);
      expect(derived).toBe(label);
      expect(derived).not.toMatch(/[/:\\]/);
    });
  }
});

describe('assertTaskLabel', () => {
  it('accepts 1-64 characters of letters, digits, _ . -', () => {
    for (const label of ['a', 'resize-image', 'v1.2_x', 'x'.repeat(64)]) {
      expect(() => assertTaskLabel(label, 'pools["x"].label')).not.toThrow();
    }
  });
  it('refuses every other shape, naming the option', () => {
    for (const label of ['', 'a b', 'a/b', 'x'.repeat(65), 'é', 7, null]) {
      expect(() => assertTaskLabel(label, 'pools["x"].label')).toThrow(/pools\["x"\]\.label/);
    }
  });
});

describe('TaskLabels', () => {
  it('assigns a label once per specifier and suffixes a taken one', () => {
    const collisions: [string, string][] = [];
    const labels = new TaskLabels(new Map([['file:///x/explicit.ts', 'resize']]), (s, l) =>
      collisions.push([s, l]),
    );
    expect(labels.labelOf('file:///x/explicit.ts')).toBe('resize');
    expect(labels.labelOf('file:///a/resize.ts')).toBe('resize_2');
    expect(labels.labelOf('file:///b/resize.ts')).toBe('resize_3');
    // Stable: the same specifier keeps its label and reports nothing again.
    expect(labels.labelOf('file:///a/resize.ts')).toBe('resize_2');
    expect(labels.labelOf('file:///c/other.ts')).toBe('other');
    expect(collisions).toEqual([
      ['file:///a/resize.ts', 'resize_2'],
      ['file:///b/resize.ts', 'resize_3'],
    ]);
  });

  it('keeps a suffixed label within 64 characters', () => {
    const long = 'n'.repeat(64);
    const labels = new TaskLabels(new Map(), () => undefined);
    expect(labels.labelOf(`file:///a/${long}.ts`)).toBe(long);
    const second = labels.labelOf(`file:///b/${long}.ts`);
    expect(second).toBe(`${'n'.repeat(62)}_2`);
    expect(second).toHaveLength(64);
  });
});
