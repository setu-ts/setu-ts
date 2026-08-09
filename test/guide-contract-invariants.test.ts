/** Source-derived invariants for curated M38 guide contracts. @module */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import { contractsMatch } from './fixtures/contract-ast.ts';
import { GUIDES } from './fixtures/snippets/fence-engine.ts';

function documentedInterface(markdown: string, name: string): string {
  const section = markdown.slice(markdown.indexOf(`### ${name}`));
  const fence = section.match(/```typescript\s*\n([\s\S]*?)```/);
  if (fence?.[1] === undefined) throw new Error(`Missing documented ${name}`);
  return fence[1];
}

describe('curated guide source-derived contracts', () => {
  it('documents IRequest exactly, including readonly and mutable members', async () => {
    const source = await Deno.readTextFile('packages/common/src/http.ts');
    const guide = await Deno.readTextFile('docs/programmatic-api.md');
    const documented = documentedInterface(guide, 'IRequest');
    expect(
      await contractsMatch(source, documented, 'IRequest', 'request-exact'),
    ).toBe(true);
    for (
      const [name, mutation] of [
        ['extra', documented.replace(/\n}/, '\n  extra(): void;\n}')],
        [
          'missing',
          documented.replace(/\s+bytes\(\): Promise<Uint8Array>;/, ''),
        ],
        [
          'signature',
          documented.replace('Promise<Uint8Array>', 'Promise<string>'),
        ],
        [
          'optional',
          documented.replace('signal?: AbortSignal', 'signal: AbortSignal'),
        ],
        ['readonly', documented.replace('readonly method:', 'method:')],
        [
          'duplicate',
          documented.replace(/\n}/, '\n  text(): Promise<string>;\n}'),
        ],
        [
          'malformed',
          documented.replace('json<T = unknown>()', 'json<T = unknown>('),
        ],
      ] as const
    ) {
      const matches = await contractsMatch(
        source,
        mutation,
        'IRequest',
        `request-${name}`,
      );
      expect(matches).toBe(false);
    }
  });

  it('documents IRuntimeServices exactly through the TypeScript AST', async () => {
    const source = await Deno.readTextFile('packages/common/src/runtime.ts');
    const guide = await Deno.readTextFile('docs/programmatic-api.md');
    const documented = documentedInterface(guide, 'IRuntimeServices');
    expect(
      await contractsMatch(
        source,
        documented,
        'IRuntimeServices',
        'runtime-exact',
      ),
    ).toBe(true);
    for (
      const [name, mutation] of [
        ['extra', documented.replace(/\n}/, '\n  extra(): void;\n}')],
        [
          'missing',
          documented.replace(/\s+platform\(\): RuntimePlatform;/, ''),
        ],
        [
          'signature',
          documented.replace('hrtime(): number', 'hrtime(): string'),
        ],
        ['optional', documented.replace('readonly dns?:', 'readonly dns:')],
        ['readonly', documented.replace('readonly fs?', 'fs?')],
        [
          'multiline',
          documented.replace(
            'setTimeout(fn: () => void, ms: number): TimerHandle;',
            'setTimeout(\n    fn: () => void,\n    ms: number,\n  ): TimerHandle;',
          ),
        ],
        ['duplicate', documented.replace(/\n}/, '\n  now(): number;\n}')],
        ['malformed', documented.replace('platform():', 'platform(:')],
      ] as const
    ) {
      const matches = await contractsMatch(
        source,
        mutation,
        'IRuntimeServices',
        `runtime-${name}`,
      );
      expect(matches).toBe(name === 'multiline');
    }
    const reordered = documented.replace(
      / {2}platform\(\): RuntimePlatform;\n {2}version\(\): string;/,
      '  version(): string;\n  platform(): RuntimePlatform;',
    );
    expect(
      await contractsMatch(
        source,
        reordered,
        'IRuntimeServices',
        'runtime-reordered',
      ),
    ).toBe(true);
  });

  it('uses CAPABILITIES for every first-party token literal', async () => {
    const standard = new Set<string>(Object.values(CAPABILITIES));
    const findings: string[] = [];
    for (const guide of GUIDES) {
      const text = await Deno.readTextFile(guide);
      for (const [index, line] of text.split('\n').entries()) {
        for (const match of line.matchAll(/['"]([^'"]+)['"]/g)) {
          const prefix = line.slice(0, match.index);
          if (
            standard.has(match[1] as string) &&
            /(?:services\.(?:get|has|register|getAll|unregister|registerFactory)(?:<[^>]+>)?\(|@Inject\(|(?:dependencies|optionalDependencies|provides|consumes)\s*:\s*\[[^\]]*)$/
              .test(
                prefix,
              )
          ) {
            findings.push(`${guide}:${index + 1}`);
          }
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it('keeps copyable guides free of ambient runtime APIs', async () => {
    const findings: string[] = [];
    for (const guide of GUIDES) {
      const text = await Deno.readTextFile(guide);
      for (const [index, line] of text.split('\n').entries()) {
        const code = line.replace(/\/\/.*$/, '');
        if (
          /\b(?:process\.env|Deno\.|Bun\.|Date\.now\()/.test(code) ||
          /new Promise[^\n]*\bsetTimeout\(/.test(code)
        ) {
          findings.push(`${guide}:${index + 1}:${line.trim()}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it('pins the source shutdown phase order in the guide', async () => {
    const source = await Deno.readTextFile(
      'packages/kernel/src/application/application.ts',
    );
    const guide = await Deno.readTextFile('docs/programmatic-api.md');
    const sequence = [
      'runStopping()',
      'this.#stopping = true',
      'await this.#drainRequests()',
      'await adapter.close',
      'runShutdown()',
      'runClose()',
    ];
    let cursor = 0;
    for (const marker of sequence) {
      cursor = source.indexOf(marker, cursor);
      expect(cursor).toBeGreaterThan(-1);
      cursor += marker.length;
    }
    expect(guide).toContain('stopping hooks while requests are still accepted');
    expect(guide).toContain(
      'close the server socket → shutdown hooks → close hooks',
    );
  });
});
