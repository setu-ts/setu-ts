/**
 * `@Policy`, `@Ability` and `@RequirePolicy` record the metadata DecoratorPlugin reads
 * (M110a §3.11): the policy name, each ability and whether it is anonymous,
 * and `@RequirePolicy` requirements in TOP-TO-BOTTOM order (decorators apply bottom-up,
 * so each `@RequirePolicy` prepends).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPrincipal, IRequestContext } from '@setu-ts/common';

import { Ability, Controller, Get, Policy, RequirePolicy } from '../../src/index.ts';
import type { PolicyClassAbility, PolicyClassTarget } from '../../src/index.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

interface Post {
  readonly authorId: string;
}

@Policy('post')
class PostPolicy {
  readonly label = 'not an ability';

  @Ability()
  update(principal: IPrincipal, post: Post | undefined): boolean {
    return post?.authorId === principal.id;
  }

  @Ability({ anonymous: true })
  read(_principal: IPrincipal | null, _post: Post | undefined): boolean {
    return true;
  }

  helper(): boolean {
    return false;
  }
}

const loadPost = (ctx: IRequestContext): Post => ({ authorId: ctx.params.id ?? '' });

@Controller('/posts')
class PostController {
  @Get('/:id')
  @RequirePolicy(PostPolicy, 'read')
  @RequirePolicy(PostPolicy, 'update', loadPost)
  show(): string {
    return 'ok';
  }
}

@Controller('/plain')
class PlainController {
  @Get('/')
  index(): string {
    return 'ok';
  }
}

describe('@Policy and @Ability', () => {
  it('records the policy name and each ability with its anonymous flag', () => {
    const meta = metadataStore.getPolicyClass(PostPolicy);
    expect(meta?.name).toBe('post');
    expect([...(meta?.abilities ?? [])]).toEqual([['update', false], ['read', true]]);
  });

  it('records nothing for a class without either decorator', () => {
    expect(metadataStore.getPolicyClass(PlainController)).toBeUndefined();
  });

  it('records abilities without a name when @Policy is missing', () => {
    class Unnamed {
      @Ability()
      go(): boolean {
        return true;
      }
    }
    const meta = metadataStore.getPolicyClass(Unnamed);
    expect(meta?.name).toBeUndefined();
    expect(meta?.abilities.get('go')).toBe(false);
  });
});

describe('@RequirePolicy', () => {
  it('records requirements top to bottom, with the target only when given', () => {
    const [route] = metadataStore.getRoutesFor(PostController);
    expect(route?.policies).toEqual([
      { policy: PostPolicy, ability: 'read' },
      { policy: PostPolicy, ability: 'update', target: loadPost },
    ]);
  });

  it('leaves an undecorated route without policies', () => {
    const [route] = metadataStore.getRoutesFor(PlainController);
    expect(route !== undefined && 'policies' in route).toBe(false);
  });

  it('types the ability as a method name and the target from its parameter', () => {
    // Compile-time rows: each fails `deno check` if the helper types regress.
    const update: PolicyClassAbility<typeof PostPolicy> = 'update';
    const helper: PolicyClassAbility<typeof PostPolicy> = 'helper';
    // @ts-expect-error -- 'label' is a field, not a method
    const field: PolicyClassAbility<typeof PostPolicy> = 'label';
    const target: PolicyClassTarget<typeof PostPolicy, 'update'> = { authorId: 'a' };
    // @ts-expect-error -- the update ability's target is a Post
    const wrong: PolicyClassTarget<typeof PostPolicy, 'update'> = { id: 1 };
    expect([update, helper, field, target.authorId, typeof wrong]).toEqual([
      'update',
      'helper',
      'label',
      'a',
      'object',
    ]);
  });
});
