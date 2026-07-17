const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  'development.seed': '初始化开发样例数据',
  'session.login': '管理员登录',
  'session.login_failed': '管理员登录失败',
  'session.logout': '管理员退出登录',
  'admin.password_change': '修改管理员密码',
  'admin.password_change_failed': '修改管理员密码失败',
  'balance_alert_settings.update': '更新全局低余额设置',
  'server_access_settings.update': '更新访问方式',
  'audit.delete': '删除审计记录',
  'site.create': '添加中转站',
  'site.update': '更新中转站',
  'site.soft_delete': '删除中转站',
  'site.credentials_replace': '更新站点凭据',
  'site.auth_test': '测试站点认证',
  'site.auth_challenge': '完成站点人工验证',
  'site.probe_key_create': '创建分组实测 Key',
  'monitor.check_requested': '请求立即执行监控',
  'monitor.enable': '启用监控任务',
  'monitor.disable': '停用监控任务',
  'rate.exclude': '排除并删除倍率',
  'rate_probe.config_update': '更新模型实测配置',
  'rate_probe.models_list': '读取实测可用模型',
  'rate_probe.run': '执行模型实测',
  'notification_channel.create': '创建通知渠道',
  'notification_channel.update': '更新通知渠道',
  'notification_channel.soft_delete': '删除通知渠道',
  'notification_channel.test': '测试通知渠道',
  'notification_rule.create': '创建告警规则',
  'notification_rule.update': '更新告警规则',
  'notification_rule.soft_delete': '删除告警规则',
  'notification_route.create': '创建通知路由',
  'notification_route.update': '更新通知路由',
  'notification_route.soft_delete': '删除通知路由',
  'notification_delivery.replay': '重新投递通知',
  'incident.acknowledge': '旧版事件标记',
  'incident.silence': '静默事件',
  'incident.soft_delete': '删除事件（旧版本）',
  'incident.delete': '删除事件',
  'incident.batch_delete': '批量删除事件',
  'incident.delete_by_time': '按时间删除事件',
  'incident.delete_all': '删除全部事件',
  'maintenance_window.create': '创建维护窗口',
  'maintenance_window.update': '更新维护窗口',
  'maintenance_window.soft_delete': '删除维护窗口（旧版本）',
  'maintenance_window.delete': '删除维护窗口',
  'silence.create': '创建临时静默',
  'silence.update': '更新临时静默',
  'silence.end': '结束临时静默',
  'silence.soft_delete': '删除临时静默（旧版本）',
  'silence.delete': '删除临时静默',
  'system.backup': '创建系统备份',
  // Earlier development seed records used these action names.
  'site.check': '立即检查站点',
  'credentials.update': '更新站点凭据',
  'notification.test': '测试通知渠道',
};

const AUDIT_RESOURCE_LABELS: Readonly<Record<string, string>> = {
  admin: '管理员',
  audit_log: '审计记录',
  balance_alert_settings: '全局低余额设置',
  server_access_settings: '访问方式设置',
  incident: '事件',
  maintenance_window: '维护窗口',
  notification_channel: '通知渠道',
  notification_route: '通知路由',
  notification_rule: '告警规则',
  outbox_message: '通知投递',
  rate: '倍率',
  silence: '临时静默',
  site: '中转站',
  system: '系统',
  system_backup: '系统备份',
};

const INCIDENT_EVENT_LABELS: Readonly<Record<string, string>> = {
  'auth.failed': '认证失败',
  'auth.interaction_required': '需要人工验证',
  'balance.low': '余额过低',
  'balance.threshold': '余额达到阈值',
  'health.status': '站点健康状态',
  'probe.failed': '模型实测失败',
  'probe.input_tokens_high': '输入 Token 异常',
  'probe.model_mismatch': '模型声明不匹配',
  'probe.prompt_interference': '提示词疑似受干扰',
  'probe.recovered': '模型实测恢复',
  'probe.unexpected_tool_calls': '出现意外工具调用',
  'rate.added': '新增倍率',
  'rate.changed': '倍率变化',
  'rate.removed': '倍率移除',
  'rate.threshold': '倍率达到阈值',
  'site.auth_expired': '认证或登录失效',
  'site.degraded': '站点降级',
  'site.down': '站点宕机',
  'site.network_unreachable': '网络不可达',
  'site.other_error': '其他站点异常',
  'site.permission_denied': '权限被拒绝',
  'site.rate_limited': '上游限流',
  'site.recovered': '站点恢复',
  'site.schema_incompatible': '响应结构不兼容',
  'site.timeout': '请求超时',
  'site.upstream_5xx': '上游服务错误',
  'webhook.test': '通知渠道测试',
};

const INCIDENT_RESOURCE_LABELS: Readonly<Record<string, string>> = {
  site: '站点连通性',
  health: '站点健康状态',
  auth: '登录与认证',
  'monitor:connectivity': '连通性监控',
  'monitor:auth': '登录状态监控',
  'monitor:rates': '倍率监控',
  'monitor:balance': '余额监控',
  'connectivity:models': '模型接口连通性',
  'connectivity:latency': '连通性延迟',
  'auth:session': '登录会话',
  'cash:primary': '主账户余额',
};

const INCIDENT_SUPPRESSION_LABELS: Readonly<Record<string, string>> = {
  root_cause_dependency: '由关联的根因事件统一告警',
  system_fallback_replaced: '相同故障已由匹配的告警规则接管',
  rule_revision_replaced: '告警规则已更新',
  rule_disabled: '告警规则已停用',
  rule_deleted: '告警规则已删除',
  incident_archived: '旧版事件已删除',
};

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  healthy: '正常', degraded: '降级', down: '宕机', unknown: '未知',
};

const OPERATOR_LABELS: Readonly<Record<string, string>> = {
  lt: '小于', lte: '小于等于', gt: '大于', gte: '大于等于', eq: '等于', ne: '不等于',
};

function readableCode(value: string): string {
  return value.replace(/[._-]+/g, ' ').trim();
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? `其他操作（${readableCode(action)}）`;
}

export function auditResourceTypeLabel(resourceType: string): string {
  return AUDIT_RESOURCE_LABELS[resourceType] ?? `其他对象（${readableCode(resourceType)}）`;
}

export function incidentEventTypeLabel(eventType: string): string {
  return INCIDENT_EVENT_LABELS[eventType] ?? `其他事件（${readableCode(eventType)}）`;
}

export function incidentResourceLabel(resourceKey: string): string {
  const key = resourceKey.trim();
  const exact = INCIDENT_RESOURCE_LABELS[key];
  if (exact) return exact;
  if (key.startsWith('probe:')) return '分组模型实测';
  if (key.startsWith('rate:')) return '分组倍率';
  if (key.startsWith('balance:')) return '余额指标';
  if (key.startsWith('monitor:')) return '独立监控任务';
  if (key.startsWith('connectivity:')) return '连通性检查';
  if (key.startsWith('auth:')) return '登录与认证';
  if (key.startsWith('cash:')) return '账户余额';
  return '其他监控资源';
}

const ONE_TIME_RATE_EVENT_TYPES = new Set(['rate.changed', 'rate.added', 'rate.removed']);

interface IncidentDetails {
  details?: Readonly<Record<string, unknown>> | undefined;
}

function detailString(incident: IncidentDetails, key: string): string | null {
  const value = incident.details?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function fallbackRateName(resourceKey: string): string | null {
  const match = /^(?:rate:)?group:([^:]+)(?::effective)?$/i.exec(resourceKey.trim());
  return match?.[1] ? `分组“${match[1]}”` : null;
}

function rateSubject(incident: PresentableIncident & { resource_key?: string | undefined }): string | null {
  const name = detailString(incident, 'rate_name');
  if (name) {
    return detailString(incident, 'rate_kind') === 'group' ? `分组“${name}”` : `“${name}”`;
  }
  return incident.resource_key ? fallbackRateName(incident.resource_key) : null;
}

export function isOneTimeRateEvent(eventType: string): boolean {
  return ONE_TIME_RATE_EVENT_TYPES.has(eventType);
}

export function incidentMatchesLifecycleTab(
  incident: { event_type: string; state: string },
  tab: 'active' | 'rate_changes' | 'resolved' | 'all',
): boolean {
  if (tab === 'all') return true;
  const isRateChange = isOneTimeRateEvent(incident.event_type);
  if (tab === 'rate_changes') return isRateChange;
  if (isRateChange) return false;
  if (tab === 'resolved') return incident.state === 'resolved';
  return ['pending', 'firing', 'acknowledged', 'recovering'].includes(incident.state);
}

export function incidentResourceDisplayLabel(
  incident: PresentableIncident & { resource_key: string },
): string {
  if (isOneTimeRateEvent(incident.event_type)) {
    const subject = rateSubject(incident);
    if (subject) return `${subject}的计费倍率`;
  }
  return incidentResourceLabel(incident.resource_key);
}

export function incidentSuppressionReasonLabel(reason: string): string {
  const value = reason.trim();
  const exact = INCIDENT_SUPPRESSION_LABELS[value];
  if (exact) return exact;
  if (value.startsWith('maintenance:')) return '处于维护窗口，通知已暂停';
  if (value.startsWith('silence:')) return '处于临时静默，通知已暂停';
  return '通知已由系统抑制';
}

export function rateUnitLabel(unit: string): string {
  const labels: Readonly<Record<string, string>> = {
    multiplier: '计费倍率',
    currency: '金额',
    token: 'Token 数量',
    request: '请求次数',
  };
  return labels[unit.trim().toLocaleLowerCase()] ?? unit;
}

interface RateHealthProbe {
  status: 'running' | 'success' | 'failed';
  requested_model: string;
  returned_model: string | null;
  input_token_assessment: 'within_expected' | 'higher_than_expected' | 'unknown';
  tool_calls_observed: boolean;
  finish_reason: string | null;
  completion_tokens?: number | null;
  reasoning_tokens?: number | null;
  prompt_integrity: 'no_interference_observed' | 'suspected' | 'unknown';
  knowledge_probe: 'weak_consistency' | 'suspicious' | 'not_applicable' | 'unknown';
  model_identity: 'declared_match' | 'declared_mismatch' | 'unknown';
  error_code: string | null;
  error_message: string | null;
  completed_at?: string | null;
  created_at: string;
  evidence?: { upstream_tools_observed?: boolean; [key: string]: unknown };
}

interface RateHealthInput {
  metadata_status: 'available' | 'stale' | 'unavailable';
  collected_at: string;
  latest_probe?: RateHealthProbe | null;
  rate_monitor?: {
    state: 'queued' | 'running' | 'retry' | 'disabled';
    last_finished_at: string | null;
    last_success_at: string | null;
    last_error_code: string | null;
    last_error_message: string | null;
  } | null;
}

interface RateHealthSite {
  service_status: 'healthy' | 'degraded' | 'down' | 'unknown' | 'adapter_unavailable';
}

export interface RateCombinedHealth {
  badgeStatus: 'healthy' | 'warning' | 'down';
  label: '正常' | '异常' | '宕机';
  summary: string;
  reasons: string[];
}

const RATE_HEALTH_SITE_LABELS: Readonly<Record<RateHealthSite['service_status'], string>> = {
  healthy: '正常',
  degraded: '降级',
  down: '宕机',
  unknown: '状态未知',
  adapter_unavailable: '适配器不可用',
};

const RATE_MONITOR_ERROR_LABELS: Readonly<Record<string, string>> = {
  UPSTREAM_UNREACHABLE: '网络不可达',
  UPSTREAM_RATE_LIMITED: '上游限流',
  UPSTREAM_SERVER_ERROR: '上游服务错误',
  UPSTREAM_SCHEMA_ERROR: '响应结构不兼容',
  RATE_SNAPSHOT_PARTIAL: '采集结果不完整',
  ADAPTER_UNAVAILABLE: '适配器不可用',
  AUTH_INVALID_CREDENTIALS: '登录凭据无效',
  AUTH_INTERACTION_REQUIRED: '需要人工验证',
  AUTH_2FA_REQUIRED: '需要二次验证',
};

function rateMonitorErrorLabel(code: string | null, message: string | null): string {
  if (code && RATE_MONITOR_ERROR_LABELS[code]) return RATE_MONITOR_ERROR_LABELS[code]!;
  if (message && message !== code) return message;
  return code ?? '采集失败';
}

function probeAnomalyReasons(probe: RateHealthProbe): string[] {
  const reasons: string[] = [];
  if (probe.status === 'failed') reasons.push(`模型实测失败${probe.error_message ? `：${probe.error_message}` : ''}`);
  if (probe.tool_calls_observed) reasons.push('响应出现未声明的工具调用');
  if (probe.evidence?.upstream_tools_observed === true) reasons.push('上游回显了客户端未声明的工具配置');
  if (probe.input_token_assessment === 'higher_than_expected') reasons.push('输入 Token 高于本地预估');
  if (probe.prompt_integrity === 'suspected') reasons.push('提示词完整性疑似异常');
  if (probe.model_identity === 'declared_mismatch') reasons.push('返回模型声明与请求不一致');
  if (probe.knowledge_probe === 'suspicious') reasons.push('知识粗筛结果异常');
  if (probe.finish_reason === 'length') reasons.push('模型输出达到长度上限');
  if (
    probe.completion_tokens !== null
    && probe.completion_tokens !== undefined
    && probe.reasoning_tokens !== null
    && probe.reasoning_tokens !== undefined
    && probe.reasoning_tokens >= probe.completion_tokens
  ) reasons.push('推理 Token 已占满本次输出');
  return [...new Set(reasons)];
}

/** Builds the single health signal shown for a rate row on desktop and mobile. */
export function rateCombinedHealth(
  rate: RateHealthInput,
  site: RateHealthSite | undefined,
  formatTime: (value: string | null | undefined) => string = (value) => value ?? '—',
): RateCombinedHealth {
  const reasons: string[] = [];
  const siteStatus = site?.service_status;
  if (siteStatus === undefined) reasons.push('站点状态未知');
  else if (siteStatus !== 'healthy' && siteStatus !== 'down') reasons.push(`站点${RATE_HEALTH_SITE_LABELS[siteStatus]}`);

  const monitor = rate.rate_monitor;
  if (monitor?.state === 'disabled') reasons.push('倍率监控已停用');
  if (monitor?.last_error_code) {
    reasons.push(`倍率采集失败：${rateMonitorErrorLabel(monitor.last_error_code, monitor.last_error_message)}`);
  } else if (monitor?.state === 'retry') {
    reasons.push('倍率采集正在等待重试');
  }
  if (rate.metadata_status === 'stale') reasons.push('倍率数据陈旧');
  if (rate.metadata_status === 'unavailable') reasons.push('倍率数据不可用');

  const probe = rate.latest_probe;
  if (probe) reasons.push(...probeAnomalyReasons(probe));

  const siteSummary = `站点：${siteStatus ? RATE_HEALTH_SITE_LABELS[siteStatus] : '状态未知'}`;
  const monitorSummary = monitor?.last_error_code
    ? `倍率采集：失败（${rateMonitorErrorLabel(monitor.last_error_code, monitor.last_error_message)}）`
    : monitor?.state === 'running'
      ? '倍率采集：正在采集'
      : monitor?.state === 'disabled'
        ? '倍率采集：已停用'
        : monitor
          ? `倍率采集：正常${monitor.last_success_at ? `，最近成功 ${formatTime(monitor.last_success_at)}` : ''}`
          : '倍率采集：暂无任务记录';
  const metadataSummary = `数据时间：${formatTime(rate.collected_at)}（${{
    available: '可用', stale: '陈旧', unavailable: '不可用',
  }[rate.metadata_status]}）`;
  const probeSummary = !probe
    ? '模型实测：尚未实测（不影响综合状态）'
    : probe.status === 'running'
      ? `模型实测：正在实测 ${probe.requested_model}`
      : probe.status === 'failed'
        ? `模型实测：失败${probe.error_message ? `（${probe.error_message}）` : ''}`
        : `模型实测：成功 ${probe.returned_model ?? probe.requested_model}，${formatTime(probe.completed_at ?? probe.created_at)}`;
  const summaryParts = [siteSummary, monitorSummary, metadataSummary, probeSummary];
  if (reasons.length > 0) summaryParts.push(`异常摘要：${reasons.join('；')}`);

  if (siteStatus === 'down') {
    return { badgeStatus: 'down', label: '宕机', summary: summaryParts.join('\n'), reasons };
  }
  if (reasons.length > 0) {
    return { badgeStatus: 'warning', label: '异常', summary: summaryParts.join('\n'), reasons };
  }
  return { badgeStatus: 'healthy', label: '正常', summary: summaryParts.join('\n'), reasons };
}

interface IncidentRelationship {
  id: string;
  suppressed_by_incident_id?: string | null;
}

export interface IncidentGroup<T extends IncidentRelationship> {
  incident: T;
  dependencies: T[];
}

export function groupIncidentsByRoot<T extends IncidentRelationship>(
  matchingIncidents: readonly T[],
  _allIncidents: readonly T[],
): IncidentGroup<T>[] {
  const matchingIds = new Set(matchingIncidents.map(({ id }) => id));
  const dependenciesByRoot = new Map<string, T[]>();
  for (const incident of matchingIncidents) {
    const rootId = incident.suppressed_by_incident_id;
    if (!rootId) continue;
    const dependencies = dependenciesByRoot.get(rootId) ?? [];
    dependencies.push(incident);
    dependenciesByRoot.set(rootId, dependencies);
  }

  return matchingIncidents
    .filter((incident) => !incident.suppressed_by_incident_id || !matchingIds.has(incident.suppressed_by_incident_id))
    .map((incident) => ({
      incident,
      dependencies: dependenciesByRoot.get(incident.id) ?? [],
    }));
}

export function localizeIncidentText(value: string, siteName?: string | null): string {
  const text = value.trim();
  let match = /^(.+?) has failed (\d+|one|two|three|four|five|six|seven|eight|nine|ten) consecutive checks[.!]?$/i.exec(text);
  if (match) {
    const count = NUMBER_WORDS[match[2]!.toLocaleLowerCase()] ?? match[2]!;
    return `${siteName?.trim() || match[1]!.trim()}已连续 ${count} 次检查失败。`;
  }

  match = /^(.+?) authentication failed[.!]?$/i.exec(text);
  if (match) return `${siteName?.trim() || match[1]!.trim()}认证失败。`;

  match = /^(.+?) health is (healthy|degraded|down|unknown)[.!]?$/i.exec(text);
  if (match) {
    const status = STATUS_LABELS[match[2]!.toLocaleLowerCase()] ?? match[2]!;
    return `${siteName?.trim() || match[1]!.trim()}服务状态为${status}。`;
  }

  match = /^(.+?) balance (.+?) is (.+?) \((lt|lte|gt|gte|eq|ne) (.+)\)[.!]?$/i.exec(text);
  if (match) {
    const operator = OPERATOR_LABELS[match[4]!.toLocaleLowerCase()] ?? match[4]!;
    return `${siteName?.trim() || match[1]!.trim()}的余额 ${match[2]} 为 ${match[3]}（${operator} ${match[5]}）。`;
  }

  match = /^(.+?) rate (.+?) is (.+?)[.!]?$/i.exec(text);
  if (match) {
    const valueLabel = match[3]!.toLocaleLowerCase() === 'unavailable' ? '不可用' : match[3]!;
    return `${siteName?.trim() || match[1]!.trim()}的倍率 ${match[2]} 当前为${valueLabel}。`;
  }

  match = /^(.+?) rate (.+?) changed[.!]?$/i.exec(text);
  if (match) return `${siteName?.trim() || match[1]!.trim()}的倍率 ${match[2]} 已变化。`;

  return value;
}

export interface PresentableIncident {
  title: string;
  summary: string;
  event_type: string;
  site_name: string;
  details?: Readonly<Record<string, unknown>> | undefined;
}

export function incidentDisplaySummary(incident: PresentableIncident): string {
  if (isOneTimeRateEvent(incident.event_type)) {
    const subject = rateSubject(incident) ?? '分组';
    const oldRate = detailString(incident, 'old_rate');
    const newRate = detailString(incident, 'new_rate');
    if (incident.event_type === 'rate.added') {
      return newRate
        ? `${incident.site_name}新增了${subject}的计费倍率，当前为 ${newRate}。`
        : `${incident.site_name}新增了${subject}的计费倍率。`;
    }
    if (incident.event_type === 'rate.removed') {
      return oldRate
        ? `${incident.site_name}移除了${subject}的计费倍率，移除前为 ${oldRate}。`
        : `${incident.site_name}移除了${subject}的计费倍率。`;
    }
    if (oldRate && newRate) {
      return `${incident.site_name}的${subject}的计费倍率由 ${oldRate} 变为 ${newRate}。`;
    }
    return `${incident.site_name}的${subject}的计费倍率已变化。`;
  }
  return localizeIncidentText(incident.summary, incident.site_name);
}

export function incidentDisplayTitle(incident: PresentableIncident): string {
  if (isOneTimeRateEvent(incident.event_type)) {
    const subject = rateSubject(incident);
    return subject
      ? `${incident.site_name} · ${incidentEventTypeLabel(incident.event_type)} · ${subject}`
      : `${incident.site_name} · ${incidentEventTypeLabel(incident.event_type)}`;
  }
  const title = localizeIncidentText(incident.title, incident.site_name);
  return title === incidentDisplaySummary(incident)
    ? `${incident.site_name} · ${incidentEventTypeLabel(incident.event_type)}`
    : title;
}
