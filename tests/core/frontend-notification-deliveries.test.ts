import { describe, expect, it } from 'vitest';

import { summarizeDeliveryOutboxes } from '../../frontend/src/services/notification-deliveries.js';
import type { DeliveryRecord } from '../../frontend/src/types/domain.js';

function delivery(
  outboxMessageId: string,
  status: DeliveryRecord['status'],
  attempt: number,
): DeliveryRecord {
  return {
    id: `${outboxMessageId}-${attempt}`,
    outbox_message_id: outboxMessageId,
    event_id: 'event-test',
    channel_name: 'QQ通知',
    status,
    notification_content: '测试通知',
    notification_created_at: '2026-08-02T10:00:00.000Z',
    attempt,
    http_status: null,
    duration_ms: 5,
    created_at: '2026-08-02T10:00:01.000Z',
  };
}

describe('notification delivery summary', () => {
  it('counts distinct outbox messages instead of delivery attempts', () => {
    expect(summarizeDeliveryOutboxes([
      delivery('outbox-a', 'dead', 1),
      delivery('outbox-a', 'dead', 2),
      delivery('outbox-a', 'dead', 3),
      delivery('outbox-a', 'dead', 4),
      delivery('outbox-b', 'retry', 1),
      delivery('outbox-b', 'retry', 2),
      delivery('outbox-c', 'sent', 1),
    ])).toEqual({ retry: 1, dead: 1 });
  });
});
