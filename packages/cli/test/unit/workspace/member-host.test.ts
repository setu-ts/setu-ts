import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolveHost } from '../../../src/templates/project-files.ts';
import { getTemplate } from '../../../src/templates/registry.ts';
import { MINIMAL_HOST } from '../../../src/templates/minimal.ts';
import { withWorkspaceMember } from '../../../src/workspace/member-host.ts';
import {
  DISCOVERY_SPECIFIER,
  SERVICE_ENDPOINTS_EXPORT,
} from '../../../src/workspace/discovery-module.ts';

const FEATURES = { di: false } as const;

/**
 * Resolves a template by name, failing the test when it is missing.
 *
 * @param name - The template name
 * @returns Its resolved host
 */
function hostOf(name: string) {
  const template = getTemplate(name);
  expect(template).toBeDefined();
  return resolveHost(template ?? MINIMAL_HOST, FEATURES);
}

describe('withWorkspaceMember', () => {
  it('points the discovery wiring at the generated map', () => {
    const member = withWorkspaceMember(hostOf('microservice'));
    const wiring = member.plugins.find((p) => p.pkg === 'service-discovery-plugin');
    expect(wiring?.args).toBe(
      `{ provider: 'static', services: ${SERVICE_ENDPOINTS_EXPORT} }`,
    );
  });

  it('brings the map identifier into scope exactly once', () => {
    const member = withWorkspaceMember(hostOf('microservice'));
    const imports = member.localImports.filter((entry) => entry.from === DISCOVERY_SPECIFIER);
    expect(imports).toEqual([{ symbols: [SERVICE_ENDPOINTS_EXPORT], from: DISCOVERY_SPECIFIER }]);
  });

  it('keeps the template own local imports', () => {
    const base = hostOf('microservice');
    const member = withWorkspaceMember(base);
    for (const entry of base.localImports) {
      expect(member.localImports).toContainEqual(entry);
    }
  });

  it('leaves every other wiring untouched', () => {
    const base = hostOf('microservice');
    const member = withWorkspaceMember(base);
    const others = member.plugins.filter((p) => p.pkg !== 'service-discovery-plugin');
    expect(others).toEqual(base.plugins.filter((p) => p.pkg !== 'service-discovery-plugin'));
  });

  // Being REACHABLE by siblings and CONSUMING their map are separate
  // properties. A member without the plugin still appears in every other
  // member's map; adding the import here would put an identifier in its config
  // that no wiring reads.
  it('changes nothing for a member without the discovery plugin', () => {
    const base = hostOf('rest');
    expect(withWorkspaceMember(base)).toEqual(base);
  });

  it('changes nothing for a member scaffolded with no template', () => {
    const base = resolveHost(MINIMAL_HOST, FEATURES);
    expect(withWorkspaceMember(base)).toEqual(base);
  });
});
