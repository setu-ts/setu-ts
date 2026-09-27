import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createDisabledAuthorizationSource,
  createUnsupportedAuthorizationSource,
} from '../../src/diagnostics/authorization-observation-collector.ts';

/**
 * The inert authorization-diagnostics sources (M98h) — the two sources the
 * AuthPlugin registers when there is nothing to observe: `disabled` when the
 * `authorizationDiagnostics` option is absent, and `unsupported` when RBAC
 * itself is absent. The active collector's option bounds, ring and loss
 * behavior are covered by `authorization-observation-collector.test.ts`; this
 * file pins the inert sources' read contract and their fixed error shape.
 */
describe('the inert authorization-diagnostics sources (M98h)', () => {
  const INSTANCE = 'instance-uuid';

  it('the disabled source answers disabled and echoes the cursor', () => {
    const source = createDisabledAuthorizationSource();
    const batch = source.read(INSTANCE, 7);
    expect(batch.state).toBe('disabled');
    expect(batch.coverage).toBeUndefined();
    expect(batch.decisions).toHaveLength(0);
    expect(batch.next).toBe(7);
    expect(batch.lost).toBe(0);
    expect(batch.closed).toBe(false);
    expect(batch.droppedUnapproved).toBe(0);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.decisions)).toBe(true);
  });

  it('the disabled source honors an explicit limit and the default 128', () => {
    const source = createDisabledAuthorizationSource();
    expect(source.read(INSTANCE, 0, 16).next).toBe(0);
    expect(source.read(INSTANCE, 0).next).toBe(0);
  });

  it('the unsupported source answers unsupported with its fixed coverage', () => {
    const source = createUnsupportedAuthorizationSource('rbac-not-configured');
    const batch = source.read(INSTANCE, 0, 128);
    expect(batch.state).toBe('unsupported');
    expect(batch.coverage).toBe('rbac-not-configured');
    expect(batch.decisions).toHaveLength(0);
    expect(batch.next).toBe(0);
    expect(batch.lost).toBe(0);
    expect(Object.isFrozen(batch)).toBe(true);
  });

  it('both inert sources validate arguments with the same fixed errors', () => {
    for (
      const source of [
        createDisabledAuthorizationSource(),
        createUnsupportedAuthorizationSource('custom-provider'),
      ]
    ) {
      expect(() => source.read('', 0)).toThrow(RangeError);
      expect(() => source.read(INSTANCE, -1)).toThrow(RangeError);
      expect(() => source.read(INSTANCE, 0, 0)).toThrow(RangeError);
      expect(() => source.read(INSTANCE, 0, 129)).toThrow(RangeError);
    }
  });
});
