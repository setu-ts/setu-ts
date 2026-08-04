# DI and decorators example

This app combines `DiPlugin` with `DecoratorPlugin`. The decorated controller receives its
`GreetingService` through parameter-level `@Inject('greeting-service')`.

`/lifetimes` visibly calls `container.createScope()`: singleton services are shared across those
scopes, while scoped services are retained inside one scope and differ between scopes. The framework
does **not** create a DI scope per request; applications that need request scoping must create and
carry that scope themselves.

```bash
cd apps/di-decorators
deno task start
deno task smoke
```
