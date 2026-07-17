const PROBE_ERROR_LABELS: Readonly<Record<string, string>> = {
  ADAPTER_UNAVAILABLE: '适配器不可用',
  AUTH_2FA_REQUIRED: '需要二次验证',
  AUTH_INTERACTION_REQUIRED: '需要人工验证',
  AUTH_ACCESS_EXPIRED: '实测 Key 已失效',
  AUTH_REFRESH_FAILED: '凭据刷新失败',
  AUTH_INVALID_CREDENTIALS: '实测 Key 无效',
  UPSTREAM_UNREACHABLE: '上游无法连接',
  UPSTREAM_RATE_LIMITED: '上游请求受限',
  UPSTREAM_SERVER_ERROR: '上游服务器错误',
  UPSTREAM_SCHEMA_ERROR: '上游响应不兼容',
  UPSTREAM_CAPABILITY_UNSUPPORTED: '上游不支持此能力',
  RATE_PROBE_INTERRUPTED: '实测意外中断',
  RATE_PROBE_UNSUPPORTED: '当前适配器不支持实测',
  RATE_PROBE_FAILED: '模型实测失败',
};

export function probeErrorCodeLabel(code: string | null | undefined): string {
  return code ? PROBE_ERROR_LABELS[code] ?? '模型实测错误' : '模型实测错误';
}

export function probeErrorMessage(
  code: string | null | undefined,
  httpStatus?: number | null,
  fallback?: string | null,
): string {
  const status = httpStatus === null || httpStatus === undefined ? '' : `（HTTP ${httpStatus}）`;
  switch (code) {
    case 'ADAPTER_UNAVAILABLE':
      return '当前站点适配器不可用，请检查适配器配置后重试。';
    case 'AUTH_2FA_REQUIRED':
    case 'AUTH_INTERACTION_REQUIRED':
      return '上游要求完成二次验证或人工验证，当前专用 Key 无法直接执行模型实测。';
    case 'AUTH_ACCESS_EXPIRED':
    case 'AUTH_INVALID_CREDENTIALS':
      return `实测 API Key 已失效、无效或被上游拒绝${status}，请重新绑定当前分组的 Key。`;
    case 'AUTH_REFRESH_FAILED':
      return '上游凭据刷新失败，请重新登录站点或重新绑定当前分组的实测 Key。';
    case 'UPSTREAM_UNREACHABLE':
      if (fallback && /time(?:d)?\s*out|timeout|超时/i.test(fallback)) {
        return `上游模型接口请求超时${status}，请检查实测超时设置、中转网络和上游响应速度。`;
      }
      return `无法连接上游模型接口${status}，请检查中转地址、网络、DNS 和 TLS。`;
    case 'UPSTREAM_RATE_LIMITED':
      return `上游模型接口触发限流${status}，请等待限流窗口结束后重试。`;
    case 'UPSTREAM_SERVER_ERROR':
      return `上游模型接口返回服务器错误${status}。这通常表示中转或其上游模型服务暂时异常，请稍后重试；持续出现时检查中转日志。`;
    case 'UPSTREAM_SCHEMA_ERROR':
      return `上游响应格式不兼容${status}，可能没有正确实现 /v1/responses 或返回了异常流数据。`;
    case 'UPSTREAM_CAPABILITY_UNSUPPORTED':
    case 'RATE_PROBE_UNSUPPORTED':
      return '当前上游或站点适配器不支持模型实测。';
    case 'RATE_PROBE_INTERRUPTED':
      return '模型实测因服务重启或任务中断而未完成，请重新执行。';
    case 'RATE_PROBE_FAILED':
      return '模型实测失败，但上游没有提供可识别的错误原因。';
    default:
      return fallback?.trim() || '模型实测失败，但没有可用的错误说明。';
  }
}
