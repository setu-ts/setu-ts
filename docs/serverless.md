# Serverless: AWS Lambda and Azure Functions

Setu-TS has no Lambda or Azure Functions adapter package, and these recipes do not need one. A Setu
application already answers web-standard requests through `app.fetch(request)`, and `app.start()`
without a port boots it without opening a socket. Each recipe below is the glue between that and one
platform. All three were run as written against the published `0.10.0` packages: the Web Functions
entry under Node 24, the classic Lambda entry in AWS's Lambda base image
(`public.ecr.aws/lambda/nodejs:24`) with events from `sam local generate-event`, and the Azure entry
on the Functions host started by Azure Functions Core Tools 4.16, with Azurite and the Azure Service
Bus emulator.

The recipes cover HTTP and the one pattern every non-HTTP trigger needs: a booted application your
handler can use. They deliberately stop there. Typed events, partial-batch helpers and idempotency
for Lambda handlers are what [Powertools for AWS Lambda][powertools] and [Middy][middy] are for, and
Azure's own Node programming model already registers typed triggers. Use them alongside Setu rather
than expecting Setu to wrap them.

## Contents

- [Which shape to choose](#which-shape-to-choose)
- [AWS Lambda Web Functions](#aws-lambda-web-functions)
- [Classic AWS Lambda](#classic-aws-lambda)
- [Azure Functions](#azure-functions)
- [What needs a process that stays alive](#what-needs-a-process-that-stays-alive)
- [Testing locally](#testing-locally)
- [What these recipes do not cover](#what-these-recipes-do-not-cover)

## Which shape to choose

|                        | Lambda Web Functions              | Classic Lambda                            | Azure Functions                                  |
| ---------------------- | --------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| How requests arrive    | Your Node server, on a local port | An event, converted by `@hono/aws-lambda` | An invocation, converted by a catch-all function |
| Queue and timer events | No — HTTP only                    | Yes, as separate handlers                 | Yes, as separate functions                       |
| Client address         | Last `X-Forwarded-For` entry      | The event's source IP                     | Not documented by Microsoft                      |
| WebSocket plugin       | No (`Upgrade` is stripped)        | No                                        | No                                               |
| Runtime                | `nodejs24.x`, Arm64 only          | `nodejs22.x`, `nodejs24.x`                | Node 22, Node 24                                 |

A service that only serves HTTP on AWS is simplest on Web Functions: it is the ordinary Node server
with a different port. Anything driven by SQS, EventBridge, S3 or DynamoDB Streams runs on classic
Lambda, which AWS now calls Event Functions. One codebase can deploy both.

If you need WebSockets, long-lived broker consumers or in-process schedules, run the ordinary Node
server in a container instead — on Amazon ECS, Azure Container Apps or App Service — as described in
[Deployment: Docker and Kubernetes](./deployment.md).

## AWS Lambda Web Functions

[Web Functions][web-functions] run your HTTP server as it is. Lambda sets `AWS_LAMBDA_HTTP_ENDPOINT`
to the `host:port` it forwards requests to; your server must be listening there within 10 seconds of
starting.

```typescript
// server.ts
import { createRuntimeServices } from '@setu-ts/runtime';
import { createApp } from './setu.config.ts';

const runtime = createRuntimeServices();
const app = createApp();

// Lambda chooses the address; the fallback applies only to local runs.
const [hostname = '127.0.0.1', port = '3000'] = (
  process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? '127.0.0.1:3000'
).split(':');
await app.start({ port: Number(port), hostname });

// Lambda allows 1 second after SIGTERM, so keep onShutdown hooks short.
runtime.onSignal?.('SIGTERM', () => {
  void app
    .stop()
    .then(() => runtime.exit(0))
    .catch((error: unknown) => {
      console.error('Graceful shutdown failed:', error);
      runtime.exit(1);
    });
});
```

Bundle it to the entry file Lambda loads (`index.js` by default; `AWS_LAMBDA_NODEJS_ENTRYPOINT`
names another):

```bash
npx esbuild server.ts --bundle --platform=node --format=esm --target=node24 --outfile=dist/index.mjs
```

**Shutdown.** Lambda stops routing to an environment and lets in-flight requests finish, on a
best-effort basis, before it sends `SIGTERM`; then it allows one second. `app.stop()` waits only
while requests are still in flight, so with none left it goes straight to your `onStopping` and
`onShutdown` hooks; those are what must fit in the second. In the probe, `stop()` with no hooks
returned in under a millisecond.

**Client address.** The socket peer is Lambda's own forwarder, so `IRequest.ip` is not the client.
Lambda appends the connecting client's address as the last `X-Forwarded-For` value and does not
validate earlier values, which a client can set. Take the rightmost entry:

```typescript
app.register(HttpSecurityPlugin({ ipSecurity: { trustProxy: true, proxyHops: 0 } }));
```

With an Amazon CloudFront distribution in front, the last value is CloudFront's address and the
client is one further left: use `proxyHops: 1`. Lambda forwards `X-Forwarded-Host` from the client
unvalidated, so build absolute links from a configured base URL, as
[Behind a reverse proxy](./deployment.md#behind-a-reverse-proxy) explains.

**Limits at launch.** `nodejs24.x` on Arm64 only, in a subset of Regions; 2 GB of memory per
environment; `Upgrade` is removed from every request, so the WebSocket plugin cannot accept
connections. AWS's [Web Functions documentation][web-functions] has the current list.

## Classic AWS Lambda

### HTTP

API Gateway (REST and HTTP APIs), Function URLs, Application Load Balancers and VPC Lattice deliver
requests as events. [`@hono/aws-lambda`][hono-lambda] converts each event to a web `Request` and the
`Response` back — payload formats 1.0 and 2.0, base64 bodies, and cookies in the shape each format
needs — so the recipe hands the request straight to `app.fetch`:

```typescript
// lambda.ts
import { getConnInfo, handle } from '@hono/aws-lambda';
import { Hono } from 'hono';
import { createApp } from './setu.config.ts';

// Boot once per execution environment, during Lambda's init phase. No port: nothing listens.
const app = createApp();
await app.start();

const hono = new Hono();
hono.all('*', (c) => {
  // The event's source IP, written over any client-sent copy of the header.
  const request = new Request(c.req.raw);
  request.headers.set('x-client-ip', getConnInfo(c).remote.address ?? '');
  return app.fetch(request);
});

/** API Gateway (REST and HTTP APIs), Function URLs, ALB and VPC Lattice. */
export const http = handle(hono);
```

Install `hono` and `@hono/aws-lambda` as dependencies of the application. Bundle as an ES module so
the top-level `await` runs in Lambda's init phase, and set the function's handler to `lambda.http`:

```bash
npx esbuild lambda.ts --bundle --platform=node --format=esm --target=node24 --outfile=dist/lambda.mjs
```

In the probe the application booted once, in 133 ms of init, and every later invocation reused it.

**Client address.** There is no socket, so `IRequest.ip` is absent. The event carries the caller's
address — `requestContext.identity.sourceIp` in payload 1.0, `requestContext.http.sourceIp` in 2.0,
the last `X-Forwarded-For` entry behind an ALB — and `getConnInfo` reads the right one. The handler
above writes it into `x-client-ip`, replacing any value the client sent, and IP security reads that
header:

```typescript
app.register(HttpSecurityPlugin({ ipSecurity: { trustProxy: true, ipHeader: 'x-client-ip' } }));
```

A client-sent `x-client-ip: 6.6.6.6` was replaced by the event's address in every payload format.

### Queues, schedules and other events

Every non-HTTP event source calls a handler with an event; it needs the same booted application. Add
handlers to the same module, so the application in `lambda.ts` serves them, and deploy each as its
own function (`lambda.sqs` below):

```typescript
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';

/** An SQS event source; report failures per message, so one bad message does not fail the batch. */
export async function sqs(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      await handleOrder(app, JSON.parse(record.body)); // your code, using app.services
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
```

Enable `ReportBatchItemFailures` on the event source mapping; without it Lambda ignores the response
and retries the whole batch. Powertools' [batch processing][powertools-batch] does the same with
Kinesis and DynamoDB Streams support, and its [idempotency][powertools-idempotency] utility guards a
handler that a redelivery can run twice. EventBridge Scheduler, SNS and S3 events are plain JSON
handed to a handler of the same shape. (`@types/aws-lambda` provides the event types.)

`queue-plugin`'s `SqsQueue` and the scheduler plugin are not involved: on Lambda the platform
delivers the message and runs the schedule, so your handler calls application code directly. See
[What needs a process that stays alive](#what-needs-a-process-that-stays-alive).

## Azure Functions

The Node.js v4 programming model (`@azure/functions` 4.x) builds a web `Request` internally, so the
HTTP side is a catch-all route that passes the request to `app.fetch`. The one part that is not a
one-line conversion is cookies.

```typescript
// src/functions.ts
import { app as functions } from '@azure/functions';
import type { Cookie, HttpRequest, HttpResponseInit } from '@azure/functions';
import { createApp } from './setu.config.ts';

// Uncomment to stream response bodies instead of buffering them (app-wide; Functions host 4.28+).
// functions.setup({ enableHttpStream: true });

// Boot once per worker process. No port: nothing listens.
const app = createApp();
const ready = app.start();

functions.http('setu', {
  route: '{*path}',
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request: HttpRequest): Promise<HttpResponseInit> => {
    await ready;
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const response = await app.fetch(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: hasBody ? request.body : null,
        duplex: 'half',
      } as RequestInit),
    );
    return toAzureResponse(response);
  },
});

/**
 * Azure keeps only the last of several Set-Cookie headers, so cookies travel in `cookies`.
 * Azure percent-encodes each value again; decoding first sends the value exactly as written.
 */
function toAzureResponse(response: Response): HttpResponseInit {
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  const cookies = response.headers.getSetCookie().map(toAzureCookie);
  return { status: response.status, headers, body: response.body, cookies };
}

function toAzureCookie(line: string): Cookie {
  const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
  const separator = pair.indexOf('=');
  const cookie: Cookie = {
    name: pair.slice(0, separator),
    value: decodeValue(pair.slice(separator + 1)),
  };
  for (const attribute of attributes) {
    const [key = '', value = ''] = attribute.split('=');
    switch (key.toLowerCase()) {
      case 'path':
        cookie.path = value;
        break;
      case 'domain':
        cookie.domain = value;
        break;
      case 'max-age':
        cookie.maxAge = Number(value);
        break;
      case 'expires':
        cookie.expires = new Date(value);
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        cookie.sameSite = sameSiteOf(value);
        break;
      // Partitioned and Priority have no field in Azure's Cookie type and are dropped.
    }
  }
  return cookie;
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sameSiteOf(value: string): Cookie['sameSite'] {
  const lower = value.toLowerCase();
  return lower === 'strict' ? 'Strict' : lower === 'none' ? 'None' : 'Lax';
}
```

Clear the default `api` route prefix in `host.json`, or every path gains `/api`. The extension
bundle provides the Storage Queue and Service Bus triggers:

```json
{
  "version": "2.0",
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  },
  "extensions": { "http": { "routePrefix": "" } }
}
```

Bundle `src/functions.ts` and point `main` in `package.json` at the output. Keep `@azure/functions`
external and deploy it in `node_modules`; that is the configuration these recipes were run with.

```bash
npx esbuild src/functions.ts --bundle --platform=node --format=esm --target=node24 --external:@azure/functions --outfile=dist/functions.mjs
```

**Why cookies need `toAzureResponse`.** Returning the `Response`, or its headers, works for
everything except `Set-Cookie`: measured on the Functions host, two `Set-Cookie` headers reached the
client as one — the last — in both buffered and streaming mode, which silently loses a session or
refresh cookie. The `cookies` field carries each separately, but Azure serializes it with
`encodeURIComponent`, so a value Setu had already encoded (`s%3A…`) arrived double-encoded
(`s%253A…`) until the value was decoded first. Setu writes cookie values with `encodeURIComponent`
and reads them with `decodeURIComponent`, so the round trip is exact. `Partitioned` and `Priority`
cannot be expressed in Azure's `Cookie` type and are lost.

**Client address.** There is no socket, so `IRequest.ip` is absent. Azure's front end adds client
addresses in `X-Forwarded-For` and `X-Client-IP`, but Microsoft does not document either as a
contract. Inspect what your deployment receives before you configure IP security to trust one; until
then, treat the address as unknown rather than reading a header a client can set.

### Timers and queues

Register other triggers with Azure's own functions, using the same booted application:

```typescript
functions.timer('nightly-report', {
  schedule: '0 0 2 * * *', // NCRONTAB: six fields, seconds first
  handler: async () => {
    await ready;
    await buildNightlyReport(app); // your code, using app.services
  },
});

functions.serviceBusQueue('orders', {
  queueName: 'orders',
  connection: 'ServiceBusConnection',
  cardinality: 'many',
  handler: async (messages: unknown[]) => {
    await ready;
    for (const message of messages) await handleOrder(app, message);
  },
});
```

Measured against the Service Bus emulator, a handler that throws fails the **whole batch**: with
`MaxDeliveryCount` 3, a batch of one good and one bad message was delivered three times and both
messages were dead-lettered. To settle messages one at a time, use Azure's [per-message
settlement][sb-settlement] (`sdkBinding: true`, in preview), or receive one message per invocation.
A Storage Queue trigger receives one message per invocation; a message that keeps failing was
retried five times and then moved to `<queue>-poison`.

## What needs a process that stays alive

Classic Lambda freezes the process between invocations. Web Functions and Azure Functions reuse a
process across requests, but can remove it at any time, and neither documents whether timers run
while it is idle. So anything the framework does on its own schedule is unreliable on all three:

| Capability                            | Where it runs                                                                                                  | Serverless replacement                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Queue processing                      | `queue-plugin` polls on an interval                                                                            | An SQS event source; a Storage Queue or Service Bus trigger         |
| Scheduled and recurring jobs          | `scheduler-plugin` timers; `queue-plugin` recurring jobs                                                       | EventBridge Scheduler; a timer trigger                              |
| Outbox relay                          | A `scheduler-plugin` job registered by `messaging-plugin`                                                      | Run the relay from a scheduled handler                              |
| Broker subscriptions                  | `messaging-plugin` consumers hold a broker connection                                                          | The broker's event source or trigger, calling your handler          |
| WebSocket, SSE, GraphQL subscriptions | Long-lived connections with heartbeats                                                                         | A container, or a managed realtime service                          |
| Background refresh                    | Feature-flag database polling, DNS service discovery, diagnostics collectors, the memory session store's sweep | None needed, but expect gaps: each runs only while the process does |

Everything a request does inside its own lifetime — routing, middleware, validation, database and
cache calls, authentication, publishing a message — works as it does on a server.

## Testing locally

None of these needs a cloud account.

- **Web Functions:** run the entry with `AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000` set.
- **Classic Lambda:** AWS's base image includes the Runtime Interface Emulator. Mount the bundle,
  name the handler, and POST an event:

  ```bash
  docker run -p 9000:8080 -v ./dist:/var/task:ro public.ecr.aws/lambda/nodejs:24 lambda.http
  ```

  ```bash
  sam local generate-event apigateway http-api-proxy > event.json
  ```

  ```bash
  curl localhost:9000/2015-03-31/functions/function/invocations -d @event.json
  ```

  `sam local generate-event` also writes SQS, EventBridge, S3 and ALB events. The emulator does not
  stream responses, and nothing local runs SQS's own delivery — batching, visibility timeouts and
  redrive to a dead-letter queue need AWS itself. LocalStack, which emulates them, now requires an
  account token even on its free plan.

- **Azure Functions:** `npm install -g azure-functions-core-tools@4` provides `func start`, which
  runs the real Functions host. Non-HTTP triggers need `AzureWebJobsStorage`; point it at
  [Azurite][azurite]. The [Service Bus emulator][sb-emulator] runs Service Bus triggers locally (it
  needs Azure SQL Edge beside it, and both require accepting Microsoft's licence terms). Fire a
  timer on demand with `POST http://localhost:7071/admin/functions/<name>` and a body of
  `{"input":""}`.

## What these recipes do not cover

- **Measured locally only.** The client-address headers are as AWS documents them and as the event
  samples carry them; they were not observed on a deployed API Gateway, ALB or Azure front end.
- **Response streaming on classic Lambda.** `@hono/aws-lambda` provides `streamHandle` for Function
  URLs and API Gateway streaming; it was not exercised here.
- **No CLI target.** `setu new --runtime` does not offer Lambda or Azure Functions; start from a
  Node project and add the entry file.

[powertools]: https://docs.aws.amazon.com/powertools/typescript/latest/
[powertools-batch]: https://docs.aws.amazon.com/powertools/typescript/latest/features/batch/
[powertools-idempotency]:
  https://docs.aws.amazon.com/powertools/typescript/latest/features/idempotency/
[middy]: https://middy.js.org/
[web-functions]: https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html
[hono-lambda]: https://hono.dev/docs/getting-started/aws-lambda
[sb-settlement]: https://devblogs.microsoft.com/azure-sdk/per-message-settlement-azure-service-bus
[azurite]: https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite
[sb-emulator]: https://learn.microsoft.com/en-us/azure/service-bus-messaging/overview-emulator
