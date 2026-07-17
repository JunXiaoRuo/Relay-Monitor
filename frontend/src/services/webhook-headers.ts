const MASKED_HEADER_VALUE = '[REDACTED]';

export function webhookHeaderEditorState(headers?: Readonly<Record<string, string>>): {
  names: string[];
  text: string;
} {
  const names = Object.keys(headers ?? {});
  return {
    names,
    text: names.length > 0
      ? JSON.stringify(Object.fromEntries(names.map((name) => [name, ''])), null, 2)
      : '',
  };
}

export function parseWebhookHeaderEditor(
  text: string,
  existingNames: ReadonlySet<string>,
): Record<string, string> {
  if (!text.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('额外 Header 必须是 JSON 对象，并且每个值都必须是字符串。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('额外 Header 必须是 JSON 对象，并且每个值都必须是字符串。');
  }

  const entries = Object.entries(parsed);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) {
    throw new Error('额外 Header 必须是 JSON 对象，并且每个值都必须是字符串。');
  }

  return Object.fromEntries(entries.map(([name, value]) => {
    if (value.length > 0) return [name, value];
    if (existingNames.has(name)) return [name, MASKED_HEADER_VALUE];
    throw new Error(`Header ${name} 需要填写值。`);
  }));
}
