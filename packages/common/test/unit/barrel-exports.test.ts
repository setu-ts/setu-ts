/**
 * Barrel-export assertions for the registry factory arm and the validation brand.
 *
 * A re-export file is fully covered merely by being loaded, so only an
 * assertion that names the symbols from the barrel catches a dropped export
 * (the M56 defect class).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as common from '../../src/index.ts';
import type { HealthCheckResult, IHealthIndicator, IServiceRegistry } from '../../src/index.ts';
import type {
  JsonValue,
  RegistryFactory,
  RouteValidationMetadata,
  SessionView,
} from '../../src/index.ts';

describe('@setu-ts/common barrel — registry factory arm', () => {
  it('exports resolveRegistryEntry as a function', () => {
    expect(common.resolveRegistryEntry).toBeDefined();
    expect(typeof common.resolveRegistryEntry).toBe('function');
  });

  it('resolveRegistryEntry resolved from the barrel behaves like the direct import', () => {
    const instance: IHealthIndicator = {
      name: 'widget',
      check: (): Promise<HealthCheckResult> => Promise.resolve({ status: 'up' }),
    };
    const services = {} as IServiceRegistry;

    expect(common.resolveRegistryEntry(instance, services, 'label')).toBe(instance);
  });

  it('exports the RegistryFactory type (declared against the barrel)', () => {
    // Compile-time: the type resolves from the barrel and a zero-parameter
    // function is assignable to it (M63 D6 — an unused parameter would fail the
    // generated project's own lint, so the emitted factory takes none).
    const factory: RegistryFactory<IHealthIndicator> = () => ({
      name: 'widget',
      check: (): Promise<HealthCheckResult> => Promise.resolve({ status: 'up' }),
    });

    expect(factory).toBeDefined();
  });
  it('exports the validation-metadata brand (M70m/X11-5)', () => {
    expect(typeof common.VALIDATION_METADATA).toBe('symbol');
    expect(typeof common.withValidationMetadata).toBe('function');
    expect(typeof common.validationMetadataOf).toBe('function');
  });

  it('exports the RouteValidationMetadata type (declared against the barrel)', () => {
    // Compile-time, and declared against the BARREL rather than the concrete
    // module: dropping the re-export stops this file compiling. A runtime
    // assertion cannot see a type at all.
    const metadata: RouteValidationMetadata = { target: 'body', schema: { kind: 'zod' } };

    expect(metadata.target).toBe('body');
  });

  it('exports the JsonValue type (declared against the barrel) (M74/X3-8)', () => {
    // Declared against the BARREL, not `types.ts`: dropping the re-export stops
    // this file compiling, which no runtime assertion could detect (the M56
    // defect class). `SseMessage.data` is typed with it, so an application that
    // wants to annotate a payload before publishing needs the name exported.
    const payload: JsonValue = { build: 412, tags: ['live'], note: undefined };

    expect(JSON.stringify(payload)).toBe('{"build":412,"tags":["live"]}');
  });
});

/**
 * Strict identity check: `true` only when `A` and `B` are the same type
 * (mutually assignable in the identity sense), so the pinned shape below fails
 * on any added, removed, or re-typed member.
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
  : false;

// Compile-time: `SessionView` resolves from the barrel and its shape is pinned
// (M73). Dropping the re-export or widening the projection stops this file
// compiling — a type-only export is invisible to every runtime assertion.
const sessionViewShapePinned: Equals<
  SessionView,
  { readonly id: string; readonly data: Readonly<Record<string, unknown>> }
> = true;

describe('@setu-ts/common barrel — SessionView (M73)', () => {
  it('exports the SessionView type with the committed shape (declared against the barrel)', () => {
    expect(sessionViewShapePinned).toBe(true);
  });
});

describe('@setu-ts/common barrel — M79 portable data-access contract', () => {
  it('exports the six new symbols from the barrel', () => {
    // Type-level: these imports succeed only if the barrel re-exports the names.
    const _entityKey: import('../../src/index.ts').EntityKey = 'id';
    const _pageResult: import('../../src/index.ts').PageResult = { rows: [], nextCursor: null };
    const _cursorPayload: import('../../src/index.ts').CursorPayload = {
      keyValues: [1],
      sortFingerprint: 'a:asc',
    };
    expect(typeof common.encodeCursor).toBe('function');
    expect(typeof common.decodeCursor).toBe('function');
    expect(typeof common.keysetPredicate).toBe('function');
    expect(_entityKey).toBe('id');
    expect(_pageResult.rows).toEqual([]);
    expect(_cursorPayload.keyValues).toEqual([1]);
  });
});
