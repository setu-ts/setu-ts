import process from 'node:process';
import { runMain, nodeProcess, type MainProcess } from '../../src/main.ts';
import { beforeEach, expect, it, vi } from 'vitest';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';

const services = vi.hoisted(() => ({ createNodeRuntimeServices: vi.fn() }));
vi.mock('@setu-ts/runtime', () => ({
  createNodeRuntimeServices: services.createNodeRuntimeServices,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

it('installs the bounded reader and writer that both executables share', async () => {
  const { readRegularFile, writeRegularFile } =
    await import('../../src/utils/node-regular-file.ts');
  const { nodeRuntime } = await import('../../src/main.ts');
  const runtime = { fs: createFakeFs(), now: () => 5 };
  services.createNodeRuntimeServices.mockReturnValue(runtime);
  expect(nodeRuntime()).toEqual({
    ...runtime,
    fs: expect.objectContaining({ readRegularFile, writeRegularFile }),
  });
  expect(nodeRuntime().fs).toMatchObject({ invokingPid: process.pid });
});

it('passes a runtime without a filesystem through unchanged', async () => {
  const { nodeRuntime } = await import('../../src/main.ts');
  const runtime = { now: () => 5 };
  services.createNodeRuntimeServices.mockReturnValue(runtime);
  expect(nodeRuntime()).toBe(runtime);
});

it('V13-148 probes process liveness without signalling and counts EPERM as alive', () => {
  const host = nodeProcess(() => {});
  const kill = vi.spyOn(process, 'kill');
  try {
    kill.mockReturnValue(true);
    expect(host.isProcessAlive?.(123)).toBe(true);
    expect(kill).toHaveBeenCalledWith(123, 0);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(host.isProcessAlive?.(123)).toBe(true);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(host.isProcessAlive?.(123)).toBe(false);
    kill.mockImplementation(() => {
      throw new Error('unknown');
    });
    expect(host.isProcessAlive?.(123)).toBe(true);
    kill.mockImplementation(() => {
      throw 'unknown';
    });
    expect(host.isProcessAlive?.(123)).toBe(true);
  } finally {
    kill.mockRestore();
    host.dispose?.();
  }
});

it('V13-148 releases the project lock after SIGINT during a generated write', async () => {
  const fs = createFakeFs({ '/work/package.json': '{}' });
  const err = createRecorder();
  let interrupt: () => void = () => {};
  const host: MainProcess = {
    args: ['g', 'service', 'billing'],
    cwd: () => '/work',
    isTerminal: () => false,
    prompt: () => Promise.resolve(null),
    log: () => {},
    error: err.sink,
    portAvailable: () => Promise.resolve(true),
  };
  expect(
    await runMain(
      {
        now: () => 0,
        onSignal: (signal, handler) => {
          expect(signal).toBe('SIGINT');
          interrupt = handler;
        },
        fs: {
          ...fs,
          writeFile: async (path, bytes) => {
            await fs.writeFile(path, bytes);
            if (path.endsWith('/billing.service.ts')) interrupt();
          },
        },
      },
      host,
    ),
  ).toBe(130);
  expect(err.text()).toContain('Interrupted;');
  expect(fs.has('/work/src/services/billing.service.ts')).toBe(false);
  expect(fs.read('/work/package.json')).toBe('{}');
  await expect(fs.stat('/work/.setu-ts/write.lock')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([['add', 'cache'], ['g', 'service', 'billing'], ['sync']])(
  'passes the host liveness probe into %j lock refusal',
  async (...args) => {
    for (const alive of [undefined, false]) {
      const path = '/work/.setu-ts/write.lock/owner.json';
      const owner = JSON.stringify({ pid: 123, command: 'add' });
      const fs = createFakeFs({ '/work/package.json': '{}', [path]: owner });
      const err = createRecorder();
      const host: MainProcess = {
        args,
        cwd: () => '/work',
        isTerminal: () => false,
        prompt: () => Promise.resolve(null),
        log: () => {},
        error: err.sink,
        portAvailable: () => Promise.resolve(true),
        ...(alive === undefined ? {} : { isProcessAlive: () => alive }),
      };
      expect(await runMain({ fs, now: () => 0 }, host)).toBe(1);
      expect(err.text()).toContain(
        alive === false ? 'that is no longer running may have left' : 'is changing this project',
      );
      expect(err.text()).toContain('/work/.setu-ts/write.lock');
      expect(fs.read(path)).toBe(owner);
    }
  },
);

it.each([
  ['20.20.2', true],
  ['22.12.0', true],
  ['22.23.4', false],
  ['23.1.0', true],
  ['24.22.0', true],
  ['24.22.1', false],
  ['26.12.0', true],
  ['26.12.1', false],
  ['27.0.0', false],
  [undefined, false],
])('V13-166 checks host version %s without changing exit status', async (nodeVersion, warns) => {
  const err = createRecorder();
  const host: MainProcess & { nodeVersion?: string } = {
    args: ['--version'],
    cwd: () => '/work',
    isTerminal: () => false,
    prompt: () => Promise.resolve(null),
    log: () => {},
    error: err.sink,
    portAvailable: () => Promise.resolve(true),
    ...(nodeVersion === undefined ? {} : { nodeVersion }),
  };
  expect(await runMain({ fs: createFakeFs(), now: () => 0 }, host)).toBe(0);
  expect(err.lines).toEqual(
    warns
      ? [
          `setu supports Node ^22.23.4 || ^24.22.1 || >=26.12.1; this is Node ${nodeVersion}. Commands may fail; upgrade Node.`,
        ]
      : [],
  );
});

it.skipIf('Deno' in globalThis || 'bun' in process.versions)(
  'sets nodeVersion only for a Node host',
  () => {
    const node = nodeProcess(() => {});
    try {
      expect(node.nodeVersion).toBe(process.versions.node);
    } finally {
      node.dispose?.();
    }
    Object.defineProperty(process.versions, 'bun', { value: '1.4.5', configurable: true });
    try {
      const bun = nodeProcess(() => {});
      try {
        expect(bun.nodeVersion).toBeUndefined();
      } finally {
        bun.dispose?.();
      }
    } finally {
      Reflect.deleteProperty(process.versions, 'bun');
    }
    Object.defineProperty(globalThis, 'Deno', { value: {}, configurable: true });
    try {
      const deno = nodeProcess(() => {});
      try {
        expect(deno.nodeVersion).toBeUndefined();
      } finally {
        deno.dispose?.();
      }
    } finally {
      Reflect.deleteProperty(globalThis, 'Deno');
    }
  },
);
