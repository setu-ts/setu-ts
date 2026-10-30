import type { ContainerToken } from '@setu-ts/common';

/**
 * Internal diagnostic formatting; token identity is never its name.
 *
 * @param token - Identity or name token
 *
 * @returns Its diagnostic name
 *
 * @since 0.11.0
 *
 * @internal
 */
export function tokenName(token: ContainerToken): string {
  return typeof token === 'string' ? token : token.name;
}

/**
 * Internal graph validation record.
 * @since 0.11.0
 */
export interface ValidationFinding {
  readonly kind: 'missing' | 'cycle' | 'captive';
  readonly token: ContainerToken;
  readonly path: readonly ContainerToken[];
}

/**
 * All wiring errors found without constructing providers.
 * @example
 * ```typescript
 * try { container.close(); } catch (error) {
 * if (error instanceof ContainerValidationError) inspect(error.findings);
 * }
 * ```
 *
 * @since 0.11.0
 */
export class ContainerValidationError extends Error {
  /** The missing, cyclic, and captive dependency paths. */
  readonly findings: readonly ValidationFinding[];
  /**
   * @param findings - Every invalid dependency path
   *
   * @since 0.11.0
   */
  constructor(findings: readonly ValidationFinding[]) {
    super(
      findings
        .map(
          (f) =>
            `${f.kind}: ${f.path.map(tokenName).join(' → ')}${f.kind === 'missing' ? ' (No provider registered)' : ''}${f.kind === 'captive' ? '; use @Params(Service(...)) for request services' : ''}`,
        )
        .join('\n'),
    );
    this.name = 'ContainerValidationError';
    this.findings = findings;
  }
}

/**
 * Root resolution reaches a scoped provider or creates a disposable transient
 * outside a singleton dependency graph, requiring an explicit or request scope.
 * @since 0.11.0
 */
export class ScopeRequiredError extends Error {
  /**
   * @param token - The graph requiring a scope requested on the root
   * @since 0.11.0
   */
  constructor(token: ContainerToken) {
    super(`DI token '${tokenName(token)}' requires a scope.`);
    this.name = 'ScopeRequiredError';
  }
}

/**
 * Resolution attempted after disposal.
 * @since 0.11.0
 */
export class ScopeDisposedError extends Error {
  /**
   * @param token - The requested token
   * @since 0.11.0
   */
  constructor(token: ContainerToken) {
    super(`Cannot resolve '${tokenName(token)}': scope is disposed.`);
    this.name = 'ScopeDisposedError';
  }
}

/**
 * Registration attempted after the owner's bootstrap phase.
 * @since 0.11.0
 */
export class ContainerClosedError extends Error {
  /**
   * @param token - The refused token
   * @since 0.11.0
   */
  constructor(token: ContainerToken) {
    super(`Cannot register '${tokenName(token)}': container is closed.`);
    this.name = 'ContainerClosedError';
  }
}

/**
 * A context cannot own and dispose a request scope.
 * @since 0.11.0
 */
export class RequestScopeUnavailableError extends Error {
  /**
   * Creates the actionable missing-cleanup error.
   * @since 0.11.0
   */
  constructor() {
    super(
      'This context cannot dispose a request scope (ctx.defer is absent). Use createTestApp to test request scopes.',
    );
    this.name = 'RequestScopeUnavailableError';
  }
}
