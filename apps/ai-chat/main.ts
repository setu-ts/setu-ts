import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { OpenTelemetry } from '@ai-sdk/otel';
import { trace } from '@opentelemetry/api';
import { registerTelemetry } from 'ai';
import { createRuntimeServices } from '@setu-ts/runtime';
import { createApp } from './setu.config.ts';

const runtime = createRuntimeServices();
const provider = createOpenAICompatible({
  name: 'compatible',
  baseURL: runtime.env['AI_COMPAT_BASE_URL'] ?? 'http://localhost:8080/v1',
  ...(runtime.env['AI_COMPAT_API_KEY'] ? { apiKey: runtime.env['AI_COMPAT_API_KEY'] } : {}),
});
registerTelemetry(new OpenTelemetry({ tracer: trace.getTracer('gen_ai') }));
const endpoint = runtime.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
const app = createApp(
  [
    {
      model: provider.chatModel(runtime.env['AI_COMPAT_MODEL'] ?? 'local'),
      prices: { inputPrice: 1, outputPrice: 1, perMessage: 64, perFile: 8192 },
    },
  ],
  endpoint ? { serviceName: 'ai-chat', exporter: 'otlp', endpoint, registerGlobal: true } : {},
);
await app.start({ port: Number(process.argv[2] ?? 3000) });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  runtime.onSignal?.(signal, () => {
    void app.stop().then(
      () => runtime.exit(0),
      () => runtime.exit(1),
    );
  });
}
