<script setup lang="ts">
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BadgeAlert,
  BadgeCheck,
  ChevronDown,
  Filter,
  FlaskConical,
  Gauge,
  Info,
  Minus,
  RefreshCw,
  Search,
  Trash2,
} from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';

import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import PaginationControls from '../components/PaginationControls.vue';
import RateProbeDialog from '../components/RateProbeDialog.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { api } from '../services/api';
import { compareDecimal, formatDateTime, formatDecimal } from '../services/format';
import { probeErrorMessage } from '../../../shared/probe-errors';
import { clampPage, fetchAllPages, slicePage } from '../services/pagination';
import { rateCombinedHealth, rateUnitLabel } from '../services/presentation';
import {
  rateSortDefinition,
  sortRatesByMultiplier,
  type RateSortDirection,
  type RateSortField,
  type RateSortMode,
} from '../services/rate-sort';
import { loadResource } from '../services/resource-loader';
import type { RateProbeResult, RateViewModel, SiteViewModel } from '../types/domain';

interface ComparedRate {
  rate: RateViewModel;
  lowest: boolean;
  highest: boolean;
  direction: 'up' | 'down' | 'same';
}

const RATE_SORT_COLUMNS: ReadonlyArray<{ field: RateSortField; label: string }> = [
  { field: 'base', label: '基础' },
  { field: 'user', label: '用户' },
  { field: 'effective', label: '生效' },
];

const rates = ref<RateViewModel[]>([]);
const sites = ref<SiteViewModel[]>([]);
const error = ref<string | null>(null);
const loading = ref(true);
const search = ref('');
const siteFilter = ref('all');
const platformFilter = ref('all');
const kindFilter = ref('all');
const changeFilter = ref('all');
const sortMode = ref<RateSortMode>('default');
const probeTarget = ref<RateViewModel | null>(null);
const deleteTarget = ref<RateViewModel | null>(null);
const deleteLoading = ref(false);
const deleteError = ref<string | null>(null);
const page = ref(1);
const pageSize = ref(20);
const expandedMobileRateIds = ref<Set<string>>(new Set());

const siteMap = computed(() => new Map(sites.value.map((site) => [site.id, site])));
const platformOptions = computed(() => [...new Set(rates.value.map((rate) => rate.platform).filter((item): item is string => Boolean(item)))].sort());

const filteredRates = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return rates.value.filter((rate) => {
    const site = siteMap.value.get(rate.site_id);
    const text = [rate.name, rate.rate_key, rate.platform ?? '', site?.name ?? ''].join(' ').toLocaleLowerCase();
    const changed = rate.previous_value !== undefined && rate.previous_value !== null && compareSafe(rate.value, rate.previous_value) !== 0;
    return (!query || text.includes(query))
      && (siteFilter.value === 'all' || rate.site_id === siteFilter.value)
      && (platformFilter.value === 'all' || rate.platform === platformFilter.value)
      && (kindFilter.value === 'all' || rate.rate_kind === kindFilter.value)
      && (changeFilter.value === 'all' || (changeFilter.value === 'changed' ? changed : !changed));
  });
});

const comparedRates = computed<ComparedRate[]>(() => {
  const extrema = new Map<string, { min: string; max: string }>();
  for (const rate of filteredRates.value) {
    if (rate.metadata_status !== 'available' || !rate.value || !rate.comparison_key) continue;
    const current = extrema.get(rate.comparison_key);
    if (!current) {
      extrema.set(rate.comparison_key, { min: rate.value, max: rate.value });
      continue;
    }
    if (compareSafe(rate.value, current.min) < 0) current.min = rate.value;
    if (compareSafe(rate.value, current.max) > 0) current.max = rate.value;
  }
  return sortRatesByMultiplier(filteredRates.value, sortMode.value).map((rate) => {
    const range = extrema.get(rate.comparison_key);
    const direction = rate.previous_value === null || rate.previous_value === undefined
      ? 'same'
      : compareSafe(rate.value, rate.previous_value) > 0
        ? 'up'
        : compareSafe(rate.value, rate.previous_value) < 0
          ? 'down'
          : 'same';
    return {
      rate,
      lowest: Boolean(range && compareSafe(rate.value, range.min) === 0),
      highest: Boolean(range && compareSafe(rate.value, range.max) === 0),
      direction,
    };
  });
});
const paginatedComparedRates = computed(() => slicePage(comparedRates.value, page.value, pageSize.value));

watch([search, siteFilter, platformFilter, kindFilter, changeFilter, sortMode], () => {
  page.value = 1;
});
watch([() => comparedRates.value.length, pageSize], () => {
  page.value = clampPage(page.value, comparedRates.value.length, pageSize.value);
});

const summary = computed(() => ({
  total: comparedRates.value.length,
  groups: new Set(comparedRates.value.map((item) => item.rate.comparison_key)).size,
  changed: comparedRates.value.filter((item) => item.direction !== 'same').length,
  stale: comparedRates.value.filter((item) => item.rate.metadata_status === 'stale').length,
}));

function compareSafe(left: string, right: string): number {
  try {
    return compareDecimal(left, right);
  } catch {
    return 0;
  }
}

function toggleRateSort(field: RateSortField): void {
  const current = rateSortDefinition(sortMode.value);
  if (!current || current.field !== field) {
    sortMode.value = `${field}-asc`;
    return;
  }
  sortMode.value = current.direction === 'asc' ? `${field}-desc` : 'default';
}

function rateSortDirection(field: RateSortField): RateSortDirection | null {
  const current = rateSortDefinition(sortMode.value);
  return current?.field === field ? current.direction : null;
}

function rateSortLabel(field: RateSortField, label: string): string {
  const direction = rateSortDirection(field);
  return direction === null
    ? `按${label}升序排列`
    : direction === 'asc'
      ? `${label}当前从低到高，切换为从高到低`
      : `${label}当前从高到低，恢复默认顺序`;
}

function attributeString(rate: RateViewModel, key: string): string | null {
  const value = rate.attributes[key];
  return typeof value === 'string' ? value : null;
}

function rateKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    group: '分组倍率', model: '模型倍率', completion: '补全倍率', user_override: '用户覆盖', fixed_price: '固定价格', peak: '峰值倍率', custom: '自定义',
  };
  return labels[kind] ?? kind;
}

function ratePlatformLabel(rate: RateViewModel): string {
  return rate.platform?.trim() || '未标注平台';
}

function openProbe(rate: RateViewModel): void {
  if (!rate.id) return;
  probeTarget.value = rate;
}

function applyProbeResult(result: RateProbeResult): void {
  const targetId = probeTarget.value?.id;
  if (!targetId) return;
  rates.value = rates.value.map((rate) => rate.id === targetId
    ? { ...rate, latest_probe: result }
    : rate);
  probeTarget.value = rates.value.find((rate) => rate.id === targetId) ?? null;
}

function rateHealth(rate: RateViewModel) {
  return rateCombinedHealth(rate, siteMap.value.get(rate.site_id), formatDateTime);
}

function rateHealthTone(rate: RateViewModel): 'success' | 'warning' | 'danger' {
  const status = rateHealth(rate).badgeStatus;
  return status === 'healthy' ? 'success' : status === 'down' ? 'danger' : 'warning';
}

function formatProbeMs(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`;
}

function formatProbeTps(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}/s`;
}

function formatProbeTokens(value: number | null): string {
  return value === null ? '—' : String(value);
}

function probeModel(result: RateProbeResult): string {
  return result.returned_model ?? result.requested_model;
}

function probeTime(result: RateProbeResult | null | undefined): string | null {
  return result?.completed_at ?? result?.created_at ?? null;
}

function mobileRateId(rate: RateViewModel): string {
  return rate.id ?? `${rate.site_id}:${rate.rate_key}`;
}

function mobileRateExpanded(rate: RateViewModel): boolean {
  return expandedMobileRateIds.value.has(mobileRateId(rate));
}

function toggleMobileRate(rate: RateViewModel): void {
  const id = mobileRateId(rate);
  const next = new Set(expandedMobileRateIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedMobileRateIds.value = next;
}

function inputTokenIssueTone(result: RateProbeResult): 'neutral' | 'warning' | 'danger' {
  if (result.status === 'failed' || result.tool_calls_observed || result.evidence?.upstream_tools_observed === true) return 'danger';
  return result.input_token_assessment === 'higher_than_expected' ? 'warning' : 'neutral';
}

function outputTokenIssueTone(result: RateProbeResult): 'neutral' | 'warning' | 'danger' {
  if (result.status === 'failed') return 'danger';
  if (result.finish_reason === 'length') return 'warning';
  if (
    result.completion_tokens !== null
    && result.reasoning_tokens !== null
    && result.reasoning_tokens >= result.completion_tokens
  ) return 'warning';
  return 'neutral';
}

function inputTokenInfoTitle(result: RateProbeResult): string {
  if (result.tool_calls_observed) return '异常：响应出现了客户端未声明的工具调用。点击查看完整实测明细。';
  if (result.evidence?.upstream_tools_observed === true) return '异常：客户端未声明工具，但上游响应回显了工具配置。点击查看完整实测明细。';
  if (result.status === 'failed') return `实测失败：${probeErrorMessage(result.error_code, result.http_status, result.error_message)}。点击查看完整实测明细。`;

  const reported = formatProbeTokens(result.prompt_tokens);
  const expected = formatProbeTokens(result.expected_input_tokens);
  const delta = result.input_token_delta === null
    ? '—'
    : `${result.input_token_delta >= 0 ? '+' : ''}${result.input_token_delta}`;
  if (result.input_token_assessment === 'higher_than_expected') {
    return `警告：上游报告 ${reported}，客户端字符粗估约 ${expected}，差值 ${delta}。点击查看原因和缓存 Token 明细。`;
  }
  return `输入 Token：上游报告 ${reported}，客户端字符粗估约 ${expected}，差值 ${delta}。点击查看完整明细。`;
}

function outputTokenInfoTitle(result: RateProbeResult): string {
  if (result.status === 'failed') return `实测失败：${probeErrorMessage(result.error_code, result.http_status, result.error_message)}。点击查看完整实测明细。`;
  if (result.finish_reason === 'length') return '警告：响应达到单次输出预算后被截断。点击查看输出和推理 Token 明细。';
  if (
    result.completion_tokens !== null
    && result.reasoning_tokens !== null
    && result.reasoning_tokens >= result.completion_tokens
  ) return `警告：输出 Token 共 ${result.completion_tokens}，其中推理 Token ${result.reasoning_tokens}，可能没有可见正文。点击查看完整明细。`;
  return `输出 Token 共 ${formatProbeTokens(result.completion_tokens)}，推理 Token ${formatProbeTokens(result.reasoning_tokens)}。点击查看完整明细。`;
}

function openDelete(rate: RateViewModel): void {
  deleteError.value = null;
  deleteTarget.value = rate;
}

function closeDelete(): void {
  if (!deleteLoading.value) deleteTarget.value = null;
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (!target?.id) return;
  deleteLoading.value = true;
  deleteError.value = null;
  try {
    await api.rates.remove(target.id);
    rates.value = rates.value.filter((rate) => rate.id !== target.id);
    if (probeTarget.value?.id === target.id) probeTarget.value = null;
    deleteTarget.value = null;
  } catch (caught) {
    deleteError.value = caught instanceof Error ? caught.message : '删除倍率对象失败';
  } finally {
    deleteLoading.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  const result = await loadResource(
    async () => {
      const [allRates, allSites] = await Promise.all([
        fetchAllPages((requestedPage, requestedPageSize) => api.rates.list('', requestedPage, requestedPageSize)),
        fetchAllPages((requestedPage, requestedPageSize) => api.sites.list(requestedPage, requestedPageSize)),
      ]);
      return { rates: allRates, sites: allSites };
    },
    { rates: [], sites: [] },
  );
  rates.value = result.data.rates;
  sites.value = result.data.sites;
  error.value = result.error;
  loading.value = false;
}

onMounted(load);
</script>

<template>
  <div class="page rates-page">
    <PageHeader title="倍率" description="仅在计费语义与 comparison_key 一致的范围内比较最低和最高值。">
      <template #actions>
        <button class="btn btn-secondary" type="button" :disabled="loading" @click="load"><RefreshCw :size="16" aria-hidden="true" />刷新倍率</button>
      </template>
    </PageHeader>

    <div v-if="error" class="notice notice-danger" role="alert">倍率数据加载失败：{{ error }}</div>

    <section class="rate-summary" aria-label="倍率汇总">
      <div><Gauge :size="16" aria-hidden="true" /><span><strong>{{ summary.total }}</strong><small>当前对象</small></span></div>
      <div><Filter :size="16" aria-hidden="true" /><span><strong>{{ summary.groups }}</strong><small>可比较组</small></span></div>
      <div><ArrowUp :size="16" aria-hidden="true" /><span><strong>{{ summary.changed }}</strong><small>最近变化</small></span></div>
      <div><BadgeAlert :size="16" aria-hidden="true" /><span><strong>{{ summary.stale }}</strong><small>陈旧数据</small></span></div>
    </section>

    <section class="surface rates-surface">
      <div class="filter-bar">
        <div class="search-field">
          <Search :size="16" aria-hidden="true" />
          <input v-model="search" class="input" type="search" placeholder="搜索倍率、稳定键或站点" aria-label="搜索倍率" />
        </div>
        <div class="field"><label for="rate-site">站点</label><select id="rate-site" v-model="siteFilter" class="select"><option value="all">全部站点</option><option v-for="site in sites" :key="site.id" :value="site.id">{{ site.name }}</option></select></div>
        <div class="field"><label for="rate-platform">平台</label><select id="rate-platform" v-model="platformFilter" class="select"><option value="all">全部平台</option><option v-for="platform in platformOptions" :key="platform" :value="platform">{{ platform }}</option></select></div>
        <div class="field"><label for="rate-kind">倍率类型</label><select id="rate-kind" v-model="kindFilter" class="select"><option value="all">全部类型</option><option value="group">分组</option><option value="model">模型</option><option value="completion">补全</option><option value="fixed_price">固定价格</option></select></div>
        <div class="field"><label for="rate-change">变化</label><select id="rate-change" v-model="changeFilter" class="select"><option value="all">全部</option><option value="changed">有变化</option><option value="unchanged">无变化</option></select></div>
        <div class="field rate-sort-select"><label for="rate-sort">排序</label><select id="rate-sort" v-model="sortMode" class="select"><option value="default">默认顺序</option><option value="effective-asc">生效倍率：低到高</option><option value="effective-desc">生效倍率：高到低</option><option value="base-asc">基础倍率：低到高</option><option value="base-desc">基础倍率：高到低</option><option value="user-asc">用户倍率：低到高</option><option value="user-desc">用户倍率：高到低</option></select></div>
      </div>
      <div v-if="loading" class="loading-line" />

      <div v-if="comparedRates.length" class="table-wrap desktop-rate-table">
        <table class="data-table rates-table">
          <colgroup>
            <col class="rate-col-identity" />
            <col class="rate-col-kind" />
            <col class="rate-col-details" />
            <col class="rate-col-comparison" />
            <col class="rate-col-probe" />
            <col class="rate-col-status" />
            <col class="rate-col-probe-time" />
            <col class="rate-col-change" />
            <col class="rate-col-collected" />
            <col class="rate-col-actions" />
          </colgroup>
          <thead><tr><th>倍率对象 / 站点</th><th>平台 / 倍率类型</th><th class="rate-details-heading"><span>倍率明细</span><span class="rate-sort-buttons"><button v-for="column in RATE_SORT_COLUMNS" :key="column.field" type="button" :class="{ active: rateSortDirection(column.field) }" :title="rateSortLabel(column.field, column.label)" :aria-label="rateSortLabel(column.field, column.label)" :aria-pressed="rateSortDirection(column.field) !== null" @click="toggleRateSort(column.field)"><span>{{ column.label }}</span><ArrowUp v-if="rateSortDirection(column.field) === 'asc'" :size="12" aria-hidden="true" /><ArrowDown v-else-if="rateSortDirection(column.field) === 'desc'" :size="12" aria-hidden="true" /><ArrowUpDown v-else :size="12" aria-hidden="true" /></button></span></th><th>同组比较</th><th>模型实测</th><th>状态</th><th>实测时间</th><th>最近变化</th><th>采集时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="item in paginatedComparedRates" :key="item.rate.id ?? `${item.rate.site_id}:${item.rate.rate_key}`">
              <td>
                <span class="cell-main">{{ item.rate.name }}</span>
                <span class="cell-sub">{{ siteMap.get(item.rate.site_id)?.name ?? item.rate.site_id }} · {{ item.rate.rate_key }}</span>
              </td>
              <td><span class="cell-main">{{ ratePlatformLabel(item.rate) }}</span><span class="cell-sub">{{ rateKindLabel(item.rate.rate_kind) }}</span></td>
              <td>
                <div class="rate-breakdown">
                  <span><small>基础</small><strong class="mono">{{ formatDecimal(attributeString(item.rate, 'base_rate') ?? item.rate.value) }}</strong></span>
                  <span><small>用户</small><strong class="mono">{{ attributeString(item.rate, 'user_rate') ? formatDecimal(attributeString(item.rate, 'user_rate')!) : '—' }}</strong></span>
                  <span><small>生效</small><strong class="rate-value mono" :class="{ lowest: item.lowest, highest: item.highest }">{{ formatDecimal(attributeString(item.rate, 'effective_rate') ?? item.rate.value) }}</strong></span>
                </div>
                <span class="cell-sub">{{ rateUnitLabel(item.rate.unit) }}</span>
              </td>
              <td>
                <span v-if="item.lowest" class="extreme-label lowest"><BadgeCheck :size="13" aria-hidden="true" />最低</span>
                <span v-if="item.highest" class="extreme-label highest"><BadgeAlert :size="13" aria-hidden="true" />最高</span>
                <span v-if="!item.lowest && !item.highest" class="muted">范围内</span>
                <span class="cell-sub comparison-key" :title="item.rate.comparison_key">{{ item.rate.comparison_key }}</span>
              </td>
              <td>
                <div class="probe-cell">
                  <div v-if="item.rate.latest_probe" class="probe-inline-summary">
                    <strong>{{ formatProbeMs(item.rate.latest_probe.ttft_ms) }} <span>·</span> {{ formatProbeTps(item.rate.latest_probe.tps) }}</strong>
                    <span class="probe-token-summary">
                      <span>↑ {{ formatProbeTokens(item.rate.latest_probe.prompt_tokens) }}</span><button :class="['token-info-button', `is-${inputTokenIssueTone(item.rate.latest_probe)}`]" type="button" :title="inputTokenInfoTitle(item.rate.latest_probe)" :aria-label="inputTokenInfoTitle(item.rate.latest_probe)" @click="openProbe(item.rate)"><BadgeAlert v-if="inputTokenIssueTone(item.rate.latest_probe) !== 'neutral'" :size="13" aria-hidden="true" /><Info v-else :size="12" aria-hidden="true" /></button>
                      <span>↓ {{ formatProbeTokens(item.rate.latest_probe.completion_tokens) }}</span><button :class="['token-info-button', `is-${outputTokenIssueTone(item.rate.latest_probe)}`]" type="button" :title="outputTokenInfoTitle(item.rate.latest_probe)" :aria-label="outputTokenInfoTitle(item.rate.latest_probe)" @click="openProbe(item.rate)"><BadgeAlert v-if="outputTokenIssueTone(item.rate.latest_probe) !== 'neutral'" :size="13" aria-hidden="true" /><Info v-else :size="12" aria-hidden="true" /></button>
                    </span>
                    <small :title="probeModel(item.rate.latest_probe)">{{ probeModel(item.rate.latest_probe) }}</small>
                  </div>
                  <span v-else class="probe-empty-copy">尚未实测</span>
                </div>
              </td>
              <td><div class="status-stack" :title="rateHealth(item.rate).summary"><StatusBadge :status="rateHealth(item.rate).badgeStatus" :label="rateHealth(item.rate).label" /></div></td>
              <td><span class="cell-main">{{ formatDateTime(probeTime(item.rate.latest_probe)) }}</span><span class="cell-sub">最近一次模型实测</span></td>
              <td>
                <span class="change-line" :class="item.direction">
                  <ArrowUp v-if="item.direction === 'up'" :size="14" aria-hidden="true" />
                  <ArrowDown v-else-if="item.direction === 'down'" :size="14" aria-hidden="true" />
                  <Minus v-else :size="14" aria-hidden="true" />
                  <template v-if="item.direction !== 'same'"><span class="mono">{{ item.rate.previous_value }}</span> → <strong class="mono">{{ item.rate.value }}</strong></template>
                  <template v-else>无变化</template>
                </span>
                <span class="cell-sub">{{ formatDateTime(item.rate.last_changed_at) }}</span>
              </td>
              <td><span class="cell-main">{{ formatDateTime(item.rate.collected_at) }}</span><span class="cell-sub">{{ item.rate.adapter_type }}</span></td>
              <td>
                <div class="rate-actions">
                  <button
                    class="icon-btn probe-button"
                    type="button"
                    :disabled="!item.rate.id"
                    :title="`实测 ${item.rate.name}`"
                    :aria-label="`实测 ${item.rate.name}`"
                    @click="openProbe(item.rate)"
                  ><FlaskConical :size="16" aria-hidden="true" /></button>
                  <button class="icon-btn icon-btn-danger compact-action" type="button" :disabled="!item.rate.id" :title="`删除 ${item.rate.name}`" :aria-label="`删除 ${item.rate.name}`" @click="openDelete(item.rate)"><Trash2 :size="15" aria-hidden="true" /></button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="comparedRates.length" class="mobile-rate-list">
        <article v-for="item in paginatedComparedRates" :key="`mobile-${item.rate.id ?? item.rate.rate_key}`" class="mobile-rate-item">
          <button
            class="mobile-rate-summary"
            type="button"
            :aria-expanded="mobileRateExpanded(item.rate)"
            :aria-controls="`mobile-rate-details-${mobileRateId(item.rate)}`"
            @click="toggleMobileRate(item.rate)"
          >
            <span class="mobile-rate-summary-identity"><strong>{{ item.rate.name }}</strong><small :title="`${siteMap.get(item.rate.site_id)?.name ?? item.rate.site_id} · ${ratePlatformLabel(item.rate)} · ${rateKindLabel(item.rate.rate_kind)}`">{{ siteMap.get(item.rate.site_id)?.name ?? item.rate.site_id }} · {{ ratePlatformLabel(item.rate) }} · {{ rateKindLabel(item.rate.rate_kind) }}</small></span>
            <span class="mobile-rate-summary-value"><small>生效</small><strong class="mono">{{ formatDecimal(attributeString(item.rate, 'effective_rate') ?? item.rate.value) }}</strong></span>
            <span v-if="item.rate.latest_probe" class="mobile-rate-summary-probe"><small>{{ item.rate.latest_probe.status === 'failed' ? `HTTP ${item.rate.latest_probe.http_status ?? '错误'}` : `${formatProbeMs(item.rate.latest_probe.ttft_ms)} · ${formatProbeTps(item.rate.latest_probe.tps)}` }}</small><strong>↑ {{ formatProbeTokens(item.rate.latest_probe.prompt_tokens) }} · ↓ {{ formatProbeTokens(item.rate.latest_probe.completion_tokens) }}</strong></span>
            <span class="mobile-attention" :class="`is-${rateHealthTone(item.rate)}`" :title="rateHealth(item.rate).summary">{{ rateHealth(item.rate).label }}</span>
            <ChevronDown class="mobile-expand-icon" :class="{ expanded: mobileRateExpanded(item.rate) }" :size="18" aria-hidden="true" />
          </button>

          <div v-if="mobileRateExpanded(item.rate)" :id="`mobile-rate-details-${mobileRateId(item.rate)}`" class="mobile-rate-expanded">
            <div class="rate-breakdown mobile-rate-breakdown">
              <span><small>基础</small><strong class="mono">{{ formatDecimal(attributeString(item.rate, 'base_rate') ?? item.rate.value) }}</strong></span>
              <span><small>用户</small><strong class="mono">{{ attributeString(item.rate, 'user_rate') ? formatDecimal(attributeString(item.rate, 'user_rate')!) : '—' }}</strong></span>
              <span><small>生效</small><strong class="rate-value mono" :class="{ lowest: item.lowest, highest: item.highest }">{{ formatDecimal(attributeString(item.rate, 'effective_rate') ?? item.rate.value) }}</strong></span>
            </div>
            <span class="cell-sub">{{ rateUnitLabel(item.rate.unit) }}</span>
            <div class="mobile-extremes"><span v-if="item.lowest" class="extreme-label lowest"><BadgeCheck :size="13" aria-hidden="true" />同组最低</span><span v-if="item.highest" class="extreme-label highest"><BadgeAlert :size="13" aria-hidden="true" />同组最高</span></div>
            <div class="mobile-probe-summary">
              <div v-if="item.rate.latest_probe">
                <span><small>TTFT</small><strong>{{ formatProbeMs(item.rate.latest_probe.ttft_ms) }}</strong></span>
                <span><small>TPS</small><strong>{{ formatProbeTps(item.rate.latest_probe.tps) }}</strong></span>
                <span><small>Token</small><span class="mobile-token-detail"><strong>↑ {{ formatProbeTokens(item.rate.latest_probe.prompt_tokens) }}</strong><button :class="['token-info-button', `is-${inputTokenIssueTone(item.rate.latest_probe)}`]" type="button" :title="inputTokenInfoTitle(item.rate.latest_probe)" :aria-label="inputTokenInfoTitle(item.rate.latest_probe)" @click="openProbe(item.rate)"><BadgeAlert v-if="inputTokenIssueTone(item.rate.latest_probe) !== 'neutral'" :size="13" aria-hidden="true" /><Info v-else :size="12" aria-hidden="true" /></button><strong>↓ {{ formatProbeTokens(item.rate.latest_probe.completion_tokens) }}</strong><button :class="['token-info-button', `is-${outputTokenIssueTone(item.rate.latest_probe)}`]" type="button" :title="outputTokenInfoTitle(item.rate.latest_probe)" :aria-label="outputTokenInfoTitle(item.rate.latest_probe)" @click="openProbe(item.rate)"><BadgeAlert v-if="outputTokenIssueTone(item.rate.latest_probe) !== 'neutral'" :size="13" aria-hidden="true" /><Info v-else :size="12" aria-hidden="true" /></button></span></span>
              </div>
              <span v-else class="mobile-probe-empty">尚无模型实测记录</span>
              <div class="rate-actions">
                <button
                  class="icon-btn"
                  type="button"
                  :disabled="!item.rate.id"
                  :title="`实测 ${item.rate.name}`"
                  :aria-label="`实测 ${item.rate.name}`"
                  @click="openProbe(item.rate)"
                ><FlaskConical :size="16" aria-hidden="true" /></button>
                <button class="icon-btn icon-btn-danger" type="button" :disabled="!item.rate.id" :title="`删除 ${item.rate.name}`" :aria-label="`删除 ${item.rate.name}`" @click="openDelete(item.rate)"><Trash2 :size="15" aria-hidden="true" /></button>
              </div>
            </div>
            <div class="mobile-statuses" :title="rateHealth(item.rate).summary"><StatusBadge :status="rateHealth(item.rate).badgeStatus" :label="rateHealth(item.rate).label" /></div>
            <p class="comparison-key mono">{{ item.rate.comparison_key }}</p>
            <p class="change-line" :class="item.direction"><ArrowUp v-if="item.direction === 'up'" :size="14" aria-hidden="true" /><ArrowDown v-else-if="item.direction === 'down'" :size="14" aria-hidden="true" /><Minus v-else :size="14" aria-hidden="true" />{{ item.direction === 'same' ? '最近无变化' : `${item.rate.previous_value} → ${item.rate.value}` }}</p>
            <dl class="mobile-rate-times">
              <div><dt>实测时间</dt><dd>{{ formatDateTime(probeTime(item.rate.latest_probe)) }}</dd></div>
              <div><dt>最近变化</dt><dd>{{ formatDateTime(item.rate.last_changed_at) }}</dd></div>
              <div><dt>采集时间</dt><dd>{{ formatDateTime(item.rate.collected_at) }}</dd><small>{{ item.rate.adapter_type }}</small></div>
            </dl>
          </div>
        </article>
      </div>

      <PaginationControls v-if="comparedRates.length" v-model:page="page" v-model:page-size="pageSize" :total="comparedRates.length" />

      <EmptyState v-if="!loading && !comparedRates.length" title="没有匹配的倍率对象" description="调整站点、平台或类型筛选。不同 comparison_key 的对象不会跨组比较。" />
    </section>

    <RateProbeDialog
      :open="probeTarget !== null"
      :rate="probeTarget"
      :site-name="probeTarget ? siteMap.get(probeTarget.site_id)?.name ?? probeTarget.site_id : ''"
      @close="probeTarget = null"
      @completed="applyProbeResult"
    />

    <ConfirmDeleteDialog
      :open="deleteTarget !== null"
      title="删除倍率对象？"
      description="该对象将从当前倍率列表移除并停止自动实测；已保存的变化和实测历史仍用于审计。"
      :item-name="deleteTarget ? `${siteMap.get(deleteTarget.site_id)?.name ?? deleteTarget.site_id} · ${deleteTarget.name}` : ''"
      :loading="deleteLoading"
      :error="deleteError"
      @cancel="closeDelete"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.rate-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.rate-summary > div {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 11px 13px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-secondary);
}

.rate-summary strong,
.rate-summary small { display: block; }
.rate-summary strong { color: var(--text); font-size: 20px; font-variant-numeric: tabular-nums; }
.rate-summary small { color: var(--text-tertiary); font-size: 12px; }
.rates-surface { overflow: hidden; }
.rates-table { min-width: 1615px; table-layout: fixed; }
.rate-col-identity { width: 205px; }
.rate-col-kind { width: 120px; }
.rate-col-details { width: 180px; }
.rate-col-comparison { width: 160px; }
.rate-col-probe { width: 220px; }
.rate-col-status { width: 130px; }
.rate-col-probe-time { width: 145px; }
.rate-col-change { width: 180px; }
.rate-col-collected { width: 150px; }
.rate-col-actions { width: 90px; }
.rate-sort-select { min-width: 190px !important; }
.rate-details-heading { padding-top: 5px !important; padding-bottom: 5px !important; }
.rate-details-heading > span:first-child { display: block; margin-bottom: 3px; }
.rate-sort-buttons { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px; }
.rate-sort-buttons button { display: inline-flex; min-width: 0; min-height: 24px; align-items: center; justify-content: center; gap: 2px; padding: 2px 3px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--text-tertiary); font: inherit; font-size: 9px; cursor: pointer; }
.rate-sort-buttons button:hover { border-color: var(--border); background: var(--surface-muted); color: var(--text-secondary); }
.rate-sort-buttons button.active { border-color: #99bdb3; background: var(--accent-soft); color: var(--accent); }
.rate-sort-buttons button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.rate-breakdown { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: stretch; gap: 4px; }
.rate-breakdown > span { display: grid; min-width: 0; grid-template-rows: 14px 32px; gap: 2px; }
.rate-breakdown small { display: flex; align-items: flex-end; color: var(--text-tertiary); font-size: 9px; }
.rate-breakdown strong { display: flex; width: 100%; min-width: 0; min-height: 32px; align-items: center; padding: 0 6px; overflow: hidden; border-radius: 4px; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.rate-breakdown .rate-value { min-width: 0; padding: 0 6px; font-size: 13px; }
.rate-value { display: inline-block; min-width: 68px; padding: 5px 7px; border-radius: 4px; font-size: 15px; font-weight: 700; }
.rate-value.lowest { background: var(--success-soft); color: var(--success); }
.rate-value.highest { background: var(--danger-soft); color: var(--danger); }
.rate-value.lowest.highest { background: var(--blue-soft); color: var(--blue); }
.extreme-label { display: inline-flex; min-height: 24px; align-items: center; gap: 4px; margin: 1px 4px 1px 0; padding: 3px 7px; border-radius: 4px; font-size: 12px; font-weight: 700; white-space: nowrap; }
.extreme-label.lowest { background: var(--success-soft); color: var(--success); }
.extreme-label.highest { background: var(--danger-soft); color: var(--danger); }
.comparison-key { max-width: 190px !important; }
.status-stack { display: grid; min-width: 0; justify-items: start; gap: 4px; }
.probe-cell { display: grid; width: 100%; min-width: 0; max-width: 100%; gap: 7px; }
.rate-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; }
.probe-button { width: 34px; height: 34px; flex-basis: 34px; color: var(--accent); }
.compact-action { width: 34px; height: 34px; flex-basis: 34px; }
.probe-inline-summary { display: grid; gap: 2px; min-width: 0; font-variant-numeric: tabular-nums; }
.probe-inline-summary strong { font-size: 12px; }
.probe-inline-summary strong span { color: var(--text-tertiary); }
.probe-inline-summary > span { color: var(--text-secondary); font-size: 11px; }
.probe-token-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; }
.token-info-button { display: inline-grid; width: 20px; height: 20px; place-items: center; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--text-tertiary); cursor: pointer; }
.token-info-button:hover:not(:disabled) { background: var(--surface-muted); color: var(--accent); }
.token-info-button.is-warning { background: var(--warning-soft); color: var(--warning); }
.token-info-button.is-warning:hover:not(:disabled) { background: var(--warning-soft); color: var(--warning); }
.token-info-button.is-danger { background: var(--danger-soft); color: var(--danger); }
.token-info-button.is-danger:hover:not(:disabled) { background: var(--danger-soft); color: var(--danger); }
.token-info-button:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
.token-info-button:disabled { cursor: not-allowed; opacity: 0.5; }
.probe-inline-summary small { max-width: 100%; overflow: hidden; color: var(--text-tertiary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.probe-empty-copy { color: var(--text-tertiary); font-size: 11px; }
.change-line { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; white-space: nowrap; }
.change-line.up { color: var(--danger); }
.change-line.down { color: var(--success); }
.change-line.same { color: var(--text-tertiary); }
.mobile-rate-list { display: none; }

@media (max-width: 1800px) {
  .rate-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .desktop-rate-table { display: none; }
  .mobile-rate-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--border); }
  .mobile-rate-item { min-width: 0; background: var(--surface); }
  .mobile-rate-summary { display: grid; width: 100%; min-height: 66px; grid-template-columns: minmax(120px, 1.3fr) minmax(64px, auto) minmax(110px, 0.8fr) auto 24px; align-items: center; gap: 10px; padding: 10px 14px; border: 0; background: var(--surface); color: var(--text); text-align: left; cursor: pointer; }
  .mobile-rate-summary:hover { background: var(--surface-subtle); }
  .mobile-rate-summary:focus-visible { position: relative; z-index: 1; outline: 2px solid var(--accent); outline-offset: -2px; }
  .mobile-rate-summary-identity,
  .mobile-rate-summary-value,
  .mobile-rate-summary-probe { display: grid; min-width: 0; gap: 2px; }
  .mobile-rate-summary-identity strong,
  .mobile-rate-summary-identity small,
  .mobile-rate-summary-value strong,
  .mobile-rate-summary-value small,
  .mobile-rate-summary-probe strong,
  .mobile-rate-summary-probe small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-rate-summary-identity strong { font-size: 14px; }
  .mobile-rate-summary-identity small,
  .mobile-rate-summary-value small,
  .mobile-rate-summary-probe small { color: var(--text-tertiary); font-size: 10px; }
  .mobile-rate-summary-value strong { font-size: 16px; }
  .mobile-rate-summary-probe { color: var(--text-secondary); font-size: 10px; font-variant-numeric: tabular-nums; }
  .mobile-attention { display: inline-flex; min-height: 24px; align-items: center; justify-content: center; padding: 3px 7px; border-radius: 4px; background: var(--surface-muted); color: var(--text-secondary); font-size: 10px; font-weight: 700; white-space: nowrap; }
  .mobile-attention.is-success { background: var(--success-soft); color: var(--success); }
  .mobile-attention.is-warning { background: var(--warning-soft); color: var(--warning); }
  .mobile-attention.is-danger { background: var(--danger-soft); color: var(--danger); }
  .mobile-expand-icon { color: var(--text-tertiary); transition: transform 160ms ease; }
  .mobile-expand-icon.expanded { transform: rotate(180deg); }
  .mobile-rate-expanded { padding: 13px 14px 14px; border-top: 1px solid var(--border); background: var(--surface-subtle); }
  .mobile-rate-breakdown { margin-bottom: 2px; }
  .mobile-extremes { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
  .mobile-probe-summary { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-subtle); }
  .mobile-probe-summary > div { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; min-width: 0; }
  .mobile-probe-summary > .rate-actions { display: flex; }
  .mobile-probe-summary > div > span { min-width: 0; }
  .mobile-probe-summary small,
  .mobile-probe-summary strong { display: block; }
  .mobile-probe-summary small { color: var(--text-tertiary); font-size: 10px; }
  .mobile-probe-summary strong { overflow: hidden; font-size: 12px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-token-detail { display: flex; min-height: 24px; align-items: center; gap: 1px; }
  .mobile-token-detail strong { flex: 0 1 auto; }
  .mobile-probe-summary .icon-btn { width: 36px; height: 36px; flex-basis: 36px; color: var(--accent); }
  .mobile-probe-summary .icon-btn-danger { color: var(--danger); }
  .mobile-probe-empty { color: var(--text-tertiary); font-size: 12px; }
  .mobile-statuses { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
  .mobile-rate-expanded > .comparison-key { margin: 9px 0; overflow-wrap: anywhere; color: var(--text-tertiary); font-size: 11px; }
  .mobile-rate-expanded > .change-line { margin: 0; }
  .mobile-rate-times { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 11px 0 0; padding-top: 10px; border-top: 1px solid var(--border); }
  .mobile-rate-times div { min-width: 0; }
  .mobile-rate-times dt { color: var(--text-tertiary); font-size: 10px; }
  .mobile-rate-times dd { margin: 2px 0 0; overflow: hidden; color: var(--text-secondary); font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-rate-times small { display: block; margin-top: 1px; color: var(--text-tertiary); font-size: 10px; }
}

@media (max-width: 1280px) {
  .mobile-rate-list { grid-template-columns: minmax(0, 1fr); }
}

@media (max-width: 600px) {
  .mobile-rate-summary { grid-template-columns: minmax(0, 1fr) auto auto 22px; gap: 7px; padding: 9px 11px; }
  .mobile-rate-summary-probe { display: none; }
  .mobile-attention { padding-inline: 5px; }
}

@media (max-width: 430px) {
  .rate-summary { grid-template-columns: minmax(0, 1fr); }
  .rate-summary > div { display: grid; grid-template-columns: auto minmax(0, 1fr); }
  .mobile-probe-summary > div { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mobile-probe-summary > div > span:last-child { grid-column: span 2; }
  .mobile-rate-times { grid-template-columns: minmax(0, 1fr); }
}
</style>
