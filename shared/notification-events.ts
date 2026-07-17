export const SITE_NOTIFICATION_EVENT_TYPES = [
  'site.network_unreachable',
  'site.timeout',
  'site.auth_expired',
  'site.permission_denied',
  'site.rate_limited',
  'site.upstream_5xx',
  'site.schema_incompatible',
  'site.other_error',
  'site.recovered',
] as const;

export const RATE_NOTIFICATION_EVENT_TYPES = [
  'rate.changed',
  'rate.added',
  'rate.removed',
] as const;

export const PROBE_NOTIFICATION_EVENT_TYPES = [
  'probe.input_tokens_high',
  'probe.unexpected_tool_calls',
  'probe.prompt_interference',
  'probe.model_mismatch',
  'probe.failed',
  'probe.recovered',
] as const;

export const BALANCE_NOTIFICATION_EVENT_TYPES = [
  'balance.low',
] as const;

export const MONITOR_NOTIFICATION_EVENT_TYPES = [
  ...SITE_NOTIFICATION_EVENT_TYPES,
  ...RATE_NOTIFICATION_EVENT_TYPES,
  ...PROBE_NOTIFICATION_EVENT_TYPES,
  ...BALANCE_NOTIFICATION_EVENT_TYPES,
] as const;

export const NOTIFICATION_EVENT_TYPES = [
  ...SITE_NOTIFICATION_EVENT_TYPES,
  ...RATE_NOTIFICATION_EVENT_TYPES,
  ...PROBE_NOTIFICATION_EVENT_TYPES,
  ...BALANCE_NOTIFICATION_EVENT_TYPES,
  'balance.threshold',
  'rate.threshold',
] as const;

export type NotificationEventType = typeof NOTIFICATION_EVENT_TYPES[number];

export function defaultMonitorEventTypes(): NotificationEventType[] {
  return [...MONITOR_NOTIFICATION_EVENT_TYPES];
}

export function notificationEventTypesForRuleType(type: string): NotificationEventType[] {
  if (type === 'monitor_events') return defaultMonitorEventTypes();
  if (['site_down', 'site_health', 'health', 'health_status'].includes(type)) {
    return [...SITE_NOTIFICATION_EVENT_TYPES];
  }
  if (type === 'auth_failed') {
    return ['site.auth_expired', 'site.permission_denied', 'site.recovered'];
  }
  if (type === 'rate_changed') {
    return [...RATE_NOTIFICATION_EVENT_TYPES, ...PROBE_NOTIFICATION_EVENT_TYPES];
  }
  if (type === 'rate_threshold') return ['rate.threshold'];
  if (type === 'balance_low') return ['balance.low'];
  if (type === 'balance_threshold') return ['balance.threshold'];
  return [...NOTIFICATION_EVENT_TYPES];
}
