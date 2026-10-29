import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { rm, stat } from 'node:fs/promises';
import { denoBinary, run, spawnProcess, tempDir, unusedPort } from '../node-helpers.ts';

describe('Node test host helpers', () => {
  it('returns a port a real listener can bind', async () => {
    const port = await unusedPort();
    const server = createServer();
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', accept);
    });
    await new Promise<void>((accept) => server.close(() => accept()));
  });
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
