import { CAPABILITIES } from '@setu-ts/common';
import type { IContainer, IRequestContext } from '@setu-ts/common';
import { Controller, Ctx, Get, Inject, Params, Service } from '@setu-ts/decorator-plugin';
import { ScopedReportService, SingletonReportService } from './lifetimes.services.ts';

/**
 * Per-request identity and lifetime comparisons.
 * @since 0.11.0
 */
export interface LifetimesReport {
  readonly singletonShared: boolean;
  readonly scopeRetainsInstance: boolean;
  readonly scopedId: string;
}

/**
 * Demonstrates lazy request scopes through Service and forRequest.
 * @since 0.11.0
 */
@Controller('/lifetimes')
@Inject(CAPABILITIES.DI_CONTAINER)
export class LifetimesController {
  /**
   * @param container - Application container
   * @since 0.11.0
   */
  constructor(private readonly container: IContainer) {}

  /**
   * Compares parameter-injected services with the same request scope.
   *
   * @param scoped - Request-owned service
   *
   * @param singleton - Application-owned service
   *
   * @param ctx - Context owning the scope and its disposal
   *
   * @returns Instance identity comparisons and this request service identifier
   *
   * @since 0.11.0
   */
  @Get('/')
  @Params(Service(ScopedReportService), Service(SingletonReportService), Ctx())
  report(
    scoped: ScopedReportService,
    singleton: SingletonReportService,
    ctx: IRequestContext,
  ): LifetimesReport {
    const scope = this.container.forRequest(ctx);
    return {
      singletonShared: singleton === scope.resolve(SingletonReportService),
      scopeRetainsInstance: scoped === scope.resolve(ScopedReportService),
      scopedId: scoped.id,
    };
  }
}
