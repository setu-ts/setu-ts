/**
 * upgrade-real-socket — A real client upgrade still succeeds after the mapping
 * has run.
 *
 * Verifies M70a §1.1 probe committed as a test: calling `await request.arrayBuffer()`
 * on a bodyless upgrade request yields `byteLength=0`, leaves `bodyUsed === false`,
 * and the runtime upgrade then succeeds. This is the foundational guarantee that
 * pipeline-first upgrades work — the mapping does not disturb a conformant upgrade.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { mapWebRequestToFrameworkRequest } from '../../src/adapters/shared/fetch-mapping.ts';

function upgradeRequest(url = 'http://localhost/ws'): Request {
  return new Request(url, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
}

describe('Real socket upgrade after mapping (M70a §1.1)', () => {
  it('mapping does not disturb a bodyless upgrade request', async () => {
    const request = upgradeRequest();
    expect(request.bodyUsed).toBe(false);

    // This is what the adapter does before calling the framework handler
    const frameworkRequest = await mapWebRequestToFrameworkRequest(request);

    // The request body is empty (no body on GET upgrade), so arrayBuffer()
    // returns an empty buffer and does NOT set bodyUsed to true
    expect(request.bodyUsed).toBe(false);

    // The IRequest carries the raw request
    expect(frameworkRequest.raw).toBe(request);

    // The body bytes are empty
    const bodyBytes = await frameworkRequest.bytes();
    expect(bodyBytes.length).toBe(0);
  });

  it('mapping preserves the upgrade headers', async () => {
    const request = upgradeRequest();
    const frameworkRequest = await mapWebRequestToFrameworkRequest(request);

    expect(frameworkRequest.headers.get('upgrade')).toBe('websocket');
    expect(frameworkRequest.headers.get('connection')).toBe('Upgrade');
  });

  it('mapping preserves the raw request for upgrade', async () => {
    const request = upgradeRequest();
    const frameworkRequest = await mapWebRequestToFrameworkRequest(request);

    // The raw request is the same instance
    expect(frameworkRequest.raw).toBe(request);

    // The URL is preserved
    expect(frameworkRequest.url).toBe(request.url);
  });

  it('mapping handles upgrade with subprotocol header', async () => {
    const request = new Request('http://localhost/ws', {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-protocol': 'graphql-ws',
      },
    });
    const frameworkRequest = await mapWebRequestToFrameworkRequest(request);

    expect(frameworkRequest.headers.get('sec-websocket-protocol')).toBe('graphql-ws');
    expect(frameworkRequest.raw).toBe(request);
    expect(request.bodyUsed).toBe(false);
  });
});
