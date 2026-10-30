import type { ProjectFacts } from '../../src/agents/facts.ts';

/** Hand-built render input, independent of the gather implementation. */
export function agentFacts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    version: '0.10.0',
    runtime: 'node',
    style: 'functional',
    installed: new Set(['common', 'runtime']),
    commands: ['start', 'check', 'test'],
    commandBodies: {},
    schematics: ['route', 'service'],
    seams: ['src/controllers'],
    directories: [],
    ...overrides,
  };
}
