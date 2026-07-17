<script setup lang="ts">
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FlaskConical,
  Info,
  KeyRound,
  Link2,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  ShieldQuestion,
  Trash2,
  WandSparkles,
  X,
} from '@lucide/vue';
import { computed, nextTick, onUnmounted, reactive, ref, useId, watch } from 'vue';

import {
  RATE_PROBE_ENDPOINT,
  rateProbePromptPreview,
} from '../../../shared/rate-probe';
import {
  MAX_RATE_PROBE_INTERVAL_SECONDS,
  MAX_RATE_PROBE_TIMEOUT_SECONDS,
  MIN_RATE_PROBE_INTERVAL_SECONDS,
  MIN_RATE_PROBE_TIMEOUT_SECONDS,
} from '../../../shared/constants';
import { probeErrorCodeLabel, probeErrorMessage } from '../../../shared/probe-errors';
import { api, pageItems } from '../services/api';
import { formatDateTime, formatDurationSeconds } from '../services/format';
import ToggleSwitch from './ToggleSwitch.vue';
import type {
  RateProbeConfig,
  RateProbeConfigInput,
  RateProbeKnowledge,
  RateProbeModelIdentity,
  RateProbePromptIntegrity,
  RateProbeResult,
  RateViewModel,
  UpstreamApiKey,
} from '../types/domain';

const props = defineProps<{
  open: boolean;
  rate: RateViewModel | null;
  siteName: string;
}>();

const emit = defineEmits<{
  close: [];
  completed: [result: RateProbeResult];
}>();

const titleId = `rate-probe-${useId()}`;
const descriptionId = `${titleId}-description`;
const closeButton = ref<HTMLButtonElement | null>(null);
const loading = ref(false);
const saving = ref(false);
const fetchingModels = ref(false);
const running = ref(false);
const error = ref<string | null>(null);
const message = ref<string | null>(null);
const models = ref<string[]>([]);
const autoModel = ref('');
const manualModel = ref('');
const customApiKey = ref('');
const customApiKeyPresent = ref(false);
const boundKeyPresent = ref(false);
const upstreamApiKeys = ref<UpstreamApiKey[]>([]);
const keysLoading = ref(false);
const keysLoaded = ref(false);
const keysError = ref<string | null>(null);
const removingKey = ref(false);
const confirmRemoveKey = ref(false);
const latestResult = ref<RateProbeResult | null>(null);
const history = ref<RateProbeResult[]>([]);
let loadSequence = 0;
let previousBodyOverflow = '';

const form = reactive<{
  model_mode: RateProbeConfig['model_mode'];
  key_mode: RateProbeConfig['key_mode'];
  upstream_key_id: string;
  max_output_tokens: number;
  auto_probe_enabled: boolean;
  probe_interval_seconds: number;
  timeout_seconds: number;
  retry_count: number;
  retry_interval_seconds: number;
  auto_create_quota_limit: number | null | '';
  auto_create_expires_in_seconds: number | null;
}>({
  model_mode: 'auto' as RateProbeConfig['model_mode'],
  key_mode: 'bound' as RateProbeConfig['key_mode'],
  upstream_key_id: '',
  max_output_tokens: 96,
  auto_probe_enabled: false,
  probe_interval_seconds: 3600,
  timeout_seconds: 30,
  retry_count: 3,
  retry_interval_seconds: 60,
  auto_create_quota_limit: null,
  auto_create_expires_in_seconds: null,
});

const actionBusy = computed(() => saving.value || fetchingModels.value || running.value || removingKey.value);
const busy = computed(() => loading.value || actionBusy.value);
const rateId = computed(() => props.rate?.id ?? null);
const selectedModel = computed(() => form.model_mode === 'manual' ? manualModel.value.trim() : autoModel.value);
const probeIntervalMinutes = computed({
  get: () => form.probe_interval_seconds / 60,
  set: (value: number) => {
    const minutes = Number(value);
    form.probe_interval_seconds = Number.isFinite(minutes) ? minutes * 60 : 0;
  },
});
const disclosedModel = computed(() => latestResult.value?.requested_model || selectedModel.value || props.rate?.model || '');
const disclosedPrompt = computed(() => rateProbePromptPreview(disclosedModel.value));
const disclosedEndpoint = computed(() => {
  if (!latestResult.value) return RATE_PROBE_ENDPOINT;
  const path = latestResult.value.evidence?.request_path;
  if (typeof path === 'string' && path) return path;
  return latestResult.value.status === 'failed'
    ? '协议未记录（旧失败记录）'
    : '/v1/chat/completions（历史记录）';
});
const modelOptions = computed(() => {
  const values = [...models.value];
  if (autoModel.value && !values.includes(autoModel.value)) values.unshift(autoModel.value);
  return [...new Set(values)];
});
const currentGroupId = computed(() => {
  const value = props.rate?.attributes.group_id;
  return typeof value === 'string' ? value : null;
});
const matchingApiKeys = computed(() => upstreamApiKeys.value.filter((key) =>
  key.status === 'active' && key.group_id === currentGroupId.value
));
const credentialReady = computed(() => {
  if (form.key_mode === 'bound') return boundKeyPresent.value;
  if (form.key_mode === 'existing') return Boolean(form.upstream_key_id);
  if (form.key_mode === 'auto_create') return true;
  return customApiKeyPresent.value || customApiKey.value.trim() !== '';
});
const canSubmit = computed(() => Boolean(rateId.value && selectedModel.value && credentialReady.value && !busy.value));

function applyConfig(config: RateProbeConfig): void {
  form.model_mode = config.model_mode;
  form.key_mode = config.key_mode;
  form.upstream_key_id = config.upstream_key_id ?? '';
  form.max_output_tokens = config.max_output_tokens;
  form.auto_probe_enabled = config.auto_probe_enabled;
  form.probe_interval_seconds = config.probe_interval_seconds;
  form.timeout_seconds = config.timeout_seconds;
  form.retry_count = config.retry_count;
  form.retry_interval_seconds = config.retry_interval_seconds;
  form.auto_create_quota_limit = config.auto_create_quota_limit;
  form.auto_create_expires_in_seconds = config.auto_create_expires_in_seconds;
  boundKeyPresent.value = config.bound_key_present;
  customApiKeyPresent.value = config.custom_api_key_present;
  if (config.model_mode === 'manual') manualModel.value = config.model ?? '';
  else autoModel.value = config.model ?? '';
}

function resetState(): void {
  loading.value = false;
  saving.value = false;
  fetchingModels.value = false;
  running.value = false;
  error.value = null;
  message.value = null;
  models.value = [];
  autoModel.value = '';
  manualModel.value = '';
  customApiKey.value = '';
  customApiKeyPresent.value = false;
  boundKeyPresent.value = false;
  upstreamApiKeys.value = [];
  keysLoading.value = false;
  keysLoaded.value = false;
  keysError.value = null;
  removingKey.value = false;
  confirmRemoveKey.value = false;
  latestResult.value = props.rate?.latest_probe ?? null;
  history.value = props.rate?.latest_probe ? [props.rate.latest_probe] : [];
  form.model_mode = 'auto';
  form.key_mode = 'bound';
  form.upstream_key_id = '';
  form.max_output_tokens = 96;
  form.auto_probe_enabled = false;
  form.probe_interval_seconds = 3600;
  form.timeout_seconds = 30;
  form.retry_count = 3;
  form.retry_interval_seconds = 60;
  form.auto_create_quota_limit = null;
  form.auto_create_expires_in_seconds = null;
}

async function initialize(): Promise<void> {
  const id = rateId.value;
  resetState();
  if (!id) {
    error.value = '当前倍率对象缺少稳定 ID，暂时无法配置实测。';
    return;
  }
  const sequence = ++loadSequence;
  loading.value = true;
  try {
    const [config, runs] = await Promise.all([
      api.rates.probeConfig(id),
      api.rates.probeRuns(id),
    ]);
    if (sequence !== loadSequence) return;
    applyConfig(config);
    history.value = pageItems(runs);
    latestResult.value = history.value[0] ?? props.rate?.latest_probe ?? null;
  } catch (caught) {
    if (sequence !== loadSequence) return;
    error.value = caught instanceof Error ? caught.message : '读取实测配置失败';
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

async function loadUpstreamApiKeys(force = false): Promise<void> {
  const siteId = props.rate?.site_id;
  if (!siteId || keysLoading.value || (!force && keysLoaded.value)) return;
  const sequence = loadSequence;
  keysLoading.value = true;
  keysError.value = null;
  try {
    const response = await api.sites.apiKeys(siteId);
    if (sequence !== loadSequence) return;
    upstreamApiKeys.value = response.items;
    keysLoaded.value = true;
  } catch (caught) {
    if (sequence !== loadSequence) return;
    keysError.value = caught instanceof Error ? caught.message : '读取上游 Key 列表失败，请稍后重试。';
  } finally {
    if (sequence === loadSequence) keysLoading.value = false;
  }
}

function configInput(): RateProbeConfigInput {
  const key = customApiKey.value.trim();
  const quotaLimit = typeof form.auto_create_quota_limit === 'number'
    ? form.auto_create_quota_limit
    : undefined;
  const expiresInSeconds = typeof form.auto_create_expires_in_seconds === 'number'
    ? form.auto_create_expires_in_seconds
    : undefined;
  return {
    model_mode: form.model_mode,
    model: selectedModel.value || null,
    key_mode: form.key_mode,
    upstream_key_id: form.key_mode === 'existing' ? form.upstream_key_id || null : null,
    max_output_tokens: Math.max(16, Math.min(256, Math.round(form.max_output_tokens || 16))),
    auto_probe_enabled: form.auto_probe_enabled,
    probe_interval_seconds: Math.max(
      MIN_RATE_PROBE_INTERVAL_SECONDS,
      Math.min(MAX_RATE_PROBE_INTERVAL_SECONDS, Math.round(form.probe_interval_seconds || MIN_RATE_PROBE_INTERVAL_SECONDS)),
    ),
    timeout_seconds: Math.max(
      MIN_RATE_PROBE_TIMEOUT_SECONDS,
      Math.min(MAX_RATE_PROBE_TIMEOUT_SECONDS, Math.round(form.timeout_seconds || MIN_RATE_PROBE_TIMEOUT_SECONDS)),
    ),
    retry_count: Math.max(0, Math.min(10, Math.round(form.retry_count || 0))),
    retry_interval_seconds: Math.max(0, Math.min(3_600, Math.round(form.retry_interval_seconds || 0))),
    ...(form.key_mode === 'auto_create' ? {
      auto_create: {
        ...(quotaLimit === undefined ? {} : { quota_limit: quotaLimit }),
        ...(expiresInSeconds === undefined ? {} : { expires_in_seconds: expiresInSeconds }),
      },
    } : {}),
    ...(form.key_mode === 'manual' && key ? { custom_api_key: key } : {}),
  };
}

function validateConfig(): string | null {
  if (!credentialReady.value) {
    if (form.key_mode === 'bound') return '当前分组尚未绑定专用 Key，请选择已有 Key、自动创建或手动填写。';
    if (form.key_mode === 'existing') return '请选择一个与当前分组匹配的上游 Key。';
    return '请输入当前分组的测试 API Key。';
  }
  if (form.model_mode === 'manual' && !manualModel.value.trim()) return '请填写要测试的模型 ID。';
  if (form.max_output_tokens < 16 || form.max_output_tokens > 256) return '本次实测最大输出 Token 必须在 16 到 256 之间。';
  if (form.key_mode === 'auto_create'
    && form.auto_create_quota_limit !== null
    && form.auto_create_quota_limit !== ''
    && (!Number.isFinite(form.auto_create_quota_limit)
      || form.auto_create_quota_limit < 0.1
      || form.auto_create_quota_limit > 10)) return '自动创建 Key 的额度上限必须在 0.1 到 10 之间，或留空表示不限额。';
  if (form.auto_probe_enabled && !selectedModel.value) return '启用自动实测前必须先获取或填写模型。';
  if (form.auto_probe_enabled
    && (!Number.isSafeInteger(probeIntervalMinutes.value) || probeIntervalMinutes.value <= 0)) return '自动实测间隔必须填写正整数分钟。';
  if (form.auto_probe_enabled
    && probeIntervalMinutes.value * 60 > MAX_RATE_PROBE_INTERVAL_SECONDS) return '自动实测间隔数值过大，请填写较小的正整数分钟。';
  if (!Number.isInteger(form.timeout_seconds)
    || form.timeout_seconds < MIN_RATE_PROBE_TIMEOUT_SECONDS
    || form.timeout_seconds > MAX_RATE_PROBE_TIMEOUT_SECONDS) return '请求超时必须在 1 到 300 秒之间。';
  if (!Number.isInteger(form.retry_count) || form.retry_count < 0 || form.retry_count > 10) return '失败重试次数必须在 0 到 10 次之间。';
  if (!Number.isInteger(form.retry_interval_seconds) || form.retry_interval_seconds < 0 || form.retry_interval_seconds > 3_600) return '额外重试间隔必须在 0 秒到 60 分钟之间。';
  return null;
}

async function persistConfig(showSuccess: boolean): Promise<boolean> {
  const id = rateId.value;
  if (!id) return false;
  const validationError = validateConfig();
  if (validationError) {
    error.value = validationError;
    return false;
  }
  saving.value = true;
  error.value = null;
  message.value = null;
  try {
    const config = await api.rates.saveProbeConfig(id, configInput());
    applyConfig(config);
    customApiKey.value = '';
    if (showSuccess) message.value = '实测配置已保存。';
    return true;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '保存实测配置失败';
    return false;
  } finally {
    saving.value = false;
  }
}

async function removeCustomApiKey(): Promise<void> {
  const id = rateId.value;
  if (!id || !customApiKeyPresent.value) return;
  removingKey.value = true;
  error.value = null;
  message.value = null;
  try {
    const config = await api.rates.saveProbeConfig(id, {
      ...configInput(),
      custom_api_key: null,
    });
    applyConfig(config);
    customApiKey.value = '';
    confirmRemoveKey.value = false;
    message.value = '已移除该分组保存的测试 Key。';
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '移除测试 Key 失败';
  } finally {
    removingKey.value = false;
  }
}

async function fetchModels(): Promise<void> {
  const id = rateId.value;
  if (!id) return;
  const desiredAutoProbe = form.auto_probe_enabled;
  if (!selectedModel.value) form.auto_probe_enabled = false;
  const persisted = await persistConfig(false);
  form.auto_probe_enabled = desiredAutoProbe;
  if (!persisted) return;
  fetchingModels.value = true;
  error.value = null;
  message.value = null;
  try {
    const result = await api.rates.probeModels(id);
    models.value = result.items.map((item) => item.id).filter(Boolean);
    const preferred = result.selected_model ?? autoModel.value;
    autoModel.value = preferred && models.value.includes(preferred) ? preferred : models.value[0] ?? '';
    message.value = models.value.length
      ? `已获取 ${models.value.length} 个可用模型。`
      : '该测试 Key 没有返回可用模型，可切换到手动填写。';
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '获取模型列表失败';
  } finally {
    fetchingModels.value = false;
  }
}

async function runProbe(): Promise<void> {
  const id = rateId.value;
  if (!id || !(await persistConfig(false))) return;
  if (!selectedModel.value) {
    error.value = form.model_mode === 'auto' ? '请先获取并选择模型。' : '请填写要测试的模型 ID。';
    return;
  }
  running.value = true;
  error.value = null;
  message.value = null;
  try {
    const result = await api.rates.runProbe(id);
    latestResult.value = result;
    history.value = [result, ...history.value.filter((item) => item.id !== result.id)].slice(0, 20);
    message.value = result.status === 'success' ? '实测完成，结果已写入历史。' : '实测已结束，请查看失败原因。';
    emit('completed', result);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '运行模型实测失败';
  } finally {
    running.value = false;
  }
}

function close(): void {
  if (!actionBusy.value) emit('close');
}

function formatMs(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`;
}

function formatTps(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}/s`;
}

function probeElapsedMs(result: RateProbeResult): number | null {
  if (result.total_ms !== null) return result.total_ms;
  if (result.status !== 'failed' || !result.completed_at) return null;
  const startedAt = result.started_at ?? result.created_at;
  const elapsed = Date.parse(result.completed_at) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function formatTokens(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('zh-CN').format(value);
}

function formatTokenDelta(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${new Intl.NumberFormat('zh-CN').format(value)}`;
}

function visibleOutputTokens(result: RateProbeResult): number | null {
  if (result.completion_tokens === null || result.reasoning_tokens === null) return null;
  return Math.max(0, result.completion_tokens - result.reasoning_tokens);
}

function inputTokenTone(result: RateProbeResult): 'neutral' | 'warning' | 'danger' {
  if (result.status === 'failed' || result.tool_calls_observed || result.evidence?.upstream_tools_observed === true) return 'danger';
  if (result.input_token_assessment === 'higher_than_expected') return 'warning';
  if (result.input_token_assessment === 'unknown' && result.input_token_delta !== null) return 'warning';
  return 'neutral';
}

function outputTokenTone(result: RateProbeResult): 'neutral' | 'warning' | 'danger' {
  if (result.status === 'failed') return 'danger';
  if (result.finish_reason === 'length') return 'warning';
  return result.completion_tokens !== null
    && result.reasoning_tokens !== null
    && result.reasoning_tokens >= result.completion_tokens
    ? 'warning'
    : 'neutral';
}

function inputTokenSummary(result: RateProbeResult): string {
  if (result.tool_calls_observed) return '异常：响应出现客户端未声明的工具调用。';
  if (result.evidence?.upstream_tools_observed === true) return '异常：客户端未声明工具，但上游响应回显了工具配置。';
  if (result.status === 'failed') return `实测失败：${probeErrorMessage(result.error_code, result.http_status, result.error_message)}`;
  return `上游报告 ${formatTokens(result.prompt_tokens)}；客户端字符粗估约 ${formatTokens(result.expected_input_tokens)}；差值 ${formatTokenDelta(result.input_token_delta)}。`;
}

function outputTokenSummary(result: RateProbeResult): string {
  if (result.status === 'failed') return `实测失败：${probeErrorMessage(result.error_code, result.http_status, result.error_message)}`;
  if (result.finish_reason === 'length') return '警告：响应达到单次输出预算后被截断。';
  return `输出 Token 共 ${formatTokens(result.completion_tokens)}；其中推理 Token ${formatTokens(result.reasoning_tokens)}。`;
}

function inputAssessmentLabel(result: RateProbeResult): string {
  if (result.input_token_assessment === 'unknown' && result.input_token_delta !== null && result.input_token_delta < 0) {
    return '上游报告明显低于本地预估';
  }
  return {
    within_expected: '输入量大致符合客户端粗估',
    higher_than_expected: '输入量高于客户端粗估',
    unknown: '输入量暂时无法比较',
  }[result.input_token_assessment];
}

function promptIntegrityLabel(value: RateProbePromptIntegrity): string {
  return {
    no_interference_observed: '未观察到提示词干扰',
    suspected: '疑似提示词干扰',
    unknown: '无法判断提示词干扰',
  }[value];
}

function knowledgeLabel(value: RateProbeKnowledge): string {
  return {
    weak_consistency: '知识粗筛一致',
    suspicious: '知识粗筛异常',
    not_applicable: '未执行知识粗筛',
    unknown: '知识粗筛未知',
  }[value];
}

function modelIdentityLabel(value: RateProbeModelIdentity): string {
  return {
    declared_match: '返回声明与请求一致',
    declared_mismatch: '返回声明与请求不一致',
    unknown: '模型声明未知',
  }[value];
}

function resultTone(result: RateProbeResult, kind: 'prompt' | 'model' | 'knowledge'): string {
  if (kind === 'prompt') return result.prompt_integrity === 'suspected' ? 'danger' : result.prompt_integrity === 'no_interference_observed' ? 'success' : 'neutral';
  if (kind === 'model') return result.model_identity === 'declared_mismatch' ? 'danger' : result.model_identity === 'declared_match' ? 'success' : 'neutral';
  return result.knowledge_probe === 'suspicious' ? 'warning' : result.knowledge_probe === 'weak_consistency' ? 'success' : 'neutral';
}

function resultStatusLabel(status: RateProbeResult['status']): string {
  return { running: '正在运行', success: '请求成功', failed: '请求失败' }[status];
}

watch(
  () => form.key_mode,
  (mode) => {
    if (mode === 'existing' && props.open) void loadUpstreamApiKeys();
  },
);

watch(
  [() => props.open, () => props.rate?.id] as const,
  async ([open], [wasOpen]) => {
    if (!open) {
      loadSequence += 1;
      if (wasOpen) document.body.style.overflow = previousBodyOverflow;
      return;
    }
    if (!wasOpen) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    await initialize();
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
    <div v-if="open" class="probe-backdrop" @click.self="close" @keydown.esc="close">
      <section class="probe-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId">
        <header class="probe-header">
          <span class="probe-mark"><FlaskConical :size="20" aria-hidden="true" /></span>
          <div>
            <h2 :id="titleId">分组模型实测</h2>
            <p :id="descriptionId">{{ siteName }} · {{ rate?.name }}</p>
          </div>
          <button ref="closeButton" class="icon-btn" type="button" :disabled="actionBusy" title="关闭实测面板" aria-label="关闭实测面板" @click="close">
            <X :size="17" aria-hidden="true" />
          </button>
        </header>

        <div v-if="loading" class="loading-line" />
        <div class="probe-scroll">
          <div class="probe-caution">
            <ShieldQuestion :size="18" aria-hidden="true" />
            <p><strong>快速行为检测，不是官方鉴真。</strong>中转可改写模型声明和响应；检测结论仅用于横向排查，不证明模型来源或不存在隐藏提示词。</p>
          </div>

          <section class="request-disclosure" aria-labelledby="probe-request-heading">
            <div class="request-disclosure-heading">
              <div><h3 id="probe-request-heading">Relay Monitor 发出的请求</h3><p>{{ latestResult ? '最近实测模板；一次性随机校验串已替换为占位符。中转后续改写不可见。' : '当前配置将使用此固定模板；一次性随机校验串会在运行时生成。' }}</p></div>
              <code>{{ disclosedEndpoint }}</code>
            </div>
            <dl class="request-facts">
              <div><dt>模型</dt><dd class="mono">{{ disclosedModel || '保存前请选择模型' }}</dd></div>
              <div><dt>客户端工具</dt><dd><code>tools: []</code>，禁止工具调用</dd></div>
              <div><dt>响应存储</dt><dd><code>store: false</code></dd></div>
            </dl>
            <div class="prompt-preview">
              <div><span>instructions</span><code>{{ disclosedPrompt.systemPrompt }}</code></div>
              <div><span>input</span><code>{{ disclosedPrompt.userPrompt }}</code></div>
            </div>
          </section>

          <div v-if="error" class="notice notice-danger" role="alert"><CircleAlert :size="17" aria-hidden="true" />{{ error }}</div>
          <div v-if="message" class="notice notice-success" role="status"><CheckCircle2 :size="17" aria-hidden="true" />{{ message }}</div>

          <section class="probe-section" aria-labelledby="probe-config-heading">
            <div class="section-copy">
              <h3 id="probe-config-heading">测试配置</h3>
              <p>发送受限的短响应请求；页面不会展示完整提示词、模型输出或 API Key。</p>
            </div>

            <div class="probe-form-grid">
              <fieldset class="probe-fieldset span-2">
                <legend>模型来源</legend>
                <div class="segment-control" role="radiogroup" aria-label="模型来源">
                  <label :class="{ active: form.model_mode === 'auto' }"><input v-model="form.model_mode" type="radio" value="auto" />自动获取</label>
                  <label :class="{ active: form.model_mode === 'manual' }"><input v-model="form.model_mode" type="radio" value="manual" />手动填写</label>
                </div>
              </fieldset>

              <div v-if="form.model_mode === 'auto'" class="field span-2">
                <label for="probe-auto-model">可用模型</label>
                <div class="model-picker">
                  <select id="probe-auto-model" v-model="autoModel" class="select" :disabled="fetchingModels">
                    <option value="">{{ models.length ? '请选择模型' : '请先获取模型列表' }}</option>
                    <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
                  </select>
                  <button class="btn btn-secondary" type="button" :disabled="busy || !credentialReady" @click="fetchModels">
                    <LoaderCircle v-if="fetchingModels" :size="16" class="spin" aria-hidden="true" />
                    <RefreshCw v-else :size="16" aria-hidden="true" />
                    {{ fetchingModels ? '正在获取…' : '获取模型' }}
                  </button>
                </div>
                <span class="field-hint">使用当前选择的测试 Key 请求模型列表，不根据分组名称猜测模型。</span>
              </div>

              <div v-else class="field span-2">
                <label for="probe-manual-model">模型 ID</label>
                <input id="probe-manual-model" v-model="manualModel" class="input mono" maxlength="160" autocomplete="off" placeholder="例如 gpt-5.6-sol" />
                <span class="field-hint">按中转站实际接受的模型 ID 填写，运行结果会同时显示返回声明。</span>
              </div>

              <fieldset class="probe-fieldset span-2">
                <legend>当前分组的测试凭据</legend>
                <div class="credential-choice" role="radiogroup" aria-label="当前分组测试凭据">
                  <label :class="{ active: form.key_mode === 'bound', unavailable: !boundKeyPresent }">
                    <input v-model="form.key_mode" type="radio" value="bound" :disabled="!boundKeyPresent" />
                    <Link2 :size="17" aria-hidden="true" />
                    <span><strong>已绑定专用 Key</strong><small>{{ boundKeyPresent ? '继续使用当前安全绑定' : '当前分组尚未绑定' }}</small></span>
                  </label>
                  <label :class="{ active: form.key_mode === 'existing' }">
                    <input v-model="form.key_mode" type="radio" value="existing" />
                    <KeyRound :size="17" aria-hidden="true" />
                    <span><strong>选择已有上游 Key</strong><small>仅显示掩码名称与元数据</small></span>
                  </label>
                  <label :class="{ active: form.key_mode === 'auto_create' }">
                    <input v-model="form.key_mode" type="radio" value="auto_create" />
                    <WandSparkles :size="17" aria-hidden="true" />
                    <span><strong>自动创建并绑定</strong><small>额度和有效期均可按需设置</small></span>
                  </label>
                  <label :class="{ active: form.key_mode === 'manual' }">
                    <input v-model="form.key_mode" type="radio" value="manual" />
                    <FlaskConical :size="17" aria-hidden="true" />
                    <span><strong>手动填写 Key</strong><small>为该倍率对象单独加密保存</small></span>
                  </label>
                </div>
              </fieldset>

              <div v-if="form.key_mode === 'existing'" class="field span-2">
                <label for="probe-existing-key">已有上游 Key</label>
                <div class="model-picker">
                  <select id="probe-existing-key" v-model="form.upstream_key_id" class="select" :disabled="keysLoading">
                    <option value="">{{ keysLoading ? '正在读取上游 Key…' : keysError ? '读取失败，请重试' : matchingApiKeys.length ? '请选择与当前分组匹配的 Key' : '没有找到当前分组可用的 Key' }}</option>
                    <option v-for="key in matchingApiKeys" :key="key.id" :value="key.id">{{ key.name }}{{ key.group_name ? ` · ${key.group_name}` : ' · 通用' }}{{ key.expires_at ? ` · ${key.expires_at.slice(0, 10)} 到期` : '' }}</option>
                  </select>
                  <button class="btn btn-secondary" type="button" :disabled="keysLoading || busy" title="刷新上游 Key" @click="loadUpstreamApiKeys(true)">
                    <LoaderCircle v-if="keysLoading" :size="16" class="spin" aria-hidden="true" />
                    <RefreshCw v-else :size="16" aria-hidden="true" />
                    {{ keysLoading ? '正在读取…' : '刷新 Key' }}
                  </button>
                </div>
                <span v-if="keysError" class="key-load-error">{{ keysError }}</span>
                <span v-else class="field-hint">仅在选择此方式时读取上游列表；选择后由服务端按 ID 重新读取并加密绑定，前端不会取得 Key 明文。</span>
              </div>

              <div v-else-if="form.key_mode === 'auto_create'" class="auto-create-options span-2">
                <div class="field"><label for="probe-auto-quota">额度上限（可选）</label><input id="probe-auto-quota" v-model.number="form.auto_create_quota_limit" class="input numeric" type="number" min="0.1" max="10" step="0.1" placeholder="留空表示不限额" /><span class="field-hint">单位 USD；不填写时不限制额度。</span></div>
                <div class="field"><label for="probe-auto-expiry">有效期（可选）</label><select id="probe-auto-expiry" v-model="form.auto_create_expires_in_seconds" class="select"><option :value="null">不设置（永不过期）</option><option :value="86400">24 小时</option><option :value="259200">3 天</option><option :value="604800">7 天</option></select></div>
                <p>创建成功后直接绑定当前分组，不向前端返回 Key 明文；留空的限制不会发送给上游。</p>
              </div>

              <div v-else-if="form.key_mode === 'manual'" class="field span-2">
                <label for="probe-api-key">分组测试 API Key</label>
                <input id="probe-api-key" v-model="customApiKey" class="input mono" type="password" maxlength="16384" autocomplete="new-password" :placeholder="customApiKeyPresent ? '已保存；留空继续使用现有 Key' : '请输入低权限、低额度测试 Key'" />
                <span class="field-hint">{{ customApiKeyPresent ? '已有测试 Key 已加密保存；输入新值将替换它。' : '尚未保存分组测试 Key。' }}</span>
                <div v-if="customApiKeyPresent" class="stored-key-actions">
                  <button v-if="!confirmRemoveKey" class="remove-key-button" type="button" :disabled="busy" @click="confirmRemoveKey = true">
                    <Trash2 :size="14" aria-hidden="true" />移除已保存 Key
                  </button>
                  <template v-else>
                    <span>确认移除？此操作不会删除历史实测。</span>
                    <button class="btn btn-secondary compact-button" type="button" :disabled="removingKey" @click="confirmRemoveKey = false">取消</button>
                    <button class="btn confirm-remove-key compact-button" type="button" :disabled="removingKey" @click="removeCustomApiKey">
                      <LoaderCircle v-if="removingKey" :size="14" class="spin" aria-hidden="true" /><Trash2 v-else :size="14" aria-hidden="true" />{{ removingKey ? '正在移除…' : '确认移除' }}
                    </button>
                  </template>
                </div>
              </div>

              <div class="field token-field">
                <label for="probe-max-tokens">本次实测最大输出 Token</label>
                <input id="probe-max-tokens" v-model.number="form.max_output_tokens" class="input numeric" type="number" min="16" max="256" step="1" inputmode="numeric" />
                <span class="field-hint">限制一次实测最多生成多少 Token（含推理和可见文本），用于控制费用与等待时间；不会预先消耗 {{ form.max_output_tokens }}，也不影响输入 Token。过低可能来不及返回校验文本，通常保持 96 即可。</span>
              </div>
              <div class="auto-probe-settings span-2">
                <div><ToggleSwitch v-model="form.auto_probe_enabled" label="启用当前分组自动实测" /><span>自动实测独立于倍率元数据采集，会产生少量 Token 消耗。</span></div>
                <div class="field"><label for="probe-interval">自动实测间隔</label><div class="input-suffix"><input id="probe-interval" v-model.number="probeIntervalMinutes" class="input numeric" type="number" min="1" step="1" inputmode="numeric" :disabled="!form.auto_probe_enabled" /><span>分钟</span></div><span class="field-hint">填写任意正整数分钟</span></div>
                <div class="field"><label for="probe-timeout">单次实测请求超时</label><div class="input-suffix"><input id="probe-timeout" v-model.number="form.timeout_seconds" class="input numeric" type="number" :min="MIN_RATE_PROBE_TIMEOUT_SECONDS" :max="MAX_RATE_PROBE_TIMEOUT_SECONDS" step="1" inputmode="numeric" /><span>秒</span></div><span class="field-hint">默认 30 秒；手动、自动、模型列表和每一次重试都分别按此计时。</span></div>
              </div>
              <div class="probe-retry-settings span-2">
                <div class="retry-setting-copy"><strong>请求失败重试</strong><span>只重试网络、超时、限流和上游服务器错误；Key、权限或响应结构错误会直接结束。</span></div>
                <div class="field"><label for="probe-retry-count">失败重试次数</label><div class="input-suffix"><input id="probe-retry-count" v-model.number="form.retry_count" class="input numeric" type="number" min="0" max="10" step="1" inputmode="numeric" /><span>次</span></div><span class="field-hint">默认 3 次；含首次请求最多共 4 次</span></div>
                <div class="field"><label for="probe-retry-interval">额外重试间隔</label><div class="input-suffix"><input id="probe-retry-interval" v-model.number="form.retry_interval_seconds" class="input numeric" type="number" min="0" max="3600" step="1" inputmode="numeric" :disabled="form.retry_count === 0" /><span>秒</span></div><span class="field-hint">{{ form.retry_count === 0 ? '未启用重试' : form.retry_interval_seconds === 0 ? '失败后立即重试' : `${formatDurationSeconds(form.retry_interval_seconds)}（默认 60 秒）` }}</span></div>
              </div>
            </div>
          </section>

          <section v-if="latestResult" class="probe-section result-section" aria-labelledby="probe-result-heading">
            <div class="section-copy result-heading-row">
              <div><h3 id="probe-result-heading">最近实测</h3><p>{{ formatDateTime(latestResult.created_at) }} · {{ latestResult.requested_model }}</p></div>
              <span class="run-status" :class="latestResult.status">{{ resultStatusLabel(latestResult.status) }}</span>
            </div>

            <div class="primary-metrics">
              <div class="ttft-metric"><small>首 Token 延迟</small><strong>{{ formatMs(latestResult.ttft_ms) }}</strong><span>TTFB {{ formatMs(latestResult.ttfb_ms) }}</span></div>
              <div><small>生成速度</small><strong>{{ formatTps(latestResult.tps) }}</strong><span>TPS</span></div>
              <div class="token-metric">
                <small>本次 Token</small>
                <div class="token-breakdowns">
                  <details :class="['token-detail', 'input-detail', `is-${inputTokenTone(latestResult)}`]" name="rate-probe-token-details">
                    <summary :title="inputTokenSummary(latestResult)" :aria-label="inputTokenSummary(latestResult)">
                      <span class="token-up">↑ {{ formatTokens(latestResult.prompt_tokens) }}</span><CircleAlert v-if="inputTokenTone(latestResult) !== 'neutral'" :size="14" aria-hidden="true" /><Info v-else :size="13" aria-hidden="true" />
                    </summary>
                    <div class="token-popover">
                      <div class="token-popover-title"><strong>输入 Token 明细</strong><span :class="`assessment-${latestResult.input_token_assessment}`">{{ inputAssessmentLabel(latestResult) }}</span></div>
                      <dl>
                        <div><dt>上游报告</dt><dd>{{ formatTokens(latestResult.prompt_tokens) }}</dd></div>
                        <div><dt>客户端请求字符粗估</dt><dd>约 {{ formatTokens(latestResult.expected_input_tokens) }}</dd></div>
                        <div><dt>报告与预估差值</dt><dd>{{ formatTokenDelta(latestResult.input_token_delta) }}</dd></div>
                        <div><dt>其中缓存 Token</dt><dd>{{ latestResult.cached_input_tokens === null ? '上游未报告' : formatTokens(latestResult.cached_input_tokens) }}</dd></div>
                      </dl>
                      <p v-if="latestResult.input_token_assessment === 'higher_than_expected'" class="token-note warning">客户端粗估不是真实 tokenizer 计数；但大幅差异可能来自额外 instructions、tools、请求模板、隐藏上下文或上游 usage 错报。此项是强异常线索，但不能单独证明注入。</p>
                      <p v-if="latestResult.input_token_assessment === 'unknown' && latestResult.input_token_delta !== null && latestResult.input_token_delta < 0" class="token-note warning">上游报告显著低于客户端字符粗估，可能采用了不同 tokenizer、漏报 usage，或没有按原请求执行。此项同样不能单独证明中转行为。</p>
                      <p v-if="latestResult.tool_calls_observed" class="token-note danger">请求未声明 tools，但响应流中出现了 tool_calls。</p>
                      <p v-if="latestResult.evidence?.upstream_tools_observed" class="token-note danger">客户端发送了空 tools，但上游响应回显了非空工具配置。</p>
                    </div>
                  </details>

                  <details :class="['token-detail', 'output-detail', `is-${outputTokenTone(latestResult)}`]" name="rate-probe-token-details">
                    <summary :title="outputTokenSummary(latestResult)" :aria-label="outputTokenSummary(latestResult)">
                      <span class="token-down">↓ {{ formatTokens(latestResult.completion_tokens) }}</span><CircleAlert v-if="outputTokenTone(latestResult) !== 'neutral'" :size="14" aria-hidden="true" /><Info v-else :size="13" aria-hidden="true" />
                    </summary>
                    <div class="token-popover">
                      <div class="token-popover-title"><strong>输出 Token 明细</strong></div>
                      <dl>
                        <div><dt>输出 Token 总数</dt><dd>{{ formatTokens(latestResult.completion_tokens) }}</dd></div>
                        <div><dt>其中推理 Token</dt><dd>{{ formatTokens(latestResult.reasoning_tokens) }}</dd></div>
                        <div><dt>可见输出粗略值</dt><dd>{{ visibleOutputTokens(latestResult) === null ? '—' : `约 ${formatTokens(visibleOutputTokens(latestResult))}` }}</dd></div>
                      </dl>
                      <p class="token-note">推理 Token 计入输出 Token。仅当 Completion 与 reasoning 都有上游报告时才计算粗略可见输出，不同上游的 usage 口径仍可能不同。</p>
                    </div>
                  </details>
                </div>
                <span>合计 {{ formatTokens(latestResult.total_tokens) }}</span>
              </div>
              <div><small>总耗时</small><strong>{{ formatMs(probeElapsedMs(latestResult)) }}</strong><span>{{ latestResult.status === 'failed' ? '收到上游错误响应' : `生成 ${formatMs(latestResult.generation_ms)}` }}</span></div>
            </div>

            <dl class="probe-details">
              <div><dt>请求协议</dt><dd class="mono">{{ disclosedEndpoint }}</dd></div>
              <div><dt>请求尝试</dt><dd>{{ latestResult.attempt_count }} 次</dd></div>
              <div><dt>请求模型</dt><dd class="mono">{{ latestResult.requested_model }}</dd></div>
              <div><dt>返回声明</dt><dd class="mono">{{ latestResult.returned_model ?? '未返回' }}</dd></div>
              <div><dt>结束原因</dt><dd>{{ latestResult.finish_reason ?? '未知' }}</dd></div>
              <div><dt>系统指纹</dt><dd class="mono">{{ latestResult.system_fingerprint ?? '未返回' }}</dd></div>
            </dl>

            <div class="behavior-signals" aria-label="行为检测结论">
              <span :class="`signal-${resultTone(latestResult, 'prompt')}`">{{ promptIntegrityLabel(latestResult.prompt_integrity) }}</span>
              <span :class="`signal-${resultTone(latestResult, 'model')}`">{{ modelIdentityLabel(latestResult.model_identity) }}</span>
              <span :class="`signal-${resultTone(latestResult, 'knowledge')}`">{{ knowledgeLabel(latestResult.knowledge_probe) }}</span>
            </div>
            <p class="behavior-footnote">Jeff Landry 仅作为知识粗筛的一项固定参考，不代表模型身份、版本或来源已经得到认证。</p>

            <p v-if="latestResult.error_code || latestResult.error_message" class="probe-error-copy"><strong>{{ probeErrorCodeLabel(latestResult.error_code) }}</strong><span v-if="latestResult.error_code" class="mono">（{{ latestResult.error_code }}）</span>：{{ probeErrorMessage(latestResult.error_code, latestResult.http_status, latestResult.error_message) }}</p>
          </section>

          <section v-if="history.length" class="probe-section history-section" aria-labelledby="probe-history-heading">
            <div class="section-copy"><h3 id="probe-history-heading">最近记录</h3><p>仅保留指标和检测结论，不展示请求与输出正文。</p></div>
            <div class="probe-history-list">
              <div v-for="run in history.slice(0, 5)" :key="run.id">
                <span :class="['history-state', run.status]"><Activity v-if="run.status === 'success'" :size="14" aria-hidden="true" /><LoaderCircle v-else-if="run.status === 'running'" :size="14" class="spin" aria-hidden="true" /><CircleAlert v-else :size="14" aria-hidden="true" /></span>
                <span><strong class="mono">{{ run.requested_model }}</strong><small>{{ formatDateTime(run.created_at) }} · {{ run.attempt_count }} 次尝试</small></span>
                <span><strong>{{ formatMs(run.ttft_ms) }}</strong><small>TTFT</small></span>
                <span><strong>{{ formatTps(run.tps) }}</strong><small>TPS</small></span>
              </div>
            </div>
          </section>
        </div>

        <footer class="probe-footer">
          <span><Clock3 :size="15" aria-hidden="true" />每次请求都可能消耗 Token；当前最多请求 {{ form.retry_count + 1 }} 次</span>
          <div>
            <button class="btn btn-secondary" type="button" :disabled="busy" @click="persistConfig(true)">
              <LoaderCircle v-if="saving" :size="16" class="spin" aria-hidden="true" /><Save v-else :size="16" aria-hidden="true" />{{ saving ? '正在保存…' : '保存配置' }}
            </button>
            <button class="btn btn-primary" type="button" :disabled="!canSubmit" @click="runProbe">
              <LoaderCircle v-if="running" :size="16" class="spin" aria-hidden="true" /><Play v-else :size="16" aria-hidden="true" />{{ running ? '正在实测…' : '运行实测' }}
            </button>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.probe-backdrop {
  position: fixed;
  z-index: 130;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgb(12 18 16 / 54%);
}

.probe-dialog {
  display: grid;
  width: min(900px, 100%);
  max-height: calc(100vh - 36px);
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface);
  box-shadow: 0 22px 60px rgb(10 24 20 / 24%);
}

.probe-header {
  grid-row: 1;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 15px 18px;
  border-bottom: 1px solid var(--border);
}

.probe-dialog > .loading-line { grid-row: 2; }
.probe-scroll { grid-row: 3; }
.probe-footer { grid-row: 4; }

.probe-mark {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
}

.probe-header h2 { margin: 0; font-size: 18px; }
.probe-header p { margin: 2px 0 0; overflow: hidden; color: var(--text-tertiary); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.probe-scroll { min-height: 0; overflow-y: auto; }

.probe-caution {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid #d3e0db;
  background: #f2f7f5;
  color: var(--text-secondary);
}

.probe-caution svg { flex: 0 0 auto; margin-top: 1px; color: var(--accent); }
.probe-caution p { margin: 0; font-size: 13px; }
.probe-caution strong { color: var(--text); }
.probe-scroll > .notice { margin: 14px 18px 0; }

.request-disclosure { padding: 15px 18px; border-bottom: 1px solid var(--border); background: var(--surface-subtle); }
.request-disclosure-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.request-disclosure-heading h3 { margin: 0; font-size: 14px; }
.request-disclosure-heading p { margin: 3px 0 0; color: var(--text-tertiary); font-size: 11px; }
.request-disclosure-heading > code { flex: 0 0 auto; padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--accent); font-size: 11px; }
.request-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0 0; }
.request-facts > div { min-width: 0; padding: 8px 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface); }
.request-facts dt { color: var(--text-tertiary); font-size: 10px; }
.request-facts dd { margin: 3px 0 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: 11px; }
.prompt-preview { display: grid; gap: 7px; margin-top: 8px; }
.prompt-preview > div { display: grid; grid-template-columns: 78px minmax(0, 1fr); align-items: start; gap: 8px; }
.prompt-preview span { padding-top: 6px; color: var(--text-tertiary); font-size: 10px; font-weight: 700; text-transform: uppercase; }
.prompt-preview code { display: block; min-width: 0; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text-secondary); font-family: var(--font-mono); font-size: 10px; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; }

.probe-section { padding: 18px; border-bottom: 1px solid var(--border); }
.probe-section:last-child { border-bottom: 0; }
.section-copy { margin-bottom: 15px; }
.section-copy h3 { margin: 0; font-size: 15px; }
.section-copy p { margin: 3px 0 0; color: var(--text-tertiary); font-size: 12px; }
.probe-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.probe-form-grid .span-2 { grid-column: span 2; }
.token-field { max-width: 240px; }

.probe-fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.probe-fieldset legend { margin-bottom: 7px; color: var(--text-secondary); font-size: 13px; font-weight: 650; }
.segment-control { display: inline-grid; grid-template-columns: repeat(2, minmax(120px, 1fr)); padding: 3px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-muted); }
.segment-control label { min-height: 34px; padding: 7px 12px; border-radius: 4px; color: var(--text-secondary); font-size: 13px; font-weight: 650; text-align: center; cursor: pointer; }
.segment-control label.active { background: var(--surface); color: var(--accent); box-shadow: var(--shadow-sm); }
.segment-control input,
.credential-choice input { position: absolute; width: 1px; height: 1px; overflow: hidden; opacity: 0; }

.model-picker { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.model-picker .btn { min-width: 128px; }
.key-load-error { color: var(--danger); font-size: 12px; line-height: 1.5; }
.credential-choice { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.credential-choice label { display: grid; min-width: 0; min-height: 68px; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px; padding: 11px 12px; border: 1px solid var(--border); border-radius: 6px; color: var(--text-secondary); cursor: pointer; }
.credential-choice label.active { border-color: #99bdb3; background: var(--accent-soft); color: var(--accent); }
.credential-choice label.unavailable { cursor: not-allowed; opacity: 0.58; }
.credential-choice strong,
.credential-choice small { display: block; }
.credential-choice strong { color: var(--text); font-size: 13px; }
.credential-choice small { margin-top: 1px; color: var(--text-tertiary); font-size: 11px; }
.auto-create-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-subtle); }
.auto-create-options > p { grid-column: 1 / -1; margin: 0; color: var(--text-tertiary); font-size: 11px; }
.auto-probe-settings { display: grid; grid-template-columns: minmax(0, 1fr) repeat(2, minmax(170px, 200px)); align-items: start; gap: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-subtle); }
.auto-probe-settings > div:first-child { align-self: center; }
.auto-probe-settings > div:first-child > span { display: block; margin-top: 4px; color: var(--text-tertiary); font-size: 11px; }
.probe-retry-settings { display: grid; grid-template-columns: minmax(0, 1fr) repeat(2, minmax(170px, 200px)); align-items: start; gap: 14px; padding: 13px 12px 0; border-top: 1px solid var(--border); }
.retry-setting-copy { align-self: center; min-width: 0; }
.retry-setting-copy strong,
.retry-setting-copy span { display: block; }
.retry-setting-copy strong { font-size: 13px; }
.retry-setting-copy span { margin-top: 3px; color: var(--text-tertiary); font-size: 11px; line-height: 1.45; }
.input-suffix { display: grid; min-height: 42px; grid-template-columns: minmax(0, 1fr) 32px; align-items: center; gap: 8px; }
.input-suffix > span { color: var(--text-secondary); font-size: 12px; font-weight: 650; }
.stored-key-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 7px; color: var(--text-secondary); font-size: 11px; }
.remove-key-button { display: inline-flex; min-height: 28px; align-items: center; gap: 5px; padding: 4px 7px; border: 0; border-radius: 4px; background: transparent; color: var(--danger); font-size: 11px; font-weight: 650; cursor: pointer; }
.remove-key-button:hover:not(:disabled) { background: var(--danger-soft); }
.remove-key-button:disabled { cursor: not-allowed; opacity: 0.5; }
.compact-button { min-height: 29px; padding: 4px 8px; font-size: 11px; }
.confirm-remove-key { border-color: #d7aaa7; background: var(--danger); color: #fff; }

.result-heading-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.run-status { min-height: 25px; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 680; white-space: nowrap; }
.run-status.success { background: var(--success-soft); color: var(--success); }
.run-status.failed { background: var(--danger-soft); color: var(--danger); }
.run-status.running { background: var(--blue-soft); color: var(--blue); }
.primary-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-block: 1px solid var(--border); }
.primary-metrics > div { min-width: 0; padding: 14px; border-right: 1px solid var(--border); }
.primary-metrics > div:last-child { border-right: 0; }
.primary-metrics small,
.primary-metrics strong,
.primary-metrics span { display: block; }
.primary-metrics small { color: var(--text-tertiary); font-size: 11px; }
.primary-metrics strong { margin: 3px 0; overflow-wrap: anywhere; font-size: 20px; font-variant-numeric: tabular-nums; line-height: 1.2; }
.primary-metrics .ttft-metric strong { color: var(--accent); font-size: 26px; }
.token-up { color: var(--blue); }
.token-down { color: var(--success); }
.primary-metrics > div > span:last-child { color: var(--text-secondary); font-size: 11px; }
.token-breakdowns { position: relative; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 9px; min-height: 29px; margin: 2px 0; }
.token-detail { position: static; }
.token-detail summary { display: inline-flex; min-height: 27px; align-items: center; gap: 4px; padding: 3px 4px; border-radius: 4px; font-size: 15px; font-weight: 700; line-height: 1.2; list-style: none; cursor: pointer; }
.token-detail summary::-webkit-details-marker { display: none; }
.token-detail summary:hover { background: var(--surface-muted); }
.token-detail summary:focus-visible { outline: 3px solid rgb(19 107 90 / 18%); outline-offset: 1px; }
.token-detail summary svg { color: var(--text-tertiary); }
.token-detail[open] summary { background: var(--surface-muted); }
.token-detail.is-warning summary { background: var(--warning-soft); }
.token-detail.is-warning summary svg { color: var(--warning); }
.token-detail.is-danger summary { background: var(--danger-soft); }
.token-detail.is-danger summary svg { color: var(--danger); }
.token-popover { position: absolute; z-index: 12; top: calc(100% + 7px); width: min(330px, calc(100vw - 48px)); padding: 12px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); box-shadow: 0 14px 34px rgb(10 24 20 / 18%); color: var(--text); }
.input-detail .token-popover { left: 0; }
.output-detail .token-popover { right: 0; }
.token-popover-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.token-popover-title > strong { margin: 0; font-size: 13px; }
.token-popover-title > span { padding: 3px 6px; border-radius: 4px; font-size: 10px; font-weight: 650; }
.assessment-within_expected { background: var(--success-soft); color: var(--success); }
.assessment-higher_than_expected { background: var(--warning-soft); color: var(--warning); }
.assessment-unknown { background: var(--surface-muted); color: var(--text-secondary); }
.token-popover dl { display: grid; gap: 5px; margin: 0; }
.token-popover dl > div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding-bottom: 5px; border-bottom: 1px solid var(--border); }
.token-popover dl > div:last-child { padding-bottom: 0; border-bottom: 0; }
.token-popover dt { color: var(--text-secondary); font-size: 11px; }
.token-popover dd { margin: 0; font-size: 12px; font-weight: 680; font-variant-numeric: tabular-nums; text-align: right; }
.token-note { margin: 9px 0 0; padding: 7px 8px; border-left: 3px solid var(--border-strong); background: var(--surface-subtle); color: var(--text-secondary); font-size: 10px; line-height: 1.45; }
.token-note.warning { border-left-color: var(--warning); background: var(--warning-soft); color: #70460c; }
.token-note.danger { border-left-color: var(--danger); background: var(--danger-soft); color: var(--danger); font-weight: 650; }

.probe-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; padding: 12px 0; border-bottom: 1px solid var(--border); }
.probe-details > div { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px; min-width: 0; padding: 5px 12px; }
.probe-details dt { color: var(--text-tertiary); font-size: 12px; }
.probe-details dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 12px; }
.behavior-signals { display: flex; flex-wrap: wrap; gap: 7px; padding-top: 12px; }
.behavior-signals span { padding: 5px 8px; border: 1px solid var(--border); border-radius: 4px; font-size: 12px; font-weight: 650; }
.signal-success { border-color: #bfdccb !important; background: var(--success-soft); color: var(--success); }
.signal-warning { border-color: #eed6ad !important; background: var(--warning-soft); color: var(--warning); }
.signal-danger { border-color: #e9c6c3 !important; background: var(--danger-soft); color: var(--danger); }
.signal-neutral { background: var(--surface-muted); color: var(--text-secondary); }
.behavior-footnote { margin: 7px 0 0; color: var(--text-tertiary); font-size: 10px; }
.probe-error-copy { margin: 12px 0 0; padding: 9px 11px; border-left: 3px solid var(--danger); background: var(--danger-soft); color: var(--danger); font-size: 12px; }

.probe-history-list { border-block: 1px solid var(--border); }
.probe-history-list > div { display: grid; grid-template-columns: auto minmax(160px, 1fr) minmax(90px, auto) minmax(90px, auto); align-items: center; gap: 10px; min-height: 54px; padding: 8px 4px; border-bottom: 1px solid var(--border); }
.probe-history-list > div:last-child { border-bottom: 0; }
.probe-history-list strong,
.probe-history-list small { display: block; }
.probe-history-list strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.probe-history-list small { color: var(--text-tertiary); font-size: 10px; }
.history-state { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 5px; }
.history-state.success { background: var(--success-soft); color: var(--success); }
.history-state.failed { background: var(--danger-soft); color: var(--danger); }
.history-state.running { background: var(--blue-soft); color: var(--blue); }

.probe-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--border); background: var(--surface-subtle); }
.probe-footer > span { display: inline-flex; align-items: center; gap: 6px; color: var(--text-tertiary); font-size: 12px; }
.probe-footer > div { display: flex; gap: 8px; }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 720px) {
  .probe-backdrop { align-items: end; padding: 0; }
  .probe-dialog { width: 100%; max-height: 96vh; border-right: 0; border-bottom: 0; border-left: 0; border-radius: 7px 7px 0 0; }
  .probe-header,
  .probe-section { padding-right: 14px; padding-left: 14px; }
  .probe-caution { padding: 11px 14px; }
  .request-disclosure { padding-right: 14px; padding-left: 14px; }
  .request-disclosure-heading { display: grid; }
  .request-disclosure-heading > code { justify-self: start; }
  .request-facts { grid-template-columns: minmax(0, 1fr); }
  .prompt-preview > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .prompt-preview span { padding-top: 0; }
  .probe-scroll > .notice { margin-right: 14px; margin-left: 14px; }
  .probe-form-grid { grid-template-columns: minmax(0, 1fr); }
  .probe-form-grid .span-2 { grid-column: span 1; }
  .credential-choice { grid-template-columns: minmax(0, 1fr); }
  .auto-probe-settings { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
  .probe-retry-settings { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
  .token-field { max-width: none; }
  .primary-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .primary-metrics > div:nth-child(2) { border-right: 0; }
  .primary-metrics > div:nth-child(-n + 2) { border-bottom: 1px solid var(--border); }
  .probe-details { grid-template-columns: minmax(0, 1fr); }
  .probe-history-list > div { grid-template-columns: auto minmax(0, 1fr) auto; }
  .probe-history-list > div > span:last-child { display: none; }
  .probe-footer { align-items: stretch; flex-direction: column; padding: 10px 14px; }
  .probe-footer > div { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 430px) {
  .probe-mark { display: none; }
  .probe-header { grid-template-columns: minmax(0, 1fr) auto; }
  .segment-control { display: grid; width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .model-picker { grid-template-columns: minmax(0, 1fr); }
  .model-picker .btn { width: 100%; }
  .auto-create-options { grid-template-columns: minmax(0, 1fr); }
  .primary-metrics { grid-template-columns: minmax(0, 1fr); }
  .primary-metrics > div,
  .primary-metrics > div:nth-child(2) { padding: 11px 9px; border-right: 0; border-bottom: 1px solid var(--border); }
  .primary-metrics > div:last-child { border-bottom: 0; }
  .primary-metrics strong { font-size: 17px; }
  .primary-metrics .ttft-metric strong { font-size: 22px; }
  .token-detail summary { font-size: 16px; }
  .input-detail .token-popover { right: auto; left: 0; width: min(310px, calc(100vw - 46px)); }
  .output-detail .token-popover { right: 0; left: auto; width: min(310px, calc(100vw - 46px)); }
  .probe-details > div { grid-template-columns: 78px minmax(0, 1fr); padding-right: 0; padding-left: 0; }
  .probe-footer > span { display: none; }
}
</style>
