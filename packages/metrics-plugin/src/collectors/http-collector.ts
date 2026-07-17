/**
 * HTTP metrics collector and middleware.
 *
 * @module
 */
import type {
  ICounter,
  IGauge,
  IHistogram,
  IRequestContext,
  IRuntimeServices,
  MetricOptions,
  NextFunction,
} from '@hono-enterprise/common';
import type { MetricsService } from '../services/metrics-service.ts';

/**
 * Priority constant for metrics middleware (outermost, just inside error-handler).
 */
export const MIDDLEWARE_PRIORITY = {
  METRICS: 20,
} as const;

/**
 * Built-in HTTP metric names.
 */
export const HTTP_METRICS = {
  DURATION: 'http_request_duration_seconds',
  REQUESTS: 'http_requests_total',
  ERRORS: 'http_request_errors_total',
  ACTIVE: 'http_active_requests',
} as const;

/**
 * HTTP metrics collector — registers and tracks HTTP request metrics.
 */
export class HttpCollector {
  readonly #metricsService: MetricsService;
  readonly #runtime: IRuntimeServices;

  // Metric instances
  #durationHistogram?: IHistogram;
  #requestsCounter?: ICounter;
  #errorsCounter?: ICounter;
  #activeGauge?: IGauge;

  readonly #durationOptions: MetricOptions;
  readonly #requestsOptions: MetricOptions;
  readonly #errorsOptions: MetricOptions;
  readonly #activeOptions: MetricOptions;

  /**
   * Creates the HTTP collector.
   *
   * @param metricsService - The metrics service
   * @param runtime - The runtime services
   * @param options - Collector options
   */
  constructor(
    metricsService: MetricsService,
    runtime: IRuntimeServices,
    options?: {
      readonly durationBuckets?: readonly number[];
      readonly durationLabels?: readonly string[];
      readonly requestsLabels?: readonly string[];
    },
  ) {
    this.#metricsService = metricsService;
    this.#runtime = runtime;

    const durationLabels = options?.durationLabels ?? ['method', 'status'];
    const requestsLabels = options?.requestsLabels ?? ['method', 'status'];

    this.#durationOptions = {
      help: 'HTTP request duration in seconds',
      labels: durationLabels as readonly string[],
      buckets: options?.durationBuckets ??
        [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    };

    this.#requestsOptions = {
      help: 'Total HTTP requests',
      labels: requestsLabels as readonly string[],
    };

    this.#errorsOptions = {
      help: 'Total HTTP request errors (5xx)',
      labels: requestsLabels as readonly string[],
    };

    this.#activeOptions = {
      help: 'Active HTTP requests',
    };
  }

  /**
   * Registers the HTTP metrics.
   */
  register(): void {
    this.#durationHistogram = this.#metricsService.histogram(
      HTTP_METRICS.DURATION,
      this.#durationOptions,
    );
    this.#requestsCounter = this.#metricsService.counter(
      HTTP_METRICS.REQUESTS,
      this.#requestsOptions,
    );
    this.#errorsCounter = this.#metricsService.counter(HTTP_METRICS.ERRORS, this.#errorsOptions);
    this.#activeGauge = this.#metricsService.gauge(HTTP_METRICS.ACTIVE, this.#activeOptions);
  }

  /**
   * Creates the metrics middleware.
   *
   * This middleware:
   * - Wraps the request in try/catch/finally
   * - Increments active requests gauge before next()
   * - Records duration and request count in finally
   * - Records errors in catch and rethrows
   *
   * @param ctx - The request context
   * @param next - The next handler
   */
  async middleware(ctx: IRequestContext, next: NextFunction): Promise<void> {
    const start = this.#runtime.hrtime();
    let errorOccurred = false;

    // Increment active requests
    this.#activeGauge?.inc(1);

    try {
      await next();
    } catch (error) {
      errorOccurred = true;
      // Record error (status 500)
      const status = '500';
      const method = ctx.request.method;

      this.#errorsCounter?.inc(1, { method, status });
      this.#requestsCounter?.inc(1, { method, status });

      const duration = (this.#runtime.hrtime() - start) / 1000;
      this.#durationHistogram?.observe(duration, { method, status });

      // Rethrow to preserve error handling
      throw error;
    } finally {
      // Always record duration and request count for non-error paths
      if (!errorOccurred) {
        const status = ctx.response.snapshot().status?.toString() ?? '500';
        const method = ctx.request.method;

        // Decrement active requests
        this.#activeGauge?.dec(1);

        const duration = (this.#runtime.hrtime() - start) / 1000;
        this.#durationHistogram?.observe(duration, { method, status });
        this.#requestsCounter?.inc(1, { method, status });

        // Record errors for 5xx responses
        if (parseInt(status, 10) >= 500) {
          this.#errorsCounter?.inc(1, { method, status });
        }
      } else {
        // Decrement active requests even on error
        this.#activeGauge?.dec(1);
      }
    }
  }
}
