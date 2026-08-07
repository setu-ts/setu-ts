# Running the cloud-broker emulators locally

The GCP Pub/Sub and Azure Service Bus backends ship guarded end-to-end suites that run against the
vendors' own local emulators. Neither needs a cloud account, a credential, or a billing profile.

Both suites skip silently when their environment variable is absent, so an ordinary `deno task test`
is unaffected. They are **not** wired into CI — see "Why not CI" below.

## GCP Pub/Sub

Google ships the emulator inside the `gcloud` CLI image. The `@google-cloud/pubsub` SDK honours
`PUBSUB_EMULATOR_HOST` natively and skips authentication entirely when it is set.

```bash
docker run -d --name he-pubsub -p 8085:8085 \
  gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
  gcloud beta emulators pubsub start --project=he-test --host-port=0.0.0.0:8085

PUBSUB_EMULATOR_HOST=localhost:8085 PUBSUB_PROJECT_ID=he-test \
  deno test --allow-all packages/messaging-plugin/test/e2e/pubsub-emulator.test.ts

docker rm -f he-pubsub
```

The suite creates and deletes its own topics, suffixed per run, so repeated runs never share state.

**What it proves that a fake cannot:** delivery through the real gRPC streaming pull into the
`on('message')` bridge; that a handler throw reaches the platform as a `nack` and produces a genuine
redelivery; and that the RPC reply inbox's `topic.createSubscription` / `subscription.delete()` pair
behaves as the design assumes — asserted by listing subscriptions on the reply topic while the
broker is up and again after `stop()`.

## Azure Service Bus

Microsoft's emulator is config-driven and needs a SQL Edge sidecar. Entities come from a mounted
`Config.json`; the emulator creates nothing at runtime.

```bash
docker network create he-sbnet

docker run -d --name he-sqledge --network he-sbnet \
  -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='<strong-password>' \
  mcr.microsoft.com/azure-sql-edge:latest
sleep 25

docker run -d --name he-sb --network he-sbnet -p 5672:5672 \
  -v "$PWD/docs/fixtures/servicebus-emulator-config.json:/ServiceBus_Emulator/ConfigFiles/Config.json" \
  -e ACCEPT_EULA=Y -e SQL_SERVER=he-sqledge -e MSSQL_SA_PASSWORD='<strong-password>' \
  mcr.microsoft.com/azure-messaging/servicebus-emulator:latest
sleep 30

SERVICEBUS_CONNECTION_STRING='Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;' \
  deno test --allow-all packages/messaging-plugin/test/e2e/service-bus-emulator.test.ts

docker rm -f he-sb he-sqledge && docker network rm he-sbnet
```

**What it proves that a fake cannot:** that `createReceiver(topicName, subscriptionName)` with
`autoCompleteMessages: false` really hands settlement to the receiver, that `completeMessage` and
`abandonMessage` reach the service (an abandon produces a real redelivery), and that the AMQP
receiver-link teardown works against a live connection.

**Two emulator behaviours shaped the suite, and both are properties of the broker rather than
defects.** A Service Bus subscription accrues every message published to its topic whether or not a
receiver is attached, so each case takes its own topic — sharing one lets an earlier case's message
arrive in a later one. And competing receivers on a single subscription share messages between them,
so each case stops its app before the next starts.

**The emulator supports no management operations.**
`ServiceBusAdministrationClient.createSubscription` fails against it with a `RestError`, so RPC
cannot be round-tripped there — the reply inbox needs a per-instance subscription. That limitation
is itself useful: it is the one place the inbox's failure path can be driven against a real broker,
and the suite asserts it surfaces `ReplyInboxUnavailableError` naming the reply topic and the
`Manage` right. **Service Bus RPC remains unverified against real Azure.**

## AWS SQS

`packages/queue-plugin/test/e2e/sqs-elasticmq.test.ts` runs against ElasticMQ and **is** wired into
CI. See `.github/workflows/ci.yml`.

```bash
docker run -d --name he-elasticmq -p 9324:9324 softwaremill/elasticmq-native:1.7.1
SQS_ENDPOINT_URL=http://localhost:9324 deno task test
docker rm -f he-elasticmq
```

## Why not CI

ElasticMQ is one container with no credentials and no licence, so it earns its place in the
workflow. The other two do not, for different reasons: the Pub/Sub emulator image carries the whole
`gcloud` SDK, and the Service Bus emulator needs a EULA acceptance plus a SQL Edge sidecar and a
mounted config file — two multi-container additions for backends whose logic is a thin translation
over a pure, fully unit-tested adapter. Running them locally before a release is the intended
workflow.
