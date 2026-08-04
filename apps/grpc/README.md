# gRPC example

This application co-hosts a normal HTTP health route with `GrpcPlugin` and a descriptor-backed Echo
service on one application. The readable `service.proto` accompanies the committed descriptor set;
no code-generation step is required.

```bash
cd apps/grpc
deno task start
```

Its smoke check sends a real Connect JSON RPC through the plugin's interception seam and verifies
the decoded Echo response alongside the ordinary HTTP route.
