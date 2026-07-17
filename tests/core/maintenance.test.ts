import { describe, expect, it } from 'vitest';

import {
  isMaintenanceWindowActive,
  isValidCronExpression,
} from '../../backend/core/maintenance.js';

const recurring = {
  enabled: true,
  kind: 'cron',
  startsAt: null,
  endsAt: null,
  cronExpression: '0 2 * * *',
  durationSeconds: 3_600,
  timezone: 'Asia/Shanghai',
};

describe('maintenance schedules', () => {
  it('evaluates recurring windows in their configured timezone', () => {
    expect(isMaintenanceWindowActive(recurring, '2026-07-13T18:00:00.000Z')).toBe(true);
    expect(isMaintenanceWindowActive(recurring, '2026-07-13T18:59:59.000Z')).toBe(true);
    expect(isMaintenanceWindowActive(recurring, '2026-07-13T19:00:00.000Z')).toBe(false);
  });

  it('evaluates one-time and open-ended manual windows', () => {
    expect(isMaintenanceWindowActive({
      ...recurring,
      kind: 'once',
      startsAt: '2026-07-14T01:00:00.000Z',
      endsAt: '2026-07-14T02:00:00.000Z',
      cronExpression: null,
      durationSeconds: null,
    }, '2026-07-14T01:30:00.000Z')).toBe(true);
  });

  it('rejects malformed cron expressions without throwing at evaluation time', () => {
    expect(isValidCronExpression('61 25 * * *')).toBe(false);
    expect(isMaintenanceWindowActive({ ...recurring, cronExpression: 'invalid' })).toBe(false);
  });
});
