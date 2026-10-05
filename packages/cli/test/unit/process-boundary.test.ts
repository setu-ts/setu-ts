import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { denoProcess, type MainProcess, runMain } from '../../src/main.ts';

const PATTERNS = [/prompt\(/, /confirm\(/, /Deno\.stdin/, /Deno\.exit/] as const;

const ALLOWLIST = [
  'src/main.ts',
  'src/workspace/dev-runner.ts',
  'src/devtool/dev-entry.ts',
] as const;

const SRC_DIR = new URL('../../src', import.meta.url).pathname.replace(/\/$/, '');

describe('the process boundary of packages/cli/src', () => {
  it('carries no prompt, stdin or exit reference outside the allowlist', async () => {
    const offenders: string[] = [];
    for await (const entry of walk(SRC_DIR)) {
      const relative = `src/${entry.slice(SRC_DIR.length + 1)}`;
      if ((ALLOWLIST as readonly string[]).includes(relative)) continue;
      const source = stripComments(await Deno.readTextFile(entry));
      for (const pattern of PATTERNS) {
        if (pattern.test(source)) offenders.push(`${relative}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds the allowlist to exactly its named entries', () => {
    expect([...ALLOWLIST].sort()).toEqual([
      'src/devtool/dev-entry.ts',
      'src/main.ts',
      'src/workspace/dev-runner.ts',
    ]);
  });

  it('registers SIGINT through runtime services, not Deno directly', async () => {
    const source = await Deno.readTextFile(new URL('../../src/main.ts', import.meta.url));
    expect(source).toContain("runtime.onSignal?.('SIGINT'");
    expect(source).not.toContain('Deno.addSignalListener');
  });

  it('returns 130 without writes when SIGINT is already delivered at startup', async () => {
    const fs = createFakeFs();
    const err = createRecorder();
    let registered: string | undefined;
    const process: MainProcess = {
      args: ['new', 'app'],
      cwd: () => '/work',
      isTerminal: () => true,
      prompt: () => '',
      log: () => {},
      error: err.sink,
      portAvailable: () => Promise.resolve(true),
    };
    expect(
      await runMain({
        fs,
        now: () => 0,
        onSignal: (signal, handler) => {
          registered = signal;
          handler();
        },
      }, process),
    ).toBe(130);
    expect(registered).toBe('SIGINT');
    expect(fs.writes).toEqual([]);
    expect(err.text()).toContain('Cancelled; nothing was written.');
  });

  it('reports missing filesystem access and runs non-terminal informational commands', async () => {
    const errors = createRecorder();
    const output = createRecorder();
    const process: MainProcess = {
      args: ['--version'],
      cwd: () => '/work',
      isTerminal: () => false,
      prompt: () => null,
      log: output.sink,
      error: errors.sink,
      portAvailable: () => Promise.resolve(true),
    };
    expect(await runMain({ now: () => 0 }, process)).toBe(1);
    expect(errors.text()).toContain('requires filesystem access');
    expect(await runMain({ fs: createFakeFs(), now: () => 0 }, process)).toBe(0);
    expect(output.lines).not.toEqual([]);
  });

  it('builds a Deno adapter whose port probe reports bind success and refusal', async () => {
    const originalPrompt = globalThis.prompt;
    const originalLog = console.log;
    const originalError = console.error;
    const messages: string[] = [];
    globalThis.prompt = () => 'answer';
    console.log = (message) => messages.push(String(message));
    console.error = (message) => messages.push(String(message));
    try {
      const process = denoProcess();
      expect(process.args).toEqual(Deno.args);
      expect(process.cwd()).toBe(Deno.cwd());
      expect(typeof process.isTerminal()).toBe('boolean');
      expect(process.prompt('question')).toBe('answer');
      process.log('out');
      process.error('err');
      expect(messages).toEqual(['out', 'err']);
      expect(await process.portAvailable(0)).toBe(true);
      expect(await process.portAvailable(-1)).toBe(false);
    } finally {
      globalThis.prompt = originalPrompt;
      console.log = originalLog;
      console.error = originalError;
    }
  });
});

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (entry.name.endsWith('.ts')) {
      yield path;
    }
  }
}

function stripComments(source: string): string {
  let out = '';
  let quote: string | undefined;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (quote !== undefined) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    out += char;
  }
  return out;
}
