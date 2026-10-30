/** Internal graph validation and direct resolver compilation. */
import type { ContainerToken, InjectEntry } from '@setu-ts/common';
import { CircularDetector } from './circular-detector.ts';
import { ContainerValidationError } from './errors.ts';
import type { ValidationFinding } from './errors.ts';
import type { ExternalResolver } from './container.ts';
import type { ProviderEntry, ProviderRegistry } from './provider-registry.ts';

/**
 * Internal per-container storage, allocated lazily for scoped values.
 * @since 0.11.0
 */
export interface ResolutionScope {
  slots: unknown[] | undefined;
  /** Scope-registered instances, separate from the fixed root slot indexes. @since 0.11.0 */
  localInstances: Map<ProviderEntry, unknown> | undefined;
  readonly root: ResolutionScope;
  track(cleanup: () => void | Promise<void>, token: ContainerToken): void;
}

/**
 * Internal executable graph entry.
 * @since 0.11.0
 */
export interface CompiledEntry {
  readonly requiresScope: boolean;
  /** Whether resolution creates disposable transients outside singletons. @since 0.11.0 */
  readonly createsDisposableTransient: boolean;
  resolve(scope: ResolutionScope): unknown;
}

/** Unwraps only dependency markers, never identity tokens. */
function dependency(entry: InjectEntry): { token: ContainerToken; optional: boolean } {
  return typeof entry === 'object' && 'optional' in entry
    ? { token: entry.token, optional: true }
    : { token: entry, optional: false };
}

/**
 * Internal graph compiler; all validation precedes cache mutation.
 * @since 0.11.0
 */
export class Compiler {
  readonly #registry: ProviderRegistry;
  readonly #external: ExternalResolver | undefined;
  readonly #parent: Compiler | (() => Compiler) | undefined;
  #nextSlot = 0;
  readonly #compiled = new Map<ContainerToken, CompiledEntry>();
  readonly #entries = new Map<ProviderEntry, CompiledEntry>();

  /**
   * @param registry - Provider recipes visible to this owner
   *
   * @param external - Optional lazy singleton leaf resolver
   *
   * @param parent - Ancestor compiler, looked up lazily when scopes can register later
   *
   * @since 0.11.0
   */
  constructor(
    registry: ProviderRegistry,
    external?: ExternalResolver,
    parent?: Compiler | (() => Compiler),
  ) {
    this.#registry = registry;
    this.#external = external;
    this.#parent = parent;
  }

  /**
   * @param token - Token to inspect without instantiation
   *
   * @returns Whether a recipe or external leaf exists
   *
   * @since 0.11.0
   */
  has(token: ContainerToken): boolean {
    return (
      this.#registry.has(token) ||
      (typeof token === 'string' && (this.#external?.has(token) ?? false))
    );
  }

  /**
   * @returns Unchecked factory tokens for bootstrap logging
   * @since 0.11.0
   */
  opaqueTokens(): ContainerToken[] {
    return [...this.#registry.entries()]
      .filter(([, e]) => 'useFactory' in e.provider && e.provider.inject === undefined)
      .map(([t]) => t);
  }

  /**
   * @returns Nothing
   * @throws {ContainerValidationError} With every invalid dependency path
   *
   * @since 0.11.0
   */
  compileAll(): void {
    const tokens = [...this.#registry.entries()].map(([token]) => token);
    this.#validate(tokens);
    for (const token of tokens) this.#build(token);
  }

  /**
   * @param token - Root of the subgraph to compile
   *
   * @returns The direct executable resolver
   * @throws {ContainerValidationError} For invalid dependencies
   *
   * @since 0.11.0
   */
  compile(token: ContainerToken): CompiledEntry {
    const cached = this.#compiled.get(token);
    if (cached !== undefined) return cached;
    const parent = this.#parentCompiler();
    if (parent !== undefined && parent.#registry.has(token)) return parent.compile(token);
    this.#validate([token]);
    return this.#build(token);
  }

  /** Finds a newly materialized ancestor without allocating registries on empty scopes. */
  #parentCompiler(): Compiler | undefined {
    return typeof this.#parent === 'function' ? this.#parent() : this.#parent;
  }

  #validate(tokens: readonly ContainerToken[]): void {
    const findings: ValidationFinding[] = [];
    for (const root of tokens) {
      const detector = new CircularDetector();
      const walk = (
        token: ContainerToken,
        path: readonly ContainerToken[],
        captive: ContainerToken | undefined,
      ): void => {
        const next = [...path, token];
        try {
          detector.enter(token);
        } catch {
          findings.push({ kind: 'cycle', token, path: next.slice(next.indexOf(token)) });
          return;
        }
        try {
          const entry = this.#registry.get(token);
          if (entry === undefined) {
            if (!this.has(token)) findings.push({ kind: 'missing', token, path: next });
            return;
          }
          if (captive !== undefined && entry.scope === 'scoped') {
            findings.push({
              kind: 'captive',
              token: captive,
              path: next.slice(next.indexOf(captive)),
            });
          }
          const owner = entry.scope === 'singleton' ? token : captive;
          const provider = entry.provider;
          if ('useValue' in provider) return;
          for (const inject of provider.inject ?? []) {
            const dep = dependency(inject);
            if (dep.optional && !this.has(dep.token)) continue;
            walk(dep.token, next, owner);
          }
        } finally {
          detector.leave();
        }
      };
      walk(root, [], undefined);
    }
    if (findings.length > 0) throw new ContainerValidationError(findings);
  }

  #build(token: ContainerToken): CompiledEntry {
    const cached = this.#compiled.get(token);
    if (cached !== undefined) return cached;
    const parent = this.#parentCompiler();
    if (parent !== undefined && parent.#registry.has(token)) return parent.compile(token);
    const entry = this.#registry.get(token);
    if (entry === undefined) {
      // Validation already established that this is an external string leaf.
      let created = false;
      let value: unknown;
      const external = this.#external as ExternalResolver;
      const result: CompiledEntry = {
        requiresScope: false,
        createsDisposableTransient: false,
        resolve: () => {
          if (!created) {
            value = external.resolve(token as string);
            created = true;
          }
          return value;
        },
      };
      this.#compiled.set(token, result);
      return result;
    }
    const alias = this.#entries.get(entry);
    if (alias !== undefined) {
      this.#compiled.set(token, alias);
      return alias;
    }
    const provider = entry.provider;
    const deps =
      'useValue' in provider
        ? []
        : (provider.inject ?? []).map((inject) => {
            const dep = dependency(inject);
            return dep.optional && !this.has(dep.token)
              ? {
                  requiresScope: false,
                  createsDisposableTransient: false,
                  resolve: () => undefined,
                }
              : this.#build(dep.token);
          });
    const create = (scope: ResolutionScope): unknown => {
      const args = deps.map((dep) => dep.resolve(scope)) as never[];
      const value =
        'useValue' in provider
          ? provider.useValue
          : 'useClass' in provider
            ? new provider.useClass(...args)
            : provider.useFactory(...args);
      if (entry.dispose !== undefined) {
        const dispose = entry.dispose;
        scope.track(() => dispose(value), token);
      }
      return value;
    };
    const slot = entry.scope === 'scoped' && this.#parent === undefined ? this.#nextSlot++ : -1;
    let created = false;
    let singleton: unknown;
    const result: CompiledEntry = {
      requiresScope: entry.scope === 'scoped' || deps.some((dep) => dep.requiresScope),
      createsDisposableTransient:
        entry.scope !== 'singleton' &&
        ((entry.scope === 'transient' && entry.dispose !== undefined) ||
          deps.some((dep) => dep.createsDisposableTransient)),
      resolve: (scope) => {
        if (entry.scope === 'singleton') {
          if (!created) {
            singleton = create(scope.root);
            created = true;
          }
          return singleton;
        }
        if (entry.scope === 'scoped') {
          if (slot === -1) {
            const instances = (scope.localInstances ??= new Map());
            if (!instances.has(entry)) instances.set(entry, create(scope));
            return instances.get(entry);
          }
          const slots = (scope.slots ??= []);
          if (!(slot in slots)) slots[slot] = create(scope);
          return slots[slot];
        }
        return create(scope);
      },
    };
    this.#compiled.set(token, result);
    this.#entries.set(entry, result);
    return result;
  }
}
