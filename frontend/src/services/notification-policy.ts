export interface NotificationRepeatPolicy {
  repeat_interval_seconds: number;
  max_repeats: number;
  cooldown_seconds?: number | undefined;
  current_revision?: {
    cooldown_seconds?: number | undefined;
  };
}

function nonNegativeInteger(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value ?? 0));
}

export function effectiveRepeatIntervalSeconds(policy: NotificationRepeatPolicy): number {
  const interval = nonNegativeInteger(policy.repeat_interval_seconds);
  const cooldown = nonNegativeInteger(
    policy.cooldown_seconds ?? policy.current_revision?.cooldown_seconds,
  );
  return Math.max(interval, cooldown);
}

export function formatRepeatInterval(seconds: number): string {
  const normalized = nonNegativeInteger(seconds);
  if (normalized === 0) return '每次后续检查';
  if (normalized < 60 || normalized % 60 !== 0) return `${normalized} 秒`;
  if (normalized % 3_600 === 0) return `${normalized / 3_600} 小时`;
  return `${normalized / 60} 分钟`;
}

export function notificationRepeatSummary(policy: NotificationRepeatPolicy): string {
  const repeats = nonNegativeInteger(policy.max_repeats);
  if (repeats === 0) return '关闭（只发送首次告警）';
  const interval = effectiveRepeatIntervalSeconds(policy);
  const timing = interval === 0 ? '每次后续检查' : `每 ${formatRepeatInterval(interval)}`;
  return `${timing}，最多再提醒 ${repeats} 次`;
}
