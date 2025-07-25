import { RuntimeEventEmitter, Usage } from '@openai/agents-core';
import type { MessageEvent as WebSocketMessageEvent } from 'ws';

import {
  RealtimeClientMessage,
  RealtimeSessionConfig,
  RealtimeTracingConfig,
  RealtimeTurnDetectionConfig,
  RealtimeTurnDetectionConfigAsIs,
  RealtimeUserInput,
} from './clientMessages';
import {
  RealtimeItem,
  realtimeMessageItemSchema,
  realtimeToolCallItem,
} from './items';
import logger from './logger';
import {
  parseRealtimeEvent,
  responseDoneEventSchema,
} from './openaiRealtimeEvents';
import {
  ApiKey,
  RealtimeTransportLayer,
  RealtimeTransportLayerConnectOptions,
} from './transportLayer';
import {
  RealtimeTransportEventTypes,
  TransportToolCallEvent,
} from './transportLayerEvents';
import { arrayBufferToBase64, diffRealtimeHistory } from './utils';
import { EventEmitterDelegate } from '@openai/agents-core/utils';

/**
 * The models that are supported by the OpenAI Realtime API.
 */
export type OpenAIRealtimeModels =
  | 'gpt-4o-realtime-preview'
  | 'gpt-4o-mini-realtime-preview'
  | 'gpt-4o-realtime-preview-2025-06-03'
  | 'gpt-4o-realtime-preview-2024-12-17'
  | 'gpt-4o-realtime-preview-2024-10-01'
  | 'gpt-4o-mini-realtime-preview-2024-12-17'
  | (string & {}); // ensures autocomplete works

/**
 * The default model that is used during the connection if no model is provided.
 */
export const DEFAULT_OPENAI_REALTIME_MODEL: OpenAIRealtimeModels =
  'gpt-4o-realtime-preview';

/**
 * The default session config that gets send over during session connection unless overriden
 * by the user.
 */
export const DEFAULT_OPENAI_REALTIME_SESSION_CONFIG: Partial<RealtimeSessionConfig> =
  {
    voice: 'ash',
    modalities: ['text', 'audio'],
    inputAudioFormat: 'pcm16',
    outputAudioFormat: 'pcm16',
    inputAudioTranscription: {
      model: 'gpt-4o-mini-transcribe',
    },
    turnDetection: {
      type: 'semantic_vad',
    },
    speed: 1,
  };

/**
 * The options for the OpenAI Realtime transport layer.
 */
export type OpenAIRealtimeBaseOptions = {
  /**
   * The model to used during the connection.
   */
  model?: OpenAIRealtimeModels;
  /**
   * The API key to use for the connection.
   */
  apiKey?: ApiKey;
};

/**
 * The events that are emitted by the OpenAI Realtime transport layer.
 */
export type OpenAIRealtimeEventTypes = {
  /**
   * Triggered when the connection is established.
   */
  connected: [];
  /**
   * Triggered when the connection is closed.
   */
  disconnected: [];
} & RealtimeTransportEventTypes;

export abstract class OpenAIRealtimeBase
  extends EventEmitterDelegate<OpenAIRealtimeEventTypes>
  implements RealtimeTransportLayer
{
  #model: string;
  #apiKey: ApiKey | undefined;
  #tracingConfig: RealtimeTracingConfig | null = null;

  protected eventEmitter: RuntimeEventEmitter<OpenAIRealtimeEventTypes> =
    new RuntimeEventEmitter<OpenAIRealtimeEventTypes>();

  constructor(options: OpenAIRealtimeBaseOptions = {}) {
    super();
    this.#model = options.model ?? DEFAULT_OPENAI_REALTIME_MODEL;
    this.#apiKey = options.apiKey;
  }

  /**
   * The current model that is being used by the transport layer.
   */
  get currentModel() {
    return this.#model;
  }

  /**
   * The current model that is being used by the transport layer.
   * **Note**: The model cannot be changed mid conversation.
   */
  set currentModel(model: OpenAIRealtimeModels) {
    this.#model = model;
  }

  abstract get status():
    | 'connected'
    | 'disconnected'
    | 'connecting'
    | 'disconnecting';

  abstract connect(
    options: RealtimeTransportLayerConnectOptions,
  ): Promise<void>;

  abstract sendEvent(event: RealtimeClientMessage): void;

  abstract mute(muted: boolean): void;

  abstract close(): void;

  abstract interrupt(): void;

  abstract readonly muted: boolean | null;

  protected async _getApiKey(options: RealtimeTransportLayerConnectOptions) {
    const apiKey = options.apiKey ?? this.#apiKey;

    if (typeof apiKey === 'function') {
      return await apiKey();
    }

    return apiKey;
  }

  protected _onMessage(event: MessageEvent | WebSocketMessageEvent) {
    const { data: parsed, isGeneric } = parseRealtimeEvent(event);
    if (parsed === null) {
      return;
    }

    this.emit('*', parsed);
    if (isGeneric) {
      return;
    }

    if (parsed.type === 'error') {
      this.emit('error', { type: 'error', error: parsed });
    } else {
      this.emit(parsed.type, parsed);
    }

    if (parsed.type === 'response.created') {
      this.emit('turn_started', {
        type: 'response_started',
        providerData: {
          ...parsed,
        },
      });
      return;
    }

    if (parsed.type === 'response.done') {
      const response = responseDoneEventSchema.safeParse(parsed);
      if (!response.success) {
        logger.error('Error parsing response done event', response.error);
        return;
      }
      const inputTokens = response.data.response.usage?.input_tokens ?? 0;
      const outputTokens = response.data.response.usage?.output_tokens ?? 0;
      const totalTokens = inputTokens + outputTokens;
      const usage = new Usage({
        inputTokens,
        inputTokensDetails:
          response.data.response.usage?.input_tokens_details ?? {},
        outputTokens,
        outputTokensDetails:
          response.data.response.usage?.output_tokens_details ?? {},
        totalTokens,
      });
      this.emit('usage_update', usage);
      this.emit('turn_done', {
        type: 'response_done',
        response: {
          id: response.data.response.id ?? '',
          output: response.data.response.output ?? [],
          usage: {
            inputTokens,
            inputTokensDetails:
              response.data.response.usage?.input_tokens_details ?? {},
            outputTokens,
            outputTokensDetails:
              response.data.response.usage?.output_tokens_details ?? {},
            totalTokens,
          },
        },
      });
      return;
    }

    if (parsed.type === 'response.audio.done') {
      this.emit('audio_done');
      return;
    }

    if (parsed.type === 'conversation.item.deleted') {
      this.emit('item_deleted', {
        itemId: parsed.item_id,
      });
      return;
    }

    if (
      parsed.type === 'conversation.item.input_audio_transcription.completed' ||
      parsed.type === 'conversation.item.truncated'
    ) {
      // right now rather than keeping track of partials and rebuilding the item we
      // will retrieve it instead which triggers the `conversation.item.retrieved` event below
      this.sendEvent({
        type: 'conversation.item.retrieve',
        item_id: parsed.item_id,
      });
      return;
    }

    if (
      parsed.type === 'conversation.item.input_audio_transcription.delta' ||
      parsed.type === 'response.text.delta' ||
      parsed.type === 'response.audio_transcript.delta' ||
      parsed.type === 'response.function_call_arguments.delta'
    ) {
      if (parsed.type === 'response.audio_transcript.delta') {
        this.emit('audio_transcript_delta', {
          type: 'transcript_delta',
          delta: parsed.delta,
          itemId: parsed.item_id,
          responseId: parsed.response_id,
        });
      }
      // no support for partial transcripts yet.
      return;
    }

    if (
      parsed.type === 'conversation.item.created' ||
      parsed.type === 'conversation.item.retrieved'
    ) {
      if (parsed.item.type === 'message') {
        const previousItemId =
          parsed.type === 'conversation.item.created'
            ? parsed.previous_item_id
            : null;
        const item = realtimeMessageItemSchema.parse({
          itemId: parsed.item.id,
          previousItemId,
          type: parsed.item.type,
          role: parsed.item.role,
          content: parsed.item.content,
          status: parsed.item.status,
        });
        this.emit('item_update', item);
        return;
      }
    }

    if (
      parsed.type === 'response.output_item.done' ||
      parsed.type === 'response.output_item.added'
    ) {
      const item = parsed.item;
      if (item.type === 'function_call' && item.status === 'completed') {
        const toolCall = realtimeToolCallItem.parse({
          itemId: item.id,
          type: item.type,
          status: 'in_progress', // we set it to in_progress for the UI as it will only be completed with the output
          arguments: item.arguments,
          name: item.name,
          output: null,
        });
        this.emit('item_update', toolCall);
        this.emit('function_call', {
          id: item.id,
          type: 'function_call',
          callId: item.call_id ?? '',
          arguments: item.arguments ?? '',
          name: item.name ?? '',
        });
        return;
      }

      if (item.type === 'message') {
        const realtimeItem = realtimeMessageItemSchema.parse({
          itemId: parsed.item.id,
          type: parsed.item.type,
          role: parsed.item.role,
          content: parsed.item.content,
          status: 'in_progress',
        });
        this.emit('item_update', realtimeItem);
        return;
      }
    }
  }

  protected _onError(error: any) {
    this.emit('error', {
      type: 'error',
      error,
    });
  }

  protected _onOpen() {
    this.emit('connected');
  }

  protected _onClose() {
    this.emit('disconnected');
  }

  /**
   * Send a message to the Realtime API. This will create a new item in the conversation and
   * trigger a response.
   *
   * @param message - The message to send.
   * @param otherEventData - Additional event data to send.
   */
  sendMessage(message: RealtimeUserInput, otherEventData: Record<string, any>) {
    this.sendEvent({
      type: 'conversation.item.create',
      item:
        typeof message === 'string'
          ? {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: message,
                },
              ],
            }
          : message,
      ...otherEventData,
    });

    this.sendEvent({
      type: 'response.create',
    });
  }

  protected _getMergedSessionConfig(config: Partial<RealtimeSessionConfig>) {
    const sessionData = {
      instructions: config.instructions,
      model:
        config.model ??
        this.#model ??
        DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.model,
      voice: config.voice ?? DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.voice,
      speed: config.speed ?? DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.speed,
      modalities:
        config.modalities ?? DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.modalities,
      input_audio_format:
        config.inputAudioFormat ??
        DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.inputAudioFormat,
      output_audio_format:
        config.outputAudioFormat ??
        DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.outputAudioFormat,
      input_audio_transcription:
        config.inputAudioTranscription ??
        DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.inputAudioTranscription,
      turn_detection:
        OpenAIRealtimeBase.buildTurnDetectionConfig(config.turnDetection) ??
        DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.turnDetection,
      tool_choice:
        config.toolChoice ?? DEFAULT_OPENAI_REALTIME_SESSION_CONFIG.toolChoice,
      tools: config.tools?.map((tool) => ({
        ...tool,
        strict: undefined,
      })),
      // We don't set tracing here to make sure that we don't try to override it on every
      // session.update as it might lead to errors
      ...(config.providerData ?? {}),
    };

    return sessionData;
  }

  private static buildTurnDetectionConfig(
    c: RealtimeTurnDetectionConfig | undefined,
  ): RealtimeTurnDetectionConfigAsIs | undefined {
    if (typeof c === 'undefined') {
      return undefined;
    }
    const {
      type,
      createResponse,
      create_response,
      eagerness,
      interruptResponse,
      interrupt_response,
      prefixPaddingMs,
      prefix_padding_ms,
      silenceDurationMs,
      silence_duration_ms,
      threshold,
      ...rest
    } = c;

    const config: RealtimeTurnDetectionConfigAsIs & Record<string, any> = {
      type,
      create_response: createResponse ? createResponse : create_response,
      eagerness,
      interrupt_response: interruptResponse
        ? interruptResponse
        : interrupt_response,
      prefix_padding_ms: prefixPaddingMs ? prefixPaddingMs : prefix_padding_ms,
      silence_duration_ms: silenceDurationMs
        ? silenceDurationMs
        : silence_duration_ms,
      threshold,
      ...rest,
    };
    // Remove undefined values from the config
    Object.keys(config).forEach((key) => {
      if (config[key] === undefined) delete config[key];
    });
    return Object.keys(config).length > 0 ? config : undefined;
  }

  /**
   * Sets the internal tracing config. This is used to track the tracing config that has been set
   * during the session.create event.
   */
  set _tracingConfig(tracingConfig: RealtimeTracingConfig | null) {
    this.#tracingConfig = tracingConfig;
  }

  /**
   * Sets the tracing config for the session. This will send the tracing config to the Realtime API.
   *
   * @param tracingConfig - The tracing config to set. We don't support 'auto' here as the SDK will always configure a Workflow Name unless it exists
   */
  protected _updateTracingConfig(tracingConfig: RealtimeTracingConfig) {
    if (typeof this.#tracingConfig === 'undefined') {
      // treating it as default value
      this.#tracingConfig = null;
    }

    if (tracingConfig === 'auto') {
      // turn on tracing in auto mode
      this.sendEvent({
        type: 'session.update',
        session: {
          tracing: 'auto',
        },
      });
      return;
    }

    if (
      typeof this.#tracingConfig !== 'string' &&
      typeof tracingConfig !== 'string'
    ) {
      // tracing is already set, we can't change it
      logger.warn(
        'Tracing config is already set, skipping setting it again. This likely happens when you already set a tracing config on session creation.',
      );
      return;
    }

    if (tracingConfig === null) {
      logger.debug(
        'Disabling tracing for this session. It cannot be turned on for this session from this point on.',
      );

      this.sendEvent({
        type: 'session.update',
        session: {
          tracing: null,
        },
      });
      return;
    }

    if (
      this.#tracingConfig === null ||
      typeof this.#tracingConfig === 'string'
    ) {
      // tracing is currently not set so we can set it to the new value
      this.sendEvent({
        type: 'session.update',
        session: {
          tracing: tracingConfig,
        },
      });
      return;
    }

    if (
      tracingConfig?.group_id !== this.#tracingConfig?.group_id ||
      tracingConfig?.metadata !== this.#tracingConfig?.metadata ||
      tracingConfig?.workflow_name !== this.#tracingConfig?.workflow_name
    ) {
      logger.warn(
        'Mismatch in tracing config. Ignoring the new tracing config. This likely happens when you already set a tracing config on session creation. Current tracing config: %s, new tracing config: %s',
        JSON.stringify(this.#tracingConfig),
        JSON.stringify(tracingConfig),
      );
      return;
    }

    this.sendEvent({
      type: 'session.update',
      session: {
        tracing: tracingConfig,
      },
    });
  }

  /**
   * Updates the session config. This will merge it with the current session config with the default
   * values and send it to the Realtime API.
   *
   * @param config - The session config to update.
   */
  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void {
    const sessionData = this._getMergedSessionConfig(config);

    this.sendEvent({
      type: 'session.update',
      session: sessionData,
    });
  }

  /**
   * Send the output of a function call to the Realtime API.
   *
   * @param toolCall - The tool call to send the output for.
   * @param output - The output of the function call.
   * @param startResponse - Whether to start a new response after sending the output.
   */
  sendFunctionCallOutput(
    toolCall: TransportToolCallEvent,
    output: string,
    startResponse: boolean = true,
  ): void {
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        output,
        call_id: toolCall.callId,
      },
    });

    try {
      const item = realtimeToolCallItem.parse({
        itemId: toolCall.id,
        previousItemId: toolCall.previousItemId,
        type: 'function_call',
        status: 'completed',
        arguments: toolCall.arguments,
        name: toolCall.name,
        output,
      });
      this.emit('item_update', item);
    } catch (error) {
      logger.error('Error parsing tool call item', error, toolCall);
    }

    if (startResponse) {
      this.sendEvent({
        type: 'response.create',
      });
    }
  }

  /**
   * Send an audio buffer to the Realtime API. If `{ commit: true }` is passed, the audio buffer
   * will be committed and the model will start processing it. This is necessary if you have
   * disabled turn detection / voice activity detection (VAD).
   *
   * @param audio - The audio buffer to send.
   * @param options - The options for the audio buffer.
   */
  sendAudio(
    audio: ArrayBuffer,
    { commit = false }: { commit?: boolean } = {},
  ): void {
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: arrayBufferToBase64(audio),
    });

    if (commit) {
      this.sendEvent({
        type: 'input_audio_buffer.commit',
      });
    }
  }

  /**
   * Reset the history of the conversation. This will create a diff between the old and new history
   * and send the necessary events to the Realtime API to update the history.
   *
   * @param oldHistory - The old history of the conversation.
   * @param newHistory - The new history of the conversation.
   */
  resetHistory(oldHistory: RealtimeItem[], newHistory: RealtimeItem[]): void {
    const { removals, additions, updates } = diffRealtimeHistory(
      oldHistory,
      newHistory,
    );

    const removalIds = new Set(removals.map((item) => item.itemId));
    // we don't have an update event for items so we will remove and re-add what's there
    for (const update of updates) {
      removalIds.add(update.itemId);
    }

    if (removalIds.size > 0) {
      for (const itemId of removalIds) {
        this.sendEvent({
          type: 'conversation.item.delete',
          item_id: itemId,
        });
      }
    }

    const additionsAndUpdates = [...additions, ...updates];

    for (const addition of additionsAndUpdates) {
      if (addition.type === 'message') {
        const itemEntry: Record<string, any> = {
          type: 'message',
          role: addition.role,
          content: addition.content,
          id: addition.itemId,
        };
        if (addition.role !== 'system' && addition.status) {
          itemEntry.status = addition.status;
        }
        this.sendEvent({
          type: 'conversation.item.create',
          item: itemEntry,
        });
      } else if (addition.type === 'function_call') {
        logger.warn(
          'Function calls cannot be manually added or updated at the moment. Ignoring.',
        );
      }
    }
  }
}
