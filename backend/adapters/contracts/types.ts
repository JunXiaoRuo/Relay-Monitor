import type { z } from 'zod';

export const ADAPTER_CONTRACT_VERSION = '1.0' as const;

export type MonitorType = 'auth' | 'balance' | 'connectivity' | 'rates';
export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown' | 'incompatible';
export type CredentialMode = 'password' | 'token';

export interface CredentialField {
  key: string;
  input: 'email' | 'password' | 'text' | 'toggle';
  secret: boolean;
  required?: boolean;
  requiredWhen?: CredentialMode[];
  persistable?: boolean;
}

export interface AdapterManifest {
  contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  adapterType: string;
  adapterVersion: string;
  adapterSchemaVersion: number;
  displayName: string;
  monitorTypes: readonly MonitorType[];
  credentialFields: readonly CredentialField[];
  sensitiveFields: readonly string[];
  capabilities: Readonly<{
    authRefresh: boolean;
    balances: boolean;
    rates: boolean;
    channels: boolean;
    activeProbe: boolean;
  }>;
}

export interface CredentialInput {
  mode: CredentialMode;
  values: Record<string, string | boolean | undefined>;
  persistKeys?: readonly string[] | undefined;
}

export interface SiteContext {
  siteId: string;
  baseUrl: string;
  credentials?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  now?: Date;
  adapterMetadata?: Readonly<Record<string, unknown>>;
  onAuthUpdate?: (update: AuthUpdate) => void | Promise<void>;
}

export interface Capability {
  status: CapabilityStatus;
  checkedAt: string;
  lastErrorCode?: string;
}

export interface CapabilitySet {
  adapterType: string;
  adapterVersion: string;
  adapterSchemaVersion: number;
  detectedAt: string;
  upstreamVersion?: string;
  responseStructureFingerprint?: string;
  capabilities: Readonly<Record<string, Capability>>;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: string;
}

export interface AuthenticatedResult {
  status: 'authenticated';
  tokens: AuthTokens;
  user?: {
    id?: string;
    email?: string;
    username?: string;
  };
}

export interface InteractionRequiredResult {
  status: 'interaction_required';
  challenge: 'two_factor' | 'turnstile' | 'other';
  temporaryToken?: string;
  maskedIdentity?: string;
  message: string;
}

export type AuthResult = AuthenticatedResult | InteractionRequiredResult;

export interface AuthChallengeInput {
  challenge: 'two_factor';
  temporaryToken: string;
  code: string;
}

export interface AuthUpdate {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface HealthResult {
  status: 'healthy' | 'degraded' | 'down';
  probeKind: 'model_api' | 'user_api';
  authenticated: boolean | null;
  latencyMs: number;
  checkedAt: string;
  httpStatus?: number;
  modelCount?: number;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  authUpdate?: AuthUpdate;
}

export type BalanceKind = 'cash' | 'credit' | 'quota' | 'token' | 'custom';

export interface NormalizedBalance {
  balanceKey: string;
  balanceKind: BalanceKind;
  value: string;
  unit: string;
  precision?: number;
  available?: string;
  frozen?: string;
  total?: string;
  collectedAt: string;
  attributes?: Readonly<Record<string, string | boolean | null>>;
}

export type RateKind =
  | 'group'
  | 'model'
  | 'completion'
  | 'user_override'
  | 'fixed_price'
  | 'peak'
  | 'custom';

export interface NormalizedRate {
  rateKey: string;
  rateKind: RateKind;
  name: string;
  platform?: string;
  group?: string;
  model?: string;
  value: string | null;
  unit: string;
  comparisonKey: string;
  billingExpression?: string;
  metadataStatus: 'available' | 'missing' | 'unknown';
  probeStatus: 'available' | 'unavailable' | 'not_configured' | 'unknown';
  collectedAt: string;
  dataQuality: 'complete' | 'partial';
  matchConfidence?: 'high' | 'low';
  attributes?: Readonly<Record<string, string | boolean | null>>;
}

export interface RateSourceStatus {
  source: string;
  required: boolean;
  status: 'success' | 'unsupported' | 'failed' | 'incompatible';
  errorCode?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

export interface NormalizedRateSnapshot {
  quality: 'complete' | 'partial' | 'unsupported';
  collectedAt: string;
  rates: readonly NormalizedRate[];
  sources: readonly RateSourceStatus[];
  fingerprint?: string;
  authUpdate?: AuthUpdate;
}

export interface ProbeModel {
  id: string;
  ownedBy?: string;
}

export interface ProbeModelCatalog {
  models: readonly ProbeModel[];
  fetchedAt: string;
}

export interface ProbeApiKey {
  id: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  status: string;
  expiresAt: string | null;
  quota: string | null;
  quotaUsed: string | null;
  /** Transient upstream secret. It must only be stored in the credential vault. */
  secretKey: string;
}

export interface CreateProbeApiKeyRequest {
  name: string;
  groupId: string;
  quota?: number;
  expiresInDays?: number;
  idempotencyKey?: string;
}

export interface ModelProbeRequest {
  model: string;
  maxOutputTokens: number;
  systemPrompt: string;
  userPrompt: string;
}

export interface ModelProbeUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
}

export interface ModelProbeResult {
  requestedModel: string;
  returnedModel: string | null;
  httpStatus: number;
  ttfbMs: number | null;
  ttftMs: number | null;
  totalMs: number;
  generationMs: number | null;
  usage: ModelProbeUsage;
  tps: string | null;
  finishReason: string | null;
  systemFingerprint: string | null;
  toolCallsObserved: boolean;
  upstreamToolsObserved: boolean;
  /** Transient probe output. Callers must not persist or log this value. */
  outputText: string;
}

export interface RelayAdapter {
  readonly credentialSchema: z.ZodType<CredentialInput>;
  manifest(): AdapterManifest;
  discover(ctx: SiteContext): Promise<CapabilitySet>;
  authenticate(ctx: SiteContext, input: CredentialInput): Promise<AuthResult>;
  completeAuthChallenge?(ctx: SiteContext, input: AuthChallengeInput): Promise<AuthResult>;
  refreshAuth?(ctx: SiteContext): Promise<AuthResult>;
  collectConnectivity(ctx: SiteContext): Promise<HealthResult>;
  collectBalances(ctx: SiteContext): Promise<NormalizedBalance[]>;
  collectRates(ctx: SiteContext): Promise<NormalizedRateSnapshot>;
  listProbeModels?(ctx: SiteContext): Promise<ProbeModelCatalog>;
  probeModel?(ctx: SiteContext, input: ModelProbeRequest): Promise<ModelProbeResult>;
  listProbeApiKeys?(ctx: SiteContext): Promise<readonly ProbeApiKey[]>;
  createProbeApiKey?(ctx: SiteContext, input: CreateProbeApiKeyRequest): Promise<ProbeApiKey>;
  deleteProbeApiKey?(ctx: SiteContext, upstreamKeyId: string): Promise<void>;
}
