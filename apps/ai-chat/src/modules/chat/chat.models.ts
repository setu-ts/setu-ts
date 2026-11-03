import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { OpenTelemetry } from '@ai-sdk/otel';
import { trace } from '@opentelemetry/api';
import { registerTelemetry } from 'ai';
import type { IRuntimeServices } from '@setu-ts/common';
import type { TelemetryPluginOptions } from '@setu-ts/telemetry-plugin';
import type { PricedModel } from './chat.budget.ts';

/**
 * Configures the compatible provider and SDK telemetry from server environment.
 * @param env - Runtime environment; credentials and provider URLs stay server-side
 * @returns Priced models and the existing optional OTLP/global-provider configuration
 */
export function createChatModels(env: IRuntimeServices['env']): {
  models: readonly PricedModel[];
  telemetry: TelemetryPluginOptions;
} {
  const provider = createOpenAICompatible({
    name: 'compatible',
    baseURL: env['AI_COMPAT_BASE_URL'] ?? 'http://localhost:8080/v1',
    includeUsage: true,
    ...(env['AI_COMPAT_API_KEY'] ? { apiKey: env['AI_COMPAT_API_KEY'] } : {}),
  });
  registerTelemetry(new OpenTelemetry({ tracer: trace.getTracer('gen_ai') }));
  const endpoint = env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
  return {
    models: [
      {
        model: provider.chatModel(env['AI_COMPAT_MODEL'] ?? 'local'),
        prices: { inputPrice: 1, outputPrice: 1, perMessage: 64, perFile: 8192 },
      },
    ],
    telemetry: endpoint
      ? { serviceName: 'ai-chat', exporter: 'otlp', endpoint, registerGlobal: true }
      : {},
  };
}
