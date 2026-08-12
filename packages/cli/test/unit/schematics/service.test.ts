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
import { assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('service schematic', () => {
  it('is ungated, so it runs in a project with no plugins at all', () => {
    expect(gateOf('service')).toBeUndefined();
  });

  describe('in a functional project', () => {
    const files = generateService(deriveNames('order-item'), options());

    it('emits exactly one file, and no seam barrel', () => {
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('src/services/order-item.service.ts');
      expect(files.some((f) => f.managed === true)).toBe(false);
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
