export const SYSTEM_EVENT_RULE_ID = 'rule_system_event_fallback';
export const SYSTEM_EVENT_RULE_REVISION_ID = 'rulerev_system_event_fallback_v2';

export function isSystemEventRuleId(ruleId: string): boolean {
  return ruleId === SYSTEM_EVENT_RULE_ID;
}
