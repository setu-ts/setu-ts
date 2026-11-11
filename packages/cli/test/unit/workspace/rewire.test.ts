import { describe, expect, it } from 'vitest';
import { createFakeFs, type FakeFs } from '../../fixtures/fake-fs.ts';
import { runCli } from '../../../src/cli.ts';
import { readWorkspaceManifest } from '../../../src/workspace/manifest.ts';
import { planTransportChange } from '../../../src/workspace/rewire.ts';
import { TRANSPORT_README_MARKERS } from '../../../src/workspace/root-files.ts';

const ROOT = '/w/ws';

/** A scaffolded workspace driven through the real CLI. */
interface Workspace {
  readonly fs: FakeFs;
  /** Runs the CLI from a directory (the root by default); returns code and output. */
  run(
    args: readonly string[],
    cwd?: string,
  ): Promise<{ readonly code: number; readonly out: string; readonly err: string }>;
  read(path: string): string;
  write(path: string, contents: string): Promise<void>;
}

/**
 * Scaffolds a workspace and its members through `setu new` and `generate app`.
 *
 * @param options - The runtime, the broker, and each member as `[name, template, rpc?]`
 * @returns The workspace
 */
async function workspace(
  options: {
    readonly runtime?: 'deno' | 'node';
    readonly broker?: string;
    readonly members?: readonly (readonly [string, string, ('grpc' | 'http')?])[];
  } = {},
): Promise<Workspace> {
  const fs = createFakeFs();
  const run: Workspace['run'] = async (args, cwd = ROOT) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, {
      fs,
      cwd,
      now: () => 0,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const created = await run(
    [
      'new',
      'ws',
      '--workspace',
      '--runtime',
      options.runtime ?? 'deno',
      ...(options.broker === undefined ? [] : ['--broker', options.broker]),
    ],
    '/w',
  );
  expect(created.code, created.err).toBe(0);
  for (const [name, template, rpc] of options.members ?? [['orders', 'microservice']]) {
    const added = await run([
      'g',
      'app',
      name,
      '--template',
      template,
      ...(rpc === undefined ? [] : ['--rpc', rpc]),
    ]);
    expect(added.code, added.err).toBe(0);
  }
  return {
    fs,
    run,
    read: (path) => fs.read(`${ROOT}/${path}`),
    write: (path, contents) => fs.writeFile(`${ROOT}/${path}`, new TextEncoder().encode(contents)),
  };
}

describe('setu workspace broker', () => {
  it('rewrites every CLI-owned file and merges the clients the broker needs', async () => {
    const ws = await workspace({
      members: [
        ['orders', 'microservice'],
        ['web', 'full-stack'],
      ],
    });
    const config = ws.read('apps/orders/setu.config.ts');
    const result = await ws.run(['workspace', 'broker', 'redis']);
    expect(result.code, result.err).toBe(0);
    // Class 1: CLI-owned, rewritten.
    expect(ws.read('apps/orders/src/transport/index.ts')).toContain("broker: 'redis-streams'");
    expect(ws.read('apps/web/src/transport/index.ts')).toContain("config.get<string>('REDIS_URL'");
    expect(JSON.parse(ws.read('setu.workspace.json'))).toMatchObject({ broker: 'redis' });
    expect(ws.read('docker/compose.yaml')).toContain('image: redis:7');
    expect(ws.read('README.md')).toContain('Members share the **redis** broker');
    // Class 2: merged, never removed.
    expect(JSON.parse(ws.read('apps/orders/deno.json')).imports).toMatchObject({
      ioredis: expect.stringContaining('npm:ioredis@'),
    });
    // Class 4: the developer's config is untouched.
    expect(ws.read('apps/orders/setu.config.ts')).toBe(config);
    expect(result.out).toContain('Run `deno install` at the workspace root.');
  });

  it('merges npm dependencies on an npm workspace', async () => {
    const ws = await workspace({ runtime: 'node' });
    expect((await ws.run(['workspace', 'broker', 'nats'])).code).toBe(0);
    expect(JSON.parse(ws.read('apps/orders/package.json')).dependencies).toMatchObject({
      nats: expect.any(String),
    });
  });

  it('replaces only the README section between its markers', async () => {
    const ws = await workspace();
    const readme = ws.read('README.md');
    await ws.write('README.md', `# Mine\n\nMy notes.\n${readme}\nMy footer.\n`);
    expect((await ws.run(['workspace', 'broker', 'kafka'])).code).toBe(0);
    const after = ws.read('README.md');
    expect(after).toContain('# Mine\n\nMy notes.');
    expect(after).toContain('My footer.');
    expect(after).toContain('Members share the **kafka** broker');
    expect(after).not.toContain('Members share the **memory** broker');
  });

  it('leaves a README without markers alone and prints the section', async () => {
    const ws = await workspace();
    await ws.write('README.md', '# My own README\n');
    const result = await ws.run(['workspace', 'broker', 'redis']);
    expect(result.code).toBe(0);
    expect(ws.read('README.md')).toBe('# My own README\n');
    expect(result.out).toContain(`README.md has no ${TRANSPORT_README_MARKERS.start} section`);
    expect(result.out).toContain('Members share the **redis** broker');
  });

  // A no-op on each field the change compares.
  it('changes nothing when the broker, endpoint and client are already recorded', async () => {
    const ws = await workspace({ broker: 'redis' });
    const before = ws.fs.writes.length;
    const result = await ws.run(['workspace', 'broker', 'redis']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('already uses the redis broker; nothing changed');
    expect(ws.fs.writes.length).toBe(before);
    // A different endpoint or client IS a change.
    expect(
      (await ws.run(['workspace', 'broker', 'redis', '--broker-url', 'redis://shared:6379'])).code,
    ).toBe(0);
    // …and repeating it is not: the manifest is compared by content, not key order.
    const again = await ws.run([
      'workspace',
      'broker',
      'redis',
      '--broker-url',
      'redis://shared:6379',
    ]);
    expect(again.out).toContain('already uses the redis broker; nothing changed');
    await ws.run(['workspace', 'rpc', 'orders', 'grpc']);
    expect(
      (await ws.run(['workspace', 'broker', 'redis', '--broker-url', 'redis://shared:6379'])).out,
    ).toContain('nothing changed');
    expect(ws.read('apps/orders/src/transport/index.ts')).toContain('redis://shared:6379');
    expect(
      (await ws.run(['workspace', 'broker', 'redis', '--redis-client', 'node-redis'])).code,
    ).toBe(0);
    expect(JSON.parse(ws.read('setu.workspace.json'))).toMatchObject({ redisClient: 'node-redis' });
    expect(ws.read('apps/orders/src/transport/index.ts')).toContain("from '../node-redis.ts'");
    // Class 3: create-only — the helper the module imports.
    expect(ws.read('apps/orders/src/node-redis.ts')).toContain('nodeRedisClient');
  });

  it('drops the Redis client when the workspace leaves Redis, and says what it left', async () => {
    const ws = await workspace({ broker: 'redis' });
    expect(
      (await ws.run(['workspace', 'broker', 'redis', '--redis-client', 'node-redis'])).code,
    ).toBe(0);
    const result = await ws.run(['workspace', 'broker', 'nats']);
    expect(result.code).toBe(0);
    expect(JSON.parse(ws.read('setu.workspace.json')).redisClient).toBeUndefined();
    expect(result.out).toContain(
      'apps/orders: its transport module no longer uses redis; left in its manifest',
    );
    expect(result.out).toContain('src/node-redis.ts is no longer imported');
  });

  // The note is per member and per shape: a REST member never had the broker's
  // client, so it is never told it no longer needs one.
  it("lists only packages a member's module used to need", async () => {
    const ws = await workspace({
      broker: 'redis',
      members: [
        ['orders', 'microservice'],
        ['api', 'rest'],
      ],
    });
    const result = await ws.run(['workspace', 'broker', 'nats']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('apps/orders: its transport module no longer uses ioredis');
    expect(result.out).not.toContain('apps/api: its transport module');
    // Leaving gRPC names the toolchain it leaves behind.
    expect((await ws.run(['workspace', 'rpc', 'orders', 'grpc'])).code).toBe(0);
    const http = await ws.run(['workspace', 'rpc', 'orders', 'http']);
    expect(http.out).toContain('@setu-ts/grpc-plugin');
    expect(http.out).toContain('apps/orders: the proto toolchain files were left in place.');
  });

  it('names the backing files of the previous broker it leaves behind', async () => {
    const ws = await workspace({ broker: 'service-bus' });
    const result = await ws.run(['workspace', 'broker', 'memory']);
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      'docker/servicebus-config.json belonged to the service-bus broker',
    );
  });

  it('prints the plan and writes nothing under --dry-run', async () => {
    const ws = await workspace();
    const before = ws.fs.writes.length;
    const result = await ws.run(['workspace', 'broker', 'redis', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`would write ${ROOT}/apps/orders/src/transport/index.ts`);
    expect(result.out).toContain(`would write ${ROOT}/setu.workspace.json`);
    expect(ws.fs.writes.length).toBe(before);
  });

  for (const [label, args, expected] of [
    ['an unknown broker', ['carrier-pigeon'], 'Unknown broker "carrier-pigeon"'],
    ['a call style', ['grpc'], 'workspace rpc <member> grpc'],
    ['no broker at all', [], 'Usage: setu workspace broker <name>'],
    [
      '--redis-client off Redis',
      ['nats', '--redis-client', 'node-redis'],
      'applies only to `workspace broker redis`',
    ],
    [
      'an unknown --redis-client',
      ['redis', '--redis-client', 'hiredis'],
      'Unknown --redis-client "hiredis"',
    ],
    ['--broker-url on memory', ['memory', '--broker-url', 'x'], 'runs inside each member'],
    [
      '--broker-url on a cloud broker',
      ['pubsub', '--broker-url', 'x'],
      'read from PUBSUB_PROJECT_ID',
    ],
  ] as const) {
    it(`refuses ${label} with a usage error`, async () => {
      const ws = await workspace();
      const result = await ws.run(['workspace', 'broker', ...args]);
      expect(result.code).toBe(2);
      expect(result.err).toContain(expected);
    });
  }

  it('refuses outside a workspace', async () => {
    const fs = createFakeFs();
    const errors: string[] = [];
    expect(
      await runCli(['workspace', 'broker', 'redis'], {
        fs,
        cwd: '/nowhere',
        now: () => 0,
        log: () => {},
        error: (line) => errors.push(line),
      }),
    ).toBe(1);
    expect(errors.join('\n')).toContain('not a Setu workspace');
  });
});

describe('setu workspace rpc', () => {
  it('switches one member to grpc and back, with the toolchain created once', async () => {
    const ws = await workspace({
      members: [
        ['orders', 'microservice'],
        ['billing', 'microservice'],
      ],
    });
    expect((await ws.run(['workspace', 'rpc', 'orders', 'grpc'])).code).toBe(0);
    expect(ws.read('apps/orders/src/transport/index.ts')).toContain(
      "GrpcPlugin({ basePath: '/grpc' })",
    );
    expect(ws.read('apps/billing/src/transport/index.ts')).not.toContain('GrpcPlugin');
    expect(JSON.parse(ws.read('apps/orders/deno.json'))).toMatchObject({
      imports: {
        '@setu-ts/grpc-plugin': expect.any(String),
        '@connectrpc/connect': expect.any(String),
      },
      tasks: { 'proto:gen': expect.any(String) },
    });
    expect(ws.read('apps/orders/buf.gen.yaml')).toBeDefined();
    // Class 3: an edited toolchain file survives a second switch.
    await ws.write('apps/orders/buf.gen.yaml', '# mine\n');
    expect((await ws.run(['workspace', 'rpc', 'orders', 'http'])).code).toBe(0);
    expect((await ws.run(['workspace', 'rpc', 'orders', 'grpc'])).code).toBe(0);
    expect(ws.read('apps/orders/buf.gen.yaml')).toBe('# mine\n');
  });

  it('changes nothing when the member already has the style', async () => {
    const ws = await workspace();
    const result = await ws.run(['workspace', 'rpc', 'orders', 'http']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('orders is already http; nothing changed');
  });

  it('exempts the gRPC mount from form CSRF on a full-stack member', async () => {
    const ws = await workspace({ members: [['web', 'full-stack']] });
    expect((await ws.run(['workspace', 'rpc', 'web', 'grpc'])).code).toBe(0);
    expect(ws.read('apps/web/src/transport/index.ts')).toContain("new RegExp('^/grpc(?:/|$)')");
  });

  for (const [label, args, expected] of [
    ['an unknown member', ['nope', 'grpc'], 'No workspace member "nope". Members: orders.'],
    ['an unknown style', ['orders', 'rest'], 'Unknown RPC style "rest"'],
    ['a missing style', ['orders'], 'Usage: setu workspace rpc <member> <http|grpc>'],
  ] as const) {
    it(`refuses ${label} with a usage error`, async () => {
      const ws = await workspace();
      const result = await ws.run(['workspace', 'rpc', ...args]);
      expect(result.code).toBe(2);
      expect(result.err).toContain(expected);
    });
  }

  it('prints its usage under --help', async () => {
    const ws = await workspace();
    expect((await ws.run(['workspace', 'rpc', '--help'])).out).toContain('workspace rpc <member>');
    expect((await ws.run(['workspace', 'broker', '--help'])).out).toContain(
      'workspace broker <name>',
    );
  });
});

describe('refusing a member that does not read the module', () => {
  for (const [template, line] of [
    ['microservice', 'MessagingPlugin(messagingOptions()),'],
    ['full-stack', 'messaging: messagingOptions(config),'],
  ] as const) {
    it(`writes nothing and names the lines on a ${template} member`, async () => {
      const ws = await workspace({ members: [['svc', template]] });
      const config = ws.read('apps/svc/setu.config.ts');
      // The shape a config made before M138 has: a literal, no module call.
      await ws.write(
        'apps/svc/setu.config.ts',
        config.replace('messagingOptions(config)', '{}').replace('messagingOptions()', ''),
      );
      const before = ws.fs.writes.length;
      const result = await ws.run(['workspace', 'broker', 'redis']);
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        'apps/svc/setu.config.ts does not read its CLI-owned transport module',
      );
      expect(result.err).toContain(line);
      expect(result.err).toContain('Nothing was written.');
      expect(ws.fs.writes.length).toBe(before);
      expect(JSON.parse(ws.read('setu.workspace.json')).broker).toBe('memory');
    });
  }

  it('treats an unreadable config as missing every call, and --force does not bypass it', async () => {
    const ws = await workspace();
    await ws.write('apps/orders/setu.config.ts', 'const text = `${x}`;\n');
    const result = await ws.run(['workspace', 'broker', 'redis', '--force']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('...transportPlugins(),');
  });

  it('decides through the strict lexer, which a template literal stops (M139d audit F2)', async () => {
    const ws = await workspace();
    // The module IS called; only the read-only check's tolerant mask could see
    // that past the template literal, and an automatic edit must not rely on it.
    const config = ws.read('apps/orders/setu.config.ts');
    await ws.write('apps/orders/setu.config.ts', `${config}\nconst label = \`orders\`;\n`);
    const before = ws.fs.writes.length;
    const result = await ws.run(['workspace', 'broker', 'redis']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Nothing was written.');
    expect(ws.fs.writes.length).toBe(before);
  });

  it('refuses a member manifest that is not plain JSON, writing nothing', async () => {
    const ws = await workspace();
    const manifest = ws.read('apps/orders/deno.json');
    await ws.write('apps/orders/deno.json', `// mine\n${manifest}`);
    const result = await ws.run(['workspace', 'broker', 'redis']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('apps/orders/deno.json is not plain JSON');
    expect(result.err).toContain('"imports": { "ioredis":');
    expect(JSON.parse(ws.read('setu.workspace.json')).broker).toBe('memory');
  });

  it('merges into a Deno member whose manifest is deno.jsonc', async () => {
    const ws = await workspace();
    const manifest = ws.read('apps/orders/deno.json');
    await ws.fs.rm(`${ROOT}/apps/orders/deno.json`);
    await ws.write('apps/orders/deno.jsonc', manifest);
    const result = await ws.run(['workspace', 'broker', 'redis']);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(ws.read('apps/orders/deno.jsonc')).imports).toMatchObject({
      ioredis: expect.stringContaining('npm:ioredis@'),
    });
    expect(ws.fs.has(`${ROOT}/apps/orders/deno.json`)).toBe(false);
  });

  it('refuses a deno.jsonc manifest with comments, naming that file', async () => {
    const ws = await workspace();
    const manifest = ws.read('apps/orders/deno.json');
    await ws.fs.rm(`${ROOT}/apps/orders/deno.json`);
    await ws.write('apps/orders/deno.jsonc', `// mine\n${manifest}`);
    const result = await ws.run(['workspace', 'broker', 'redis']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('apps/orders/deno.jsonc is not plain JSON');
    expect(result.err).not.toContain('cannot be read');
    expect(JSON.parse(ws.read('setu.workspace.json')).broker).toBe('memory');
  });
});

describe('refusing a switch that would orphan wiring', () => {
  it('refuses leaving Redis while code still reads REDIS_URL, and --force goes ahead', async () => {
    const ws = await workspace({ broker: 'redis' });
    await ws.write('apps/orders/src/cache.ts', "export const url = Deno.env.get('REDIS_URL');\n");
    const refused = await ws.run(['workspace', 'broker', 'nats']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('apps/orders/src/cache.ts:1 — reads REDIS_URL');
    expect(JSON.parse(ws.read('setu.workspace.json')).broker).toBe('redis');
    const forced = await ws.run(['workspace', 'broker', 'nats', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.err).toContain('warning: apps/orders/src/cache.ts:1');
    expect(JSON.parse(ws.read('setu.workspace.json')).broker).toBe('nats');
  });

  // Only an absent `src/` is an empty scan: a walk or read that fails leaves the
  // scan incomplete, which is refused like a hit unless `--force`.
  for (const [label, broken] of [
    [
      'src/ cannot be walked',
      (fs: FakeFs, path: string) => path.endsWith('/apps/orders/src') && fs,
    ],
    [
      'a source file cannot be read',
      (fs: FakeFs, path: string) => path.endsWith('/apps/orders/src/cache.ts') && fs,
    ],
  ] as const) {
    it(`refuses an incomplete scan when ${label}, and --force goes ahead`, async () => {
      const ws = await workspace({ broker: 'redis' });
      await ws.write('apps/orders/src/cache.ts', 'export {};\n');
      const read = await readWorkspaceManifest(ws.fs, ROOT);
      if (!read.ok) throw new Error('expected a manifest');
      const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      const fs: FakeFs = {
        ...ws.fs,
        readdir: (path) => (broken(ws.fs, path) ? Promise.reject(denied) : ws.fs.readdir(path)),
        readFile: (path) =>
          label.startsWith('a source') && broken(ws.fs, path)
            ? Promise.reject(denied)
            : ws.fs.readFile(path),
      };
      const change = { kind: 'broker', broker: 'nats' } as const;
      const refused = await planTransportChange(fs, ROOT, read.manifest, change);
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.messages.join('\n')).toContain(
        'could not be scanned, so what it uses is unknown',
      );
      const forced = await planTransportChange(fs, ROOT, read.manifest, change, { force: true });
      expect(forced.ok && forced.warnings.join('\n')).toContain('could not be scanned');
    });
  }

  it('treats a member with no src/ as an empty scan', async () => {
    const ws = await workspace({ broker: 'redis' });
    const read = await readWorkspaceManifest(ws.fs, ROOT);
    if (!read.ok) throw new Error('expected a manifest');
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fs: FakeFs = {
      ...ws.fs,
      readdir: (path) =>
        path.endsWith('/apps/orders/src') ? Promise.reject(missing) : ws.fs.readdir(path),
    };
    expect(
      (await planTransportChange(fs, ROOT, read.manifest, { kind: 'broker', broker: 'nats' })).ok,
    ).toBe(true);
  });

  it('ignores the pattern in a comment of a file it can read', async () => {
    const ws = await workspace({ broker: 'redis' });
    await ws.write('apps/orders/src/notes.ts', '// we used to read REDIS_URL here\nexport {};\n');
    expect((await ws.run(['workspace', 'broker', 'nats'])).code).toBe(0);
  });

  it('scans a file it cannot classify as raw text, so it refuses rather than skips', async () => {
    const ws = await workspace({ broker: 'redis' });
    await ws.write('apps/orders/src/odd.ts', '// REDIS_URL\nexport const t = `${1}`;\n');
    expect((await ws.run(['workspace', 'broker', 'nats'])).code).toBe(1);
  });

  for (const [label, contents] of [
    [
      'resolves the gRPC capability',
      "import { CAPABILITIES } from '@setu-ts/common';\nexport const k = CAPABILITIES.GRPC;\n",
    ],
    ['imports the gRPC plugin', "export { GrpcPlugin } from '@setu-ts/grpc-plugin';\n"],
    ['imports generated descriptors', "export * from './gen/orders/v1/orders_pb.ts';\n"],
  ] as const) {
    it(`refuses leaving grpc while code ${label}`, async () => {
      const ws = await workspace({ members: [['orders', 'microservice', 'grpc']] });
      await ws.write('apps/orders/src/rpc.ts', contents);
      const result = await ws.run(['workspace', 'rpc', 'orders', 'http']);
      expect(result.code).toBe(1);
      expect(result.err).toContain('apps/orders/src/rpc.ts:');
    });
  }

  // A file name comes from the developer's tree, and the output sinks leave a line
  // feed alone: unescaped, a newline in a name would print a forged line of its own.
  it('escapes a control character in a reported file name', async () => {
    const ws = await workspace({ members: [['orders', 'microservice', 'grpc']] });
    await ws.write('apps/orders/src/x\nsetu: FORGED.ts', 'export const k = CAPABILITIES.GRPC;\n');
    const result = await ws.run(['workspace', 'rpc', 'orders', 'http']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('apps/orders/src/x\\u000asetu: FORGED.ts:1');
    expect(result.err.split('\n').some((line) => line.startsWith('setu: FORGED'))).toBe(false);
  });

  it('ignores the generated descriptors themselves, and never refuses a switch TO grpc', async () => {
    const ws = await workspace({ members: [['orders', 'microservice', 'grpc']] });
    await ws.write(
      'apps/orders/src/gen/orders/v1/orders_pb.ts',
      "import { x } from './gen/y.ts';\n",
    );
    expect((await ws.run(['workspace', 'rpc', 'orders', 'http'])).code).toBe(0);
    await ws.write('apps/orders/src/rpc.ts', 'export const k = CAPABILITIES.GRPC;\n');
    expect((await ws.run(['workspace', 'rpc', 'orders', 'grpc'])).code).toBe(0);
  });
});

// M138 §3.7: one renderer behind every entry point. Each produces the module the
// planner would for the same manifest and packages, on a NON-default workspace.
describe('every entry point renders the same module', () => {
  it('generate app, workspace broker/rpc, sync and add agree byte for byte', async () => {
    const ws = await workspace({
      broker: 'rabbitmq',
      members: [
        ['orders', 'microservice', 'grpc'],
        ['api', 'rest'],
      ],
    });
    const generated = ws.read('apps/orders/src/transport/index.ts');

    await ws.write('apps/orders/src/transport/index.ts', '// drift\n');
    expect((await ws.run(['sync'], `${ROOT}/apps/orders`)).code).toBe(0);
    expect(ws.read('apps/orders/src/transport/index.ts')).toBe(generated);

    await ws.write('apps/orders/src/transport/index.ts', '// drift\n');
    expect((await ws.run(['sync'])).code).toBe(0);
    expect(ws.read('apps/orders/src/transport/index.ts')).toBe(generated);

    expect((await ws.run(['workspace', 'rpc', 'orders', 'http'])).code).toBe(0);
    expect((await ws.run(['workspace', 'rpc', 'orders', 'grpc'])).code).toBe(0);
    expect(ws.read('apps/orders/src/transport/index.ts')).toBe(generated);

    expect((await ws.run(['workspace', 'broker', 'redis'])).code).toBe(0);
    expect((await ws.run(['workspace', 'broker', 'rabbitmq'])).code).toBe(0);
    expect(ws.read('apps/orders/src/transport/index.ts')).toBe(generated);

    // `generate app` regenerates every OTHER member's module too.
    await ws.write('apps/orders/src/transport/index.ts', '// drift\n');
    expect((await ws.run(['g', 'app', 'billing', '--template', 'rest'])).code).toBe(0);
    expect(ws.read('apps/orders/src/transport/index.ts')).toBe(generated);

    // `add grpc` in a member is `workspace rpc <member> grpc`.
    const api = ws.read('apps/api/src/transport/index.ts');
    expect((await ws.run(['add', 'grpc'], `${ROOT}/apps/api`)).code).toBe(0);
    expect(
      JSON.parse(ws.read('setu.workspace.json')).members.find(
        (m: { name: string }) => m.name === 'api',
      ).rpc,
    ).toBe('grpc');
    expect(ws.read('apps/api/src/transport/index.ts')).not.toBe(api);

    // `add messaging` and `add queue` regenerate the module with the new export.
    expect((await ws.run(['add', 'messaging'], `${ROOT}/apps/api`)).code).toBe(0);
    expect((await ws.run(['add', 'queue'], `${ROOT}/apps/api`)).code).toBe(0);
    const withBus = ws.read('apps/api/src/transport/index.ts');
    expect(withBus).toContain("broker: 'rabbitmq'");
    expect(withBus).toContain("adapter: 'rabbitmq'");
    await ws.write('apps/api/src/transport/index.ts', '// drift\n');
    expect((await ws.run(['sync'], `${ROOT}/apps/api`)).code).toBe(0);
    expect(ws.read('apps/api/src/transport/index.ts')).toBe(withBus);
  });

  // `setu add grpc` in a member runs every flag refusal `setu add` runs before it
  // hands off, so a transport flag is refused rather than silently ignored.
  for (const extra of [
    ['--broker', 'redis'],
    ['--queue', 'redis'],
    ['--redis-client', 'node-redis'],
    ['--store', 'redis'],
  ]) {
    it(`refuses setu add grpc ${extra.join(' ')} in a member, writing nothing`, async () => {
      const ws = await workspace();
      const before = ws.fs.writes.length;
      const result = await ws.run(['add', 'grpc', ...extra], `${ROOT}/apps/orders`);
      expect(result.code).toBe(2);
      expect(ws.fs.writes.length).toBe(before);
      expect(JSON.parse(ws.read('setu.workspace.json')).members[0].rpc).toBeUndefined();
    });
  }

  // Adding the plugin is a request for it: on a member already on gRPC, `setu add
  // grpc` restores what that choice needs rather than stopping as a no-op.
  it("restores a gRPC member's plugin and toolchain on setu add grpc", async () => {
    const ws = await workspace({ members: [['orders', 'microservice', 'grpc']] });
    const manifest = JSON.parse(ws.read('apps/orders/deno.json'));
    delete manifest.imports['@setu-ts/grpc-plugin'];
    await ws.write('apps/orders/deno.json', JSON.stringify(manifest, null, 2));
    await ws.fs.rm(`${ROOT}/apps/orders/buf.gen.yaml`);
    const result = await ws.run(['add', 'grpc'], `${ROOT}/apps/orders`);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(
      'orders already serves grpc; its transport module and packages are up to date',
    );
    expect(
      JSON.parse(ws.read('apps/orders/deno.json')).imports['@setu-ts/grpc-plugin'],
    ).toBeDefined();
    expect(ws.read('apps/orders/buf.gen.yaml')).toBeDefined();
    // `setu workspace rpc` keeps the no-op: it changes a choice, it does not repair one.
    expect((await ws.run(['workspace', 'rpc', 'orders', 'grpc'])).out).toContain('nothing changed');
  });

  it('plans without a command, returning the manifest it would write', async () => {
    const ws = await workspace();
    const read = await readWorkspaceManifest(ws.fs, ROOT);
    if (!read.ok) throw new Error('expected a manifest');
    const plan = await planTransportChange(ws.fs, ROOT, read.manifest, {
      kind: 'broker',
      broker: 'nats',
    });
    expect(plan.ok && plan.manifest.broker).toBe('nats');
    expect(plan.ok && plan.files.map((file) => file.path)).toContain(
      'apps/orders/src/transport/index.ts',
    );
  });
});

// M138 §3.10: a workspace made by 0.11.0 has a version-1 manifest and members
// whose configs hold literal broker options.
describe('a workspace made by 0.11.0', () => {
  it('gains members without a refusal, and switches once its configs read the module', async () => {
    const ws = await workspace({ broker: 'redis' });
    const literal = ws
      .read('apps/orders/setu.config.ts')
      .replace(
        'MessagingPlugin(messagingOptions())',
        "MessagingPlugin({ broker: 'redis-streams', url: 'redis://127.0.0.1:6379' })",
      )
      .replace(/\nimport \{[^}]*\} from '\.\/src\/transport\/index\.ts';/, '')
      .replace(', ...queueOptions()', '')
      .replace('      ...transportPlugins(),\n', '');
    await ws.write('apps/orders/setu.config.ts', literal);
    await ws.fs.rm(`${ROOT}/apps/orders/src/transport/index.ts`);
    const manifest = JSON.parse(ws.read('setu.workspace.json'));
    const { broker: _broker, ...rest } = manifest;
    await ws.write(
      'setu.workspace.json',
      JSON.stringify({ ...rest, version: 1, transport: 'redis' }),
    );

    expect((await ws.run(['g', 'app', 'billing', '--template', 'rest'])).code).toBe(0);
    expect(JSON.parse(ws.read('setu.workspace.json')).version).toBe(2);
    // The old member gained its module, but its config still reads literals.
    expect(ws.read('apps/orders/src/transport/index.ts')).toContain('redis-streams');

    const refused = await ws.run(['workspace', 'broker', 'nats']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      "import { messagingOptions, queueOptions, transportPlugins } from './src/transport/index.ts';",
    );

    await ws.write(
      'apps/orders/setu.config.ts',
      ws
        .read('apps/orders/setu.config.ts')
        .replace(
          "import { MessagingPlugin } from '@setu-ts/messaging-plugin';",
          "import { MessagingPlugin } from '@setu-ts/messaging-plugin';\nimport { messagingOptions, queueOptions, transportPlugins } from './src/transport/index.ts';",
        )
        .replace(
          "MessagingPlugin({ broker: 'redis-streams', url: 'redis://127.0.0.1:6379' })",
          'MessagingPlugin(messagingOptions())',
        )
        .replace(
          'processors: [...QUEUE_PROCESSORS] }',
          'processors: [...QUEUE_PROCESSORS], ...queueOptions() }',
        )
        .replace(
          '      ...GENERATED_PLUGINS,',
          '      ...transportPlugins(),\n      ...GENERATED_PLUGINS,',
        ),
    );
    const switched = await ws.run(['workspace', 'broker', 'nats']);
    expect(switched.code, switched.err).toBe(0);
    expect(ws.read('apps/orders/src/transport/index.ts')).toContain("broker: 'nats'");
  });
});
