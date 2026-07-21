/**
 * Fake OTel instrumentation and dynamic-import map for testing.
 *
 * @module
 * @since 0.24.1
 */

/**
 * Records calls made to a fake instrumentation.
 */
export interface RecordedInstrumentationCall {
  type: 'setTracerProvider' | 'enable' | 'disable' | 'setConfig';
  args: unknown[];
}

/**
 * Creates a fake OTel Instrumentation instance that records all calls.
 */
export function createFakeInstrumentation(): FakeInstrumentation {
  const recordedCalls: RecordedInstrumentationCall[] = [];

  return {
    recordedCalls,

    instance: {
      setTracerProvider(provider: unknown) {
        recordedCalls.push({ type: 'setTracerProvider', args: [provider] });
      },
      setMeterProvider(_meter: unknown) {
        // Intentionally no-op for the fake.
      },
      enable() {
        recordedCalls.push({ type: 'enable', args: [] });
      },
      disable() {
        recordedCalls.push({ type: 'disable', args: [] });
      },
      setConfig(config: Record<string, unknown>) {
        recordedCalls.push({ type: 'setConfig', args: [config] });
      },
    } as unknown as FakeInstrumentationInstance,
  };
}

/**
 * A fake OTel instrumentation instance shape.
 */
export interface FakeInstrumentationInstance {
  setTracerProvider?(provider: unknown): void;
  setMeterProvider?(meter: unknown): void;
  enable?(): void;
  disable?(): void;
  setConfig?(config: Record<string, unknown>): void;
}

/**
 * A fake instrumentation that records calls and can be configured to throw.
 */
export interface FakeInstrumentation {
  recordedCalls: RecordedInstrumentationCall[];
  instance: FakeInstrumentationInstance;
}

/**
 * Fake dynamic-import map keyed by specifier.
 */
export interface FakeDynamicImportMap {
  imports: Map<string, Record<string, unknown>>;
  resolve(specifier: string): Record<string, unknown>;
  register(specifier: string, mod: Record<string, unknown>): void;
}

/**
 * Creates a fake dynamic-import map keyed by specifier.
 *
 * Usage: pass the returned map's `resolve` function to a fake loader seam
 * to simulate which npm package resolves to which constructor.
 */
export function createFakeDynamicImportMap(): FakeDynamicImportMap {
  const imports: Map<string, Record<string, unknown>> = new Map();

  return {
    imports,

    /**
     * Resolves a specifier to its fake module map.
     * @throws if the specifier is not registered.
     */
    resolve(specifier: string): Record<string, unknown> {
      const mod = imports.get(specifier);
      if (!mod) {
        throw new Error(`Fake import not registered for: ${specifier}`);
      }
      return mod;
    },

    /**
     * Registers a fake module for a given specifier.
     */
    register(specifier: string, mod: Record<string, unknown>): void {
      imports.set(specifier, mod);
    },
  };
}
