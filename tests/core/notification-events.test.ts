import { describe, expect, it } from 'vitest';

import { detailedAlertEventType } from '../../backend/services/alert-engine.js';
import { defaultMonitorEventTypes, notificationEventTypesForRuleType } from '../../shared/notification-events.js';

describe('notification event catalog', () => {
  it('returns a fresh, fully selected 19-event default for every new monitor rule', () => {
    const first = defaultMonitorEventTypes();
    const second = defaultMonitorEventTypes();

    expect(first).toHaveLength(19);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('defaults site and rate rules to all supported detailed events', () => {
    expect(notificationEventTypesForRuleType('monitor_events')).toEqual(expect.arrayContaining([
      'site.network_unreachable',
      'rate.changed',
      'balance.low',
      'probe.input_tokens_high',
    ]));
    expect(notificationEventTypesForRuleType('site_health')).toEqual(expect.arrayContaining([
      'site.network_unreachable',
      'site.timeout',
      'site.other_error',
      'site.recovered',
    ]));
    expect(notificationEventTypesForRuleType('rate_changed')).toEqual(expect.arrayContaining([
      'rate.changed',
      'rate.added',
      'rate.removed',
      'probe.input_tokens_high',
      'probe.failed',
      'probe.recovered',
    ]));
  });

  it('classifies concrete health failure evidence without inventing an error', () => {
    const rule = { type: 'site_health' };
    expect(detailedAlertEventType(rule, {
      kind: 'health', siteId: 'site', observedAt: 0, status: 'down',
      errorCode: 'UPSTREAM_UNREACHABLE', errorMessage: 'The upstream request timed out',
    })).toBe('site.timeout');
    expect(detailedAlertEventType(rule, {
      kind: 'health', siteId: 'site', observedAt: 0, status: 'degraded',
      errorCode: 'AUTH_ACCESS_EXPIRED', details: { http_status: 403 },
    })).toBe('site.permission_denied');
    expect(detailedAlertEventType(rule, {
      kind: 'health', siteId: 'site', observedAt: 0, status: 'degraded',
      errorCode: 'ADAPTER_UNAVAILABLE',
    })).toBe('site.other_error');
    expect(detailedAlertEventType(rule, {
      kind: 'health', siteId: 'site', observedAt: 0, status: 'healthy',
    })).toBe('site.recovered');
  });

  it('classifies rate lifecycle and probe recovery observations', () => {
    expect(detailedAlertEventType({ type: 'rate_changed' }, {
      kind: 'rate', siteId: 'site', observedAt: 0,
      rateKey: 'group:1', value: '1', changeType: 'added', changed: true,
    })).toBe('rate.added');
    expect(detailedAlertEventType({ type: 'rate_changed' }, {
      kind: 'rate', siteId: 'site', observedAt: 0,
      rateKey: 'group:1', value: null, eventType: 'probe.failed', violating: false,
    })).toBe('probe.recovered');
  });
});
