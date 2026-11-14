import { describe, expect, it } from 'vitest';

import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { devEntryVariants } from '../../src/devtool/dev-entry.ts';
import { parseArgs } from '../../src/args.ts';
import { runWorkspaceCommand } from '../../src/commands/workspace.ts';
import {
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
  type WorkspaceMember,
} from '../../src/workspace/manifest.ts';
import { DISCOVERY_MODULE, DISCOVERY_SPECIFIER } from '../../src/workspace/discovery-module.ts';
import type { TargetRuntime } from '../../src/constants.ts';

function harness(members: readonly WorkspaceMember[], runtime: TargetRuntime = 'deno') {
  const fs = createFakeFs({
    [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
      version: WORKSPACE_VERSION,
      runtime,
      basePort: 3000,
      broker: 'memory',
      members,
    }),
    '/ws/deno.json': '{"workspace":["./apps/*"]}',
    ...Object.fromEntries(
      members
        .filter((member) => member.devtoolPort !== undefined)
        .map((member) => [
          `/ws/apps/${member.name}/main.dev.ts`,
          devEntryVariants(member.devtoolPort!)[0],
        ]),
    ),
    ...Object.fromEntries(members.map((member) => [`/ws/apps/${member.name}/.setu-member`, ''])),
  });
  const log = createRecorder();
  return {
    fs,
    log,
    run: () =>
      runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
        fs,
        cwd: '/ws',
        log: log.sink,
        error: () => {},
        portAvailable: () => Promise.resolve(true),
      }),
  };
}

describe('ports --reallocate', () => {
  it('L4 reports an unreadable inspector script without throwing out of reallocation', async () => {
    const h = harness([{ name: 'web', port: 3000, inspectPort: 5900 }], 'node');
    await h.fs.writeFile('/ws/apps/web/package.json', new TextEncoder().encode('{}'));
    const read = h.fs.readFile.bind(h.fs);
    h.fs.readFile = (path) =>
      path === '/ws/apps/web/package.json'
        ? Promise.reject(new Error('permission denied'))
        : read(path);
    expect(await h.run()).toBe(0);
    expect(h.log.text()).toContain('manifest could not be read');
    expect(h.log.text()).toContain('--inspect=127.0.0.1:5000');
  });
  it('X87-6 drops stale dev ports, rewrites exact tokens and leaves edited scripts with a note', async () => {
    for (const script of [
      'node --inspect=127.0.0.1:5900 main.ts',
      'node --inspect=127.0.0.1:5900 --inspect=127.0.0.1:5900 main.ts',
    ]) {
      const h = harness([{ name: 'web', port: 3000, inspectPort: 5900, vitePort: 5901 }], 'node');
      await h.fs.writeFile(
        '/ws/apps/web/package.json',
        new TextEncoder().encode(JSON.stringify({ scripts: { 'start:debug': script } })),
      );
      expect(await h.run()).toBe(0);
      const manifest = JSON.parse(h.fs.read('/ws/setu.workspace.json'));
      expect(manifest.members[0]).toMatchObject({ inspectPort: 5000, vitePort: 5001 });
      const debug = JSON.parse(h.fs.read('/ws/apps/web/package.json')).scripts['start:debug'];
      if (script.includes('--inspect=127.0.0.1:5900 --inspect')) {
        expect(debug).toBe(script);
        expect(h.log.text()).toContain('script was left unchanged');
      } else expect(debug).toBe('node --inspect=127.0.0.1:5000 main.ts');
    }
  });
  it('names the dev.ts lines when a full-stack member does not read VITE_PORT (CodeRabbit #560)', async () => {
    for (const [dev, noted] of [
      ["const vitePort = Number(process.env.VITE_PORT ?? '5173');\n", true],
      [`import { SERVICE_PORT, VITE_PORT } from '${DISCOVERY_SPECIFIER}';\n`, false],
    ] as const) {
      const h = harness([{ name: 'web', port: 3000, inspectPort: 5900, vitePort: 5901 }], 'node');
      await h.fs.writeFile('/ws/apps/web/dev.ts', new TextEncoder().encode(dev));
      expect(await h.run()).toBe(0);
      expect(h.log.text().includes('Set the two development port lines'), dev).toBe(noted);
    }
  });
  it('X87-6 leaves a bare inspector token unchanged when no old inspector port was recorded', async () => {
    const h = harness([{ name: 'web', port: 3000 }], 'node');
    const script = 'node --inspect main.ts';
    await h.fs.writeFile(
      '/ws/apps/web/package.json',
      new TextEncoder().encode(JSON.stringify({ scripts: { 'start:debug': script } })),
    );
    expect(await h.run()).toBe(0);
    expect(JSON.parse(h.fs.read('/ws/apps/web/package.json')).scripts['start:debug']).toBe(script);
    expect(JSON.parse(h.fs.read('/ws/setu.workspace.json')).members[0].inspectPort).toBe(5000);
    expect(h.log.text()).toContain('no old inspector port was recorded');
    expect(h.log.text()).toContain('--inspect=127.0.0.1:5000');
  });
  it('rewrites a Node member at its new connector port with Node CLI guidance', async () => {
    const h = harness([{ name: 'a', port: 3000, devtoolPort: 4919 }], 'node');
    expect(await h.run()).toBe(0);
    const source = h.fs.read('/ws/apps/a/main.dev.ts');
    expect(source).toContain('port: 4000,');
    expect(source).toContain('npx @setu-ts/cli@');
    expect(source).toContain("delete process.env['SETU_DEVTOOL_SESSION_KEY'];");
    expect(source).toContain('await app.start({ port: SERVICE_PORT });');
  });
  it('moves a member application port and devtool port together', async () => {
    const h = harness([
      { name: 'orders', port: 3000, devtoolPort: 4919 },
      { name: 'billing', port: 3100 },
    ]);
    expect(await h.run()).toBe(0);

    const manifest = JSON.parse(h.fs.read(`/ws/${WORKSPACE_MANIFEST}`)) as {
      members: WorkspaceMember[];
    };
    expect(manifest.members[0].port).toBe(3000);
    expect(manifest.members[0].devtoolPort).toBe(4000);
    // The second member's application port starts AFTER the first member's
    // devtool port — the two addresses moved as one unit.
    expect(manifest.members[1].port).toBe(3001);
    expect(manifest.members[1].devtoolPort).toBeUndefined();

    // The devtool port the discovery modules render is the application port,
    // so the regenerated map must name the new application address.
    const discovery = h.fs.read(`/ws/apps/billing/${DISCOVERY_MODULE}`);
    expect(discovery).toContain('port: 3000');
  });

  it('gains no devtool port for a member that carried none', async () => {
    const h = harness([{ name: 'orders', port: 3000 }]);
    expect(await h.run()).toBe(0);
    const manifest = JSON.parse(h.fs.read(`/ws/${WORKSPACE_MANIFEST}`)) as {
      members: WorkspaceMember[];
    };
    expect(manifest.members[0].devtoolPort).toBeUndefined();
  });

  it('skips an occupied port for the devtool address too', async () => {
    const fs = createFakeFs({
      [`/ws/${WORKSPACE_MANIFEST}`]: renderWorkspaceManifest({
        version: WORKSPACE_VERSION,
        runtime: 'deno',
        basePort: 3000,
        broker: 'memory',
        members: [{ name: 'orders', port: 3000, devtoolPort: 4919 }],
      }),
      '/ws/deno.json': '{"workspace":["./apps/*"]}',
      '/ws/apps/orders/.setu-member': '',
      '/ws/apps/orders/main.dev.ts': devEntryVariants(4919)[0],
    });
    const occupied = new Set([3000, 3001]);
    const code = await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
      fs,
      cwd: '/ws',
      log: () => {},
      error: () => {},
      portAvailable: (port) => Promise.resolve(!occupied.has(port)),
    });
    expect(code).toBe(0);
    const manifest = JSON.parse(fs.read(`/ws/${WORKSPACE_MANIFEST}`)) as {
      members: WorkspaceMember[];
    };
    expect(manifest.members[0].port).toBe(3002);
    expect(manifest.members[0].devtoolPort).toBe(4000);
  });
});
