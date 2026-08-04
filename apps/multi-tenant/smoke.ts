import { createMultiTenantApp } from './src/app.ts';

const app = createMultiTenantApp();
await app.start();
try {
  const headers = { 'x-tenant-id': 'tenant-a' };
  const created = await app.inject({
    method: 'POST',
    url: 'http://example.test/notes',
    headers,
    body: { text: 'only A can read this' },
  });
  if (created.statusCode !== 201) {
    throw new Error(`Expected tenant A write to succeed, received ${created.statusCode}`);
  }
  const tenantA = await app.inject({ method: 'GET', url: 'http://example.test/notes', headers });
  const tenantB = await app.inject({
    method: 'GET',
    url: 'http://example.test/notes',
    headers: { 'x-tenant-id': 'tenant-b' },
  });
  if (
    tenantA.json<readonly unknown[]>().length !== 1 ||
    tenantB.json<readonly unknown[]>().length !== 0
  ) {
    throw new Error('Tenant data isolation failed.');
  }
} finally {
  await app.stop();
}
