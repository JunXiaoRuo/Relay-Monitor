<script setup lang="ts">
import {
  Check,
  Copy,
  ExternalLink,
  Globe2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Save,
  ShieldAlert,
  ShieldCheck,
} from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';

import { api } from '../services/api';
import { formatDateTime } from '../services/format';
import type { ServerAccessSettings } from '../types/domain';

const settings = ref<ServerAccessSettings | null>(null);
const protocol = ref<'http' | 'https'>('http');
const accessHost = ref('');
const certificatePem = ref('');
const privateKeyPem = ref('');
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
const copied = ref(false);

const currentBrowserOrigin = window.location.origin;
const hasNewCertificate = computed(() => certificatePem.value.trim().length > 0);
const hasNewPrivateKey = computed(() => privateKeyPem.value.trim().length > 0);
const certificatePairComplete = computed(() => hasNewCertificate.value === hasNewPrivateKey.value);
const nextAddress = computed(() => {
  const host = accessHost.value.trim();
  const port = settings.value?.listen_port;
  if (!host || !port) return '—';
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const defaultPort = (protocol.value === 'http' && port === 80) || (protocol.value === 'https' && port === 443);
  return `${protocol.value}://${urlHost}${defaultPort ? '' : `:${port}`}`;
});
const canSave = computed(() => {
  if (loading.value || saving.value || !accessHost.value.trim() || !certificatePairComplete.value) return false;
  if (protocol.value === 'https' && !settings.value?.certificate.configured && !hasNewCertificate.value) return false;
  return true;
});

function applySettings(next: ServerAccessSettings): void {
  settings.value = next;
  protocol.value = next.protocol;
  accessHost.value = next.access_host;
  certificatePem.value = '';
  privateKeyPem.value = '';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    applySettings(await api.settings.serverAccess());
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '访问方式加载失败。';
  } finally {
    loading.value = false;
  }
}

async function copyAddress(): Promise<void> {
  const value = currentBrowserOrigin;
  try {
    let copiedWithClipboard = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        copiedWithClipboard = true;
      } catch {
        // HTTP and older browsers may reject the Clipboard API; use the local fallback below.
      }
    }
    if (!copiedWithClipboard) {
      const textarea = document.createElement('textarea');
      try {
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        if (!document.execCommand('copy')) throw new Error('copy failed');
      } finally {
        textarea.remove();
      }
    }
    copied.value = true;
    window.setTimeout(() => { copied.value = false; }, 1_500);
  } catch {
    error.value = '地址复制失败，请手动选择复制。';
  }
}

async function save(): Promise<void> {
  error.value = null;
  message.value = null;
  if (!certificatePairComplete.value) {
    error.value = '服务器证书和私钥必须同时填写，或同时留空。';
    return;
  }
  if (protocol.value === 'https' && !settings.value?.certificate.configured && !hasNewCertificate.value) {
    error.value = '启用 HTTPS 前需要填写服务器证书和私钥。';
    return;
  }

  saving.value = true;
  try {
    const next = await api.settings.updateServerAccess({
      protocol: protocol.value,
      access_host: accessHost.value.trim(),
      ...(hasNewCertificate.value ? {
        certificate_pem: certificatePem.value.trim(),
        private_key_pem: privateKeyPem.value.trim(),
      } : {}),
    });
    applySettings(next);
    if (next.restarting) {
      message.value = `设置已保存，服务正在重启。请稍候使用 ${next.next_url} 重新登录。`;
    } else if (next.restart_required) {
      message.value = '设置已保存，需要重启 Relay Monitor 服务后生效。';
    } else {
      message.value = '访问设置已保存。';
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '访问设置保存失败。';
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="surface access-settings">
    <div class="surface-header">
      <div>
        <h2 class="surface-title">访问方式</h2>
        <p class="surface-subtitle">管理台和 API 使用同一个服务端口；协议切换后需要重新登录。</p>
      </div>
      <Globe2 :size="18" class="muted" aria-hidden="true" />
    </div>

    <div v-if="loading" class="loading-line" />
    <div class="access-body">
      <div v-if="error" class="notice notice-danger" role="alert">{{ error }}</div>
      <div v-if="message" class="notice notice-success" role="status">
        {{ message }}
        <a v-if="settings?.restart_required || settings?.restarting" class="notice-link" :href="settings.next_url">
          打开新地址 <ExternalLink :size="13" aria-hidden="true" />
        </a>
      </div>

      <div v-if="settings" class="access-summary">
        <div>
          <span>当前地址</span>
          <strong class="mono address-value" :title="currentBrowserOrigin">{{ currentBrowserOrigin }}</strong>
          <button class="icon-copy" type="button" :title="copied ? '已复制' : '复制当前地址'" :aria-label="copied ? '当前地址已复制' : '复制当前地址'" @click="copyAddress">
            <Check v-if="copied" :size="14" aria-hidden="true" />
            <Copy v-else :size="14" aria-hidden="true" />
          </button>
        </div>
        <div><span>运行协议</span><strong>{{ settings.active_protocol.toUpperCase() }}</strong></div>
        <div><span>监听端口</span><strong class="mono">{{ settings.listen_host }}:{{ settings.listen_port }}</strong></div>
        <div>
          <span>配置状态</span>
          <strong :class="settings.restart_required ? 'text-warning' : 'text-success'">
            {{ settings.restart_required ? '等待重启生效' : '已生效' }}
          </strong>
        </div>
      </div>

      <form class="access-form" @submit.prevent="save">
        <div class="field protocol-field">
          <label>访问协议</label>
          <div class="segment-control" role="radiogroup" aria-label="访问协议">
            <label :class="{ active: protocol === 'http' }">
              <input v-model="protocol" type="radio" value="http" />
              HTTP
            </label>
            <label :class="{ active: protocol === 'https' }">
              <input v-model="protocol" type="radio" value="https" />
              HTTPS
            </label>
          </div>
          <span class="field-hint">HTTP 只适合受信局域网；账号密码、会话和管理数据不会加密传输。</span>
        </div>

        <div class="field">
          <label for="server-access-host">访问主机</label>
          <input id="server-access-host" v-model="accessHost" class="input mono" type="text" maxlength="253" placeholder="192.168.31.76 或 monitor.example.com" autocomplete="off" />
          <span class="field-hint">用于生成切换后的地址，并校验证书是否覆盖该 IP 或域名。</span>
        </div>

        <div v-if="protocol === 'https'" class="certificate-section">
          <div class="certificate-heading">
            <div>
              <strong>服务器证书</strong>
              <span>{{ settings?.certificate.configured ? '已配置；留空表示继续使用，私钥不会回填。' : '尚未配置证书。' }}</span>
            </div>
            <span class="certificate-state" :class="settings?.certificate.configured ? 'configured' : 'missing'">
              <ShieldCheck v-if="settings?.certificate.configured" :size="15" aria-hidden="true" />
              <ShieldAlert v-else :size="15" aria-hidden="true" />
              {{ settings?.certificate.configured ? '已配置' : '未配置' }}
            </span>
          </div>

          <div class="certificate-inputs">
            <div class="field">
              <label for="server-certificate-pem">服务器证书（PEM）</label>
              <textarea id="server-certificate-pem" v-model="certificatePem" class="textarea pem-input mono" spellcheck="false" autocomplete="off" placeholder="-----BEGIN CERTIFICATE-----" />
            </div>
            <div class="field">
              <label for="server-private-key-pem">私钥（PEM）</label>
              <textarea id="server-private-key-pem" v-model="privateKeyPem" class="textarea pem-input mono" spellcheck="false" autocomplete="off" placeholder="-----BEGIN PRIVATE KEY-----" />
            </div>
          </div>
          <p v-if="!certificatePairComplete" class="field-error">证书和私钥必须同时填写。</p>

          <dl v-if="settings?.certificate.configured" class="certificate-details">
            <div><dt>证书主体</dt><dd :title="settings.certificate.subject ?? undefined">{{ settings.certificate.subject || '未提供' }}</dd></div>
            <div><dt>颁发者</dt><dd :title="settings.certificate.issuer ?? undefined">{{ settings.certificate.issuer || '未提供' }}</dd></div>
            <div><dt>有效期至</dt><dd>{{ formatDateTime(settings.certificate.valid_to) }}</dd></div>
            <div><dt>主机匹配</dt><dd :class="settings.certificate.host_matches ? 'text-success' : 'text-danger'">{{ settings.certificate.host_matches ? '匹配' : '不匹配' }}</dd></div>
          </dl>
        </div>

        <div class="access-actions">
          <div class="next-address">
            <span>保存后地址</span>
            <strong class="mono" :title="nextAddress">{{ nextAddress }}</strong>
          </div>
          <button class="btn btn-primary" type="submit" :disabled="!canSave">
            <LoaderCircle v-if="saving" :size="16" class="spin" aria-hidden="true" />
            <LockKeyhole v-else-if="protocol === 'https'" :size="16" aria-hidden="true" />
            <Save v-else :size="16" aria-hidden="true" />
            {{ saving ? '正在保存…' : settings?.managed_restart ? '保存并应用' : '保存设置' }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.access-settings { margin-top: 14px; }
.access-body { display: grid; gap: 14px; padding: 15px; }
.notice-link { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; font-weight: 700; }
.access-summary { display: grid; grid-template-columns: minmax(250px, 1.5fr) repeat(3, minmax(140px, 0.6fr)); border: 1px solid var(--border); border-radius: 6px; background: var(--surface-subtle); }
.access-summary > div { position: relative; min-width: 0; padding: 11px 13px; border-right: 1px solid var(--border); }
.access-summary > div:last-child { border-right: 0; }
.access-summary span,
.access-summary strong { display: block; }
.access-summary span { color: var(--text-tertiary); font-size: 11px; }
.access-summary strong { min-width: 0; margin-top: 3px; overflow-wrap: anywhere; font-size: 13px; }
.address-value { padding-right: 30px; }
.icon-copy { position: absolute; right: 9px; bottom: 8px; display: grid; width: 28px; height: 28px; place-items: center; padding: 0; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text-tertiary); cursor: pointer; }
.icon-copy:hover { border-color: var(--accent); color: var(--accent); }
.access-form { display: grid; grid-template-columns: minmax(220px, 0.7fr) minmax(280px, 1.3fr); gap: 14px; }
.protocol-field { align-content: start; }
.segment-control { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 3px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-muted); }
.segment-control label { min-height: 36px; padding: 8px 12px; border-radius: 4px; color: var(--text-secondary); font-size: 13px; font-weight: 700; text-align: center; cursor: pointer; }
.segment-control label.active { background: var(--surface); color: var(--accent); box-shadow: var(--shadow-sm); }
.segment-control input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.certificate-section { display: grid; grid-column: 1 / -1; gap: 12px; padding-top: 14px; border-top: 1px solid var(--border); }
.certificate-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.certificate-heading strong,
.certificate-heading span { display: block; }
.certificate-heading span { margin-top: 2px; color: var(--text-tertiary); font-size: 12px; }
.certificate-state { display: inline-flex !important; min-height: 30px; flex: 0 0 auto; align-items: center; gap: 5px; padding: 5px 9px; border-radius: 4px; font-weight: 700; }
.certificate-state.configured { background: var(--success-soft); color: var(--success); }
.certificate-state.missing { background: var(--warning-soft); color: var(--warning); }
.text-warning { color: var(--warning); }
.certificate-inputs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.pem-input { min-height: 128px; resize: vertical; font-size: 11px; line-height: 1.45; }
.field-error { margin: -4px 0 0; color: var(--danger); font-size: 12px; }
.certificate-details { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; border: 1px solid var(--border); border-radius: 6px; }
.certificate-details > div { min-width: 0; padding: 10px 12px; border-right: 1px solid var(--border); }
.certificate-details > div:last-child { border-right: 0; }
.certificate-details dt { color: var(--text-tertiary); font-size: 11px; }
.certificate-details dd { margin: 3px 0 0; overflow: hidden; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.access-actions { display: flex; grid-column: 1 / -1; align-items: end; justify-content: space-between; gap: 14px; padding-top: 13px; border-top: 1px solid var(--border); }
.next-address { min-width: 0; }
.next-address span,
.next-address strong { display: block; }
.next-address span { color: var(--text-tertiary); font-size: 11px; }
.next-address strong { margin-top: 3px; overflow-wrap: anywhere; font-size: 13px; }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 980px) {
  .access-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .access-summary > div:nth-child(2) { border-right: 0; }
  .access-summary > div:nth-child(-n + 2) { border-bottom: 1px solid var(--border); }
  .certificate-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .certificate-details > div:nth-child(2) { border-right: 0; }
  .certificate-details > div:nth-child(-n + 2) { border-bottom: 1px solid var(--border); }
}

@media (max-width: 760px) {
  .access-form,
  .certificate-inputs { grid-template-columns: minmax(0, 1fr); }
  .certificate-heading,
  .access-actions { align-items: stretch; flex-direction: column; }
  .certificate-state { align-self: flex-start; }
  .access-actions .btn { width: 100%; }
}

@media (max-width: 430px) {
  .access-summary,
  .certificate-details { grid-template-columns: minmax(0, 1fr); }
  .access-summary > div,
  .access-summary > div:nth-child(2),
  .certificate-details > div,
  .certificate-details > div:nth-child(2) { border-right: 0; border-bottom: 1px solid var(--border); }
  .access-summary > div:last-child,
  .certificate-details > div:last-child { border-bottom: 0; }
}
</style>
