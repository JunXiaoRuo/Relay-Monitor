<script setup lang="ts">
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  CircleX,
  Clock3,
  PauseCircle,
  RefreshCw,
  ShieldAlert,
} from '@lucide/vue';
import { computed, type Component } from 'vue';

const props = defineProps<{
  status: string;
  label?: string | undefined;
}>();

const definitions: Record<string, { label: string; tone: string; icon: Component }> = {
  healthy: { label: '正常', tone: 'success', icon: CheckCircle2 },
  authenticated: { label: '已登录', tone: 'success', icon: CheckCircle2 },
  available: { label: '可用', tone: 'success', icon: CheckCircle2 },
  ready: { label: '就绪', tone: 'success', icon: CheckCircle2 },
  success: { label: '成功', tone: 'success', icon: CheckCircle2 },
  sent: { label: '已发送', tone: 'success', icon: CheckCircle2 },
  resolved: { label: '已恢复', tone: 'success', icon: CheckCircle2 },
  degraded: { label: '降级', tone: 'warning', icon: CircleAlert },
  warning: { label: '警告', tone: 'warning', icon: CircleAlert },
  pending: { label: '告警中', tone: 'danger', icon: CircleAlert },
  recovering: { label: '恢复观察中', tone: 'warning', icon: RefreshCw },
  refreshing: { label: '刷新中', tone: 'info', icon: RefreshCw },
  retry: { label: '等待重试', tone: 'warning', icon: RefreshCw },
  down: { label: '宕机', tone: 'danger', icon: CircleX },
  critical: { label: '严重', tone: 'danger', icon: CircleX },
  failed: { label: '失败', tone: 'danger', icon: CircleX },
  dead: { label: '投递终止', tone: 'danger', icon: CircleX },
  firing: { label: '告警中', tone: 'danger', icon: CircleAlert },
  reauth_required: { label: '需重新登录', tone: 'danger', icon: ShieldAlert },
  invalid_credentials: { label: '凭据无效', tone: 'danger', icon: ShieldAlert },
  interaction_required: { label: '需人工验证', tone: 'violet', icon: ShieldAlert },
  adapter_unavailable: { label: '适配器不可用', tone: 'danger', icon: Ban },
  acknowledged: { label: '告警中', tone: 'danger', icon: CircleAlert },
  info: { label: '信息', tone: 'info', icon: CircleAlert },
  not_configured: { label: '未配置实测', tone: 'neutral', icon: CircleHelp },
  unavailable: { label: '不可用', tone: 'danger', icon: CircleX },
  stale: { label: '数据陈旧', tone: 'warning', icon: Clock3 },
  disabled: { label: '已停用', tone: 'neutral', icon: PauseCircle },
  paused: { label: '已暂停', tone: 'neutral', icon: PauseCircle },
  suppressed: { label: '已抑制', tone: 'neutral', icon: Ban },
  unknown: { label: '未知', tone: 'neutral', icon: CircleHelp },
  never: { label: '从未投递', tone: 'neutral', icon: CircleHelp },
};

const definition = computed(() => definitions[props.status] ?? {
  label: props.status,
  tone: 'neutral',
  icon: CircleHelp,
});
</script>

<template>
  <span class="status-badge" :class="`tone-${definition.tone}`">
    <component :is="definition.icon" :size="13" aria-hidden="true" />
    {{ label ?? definition.label }}
  </span>
</template>

<style scoped>
.status-badge {
  display: inline-flex;
  min-height: 26px;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 660;
  line-height: 1.15;
  white-space: nowrap;
}

.tone-success { border-color: #c3ddce; background: var(--success-soft); color: var(--success); }
.tone-warning { border-color: #ead4ad; background: var(--warning-soft); color: var(--warning); }
.tone-danger { border-color: #e5c4c1; background: var(--danger-soft); color: var(--danger); }
.tone-info { border-color: #c8d9e8; background: var(--blue-soft); color: var(--blue); }
.tone-violet { border-color: #d7cce5; background: var(--violet-soft); color: var(--violet); }
.tone-neutral { border-color: var(--border); background: var(--surface-muted); color: var(--text-secondary); }
</style>
