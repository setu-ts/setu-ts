/**
 * Unit tests for the query-handler schematic (gated on cqrs-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateQueryHandler } from '../../../src/schematics/query-handler.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateQueryHandler', () => {
  it('emits a query handler file implementing IQueryHandler', () => {
    const names = deriveNames('get-user');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateQueryHandler(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/cqrs/get-user.query-handler.ts');
    expect(files[0].contents).toContain('implements IQueryHandler');
  });

  it('handles both query and result types', () => {
    const names = deriveNames('find-products');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateQueryHandler(names, options);

    expect(files[0].contents).toContain('FindProductsQuery');
    expect(files[0].contents).toContain('IQueryHandler<FindProductsQuery, FindProductsQuery>');
  });
});
