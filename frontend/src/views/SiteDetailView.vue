<script setup lang="ts">
import {
  ArrowLeft,
  Clock3,
  ExternalLink,
  Gauge,
  KeyRound,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  WalletCards,
  Wifi,
} from '@lucide/vue';
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SiteEditDialog from '../components/SiteEditDialog.vue';
import StatusBadge from '../components/StatusBadge.vue';
import TokenLoginHelper from '../components/TokenLoginHelper.vue';
import ToggleSwitch from '../components/ToggleSwitch.vue';
import { api } from '../services/api';
import { formatDateTime, formatDurationSeconds, formatMoney, formatRelativeTime } from '../services/format';
import { loadResource } from '../services/resource-loader';
import type { SiteViewModel } from '../types/domain';
import type { MonitorConfigDto } from '../../../shared/types';

const route = useRoute();
const router = useRouter();
const site = ref<SiteViewModel | null>(null);
const monitors = ref<MonitorConfigDto[]>([]);
const error = ref<string | null>(null);
const loading = ref(true);
const activeTab = ref<'overview' | 'monitors' | 'credentials' | 'activity'>('overview');
const actionMessage = ref<string | null>(null);
const actionError = ref(false);
const activeAction = ref<string | null>(null);
const showDelete = ref(false);
const showEdit = ref(false);
const deleteLoading = ref(false);
const deleteError = ref<string | null>(null);
const runtimeRefreshTimers: number[] = [];
const credentialForm = reactive({
  mode: 'token' as 'token' | 'password',
  email: '',
  password: '',
  access_token: '',
  refresh_token: '',
  persist_password: false,
});

const monitorDefinitions = [
  { type: 'connectivity', label: '连通性监控', icon: Wifi, description: 'DNS、TCP/TLS、HTTP 鉴权链路与延迟' },
  { type: 'rates', label: '倍率监控', icon: Gauge, description: '完整快照、稳定键匹配与确认后的变化' },
  { type: 'balance', label: '余额监控', icon: WalletCards, description: '指定 balance_key 的余额与消耗' },
  { type: 'auth', label: '登录状态监控', icon: ShieldCheck, description: 'Token 有效期、刷新与交互验证状态' },
] as const;

function monitorRuntimeStatus(monitor: MonitorConfigDto): string {
  if (!monitor.enabled || monitor.runtime?.state === 'disabled') return 'disabled';
  if (monitor.runtime?.state === 'running') return 'refreshing';
  if (monitor.runtime?.state === 'retry') return 'retry';
  if (monitor.runtime?.last_error_code) return 'failed';
  if (monitor.runtime?.last_success_at) return 'success';
  return 'pending';
}

function monitorRuntimeLabel(monitor: MonitorConfigDto): string {
  if (!monitor.enabled || monitor.runtime?.state === 'disabled') return '已关闭';
  if (monitor.runtime?.state === 'running') return '执行中';
  if (monitor.runtime?.state === 'retry') return `等待第 ${monitor.runtime.attempts + 1} 次重试`;
  if (monitor.runtime?.last_error_code) return '失败';
  if (monitor.runtime?.last_success_at) return '成功';
  return '尚未执行';
}

function monitorRunTime(monitor: MonitorConfigDto): string | null | undefined {
  return monitor.runtime?.last_finished_at ?? monitor.runtime?.last_started_at;
}

function monitorDuration(monitor: MonitorConfigDto): string {
  const started = Date.parse(monitor.runtime?.last_started_at ?? '');
  const finished = Date.parse(monitor.runtime?.last_finished_at ?? '');
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return '—';
  return `${finished - started} ms`;
}

function monitorRunDescription(monitor: MonitorConfigDto): string {
  if (monitor.runtime?.last_error_message) return monitor.runtime.last_error_message;
  if (!monitor.enabled) return '监控已关闭，历史状态保留';
  if (monitor.runtime?.state === 'running') return '正在执行检查';
  if (monitor.runtime?.state === 'retry') return `首次失败后正在等待重试，下一次 ${formatRelativeTime(monitor.runtime.next_run_at)}`;
  if (monitor.runtime?.last_success_at) return '最近一次检查成功';
  return '等待首次检查';
}

async function load(): Promise<void> {
  loading.value = true;
  const result = await loadResource(
    () => api.sites.get(String(route.params.id)),
    null,
  );
  site.value = result.data;
  monitors.value = result.data?.monitor_configs?.map((item) => ({ ...item })) ?? [];
  error.value = result.error;
  loading.value = false;
}

async function refreshRuntime(): Promise<void> {
  try {
    const updated = await api.sites.get(String(route.params.id));
    site.value = updated;
    monitors.value = updated.monitor_configs?.map((item) => ({ ...item })) ?? [];
  } catch {
    // Keep the last visible state; explicit page refresh will surface API errors.
  }
}

function scheduleRuntimeRefresh(): void {
  while (runtimeRefreshTimers.length) window.clearTimeout(runtimeRefreshTimers.pop());
  for (const delay of [750, 2_500, 6_000]) {
    runtimeRefreshTimers.push(window.setTimeout(() => void refreshRuntime(), delay));
  }
}

function monitorFor(type: string): MonitorConfigDto {
  return monitors.value.find((monitor) => monitor.monitor_type === type) ?? {
    monitor_type: type as MonitorConfigDto['monitor_type'],
    enabled: false,
    interval_seconds: 300,
    timeout_seconds: 15,
    retry_count: 1,
    retry_interval_seconds: 60,
    schedule_jitter_percent: 10,
  };
}

async function runCheck(type: string): Promise<void> {
  if (!site.value) return;
  activeAction.value = `check-${type}`;
  actionMessage.value = null;
  actionError.value = false;
  try {
    await api.sites.check(site.value.id, type);
    const current = monitors.value.find((monitor) => monitor.monitor_type === type);
    if (current?.runtime) {
      current.runtime.state = 'queued';
      current.runtime.attempts = 0;
      current.runtime.next_run_at = new Date().toISOString();
    }
    actionMessage.value = '检查任务已提交，执行期间同类定时任务会自动合并。';
    scheduleRuntimeRefresh();
  } catch (caught) {
    actionError.value = true;
    actionMessage.value = caught instanceof Error ? caught.message : '检查提交失败';
  }
  activeAction.value = null;
}

async function setMonitorEnabled(type: string, enabled: boolean): Promise<void> {
  if (!site.value) return;
  const current = monitorFor(type);
  activeAction.value = `monitor-${type}`;
  actionMessage.value = null;
  actionError.value = false;
  const payload = { ...current, enabled };
  delete (payload as Partial<MonitorConfigDto>).monitor_type;
  try {
    await api.sites.updateMonitor(site.value.id, type, payload);
    const existing = monitors.value.find((monitor) => monitor.monitor_type === type);
    if (existing) {
      existing.enabled = enabled;
      if (existing.runtime) {
        existing.runtime.state = enabled ? 'queued' : 'disabled';
        existing.runtime.attempts = 0;
        existing.runtime.next_run_at = new Date().toISOString();
      }
    }
    actionMessage.value = enabled ? '监控已开启，将立即采集一次。' : '监控已关闭，历史数据仍会保留。';
    scheduleRuntimeRefresh();
  } catch (caught) {
    actionError.value = true;
    actionMessage.value = caught instanceof Error ? caught.message : '监控更新失败';
  }
  activeAction.value = null;
}

async function saveCredentials(): Promise<void> {
  if (!site.value) return;
  activeAction.value = 'credentials';
  actionMessage.value = null;
  actionError.value = false;
  const hasInput = Boolean(
    credentialForm.email.trim()
    || credentialForm.password
    || credentialForm.access_token
    || credentialForm.refresh_token,
  );
  if (!hasInput) {
    actionMessage.value = '未填写新凭据，现有凭据保持不变。';
    activeAction.value = null;
    return;
  }

  if (credentialForm.mode === 'password' && (!credentialForm.email.trim() || !credentialForm.password)) {
    actionError.value = true;
    actionMessage.value = '更新账号密码时，邮箱和新密码必须同时填写。';
    activeAction.value = null;
    return;
  }
  if (credentialForm.mode === 'token' && !credentialForm.access_token) {
    actionError.value = true;
    actionMessage.value = '更新 Token 时必须填写新的 Access Token。';
    activeAction.value = null;
    return;
  }
  const values: Record<string, string> = {};
  const persistKeys: string[] = [];
  if (credentialForm.mode === 'password') {
    values.email = credentialForm.email;
    values.password = credentialForm.password;
    persistKeys.push('email');
    if (credentialForm.persist_password) persistKeys.push('password');
  } else {
    values.access_token = credentialForm.access_token;
    persistKeys.push('access_token');
    if (credentialForm.refresh_token) {
      values.refresh_token = credentialForm.refresh_token;
      persistKeys.push('refresh_token');
    }
  }
  try {
    await api.sites.credentials(site.value.id, { mode: credentialForm.mode, values, persist_keys: persistKeys });
    actionMessage.value = '凭据已更新并加密保存；敏感值不会由 API 回传。';
    credentialForm.password = '';
    credentialForm.access_token = '';
    credentialForm.refresh_token = '';
    await load();
  } catch (caught) {
    actionError.value = true;
    actionMessage.value = caught instanceof Error ? caught.message : '凭据更新失败';
  } finally {
    activeAction.value = null;
  }
}

function applySiteEdit(updatedSite: SiteViewModel, updatedMonitors: MonitorConfigDto[]): void {
  site.value = updatedSite;
  monitors.value = updatedMonitors;
  showEdit.value = false;
  actionError.value = false;
  actionMessage.value = '站点资料、分组范围和监控参数已更新。';
}

function openDelete(): void {
  deleteError.value = null;
  showDelete.value = true;
}

function closeDelete(): void {
  if (!deleteLoading.value) showDelete.value = false;
}

async function confirmDelete(): Promise<void> {
  if (!site.value) return;
  deleteLoading.value = true;
  deleteError.value = null;

  try {
    await api.sites.remove(site.value.id);
    showDelete.value = false;
    await router.replace('/sites');
  } catch (caught) {
    deleteError.value = caught instanceof Error ? caught.message : '删除站点失败';
  } finally {
    deleteLoading.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => {
  while (runtimeRefreshTimers.length) window.clearTimeout(runtimeRefreshTimers.pop());
});
</script>

<template>
  <div class="page">
    <PageHeader :title="site?.name ?? '站点详情'" :description="site ? `${site.adapter_type} · ${site.base_url}` : '正在读取站点信息…'">
      <template #actions>
        <RouterLink class="btn btn-secondary" to="/sites"><ArrowLeft :size="16" aria-hidden="true" />返回</RouterLink>
        <button class="icon-btn" type="button" :disabled="!site || activeAction !== null" title="编辑站点" aria-label="编辑站点" @click="showEdit = true"><Pencil :size="16" aria-hidden="true" /></button>
        <a v-if="site" class="icon-btn" :href="site.base_url" target="_blank" rel="noopener noreferrer" title="打开站点地址" aria-label="打开站点地址">
          <ExternalLink :size="16" aria-hidden="true" />
        </a>
        <button class="icon-btn icon-btn-danger" type="button" :disabled="!site || activeAction !== null" :title="site ? `删除 ${site.name}` : '删除站点'" :aria-label="site ? `删除 ${site.name}` : '删除站点'" @click="openDelete">
          <Trash2 :size="16" aria-hidden="true" />
        </button>
        <button class="btn btn-primary" type="button" :disabled="!site || activeAction !== null" @click="runCheck('connectivity')">
          <Play :size="16" aria-hidden="true" />立即检查
        </button>
      </template>
    </PageHeader>

    <div v-if="error && !loading" class="notice notice-danger" role="alert">站点详情加载失败：{{ error }}</div>
    <div v-if="loading" class="loading-line" />
    <div v-if="actionMessage" class="notice" :class="actionError ? 'notice-danger' : 'notice-success'" role="status">{{ actionMessage }}</div>

    <template v-if="site">
      <section class="site-status-strip surface">
        <div class="site-identity">
          <span><Server :size="19" aria-hidden="true" /></span>
          <div><strong>{{ site.name }}</strong><small>更新于 {{ formatDateTime(site.updated_at) }}</small></div>
        </div>
        <div class="status-pair">
          <div><small>服务状态</small><StatusBadge :status="site.service_status" /></div>
          <div><small>登录状态</small><StatusBadge :status="site.auth_status" /></div>
        </div>
        <div class="site-tags tag-list"><span v-for="tag in site.tags" :key="tag" class="tag">{{ tag }}</span></div>
      </section>

      <nav class="tabs detail-tabs" aria-label="站点详情视图">
        <button v-for="tab in [
          { id: 'overview', label: '概览' },
          { id: 'monitors', label: '监控设置' },
          { id: 'credentials', label: '认证凭据' },
          { id: 'activity', label: '检查记录' },
        ]" :key="tab.id" class="tab-button" :class="{ active: activeTab === tab.id }" type="button" @click="activeTab = tab.id as typeof activeTab">
          {{ tab.label }}
        </button>
      </nav>

      <div v-if="activeTab === 'overview'" class="tab-content">
        <section class="metrics-grid site-metrics">
          <article class="metric-card"><div class="metric-label"><WalletCards :size="15" aria-hidden="true" />当前余额</div><div class="metric-value money-value">{{ site.balance ? formatMoney(site.balance.value, site.balance.currency) : '—' }}</div><div class="metric-detail">{{ site.balance ? `${formatRelativeTime(site.balance.collected_at)}更新` : '未采集' }}</div></article>
          <article class="metric-card"><div class="metric-label"><Gauge :size="15" aria-hidden="true" />API 延迟</div><div class="metric-value">{{ site.latency_ms ? `${site.latency_ms} ms` : '—' }}</div><div class="metric-detail">最近一次连通性检查</div></article>
          <article class="metric-card"><div class="metric-label"><Wifi :size="15" aria-hidden="true" />24h 可用率</div><div class="metric-value">{{ site.uptime_24h ? `${site.uptime_24h}%` : '—' }}</div><div class="metric-detail">服务探测结果</div></article>
          <article class="metric-card"><div class="metric-label"><Gauge :size="15" aria-hidden="true" />已监控分组</div><div class="metric-value">{{ site.rate_count ?? 0 }}</div><div class="metric-detail">当前纳入倍率监控的分组数</div></article>
          <article class="metric-card"><div class="metric-label"><Clock3 :size="15" aria-hidden="true" />下次检查</div><div class="metric-value next-check">{{ formatRelativeTime(site.next_check_at) }}</div><div class="metric-detail">调度含 ±10% 抖动</div></article>
        </section>

        <div class="content-grid overview-grid">
          <section class="surface">
            <div class="surface-header"><h2 class="surface-title">站点信息</h2></div>
            <div class="surface-body">
              <dl class="detail-list">
                <div class="detail-row"><dt>适配器</dt><dd>{{ site.adapter_type }}</dd></div>
                <div class="detail-row"><dt>Base URL</dt><dd class="mono">{{ site.base_url }}</dd></div>
                <div class="detail-row"><dt>倍率范围</dt><dd>{{ site.rate_group_scope?.mode === 'selected' ? `指定 ${site.rate_group_scope.group_ids.length} 个分组` : '全部分组' }}</dd></div>
                <div class="detail-row"><dt>最近成功</dt><dd>{{ formatDateTime(site.last_success_at) }}</dd></div>
                <div class="detail-row"><dt>最近错误</dt><dd :class="site.last_error ? 'text-danger' : 'muted'">{{ site.last_error ?? '最近无错误' }}</dd></div>
                <div class="detail-row"><dt>创建时间</dt><dd>{{ formatDateTime(site.created_at) }}</dd></div>
              </dl>
            </div>
          </section>
          <section class="surface">
            <div class="surface-header"><h2 class="surface-title">凭据状态</h2><KeyRound :size="17" class="muted" aria-hidden="true" /></div>
            <div class="surface-body">
              <dl class="detail-list">
                <div class="detail-row"><dt>安全模式</dt><dd>{{ site.credential_status?.mode ?? '未配置' }}</dd></div>
                <div class="detail-row"><dt>已保存字段</dt><dd><div class="tag-list"><span v-for="key in site.credential_status?.present_keys ?? []" :key="key" class="tag mono">{{ key }}</span></div></dd></div>
                <div class="detail-row"><dt>Access Token 到期</dt><dd>{{ formatDateTime(site.credential_status?.access_expires_at) }}</dd></div>
              </dl>
            </div>
          </section>
        </div>
      </div>

      <section v-else-if="activeTab === 'monitors'" class="surface tab-content">
        <div class="surface-header"><div><h2 class="surface-title">独立监控任务</h2><p class="surface-subtitle">关闭一类任务不会影响其他任务，历史数据始终保留。</p></div></div>
        <div class="monitor-config-list">
          <article v-for="definition in monitorDefinitions" :key="definition.type" class="monitor-config-row">
            <span class="monitor-icon"><component :is="definition.icon" :size="18" aria-hidden="true" /></span>
            <div class="monitor-copy"><strong>{{ definition.label }}</strong><span>{{ definition.description }}</span></div>
            <ToggleSwitch :model-value="monitorFor(definition.type).enabled" :disabled="activeAction === `monitor-${definition.type}`" :label="monitorFor(definition.type).enabled ? `关闭${definition.label}` : `开启${definition.label}`" @update:model-value="setMonitorEnabled(definition.type, $event)" />
            <div class="monitor-interval"><small>检查间隔</small><strong>{{ formatDurationSeconds(monitorFor(definition.type).interval_seconds) }}</strong></div>
            <div class="monitor-interval monitor-timeout"><small>单次超时</small><strong>{{ monitorFor(definition.type).timeout_seconds }} 秒</strong></div>
            <div class="monitor-interval monitor-retry"><small>失败重试</small><strong>{{ monitorFor(definition.type).retry_count ? `${monitorFor(definition.type).retry_count} 次 · ${formatDurationSeconds(monitorFor(definition.type).retry_interval_seconds)}` : '0 次（关闭）' }}</strong></div>
            <button class="icon-btn" type="button" :disabled="!monitorFor(definition.type).enabled || activeAction !== null" :title="`立即执行${definition.label}`" :aria-label="`立即执行${definition.label}`" @click="runCheck(definition.type)"><RefreshCw :size="16" aria-hidden="true" /></button>
          </article>
        </div>
      </section>

      <section v-else-if="activeTab === 'credentials'" class="surface tab-content credentials-panel">
        <div class="surface-header"><div><h2 class="surface-title">更新认证凭据</h2><p class="surface-subtitle">已有敏感值不会回填；全部留空并保存表示不修改现有凭据。</p></div></div>
        <div class="surface-body credentials-body">
          <div class="credential-mode-row">
            <label><input v-model="credentialForm.mode" type="radio" value="token" />Token 优先</label>
            <label><input v-model="credentialForm.mode" type="radio" value="password" />账号密码</label>
          </div>
          <div class="form-grid">
            <template v-if="credentialForm.mode === 'token'">
              <TokenLoginHelper class="span-2" :base-url="site.base_url" />
              <div class="field span-2"><label for="detail-access-token">新 Access Token</label><input id="detail-access-token" v-model="credentialForm.access_token" class="input mono" type="password" autocomplete="off" /></div>
              <div class="field span-2"><label for="detail-refresh-token">新 Refresh Token（可选）</label><input id="detail-refresh-token" v-model="credentialForm.refresh_token" class="input mono" type="password" autocomplete="off" /></div>
            </template>
            <template v-else>
              <div class="field"><label for="detail-email">登录邮箱</label><input id="detail-email" v-model="credentialForm.email" class="input" type="email" autocomplete="off" /></div>
              <div class="field"><label for="detail-password">新密码</label><input id="detail-password" v-model="credentialForm.password" class="input" type="password" autocomplete="new-password" /></div>
              <div class="field span-2"><ToggleSwitch v-model="credentialForm.persist_password" label="加密保存密码并允许自动重新登录" /></div>
            </template>
          </div>
          <div class="notice"><ShieldCheck :size="17" aria-hidden="true" />服务端仅返回凭据存在状态；分组实测 Key 在倍率页单独绑定。</div>
          <div class="button-row credentials-actions"><button class="btn btn-primary" type="button" :disabled="activeAction === 'credentials'" @click="saveCredentials"><Save :size="16" aria-hidden="true" />{{ activeAction === 'credentials' ? '正在保存…' : '安全更新凭据' }}</button></div>
        </div>
      </section>

      <section v-else class="surface tab-content">
        <div class="surface-header"><div><h2 class="surface-title">独立任务最近状态</h2><p class="surface-subtitle">每类任务分别显示真实运行状态；这里不是逐次历史流水。</p></div></div>
        <div class="table-wrap">
          <table class="data-table activity-table">
            <thead><tr><th>时间</th><th>检查类型</th><th>结果</th><th>耗时</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="definition in monitorDefinitions" :key="definition.type">
                <td>{{ formatDateTime(monitorRunTime(monitorFor(definition.type))) }}</td>
                <td>{{ definition.label.replace('监控', '') }}</td>
                <td><StatusBadge :status="monitorRuntimeStatus(monitorFor(definition.type))" :label="monitorRuntimeLabel(monitorFor(definition.type))" /></td>
                <td class="numeric">{{ monitorDuration(monitorFor(definition.type)) }}</td>
                <td :class="monitorFor(definition.type).runtime?.last_error_message ? 'text-danger' : ''">
                  {{ monitorRunDescription(monitorFor(definition.type)) }}
                  <small v-if="monitorFor(definition.type).runtime?.last_error_code" class="runtime-error-code mono">{{ monitorFor(definition.type).runtime?.last_error_code }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <SiteEditDialog
      :open="showEdit"
      :site="site"
      :monitors="monitors"
      @close="showEdit = false"
      @saved="applySiteEdit"
    />

    <ConfirmDeleteDialog
      :open="showDelete"
      title="删除中转站？"
      description="该站点的采集任务将停止，已保存凭据和关联配置也会被移除。"
      :item-name="site?.name ?? ''"
      :loading="deleteLoading"
      :error="deleteError"
      @cancel="closeDelete"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.site-status-strip {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) auto auto;
  align-items: center;
  gap: 20px;
  padding: 13px 15px;
}

.site-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.site-identity > span {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  place-items: center;
  border-radius: 5px;
  background: var(--accent-soft);
  color: var(--accent);
}

.site-identity strong,
.site-identity small { display: block; }
.site-identity strong { font-size: 15px; }
.site-identity small { margin-top: 1px; color: var(--text-tertiary); font-size: 12px; }

.status-pair {
  display: flex;
  gap: 14px;
}

.status-pair > div { display: grid; gap: 4px; }
.status-pair small { color: var(--text-tertiary); font-size: 12px; }
.detail-tabs { margin-top: 15px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px 6px 0 0; }
.tab-content { margin-top: 14px; }
.site-metrics { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.money-value { font-size: 25px; }
.next-check { font-size: 21px; }
.overview-grid { margin-top: 14px; }

.monitor-config-list { display: grid; }
.monitor-config-row {
  display: grid;
  grid-template-columns: auto minmax(190px, 1fr) auto 100px 82px 135px auto;
  align-items: center;
  gap: 15px;
  min-height: 76px;
  padding: 11px 15px;
  border-bottom: 1px solid var(--border);
}
.monitor-config-row:last-child { border-bottom: 0; }
.monitor-icon { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 5px; background: var(--surface-muted); color: var(--text-secondary); }
.monitor-copy strong,
.monitor-copy span { display: block; }
.monitor-copy strong { font-size: 14px; }
.monitor-copy span { margin-top: 2px; color: var(--text-tertiary); font-size: 12px; }
.monitor-interval { min-width: 0; }
.monitor-interval small,
.monitor-interval strong { display: block; }
.monitor-interval small { color: var(--text-tertiary); font-size: 12px; }
.monitor-interval strong { margin-top: 2px; font-size: 13px; }

.credentials-body { max-width: 780px; }
.credential-mode-row { display: flex; gap: 18px; margin-bottom: 18px; }
.credential-mode-row label { display: flex; align-items: center; gap: 6px; font-weight: 620; }
.credential-mode-row input { accent-color: var(--accent); }
.credentials-body .notice { margin-top: 18px; }
.credentials-actions { margin-top: 16px; }
.activity-table { min-width: 720px; }
.runtime-error-code { display: block; margin-top: 3px; color: var(--text-tertiary); font-size: 11px; }

@media (max-width: 1180px) {
  .site-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .monitor-config-row { grid-template-columns: auto minmax(160px, 1fr) auto 95px 125px auto; }
  .monitor-config-row .monitor-timeout { display: none; }
}

@media (max-width: 760px) {
  .site-status-strip { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .status-pair { justify-content: start; }
  .site-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .monitor-config-row { grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; }
  .monitor-config-row .monitor-interval { grid-column: 2; }
  .monitor-config-row > .icon-btn { grid-column: 3; grid-row: 2; }
}

@media (max-width: 430px) {
  .site-metrics { grid-template-columns: minmax(0, 1fr); }
  .site-status-strip { padding: 12px; }
  .status-pair { flex-wrap: wrap; }
  .monitor-config-row { padding: 12px; }
}
</style>
