import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { DatabaseConnection } from '../db/index.js';
import { idempotencyKeys } from '../db/index.js';
import { AppError } from './errors.js';
import { createId } from './ids.js';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(',')}}`;
}

export function idempotencyRequestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export type IdempotencyClaim =
  | { kind: 'none' }
  | { kind: 'acquired'; id: string }
  | { kind: 'replay'; responseStatus: number; responseBody: unknown };

export function claimIdempotencyKey(
  connection: DatabaseConnection,
  input: {
    scope: string;
    key: string | string[] | undefined;
    request: unknown;
    now?: Date;
  },
): IdempotencyClaim {
  if (input.key === undefined) return { kind: 'none' };
  if (Array.isArray(input.key) || !KEY_PATTERN.test(input.key)) {
    throw new AppError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must contain 1 to 200 visible ASCII characters',
      400,
    );
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const requestHash = idempotencyRequestHash(input.request);
  return connection.sqlite.transaction((): IdempotencyClaim => {
    let existing = connection.db.select().from(idempotencyKeys).where(and(
      eq(idempotencyKeys.scope, input.scope),
      eq(idempotencyKeys.key, input.key as string),
    )).get();

    if (existing && existing.expiresAt <= nowIso) {
      connection.db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id)).run();
      existing = undefined;
    }
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AppError(
          'IDEMPOTENCY_KEY_CONFLICT',
          'This Idempotency-Key was already used for a different request',
          409,
        );
      }
      if (existing.state === 'completed' && existing.responseStatus && existing.responseBodyJson) {
        return {
          kind: 'replay',
          responseStatus: existing.responseStatus,
          responseBody: JSON.parse(existing.responseBodyJson) as unknown,
        };
      }
      if (existing.state === 'processing') {
        throw new AppError(
          'IDEMPOTENCY_REQUEST_IN_PROGRESS',
          'A request with this Idempotency-Key is still in progress',
          409,
        );
      }
      connection.db.update(idempotencyKeys).set({
        state: 'processing',
        responseStatus: null,
        responseBodyJson: null,
        resourceId: null,
        completedAt: null,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      }).where(eq(idempotencyKeys.id, existing.id)).run();
      return { kind: 'acquired', id: existing.id };
    }

    const id = createId('idem');
    connection.db.insert(idempotencyKeys).values({
      id,
      scope: input.scope,
      key: input.key as string,
      requestHash,
      state: 'processing',
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
    }).run();
    return { kind: 'acquired', id };
  }).immediate();
}

export function completeIdempotencyKey(
  connection: DatabaseConnection,
  claim: IdempotencyClaim,
  input: { responseStatus: number; responseBody: unknown; resourceId?: string },
): void {
  if (claim.kind !== 'acquired') return;
  connection.db.update(idempotencyKeys).set({
    state: 'completed',
    responseStatus: input.responseStatus,
    responseBodyJson: JSON.stringify(input.responseBody),
    resourceId: input.resourceId ?? null,
    completedAt: new Date().toISOString(),
  }).where(and(
    eq(idempotencyKeys.id, claim.id),
    eq(idempotencyKeys.state, 'processing'),
  )).run();
}

export function failIdempotencyKey(
  connection: DatabaseConnection,
  claim: IdempotencyClaim,
): void {
  if (claim.kind !== 'acquired') return;
  connection.db.update(idempotencyKeys).set({
    state: 'failed',
    completedAt: new Date().toISOString(),
  }).where(and(
    eq(idempotencyKeys.id, claim.id),
    eq(idempotencyKeys.state, 'processing'),
  )).run();
}
