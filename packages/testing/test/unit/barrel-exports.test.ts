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

  // The exported option types are structural, so the meaningful assertion is
  // that a populated value round-trips with its fields intact. `expect(x)
  // .toBeDefined()` on a fresh object literal cannot fail and proves nothing.
  it('option types carry their declared fields', () => {
    const appOpts: TestAppOptions = { plugins: [], autoStart: false };
    expect(appOpts.plugins).toEqual([]);
    expect(appOpts.autoStart).toBe(false);

    const pluginOpts: MockPluginOptions = { name: 'test', service: {}, provides: 'tok' };
    expect(pluginOpts.name).toBe('test');
    expect(pluginOpts.provides).toBe('tok');

    const ctxOpts: TestContextOptions = { params: { id: '1' }, startTime: 5 };
    expect(ctxOpts.params).toEqual({ id: '1' });
    expect(ctxOpts.startTime).toBe(5);

    const body: StreamingBody = { chunks: [new Uint8Array([1])], text: 'x' };
    expect(body.chunks).toHaveLength(1);
    expect(body.text).toBe('x');
  });

  // The kernel re-exports must be the SAME types, not lookalikes. Assignability
  // in both directions is enforced by `deno task check` at compile time — these
  // bindings exist to make the type-checker prove it. There is no runtime
  // component to assert, so the test asserts the one runtime fact available:
  // the values flow through unchanged.
  it('kernel type re-exports are mutually assignable, not just structurally similar', () => {
    const toKernelReq = (val: InjectRequest): KernelInjectRequest => val;
    const fromKernelReq = (val: KernelInjectRequest): InjectRequest => val;
    const req: InjectRequest = { method: 'GET', url: '/x' };
    expect(fromKernelReq(toKernelReq(req))).toBe(req);

    const toKernelRes = (val: InjectResponse): KernelInjectResponse => val;
    const fromKernelRes = (val: KernelInjectResponse): InjectResponse => val;
    const res: InjectResponse = {
      statusCode: 200,
      headers: new Headers(),
      body: null,
      json: <T>(): T => ({}) as T,
    };
    expect(fromKernelRes(toKernelRes(res))).toBe(res);

    const toKernelApp = (val: IKernelApplication): KernelIKernelApplication => val;
    const fromKernelApp = (val: KernelIKernelApplication): IKernelApplication => val;
    expect(typeof toKernelApp).toBe('function');
    expect(typeof fromKernelApp).toBe('function');
  });
});
