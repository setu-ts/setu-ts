import type { Constructor } from '@setu-ts/common';
import { GreetingModule } from './greeting/greeting.module.ts';
import { LifetimesModule } from './lifetimes/lifetimes.module.ts';

/** Every feature module, for `DecoratorPlugin({ modules })`. */
export const MODULES: readonly Constructor[] = [GreetingModule, LifetimesModule];
