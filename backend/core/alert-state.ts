import { createHash } from 'node:crypto';

export type AlertStatus =
  | 'normal'
  | 'pending'
  | 'firing'
  | 'acknowledged'
  | 'recovering'
  | 'resolved'
  | 'paused'
  | 'suppressed';

export interface AlertState {
  status: AlertStatus;
  violationCount: number;
  recoveryCount: number;
  repeatCount: number;
  lastObservedAt?: string;
  pendingSince?: string;
  firstFiredAt?: string;
  lastNotifiedAt?: string;
  acknowledgedAt?: string;
  suppressionActive?: boolean;
  suppressedBy?: string;
  suspendedFrom?: Exclude<AlertStatus, 'paused' | 'suppressed'>;
}

export interface AlertPolicy {
  recoveryConfirmations: number;
  cooldownMs: number;
  repeatIntervalMs: number;
  maxRepeats: number;
  sendRecovery: boolean;
}

export interface AlertObservation {
  violating: boolean;
  observedAt: Date | string | number;
  notificationsAllowed?: boolean;
  suppressionReason?: string;
  restartAfterSuppression?: boolean;
}

export interface AlertNotification {
  kind: 'trigger' | 'repeat' | 'recovery';
  occurredAt: string;
  repeatNumber?: number;
}

export interface AlertEvaluation {
  state: AlertState;
  notifications: readonly AlertNotification[];
  transitioned: boolean;
}

export interface IncidentFingerprintInput {
  ruleRevisionId: string;
  siteId: string;
  resourceKey: string;
  eventType: string;
}

export function incidentFingerprint(input: IncidentFingerprintInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.ruleRevisionId,
        input.siteId,
        input.resourceKey,
        input.eventType,
      ]),
      'utf8',
    )
    .digest('hex');
}

export function initialAlertState(): AlertState {
  return {
    status: 'normal',
    violationCount: 0,
    recoveryCount: 0,
    repeatCount: 0,
  };
}

function timestamp(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('observedAt must be a valid timestamp');
  return date.toISOString();
}

function milliseconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validatedPolicy(policy: AlertPolicy): AlertPolicy {
  if (!Number.isInteger(policy.recoveryConfirmations) || policy.recoveryConfirmations < 1) {
    throw new Error('recoveryConfirmations must be a positive integer');
  }
  if (!Number.isInteger(policy.maxRepeats) || policy.maxRepeats < 0) {
    throw new Error('maxRepeats must be a non-negative integer');
  }
  for (const [name, value] of [
    ['cooldownMs', policy.cooldownMs],
    ['repeatIntervalMs', policy.repeatIntervalMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  }
  return policy;
}

function resetToNormal(observedAt?: string): AlertState {
  return {
    ...initialAlertState(),
    ...(observedAt ? { lastObservedAt: observedAt } : {}),
  };
}

function repeatDue(state: AlertState, policy: AlertPolicy, nowMs: number): boolean {
  if (policy.maxRepeats === 0 || state.repeatCount >= policy.maxRepeats) return false;
  const lastNotification = milliseconds(state.lastNotifiedAt);
  if (lastNotification === undefined) return false;
  return (
    nowMs - lastNotification >= policy.repeatIntervalMs &&
    nowMs - lastNotification >= policy.cooldownMs
  );
}

function fire(
  state: AlertState,
  at: string,
  notificationsAllowed: boolean,
  notifications: AlertNotification[],
): AlertState {
  if (notificationsAllowed) notifications.push({ kind: 'trigger', occurredAt: at });
  return {
    ...state,
    status: 'firing',
    recoveryCount: 0,
    firstFiredAt: state.firstFiredAt ?? at,
    ...(notificationsAllowed ? { lastNotifiedAt: at } : {}),
    lastObservedAt: at,
  };
}

function resolve(
  state: AlertState,
  at: string,
  policy: AlertPolicy,
  notificationsAllowed: boolean,
  notifications: AlertNotification[],
): AlertState {
  if (notificationsAllowed && policy.sendRecovery) {
    notifications.push({ kind: 'recovery', occurredAt: at });
  }
  return {
    ...state,
    status: 'resolved',
    violationCount: 0,
    recoveryCount: policy.recoveryConfirmations,
    lastObservedAt: at,
    ...(notificationsAllowed && policy.sendRecovery ? { lastNotifiedAt: at } : {}),
  };
}

export function evaluateAlertState(
  previousState: AlertState | undefined,
  observation: AlertObservation,
  rawPolicy: AlertPolicy,
): AlertEvaluation {
  const policy = validatedPolicy(rawPolicy);
  const at = timestamp(observation.observedAt);
  const nowMs = Date.parse(at);
  const notificationsAllowed = observation.notificationsAllowed ?? true;
  const notifications: AlertNotification[] = [];
  let state: AlertState = { ...(previousState ?? initialAlertState()) };
  const originalStatus = state.status;

  if (state.status === 'paused' || state.status === 'suppressed') {
    return { state: { ...state, lastObservedAt: at }, notifications, transitioned: false };
  }

  if (
    state.suppressionActive &&
    notificationsAllowed &&
    (observation.restartAfterSuppression ?? true)
  ) {
    state = resetToNormal(at);
  }

  if (state.status === 'resolved') state = resetToNormal(at);

  switch (state.status) {
    case 'normal': {
      if (observation.violating) {
        state = fire({
          ...state,
          violationCount: 1,
          recoveryCount: 0,
          repeatCount: 0,
        }, at, notificationsAllowed, notifications);
      } else {
        state = resetToNormal(at);
      }
      break;
    }
    case 'pending': {
      if (!observation.violating) {
        state = resetToNormal(at);
        break;
      }
      state = fire({
        ...state,
        violationCount: state.violationCount + 1,
        recoveryCount: 0,
      }, at, notificationsAllowed, notifications);
      break;
    }
    case 'firing': {
      if (!observation.violating) {
        state = {
          ...state,
          status: 'recovering',
          recoveryCount: 1,
          lastObservedAt: at,
        };
        if (policy.recoveryConfirmations === 1) {
          state = resolve(state, at, policy, notificationsAllowed, notifications);
        }
        break;
      }
      state = { ...state, violationCount: state.violationCount + 1, lastObservedAt: at };
      if (notificationsAllowed && state.lastNotifiedAt === undefined) {
        notifications.push({ kind: 'trigger', occurredAt: at });
        state = { ...state, lastNotifiedAt: at };
      } else if (notificationsAllowed && repeatDue(state, policy, nowMs)) {
        const repeatNumber = state.repeatCount + 1;
        notifications.push({ kind: 'repeat', occurredAt: at, repeatNumber });
        state = { ...state, repeatCount: repeatNumber, lastNotifiedAt: at };
      }
      break;
    }
    case 'acknowledged': {
      if (observation.violating) {
        state = { ...state, violationCount: state.violationCount + 1, lastObservedAt: at };
      } else {
        state = {
          ...state,
          status: 'recovering',
          recoveryCount: 1,
          lastObservedAt: at,
        };
        if (policy.recoveryConfirmations === 1) {
          state = resolve(state, at, policy, notificationsAllowed, notifications);
        }
      }
      break;
    }
    case 'recovering': {
      if (observation.violating) {
        state = {
          ...state,
          status: 'firing',
          violationCount: state.violationCount + 1,
          recoveryCount: 0,
          lastObservedAt: at,
        };
        break;
      }
      state = { ...state, recoveryCount: state.recoveryCount + 1, lastObservedAt: at };
      if (state.recoveryCount >= policy.recoveryConfirmations) {
        state = resolve(state, at, policy, notificationsAllowed, notifications);
      }
      break;
    }
    case 'resolved':
    case 'paused':
    case 'suppressed':
      break;
  }

  if (notificationsAllowed) {
    state = { ...state, suppressionActive: false };
    delete state.suppressedBy;
  } else {
    state = {
      ...state,
      suppressionActive: true,
      ...(observation.suppressionReason ? { suppressedBy: observation.suppressionReason } : {}),
    };
  }
  return {
    state,
    notifications,
    transitioned: originalStatus !== state.status,
  };
}

export function pauseAlertState(state: AlertState): AlertState {
  if (state.status === 'paused') return { ...state };
  const suspendedFrom =
    state.status === 'suppressed' ? state.suspendedFrom ?? 'normal' : state.status;
  return { ...state, status: 'paused', suspendedFrom };
}

export function suppressAlertRule(state: AlertState): AlertState {
  if (state.status === 'suppressed') return { ...state };
  const suspendedFrom = state.status === 'paused' ? state.suspendedFrom ?? 'normal' : state.status;
  return { ...state, status: 'suppressed', suspendedFrom };
}

export function resumeAlertState(state: AlertState): AlertState {
  if (state.status !== 'paused' && state.status !== 'suppressed') return { ...state };
  return resetToNormal(state.lastObservedAt);
}
