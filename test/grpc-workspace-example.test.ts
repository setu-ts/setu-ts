/**
 * The gRPC workspace example is a replica of the scaffold: `apps/grpc-workspace`
 * is what the CLI generates for a gRPC workspace, plus the gRPC feature. This
 * test regenerates the scaffold from source with the same commands and fails
 * when the example and the generator drift apart.
 *
 * Every difference is declared below, with its reason: a file the example
 * changes (`MAY_DIFFER`), a generated file it removes (`DELETED`), one it renames
 * (`RENAMED`), and one it adds (`ADDED`). An entry that no longer describes a
 * real difference fails too, so the lists cannot go stale. Both sides are
 * formatted with the Prettier configuration that governs the example's path
 * before they are compared, because the repository formats the example.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import * as prettier from 'prettier';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../scripts/lib/run.ts';

const ROOT = resolve(import.meta.dirname, '..');
const EXAMPLE = join(ROOT, 'apps/grpc-workspace');
const CLI = join(ROOT, 'packages/cli');
const SOURCE_REGISTER = join(ROOT, 'scripts/lib/source-register.ts');
const MEMBERS = ['apps/billing', 'apps/orders'] as const;

/** Files the example changes, keyed by path, with the reason. */
const MAY_DIFFER: Readonly<Record<string, string>> = {
  'README.md':
    'an example section on top of the generated README: what it shows and every difference',
  'package.json':
    'repository wiring: explicit start, smoke, a check and a test over every member, tsx for the apps gate; the npm-only test script is replaced',
  'apps/billing/package.json':
    'framework ranges become workspace:^, the contracts library is linked, check is tsc only, lint names lint.config.js, the per-member buf toolchain is removed',
  'apps/orders/package.json':
    'as billing, plus @connectrpc/connect and @connectrpc/connect-node: an http member ships no Connect client',
  'libs/contracts/package.json':
    'the library owns the contract: @bufbuild/protobuf, check, and proto:gen through a pinned npx buf',
  'apps/billing/tsconfig.json':
    'extends the repository tsconfig.apps.json, so @setu-ts/* resolves to source',
  'apps/orders/tsconfig.json':
    'extends the repository tsconfig.apps.json, so @setu-ts/* resolves to source',
  'apps/billing/setu.config.ts':
    'RuntimePlugin({ http2: true }): billing serves HTTP/2 beside HTTP/1.1, which orders calls over one connection',
  'apps/billing/main.ts':
    'the repository lint forbids console outside the CLI; one eslint-disable line',
  'apps/orders/main.ts':
    'the repository lint forbids console outside the CLI; one eslint-disable line',
  'apps/billing/src/plugins/billing.plugin.ts':
    'the generated plugin stub becomes BillingService.Quote, added through IGrpcService.addService',
  'apps/orders/src/controllers/orders.controller.ts':
    'GET lists and reads orders; POST /orders validates line items and quotes them through billing',
  'apps/orders/src/services/orders.service.ts':
    'creating an order calls billing and maps its errors to 400 and 503; describeOrders stays for the services barrel',
  'apps/orders/src/shared/schemas/orders.schemas.ts':
    'an order is a list of line items with a quoted total',
  'libs/contracts/src/index.ts': 're-exports the generated BillingService instead of the stub',
  'libs/contracts/README.md': 'shows the BillingService import and the pnpm workspace:* link',
  'libs/contracts/test/contracts.test.ts':
    'tests the re-exported service type name instead of the stub',
};

/** Generated files the example removes, with the reason. */
const DELETED: Readonly<Record<string, string>> = {
  'apps/billing/.env': 'gitignored; .env.example carries the values',
  'apps/orders/.env': 'gitignored; .env.example carries the values',
  'apps/billing/buf.yaml': 'the contract and its toolchain live in libs/contracts',
  'apps/billing/buf.gen.yaml': 'the contract and its toolchain live in libs/contracts',
  'apps/billing/proto/billing/v1/billing.proto':
    'the stub proto; the contract lives in libs/contracts',
  'apps/billing/proto/README.md': 'describes the per-member toolchain the example removes',
};

/** Generated files the example keeps under another name, unchanged. */
const RENAMED: Readonly<Record<string, string>> = {
  'apps/billing/lint.config.js': 'apps/billing/eslint.config.js',
  'apps/orders/lint.config.js': 'apps/orders/eslint.config.js',
};

/** Files only the example has: the gRPC feature, with the reason. */
const ADDED: Readonly<Record<string, string>> = {
  'smoke.ts': 'the cross-process smoke: both members, a real RPC, the 400 and 503 paths',
  'libs/contracts/tsconfig.json': 'the generated library has none; check type-checks it',
  'libs/contracts/buf.yaml': 'the buf module, moved from a member',
  'libs/contracts/buf.gen.yaml': 'the protoc-gen-es output, moved from a member',
  'libs/contracts/proto/billing/v1/billing.proto': 'the shared contract',
  'libs/contracts/src/gen/billing/v1/billing_pb.ts': 'protoc-gen-es output, committed',
  'apps/billing/test/billing.test.ts':
    'Quote over Connect: a priced SKU, and unknown ones including inherited object names',
  'apps/orders/src/clients/billing.client.ts': 'the Connect client for billing',
  'apps/orders/test/orders.test.ts': 'tests the orders service and routes against a fake billing',
  'apps/orders/test/e2e/orders.e2e.test.ts':
    'creates and reads an order against a fake billing server',
  'apps/orders/test/support/fake-billing.ts':
    'a fake billing server and client for the orders tests',
};

async function cli(args: readonly string[]): Promise<string> {
  const { code, stdout, stderr } = await run(
    process.execPath,
    ['--import', 'tsx', '--import', SOURCE_REGISTER, 'src/bin.ts', ...args],
    { cwd: CLI, capture: 'file', timeoutMs: 180_000 },
  );
  if (code !== 0) throw new Error(`setu ${args.join(' ')} exited ${code}: ${stderr}`);
  return stdout;
}

/** Every file under `directory`, relative, skipping installed and built output. */
async function files(directory: string): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.add(relative(directory, path));
    }
  };
  await walk(directory);
  return found;
}

/** The file's text, formatted with the Prettier configuration the example's path uses. */
async function formatted(text: string, examplePath: string): Promise<string> {
  const options = await prettier.resolveConfig(examplePath);
  try {
    return await prettier.format(text, { ...options, filepath: examplePath });
  } catch {
    // No parser for this file type: compare it as written.
    return text;
  }
}

async function same(examplePath: string, generatedPath: string): Promise<boolean> {
  const [example, generated] = await Promise.all([
    readFile(examplePath, 'utf8'),
    readFile(generatedPath, 'utf8'),
  ]);
  return (await formatted(example, examplePath)) === (await formatted(generated, examplePath));
}

describe('apps/grpc-workspace is the scaffold plus the gRPC feature', () => {
  let parent = '';
  let generated = '';
  let example: Set<string>;
  let scaffold: Set<string>;

  beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), 'setu-grpc-workspace-'));
    generated = join(parent, 'grpc-workspace');
    // The same commands the example's README records, in the same order:
    // billing first, so orders can record it with --depends-on. Only billing
    // is called over gRPC, so only billing takes --rpc grpc; orders stays http.
    await cli([
      'new',
      'grpc-workspace',
      '--workspace',
      '--runtime',
      'node',
      '--port',
      '3410',
      '--yes',
      '--dir',
      parent,
    ]);
    await cli(['generate', 'library', 'contracts', '--dir', generated]);
    await cli([
      'generate',
      'app',
      'billing',
      '--template',
      'microservice',
      '--rpc',
      'grpc',
      '--dir',
      generated,
    ]);
    await cli([
      'generate',
      'app',
      'orders',
      '--template',
      'microservice',
      '--depends-on',
      'billing',
      '--dir',
      generated,
    ]);
    // Both members have one feature, so both stay flat: billing serves it from a
    // generated plugin, orders from a controller, a service and a schema.
    await cli(['generate', 'plugin', 'billing', '--dir', join(generated, 'apps/billing')]);
    for (const artifact of ['controller', 'service', 'schema']) {
      await cli(['generate', artifact, 'orders', '--dir', join(generated, 'apps/orders')]);
    }
    // The example side is what git tracks, so a local gitignored file cannot fail the test.
    const tracked = await run('git', ['ls-files', '--', 'apps/grpc-workspace'], {
      cwd: ROOT,
      capture: 'file',
    });
    example = new Set(
      tracked.stdout
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => relative('apps/grpc-workspace', line)),
    );
    scaffold = await files(generated);
  }, 600_000);

  afterAll(async () => {
    if (parent !== '') await rm(parent, { recursive: true, force: true });
  });

  it('keeps every shared file identical, except the declared differences', async () => {
    const drifted: string[] = [];
    const stale: string[] = [];
    for (const path of example) {
      if (!scaffold.has(path)) continue;
      const identical = await same(join(EXAMPLE, path), join(generated, path));
      if (!identical && MAY_DIFFER[path] === undefined) drifted.push(path);
      if (identical && MAY_DIFFER[path] !== undefined) stale.push(path);
    }
    expect(drifted, 'files that differ from the generator without a MAY_DIFFER reason').toEqual([]);
    expect(stale, 'MAY_DIFFER entries that no longer differ').toEqual([]);
    for (const path of Object.keys(MAY_DIFFER)) {
      expect(example.has(path) && scaffold.has(path), `${path} exists on both sides`).toBe(true);
    }
  });

  it('removes only the declared generated files', () => {
    const missing = [...scaffold].filter(
      (path) => !example.has(path) && !Object.values(RENAMED).includes(path),
    );
    expect(missing.sort()).toEqual(Object.keys(DELETED).sort());
  });

  it('adds only the declared files', () => {
    const extra = [...example].filter((path) => !scaffold.has(path) && RENAMED[path] === undefined);
    expect(extra.sort()).toEqual(Object.keys(ADDED).sort());
  });

  it('keeps each renamed file unchanged', async () => {
    for (const [now, was] of Object.entries(RENAMED)) {
      expect(example.has(now) && scaffold.has(was), `${was} → ${now}`).toBe(true);
      expect(await same(join(EXAMPLE, now), join(generated, was)), `${was} → ${now}`).toBe(true);
    }
  });

  it.each(MEMBERS)('%s passes setu check and needs no setu sync', async (member) => {
    const directory = join(EXAMPLE, member);
    expect(await cli(['check', '--dir', directory])).toMatch(/\b0 error\(s\)/);
    const planned = (await cli(['sync', '--dry-run', '--dir', directory]))
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('unchanged '));
    expect(planned).toEqual([]);
  });
});
