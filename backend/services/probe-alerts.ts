import { eq, inArray } from 'drizzle-orm';

import type { DatabaseConnection } from '../db/index.js';
import { outboxMessages } from '../db/index.js';
import {
  evaluateAlertRulesInTransaction,
  type AlertEngineEvaluationResult,
} from './alert-engine.js';

export interface ProbeAlertInput {
  siteId: string;
  rateKey: string;
  rateKind?: string | undefined;
  rateName?: string | undefined;
  observedAt: string;
  requestedModel: string;
  status: 'success' | 'failed';
  inputTokenAssessment?: 'within_expected' | 'higher_than_expected' | 'unknown' | undefined;
  toolCallsObserved?: boolean | undefined;
  upstreamToolsObserved?: boolean | undefined;
  promptIntegrity?: 'no_interference_observed' | 'suspected' | 'unknown' | undefined;
  modelIdentity?: 'declared_match' | 'declared_mismatch' | 'unknown' | undefined;
  reportedInputTokens?: number | null | undefined;
  expectedInputTokens?: number | null | undefined;
  inputTokenDelta?: number | null | undefined;
  cachedInputTokens?: number | null | undefined;
  requestProtocol?: string | undefined;
  httpStatus?: number | null | undefined;
  errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined;
}

type ProbeSignal = {
  eventType: string;
  violating: boolean;
  summary: string;
};

type JsonObject = Record<string, unknown>;

function jsonObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function parsePayload(value: string): JsonObject | undefined {
  try {
    return jsonObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

const probeFindingLabels: Readonly<Record<string, string>> = {
  'probe.input_tokens_high': '输入 Token 高于客户端字符粗估',
  'probe.unexpected_tool_calls': '返回了未声明的 tool_calls',
  'probe.prompt_interference': '疑似存在提示词干扰',
  'probe.model_mismatch': '模型返回声明与请求不匹配',
};

function mergedProbeSummary(
  payload: JsonObject,
  input: ProbeAlertInput,
  notificationKind: string,
  eventTypes: readonly string[],
): string {
  const siteName = String(jsonObject(payload.site)?.name ?? input.siteId);
  const rateName = input.rateName ?? input.rateKey;
  const labels = eventTypes.map((eventType) => probeFindingLabels[eventType] ?? eventType);
  const findingCount = labels.length;
  const heading = notificationKind === 'recovery'
    ? `模型实测有 ${findingCount} 项异常已恢复`
    : notificationKind === 'repeat'
      ? `模型实测仍有 ${findingCount} 项异常`
      : `模型实测发现 ${findingCount} 项异常`;
  return `${siteName} · ${rateName} · ${heading}：${labels.join('；')}`;
}

function mergeProbeFindingNotificationsInTransaction(
  database: DatabaseConnection,
  input: ProbeAlertInput,
  results: readonly AlertEngineEvaluationResult[],
): void {
  const evaluationByOutboxId = new Map<string, {
    ruleRevisionId: string;
    eventType: string;
  }>();
  for (const result of results) {
    for (const evaluation of result.evaluations) {
      if (!(evaluation.eventType in probeFindingLabels)) continue;
      for (const outboxId of evaluation.outboxMessageIds) {
        evaluationByOutboxId.set(outboxId, {
          ruleRevisionId: evaluation.ruleRevisionId,
          eventType: evaluation.eventType,
        });
      }
    }
  }
  const outboxIds = [...evaluationByOutboxId.keys()];
  if (outboxIds.length < 2) return;

  const position = new Map(outboxIds.map((id, index) => [id, index]));
  const candidates = database.db.select({
    id: outboxMessages.id,
    incidentId: outboxMessages.incidentId,
    channelId: outboxMessages.channelId,
    payloadJson: outboxMessages.payloadJson,
    state: outboxMessages.state,
    attempts: outboxMessages.attempts,
  }).from(outboxMessages).where(inArray(outboxMessages.id, outboxIds)).all()
    .sort((left, right) => (position.get(left.id) ?? 0) - (position.get(right.id) ?? 0));
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    if (candidate.state !== 'pending' || candidate.attempts !== 0) continue;
    const evaluation = evaluationByOutboxId.get(candidate.id);
    const payload = parsePayload(candidate.payloadJson);
    const notificationKind = typeof payload?.notification_kind === 'string'
      ? payload.notification_kind
      : undefined;
    if (!evaluation || !notificationKind) continue;
    const repeatNumber = typeof payload?.repeat_number === 'number'
      ? payload.repeat_number
      : '';
    const key = [
      evaluation.ruleRevisionId,
      candidate.channelId,
      notificationKind,
      repeatNumber,
    ].join('\u0000');
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const primary = group[0]!;
    const primaryPayload = parsePayload(primary.payloadJson);
    if (!primaryPayload) continue;
    const parsed = group.map((candidate) => ({
      candidate,
      payload: parsePayload(candidate.payloadJson),
      evaluation: evaluationByOutboxId.get(candidate.id),
    })).filter((entry): entry is typeof entry & {
      payload: JsonObject;
      evaluation: { ruleRevisionId: string; eventType: string };
    } => entry.payload !== undefined && entry.evaluation !== undefined);
    if (parsed.length < 2) continue;
    const notificationKind = String(primaryPayload.notification_kind ?? 'trigger');
    const eventTypes = [...new Set(parsed.map(({ evaluation }) => evaluation.eventType))];
    const summary = mergedProbeSummary(primaryPayload, input, notificationKind, eventTypes);
    const primaryIncident = jsonObject(primaryPayload.incident) ?? {};
    const primaryDetails = jsonObject(primaryPayload.details) ?? {};
    const findings = parsed.map(({ candidate, payload, evaluation }) => ({
      event: evaluation.eventType,
      incident_id: candidate.incidentId,
      summary: jsonObject(payload.incident)?.summary ?? probeFindingLabels[evaluation.eventType],
      repeat_number: typeof payload.repeat_number === 'number' ? payload.repeat_number : null,
    }));
    const mergedPayload: JsonObject = {
      ...primaryPayload,
      event_types: eventTypes,
      incident: {
        ...primaryIncident,
        summary,
        related_incident_ids: parsed.map(({ candidate }) => candidate.incidentId),
      },
      incidents: findings,
      details: {
        ...primaryDetails,
        probe_notification_merged: true,
        probe_findings: findings,
      },
    };
    database.db.update(outboxMessages).set({
      payloadJson: JSON.stringify(mergedPayload),
      updatedAt: input.observedAt,
    }).where(eq(outboxMessages.id, primary.id)).run();
    database.db.delete(outboxMessages)
      .where(inArray(outboxMessages.id, group.slice(1).map(({ id }) => id))).run();
  }
}

export function evaluateProbeAlertsInTransaction(
  database: DatabaseConnection,
  input: ProbeAlertInput,
): void {
  const failed = input.status === 'failed';
  const signals: ProbeSignal[] = [{
    eventType: 'probe.failed',
    violating: failed,
    summary: failed
      ? `${input.rateName ?? input.rateKey} · 模型实测失败`
      : `${input.rateName ?? input.rateKey} · 模型实测已恢复`,
  }];
  if (!failed) {
    const rateName = input.rateName ?? input.rateKey;
    const inputTokensHigh = input.inputTokenAssessment === 'higher_than_expected';
    const unexpectedToolCalls = input.toolCallsObserved === true;
    const promptInterference = input.promptIntegrity === 'suspected';
    const modelMismatch = input.modelIdentity === 'declared_mismatch';
    signals.push(
      {
        eventType: 'probe.input_tokens_high',
        violating: inputTokensHigh,
        summary: inputTokensHigh
          ? `${rateName} · 输入 Token 高于客户端字符粗估`
          : `${rateName} · 输入 Token 异常已恢复`,
      },
      {
        eventType: 'probe.unexpected_tool_calls',
        violating: unexpectedToolCalls,
        summary: unexpectedToolCalls
          ? `${rateName} · 返回了未声明的 tool_calls`
          : `${rateName} · 未声明 tool_calls 异常已恢复`,
      },
      {
        eventType: 'probe.prompt_interference',
        violating: promptInterference,
        summary: promptInterference
          ? `${rateName} · 疑似存在提示词干扰`
          : `${rateName} · 提示词干扰线索已恢复`,
      },
      {
        eventType: 'probe.model_mismatch',
        violating: modelMismatch,
        summary: modelMismatch
          ? `${rateName} · 模型返回声明与请求不匹配`
          : `${rateName} · 模型声明异常已恢复`,
      },
    );
  }

  const results: AlertEngineEvaluationResult[] = [];
  for (const signal of signals) {
    results.push(evaluateAlertRulesInTransaction(database, {
      kind: 'rate',
      siteId: input.siteId,
      observedAt: input.observedAt,
      rateKey: input.rateKey,
      ...(input.rateKind ? { rateKind: input.rateKind } : {}),
      ...(input.rateName ? { rateName: input.rateName } : {}),
      value: null,
      eventType: signal.eventType,
      resourceKey: `probe:${input.rateKey}`,
      violating: signal.violating,
      summary: signal.summary,
      details: {
        requested_model: input.requestedModel,
        input_token_assessment: input.inputTokenAssessment ?? null,
        reported_input_tokens: input.reportedInputTokens ?? null,
        expected_input_tokens: input.expectedInputTokens ?? null,
        input_token_delta: input.inputTokenDelta ?? null,
        cached_input_tokens: input.cachedInputTokens ?? null,
        request_protocol: input.requestProtocol ?? null,
        http_status: input.httpStatus ?? null,
        client_tools_declared: false,
        upstream_tools_observed: input.upstreamToolsObserved ?? null,
        unexpected_tool_calls: input.toolCallsObserved ?? null,
        prompt_integrity: input.promptIntegrity ?? null,
        model_identity: input.modelIdentity ?? null,
        error_code: input.errorCode ?? null,
        error_message: input.errorMessage ?? null,
      },
    }));
  }
  mergeProbeFindingNotificationsInTransaction(database, input, results);
}
