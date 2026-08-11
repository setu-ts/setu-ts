import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  DISCOVERY_MODULE,
  DISCOVERY_SPECIFIER,
  renderDiscoveryModule,
  SERVICE_ENDPOINTS_EXPORT,
  SERVICE_PORT_EXPORT,
} from '../../../src/workspace/discovery-module.ts';
import type { WorkspaceMember } from '../../../src/workspace/manifest.ts';

const ORDERS: WorkspaceMember = { name: 'orders', port: 3000 };
const BILLING: WorkspaceMember = { name: 'billing', port: 3001 };
const SHIPPING: WorkspaceMember = { name: 'shipping', port: 3002 };

describe('renderDiscoveryModule', () => {
  it('exports the member own port', () => {
    const source = renderDiscoveryModule(ORDERS, [ORDERS]);
    expect(source).toContain(`export const ${SERVICE_PORT_EXPORT} = 3000;`);
  });

  it('names every sibling with its allocated port', () => {
    const source = renderDiscoveryModule(ORDERS, [ORDERS, BILLING, SHIPPING]);
    // The host is an environment read with the local address as its fallback:
    // inside a container 127.0.0.1 is the container itself, so a fixed value would
    // have every member dial ITSELF on its sibling's port.
    expect(source).toContain("host: Deno.env.get('BILLING_HOST') ?? '127.0.0.1'");
    expect(source).toContain('port: 3001,');
    expect(source).toContain("host: Deno.env.get('SHIPPING_HOST') ?? '127.0.0.1'");
    expect(source).toContain('port: 3002,');
  });

  // Discovery is for reaching OTHER services; a self-entry invites a service to
  // route a request back into its own process.
  it('excludes the member itself', () => {
    const source = renderDiscoveryModule(ORDERS, [ORDERS, BILLING]);
    expect(source).not.toContain(`'orders':`);
  });

  it('emits an empty map for a lone member', () => {
    const source = renderDiscoveryModule(ORDERS, [ORDERS]);
    expect(source).toContain(`export const ${SERVICE_ENDPOINTS_EXPORT} = {};`);
  });

  // Member order comes from a manifest a human may reorder, and `readdir`
  // ordering is filesystem-defined; without a sort a no-op regeneration would
  // show up as a diff.
  it('sorts siblings by name regardless of input order', () => {
    const forwards = renderDiscoveryModule(ORDERS, [ORDERS, BILLING, SHIPPING]);
    const backwards = renderDiscoveryModule(ORDERS, [SHIPPING, BILLING, ORDERS]);
    expect(forwards).toBe(backwards);
    expect(forwards.indexOf(`'billing'`)).toBeLessThan(forwards.indexOf(`'shipping'`));
  });

  it('does not mutate the caller member list', () => {
    const members = [SHIPPING, BILLING, ORDERS];
    renderDiscoveryModule(ORDERS, members);
    expect(members.map((m) => m.name)).toEqual(['shipping', 'billing', 'orders']);
  });

  // The header is the only thing that tells a developer this file is rewritten,
  // and the only place a project scaffolded before workspaces existed learns
  // the two lines to add.
  it('states that the CLI owns the file and how both consumers read it', () => {
    const source = renderDiscoveryModule(ORDERS, [ORDERS, BILLING]);
    expect(source).toContain('The CLI owns this file');
    expect(source).toContain(
      `import { ${SERVICE_ENDPOINTS_EXPORT} } from '${DISCOVERY_SPECIFIER}';`,
    );
    expect(source).toContain(`import { ${SERVICE_PORT_EXPORT} } from '${DISCOVERY_SPECIFIER}';`);
    expect(source).toContain(`services: ${SERVICE_ENDPOINTS_EXPORT}`);
  });

  it('says the map is the local topology, not a deployed one', () => {
    expect(renderDiscoveryModule(ORDERS, [ORDERS])).toContain(`provider: 'consul'`);
  });

  it('imports through the module own path', () => {
    expect(DISCOVERY_SPECIFIER).toBe(`./${DISCOVERY_MODULE}`);
  });
});
