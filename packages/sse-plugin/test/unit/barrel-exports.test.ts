/**
 * Barrel-export tests for `@hono-enterprise/sse-plugin`.
 *
 * Ensures every named export from `src/index.ts` is reachable at runtime,
 * mirroring the events-plugin convention.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, SseConnection, SsePlugin, SseService } from '@hono-enterprise/sse-plugin';
import type {
  ISseConnection,
  ISseService,
  SseChannel,
  SseMessage,
} from '@hono-enterprise/sse-plugin';

describe('sse-plugin barrel exports', () => {
  it('exposes every documented value export at runtime', () => {
    expect(typeof SsePlugin).toBe('function');
    expect(typeof SseService).toBe('function');
    expect(typeof SseConnection).toBe('function');
  });

  it('re-exports CAPABILITIES with SSE token', () => {
    expect(CAPABILITIES.SSE).toBe('sse');
  });

  it('is a factory function that returns an IPlugin', () => {
    const plugin = SsePlugin();
    expect(plugin.name).toBe('sse-plugin');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.provides).toEqual(['sse']);
  });

  it('SseService implements ISseService surface', () => {
    // Runtime check: constructor exists and has expected methods.
    const fakeRuntime = {
      uuid: () => 'test',
      setInterval: () => {},
      clearInterval: () => {},
    };
    const service = new SseService({}, fakeRuntime as never);
    expect(typeof service.open).toBe('function');
    expect(typeof service.channel).toBe('function');
    expect(typeof service.connectionCount).toBe('number');
  });

  it('type imports are available (compile-time check)', () => {
    const _msg: SseMessage = { data: 'test' };
    void _msg;
    const _channel: SseChannel = undefined as unknown as SseChannel;
    void _channel;
    const _conn: ISseConnection = undefined as unknown as ISseConnection;
    void _conn;
    const _service: ISseService = undefined as unknown as ISseService;
    void _service;
  });
});
