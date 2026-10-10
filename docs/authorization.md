# Authorization: Roles, Policies, and Where Attribute Rules Go

Setu-TS has two authorization layers, and they answer different questions.

| Layer                 | Question it answers                                 | Contract                      | Token                                 |
| --------------------- | --------------------------------------------------- | ----------------------------- | ------------------------------------- |
| Roles and permissions | "Does this principal hold this role or permission?" | `IAuthorizationService`       | `CAPABILITIES.AUTHORIZATION`          |
| Policies (this guide) | "May this principal do this, **to this target**?"   | `IAuthorizationPolicyService` | `CAPABILITIES.AUTHORIZATION_POLICIES` |

The role layer is synchronous and has no parameter through which a target can reach a decision, so
"the author of this post", "an approver of an amount under their limit", or "a member of the
document's team" has no home there. Policies are that home. Both layers ship in
[`@setu-ts/auth-plugin`](../packages/auth-plugin/README.md); `AuthPlugin` registers the policy
service whether or not you configure roles.

## Does the framework need an attribute (ABAC) engine?

No. Attribute rules are **policies you write**: a policy is a named set of abilities, each an
asynchronous check that receives the principal and the target. ASP.NET Core
(`IAuthorizationService.AuthorizeAsync` with resource handlers), NestJS's policy layer, and Spring's
`PermissionEvaluator` make the same choice — none ships an attribute language; each gives you a
place to put code. If you prefer an external engine (OpenFGA, Casbin, Cerbos), wrap it in a policy:
the check calls the engine, and every entry point below works unchanged.

What policies do **not** give you yet is a role held in one tenant, organisation, or region rather
than everywhere. That is scoped RBAC, built on this layer in a later milestone (M110b).

## Defining a Policy

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, definePolicy, requirePolicy } from '@setu-ts/auth-plugin';

interface Post {
  readonly id: string;
  readonly authorId: string;
  readonly published: boolean;
}

const posts = new Map<string, Post>();

const postPolicy = definePolicy({
  name: 'post',
  abilities: {
    // Requires a signed-in principal: an anonymous request is refused 401
    // before this check runs.
    update: (principal, post: Post | undefined) => post?.authorId === principal.id,
    // Opts in to anonymous principals: called with `null` when nobody is signed in.
    read: {
      anonymous: true,
      check: (principal, post: Post | undefined) =>
        post?.published === true || (principal !== null && post?.authorId === principal.id),
    },
  },
  // Runs first, for a signed-in principal: `true` allows every ability,
  // `undefined` falls through to the ability's check, anything else denies.
  before: (principal) => (principal.roles?.includes('admin') === true ? true : undefined),
});

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    AuthPlugin({ jwt: { secret: 'replace-with-a-secret-of-32-chars!' }, policies: [postPolicy] }),
  ],
});

app.router.patch('/posts/:id', {
  // The third argument is the target: a value, or an extractor called per
  // request. An extractor answering `undefined` (not found) is allowed — the
  // check receives `undefined` and decides.
  middleware: [requirePolicy(postPolicy, 'update', (ctx) => posts.get(ctx.params.id ?? ''))],
  handler: (ctx) => ctx.response.json({ updated: ctx.params.id }),
});

await app.start();
```

`definePolicy` infers the ability names from the object, so `requirePolicy(postPolicy, 'updaet')` is
a compile error. It infers the target type from an annotated check parameter
(`post: Post |
undefined` above).

## The Rules Are Fixed

These are not options. Each is the same for the route guard, the decorator, and the imperative
calls, because all four reach one evaluator.

| Situation                                                      | Outcome                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The check returns `true` (or a promise of `true`)              | Allowed                                                                |
| The check returns anything else — `false`, `1`, `'yes'`, `{}`  | Denied                                                                 |
| The check or `before` throws or rejects                        | Denied, and reported once to the logger (never the target)             |
| No principal, and the ability is not `anonymous`               | Denied `401`, the check is not called                                  |
| `before` returns `true` / `undefined` / anything else          | Allowed / falls through to the check / denied (`null` denies)          |
| Denied, no principal                                           | `401 Unauthorized`, "Authentication required"                          |
| Denied, signed-in principal                                    | `403 Forbidden`, "Insufficient privileges" — the policy is never named |
| No `AuthPlugin` registered                                     | `501 Not Implemented` — the route is never served unguarded            |
| A route guard names a policy or ability that is not registered | `app.start()` fails, naming the route, policy, and ability             |
| An imperative call names an unknown policy or ability          | The call rejects with `UnknownPolicyError`, naming it                  |

The refusal bodies are the same ones `requireRole` writes, in whatever error format you configured.

Two limits are worth knowing. The startup check reads routes registered before `start()`; a route
added afterwards, or a guard added as global middleware, is not checked and fails closed per request
instead. And a policy is identified by its **name**: a guard built from a policy object you forgot
to register, while a different policy with the same name is registered, would evaluate that other
policy — the startup check (and, for `@Can`, `register()`) refuses the case where the two disagree
on which abilities are anonymous. An anonymous request to an ability that needs a principal is
refused before your target extractor runs, so it costs no record lookup and learns nothing from it.

## Checks Inside a Handler

A declarative guard runs before your handler has loaded anything. When the decision needs the record
the handler loads, ask the service directly. `can` answers a boolean — useful for showing or hiding
an edit button — and `authorize` rejects when denied:

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthorizationPolicyService, IRequestContext } from '@setu-ts/common';
import { definePolicy } from '@setu-ts/auth-plugin';

interface Invoice {
  readonly amount: number;
  readonly approverLimit: number;
}

const invoicePolicy = definePolicy({
  name: 'invoice',
  abilities: {
    approve: (_principal, invoice: Invoice | undefined) =>
      invoice !== undefined && invoice.amount <= invoice.approverLimit,
  },
});

export async function approve(ctx: IRequestContext, invoice: Invoice): Promise<void> {
  const policies = ctx.services.get<IAuthorizationPolicyService>(
    CAPABILITIES.AUTHORIZATION_POLICIES,
  );
  const canApprove = await policies.can(
    ctx.request.user ?? null,
    invoicePolicy,
    'approve',
    invoice,
  );
  if (canApprove) {
    // render the approve button, or proceed
  }
  // Rejects with AuthorizationDeniedError when denied.
  await policies.authorize(ctx.request.user ?? null, invoicePolicy, 'approve', invoice);
}
```

`AuthorizationDeniedError` carries an HTTP status hint, so with
[`errorHandler`](../packages/exceptions/README.md) installed a denied `authorize` answers exactly
the body a guard's refusal would. Without `errorHandler` it is an ordinary error and the kernel
answers `500`.

## The Class Form

With [`@setu-ts/decorator-plugin`](../packages/decorator-plugin/README.md), a policy can be a class.
It is constructed like a controller, so its constructor can take injected dependencies:

```typescript
import type { IPrincipal } from '@setu-ts/common';
import {
  Ability,
  Can,
  Controller,
  DecoratorPlugin,
  Get,
  Inject,
  Injectable,
  Patch,
  Policy,
} from '@setu-ts/decorator-plugin';

interface Doc {
  readonly id: string;
  readonly ownerId: string;
}

@Injectable({ token: 'doc-store' })
class DocStore {
  readonly #docs = new Map<string, Doc>();
  find(id: string): Doc | undefined {
    return this.#docs.get(id);
  }
}

@Policy('doc')
@Inject('doc-store')
class DocPolicy {
  constructor(private readonly docs: DocStore) {}

  @Ability()
  edit(principal: IPrincipal, doc: Doc | undefined): boolean {
    return doc !== undefined && this.docs.find(doc.id)?.ownerId === principal.id;
  }

  @Ability({ anonymous: true })
  view(_principal: IPrincipal | null, _doc: Doc | undefined): boolean {
    return true;
  }
}

@Controller('/docs')
class DocController {
  @Patch('/:id')
  @Can(DocPolicy, 'edit', (ctx) => ({ id: ctx.params.id ?? '', ownerId: '' }))
  edit(): { readonly saved: boolean } {
    return { saved: true };
  }

  @Get('/:id')
  @Can(DocPolicy, 'view')
  show(): { readonly shown: boolean } {
    return { shown: true };
  }
}

export const decorators = DecoratorPlugin({
  services: [DocStore],
  policies: [DocPolicy],
  controllers: [DocController],
});
```

A method named `before` is the policy's `before` hook. `@Can` also accepts a `definePolicy`
definition, may be repeated (every `@Can` on a route must allow, top to bottom), and runs after
guards and `@Roles`/`@Permissions` but **before** validation — so a target extractor reading the
body sees the unvalidated body; prefer route parameters. Registering `DecoratorPlugin` with `@Can`
routes or `policies` but no `AuthPlugin` fails at startup, naming the route.

## Queues, Messages, and Sockets

There is no policy behaviour for non-HTTP ingress yet: a queue job, a message, or a socket frame
carries no principal, and a check that silently evaluated as anonymous would be worse than none. The
imperative calls work anywhere, because the principal is an argument you supply — derive it from the
payload you trust:

```typescript
import type { IAuthorizationPolicyService, IPrincipal } from '@setu-ts/common';
import { definePolicy } from '@setu-ts/auth-plugin';

interface ExportJob {
  readonly requestedBy: string;
  readonly accountId: string;
}

const accountPolicy = definePolicy({
  name: 'account',
  abilities: { export: (principal, accountId: string | undefined) => principal.id === accountId },
});

export async function handleExport(
  policies: IAuthorizationPolicyService,
  job: ExportJob,
): Promise<void> {
  const principal: IPrincipal = { id: job.requestedBy };
  await policies.authorize(principal, accountPolicy, 'export', job.accountId);
  // …run the export
}
```

## OpenAPI

`requirePolicy` and `@Can` carry the same security brand the role guards do, so
[`OpenApiPlugin({ deriveSecurity })`](../packages/openapi-plugin/README.md) documents a route whose
ability requires a signed-in principal as secured. A route whose ability opted in to anonymous
principals is documented as public (`security: []`), because the guard lets an anonymous request
through.
