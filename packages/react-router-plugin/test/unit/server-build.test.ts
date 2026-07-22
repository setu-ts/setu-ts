/**
 * Tests for server-build loader and pure assembleHandler seam.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { SsrRequestHandler } from '../../src/interfaces/index.ts';
import { assembleHandler } from '../../src/handler/server-build.ts';

describe('server-build', () => {
  it('assembleHandler returns a handler that calls createRequestHandler(build, mode)', async () => {
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
    await handler(fakeRequest, {});

    expect(factoryCalled).toBe(true);
    expect(capturedBuild).toBe(fakeBuild);
    expect(capturedMode).toBe('production');
  });

  it('assembleHandler forwards request and loadContext to the created handler', async () => {
    let receivedRequest: Request | null = null;
    let receivedContext: unknown = null;

    const createRequestHandler = () => {
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

    await handler(testRequest, testContext);

    expect(receivedRequest).toBe(testRequest);
    expect(receivedRequest!.method).toBe('POST');
    expect(receivedContext).toBe(testContext);
  });

  it('clear error when createRequestHandler import fails (via loadRequestHandler rejection)', async () => {
    // Test the error path of default loadRequestHandler indirectly:
    // We can't directly test the import paths without mocking import(),
    // so we verify that assembleHandler itself propagates errors correctly.
    const erringFactory = (): never => {
      throw new Error('RR factory failed');
    };

    // The factory throws immediately in assembleHandler, not at handler call time.
    try {
      assembleHandler({}, erringFactory, 'production');
      throw new Error('expected assembleHandler to throw');
    } catch (e) {
      expect(e instanceof Error && e.message).toBe('RR factory failed');
    }
  });
});
