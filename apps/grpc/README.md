# gRPC example

This application co-hosts a normal HTTP health route with `GrpcPlugin` and a descriptor-backed Echo
service on one application. `src/modules/echo/echo.proto` is the readable source of the committed
descriptor set in `echo.descriptor.ts`; no code-generation step is required.

```bash
pnpm --dir apps/grpc run start
```

Its smoke check sends a real Connect JSON RPC through the plugin's interception seam and verifies
the decoded Echo response alongside the ordinary HTTP route.

Read the [example deep dive](../../docs/examples.md#grpc) for the concept and source walkthrough.
