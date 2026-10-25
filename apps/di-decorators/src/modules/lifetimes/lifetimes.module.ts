import { Module } from '@setu-ts/decorator-plugin';
import { LifetimesController } from './lifetimes.controller.ts';
import { ScopedReportService, SingletonReportService } from './lifetimes.services.ts';

/**
 * Demonstrates singleton and lazily created HTTP request lifetimes.
 * @since 0.11.0
 */
@Module({
  controllers: [LifetimesController],
  providers: [SingletonReportService, ScopedReportService],
})
export class LifetimesModule {}
