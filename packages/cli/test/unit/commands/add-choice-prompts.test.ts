/**
 * Tests for the terminal prompt `setu add` shows for every option that selects one
 * of several values, driven by the `ADD_CHOICES` table.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { createFakeFs } from '../../fixtures/fake-fs.ts';
import { ADD_CHOICES } from '../../../src/commands/add.ts';
import { runCli } from '../../../src/cli.ts';
import { EXIT_INTERRUPTED } from '../../../src/constants.ts';
import type { PromptChoice, PromptSelection } from '../../../src/prompt.ts';
import type { IFileSystem } from '@setu-ts/common';

/** A recorded question: the text and the values offered, in order. */
interface Asked {
  readonly question: string;
  readonly values: readonly string[];
}

/** A prompter that records every question and answers from `answer`. */
function recorder(answer: (asked: Asked) => PromptSelection = () => ({ kind: 'unavailable' })): {
  readonly asked: Asked[];
  readonly ask: {
    select: (question: string, choices: readonly PromptChoice[]) => Promise<PromptSelection>;
  };
} {
  const asked: Asked[] = [];
  return {
    asked,
    ask: {
      select: (question, choices) => {
        const entry = { question, values: choices.map((choice) => choice.value) };
        asked.push(entry);
        return Promise.resolve(answer(entry));
      },
    },
  };
}

function deps(fs: IFileSystem, ask?: ReturnType<typeof recorder>['ask'], cwd = '/app') {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      fs,
      cwd,
      now: () => 0,
      log: (line: string) => out.push(line),
      error: (line: string) => err.push(line),
      ...(ask === undefined ? {} : { ask }),
    },
  };
}

/** The CLI name of a package (`cache-plugin` → `cache`). */
const short = (pkg: string): string => pkg.replace(/-plugin$/, '');

describe('setu add choice prompts', () => {
  // Every row of the table, as data: each standalone choice is asked for its first
  // package, with exactly the values the table lists, default first.
  for (const choice of ADD_CHOICES.filter((entry) => entry.after === undefined)) {
    it(`asks --${choice.flag} for ${short(choice.packages[0]!)} with every accepted value`, async () => {
      const fs = createFakeFs({ '/app/package.json': '{}' });
      const prompt = recorder();
      const run = deps(fs, prompt.ask);
      expect(await runCli(['add', short(choice.packages[0]!)], run.deps), run.err.join('\n')).toBe(
        0,
      );
      expect(prompt.asked).toContainEqual({
        question: `Choose the ${choice.flag} for ${choice.packages[0]}`,
        values: choice.values(),
      });
      expect(choice.values().length).toBeGreaterThan(1);
    });
  }

  it('lists memory (or log) first, so Enter keeps the documented default', () => {
    for (const choice of ADD_CHOICES) {
      const first = choice.values()[0];
      expect(['memory', 'log', 'postgresql']).toContain(first);
    }
  });

  it('passes the answer on: --store redis wires the Redis cache store', async () => {
    const fs = createFakeFs({ '/app/package.json': '{}' });
    const prompt = recorder(({ values }) => ({ kind: 'answer', value: values.at(-1)! }));
    const run = deps(fs, prompt.ask);
    expect(await runCli(['add', 'cache'], run.deps), run.err.join('\n')).toBe(0);
    expect(prompt.asked.map((entry) => entry.question)).toEqual([
      'Choose the store for cache-plugin',
    ]);
    expect(fs.read('/app/package.json')).toContain('ioredis');
  });

  it('asks --dialect only after --type drizzle is chosen', async () => {
    for (const [type, expected] of [
      ['drizzle', ['type', 'dialect']],
      ['memory', ['type']],
    ] as const) {
      const fs = createFakeFs({ '/app/package.json': '{}' });
      const prompt = recorder(({ question, values }) =>
        question.startsWith('Choose the type')
          ? { kind: 'answer', value: type }
          : { kind: 'answer', value: values.at(-1)! },
      );
      const run = deps(fs, prompt.ask);
      expect(await runCli(['add', 'database'], run.deps), run.err.join('\n')).toBe(0);
      expect(prompt.asked.map((entry) => entry.question.split(' ')[2])).toEqual(expected);
      // The answer reaches the command: the chosen dialect's driver is in the install line.
      if (type === 'drizzle') expect(run.out.join('\n')).toContain('@libsql/client');
    }
  });

  it('asks a shared flag once for every package that takes it', async () => {
    const fs = createFakeFs({ '/app/package.json': '{}' });
    const prompt = recorder();
    const run = deps(fs, prompt.ask);
    expect(await runCli(['add', 'cache', 'idempotency'], run.deps), run.err.join('\n')).toBe(0);
    expect(prompt.asked.map((entry) => entry.question)).toEqual([
      'Choose the store for cache-plugin and idempotency-plugin',
    ]);
  });

  it('does not ask for a flag already given, and asks nothing with --yes or -y', async () => {
    const given = recorder();
    const run = deps(createFakeFs({ '/app/package.json': '{}' }), given.ask);
    expect(await runCli(['add', 'messaging', '--broker', 'memory'], run.deps)).toBe(0);
    expect(given.asked).toEqual([]);
    for (const yes of ['--yes', '-y']) {
      const prompt = recorder();
      const quiet = deps(createFakeFs({ '/app/package.json': '{}' }), prompt.ask);
      expect(await runCli(['add', 'messaging', 'mail', 'database', yes], quiet.deps)).toBe(0);
      expect(prompt.asked).toEqual([]);
    }
  });

  it('keeps the default when the prompter has no terminal answer', async () => {
    const fs = createFakeFs({ '/app/package.json': '{}' });
    const prompt = recorder(() => ({ kind: 'unavailable' }));
    const run = deps(fs, prompt.ask);
    expect(await runCli(['add', 'mail'], run.deps)).toBe(0);
    expect(prompt.asked).toHaveLength(1);
    expect(fs.read('/app/package.json')).not.toContain('nodemailer');
  });

  it('stops with the interrupted code and writes nothing when a question is cancelled', async () => {
    const fs = createFakeFs({ '/app/package.json': '{}' });
    const prompt = recorder(() => ({ kind: 'cancelled' }));
    const run = deps(fs, prompt.ask);
    expect(await runCli(['add', 'queue'], run.deps)).toBe(EXIT_INTERRUPTED);
    expect(fs.read('/app/package.json')).toBe('{}');
  });

  it('does not ask a Workers project for a transport backend, but still asks mail', async () => {
    const fs = createFakeFs({ '/app/package.json': '{}', '/app/wrangler.toml': '' });
    const prompt = recorder();
    const run = deps(fs, prompt.ask);
    expect(await runCli(['add', 'cache', 'mail'], run.deps), run.err.join('\n')).toBe(0);
    expect(prompt.asked.map((entry) => entry.question)).toEqual([
      'Choose the provider for mail-plugin',
    ]);
  });

  it('does not ask a workspace member for a transport backend', async () => {
    const fs = createFakeFs();
    const setup = deps(fs);
    expect(await runCli(['new', 'ws', '--workspace'], setup.deps)).toBe(0);
    expect(
      await runCli(['g', 'app', 'api', '--template', 'rest'], { ...setup.deps, cwd: '/app/ws' }),
    ).toBe(0);
    const prompt = recorder();
    const member = deps(fs, prompt.ask, '/app/ws/apps/api');
    expect(await runCli(['add', 'realtime-backplane'], member.deps), member.err.join('\n')).toBe(0);
    expect(prompt.asked).toEqual([]);
  });

  it('asks nothing when the runtime marker cannot be read', async () => {
    const base = createFakeFs({ '/app/package.json': '{}' });
    const fs: IFileSystem = {
      ...base,
      stat: (path: string) =>
        path === '/app/deno.json'
          ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
          : base.stat(path),
    };
    const prompt = recorder();
    const run = deps(fs, prompt.ask);
    expect(await runCli(['add', 'messaging', 'mail'], run.deps)).not.toBe(0);
    expect(prompt.asked).toEqual([]);
  });

  it('asks nothing at a workspace root, which the command refuses for every package', async () => {
    const fs = createFakeFs({ '/app/package.json': '{"workspaces":["apps/*"]}' });
    const prompt = recorder();
    const run = deps(fs, prompt.ask);
    expect(await runCli(['add', 'messaging', 'mail'], run.deps)).not.toBe(0);
    expect(prompt.asked).toEqual([]);
  });

  it('asks nothing in a workspace that names an unknown Redis client', async () => {
    const fs = createFakeFs();
    const setup = deps(fs);
    expect(await runCli(['new', 'ws', '--workspace'], setup.deps)).toBe(0);
    expect(
      await runCli(['g', 'app', 'api', '--template', 'rest'], { ...setup.deps, cwd: '/app/ws' }),
    ).toBe(0);
    const manifest = JSON.parse(fs.read('/app/ws/setu.workspace.json')) as Record<string, unknown>;
    await fs.writeFile(
      '/app/ws/setu.workspace.json',
      new TextEncoder().encode(JSON.stringify({ ...manifest, redisClient: 'bogus' })),
    );
    const prompt = recorder();
    const member = deps(fs, prompt.ask, '/app/ws/apps/api');
    expect(await runCli(['add', 'mail'], member.deps)).not.toBe(0);
    expect(prompt.asked).toEqual([]);
  });

  // Every given-flag refusal is caught by the silent dry run, so none of these asks
  // a question it then refuses. Each row is a command the real run refuses.
  const refusedUpFront: readonly {
    readonly name: string;
    readonly argv: readonly string[];
    /** The refusal the real run reports, so a row refused for another reason fails. */
    readonly refusal: string;
    readonly seed?: Readonly<Record<string, string>>;
  }[] = [
    {
      name: 'an invalid --redis-client',
      argv: ['add', 'mail', 'cache', '--redis-client', 'bogus'],
      refusal: 'Unknown --redis-client "bogus"',
    },
    {
      name: 'a valid --redis-client beside a non-Redis arm',
      argv: ['add', 'mail', 'cache', '--redis-client', 'ioredis', '--store', 'memory'],
      refusal: '--redis-client requires a Redis arm',
    },
    {
      name: 'a --redis-client that disagrees with the project client',
      argv: ['add', 'mail', 'queue', '--redis-client', 'node-redis', '--queue', 'redis'],
      refusal: "--redis-client node-redis disagrees with the project's ioredis client",
      seed: { '/app/package.json': '{"dependencies":{"ioredis":"^5.0.0"}}' },
    },
    {
      name: 'an unknown --dialect',
      // --type drizzle, so the dialect itself is what is refused; mail keeps a choice open.
      argv: ['add', 'mail', 'database', '--type', 'drizzle', '--dialect', 'mysql'],
      refusal: '--dialect requires database --type drizzle',
    },
    {
      name: '--dialect with a non-drizzle --type',
      argv: ['add', 'mail', 'database', '--type', 'prisma', '--dialect', 'sqlite'],
      refusal: '--dialect requires database --type drizzle',
    },
    {
      name: 'an unknown --provider beside another package',
      argv: ['add', 'cache', 'mail', '--provider', 'bogus'],
      refusal: 'Unknown --provider: bogus',
    },
    {
      name: 'a --redis-client on Workers',
      argv: ['add', 'mail', 'cache', '--redis-client', 'ioredis'],
      refusal: '--redis-client cannot apply on Cloudflare Workers',
      seed: { '/app/package.json': '{}', '/app/wrangler.toml': '' },
    },
  ];
  for (const { name, argv, refusal, seed } of refusedUpFront) {
    it(`asks nothing for ${name}, which the command refuses`, async () => {
      const prompt = recorder();
      const run = deps(createFakeFs(seed ?? { '/app/package.json': '{}' }), prompt.ask);
      expect(await runCli([...argv], run.deps)).not.toBe(0);
      expect(prompt.asked).toEqual([]);
      expect(run.err.join('\n')).toContain(refusal);
    });
  }

  // A given flag that works with only one value of an open choice narrows the
  // offer to that value, so the user still chooses and the run succeeds.
  const narrowed: readonly {
    readonly name: string;
    readonly argv: readonly string[];
    readonly asked: readonly Asked[];
  }[] = [
    {
      name: '--redis-client leaves only redis for the store',
      argv: ['add', 'mail', 'cache', '--redis-client', 'ioredis'],
      asked: [
        {
          question: 'Choose the provider for mail-plugin',
          values: ['log', 'smtp', 'ses', 'sendgrid'],
        },
        { question: 'Choose the store for cache-plugin', values: ['redis'] },
      ],
    },
    {
      name: '--redis-client leaves only redis for the queue',
      argv: ['add', 'queue', '--redis-client', 'node-redis'],
      asked: [{ question: 'Choose the queue for queue-plugin', values: ['redis'] }],
    },
    {
      name: '--dialect leaves only drizzle for the type',
      argv: ['add', 'mail', 'database', '--dialect', 'sqlite'],
      asked: [
        {
          question: 'Choose the provider for mail-plugin',
          values: ['log', 'smtp', 'ses', 'sendgrid'],
        },
        { question: 'Choose the type for database-plugin', values: ['drizzle'] },
      ],
    },
  ];
  for (const { name, argv, asked } of narrowed) {
    it(`asks when ${name}, and the default answer succeeds`, async () => {
      const prompt = recorder(({ values }) => ({ kind: 'answer', value: values[0]! }));
      const run = deps(createFakeFs({ '/app/package.json': '{}' }), prompt.ask);
      expect(await runCli([...argv], run.deps), run.err.join('\n')).toBe(0);
      expect(prompt.asked).toEqual(asked);
    });
  }

  it('asks nothing for a --redis-client in a workspace member, which the command refuses', async () => {
    const fs = createFakeFs();
    const setup = deps(fs);
    expect(await runCli(['new', 'ws', '--workspace'], setup.deps)).toBe(0);
    expect(
      await runCli(['g', 'app', 'api', '--template', 'rest'], { ...setup.deps, cwd: '/app/ws' }),
    ).toBe(0);
    const prompt = recorder();
    const member = deps(fs, prompt.ask, '/app/ws/apps/api');
    expect(
      await runCli(['add', 'mail', 'cache', '--redis-client', 'ioredis'], member.deps),
    ).not.toBe(0);
    expect(prompt.asked).toEqual([]);
  });

  it('documents every choice in the help text, from the same table', async () => {
    const run = deps(createFakeFs({}));
    expect(await runCli(['add', '--help'], run.deps)).toBe(0);
    const help = run.out.join('\n');
    for (const choice of ADD_CHOICES)
      expect(help).toContain(`--${choice.flag} ${choice.values().join('|')} selects`);
    expect(help).toContain('--yes, -y takes');
  });
});
