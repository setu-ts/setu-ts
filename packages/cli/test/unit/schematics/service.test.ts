import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateService } from '../../../src/schematics/service.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('service schematic', () => {
  describe('in a project without decorator-plugin', () => {
    const files = generateService(deriveNames('order-item'), options());
    const [file] = files;

    // Pins the promise the conditional shape is built on: a bare project's output does
    // not move at all, so `g service` keeps working exactly as it did while staying
    // ungated. If this ever fails, the schematic has silently become decorator-only.
    it('emits exactly one file, and no seam barrel', () => {
      expect(files).toHaveLength(1);
      expect(file!.path).toBe('src/services/order-item.service.ts');
      expect(files.some((f) => f.managed === true)).toBe(false);
    });

    it('produces non-empty contents ending in a newline', () => {
      expect(file!.contents.length).toBeGreaterThan(0);
      expect(file!.contents.endsWith('\n')).toBe(true);
    });

    it('declares the service class', () => {
      expect(file!.contents).toContain('export class OrderItemService');
    });

    it('needs no framework import', () => {
      // Matched as STATEMENTS at the start of a line, not as substrings: the JSDoc says
      // the class "is used by whatever imports it" and names `@Injectable` as what you
      // get with the plugin installed, so bare `toContain` checks would both trip on
      // prose while an applied import or decorator is what actually matters.
      expect(file!.contents).not.toMatch(/^import /m);
      expect(file!.contents).not.toMatch(/^@Injectable/m);
    });

    it('says it is unregistered, and how to change that', () => {
      expect(file!.contents).toContain('No framework registration');
      expect(file!.contents).toContain('@setu-ts/decorator-plugin');
    });

    it('is ungated, so it runs in a project with no plugins at all', () => {
      expect(gateOf('service')).toBe(undefined);
    });

    it('derives identical output from any casing of the same name', () => {
      expect(generateService(deriveNames('OrderItem'), options())).toEqual(files);
    });
  });

  describe('in a project with decorator-plugin', () => {
    const files = generateService(deriveNames('order-item'), options(['decorator-plugin']));
    const file = artifactOf(files, 'service');

    it('emits the service plus its seam barrel', () => {
      expect(files.map((f) => f.path)).toEqual([
        'src/services/order-item.service.ts',
        'src/services/index.ts',
      ]);
    });

    it('decorates the class with an explicit token', () => {
      // Explicit because `emitDecoratorMetadata` is unavailable under Deno, so a
      // consumer's `@Inject` cannot read the parameter's type.
      expect(file.contents).toContain("@Injectable({ token: 'order-item-service' })");
      expect(file.contents).toContain(`import { Injectable } from '@setu-ts/decorator-plugin';`);
    });

    it('lists the class in the barrel for DecoratorPlugin({ services })', () => {
      expect(barrelOf(files, 'service').contents).toContain('OrderItemService');
      expect(barrelOf(files, 'service').contents).toContain('readonly Constructor[]');
    });

    it('satisfies the seam contract', () => {
      assertSeamContract('service', 'order-item', ['gizmo', 'billing'], {
        plugins: ['decorator-plugin'],
      });
    });

    it('derives identical output from any casing of the same name', () => {
      expect(generateService(deriveNames('OrderItem'), options(['decorator-plugin'])))
        .toEqual(files);
    });
  });
});
