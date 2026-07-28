import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateRoute } from '../../../src/schematics/route.ts';
import { gateOf, options } from './_shared.ts';

describe('route schematic', () => {
  const files = generateRoute(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
  });

  it('emits it at src/routes/order-item.routes.ts', () => {
    expect(file.path).toBe('src/routes/order-item.routes.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is ungated', () => {
    expect(gateOf('route')).toBe(undefined);
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateRoute(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('exports the register function', () => {
    expect(file.contents).toContain('export function registerOrderItemRoutes(router: IRouterApi)');
  });

  it('groups the routes under the kebab path', () => {
    expect(file.contents).toContain("router.group('/order-item'");
  });

  it('reads path params from the request context, not the request', () => {
    expect(file.contents).toContain("ctx.params['id']");
    expect(file.contents).not.toContain('ctx.request.params');
  });

  it('binds the group callback to a fixed identifier, not the derived name', () => {
    // A resource legitimately called `class` must not land in a binding
    // position — `(class) => {}` does not parse.
    const reserved = generateRoute(deriveNames('class'), options())[0];
    expect(reserved.contents).toContain("router.group('/class', (routes) => {");
    expect(reserved.contents).toContain('routes.get(');
    expect(reserved.contents).not.toContain('(class)');
  });
});
