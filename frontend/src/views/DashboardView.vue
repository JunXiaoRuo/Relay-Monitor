<script setup lang="ts">
import { BarChart, PieChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
import { init, type EChartsType, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import {
  Activity,
  ArrowRight,
  BellRing,
  CircleDollarSign,
  Clock3,
  Gauge,
  RadioTower,
  RefreshCw,
  Save,
  ShieldAlert,
  TriangleAlert,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import PageHeader from '../components/PageHeader.vue';
import StatusBadge from '../components/StatusBadge.vue';
import ToggleSwitch from '../components/ToggleSwitch.vue';
import { api, pageItems } from '../services/api';
import { compareDecimal, formatDateTime, formatRelativeTime } from '../services/format';
import { incidentDisplaySummary, incidentDisplayTitle } from '../services/presentation';
import { loadResource } from '../services/resource-loader';
import type {
  BalanceAlertSettings,
  IncidentViewModel,
  RateViewModel,
  SiteViewModel,
} from '../types/domain';

use([BarChart, PieChart, GridComponent, CanvasRenderer]);

const loading = ref(true);
const error = ref<string | null>(null);
const sites = ref<SiteViewModel[]>([]);
const rates = ref<RateViewModel[]>([]);
const incidents = ref<IncidentViewModel[]>([]);
const balanceAlertSettings = ref<BalanceAlertSettings>({ enabled: true, threshold: '10', updated_at: null });
const balanceThreshold = ref('10');
const balanceAlertEnabled = ref(true);
const balanceSettingsSaving = ref(false);
const balanceSettingsMessage = ref<string | null>(null);
const balanceSettingsError = ref(false);
const statusChartElement = ref<HTMLDivElement | null>(null);
const latencyChartElement = ref<HTMLDivElement | null>(null);
let statusChart: EChartsType | null = null;
let latencyChart: EChartsType | null = null;
let resizeObserver: ResizeObserver | null = null;

const activeIncidents = computed(() => incidents.value.filter((item) => !['resolved', 'normal'].includes(item.state)));
const lowBalanceIncidents = computed(() => activeIncidents.value.filter((item) => ['balance.low', 'balance.threshold'].includes(item.event_type)));
const metrics = computed(() => [
  { label: '站点总数', value: String(sites.value.length), detail: `${sites.value.filter((site) => site.service_status === 'healthy').length} 个运行正常`, icon: RadioTower },
  { label: '宕机 / 降级', value: `${sites.value.filter((site) => site.service_status === 'down').length} / ${sites.value.filter((site) => site.service_status === 'degraded').length}`, detail: '服务状态独立判定', icon: TriangleAlert },
  { label: '认证待处理', value: String(sites.value.filter((site) => !['authenticated', 'refreshing'].includes(site.auth_status)).length), detail: '不计入站点宕机', icon: ShieldAlert },
  {
    label: '低余额',
    value: String(lowBalanceIncidents.value.length),
    detail: balanceAlertSettings.value.enabled
      ? `全局阈值低于 ${balanceAlertSettings.value.threshold}`
      : '全局低余额监控已关闭',
    icon: CircleDollarSign,
  },
  { label: '活动事件', value: String(activeIncidents.value.length), detail: `${activeIncidents.value.filter((item) => item.severity === 'critical').length} 个严重事件`, icon: BellRing },
]);

const recentRateChanges = computed(() => rates.value
  .filter((item) => item.previous_value !== null && item.previous_value !== undefined)
  .sort((left, right) => (right.last_changed_at ?? '').localeCompare(left.last_changed_at ?? ''))
  .slice(0, 5));

async function load(): Promise<void> {
  loading.value = true;
  const result = await loadResource(
    async () => {
      const [sitePage, ratePage, incidentPage, settings] = await Promise.all([
        api.sites.list(),
        api.rates.list(),
        api.incidents.list(),
        api.settings.balanceAlert(),
      ]);
      return {
        sites: pageItems(sitePage),
        rates: pageItems(ratePage),
        incidents: pageItems(incidentPage),
        settings,
      };
    },
    {
      sites: [],
      rates: [],
      incidents: [],
      settings: { enabled: true, threshold: '10', updated_at: null },
    },
  );
  sites.value = result.data.sites;
  rates.value = result.data.rates;
  incidents.value = result.data.incidents;
  balanceAlertSettings.value = result.data.settings;
  balanceThreshold.value = result.data.settings.threshold;
  balanceAlertEnabled.value = result.data.settings.enabled;
  error.value = result.error;
  loading.value = false;
  await nextTick();
  renderCharts();
}

async function saveBalanceAlertSettings(): Promise<void> {
  const threshold = balanceThreshold.value.trim();
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(threshold)) {
    balanceSettingsMessage.value = '请输入有效的余额阈值。';
    balanceSettingsError.value = true;
    return;
  }
  balanceSettingsSaving.value = true;
  balanceSettingsMessage.value = null;
  balanceSettingsError.value = false;
  try {
    const saved = await api.settings.updateBalanceAlert({ enabled: balanceAlertEnabled.value, threshold });
    balanceAlertSettings.value = saved;
    balanceThreshold.value = saved.threshold;
    balanceAlertEnabled.value = saved.enabled;
    balanceSettingsMessage.value = saved.enabled
      ? `全局低余额阈值已保存${saved.queued_checks ? `，已安排 ${saved.queued_checks} 个站点立即检查` : ''}。`
      : '全局低余额监控已关闭，现有低余额事件将在检查后自动结束。';
  } catch (caught) {
    balanceSettingsError.value = true;
    balanceSettingsMessage.value = caught instanceof Error ? caught.message : '低余额设置保存失败';
  } finally {
    balanceSettingsSaving.value = false;
  }
}

function renderCharts(): void {
  if (statusChartElement.value) {
    statusChart ??= init(statusChartElement.value);
    const counts = ['healthy', 'degraded', 'down', 'unknown'].map((status) => sites.value.filter((site) => site.service_status === status).length);
    statusChart.setOption({
      animationDuration: 300,
      series: [{
        type: 'pie',
        radius: ['52%', '76%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false },
        itemStyle: { borderColor: '#fff', borderWidth: 3 },
        data: [
          { value: counts[0], name: '正常', itemStyle: { color: '#237453' } },
          { value: counts[1], name: '降级', itemStyle: { color: '#b77817' } },
          { value: counts[2], name: '宕机', itemStyle: { color: '#aa3c38' } },
          { value: counts[3], name: '未知', itemStyle: { color: '#a3aeaa' } },
        ],
      }],
    });
  }

  if (latencyChartElement.value) {
    latencyChart ??= init(latencyChartElement.value);
    const measuredSites = sites.value.filter((site) => (site.latency_ms ?? 0) > 0);
    latencyChart.setOption({
      animationDuration: 300,
      grid: { top: 18, right: 16, bottom: 40, left: 48 },
      xAxis: {
        type: 'category',
        data: measuredSites.map((site) => site.name),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#dce3e0' } },
        axisLabel: { color: '#74817d', fontSize: 12, width: 104, overflow: 'truncate' },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#74817d', fontSize: 12, formatter: '{value} ms' },
        splitLine: { lineStyle: { color: '#edf1ef' } },
      },
      series: [{
        type: 'bar',
        barMaxWidth: 34,
        data: measuredSites.map((site) => ({
          value: site.latency_ms,
          itemStyle: { color: (site.latency_ms ?? 0) > 1000 ? '#b77817' : '#3d806f', borderRadius: [3, 3, 0, 0] },
        })),
      }],
    });
  }
}

function rateDirection(rate: RateViewModel): 'up' | 'down' | 'same' {
  if (!rate.previous_value) return 'same';
  try {
    const comparison = compareDecimal(rate.value, rate.previous_value);
    return comparison > 0 ? 'up' : comparison < 0 ? 'down' : 'same';
  } catch {
    return 'same';
  }
}

onMounted(async () => {
  await load();
  resizeObserver = new ResizeObserver(() => {
    statusChart?.resize();
    latencyChart?.resize();
  });
  if (statusChartElement.value) resizeObserver.observe(statusChartElement.value);
  if (latencyChartElement.value) resizeObserver.observe(latencyChartElement.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  statusChart?.dispose();
  latencyChart?.dispose();
});
</script>

<template>
  <div class="page">
    <PageHeader title="运行概览" description="站点健康、认证、余额与事件的当前视图。">
      <template #actions>
        <button class="btn btn-secondary" type="button" :disabled="loading" @click="load">
          <RefreshCw :size="16" aria-hidden="true" />
          刷新
        </button>
        <RouterLink class="btn btn-primary" to="/sites/new">
          <RadioTower :size="16" aria-hidden="true" />
          添加站点
        </RouterLink>
      </template>
    </PageHeader>

    <div v-if="error" class="notice notice-danger" role="alert">数据加载失败：{{ error }}</div>
    <div v-if="loading" class="loading-line" />

    <section class="metrics-grid" aria-label="关键指标">
      <article v-for="metric in metrics" :key="metric.label" class="metric-card">
        <div class="metric-label"><component :is="metric.icon" :size="15" aria-hidden="true" />{{ metric.label }}</div>
        <div class="metric-value">{{ metric.value }}</div>
        <div class="metric-detail">{{ metric.detail }}</div>
      </article>
    </section>

    <section class="balance-settings-bar" aria-labelledby="balance-alert-settings-title">
      <div class="balance-settings-copy">
        <CircleDollarSign :size="19" aria-hidden="true" />
        <div>
          <h2 id="balance-alert-settings-title">全局低余额监控</h2>
          <p>所有中转站使用同一个数值阈值，按各站点自身余额单位比较，不进行汇率换算。</p>
        </div>
      </div>
      <div class="balance-settings-controls">
        <ToggleSwitch v-model="balanceAlertEnabled" :label="balanceAlertEnabled ? '关闭低余额监控' : '开启低余额监控'" />
        <label for="global-balance-threshold"><span>低于此值时告警</span><input id="global-balance-threshold" v-model="balanceThreshold" class="input mono" inputmode="decimal" :disabled="!balanceAlertEnabled || balanceSettingsSaving" /></label>
        <button class="btn btn-primary" type="button" :disabled="balanceSettingsSaving" @click="saveBalanceAlertSettings"><Save :size="15" aria-hidden="true" />{{ balanceSettingsSaving ? '保存中…' : '保存设置' }}</button>
      </div>
      <p v-if="balanceSettingsMessage" class="balance-settings-message" :class="{ error: balanceSettingsError }" role="status">{{ balanceSettingsMessage }}</p>
    </section>

    <div class="dashboard-charts">
      <section class="surface">
        <div class="surface-header">
          <div>
            <h2 class="surface-title">当前服务状态</h2>
            <p class="surface-subtitle">认证异常不会被计为宕机</p>
          </div>
          <Activity :size="18" class="muted" aria-hidden="true" />
        </div>
        <div ref="statusChartElement" class="chart chart-status" aria-label="服务状态分布图" />
        <div class="status-legend" aria-label="图例">
          <span><i class="healthy" />正常</span><span><i class="degraded" />降级</span><span><i class="down" />宕机</span><span><i class="unknown" />未知</span>
        </div>
      </section>

      <section class="surface chart-wide">
        <div class="surface-header">
          <div>
            <h2 class="surface-title">站点 API 延迟</h2>
            <p class="surface-subtitle">最近一次有效连通性检查</p>
          </div>
          <Gauge :size="18" class="muted" aria-hidden="true" />
        </div>
        <div ref="latencyChartElement" class="chart" aria-label="站点 API 延迟柱状图" />
      </section>
    </div>

    <div class="dashboard-lists content-grid">
      <section class="surface">
        <div class="surface-header">
          <div>
            <h2 class="surface-title">需要关注的事件</h2>
            <p class="surface-subtitle">按严重程度与最近更新时间排序</p>
          </div>
          <RouterLink class="btn btn-quiet" to="/incidents">查看全部 <ArrowRight :size="14" aria-hidden="true" /></RouterLink>
        </div>
        <div class="incident-list">
          <article v-for="incident in activeIncidents.slice(0, 5)" :key="incident.id" class="incident-row">
            <span class="incident-severity" :class="incident.severity" />
            <div class="incident-copy">
              <strong>{{ incidentDisplayTitle(incident) }}</strong>
              <span>{{ incidentDisplaySummary(incident) }}</span>
            </div>
            <div class="incident-meta">
              <StatusBadge :status="incident.state" />
              <time
                :datetime="incident.last_observed_at ?? incident.updated_at"
                :title="formatRelativeTime(incident.last_observed_at ?? incident.updated_at)"
              >{{ formatDateTime(incident.last_observed_at ?? incident.updated_at) }}</time>
            </div>
          </article>
        </div>
      </section>

      <section class="surface">
        <div class="surface-header">
          <div>
            <h2 class="surface-title">最近倍率变化</h2>
            <p class="surface-subtitle">仅展示已生效变化</p>
          </div>
          <RouterLink class="btn btn-quiet" to="/rates">倍率页 <ArrowRight :size="14" aria-hidden="true" /></RouterLink>
        </div>
        <div class="rate-change-list">
          <article v-for="rate in recentRateChanges" :key="rate.id" class="rate-change-row">
            <span class="rate-direction" :class="rateDirection(rate)">
              <TriangleAlert :size="14" aria-hidden="true" />
            </span>
            <div>
              <strong>{{ rate.name }}</strong>
              <span>{{ sites.find((site) => site.id === rate.site_id)?.name ?? rate.site_id }}</span>
            </div>
            <div class="rate-change-meta">
              <div class="rate-values mono">
                <span>{{ rate.previous_value }}</span>
                <ArrowRight :size="12" aria-hidden="true" />
                <strong>{{ rate.value }}</strong>
              </div>
              <time
                :datetime="rate.last_changed_at ?? undefined"
                :title="formatRelativeTime(rate.last_changed_at)"
              >{{ formatDateTime(rate.last_changed_at) }}</time>
            </div>
          </article>
        </div>
      </section>
    </div>

    <p class="dashboard-footnote">
      <Clock3 :size="13" aria-hidden="true" />
      数据更新时间 {{ formatDateTime(new Date().toISOString()) }}
    </p>
  </div>
</template>

<style scoped>
.balance-settings-bar {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) auto;
  align-items: center;
  gap: 12px 24px;
  margin-top: 14px;
  padding: 13px 15px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
}

.balance-settings-copy,
.balance-settings-controls,
.balance-settings-controls label {
  display: flex;
  align-items: center;
}

.balance-settings-copy { min-width: 0; gap: 10px; color: var(--accent); }
.balance-settings-copy div { min-width: 0; }
.balance-settings-copy h2 { margin: 0; color: var(--text); font-size: 14px; }
.balance-settings-copy p { margin: 3px 0 0; color: var(--text-tertiary); font-size: 12px; }
.balance-settings-controls { flex-wrap: wrap; justify-content: flex-end; gap: 10px 14px; }
.balance-settings-controls label { gap: 7px; color: var(--text-secondary); font-size: 12px; }
.balance-settings-controls .input { width: 112px; }
.balance-settings-message { grid-column: 1 / -1; margin: 0; color: var(--success); font-size: 12px; }
.balance-settings-message.error { color: var(--danger); }

.dashboard-charts {
  display: grid;
  grid-template-columns: minmax(260px, 0.62fr) minmax(0, 1.38fr);
  gap: 14px;
  margin-top: 14px;
}

.chart {
  width: 100%;
  height: 270px;
}

.chart-status {
  min-width: 240px;
  height: 235px;
}

.status-legend { display: flex; justify-content: center; flex-wrap: wrap; gap: 6px 12px; min-height: 37px; padding: 0 10px 11px; color: var(--text-secondary); font-size: 12px; }
.status-legend span { display: inline-flex; align-items: center; gap: 5px; }
.status-legend i { width: 7px; height: 7px; border-radius: 50%; background: #a3aeaa; }
.status-legend i.healthy { background: #237453; }
.status-legend i.degraded { background: #b77817; }
.status-legend i.down { background: #aa3c38; }

.dashboard-lists {
  margin-top: 14px;
}

.incident-list,
.rate-change-list {
  display: grid;
}

.incident-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 11px;
  min-height: 64px;
  padding: 10px 14px;
  border-bottom: 1px solid #e8ecea;
}

.incident-row:last-child,
.rate-change-row:last-child {
  border-bottom: 0;
}

.incident-severity {
  width: 7px;
  height: 32px;
  border-radius: 2px;
  background: var(--blue);
}

.incident-severity.warning { background: #b77817; }
.incident-severity.critical { background: var(--danger); }

.incident-copy,
.incident-meta,
.rate-change-row > div {
  min-width: 0;
}

.incident-copy strong,
.incident-copy span,
.rate-change-row strong,
.rate-change-row span {
  display: block;
}

.incident-copy strong,
.rate-change-row strong {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.incident-copy span,
.rate-change-row span {
  margin-top: 3px;
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.incident-meta {
  display: grid;
  justify-items: end;
  gap: 5px;
}

.incident-meta time {
  color: var(--text-tertiary);
  font-size: 12px;
}

.rate-change-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-height: 55px;
  padding: 9px 14px;
  border-bottom: 1px solid #e8ecea;
}

.rate-direction {
  display: grid;
  width: 27px;
  height: 27px;
  place-items: center;
  border-radius: 5px;
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.rate-direction.up { background: var(--danger-soft); color: var(--danger); }
.rate-direction.down { background: var(--success-soft); color: var(--success); }

.rate-change-meta {
  display: grid;
  justify-items: end;
  gap: 4px;
}

.rate-values {
  display: flex !important;
  align-items: center;
  gap: 5px;
  font-size: 13px;
}

.rate-values span,
.rate-values strong {
  margin: 0;
}

.rate-change-meta time {
  color: var(--text-tertiary);
  font-size: 12px;
  white-space: nowrap;
}

.dashboard-footnote {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin: 12px 2px 0;
  color: var(--text-tertiary);
  font-size: 12px;
}

@media (max-width: 1050px) {
  .balance-settings-bar { grid-template-columns: minmax(0, 1fr); }
  .balance-settings-controls { justify-content: flex-start; }

  .dashboard-charts {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 560px) {
  .balance-settings-controls { align-items: stretch; }
  .balance-settings-controls label { width: 100%; justify-content: space-between; }
  .balance-settings-controls .input { width: min(140px, 45vw); }
  .balance-settings-controls .btn { width: 100%; }

  .chart {
    height: 230px;
  }

  .incident-row {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .incident-meta {
    grid-column: 2;
    grid-template-columns: auto auto;
    justify-content: start;
    align-items: center;
  }

  .rate-change-row {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .rate-change-meta {
    grid-column: 2;
    justify-self: start;
    justify-items: start;
  }
}
</style>
