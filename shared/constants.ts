export const MONITOR_TYPES = ['connectivity', 'rates', 'balance', 'auth'] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

export const SERVICE_STATUSES = [
  'healthy',
  'degraded',
  'down',
  'unknown',
  'adapter_unavailable',
] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const AUTH_STATUSES = [
  'authenticated',
  'refreshing',
  'reauth_required',
  'interaction_required',
  'invalid_credentials',
  'disabled',
  'unknown',
] as const;
export type AuthStatus = (typeof AUTH_STATUSES)[number];

export const RATE_KINDS = [
  'group',
  'model',
  'completion',
  'user_override',
  'fixed_price',
  'peak',
  'custom',
] as const;
export type RateKind = (typeof RATE_KINDS)[number];

export const BALANCE_KINDS = ['cash', 'credit', 'quota', 'token', 'custom'] as const;
export type BalanceKind = (typeof BALANCE_KINDS)[number];

export const SNAPSHOT_QUALITIES = ['complete', 'partial', 'unsupported'] as const;
export type SnapshotQuality = (typeof SNAPSHOT_QUALITIES)[number];

export const CAPABILITY_STATUSES = [
  'supported',
  'unsupported',
  'unknown',
  'incompatible',
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const JOB_STATES = ['queued', 'running', 'retry', 'disabled'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const INCIDENT_STATES = [
  'normal',
  'pending',
  'firing',
  'acknowledged',
  'recovering',
  'resolved',
  'paused',
  'suppressed',
] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export const OUTBOX_STATES = ['pending', 'sending', 'retry', 'sent', 'dead'] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const DEFAULT_MONITOR_INTERVAL_SECONDS: Record<MonitorType, number> = {
  connectivity: 300,
  rates: 300,
  balance: 300,
  auth: 300,
};

export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 15;
export const DEFAULT_SCHEDULE_JITTER_PERCENT = 10;
export const DEFAULT_MONITOR_RETRY_COUNT = 1;
export const DEFAULT_MONITOR_RETRY_INTERVAL_SECONDS = 60;
export const DEFAULT_RATE_PROBE_INTERVAL_SECONDS = 3_600;
export const MIN_RATE_PROBE_INTERVAL_SECONDS = 60;
// Keeps all next-run timestamps inside JavaScript's supported Date range.
export const MAX_RATE_PROBE_INTERVAL_SECONDS = 8_000_000_000_000;
export const DEFAULT_RATE_PROBE_TIMEOUT_SECONDS = 30;
export const MIN_RATE_PROBE_TIMEOUT_SECONDS = 1;
export const MAX_RATE_PROBE_TIMEOUT_SECONDS = 300;
export const DEFAULT_RATE_PROBE_RETRY_COUNT = 3;
export const DEFAULT_RATE_PROBE_RETRY_INTERVAL_SECONDS = 60;
export const MAX_MONITOR_RETRY_COUNT = 10;
export const MAX_MONITOR_RETRY_INTERVAL_SECONDS = 3_600;
export const DEFAULT_MAX_CONCURRENT_SITES = 5;
export const API_PAGE_SIZE = 50;
export const API_MAX_PAGE_SIZE = 200;
