import type { DatabaseConnection } from '../db/client.js';
import { balanceAlertSettings } from '../db/schema.js';

export const GLOBAL_BALANCE_ALERT_SETTINGS_ID = 'global';
export const DEFAULT_LOW_BALANCE_THRESHOLD = '10';

export interface BalanceAlertSettingsValue {
  enabled: boolean;
  threshold: string;
  updatedAt: string | null;
}

export function readBalanceAlertSettings(database: DatabaseConnection): BalanceAlertSettingsValue {
  const row = database.db.select().from(balanceAlertSettings).get();
  return row
    ? { enabled: row.enabled, threshold: row.threshold, updatedAt: row.updatedAt }
    : { enabled: true, threshold: DEFAULT_LOW_BALANCE_THRESHOLD, updatedAt: null };
}
