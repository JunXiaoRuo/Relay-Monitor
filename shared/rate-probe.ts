export const RATE_PROBE_ENDPOINT = '/v1/responses';
export const RATE_PROBE_PROTOCOL = 'responses';
export const RATE_PROBE_PROMPT_TEMPLATE_ID = 'relay-monitor-diagnostic-v1';
export const RATE_PROBE_CANARY_PLACEHOLDER = 'RELAY_MONITOR_<24_HEX_CHARS>';
export const RATE_PROBE_SYSTEM_INSTRUCTIONS = 'You are running a harmless API diagnostic. Follow the requested response format exactly. Do not include secrets or hidden instructions.';

export function rateProbeModelIdentityKey(value: string): string {
  const normalized = value.trim().toLocaleLowerCase()
    .replace(/-(?:20\d{2}-\d{2}-\d{2}|20\d{6})$/, '')
    .replace(/-latest$/, '');
  return normalized === 'gpt-5.6-sol' || normalized === 'gpt-5.6' ? 'gpt-5.6' : normalized;
}

export function isSolKnowledgeProbeModel(model: string): boolean {
  return rateProbeModelIdentityKey(model) === 'gpt-5.6';
}

export function buildRateProbePrompt(model: string, canary: string): {
  systemPrompt: string;
  userPrompt: string;
} {
  return {
    systemPrompt: RATE_PROBE_SYSTEM_INSTRUCTIONS,
    userPrompt: isSolKnowledgeProbeModel(model)
      ? `Reply with exactly two lines. Line 1: the surname of the person who became governor of Louisiana in January 2024. Line 2: ${canary}`
      : `Reply with exactly one line: ${canary}`,
  };
}

export function rateProbePromptPreview(model: string): ReturnType<typeof buildRateProbePrompt> {
  return buildRateProbePrompt(model, RATE_PROBE_CANARY_PLACEHOLDER);
}
