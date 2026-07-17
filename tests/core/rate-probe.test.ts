import { describe, expect, it } from 'vitest';

import {
  assessProbeInputTokens,
  assessProbeOutput,
  expectedProbeInputTokens,
} from '../../backend/services/rate-probe.js';
import {
  buildRateProbePrompt,
  RATE_PROBE_SYSTEM_INSTRUCTIONS,
} from '../../shared/rate-probe.js';
import { probeErrorCodeLabel, probeErrorMessage } from '../../shared/probe-errors.js';

describe('rate probe token heuristics', () => {
  it('localizes common upstream probe errors while retaining the stable code', () => {
    expect(probeErrorCodeLabel('UPSTREAM_SERVER_ERROR')).toBe('上游服务器错误');
    expect(probeErrorMessage('UPSTREAM_SERVER_ERROR', 502)).toContain('HTTP 502');
    expect(probeErrorMessage('UPSTREAM_SCHEMA_ERROR', 200)).toContain('/v1/responses');
    expect(probeErrorMessage('UPSTREAM_UNREACHABLE', null, 'The model probe timed out'))
      .toContain('请求超时');
    expect(probeErrorMessage('CUSTOM_ERROR', null, 'custom message')).toBe('custom message');
  });

  it('uses a conservative character estimate plus Responses framing overhead', () => {
    expect(expectedProbeInputTokens('12345678', '1234')).toBe(12);
  });

  it('keeps the disclosed gpt-5.6-sol prompt and its 83-token character estimate stable', () => {
    const canary = 'RELAY_MONITOR_0123456789ABCDEF01234567';
    const prompt = buildRateProbePrompt('gpt-5.6-sol', canary);
    expect(prompt).toEqual({
      systemPrompt: RATE_PROBE_SYSTEM_INSTRUCTIONS,
      userPrompt: `Reply with exactly two lines. Line 1: the surname of the person who became governor of Louisiana in January 2024. Line 2: ${canary}`,
    });
    expect(expectedProbeInputTokens(prompt.systemPrompt, prompt.userPrompt)).toBe(83);
  });

  it('only flags reported input above both the absolute and relative tolerance', () => {
    expect(assessProbeInputTokens(100, 135)).toEqual({
      delta: 35,
      assessment: 'within_expected',
      threshold: 35,
    });
    expect(assessProbeInputTokens(100, 136)).toEqual({
      delta: 36,
      assessment: 'higher_than_expected',
      threshold: 35,
    });
    expect(assessProbeInputTokens(20, 36)).toEqual({
      delta: 16,
      assessment: 'within_expected',
      threshold: 16,
    });
    expect(assessProbeInputTokens(20, 37)).toEqual({
      delta: 17,
      assessment: 'higher_than_expected',
      threshold: 16,
    });
  });

  it('keeps small negative deltas in tolerance and rejects implausibly low usage', () => {
    expect(assessProbeInputTokens(100, 80)).toMatchObject({
      delta: -20,
      assessment: 'within_expected',
    });
    expect(assessProbeInputTokens(100, 0)).toMatchObject({
      delta: -100,
      assessment: 'unknown',
    });
    expect(assessProbeInputTokens(100, null)).toMatchObject({
      delta: null,
      assessment: 'unknown',
    });
  });

  it('reports output-limit truncation as inconclusive instead of interference', () => {
    expect(assessProbeOutput({
      targetKnowledge: true,
      outputText: 'Landry',
      canary: 'RELAY_MONITOR_TEST',
      toolCallsObserved: false,
      upstreamToolsObserved: false,
      finishReason: 'length',
      completionTokens: 1,
      maxOutputTokens: 1,
    })).toMatchObject({
      outputTruncated: true,
      promptIntegrity: 'unknown',
      knowledgeProbe: 'unknown',
    });
  });

  it('still treats an unexpected tool call as suspected interference', () => {
    expect(assessProbeOutput({
      targetKnowledge: false,
      outputText: '',
      canary: 'RELAY_MONITOR_TEST',
      toolCallsObserved: true,
      upstreamToolsObserved: false,
      finishReason: 'tool_calls',
      completionTokens: null,
      maxOutputTokens: 64,
    })).toMatchObject({
      outputTruncated: false,
      promptIntegrity: 'suspected',
      knowledgeProbe: 'not_applicable',
    });
  });

  it('treats upstream-echoed tools as suspected interference even without a tool call', () => {
    expect(assessProbeOutput({
      targetKnowledge: false,
      outputText: 'RELAY_MONITOR_TEST',
      canary: 'RELAY_MONITOR_TEST',
      toolCallsObserved: false,
      upstreamToolsObserved: true,
      finishReason: 'stop',
      completionTokens: 8,
      maxOutputTokens: 96,
    })).toMatchObject({
      strictPromptMatch: true,
      promptIntegrity: 'suspected',
    });
  });
});
