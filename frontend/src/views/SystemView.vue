<script setup lang="ts">
import {
  Activity,
  Archive,
  Box,
  Check,
  Copy,
  Database,
  ExternalLink,
  FileClock,
  HardDrive,
  MemoryStick,
  RefreshCw,
  RotateCcw,
  Search,
  ServerCog,
  ShieldCheck,
  TimerReset,
  Trash2,
} from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';

import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import PaginationControls from '../components/PaginationControls.vue';
import ServerAccessSettings from '../components/ServerAccessSettings.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { api } from '../services/api';
import { formatBytes, formatDateTime, formatRelativeTime } from '../services/format';
import { clampPage } from '../services/pagination';
import { auditActionLabel, auditResourceTypeLabel } from '../services/presentation';
import { beijingDateTimeToIso } from '../services/query';
import { loadResource } from '../services/resource-loader';
import type { AuditLog, SystemStatus } from '../types/domain';

const EMPTY_SYSTEM_STATUS: SystemStatus = {
  version: '—',
  started_at: '',
  scheduler_running: false,
  scheduler_lag_ms: 0,
  running_jobs: 0,
  queued_jobs: 0,
  last_schedule_success_at: '',
  outbox_pending: 0,
  outbox_dead: 0,
  database_size_bytes: 0,
  wal_size_bytes: 0,
  last_backup_at: null,
  event_loop_lag_ms: 0,
  memory_used_bytes: 0,
  memory_total_bytes: 0,
  adapter_versions: [],
};

const status = ref<SystemStatus>({ ...EMPTY_SYSTEM_STATUS });
const auditLogs = ref<AuditLog[]>([]);
const statusLoadError = ref<string | null>(null);
const auditLoadError = ref<string | null>(null);
const loading = ref(true);
const auditLoading = ref(false);
const backingUp = ref(false);
const actionMessage = ref<string | null>(null);
const actionError = ref(false);
const copiedRequestId = ref<string | null>(null);
const auditSearch = ref('');
const auditResult = ref<'all' | 'success' | 'failed'>('all');
const auditFrom = ref('');
const auditTo = ref('');
const auditPage = ref(1);
const auditPageSize = ref(20);
const auditTotal = ref(0);
const auditDeleteTarget = ref<AuditLog | null>(null);
const auditDeleteLoading = ref(false);
const auditDeleteError = ref<string | null>(null);
const selectedAuditIds = ref<string[]>([]);
const auditBatchDeleteOpen = ref(false);
const auditBatchDeleteMode = ref<'selected' | 'time' | 'all'>('selected');
const auditDeleteBefore = ref('');
const auditBatchDeleteLoading = ref(false);
const auditBatchDeleteError = ref<string | null>(null);

const error = computed(() => [statusLoadError.value, auditLoadError.value].filter(Boolean).join('；') || null);
const auditPageIds = computed(() => auditLogs.value.map((entry) => entry.id));
const selectedAuditCount = computed(() => selectedAuditIds.value.length);
const allAuditPageSelected = computed(() => auditPageIds.value.length > 0
  && auditPageIds.value.every((id) => selectedAuditIds.value.includes(id)));
const someAuditPageSelected = computed(() => !allAuditPageSelected.value
  && auditPageIds.value.some((id) => selectedAuditIds.value.includes(id)));

const uptime = computed(() => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(status.value.started_at).getTime()) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
});

const memoryPercent = computed(() => status.value.memory_total_bytes > 0
  ? Math.min(100, Math.round((status.value.memory_used_bytes / status.value.memory_total_bytes) * 100))
  : 0);

function auditObjectLabel(entry: AuditLog): string {
  return entry.resource_type ? auditResourceTypeLabel(entry.resource_type) : entry.target;
}

function auditObjectDetail(entry: AuditLog): string | null {
  if (entry.resource_id) return entry.resource_id;
  if (entry.resource_type && entry.target !== entry.resource_type) return entry.target;
  return null;
}

async function copyRequestId(requestId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(requestId);
    copiedRequestId.value = requestId;
    window.setTimeout(() => {
      if (copiedRequestId.value === requestId) copiedRequestId.value = null;
    }, 1_500);
  } catch {
    actionError.value = true;
    actionMessage.value = '请求 ID 复制失败，请手动选择复制。';
  }
}

function auditQuery() {
  const from = beijingDateTimeToIso(auditFrom.value);
  const to = beijingDateTimeToIso(auditTo.value);
  if (from && to && from > to) throw new Error('开始时间不能晚于结束时间。');
  return {
    search: auditSearch.value.trim() || undefined,
    result: auditResult.value === 'all' ? undefined : auditResult.value,
    from,
    to,
    page: auditPage.value,
    page_size: auditPageSize.value,
  };
}

async function loadAuditLogs(): Promise<void> {
  auditLoading.value = true;
  auditLoadError.value = null;
  selectedAuditIds.value = [];
  try {
    const query = auditQuery();
    const result = await loadResource(
      () => api.system.auditLogs(query),
      {
        items: [],
        page: query.page,
        page_size: query.page_size,
        total: 0,
      },
    );
    auditLogs.value = result.data.items;
    auditTotal.value = result.data.total;
    auditLoadError.value = result.error;
  } catch (caught) {
    auditLogs.value = [];
    auditTotal.value = 0;
    auditLoadError.value = caught instanceof Error ? caught.message : '审计记录加载失败。';
  } finally {
    auditLoading.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  const result = await loadResource(
    () => api.system.status(),
    status.value,
  );
  status.value = result.data;
  statusLoadError.value = result.error;
  await loadAuditLogs();
  loading.value = false;
}

async function searchAuditLogs(): Promise<void> {
  auditPage.value = 1;
  await loadAuditLogs();
}

async function resetAuditFilters(): Promise<void> {
  auditSearch.value = '';
  auditResult.value = 'all';
  auditFrom.value = '';
  auditTo.value = '';
  auditPage.value = 1;
  await loadAuditLogs();
}

let auditReloadQueued = false;
function scheduleAuditReload(): void {
  if (auditReloadQueued) return;
  auditReloadQueued = true;
  queueMicrotask(() => {
    auditReloadQueued = false;
    void loadAuditLogs();
  });
}

function updateAuditPage(value: number): void {
  auditPage.value = value;
  scheduleAuditReload();
}

function updateAuditPageSize(value: number): void {
  auditPageSize.value = value;
  auditPage.value = 1;
  scheduleAuditReload();
}

function toggleCurrentAuditPage(event: Event): void {
  selectedAuditIds.value = (event.target as HTMLInputElement).checked ? [...auditPageIds.value] : [];
}

function openAuditBatchDelete(mode: 'selected' | 'time' | 'all' = 'selected'): void {
  if (mode === 'selected' && selectedAuditIds.value.length === 0) return;
  if (mode === 'time' && !auditDeleteBefore.value) return;
  auditBatchDeleteMode.value = mode;
  auditBatchDeleteError.value = null;
  auditBatchDeleteOpen.value = true;
}

function closeAuditBatchDelete(): void {
  if (auditBatchDeleteLoading.value) return;
  auditBatchDeleteOpen.value = false;
  auditBatchDeleteError.value = null;
}

async function reloadAuditLogsAfterDelete(): Promise<void> {
  await loadAuditLogs();
  const validPage = clampPage(auditPage.value, auditTotal.value, auditPageSize.value);
  if (validPage === auditPage.value) return;
  auditPage.value = validPage;
  await loadAuditLogs();
}

function openAuditDelete(entry: AuditLog): void {
  auditDeleteTarget.value = entry;
  auditDeleteError.value = null;
}

function closeAuditDelete(): void {
  if (!auditDeleteLoading.value) auditDeleteTarget.value = null;
}

async function confirmAuditDelete(): Promise<void> {
  const target = auditDeleteTarget.value;
  if (!target) return;
  auditDeleteLoading.value = true;
  auditDeleteError.value = null;
  try {
    await api.system.deleteAuditLog(target.id);
    auditDeleteTarget.value = null;
    actionError.value = false;
    actionMessage.value = '审计记录已永久删除。';
    await reloadAuditLogsAfterDelete();
  } catch (caught) {
    auditDeleteError.value = caught instanceof Error ? caught.message : '审计记录删除失败。';
  } finally {
    auditDeleteLoading.value = false;
  }
}

async function confirmAuditBatchDelete(): Promise<void> {
  const ids = [...selectedAuditIds.value];
  const mode = auditBatchDeleteMode.value;
  if (mode === 'selected' && ids.length === 0) return;
  auditBatchDeleteLoading.value = true;
  auditBatchDeleteError.value = null;
  try {
    let deletedCount: number;
    if (mode === 'selected') {
      deletedCount = (await api.system.deleteAuditLogs(ids)).deleted_count;
    } else if (mode === 'time') {
      const before = beijingDateTimeToIso(auditDeleteBefore.value);
      if (!before) throw new Error('请选择删除截止时间');
      deletedCount = (await api.system.deleteAuditLogsByTime(before)).deleted_count;
    } else {
      deletedCount = (await api.system.deleteAllAuditLogs()).deleted_count;
    }
    auditBatchDeleteOpen.value = false;
    actionError.value = false;
    actionMessage.value = `已永久删除 ${deletedCount} 条审计记录。`;
    await reloadAuditLogsAfterDelete();
  } catch (caught) {
    auditBatchDeleteError.value = caught instanceof Error ? caught.message : '批量删除审计记录失败。';
  } finally {
    auditBatchDeleteLoading.value = false;
  }
}

async function backup(): Promise<void> {
  backingUp.value = true;
  actionMessage.value = null;
  actionError.value = false;
  try {
    const result = await api.system.backup();
    actionMessage.value = result.backup_path ? `备份已完成：${result.backup_path}` : '备份已完成并通过校验。';
    await load();
  } catch (caught) {
    actionError.value = true;
    actionMessage.value = caught instanceof Error ? caught.message : '备份失败';
  } finally {
    backingUp.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <PageHeader title="系统设置" description="配置访问方式，并观察调度、通知投递、数据库和运行时健康。">
      <template #actions>
        <a class="btn btn-secondary" href="/openapi.json" target="_blank" rel="noopener noreferrer"><ExternalLink :size="16" aria-hidden="true" />OpenAPI</a>
        <button class="btn btn-secondary" type="button" :disabled="loading" @click="load"><RefreshCw :size="16" aria-hidden="true" />刷新</button>
        <button class="btn btn-primary" type="button" :disabled="backingUp" @click="backup"><Archive :size="16" aria-hidden="true" />{{ backingUp ? '备份中…' : '立即备份' }}</button>
      </template>
    </PageHeader>

    <div v-if="error" class="notice notice-danger" role="alert">系统数据加载失败：{{ error }}</div>
    <div v-if="actionMessage" class="notice" :class="actionError ? 'notice-danger' : 'notice-success'" role="status">{{ actionMessage }}</div>
    <div v-if="loading" class="loading-line" />

    <ServerAccessSettings />

    <section class="system-metrics metrics-grid">
      <article class="metric-card"><div class="metric-label"><Activity :size="15" aria-hidden="true" />调度器</div><div class="metric-value status-value"><StatusBadge :status="status.scheduler_running ? 'ready' : 'down'" :label="status.scheduler_running ? '运行中' : '已停止'" /></div><div class="metric-detail">延迟 {{ status.scheduler_lag_ms }} ms</div></article>
      <article class="metric-card"><div class="metric-label"><TimerReset :size="15" aria-hidden="true" />运行时间</div><div class="metric-value compact-value">{{ uptime }}</div><div class="metric-detail">启动于 {{ formatDateTime(status.started_at) }}</div></article>
      <article class="metric-card"><div class="metric-label"><Box :size="15" aria-hidden="true" />任务队列</div><div class="metric-value">{{ status.running_jobs }} / {{ status.queued_jobs }}</div><div class="metric-detail">运行中 / 等待中</div></article>
      <article class="metric-card"><div class="metric-label"><FileClock :size="15" aria-hidden="true" />通知投递</div><div class="metric-value">{{ status.outbox_pending }} / {{ status.outbox_dead }}</div><div class="metric-detail">待投递 / 已终止</div></article>
      <article class="metric-card"><div class="metric-label"><MemoryStick :size="15" aria-hidden="true" />内存使用</div><div class="metric-value">{{ memoryPercent }}%</div><div class="metric-detail">{{ formatBytes(status.memory_used_bytes) }} / {{ formatBytes(status.memory_total_bytes) }}</div></article>
    </section>

    <div class="system-grid">
      <section class="surface">
        <div class="surface-header"><div><h2 class="surface-title">运行时与调度</h2><p class="surface-subtitle">服务内部可观测状态</p></div><ServerCog :size="18" class="muted" aria-hidden="true" /></div>
        <div class="surface-body">
          <dl class="detail-list">
            <div class="detail-row"><dt>Relay Monitor 版本</dt><dd class="mono">v{{ status.version }}</dd></div>
            <div class="detail-row"><dt>最近成功调度</dt><dd>{{ formatRelativeTime(status.last_schedule_success_at) }}（{{ formatDateTime(status.last_schedule_success_at) }}）</dd></div>
            <div class="detail-row"><dt>调度延迟</dt><dd :class="status.scheduler_lag_ms > 1000 ? 'text-danger' : 'text-success'">{{ status.scheduler_lag_ms }} ms</dd></div>
            <div class="detail-row"><dt>事件循环延迟</dt><dd>{{ status.event_loop_lag_ms }} ms</dd></div>
            <div class="detail-row"><dt>就绪探针</dt><dd><a class="inline-link mono" href="/readyz" target="_blank" rel="noopener noreferrer">/readyz <ExternalLink :size="12" aria-hidden="true" /></a></dd></div>
          </dl>
        </div>
      </section>

      <section class="surface">
        <div class="surface-header"><div><h2 class="surface-title">存储与备份</h2><p class="surface-subtitle">SQLite WAL 与数据恢复</p></div><Database :size="18" class="muted" aria-hidden="true" /></div>
        <div class="surface-body">
          <div class="storage-usage"><div><HardDrive :size="18" aria-hidden="true" /><span><strong>{{ formatBytes(status.database_size_bytes) }}</strong><small>数据库</small></span></div><div><FileClock :size="18" aria-hidden="true" /><span><strong>{{ formatBytes(status.wal_size_bytes) }}</strong><small>WAL</small></span></div></div>
          <dl class="detail-list storage-details">
            <div class="detail-row"><dt>最近备份</dt><dd>{{ status.last_backup_at ? `${formatRelativeTime(status.last_backup_at)}（${formatDateTime(status.last_backup_at)}）` : '从未备份' }}</dd></div>
            <div class="detail-row"><dt>健康明细保留</dt><dd>30 天</dd></div>
            <div class="detail-row"><dt>倍率 / 余额历史</dt><dd>365 天</dd></div>
          </dl>
        </div>
      </section>
    </div>

    <div class="system-grid lower-grid">
      <section class="surface">
        <div class="surface-header"><div><h2 class="surface-title">适配器</h2><p class="surface-subtitle">仅加载随版本发布并通过测试的内置实现</p></div><ShieldCheck :size="18" class="muted" aria-hidden="true" /></div>
        <div class="adapter-list"><article v-for="adapter in status.adapter_versions" :key="adapter.type"><span class="adapter-mark">{{ adapter.type.slice(0, 1).toUpperCase() }}</span><div><strong>{{ adapter.type }}</strong><small class="mono">v{{ adapter.version }}</small></div><StatusBadge :status="adapter.status" /></article></div>
      </section>

      <section class="surface audit-surface">
        <div class="surface-header"><div><h2 class="surface-title">审计记录</h2><p class="surface-subtitle">操作内容已中文化展示，敏感凭据不会写入审计内容</p></div><FileClock :size="18" class="muted" aria-hidden="true" /></div>
        <form class="audit-filters" @submit.prevent="searchAuditLogs">
          <div class="search-field audit-search"><Search :size="16" aria-hidden="true" /><input v-model="auditSearch" class="input" type="search" placeholder="搜索操作、对象、ID 或请求 ID" aria-label="搜索审计记录" /></div>
          <div class="field"><label for="audit-result">结果</label><select id="audit-result" v-model="auditResult" class="select"><option value="all">全部结果</option><option value="success">成功</option><option value="failed">失败</option></select></div>
          <div class="field"><label for="audit-from">开始时间（北京时间）</label><input id="audit-from" v-model="auditFrom" class="input" type="datetime-local" /></div>
          <div class="field"><label for="audit-to">结束时间（北京时间）</label><input id="audit-to" v-model="auditTo" class="input" type="datetime-local" /></div>
          <div class="audit-filter-actions">
            <button class="btn btn-secondary" type="button" :disabled="auditLoading" @click="resetAuditFilters"><RotateCcw :size="15" aria-hidden="true" />重置</button>
            <button class="btn btn-primary" type="submit" :disabled="auditLoading"><Search :size="15" aria-hidden="true" />查询</button>
          </div>
        </form>
        <div v-if="auditLogs.length" class="audit-batch-bar">
          <label class="audit-select-page">
            <input
              type="checkbox"
              :checked="allAuditPageSelected"
              :indeterminate="someAuditPageSelected"
              :disabled="auditLoading || auditDeleteLoading || auditBatchDeleteLoading"
              @change="toggleCurrentAuditPage"
            />
            <span>全选当前页</span>
          </label>
          <span class="audit-selected-count">已选择 {{ selectedAuditCount }} 条</span>
          <button class="btn btn-danger" type="button" :disabled="selectedAuditCount === 0 || auditDeleteLoading || auditBatchDeleteLoading" @click="openAuditBatchDelete('selected')">
            <Trash2 :size="15" aria-hidden="true" />删除选中
          </button>
          <div class="audit-delete-by-time"><input v-model="auditDeleteBefore" class="input" type="datetime-local" aria-label="审计记录删除截止时间" /><button class="btn btn-danger" type="button" :disabled="!auditDeleteBefore || auditDeleteLoading || auditBatchDeleteLoading" @click="openAuditBatchDelete('time')">按时间删除</button></div>
          <button class="btn btn-danger" type="button" :disabled="auditTotal === 0 || auditDeleteLoading || auditBatchDeleteLoading" @click="openAuditBatchDelete('all')">全部删除</button>
        </div>
        <div v-if="auditLoading" class="loading-line" />
        <div v-if="auditLogs.length" class="table-wrap"><table class="data-table audit-table"><thead><tr><th class="audit-select-column"><span class="sr-only">选择</span></th><th>时间</th><th>操作</th><th>对象</th><th>结果</th><th>请求 ID</th><th><span class="sr-only">操作</span></th></tr></thead><tbody><tr v-for="entry in auditLogs" :key="entry.id" :class="{ 'audit-row-selected': selectedAuditIds.includes(entry.id) }"><td class="audit-select-column"><input v-model="selectedAuditIds" type="checkbox" :value="entry.id" :disabled="auditDeleteLoading || auditBatchDeleteLoading" :aria-label="`选择审计记录 ${auditActionLabel(entry.action)}`" /></td><td>{{ formatDateTime(entry.created_at) }}</td><td class="audit-action"><strong :title="entry.action">{{ auditActionLabel(entry.action) }}</strong></td><td class="audit-object"><strong :title="auditObjectDetail(entry) ?? undefined">{{ auditObjectLabel(entry) }}</strong></td><td><StatusBadge :status="entry.result" /></td><td><div class="request-id-cell"><code class="request-id-code">{{ entry.request_id }}</code><button class="copy-request" type="button" :title="copiedRequestId === entry.request_id ? '已复制' : '复制请求 ID'" :aria-label="copiedRequestId === entry.request_id ? `已复制 ${entry.request_id}` : `复制请求 ID ${entry.request_id}`" @click="copyRequestId(entry.request_id)"><Check v-if="copiedRequestId === entry.request_id" :size="13" aria-hidden="true" /><Copy v-else :size="13" aria-hidden="true" /></button></div></td><td><button class="icon-btn icon-btn-danger" type="button" :disabled="auditBatchDeleteLoading" :title="`删除 ${auditActionLabel(entry.action)}`" :aria-label="`删除审计记录 ${auditActionLabel(entry.action)}`" @click="openAuditDelete(entry)"><Trash2 :size="15" aria-hidden="true" /></button></td></tr></tbody></table></div>
        <p v-else-if="!auditLoading" class="audit-empty">当前条件下没有审计记录。</p>
        <PaginationControls :page="auditPage" :page-size="auditPageSize" :total="auditTotal" @update:page="updateAuditPage" @update:page-size="updateAuditPageSize" />
      </section>
    </div>

    <ConfirmDeleteDialog
      :open="auditDeleteTarget !== null"
      title="永久删除审计记录？"
      description="该审计记录会从数据库永久删除，不会额外生成一条删除审计。"
      :item-name="auditDeleteTarget ? `${auditActionLabel(auditDeleteTarget.action)} · ${formatDateTime(auditDeleteTarget.created_at)}` : ''"
      warning="删除无法撤销，但不会影响对应业务对象。"
      confirm-label="确认永久删除"
      loading-label="正在删除…"
      :loading="auditDeleteLoading"
      :error="auditDeleteError"
      @cancel="closeAuditDelete"
      @confirm="confirmAuditDelete"
    />
    <ConfirmDeleteDialog
      :open="auditBatchDeleteOpen"
      :title="auditBatchDeleteMode === 'all' ? '删除全部审计记录？' : auditBatchDeleteMode === 'time' ? '按时间删除审计记录？' : '删除选中的审计记录？'"
      description="符合条件的审计记录会从数据库永久删除，不会额外生成删除审计。"
      :item-name="auditBatchDeleteMode === 'all' ? `当前共 ${auditTotal} 条` : auditBatchDeleteMode === 'time' ? `截止 ${auditDeleteBefore}` : `已选择 ${selectedAuditCount} 条`"
      warning="删除无法撤销；全部删除完成后审计记录数量为 0。"
      confirm-label="确认永久删除"
      loading-label="正在删除…"
      :loading="auditBatchDeleteLoading"
      :error="auditBatchDeleteError"
      @cancel="closeAuditBatchDelete"
      @confirm="confirmAuditBatchDelete"
    />
  </div>
</template>

<style scoped>
.system-metrics { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.status-value { margin-top: 10px; font-size: 16px; }
.compact-value { font-size: 22px; }
.system-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 14px; }
.storage-usage { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.storage-usage > div { display: flex; align-items: center; gap: 9px; padding: 11px; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 5px; color: var(--text-secondary); }
.storage-usage strong,
.storage-usage small { display: block; }
.storage-usage strong { color: var(--text); font-size: 16px; }
.storage-usage small { color: var(--text-tertiary); font-size: 12px; }
.storage-details { margin-top: 9px; }
.inline-link { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); text-decoration: none; }
.lower-grid { grid-template-columns: minmax(0, 1fr); }
.adapter-list { display: grid; }
.adapter-list article { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 13px 15px; border-bottom: 1px solid var(--border); }
.adapter-list article:last-child { border-bottom: 0; }
.adapter-mark { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 5px; background: var(--accent-soft); color: var(--accent); font-weight: 750; }
.adapter-list strong,
.adapter-list small { display: block; }
.adapter-list strong { font-size: 14px; }
.adapter-list small { color: var(--text-tertiary); font-size: 12px; }
.audit-filters { display: grid; grid-template-columns: minmax(220px, 1.4fr) minmax(130px, 0.55fr) minmax(190px, 0.8fr) minmax(190px, 0.8fr) auto; align-items: end; gap: 10px; padding: 13px 15px; border-bottom: 1px solid var(--border); background: var(--surface-subtle); }
.audit-search { align-self: end; }
.audit-filter-actions { display: flex; gap: 7px; }
.audit-filter-actions .btn { min-height: 42px; padding: 7px 10px; }
.audit-batch-bar { display: flex; min-height: 52px; align-items: center; gap: 12px; padding: 8px 15px; border-bottom: 1px solid var(--border); background: var(--surface); }
.audit-select-page { display: inline-flex; align-items: center; gap: 7px; color: var(--text-secondary); font-size: 12px; font-weight: 650; cursor: pointer; }
.audit-select-page input,
.audit-select-column input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.audit-selected-count { color: var(--text-tertiary); font-size: 12px; }
.audit-batch-bar .btn { min-height: 34px; padding: 5px 9px; }
.audit-batch-bar > .btn:first-of-type { margin-left: auto; }
.audit-delete-by-time { display: flex; align-items: center; gap: 7px; }
.audit-delete-by-time .input { min-height: 34px; }
.audit-table { min-width: 980px; }
.audit-select-column { width: 44px; text-align: center; }
.audit-row-selected td { background: var(--accent-soft); }
.audit-empty { margin: 0; padding: 30px 16px; color: var(--text-tertiary); font-size: 13px; text-align: center; }
.audit-action strong,
.audit-action small,
.audit-object strong,
.audit-object small { display: block; }
.audit-action strong,
.audit-object strong { font-size: 12px; }
.audit-action small,
.audit-object small { max-width: 220px; margin-top: 2px; overflow: hidden; color: var(--text-tertiary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.request-id-cell { display: flex; align-items: center; gap: 5px; }
.request-id-code { color: var(--text-secondary); font-size: 10px; user-select: all; white-space: nowrap; }
.copy-request { display: grid; width: 26px; height: 26px; flex: 0 0 26px; place-items: center; padding: 0; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text-tertiary); cursor: pointer; }
.copy-request:hover { border-color: var(--accent); color: var(--accent); }

@media (max-width: 1180px) {
  .system-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .audit-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .audit-search { grid-column: span 2; }
  .audit-filter-actions { justify-content: flex-end; grid-column: span 2; }
}
@media (max-width: 760px) {
  .system-grid { grid-template-columns: minmax(0, 1fr); }
  .system-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .audit-filters { grid-template-columns: minmax(0, 1fr); }
  .audit-search,
  .audit-filter-actions { grid-column: span 1; }
  .audit-filter-actions .btn { flex: 1 1 0; }
}
@media (max-width: 430px) {
  .system-metrics { grid-template-columns: minmax(0, 1fr); }
  .storage-usage { grid-template-columns: minmax(0, 1fr); }
  .audit-batch-bar { align-items: stretch; flex-direction: column; }
  .audit-batch-bar .btn { width: 100%; margin-left: 0; }
  .audit-delete-by-time { flex-direction: column; }
  .audit-delete-by-time .input { width: 100%; }
}
</style>
