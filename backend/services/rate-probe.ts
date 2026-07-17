import { createHash, randomBytes } from 'node:crypto';

import { and, count, desc, eq, isNull, lt, or } from 'drizzle-orm';

import {
  buildRateProbePrompt,
  isSolKnowledgeProbeModel,
  RATE_PROBE_ENDPOINT,
  RATE_PROBE_PROMPT_TEMPLATE_ID,
  RATE_PROBE_PROTOCOL,
  rateProbeModelIdentityKey,
} from '../../shared/rate-probe.js';
import { probeErrorMessage } from '../../shared/probe-errors.js';
import {
  DEFAULT_RATE_PROBE_INTERVAL_SECONDS,
  DEFAULT_RATE_PROBE_RETRY_COUNT,
  DEFAULT_RATE_PROBE_RETRY_INTERVAL_SECONDS,
  DEFAULT_RATE_PROBE_TIMEOUT_SECONDS,
  MAX_RATE_PROBE_INTERVAL_SECONDS,
  MAX_RATE_PROBE_TIMEOUT_SECONDS,
  MIN_RATE_PROBE_INTERVAL_SECONDS,
  MIN_RATE_PROBE_TIMEOUT_SECONDS,
} from '../../shared/constants.js';

import { AdapterError, type ModelProbeResult } from '../adapters/index.js';
import type { AppContext } from '../context.js';
import {
  rateProbeConfigs,
  rateProbeRuns,
  ratesCurrent,
  monitorJobs,
  sites,
} from '../db/index.js';
import { AppError } from '../core/errors.js';
import { createId } from '../core/ids.js';
import { redactString } from '../core/redaction.js';
import { createSafeFetchContext } from '../core/safe-fetch.js';
import {
  credentialPresence,
  loadCredentialValue,
  revokeCredentials,
  storeCredentials,
} from './credentials.js';
import { rateGroupId } from './rate-scope.js';
import {
  bindProbeKeyToRate,
  revokeManagedProbeKeyIds,
  resolveProbeKeyMappings,
  savedSiteCredentials,
  type ResolvedProbeKeyMapping,
} from './upstream-probe-keys.js';
import { evaluateProbeAlertsInTransaction } from './probe-alerts.js';

export const DEFAULT_RATE_PROBE_MAX_OUTPUT_TOKENS = 96;
export const MIN_RATE_PROBE_MAX_OUTPUT_TOKENS = 16;
const STALE_RATE_PROBE_MS = 120_000;
const RATE_PROBE_HEARTBEAT_INTERVAL_MS = 15_000;
const activeProbeSites = new Set<string>();

type ProbeConfigRow = typeof rateProbeConfigs.$inferSelect;
type ProbeRunRow = typeof rateProbeRuns.$inferSelect;

function normalizedMaxOutputTokens(value: number): number {
  return Math.max(MIN_RATE_PROBE_MAX_OUTPUT_TOKENS, Math.min(256, Math.trunc(value)));
}

interface ProbeTarget {
  rate: typeof ratesCurrent.$inferSelect;
  site: typeof sites.$inferSelect;
}

export interface UpdateRateProbeConfigInput {
  modelMode: 'auto' | 'manual';
  model?: string | null;
  keyMode?: 'bound' | 'existing' | 'auto_create' | 'manual';
  upstreamKeyId?: string | null;
  useSiteApiKey?: boolean;
  customApiKey?: string | null;
  maxOutputTokens: number;
  enabled?: boolean;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  retryCount?: number;
  retryIntervalSeconds?: number;
  autoCreate?: {
    quotaLimit?: number;
    expiresInSeconds?: number;
  } | null;
  idempotencyKey?: string;
}

function customCredentialType(rateId: string): string {
  return `rate_probe:${rateId}:api_key`;
}

function requireProbeTarget(context: AppContext, rateId: string, requireEnabled = false): ProbeTarget {
  const target = context.database.db
    .select({ rate: ratesCurrent, site: sites })
    .from(ratesCurrent)
    .innerJoin(sites, eq(sites.id, ratesCurrent.siteId))
    .where(and(eq(ratesCurrent.id, rateId), isNull(sites.deletedAt)))
    .get();
  if (!target) throw new AppError('RATE_NOT_FOUND', '倍率对象不存在', 404);
  if (requireEnabled && (!target.site.enabled || target.rate.removedAt !== null)) {
    throw new AppError('RATE_NOT_PROBEABLE', '该倍率对象当前不可进行模型实测', 409);
  }
  return target;
}

function configRow(context: AppContext, rateId: string): ProbeConfigRow | undefined {
  return context.database.db.select().from(rateProbeConfigs)
    .where(eq(rateProbeConfigs.rateId, rateId)).get();
}

function configDto(context: AppContext, target: ProbeTarget, row?: ProbeConfigRow) {
  const credentialType = row?.customCredentialType ?? customCredentialType(target.rate.id);
  const presentKeys = credentialPresence(context.database, target.site.id);
  const boundKeyPresent = presentKeys.includes(credentialType)
    || Boolean((row?.useSiteApiKey ?? false) && presentKeys.includes('api_key'));
  return {
    rate_id: target.rate.id,
    configured: row !== undefined,
    model_mode: (row?.modelMode ?? 'auto') as 'auto' | 'manual',
    model: row?.model ?? null,
    key_mode: (row?.keyMode ?? 'bound') as 'bound' | 'existing' | 'auto_create' | 'manual',
    bound_key_present: boundKeyPresent,
    upstream_key_id: row?.upstreamKeyId ?? null,
    upstream_key_name: null,
    use_site_api_key: row?.useSiteApiKey ?? true,
    custom_api_key_present: presentKeys.includes(credentialType),
    max_output_tokens: normalizedMaxOutputTokens(row?.maxOutputTokens ?? DEFAULT_RATE_PROBE_MAX_OUTPUT_TOKENS),
    auto_probe_enabled: row?.enabled ?? false,
    probe_interval_seconds: row?.intervalSeconds ?? DEFAULT_RATE_PROBE_INTERVAL_SECONDS,
    timeout_seconds: row?.timeoutSeconds ?? DEFAULT_RATE_PROBE_TIMEOUT_SECONDS,
    retry_count: row?.retryCount ?? DEFAULT_RATE_PROBE_RETRY_COUNT,
    retry_interval_seconds: row?.retryIntervalSeconds ?? DEFAULT_RATE_PROBE_RETRY_INTERVAL_SECONDS,
    next_run_at: row?.nextRunAt ?? null,
    last_run_at: row?.lastRunAt ?? null,
    auto_create_quota_limit: row?.autoCreateQuotaLimit === null || row?.autoCreateQuotaLimit === undefined
      ? null
      : Number(row.autoCreateQuotaLimit),
    auto_create_expires_in_seconds: row?.autoCreateExpiresInSeconds ?? null,
    updated_at: row?.updatedAt ?? null,
  };
}

function parseEvidence(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function recoverStaleProbeRuns(context: AppContext, rateId?: string): void {
  const cutoff = new Date(Date.now() - STALE_RATE_PROBE_MS).toISOString();
  const staleHeartbeat = or(
    lt(rateProbeRuns.heartbeatAt, cutoff),
    and(isNull(rateProbeRuns.heartbeatAt), lt(rateProbeRuns.startedAt, cutoff)),
  );
  const conditions = [eq(rateProbeRuns.status, 'running'), staleHeartbeat];
  if (rateId) conditions.push(eq(rateProbeRuns.rateId, rateId));
  const completedAt = new Date().toISOString();
  const staleRuns = context.database.db.select().from(rateProbeRuns).where(and(...conditions)).all();
  if (staleRuns.length === 0) return;
  const errorMessage = probeErrorMessage('RATE_PROBE_INTERRUPTED');
  context.database.sqlite.transaction(() => {
    for (const stale of staleRuns) {
      const updated = context.database.db.update(rateProbeRuns).set({
        status: 'failed',
        promptIntegrity: 'unknown',
        knowledgeProbe: 'unknown',
        modelIdentity: 'unknown',
        errorCode: 'RATE_PROBE_INTERRUPTED',
        errorMessage,
        completedAt,
      }).where(and(
        eq(rateProbeRuns.id, stale.id),
        eq(rateProbeRuns.status, 'running'),
        staleHeartbeat,
      )).run();
      if (updated.changes !== 1) continue;
    }
  }).immediate();
}

export function rateProbeRunDto(row: ProbeRunRow) {
  const parsedTps = row.tps === null ? null : Number(row.tps);
  return {
    id: row.id,
    status: (row.status === 'succeeded' ? 'success' : row.status) as 'running' | 'success' | 'failed',
    attempt_count: row.attemptCount,
    requested_model: row.requestedModel,
    returned_model: row.returnedModel,
    ttfb_ms: row.ttfbMs,
    ttft_ms: row.ttftMs,
    total_ms: row.totalMs,
    generation_ms: row.generationMs,
    prompt_tokens: row.promptTokens,
    completion_tokens: row.completionTokens,
    total_tokens: row.totalTokens,
    cached_input_tokens: row.cachedInputTokens,
    reasoning_tokens: row.reasoningTokens,
    expected_input_tokens: row.expectedInputTokens,
    input_token_delta: row.inputTokenDelta,
    input_token_assessment: row.inputTokenAssessment as 'within_expected' | 'higher_than_expected' | 'unknown',
    tool_calls_observed: row.toolCallsObserved,
    tps: parsedTps !== null && Number.isFinite(parsedTps) ? parsedTps : null,
    finish_reason: row.finishReason,
    system_fingerprint: row.systemFingerprint,
    prompt_integrity: row.promptIntegrity as 'no_interference_observed' | 'suspected' | 'unknown',
    knowledge_probe: row.knowledgeProbe as 'weak_consistency' | 'suspicious' | 'not_applicable' | 'unknown',
    model_identity: row.modelIdentity as 'declared_match' | 'declared_mismatch' | 'unknown',
    evidence: parseEvidence(row.evidenceJson),
    response_hash: row.responseHash,
    http_status: row.httpStatus,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    started_at: row.startedAt,
    completed_at: row.completedAt,
    created_at: row.createdAt,
  };
}

export function latestRateProbe(context: AppContext, rateId: string) {
  recoverStaleProbeRuns(context, rateId);
  const row = context.database.db.select().from(rateProbeRuns)
    .where(eq(rateProbeRuns.rateId, rateId))
    .orderBy(desc(rateProbeRuns.startedAt), desc(rateProbeRuns.id))
    .get();
  return row ? rateProbeRunDto(row) : null;
}

export function getRateProbeConfig(context: AppContext, rateId: string) {
  const target = requireProbeTarget(context, rateId);
  return configDto(context, target, configRow(context, rateId));
}

export async function updateRateProbeConfig(
  context: AppContext,
  rateId: string,
  input: UpdateRateProbeConfigInput,
) {
  const target = requireProbeTarget(context, rateId);
  let existing = configRow(context, rateId);
  const credentialType = existing?.customCredentialType ?? customCredentialType(rateId);
  const model = input.model === undefined ? existing?.model ?? null : input.model?.trim() || null;
  const requestedKeyMode = input.keyMode
    ?? (input.useSiteApiKey === false
      ? 'manual'
      : existing?.keyMode as UpdateRateProbeConfigInput['keyMode'] ?? 'bound');
  const enabled = input.enabled ?? existing?.enabled ?? false;
  const intervalSeconds = input.intervalSeconds
    ?? existing?.intervalSeconds
    ?? DEFAULT_RATE_PROBE_INTERVAL_SECONDS;
  const timeoutSeconds = input.timeoutSeconds
    ?? existing?.timeoutSeconds
    ?? DEFAULT_RATE_PROBE_TIMEOUT_SECONDS;
  const retryCount = input.retryCount ?? existing?.retryCount ?? DEFAULT_RATE_PROBE_RETRY_COUNT;
  const retryIntervalSeconds = input.retryIntervalSeconds
    ?? existing?.retryIntervalSeconds
    ?? DEFAULT_RATE_PROBE_RETRY_INTERVAL_SECONDS;
  if (enabled && !model) {
    throw new AppError('RATE_PROBE_MODEL_REQUIRED', '启用自动实测前必须指定模型', 400);
  }
  if (input.maxOutputTokens < MIN_RATE_PROBE_MAX_OUTPUT_TOKENS || input.maxOutputTokens > 256) {
    throw new AppError('RATE_PROBE_MAX_OUTPUT_TOKENS_INVALID', '单次响应输出预算必须在 16 到 256 Token 之间', 400);
  }
  if (!Number.isInteger(intervalSeconds)
    || intervalSeconds < MIN_RATE_PROBE_INTERVAL_SECONDS
    || intervalSeconds > MAX_RATE_PROBE_INTERVAL_SECONDS
    || intervalSeconds % 60 !== 0) {
    throw new AppError('RATE_PROBE_INTERVAL_INVALID', '自动实测间隔必须填写正整数分钟', 400);
  }
  if (!Number.isInteger(timeoutSeconds)
    || timeoutSeconds < MIN_RATE_PROBE_TIMEOUT_SECONDS
    || timeoutSeconds > MAX_RATE_PROBE_TIMEOUT_SECONDS) {
    throw new AppError('RATE_PROBE_TIMEOUT_INVALID', '模型实测请求超时必须在 1 到 300 秒之间', 400);
  }
  if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 10) {
    throw new AppError('RATE_PROBE_RETRY_COUNT_INVALID', '失败重试次数必须在 0 到 10 次之间', 400);
  }
  if (!Number.isInteger(retryIntervalSeconds) || retryIntervalSeconds < 0 || retryIntervalSeconds > 3_600) {
    throw new AppError('RATE_PROBE_RETRY_INTERVAL_INVALID', '实测额外重试间隔必须在 0 秒到 60 分钟之间', 400);
  }

  let persistedKeyMode = requestedKeyMode;
  let useSiteApiKey = input.useSiteApiKey ?? existing?.useSiteApiKey ?? false;
  let upstreamKeyId = existing?.upstreamKeyId ?? null;
  let upstreamKeyManaged = existing?.upstreamKeyManaged ?? false;
  let autoCreateQuotaLimit = existing?.autoCreateQuotaLimit ?? null;
  let autoCreateExpiresInSeconds = existing?.autoCreateExpiresInSeconds ?? null;
  let pendingBinding: ResolvedProbeKeyMapping | undefined;

  if (requestedKeyMode === 'existing' || requestedKeyMode === 'auto_create') {
    const groupId = rateGroupId(target.rate.attributesJson);
    if (!groupId) {
      throw new AppError('RATE_GROUP_ID_MISSING', '该倍率缺少上游分组 ID，无法绑定分组 Key', 409);
    }
    if (requestedKeyMode === 'existing' && !input.upstreamKeyId) {
      throw new AppError('UPSTREAM_API_KEY_REQUIRED', '请选择与当前分组匹配的上游 Key', 400);
    }
    if (requestedKeyMode === 'auto_create' && !input.idempotencyKey) {
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', '自动创建上游 Key 必须提供 Idempotency-Key', 400);
    }
    const resolved = await resolveProbeKeyMappings(context, {
      adapter: context.adapters.get(target.site.adapterType),
      siteId: target.site.id,
      baseUrl: target.site.baseUrl,
      credentials: savedSiteCredentials(context, target.site),
      persistAuthUpdates: true,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      mappings: [{
        groupId,
        mode: requestedKeyMode,
        ...(input.upstreamKeyId ? { upstreamKeyId: input.upstreamKeyId } : {}),
        ...(input.autoCreate ? {
          ...(input.autoCreate.quotaLimit === undefined
            ? {}
            : { quotaLimit: input.autoCreate.quotaLimit }),
          ...(input.autoCreate.expiresInSeconds === undefined
            ? {}
            : { expiresInSeconds: input.autoCreate.expiresInSeconds }),
        } : {}),
      }],
    });
    const mapping = resolved[0]!;
    pendingBinding = mapping;
    persistedKeyMode = 'bound';
    useSiteApiKey = false;
    upstreamKeyId = mapping.key.id;
    upstreamKeyManaged = mapping.mode === 'auto_create';
    autoCreateQuotaLimit = mapping.quotaLimit === null ? null : String(mapping.quotaLimit);
    autoCreateExpiresInSeconds = mapping.expiresInSeconds;
  } else if (requestedKeyMode === 'manual') {
    useSiteApiKey = false;
    upstreamKeyId = null;
    upstreamKeyManaged = false;
    autoCreateQuotaLimit = null;
    autoCreateExpiresInSeconds = null;
    const hasStoredKey = credentialPresence(context.database, target.site.id).includes(credentialType)
      && !existing?.upstreamKeyManaged;
    const willHaveKey = input.customApiKey === null
      ? false
      : Boolean(input.customApiKey?.trim()) || hasStoredKey;
    if (enabled && !willHaveKey) {
      throw new AppError('RATE_PROBE_API_KEY_MISSING', '启用自动实测前必须提供当前分组的测试 Key', 400);
    }
  } else {
    const hasBoundKey = credentialPresence(context.database, target.site.id).includes(credentialType);
    if (!hasBoundKey && !useSiteApiKey) {
      throw new AppError('RATE_PROBE_API_KEY_MISSING', '当前分组尚未绑定专用测试 Key', 409);
    }
  }

  const shouldRevokePreviousManagedKey = Boolean(
    existing?.upstreamKeyManaged
    && existing.upstreamKeyId
    && (
      requestedKeyMode === 'manual'
      || (pendingBinding && pendingBinding.key.id !== existing.upstreamKeyId)
    ),
  );
  if (shouldRevokePreviousManagedKey) {
    await revokeManagedProbeKeyIds(context, target.site, [existing!.upstreamKeyId!]);
  }

  const now = new Date().toISOString();
  let nextRunAt: string | null = null;
  if (enabled) {
    nextRunAt = existing?.enabled ? existing.nextRunAt ?? now : now;
    if (existing?.enabled
      && input.intervalSeconds !== undefined
      && input.intervalSeconds !== existing.intervalSeconds) {
      const lastRun = existing.lastRunAt ? Date.parse(existing.lastRunAt) : Number.NaN;
      nextRunAt = Number.isFinite(lastRun)
        ? new Date(Math.max(Date.parse(now), lastRun + intervalSeconds * 1_000)).toISOString()
        : now;
    }
  }
  context.database.sqlite.transaction(() => {
    if (pendingBinding) {
      bindProbeKeyToRate(context, {
        rateId,
        siteId: target.site.id,
        key: pendingBinding.key,
        mode: pendingBinding.mode,
        quotaLimit: pendingBinding.quotaLimit,
        expiresInSeconds: pendingBinding.expiresInSeconds,
      });
    }
    const values = {
      modelMode: input.modelMode,
      model,
      keyMode: persistedKeyMode,
      useSiteApiKey,
      customCredentialType: credentialType,
      upstreamKeyId,
      upstreamKeyManaged,
      maxOutputTokens: input.maxOutputTokens,
      enabled,
      intervalSeconds,
      timeoutSeconds,
      retryCount,
      retryIntervalSeconds,
      nextRunAt,
      autoCreateQuotaLimit,
      autoCreateExpiresInSeconds,
      updatedAt: now,
    };
    const persisted = configRow(context, rateId);
    if (persisted) {
      context.database.db.update(rateProbeConfigs).set(values)
        .where(eq(rateProbeConfigs.id, persisted.id)).run();
    } else {
      context.database.db.insert(rateProbeConfigs).values({
        id: createId('probeconfig'),
        rateId,
        siteId: target.site.id,
        ...values,
      }).run();
    }
    if (input.customApiKey === null) {
      revokeCredentials(context.database, target.site.id, [credentialType]);
    } else if (input.customApiKey !== undefined) {
      storeCredentials(context.database, context.vault, target.site.id, {
        [credentialType]: input.customApiKey,
      }, { persistKeys: [credentialType] });
    }
  }).immediate();
  return configDto(context, target, configRow(context, rateId));
}

function probeApiKey(context: AppContext, target: ProbeTarget, config?: ProbeConfigRow): string {
  const credentialType = config?.customCredentialType ?? customCredentialType(target.rate.id);
  const bound = loadCredentialValue(context.database, context.vault, target.site.id, credentialType)?.trim();
  const useSiteApiKey = config?.useSiteApiKey ?? true;
  const value = bound || (useSiteApiKey
    ? loadCredentialValue(context.database, context.vault, target.site.id, 'api_key')?.trim()
    : undefined);
  if (!value) {
    throw new AppError(
      'RATE_PROBE_API_KEY_MISSING',
      useSiteApiKey ? '该站点尚未配置模型 API Key' : '该倍率对象尚未配置独立测试 API Key',
      409,
    );
  }
  return value;
}

async function withProbeAdapter<T>(
  context: AppContext,
  target: ProbeTarget,
  config: ProbeConfigRow | undefined,
  signal: AbortSignal | undefined,
  operation: (
    adapter: ReturnType<AppContext['adapters']['get']>,
    siteContext: {
      siteId: string;
      baseUrl: string;
      credentials: Readonly<Record<string, string>>;
      fetch: typeof globalThis.fetch;
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ) => Promise<T>,
): Promise<T> {
  const adapter = context.adapters.get(target.site.adapterType);
  if (!adapter.manifest().capabilities.activeProbe) {
    throw new AppError('RATE_PROBE_UNSUPPORTED', '该站点适配器不支持模型实测', 409);
  }
  const apiKey = probeApiKey(context, target, config);
  const outbound = await createSafeFetchContext(target.site.baseUrl, {
    allowHttp: !context.config.isProduction,
    allowedCidrs: context.config.outboundAllowedCidrs,
  });
  try {
    return await operation(adapter, {
      siteId: target.site.id,
      baseUrl: outbound.baseUrl,
      credentials: { api_key: apiKey },
      fetch: outbound.fetch,
      timeoutMs: (config?.timeoutSeconds ?? DEFAULT_RATE_PROBE_TIMEOUT_SECONDS) * 1_000,
      ...(signal ? { signal } : {}),
    });
  } finally {
    await outbound.close();
  }
}

export async function listRateProbeModels(context: AppContext, rateId: string) {
  const target = requireProbeTarget(context, rateId, true);
  const config = configRow(context, rateId);
  return withProbeAdapter(context, target, config, undefined, async (adapter, siteContext) => {
    if (!adapter.listProbeModels) {
      throw new AppError('RATE_PROBE_UNSUPPORTED', '该站点适配器不支持获取模型列表', 409);
    }
    const catalog = await adapter.listProbeModels(siteContext);
    return {
      items: catalog.models.map(({ id }) => ({ id })),
      selected_model: config?.model ?? target.rate.model ?? null,
    };
  });
}

function ensureConfig(context: AppContext, target: ProbeTarget): ProbeConfigRow {
  const existing = configRow(context, target.rate.id);
  if (existing) return existing;
  const now = new Date().toISOString();
  context.database.db.insert(rateProbeConfigs).values({
    id: createId('probeconfig'),
    rateId: target.rate.id,
    siteId: target.site.id,
    modelMode: 'auto',
    model: null,
    useSiteApiKey: true,
    keyMode: 'bound',
    customCredentialType: customCredentialType(target.rate.id),
    maxOutputTokens: DEFAULT_RATE_PROBE_MAX_OUTPUT_TOKENS,
    updatedAt: now,
  }).run();
  return configRow(context, target.rate.id)!;
}

const RESPONSES_FRAMEWORK_TOKEN_ESTIMATE = 9;

export function expectedProbeInputTokens(systemPrompt: string, userPrompt: string): number {
  return Math.ceil((systemPrompt.length + userPrompt.length) / 4) + RESPONSES_FRAMEWORK_TOKEN_ESTIMATE;
}

export function assessProbeInputTokens(
  expected: number,
  reported: number | null,
): { delta: number | null; assessment: 'within_expected' | 'higher_than_expected' | 'unknown'; threshold: number } {
  const threshold = Math.max(16, Math.ceil(expected * 0.35));
  if (reported === null) return { delta: null, assessment: 'unknown', threshold };
  const delta = reported - expected;
  return {
    delta,
    assessment: delta > threshold
      ? 'higher_than_expected'
      : delta < -threshold ? 'unknown' : 'within_expected',
    threshold,
  };
}

export function assessProbeOutput(input: {
  targetKnowledge: boolean;
  outputText: string;
  canary: string;
  toolCallsObserved: boolean;
  upstreamToolsObserved: boolean;
  finishReason: string | null;
  completionTokens: number | null;
  maxOutputTokens: number;
}) {
  const canaryPresent = input.outputText.includes(input.canary);
  const landryPresent = /\blandry\b/i.test(input.outputText);
  const normalizedOutput = input.outputText.trim();
  const outputLines = normalizedOutput.split(/\r?\n/).map((line) => line.trim());
  const strictPromptMatch = input.targetKnowledge
    ? outputLines.length === 2
      && /^landry[.!]?$/.test(outputLines[0]!.toLocaleLowerCase())
      && outputLines[1] === input.canary
    : normalizedOutput === input.canary;
  const outputTruncated = input.finishReason === 'length'
    || (!strictPromptMatch
      && input.completionTokens !== null
      && input.completionTokens >= input.maxOutputTokens);
  const promptIntegrity = input.toolCallsObserved || input.upstreamToolsObserved
    ? 'suspected'
    : outputTruncated
      ? 'unknown'
      : strictPromptMatch ? 'no_interference_observed' : 'suspected';
  const knowledgeProbe = input.targetKnowledge
    ? outputTruncated
      ? 'unknown'
      : landryPresent ? 'weak_consistency' : 'suspicious'
    : 'not_applicable';
  return {
    canaryPresent,
    landryPresent,
    strictPromptMatch,
    outputTruncated,
    promptIntegrity: promptIntegrity as 'no_interference_observed' | 'suspected' | 'unknown',
    knowledgeProbe: knowledgeProbe as 'weak_consistency' | 'suspicious' | 'not_applicable' | 'unknown',
  };
}

function cleanError(error: unknown): { code: string; message: string; httpStatus: number | null } {
  if (error instanceof AdapterError) {
    const httpStatus = error.httpStatus ?? null;
    return {
      code: error.code,
      message: probeErrorMessage(error.code, httpStatus, redactString(error.message).slice(0, 500)),
      httpStatus,
    };
  }
  if (error instanceof AppError) {
    const fallback = redactString(error.message).slice(0, 500);
    return { code: error.code, message: probeErrorMessage(error.code, null, fallback), httpStatus: null };
  }
  return { code: 'RATE_PROBE_FAILED', message: probeErrorMessage('RATE_PROBE_FAILED'), httpStatus: null };
}

async function resolvedProbeModel(
  context: AppContext,
  target: ProbeTarget,
  config: ProbeConfigRow,
  override: string | undefined,
): Promise<string> {
  const configured = override?.trim() || config.model?.trim() || target.rate.model?.trim();
  if (configured) return configured;
  throw new AppError(
    'RATE_PROBE_MODEL_REQUIRED',
    config.modelMode === 'auto'
      ? '请先从上游模型列表选择一个模型'
      : '手动模式需要填写模型名称',
    409,
  );
}

function probeInterruptedError(): AppError {
  return new AppError('RATE_PROBE_INTERRUPTED', '模型实测已取消或服务正在停止', 409);
}

async function waitForProbeRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw probeInterruptedError();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finish = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(probeInterruptedError());
    };
    timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
    timer.unref();
  });
}

export async function runRateProbe(
  context: AppContext,
  rateId: string,
  modelOverride?: string,
  signal?: AbortSignal,
) {
  const target = requireProbeTarget(context, rateId, true);
  recoverStaleProbeRuns(context);
  const activeMonitor = context.database.db.select({ id: monitorJobs.id })
    .from(monitorJobs)
    .where(and(eq(monitorJobs.siteId, target.site.id), eq(monitorJobs.state, 'running')))
    .get();
  if (activeMonitor) {
    throw new AppError('SITE_MONITOR_IN_PROGRESS', '该站点正在执行监控任务，请稍后再实测', 409);
  }
  const persistedActiveRun = context.database.db.select({ id: rateProbeRuns.id })
    .from(rateProbeRuns)
    .where(and(eq(rateProbeRuns.siteId, target.site.id), eq(rateProbeRuns.status, 'running')))
    .get();
  if (activeProbeSites.has(target.site.id) || persistedActiveRun) {
    throw new AppError('RATE_PROBE_IN_PROGRESS', '该站点已有模型实测正在运行', 409);
  }
  activeProbeSites.add(target.site.id);
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const config = ensureConfig(context, target);
    const model = await resolvedProbeModel(context, target, config, modelOverride);
    const templatePrompt = buildRateProbePrompt(model, `RELAY_MONITOR_${'0'.repeat(24)}`);
    const expectedInputTokens = expectedProbeInputTokens(
      templatePrompt.systemPrompt,
      templatePrompt.userPrompt,
    );
    const maxOutputTokens = normalizedMaxOutputTokens(config.maxOutputTokens);
    const maxAttempts = config.retryCount + 1;
    const requestEvidence = {
      expected_input_tokens_heuristic: expectedInputTokens,
      input_token_estimate_method: 'ceil((instructions_chars + input_chars) / 4) + 9',
      request_protocol: RATE_PROBE_PROTOCOL,
      request_path: RATE_PROBE_ENDPOINT,
      client_tools_declared: false,
      client_tool_choice: 'none',
      prompt_template_id: RATE_PROBE_PROMPT_TEMPLATE_ID,
      instructions_chars: templatePrompt.systemPrompt.length,
      input_chars: templatePrompt.userPrompt.length,
      max_attempts: maxAttempts,
      timeout_seconds: config.timeoutSeconds,
      retry_interval_seconds: config.retryIntervalSeconds,
      heuristic_only: true,
    };
    const runId = createId('proberun');
    const startedAt = new Date().toISOString();
    const claim = context.database.sqlite.transaction((): 'claimed' | 'monitor' | 'probe' => {
      const monitor = context.database.db.select({ id: monitorJobs.id })
        .from(monitorJobs)
        .where(and(eq(monitorJobs.siteId, target.site.id), eq(monitorJobs.state, 'running')))
        .get();
      if (monitor) return 'monitor';
      const claimed = context.database.db.insert(rateProbeRuns).values({
        id: runId,
        configId: config.id,
        rateId: target.rate.id,
        siteId: target.site.id,
        status: 'running',
        attemptCount: 1,
        heartbeatAt: startedAt,
        requestedModel: model,
        expectedInputTokens,
        evidenceJson: JSON.stringify(requestEvidence),
        startedAt,
      }).onConflictDoNothing().run();
      return claimed.changes === 1 ? 'claimed' : 'probe';
    }).immediate();
    if (claim === 'monitor') {
      throw new AppError('SITE_MONITOR_IN_PROGRESS', '该站点正在执行监控任务，请稍后再实测', 409);
    }
    if (claim === 'probe') {
      throw new AppError('RATE_PROBE_IN_PROGRESS', '该站点已有模型实测正在运行', 409);
    }

    heartbeat = setInterval(() => {
      context.database.db.update(rateProbeRuns).set({ heartbeatAt: new Date().toISOString() })
        .where(and(eq(rateProbeRuns.id, runId), eq(rateProbeRuns.status, 'running'))).run();
    }, RATE_PROBE_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    try {
      let attemptCount = 0;
      let successfulAttempt: {
        result: ModelProbeResult;
        canary: string;
      } | undefined;
      while (!successfulAttempt) {
        if (signal?.aborted) throw probeInterruptedError();
        attemptCount += 1;
        const canary = `RELAY_MONITOR_${randomBytes(12).toString('hex').toUpperCase()}`;
        const prompt = buildRateProbePrompt(model, canary);
        const attemptAt = new Date().toISOString();
        const attemptEvidence = {
          ...requestEvidence,
          attempt_count: attemptCount,
          request_failed: false,
        };
        const prepared = context.database.db.update(rateProbeRuns).set({
          attemptCount,
          heartbeatAt: attemptAt,
          evidenceJson: JSON.stringify(attemptEvidence),
        }).where(and(eq(rateProbeRuns.id, runId), eq(rateProbeRuns.status, 'running'))).run();
        if (prepared.changes !== 1) throw probeInterruptedError();
        try {
          const result = await withProbeAdapter(context, target, config, signal, async (adapter, siteContext) => {
            if (!adapter.probeModel) {
              throw new AppError('RATE_PROBE_UNSUPPORTED', '该站点适配器不支持模型实测', 409);
            }
            return adapter.probeModel(siteContext, {
              model,
              maxOutputTokens,
              systemPrompt: prompt.systemPrompt,
              userPrompt: prompt.userPrompt,
            });
          });
          successfulAttempt = { result, canary };
        } catch (error) {
          if (signal?.aborted) throw probeInterruptedError();
          const adapterError = error instanceof AdapterError ? error : undefined;
          if (!adapterError?.retryable || attemptCount >= maxAttempts) throw error;
          const cleaned = cleanError(error);
          const delayMs = Math.max(
            config.retryIntervalSeconds * 1_000,
            adapterError.retryAfterMs ?? 0,
          );
          context.database.db.update(rateProbeRuns).set({
            heartbeatAt: new Date().toISOString(),
            evidenceJson: JSON.stringify({
              ...attemptEvidence,
              request_failed: true,
              last_attempt_error_code: cleaned.code,
              last_attempt_http_status: cleaned.httpStatus,
              next_retry_delay_ms: delayMs,
            }),
          }).where(and(eq(rateProbeRuns.id, runId), eq(rateProbeRuns.status, 'running'))).run();
          await waitForProbeRetry(delayMs, signal);
        }
      }
      const { result, canary } = successfulAttempt;
      const completedAt = new Date().toISOString();
      const targetKnowledge = isSolKnowledgeProbeModel(model);
      const modelMatch = result.returnedModel === null
        ? null
        : rateProbeModelIdentityKey(result.returnedModel) === rateProbeModelIdentityKey(model);
      const outputEvidence = assessProbeOutput({
        targetKnowledge,
        outputText: result.outputText,
        canary,
        toolCallsObserved: result.toolCallsObserved,
        upstreamToolsObserved: result.upstreamToolsObserved,
        finishReason: result.finishReason,
        completionTokens: result.usage.completionTokens,
        maxOutputTokens,
      });
      const inputTokenEvidence = assessProbeInputTokens(expectedInputTokens, result.usage.promptTokens);
      const modelIdentity = modelMatch === null
        ? 'unknown'
        : modelMatch ? 'declared_match' : 'declared_mismatch';
      const evidence = {
        ...requestEvidence,
        attempt_count: attemptCount,
        canary_present: outputEvidence.canaryPresent,
        strict_response_format_match: outputEvidence.strictPromptMatch,
        output_truncated_or_limit_reached: outputEvidence.outputTruncated,
        unexpected_tool_calls_observed: result.toolCallsObserved,
        upstream_tools_observed: result.upstreamToolsObserved,
        input_token_delta_threshold: inputTokenEvidence.threshold,
        requested_returned_model_match: modelMatch,
        landry_present: targetKnowledge ? outputEvidence.landryPresent : null,
        system_fingerprint_is_weak_deprecated_evidence: result.systemFingerprint !== null,
      };
      context.database.sqlite.transaction(() => {
        const updated = context.database.db.update(rateProbeRuns).set({
          status: 'succeeded',
          attemptCount,
          heartbeatAt: completedAt,
          returnedModel: result.returnedModel,
          ttfbMs: result.ttfbMs,
          ttftMs: result.ttftMs,
          totalMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
          generationMs: result.generationMs,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          reasoningTokens: result.usage.reasoningTokens,
          expectedInputTokens,
          inputTokenDelta: inputTokenEvidence.delta,
          inputTokenAssessment: inputTokenEvidence.assessment,
          toolCallsObserved: result.toolCallsObserved,
          tps: result.tps,
          finishReason: result.finishReason,
          systemFingerprint: result.systemFingerprint,
          promptIntegrity: outputEvidence.promptIntegrity,
          knowledgeProbe: outputEvidence.knowledgeProbe,
          modelIdentity,
          evidenceJson: JSON.stringify(evidence),
          responseHash: createHash('sha256').update(result.outputText, 'utf8').digest('hex'),
          httpStatus: result.httpStatus,
          completedAt,
        }).where(and(eq(rateProbeRuns.id, runId), eq(rateProbeRuns.status, 'running'))).run();
        if (updated.changes !== 1) return;
        evaluateProbeAlertsInTransaction(context.database, {
          siteId: target.site.id,
          rateKey: target.rate.rateKey,
          rateKind: target.rate.rateKind,
          rateName: target.rate.name,
          observedAt: completedAt,
          requestedModel: model,
          status: 'success',
          inputTokenAssessment: inputTokenEvidence.assessment,
          toolCallsObserved: result.toolCallsObserved,
          upstreamToolsObserved: result.upstreamToolsObserved,
          promptIntegrity: outputEvidence.promptIntegrity,
          modelIdentity,
          reportedInputTokens: result.usage.promptTokens,
          expectedInputTokens,
          inputTokenDelta: inputTokenEvidence.delta,
          cachedInputTokens: result.usage.cachedInputTokens,
          requestProtocol: RATE_PROBE_PROTOCOL,
        });
      }).immediate();
    } catch (error) {
      const failedAt = new Date().toISOString();
      const cleaned = cleanError(error);
      const failedElapsedMs = Math.max(0, Date.parse(failedAt) - Date.parse(startedAt));
      const attemptCount = context.database.db.select({ value: rateProbeRuns.attemptCount })
        .from(rateProbeRuns).where(eq(rateProbeRuns.id, runId)).get()?.value ?? 1;
      const interrupted = cleaned.code === 'RATE_PROBE_INTERRUPTED';
      context.database.sqlite.transaction(() => {
        const updated = context.database.db.update(rateProbeRuns).set({
          status: 'failed',
          attemptCount,
          heartbeatAt: failedAt,
          totalMs: failedElapsedMs,
          promptIntegrity: 'unknown',
          knowledgeProbe: 'unknown',
          modelIdentity: 'unknown',
          evidenceJson: JSON.stringify({
            ...requestEvidence,
            attempt_count: attemptCount,
            request_failed: true,
            error_code: cleaned.code,
            http_status: cleaned.httpStatus,
          }),
          httpStatus: cleaned.httpStatus,
          errorCode: cleaned.code,
          errorMessage: cleaned.message,
          completedAt: failedAt,
        }).where(and(eq(rateProbeRuns.id, runId), eq(rateProbeRuns.status, 'running'))).run();
        if (updated.changes !== 1 || interrupted) return;
        evaluateProbeAlertsInTransaction(context.database, {
          siteId: target.site.id,
          rateKey: target.rate.rateKey,
          rateKind: target.rate.rateKind,
          rateName: target.rate.name,
          observedAt: failedAt,
          requestedModel: model,
          status: 'failed',
          requestProtocol: RATE_PROBE_PROTOCOL,
          httpStatus: cleaned.httpStatus,
          errorCode: cleaned.code,
          errorMessage: cleaned.message,
        });
      }).immediate();
    }
    const stored = context.database.db.select().from(rateProbeRuns)
      .where(eq(rateProbeRuns.id, runId)).get();
    if (!stored) throw new AppError('RATE_PROBE_RESULT_MISSING', '模型实测结果未能保存', 500);
    const finishedAt = stored.completedAt ?? new Date().toISOString();
    const refreshedConfig = configRow(context, rateId);
    if (refreshedConfig) {
      context.database.db.update(rateProbeConfigs).set({
        lastRunAt: finishedAt,
        nextRunAt: refreshedConfig.enabled
          ? new Date(Date.parse(finishedAt) + refreshedConfig.intervalSeconds * 1_000).toISOString()
          : null,
        updatedAt: finishedAt,
      }).where(eq(rateProbeConfigs.id, refreshedConfig.id)).run();
    }
    return rateProbeRunDto(stored);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    activeProbeSites.delete(target.site.id);
  }
}

export function listRateProbeRuns(
  context: AppContext,
  rateId: string,
  page: number,
  pageSize: number,
) {
  requireProbeTarget(context, rateId);
  recoverStaleProbeRuns(context, rateId);
  const where = eq(rateProbeRuns.rateId, rateId);
  const total = context.database.db.select({ value: count() }).from(rateProbeRuns)
    .where(where)
    .get()?.value ?? 0;
  const offset = (page - 1) * pageSize;
  const items = context.database.db.select().from(rateProbeRuns)
    .where(where)
    .orderBy(desc(rateProbeRuns.startedAt), desc(rateProbeRuns.id))
    .limit(pageSize)
    .offset(offset)
    .all();
  return {
    items: items.map(rateProbeRunDto),
    page,
    page_size: pageSize,
    total,
  };
}
