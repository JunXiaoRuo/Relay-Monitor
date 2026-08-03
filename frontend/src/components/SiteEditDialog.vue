<script setup lang="ts">
import { Edit3, LoaderCircle, Save, ShieldCheck, X } from '@lucide/vue';
import { nextTick, onUnmounted, reactive, ref, useId, watch } from 'vue';

import type { MonitorConfigDto } from '../../../shared/types';
import { api } from '../services/api';
import type { RateGroupScope, SiteViewModel, Sub2ApiGroup } from '../types/domain';
import RateGroupSelector from './RateGroupSelector.vue';
import TokenLoginHelper from './TokenLoginHelper.vue';
import ToggleSwitch from './ToggleSwitch.vue';

const props = defineProps<{
  open: boolean;
  site: SiteViewModel | null;
  monitors: MonitorConfigDto[];
}>();

const emit = defineEmits<{
  close: [];
  saved: [site: SiteViewModel, monitors: MonitorConfigDto[]];
}>();

const titleId = `site-edit-${useId()}`;
const closeButton = ref<HTMLButtonElement | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const groups = ref<Sub2ApiGroup[]>([]);
const groupsLoading = ref(false);
const groupMessage = ref<string | null>(null);
const groupScopeMode = ref<RateGroupScope['mode']>('all');
const selectedGroupIds = ref<string[]>([]);
const monitorForm = ref<MonitorConfigDto[]>([]);
let previousBodyOverflow = '';
let loadSequence = 0;

const form = reactive({
  name: '',
  base_url: '',
  enabled: true,
  tls_verify: true,
  tags: '',
  notes: '',
});

const credentials = reactive({
  mode: 'token' as 'token' | 'password',
  email: '',
  password: '',
  access_token: '',
  refresh_token: '',
  persist_password: false,
});

function populate(): void {
  const site = props.site;
  if (!site) return;
  form.name = site.name;
  form.base_url = site.base_url;
  form.enabled = site.enabled ?? true;
  form.tls_verify = site.tls_verify ?? true;
  form.tags = site.tags.join(', ');
  form.notes = site.notes ?? '';
  groupScopeMode.value = site.rate_group_scope?.mode ?? 'all';
  selectedGroupIds.value = [...(site.rate_group_scope?.group_ids ?? [])];
  monitorForm.value = props.monitors.map((monitor) => ({ ...monitor }));
  credentials.mode = site.credential_status?.mode === 'password' ? 'password' : 'token';
  credentials.email = '';
  credentials.password = '';
  credentials.access_token = '';
  credentials.refresh_token = '';
  credentials.persist_password = false;
  error.value = null;
  groupMessage.value = null;
}

async function loadGroups(): Promise<void> {
  const site = props.site;
  if (!site) return;
  groupsLoading.value = true;
  const sequence = ++loadSequence;
  try {
    const result = await api.sites.groups(site.id);
    if (sequence !== loadSequence) return;
    groups.value = result.items;
    groupMessage.value = result.items.length ? null : '该站点目前没有返回可用分组。';
  } catch (caught) {
    if (sequence !== loadSequence) return;
    groupMessage.value = caught instanceof Error ? caught.message : '读取站点分组失败';
  } finally {
    if (sequence === loadSequence) groupsLoading.value = false;
  }
}

function hasCredentialInput(): boolean {
  return Boolean(
    credentials.email.trim()
    || credentials.password
    || credentials.access_token
    || credentials.refresh_token,
  );
}

function credentialPayload(): { mode: 'token' | 'password'; values: Record<string, string>; persist_keys: string[] } | null {
  if (!hasCredentialInput()) return null;
  const values: Record<string, string> = {};
  const persistKeys: string[] = [];
  if (credentials.mode === 'password') {
    if (!credentials.email.trim() || !credentials.password) {
      throw new Error('更新账号密码时，邮箱和新密码必须同时填写。');
    }
    values.email = credentials.email.trim();
    values.password = credentials.password;
    persistKeys.push('email');
    if (credentials.persist_password) {
      values.auto_reauthenticate = 'true';
      persistKeys.push('password', 'auto_reauthenticate');
    }
  } else {
    if (!credentials.access_token) throw new Error('更新 Token 时必须填写新的 Access Token。');
    values.access_token = credentials.access_token;
    persistKeys.push('access_token');
    if (credentials.refresh_token) {
      values.refresh_token = credentials.refresh_token;
      persistKeys.push('refresh_token');
    }
  }
  return { mode: credentials.mode, values, persist_keys: persistKeys };
}

async function save(): Promise<void> {
  const current = props.site;
  if (!current) return;
  if (!form.name.trim()) {
    error.value = '站点名称不能为空。';
    return;
  }
  if (!/^https:\/\//i.test(form.base_url.trim())) {
    error.value = 'Base URL 必须使用 HTTPS。';
    return;
  }
  if (groupScopeMode.value === 'selected' && selectedGroupIds.value.length === 0) {
    error.value = '选择“指定分组”时，至少勾选一个分组。';
    return;
  }

  let credentialUpdate: ReturnType<typeof credentialPayload>;
  try {
    credentialUpdate = credentialPayload();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '凭据输入无效';
    return;
  }

  saving.value = true;
  error.value = null;
  try {
    const tags = form.tags.split(',').map((tag) => tag.trim()).filter(Boolean);
    const monitorOverrides = Object.fromEntries(monitorForm.value.map((monitor) => [monitor.monitor_type, {
      enabled: monitor.enabled,
      interval_seconds: monitor.interval_seconds,
      timeout_seconds: monitor.timeout_seconds,
      retry_count: monitor.retry_count,
      retry_interval_seconds: monitor.retry_interval_seconds,
      schedule_jitter_percent: monitor.schedule_jitter_percent,
    }]));
    const updated = await api.sites.update(current.id, {
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      enabled: form.enabled,
      tls_verify: form.tls_verify,
      tags,
      notes: form.notes.trim() || null,
      rate_group_scope: {
        mode: groupScopeMode.value,
        group_ids: groupScopeMode.value === 'selected' ? selectedGroupIds.value : [],
      },
      monitors: monitorOverrides,
      ...(credentialUpdate ? { credentials: credentialUpdate } : {}),
    });
    emit('saved', { ...updated, monitor_configs: monitorForm.value.map((monitor) => ({ ...monitor })) }, monitorForm.value.map((monitor) => ({ ...monitor })));
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '保存站点设置失败';
  } finally {
    saving.value = false;
  }
}

function close(): void {
  if (!saving.value) emit('close');
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      loadSequence += 1;
      document.body.style.overflow = previousBodyOverflow;
      return;
    }
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    populate();
    loading.value = true;
    await loadGroups();
    loading.value = false;
    await nextTick();
    closeButton.value?.focus();
  },
);

onUnmounted(() => {
  document.body.style.overflow = previousBodyOverflow;
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="edit-backdrop" @click.self="close" @keydown.esc="close">
      <section class="edit-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <header>
          <span class="edit-mark"><Edit3 :size="19" aria-hidden="true" /></span>
          <div><h2 :id="titleId">编辑中转站</h2><p>{{ site?.adapter_type }} · 敏感字段不会回填</p></div>
          <button ref="closeButton" class="icon-btn" type="button" :disabled="saving" title="关闭编辑" aria-label="关闭编辑" @click="close"><X :size="17" aria-hidden="true" /></button>
        </header>
        <div v-if="loading" class="loading-line" />

        <div class="edit-scroll">
          <div v-if="error" class="notice notice-danger" role="alert">{{ error }}</div>

          <section class="edit-section">
            <div class="section-copy"><h3>基本信息</h3><p>修改地址时服务端会重新执行出站安全校验。</p></div>
            <div class="form-grid">
              <div class="field"><label for="edit-site-name">显示名称</label><input id="edit-site-name" v-model="form.name" class="input" maxlength="120" /></div>
              <div class="field toggle-field"><span class="field-label">站点状态</span><ToggleSwitch v-model="form.enabled" :label="form.enabled ? '停用站点' : '启用站点'" /></div>
              <div class="field span-2"><label for="edit-base-url">Base URL</label><input id="edit-base-url" v-model="form.base_url" class="input mono" type="url" /></div>
              <div class="field"><label for="edit-tags">标签</label><input id="edit-tags" v-model="form.tags" class="input" placeholder="production, primary" /></div>
              <div class="field toggle-field"><span class="field-label">传输安全</span><ToggleSwitch v-model="form.tls_verify" label="验证 TLS 证书" /></div>
              <div class="field span-2"><label for="edit-notes">备注</label><textarea id="edit-notes" v-model="form.notes" class="textarea" maxlength="4000" /></div>
            </div>
          </section>

          <section class="edit-section">
            <div class="section-copy"><h3>倍率分组范围</h3><p>全部分组会自动包含后续新增项；指定分组只采集勾选对象。</p></div>
            <RateGroupSelector v-model:mode="groupScopeMode" v-model:selected-ids="selectedGroupIds" :groups="groups" :disabled="groupsLoading" />
            <div v-if="groupMessage" class="notice">{{ groupMessage }}</div>
          </section>

          <section class="edit-section">
            <div class="section-copy"><h3>监控任务</h3><p>每类任务独立设置检查周期、单次请求超时和最终告警前的失败重试。</p></div>
            <div class="edit-monitor-list">
              <article v-for="monitor in monitorForm" :key="monitor.monitor_type">
                <div><strong>{{ { connectivity: '连通性', rates: '倍率', balance: '余额', auth: '登录状态' }[monitor.monitor_type] }}</strong><small>{{ monitor.monitor_type }}</small></div>
                <ToggleSwitch v-model="monitor.enabled" :label="monitor.enabled ? '关闭监控' : '开启监控'" />
                <div class="field"><label :for="`edit-interval-${monitor.monitor_type}`">间隔（秒）</label><input :id="`edit-interval-${monitor.monitor_type}`" v-model.number="monitor.interval_seconds" class="input numeric" type="number" min="10" max="86400" /></div>
                <div class="field"><label :for="`edit-timeout-${monitor.monitor_type}`">超时（秒）</label><input :id="`edit-timeout-${monitor.monitor_type}`" v-model.number="monitor.timeout_seconds" class="input numeric" type="number" min="1" max="120" /></div>
                <div class="field"><label :for="`edit-retry-count-${monitor.monitor_type}`">失败重试次数</label><input :id="`edit-retry-count-${monitor.monitor_type}`" v-model.number="monitor.retry_count" class="input numeric" type="number" min="0" max="10" /></div>
                <div class="field"><label :for="`edit-retry-interval-${monitor.monitor_type}`">失败重试间隔（秒）</label><input :id="`edit-retry-interval-${monitor.monitor_type}`" v-model.number="monitor.retry_interval_seconds" class="input numeric" type="number" min="0" max="3600" :disabled="monitor.retry_count === 0" /></div>
              </article>
            </div>
          </section>

          <section class="edit-section">
            <div class="section-copy"><h3>可选凭据更新</h3><p>所有字段留空表示不修改现有凭据；填写时必须提供一套完整的新认证组合。</p></div>
            <div class="credential-mode" role="radiogroup" aria-label="新凭据类型"><label><input v-model="credentials.mode" type="radio" value="token" />Token</label><label><input v-model="credentials.mode" type="radio" value="password" />账号密码</label></div>
            <div class="form-grid">
              <template v-if="credentials.mode === 'token'">
                <TokenLoginHelper class="span-2" :base-url="form.base_url" />
                <div class="field span-2"><label for="edit-access-token">新 Access Token</label><input id="edit-access-token" v-model="credentials.access_token" class="input mono" type="password" autocomplete="new-password" /></div>
                <div class="field span-2"><label for="edit-refresh-token">新 Refresh Token（可选）</label><input id="edit-refresh-token" v-model="credentials.refresh_token" class="input mono" type="password" autocomplete="new-password" /></div>
              </template>
              <template v-else>
                <div class="field"><label for="edit-email">登录邮箱</label><input id="edit-email" v-model="credentials.email" class="input" type="email" autocomplete="off" /></div>
                <div class="field"><label for="edit-password">新密码</label><input id="edit-password" v-model="credentials.password" class="input" type="password" autocomplete="new-password" /></div>
                <div class="field span-2"><ToggleSwitch v-model="credentials.persist_password" label="加密保存密码并允许自动重新登录" /></div>
              </template>
            </div>
            <div class="notice"><ShieldCheck :size="17" aria-hidden="true" />分组实测 Key 在倍率页单独管理，不再使用站点级单 Key。</div>
          </section>
        </div>

        <footer><button class="btn btn-secondary" type="button" :disabled="saving" @click="close">取消</button><button class="btn btn-primary" type="button" :disabled="saving || loading" @click="save"><LoaderCircle v-if="saving" :size="16" class="spin" aria-hidden="true" /><Save v-else :size="16" aria-hidden="true" />{{ saving ? '正在保存…' : '保存全部设置' }}</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.edit-backdrop { position: fixed; z-index: 125; inset: 0; display: grid; place-items: center; padding: 18px; background: rgb(12 18 16 / 54%); }
.edit-dialog { display: grid; width: min(920px, 100%); max-height: calc(100vh - 36px); grid-template-rows: auto auto minmax(0, 1fr) auto; overflow: hidden; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--surface); box-shadow: 0 22px 60px rgb(10 24 20 / 24%); }
.edit-dialog > header { grid-row: 1; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 15px 18px; border-bottom: 1px solid var(--border); }
.edit-dialog > .loading-line { grid-row: 2; }
.edit-mark { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 6px; background: var(--accent-soft); color: var(--accent); }
.edit-dialog h2 { margin: 0; font-size: 18px; }
.edit-dialog header p { margin: 2px 0 0; color: var(--text-tertiary); font-size: 12px; }
.edit-scroll { grid-row: 3; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.edit-scroll > .notice { margin: 14px 18px 0; }
.edit-section { padding: 18px; border-bottom: 1px solid var(--border); }
.edit-section:last-child { border-bottom: 0; }
.section-copy { margin-bottom: 14px; }
.section-copy h3 { margin: 0; font-size: 15px; }
.section-copy p { margin: 2px 0 0; color: var(--text-tertiary); font-size: 12px; }
.toggle-field { align-content: start; }
.edit-section > .notice { margin-top: 12px; }
.edit-monitor-list { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; }
.edit-monitor-list article { display: grid; grid-template-columns: minmax(110px, 1fr) auto repeat(4, minmax(96px, 118px)); align-items: end; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.edit-monitor-list article:last-child { border-bottom: 0; }
.edit-monitor-list article > div:first-child { align-self: center; }
.edit-monitor-list strong,
.edit-monitor-list small { display: block; }
.edit-monitor-list strong { font-size: 13px; }
.edit-monitor-list small { color: var(--text-tertiary); font-size: 10px; }
.credential-mode { display: flex; gap: 16px; margin-bottom: 14px; }
.credential-mode label { display: flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 650; }
.credential-mode input { accent-color: var(--accent); }
.edit-dialog > footer { z-index: 1; grid-row: 4; display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border); background: var(--surface-subtle); }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 700px) {
  .edit-backdrop { align-items: end; padding: 0; }
  .edit-dialog { width: 100%; max-height: 96vh; max-height: 96dvh; border-right: 0; border-bottom: 0; border-left: 0; border-radius: 7px 7px 0 0; }
  .edit-dialog > header,
  .edit-section { padding-right: 14px; padding-left: 14px; }
  .edit-dialog > footer { padding-right: 14px; padding-bottom: max(12px, env(safe-area-inset-bottom)); padding-left: 14px; }
  .edit-monitor-list article { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: center; }
  .edit-monitor-list article > :nth-child(2) { justify-self: end; }
  .edit-monitor-list article .field { grid-column: span 1; }
}

@media (max-width: 430px) {
  .edit-mark { display: none; }
  .edit-dialog > header { grid-template-columns: minmax(0, 1fr) auto; }
  .edit-monitor-list article { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
  .edit-monitor-list article .field { grid-column: span 1; }
  .edit-dialog > footer .btn { flex: 1 1 0; }
}
</style>
