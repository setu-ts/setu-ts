import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { runIn } from '../fixtures/node-project.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

afterEach(() => vi.unstubAllEnvs());

it('V13-143 removes inherited Pub/Sub variables from the dotenv probe child environment', async () => {
  vi.stubEnv('PUBSUB_EMULATOR_HOST', 'parent-emulator:1234');
  vi.stubEnv('PUBSUB_PROJECT_ID', 'parent-project');
  vi.stubEnv('SETU_PROBE_KEEP', 'preserved');
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => child.emit('close', 0));
    return child as ReturnType<typeof spawn>;
  });
  const result = await runIn('/project', 'npm', ['run', '--silent', 'test'], undefined, {
    PUBSUB_EMULATOR_HOST: undefined,
    PUBSUB_PROJECT_ID: undefined,
  });
  expect(result.code).toBe(0);
  const env = vi.mocked(spawn).mock.calls[0]?.[2]?.env;
  expect(env).toBeDefined();
  expect(env).not.toHaveProperty('PUBSUB_EMULATOR_HOST');
  expect(env).not.toHaveProperty('PUBSUB_PROJECT_ID');
  expect(env?.SETU_PROBE_KEEP).toBe('preserved');
  expect(env?.PATH).toContain('/project/node_modules/.bin');
  expect(process.env.PUBSUB_EMULATOR_HOST).toBe('parent-emulator:1234');
});
