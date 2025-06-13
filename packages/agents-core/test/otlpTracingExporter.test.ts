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
