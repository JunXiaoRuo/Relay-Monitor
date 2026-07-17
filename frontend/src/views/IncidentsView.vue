<script setup lang="ts">
import {
  BellOff,
  CheckCircle2,
  ChevronDown,
  History,
  Link2,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from '@lucide/vue';
import { computed, onMounted, reactive, ref, watch } from 'vue';

import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import PaginationControls from '../components/PaginationControls.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { api } from '../services/api';
import { formatDateTime, formatRelativeTime } from '../services/format';
import { clampPage, fetchAllPages, slicePage } from '../services/pagination';
import { beijingDateTimeToIso } from '../services/query';
import {
  groupIncidentsByRoot,
  incidentDisplaySummary,
  incidentDisplayTitle,
  incidentEventTypeLabel,
  incidentMatchesLifecycleTab,
  incidentResourceDisplayLabel,
  incidentSuppressionReasonLabel,
  isOneTimeRateEvent,
} from '../services/presentation';
import { loadResource } from '../services/resource-loader';
import type { IncidentViewModel } from '../types/domain';

const incidents = ref<IncidentViewModel[]>([]);
const error = ref<string | null>(null);
const loading = ref(true);
const stateFilter = ref('active');
const severityFilter = ref('all');
const search = ref('');
const actionId = ref<string | null>(null);
const actionMessage = ref<string | null>(null);
const actionError = ref(false);
const silenceTarget = ref<IncidentViewModel | null>(null);
const silenceForm = reactive({ duration_hours: 6, reason: '' });
const deleteTarget = ref<IncidentViewModel | null>(null);
const deleteLoading = ref(false);
const deleteError = ref<string | null>(null);
const selectedIncidentIds = ref<string[]>([]);
const bulkDeleteMode = ref<'selected' | 'time' | 'all' | null>(null);
const bulkDeleteBefore = ref('');
const bulkDeleteLoading = ref(false);
const bulkDeleteError = ref<string | null>(null);
const expandedDependencyIds = ref<Set<string>>(new Set());
const page = ref(1);
const pageSize = ref(20);

const stateTabs = [
  { id: 'active', label: '活动中' },
  { id: 'rate_changes', label: '变化提醒' },
  { id: 'resolved', label: '已恢复' },
  { id: 'all', label: '全部' },
];

const filteredIncidents = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return incidents.value.filter((incident) => {
    const matchesState = incidentMatchesLifecycleTab(
      incident,
      stateFilter.value as 'active' | 'rate_changes' | 'resolved' | 'all',
    );
    const matchesSeverity = severityFilter.value === 'all' || incident.severity === severityFilter.value;
    const matchesSearch = !query || [
      incidentDisplayTitle(incident),
      incidentDisplaySummary(incident),
      incidentEventTypeLabel(incident.event_type),
      incident.site_name,
      incident.event_type,
      incident.resource_key,
      incidentResourceDisplayLabel(incident),
    ].join(' ').toLocaleLowerCase().includes(query);
    return matchesState && matchesSeverity && matchesSearch;
  }).sort((left, right) => right.updated_at.localeCompare(left.updated_at));
});
const filteredIncidentGroups = computed(() => groupIncidentsByRoot(filteredIncidents.value, incidents.value));
const paginatedIncidentGroups = computed(() => slicePage(filteredIncidentGroups.value, page.value, pageSize.value));
const pageIncidentIds = computed(() => paginatedIncidentGroups.value.map(({ incident }) => incident.id));
const allPageIncidentsSelected = computed(() => pageIncidentIds.value.length > 0
  && pageIncidentIds.value.every((id) => selectedIncidentIds.value.includes(id)));
const somePageIncidentsSelected = computed(() => !allPageIncidentsSelected.value
  && pageIncidentIds.value.some((id) => selectedIncidentIds.value.includes(id)));
const incidentsById = computed(() => new Map(incidents.value.map((incident) => [incident.id, incident])));

watch([stateFilter, severityFilter, search], () => {
  page.value = 1;
});
watch([() => filteredIncidentGroups.value.length, pageSize], () => {
  page.value = clampPage(page.value, filteredIncidentGroups.value.length, pageSize.value);
});

const counts = computed(() => ({
  active: incidents.value.filter((item) => !item.suppressed_by_incident_id
    && !isOneTimeRateEvent(item.event_type)
    && ['pending', 'firing', 'acknowledged', 'recovering'].includes(item.state)).length,
  rateChanges: incidents.value.filter((item) => !item.suppressed_by_incident_id
    && isOneTimeRateEvent(item.event_type)).length,
  resolved: incidents.value.filter((item) => !item.suppressed_by_incident_id
    && !isOneTimeRateEvent(item.event_type)
    && item.state === 'resolved').length,
  suppressed: incidents.value.filter((item) => item.suppressed_by_incident_id || item.suppressed_by).length,
}));

function toggleDependencies(incidentId: string): void {
  const next = new Set(expandedDependencyIds.value);
  if (next.has(incidentId)) next.delete(incidentId);
  else next.add(incidentId);
  expandedDependencyIds.value = next;
}

function rootCauseLabel(incident: IncidentViewModel): string {
  const rootId = incident.suppressed_by_incident_id;
  if (!rootId) return '关联的根因事件';
  const root = incidentsById.value.get(rootId);
  return root ? incidentDisplayTitle(root) : '关联的根因事件';
}

function dependencyIsActive(incident: IncidentViewModel): boolean {
  return !['normal', 'resolved'].includes(incident.state);
}

async function load(): Promise<void> {
  loading.value = true;
  const result = await loadResource(
    async () => fetchAllPages((requestedPage, requestedPageSize) => api.incidents.list(requestedPage, requestedPageSize)),
    [],
  );
  incidents.value = result.data;
  selectedIncidentIds.value = [];
  error.value = result.error;
  loading.value = false;
}

function toggleCurrentIncidentPage(event: Event): void {
  const pageIds = new Set(pageIncidentIds.value);
  selectedIncidentIds.value = (event.target as HTMLInputElement).checked
    ? [...new Set([...selectedIncidentIds.value, ...pageIds])]
    : selectedIncidentIds.value.filter((id) => !pageIds.has(id));
}

function openBulkDelete(mode: 'selected' | 'time' | 'all'): void {
  if (mode === 'selected' && selectedIncidentIds.value.length === 0) return;
  if (mode === 'time' && !bulkDeleteBefore.value) return;
  bulkDeleteMode.value = mode;
  bulkDeleteError.value = null;
}

function closeBulkDelete(): void {
  if (bulkDeleteLoading.value) return;
  bulkDeleteMode.value = null;
  bulkDeleteError.value = null;
}

async function confirmBulkDelete(): Promise<void> {
  const mode = bulkDeleteMode.value;
  if (!mode) return;
  bulkDeleteLoading.value = true;
  bulkDeleteError.value = null;
  try {
    let deletedCount: number;
    if (mode === 'selected') {
      deletedCount = (await api.incidents.deleteMany(selectedIncidentIds.value)).deleted_count;
    } else if (mode === 'time') {
      const before = beijingDateTimeToIso(bulkDeleteBefore.value);
      if (!before) throw new Error('请选择删除截止时间');
      deletedCount = (await api.incidents.deleteByTime(before)).deleted_count;
    } else {
      deletedCount = (await api.incidents.deleteAll()).deleted_count;
    }
    bulkDeleteMode.value = null;
    selectedIncidentIds.value = [];
    actionError.value = false;
    actionMessage.value = `已永久删除 ${deletedCount} 条事件及其关联通知历史。持续存在的故障会由后续监控重新生成事件。`;
    await load();
  } catch (caught) {
    bulkDeleteError.value = caught instanceof Error ? caught.message : '批量删除事件失败';
  } finally {
    bulkDeleteLoading.value = false;
  }
}

function openSilence(incident: IncidentViewModel): void {
  silenceTarget.value = incident;
  silenceForm.duration_hours = 6;
  silenceForm.reason = '';
}

async function createSilence(): Promise<void> {
  if (!silenceTarget.value || !silenceForm.reason.trim()) return;
  actionId.value = silenceTarget.value.id;
  actionMessage.value = null;
  actionError.value = false;
  const expiresAt = new Date(Date.now() + silenceForm.duration_hours * 3_600_000).toISOString();
  try {
    await api.incidents.silence(silenceTarget.value.id, {
      reason: silenceForm.reason.trim(),
      expires_at: expiresAt,
    });
    actionMessage.value = '已创建临时静默；事件时间线仍会保留。';
  } catch (caught) {
    actionError.value = true;
    actionMessage.value = caught instanceof Error ? caught.message : '创建静默失败';
  }
  actionId.value = null;
  silenceTarget.value = null;
}

function openDelete(incident: IncidentViewModel): void {
  deleteTarget.value = incident;
  deleteError.value = null;
}

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  const target = deleteTarget.value;
  deleteLoading.value = true;
  deleteError.value = null;
  actionMessage.value = null;
  actionError.value = false;
  try {
    await api.incidents.remove(target.id);
    const deletedIds = new Set([target.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const incident of incidents.value) {
        if (!incident.suppressed_by_incident_id || !deletedIds.has(incident.suppressed_by_incident_id) || deletedIds.has(incident.id)) continue;
        deletedIds.add(incident.id);
        changed = true;
      }
    }
    incidents.value = incidents.value.filter((incident) => !deletedIds.has(incident.id));
    actionMessage.value = '事件及关联通知历史已永久删除；监控仍会继续，同类异常可能再次生成新事件。';
    deleteTarget.value = null;
  } catch (caught) {
    deleteError.value = caught instanceof Error ? caught.message : '删除事件失败';
  } finally {
    deleteLoading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page incidents-page">
    <PageHeader title="事件中心" description="最终故障按生命周期持续更新；倍率新增、变化和移除作为一次性变化提醒单独记录。">
      <template #actions>
        <button class="btn btn-secondary" type="button" :disabled="loading" @click="load"><RefreshCw :size="16" aria-hidden="true" />刷新</button>
      </template>
    </PageHeader>

    <div v-if="error" class="notice notice-danger" role="alert">事件加载失败：{{ error }}</div>
    <div v-if="actionMessage" class="notice" :class="actionError ? 'notice-danger' : 'notice-success'" role="status">{{ actionMessage }}</div>

    <section class="incident-metrics" aria-label="事件统计">
      <article><span class="metric-icon danger"><TriangleAlert :size="17" aria-hidden="true" /></span><div><strong>{{ counts.active }}</strong><small>告警中</small></div></article>
      <article><span class="metric-icon info"><History :size="17" aria-hidden="true" /></span><div><strong>{{ counts.rateChanges }}</strong><small>变化提醒</small></div></article>
      <article><span class="metric-icon success"><CheckCircle2 :size="17" aria-hidden="true" /></span><div><strong>{{ counts.resolved }}</strong><small>已恢复</small></div></article>
      <article><span class="metric-icon neutral"><BellOff :size="17" aria-hidden="true" /></span><div><strong>{{ counts.suppressed }}</strong><small>受影响 / 抑制</small></div></article>
    </section>

    <section class="surface incident-surface">
      <div class="incident-toolbar">
        <div class="tabs" role="tablist" aria-label="事件状态">
          <button v-for="tab in stateTabs" :key="tab.id" class="tab-button" :class="{ active: stateFilter === tab.id }" type="button" @click="stateFilter = tab.id">{{ tab.label }}</button>
        </div>
        <div class="incident-filters">
          <div class="search-field"><Search :size="16" aria-hidden="true" /><input v-model="search" class="input" type="search" placeholder="搜索事件或站点" aria-label="搜索事件" /></div>
          <select v-model="severityFilter" class="select severity-select" aria-label="严重程度">
            <option value="all">全部级别</option><option value="critical">严重</option><option value="warning">警告</option><option value="info">信息</option>
          </select>
        </div>
      </div>
      <div class="incident-delete-bar">
        <label><input type="checkbox" :checked="allPageIncidentsSelected" :indeterminate="somePageIncidentsSelected" :disabled="bulkDeleteLoading" @change="toggleCurrentIncidentPage" />全选当前页</label>
        <span>已选择 {{ selectedIncidentIds.length }} 条</span>
        <button class="btn btn-danger" type="button" :disabled="selectedIncidentIds.length === 0 || bulkDeleteLoading" @click="openBulkDelete('selected')"><Trash2 :size="15" aria-hidden="true" />删除选中</button>
        <div class="delete-by-time"><input v-model="bulkDeleteBefore" class="input" type="datetime-local" aria-label="事件删除截止时间" /><button class="btn btn-danger" type="button" :disabled="!bulkDeleteBefore || bulkDeleteLoading" @click="openBulkDelete('time')">按时间删除</button></div>
        <button class="btn btn-danger delete-all" type="button" :disabled="incidents.length === 0 || bulkDeleteLoading" @click="openBulkDelete('all')">全部删除</button>
      </div>
      <div v-if="loading" class="loading-line" />

      <div v-if="filteredIncidentGroups.length" class="incident-list">
        <article v-for="{ incident, dependencies } in paginatedIncidentGroups" :key="incident.id" class="incident-item" :class="incident.severity">
          <input v-model="selectedIncidentIds" class="incident-select" type="checkbox" :value="incident.id" :disabled="bulkDeleteLoading" :aria-label="`选择事件 ${incidentDisplayTitle(incident)}`" />
          <div class="incident-marker"><span /><i /></div>
          <div class="incident-main">
            <header>
              <div>
                <div class="incident-badges"><StatusBadge :status="incident.severity" /><StatusBadge v-if="isOneTimeRateEvent(incident.event_type)" status="info" label="已记录" /><StatusBadge v-else :status="incident.state" /></div>
                <h2>{{ incidentDisplayTitle(incident) }}</h2>
                <p>{{ incidentDisplaySummary(incident) }}</p>
              </div>
              <time :title="formatDateTime(incident.updated_at)">{{ formatRelativeTime(incident.updated_at) }}</time>
            </header>
            <dl class="incident-details">
              <div><dt>站点</dt><dd>{{ incident.site_name }}</dd></div>
              <div><dt>事件类型</dt><dd class="incident-event-type"><span>{{ incidentEventTypeLabel(incident.event_type) }}</span><small class="mono">{{ incident.event_type }}</small></dd></div>
              <div><dt>资源</dt><dd class="incident-resource" :title="incident.resource_key"><span>{{ incidentResourceDisplayLabel(incident) }}</span></dd></div>
              <div><dt>出现 / 重复</dt><dd>{{ incident.occurrence_count }} / {{ incident.repeat_count }}</dd></div>
              <div><dt>开始时间</dt><dd>{{ formatDateTime(incident.started_at) }}</dd></div>
              <div><dt>最近一次</dt><dd>{{ formatDateTime(incident.last_observed_at ?? incident.updated_at) }}</dd></div>
            </dl>
            <div v-if="incident.suppressed_by_incident_id" class="suppression-note root-cause-note"><Link2 :size="14" aria-hidden="true" /><span><strong>{{ dependencyIsActive(incident) ? '受根因影响' : '曾受根因影响' }}</strong>{{ dependencyIsActive(incident) ? `由“${rootCauseLabel(incident)}”连带引起；事件记录保留，但不再重复发送告警。` : `该记录曾由“${rootCauseLabel(incident)}”连带引起，现已结束。` }}<small class="mono" :title="incident.suppressed_by_incident_id">根因事件 {{ incident.suppressed_by_incident_id }}</small></span></div>
            <div v-else-if="incident.suppressed_by" class="suppression-note"><BellOff :size="14" aria-hidden="true" /><span><strong>通知已抑制</strong>{{ incidentSuppressionReasonLabel(incident.suppression_reason ?? incident.suppressed_by) }}<small v-if="incident.suppression_reason" class="mono" :title="incident.suppression_reason">{{ incident.suppression_reason }}</small></span></div>
            <section v-if="dependencies.length" class="dependency-panel">
              <button class="dependency-toggle" type="button" :aria-expanded="expandedDependencyIds.has(incident.id)" @click="toggleDependencies(incident.id)">
                <Link2 :size="15" aria-hidden="true" />
                <span><strong>受影响监控 {{ dependencies.length }} 项</strong><small>已归并到此根因事件，不重复发送告警</small></span>
                <ChevronDown :size="16" aria-hidden="true" :class="{ expanded: expandedDependencyIds.has(incident.id) }" />
              </button>
              <div v-if="expandedDependencyIds.has(incident.id)" class="dependency-list">
                <article v-for="dependency in dependencies" :key="dependency.id" class="dependency-row">
                  <div class="dependency-cell dependency-resource" :title="dependency.resource_key"><small>受影响资源</small><strong>{{ incidentResourceDisplayLabel(dependency) }}</strong></div>
                  <div class="dependency-cell"><small>事件类型</small><strong>{{ incidentEventTypeLabel(dependency.event_type) }}</strong><code>{{ dependency.event_type }}</code></div>
                  <div class="dependency-cell"><small>状态</small><StatusBadge :status="dependency.state" /></div>
                  <div class="dependency-cell"><small>出现次数</small><strong>{{ dependency.occurrence_count }}</strong></div>
                  <div class="dependency-cell"><small>最近一次</small><strong>{{ formatDateTime(dependency.last_observed_at ?? dependency.updated_at) }}</strong></div>
                </article>
              </div>
            </section>
            <footer>
              <button v-if="incident.state !== 'resolved' && !isOneTimeRateEvent(incident.event_type)" class="btn btn-secondary" type="button" :disabled="actionId === incident.id" @click="openSilence(incident)"><BellOff :size="15" aria-hidden="true" />临时静默</button>
              <button class="icon-btn icon-btn-danger incident-delete" type="button" :disabled="deleteLoading && deleteTarget?.id === incident.id" :title="`删除 ${incidentDisplayTitle(incident)}`" :aria-label="`删除 ${incidentDisplayTitle(incident)}`" @click="openDelete(incident)"><Trash2 :size="15" aria-hidden="true" /></button>
            </footer>
          </div>
        </article>
      </div>

      <PaginationControls v-if="filteredIncidentGroups.length" v-model:page="page" v-model:page-size="pageSize" :total="filteredIncidentGroups.length" />

      <EmptyState v-else-if="!loading" title="当前筛选没有事件" description="监控重试耗尽后的终态故障会自动记录；告警规则决定匹配范围和通知渠道，未选渠道时只记录事件。" />
    </section>

    <div v-if="silenceTarget" class="modal-backdrop" @click.self="silenceTarget = null">
      <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="silence-title">
        <header><div><h2 id="silence-title">临时静默事件</h2><p>{{ incidentDisplayTitle(silenceTarget) }}</p></div><button class="icon-btn" type="button" title="关闭" aria-label="关闭" @click="silenceTarget = null"><X :size="17" aria-hidden="true" /></button></header>
        <div class="modal-body">
          <div class="notice"><ShieldCheck :size="17" aria-hidden="true" />静默期间继续采集和记录事件，只停止匹配通知。</div>
          <div class="field"><label for="silence-duration">持续时间</label><select id="silence-duration" v-model="silenceForm.duration_hours" class="select"><option :value="1">1 小时</option><option :value="6">6 小时</option><option :value="24">24 小时</option><option :value="72">3 天</option></select></div>
          <div class="field"><label for="silence-reason">原因</label><textarea id="silence-reason" v-model="silenceForm.reason" class="textarea" placeholder="说明静默原因，便于审计" /></div>
        </div>
        <footer><button class="btn btn-secondary" type="button" @click="silenceTarget = null">取消</button><button class="btn btn-primary" type="button" :disabled="!silenceForm.reason.trim()" @click="createSilence"><BellOff :size="15" aria-hidden="true" />创建静默</button></footer>
      </section>
    </div>

    <ConfirmDeleteDialog
      :open="deleteTarget !== null"
      title="删除事件？"
      description="该事件、受其影响的根因子事件，以及关联的通知投递历史都会永久删除。"
      :item-name="deleteTarget ? incidentDisplayTitle(deleteTarget) : ''"
      warning="删除无法撤销。监控仍会继续；如果异常持续或再次发生，启用的告警规则会重新生成事件。"
      confirm-label="永久删除事件"
      loading-label="正在删除…"
      :loading="deleteLoading"
      :error="deleteError"
      @cancel="deleteTarget = null"
      @confirm="confirmDelete"
    />
    <ConfirmDeleteDialog
      :open="bulkDeleteMode !== null"
      :title="bulkDeleteMode === 'all' ? '删除全部事件？' : bulkDeleteMode === 'time' ? '按时间删除事件？' : '删除选中的事件？'"
      description="符合条件的事件、受其影响的根因子事件及关联通知投递历史都会永久删除。"
      :item-name="bulkDeleteMode === 'all' ? `当前共 ${incidents.length} 条事件` : bulkDeleteMode === 'time' ? `截止 ${bulkDeleteBefore}` : `已选择 ${selectedIncidentIds.length} 条事件`"
      warning="删除无法撤销；仍持续的故障会在后续监控时重新生成事件。"
      confirm-label="确认永久删除"
      loading-label="正在删除…"
      :loading="bulkDeleteLoading"
      :error="bulkDeleteError"
      @cancel="closeBulkDelete"
      @confirm="confirmBulkDelete"
    />
  </div>
</template>

<style scoped>
.incident-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.incident-metrics article { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.incident-metrics strong,
.incident-metrics small { display: block; }
.incident-metrics strong { font-size: 21px; font-variant-numeric: tabular-nums; }
.incident-metrics small { color: var(--text-tertiary); font-size: 12px; }
.metric-icon { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 5px; }
.metric-icon.danger { background: var(--danger-soft); color: var(--danger); }
.metric-icon.success { background: var(--success-soft); color: var(--success); }
.metric-icon.warning { background: var(--warning-soft); color: var(--warning); }
.metric-icon.info { background: var(--blue-soft); color: var(--blue); }
.metric-icon.neutral { background: var(--surface-muted); color: var(--text-secondary); }
.incident-surface { overflow: hidden; }
.incident-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 0 13px; border-bottom: 1px solid var(--border); }
.incident-toolbar .tabs { border: 0; }
.incident-filters { display: flex; align-items: center; gap: 8px; }
.incident-filters .input,
.incident-filters .select { min-height: 34px; }
.severity-select { width: 122px; }
.incident-delete-bar { display: flex; align-items: center; gap: 9px; padding: 10px 13px; border-bottom: 1px solid var(--border); background: var(--surface-subtle); }
.incident-delete-bar > label { display: inline-flex; align-items: center; gap: 7px; }
.incident-delete-bar > span { color: var(--text-secondary); font-size: 13px; }
.delete-by-time { display: flex; align-items: center; gap: 7px; margin-left: auto; }
.delete-by-time .input { min-height: 36px; }
.incident-list { display: grid; }
.incident-item { position: relative; display: grid; grid-template-columns: 18px 24px minmax(0, 1fr); gap: 7px; padding: 17px 18px 17px 12px; border-bottom: 1px solid var(--border); }
.incident-select { margin-top: 5px; }
.incident-item:last-child { border-bottom: 0; }
.incident-marker { position: relative; display: flex; justify-content: center; }
.incident-marker span { position: relative; z-index: 1; width: 9px; height: 9px; margin-top: 8px; border: 2px solid #fff; border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 2px var(--blue); }
.incident-marker i { position: absolute; top: 18px; bottom: -25px; width: 1px; background: var(--border); }
.incident-item:last-child .incident-marker i { display: none; }
.incident-item.warning .incident-marker span { background: var(--warning); box-shadow: 0 0 0 2px var(--warning); }
.incident-item.critical .incident-marker span { background: var(--danger); box-shadow: 0 0 0 2px var(--danger); }
.incident-main { min-width: 0; }
.incident-main > header { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
.incident-main > header > div { min-width: 0; }
.incident-main > header time { flex: 0 0 auto; color: var(--text-tertiary); font-size: 12px; }
.incident-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 7px; }
.incident-main h2 { margin: 0; font-size: 16px; }
.incident-main h2 + p { margin: 4px 0 0; color: var(--text-secondary); font-size: 14px; }
.incident-details { display: grid; grid-template-columns: 1fr 1.2fr 1.2fr 0.8fr 1fr 1fr; gap: 15px; margin: 14px 0 0; padding-top: 11px; border-top: 1px solid #e9eeeb; }
.incident-details div { min-width: 0; }
.incident-details dt { color: var(--text-tertiary); font-size: 12px; }
.incident-details dd { margin: 2px 0 0; overflow: hidden; font-size: 12px; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
.incident-event-type span,
.incident-event-type small,
.incident-resource span,
.incident-resource small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.incident-event-type small,
.incident-resource small { margin-top: 1px; color: var(--text-tertiary); font-size: 10px; font-weight: 500; }
.suppression-note { display: flex; align-items: start; gap: 8px; margin-top: 12px; padding: 9px 10px; border-left: 3px solid #9aa8a3; background: var(--surface-subtle); color: var(--text-secondary); font-size: 12px; }
.suppression-note > span { min-width: 0; }
.suppression-note strong,
.suppression-note small { display: block; }
.suppression-note strong { color: var(--text); }
.suppression-note small { margin-top: 3px; overflow: hidden; color: var(--text-tertiary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.root-cause-note { border-left-color: var(--warning); background: var(--warning-soft); }
.dependency-panel { margin-top: 12px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.dependency-toggle { display: grid; grid-template-columns: 20px minmax(0, 1fr) 20px; align-items: center; gap: 7px; width: 100%; min-height: 48px; padding: 7px 10px; border: 0; background: var(--surface-subtle); color: var(--text); text-align: left; cursor: pointer; }
.dependency-toggle:hover { background: var(--surface-muted); }
.dependency-toggle span,
.dependency-toggle strong,
.dependency-toggle small { display: block; min-width: 0; }
.dependency-toggle strong { font-size: 12px; }
.dependency-toggle small { margin-top: 1px; color: var(--text-tertiary); font-size: 11px; }
.dependency-toggle > svg:last-child { transition: transform 160ms ease; }
.dependency-toggle > svg:last-child.expanded { transform: rotate(180deg); }
.dependency-list { border-top: 1px solid var(--border); }
.dependency-row { display: grid; grid-template-columns: minmax(150px, 1.3fr) minmax(150px, 1.2fr) minmax(90px, 0.55fr) minmax(80px, 0.5fr) minmax(140px, 0.9fr); gap: 10px; padding: 9px 10px; border-bottom: 1px solid var(--border); background: var(--surface); }
.dependency-row:last-child { border-bottom: 0; }
.dependency-cell { min-width: 0; }
.dependency-cell > small,
.dependency-cell > strong,
.dependency-cell > code { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dependency-cell > small { color: var(--text-tertiary); font-size: 10px; }
.dependency-cell > strong { margin-top: 1px; font-size: 11px; }
.dependency-cell > code { margin-top: 1px; color: var(--text-tertiary); font-size: 9px; }
.incident-main > footer { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.incident-main > footer .btn { min-height: 36px; padding: 6px 10px; font-size: 13px; }
.incident-delete { margin-left: auto; }
.modal-backdrop { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: 18px; background: rgb(12 18 16 / 46%); }
.modal-panel { width: min(500px, 100%); max-height: calc(100vh - 36px); overflow-y: auto; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); box-shadow: 0 18px 50px rgb(10 24 20 / 18%); }
.modal-panel > header { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 15px 17px; border-bottom: 1px solid var(--border); }
.modal-panel h2 { margin: 0; font-size: 17px; }
.modal-panel header p { margin: 2px 0 0; color: var(--text-tertiary); font-size: 13px; }
.modal-body { display: grid; gap: 15px; padding: 17px; }
.modal-panel > footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 17px; border-top: 1px solid var(--border); background: var(--surface-subtle); }

@media (max-width: 860px) {
  .incident-toolbar { align-items: stretch; flex-direction: column; padding: 0; }
  .incident-toolbar .tabs { padding: 0 10px; }
  .incident-filters { padding: 0 12px 12px; }
  .incident-filters .search-field { flex: 1; }
  .incident-delete-bar { flex-wrap: wrap; }
  .delete-by-time { width: 100%; margin-left: 0; }
  .delete-by-time .input { flex: 1; }
  .incident-details { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .incident-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .incident-filters { flex-direction: column; }
  .incident-filters .search-field,
  .delete-by-time,
  .delete-by-time .btn,
  .incident-delete-bar .delete-all,
  .severity-select { width: 100%; }
  .incident-item { padding-right: 13px; padding-left: 7px; }
  .incident-main > header { flex-direction: column; gap: 5px; }
  .incident-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dependency-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 380px) {
  .incident-metrics { grid-template-columns: minmax(0, 1fr); }
  .incident-details { grid-template-columns: minmax(0, 1fr); }
}
</style>
