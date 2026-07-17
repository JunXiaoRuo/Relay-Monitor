import type { NotificationChannelTestResult } from '../types/domain';

export function notificationChannelTestMessage(result: NotificationChannelTestResult): string {
  const httpStatus = result.response_status === null ? '' : `（HTTP ${result.response_status}）`;
  if (result.succeeded) {
    return `测试成功${httpStatus}，结果已写入审计记录。`;
  }

  const failureMessage = result.error_message ?? result.error_code ?? '接收端未接受请求';
  const responseBody = result.response_body_truncated?.trim();
  const genericHttpFailure = result.response_status !== null
    && failureMessage === `接收端返回 HTTP ${result.response_status}`;
  const message = genericHttpFailure
    ? `测试失败${httpStatus}`
    : `测试失败${httpStatus}：${failureMessage}`;
  return responseBody ? `${message}\n接收端响应：${responseBody}` : message;
}
