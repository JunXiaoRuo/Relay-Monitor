import { CronExpressionParser } from 'cron-parser';

export interface MaintenanceSchedule {
  enabled: boolean;
  kind: string;
  startsAt: string | null;
  endsAt: string | null;
  cronExpression: string | null;
  durationSeconds: number | null;
  timezone: string;
}

export function isValidCronExpression(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression, { currentDate: new Date(), tz: 'UTC' });
    return true;
  } catch {
    return false;
  }
}

export function isMaintenanceWindowActive(
  schedule: MaintenanceSchedule,
  at: Date | string = new Date(),
): boolean {
  if (!schedule.enabled) return false;
  const observedAt = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(observedAt.getTime())) return false;

  if (schedule.kind !== 'cron') {
    const milliseconds = observedAt.getTime();
    const startsAt = schedule.startsAt === null ? undefined : Date.parse(schedule.startsAt);
    const endsAt = schedule.endsAt === null ? undefined : Date.parse(schedule.endsAt);
    return (startsAt === undefined || startsAt <= milliseconds)
      && (endsAt === undefined || endsAt > milliseconds);
  }

  if (!schedule.cronExpression || !schedule.durationSeconds || schedule.durationSeconds <= 0) {
    return false;
  }
  try {
    // prev() is exclusive, so advance slightly to include an occurrence exactly at `at`.
    const interval = CronExpressionParser.parse(schedule.cronExpression, {
      currentDate: new Date(observedAt.getTime() + 1_000),
      tz: schedule.timezone,
    });
    const startedAt = interval.prev().toDate().getTime();
    return startedAt <= observedAt.getTime()
      && startedAt + schedule.durationSeconds * 1_000 > observedAt.getTime();
  } catch {
    return false;
  }
}
