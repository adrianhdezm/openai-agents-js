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
  if (!time) return undefined;
  return Date.parse(time) * 1e6;
}

function otelAttribute(key: string, value: any) {
  if (value === null || value === undefined) {
    return null;
  }
  const val: any = {};
  if (typeof value === 'number') {
    val.doubleValue = value;
  } else if (typeof value === 'boolean') {
    val.boolValue = value;
  } else {
    val.stringValue = String(value);
  }
  return { key, value: val };
}

function spanDataToAttributes(data: Record<string, any> | undefined) {
  if (!data) return [] as any[];
  return Object.entries(data)
    .map(([key, value]) => otelAttribute(key, value))
    .filter((a) => a !== null);
}

function guessOutputType(output: any[]): string | undefined {
  if (!output || output.length === 0) return undefined;
  const first = output[0];
  if (first.type === 'message' && Array.isArray(first.content)) {
    const c = first.content[0];
    if (!c) return undefined;
    if (c.type === 'output_text') return 'text';
    if (c.type === 'image_url') return 'image';
    if (c.type === 'speech') return 'speech';
  }
  return undefined;
}

function mapGenerationAttributes(data: any) {
  const attrs = [otelAttribute('gen_ai.operation.name', 'generate_content')];
  if (data.model) attrs.push(otelAttribute('gen_ai.request.model', data.model));
  if (data.model_config) {
    const c = data.model_config;
    if (c.temperature !== undefined)
      attrs.push(otelAttribute('gen_ai.request.temperature', c.temperature));
    if (c.top_p !== undefined)
      attrs.push(otelAttribute('gen_ai.request.top_p', c.top_p));
    if (c.top_k !== undefined)
      attrs.push(otelAttribute('gen_ai.request.top_k', c.top_k));
    if (c.frequency_penalty !== undefined)
      attrs.push(
        otelAttribute('gen_ai.request.frequency_penalty', c.frequency_penalty),
      );
    if (c.presence_penalty !== undefined)
      attrs.push(
        otelAttribute('gen_ai.request.presence_penalty', c.presence_penalty),
      );
    if (c.max_tokens !== undefined)
      attrs.push(otelAttribute('gen_ai.request.max_tokens', c.max_tokens));
    if (c.stop_sequences)
      attrs.push(
        otelAttribute('gen_ai.request.stop_sequences', c.stop_sequences),
      );
    if (c.seed !== undefined)
      attrs.push(otelAttribute('gen_ai.request.seed', c.seed));
  }
  if (data.usage) {
    const u = data.usage;
    if (u.inputTokens !== undefined)
      attrs.push(otelAttribute('gen_ai.usage.input_tokens', u.inputTokens));
    if (u.outputTokens !== undefined)
      attrs.push(otelAttribute('gen_ai.usage.output_tokens', u.outputTokens));
  }
  if (data.output) {
    const type = guessOutputType(data.output);
    if (type) attrs.push(otelAttribute('gen_ai.output.type', type));
  }
  return attrs.filter(Boolean);
}

function mapFunctionAttributes(data: any) {
  const attrs = [otelAttribute('gen_ai.operation.name', 'execute_tool')];
  if (data.name) attrs.push(otelAttribute('gen_ai.tool.name', data.name));
  if (data.call_id)
    attrs.push(otelAttribute('gen_ai.tool.call.id', data.call_id));
  if (data.description)
    attrs.push(otelAttribute('gen_ai.tool.description', data.description));
  return attrs.filter(Boolean);
}

function mapAgentAttributes(data: any) {
  const attrs = [otelAttribute('gen_ai.operation.name', 'invoke_agent')];
  if (data.name) attrs.push(otelAttribute('gen_ai.agent.name', data.name));
  if (data.output_type)
    attrs.push(otelAttribute('gen_ai.output.type', data.output_type));
  return attrs.filter(Boolean);
}

function toOtlpSpan(item: Trace | Span<any>): any | null {
  const json = item.toJSON() as any;
  if (!json) return null;
  if (json.object === 'trace') {
    return null; // traces are not exported separately
  }

  let attributes: any[] = [];
  let name = json.span_data?.name ?? 'span';
  const type = json.span_data?.type;
  if (type === 'generation') {
    attributes = mapGenerationAttributes(json.span_data);
    name = `generate_content ${json.span_data.model ?? ''}`.trim();
  } else if (type === 'function') {
    attributes = mapFunctionAttributes(json.span_data);
    name = `execute_tool ${json.span_data.name ?? ''}`.trim();
  } else if (type === 'agent') {
    attributes = mapAgentAttributes(json.span_data);
    name = `invoke_agent ${json.span_data.name ?? ''}`.trim();
  } else {
    attributes = spanDataToAttributes(json.span_data);
  }

  if (json.error?.message) {
    attributes.push(otelAttribute('error.type', json.error.message));
  }

  return {
    traceId: json.trace_id,
    spanId: json.id,
    parentSpanId: json.parent_id ?? undefined,
    name,
    startTimeUnixNano: timeToNano(json.started_at),
    endTimeUnixNano: timeToNano(json.ended_at),
    attributes,
    status: json.error
      ? { code: 2, message: String(json.error.message) }
      : { code: 1 },
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

export function setDefaultOTLPHttpExporter(
  options?: Partial<OTLPHttpExporterOptions>,
) {
  const exporter = new OTLPHttpExporter(options);
  const processor = new BatchTraceProcessor(exporter);
  setTraceProcessors([processor]);
}
