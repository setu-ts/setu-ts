import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as barrel from '../../src/index.ts';
import type {
  InjectToken,
  ModuleOptions,
  OptionalToken,
  ParamSource,
  SetuClassDecorator,
  SetuClassOrMethodDecorator,
  SetuMethodDecorator,
  SourceValues,
} from '../../src/index.ts';

/**
 * Pins the published surface.
 *
 * Every other test in this package imports the concrete module rather than the
 * barrel, so dropping a re-export leaves them all green — and a re-export file
 * is fully covered merely by being loaded, so the per-file bar does not see it
 * either. That is the M56 defect class, and these assertions are declared
 * AGAINST the barrel so a missing export fails `deno check`, not just at
 * runtime.
 */

// Type-level: each fails to compile if the type stops being exported.
const _classDecorator: SetuClassDecorator = () => {};
const _methodDecorator: SetuMethodDecorator = () => {};
const _classOrMethod: SetuClassOrMethodDecorator = () => {};
const _source: ParamSource<string> = { descriptor: { type: 'param', name: 'id' } };
const _values: SourceValues<[ParamSource<string>]> = ['x'];
const _optionalToken: OptionalToken = { token: 'cache', optional: true };
const _injectToken: InjectToken = _optionalToken;
const _moduleOptions: ModuleOptions = {};

/** The complete published surface, in barrel order. */
const EXPECTED_VALUES = [
  'MetadataStore',
  'metadataStore',
  'Controller',
  'Version',
  'Delete',
  'Get',
  'Head',
  'Options',
  'Patch',
  'Post',
  'Put',
  'Body',
  'Cookie',
  'CurrentUser',
  'Ctx',
  'Custom',
  'Header',
  'Param',
  'Params',
  'Query',
  'Inject',
  'Injectable',
  'Module',
  'Optional',
  'Permissions',
  'Public',
  'Roles',
  'UseFilters',
  'UseGuards',
  'UseInterceptors',
  'ValidateBody',
  'ValidateParams',
  'ValidateQuery',
  'ApiOperation',
  'ApiResponse',
  'ApiTags',
  'createDecorator',
  'clearParameterResolvers',
  'getParameterResolver',
  'parseCookies',
  'registerParameterResolver',
  'resolveParameter',
  'resolveParameters',
  'discoverControllers',
  'DecoratorPlugin',
] as const;

describe('published barrel surface', () => {
  it('exports exactly the documented values, and nothing else', () => {
    expect(Object.keys(barrel).sort()).toEqual([...EXPECTED_VALUES].sort());
  });

  it('exports the positional parameter surface', () => {
    // The headline addition. Without these the milestone's replacement for
    // parameter decorators is unreachable by any consumer.
    for (const name of ['Params', 'Custom', 'Body', 'Query', 'Param', 'Ctx'] as const) {
      expect(typeof barrel[name]).toBe('function');
    }
  });

  it('no longer exports the removed legacy surface', () => {
    // createParameterDecorator has no standard-decorator form; Custom() replaces
    // it. Pinned so it cannot return by accident.
    expect('createParameterDecorator' in barrel).toBe(false);
  });

  it('keeps the mechanism internal', () => {
    // The bridge and the pending-write accumulator are implementation, not API.
    for (const name of ['defer', 'takePending', 'flushInto', 'classDecorator']) {
      expect(name in barrel).toBe(false);
    }
  });

  it('keeps the authorization middleware internal (M89a)', () => {
    // The enforcing middleware @Roles/@Permissions produce is plugin plumbing
    // reached through registration, never a published symbol — the published
    // surface is unchanged by M89a.
    for (
      const name of [
        'createRolesMiddleware',
        'createPermissionsMiddleware',
        'appendAuthorizationMiddleware',
      ]
    ) {
      expect(name in barrel).toBe(false);
    }
  });

  it('keeps the type-level assertions live', () => {
    // Referencing them stops `noUnusedLocals` removing the compile-time checks.
    expect(_source.descriptor.type).toBe('param');
    expect(_values[0]).toBe('x');
    expect(_optionalToken.optional).toBe(true);
    expect(typeof _injectToken).toBe('object');
    expect(_moduleOptions).toEqual({});
    expect(
      [_classDecorator, _methodDecorator, _classOrMethod].every((f) => typeof f === 'function'),
    )
      .toBe(true);
  });
});
