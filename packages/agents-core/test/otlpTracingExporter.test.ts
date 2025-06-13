import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OTLPTracingExporter } from '../src/otlpTracingExporter';
import { createCustomSpan } from '../src/tracing/createSpans';

describe('OTLPTracingExporter', () => {
  const fakeSpan = createCustomSpan({
    data: { name: 'test' },
  });
  fakeSpan.toJSON = () => ({
    object: 'trace.span',
    id: '123',
    trace_id: '123',
    parent_id: '123',
    started_at: '2024-01-01T00:00:00.000Z',
    ended_at: '2024-01-01T00:00:01.000Z',
    span_data: { name: 'test' },
    error: null,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('exports payload via fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OTLPTracingExporter({ endpoint: 'http://localhost' });
    await exporter.export([fakeSpan], undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toEqual(
      expect.objectContaining({ 'Content-Type': 'application/json' }),
    );
  });

  it('maps generation span attributes', async () => {
    const generationSpan = createCustomSpan({ data: { name: 'g' } });
    generationSpan.toJSON = () => ({
      object: 'trace.span',
      id: '1',
      trace_id: 't1',
      parent_id: 'p1',
      started_at: '2024-01-01T00:00:00.000Z',
      ended_at: '2024-01-01T00:00:01.000Z',
      span_data: {
        type: 'generation',
        model: 'gpt-4',
        model_config: { temperature: 0.2 },
        usage: { inputTokens: 1, outputTokens: 2 },
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hi' }],
            status: 'completed',
          },
        ],
      },
      error: null,
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OTLPTracingExporter({ endpoint: 'http://l' });
    await exporter.export([generationSpan]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const otlp = body.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs: Record<string, any> = {};
    for (const a of otlp.attributes) {
      attrs[a.key] =
        a.value.stringValue ?? a.value.doubleValue ?? a.value.boolValue;
    }
    expect(otlp.name).toBe('generate_content gpt-4');
    expect(attrs['gen_ai.operation.name']).toBe('generate_content');
    expect(attrs['gen_ai.request.model']).toBe('gpt-4');
    expect(attrs['gen_ai.request.temperature']).toBe(0.2);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(2);
  });

  it('retries on server errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'err',
      })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OTLPTracingExporter({
      endpoint: 'url',
      maxRetries: 2,
      baseDelay: 1,
      maxDelay: 2,
    });
    await exporter.export([fakeSpan]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops on client error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OTLPTracingExporter({ endpoint: 'u', maxRetries: 2 });
    await exporter.export([fakeSpan]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('setDefaultOTLPTracingExporter registers processor', async () => {
    const setTraceProcessors = vi.fn();
    const BatchTraceProcessor = vi.fn().mockImplementation((exp) => ({ exp }));
    vi.resetModules();
    vi.doMock('../src/tracing', async () => {
      const actual = await vi.importActual<any>('../src/tracing');
      return { ...actual, BatchTraceProcessor, setTraceProcessors };
    });
    const mod = await import('../src/otlpTracingExporter');
    mod.setDefaultOTLPTracingExporter();
    expect(BatchTraceProcessor).toHaveBeenCalled();
    expect(setTraceProcessors).toHaveBeenCalledWith([expect.anything()]);
    vi.resetModules();
  });
});
