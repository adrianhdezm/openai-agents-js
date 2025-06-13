import {
  TracingExporter,
  BatchTraceProcessor,
  setTraceProcessors,
} from './tracing';
import type { Span } from './tracing/spans';
import type { Trace } from './tracing/traces';
import { getLogger } from './logger';

const logger = getLogger('openai-agents:otlp');

export type OTLPTracingExporterOptions = {
  endpoint: string;
  headers: Record<string, string>;
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
};

function timeToNano(time: string | null | undefined): number | undefined {
  if (!time) return undefined;
  return Date.parse(time) * 1e6;
}

function spanDataToAttributes(data: Record<string, any> | undefined) {
  if (!data) return [] as any[];
  return Object.entries(data).map(([key, value]) => ({
    key,
    value: { stringValue: String(value) },
  }));
}

function toOtlpSpan(item: Trace | Span<any>): any | null {
  const json = item.toJSON() as any;
  if (!json) return null;
  if (json.object === 'trace') {
    return null; // traces are not exported separately
  }
  return {
    traceId: json.trace_id,
    spanId: json.id,
    parentSpanId: json.parent_id ?? undefined,
    name: json.span_data?.name ?? 'span',
    startTimeUnixNano: timeToNano(json.started_at),
    endTimeUnixNano: timeToNano(json.ended_at),
    attributes: spanDataToAttributes(json.span_data),
    status: json.error ? { code: 2, message: String(json.error) } : { code: 1 },
  };
}

export class OTLPTracingExporter implements TracingExporter {
  #options: OTLPTracingExporterOptions;

  constructor(options: Partial<OTLPTracingExporterOptions> = {}) {
    this.#options = {
      endpoint: options.endpoint ?? 'http://localhost:4318/v1/traces',
      headers: options.headers ?? {},
      maxRetries: options.maxRetries ?? 3,
      baseDelay: options.baseDelay ?? 1000,
      maxDelay: options.maxDelay ?? 30000,
    };
  }

  async export(
    items: (Trace | Span<any>)[],
    signal?: AbortSignal,
  ): Promise<void> {
    const spans = items.map(toOtlpSpan).filter((s) => !!s);
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans,
            },
          ],
        },
      ],
    };

    let attempts = 0;
    let delay = this.#options.baseDelay;

    while (attempts < this.#options.maxRetries) {
      try {
        const response = await fetch(this.#options.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.#options.headers,
          },
          body: JSON.stringify(payload),
          signal,
        });

        if (response.ok) {
          logger.debug(`Exported ${spans.length} items`);
          return;
        }

        if (response.status >= 400 && response.status < 500) {
          logger.error(
            `[non-fatal] OTLP client error ${response.status}: ${await response.text()}`,
          );
          return;
        }

        logger.warn(
          `[non-fatal] OTLP: server error ${response.status}, retrying.`,
        );
      } catch (error: any) {
        logger.error('[non-fatal] OTLP: request failed: ', error);
      }

      if (signal?.aborted) {
        logger.error('OTLP: request aborted');
        return;
      }

      const sleepTime = delay + Math.random() * 0.1 * delay;
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
      delay = Math.min(delay * 2, this.#options.maxDelay);
      attempts++;
    }

    logger.error(
      `OTLP: failed to export traces after ${this.#options.maxRetries} attempts`,
    );
  }
}

export function setDefaultOTLPTracingExporter(
  options?: Partial<OTLPTracingExporterOptions>,
) {
  const exporter = new OTLPTracingExporter(options);
  const processor = new BatchTraceProcessor(exporter);
  setTraceProcessors([processor]);
}
