import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { getTemplate, listTemplates } from '../../src/templates/registry.ts';
import { MINIMAL_HOST } from '../../src/templates/minimal.ts';
import type { TemplateHost } from '../../src/templates/registry.ts';

/**
 * The `start` task a host's generated Deno manifest carries.
 *
 * @param host - The template host to scaffold
 * @returns The task's command line
 */
function startTaskOf(host: TemplateHost): string {
  const resolved = resolveHost(host, 'deno');
  const files = projectFiles('shop', 'deno', resolved);
  const manifest = files.find((f) => f.path === 'deno.json');
  const parsed = JSON.parse(manifest!.contents) as { tasks: Record<string, string> };
  return parsed.tasks['start'] ?? '';
}

/**
 * The `compilerOptions` a host's generated Deno manifest carries.
 *
 * @param host - The template host to scaffold
 * @returns The options, or undefined when the key is omitted
 */
function compilerOptionsOf(host: TemplateHost): Record<string, unknown> | undefined {
  const resolved = resolveHost(host, 'deno');
  const files = projectFiles('shop', 'deno', resolved);
  const manifest = files.find((f) => f.path === 'deno.json');
  const parsed = JSON.parse(manifest!.contents) as {
    compilerOptions?: Record<string, unknown>;
  };
  return parsed.compilerOptions;
}

/** The templates whose plugin set includes HealthPlugin. */
const HEALTH_TEMPLATES = ['rest', 'microservice', 'class-based', 'full-stack'] as const;

describe('generated start-task permissions', () => {
  it('always grants network and environment access', () => {
    // Every generated project binds a socket and reads configuration.
    for (const template of listTemplates()) {
      const start = startTaskOf(template);
      expect(start).toContain('--allow-net');
      expect(start).toContain('--allow-env');
    }
  });

  for (const name of HEALTH_TEMPLATES) {
    it(`grants ${name} the sys access its health indicator needs`, () => {
      // HealthPlugin's `self` indicator reads runtime.hostname(). Without this
      // the project scaffolds, starts, and answers 500 on /health — the path
      // the generated Kubernetes probes point at.
      expect(startTaskOf(getTemplate(name)!)).toContain('--allow-sys');
    });
  }

  it('grants full-stack the read access the SSR plugin needs', () => {
    expect(startTaskOf(getTemplate('full-stack')!)).toContain('--allow-read');
  });

  it('grants the no-template host nothing beyond the base pair', () => {
    // It registers only the runtime plugin, so a wider grant would be
    // privilege it never exercises.
    expect(startTaskOf(MINIMAL_HOST)).toBe('deno run --allow-net --allow-env main.ts');
  });
});

describe('generated Deno compiler options', () => {
  it('gives the decorator-hosting templates the decorator option', () => {
    for (const name of ['class-based'] as const) {
      expect(compilerOptionsOf(getTemplate(name)!)?.['experimentalDecorators']).toBe(true);
    }
  });

  it('gives full-stack the JSX options and NOT the decorator one', () => {
    // Vite reads tsconfig.json and `deno check` reads deno.json; a project
    // carrying only the first fails to type-check every .tsx route. The
    // decorator option is absent because this template emits no decorated class.
    const options = compilerOptionsOf(getTemplate('full-stack')!);

    expect(options?.['jsx']).toBe('react-jsx');
    expect(options?.['jsxImportSource']).toBe('react');
    expect(options?.['experimentalDecorators']).toBeUndefined();
  });

  it('keeps the decorator option on the no-template host', () => {
    // Nothing this host emits is decorated, but a developer who adds
    // decorator-plugin by hand should not have to discover a manifest edit.
    // It is free here precisely because this host emits no JSX.
    expect(compilerOptionsOf(MINIMAL_HOST)?.['experimentalDecorators']).toBe(true);
  });

  it('omits the key entirely when a host declares none', () => {
    // An empty `compilerOptions: {}` is noise suggesting a setting was intended
    // and lost — and a non-empty one replaces Deno's defaults, so emitting one
    // that was never asked for is not neutral.
    const { manifest: _dropped, ...bare } = MINIMAL_HOST;
    expect(compilerOptionsOf(bare)).toBeUndefined();
  });
});
