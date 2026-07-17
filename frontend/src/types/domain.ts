import type {
  MonitorConfigDto,
  NormalizedRate,
  ProbeApiKeyCreationLimits,
  SiteSummary,
} from '../../../shared/types';
import type { IncidentState, Severity } from '../../../shared/constants';

export interface Sub2ApiGroup {
  id: string;
  name: string;
  platform: string | null;
  base_rate: string;
  user_rate: string | null;
  effective_rate: string;
}

export interface RateGroupScope {
  mode: 'all' | 'selected';
  group_ids: string[];
}

export interface UpstreamApiKey {
  id: string;
  name: string;
  group_id: string | null;
  group_name: string | null;
  status: 'active' | 'disabled' | 'expired' | 'unknown';
  expires_at: string | null;
  quota?: string | null;
  quota_used?: string | null;
}

export interface CreateUpstreamApiKeyInput extends ProbeApiKeyCreationLimits {
  group_id: string;
}

export interface ProbeKeyMappingInput {
  group_id: string;
  mode: 'none' | 'existing' | 'auto_create';
  upstream_key_id?: string;
  quota_limit?: number | null | '';
  expires_in_seconds?: number | null;
}

export interface AdminUser {
  id: string;
  username: string;
  display_name: string;
  timezone: string;
  csrf_token?: string;
}

export interface SiteViewModel extends SiteSummary {
  notes?: string;
  balance?: {
    value: string;
    currency: string;
    balance_key: string;
    collected_at: string;
  };
  latency_ms?: number;
  uptime_24h?: string;
  rate_count?: number;
  last_success_at?: string;
  last_error?: string | null;
  next_check_at?: string;
  monitor_configs?: MonitorConfigDto[];
}

export interface RateViewModel extends NormalizedRate {
  previous_value?: string | null;
  last_changed_at?: string | null;
  channel_count?: number;
  model_count?: number;
  latest_probe?: RateProbeResult | null;
  rate_monitor?: {
    state: 'queued' | 'running' | 'retry' | 'disabled';
    last_finished_at: string | null;
    last_success_at: string | null;
    last_error_code: string | null;
    last_error_message: string | null;
  } | null;
}

export type RateProbePromptIntegrity = 'no_interference_observed' | 'suspected' | 'unknown';
export type RateProbeKnowledge = 'weak_consistency' | 'suspicious' | 'not_applicable' | 'unknown';
export type RateProbeModelIdentity = 'declared_match' | 'declared_mismatch' | 'unknown';

export interface RateProbeConfig {
  rate_id: string;
  configured: boolean;
  model_mode: 'auto' | 'manual';
  model: string | null;
  key_mode: 'bound' | 'existing' | 'auto_create' | 'manual';
  bound_key_present: boolean;
  upstream_key_id: string | null;
  upstream_key_name: string | null;
  custom_api_key_present: boolean;
  max_output_tokens: number;
  auto_probe_enabled: boolean;
  probe_interval_seconds: number;
  timeout_seconds: number;
  retry_count: number;
  retry_interval_seconds: number;
  auto_create_quota_limit: number | null;
  auto_create_expires_in_seconds: number | null;
  updated_at: string | null;
}

export interface RateProbeConfigInput {
  model_mode: RateProbeConfig['model_mode'];
  model: string | null;
  key_mode: RateProbeConfig['key_mode'];
  upstream_key_id: string | null;
  max_output_tokens: number;
  auto_probe_enabled: boolean;
  probe_interval_seconds: number;
  timeout_seconds: number;
  retry_count: number;
  retry_interval_seconds: number;
  auto_create?: ProbeApiKeyCreationLimits;
  custom_api_key?: string | null;
}

export interface RateProbeModels {
  items: Array<{ id: string }>;
  selected_model: string | null;
}

export interface RateProbeResult {
  id: string;
  status: 'running' | 'success' | 'failed';
  attempt_count: number;
  requested_model: string;
  returned_model: string | null;
  ttfb_ms: number | null;
  ttft_ms: number | null;
  total_ms: number | null;
  generation_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  expected_input_tokens: number | null;
  input_token_delta: number | null;
  input_token_assessment: 'within_expected' | 'higher_than_expected' | 'unknown';
  tool_calls_observed: boolean;
  tps: number | null;
  finish_reason: string | null;
  system_fingerprint: string | null;
  prompt_integrity: RateProbePromptIntegrity;
  knowledge_probe: RateProbeKnowledge;
  model_identity: RateProbeModelIdentity;
  evidence?: {
    request_protocol?: string;
    request_path?: string;
    client_tools_declared?: boolean;
    client_tool_choice?: string;
    prompt_template_id?: string;
    upstream_tools_observed?: boolean;
    instructions_chars?: number;
    input_chars?: number;
    [key: string]: unknown;
  };
  http_status?: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  error_code: string | null;
  error_message: string | null;
}

export interface IncidentViewModel {
  id: string;
  title: string;
  event_type: string;
  site_id: string | null;
  site_name: string;
  severity: Severity;
  state: IncidentState;
  summary: string;
  resource_key: string;
  occurrence_count: number;
  repeat_count: number;
  suppressed_by_incident_id?: string | null;
  suppression_reason?: string | null;
  suppressed_by?: string | null;
  started_at: string;
  last_observed_at?: string | null;
  updated_at: string;
  deleted_at?: string | null;
}

export interface NotificationChannel {
  id: string;
  name: string;
  type: 'webhook';
  url: string;
  enabled: boolean;
  method?: 'POST';
  timeout_seconds?: number;
  headers?: Record<string, string>;
  has_headers?: boolean;
  body_mode: 'json' | 'form_data' | 'custom';
  body_template?: string | null;
  legacy_security?: boolean;
  retry_delays_seconds?: number[];
  max_response_bytes?: number;
  last_delivery_status: 'success' | 'failed' | 'never';
  last_delivery_at: string | null;
}

export interface NotificationChannelTestResult {
  succeeded: boolean;
  response_status: number | null;
  duration_ms: number;
  response_body_truncated: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface NotificationRule {
  id: string;
  name: string;
  type: string;
  severity: Severity;
  enabled: boolean;
  scope_label: string;
  recovery_confirm_count?: number;
  repeat_interval_seconds: number;
  max_repeats: number;
  channel_ids: string[];
  event_types: string[];
  current_revision?: {
    scope: Record<string, unknown>;
    condition: Record<string, unknown>;
    event_types: string[];
    recovery_confirm_count: number;
    digest_window_seconds: number;
    cooldown_seconds: number;
    repeat_interval_seconds: number;
    max_repeats: number;
    send_recovery: boolean;
    channel_ids: string[];
  };
}

export interface DeliveryRecord {
  id: string;
  event_id: string;
  channel_name: string;
  status: 'sent' | 'retry' | 'dead';
  attempt: number;
  http_status: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface MaintenanceWindow {
  id: string;
  name: string;
  enabled: boolean;
  kind: 'manual' | 'once' | 'cron';
  schedule_type: 'manual' | 'once' | 'cron';
  matcher: {
    site_ids?: string[];
    tags?: string[];
  };
  scope_label: string;
  starts_at: string | null;
  ends_at: string | null;
  cron_expression: string | null;
  duration_seconds: number | null;
  timezone: string;
  active: boolean;
  reason: string;
  created_at?: string;
  updated_at?: string;
}

export interface SilenceRecord {
  id: string;
  matcher: string;
  matcher_config: {
    site_ids?: string[];
    event_types?: string[];
    severities?: string[];
    tags?: string[];
  };
  reason: string;
  starts_at: string;
  ends_at: string;
  created_by: string;
  expires_at: string;
  active: boolean;
  deleted_at?: string | null;
}

export interface SystemStatus {
  version: string;
  started_at: string;
  scheduler_running: boolean;
  scheduler_lag_ms: number;
  running_jobs: number;
  queued_jobs: number;
  last_schedule_success_at: string;
  outbox_pending: number;
  outbox_dead: number;
  database_size_bytes: number;
  wal_size_bytes: number;
  last_backup_at: string | null;
  event_loop_lag_ms: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  adapter_versions: Array<{
    type: string;
    version: string;
    status: 'ready' | 'incompatible';
  }>;
}

export interface AuditLog {
  id: string;
  action: string;
  actor: string;
  target: string;
  resource_type?: string;
  resource_id?: string | null;
  result: 'success' | 'failed';
  created_at: string;
  request_id: string;
}

export interface DeleteRecordsResult {
  deleted_count: number;
}

export interface BalanceAlertSettings {
  enabled: boolean;
  threshold: string;
  updated_at: string | null;
  queued_checks?: number;
}

export interface ServerCertificateMetadata {
  configured: boolean;
  subject: string | null;
  issuer: string | null;
  subject_alt_name: string | null;
  valid_from: string | null;
  valid_to: string | null;
  fingerprint_sha256: string | null;
  host_matches: boolean | null;
}

export interface ServerAccessSettings {
  protocol: 'http' | 'https';
  access_host: string;
  listen_host: string;
  listen_port: number;
  active_protocol: 'http' | 'https';
  active_url: string;
  next_url: string;
  restart_required: boolean;
  managed_restart: boolean;
  restarting?: boolean;
  updated_at: string | null;
  certificate: ServerCertificateMetadata;
}

export interface ServerAccessSettingsInput {
  protocol: ServerAccessSettings['protocol'];
  access_host: string;
  certificate_pem?: string;
  private_key_pem?: string;
}

export interface DashboardSeriesPoint {
  time: string;
  healthy: number;
  degraded: number;
  down: number;
  p95_latency_ms: number;
}
