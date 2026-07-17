<script setup lang="ts">
import {
  BellOff,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';

import {
  BALANCE_NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_EVENT_TYPES,
  PROBE_NOTIFICATION_EVENT_TYPES,
  RATE_NOTIFICATION_EVENT_TYPES,
  SITE_NOTIFICATION_EVENT_TYPES,
} from '../../../shared/notification-events';
import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import StatusBadge from '../components/StatusBadge.vue';
import ToggleSwitch from '../components/ToggleSwitch.vue';
import { api, pageItems } from '../services/api';
import { formatDateTime, formatDurationSeconds, formatRelativeTime } from '../services/format';
import { loadResource } from '../services/resource-loader';
import { useAuthStore } from '../stores/auth';
import type { MaintenanceWindow, SilenceRecord, SiteViewModel } from '../types/domain';

type ActiveTab = 'windows' | 'silences';
type EditorKind = 'window' | 'silence';
type DeleteTarget = { kind: EditorKind; id: string; name: string };
type SuppressionMatcher = {
  site_ids?: string[];
  event_types?: string[];
  severities?: string[];
  tags?: string[];
};

const auth = useAuthStore();

const EVENT_LABELS: Readonly<Record<string, string>> = {
  'site.network_unreachable': '网络不可达',
  'site.timeout': '请求超时',
  'site.auth_expired': '认证 / 登录失效',
  'site.permission_denied': '权限拒绝',
  'site.rate_limited': '上游限流',
  'site.upstream_5xx': '上游服务异常',
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
  'probe.failed': '模型实测失败',
  'probe.recovered': '模型实测恢复',
  'balance.low': '余额过低',
  'balance.threshold': '余额阈值',
};
const EVENT_GROUPS = [
  { id: 'site', label: '中转站状态', events: [...SITE_NOTIFICATION_EVENT_TYPES] },
  { id: 'rate', label: '倍率变化', events: [...RATE_NOTIFICATION_EVENT_TYPES, 'rate.threshold'] },
  { id: 'probe', label: '模型实测', events: [...PROBE_NOTIFICATION_EVENT_TYPES] },
  { id: 'balance', label: '余额', events: [...BALANCE_NOTIFICATION_EVENT_TYPES] },
] as const;
const SEVERITIES = [
  { value: 'info', label: '信息' },
  { value: 'warning', label: '警告' },
  { value: 'critical', label: '严重' },
] as const;

const windows = ref<MaintenanceWindow[]>([]);
const silences = ref<SilenceRecord[]>([]);
const sites = ref<SiteViewModel[]>([]);
const error = ref<string | null>(null);
const loading = ref(true);
const activeTab = ref<ActiveTab>('windows');
const windowPage = ref(1);
const silencePage = ref(1);
const pageSize = ref(10);
const windowTotal = ref(0);
const silenceTotal = ref(0);
const editorKind = ref<EditorKind | null>(null);
const editingId = ref<string | null>(null);
const submitting = ref(false);
const editorError = ref<string | null>(null);
const actionId = ref<string | null>(null);
const actionMessage = ref<string | null>(null);
const actionError = ref(false);
const deleteTarget = ref<DeleteTarget | null>(null);
const deleteLoading = ref(false);
const deleteError = ref<string | null>(null);

const windowForm = reactive({
  name: '',
  enabled: true,
  schedule_type: 'once' as MaintenanceWindow['schedule_type'],
  starts_at: '',
  ends_at: '',
  cron_expression: '0 2 * * 3',
  duration_minutes: 60,
  timezone: 'Asia/Shanghai',
  reason: '',
  site_ids: [] as string[],
  tags: [] as string[],
});
const silenceForm = reactive({
  reason: '',
  starts_at: '',
  ends_at: '',
  site_ids: [] as string[],
  tags: [] as string[],
  event_types: [] as string[],
  severities: [] as string[],
});

const activeWindowCount = computed(() => windows.value.filter((item) => item.active).length);
const activeSilenceCount = computed(() => silences.value.filter((item) => item.active).length);
const windowPageCount = computed(() => Math.max(1, Math.ceil(windowTotal.value / pageSize.value)));
const silencePageCount = computed(() => Math.max(1, Math.ceil(silenceTotal.value / pageSize.value)));
const currentPage = computed(() => activeTab.value === 'windows' ? windowPage.value : silencePage.value);
const currentPageCount = computed(() => activeTab.value === 'windows' ? windowPageCount.value : silencePageCount.value);
const currentTotal = computed(() => activeTab.value === 'windows' ? windowTotal.value : silenceTotal.value);
const siteIds = computed(() => sites.value.map((site) => site.id));
const tagOptions = computed(() => [...new Set(sites.value.flatMap((site) => site.tags))].sort((a, b) => a.localeCompare(b)));
const editorTitle = computed(() => {
  if (editorKind.value === 'window') return editingId.value ? '编辑维护窗口' : '新建维护窗口';
  return editingId.value ? '编辑临时静默' : '新建临时静默';
});
const deleteCopy = computed(() => deleteTarget.value?.kind === 'silence'
  ? { title: '删除临时静默？', description: '该静默会从数据库永久删除并立即失效；“结束”操作则会保留在历史列表中。' }
  : { title: '删除维护窗口？', description: '该维护窗口会从数据库永久删除；如只想停止当前计划，请使用“结束 / 停用”。' });
const windowFormValid = computed(() => {
  if (!windowForm.name.trim() || !windowForm.reason.trim()) return false;
  if (windowForm.schedule_type === 'once') {
    return Boolean(windowForm.starts_at && windowForm.ends_at && Date.parse(windowForm.ends_at) > Date.parse(windowForm.starts_at));
  }
  if (windowForm.schedule_type === 'cron') {
    return Boolean(windowForm.cron_expression.trim() && windowForm.duration_minutes >= 1);
  }
  return true;
});
const silenceFormValid = computed(() => Boolean(
  silenceForm.reason.trim() &&
  silenceForm.starts_at &&
  silenceForm.ends_at &&
  Date.parse(silenceForm.ends_at) > Date.parse(silenceForm.starts_at)
));

function localDateTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function asIso(value: string): string {
  return new Date(value).toISOString();
}

async function load(): Promise<void> {
  loading.value = true;
  const result = await loadResource(
    async () => {
      const [windowResult, silenceResult, siteResult] = await Promise.all([
        api.maintenance.list(windowPage.value, pageSize.value),
        api.maintenance.silences(silencePage.value, pageSize.value),
        api.sites.list(),
      ]);
      return { windowResult, silenceResult, sites: pageItems(siteResult) };
    },
    {
      windowResult: { items: [], page: windowPage.value, page_size: pageSize.value, total: 0 },
      silenceResult: { items: [], page: silencePage.value, page_size: pageSize.value, total: 0 },
      sites: [],
    },
  );
  windows.value = result.data.windowResult.items;
  silences.value = result.data.silenceResult.items;
  sites.value = result.data.sites;
  windowTotal.value = result.data.windowResult.total;
  silenceTotal.value = result.data.silenceResult.total;
  error.value = result.error;
  loading.value = false;
}

function matcher(siteSelection: string[], tags: string[], extra: SuppressionMatcher = {}): SuppressionMatcher {
  return {
    ...(siteSelection.length ? { site_ids: [...siteSelection] } : {}),
    ...(tags.length ? { tags: [...tags] } : {}),
    ...extra,
  };
}

function describeMatcher(value: SuppressionMatcher, fallback: string): string {
  const parts: string[] = [];
  if (value.site_ids?.length) {
    const names = value.site_ids.map((id) => sites.value.find((site) => site.id === id)?.name ?? '已删除站点');
    parts.push(`站点：${names.join('、')}`);
  }
  if (value.tags?.length) parts.push(`标签：${value.tags.join('、')}`);
  if (value.event_types?.length) parts.push(`事件：${value.event_types.map((item) => EVENT_LABELS[item] ?? '其他事件').join('、')}`);
  if (value.severities?.length) {
    const labels: Readonly<Record<string, string>> = { info: '信息', warning: '警告', critical: '严重' };
    parts.push(`严重度：${value.severities.map((item) => labels[item] ?? item).join('、')}`);
  }
  return parts.join('；') || fallback;
}

function selectedAll(selected: string[], options: readonly string[]): boolean {
  return options.length > 0 && options.every((item) => selected.includes(item));
}

function selectedSome(selected: string[], options: readonly string[]): boolean {
  const count = options.filter((item) => selected.includes(item)).length;
  return count > 0 && count < options.length;
}

function toggleSelection(selected: string[], options: readonly string[], event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  const next = checked
    ? [...new Set([...selected, ...options])]
    : selected.filter((item) => !options.includes(item));
  selected.splice(0, selected.length, ...next);
}

function resetWindowForm(): void {
  const now = new Date();
  const end = new Date(now.getTime() + 60 * 60 * 1_000);
  Object.assign(windowForm, {
    name: '', enabled: true, schedule_type: 'once', starts_at: localDateTime(now),
    ends_at: localDateTime(end), cron_expression: '0 2 * * 3', duration_minutes: 60,
    timezone: auth.user?.timezone ?? 'Asia/Shanghai', reason: '', site_ids: [], tags: [],
  });
}

function resetSilenceForm(): void {
  const now = new Date();
  const end = new Date(now.getTime() + 6 * 60 * 60 * 1_000);
  Object.assign(silenceForm, {
    reason: '', starts_at: localDateTime(now), ends_at: localDateTime(end),
    site_ids: [], tags: [], event_types: [], severities: [],
  });
}

function openCreate(kind: EditorKind): void {
  editingId.value = null;
  editorError.value = null;
  if (kind === 'window') resetWindowForm();
  else resetSilenceForm();
  editorKind.value = kind;
}

function openWindowEdit(item: MaintenanceWindow): void {
  editingId.value = item.id;
  editorError.value = null;
  Object.assign(windowForm, {
    name: item.name,
    enabled: item.enabled,
    schedule_type: item.schedule_type,
    starts_at: item.starts_at ? localDateTime(item.starts_at) : '',
    ends_at: item.ends_at ? localDateTime(item.ends_at) : '',
    cron_expression: item.cron_expression ?? '0 2 * * 3',
    duration_minutes: Math.max(1, Math.round((item.duration_seconds ?? 3_600) / 60)),
    timezone: item.timezone,
    reason: item.reason,
    site_ids: [...(item.matcher.site_ids ?? [])],
    tags: [...(item.matcher.tags ?? [])],
  });
  editorKind.value = 'window';
}

function openSilenceEdit(item: SilenceRecord): void {
  editingId.value = item.id;
  editorError.value = null;
  Object.assign(silenceForm, {
    reason: item.reason,
    starts_at: localDateTime(item.starts_at),
    ends_at: localDateTime(item.ends_at),
    site_ids: [...(item.matcher_config.site_ids ?? [])],
    tags: [...(item.matcher_config.tags ?? [])],
    event_types: [...(item.matcher_config.event_types ?? [])],
    severities: [...(item.matcher_config.severities ?? [])],
  });
  editorKind.value = 'silence';
}

function closeEditor(): void {
  if (!submitting.value) editorKind.value = null;
}

async function saveWindow(): Promise<void> {
  if (!windowFormValid.value) return;
  submitting.value = true;
  editorError.value = null;
  const current = editingId.value ? windows.value.find((item) => item.id === editingId.value) : undefined;
  const payload = {
    name: windowForm.name.trim(),
    enabled: windowForm.enabled,
    schedule_type: windowForm.schedule_type,
    matcher: matcher(windowForm.site_ids, windowForm.tags),
    starts_at: windowForm.schedule_type === 'cron'
      ? null
      : windowForm.schedule_type === 'manual'
        ? current?.starts_at ?? new Date().toISOString()
        : asIso(windowForm.starts_at),
    ends_at: windowForm.schedule_type === 'cron'
      ? null
      : windowForm.schedule_type === 'manual'
        ? current?.ends_at ?? null
        : asIso(windowForm.ends_at),
    cron_expression: windowForm.schedule_type === 'cron' ? windowForm.cron_expression.trim() : null,
    duration_seconds: windowForm.schedule_type === 'cron' ? windowForm.duration_minutes * 60 : null,
    timezone: windowForm.timezone,
    reason: windowForm.reason.trim(),
  };
  try {
    if (editingId.value) await api.maintenance.update(editingId.value, payload);
    else await api.maintenance.create(payload);
    await load();
    actionMessage.value = `维护窗口已${editingId.value ? '更新' : '创建'}。`;
    actionError.value = false;
    editorKind.value = null;
  } catch (caught) {
    editorError.value = caught instanceof Error ? caught.message : '保存维护窗口失败';
  } finally {
    submitting.value = false;
  }
}

async function saveSilence(): Promise<void> {
  if (!silenceFormValid.value) return;
  submitting.value = true;
  editorError.value = null;
  const matcherConfig = matcher(silenceForm.site_ids, silenceForm.tags, {
    ...(silenceForm.event_types.length ? { event_types: [...silenceForm.event_types] } : {}),
    ...(silenceForm.severities.length ? { severities: [...silenceForm.severities] } : {}),
  });
  const payload = {
    matcher: matcherConfig,
    reason: silenceForm.reason.trim(),
    starts_at: asIso(silenceForm.starts_at),
    ends_at: asIso(silenceForm.ends_at),
  };
  try {
    if (editingId.value) await api.maintenance.updateSilence(editingId.value, payload);
    else await api.maintenance.createSilence(payload);
    await load();
    actionMessage.value = `临时静默已${editingId.value ? '更新' : '创建'}。`;
    actionError.value = false;
    editorKind.value = null;
  } catch (caught) {
    editorError.value = caught instanceof Error ? caught.message : '保存临时静默失败';
  } finally {
    submitting.value = false;
  }
}

async function endWindow(item: MaintenanceWindow): Promise<void> {
  actionId.value = item.id;
  actionMessage.value = null;
  try {
    await api.maintenance.update(item.id, {
      enabled: false,
      active: false,
      ...(item.active && item.schedule_type !== 'cron' ? { ends_at: new Date().toISOString() } : {}),
    });
    await load();
    actionMessage.value = '维护窗口已结束并保留在历史列表中。';
    actionError.value = false;
  } catch (caught) {
    actionError.value = true;
    actionMessage.value = caught instanceof Error ? caught.message : '停用维护窗口失败';
  } finally {
    actionId.value = null;
  }
}

async function endSilence(item: SilenceRecord): Promise<void> {
  actionId.value = item.id;
  actionMessage.value = null;
  try {
    await api.maintenance.updateSilence(item.id, { active: false });
    await load();
    actionMessage.value = '临时静默已结束并保留在历史列表中。';
    actionError.value = false;
  } catch (caught) {
    actionError.value = true;
    actionMessage.value = caught instanceof Error ? caught.message : '结束临时静默失败';
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
    if (target.kind === 'window') await api.maintenance.remove(target.id);
    else await api.maintenance.deleteSilence(target.id);
    await load();
    actionMessage.value = `“${target.name}”已永久删除。`;
    actionError.value = false;
    deleteTarget.value = null;
  } catch (caught) {
    deleteError.value = caught instanceof Error ? caught.message : '删除失败';
  } finally {
    deleteLoading.value = false;
  }
}

async function changePage(page: number): Promise<void> {
  if (activeTab.value === 'windows') windowPage.value = Math.min(Math.max(1, page), windowPageCount.value);
  else silencePage.value = Math.min(Math.max(1, page), silencePageCount.value);
  await load();
}

async function changePageSize(): Promise<void> {
  windowPage.value = 1;
  silencePage.value = 1;
  await load();
}

function windowStatus(item: MaintenanceWindow): { status: 'warning' | 'info' | 'resolved'; label: string } {
  if (item.active) return { status: 'warning', label: '维护中' };
  if (!item.enabled) return { status: 'resolved', label: '已停用' };
  if (item.schedule_type === 'cron') return { status: 'info', label: '周期计划' };
  if (item.starts_at && Date.parse(item.starts_at) > Date.now()) return { status: 'info', label: '待开始' };
  return { status: 'resolved', label: '已结束' };
}

function silenceStatus(item: SilenceRecord): { status: 'suppressed' | 'info' | 'resolved'; label: string } {
  if (item.active) return { status: 'suppressed', label: '静默中' };
  if (Date.parse(item.starts_at) > Date.now()) return { status: 'info', label: '待开始' };
  return { status: 'resolved', label: '已结束' };
}

onMounted(load);
</script>

<template>
  <div class="page">
    <PageHeader title="维护与静默" description="维护窗口和临时静默只暂停匹配通知；监控采集、事件记录与历史数据不会停止。">
      <template #actions>
        <button class="btn btn-secondary" type="button" :disabled="loading" @click="load"><RefreshCw :size="16" aria-hidden="true" />刷新</button>
        <button class="btn btn-primary" type="button" @click="openCreate(activeTab === 'windows' ? 'window' : 'silence')">
          <Plus :size="16" aria-hidden="true" />{{ activeTab === 'windows' ? '新建维护窗口' : '新建临时静默' }}
        </button>
      </template>
    </PageHeader>

    <div v-if="error" class="notice notice-danger" role="alert">维护数据加载失败：{{ error }}</div>
    <div v-if="actionMessage" class="notice" :class="actionError ? 'notice-danger' : 'notice-success'" role="status">{{ actionMessage }}</div>

    <section class="maintenance-summary" aria-label="维护与静默概览">
      <div><span><CalendarClock :size="18" aria-hidden="true" /></span><p><strong>{{ windowTotal }}</strong><small>维护窗口总数</small></p></div>
      <div><span><Clock3 :size="18" aria-hidden="true" /></span><p><strong>{{ activeWindowCount }}</strong><small>本页维护中</small></p></div>
      <div><span><BellOff :size="18" aria-hidden="true" /></span><p><strong>{{ activeSilenceCount }} / {{ silenceTotal }}</strong><small>本页活动 / 静默总数</small></p></div>
    </section>

    <section class="surface maintenance-surface">
      <nav class="tabs" aria-label="维护视图">
        <button class="tab-button" :class="{ active: activeTab === 'windows' }" type="button" @click="activeTab = 'windows'">维护窗口（{{ windowTotal }}）</button>
        <button class="tab-button" :class="{ active: activeTab === 'silences' }" type="button" @click="activeTab = 'silences'">临时静默（{{ silenceTotal }}）</button>
      </nav>
      <div v-if="loading" class="loading-line" />

      <div v-if="activeTab === 'windows' && windows.length" class="maintenance-list">
        <article v-for="item in windows" :key="item.id" class="maintenance-item">
          <span class="maintenance-icon" :class="{ active: item.active }"><CalendarClock :size="18" aria-hidden="true" /></span>
          <div class="maintenance-main">
            <header>
              <div><strong>{{ item.name }}</strong><span>{{ describeMatcher(item.matcher, '全部站点') }}</span></div>
              <StatusBadge :status="windowStatus(item).status" :label="windowStatus(item).label" />
            </header>
            <p>{{ item.reason || '未填写维护原因' }}</p>
            <dl>
              <div><dt>计划类型</dt><dd>{{ item.schedule_type === 'manual' ? '手动维护' : item.schedule_type === 'once' ? '单次时段' : 'Cron 周期' }}</dd></div>
              <template v-if="item.schedule_type === 'cron'">
                <div><dt>Cron</dt><dd class="mono">{{ item.cron_expression }}</dd></div>
                <div><dt>每次持续</dt><dd>{{ formatDurationSeconds(item.duration_seconds ?? 3600) }}</dd></div>
              </template>
              <template v-else>
                <div><dt>开始</dt><dd>{{ formatDateTime(item.starts_at) }}</dd></div>
                <div><dt>结束</dt><dd>{{ item.ends_at ? formatDateTime(item.ends_at) : '手动结束' }}</dd></div>
              </template>
              <div><dt>时区</dt><dd>{{ item.timezone }}</dd></div>
            </dl>
          </div>
          <div class="maintenance-actions">
            <button v-if="item.enabled" class="btn btn-secondary" type="button" :disabled="actionId === item.id" @click="endWindow(item)"><Square :size="14" aria-hidden="true" />{{ item.active ? '结束' : '停用' }}</button>
            <button class="icon-btn" type="button" :title="`编辑 ${item.name}`" :aria-label="`编辑 ${item.name}`" @click="openWindowEdit(item)"><Pencil :size="16" aria-hidden="true" /></button>
            <button class="icon-btn icon-btn-danger" type="button" :title="`删除 ${item.name}`" :aria-label="`删除 ${item.name}`" @click="openDelete({ kind: 'window', id: item.id, name: item.name })"><Trash2 :size="16" aria-hidden="true" /></button>
          </div>
        </article>
      </div>

      <div v-else-if="activeTab === 'silences' && silences.length" class="silence-list">
        <article v-for="item in silences" :key="item.id" class="silence-item">
          <span class="silence-icon" :class="{ active: item.active }"><BellOff :size="17" aria-hidden="true" /></span>
          <div class="silence-main">
            <header><strong>{{ describeMatcher(item.matcher_config, '全部事件') }}</strong><StatusBadge :status="silenceStatus(item).status" :label="silenceStatus(item).label" /></header>
            <p>{{ item.reason }}</p>
            <small>由 {{ item.created_by }} 创建 · {{ formatDateTime(item.starts_at) }} 至 {{ formatDateTime(item.ends_at) }}（{{ formatRelativeTime(item.ends_at) }}）</small>
          </div>
          <div class="maintenance-actions">
            <button v-if="item.active" class="btn btn-secondary" type="button" :disabled="actionId === item.id" @click="endSilence(item)"><Square :size="14" aria-hidden="true" />结束</button>
            <button class="icon-btn" type="button" title="编辑临时静默" aria-label="编辑临时静默" @click="openSilenceEdit(item)"><Pencil :size="16" aria-hidden="true" /></button>
            <button class="icon-btn icon-btn-danger" type="button" title="删除临时静默" aria-label="删除临时静默" @click="openDelete({ kind: 'silence', id: item.id, name: item.reason })"><Trash2 :size="16" aria-hidden="true" /></button>
          </div>
        </article>
      </div>

      <EmptyState v-else-if="!loading" :title="activeTab === 'windows' ? '没有维护窗口' : '没有临时静默'" :description="activeTab === 'windows' ? '新建维护计划，在变更期间暂停匹配通知。' : '新建有明确范围和有效期的临时静默。'" />

      <footer v-if="currentTotal > 0" class="pagination-bar">
        <span>共 {{ currentTotal }} 条</span>
        <label>每页 <select v-model.number="pageSize" class="select page-size" @change="changePageSize"><option :value="10">10</option><option :value="20">20</option><option :value="50">50</option></select> 条</label>
        <div class="page-buttons">
          <button class="icon-btn" type="button" title="上一页" aria-label="上一页" :disabled="currentPage <= 1 || loading" @click="changePage(currentPage - 1)"><ChevronLeft :size="17" aria-hidden="true" /></button>
          <span>第 {{ currentPage }} / {{ currentPageCount }} 页</span>
          <button class="icon-btn" type="button" title="下一页" aria-label="下一页" :disabled="currentPage >= currentPageCount || loading" @click="changePage(currentPage + 1)"><ChevronRight :size="17" aria-hidden="true" /></button>
        </div>
      </footer>
    </section>

    <div v-if="editorKind" class="modal-backdrop" @click.self="closeEditor">
      <section class="modal-panel maintenance-modal" role="dialog" aria-modal="true" aria-labelledby="maintenance-editor-title">
        <header>
          <div><h2 id="maintenance-editor-title">{{ editorTitle }}</h2><p>{{ editorKind === 'window' ? '计划内继续采集，只暂停匹配通知。' : '静默有明确时限，结束后通知自动恢复。' }}</p></div>
          <button class="icon-btn" type="button" title="关闭" aria-label="关闭" @click="closeEditor"><X :size="17" aria-hidden="true" /></button>
        </header>

        <div v-if="editorKind === 'window'" class="modal-body">
          <div class="form-grid">
            <div class="field"><label for="maint-name">名称</label><input id="maint-name" v-model="windowForm.name" class="input" maxlength="120" placeholder="例如：上游版本升级" /></div>
            <div class="field"><label for="maint-type">计划类型</label><select id="maint-type" v-model="windowForm.schedule_type" class="select"><option value="manual">立即开始，手动结束</option><option value="once">单次时间段</option><option value="cron">Cron 周期计划</option></select></div>
            <template v-if="windowForm.schedule_type === 'once'">
              <div class="field"><label for="maint-start">开始时间</label><input id="maint-start" v-model="windowForm.starts_at" class="input" type="datetime-local" /></div>
              <div class="field"><label for="maint-end">结束时间</label><input id="maint-end" v-model="windowForm.ends_at" class="input" type="datetime-local" /></div>
            </template>
            <template v-if="windowForm.schedule_type === 'cron'">
              <div class="field"><label for="maint-cron">Cron 表达式</label><input id="maint-cron" v-model="windowForm.cron_expression" class="input mono" placeholder="0 2 * * 3" /></div>
              <div class="field"><label for="maint-duration">每次持续（分钟）</label><input id="maint-duration" v-model.number="windowForm.duration_minutes" class="input" type="number" min="1" max="525600" /></div>
            </template>
            <div class="field"><label for="maint-timezone">时区</label><select id="maint-timezone" v-model="windowForm.timezone" class="select"><option value="Asia/Shanghai">Asia/Shanghai</option><option value="UTC">UTC</option></select></div>
            <div class="field toggle-field"><span class="field-label">计划状态</span><ToggleSwitch v-model="windowForm.enabled" label="启用维护计划" /></div>
          </div>

          <fieldset class="editor-fieldset">
            <legend class="legend-with-action"><span>站点范围 <small>不选表示全部站点</small></span><label><input type="checkbox" :checked="selectedAll(windowForm.site_ids, siteIds)" :indeterminate="selectedSome(windowForm.site_ids, siteIds)" @change="toggleSelection(windowForm.site_ids, siteIds, $event)" />全选</label></legend>
            <div v-if="sites.length" class="choice-grid site-choice-grid"><label v-for="site in sites" :key="site.id"><input v-model="windowForm.site_ids" type="checkbox" :value="site.id" /><span><strong>{{ site.name }}</strong><small class="mono">{{ site.base_url }}</small></span></label></div>
            <p v-else class="selector-empty">暂无可选站点</p>
          </fieldset>

          <fieldset class="editor-fieldset">
            <legend>站点标签 <small>来自中转站设置，可按环境或用途批量匹配；不选表示不限</small></legend>
            <div v-if="tagOptions.length" class="choice-grid tag-choice-grid"><label v-for="tag in tagOptions" :key="tag"><input v-model="windowForm.tags" type="checkbox" :value="tag" /><span>{{ tag }}</span></label></div>
            <p v-else class="selector-empty">当前站点尚未设置标签</p>
          </fieldset>

          <div class="field"><label for="maint-reason">维护原因</label><textarea id="maint-reason" v-model="windowForm.reason" class="textarea" maxlength="1000" placeholder="说明变更内容和负责人，便于追溯" /></div>
          <div class="notice"><ShieldCheck :size="17" aria-hidden="true" />结束会保留历史记录；删除会从数据库永久移除该记录。</div>
          <div v-if="editorError" class="notice notice-danger">{{ editorError }}</div>
        </div>

        <div v-else class="modal-body">
          <div class="form-grid">
            <div class="field"><label for="silence-start">开始时间</label><input id="silence-start" v-model="silenceForm.starts_at" class="input" type="datetime-local" /></div>
            <div class="field"><label for="silence-end">结束时间</label><input id="silence-end" v-model="silenceForm.ends_at" class="input" type="datetime-local" /></div>
          </div>

          <fieldset class="editor-fieldset">
            <legend class="legend-with-action"><span>站点范围 <small>不选表示全部站点</small></span><label><input type="checkbox" :checked="selectedAll(silenceForm.site_ids, siteIds)" :indeterminate="selectedSome(silenceForm.site_ids, siteIds)" @change="toggleSelection(silenceForm.site_ids, siteIds, $event)" />全选</label></legend>
            <div v-if="sites.length" class="choice-grid site-choice-grid"><label v-for="site in sites" :key="site.id"><input v-model="silenceForm.site_ids" type="checkbox" :value="site.id" /><span><strong>{{ site.name }}</strong><small class="mono">{{ site.base_url }}</small></span></label></div>
            <p v-else class="selector-empty">暂无可选站点</p>
          </fieldset>

          <fieldset class="editor-fieldset">
            <legend>站点标签 <small>来自中转站设置；所选标签需同时存在</small></legend>
            <div v-if="tagOptions.length" class="choice-grid tag-choice-grid"><label v-for="tag in tagOptions" :key="tag"><input v-model="silenceForm.tags" type="checkbox" :value="tag" /><span>{{ tag }}</span></label></div>
            <p v-else class="selector-empty">当前站点尚未设置标签</p>
          </fieldset>

          <fieldset class="editor-fieldset event-selector">
            <legend class="legend-with-action"><span>监控事件 <small>不选表示全部事件</small></span><label><input type="checkbox" :checked="selectedAll(silenceForm.event_types, NOTIFICATION_EVENT_TYPES)" :indeterminate="selectedSome(silenceForm.event_types, NOTIFICATION_EVENT_TYPES)" @change="toggleSelection(silenceForm.event_types, NOTIFICATION_EVENT_TYPES, $event)" />全选</label></legend>
            <section v-for="group in EVENT_GROUPS" :key="group.id" class="event-group">
              <label class="event-group-heading"><input type="checkbox" :checked="selectedAll(silenceForm.event_types, group.events)" :indeterminate="selectedSome(silenceForm.event_types, group.events)" @change="toggleSelection(silenceForm.event_types, group.events, $event)" /><strong>{{ group.label }}</strong></label>
              <div class="choice-grid event-choice-grid"><label v-for="eventType in group.events" :key="eventType"><input v-model="silenceForm.event_types" type="checkbox" :value="eventType" /><span>{{ EVENT_LABELS[eventType] }}</span></label></div>
            </section>
          </fieldset>

          <fieldset class="editor-fieldset">
            <legend>严重度 <small>不选表示全部</small></legend>
            <div class="choice-grid severity-grid"><label v-for="severity in SEVERITIES" :key="severity.value"><input v-model="silenceForm.severities" type="checkbox" :value="severity.value" /><span>{{ severity.label }}</span></label></div>
          </fieldset>

          <div class="field"><label for="silence-reason">静默原因</label><textarea id="silence-reason" v-model="silenceForm.reason" class="textarea" maxlength="1000" placeholder="说明为何静默及后续处理方式" /></div>
          <div class="notice"><ShieldCheck :size="17" aria-hidden="true" />结束静默会保留历史；删除会永久移除记录，二者都会立即恢复后续匹配通知。</div>
          <div v-if="editorError" class="notice notice-danger">{{ editorError }}</div>
        </div>

        <footer>
          <button class="btn btn-secondary" type="button" :disabled="submitting" @click="closeEditor">取消</button>
          <button v-if="editorKind === 'window'" class="btn btn-primary" type="button" :disabled="submitting || !windowFormValid" @click="saveWindow"><CalendarClock :size="15" aria-hidden="true" />{{ submitting ? '正在保存…' : '保存维护窗口' }}</button>
          <button v-else class="btn btn-primary" type="button" :disabled="submitting || !silenceFormValid" @click="saveSilence"><BellOff :size="15" aria-hidden="true" />{{ submitting ? '正在保存…' : '保存临时静默' }}</button>
        </footer>
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
.maintenance-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
.maintenance-summary > div { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.maintenance-summary > div > span { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; border-radius: 5px; background: var(--accent-soft); color: var(--accent); }
.maintenance-summary p { min-width: 0; margin: 0; }
.maintenance-summary strong,
.maintenance-summary small { display: block; }
.maintenance-summary strong { font-size: 21px; }
.maintenance-summary small { overflow: hidden; color: var(--text-tertiary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.maintenance-surface { overflow: hidden; }
.maintenance-surface > .tabs { padding: 0 12px; }
.maintenance-list,
.silence-list { display: grid; }
.maintenance-item,
.silence-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 13px; padding: 15px; border-bottom: 1px solid var(--border); }
.maintenance-icon,
.silence-icon { display: grid; width: 36px; height: 36px; place-items: center; border-radius: 6px; background: var(--surface-muted); color: var(--text-secondary); }
.maintenance-icon.active { background: var(--warning-soft); color: var(--warning); }
.silence-icon.active { background: var(--violet-soft); color: var(--violet); }
.maintenance-main,
.silence-main { min-width: 0; }
.maintenance-main header,
.silence-main header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.maintenance-main header > div { min-width: 0; }
.maintenance-main header strong,
.maintenance-main header span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.maintenance-main header span { color: var(--text-tertiary); font-size: 12px; }
.silence-main header strong { overflow-wrap: anywhere; font-size: 13px; }
.maintenance-main > p,
.silence-main > p { margin: 7px 0 0; color: var(--text-secondary); font-size: 13px; }
.maintenance-main dl { display: flex; flex-wrap: wrap; gap: 12px 24px; margin: 10px 0 0; }
.maintenance-main dl div { min-width: 100px; }
.maintenance-main dt { color: var(--text-tertiary); font-size: 12px; }
.maintenance-main dd { margin: 1px 0 0; font-size: 12px; font-weight: 620; }
.silence-main small { display: block; margin-top: 4px; color: var(--text-tertiary); font-size: 12px; }
.maintenance-actions { display: flex; align-items: center; gap: 7px; }
.pagination-bar { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 14px; min-height: 58px; padding: 10px 15px; border-top: 1px solid var(--border); color: var(--text-secondary); font-size: 13px; }
.pagination-bar label,
.page-buttons { display: flex; align-items: center; gap: 8px; }
.page-size { width: 74px; min-height: 36px; padding: 6px 9px; }
.page-buttons .icon-btn { width: 36px; height: 36px; flex-basis: 36px; }
.modal-backdrop { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: 18px; background: rgb(12 18 16 / 46%); }
.modal-panel { width: min(760px, 100%); max-height: calc(100vh - 36px); overflow-y: auto; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); box-shadow: 0 18px 50px rgb(10 24 20 / 18%); }
.modal-panel > header { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 15px 17px; border-bottom: 1px solid var(--border); }
.modal-panel h2 { margin: 0; font-size: 17px; }
.modal-panel header p { margin: 2px 0 0; color: var(--text-tertiary); font-size: 13px; }
.modal-body { display: grid; gap: 16px; padding: 17px; }
.modal-panel > footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 17px; border-top: 1px solid var(--border); background: var(--surface-subtle); }
.toggle-field { align-content: end; }
.editor-fieldset { display: grid; min-width: 0; gap: 10px; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: 6px; }
.editor-fieldset legend { max-width: 100%; padding: 0 6px; color: var(--text-secondary); font-size: 13px; font-weight: 650; }
.editor-fieldset legend small { color: var(--text-tertiary); font-weight: 400; }
.legend-with-action { display: flex; width: calc(100% - 8px); align-items: center; justify-content: space-between; gap: 12px; }
.legend-with-action > label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.choice-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.choice-grid > label { display: flex; min-width: 0; align-items: center; gap: 9px; min-height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 5px; color: var(--text-secondary); cursor: pointer; }
.choice-grid > label:has(input:checked) { border-color: #91baae; background: var(--accent-soft); color: var(--text); }
.choice-grid input,
.legend-with-action input,
.event-group-heading input { flex: 0 0 auto; }
.choice-grid span { min-width: 0; overflow-wrap: anywhere; }
.site-choice-grid strong,
.site-choice-grid small { display: block; }
.site-choice-grid small { overflow: hidden; color: var(--text-tertiary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.tag-choice-grid,
.severity-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.event-selector { gap: 13px; }
.event-group { display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid var(--border); }
.event-group:first-of-type { padding-top: 0; border-top: 0; }
.event-group-heading { display: inline-flex; align-items: center; gap: 7px; color: var(--text); font-size: 13px; cursor: pointer; }
.event-choice-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.selector-empty { margin: 0; color: var(--text-tertiary); font-size: 13px; }

@media (max-width: 760px) {
  .maintenance-summary { grid-template-columns: minmax(0, 1fr); }
  .maintenance-item,
  .silence-item { grid-template-columns: auto minmax(0, 1fr); align-items: start; }
  .maintenance-actions { grid-column: 2; justify-self: start; flex-wrap: wrap; }
  .maintenance-main header,
  .silence-main header { align-items: flex-start; flex-direction: column; }
  .form-grid,
  .choice-grid,
  .event-choice-grid { grid-template-columns: minmax(0, 1fr); }
  .pagination-bar { justify-content: space-between; }
}

@media (max-width: 440px) {
  .pagination-bar { align-items: stretch; flex-direction: column; }
  .page-buttons { justify-content: space-between; }
  .modal-backdrop { padding: 8px; }
  .modal-panel { max-height: calc(100vh - 16px); }
  .legend-with-action { align-items: flex-start; flex-direction: column; }
}
</style>
