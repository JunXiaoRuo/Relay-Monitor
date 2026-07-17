import type { Page } from '../../../shared/types';
import type {
  AdminUser,
  AuditLog,
  BalanceAlertSettings,
  CreateUpstreamApiKeyInput,
  DeleteRecordsResult,
  DeliveryRecord,
  IncidentViewModel,
  MaintenanceWindow,
  NotificationChannel,
  NotificationChannelTestResult,
  NotificationRule,
  RateProbeConfig,
  RateProbeConfigInput,
  RateProbeModels,
  RateProbeResult,
  RateViewModel,
  ServerAccessSettings,
  ServerAccessSettingsInput,
  Sub2ApiGroup,
  UpstreamApiKey,
  SilenceRecord,
  SiteViewModel,
  SystemStatus,
} from '../types/domain';
import { buildQueryString } from './query';
import { createClientId } from './client-id';

export interface AuditLogQuery {
  search?: string | undefined;
  result?: 'success' | 'failed' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page?: number;
  page_size?: number;
}

const API_BASE = '/api/v1';
let csrfToken = '';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token ?? '';
}

function makeRequestId(): string {
  return `web_${createClientId()}`;
}

function makeIdempotencyKey(): string {
  return `idem_${createClientId()}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('X-Request-ID', makeRequestId());
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (csrfToken && init.method && !['GET', 'HEAD'].includes(init.method)) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers,
    });
  } catch {
    throw new ApiClientError(0, 'NETWORK_UNAVAILABLE', '无法连接 Relay Monitor API');
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const errorPayload = payload as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    } | null;
    throw new ApiClientError(
      response.status,
      errorPayload?.error?.code ?? 'HTTP_ERROR',
      errorPayload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
      errorPayload?.error?.details ?? {},
    );
  }

  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

function post<T>(path: string, body?: unknown, idempotent = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (idempotent) headers['Idempotency-Key'] = makeIdempotencyKey();
  return request<T>(path, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

function put<T>(path: string, body: unknown, idempotent = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (idempotent) headers['Idempotency-Key'] = makeIdempotencyKey();
  return request<T>(path, { method: 'PUT', headers, body: JSON.stringify(body) });
}

function remove<T = void>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

export const api = {
  session: {
    login: (username: string, password: string) =>
      post<AdminUser>('/session/login', { username, password }),
    logout: () => post<void>('/session/logout'),
    me: () => request<AdminUser>('/session/me'),
    changePassword: (currentPassword: string, newPassword: string) =>
      put<{ revoked_session_count: number }>('/session/password', {
        current_password: currentPassword,
        new_password: newPassword,
      }),
  },
  adapters: {
    list: () => request<Array<{ adapter_type: string; display_name: string; adapter_version: string }>>('/adapters'),
    discover: (body: { adapter_type: string; base_url: string }) => post<Record<string, unknown>>('/sites/discover', body),
  },
  sites: {
    list: (page = 1, pageSize = 200) =>
      request<Page<SiteViewModel>>(`/sites${buildQueryString({ page, page_size: pageSize })}`),
    get: (id: string) => request<SiteViewModel>(`/sites/${encodeURIComponent(id)}`),
    create: (body: unknown) => post<SiteViewModel>('/sites', body, true),
    update: (id: string, body: unknown) => patch<SiteViewModel>(`/sites/${encodeURIComponent(id)}`, body),
    remove: (id: string) => remove(`/sites/${encodeURIComponent(id)}`),
    credentials: (id: string, body: unknown) => put<void>(`/sites/${encodeURIComponent(id)}/credentials`, body),
    check: (id: string, monitorType: string) => post<void>(`/sites/${encodeURIComponent(id)}/check/${encodeURIComponent(monitorType)}`),
    updateMonitor: (id: string, monitorType: string, body: unknown) =>
      patch<void>(`/sites/${encodeURIComponent(id)}/monitors/${encodeURIComponent(monitorType)}`, body),
    authTest: (id: string) => post<Record<string, unknown>>(`/sites/${encodeURIComponent(id)}/auth/test`),
    discoverGroups: (body: unknown) => post<{ items: Sub2ApiGroup[] }>('/sites/groups/discover', body),
    groups: (id: string) => request<{ items: Sub2ApiGroup[] }>(`/sites/${encodeURIComponent(id)}/groups`),
    discoverApiKeys: (body: unknown) => post<{ items: UpstreamApiKey[] }>('/sites/api-keys/discover', body),
    apiKeys: (id: string) => request<{ items: UpstreamApiKey[] }>(`/sites/${encodeURIComponent(id)}/upstream-api-keys`),
    createApiKey: (id: string, body: CreateUpstreamApiKeyInput) =>
      post<UpstreamApiKey>(`/sites/${encodeURIComponent(id)}/upstream-api-keys`, body, true),
  },
  rates: {
    list: (query = '', page = 1, pageSize = 200) => {
      const pagination = buildQueryString({ page, page_size: pageSize });
      return request<Page<RateViewModel>>(`/rates${pagination}${query ? `&${query.replace(/^\?/, '')}` : ''}`);
    },
    probeConfig: (id: string) => request<RateProbeConfig>(`/rates/${encodeURIComponent(id)}/probe-config`),
    saveProbeConfig: (id: string, body: RateProbeConfigInput) =>
      put<RateProbeConfig>(`/rates/${encodeURIComponent(id)}/probe-config`, body, true),
    probeModels: (id: string) => post<RateProbeModels>(`/rates/${encodeURIComponent(id)}/probe-models`, {}),
    runProbe: (id: string) => post<RateProbeResult>(`/rates/${encodeURIComponent(id)}/probe`, {}, true),
    probeRuns: (id: string) =>
      request<Page<RateProbeResult>>(`/rates/${encodeURIComponent(id)}/probes?page=1&page_size=5`),
    remove: (id: string) => remove(`/rates/${encodeURIComponent(id)}`),
  },
  incidents: {
    list: (page = 1, pageSize = 200) =>
      request<Page<IncidentViewModel>>(`/incidents${buildQueryString({ page, page_size: pageSize })}`),
    silence: (id: string, body: unknown) => post<void>(`/incidents/${encodeURIComponent(id)}/silence`, body),
    remove: (id: string) => remove(`/incidents/${encodeURIComponent(id)}`),
    deleteMany: (ids: string[]) => post<DeleteRecordsResult>('/incidents/batch-delete', { ids }),
    deleteByTime: (before: string) => post<DeleteRecordsResult>('/incidents/delete-by-time', { before }),
    deleteAll: () => remove<DeleteRecordsResult>('/incidents'),
  },
  settings: {
    balanceAlert: () => request<BalanceAlertSettings>('/settings/balance-alert'),
    updateBalanceAlert: (body: Pick<BalanceAlertSettings, 'enabled' | 'threshold'>) =>
      patch<BalanceAlertSettings>('/settings/balance-alert', body),
    serverAccess: () => request<ServerAccessSettings>('/settings/server-access'),
    updateServerAccess: (body: ServerAccessSettingsInput) =>
      patch<ServerAccessSettings>('/settings/server-access', body),
  },
  notifications: {
    channels: () => request<NotificationChannel[]>('/notification-channels'),
    createChannel: (body: unknown) => post<NotificationChannel>('/notification-channels', body, true),
    updateChannel: (id: string, body: unknown) => patch<NotificationChannel>(`/notification-channels/${encodeURIComponent(id)}`, body),
    deleteChannel: (id: string) => remove(`/notification-channels/${encodeURIComponent(id)}`),
    testChannel: (id: string) =>
      post<NotificationChannelTestResult>(`/notification-channels/${encodeURIComponent(id)}/test`),
    rules: () => request<NotificationRule[]>('/notification-rules'),
    createRule: (body: unknown) => post<NotificationRule>('/notification-rules', body),
    updateRule: (id: string, body: unknown) => patch<NotificationRule>(`/notification-rules/${encodeURIComponent(id)}`, body),
    deleteRule: (id: string) => remove(`/notification-rules/${encodeURIComponent(id)}`),
    deliveries: (page = 1, pageSize = 200) =>
      request<Page<DeliveryRecord>>(`/notification-deliveries${buildQueryString({ page, page_size: pageSize })}`),
    replay: (id: string) => post<void>(`/notification-deliveries/${encodeURIComponent(id)}/replay`, undefined, true),
  },
  maintenance: {
    list: (page = 1, pageSize = 20) =>
      request<Page<MaintenanceWindow>>(`/maintenance-windows?page=${page}&page_size=${pageSize}`),
    create: (body: unknown) => post<MaintenanceWindow>('/maintenance-windows', body, true),
    update: (id: string, body: unknown) => patch<MaintenanceWindow>(`/maintenance-windows/${encodeURIComponent(id)}`, body),
    remove: (id: string) => remove(`/maintenance-windows/${encodeURIComponent(id)}`),
    silences: (page = 1, pageSize = 20) =>
      request<Page<SilenceRecord>>(`/silences?page=${page}&page_size=${pageSize}`),
    createSilence: (body: unknown) => post<SilenceRecord>('/silences', body),
    updateSilence: (id: string, body: unknown) =>
      patch<SilenceRecord>(`/silences/${encodeURIComponent(id)}`, body),
    deleteSilence: (id: string) => remove(`/silences/${encodeURIComponent(id)}`),
  },
  system: {
    status: () => request<SystemStatus>('/system/status'),
    backup: () => post<{ backup_path?: string }>('/system/backup', undefined, true),
    auditLogs: (query: AuditLogQuery = {}) => request<Page<AuditLog>>(`/audit-logs${buildQueryString({
      page: query.page ?? 1,
      page_size: query.page_size ?? 20,
      search: query.search,
      result: query.result,
      from: query.from,
      to: query.to,
    })}`),
    deleteAuditLog: (id: string) => remove(`/audit-logs/${encodeURIComponent(id)}`),
    deleteAuditLogs: (ids: string[]) =>
      post<DeleteRecordsResult>('/audit-logs/batch-delete', { ids }),
    deleteAuditLogsByTime: (before: string) =>
      post<DeleteRecordsResult>('/audit-logs/delete-by-time', { before }),
    deleteAllAuditLogs: () => remove<DeleteRecordsResult>('/audit-logs'),
  },
};

export function pageItems<T>(page: Page<T> | T[]): T[] {
  return Array.isArray(page) ? page : page.items;
}
