/**
 * Unit tests for the query-handler schematic (gated on cqrs-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateQueryHandler } from '../../../src/schematics/query-handler.ts';
import { createFakeRuntime } from '../../../test/fixtures/fake-runtime.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateQueryHandler', () => {
  it('emits a query handler implementing IQueryHandler', () => {
    const names = deriveNames('get-user');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateQueryHandler(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/cqrs/get-user.query-handler.ts');
    expect(files[0].contents).toContain('implements IQueryHandler');
  });

  it('creates a query class name from input', () => {
    const names = deriveNames('find-product');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateQueryHandler(names, options);

    expect(files[0].contents).toContain('FindProductQuery');
  });
});
