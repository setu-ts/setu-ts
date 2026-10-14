import { describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { runDocsMain } from '../../scripts/check-docs.ts';
import { runProseMain } from '../../scripts/check-prose-assertions.ts';
import { runSinceMain } from '../../scripts/check-since-tags.ts';
import { runVersionSweepMain } from '../../scripts/version-sweep.ts';
import { runApiDocsMain } from '../../scripts/generate-api-docs.ts';

describe('real repository entry points without exiting the runner', () => {
  it('executes the complete documentation path and reports the stopped export-table discrepancy', async () => {
    expect(await runDocsMain(['README.md'])).toBe(0);
    expect(await runDocsMain([])).toBe(1);
  }, 120_000);
  it('runs both API documentation modes through their real engines', async () => {
    expect(await runApiDocsMain(['--check'])).toBe(0);
    expect(await runApiDocsMain([])).toBe(0);
  }, 120_000);
  it('runs the prose entry point and reports a controlled false claim', async () => {
    await mkdir('.tmp', { recursive: true });
    const file = '.tmp/prose-main-proof.md';
    await writeFile(
      file,
      '<!-- assert:js -->\n\n| Expression | Value |\n| - | - |\n| `1 === 1` | `true` |\n',
    );
    try {
      expect(await runProseMain([file])).toBe(0);
      await writeFile(
        file,
        '<!-- assert:js -->\n\n| Expression | Value |\n| - | - |\n| `1 === 1` | `false` |\n',
      );
      expect(await runProseMain([file])).toBe(1);
    } finally {
      await rm(file);
    }
  });
  it('runs the registry entry point offline and exposes skipped verification', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline entry proof')));
    try {
      expect(await runSinceMain()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('runs default and explicit version sweeps against the tracked tree', async () => {
    expect(await runVersionSweepMain([])).toBe(0);
    expect(await runVersionSweepMain(['9.9.9'])).toBe(1);
  });
});
