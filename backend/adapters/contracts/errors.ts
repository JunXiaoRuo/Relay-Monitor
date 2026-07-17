export const ADAPTER_ERROR_CODES = [
  'ADAPTER_UNAVAILABLE',
  'AUTH_2FA_REQUIRED',
  'AUTH_INTERACTION_REQUIRED',
  'AUTH_ACCESS_EXPIRED',
  'AUTH_REFRESH_FAILED',
  'AUTH_INVALID_CREDENTIALS',
  'UPSTREAM_UNREACHABLE',
  'UPSTREAM_RATE_LIMITED',
  'UPSTREAM_SERVER_ERROR',
  'UPSTREAM_SCHEMA_ERROR',
  'UPSTREAM_CAPABILITY_UNSUPPORTED',
] as const;

export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: AdapterErrorCode,
    message: string,
    options: {
      cause?: unknown;
      retryable?: boolean;
      httpStatus?: number;
      retryAfterMs?: number;
      details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AdapterError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details ?? {};
  }
}

export function isAdapterError(error: unknown, code?: AdapterErrorCode): error is AdapterError {
  return error instanceof AdapterError && (code === undefined || error.code === code);
}

export function adapterErrorCode(error: unknown): AdapterErrorCode | undefined {
  return error instanceof AdapterError ? error.code : undefined;
}

export function adapterErrorPublicMessage(
  error: Pick<AdapterError, 'code' | 'httpStatus' | 'details'>,
): string {
  const status = error.httpStatus === undefined ? '' : `（HTTP ${error.httpStatus}）`;
  switch (error.code) {
    case 'ADAPTER_UNAVAILABLE':
      return '当前站点适配器不可用，请检查适配器配置。';
    case 'AUTH_2FA_REQUIRED':
      return '目标站点要求二次验证，请完成验证后重试。';
    case 'AUTH_INTERACTION_REQUIRED':
      return '目标站点要求人工验证，请完成验证后重试。';
    case 'AUTH_ACCESS_EXPIRED':
      return `Access Token 无效或已过期${status}，请重新登录或更新凭据。`;
    case 'AUTH_REFRESH_FAILED':
      return `登录状态刷新失败${status}，请重新登录或更新凭据。`;
    case 'AUTH_INVALID_CREDENTIALS':
      return `邮箱或密码错误，或目标站点拒绝了登录凭据${status}。`;
    case 'UPSTREAM_UNREACHABLE':
      return error.details.reason === 'timeout'
        ? '连接目标站点超时，请检查地址、网络、DNS 和 TLS。'
        : '无法连接目标站点，请检查地址、网络、DNS 和 TLS。';
    case 'UPSTREAM_RATE_LIMITED':
      return `目标站点触发请求限流${status}，请稍后重试。`;
    case 'UPSTREAM_SERVER_ERROR':
      return `目标站点或其上游服务发生错误${status}，请稍后重试。`;
    case 'UPSTREAM_SCHEMA_ERROR':
      return `目标站点返回的数据格式不兼容${status}，请检查站点版本和适配器。`;
    case 'UPSTREAM_CAPABILITY_UNSUPPORTED':
      return `目标站点不支持当前操作${status}。`;
  }
}
