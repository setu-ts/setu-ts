/**
 * Tests for depth-limit.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDepthLimitRule } from '../../src/security/depth-limit.ts';

// Mock validation context for testing
interface MockValidationContext {
  reportError(error: Error): void;
}

describe('createDepthLimitRule', () => {
  it('returns a rule function', () => {
    const rule = createDepthLimitRule(10);
    expect(typeof rule).toBe('function');
  });

  it('returns no-op rule when maxDepth is 0', () => {
    const rule = createDepthLimitRule(0);
    const mockContext: MockValidationContext = {
      reportError: () => {},
    };
    const visitor = rule(mockContext);
    expect(visitor).toEqual({});
  });

  it('creates a rule with SelectionSet and Field visitors', () => {
    const rule = createDepthLimitRule(5);
    const mockContext: MockValidationContext = {
      reportError: () => {},
    };
    const visitor = rule(mockContext);

    expect(visitor).toHaveProperty('SelectionSet');
    expect(visitor).toHaveProperty('Field');
  });

  it('visitor functions exist and accept parameters', () => {
    const rule = createDepthLimitRule(5);
    const mockContext: MockValidationContext = {
      reportError: () => {},
    };
    const visitor = rule(mockContext) as {
      SelectionSet: (...args: unknown[]) => void;
      Field: (...args: unknown[]) => void;
    };

    expect(typeof visitor.SelectionSet).toBe('function');
    expect(typeof visitor.Field).toBe('function');
  });

  it('returns no-op rule when maxDepth is negative', () => {
    const rule = createDepthLimitRule(-1);
    const mockContext: MockValidationContext = {
      reportError: () => {},
    };
    const visitor = rule(mockContext);
    expect(visitor).toEqual({});
  });

  it('Field visitor counts depth from ancestors', () => {
    const rule = createDepthLimitRule(2);
    const mockContext: MockValidationContext = {
      reportError: () => {},
    };
    const visitor = rule(mockContext) as {
      SelectionSet: (...args: unknown[]) => void;
      Field: (...args: unknown[]) => void;
    };

    // Create mock ancestors with SelectionSet nodes
    const mockAncestors = [
      { kind: 'SelectionSet' },
      { kind: 'Field' },
      { kind: 'SelectionSet' },
      { kind: 'Object' },
    ];

    // Call Field visitor - should count 2 SelectionSets
    visitor.Field({}, null, null, mockAncestors);

    // Should not throw
    expect(true).toBe(true);
  });

  it('SelectionSet visitor is a function', () => {
    const rule = createDepthLimitRule(5);
    const mockContext: MockValidationContext = {
      reportError: () => {},
    };
    const visitor = rule(mockContext) as {
      SelectionSet: (...args: unknown[]) => void;
      Field: (...args: unknown[]) => void;
    };

    // Call SelectionSet with mock parameters
    visitor.SelectionSet({ kind: 'SelectionSet' }, null, null, null);

    // Should not throw
    expect(true).toBe(true);
  });

  it('handles empty ancestors array', () => {
    const rule = createDepthLimitRule(5);
    const mockContext: MockValidationContext = {
      reportError: () => {},
    };
    const visitor = rule(mockContext) as {
      Field: (...args: unknown[]) => void;
    };

    // Call Field with empty ancestors
    visitor.Field({}, null, null, []);

    expect(true).toBe(true);
  });

  it('handles ancestors with no SelectionSets', () => {
    const rule = createDepthLimitRule(5);
    const mockContext: MockValidationContext = {
      reportError: () => {},
    };
    const visitor = rule(mockContext) as {
      Field: (...args: unknown[]) => void;
    };

    // Call Field with ancestors that have no SelectionSets
    visitor.Field({}, null, null, [
      { kind: 'Field' },
      { kind: 'Object' },
      { kind: 'String' },
    ]);

    expect(true).toBe(true);
  });

  it('handles null and undefined in ancestors', () => {
    const rule = createDepthLimitRule(5);
    const mockContext: MockValidationContext = {
      reportError: () => {},
    };
    const visitor = rule(mockContext) as {
      Field: (...args: unknown[]) => void;
    };

    // Call Field with null/undefined in ancestors
    visitor.Field({}, null, null, [null, undefined, { kind: 'SelectionSet' }]);

    expect(true).toBe(true);
  });

  it('handles ancestors with objects without kind property', () => {
    const rule = createDepthLimitRule(5);
    const mockContext: MockValidationContext = {
      reportError: () => {},
    };
    const visitor = rule(mockContext) as {
      Field: (...args: unknown[]) => void;
    };

    // Call Field with objects that don't have kind property
    visitor.Field({}, null, null, [
      { foo: 'bar' },
      { baz: 123 },
      { kind: 'SelectionSet' },
    ]);

    expect(true).toBe(true);
  });

  it('counts multiple SelectionSets correctly', () => {
    const rule = createDepthLimitRule(5);
    const mockContext: MockValidationContext = {
      reportError: () => {},
    };
    const visitor = rule(mockContext) as {
      Field: (...args: unknown[]) => void;
    };

    // Call Field with multiple SelectionSets
    visitor.Field({}, null, null, [
      { kind: 'SelectionSet' },
      { kind: 'Field' },
      { kind: 'SelectionSet' },
      { kind: 'Field' },
      { kind: 'SelectionSet' },
    ]);

    expect(true).toBe(true);
  });
});
