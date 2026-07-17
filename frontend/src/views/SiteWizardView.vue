<script setup lang="ts">
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  KeyRound,
  LoaderCircle,
  Radar,
  RefreshCw,
  Server,
  ShieldCheck,
} from '@lucide/vue';
import { computed, reactive, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import PageHeader from '../components/PageHeader.vue';
import RateGroupSelector from '../components/RateGroupSelector.vue';
import TokenLoginHelper from '../components/TokenLoginHelper.vue';
import ToggleSwitch from '../components/ToggleSwitch.vue';
import { api } from '../services/api';
import type { ProbeKeyMappingInput, RateGroupScope, Sub2ApiGroup, UpstreamApiKey } from '../types/domain';

const router = useRouter();
const step = ref(1);
const discovering = ref(false);
const discoveryMessage = ref<string | null>(null);
const discoveryError = ref(false);
const submitting = ref(false);
const submitMessage = ref<string | null>(null);
const submitError = ref(false);
const groups = ref<Sub2ApiGroup[]>([]);
const groupsLoading = ref(false);
const groupsMessage = ref<string | null>(null);
const groupsError = ref(false);
const groupScopeMode = ref<RateGroupScope['mode']>('all');
const selectedGroupIds = ref<string[]>([]);
const upstreamApiKeys = ref<UpstreamApiKey[]>([]);
const apiKeysLoading = ref(false);
const apiKeysMessage = ref<string | null>(null);
const apiKeysError = ref(false);
const keyMappings = reactive<Record<string, ProbeKeyMappingInput>>({});

const form = reactive({
  adapter_type: 'sub2api',
  name: '',
  base_url: '',
  tags: '',
  notes: '',
  tls_verify: true,
  credential_mode: 'password' as 'password' | 'token',
  email: '',
  password: '',
  access_token: '',
  refresh_token: '',
  persist_password: false,
});

const monitors = reactive([
  { type: 'connectivity', label: '连通性监控', enabled: true, interval_seconds: 300, timeout_seconds: 15, retry_count: 1, retry_interval_seconds: 60, detail: '模型 API 链路与延迟' },
  { type: 'rates', label: '倍率监控', enabled: true, interval_seconds: 300, timeout_seconds: 15, retry_count: 1, retry_interval_seconds: 60, detail: '完整倍率快照与变化' },
  { type: 'balance', label: '余额监控', enabled: true, interval_seconds: 300, timeout_seconds: 15, retry_count: 1, retry_interval_seconds: 60, detail: '余额与消耗趋势' },
  { type: 'auth', label: '登录状态监控', enabled: true, interval_seconds: 300, timeout_seconds: 15, retry_count: 1, retry_interval_seconds: 60, detail: 'Token 有效期与刷新' },
]);

const selectedGroups = computed(() => groupScopeMode.value === 'all'
  ? groups.value
  : groups.value.filter((group) => selectedGroupIds.value.includes(group.id)));
const credentialsReady = computed(() => form.credential_mode === 'password'
  ? Boolean(form.email.trim() && form.password)
  : Boolean(form.access_token));

const canContinue = computed(() => {
  if (step.value === 1) return form.name.trim().length > 0 && /^https:\/\//i.test(form.base_url.trim());
  if (step.value === 2) {
    return credentialsReady.value && (groupScopeMode.value === 'all' || selectedGroupIds.value.length > 0);
  }
  return true;
});

async function discover(): Promise<void> {
  if (!/^https:\/\//i.test(form.base_url.trim())) {
    discoveryError.value = true;
    discoveryMessage.value = 'Base URL 必须使用 HTTPS。';
    return;
  }
  discovering.value = true;
  discoveryMessage.value = null;
  discoveryError.value = false;
  try {
    await api.adapters.discover({ adapter_type: form.adapter_type, base_url: form.base_url.trim() });
    discoveryMessage.value = '能力探测通过，可以继续配置认证。';
  } catch (caught) {
    discoveryError.value = true;
    discoveryMessage.value = caught instanceof Error ? caught.message : '能力探测失败';
  }
  discovering.value = false;
}

function credentialValues(): Record<string, string> {
  if (form.credential_mode === 'password') {
    return { email: form.email.trim(), password: form.password };
  }
  return {
    access_token: form.access_token,
    ...(form.refresh_token ? { refresh_token: form.refresh_token } : {}),
  };
}

function discoveryBody() {
  return {
    adapter_type: form.adapter_type,
    base_url: form.base_url.trim(),
    credentials: { mode: form.credential_mode, values: credentialValues() },
  };
}

function ensureKeyMappings(items: Sub2ApiGroup[]): void {
  for (const group of items) {
    keyMappings[group.id] ??= {
      group_id: group.id,
      mode: 'none',
      quota_limit: null,
      expires_in_seconds: null,
    };
  }
}

async function discoverGroups(): Promise<void> {
  groupsLoading.value = true;
  groupsMessage.value = null;
  groupsError.value = false;
  try {
    const result = await api.sites.discoverGroups(discoveryBody());
    groups.value = result.items;
    ensureKeyMappings(result.items);
    selectedGroupIds.value = selectedGroupIds.value.filter((id) => result.items.some((group) => group.id === id));
    groupsMessage.value = result.items.length ? `已读取 ${result.items.length} 个可用分组。` : '认证成功，但上游没有返回可用分组。';
  } catch (caught) {
    groupsError.value = true;
    groupsMessage.value = caught instanceof Error ? caught.message : '获取分组失败';
  } finally {
    groupsLoading.value = false;
  }
}

async function discoverApiKeys(): Promise<void> {
  apiKeysLoading.value = true;
  apiKeysMessage.value = null;
  apiKeysError.value = false;
  try {
    const result = await api.sites.discoverApiKeys(discoveryBody());
    upstreamApiKeys.value = result.items;
    apiKeysMessage.value = result.items.length ? `已读取 ${result.items.length} 个上游 Key（仅显示掩码元数据）。` : '没有可复用的上游 Key，可留空或自动创建。';
  } catch (caught) {
    apiKeysError.value = true;
    apiKeysMessage.value = caught instanceof Error ? caught.message : '获取上游 API Key 失败';
  } finally {
    apiKeysLoading.value = false;
  }
}

function keysForGroup(groupId: string): UpstreamApiKey[] {
  return upstreamApiKeys.value.filter((key) => key.status === 'active' && key.group_id === groupId);
}

function next(): void {
  if (canContinue.value && step.value < 3) step.value += 1;
}

function previous(): void {
  if (step.value > 1) step.value -= 1;
}

async function submit(): Promise<void> {
  submitting.value = true;
  submitMessage.value = null;
  submitError.value = false;
  const invalidMapping = selectedGroups.value.find((group) => {
    const mapping = keyMappings[group.id];
    return mapping?.mode === 'existing' && !mapping.upstream_key_id;
  });
  if (invalidMapping) {
    submitError.value = true;
    submitMessage.value = `${invalidMapping.name} 选择了复用上游 Key，但尚未指定具体 Key。`;
    submitting.value = false;
    return;
  }
  const invalidAutoQuota = selectedGroups.value.find((group) => {
    const quota = keyMappings[group.id]?.quota_limit;
    return keyMappings[group.id]?.mode === 'auto_create'
      && quota !== null
      && quota !== ''
      && quota !== undefined
      && (!Number.isFinite(quota) || quota < 0.1 || quota > 10);
  });
  if (invalidAutoQuota) {
    submitError.value = true;
    submitMessage.value = `${invalidAutoQuota.name} 的额度上限必须在 0.1 到 10 USD 之间，或留空表示不限额。`;
    submitting.value = false;
    return;
  }

  const values: Record<string, string> = {};
  const persistKeys: string[] = [];
  if (form.credential_mode === 'password') {
    values.email = form.email.trim();
    values.password = form.password;
    persistKeys.push('email');
    if (form.persist_password) persistKeys.push('password');
  } else {
    values.access_token = form.access_token;
    persistKeys.push('access_token');
    if (form.refresh_token) {
      values.refresh_token = form.refresh_token;
      persistKeys.push('refresh_token');
    }
  }
  try {
    const monitorOverrides = Object.fromEntries(monitors.map((monitor) => [monitor.type, {
      enabled: monitor.enabled,
      interval_seconds: monitor.interval_seconds,
      timeout_seconds: monitor.timeout_seconds,
      retry_count: monitor.retry_count,
      retry_interval_seconds: monitor.retry_interval_seconds,
      schedule_jitter_percent: 10,
    }]));
    const probeKeyMappings = selectedGroups.value
      .map((group) => keyMappings[group.id])
      .filter((mapping): mapping is ProbeKeyMappingInput & { mode: 'existing' | 'auto_create' } => (
        Boolean(mapping && mapping.mode !== 'none')
      ))
      .map((mapping) => ({
        group_id: mapping.group_id,
        mode: mapping.mode,
        ...(mapping.upstream_key_id ? { upstream_key_id: mapping.upstream_key_id } : {}),
        ...(typeof mapping.quota_limit === 'number' ? { quota_limit: mapping.quota_limit } : {}),
        ...(typeof mapping.expires_in_seconds === 'number'
          ? { expires_in_seconds: mapping.expires_in_seconds }
          : {}),
      }));
    const created = await api.sites.create({
      name: form.name.trim(),
      adapter_type: form.adapter_type,
      base_url: form.base_url.trim(),
      tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      notes: form.notes.trim(),
      tls_verify: form.tls_verify,
      credentials: {
        mode: form.credential_mode,
        values,
        persist_keys: persistKeys,
      },
      monitors: monitorOverrides,
      rate_group_scope: {
        mode: groupScopeMode.value,
        group_ids: groupScopeMode.value === 'selected' ? selectedGroupIds.value : [],
      },
      probe_key_mappings: probeKeyMappings,
    });
    await router.replace(`/sites/${created.id}`);
  } catch (caught) {
    submitError.value = true;
    submitMessage.value = caught instanceof Error ? caught.message : '创建站点失败';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="page wizard-page">
    <PageHeader title="添加中转站" description="先探测适配器能力，再安全保存凭据并建立监控基线。">
      <template #actions>
        <RouterLink class="btn btn-secondary" to="/sites"><ArrowLeft :size="16" aria-hidden="true" />返回站点</RouterLink>
      </template>
    </PageHeader>

    <ol class="wizard-steps" aria-label="添加步骤">
      <li v-for="item in 3" :key="item" :class="{ active: step === item, complete: step > item }">
        <span><Check v-if="step > item" :size="14" aria-hidden="true" /><template v-else>{{ item }}</template></span>
        <div>
          <strong>{{ item === 1 ? '站点与探测' : item === 2 ? '认证凭据' : '监控基线' }}</strong>
          <small>{{ item === 1 ? '地址和适配器' : item === 2 ? '安全登录方式' : '独立任务配置' }}</small>
        </div>
      </li>
    </ol>

    <section class="surface wizard-surface">
      <div v-if="step === 1" class="wizard-panel">
        <div class="panel-intro">
          <span class="intro-icon"><Server :size="20" aria-hidden="true" /></span>
          <div><h2>站点基本信息</h2><p>V1 提供经过契约测试的 Sub2API 内置适配器。</p></div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="adapter">站点类型</label>
            <select id="adapter" v-model="form.adapter_type" class="select">
              <option value="sub2api">Sub2API</option>
            </select>
          </div>
          <div class="field">
            <label for="site-name">显示名称</label>
            <input id="site-name" v-model="form.name" class="input" placeholder="例如：北辰主站" maxlength="120" />
          </div>
          <div class="field span-2">
            <label for="base-url">Base URL</label>
            <div class="url-field">
              <input id="base-url" v-model="form.base_url" class="input" type="url" placeholder="https://relay.example.com" />
              <button class="btn btn-secondary" type="button" :disabled="discovering || !form.base_url" @click="discover">
                <Radar :size="16" aria-hidden="true" />{{ discovering ? '探测中…' : '安全探测' }}
              </button>
            </div>
            <span class="field-hint">服务端会执行 SSRF、DNS、重定向和 TLS 校验。</span>
          </div>
          <div class="field">
            <label for="tags">标签</label>
            <input id="tags" v-model="form.tags" class="input" placeholder="production, primary" />
          </div>
          <div class="field toggle-field">
            <span class="field-label">传输安全</span>
            <ToggleSwitch v-model="form.tls_verify" label="验证 TLS 证书" />
          </div>
          <div class="field span-2">
            <label for="notes">备注</label>
            <textarea id="notes" v-model="form.notes" class="textarea" placeholder="运维联系人、用途或切换说明" maxlength="4000" />
          </div>
        </div>
        <div v-if="discoveryMessage" class="notice" :class="discoveryError ? 'notice-danger' : 'notice-success'" role="status">
          {{ discoveryMessage }}
        </div>
      </div>

      <div v-else-if="step === 2" class="wizard-panel">
        <div class="panel-intro">
          <span class="intro-icon"><KeyRound :size="20" aria-hidden="true" /></span>
          <div><h2>认证方式</h2><p>凭据只发送到本系统 API，并由服务端加密保存。</p></div>
        </div>
        <div class="credential-mode" role="radiogroup" aria-label="认证方式">
          <label :class="{ selected: form.credential_mode === 'password' }">
            <input v-model="form.credential_mode" type="radio" value="password" />
            <span><strong>账号密码</strong><small>支持 Token 刷新；可选自动重新登录</small></span>
          </label>
          <label :class="{ selected: form.credential_mode === 'token' }">
            <input v-model="form.credential_mode" type="radio" value="token" />
            <span><strong>手动 Token</strong><small>默认推荐，不持久保存账户密码</small></span>
          </label>
        </div>

        <div v-if="form.credential_mode === 'password'" class="form-grid credentials-grid">
          <div class="field">
            <label for="email">登录邮箱</label>
            <input id="email" v-model="form.email" class="input" type="email" autocomplete="off" />
          </div>
          <div class="field">
            <label for="upstream-password">上游密码</label>
            <input id="upstream-password" v-model="form.password" class="input" type="password" autocomplete="new-password" />
          </div>
          <div class="field span-2 toggle-field">
            <ToggleSwitch v-model="form.persist_password" label="加密保存密码，Token 失效后允许自动重新登录" />
            <span class="field-hint">关闭时采用 Token 优先模式，Token 全部失效后需要人工处理。</span>
          </div>
        </div>

        <div v-else class="form-grid credentials-grid">
          <TokenLoginHelper class="span-2" :base-url="form.base_url" />
          <div class="field span-2">
            <label for="access-token">Access Token</label>
            <input id="access-token" v-model="form.access_token" class="input mono" type="password" autocomplete="off" />
          </div>
          <div class="field span-2">
            <label for="refresh-token">Refresh Token（可选）</label>
            <input id="refresh-token" v-model="form.refresh_token" class="input mono" type="password" autocomplete="off" />
          </div>
        </div>

        <div class="notice">
          <ShieldCheck :size="17" aria-hidden="true" />
          遇到 TOTP 会进入一次性验证码流程；Turnstile 会明确标记为需要人工处理，系统不会尝试绕过。
        </div>

        <section class="credential-discovery">
          <div class="subsection-heading">
            <div><h3>倍率分组范围</h3><p>使用上面的认证信息读取 Sub2API 分组；只展示名称、平台和倍率。</p></div>
            <button class="btn btn-secondary" type="button" :disabled="groupsLoading || !credentialsReady" @click="discoverGroups">
              <LoaderCircle v-if="groupsLoading" :size="16" class="spin" aria-hidden="true" />
              <RefreshCw v-else :size="16" aria-hidden="true" />
              {{ groupsLoading ? '正在读取…' : '认证并读取分组' }}
            </button>
          </div>
          <RateGroupSelector v-model:mode="groupScopeMode" v-model:selected-ids="selectedGroupIds" :groups="groups" :disabled="groupsLoading" />
          <div v-if="groupsMessage" class="notice" :class="groupsError ? 'notice-danger' : 'notice-success'" role="status">{{ groupsMessage }}</div>
        </section>
      </div>

      <div v-else class="wizard-panel">
        <div class="panel-intro">
          <span class="intro-icon"><Radar :size="20" aria-hidden="true" /></span>
          <div><h2>建立监控基线</h2><p>四类任务独立启停；首次倍率采集只建立基线，不发送变化通知。</p></div>
        </div>
        <div class="monitor-list">
          <article v-for="monitor in monitors" :key="monitor.type" class="monitor-row">
            <div>
              <strong>{{ monitor.label }}</strong>
              <span>{{ monitor.detail }}</span>
            </div>
            <ToggleSwitch v-model="monitor.enabled" :label="monitor.enabled ? `关闭${monitor.label}` : `开启${monitor.label}`" />
            <div class="interval-field">
              <label :for="`interval-${monitor.type}`">间隔</label>
              <select :id="`interval-${monitor.type}`" v-model="monitor.interval_seconds" class="select" :disabled="!monitor.enabled">
                <option :value="60">1 分钟</option>
                <option :value="300">5 分钟</option>
                <option :value="600">10 分钟</option>
                <option :value="1800">30 分钟</option>
              </select>
            </div>
            <div class="interval-field timeout-field">
              <label :for="`timeout-${monitor.type}`">超时（秒）</label>
              <input :id="`timeout-${monitor.type}`" v-model.number="monitor.timeout_seconds" class="input numeric" type="number" min="1" max="120" step="1" :disabled="!monitor.enabled" />
            </div>
            <div class="interval-field retry-count-field">
              <label :for="`retry-count-${monitor.type}`">失败重试次数</label>
              <input :id="`retry-count-${monitor.type}`" v-model.number="monitor.retry_count" class="input numeric" type="number" min="0" max="10" step="1" :disabled="!monitor.enabled" />
            </div>
            <div class="interval-field retry-interval-field">
              <label :for="`retry-interval-${monitor.type}`">失败重试间隔（秒）</label>
              <input :id="`retry-interval-${monitor.type}`" v-model.number="monitor.retry_interval_seconds" class="input numeric" type="number" min="0" max="3600" step="1" :disabled="!monitor.enabled || monitor.retry_count === 0" />
            </div>
          </article>
        </div>

        <section class="probe-key-setup">
          <div class="subsection-heading">
            <div><h3>分组实测 Key</h3><p>可留空，稍后在倍率页逐个配置；列表只返回掩码元数据，不会返回 Key 明文。</p></div>
            <button class="btn btn-secondary" type="button" :disabled="apiKeysLoading" @click="discoverApiKeys">
              <LoaderCircle v-if="apiKeysLoading" :size="16" class="spin" aria-hidden="true" />
              <KeyRound v-else :size="16" aria-hidden="true" />
              {{ apiKeysLoading ? '正在读取…' : '读取已有 API Keys' }}
            </button>
          </div>
          <div v-if="selectedGroups.length" class="key-mapping-list">
            <article v-for="group in selectedGroups" :key="group.id">
              <div class="mapping-group"><strong>{{ group.name }}</strong><span>{{ group.platform ?? '未分类' }} · 生效倍率 <b class="mono">{{ group.effective_rate }}</b></span></div>
              <div class="field mapping-mode">
                <label :for="`key-mode-${group.id}`">实测 Key</label>
                <select :id="`key-mode-${group.id}`" v-model="keyMappings[group.id]!.mode" class="select">
                  <option value="none">不配置，稍后设置</option>
                  <option value="existing">选择已有上游 Key</option>
                  <option value="auto_create">自动创建并绑定</option>
                </select>
              </div>
              <div v-if="keyMappings[group.id]!.mode === 'existing'" class="field mapping-options">
                <label :for="`existing-key-${group.id}`">已有 Key（掩码）</label>
                <select :id="`existing-key-${group.id}`" v-model="keyMappings[group.id]!.upstream_key_id" class="select">
                  <option value="">请选择</option>
                  <option v-for="key in keysForGroup(group.id)" :key="key.id" :value="key.id">{{ key.name }}{{ key.expires_at ? ` · ${key.expires_at.slice(0, 10)} 到期` : '' }}</option>
                </select>
              </div>
              <div v-else-if="keyMappings[group.id]!.mode === 'auto_create'" class="auto-key-options">
                <div class="field"><label :for="`quota-${group.id}`">额度上限（可选）</label><input :id="`quota-${group.id}`" v-model.number="keyMappings[group.id]!.quota_limit" class="input numeric" type="number" min="0.1" max="10" step="0.1" placeholder="留空表示不限额" /></div>
                <div class="field"><label :for="`expiry-${group.id}`">有效期（可选）</label><select :id="`expiry-${group.id}`" v-model="keyMappings[group.id]!.expires_in_seconds" class="select"><option :value="null">不设置（永不过期）</option><option :value="86400">24 小时</option><option :value="259200">3 天</option><option :value="604800">7 天</option></select></div>
              </div>
            </article>
          </div>
          <div v-else class="notice"><Clock3 :size="17" aria-hidden="true" />尚未读取或选择分组。可以直接创建站点，之后在倍率页配置。</div>
          <div v-if="apiKeysMessage" class="notice" :class="apiKeysError ? 'notice-danger' : 'notice-success'" role="status">{{ apiKeysMessage }}</div>
        </section>

        <dl class="review-list">
          <div><dt>站点</dt><dd>{{ form.name }}</dd></div>
          <div><dt>地址</dt><dd class="mono">{{ form.base_url }}</dd></div>
          <div><dt>认证</dt><dd>{{ form.credential_mode === 'password' ? (form.persist_password ? '全自动模式' : 'Token 优先模式') : '手动 Token' }}</dd></div>
          <div><dt>倍率范围</dt><dd>{{ groupScopeMode === 'all' ? '全部分组' : `指定 ${selectedGroupIds.length} 个分组` }}</dd></div>
          <div><dt>TLS</dt><dd>{{ form.tls_verify ? '严格验证' : '已关闭（不推荐）' }}</dd></div>
        </dl>
        <div v-if="submitMessage" class="notice" :class="submitError ? 'notice-danger' : 'notice-success'" role="status">{{ submitMessage }}</div>
      </div>

      <footer class="wizard-footer">
        <button class="btn btn-secondary" type="button" :disabled="step === 1" @click="previous">
          <ArrowLeft :size="16" aria-hidden="true" />上一步
        </button>
        <span>步骤 {{ step }} / 3</span>
        <button v-if="step < 3" class="btn btn-primary" type="button" :disabled="!canContinue" @click="next">
          下一步<ArrowRight :size="16" aria-hidden="true" />
        </button>
        <button v-else class="btn btn-primary" type="button" :disabled="submitting" @click="submit">
          <Check :size="16" aria-hidden="true" />{{ submitting ? '正在创建…' : '创建并开始采集' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.wizard-page {
  max-width: 1060px;
}

.wizard-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
}

.wizard-steps li {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-tertiary);
}

.wizard-steps li > span {
  display: grid;
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  place-items: center;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  font-size: 13px;
  font-weight: 700;
}

.wizard-steps strong,
.wizard-steps small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wizard-steps strong { font-size: 13px; }
.wizard-steps small { margin-top: 1px; font-size: 12px; }
.wizard-steps li.active { border-color: #9ec8bc; background: var(--accent-soft); color: var(--accent); }
.wizard-steps li.active > span { border-color: var(--accent); background: var(--accent); color: #fff; }
.wizard-steps li.complete { color: var(--success); }
.wizard-steps li.complete > span { border-color: #acd3c0; background: var(--success-soft); color: var(--success); }

.wizard-surface {
  overflow: hidden;
}

.wizard-panel {
  min-height: 520px;
  padding: 24px;
}

.panel-intro {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.intro-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
}

.panel-intro h2 {
  margin: 0;
  font-size: 18px;
}

.panel-intro p {
  margin: 2px 0 0;
  color: var(--text-tertiary);
  font-size: 13px;
}

.url-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.toggle-field {
  align-content: start;
}

.credential-mode {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 22px;
}

.credential-mode label {
  display: flex;
  align-items: start;
  gap: 9px;
  padding: 13px;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}

.credential-mode label.selected {
  border-color: #8bbbae;
  background: var(--accent-soft);
}

.credential-mode input {
  margin-top: 3px;
  accent-color: var(--accent);
}

.credential-mode strong,
.credential-mode small {
  display: block;
}

.credential-mode strong { font-size: 14px; }
.credential-mode small { margin-top: 3px; color: var(--text-tertiary); font-size: 12px; }

.credentials-grid {
  margin-bottom: 20px;
}


.credential-discovery,
.probe-key-setup { margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--border); }
.subsection-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 13px; }
.subsection-heading h3 { margin: 0; font-size: 15px; }
.subsection-heading p { margin: 2px 0 0; color: var(--text-tertiary); font-size: 12px; }
.credential-discovery > .notice,
.probe-key-setup > .notice { margin-top: 12px; }

.monitor-list {
  display: grid;
}

.monitor-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 140px 92px 92px 126px;
  align-items: center;
  gap: 18px;
  min-height: 76px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border);
}

.monitor-row strong,
.monitor-row span {
  display: block;
}

.monitor-row strong { font-size: 14px; }
.monitor-row > div:first-child span { margin-top: 2px; color: var(--text-tertiary); font-size: 12px; }
.interval-field { display: grid; gap: 4px; }
.interval-field label { color: var(--text-tertiary); font-size: 12px; }
.timeout-field .input { min-height: 42px; }
.key-mapping-list { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; }
.key-mapping-list article { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(190px, 0.8fr) minmax(210px, 1fr); align-items: end; gap: 12px; padding: 12px; border-bottom: 1px solid var(--border); }
.key-mapping-list article:last-child { border-bottom: 0; }
.mapping-group { align-self: center; min-width: 0; }
.mapping-group strong,
.mapping-group span { display: block; }
.mapping-group strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.mapping-group span { margin-top: 2px; color: var(--text-tertiary); font-size: 11px; }
.mapping-group b { color: var(--text-secondary); }
.auto-key-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.review-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 24px;
  margin: 20px 0 0;
  padding: 14px;
  background: var(--surface-subtle);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.review-list div {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr);
  gap: 8px;
  padding: 7px 0;
}

.review-list dt { color: var(--text-tertiary); }
.review-list dd { margin: 0; overflow-wrap: anywhere; font-weight: 620; }

.wizard-footer {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
  padding: 14px 24px;
  border-top: 1px solid var(--border);
  background: var(--surface-subtle);
}

.wizard-footer > span {
  color: var(--text-tertiary);
  font-size: 12px;
}

.wizard-footer > .btn:first-child { justify-self: start; }
.wizard-footer > .btn:last-child { justify-self: end; }

@media (min-width: 701px) and (max-width: 1100px) {
  .monitor-row {
    grid-template-columns: minmax(130px, 1fr) auto repeat(2, minmax(120px, 1fr));
    align-items: start;
    gap: 10px 12px;
    padding: 14px 0;
  }

  .monitor-row > div:first-child,
  .monitor-row > :nth-child(2) {
    align-self: center;
    grid-row: 1 / span 2;
  }

  .retry-count-field { grid-column: 3; }
  .retry-interval-field { grid-column: 4; }

  .key-mapping-list article {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
  }

  .mapping-group { grid-column: 1 / -1; }
}

@media (max-width: 700px) {
  .wizard-steps li {
    justify-content: center;
  }

  .wizard-steps li div {
    display: none;
  }

  .wizard-panel {
    min-height: 0;
    padding: 17px;
  }

  .credential-mode {
    grid-template-columns: minmax(0, 1fr);
  }


  .monitor-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .monitor-row > :nth-child(2) { justify-self: end; }

  .interval-field {
    grid-column: auto;
  }

  .key-mapping-list article { grid-template-columns: minmax(0, 1fr); align-items: stretch; }

  .review-list {
    grid-template-columns: minmax(0, 1fr);
  }

  .wizard-footer {
    padding: 12px 16px;
  }
}

@media (max-width: 430px) {
  .url-field {
    grid-template-columns: minmax(0, 1fr);
  }

  .wizard-footer {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .wizard-footer > span {
    display: none;
  }

  .wizard-footer .btn {
    width: 100%;
  }

  .subsection-heading { align-items: stretch; flex-direction: column; }
  .subsection-heading .btn { width: 100%; }
  .monitor-row .interval-field { grid-column: 1 / -1; }
  .auto-key-options { grid-template-columns: minmax(0, 1fr); }
}
</style>
