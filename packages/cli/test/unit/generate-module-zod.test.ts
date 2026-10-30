import { describe, expect, it } from 'vitest';
import { runGenerateCommand } from '../../src/commands/generate.ts';
import { parseArgs } from '../../src/args.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';

describe('schema generation Zod installation guidance', () => {
  for (const runtime of ['node', 'bun', 'deno', 'cloudflare-workers'] as const) {
    for (const kind of ['module', 'schema']) {
      for (const present of [false, true]) {
        it(`${runtime} ${kind}: ${present ? 'keeps installed Zod silent' : 'writes files and prints the exact install command'}`, async () => {
          const manifest = runtime === 'deno' ? 'deno.json' : 'package.json';
          const entries = {
            '@setu-ts/validation-plugin':
              runtime === 'deno' ? 'npm:@setu-ts/validation-plugin@^0.9' : '^0.9',
            ...(present ? { zod: runtime === 'deno' ? 'npm:zod@^4.6.6' : '^4.6.6' } : {}),
          };
          const text = JSON.stringify(
            runtime === 'deno' ? { imports: entries } : { dependencies: entries },
          );
          const fs = createFakeFs({ [`/app/${manifest}`]: text });
          const out = createRecorder();
          const err = createRecorder();
          const code = await runGenerateCommand(
            parseArgs([kind, 'invoice', '--runtime', runtime]),
            { fs, cwd: '/app', now: () => 0, log: out.sink, error: err.sink },
          );
          expect(code, err.text()).toBe(0);
          expect(
            fs.has(
              `/app/${kind === 'module' ? 'src/modules/invoice/invoice' : 'src/shared/schemas/invoice'}.schemas.ts`,
            ),
          ).toBe(true);
          expect(fs.read(`/app/${manifest}`)).toBe(text);
          if (present) expect(out.text()).not.toContain('Install Zod:');
          else
            expect(out.text()).toContain(
              `Install Zod: ${runtime === 'deno' ? 'deno add npm:zod@^4.6.6' : runtime === 'bun' ? 'bun add zod@^4.6.6' : 'npm install zod@^4.6.6'}`,
            );
        });
      }
    }
  }
});
