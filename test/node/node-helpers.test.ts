import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync as writeSync,
} from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPortAllocator,
  denoBinary,
  run,
  spawnProcess,
  tempDir,
  TEST_PORT_RANGE,
  unusedPort,
  unusedPortRange,
} from '../node-helpers.ts';
import type { PortAllocatorOptions } from '../node-helpers.ts';

/** Binds the port for real, so a returned number is proven usable. */
async function bindAndClose(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', accept);
  });
  await new Promise<void>((accept) => server.close(() => accept()));
}

describe('Node test host helpers', () => {
  it('returns claimed ports below the range the operating system assigns from', async () => {
    const first = await unusedPort();
    const second = await unusedPort();
    expect(second).not.toBe(first);
    const claims = join(tmpdir(), 'setu-ts-test-ports');
    for (const port of [first, second]) {
      expect(port).toBeGreaterThanOrEqual(TEST_PORT_RANGE.first);
      expect(port).toBeLessThanOrEqual(TEST_PORT_RANGE.last);
      expect(existsSync(join(claims, String(port)))).toBe(true);
      await bindAndClose(port);
    }
    const base = await unusedPortRange(3);
    for (const port of [base, base + 1, base + 2]) {
      expect(existsSync(join(claims, String(port)))).toBe(true);
      await bindAndClose(port);
    }
  });
});

describe('the test port allocator', () => {
  /** A five-port range over its own claims directory; the search always starts at 100. */
  async function allocator(overrides: Partial<PortAllocatorOptions> = {}) {
    const directory = await tempDir({ prefix: 'ports-' });
    const options: PortAllocatorOptions = {
      directory,
      first: 100,
      last: 104,
      pid: 4242,
      alive: () => true,
      now: () => Date.now(),
      bindable: () => Promise.resolve(true),
      random: () => 0,
      ...overrides,
    };
    return { directory, ports: createPortAllocator(options) };
  }
  const claimed = (directory: string): string[] => readdirSync(directory).sort();

  it('gives each caller its own port and releases every claim', async () => {
    const { directory, ports } = await allocator();
    expect([await ports.port(), await ports.port()]).toEqual([100, 101]);
    expect(claimed(directory)).toEqual(['100', '101']);
    ports.release();
    expect(claimed(directory)).toEqual([]);
    expect(await ports.port()).toBe(100);
  });
  it('starts its search where the random source points and wraps around', async () => {
    const { ports } = await allocator({ random: () => 0.99 });
    expect([await ports.port(), await ports.port()]).toEqual([104, 100]);
  });
  it("skips a port another running process has claimed, and keeps that process's claim", async () => {
    const { directory, ports } = await allocator();
    writeSync(join(directory, '100'), '7');
    expect(await ports.port()).toBe(101);
    expect(claimed(directory)).toEqual(['100', '101']);
  });
  it('takes over a claim whose process is gone', async () => {
    const asked: number[] = [];
    const { directory, ports } = await allocator({
      alive: (pid) => {
        asked.push(pid);
        return false;
      },
    });
    writeSync(join(directory, '100'), '7');
    expect(await ports.port()).toBe(100);
    expect(asked).toEqual([7]);
    expect(readFileSync(join(directory, '100'), 'utf8')).toBe('4242');
  });
  it('takes over a claim older than any test run, even from a running process', async () => {
    const { directory, ports } = await allocator();
    writeSync(join(directory, '100'), '7');
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(join(directory, '100'), old, old);
    expect(await ports.port()).toBe(100);
  });
  it('keeps a claim that is still being written or does not name a process', async () => {
    const { directory, ports } = await allocator({ alive: () => false });
    writeSync(join(directory, '100'), '');
    writeSync(join(directory, '101'), 'not a pid');
    expect(await ports.port()).toBe(102);
  });
  it('skips a port nothing can bind and leaves no claim on it', async () => {
    const { directory, ports } = await allocator({
      bindable: (port) => Promise.resolve(port !== 100),
    });
    expect(await ports.port()).toBe(101);
    expect(claimed(directory)).toEqual(['101']);
  });
  it('really checks that the port can be bound', async () => {
    const occupant = createServer();
    await new Promise<void>((accept) => occupant.listen(0, '127.0.0.1', accept));
    const address = occupant.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    try {
      const directory = await tempDir({ prefix: 'ports-' });
      const ports = createPortAllocator({ directory, first: address.port, last: address.port });
      await expect(ports.port()).rejects.toThrow('no free test port');
      expect(claimed(directory)).toEqual([]);
    } finally {
      await new Promise<void>((accept) => occupant.close(() => accept()));
    }
  });
  it('refuses when the whole range is taken, and when a run is longer than the range', async () => {
    const { ports } = await allocator({ first: 100, last: 101 });
    expect([await ports.port(), await ports.port()]).toEqual([100, 101]);
    await expect(ports.port()).rejects.toThrow('no free test port');
    await expect(ports.range(3)).rejects.toThrow('no free test port');
  });
  // Root ignores directory permissions, so there is no write to refuse.
  it.skipIf(process.getuid?.() === 0)(
    'reports a claims directory it cannot write to instead of treating the port as taken',
    async () => {
      const { directory, ports } = await allocator();
      chmodSync(directory, 0o555);
      try {
        await expect(ports.port()).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        chmodSync(directory, 0o755);
      }
    },
  );
  it('reports a claim it cannot read instead of treating it as released', async () => {
    const { directory, ports } = await allocator();
    // A directory where the claim file should be: the exclusive create and the read both fail.
    mkdirSync(join(directory, '100'));
    await expect(ports.port()).rejects.toMatchObject({ code: 'EISDIR' });
  });
  it('gives a run of consecutive ports and leaves nothing behind from a run that failed', async () => {
    const { directory, ports } = await allocator();
    writeSync(join(directory, '101'), '7');
    // 100..102 fails at 101 and 101..103 at once; 102..104 is the first free run.
    expect(await ports.range(3)).toBe(102);
    expect(claimed(directory)).toEqual(['101', '102', '103', '104']);
  });
  it('drops the whole run when one of its ports cannot be bound', async () => {
    const { directory, ports } = await allocator({
      bindable: (port) => Promise.resolve(port !== 101),
    });
    expect(await ports.range(2)).toBe(102);
    expect(claimed(directory)).toEqual(['102', '103']);
  });
  it("releases the shared claims when the process exits, and takes over a killed process's claim", async () => {
    const claims = join(tmpdir(), 'setu-ts-test-ports');
    const helper = new URL('../node-helpers.ts', import.meta.url).href;
    const args = (after: string): string[] => [
      '--experimental-transform-types',
      '--input-type=module',
      '-e',
      `const { unusedPort } = await import(${JSON.stringify(helper)});` +
        `process.stdout.write(String(await unusedPort())); ${after}`,
    ];
    const clean = await run(process.execPath, { args: args('') });
    const released = Number(new TextDecoder().decode(clean.stdout));
    expect(released).toBeGreaterThanOrEqual(TEST_PORT_RANGE.first);
    expect(existsSync(join(claims, String(released)))).toBe(false);

    const killed = spawnProcess(process.execPath, { args: args('setInterval(() => {}, 1000);') });
    const port = Number(new TextDecoder().decode((await killed.stdout!.getReader().read()).value));
    try {
      expect(readFileSync(join(claims, String(port)), 'utf8')).toBe(String(killed.pid));
      const whileAlive = createPortAllocator({ directory: claims, first: port, last: port });
      await expect(whileAlive.port()).rejects.toThrow('no free test port');
    } finally {
      killed.kill('SIGKILL');
      await killed.status;
    }
    expect(existsSync(join(claims, String(port)))).toBe(true);
    const ports = createPortAllocator({ directory: claims, first: port, last: port });
    try {
      expect(await ports.port()).toBe(port);
      expect(readFileSync(join(claims, String(port)), 'utf8')).toBe(String(process.pid));
    } finally {
      ports.release();
    }
  });
});

describe('Node test host helpers: scratch and processes', () => {
  it('creates removable scratch directories under the workspace', async () => {
    const directory = await tempDir();
    try {
      expect((await stat(directory)).isDirectory()).toBe(true);
      expect(directory).toContain('/.tmp/node-tests/');
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it('returns stdout, stderr and the real nonzero exit status', async () => {
    const output = await run(process.execPath, {
      args: ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'],
    });
    expect(output.code).toBe(3);
    expect(output.success).toBe(false);
    expect(new TextDecoder().decode(output.stdout)).toBe('out');
    expect(new TextDecoder().decode(output.stderr)).toBe('err');
  });
  it('reports process launch failure', async () => {
    await expect(run('/does-not-exist-m111b')).rejects.toThrow('ENOENT');
  });
  it('passes a bounded environment and null output through a real subprocess', async () => {
    const output = await run(process.execPath, {
      args: ['-e', 'process.exit(process.env.M111B === "ok" && !process.env.HOME ? 0 : 1)'],
      clearEnv: true,
      env: { M111B: 'ok' },
      stdout: 'null',
      stderr: 'null',
    });
    expect(output.success).toBe(true);
    expect(output.stdout).toHaveLength(0);
  });
  it('can terminate a long-running real subprocess', async () => {
    const child = spawnProcess(process.execPath, { args: ['-e', 'setInterval(()=>{},1000)'] });
    child.kill();
    expect((await child.status).success).toBe(false);
  });
  it('finds Deno on PATH and names the missing-binary requirement', () => {
    expect(denoBinary()).toMatch(/deno/);
    expect(() => denoBinary('')).toThrow('deno is required on PATH');
    expect(denoBinary('', '/opt/deno/bin/deno')).toBe('/opt/deno/bin/deno');
  });
});

import { writeFile } from 'node:fs/promises';
import {
  connect,
  importSource,
  serveHttp,
  upgradeResponse,
  WorkersResponse,
} from '../node-helpers.ts';

describe('real Node protocol helpers', () => {
  it('keeps upgrade statuses and Workers socket identity in explicit host doubles', () => {
    expect(upgradeResponse().status).toBe(101);
    expect(upgradeResponse('body', { status: 403 }).status).toBe(403);
    const socket = {};
    expect(new WorkersResponse().status).toBe(200);
    expect(new WorkersResponse('ok', { status: 201 }).status).toBe(201);
    const response = new WorkersResponse(null, { status: 101, webSocket: socket });
    expect(response.status).toBe(101);
    expect(Reflect.get(response, 'webSocket')).toBe(socket);
  });
  it('imports a temporary TypeScript module and removes it even when evaluation fails', async () => {
    expect((await importSource('export const value: number = 42;')).value).toBe(42);
    await expect(importSource('throw new Error("module-failure");')).rejects.toThrow(
      'module-failure',
    );
  });
  it('preserves byte boundaries over a real TCP connection and reports EOF', async () => {
    const server = createServer((socket) => {
      socket.once('data', (input) => {
        expect(input.toString()).toBe('request');
        socket.end('response');
      });
    });
    await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const client = await connect({ port: address.port });
    try {
      expect(await client.write(new TextEncoder().encode('request'))).toBe(7);
      const buffer = new Uint8Array(3);
      let text = '';
      let count;
      while ((count = await client.read(buffer)) !== null) {
        text += new TextDecoder().decode(buffer.subarray(0, count));
      }
      expect(text).toBe('response');
    } finally {
      client.close();
      await new Promise<void>((accept) => server.close(() => accept()));
    }
    await expect(connect({ hostname: '127.0.0.1', port: address.port })).rejects.toThrow();
  });
  it('serves an actual Fetch handler and shuts down both explicit and default listeners', async () => {
    for (const options of [{}, { port: 0, hostname: '127.0.0.1' }]) {
      const server = await serveHttp(
        options,
        (request) => new Response(new URL(request.url).pathname),
      );
      try {
        expect(await (await fetch(`http://127.0.0.1:${server.addr.port}/proof`)).text()).toBe(
          '/proof',
        );
      } finally {
        await server.shutdown();
      }
    }
  });
  it('rejects a failed HTTP bind without disturbing the active listener', async () => {
    const server = await serveHttp({}, () => new Response('occupant'));
    try {
      await expect(
        serveHttp({ port: server.addr.port }, () => new Response('conflict')),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(await (await fetch(`http://127.0.0.1:${server.addr.port}/`)).text()).toBe('occupant');
    } finally {
      await server.shutdown();
    }
  });
  it('honors cwd, stdin, environment, and AbortSignal on real children', async () => {
    const directory = await tempDir({ prefix: 'child-' });
    try {
      await writeFile(`${directory}/proof.txt`, 'proof');
      const child = spawnProcess(process.execPath, {
        cwd: directory,
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'null',
        args: [
          '-e',
          'process.stdin.on("data", b => { process.stdout.write(require("node:fs").readFileSync("proof.txt") + b); process.exit(0) })',
        ],
      });
      const writer = child.stdin!.getWriter();
      await writer.write(new TextEncoder().encode('!'));
      await writer.close();
      expect(new TextDecoder().decode((await child.output()).stdout)).toBe('proof!');
      const controller = new AbortController();
      const aborted = spawnProcess(process.execPath, {
        signal: controller.signal,
        args: ['-e', 'setInterval(()=>{},1000)'],
      });
      const outcome = expect(aborted.status).rejects.toThrow('aborted');
      controller.abort();
      await outcome;
      expect(
        (
          await run(process.execPath, {
            args: ['-e', 'process.exit(0)'],
            stdin: 'null',
            stdout: 'inherit',
            stderr: 'inherit',
          })
        ).code,
      ).toBe(0);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
