/**
 * The style axis: one recipe, two hosts.
 *
 * `composeHost` is the single place that turns a styleable template's recipe
 * into a host, for either style. These assertions pin what each style adds —
 * without rendering a project, which is the `runtimeSwaps` reasoning: the host
 * is data, so it is assertable in place.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MICROSERVICE_RECIPE } from '../../../src/templates/microservice.ts';
import { REST_RECIPE, REST_TEMPLATE } from '../../../src/templates/rest.ts';
import { CLASS_BASED_TEMPLATE } from '../../../src/templates/class-based.ts';
import { composeHost, DECORATOR_WIRING } from '../../../src/templates/style.ts';
import { DI_WIRING } from '../../../src/templates/di.ts';

/** The packages a functional host must NOT install. */
const CLASS_ONLY_PACKAGES = new Set(['decorator-plugin', 'di-plugin']);

/**
 * Counts how many times a package appears in a host's plugin list.
 *
 * @param host - The composed host
 * @param pkg - The bare package name
 * @returns The number of wirings naming it
 */
function countPlugins(host: ReturnType<typeof composeHost>, pkg: string): number {
  return host.plugins.filter((wiring) => wiring.pkg === pkg).length;
}

describe('composeHost', () => {
  describe('the class-based arm of rest', () => {
    const host = composeHost(REST_RECIPE, 'class-based');

    it('installs exactly one DecoratorPlugin and one DiPlugin, in that order and last', () => {
      expect(countPlugins(host, 'decorator-plugin')).toBe(1);
      expect(countPlugins(host, 'di-plugin')).toBe(1);
      const decorator = host.plugins.find((w) => w.pkg === 'decorator-plugin');
      const di = host.plugins.find((w) => w.pkg === 'di-plugin');
      // The composed wirings are new objects (the module seam appends `args`
      // to the decorator), so assert on the pair's identity, not the instance.
      expect(decorator?.symbol).toBe(DECORATOR_WIRING.symbol);
      expect(di?.symbol).toBe(DI_WIRING.symbol);
      // The pair is last: the DI plugin resolves the decorator's classes, so it
      // registers after them.
      const lastTwo = host.plugins.slice(-2).map((w) => w.pkg);
      expect(lastTwo).toEqual(['decorator-plugin', 'di-plugin']);
    });

    it('keeps the whole REST plugin set', () => {
      for (const pkg of REST_RECIPE.plugins.map((w) => w.pkg)) {
        expect(countPlugins(host, pkg)).toBe(1);
      }
    });

    it('emits the class-based showcase files and seeds the controller and service barrels', () => {
      const paths = host.files?.map((file) => file.path) ?? [];
      expect(paths).toContain('src/services/greeting.service.ts');
      expect(paths).toContain('src/controllers/greeting.controller.ts');
      // The module barrel seam is present for a class-based host.
      expect(paths).toContain('src/modules/index.ts');
    });

    it('does not carry the functional showcase', () => {
      // The functional showcase uses the same filenames; the distinction is the
      // CONTENT. The class-based service is decorated, the functional one is not.
      const service = host.files?.find((f) => f.path === 'src/services/greeting.service.ts');
      expect(service?.contents).toContain('@Injectable');
    });
  });

  describe('the functional arm of rest', () => {
    const host = composeHost(REST_RECIPE, 'functional');

    it('installs neither the decorator plugin nor the DI plugin', () => {
      for (const pkg of CLASS_ONLY_PACKAGES) {
        expect(countPlugins(host, pkg)).toBe(0);
      }
    });

    it('emits the functional showcase', () => {
      const paths = host.files?.map((file) => file.path) ?? [];
      expect(paths).toContain('src/services/greeting.service.ts');
      expect(paths).toContain('src/controllers/greeting.controller.ts');
      const service = host.files?.find((f) => f.path === 'src/services/greeting.service.ts');
      // The functional service is a plain function, not a decorated class.
      expect(service?.contents).not.toContain('@Injectable');
    });
  });

  describe('the class-based arm of microservice', () => {
    const host = composeHost(MICROSERVICE_RECIPE, 'class-based');

    it('keeps all eight microservice additions plus the decorator and DI pair', () => {
      for (const pkg of MICROSERVICE_RECIPE.plugins.map((w) => w.pkg)) {
        expect(countPlugins(host, pkg)).toBe(1);
      }
      expect(countPlugins(host, 'decorator-plugin')).toBe(1);
      expect(countPlugins(host, 'di-plugin')).toBe(1);
    });

    it('shares the WORKERS swap with the functional arm', () => {
      const functional = composeHost(MICROSERVICE_RECIPE, 'functional');
      expect(host.runtimeSwaps).toBe(functional.runtimeSwaps);
      expect(host.runtimeSwaps?.['cloudflare-workers']).toBeDefined();
    });

    it('emits no showcase in either style', () => {
      // The microservice tier emits only the seam barrels.
      const paths = host.files?.map((file) => file.path) ?? [];
      expect(paths.some((p) => p.includes('greeting'))).toBe(false);
    });
  });

  describe('the functional arm of microservice', () => {
    const host = composeHost(MICROSERVICE_RECIPE, 'functional');

    it('installs neither the decorator plugin nor the DI plugin', () => {
      for (const pkg of CLASS_ONLY_PACKAGES) {
        expect(countPlugins(host, pkg)).toBe(0);
      }
    });
  });

  it('makes the class-based alias and rest --style class-based equal field for field', () => {
    // Both are built from composeHost(REST_RECIPE, 'class-based') — two separate
    // calls, so the objects are not identical, but every field is. A deep
    // equality here is what "identical by construction" means for data; the
    // byte-identity of the RENDERED output is the baseline test's job.
    expect(CLASS_BASED_TEMPLATE).toEqual({
      ...REST_TEMPLATE.classBased,
      name: 'class-based',
      description: CLASS_BASED_TEMPLATE.description,
      aliasOf: '--template rest --style class-based',
    });
    // The alias carries no classBased variant of its own — it IS the variant.
    expect(CLASS_BASED_TEMPLATE.classBased).toBeUndefined();
  });
});
