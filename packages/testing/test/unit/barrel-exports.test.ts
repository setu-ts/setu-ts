import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  collectStream,
  createMockPlugin,
  createTestApp,
  createTestContext,
  FixtureManager,
  inject,
  MockResponse,
  MockServiceRegistry,
} from '../../src/index.ts';

// Type imports for assignability checks
import type {
  IKernelApplication,
  InjectRequest,
  InjectResponse,
  MockPluginOptions,
  StreamingBody,
  TestAppOptions,
  TestContextOptions,
} from '../../src/index.ts';
import type {
  IKernelApplication as KernelIKernelApplication,
  InjectRequest as KernelInjectRequest,
  InjectResponse as KernelInjectResponse,
} from '@hono-enterprise/kernel';

describe('barrel exports', () => {
  it('every named export is defined', () => {
    expect(typeof createTestApp).toBe('function');
    expect(typeof createMockPlugin).toBe('function');
    expect(typeof inject).toBe('function');
    expect(typeof createTestContext).toBe('function');
    expect(typeof MockServiceRegistry).toBe('function');
    expect(typeof MockResponse).toBe('function');
    expect(typeof FixtureManager).toBe('function');
    expect(typeof collectStream).toBe('function');
  });

  it('TestAppOptions is a type (compile-time check only)', () => {
    const _opts: Partial<TestAppOptions> = {};
    expect(_opts).toBeDefined();
  });

  it('MockPluginOptions is a type (compile-time check only)', () => {
    const _opts: Partial<MockPluginOptions> = { name: 'test', service: {} };
    expect(_opts.name).toBe('test');
  });

  it('TestContextOptions is a type (compile-time check only)', () => {
    const _opts: Partial<TestContextOptions> = {};
    expect(_opts).toBeDefined();
  });

  it('StreamingBody is a type (compile-time check only)', () => {
    const assertType = (_sb: StreamingBody): void => {};
    expect(assertType).toBeDefined();
  });

  it('re-export InjectRequest is assignable to kernel InjectRequest', () => {
    const assertAssignable = (val: InjectRequest): KernelInjectRequest => val;
    expect(assertAssignable).toBeDefined();
  });

  it('re-export InjectResponse is assignable to kernel InjectResponse', () => {
    const assertAssignable = (val: InjectResponse): KernelInjectResponse => val;
    expect(assertAssignable).toBeDefined();
  });

  it('re-export IKernelApplication is assignable to kernel IKernelApplication', () => {
    const assertAssignable = (val: IKernelApplication): KernelIKernelApplication => val;
    expect(assertAssignable).toBeDefined();
  });
});
