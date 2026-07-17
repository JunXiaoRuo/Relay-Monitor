import type {
  AuthStatus,
  BalanceKind,
  CapabilityStatus,
  MonitorType,
  RateKind,
  ServiceStatus,
  SnapshotQuality,
} from './constants.js';

export type DecimalString = string;
export type Rfc3339Timestamp = string;

export interface ProbeApiKeyCreationLimits {
  quota_limit?: number;
  expires_in_seconds?: number;
}

export interface CredentialStatus {
  mode: 'password' | 'token' | 'custom';
  present_keys: string[];
  access_expires_at: Rfc3339Timestamp | null;
}

export interface SiteSummary {
  id: string;
  adapter_type: string;
  name: string;
  base_url: string;
  tags: string[];
  rate_group_scope: {
    mode: 'all' | 'selected';
    group_ids: string[];
  };
  tls_verify: boolean;
  enabled: boolean;
  service_status: ServiceStatus;
  auth_status: AuthStatus;
  credential_status?: CredentialStatus;
  created_at: Rfc3339Timestamp;
  updated_at: Rfc3339Timestamp;
}

export interface NormalizedRate {
  id?: string;
  site_id: string;
  adapter_type: string;
  rate_key: string;
  rate_kind: RateKind;
  name: string;
  platform: string | null;
  group: string | null;
  model: string | null;
  value: DecimalString;
  unit: string;
  comparison_key: string;
  billing_expression: string | null;
  attributes: Record<string, unknown>;
  metadata_status: 'available' | 'stale' | 'unavailable';
  probe_status: 'available' | 'unavailable' | 'not_configured' | 'unknown';
  collected_at: Rfc3339Timestamp;
}

export interface NormalizedRateSnapshot {
  quality: SnapshotQuality;
  rates: NormalizedRate[];
  fingerprint: string;
  collected_at: Rfc3339Timestamp;
  error_code?: string;
}

export interface NormalizedBalance {
  site_id: string;
  balance_key: string;
  balance_kind: BalanceKind;
  value: DecimalString;
  available: DecimalString | null;
  frozen: DecimalString | null;
  total: DecimalString | null;
  currency: string | null;
  unit: string;
  precision: number | null;
  collected_at: Rfc3339Timestamp;
}

export interface CapabilityValue {
  status: CapabilityStatus;
  last_error_code?: string;
}

export interface CapabilitySet {
  adapter_type: string;
  adapter_version: string;
  adapter_schema_version: string;
  upstream_version: string | null;
  structure_fingerprint: string | null;
  capabilities: Record<string, CapabilityValue>;
  detected_at: Rfc3339Timestamp;
}

export interface MonitorConfigDto {
  monitor_type: MonitorType;
  enabled: boolean;
  interval_seconds: number;
  timeout_seconds: number;
  retry_count: number;
  retry_interval_seconds: number;
  schedule_jitter_percent: number;
  runtime?: {
    state: 'queued' | 'running' | 'retry' | 'disabled';
    attempts: number;
    next_run_at: Rfc3339Timestamp;
    last_started_at: Rfc3339Timestamp | null;
    last_finished_at: Rfc3339Timestamp | null;
    last_success_at: Rfc3339Timestamp | null;
    last_error_code: string | null;
    last_error_message: string | null;
  };
}

export interface ApiSuccess<T> {
  data: T;
  request_id: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
  request_id: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
}
