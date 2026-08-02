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
});
