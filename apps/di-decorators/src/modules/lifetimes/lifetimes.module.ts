import { Module } from '@setu-ts/decorator-plugin';
import { LifetimesController } from './lifetimes.controller.ts';
import { ScopedReportService, SingletonReportService } from './lifetimes.services.ts';

@Module({
  controllers: [LifetimesController],
  providers: [SingletonReportService, ScopedReportService],
})
export class LifetimesModule {}
