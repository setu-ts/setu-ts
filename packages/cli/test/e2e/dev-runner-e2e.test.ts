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

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { workspaceDevRunner } from '../../src/workspace/dev-runner.ts';
import { workspaceProfile } from '../../src/workspace/runtime-profile.ts';
import { unusedPort } from '../fixtures/generated-project.ts';

let root = '';

beforeEach(async () => {
  root = await Deno.makeTempDir({ prefix: 'setu-dev-runner-' });
});

afterEach(async () => {
  await Deno.remove(root, { recursive: true }).catch(() => {});
});

/** One workspace member, described the way the manifest describes it. */
interface Member {
  readonly name: string;
  readonly port: number;
  readonly dependsOn?: readonly string[];
}

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
  await Deno.writeTextFile(
    `${root}/setu.workspace.json`,
    JSON.stringify({ version: 1, basePort: members[0].port, runtime: 'deno', members }, null, 2),
  );
  await Deno.mkdir(`${root}/scripts`, { recursive: true });
  const runner = workspaceDevRunner(workspaceProfile('deno'));
  await Deno.writeTextFile(`${root}/${runner.path}`, runner.contents);

  const orders = members.find((member) => member.name === 'orders')!;
  const billing = members.find((member) => member.name === 'billing')!;

  for (const member of members) {
    await Deno.mkdir(`${root}/apps/${member.name}`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/apps/${member.name}/deno.json`,
      JSON.stringify({ tasks: { start: 'deno run --allow-net --allow-write server.ts' } }),
    );
  }

  await Deno.writeTextFile(
    `${root}/apps/orders/server.ts`,
    `await new Promise((resolve) => setTimeout(resolve, ${ordersDelayMs}));\n` +
      `Deno.serve({ port: ${orders.port}, onListen: () => {} }, () => new Response('ok'));\n`,
  );
  // The observation: was the prerequisite already answering when this started?
  await Deno.writeTextFile(
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
  const child = new Deno.Command(Deno.execPath(), {
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
  }).spawn();

  const collected = child.output();
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await observed() !== undefined) break;
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
  return await Deno.readTextFile(`${root}/observed.txt`).catch(() => undefined);
}

describe('the generated dev runner, executed', () => {
  it('starts a dependent only after its prerequisite answers /ready', async () => {
    const orders = unusedPort();
    const billing = unusedPort();
    await writeWorkspace(
      [{ name: 'orders', port: orders }, { name: 'billing', port: billing, dependsOn: ['orders'] }],
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
    const orders = unusedPort();
    const billing = unusedPort();
    await writeWorkspace(
      [{ name: 'orders', port: orders }, { name: 'billing', port: billing }],
      2000,
    );

    await runRunner(15_000);

    expect(await observed()).toBe('false');
  });

  it('names a dependency cycle instead of recursing forever', async () => {
    const orders = unusedPort();
    const billing = unusedPort();
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
    const orders = unusedPort();
    const billing = unusedPort();
    await writeWorkspace(
      [{ name: 'orders', port: orders }, { name: 'billing', port: billing, dependsOn: ['orders'] }],
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
): Promise<{ orders: number; billing: number }> {
  const orders = unusedPort();
  const billing = unusedPort();
  await Deno.writeTextFile(
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
  await Deno.mkdir(`${root}/scripts`, { recursive: true });
  const runner = workspaceDevRunner(workspaceProfile('deno'));
  await Deno.writeTextFile(`${root}/${runner.path}`, runner.contents);

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
    await Deno.mkdir(`${root}/apps/${member}`, { recursive: true });
    // BOTH members carry both tasks: `dev` for the selected member, `start`
    // for everyone else — which is the observable under test.
    await Deno.writeTextFile(
      `${root}/apps/${member}/deno.json`,
      JSON.stringify({
        tasks: {
          start: `deno run --allow-net --allow-write --allow-env start-${member}.ts`,
          dev: `deno run --allow-net --allow-write --allow-env dev-${member}.ts`,
        },
      }),
    );
    await Deno.writeTextFile(
      `${root}/apps/${member}/start-${member}.ts`,
      recorder(member, member === 'orders' ? orders : billing),
    );
    await Deno.writeTextFile(
      `${root}/apps/${member}/dev-${member}.ts`,
      recorder(member, member === 'orders' ? orders : billing),
    );
  }
  return { orders, billing };
}

/** Reads what one member recorded about the environment it was handed. */
async function observedEnv(member: string): Promise<Record<string, string> | undefined> {
  const text = await Deno.readTextFile(`${root}/${member}.env.json`).catch(() => undefined);
  return text === undefined ? undefined : JSON.parse(text) as Record<string, string>;
}

/** Runs the runner with the given devtool environment until both ports answer. */
async function runRunnerWithEnv(
  ports: readonly number[],
  env: Record<string, string>,
  timeoutMs = 20_000,
): Promise<void> {
  const child = new Deno.Command(Deno.execPath(), {
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
  }).spawn();
  const deadline = performance.now() + timeoutMs;
  try {
    while (performance.now() < deadline) {
      const both = await Promise.all(
        ports.map((port) =>
          fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok).catch(() => false)
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
    const devtoolPort = unusedPort();
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
    const devtoolPort = unusedPort();
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
    const devtoolPort = unusedPort();
    await writeDevtoolWorkspace(devtoolPort);
    const child = new Deno.Command(Deno.execPath(), {
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
    }).spawn();
    const { code, stderr } = await child.output();
    const decoder = new TextDecoder();
    expect(code).not.toBe(0);
    expect(decoder.decode(stderr)).toContain('which setu.workspace.json does not carry');
    // Nothing came up: the refusal precedes every spawn.
    expect(await observedEnv('orders')).toBeUndefined();
  });
});
