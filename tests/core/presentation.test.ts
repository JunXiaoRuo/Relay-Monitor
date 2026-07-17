import { describe, expect, it } from 'vitest';

import {
  auditActionLabel,
  auditResourceTypeLabel,
  groupIncidentsByRoot,
  incidentDisplaySummary,
  incidentDisplayTitle,
  incidentEventTypeLabel,
  incidentMatchesLifecycleTab,
  incidentResourceDisplayLabel,
  incidentResourceLabel,
  incidentSuppressionReasonLabel,
  isOneTimeRateEvent,
  localizeIncidentText,
  rateCombinedHealth,
  rateUnitLabel,
} from '../../frontend/src/services/presentation.js';

describe('frontend presentation labels', () => {
  it('localizes audit actions and resources with readable fallbacks', () => {
    expect(auditActionLabel('notification_rule.create')).toBe('创建告警规则');
    expect(auditActionLabel('site.probe_key_create')).toBe('创建分组实测 Key');
    expect(auditResourceTypeLabel('outbox_message')).toBe('通知投递');
    expect(auditActionLabel('admin.password_change')).toBe('修改管理员密码');
    expect(auditActionLabel('admin.password_change_failed')).toBe('修改管理员密码失败');
    expect(auditActionLabel('audit.delete')).toBe('删除审计记录');
    expect(auditActionLabel('incident.soft_delete')).toBe('删除事件（旧版本）');
    expect(auditActionLabel('incident.delete')).toBe('删除事件');
    expect(auditResourceTypeLabel('audit_log')).toBe('审计记录');
    expect(auditActionLabel('silence.update')).toBe('更新临时静默');
    expect(auditActionLabel('silence.end')).toBe('结束临时静默');
    expect(auditActionLabel('silence.soft_delete')).toBe('删除临时静默（旧版本）');
    expect(auditActionLabel('silence.delete')).toBe('删除临时静默');
    expect(auditActionLabel('custom.thing_done')).toBe('其他操作（custom thing done）');
  });

  it('localizes incident event types and historical English summaries', () => {
    expect(incidentEventTypeLabel('site.timeout')).toBe('请求超时');
    expect(localizeIncidentText('Harbor API has failed four consecutive checks', '港湾备用站'))
      .toBe('港湾备用站已连续 4 次检查失败。');
    expect(localizeIncidentText('Relay health is degraded', '北辰主站')).toBe('北辰主站服务状态为降级。');
    expect(localizeIncidentText('Relay rate group:1 changed', '北辰主站')).toBe('北辰主站的倍率 group:1 已变化。');
    const incident = {
      title: 'Harbor API has failed four consecutive checks',
      summary: 'Harbor API has failed four consecutive checks',
      event_type: 'site.timeout',
      site_name: '港湾备用站',
    };
    expect(incidentDisplayTitle(incident)).toBe('港湾备用站 · 请求超时');
    expect(incidentDisplaySummary(incident)).toBe('港湾备用站已连续 4 次检查失败。');
  });

  it('localizes incident resources while preserving stable grouping semantics', () => {
    expect(incidentResourceLabel('site')).toBe('站点连通性');
    expect(incidentResourceLabel('auth')).toBe('登录与认证');
    expect(incidentResourceLabel('monitor:connectivity')).toBe('连通性监控');
    expect(incidentResourceLabel('monitor:rates')).toBe('倍率监控');
    expect(incidentResourceLabel('monitor:balance')).toBe('余额监控');
    expect(incidentResourceLabel('probe:rate_01')).toBe('分组模型实测');
    expect(incidentResourceLabel('rate:group_01')).toBe('分组倍率');
    expect(incidentResourceLabel('balance:primary')).toBe('余额指标');
    expect(incidentResourceLabel('unknown:key')).toBe('其他监控资源');
    expect(incidentSuppressionReasonLabel('root_cause_dependency')).toBe('由关联的根因事件统一告警');
    expect(incidentSuppressionReasonLabel('maintenance:mw_01')).toBe('处于维护窗口，通知已暂停');
    expect(rateUnitLabel('multiplier')).toBe('计费倍率');
  });

  it('presents rate changes as named one-time records with their previous and current values', () => {
    const changed = {
      title: '麻豆的倍率 group:44:effective 已变化。',
      summary: '麻豆的倍率 group:44:effective 已变化。',
      event_type: 'rate.changed',
      site_name: '麻豆',
      resource_key: 'rate:group:44:effective',
      details: {
        rate_kind: 'group',
        rate_name: 'OpenAI 标准组',
        old_rate: '0.02',
        new_rate: '0.08',
      },
    };
    expect(isOneTimeRateEvent(changed.event_type)).toBe(true);
    expect(isOneTimeRateEvent('site.timeout')).toBe(false);
    expect(incidentDisplayTitle(changed)).toBe('麻豆 · 倍率变化 · 分组“OpenAI 标准组”');
    expect(incidentDisplaySummary(changed)).toBe('麻豆的分组“OpenAI 标准组”的计费倍率由 0.02 变为 0.08。');
    expect(incidentResourceDisplayLabel(changed)).toBe('分组“OpenAI 标准组”的计费倍率');

    const historical = { ...changed, details: undefined };
    expect(incidentDisplaySummary(historical)).toBe('麻豆的分组“44”的计费倍率已变化。');
    expect(incidentResourceDisplayLabel(historical)).toBe('分组“44”的计费倍率');

    expect(incidentDisplaySummary({
      ...changed,
      event_type: 'rate.added',
      details: { ...changed.details, old_rate: null, new_rate: '0.12' },
    })).toBe('麻豆新增了分组“OpenAI 标准组”的计费倍率，当前为 0.12。');
    expect(incidentDisplaySummary({
      ...changed,
      event_type: 'rate.removed',
      details: { ...changed.details, old_rate: '0.12', new_rate: null },
    })).toBe('麻豆移除了分组“OpenAI 标准组”的计费倍率，移除前为 0.12。');

    const resolvedFailure = { event_type: 'site.timeout', state: 'resolved' };
    const recordedChange = { event_type: 'rate.changed', state: 'resolved' };
    expect(incidentMatchesLifecycleTab(recordedChange, 'rate_changes')).toBe(true);
    expect(incidentMatchesLifecycleTab(recordedChange, 'active')).toBe(false);
    expect(incidentMatchesLifecycleTab(recordedChange, 'resolved')).toBe(false);
    expect(incidentMatchesLifecycleTab(recordedChange, 'all')).toBe(true);
    expect(incidentMatchesLifecycleTab(resolvedFailure, 'resolved')).toBe(true);
  });

  it('groups dependencies only when their root incident is in the filtered result', () => {
    const root = { id: 'root' };
    const rates = { id: 'rates', suppressed_by_incident_id: 'root' };
    const balance = { id: 'balance', suppressed_by_incident_id: 'root' };
    const all = [root, rates, balance];

    expect(groupIncidentsByRoot(all, all)).toEqual([
      { incident: root, dependencies: [rates, balance] },
    ]);
    expect(groupIncidentsByRoot([rates], all)).toEqual([
      { incident: rates, dependencies: [] },
    ]);
    expect(groupIncidentsByRoot([root], all)).toEqual([
      { incident: root, dependencies: [] },
    ]);
    expect(groupIncidentsByRoot([root, rates], all)).toEqual([
      { incident: root, dependencies: [rates] },
    ]);
  });

  it('combines site, rate collection, metadata, and model probe health into one status', () => {
    const baseRate = {
      metadata_status: 'available' as const,
      collected_at: '2026-07-15T01:00:00.000Z',
      rate_monitor: {
        state: 'queued' as const,
        last_finished_at: '2026-07-15T01:00:00.000Z',
        last_success_at: '2026-07-15T01:00:00.000Z',
        last_error_code: null,
        last_error_message: null,
      },
    };
    const time = (value: string | null | undefined) => value ? `时间:${value}` : '—';

    const notProbed = rateCombinedHealth(baseRate, { service_status: 'healthy' }, time);
    expect(notProbed).toMatchObject({ badgeStatus: 'healthy', label: '正常', reasons: [] });
    expect(notProbed.summary).toContain('模型实测：尚未实测（不影响综合状态）');
    expect(notProbed.summary).toContain('倍率采集：正常');

    expect(rateCombinedHealth(baseRate, { service_status: 'down' }, time)).toMatchObject({
      badgeStatus: 'down', label: '宕机',
    });

    const collectionFailed = rateCombinedHealth({
      ...baseRate,
      rate_monitor: {
        ...baseRate.rate_monitor,
        last_error_code: 'UPSTREAM_UNREACHABLE',
        last_error_message: 'raw error',
      },
    }, { service_status: 'healthy' }, time);
    expect(collectionFailed).toMatchObject({ badgeStatus: 'warning', label: '异常' });
    expect(collectionFailed.reasons).toContain('倍率采集失败：网络不可达');

    const stale = rateCombinedHealth({ ...baseRate, metadata_status: 'stale' }, { service_status: 'healthy' }, time);
    expect(stale.reasons).toContain('倍率数据陈旧');

    const disabled = rateCombinedHealth({
      ...baseRate,
      rate_monitor: { ...baseRate.rate_monitor, state: 'disabled' },
    }, { service_status: 'healthy' }, time);
    expect(disabled.reasons).toContain('倍率监控已停用');

    const abnormalProbe = rateCombinedHealth({
      ...baseRate,
      latest_probe: {
        status: 'success', requested_model: 'gpt-test', returned_model: 'other-model',
        input_token_assessment: 'higher_than_expected', tool_calls_observed: false,
        finish_reason: 'stop', prompt_integrity: 'suspected', knowledge_probe: 'suspicious',
        model_identity: 'declared_mismatch', error_code: null, error_message: null,
        completion_tokens: 48, reasoning_tokens: 48,
        created_at: '2026-07-15T01:01:00.000Z', evidence: { upstream_tools_observed: true },
      },
    }, { service_status: 'healthy' }, time);
    expect(abnormalProbe).toMatchObject({ badgeStatus: 'warning', label: '异常' });
    expect(abnormalProbe.reasons).toEqual(expect.arrayContaining([
      '输入 Token 高于本地预估',
      '提示词完整性疑似异常',
      '返回模型声明与请求不一致',
      '知识粗筛结果异常',
      '上游回显了客户端未声明的工具配置',
      '推理 Token 已占满本次输出',
    ]));
  });
});
