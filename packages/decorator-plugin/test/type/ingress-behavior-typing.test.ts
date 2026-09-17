import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IIngressBehavior, IPipelineBehavior } from '@setu-ts/common';

import {
  CommandHandler,
  Processor,
  UseIngressBehaviors,
  UsePipelineBehaviors,
} from '../../src/index.ts';

const ingress: IIngressBehavior = { handle: async (_context, next) => await next() };
const pipeline: IPipelineBehavior = { handle: async (_request, next) => await next() };

describe('typed ingress behavior decorators', () => {
  it('accepts each behavior at its matching decorator factory', () => {
    class Handlers {
      @Processor('job')
      @UseIngressBehaviors(ingress)
      process(): void {}

      @CommandHandler('command')
      @UsePipelineBehaviors(pipeline)
      command(): void {}
    }
    expect(typeof Handlers).toBe('function');
  });

  it('rejects the other behavior interface at the decorator call site', () => {
    class Handlers {
      @Processor('job')
      // @ts-expect-error A CQRS pipeline behavior cannot be an ingress behavior.
      @UseIngressBehaviors(pipeline)
      process(): void {}

      @CommandHandler('command')
      // @ts-expect-error An ingress behavior cannot be a CQRS pipeline behavior.
      @UsePipelineBehaviors(ingress)
      command(): void {}
    }
    expect(typeof Handlers).toBe('function');
  });
});
