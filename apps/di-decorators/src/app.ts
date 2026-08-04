import { CAPABILITIES } from '@hono-enterprise/common';
import type { IContainer } from '@hono-enterprise/common';
import { DecoratorPlugin } from '@hono-enterprise/decorator-plugin';
import { DiPlugin } from '@hono-enterprise/di-plugin';
import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { GreetingController } from './greeting-controller.ts';
import { GreetingService } from './greeting-service.ts';
import { ScopedReportService, SingletonReportService } from './report-service.ts';

/** Builds the decorated-controller and lifetime demonstration application. */
export function createDiDecoratorsApp(): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiPlugin(),
      DecoratorPlugin({
        controllers: [GreetingController],
        services: [GreetingService, SingletonReportService, ScopedReportService],
      }),
    ],
  });
  app.router.get('/lifetimes', (ctx) => {
    const container = ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
    const firstScope = container.createScope();
    const secondScope = container.createScope();
    const singletonA = firstScope.resolve<SingletonReportService>('singleton-report');
    const singletonB = secondScope.resolve<SingletonReportService>('singleton-report');
    const scopedA = firstScope.resolve<ScopedReportService>('scoped-report');
    const scopedAgain = firstScope.resolve<ScopedReportService>('scoped-report');
    const scopedB = secondScope.resolve<ScopedReportService>('scoped-report');
    return ctx.response.json({
      singletonShared: singletonA === singletonB,
      scopeRetainsInstance: scopedA === scopedAgain,
      scopesAreDistinct: scopedA !== scopedB,
    });
  });
  return app;
}
