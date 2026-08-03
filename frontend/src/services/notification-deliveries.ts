import type { DeliveryRecord } from '../types/domain';

export interface DeliveryOutboxSummary {
  retry: number;
  dead: number;
}

export function summarizeDeliveryOutboxes(
  deliveries: readonly DeliveryRecord[],
): DeliveryOutboxSummary {
  const states = new Map<string, DeliveryRecord['status']>();
  for (const delivery of deliveries) {
    states.set(delivery.outbox_message_id, delivery.status);
  }
  return {
    retry: [...states.values()].filter((state) => state === 'retry').length,
    dead: [...states.values()].filter((state) => state === 'dead').length,
  };
}
