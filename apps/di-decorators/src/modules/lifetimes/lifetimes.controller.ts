import { CAPABILITIES } from '@setu-ts/common';
import type { IContainer } from '@setu-ts/common';
import { Controller, Get, Inject } from '@setu-ts/decorator-plugin';
import { SCOPED_REPORT, SINGLETON_REPORT } from './lifetimes.services.ts';

/** What `GET /lifetimes` reports about the two services' instances. */
export interface LifetimesReport {
  readonly singletonShared: boolean;
  readonly scopeRetainsInstance: boolean;
  readonly scopesAreDistinct: boolean;
}

/**
 * Compares service instances across two DI scopes.
 *
 * The framework does not open a scope per request, so this controller creates
 * both scopes itself.
 */
@Controller('/lifetimes')
@Inject(CAPABILITIES.DI_CONTAINER)
export class LifetimesController {
  constructor(private readonly container: IContainer) {}

  @Get('/')
  report(): LifetimesReport {
    const first = this.container.createScope();
    const second = this.container.createScope();
    const scoped = first.resolve(SCOPED_REPORT);
    return {
      singletonShared: first.resolve(SINGLETON_REPORT) === second.resolve(SINGLETON_REPORT),
      scopeRetainsInstance: scoped === first.resolve(SCOPED_REPORT),
      scopesAreDistinct: scoped !== second.resolve(SCOPED_REPORT),
    };
  }
}
