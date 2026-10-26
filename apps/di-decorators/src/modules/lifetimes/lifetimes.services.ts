import type { IRuntimeServices } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { Inject, Injectable } from '@setu-ts/decorator-plugin';

export const SINGLETON_REPORT = 'singleton-report';
export const SCOPED_REPORT = 'scoped-report';

/** One instance for the whole application. */
@Injectable({ scope: 'singleton', token: SINGLETON_REPORT })
export class SingletonReportService {}

/**
 * One instance per lazy request scope.
 * @since 0.11.0
 */
@Injectable({ scope: 'scoped', token: SCOPED_REPORT })
@Inject(CAPABILITIES.RUNTIME)
export class ScopedReportService {
  /**
   * Request service identity.
   * @since 0.11.0
   */
  readonly id: string;
  /**
   * @param runtime - Portable identifier source
   * @since 0.11.0
   */
  constructor(runtime: IRuntimeServices) {
    this.id = runtime.uuid();
  }
}
