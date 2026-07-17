<script setup lang="ts">
import { Check, Copy, ExternalLink } from '@lucide/vue';
import { onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  baseUrl: string;
}>();

const helperMessage = ref<string | null>(null);
const copiedCommand = ref<'access' | 'refresh' | null>(null);
const tokenCommands = {
  access: "copy(localStorage.getItem('auth_token') || '')",
  refresh: "copy(localStorage.getItem('refresh_token') || '')",
} as const;
let copiedResetTimer: number | undefined;

function openLoginPage(): void {
  helperMessage.value = null;
  try {
    const loginUrl = new URL('/login', props.baseUrl.trim());
    if (loginUrl.protocol !== 'https:') throw new Error('invalid protocol');
    window.open(loginUrl.toString(), '_blank', 'noopener,noreferrer');
    helperMessage.value = '已请求打开登录页。若没有出现新窗口，请允许本站弹出窗口后重试；登录完成后回到这里复制 Token。';
  } catch {
    helperMessage.value = '请先填写有效的 HTTPS 站点地址。';
  }
}

async function copyPlainText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // HTTP LAN access may not expose Clipboard API; continue with the local fallback.
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

async function copyTokenCommand(kind: 'access' | 'refresh'): Promise<void> {
  const copied = await copyPlainText(tokenCommands[kind]);
  if (!copied) {
    helperMessage.value = '命令复制失败，请手动选择命令文本复制。';
    return;
  }

  copiedCommand.value = kind;
  helperMessage.value = `${kind === 'access' ? 'Access' : 'Refresh'} Token 获取命令已复制。请在目标站点页面的开发者工具控制台中运行。`;
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
  copiedResetTimer = window.setTimeout(() => {
    copiedCommand.value = null;
    copiedResetTimer = undefined;
  }, 1_500);
}

onBeforeUnmount(() => {
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
});
</script>

<template>
  <section class="token-login-helper">
    <div class="token-helper-heading">
      <div><h3>从站点登录页获取 Token</h3><p>登录在目标站点的新窗口中完成，Relay Monitor 不会接触验证码或代填密码。</p></div>
      <button class="btn btn-secondary" type="button" :disabled="!baseUrl.trim()" @click="openLoginPage"><ExternalLink :size="16" aria-hidden="true" />打开登录页</button>
    </div>
    <ol class="token-helper-steps">
      <li>在打开的站点完成登录，然后按 <kbd>F12</kbd> 打开开发者工具的“控制台”。</li>
      <li>复制并运行下方命令；它只读取该站点自己的本地存储，并把结果放入剪贴板。</li>
      <li>回到这里，将结果粘贴到对应输入框。不要把 Token 发到聊天、工单或其他网站。</li>
    </ol>
    <div class="token-command-list">
      <button type="button" :title="copiedCommand === 'access' ? '已复制' : '复制 Access Token 获取命令'" :aria-label="copiedCommand === 'access' ? 'Access Token 获取命令已复制' : '复制 Access Token 获取命令'" @click="copyTokenCommand('access')"><code>{{ tokenCommands.access }}</code><span><Check v-if="copiedCommand === 'access'" :size="14" aria-hidden="true" /><Copy v-else :size="14" aria-hidden="true" />{{ copiedCommand === 'access' ? '已复制' : '复制命令' }}</span></button>
      <button type="button" :title="copiedCommand === 'refresh' ? '已复制' : '复制 Refresh Token 获取命令'" :aria-label="copiedCommand === 'refresh' ? 'Refresh Token 获取命令已复制' : '复制 Refresh Token 获取命令'" @click="copyTokenCommand('refresh')"><code>{{ tokenCommands.refresh }}</code><span><Check v-if="copiedCommand === 'refresh'" :size="14" aria-hidden="true" /><Copy v-else :size="14" aria-hidden="true" />{{ copiedCommand === 'refresh' ? '已复制' : '复制命令' }}</span></button>
    </div>
    <details class="token-manual-help">
      <summary>控制台命令不可用时，查看手动路径</summary>
      <p>在目标站点开发者工具中打开“应用” → “本地存储” → 当前站点，找到 <code>auth_token</code>；如存在 <code>refresh_token</code> 也可一并填写。</p>
    </details>
    <p class="field-hint">浏览器同源策略禁止本系统直接读取其他域名的本地存储；只有目标站点提供授权回调时才能自动回传。当前 Sub2API 未提供该接口，且禁止嵌入 iframe。</p>
    <div v-if="helperMessage" class="notice" role="status">{{ helperMessage }}</div>
  </section>
</template>

<style scoped>
.token-login-helper { display: grid; gap: 12px; margin-bottom: 4px; padding: 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-subtle); }
.token-helper-heading { display: flex; align-items: start; justify-content: space-between; gap: 14px; }
.token-helper-heading h3 { margin: 0; font-size: 15px; }
.token-helper-heading p { margin: 3px 0 0; color: var(--text-tertiary); font-size: 12px; }
.token-helper-heading .btn { flex: 0 0 auto; }
.token-helper-steps { display: grid; gap: 5px; margin: 0; padding-left: 20px; color: var(--text-secondary); font-size: 12px; }
.token-helper-steps kbd { padding: 1px 4px; border: 1px solid var(--border); border-radius: 3px; background: var(--surface); font: inherit; }
.token-command-list { display: grid; gap: 7px; }
.token-command-list button { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface); color: var(--text-secondary); cursor: pointer; text-align: left; }
.token-command-list button:hover { border-color: var(--accent); }
.token-command-list code { min-width: 0; overflow: hidden; color: var(--text); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.token-command-list span { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; color: var(--accent); font-size: 12px; font-weight: 650; }
.token-manual-help { color: var(--text-secondary); font-size: 12px; }
.token-manual-help summary { cursor: pointer; font-weight: 650; }
.token-manual-help p { margin: 7px 0 0; line-height: 1.6; }

@media (max-width: 700px) {
  .token-helper-heading { align-items: stretch; flex-direction: column; }
  .token-helper-heading .btn { width: 100%; }
  .token-command-list button { align-items: stretch; flex-direction: column; }
  .token-command-list code { width: 100%; white-space: normal; overflow-wrap: anywhere; }
}
</style>
