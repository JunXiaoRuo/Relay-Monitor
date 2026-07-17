<script setup lang="ts">
import {
  ExternalLink,
  Filter,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import PaginationControls from '../components/PaginationControls.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { api } from '../services/api';
import { formatMoney, formatRelativeTime } from '../services/format';
import { clampPage, fetchAllPages, slicePage } from '../services/pagination';
import { loadResource } from '../services/resource-loader';
import type { SiteViewModel } from '../types/domain';

const sites = ref<SiteViewModel[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const search = ref('');
const serviceStatus = ref('all');
const authStatus = ref('all');
const checkingId = ref<string | null>(null);
const actionMessage = ref<string | null>(null);
const deleteTarget = ref<SiteViewModel | null>(null);
const deleteLoading = ref(false);
const deleteError = ref<string | null>(null);
const page = ref(1);
const pageSize = ref(20);

const filteredSites = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return sites.value.filter((site) => {
    const matchesText = !query || [site.name, site.base_url, site.adapter_type, ...site.tags].join(' ').toLocaleLowerCase().includes(query);
    const matchesService = serviceStatus.value === 'all' || site.service_status === serviceStatus.value;
    const matchesAuth = authStatus.value === 'all' || site.auth_status === authStatus.value;
    return matchesText && matchesService && matchesAuth;
  });
});
const paginatedSites = computed(() => slicePage(filteredSites.value, page.value, pageSize.value));

watch([search, serviceStatus, authStatus], () => {
  page.value = 1;
});
watch([() => filteredSites.value.length, pageSize], () => {
  page.value = clampPage(page.value, filteredSites.value.length, pageSize.value);
});

async function load(): Promise<void> {
  loading.value = true;
  actionMessage.value = null;
  const result = await loadResource(
    async () => fetchAllPages((requestedPage, requestedPageSize) => api.sites.list(requestedPage, requestedPageSize)),
    [],
  );
  sites.value = result.data;
  error.value = result.error;
  loading.value = false;
}

async function runCheck(site: SiteViewModel): Promise<void> {
  checkingId.value = site.id;
  actionMessage.value = null;
  try {
    await api.sites.check(site.id, 'connectivity');
    actionMessage.value = `已提交“${site.name}”连通性检查。`;
  } catch (caught) {
    actionMessage.value = caught instanceof Error ? caught.message : '检查提交失败';
  }
  checkingId.value = null;
}

function openDelete(site: SiteViewModel): void {
  deleteTarget.value = site;
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
    await api.sites.remove(target.id);
    await load();
    actionMessage.value = `站点“${target.name}”已删除。`;
    deleteTarget.value = null;
  } catch (caught) {
    deleteError.value = caught instanceof Error ? caught.message : '删除站点失败';
  } finally {
    deleteLoading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <PageHeader title="中转站" description="分别查看服务健康与登录状态，并管理每类监控任务。">
      <template #actions>
        <button class="btn btn-secondary" type="button" :disabled="loading" @click="load">
          <RefreshCw :size="16" aria-hidden="true" />
          刷新
        </button>
        <RouterLink class="btn btn-primary" to="/sites/new">
          <Plus :size="16" aria-hidden="true" />
          添加站点
        </RouterLink>
      </template>
    </PageHeader>

    <div v-if="error" class="notice notice-danger" role="alert">站点加载失败：{{ error }}</div>
    <div v-if="actionMessage" class="notice" role="status">{{ actionMessage }}</div>

    <section class="surface sites-surface">
      <div class="filter-bar">
        <div class="search-field">
          <Search :size="16" aria-hidden="true" />
          <input v-model="search" class="input" type="search" placeholder="搜索名称、地址或标签" aria-label="搜索站点" />
        </div>
        <div class="field compact-filter">
          <label for="service-status">服务状态</label>
          <select id="service-status" v-model="serviceStatus" class="select">
            <option value="all">全部</option>
            <option value="healthy">正常</option>
            <option value="degraded">降级</option>
            <option value="down">宕机</option>
            <option value="unknown">未知</option>
          </select>
        </div>
        <div class="field compact-filter">
          <label for="auth-status">登录状态</label>
          <select id="auth-status" v-model="authStatus" class="select">
            <option value="all">全部</option>
            <option value="authenticated">已登录</option>
            <option value="reauth_required">需重新登录</option>
            <option value="interaction_required">需人工验证</option>
            <option value="invalid_credentials">凭据无效</option>
          </select>
        </div>
        <span class="filter-count"><Filter :size="14" aria-hidden="true" />{{ filteredSites.length }} / {{ sites.length }}</span>
      </div>
      <div v-if="loading" class="loading-line" />

      <div v-if="filteredSites.length" class="table-wrap desktop-site-table">
        <table class="data-table site-table">
          <thead>
            <tr>
              <th>站点</th>
              <th>服务状态</th>
              <th>登录状态</th>
              <th>余额</th>
              <th>延迟 / 可用率</th>
              <th>倍率对象</th>
              <th>最近状态</th>
              <th><span class="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="site in paginatedSites" :key="site.id">
              <td>
                <RouterLink class="site-link" :to="`/sites/${site.id}`">
                  <span class="site-icon"><Server :size="16" aria-hidden="true" /></span>
                  <span>
                    <strong>{{ site.name }}</strong>
                    <small>{{ site.adapter_type }} · {{ site.base_url }}</small>
                  </span>
                </RouterLink>
                <div class="tag-list site-tags">
                  <span v-for="tag in site.tags" :key="tag" class="tag">{{ tag }}</span>
                </div>
              </td>
              <td><StatusBadge :status="site.service_status" /></td>
              <td><StatusBadge :status="site.auth_status" /></td>
              <td>
                <span v-if="site.balance" class="cell-main numeric">{{ formatMoney(site.balance.value, site.balance.currency) }}</span>
                <span v-else class="muted">—</span>
                <span v-if="site.balance" class="cell-sub">{{ formatRelativeTime(site.balance.collected_at) }}更新</span>
              </td>
              <td>
                <span class="cell-main numeric">{{ site.latency_ms ? `${site.latency_ms} ms` : '—' }}</span>
                <span class="cell-sub numeric">{{ site.uptime_24h ? `${site.uptime_24h}% / 24h` : '无数据' }}</span>
              </td>
              <td><span class="cell-main numeric">{{ site.rate_count ?? 0 }}</span><span class="cell-sub">已规范化对象</span></td>
              <td>
                <span class="cell-main">{{ formatRelativeTime(site.last_success_at) }}</span>
                <span class="cell-sub" :title="site.last_error ?? ''">{{ site.last_error ?? '最近无错误' }}</span>
              </td>
              <td>
                <div class="row-actions">
                  <button
                    class="icon-btn"
                    type="button"
                    :disabled="checkingId === site.id"
                    :title="`立即检查 ${site.name}`"
                    :aria-label="`立即检查 ${site.name}`"
                    @click="runCheck(site)"
                  >
                    <RefreshCw v-if="checkingId === site.id" :size="16" class="spin" aria-hidden="true" />
                    <Play v-else :size="16" aria-hidden="true" />
                  </button>
                  <RouterLink class="icon-btn" :to="`/sites/${site.id}`" :title="`查看 ${site.name} 详情`" :aria-label="`查看 ${site.name} 详情`">
                    <ExternalLink :size="16" aria-hidden="true" />
                  </RouterLink>
                  <button class="icon-btn icon-btn-danger" type="button" :disabled="deleteLoading && deleteTarget?.id === site.id" :title="`删除 ${site.name}`" :aria-label="`删除 ${site.name}`" @click="openDelete(site)">
                    <Trash2 :size="16" aria-hidden="true" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="filteredSites.length" class="mobile-site-list">
        <article v-for="site in paginatedSites" :key="site.id" class="mobile-site-item">
          <div class="mobile-site-head">
            <RouterLink :to="`/sites/${site.id}`">
              <strong>{{ site.name }}</strong>
              <span>{{ site.adapter_type }} · {{ site.base_url }}</span>
            </RouterLink>
            <div class="mobile-head-actions">
              <RouterLink class="icon-btn" :to="`/sites/${site.id}`" :title="`查看 ${site.name} 详情`" :aria-label="`查看 ${site.name} 详情`">
                <ExternalLink :size="16" aria-hidden="true" />
              </RouterLink>
              <button class="icon-btn icon-btn-danger" type="button" :disabled="deleteLoading && deleteTarget?.id === site.id" :title="`删除 ${site.name}`" :aria-label="`删除 ${site.name}`" @click="openDelete(site)">
                <Trash2 :size="16" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div class="mobile-statuses">
            <StatusBadge :status="site.service_status" />
            <StatusBadge :status="site.auth_status" />
          </div>
          <dl class="mobile-site-stats">
            <div><dt>余额</dt><dd>{{ site.balance ? formatMoney(site.balance.value, site.balance.currency) : '—' }}</dd></div>
            <div><dt>延迟</dt><dd>{{ site.latency_ms ? `${site.latency_ms} ms` : '—' }}</dd></div>
            <div><dt>24h 可用率</dt><dd>{{ site.uptime_24h ? `${site.uptime_24h}%` : '—' }}</dd></div>
          </dl>
          <p v-if="site.last_error" class="mobile-error">{{ site.last_error }}</p>
          <button class="btn btn-secondary" type="button" :disabled="checkingId === site.id" @click="runCheck(site)">
            <Play :size="15" aria-hidden="true" />立即检查
          </button>
        </article>
      </div>

      <PaginationControls v-if="filteredSites.length" v-model:page="page" v-model:page-size="pageSize" :total="filteredSites.length" />

      <EmptyState v-if="!loading && !filteredSites.length" title="没有匹配的站点" description="调整筛选条件，或添加第一个中转站。">
        <RouterLink class="btn btn-primary" to="/sites/new"><Plus :size="16" aria-hidden="true" />添加站点</RouterLink>
      </EmptyState>
    </section>

    <ConfirmDeleteDialog
      :open="deleteTarget !== null"
      title="删除中转站？"
      description="该站点的采集任务将停止，已保存凭据和关联配置也会被移除。"
      :item-name="deleteTarget?.name ?? ''"
      :loading="deleteLoading"
      :error="deleteError"
      @cancel="closeDelete"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.sites-surface {
  overflow: hidden;
}

.compact-filter {
  min-width: 145px !important;
}

.compact-filter .select {
  min-height: 34px;
  padding-top: 6px;
  padding-bottom: 6px;
}

.filter-count {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0 2px 8px auto;
  color: var(--text-tertiary);
  font-size: 12px;
}

.site-table {
  min-width: 1120px;
}

.site-link {
  display: flex;
  min-width: 210px;
  max-width: 330px;
  align-items: center;
  gap: 9px;
  color: var(--text);
  text-decoration: none;
}

.site-link:hover strong {
  color: var(--accent);
}

.site-link > span:last-child {
  min-width: 0;
}

.site-link strong,
.site-link small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.site-link strong {
  font-size: 14px;
}

.site-link small {
  margin-top: 2px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.site-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  place-items: center;
  border-radius: 5px;
  background: var(--accent-soft);
  color: var(--accent);
}

.site-tags {
  margin: 7px 0 0 39px;
}

.row-actions {
  display: flex;
  gap: 6px;
}

.mobile-head-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.mobile-site-list {
  display: none;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

@media (max-width: 900px) {
  .desktop-site-table {
    display: none;
  }

  .mobile-site-list {
    display: grid;
  }

  .mobile-site-item {
    padding: 14px;
    border-bottom: 1px solid var(--border);
  }

  .mobile-site-item:last-child {
    border-bottom: 0;
  }

  .mobile-site-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 10px;
  }

  .mobile-site-head > a:first-child {
    min-width: 0;
    text-decoration: none;
  }

  .mobile-site-head strong,
  .mobile-site-head span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile-site-head span {
    margin-top: 3px;
    color: var(--text-tertiary);
    font-size: 12px;
  }

  .mobile-statuses {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }

  .mobile-site-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin: 13px 0;
  }

  .mobile-site-stats div {
    min-width: 0;
  }

  .mobile-site-stats dt {
    color: var(--text-tertiary);
    font-size: 12px;
  }

  .mobile-site-stats dd {
    margin: 2px 0 0;
    overflow-wrap: anywhere;
    font-size: 14px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }

  .mobile-error {
    margin: 0 0 12px;
    color: var(--danger);
    font-size: 13px;
  }

  .mobile-site-item > .btn {
    width: 100%;
  }
}

@media (max-width: 430px) {
  .filter-count {
    width: 100%;
    margin-left: 0;
  }

  .mobile-site-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
