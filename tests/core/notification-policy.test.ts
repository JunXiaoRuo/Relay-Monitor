import { describe, expect, it } from 'vitest';

import {
  effectiveRepeatIntervalSeconds,
  formatRepeatInterval,
  notificationRepeatSummary,
} from '../../frontend/src/services/notification-policy.js';

describe('notification policy display', () => {
  it('explains that zero repeats sends only the first alert', () => {
    expect(notificationRepeatSummary({ repeat_interval_seconds: 0, max_repeats: 0 }))
      .toBe('关闭（只发送首次告警）');
  });

  it('uses the effective interval when a legacy cooldown is larger', () => {
    const policy = {
      repeat_interval_seconds: 60,
      cooldown_seconds: 600,
      max_repeats: 3,
    };
    expect(effectiveRepeatIntervalSeconds(policy)).toBe(600);
    expect(notificationRepeatSummary(policy)).toBe('每 10 分钟，最多再提醒 3 次');
  });

  it('describes zero interval as every following check', () => {
    expect(formatRepeatInterval(0)).toBe('每次后续检查');
    expect(notificationRepeatSummary({ repeat_interval_seconds: 0, max_repeats: 2 }))
      .toBe('每次后续检查，最多再提醒 2 次');
  });
});
