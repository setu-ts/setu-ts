import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateRoute } from '../../../src/schematics/route.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('route schematic', () => {
  const files = generateRoute(deriveNames('order-item'), options());
  const file = artifactOf(files, 'route');

  it('emits the route module plus its seam barrel', () => {
    expect(files.map((f) => f.path)).toEqual([
      'src/controllers/order-item.routes.ts',
      'src/controllers/index.ts',
    ]);
  });

  it('satisfies the seam contract', () => {
    assertSeamContract('route', 'order-item', ['gizmo', 'billing']);
  });

  it('calls each route module through the compatibility-safe registrar list', () => {
    const barrel = barrelOf(files, 'route').contents;
    expect(barrel).toContain('export function registerGeneratedRoutes(');
    // The registry parameter is OPTIONAL on purpose. A `setu.config.ts` scaffolded
    // before it existed calls `registerGeneratedRoutes(app.router)`, and `generate`
    // never rewrites that file — so requiring it would fail the developer's own
    // project with TS2554 on their next generate, from a command reporting success.
    expect(barrel).toContain('  services?: IServiceRegistry,\n');
    expect(barrel).not.toContain(
      'registerGeneratedRoutes(router: IRouterApi, services: IServiceRegistry)',
    );
    expect(barrel).toContain('const GENERATED_ROUTE_REGISTRARS');
    expect(barrel).toContain('registerOrderItemRoutes,');
    expect(barrel).toContain('register(router, services);');
  });

  it('uses the router parameter even when no route module exists yet', () => {
    // The scaffolded barrel is empty, and the drift gate applies this workspace's
    // `noUnusedParameters` to a generated project — so an empty body still has to
    // consume `router` or the project fails to compile before anything is generated.
    const empty = barrelOf(generateRoute(deriveNames('x'), options()), 'route');
    expect(empty.contents).toContain('registerXRoutes,');
    const scaffolded = barrelOf(files, 'route').contents;
    expect(
      scaffolded.includes('void router;') || scaffolded.includes('register(router, services);'),
    ).toBe(true);
  });

  it('emits it at src/controllers/order-item.routes.ts', () => {
    expect(file.path).toBe('src/controllers/order-item.routes.ts');
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
    expect(file.contents).toContain(
      'export function registerOrderItemRoutes(\n  router: IRouterApi,\n  services?: IServiceRegistry,\n)',
    );
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
