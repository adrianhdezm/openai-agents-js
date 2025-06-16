import {
  TracingExporter,
  BatchTraceProcessor,
  setTraceProcessors,
} from './index';
import type { Span } from './spans';
import type { Trace } from './traces';
import { getLogger } from '../logger';

const logger = getLogger('openai-agents:otlp');

export type OTLPHttpExporterOptions = {
  endpoint: string;
  headers: Record<string, string>;
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
};

function timeToNano(time: string | null | undefined): number | undefined {
  return time ? Date.parse(time) * 1e6 : undefined;
}

function otelAttribute(key: string, value: any) {
  if (value === null || value === undefined) return null;
  const val: any = {};
  if (typeof value === 'number') val.doubleValue = value;
  else if (typeof value === 'boolean') val.boolValue = value;
  else val.stringValue = String(value);
  return { key, value: val };
}

function spanDataToAttributes(data: Record<string, any> | undefined) {
  if (!data) return [] as any[];
  return Object.entries(data)
    .map(([key, value]) => otelAttribute(key, value))
    .filter(Boolean);
}

function toOtlpSpan(item: Trace | Span<any>): any | null {
  const json = item.toJSON() as any;
  if (!json || json.object !== 'trace.span') return null;
  const attributes = spanDataToAttributes(json.span_data);
  if (json.error?.message) {
    attributes.push(otelAttribute('error.type', json.error.message));
  }
  return {
    traceId: json.trace_id,
    spanId: json.id,
    parentSpanId: json.parent_id ?? undefined,
    name: json.span_data?.name ?? json.span_data?.type ?? 'span',
    startTimeUnixNano: timeToNano(json.started_at),
    endTimeUnixNano: timeToNano(json.ended_at),
    attributes,
  };
}

export class OTLPHttpExporter implements TracingExporter {
  #options: OTLPHttpExporterOptions;

  constructor(options: Partial<OTLPHttpExporterOptions> = {}) {
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
    const spans = items.map(toOtlpSpan).filter(Boolean);
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

export function setDefaultOTLPHttpExporter(
  options?: Partial<OTLPHttpExporterOptions>,
) {
  const exporter = new OTLPHttpExporter(options);
  const processor = new BatchTraceProcessor(exporter);
  setTraceProcessors([processor]);
}
