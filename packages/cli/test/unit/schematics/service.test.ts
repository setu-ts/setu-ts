/**
 * Unit tests for the `service` schematic.
 *
 * The one schematic whose emitted shape depends on the target project's
 * composition, so both arms are pinned rather than only the one the default
 * template takes.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { generateService } from '../../../src/schematics/service.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { FUNCTIONAL_SERVICES_SEAM } from '../../../src/seams/services.ts';
import { assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('service schematic', () => {
  it('is ungated, so it runs in a project with no plugins at all', () => {
    expect(gateOf('service')).toBeUndefined();
  });

  describe('in a functional project', () => {
    const files = generateService(deriveNames('order-item'), options());

    it('emits the service and a convenience re-export barrel', () => {
      expect(files.map((f) => f.path)).toEqual([
        'src/services/order-item.service.ts',
        'src/services/index.ts',
      ]);
      // Managed, so a second `g service` rewrites it rather than refusing.
      expect(files.filter((f) => f.managed === true).map((f) => f.path))
        .toEqual(['src/services/index.ts']);
    });

    it('re-exports the function, and registers nothing', () => {
      const barrel = files[1].contents;
      expect(barrel).toContain(
        "export { describeOrderItem } from './order-item.service.ts';",
      );
      // A plain function has no registration site, and the barrel must not imply
      // one: `APP_SERVICES` is the class barrel's export, read by DecoratorPlugin.
      expect(barrel).not.toContain('APP_SERVICES');
      expect(barrel).not.toContain('DecoratorPlugin');
      expect(barrel).toContain('not a registration');
    });

    it('unions the services already present with the new one', () => {
      const barrel = generateService(
        deriveNames('order-item'),
        options([], [], { service: ['gizmo', 'billing'] }),
      )[1].contents;
      for (const symbol of ['describeGizmo', 'describeBilling', 'describeOrderItem']) {
        expect(barrel).toContain(`export { ${symbol} }`);
      }
    });

    it('lists a regenerated service exactly once', () => {
      const barrel = generateService(
        deriveNames('billing'),
        options([], [], { service: ['billing'] }),
      )[1].contents;
      expect(barrel.match(/describeBilling/g)?.length).toBe(1);
    });

    it('produces non-empty contents ending in a newline', () => {
      expect(files[0].contents.length).toBeGreaterThan(0);
      expect(files[0].contents.endsWith('\n')).toBe(true);
    });

    it('exports a plain function', () => {
      expect(files[0].contents).toContain('export function describeOrderItem(): string');
    });

    it('needs no framework import', () => {
      // Matched as STATEMENTS at the start of a line, not as substrings: the JSDoc
      // names the functional style in prose, so a bare `toContain` would trip on
      // that while an applied import or decorator is what actually matters.
      expect(files[0].contents).not.toMatch(/^import /m);
      expect(files[0].contents).not.toMatch(/^@Injectable/m);
    });

    // The symbol the module exports and the symbol the barrel imports have ONE
    // owner, `functionalServiceSymbol` — which is also what the scanner admits
    // files by. Splitting those is the M60 defect this seam nearly repeated.
    it('exports exactly the symbol its seam requires', () => {
      const required = FUNCTIONAL_SERVICES_SEAM.importSymbols(deriveNames('order-item'));
      expect(required).toEqual(['describeOrderItem']);
      for (const symbol of required) {
        expect(files[0].contents).toContain(`export function ${symbol}(`);
      }
    });

    it('derives identical output from any casing of the same name', () => {
      expect(generateService(deriveNames('OrderItem'), options())).toEqual(files);
    });
  });

  describe('in a class-based project', () => {
    const plugins = ['decorator-plugin', 'di-plugin'];
    const files = generateService(deriveNames('order-item'), options(plugins));

    it('emits the service plus its seam barrel', () => {
      expect(files.map((f) => f.path)).toEqual([
        'src/services/order-item.service.ts',
        'src/services/index.ts',
      ]);
    });

    it('decorates the class with an explicit token', () => {
      // Explicit because `emitDecoratorMetadata` is unavailable under Deno, so a
      // consumer's `@Inject` cannot read the parameter's type.
      expect(files[0].contents).toContain("@Injectable({ token: 'order-item-service' })");
      expect(files[0].contents).toContain(
        `import { Injectable } from '@setu-ts/decorator-plugin';`,
      );
    });

    it('lists the class in the barrel for DecoratorPlugin({ services })', () => {
      expect(barrelOf(files, 'service').contents).toContain('OrderItemService');
      expect(barrelOf(files, 'service').contents).toContain('readonly Constructor[]');
    });

    it('satisfies the seam contract', () => {
      assertSeamContract('service', 'order-item', ['gizmo', 'billing'], { plugins });
    });

    it('derives identical output from any casing of the same name', () => {
      expect(generateService(deriveNames('OrderItem'), options(plugins))).toEqual(files);
    });
  });

  // Only a project predating `--template class-based` can hold decorators
  // without a container, and its generation must keep working — that is the
  // whole reason the mode classifier reads `decorator-plugin` alone.
  it('emits the class for a legacy decorator-only project', () => {
    const files = generateService(deriveNames('order-item'), options(['decorator-plugin']));
    expect(files.map((f) => f.path)).toEqual([
      'src/services/order-item.service.ts',
      'src/services/index.ts',
    ]);
  });
});

// The emitted JSDoc is the only place a developer is told HOW to resolve the
// class, and the two compositions genuinely differ: with a container the class
// is a provider ON the container and is absent from the kernel registry, so
// `services.get(token)` throws. Verified by booting both, not inferred — see the
// M61 matrix, and `test/e2e/seam-probe.test.ts`, which resolves the generated
// service through the container exactly as this text instructs.
describe('the injectable service JSDoc names the right resolution route', () => {
  const injectable = () =>
    generateService(deriveNames('billing'), options(['decorator-plugin', 'di-plugin']))[0].contents;

  it('does not present services.get as unconditional', () => {
    expect(injectable()).not.toContain('constructor parameter, or `services.get(');
  });

  it('names the container route and says the registry one throws', () => {
    const src = injectable();
    expect(src).toContain('DI_CONTAINER');
    expect(src).toContain("resolve('billing-service')");
    expect(src).toContain('throws');
  });

  it('still names services.get for the container-less composition', () => {
    expect(injectable()).toContain("services.get('billing-service')");
  });

  it('says @Inject works either way', () => {
    expect(injectable()).toContain('whether or not a container is registered');
  });

  it('records that scope is ignored without a container and honored with one', () => {
    const src = injectable();
    expect(src).toContain('`scope` is ignored');
    expect(src).toContain('`scope` is honored');
  });
});
