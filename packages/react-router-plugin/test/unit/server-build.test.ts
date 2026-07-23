/**
 * Tests for server-build loader and pure assembleHandler seam.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { SsrRequestHandler } from '../../src/interfaces/index.ts';
import { assembleHandler, loadRequestHandler } from '../../src/handler/server-build.ts';
import { createSimpleFakeHandler } from '../fixtures/fake-handler.ts';

describe('server-build', () => {
  it('assembleHandler returns a handler that calls createRequestHandler(build, mode)', () => {
    let factoryCalled = false;
    let capturedBuild: unknown = null;
    let capturedMode: string | undefined = undefined;

    const fakeBuild = { __type: 'ServerBuild' };
    const fakeRRResponse = new Response('<html>ok</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });

    const createRequestHandler = (
      build: unknown,
      mode?: string,
    ): SsrRequestHandler => {
      factoryCalled = true;
      capturedBuild = build;
      capturedMode = mode;
      // deno-lint-ignore require-await
      return async (_request, _context) => fakeRRResponse;
    };

    const handler = assembleHandler(
      fakeBuild,
      createRequestHandler,
      'production',
    );

    // assembleHandler calls createRequestHandler immediately, so factoryCalled is true.
    expect(factoryCalled).toBe(true);
    expect(capturedBuild).toBe(fakeBuild);
    expect(capturedMode).toBe('production');

    const fakeRequest = new Request('http://localhost/', { method: 'GET' });
    void handler(fakeRequest, {});

    expect(factoryCalled).toBe(true);
    expect(capturedBuild).toBe(fakeBuild);
    expect(capturedMode).toBe('production');
  });

  it('assembleHandler forwards request and loadContext to the created handler', () => {
    let receivedRequest: Request | null = null;
    let receivedContext: unknown = null;

    const createRequestHandler = () => {
      // deno-lint-ignore require-await
      return async (request: Request, context: unknown) => {
        receivedRequest = request;
        receivedContext = context;
        return new Response('ok');
      };
    };

    const handler = assembleHandler({}, createRequestHandler, 'development');
    const testRequest = new Request('http://localhost/test', {
      method: 'POST',
      body: 'data',
    });
    const testContext = { services: {}, user: { name: 'admin' } };

    void handler(testRequest, testContext);

    expect(receivedRequest).toBe(testRequest);
    expect(receivedRequest!.method).toBe('POST');
    expect(receivedContext).toBe(testContext);
  });

  it('error propagates when createRequestHandler factory throws', () => {
    const erringFactory = (): never => {
      throw new Error('RR factory failed');
    };

    try {
      assembleHandler({}, erringFactory, 'production');
      expect(true).toBe(false);
    } catch (e) {
      expect(e instanceof Error && e.message).toBe('RR factory failed');
    }
  });

  it('createSimpleFakeHandler returns a handler that always resolves with the given response', async () => {
    const expectedResponse = new Response('fixed', { status: 418 });
    const handler = createSimpleFakeHandler(expectedResponse);
    const request = new Request('http://localhost/test');
    const result = await handler(request, {});

    expect(result).toBe(expectedResponse);
    const text = await result.text();
    expect(text).toBe('fixed');
  });

  it('loadRequestHandler rejects when server build path does not exist', async () => {
    const nonExistentPath = './__non_existent_build_path_for_test__';
    await expect(
      loadRequestHandler(nonExistentPath, 'production'),
    ).rejects.toThrow('Failed to load React Router server build');
  });
});
