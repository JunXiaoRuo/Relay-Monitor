import { Decimal } from 'decimal.js';

import { DEFAULT_RATE_PROBE_TIMEOUT_SECONDS } from '../../../shared/constants.js';
import { AdapterError } from '../contracts/errors.js';
import type {
  ModelProbeRequest,
  ModelProbeResult,
  ProbeModelCatalog,
  SiteContext,
} from '../contracts/types.js';
import { createSub2ApiClient } from './auth.js';
import { modelsResponseSchema } from './schemas.js';

const DEFAULT_PROBE_TIMEOUT_MS = DEFAULT_RATE_PROBE_TIMEOUT_SECONDS * 1_000;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_RETURNED_MODEL_LENGTH = 200;
const MAX_SYSTEM_FINGERPRINT_LENGTH = 256;
const MAX_FINISH_REASON_LENGTH = 64;

interface ResponseStreamEvent {
  type?: unknown;
  delta?: unknown;
  text?: unknown;
  item?: unknown;
  response?: unknown;
  error?: unknown;
}

interface ProbeUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  input_tokens_details?: unknown;
  output_tokens_details?: unknown;
}

interface ProbeResponse {
  model?: unknown;
  system_fingerprint?: unknown;
  status?: unknown;
  incomplete_details?: unknown;
  usage?: unknown;
  output?: unknown;
  tools?: unknown;
}

function requiredApiKey(ctx: SiteContext): string {
  const apiKey = ctx.credentials?.api_key?.trim();
  if (!apiKey) {
    throw new AdapterError('AUTH_INVALID_CREDENTIALS', 'A model probe API key is required');
  }
  return apiKey;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedMetadata(value: unknown, field: string, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > maxLength) {
    throw new AdapterError('UPSTREAM_SCHEMA_ERROR', `The model stream returned an oversized ${field}`);
  }
  return value;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function httpError(response: Response): AdapterError {
  if (response.status === 401 || response.status === 403) {
    return new AdapterError('AUTH_ACCESS_EXPIRED', 'The model probe API key was rejected', {
      httpStatus: response.status,
    });
  }
  if (response.status === 429) {
    const retry = retryAfterMs(response.headers.get('retry-after'));
    return new AdapterError('UPSTREAM_RATE_LIMITED', 'The upstream rate limit was reached', {
      httpStatus: response.status,
      retryable: true,
      ...(retry === undefined ? {} : { retryAfterMs: retry }),
    });
  }
  if (response.status >= 500) {
    return new AdapterError('UPSTREAM_SERVER_ERROR', 'The upstream model endpoint returned an error', {
      httpStatus: response.status,
      retryable: true,
    });
  }
  return new AdapterError('UPSTREAM_SCHEMA_ERROR', `The model endpoint returned HTTP ${response.status}`, {
    httpStatus: response.status,
  });
}

function eventData(block: string): string | null {
  const values = block
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  return values.length === 0 ? null : values.join('\n');
}

function nextEventBoundary(buffer: string): { index: number; length: number } | null {
  const match = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

function responseRecord(value: unknown): ProbeResponse | null {
  return value && typeof value === 'object' ? value as ProbeResponse : null;
}

function outputItemIsToolCall(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const type = (value as Record<string, unknown>).type;
  if (typeof type !== 'string') return false;
  return type === 'tool_call' || type.endsWith('_call') || type.includes('tool_call');
}

function outputHasToolCall(value: unknown): boolean {
  return Array.isArray(value) && value.some(outputItemIsToolCall);
}

function outputTextFromItems(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.type !== 'message' || !Array.isArray(itemRecord.content)) continue;
    for (const content of itemRecord.content) {
      if (!content || typeof content !== 'object') continue;
      const contentRecord = content as Record<string, unknown>;
      if (contentRecord.type === 'output_text' && typeof contentRecord.text === 'string') {
        parts.push(contentRecord.text);
      } else if (contentRecord.type === 'refusal' && typeof contentRecord.refusal === 'string') {
        parts.push(contentRecord.refusal);
      }
    }
  }
  return parts.join('');
}

function normalizedUsage(value: unknown): ModelProbeResult['usage'] | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as ProbeUsage;
  const promptTokens = nonNegativeInteger(usage.input_tokens);
  const completionTokens = nonNegativeInteger(usage.output_tokens);
  const reportedTotalTokens = nonNegativeInteger(usage.total_tokens);
  const calculatedTotalTokens = promptTokens !== null && completionTokens !== null
    ? promptTokens + completionTokens
    : null;
  if (reportedTotalTokens !== null
    && calculatedTotalTokens !== null
    && reportedTotalTokens !== calculatedTotalTokens) {
    throw new AdapterError('UPSTREAM_SCHEMA_ERROR', 'The model stream returned inconsistent total token usage');
  }
  const totalTokens = reportedTotalTokens ?? calculatedTotalTokens;
  const promptDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details as Record<string, unknown>
    : undefined;
  const completionDetails = usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
    ? usage.output_tokens_details as Record<string, unknown>
    : undefined;
  const cachedInputTokens = nonNegativeInteger(promptDetails?.cached_tokens);
  const reasoningTokens = nonNegativeInteger(completionDetails?.reasoning_tokens);
  if (cachedInputTokens !== null && promptTokens !== null && cachedInputTokens > promptTokens) {
    throw new AdapterError('UPSTREAM_SCHEMA_ERROR', 'The model stream returned invalid cached token usage');
  }
  if (reasoningTokens !== null && completionTokens !== null && reasoningTokens > completionTokens) {
    throw new AdapterError('UPSTREAM_SCHEMA_ERROR', 'The model stream returned invalid reasoning token usage');
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens,
  };
}

export function visibleOutputTps(
  completionTokens: number | null,
  reasoningTokens: number | null,
  generationMs: number | null,
): string | null {
  if (completionTokens === null || generationMs === null || generationMs <= 0) return null;
  // Reasoning tokens are produced before the first visible token, so including them
  // in the post-TTFT generation window would overstate visible output throughput.
  const visibleTokens = reasoningTokens === null
    ? completionTokens
    : Math.max(0, completionTokens - reasoningTokens);
  return new Decimal(visibleTokens).mul(1_000).div(generationMs).toDecimalPlaces(2).toString();
}

export async function listSub2ApiProbeModels(ctx: SiteContext): Promise<ProbeModelCatalog> {
  const response = await createSub2ApiClient(ctx).request<Array<{ id: string }>>('/v1/models', {
    bearerToken: requiredApiKey(ctx),
    schema: modelsResponseSchema,
    unwrapEnvelope: false,
    authFailureCode: 'AUTH_ACCESS_EXPIRED',
  });
  const ids = [...new Set(response.data.map(({ id }) => id.trim()).filter(Boolean))].sort();
  return {
    models: ids.map((id) => ({ id })),
    fetchedAt: (ctx.now ?? new Date()).toISOString(),
  };
}

export async function probeSub2ApiModel(
  ctx: SiteContext,
  input: ModelProbeRequest,
): Promise<ModelProbeResult> {
  const apiKey = requiredApiKey(ctx);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Model probe timed out'));
  }, ctx.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);

  const startedAt = performance.now();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (ctx.fetch ?? globalThis.fetch)(new URL('/v1/responses', `${ctx.baseUrl}/`), {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        instructions: input.systemPrompt,
        input: input.userPrompt,
        stream: true,
        store: false,
        tools: [],
        tool_choice: 'none',
        max_output_tokens: input.maxOutputTokens,
      }),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new AdapterError('UPSTREAM_UNREACHABLE', 'Upstream redirect was not followed', {
        httpStatus: response.status,
      });
    }
    if (!response.ok) throw httpError(response);
    if (!response.body) {
      throw new AdapterError('UPSTREAM_SCHEMA_ERROR', 'The model endpoint returned an empty response', {
        httpStatus: response.status,
      });
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalBytes = 0;
    let ttfbMs: number | null = null;
    let ttftMs: number | null = null;
    let outputText = '';
    let returnedModel: string | null = null;
    let systemFingerprint: string | null = null;
    let finishReason: string | null = null;
    let usage: ModelProbeResult['usage'] = {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
    };
    let toolCallsObserved = false;
    let upstreamToolsObserved = false;
    let done = false;

    const recordVisibleText = (text: string, finalPart = false): void => {
      if (text.length === 0) return;
      if (ttftMs === null) ttftMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (!finalPart) {
        outputText += text;
        return;
      }
      if (outputText.endsWith(text)) return;
      if (text.startsWith(outputText)) {
        outputText = text;
        return;
      }
      outputText += text;
    };

    const applyResponse = (value: unknown): ProbeResponse | null => {
      const streamedResponse = responseRecord(value);
      if (!streamedResponse) return null;
      const streamModel = boundedMetadata(
        streamedResponse.model,
        'model identifier',
        MAX_RETURNED_MODEL_LENGTH,
      );
      const streamFingerprint = boundedMetadata(
        streamedResponse.system_fingerprint,
        'system fingerprint',
        MAX_SYSTEM_FINGERPRINT_LENGTH,
      );
      if (streamModel !== null) returnedModel = streamModel;
      if (streamFingerprint !== null) systemFingerprint = streamFingerprint;
      const parsedUsage = normalizedUsage(streamedResponse.usage);
      if (parsedUsage) usage = parsedUsage;
      toolCallsObserved ||= outputHasToolCall(streamedResponse.output);
      upstreamToolsObserved ||= Array.isArray(streamedResponse.tools) && streamedResponse.tools.length > 0;
      recordVisibleText(outputTextFromItems(streamedResponse.output), true);
      return streamedResponse;
    };

    const consumeEvent = (block: string): void => {
      const data = eventData(block);
      if (data === null) return;
      if (data.trim() === '[DONE]') {
        done = true;
        return;
      }
      let parsed: ResponseStreamEvent;
      try {
        parsed = JSON.parse(data) as ResponseStreamEvent;
      } catch (cause) {
        throw new AdapterError('UPSTREAM_SCHEMA_ERROR', 'The model stream contained invalid JSON', {
          cause,
          httpStatus: response.status,
        });
      }
      const eventType = boundedMetadata(parsed.type, 'event type', MAX_FINISH_REASON_LENGTH);
      if (eventType === 'response.created' || eventType === 'response.in_progress') {
        applyResponse(parsed.response);
        return;
      }
      if (eventType === 'response.output_text.delta') {
        if (typeof parsed.delta !== 'string') {
          throw new AdapterError('UPSTREAM_SCHEMA_ERROR', 'The model stream returned an invalid text delta');
        }
        recordVisibleText(parsed.delta);
        return;
      }
      if (eventType === 'response.output_text.done') {
        if (typeof parsed.text !== 'string') {
          throw new AdapterError('UPSTREAM_SCHEMA_ERROR', 'The model stream returned invalid completed text');
        }
        recordVisibleText(parsed.text, true);
        return;
      }
      if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
        toolCallsObserved ||= outputItemIsToolCall(parsed.item);
        return;
      }
      if (eventType === 'response.completed') {
        applyResponse(parsed.response);
        finishReason = 'stop';
        done = true;
        return;
      }
      if (eventType === 'response.incomplete') {
        const incompleteResponse = applyResponse(parsed.response);
        const details = incompleteResponse?.incomplete_details;
        const reason = details && typeof details === 'object'
          ? (details as Record<string, unknown>).reason
          : null;
        finishReason = reason === 'max_output_tokens'
          ? 'length'
          : boundedMetadata(reason, 'finish reason', MAX_FINISH_REASON_LENGTH) ?? 'incomplete';
        done = true;
        return;
      }
      if (eventType === 'response.failed') {
        applyResponse(parsed.response);
        throw new AdapterError('UPSTREAM_SERVER_ERROR', 'The upstream model response failed', {
          httpStatus: response.status,
          retryable: true,
        });
      }
      if (eventType === 'error') {
        throw new AdapterError('UPSTREAM_SERVER_ERROR', 'The upstream model stream returned an error', {
          httpStatus: response.status,
          retryable: true,
        });
      }
    };

    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > 0 && ttfbMs === null) {
        ttfbMs = Math.max(0, Math.round(performance.now() - startedAt));
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_STREAM_BYTES) {
        throw new AdapterError('UPSTREAM_SCHEMA_ERROR', 'The model stream exceeded the response limit', {
          httpStatus: response.status,
        });
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = nextEventBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        consumeEvent(block);
        if (done) break;
        boundary = nextEventBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    if (!done && buffer.trim()) consumeEvent(buffer);
    const totalMs = Math.max(0, Math.round(performance.now() - startedAt));
    if ((ttftMs === null || outputText.length === 0)
      && !toolCallsObserved
      && finishReason !== 'length') {
      throw new AdapterError('UPSTREAM_SCHEMA_ERROR', 'The model stream did not contain output text', {
        httpStatus: response.status,
      });
    }
    const generationMs = ttftMs === null ? null : Math.max(0, totalMs - ttftMs);
    return {
      requestedModel: input.model,
      returnedModel,
      httpStatus: response.status,
      ttfbMs,
      ttftMs,
      totalMs,
      generationMs,
      usage,
      tps: visibleOutputTps(usage.completionTokens, usage.reasoningTokens, generationMs),
      finishReason,
      systemFingerprint,
      toolCallsObserved,
      upstreamToolsObserved,
      outputText,
    };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('UPSTREAM_UNREACHABLE', timedOut ? 'The model probe timed out' : 'The model endpoint is unreachable', {
      cause: error,
      retryable: true,
      details: { reason: timedOut ? 'timeout' : 'network' },
    });
  } finally {
    clearTimeout(timeout);
    ctx.signal?.removeEventListener('abort', abortFromParent);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed or aborted.
      }
      reader.releaseLock();
    }
  }
}
