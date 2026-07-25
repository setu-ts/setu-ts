import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  WebSocketEventSink,
  WebSocketUpgradeDecision,
  WebSocketUpgradeRouter,
} from '../../src/services/websocket.ts';
import { CAPABILITIES, createCapabilityToken } from '../../src/tokens.ts';

const sink: WebSocketEventSink = {
  onOpen: () => {},
  onMessage: () => {},
  onClose: () => {},
  onError: () => {},
};

describe('CAPABILITIES.WEBSOCKET', () => {
  it('is the lowercase kebab-case token the plugin publishes', () => {
    expect(CAPABILITIES.WEBSOCKET).toBe('websocket');
  });

  it('satisfies the committed capability-token grammar', () => {
    expect(createCapabilityToken(CAPABILITIES.WEBSOCKET)).toBe('websocket');
  });

  it('does not collide with the SSE token', () => {
    expect(CAPABILITIES.WEBSOCKET).not.toBe(CAPABILITIES.SSE);
  });
});

describe('WebSocketUpgradeDecision', () => {
  it('narrows to the accept arm on the accept discriminant', () => {
    const decision: WebSocketUpgradeDecision = { accept: true, sink, protocol: 'chat' };

    if (decision.accept) {
      expect(decision.sink).toBe(sink);
      expect(decision.protocol).toBe('chat');
    } else {
      throw new Error('expected the accept arm');
    }
  });

  it('narrows to the reject arm, which carries a status and no sink', () => {
    const decision: WebSocketUpgradeDecision = { accept: false, status: 503 };

    if (decision.accept) {
      throw new Error('expected the reject arm');
    }
    expect(decision.status).toBe(503);
  });
});

describe('WebSocketUpgradeRouter', () => {
  it('may answer null to fall through to the HTTP pipeline', async () => {
    const router: WebSocketUpgradeRouter = () => Promise.resolve(null);

    expect(await router(new Request('http://localhost/ws'))).toBeNull();
  });

  it('receives the native request so an implementation can read its headers', async () => {
    const seen: string[] = [];
    const router: WebSocketUpgradeRouter = (request) => {
      seen.push(request.headers.get('sec-websocket-protocol') ?? '');
      return Promise.resolve({ accept: true, sink });
    };

    await router(
      new Request('http://localhost/ws', { headers: { 'sec-websocket-protocol': 'chat' } }),
    );

    expect(seen).toEqual(['chat']);
  });
});
