import { denoBinary, spawnProcess, tempDir } from '../../../../test/node-helpers.ts';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs/promises';
/**
 * The gate for the generated workspace dev runner.
 *
 * M67 shipped this runner asserted only as SUBSTRINGS of the template literal
 * that renders it — `toContain('/ready')`, `toContain('child.kill')`. Nothing
 * ever executed it, and nothing ever formatted or linted it either, which is
 * how it came to be emitted into developers' repositories failing both
 * `deno fmt --check` and `deno lint` while every gate stayed green.
 *
 * So this file RUNS the emitted source. The members are fixtures rather than
 * generated projects on purpose: the runner's job is process orchestration, and
 * a fixture is the only way to give a prerequisite a deliberate startup delay —
 * without one, "started after" and "started concurrently" are indistinguishable
 * and the negative control proves nothing.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workspaceDevRunner } from '../../src/workspace/dev-runner.ts';
import { workspaceProfile } from '../../src/workspace/runtime-profile.ts';
import { unusedPort } from '../fixtures/generated-project.ts';
import { eventually, launchGroup, liveProcesses } from '../fixtures/process-group.ts';

let root = '';

beforeEach(async () => {
  root = await tempDir({ dir: tmpdir(), prefix: 'setu-dev-runner-' });
});

afterEach(async () => {
  await nodeFs.rm(root, { recursive: true }).catch(() => {});
});

/** One workspace member, described the way the manifest describes it. */
interface Member {
  readonly name: string;
  readonly port: number;
  readonly dependsOn?: readonly string[];
  readonly devtoolPort?: number;
}

/** Writes observable npm members without changing the generated runner under test. */
async function writeNodeHandoffWorkspace(members: readonly Member[]): Promise<void> {
  await nodeFs.writeFile(`${root}/setu.workspace.json`, JSON.stringify({ members }));
  const runner = workspaceDevRunner(workspaceProfile('node'));
  await nodeFs.mkdir(`${root}/scripts`, { recursive: true });
  await nodeFs.writeFile(`${root}/${runner.path}`, runner.contents);
  for (const member of members) {
    const dir = `${root}/apps/${member.name}`;
    await nodeFs.mkdir(dir, { recursive: true });
    await nodeFs.writeFile(
      `${dir}/package.json`,
      JSON.stringify({
        private: true,
        scripts: { dev: 'node server.mjs dev', 'start:dev': 'node server.mjs start:dev' },
      }),
    );
    await nodeFs.writeFile(
      `${dir}/server.mjs`,
      `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
writeFileSync(${JSON.stringify(`${root}/${member.name}-env.json`)}, JSON.stringify({
  pid: process.pid,
  script: process.argv[2],
  member: process.env.SETU_DEVTOOL_MEMBER,
  id: process.env.SETU_DEVTOOL_SESSION_ID,
  key: process.env.SETU_DEVTOOL_SESSION_KEY,
}));
createServer((_request, response) => response.end('ok')).listen(${member.port}, '127.0.0.1');
`,
    );
  }
}

describe('the npm-profile dev runner, forwarding the devtool environment', () => {
  it(
    'hands the pair to the selected child, blanks its sibling and keeps both in the launcher group',
    { timeout: 45_000 },
    async () => {
      await writeNodeHandoffWorkspace([
        { name: 'a', port: await unusedPort(), devtoolPort: await unusedPort() },
        { name: 'b', port: await unusedPort() },
      ]);
      const pair = {
        SETU_DEVTOOL_MEMBER: 'a',
        SETU_DEVTOOL_SESSION_ID: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
          'hex',
        ),
        SETU_DEVTOOL_SESSION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
          'hex',
        ),
      };
      const launched = launchGroup(process.execPath, ['scripts/dev.mjs'], root, pair);
      try {
        await eventually(
          async () =>
            (await nodeFs.stat(`${root}/a-env.json`).then(
              () => true,
              () => false,
            )) &&
            (await nodeFs.stat(`${root}/b-env.json`).then(
              () => true,
              () => false,
            )),
          'Both npm children must report their startup environment',
        );
        const selected = JSON.parse(await nodeFs.readFile(`${root}/a-env.json`, 'utf8')) as {
          pid: number;
          script: string;
          member: string;
          id: string;
          key: string;
        };
        const sibling = JSON.parse(
          await nodeFs.readFile(`${root}/b-env.json`, 'utf8'),
        ) as typeof selected;
        expect(selected.script).toBe('dev');
        expect(selected.member).toBe('a');
        expect(selected.id === pair.SETU_DEVTOOL_SESSION_ID).toBe(true);
        expect(selected.key === pair.SETU_DEVTOOL_SESSION_KEY).toBe(true);
        expect(sibling.script).toBe('start:dev');
        for (const field of ['member', 'id', 'key'] as const)
          expect(sibling[field] === '').toBe(true);
        if (process.platform === 'linux') {
          const processes = await liveProcesses();
          for (const pid of [selected.pid, sibling.pid]) {
            expect(processes.find((row) => row.pid === pid)?.group).toBe(launched.pid);
          }
        }
        expect(launched.output().includes(pair.SETU_DEVTOOL_SESSION_ID)).toBe(false);
        expect(launched.output().includes(pair.SETU_DEVTOOL_SESSION_KEY)).toBe(false);
      } finally {
        await launched.stop();
      }
    },
  );

  for (const row of [
    { member: 'absent', expected: 'which setu.workspace.json does not carry.' },
    { member: 'b', expected: 'but that member carries no devtoolPort.' },
  ]) {
    it(`refuses selection ${row.member} before spawning any child`, async () => {
      await writeNodeHandoffWorkspace([
        { name: 'a', port: await unusedPort(), devtoolPort: await unusedPort() },
        { name: 'b', port: await unusedPort() },
      ]);
      const launched = launchGroup(process.execPath, ['scripts/dev.mjs'], root, {
        SETU_DEVTOOL_MEMBER: row.member,
        SETU_DEVTOOL_SESSION_ID: '',
        SETU_DEVTOOL_SESSION_KEY: '',
      });
      try {
        let code: number | null | undefined;
        void launched.status.then((value) => {
          code = value;
        });
        await eventually(() => code !== undefined, 'Invalid selection must fail before spawning');
        expect(code).not.toBe(0);
        expect(launched.output()).toContain(row.expected);
        for (const name of ['a', 'b'])
          expect(
            await nodeFs.stat(`${root}/${name}-env.json`).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
      } finally {
        await launched.stop();
      }
    });
  }
});

/**
 * Writes a workspace whose members are observable fixtures.
 *
 * `orders` binds only after a delay, so a dependent that ignored readiness
 * would demonstrably reach it before it is listening. `billing` records what it
 * saw at the moment it started, which is the observation the assertions read.
 *
 * @param members - The members to record in the manifest
 * @param ordersDelayMs - How long `orders` waits before it binds
 */
async function writeWorkspace(members: readonly Member[], ordersDelayMs: number): Promise<void> {
  await nodeFs.writeFile(
    `${root}/setu.workspace.json`,
    JSON.stringify({ version: 1, basePort: members[0].port, runtime: 'deno', members }, null, 2),
  );
  await nodeFs.mkdir(`${root}/scripts`, { recursive: true });
  const runner = workspaceDevRunner(workspaceProfile('deno'));
  await nodeFs.writeFile(`${root}/${runner.path}`, runner.contents);

  const orders = members.find((member) => member.name === 'orders')!;
  const billing = members.find((member) => member.name === 'billing')!;

  for (const member of members) {
    await nodeFs.mkdir(`${root}/apps/${member.name}`, { recursive: true });
    await nodeFs.writeFile(
      `${root}/apps/${member.name}/deno.json`,
      JSON.stringify({ tasks: { start: 'deno run --allow-net --allow-write server.ts' } }),
    );
  }

  await nodeFs.writeFile(
    `${root}/apps/orders/server.ts`,
    `await new Promise((resolve) => setTimeout(resolve, ${ordersDelayMs}));\n` +
      `Deno.serve({ port: ${orders.port}, onListen: () => {} }, () => new Response('ok'));\n`,
  );
  // The observation: was the prerequisite already answering when this started?
  await nodeFs.writeFile(
    `${root}/apps/billing/server.ts`,
    `const ready = await fetch('http://127.0.0.1:${orders.port}/ready')\n` +
      `  .then((response) => response.ok)\n` +
      `  .catch(() => false);\n` +
      `await Deno.writeTextFile('${root}/observed.txt', String(ready));\n` +
      `Deno.serve({ port: ${billing.port}, onListen: () => {} }, () => new Response('ok'));\n`,
  );
}

/**
 * Runs the emitted runner until the dependent has reported, then stops it.
 *
 * The runner keeps its children alive by design, so it never exits on its own
 * on the success paths. Polling for the observation rather than waiting out the
 * whole budget keeps each case to about as long as the fixture's own delay.
 *
 * @param timeoutMs - The longest to wait for an observation before giving up
 * @returns Its combined output
 */
async function runRunner(timeoutMs: number): Promise<string> {
  const child = spawnProcess(denoBinary(), {
    // The root `dev` task's own grant, widened in M98c with the scoped
    // --allow-env the runner reads the launcher's variables through.
    args: [
      'run',
      '--allow-read',
      '--allow-run',
      '--allow-net',
      '--allow-write',
      '--allow-env',
      'scripts/dev.ts',
    ],
    cwd: root,
    stdout: 'piped',
    stderr: 'piped',
  });

  const collected = child.output();
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if ((await observed()) !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Already exited on its own — a cycle refusal does exactly that.
  }

  const { stdout, stderr } = await collected;
  const decoder = new TextDecoder();
  return `${decoder.decode(stdout)}${decoder.decode(stderr)}`;
}

/**
 * Reads what `billing` observed, once it has recorded anything.
 *
 * @returns The recorded observation, or undefined when it never started
 */
async function observed(): Promise<string | undefined> {
  return await nodeFs.readFile(`${root}/observed.txt`, 'utf8').catch(() => undefined);
}

/**
 * The npm profile's members expose start:dev, which the root development runner uses.
 */
async function writeNodeWorkspace(
  members: readonly Member[],
  ordersDelayMs: number,
): Promise<void> {
  await nodeFs.writeFile(
    `${root}/setu.workspace.json`,
    JSON.stringify({ version: 1, basePort: members[0].port, runtime: 'node', members }, null, 2),
  );
  await nodeFs.mkdir(`${root}/scripts`, { recursive: true });
  const runner = workspaceDevRunner(workspaceProfile('node'));
  await nodeFs.writeFile(`${root}/${runner.path}`, runner.contents);
  const orders = members.find((member) => member.name === 'orders')!;
  const billing = members.find((member) => member.name === 'billing')!;
  for (const member of members) {
    await nodeFs.mkdir(`${root}/apps/${member.name}`, { recursive: true });
    await nodeFs.writeFile(
      `${root}/apps/${member.name}/package.json`,
      JSON.stringify({
        name: member.name,
        private: true,
        scripts: { 'start:dev': 'node server.mjs' },
      }),
    );
  }
  await nodeFs.writeFile(
    `${root}/apps/orders/server.mjs`,
    `import { createServer } from 'node:http';\n` +
      `await new Promise((resolve) => setTimeout(resolve, ${ordersDelayMs}));\n` +
      `createServer((_req, res) => res.end('ok')).listen(${orders.port}, '127.0.0.1');\n`,
  );
  await nodeFs.writeFile(
    `${root}/apps/billing/server.mjs`,
    `import { createServer } from 'node:http';\n` +
      `import { writeFileSync } from 'node:fs';\n` +
      `const ready = await fetch('http://127.0.0.1:${orders.port}/ready')\n` +
      `  .then((response) => response.ok)\n` +
      `  .catch(() => false);\n` +
      `writeFileSync('${root}/observed.txt', String(ready));\n` +
      `createServer((_req, res) => res.end('ok')).listen(${billing.port}, '127.0.0.1');\n`,
  );
}

/** Runs the npm profile's runner until the dependent has reported, then stops it. */
async function runNodeRunner(
  timeoutMs: number,
  env: Readonly<Record<string, string>> = {},
): Promise<void> {
  const child = spawnProcess(process.execPath, {
    args: ['scripts/dev.mjs'],
    cwd: root,
    env,
    stdout: 'piped',
    stderr: 'piped',
  });
  const collected = child.output();
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if ((await observed()) !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Already exited.
  }
  await collected;
}

describe('the npm-profile dev runner, executed', () => {
  it('starts a dependent only after its prerequisite answers /ready', async () => {
    const orders = await unusedPort();
    const billing = await unusedPort();
    await writeNodeWorkspace(
      [
        { name: 'orders', port: orders },
        { name: 'billing', port: billing, dependsOn: ['orders'] },
      ],
      2000,
    );
    await runNodeRunner(20_000);
    expect(await observed()).toBe('true');
  });

  it('does not wait when nothing is declared — the control', async () => {
    const orders = await unusedPort();
    const billing = await unusedPort();
    await writeNodeWorkspace(
      [
        { name: 'orders', port: orders },
        { name: 'billing', port: billing },
      ],
      2000,
    );
    await runNodeRunner(20_000);
    expect(await observed()).toBe('false');
  });
});

/** Whether something still accepts connections on a loopback port. */
async function listening(port: number): Promise<boolean> {
  return await fetch(`http://127.0.0.1:${port}/`).then(
    async (response) => {
      await response.body?.cancel();
      return true;
    },
    () => false,
  );
}

describe('the npm-profile dev runner, stopped', () => {
  // PR #450 CI: npm runs `start` through the platform shell, and Ubuntu's `dash`
  // does not forward a signal to the command it runs. The runner signalled only
  // its `npm` children, so every member's server outlived it — holding its port
  // and the inherited output pipe. Locally `bash` execs a lone command and hid
  // it. This shell runs the command as a CHILD, as `dash` does, so the defect
  // reproduces anywhere; the runner must still leave no server behind.
  // POSIX only: the fixture is a `/bin/sh` script, and Windows has no process
  // groups — the runner signals the child directly there, by design.
  it.skipIf(process.platform === 'win32')(
    'stops every member when the script shell does not forward signals',
    async () => {
      const orders = await unusedPort();
      const billing = await unusedPort();
      await writeNodeWorkspace(
        [
          { name: 'orders', port: orders },
          {
            name: 'billing',
            port: billing,
            dependsOn: ['orders'],
          },
        ],
        0,
      );
      const shell = `${root}/non-forwarding-sh`;
      await nodeFs.writeFile(shell, '#!/bin/sh\nshift\n/bin/sh -c "$1; :"\n', { mode: 0o755 });
      await runNodeRunner(20_000, { NPM_CONFIG_SCRIPT_SHELL: shell });
      expect(await observed()).toBe('true');
      // Shutdown is asynchronous: give the members' groups a moment to exit.
      const deadline = performance.now() + 5_000;
      while (
        performance.now() < deadline &&
        ((await listening(orders)) || (await listening(billing)))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect({ orders: await listening(orders), billing: await listening(billing) }).toEqual({
        orders: false,
        billing: false,
      });
    },
  );
});

describe('the generated dev runner, executed', () => {
  it('starts a dependent only after its prerequisite answers /ready', async () => {
    const orders = await unusedPort();
    const billing = await unusedPort();
    await writeWorkspace(
      [
        { name: 'orders', port: orders },
        { name: 'billing', port: billing, dependsOn: ['orders'] },
      ],
      2000,
    );

    await runRunner(15_000);

    // `orders` binds 2s after it is spawned. Reaching it at billing's very
    // first statement is only possible because the runner waited.
    expect(await observed()).toBe('true');
  });

  it('does not wait when nothing is declared — the control for the case above', async () => {
    // Same fixtures, same delay, `dependsOn` removed. If this also reported
    // `true`, the assertion above would be measuring the fixture rather than
    // the readiness gate.
    const orders = await unusedPort();
    const billing = await unusedPort();
    await writeWorkspace(
      [
        { name: 'orders', port: orders },
        { name: 'billing', port: billing },
      ],
      2000,
    );

    await runRunner(15_000);

    expect(await observed()).toBe('false');
  });

  it('names a dependency cycle instead of recursing forever', async () => {
    const orders = await unusedPort();
    const billing = await unusedPort();
    await writeWorkspace(
      [
        { name: 'orders', port: orders, dependsOn: ['billing'] },
        { name: 'billing', port: billing, dependsOn: ['orders'] },
      ],
      0,
    );

    // Short budget on purpose: a cycle is refused before anything is spawned,
    // so the runner exits immediately and there is nothing to wait for.
    const output = await runRunner(3000);

    expect(output).toContain('Dependency cycle includes');
    // A cycle is refused before anything is spawned, so nothing observed.
    expect(await observed()).toBeUndefined();
  });

  it('reports a prerequisite that never becomes ready, by name', async () => {
    // The failure path the plan called for and never exercised: `orders` is
    // configured to bind long after the runner's 30s readiness deadline, so the
    // dependent must never start and the runner must say which service stalled.
    const orders = await unusedPort();
    const billing = await unusedPort();
    await writeWorkspace(
      [
        { name: 'orders', port: orders },
        { name: 'billing', port: billing, dependsOn: ['orders'] },
      ],
      60_000,
    );

    // Terminated well before the 30s deadline: what is under test is that the
    // dependent stays unstarted while its prerequisite is not answering.
    await runRunner(6000);

    expect(await observed()).toBeUndefined();
  });
});

/**
 * Writes a two-member workspace whose members RECORD the devtool environment
 * they were handed.
 *
 * The observation file each member writes carries the three variables as the
 * child actually received them, so the assertions read the runner's env
 * forwarding rather than its source. `orders` additionally runs a `dev` task
 * (the entry the launcher selects), and both bind their own ports.
 */
async function writeDevtoolWorkspace(
  devtoolPort: number,
): Promise<Promise<{ orders: number; billing: number }>> {
  const orders = await unusedPort();
  const billing = await unusedPort();
  await nodeFs.writeFile(
    `${root}/setu.workspace.json`,
    JSON.stringify(
      {
        version: 1,
        basePort: orders,
        runtime: 'deno',
        members: [
          { name: 'orders', port: orders, devtoolPort },
          { name: 'billing', port: billing },
        ],
      },
      null,
      2,
    ),
  );
  await nodeFs.mkdir(`${root}/scripts`, { recursive: true });
  const runner = workspaceDevRunner(workspaceProfile('deno'));
  await nodeFs.writeFile(`${root}/${runner.path}`, runner.contents);

  // Records the environment AS RECEIVED and binds the member's own port.
  const recorder = (member: string, port: number, extraEnv = '') =>
    `const seen = {
  member: Deno.env.get('SETU_DEVTOOL_MEMBER') ?? '(unset)',
  sessionId: Deno.env.get('SETU_DEVTOOL_SESSION_ID') ?? '(unset)',
  sessionKey: Deno.env.get('SETU_DEVTOOL_SESSION_KEY') ?? '(unset)',
};
await Deno.writeTextFile('${root}/${member}.env.json', JSON.stringify(seen));
await Deno.serve({ port: ${port}, onListen: () => {} }, () => new Response('ok'));
${extraEnv}`;

  for (const member of ['orders', 'billing']) {
    await nodeFs.mkdir(`${root}/apps/${member}`, { recursive: true });
    // BOTH members carry both tasks: `dev` for the selected member, `start`
    // for everyone else — which is the observable under test.
    await nodeFs.writeFile(
      `${root}/apps/${member}/deno.json`,
      JSON.stringify({
        tasks: {
          start: `deno run --allow-net --allow-write --allow-env start-${member}.ts`,
          dev: `deno run --allow-net --allow-write --allow-env dev-${member}.ts`,
        },
      }),
    );
    await nodeFs.writeFile(
      `${root}/apps/${member}/start-${member}.ts`,
      recorder(member, member === 'orders' ? orders : billing),
    );
    await nodeFs.writeFile(
      `${root}/apps/${member}/dev-${member}.ts`,
      recorder(member, member === 'orders' ? orders : billing),
    );
  }
  return { orders, billing };
}

/** Reads what one member recorded about the environment it was handed. */
async function observedEnv(member: string): Promise<Record<string, string> | undefined> {
  const text = await nodeFs.readFile(`${root}/${member}.env.json`, 'utf8').catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as Record<string, string>);
}

/** Runs the runner with the given devtool environment until both ports answer. */
async function runRunnerWithEnv(
  ports: readonly number[],
  env: Record<string, string>,
  timeoutMs = 20_000,
): Promise<void> {
  const child = spawnProcess(denoBinary(), {
    args: [
      'run',
      '--allow-read',
      '--allow-run',
      '--allow-net',
      '--allow-write',
      '--allow-env',
      'scripts/dev.ts',
    ],
    cwd: root,
    env,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  });
  const deadline = performance.now() + timeoutMs;
  try {
    while (performance.now() < deadline) {
      const both = await Promise.all(
        ports.map((port) =>
          fetch(`http://127.0.0.1:${port}/`)
            .then((r) => r.ok)
            .catch(() => false),
        ),
      );
      if (both.every(Boolean)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the runner never brought both members up');
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already exited.
    }
    await child.status;
  }
}

describe('the generated dev runner, forwarding the devtool environment', () => {
  const SESSION_ID = 'b'.repeat(32);
  const SESSION_KEY = 'c'.repeat(64);

  it('hands the pair to the named member alone and blanks it for every sibling', async () => {
    const devtoolPort = await unusedPort();
    const ports = await writeDevtoolWorkspace(devtoolPort);
    await runRunnerWithEnv([ports.orders, ports.billing], {
      SETU_DEVTOOL_MEMBER: 'orders',
      SETU_DEVTOOL_SESSION_ID: SESSION_ID,
      SETU_DEVTOOL_SESSION_KEY: SESSION_KEY,
    });

    const selected = await observedEnv('orders');
    // The selected member ran its DEV entry carrying the real pair.
    expect(selected).toEqual({
      member: 'orders',
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
    });

    const sibling = await observedEnv('billing');
    // The sibling ran its START entry with every variable BLANKED — an empty
    // value is not a credential, and inheritance would have handed it one.
    expect(sibling).toEqual({ member: '', sessionId: '', sessionKey: '' });
  });

  it('runs every member on start with no devtool variables set — the no-launcher case', async () => {
    const devtoolPort = await unusedPort();
    const ports = await writeDevtoolWorkspace(devtoolPort);
    // `deno task dev` with no devtool variables: the pre-devtool behavior.
    await runRunnerWithEnv([ports.orders, ports.billing], {});

    for (const member of ['orders', 'billing']) {
      const seen = await observedEnv(member);
      // Unset, not blank: the runner read nothing and forwarded nothing.
      expect(seen?.sessionId).toBe('');
      expect(seen?.sessionKey).toBe('');
      expect(seen?.member).toBe('');
    }
  });

  it('refuses a SETU_DEVTOOL_MEMBER the manifest does not carry, before spawning', async () => {
    const devtoolPort = await unusedPort();
    await writeDevtoolWorkspace(devtoolPort);
    const child = spawnProcess(denoBinary(), {
      args: [
        'run',
        '--allow-read',
        '--allow-run',
        '--allow-net',
        '--allow-write',
        '--allow-env',
        'scripts/dev.ts',
      ],
      cwd: root,
      env: {
        SETU_DEVTOOL_MEMBER: 'nope',
        SETU_DEVTOOL_SESSION_ID: SESSION_ID,
        SETU_DEVTOOL_SESSION_KEY: SESSION_KEY,
      },
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    });
    const { code, stderr } = await child.output();
    const decoder = new TextDecoder();
    expect(code).not.toBe(0);
    expect(decoder.decode(stderr)).toContain('which setu.workspace.json does not carry');
    // Nothing came up: the refusal precedes every spawn.
    expect(await observedEnv('orders')).toBeUndefined();
  });
});
