import { describe, expect, it } from 'vitest';

import { notificationChannelTestMessage } from '../../frontend/src/services/notification-test.js';

describe('notification channel test display', () => {
  it('shows the sanitized receiver response after the Chinese failure message', () => {
    expect(notificationChannelTestMessage({
      succeeded: false,
      response_status: 400,
      duration_ms: 12,
      response_body_truncated: '{"details":"JSON 负载中缺失 msg 字段"}',
      error_code: 'WEBHOOK_HTTP_ERROR',
      error_message: '接收端返回 HTTP 400',
    })).toBe(
      '测试失败（HTTP 400）\n接收端响应：{"details":"JSON 负载中缺失 msg 字段"}',
    );
  });

  it('omits an empty receiver response', () => {
    expect(notificationChannelTestMessage({
      succeeded: false,
      response_status: null,
      duration_ms: 12,
      response_body_truncated: '   ',
      error_code: 'WEBHOOK_NETWORK_ERROR',
      error_message: null,
    })).toBe('测试失败：WEBHOOK_NETWORK_ERROR');
  });

  it('keeps the existing success wording', () => {
    expect(notificationChannelTestMessage({
      succeeded: true,
      response_status: 204,
      duration_ms: 12,
      response_body_truncated: 'ignored for successful tests',
      error_code: null,
      error_message: null,
    })).toBe('测试成功（HTTP 204），结果已写入审计记录。');
  });
});
