import { describe, expect, it } from 'vitest';

import {
  evaluateAlertState,
  incidentFingerprint,
  initialAlertState,
  pauseAlertState,
  resumeAlertState,
  type AlertPolicy,
} from '../../backend/core/alert-state.js';

const policy: AlertPolicy = {
  recoveryConfirmations: 2,
  cooldownMs: 300_000,
  repeatIntervalMs: 3_600_000,
  maxRepeats: 3,
  sendRecovery: true,
};

describe('alert state machine', () => {
  it('fires immediately and requires consecutive healthy observations to recover', () => {
    const firing = evaluateAlertState(
      undefined,
      { violating: true, observedAt: '2026-07-14T00:00:00Z' },
      policy,
    );
    expect(firing.state.status).toBe('firing');
    expect(firing.notifications.map((item) => item.kind)).toEqual(['trigger']);

    const recovering = evaluateAlertState(
      firing.state,
      { violating: false, observedAt: '2026-07-14T00:02:00Z' },
      policy,
    );
    expect(recovering.state.status).toBe('recovering');
    expect(recovering.notifications).toEqual([]);

    const resolved = evaluateAlertState(
      recovering.state,
      { violating: false, observedAt: '2026-07-14T00:03:00Z' },
      policy,
    );
    expect(resolved.state.status).toBe('resolved');
    expect(resolved.notifications.map((item) => item.kind)).toEqual(['recovery']);
  });

  it('never repeats when maxRepeats is zero', () => {
    const immediate = { ...policy, maxRepeats: 0, repeatIntervalMs: 0, cooldownMs: 0 };
    const firing = evaluateAlertState(
      undefined,
      { violating: true, observedAt: '2026-07-14T00:00:00Z' },
      immediate,
    );
    const stillFiring = evaluateAlertState(
      firing.state,
      { violating: true, observedAt: '2026-07-14T10:00:00Z' },
      immediate,
    );
    expect(stillFiring.notifications).toEqual([]);
  });

  it('sends the first notification for a migrated firing state that was never notified', () => {
    const migrated = evaluateAlertState(
      {
        status: 'firing',
        violationCount: 1,
        recoveryCount: 0,
        repeatCount: 0,
        firstFiredAt: '2026-07-14T00:00:00.000Z',
      },
      { violating: true, observedAt: '2026-07-14T00:05:00Z' },
      policy,
    );
    expect(migrated.notifications.map((item) => item.kind)).toEqual(['trigger']);
    expect(migrated.state.lastNotifiedAt).toBe('2026-07-14T00:05:00.000Z');
  });

  it('does not notify while silenced and restarts alerting after silence ends', () => {
    const firing = evaluateAlertState(
      undefined,
      { violating: true, observedAt: '2026-07-14T00:00:00Z' },
      policy,
    );
    const silenced = evaluateAlertState(
      firing.state,
      {
        violating: true,
        observedAt: '2026-07-14T01:00:00Z',
        notificationsAllowed: false,
        suppressionReason: 'maintenance:mw_1',
      },
      policy,
    );
    expect(silenced.notifications).toEqual([]);
    expect(silenced.state.suppressedBy).toBe('maintenance:mw_1');

    const restarted = evaluateAlertState(
      silenced.state,
      { violating: true, observedAt: '2026-07-14T02:00:00Z' },
      policy,
    );
    expect(restarted.state.status).toBe('firing');
    expect(restarted.notifications.map((item) => item.kind)).toEqual(['trigger']);
  });

  it('pauses without creating a false recovery and resumes from a fresh observation', () => {
    const paused = pauseAlertState({ ...initialAlertState(), status: 'firing', violationCount: 3 });
    const whilePaused = evaluateAlertState(
      paused,
      { violating: false, observedAt: '2026-07-14T01:00:00Z' },
      policy,
    );
    expect(whilePaused.state.status).toBe('paused');
    expect(whilePaused.notifications).toEqual([]);
    expect(resumeAlertState(whilePaused.state).status).toBe('normal');
  });

  it('uses all fingerprint dimensions without ambiguous concatenation', () => {
    const first = incidentFingerprint({
      ruleRevisionId: 'ab',
      siteId: 'c',
      resourceKey: 'balance:cash',
      eventType: 'balance.low',
    });
    const second = incidentFingerprint({
      ruleRevisionId: 'a',
      siteId: 'bc',
      resourceKey: 'balance:cash',
      eventType: 'balance.low',
    });
    expect(first).not.toBe(second);
    expect(first).toHaveLength(64);
  });
});
