import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FULL_STACK_TEMPLATE } from '../../src/templates/full-stack.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { withBrokerArgs, withQueueArgs } from '../../src/templates/broker.ts';
import { listTransports } from '../../src/workspace/transport.ts';
import { workspaceProfile } from '../../src/workspace/runtime-profile.ts';

interface IDiagnostic {
  readonly code: number;
  readonly message: string;
}

describe('the generated full-stack typed options position', () => {
  for (const spec of listTransports()) {
    for (const flag of ['broker', 'queue'] as const) {
      if ((flag === 'broker' ? spec.messagingArgs : spec.queueArgs) === undefined) continue;
      it(`checks every ${flag} arm: ${spec.name}`, { timeout: 120_000 }, () => {
        const profile = workspaceProfile('node');
        const host = resolveHost(FULL_STACK_TEMPLATE, 'node');
        const connected =
          flag === 'broker'
            ? withBrokerArgs(host, spec, profile)
            : withQueueArgs(host, spec, profile);
        // TypeScript's compiler allocates many closures; keeping that work out of
        // the V8 coverage worker avoids retaining every compiler graph there.
        // The child uses the compiler API and real workspace types, without writes.
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(new URL('../fixtures/full-stack-options-compiler.ts', import.meta.url))],
          {
            cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
            input: JSON.stringify(projectFiles('portal', 'node', connected)),
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 110_000,
          },
        );
        expect(result.status, `${result.error?.message ?? ''}\n${result.stderr}`).toBe(0);
        const diagnostics = JSON.parse(result.stdout) as {
          valid: readonly IDiagnostic[];
          misspelled: readonly IDiagnostic[];
          unannotated: readonly IDiagnostic[];
        };
        expect(diagnostics.valid).toEqual([]);
        expect(
          diagnostics.misspelled.some(
            (item) => item.code === 2561 && item.message.includes('messaging'),
          ),
          JSON.stringify(diagnostics.misspelled),
        ).toBe(true);
        expect(diagnostics.unannotated).toEqual([]);
      });
    }
  }
});
