<script setup lang="ts">
import {
  BellRing,
  CheckCircle2,
  FlaskConical,
  History,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  Trash2,
  Webhook,
  X,
} from '@lucide/vue';
import { computed, onMounted, reactive, ref, watch } from 'vue';

import {
  BALANCE_NOTIFICATION_EVENT_TYPES,
  MONITOR_NOTIFICATION_EVENT_TYPES,
  PROBE_NOTIFICATION_EVENT_TYPES,
  RATE_NOTIFICATION_EVENT_TYPES,
  SITE_NOTIFICATION_EVENT_TYPES,
  defaultMonitorEventTypes,
} from '../../../shared/notification-events';
import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import PaginationControls from '../components/PaginationControls.vue';
import StatusBadge from '../components/StatusBadge.vue';
import ToggleSwitch from '../components/ToggleSwitch.vue';
import { api } from '../services/api';
import { formatDateTime, formatRelativeTime } from '../services/format';
import {
  effectiveRepeatIntervalSeconds,
  formatRepeatInterval,
  notificationRepeatSummary,
} from '../services/notification-policy';
import { notificationChannelTestMessage } from '../services/notification-test';
import { clampPage, fetchAllPages, slicePage } from '../services/pagination';
import { loadResource } from '../services/resource-loader';
import { parseWebhookHeaderEditor, webhookHeaderEditorState } from '../services/webhook-headers';
import type {
  DeliveryRecord,
  NotificationChannel,
  NotificationChannelTestResult,
  NotificationRule,
  SiteViewModel,
} from '../types/domain';

type EditorKind = 'channel' | 'rule';
type DeleteTarget = { kind: EditorKind; id: string; name: string };
type NotificationTab = 'channels' | 'rules' | 'deliveries';

const EVENT_LABELS: Record<string, string> = {
  'site.network_unreachable': '网络不可达',
  'site.timeout': '请求超时',
  'site.auth_expired': '认证 / 登录失效',
  'site.permission_denied': '权限拒绝',
  'site.rate_limited': '上游限流',
  'site.upstream_5xx': '上游 5xx',
  'site.schema_incompatible': '响应结构不兼容',
  'site.other_error': '其他站点异常',
  'site.recovered': '恢复上线',
  'rate.changed': '倍率变化',
  'rate.added': '倍率新增',
  'rate.removed': '倍率移除',
  'rate.threshold': '倍率阈值',
  'probe.input_tokens_high': '输入 Token 异常',
  'probe.unexpected_tool_calls': '意外工具调用',
  'probe.prompt_interference': '提示词疑似干扰',
  'probe.model_mismatch': '模型声明不匹配',
  'probe.failed': '实测失败',
  'probe.recovered': '实测恢复',
  'balance.low': '余额过低',
  'balance.threshold': '余额阈值',
};
const EVENT_GROUPS = [
  { id: 'site', label: '中转站状态', events: [...SITE_NOTIFICATION_EVENT_TYPES] },
  { id: 'rate', label: '倍率变化', events: [...RATE_NOTIFICATION_EVENT_TYPES] },
  { id: 'probe', label: '模型实测', events: [...PROBE_NOTIFICATION_EVENT_TYPES] },
  { id: 'balance', label: '余额监控', events: [...BALANCE_NOTIFICATION_EVENT_TYPES] },
] as const;
const MONITOR_EVENT_TYPE_SET = new Set<string>(MONITOR_NOTIFICATION_EVENT_TYPES);
const MONITOR_EVENT_COUNT = MONITOR_NOTIFICATION_EVENT_TYPES.length;
const REPEAT_INTERVAL_OPTIONS = [
  { value: 0, label: '每次后续检查' },
  { value: 60, label: '1 分钟' },
  { value: 300, label: '5 分钟' },
  { value: 600, label: '10 分钟' },
  { value: 1_800, label: '30 分钟' },
  { value: 3_600, label: '1 小时' },
  { value: 21_600, label: '6 小时' },
  { value: 43_200, label: '12 小时' },
  { value: 86_400, label: '24 小时' },
] as const;
const REPEAT_INTERVAL_VALUES = new Set<number>(REPEAT_INTERVAL_OPTIONS.map((item) => item.value));
const EXTRA_HEADERS_EXAMPLE = `{
  "Authorization": "Bearer YOUR_TOKEN",
  "X-Tenant": "relay-monitor"
}`;
const CUSTOM_BODY_EXAMPLE = `{
  "event": {{ payload.event | json }},
  "msg": {{ msg | json }},
  "site": {{ payload.site.name | json }},
  "detected_at": {{ payload.detected_at | json }}
}`;

const channels = ref<NotificationChannel[]>([]);
const sites = ref<SiteViewModel[]>([]);
const rules = ref<NotificationRule[]>([]);
const deliveries = ref<DeliveryRecord[]>([]);
const error = ref<string | null>(null);
const loading = ref(true);
const activeTab = ref<NotificationTab>('channels');
const actionId = ref<string | null>(null);
const actionMessage = ref<string | null>(null);
const actionError = ref(false);
const editorKind = ref<EditorKind | null>(null);
const editingId = ref<string | null>(null);
const editorBusy = ref(false);
const editorError = ref<string | null>(null);
const originalHeadersText = ref('');
const existingHeaderNames = ref<ReadonlySet<string>>(new Set());
const deleteTarget = ref<DeleteTarget | null>(null);
const deleteLoading = ref(false);
const deleteError = ref<string | null>(null);
const tabPages = reactive<Record<NotificationTab, number>>({ channels: 1, rules: 1, deliveries: 1 });
const tabPageSizes = reactive<Record<NotificationTab, number>>({ channels: 20, rules: 20, deliveries: 20 });

const channelForm = reactive({
  name: '', url: '', enabled: true, timeout_seconds: 10,
  body_mode: 'json' as 'json' | 'form_data' | 'custom', body_template: '',
  headers_enabled: false, headers_text: '',
});
const ruleForm = reactive({
  name: '', type: 'monitor_events', severity: 'warning', enabled: true,
  event_types: defaultMonitorEventTypes() as string[], site_ids: [] as string[], tags: [] as string[], rate_kinds: '',
  directions: ['up', 'down'] as string[], minimum_change: '',
  recovery_confirm_count: 1,
  repeat_interval_seconds: 0, max_repeats: 0, cooldown_seconds: 0,
  send_recovery: true, channel_ids: [] as string[],
});
const summary = computed(() => ({
  channels: channels.value.filter((item) => item.enabled).length,
  rules: rules.value.filter((item) => item.enabled).length,
  failed: deliveries.value.filter((item) => ['retry', 'dead'].includes(item.status)).length,
  customized: channels.value.filter((item) => item.enabled && (item.body_mode !== 'json' || item.has_headers)).length,
}));
const paginatedChannels = computed(() => slicePage(channels.value, tabPages.channels, tabPageSizes.channels));
const paginatedRules = computed(() => slicePage(rules.value, tabPages.rules, tabPageSizes.rules));
const paginatedDeliveries = computed(() => slicePage(deliveries.value, tabPages.deliveries, tabPageSizes.deliveries));
const activeTotal = computed(() => ({
  channels: channels.value.length,
  rules: rules.value.length,
  deliveries: deliveries.value.length,
})[activeTab.value]);
const activePage = computed({
  get: () => tabPages[activeTab.value],
  set: (value: number) => { tabPages[activeTab.value] = value; },
});
const activePageSize = computed({
  get: () => tabPageSizes[activeTab.value],
  set: (value: number) => { tabPageSizes[activeTab.value] = value; },
});
const editorTitle = computed(() => `${editingId.value ? '编辑' : '新增'}${editorKind.value === 'channel' ? '通知渠道' : '告警规则'}`);
const headerAction = computed(() => activeTab.value === 'channels'
  ? { label: '添加渠道', kind: 'channel' as const }
  : activeTab.value === 'rules'
    ? { label: '添加规则', kind: 'rule' as const }
    : null);
const repeatEnabled = computed({
  get: () => ruleForm.max_repeats > 0,
  set: (enabled: boolean) => {
    if (!enabled) {
      ruleForm.max_repeats = 0;
      ruleForm.repeat_interval_seconds = 0;
      ruleForm.cooldown_seconds = 0;
      return;
    }
    ruleForm.max_repeats = Math.max(1, ruleForm.max_repeats || 3);
    ruleForm.repeat_interval_seconds = Math.max(0, ruleForm.repeat_interval_seconds || 3_600);
    ruleForm.cooldown_seconds = ruleForm.repeat_interval_seconds;
  },
});
const customRepeatInterval = computed(() => repeatEnabled.value
  && !REPEAT_INTERVAL_VALUES.has(ruleForm.repeat_interval_seconds));
const alertPolicySummary = computed(() => {
  const recoveryCount = Math.max(1, Number(ruleForm.recovery_confirm_count) || 1);
  const recoveryNotification = ruleForm.send_recovery ? '并发送恢复通知' : '但不发送恢复通知';
  const repeat = repeatEnabled.value
    ? `异常持续时${notificationRepeatSummary({
      repeat_interval_seconds: ruleForm.repeat_interval_seconds,
      cooldown_seconds: ruleForm.repeat_interval_seconds,
      max_repeats: ruleForm.max_repeats,
    })}`
    : '异常持续时不再重复提醒';
  return `监控重试耗尽后的最终异常直接告警。连续正常 ${recoveryCount} 次后恢复，${recoveryNotification}。${repeat}。`;
});
const siteOptionIds = computed(() => sites.value.map((site) => site.id));
const siteTagOptions = computed(() => [...new Set(sites.value.flatMap((site) => site.tags))]
  .sort((left, right) => left.localeCompare(right, 'zh-CN')));
const deleteCopy = computed(() => {
  if (deleteTarget.value?.kind === 'channel') return { title: '删除通知渠道？', description: '该渠道将停止接收新投递；仍被告警规则绑定时不能删除。' };
  return { title: '删除告警规则？', description: '该规则将不再评估新采集结果，已有事件和投递记录会继续保留。' };
});

watch([
  () => channels.value.length,
  () => rules.value.length,
  () => deliveries.value.length,
  () => tabPageSizes.channels,
  () => tabPageSizes.rules,
  () => tabPageSizes.deliveries,
], () => {
  tabPages.channels = clampPage(tabPages.channels, channels.value.length, tabPageSizes.channels);
  tabPages.rules = clampPage(tabPages.rules, rules.value.length, tabPageSizes.rules);
  tabPages.deliveries = clampPage(tabPages.deliveries, deliveries.value.length, tabPageSizes.deliveries);
});

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function selectableSiteIds(value: unknown): string[] {
  return asStrings(value).filter((id) => siteOptionIds.value.includes(id));
}

function selectableSiteTags(value: unknown): string[] {
  return asStrings(value).filter((tag) => siteTagOptions.value.includes(tag));
}

function csv(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function csvDisplay(value: unknown): string {
  return asStrings(value).join(', ');
}

function setChecked(values: string[], value: string, checked: boolean): void {
  const index = values.indexOf(value);
  if (checked && index < 0) values.push(value);
  if (!checked && index >= 0) values.splice(index, 1);
}

function allSelected(values: readonly string[], options: readonly string[]): boolean {
  return options.length > 0 && options.every((option) => values.includes(option));
}

function partiallySelected(values: readonly string[], options: readonly string[]): boolean {
  const count = options.filter((option) => values.includes(option)).length;
  return count > 0 && count < options.length;
}

function toggleSelection(values: string[], options: readonly string[], event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  for (const option of options) setChecked(values, option, checked);
}

function eventGroupSelected(events: readonly string[]): boolean {
  return allSelected(ruleForm.event_types, events);
}

function eventGroupPartial(events: readonly string[]): boolean {
  return partiallySelected(ruleForm.event_types, events);
}

function toggleEventGroup(events: readonly string[], event: Event): void {
  toggleSelection(ruleForm.event_types, events, event);
}

function eventTypeLabel(value: string): string {
  return EVENT_LABELS[value] ?? value;
}

function ruleTypeLabel(type: string): string {
  return {
    monitor_events: '监控事件',
    site_health: '站点健康', site_down: '站点宕机', auth_failed: '登录失效',
    rate_changed: '倍率 / 实测', rate_threshold: '倍率阈值',
    balance_low: '低余额', balance_threshold: '余额阈值',
  }[type] ?? type;
}

function ruleRepeatSummary(rule: NotificationRule): string {
  return notificationRepeatSummary(rule);
}

function channelProtocol(url: string): string {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' ? 'HTTP' : protocol === 'https:' ? 'HTTPS' : '未知协议';
  } catch {
    return '未知协议';
  }
}

function channelBodyModeLabel(mode: NotificationChannel['body_mode']): string {
  return {
    json: 'JSON',
    form_data: '表单',
    custom: '自定义',
  }[mode] ?? 'JSON';
}

async function load(): Promise<void> {
  loading.value = true;
  const result = await loadResource(
    async () => {
      const [allChannels, allRules, allDeliveries, allSites] = await Promise.all([
        api.notifications.channels(),
        api.notifications.rules(),
        fetchAllPages((page, pageSize) => api.notifications.deliveries(page, pageSize)),
        fetchAllPages((page, pageSize) => api.sites.list(page, pageSize)),
      ]);
      return {
        channels: allChannels, rules: allRules,
        deliveries: allDeliveries, sites: allSites,
      };
    },
    { channels: [], rules: [], deliveries: [], sites: [] },
  );
  channels.value = result.data.channels;
  sites.value = result.data.sites;
  rules.value = result.data.rules;
  deliveries.value = result.data.deliveries;
  error.value = result.error;
  loading.value = false;
}

function openChannelEditor(channel?: NotificationChannel): void {
  const headerEditor = webhookHeaderEditorState(channel?.headers);
  Object.assign(channelForm, {
    name: channel?.name ?? '', url: channel?.url ?? '', enabled: channel?.enabled ?? true,
    timeout_seconds: channel?.timeout_seconds ?? 10,
    body_mode: channel?.body_mode ?? 'json', body_template: channel?.body_template ?? '',
    headers_enabled: Boolean(headerEditor.text), headers_text: headerEditor.text,
  });
  originalHeadersText.value = headerEditor.text;
  existingHeaderNames.value = new Set(headerEditor.names);
  editingId.value = channel?.id ?? null;
  editorError.value = null;
  editorKind.value = 'channel';
}

function openRuleEditor(rule?: NotificationRule): void {
  const revision = rule?.current_revision;
  const scope = revision?.scope ?? {};
  const condition = revision?.condition ?? {};
  const sourceEvents = rule
    ? rule.event_types?.length ? rule.event_types : defaultMonitorEventTypes()
    : defaultMonitorEventTypes();
  const editableEvents = sourceEvents.filter((eventType) => MONITOR_EVENT_TYPE_SET.has(eventType));
  const repeatIntervalSeconds = rule
    ? effectiveRepeatIntervalSeconds({
      repeat_interval_seconds: revision?.repeat_interval_seconds ?? rule.repeat_interval_seconds,
      max_repeats: revision?.max_repeats ?? rule.max_repeats,
      cooldown_seconds: revision?.cooldown_seconds,
    })
    : 0;
  Object.assign(ruleForm, {
    name: rule?.name ?? '', type: 'monitor_events', severity: rule?.severity ?? 'warning', enabled: rule?.enabled ?? true,
    event_types: [...(editableEvents.length ? editableEvents : defaultMonitorEventTypes())],
    site_ids: selectableSiteIds(scope.site_ids), tags: selectableSiteTags(scope.tags), rate_kinds: csvDisplay(scope.rate_kinds),
    directions: asStrings(condition.directions).length ? asStrings(condition.directions) : ['up', 'down'],
    minimum_change: typeof condition.minimum_change === 'string' ? condition.minimum_change : '',
    recovery_confirm_count: revision?.recovery_confirm_count ?? rule?.recovery_confirm_count ?? 1,
    repeat_interval_seconds: repeatIntervalSeconds,
    max_repeats: revision?.max_repeats ?? rule?.max_repeats ?? 0,
    cooldown_seconds: repeatIntervalSeconds,
    send_recovery: revision?.send_recovery ?? true,
    channel_ids: [...(revision?.channel_ids ?? rule?.channel_ids ?? [])],
  });
  editingId.value = rule?.id ?? null;
  editorError.value = null;
  editorKind.value = 'rule';
}

function openEditor(kind: EditorKind): void {
  if (kind === 'channel') openChannelEditor();
  else openRuleEditor();
}

function closeEditor(): void {
  if (!editorBusy.value) editorKind.value = null;
}

function replaceById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [item, ...items];
  return items.map((candidate) => candidate.id === item.id ? item : candidate);
}

async function saveChannel(): Promise<void> {
  const name = channelForm.name.trim();
  const url = channelForm.url.trim();
  let protocol = '';
  try {
    protocol = new URL(url).protocol;
  } catch {
    // Report one stable validation message below.
  }
  if (!name || !['http:', 'https:'].includes(protocol)) {
    editorError.value = '请填写渠道名称和有效的 HTTP 或 HTTPS 地址。';
    return;
  }
  const existing = editingId.value ? channels.value.find((item) => item.id === editingId.value) : undefined;
  if (channelForm.body_mode === 'custom' && !channelForm.body_template.trim()) {
    editorError.value = '自定义内容模式需要填写请求体模板。';
    return;
  }
  let headers: Record<string, string> = {};
  const headersText = channelForm.headers_enabled ? channelForm.headers_text.trim() : '';
  try {
    headers = parseWebhookHeaderEditor(headersText, existingHeaderNames.value);
  } catch (caught) {
    editorError.value = caught instanceof Error ? caught.message : '额外 Header 配置无效。';
    return;
  }
  const payload: Record<string, unknown> = {
    name, type: 'webhook', enabled: channelForm.enabled, url, method: 'POST',
    timeout_seconds: channelForm.timeout_seconds,
    body_mode: channelForm.body_mode,
    body_template: channelForm.body_mode === 'custom' ? channelForm.body_template : null,
  };
  if (!existing || headersText !== originalHeadersText.value) {
    payload.headers = headers;
  }
  editorBusy.value = true;
  editorError.value = null;
  try {
    const saved = existing
      ? await api.notifications.updateChannel(existing.id, payload)
      : await api.notifications.createChannel(payload);
    channels.value = replaceById(channels.value, saved);
    actionMessage.value = `${name} 已${existing ? '更新' : '创建'}。`;
    actionError.value = false;
    editorKind.value = null;
  } catch (caught) {
    editorError.value = caught instanceof Error ? caught.message : '渠道保存失败';
  } finally {
    editorBusy.value = false;
  }
}

async function saveRule(): Promise<void> {
  const name = ruleForm.name.trim();
  if (!name || ruleForm.event_types.length === 0) {
    editorError.value = '请填写规则名称并至少选择一个事件类型。';
    return;
  }
  if (ruleForm.event_types.includes('probe.recovered') && !ruleForm.event_types.includes('probe.failed')) {
    editorError.value = '选择“实测恢复”时必须同时选择“实测失败”。';
    return;
  }
  if (ruleForm.event_types.includes('site.recovered') && !ruleForm.event_types.some((item) => item.startsWith('site.') && item !== 'site.recovered')) {
    editorError.value = '选择“恢复上线”时必须同时选择至少一个站点异常事件。';
    return;
  }
  if (ruleForm.type === 'monitor_events' && ruleForm.event_types.includes('rate.changed') && ruleForm.directions.length === 0) {
    editorError.value = '倍率变化规则至少选择一个变化方向。';
    return;
  }
  if (repeatEnabled.value && ruleForm.repeat_interval_seconds < 0) {
    editorError.value = '再次提醒间隔不能小于 0。';
    return;
  }
  const scope: Record<string, unknown> = {};
  if (ruleForm.site_ids.length) scope.site_ids = [...ruleForm.site_ids];
  if (ruleForm.tags.length) scope.tags = [...ruleForm.tags];
  if (csv(ruleForm.rate_kinds).length) scope.rate_kinds = csv(ruleForm.rate_kinds);
  const payload: Record<string, unknown> = {
    name, type: ruleForm.type, severity: ruleForm.severity, enabled: ruleForm.enabled,
    scope, event_types: [...ruleForm.event_types],
    recovery_confirm_count: ruleForm.recovery_confirm_count,
    digest_window_seconds: 60,
    cooldown_seconds: repeatEnabled.value ? ruleForm.repeat_interval_seconds : 0,
    repeat_interval_seconds: ruleForm.repeat_interval_seconds, max_repeats: ruleForm.max_repeats,
    send_recovery: ruleForm.send_recovery, channel_ids: [...ruleForm.channel_ids],
  };
  if (ruleForm.type === 'monitor_events' && ruleForm.event_types.includes('rate.changed')) {
    payload.directions = [...ruleForm.directions];
    if (ruleForm.minimum_change.trim()) payload.minimum_change = ruleForm.minimum_change.trim();
  }
  editorBusy.value = true;
  editorError.value = null;
  const existing = editingId.value ? rules.value.find((item) => item.id === editingId.value) : undefined;
  try {
    const saved = existing
      ? await api.notifications.updateRule(existing.id, payload)
      : await api.notifications.createRule(payload);
    rules.value = replaceById(rules.value, saved);
    actionMessage.value = `${name} 已${existing ? '更新并生成新修订' : '创建'}。`;
    actionError.value = false;
    editorKind.value = null;
  } catch (caught) {
    editorError.value = caught instanceof Error ? caught.message : '规则保存失败';
  } finally {
    editorBusy.value = false;
  }
}

async function saveEditor(): Promise<void> {
  if (editorKind.value === 'channel') await saveChannel();
  else await saveRule();
}

async function toggleChannel(channel: NotificationChannel, enabled: boolean): Promise<void> {
  actionId.value = channel.id;
  actionMessage.value = null;
  actionError.value = false;
  try {
    await api.notifications.updateChannel(channel.id, { enabled });
    channel.enabled = enabled;
    actionMessage.value = enabled ? '渠道已启用。' : '渠道已停用。';
  } catch (caught) {
    actionError.value = true;
    actionMessage.value = caught instanceof Error ? caught.message : '渠道更新失败';
  } finally {
    actionId.value = null;
  }
}

async function testChannel(channel: NotificationChannel): Promise<void> {
  actionId.value = `test-${channel.id}`;
  actionMessage.value = null;
  actionError.value = false;
  try {
    const result: NotificationChannelTestResult = await api.notifications.testChannel(channel.id);
    actionError.value = !result.succeeded;
    actionMessage.value = notificationChannelTestMessage(result);
  } catch (caught) {
    actionError.value = true;
    actionMessage.value = caught instanceof Error ? caught.message : '测试发送失败';
  } finally {
    actionId.value = null;
  }
}

async function toggleRule(rule: NotificationRule, enabled: boolean): Promise<void> {
  actionId.value = rule.id;
  actionMessage.value = null;
  actionError.value = false;
  try {
    await api.notifications.updateRule(rule.id, { enabled });
    rule.enabled = enabled;
    actionMessage.value = enabled ? '规则已启用。' : '规则已停用。';
  } catch (caught) {
    actionError.value = true;
    actionMessage.value = caught instanceof Error ? caught.message : '规则更新失败';
  } finally {
    actionId.value = null;
  }
}

async function replay(delivery: DeliveryRecord): Promise<void> {
  actionId.value = delivery.id;
  actionMessage.value = null;
  actionError.value = false;
  try {
    await api.notifications.replay(delivery.id);
    actionMessage.value = '已使用原事件 ID 提交重放。';
  } catch (caught) {
    actionError.value = true;
    actionMessage.value = caught instanceof Error ? caught.message : '重放失败';
  } finally {
    actionId.value = null;
  }
}

function openDelete(target: DeleteTarget): void {
  deleteTarget.value = target;
  deleteError.value = null;
}

function closeDelete(): void {
  if (!deleteLoading.value) deleteTarget.value = null;
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deleteLoading.value = true;
  deleteError.value = null;
  try {
    if (target.kind === 'channel') await api.notifications.deleteChannel(target.id);
    if (target.kind === 'rule') await api.notifications.deleteRule(target.id);
    await load();
    actionMessage.value = `“${target.name}”已删除。`;
    actionError.value = false;
    deleteTarget.value = null;
  } catch (caught) {
    deleteError.value = caught instanceof Error ? caught.message : '删除失败';
  } finally {
    deleteLoading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <PageHeader title="通知管理" description="告警规则直接绑定通知渠道；投递重试不会重新创建业务事件。">
      <template #actions>
        <button class="btn btn-secondary" type="button" :disabled="loading" @click="load"><RefreshCw :size="16" aria-hidden="true" />刷新</button>
        <button v-if="headerAction" class="btn btn-primary" type="button" @click="openEditor(headerAction.kind)"><Plus :size="16" aria-hidden="true" />{{ headerAction.label }}</button>
      </template>
    </PageHeader>

    <div v-if="error" class="notice notice-danger" role="alert">通知数据加载失败：{{ error }}</div>
    <div v-if="actionMessage" class="notice" :class="actionError ? 'notice-danger' : 'notice-success'" role="status"><span class="action-notice-copy">{{ actionMessage }}</span></div>

    <section class="notification-summary">
      <article><Webhook :size="17" aria-hidden="true" /><span><strong>{{ summary.channels }}</strong><small>活动渠道</small></span></article>
      <article><BellRing :size="17" aria-hidden="true" /><span><strong>{{ summary.rules }}</strong><small>启用规则</small></span></article>
      <article><Send :size="17" aria-hidden="true" /><span><strong>{{ summary.customized }}</strong><small>自定义投递</small></span></article>
      <article :class="{ alert: summary.failed > 0 }"><History :size="17" aria-hidden="true" /><span><strong>{{ summary.failed }}</strong><small>等待重试 / 终止</small></span></article>
    </section>

    <section class="surface notification-surface">
      <nav class="tabs notification-tabs" aria-label="通知视图">
        <button class="tab-button" :class="{ active: activeTab === 'channels' }" type="button" @click="activeTab = 'channels'">渠道</button>
        <button class="tab-button" :class="{ active: activeTab === 'rules' }" type="button" @click="activeTab = 'rules'">告警规则</button>
        <button class="tab-button" :class="{ active: activeTab === 'deliveries' }" type="button" @click="activeTab = 'deliveries'">投递记录</button>
      </nav>
      <div v-if="loading" class="loading-line" />

      <template v-if="activeTab === 'channels' && channels.length">
        <div class="table-wrap desktop-channel-table">
          <table class="data-table channels-table">
          <thead><tr><th>渠道</th><th>地址</th><th>请求体</th><th>最近投递</th><th>启用</th><th><span class="sr-only">操作</span></th></tr></thead>
          <tbody>
            <tr v-for="channel in paginatedChannels" :key="channel.id">
              <td><span class="cell-main">{{ channel.name }}</span><span class="cell-sub">Webhook · POST</span></td>
              <td><span class="cell-main mono channel-url" :title="channel.url">{{ channel.url }}</span><span class="cell-sub">{{ channelProtocol(channel.url) }} · {{ channel.timeout_seconds ?? 10 }} 秒超时</span></td>
              <td><StatusBadge status="ready" :label="channelBodyModeLabel(channel.body_mode)" /><span v-if="channel.has_headers" class="cell-sub">含额外 Header</span></td>
              <td><StatusBadge :status="channel.last_delivery_status" /><span class="cell-sub">{{ channel.last_delivery_at ? formatRelativeTime(channel.last_delivery_at) : '暂无记录' }}</span></td>
              <td><ToggleSwitch :model-value="channel.enabled" :disabled="actionId === channel.id" :label="channel.enabled ? `停用${channel.name}` : `启用${channel.name}`" @update:model-value="toggleChannel(channel, $event)" /></td>
              <td><div class="notification-actions"><button class="icon-btn" type="button" :title="`编辑 ${channel.name}`" :aria-label="`编辑 ${channel.name}`" @click="openChannelEditor(channel)"><Pencil :size="16" aria-hidden="true" /></button><button class="icon-btn" type="button" :disabled="!channel.enabled || actionId === `test-${channel.id}`" :title="`测试 ${channel.name}`" :aria-label="`测试 ${channel.name}`" @click="testChannel(channel)"><FlaskConical :size="16" aria-hidden="true" /></button><button class="icon-btn icon-btn-danger" type="button" :title="`删除 ${channel.name}`" :aria-label="`删除 ${channel.name}`" @click="openDelete({ kind: 'channel', id: channel.id, name: channel.name })"><Trash2 :size="16" aria-hidden="true" /></button></div></td>
            </tr>
          </tbody>
          </table>
        </div>
        <div class="mobile-channel-list">
          <article v-for="channel in paginatedChannels" :key="`mobile-${channel.id}`" class="mobile-channel-item">
            <header><div><strong>{{ channel.name }}</strong><span>Webhook · POST · {{ channelProtocol(channel.url) }}</span></div><StatusBadge :status="channel.last_delivery_status" /></header>
            <p class="mono">{{ channel.url }}</p>
            <dl><div><dt>请求体</dt><dd>{{ channelBodyModeLabel(channel.body_mode) }}{{ channel.has_headers ? ' · 含 Header' : '' }}</dd></div><div><dt>最近投递</dt><dd>{{ channel.last_delivery_at ? formatRelativeTime(channel.last_delivery_at) : '暂无记录' }}</dd></div></dl>
            <footer><ToggleSwitch :model-value="channel.enabled" :disabled="actionId === channel.id" :label="channel.enabled ? `停用${channel.name}` : `启用${channel.name}`" @update:model-value="toggleChannel(channel, $event)" /><div class="notification-actions"><button class="icon-btn" type="button" :title="`编辑 ${channel.name}`" :aria-label="`编辑 ${channel.name}`" @click="openChannelEditor(channel)"><Pencil :size="16" aria-hidden="true" /></button><button class="btn btn-secondary" type="button" :disabled="!channel.enabled || actionId === `test-${channel.id}`" @click="testChannel(channel)"><FlaskConical :size="15" aria-hidden="true" />测试</button><button class="icon-btn icon-btn-danger" type="button" :title="`删除 ${channel.name}`" :aria-label="`删除 ${channel.name}`" @click="openDelete({ kind: 'channel', id: channel.id, name: channel.name })"><Trash2 :size="16" aria-hidden="true" /></button></div></footer>
          </article>
        </div>
      </template>

      <div v-else-if="activeTab === 'rules' && rules.length" class="rule-list">
        <article v-for="rule in paginatedRules" :key="rule.id" class="rule-item">
          <span class="rule-icon"><BellRing :size="17" aria-hidden="true" /></span>
          <div class="rule-main">
            <header><div><strong>{{ rule.name }}</strong><span>{{ ruleTypeLabel(rule.type) }} · {{ rule.scope_label }}</span></div><StatusBadge :status="rule.severity" /></header>
            <dl>
              <div><dt>告警条件</dt><dd>最终失败立即告警</dd></div>
              <div><dt>恢复条件</dt><dd>连续正常 {{ rule.recovery_confirm_count ?? 1 }} 次</dd></div>
              <div><dt>持续提醒</dt><dd>{{ ruleRepeatSummary(rule) }}</dd></div>
              <div><dt>渠道数</dt><dd>{{ rule.channel_ids.length }}</dd></div>
            </dl>
            <div class="event-chip-list"><span v-for="eventType in rule.event_types.slice(0, 4)" :key="eventType" :title="eventType">{{ eventTypeLabel(eventType) }}</span><span v-if="rule.event_types.length > 4">+{{ rule.event_types.length - 4 }}</span></div>
          </div>
          <div class="rule-actions"><ToggleSwitch :model-value="rule.enabled" :disabled="actionId === rule.id" :label="rule.enabled ? `停用${rule.name}` : `启用${rule.name}`" @update:model-value="toggleRule(rule, $event)" /><button class="icon-btn" type="button" :title="`编辑 ${rule.name}`" :aria-label="`编辑 ${rule.name}`" @click="openRuleEditor(rule)"><Pencil :size="16" aria-hidden="true" /></button><button class="icon-btn icon-btn-danger" type="button" :title="`删除 ${rule.name}`" :aria-label="`删除 ${rule.name}`" @click="openDelete({ kind: 'rule', id: rule.id, name: rule.name })"><Trash2 :size="16" aria-hidden="true" /></button></div>
        </article>
      </div>

      <template v-else-if="activeTab === 'deliveries' && deliveries.length">
        <div class="table-wrap desktop-delivery-table">
          <table class="data-table deliveries-table">
          <thead><tr><th>时间</th><th>事件 ID</th><th>渠道</th><th>状态</th><th>尝试</th><th>HTTP</th><th>耗时</th><th><span class="sr-only">操作</span></th></tr></thead>
          <tbody><tr v-for="delivery in paginatedDeliveries" :key="delivery.id"><td>{{ formatDateTime(delivery.created_at) }}</td><td class="mono">{{ delivery.event_id }}</td><td>{{ delivery.channel_name }}</td><td><StatusBadge :status="delivery.status" /></td><td class="numeric">{{ delivery.attempt }}</td><td class="numeric">{{ delivery.http_status ?? '—' }}</td><td class="numeric">{{ delivery.duration_ms ? `${delivery.duration_ms} ms` : '—' }}</td><td><button v-if="delivery.status !== 'sent'" class="icon-btn" type="button" :disabled="actionId === delivery.id" title="重放投递" aria-label="重放投递" @click="replay(delivery)"><RotateCcw :size="16" aria-hidden="true" /></button><CheckCircle2 v-else :size="16" class="text-success" aria-label="已发送" /></td></tr></tbody>
          </table>
        </div>
        <div class="mobile-delivery-list">
          <article v-for="delivery in paginatedDeliveries" :key="`mobile-${delivery.id}`" class="mobile-delivery-item">
            <header><div><strong>{{ delivery.channel_name }}</strong><span>{{ formatDateTime(delivery.created_at) }}</span></div><StatusBadge :status="delivery.status" /></header>
            <p class="mono">{{ delivery.event_id }}</p>
            <dl><div><dt>尝试次数</dt><dd>{{ delivery.attempt }}</dd></div><div><dt>HTTP</dt><dd>{{ delivery.http_status ?? '—' }}</dd></div><div><dt>耗时</dt><dd>{{ delivery.duration_ms ? `${delivery.duration_ms} ms` : '—' }}</dd></div></dl>
            <button v-if="delivery.status !== 'sent'" class="btn btn-secondary" type="button" :disabled="actionId === delivery.id" @click="replay(delivery)"><RotateCcw :size="15" aria-hidden="true" />重放投递</button>
          </article>
        </div>
      </template>

      <EmptyState v-else-if="!loading" title="当前视图暂无记录" description="添加 Webhook 渠道，并在告警规则中直接选择接收渠道。" />
      <PaginationControls v-if="activeTotal" v-model:page="activePage" v-model:page-size="activePageSize" :total="activeTotal" />
    </section>

    <div v-if="editorKind" class="modal-backdrop" @click.self="closeEditor" @keydown.esc="closeEditor">
      <section class="modal-panel" :class="{ 'modal-panel-wide': editorKind !== 'channel' }" role="dialog" aria-modal="true" aria-labelledby="notification-editor-title">
        <header><div><h2 id="notification-editor-title">{{ editorTitle }}</h2><p>{{ editorKind === 'channel' ? 'Webhook 出站配置' : '事件判定与通知渠道' }}</p></div><button class="icon-btn" type="button" :disabled="editorBusy" title="关闭" aria-label="关闭" @click="closeEditor"><X :size="17" aria-hidden="true" /></button></header>
        <div class="modal-body">
          <div v-if="editorError" class="notice notice-danger" role="alert">{{ editorError }}</div>

          <template v-if="editorKind === 'channel'">
            <div class="field"><label for="channel-name">渠道名称</label><input id="channel-name" v-model="channelForm.name" class="input" maxlength="120" /></div>
            <div class="field"><label for="channel-url">目标 URL（HTTP / HTTPS）</label><input id="channel-url" v-model="channelForm.url" class="input mono" type="url" placeholder="https://hooks.example.com/relay" /><span class="field-hint">公网接收端推荐 HTTPS；RFC1918 私网与本机回环地址可直接使用。</span></div>
            <div class="notice" role="note"><ShieldAlert :size="17" aria-hidden="true" /><span><strong>内网访问安全提醒：</strong>Webhook 可以访问本机和局域网服务，请只填写可信接收端。系统仍会阻止链路本地云元数据、多播、保留或无效地址，并限制重定向、超时和响应大小。</span></div>
            <div class="form-grid">
              <div class="field"><label for="channel-timeout">请求超时</label><select id="channel-timeout" v-model="channelForm.timeout_seconds" class="select"><option :value="5">5 秒</option><option :value="10">10 秒</option><option :value="15">15 秒</option><option :value="30">30 秒</option></select></div>
              <div class="field toggle-field"><span class="field-label">渠道状态</span><ToggleSwitch v-model="channelForm.enabled" label="启用渠道" /></div>
              <div class="field form-span-2"><label for="channel-body-mode">请求体</label><select id="channel-body-mode" v-model="channelForm.body_mode" class="select"><option value="json">预设 - application/json</option><option value="form_data">预设 - multipart/form-data</option><option value="custom">自定义内容</option></select><span v-if="channelForm.body_mode === 'json'" class="field-hint">发送顶层 <code>msg</code> 和来源名称 <code>Relay Monitor</code>，并保留完整事件详情。</span><span v-else-if="channelForm.body_mode === 'form_data'" class="field-hint">发送名为 <code>data</code> 的表单字段，字段值是同一份事件 JSON；Content-Type boundary 会自动生成。</span><span v-else class="field-hint">按模板生成原始请求体；可使用 <code>msg</code>，结果是有效 JSON 时使用 application/json，否则使用 text/plain。</span></div>
              <div v-if="channelForm.body_mode === 'custom'" class="field form-span-2"><label for="channel-body-template">自定义请求体</label><textarea id="channel-body-template" v-model="channelForm.body_template" class="input code-textarea" :placeholder="CUSTOM_BODY_EXAMPLE" spellcheck="false"></textarea><span class="field-hint">消息文本可用 <code>msg</code> 或 <code>payload.msg</code>；还可读取 payload.event、payload.incident、payload.rule、payload.site、payload.details 和 payload.detected_at。使用 <code>| json</code> 可安全写入 JSON。</span></div>
              <div class="field form-span-2 toggle-field"><span class="field-label">额外 Header</span><ToggleSwitch v-model="channelForm.headers_enabled" label="添加额外 Header" /></div>
              <div v-if="channelForm.headers_enabled" class="field form-span-2"><label for="channel-headers">Header JSON</label><textarea id="channel-headers" v-model="channelForm.headers_text" class="input code-textarea" :placeholder="EXTRA_HEADERS_EXAMPLE" spellcheck="false"></textarea><span class="field-hint">Bearer 示例：<code>"Authorization": "Bearer YOUR_TOKEN"</code>，Bearer 后有一个空格。编辑已有渠道时会列出 Header 名称：值留空表示保留，填写表示替换，删除键表示移除该项。</span></div>
            </div>
          </template>

          <template v-else-if="editorKind === 'rule'">
            <div class="form-grid">
              <div class="field"><label for="rule-name">规则名称</label><input id="rule-name" v-model="ruleForm.name" class="input" maxlength="120" /></div>
              <div class="field"><label for="rule-severity">严重度</label><select id="rule-severity" v-model="ruleForm.severity" class="select"><option value="info">信息</option><option value="warning">警告</option><option value="critical">严重</option></select></div>
            </div>

            <fieldset class="editor-fieldset event-tree">
              <legend class="legend-with-action">
                <span class="legend-heading">监控事件 <small>{{ ruleForm.event_types.length }}/{{ MONITOR_EVENT_COUNT }}</small></span>
                <label class="legend-select-all">
                  <input
                    type="checkbox"
                    :checked="eventGroupSelected(MONITOR_NOTIFICATION_EVENT_TYPES)"
                    :indeterminate="eventGroupPartial(MONITOR_NOTIFICATION_EVENT_TYPES)"
                    @change="toggleEventGroup(MONITOR_NOTIFICATION_EVENT_TYPES, $event)"
                  />
                  <b>{{ eventGroupSelected(MONITOR_NOTIFICATION_EVENT_TYPES) ? '取消全选' : '全选' }}</b>
                </label>
              </legend>
              <section v-for="group in EVENT_GROUPS" :key="group.id" class="event-group">
                <label class="event-group-header">
                  <input
                    type="checkbox"
                    :checked="eventGroupSelected(group.events)"
                    :indeterminate="eventGroupPartial(group.events)"
                    @change="toggleEventGroup(group.events, $event)"
                  />
                  <span>{{ group.label }}</span>
                  <small>{{ group.events.filter((eventType) => ruleForm.event_types.includes(eventType)).length }}/{{ group.events.length }}</small>
                </label>
                <div class="choice-grid event-choice-grid">
                  <label v-for="eventType in group.events" :key="eventType">
                    <input v-model="ruleForm.event_types" type="checkbox" :value="eventType" />
                    <span>{{ eventTypeLabel(eventType) }}</span>
                  </label>
                </div>
              </section>
            </fieldset>

            <fieldset class="editor-fieldset">
              <legend class="legend-with-action">
                <span class="legend-heading">站点范围 <small>不选表示全部站点</small></span>
                <label class="legend-select-all" :class="{ disabled: sites.length === 0 }">
                  <input
                    type="checkbox"
                    :checked="allSelected(ruleForm.site_ids, siteOptionIds)"
                    :indeterminate="partiallySelected(ruleForm.site_ids, siteOptionIds)"
                    :disabled="sites.length === 0"
                    @change="toggleSelection(ruleForm.site_ids, siteOptionIds, $event)"
                  />
                  <b>{{ allSelected(ruleForm.site_ids, siteOptionIds) ? '取消全选' : '全选' }}</b>
                </label>
              </legend>
              <div v-if="sites.length" class="choice-grid site-choice-grid">
                <label v-for="site in sites" :key="site.id">
                  <input v-model="ruleForm.site_ids" type="checkbox" :value="site.id" />
                  <span class="site-choice-copy"><strong>{{ site.name }}</strong><small class="mono">{{ site.base_url }}</small></span>
                </label>
              </div>
              <p v-else class="selector-empty">暂无可选站点</p>
            </fieldset>

            <fieldset class="editor-fieldset">
              <legend>站点标签 <span>所选标签需同时存在；不选表示不限，已选具体站点时可留空</span></legend>
              <div v-if="siteTagOptions.length" class="choice-grid tag-choice-grid">
                <label v-for="tag in siteTagOptions" :key="tag"><input v-model="ruleForm.tags" type="checkbox" :value="tag" /><span>{{ tag }}</span></label>
              </div>
              <p v-else class="selector-empty">先在中转站编辑中添加标签</p>
            </fieldset>

            <div class="form-grid">
              <div v-if="ruleForm.event_types.some((eventType) => eventType.startsWith('rate.') || eventType.startsWith('probe.'))" class="field"><label for="rule-rate-kinds">倍率类型</label><input id="rule-rate-kinds" v-model="ruleForm.rate_kinds" class="input mono" placeholder="group, model" /></div>
              <div v-if="ruleForm.event_types.includes('rate.changed')" class="field"><span class="field-label">变化方向</span><div class="inline-checks"><label><input v-model="ruleForm.directions" type="checkbox" value="up" /> 上升</label><label><input v-model="ruleForm.directions" type="checkbox" value="down" /> 下降</label></div></div>
              <div v-if="ruleForm.event_types.includes('rate.changed')" class="field"><label for="rule-min-change">最小变化量</label><input id="rule-min-change" v-model="ruleForm.minimum_change" class="input mono" inputmode="decimal" placeholder="留空表示任意变化" /></div>
            </div>

            <fieldset class="editor-fieldset policy-fieldset">
              <legend>告警与自动恢复 <span>临时故障先由监控任务按配置重试</span></legend>
              <div class="form-grid recovery-grid">
                <div class="field">
                  <label for="recovery-count">什么时候判定恢复</label>
                  <div class="count-sentence"><span>连续正常</span><input id="recovery-count" v-model.number="ruleForm.recovery_confirm_count" class="input numeric" type="number" min="1" max="10000" aria-describedby="recovery-count-hint" /><span>次后恢复</span></div>
                  <span id="recovery-count-hint" class="field-hint">最终异常会直接告警；恢复后是否通知，由下方“发送恢复通知”控制。</span>
                </div>
              </div>
            </fieldset>

            <fieldset class="editor-fieldset policy-fieldset">
              <legend>持续告警提醒 <span>异常一直没有恢复时</span></legend>
              <div class="repeat-toggle-row">
                <div><strong>再次发送告警</strong><span>{{ repeatEnabled ? '按间隔继续提醒' : '关闭后只发送首次告警' }}</span></div>
                <ToggleSwitch v-model="repeatEnabled" :label="repeatEnabled ? '关闭持续提醒' : '开启持续提醒'" />
              </div>
              <div v-if="repeatEnabled" class="form-grid repeat-grid">
                <div class="field">
                  <label for="repeat-interval">再次提醒间隔</label>
                  <select id="repeat-interval" v-model.number="ruleForm.repeat_interval_seconds" class="select">
                    <option v-if="customRepeatInterval" :value="ruleForm.repeat_interval_seconds">{{ formatRepeatInterval(ruleForm.repeat_interval_seconds) }}（当前值）</option>
                    <option v-for="option in REPEAT_INTERVAL_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
                  </select>
                  <span class="field-hint">从上一次告警发送完成后开始计算。</span>
                </div>
                <div class="field">
                  <label for="max-repeats">最多再提醒几次</label>
                  <div class="count-sentence compact"><input id="max-repeats" v-model.number="ruleForm.max_repeats" class="input numeric" type="number" min="1" max="10000" /><span>次</span></div>
                  <span class="field-hint">不包含第一次正式告警。</span>
                </div>
              </div>
              <div class="policy-summary" aria-live="polite"><BellRing :size="16" aria-hidden="true" /><span>{{ alertPolicySummary }}</span></div>
            </fieldset>
            <fieldset class="editor-fieldset"><legend>通知渠道 <span>规则的唯一发送绑定；不选时只生成事件中心记录</span></legend><div v-if="channels.length" class="choice-grid"><label v-for="channel in channels" :key="channel.id"><input v-model="ruleForm.channel_ids" type="checkbox" :value="channel.id" /><span>{{ channel.name }}</span></label></div><p v-else class="selector-empty">请先创建通知渠道</p></fieldset>
            <div class="binary-row"><ToggleSwitch v-model="ruleForm.enabled" label="启用规则" /><ToggleSwitch v-model="ruleForm.send_recovery" label="发送恢复通知" /></div>
          </template>

        </div>
        <footer><button class="btn btn-secondary" type="button" :disabled="editorBusy" @click="closeEditor">取消</button><button class="btn btn-primary" type="button" :disabled="editorBusy" @click="saveEditor"><CheckCircle2 :size="15" aria-hidden="true" />{{ editorBusy ? '正在保存…' : '保存' }}</button></footer>
      </section>
    </div>

    <ConfirmDeleteDialog
      :open="deleteTarget !== null"
      :title="deleteCopy.title"
      :description="deleteCopy.description"
      :item-name="deleteTarget?.name ?? ''"
      :loading="deleteLoading"
      :error="deleteError"
      @cancel="closeDelete"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.notification-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
.notification-summary article { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--accent); }
.notification-summary article.alert { color: var(--danger); }
.notification-summary strong,
.notification-summary small { display: block; }
.notification-summary strong { color: var(--text); font-size: 21px; }
.notification-summary small { color: var(--text-tertiary); font-size: 12px; }
.notification-surface { overflow: hidden; }
.notification-tabs { padding: 0 12px; }
.channels-table { min-width: 900px; }
.deliveries-table { min-width: 920px; }
.mobile-channel-list,
.mobile-delivery-list { display: none; }
.notification-actions,
.rule-actions { display: flex; align-items: center; gap: 7px; }
.channel-url { display: block; max-width: 310px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-list { display: grid; }
.rule-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 13px; padding: 14px 15px; border-bottom: 1px solid var(--border); }
.rule-item:last-child { border-bottom: 0; }
.rule-icon { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 5px; background: var(--surface-muted); color: var(--text-secondary); }
.rule-main { min-width: 0; }
.rule-main header { display: flex; align-items: start; justify-content: space-between; gap: 10px; }
.rule-main header > div { min-width: 0; }
.rule-main header strong,
.rule-main header span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-main header span { margin-top: 2px; color: var(--text-tertiary); font-size: 12px; }
.rule-main dl { display: flex; flex-wrap: wrap; gap: 12px 28px; margin: 11px 0 0; }
.rule-main dt { color: var(--text-tertiary); font-size: 12px; }
.rule-main dd { margin: 1px 0 0; font-size: 12px; font-weight: 650; }
.event-chip-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
.event-chip-list span { padding: 3px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-subtle); color: var(--text-secondary); font-size: 10px; }
.code-textarea { min-height: 150px; resize: vertical; font-family: var(--font-mono); line-height: 1.5; }
.action-notice-copy { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.modal-backdrop { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: 18px; background: rgb(12 18 16 / 46%); }
.modal-panel { width: min(620px, 100%); max-height: calc(100vh - 36px); overflow-y: auto; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); box-shadow: 0 18px 50px rgb(10 24 20 / 18%); }
.modal-panel-wide { width: min(860px, 100%); }
.modal-panel > header { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 15px 17px; border-bottom: 1px solid var(--border); }
.modal-panel h2 { margin: 0; font-size: 17px; }
.modal-panel header p { margin: 2px 0 0; color: var(--text-tertiary); font-size: 13px; }
.modal-body { display: grid; gap: 16px; padding: 17px; }
.modal-panel > footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 17px; border-top: 1px solid var(--border); background: var(--surface-subtle); }
.toggle-field { align-content: start; }
.form-span-2 { grid-column: span 2; }
.editor-fieldset { min-width: 0; margin: 0; padding: 14px 0 0; border: 0; border-top: 1px solid var(--border); }
.editor-fieldset legend { width: 100%; margin-bottom: 9px; padding: 0; color: var(--text-secondary); font-size: 13px; font-weight: 680; }
.editor-fieldset legend span { margin-left: 5px; color: var(--text-tertiary); font-size: 11px; font-weight: 500; }
.editor-fieldset .legend-with-action { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.legend-with-action > .legend-heading { min-width: 0; margin-left: 0; color: var(--text-secondary); font-size: 13px; font-weight: 680; }
.legend-heading small { margin-left: 5px; color: var(--text-tertiary); font-size: 11px; font-weight: 500; }
.legend-select-all { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 6px; color: var(--accent); font-size: 12px; cursor: pointer; }
.legend-select-all input { margin: 0; accent-color: var(--accent); }
.legend-select-all b { font-weight: 650; }
.legend-select-all.disabled { color: var(--text-tertiary); cursor: not-allowed; }
.choice-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.event-choice-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.choice-grid label { display: flex; min-width: 0; min-height: 34px; align-items: center; gap: 7px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 5px; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.choice-grid label:has(input:checked) { border-color: #99bdb3; background: var(--accent-soft); color: var(--accent); }
.choice-grid input,
.inline-checks input { accent-color: var(--accent); }
.choice-grid span { min-width: 0; overflow-wrap: anywhere; }
.event-tree { display: grid; gap: 14px; }
.event-group { display: grid; gap: 8px; }
.event-group + .event-group { padding-top: 13px; border-top: 1px solid var(--border); }
.event-group-header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; color: var(--text); font-size: 13px; font-weight: 700; cursor: pointer; }
.event-group-header input { accent-color: var(--accent); }
.event-group-header small { color: var(--text-tertiary); font-size: 11px; font-weight: 550; }
.site-choice-grid label { align-items: flex-start; min-height: 50px; }
.site-choice-grid input { margin-top: 3px; }
.site-choice-copy strong,
.site-choice-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site-choice-copy strong { color: var(--text); font-size: 12px; }
.site-choice-copy small { margin-top: 2px; color: var(--text-tertiary); font-size: 10px; }
.selector-empty { margin: 0; color: var(--text-tertiary); font-size: 12px; }
.inline-checks { display: flex; min-height: 38px; align-items: center; flex-wrap: wrap; gap: 8px 18px; color: var(--text-secondary); font-size: 12px; }
.inline-checks label { cursor: pointer; }
.binary-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 26px; padding-top: 12px; border-top: 1px solid var(--border); }
.recovery-grid { grid-template-columns: minmax(0, 1fr); }
.repeat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.count-sentence { display: grid; min-height: 42px; grid-template-columns: auto minmax(72px, 110px) auto; align-items: center; justify-content: start; gap: 8px; color: var(--text-secondary); font-size: 12px; }
.count-sentence.compact { grid-template-columns: minmax(72px, 110px) auto; justify-content: start; }
.count-sentence .input { min-width: 0; }
.repeat-toggle-row { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 16px; }
.repeat-toggle-row strong,
.repeat-toggle-row span { display: block; }
.repeat-toggle-row strong { font-size: 13px; }
.repeat-toggle-row span { margin-top: 2px; color: var(--text-tertiary); font-size: 11px; }
.repeat-grid { margin-top: 12px; }
.policy-summary { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding-top: 11px; border-top: 1px dashed var(--border); color: var(--text-secondary); font-size: 12px; line-height: 1.55; }
.policy-summary svg { flex: 0 0 auto; margin-top: 1px; color: var(--accent); }

@media (max-width: 700px) {
  .notification-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rule-item { grid-template-columns: auto minmax(0, 1fr); align-items: start; }
  .rule-item > :last-child { grid-column: 2; }
  .event-choice-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .repeat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  .desktop-channel-table,
  .desktop-delivery-table { display: none; }
  .mobile-channel-list,
  .mobile-delivery-list { display: grid; }
  .mobile-channel-item,
  .mobile-delivery-item { padding: 14px; border-bottom: 1px solid var(--border); }
  .mobile-channel-item:last-child,
  .mobile-delivery-item:last-child { border-bottom: 0; }
  .mobile-channel-item header,
  .mobile-delivery-item header { display: flex; align-items: start; justify-content: space-between; gap: 10px; }
  .mobile-channel-item header strong,
  .mobile-channel-item header span,
  .mobile-delivery-item header strong,
  .mobile-delivery-item header span { display: block; }
  .mobile-channel-item header span,
  .mobile-delivery-item header span { margin-top: 2px; color: var(--text-tertiary); font-size: 12px; }
  .mobile-channel-item > p,
  .mobile-delivery-item > p { margin: 10px 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: 12px; }
  .mobile-channel-item dl,
  .mobile-delivery-item dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0; }
  .mobile-channel-item dt,
  .mobile-delivery-item dt { color: var(--text-tertiary); font-size: 11px; }
  .mobile-channel-item dd,
  .mobile-delivery-item dd { margin: 2px 0 0; overflow-wrap: anywhere; font-size: 12px; font-weight: 650; }
  .mobile-channel-item footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--border); }
  .mobile-channel-item footer .btn,
  .mobile-delivery-item > .btn { min-height: 36px; padding: 6px 10px; font-size: 13px; }
  .mobile-delivery-item > .btn { margin-top: 12px; }
}
@media (max-width: 430px) {
  .notification-summary { grid-template-columns: minmax(0, 1fr); }
  .notification-summary article { display: grid; grid-template-columns: auto minmax(0, 1fr); }
  .mobile-channel-item dl,
  .mobile-delivery-item dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .form-grid,
  .choice-grid,
  .event-choice-grid,
  .recovery-grid,
  .repeat-grid { grid-template-columns: minmax(0, 1fr); }
  .form-span-2 { grid-column: span 1; }
  .count-sentence { grid-template-columns: auto minmax(64px, 92px) auto; }
}
</style>
