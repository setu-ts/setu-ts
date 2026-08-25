import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';

/** The runtime-visible surface §4 of the milestone plan commits to. */
const EXPECTED_VALUES = ['runCli', 'deriveNames', 'PROGRAM_NAME', 'detectPlugins'] as const;

describe('@setu-ts/cli barrel', () => {
  it('exports exactly the committed runtime symbols', () => {
    expect(Object.keys(barrel).sort()).toEqual([...EXPECTED_VALUES].sort());
  });

  it('exports runCli as a function', () => {
    expect(typeof barrel.runCli).toBe('function');
  });

  it('exports deriveNames as a function', () => {
    expect(typeof barrel.deriveNames).toBe('function');
  });

  it('exports detectPlugins as a function', () => {
    expect(typeof barrel.detectPlugins).toBe('function');
  });

  it('exports PROGRAM_NAME as the installed binary name', () => {
    expect(barrel.PROGRAM_NAME).toBe('setu');
  });

  it('does not leak internal schematic factories', () => {
    for (const name of ['generateService', 'getSchematic', 'listSchematics', 'parseArgs']) {
      expect(Object.keys(barrel)).not.toContain(name);
    }
  });

  it('does not export the terminal prompter implementation', () => {
    // Its only consumer is src/main.ts, which imports it directly; a second
    // export with no reader is dead surface.
    expect(Object.keys(barrel)).not.toContain('createTerminalPrompter');
  });

  // COMPILE-TIME, deliberately: a runtime assertion over a type export passes
  // when the export is gone (the M56 defect class), because types vanish at
  // runtime. These annotations fail `deno check` the moment the barrel stops
  // exporting either type.
  it('names Prompter and PromptChoice from the barrel', () => {
    const prompter: barrel.Prompter = {
      select: (_question: string, _choices: readonly barrel.PromptChoice[]) =>
        Promise.resolve(undefined),
    };
    const choice: barrel.PromptChoice = { value: 'rest', label: 'REST set' };
    expect(prompter).toBeDefined();
    expect(choice.value).toBe('rest');
  });

  it('does not leak the command implementations', () => {
    for (const name of ['runNewCommand', 'runGenerateCommand', 'writeFiles']) {
      expect(Object.keys(barrel)).not.toContain(name);
    }
  });
});
