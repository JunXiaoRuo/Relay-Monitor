import { describe, expect, it } from 'vitest';

import {
  parseWebhookHeaderEditor,
  webhookHeaderEditorState,
} from '../../frontend/src/services/webhook-headers.js';

describe('webhook Header editor', () => {
  it('shows saved names with blank values instead of exposing masked storage markers', () => {
    const state = webhookHeaderEditorState({
      Authorization: '[REDACTED]',
      'X-Tenant': '[REDACTED]',
    });

    expect(state.names).toEqual(['Authorization', 'X-Tenant']);
    expect(JSON.parse(state.text)).toEqual({ Authorization: '', 'X-Tenant': '' });
    expect(state.text).not.toContain('REDACTED');
  });

  it('keeps blank saved values, replaces filled values, and removes deleted names', () => {
    expect(parseWebhookHeaderEditor(JSON.stringify({
      Authorization: '',
      'X-New': 'new-value',
    }), new Set(['Authorization', 'X-Tenant']))).toEqual({
      Authorization: '[REDACTED]',
      'X-New': 'new-value',
    });
  });

  it('requires a value for a newly added Header', () => {
    expect(() => parseWebhookHeaderEditor(
      JSON.stringify({ 'X-New': '' }),
      new Set(['Authorization']),
    )).toThrow('Header X-New 需要填写值');
  });

  it('rejects non-object JSON and non-string values', () => {
    expect(() => parseWebhookHeaderEditor('[]', new Set())).toThrow('必须是 JSON 对象');
    expect(() => parseWebhookHeaderEditor('{"X-Test":1}', new Set())).toThrow('每个值都必须是字符串');
  });
});
