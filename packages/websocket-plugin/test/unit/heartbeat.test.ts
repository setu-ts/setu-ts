import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HeartbeatSweeper } from '../../src/heartbeat/heartbeat.ts';
import { WebSocketConnection } from '../../src/connection/websocket-connection.ts';
import {
  createFakeRuntime,
  createFakeTransport,
  type FakeTransport,
} from '../fixtures/fake-runtime.ts';

function makeConnection(runtimeNow: number): {
  conn: WebSocketConnection;
  transport: FakeTransport;
} {
  const transport = createFakeTransport();
  return { conn: new WebSocketConnection('c', '/ws', transport, runtimeNow), transport };
}

describe('HeartbeatSweeper', () => {
  it('creates no timer when heartbeats are disabled', () => {
    const runtime = createFakeRuntime();
    const sweeper = new HeartbeatSweeper(
      runtime,
      { heartbeatMs: 0, heartbeatPayload: 'ping', idleTimeoutMs: 0 },
      () => [],
    );

    sweeper.start();

    expect(sweeper.isRunning).toBe(false);
    expect(runtime.intervals).toHaveLength(0);
  });

  it('registers a single interval at the configured period', () => {
    const runtime = createFakeRuntime();
    const sweeper = new HeartbeatSweeper(
      runtime,
      { heartbeatMs: 5000, heartbeatPayload: 'ping', idleTimeoutMs: 0 },
      () => [],
    );

    sweeper.start();
    sweeper.start(); // second call must not add another timer

    expect(sweeper.isRunning).toBe(true);
    expect(runtime.intervals).toHaveLength(1);
    expect(runtime.intervals[0]?.ms).toBe(5000);
  });

  it('sends the configured payload to every open connection on each tick', () => {
    const runtime = createFakeRuntime();
    const a = makeConnection(runtime.hrtime());
    const b = makeConnection(runtime.hrtime());
    const sweeper = new HeartbeatSweeper(
      runtime,
      { heartbeatMs: 1000, heartbeatPayload: 'keep-alive', idleTimeoutMs: 0 },
      () => [a.conn, b.conn],
    );
    sweeper.start();

    runtime.runIntervals();

    expect(a.transport.sent).toEqual(['keep-alive']);
    expect(b.transport.sent).toEqual(['keep-alive']);
  });

  it('skips connections that are already closed', () => {
    const runtime = createFakeRuntime();
    const a = makeConnection(runtime.hrtime());
    a.conn.close();
    const sweeper = new HeartbeatSweeper(
      runtime,
      { heartbeatMs: 1000, heartbeatPayload: 'ping', idleTimeoutMs: 0 },
      () => [a.conn],
    );

    sweeper.tick();

    expect(a.transport.sent).toEqual([]);
  });

  it('closes a connection whose inbound silence reached the idle timeout', () => {
    const runtime = createFakeRuntime();
    const idle = makeConnection(runtime.hrtime());
    const sweeper = new HeartbeatSweeper(
      runtime,
      { heartbeatMs: 1000, heartbeatPayload: 'ping', idleTimeoutMs: 30_000 },
      () => [idle.conn],
    );

    runtime.advance(30_000);
    sweeper.tick();

    expect(idle.transport.closes).toEqual([{ code: 1001, reason: 'Idle timeout' }]);
    // An idle peer is closed, never pinged.
    expect(idle.transport.sent).toEqual([]);
  });

  it('leaves a connection alone while it is still sending traffic', () => {
    const runtime = createFakeRuntime();
    const active = makeConnection(runtime.hrtime());
    const sweeper = new HeartbeatSweeper(
      runtime,
      { heartbeatMs: 1000, heartbeatPayload: 'ping', idleTimeoutMs: 30_000 },
      () => [active.conn],
    );

    runtime.advance(29_000);
    active.conn.touch(runtime.hrtime());
    runtime.advance(29_000);
    sweeper.tick();

    expect(active.transport.closes).toEqual([]);
    expect(active.transport.sent).toEqual(['ping']);
  });

  it('stops the interval idempotently', () => {
    const runtime = createFakeRuntime();
    const sweeper = new HeartbeatSweeper(
      runtime,
      { heartbeatMs: 1000, heartbeatPayload: 'ping', idleTimeoutMs: 0 },
      () => [],
    );
    sweeper.start();

    sweeper.stop();
    sweeper.stop();

    expect(sweeper.isRunning).toBe(false);
    expect(runtime.intervals[0]?.cleared).toBe(true);
  });
});
