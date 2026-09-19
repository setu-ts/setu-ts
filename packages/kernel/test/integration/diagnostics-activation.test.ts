import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '../../src/application/application.ts';
import { runtimePlugin } from '../fixtures/runtime-plugin.ts';

const SECRET_ENTRY = 'x'.repeat(500);

describe('diagnostics activation', () => {
  it('an omitted option leaves the reader absent and allocates nothing', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    expect(app.diagnostics).toBeUndefined();
    await app.start();
    expect(app.diagnostics).toBeUndefined();
    const response = await app.inject({ method: 'GET', url: '/nothing' });
    expect(response.statusCode).toBe(404);
    await app.stop();
  });

  it('an explicit empty object enables collection', async () => {
    const app = createApplication({ plugins: [runtimePlugin()], diagnostics: {} });
    expect(app.diagnostics).toBeDefined();
    await app.start();
    const snapshot = app.diagnostics!.snapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.state).toBe('running');
    expect(snapshot.instanceId).toMatch(/^test-uuid-/);
    await app.stop();
  });

  it('malformed label lists reject CONSTRUCTION with value-free errors', () => {
    expect(() =>
      createApplication({
        plugins: [runtimePlugin()],
        diagnostics: { labels: { plugins: ['x'.repeat(500)] } },
      })
    ).toThrow(RangeError);
    let message = '';
    try {
      createApplication({
        plugins: [runtimePlugin()],
        diagnostics: { labels: { plugins: [SECRET_ENTRY.slice(0, 161), 'ok'] } },
      });
      throw new Error('unreachable');
    } catch (error) {
      message = (error as Error).message;
      expect(error).toBeInstanceOf(RangeError);
    }
    expect(message).toContain('160-byte bound');
    expect(message).not.toContain('xxxxxxxxxxxxxxxxxxxx');
  });

  it('the reader is pull-only and returns frozen data', async () => {
    const app = createApplication({
      plugins: [runtimePlugin()],
      diagnostics: { labels: { plugins: ['fake-runtime'] } },
    });
    await app.start();
    const source = app.diagnostics!;
    // The CONSUMER surface carries the two read methods — no subscription,
    // no write, no callback registration is reachable through the member.
    expect(typeof source.snapshot).toBe('function');
    expect(typeof source.read).toBe('function');
    const batch = source.read(0);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.events)).toBe(true);
    await app.stop();
  });

  it('a legacy structural application still type-checks alongside diagnostics', () => {
    // Compiles because the member is optional: nothing about the existing
    // surface moved.
    const app = createApplication({ plugins: [runtimePlugin()] });
    expect(typeof app.start).toBe('function');
    expect(typeof app.inject).toBe('function');
  });
});
