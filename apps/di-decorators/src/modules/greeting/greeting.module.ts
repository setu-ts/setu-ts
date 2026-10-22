import { Module } from '@setu-ts/decorator-plugin';
import { GreetingController } from './greeting.controller.ts';
import { GreetingService } from './greeting.service.ts';

@Module({ controllers: [GreetingController], providers: [GreetingService] })
export class GreetingModule {}
