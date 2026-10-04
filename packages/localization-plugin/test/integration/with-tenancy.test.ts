/**
 * The tenant default with the REAL `MultiTenancyPlugin`. The tenancy plugin is
 * listed AFTER this one on purpose: what orders the tenant (40) before the
 * locale (45) is middleware priority, not plugin registration order — so no
 * dependency edge is declared, and the control below proves priority is the
 * mechanism.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IKernelApplication } from '@setu-ts/kernel';
import type { ITenant } from '@setu-ts/common';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createTestApp } from '@setu-ts/testing';

import { LocalizationPlugin, localizerFor } from '../../src/index.ts';
import { CATALOGUES } from '../fixtures/catalogues.ts';

const TENANT_LOCALES: Readonly<Record<string, string>> = { acme: 'fr', globex: 'de' };

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function start(localePriority?: number): Promise<void> {
  app = await createTestApp({
    plugins: [
      RuntimePlugin(),
      LocalizationPlugin({
        supportedLocales: ['en', 'de', 'fr'],
        catalogues: CATALOGUES,
        tenantLocale: (tenant: ITenant) => TENANT_LOCALES[tenant.id],
        ...(localePriority === undefined ? {} : { middleware: { priority: localePriority } }),
      }),
      MultiTenancyPlugin({ resolver: 'header' }),
    ],
  });
  app.router.get('/title', (ctx) => ctx.response.text(localizerFor(ctx).t('title')));
}

async function title(headers: Record<string, string>): Promise<string> {
  const response = await app!.fetch(new Request('http://localhost/title', { headers }));
  return await response.text();
}

describe('tenant default locale', () => {
  it('uses the tenant default when the browser expresses no supported preference', async () => {
    await start();
    expect(await title({ 'x-tenant-id': 'acme' })).toBe('Panier');
    expect(await title({ 'x-tenant-id': 'globex' })).toBe('Warenkorb');
    expect(await title({ 'x-tenant-id': 'unknown' })).toBe('Cart');
  });

  it('ranks Accept-Language above the tenant default', async () => {
    await start();
    expect(await title({ 'x-tenant-id': 'acme', 'accept-language': 'de' })).toBe('Warenkorb');
  });

  it('control: run the locale middleware BEFORE tenancy (35 < 40) and no tenant is seen', async () => {
    await start(35);
    expect(await title({ 'x-tenant-id': 'acme' })).toBe('Cart');
  });
});
