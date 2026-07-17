import { and, desc, eq, isNull } from 'drizzle-orm';

import type { DatabaseConnection } from '../db/index.js';
import { credentials } from '../db/index.js';
import type { CredentialVault } from '../core/vault.js';
import { createId } from '../core/ids.js';

export type CredentialValues = Readonly<Record<string, string | boolean | undefined>>;

export interface StoreCredentialOptions {
  persistKeys: readonly string[];
  expiresAtByKey?: Readonly<Record<string, string | undefined>>;
}

export function storeCredentials(
  database: DatabaseConnection,
  vault: CredentialVault,
  siteId: string,
  values: CredentialValues,
  options: StoreCredentialOptions,
): string[] {
  const stored: string[] = [];
  const write = () => {
    const now = new Date().toISOString();
    for (const key of [...new Set(options.persistKeys)].sort()) {
      const value = values[key];
      if (value === undefined || value === '') continue;
      const encrypted = vault.encryptCredential(siteId, key, typeof value === 'boolean' ? String(value) : value);
      database.db
        .insert(credentials)
        .values({
          id: createId('cred'),
          siteId,
          credentialType: key,
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          authTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          expiresAt: options.expiresAtByKey?.[key] ?? null,
          revokedAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [credentials.siteId, credentials.credentialType, credentials.keyVersion],
          set: {
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            authTag: encrypted.authTag,
            expiresAt: options.expiresAtByKey?.[key] ?? null,
            revokedAt: null,
            updatedAt: now,
          },
        })
        .run();
      stored.push(key);
    }
  };
  if (database.sqlite.inTransaction) write();
  else database.sqlite.transaction(write)();
  return stored;
}

export function revokeCredentials(
  database: DatabaseConnection,
  siteId: string,
  keys?: readonly string[],
): void {
  const conditions = [eq(credentials.siteId, siteId), isNull(credentials.revokedAt)];
  if (keys !== undefined) {
    for (const key of keys) {
      database.db
        .update(credentials)
        .set({ revokedAt: new Date().toISOString() })
        .where(and(...conditions, eq(credentials.credentialType, key)))
        .run();
    }
    return;
  }
  database.db
    .update(credentials)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(...conditions))
    .run();
}

export function loadCredentials(
  database: DatabaseConnection,
  vault: CredentialVault,
  siteId: string,
): Record<string, string> {
  const rows = database.db
    .select()
    .from(credentials)
    .where(and(eq(credentials.siteId, siteId), isNull(credentials.revokedAt)))
    .orderBy(desc(credentials.keyVersion), desc(credentials.updatedAt))
    .all();
  const values: Record<string, string> = {};
  for (const row of rows) {
    if (Object.hasOwn(values, row.credentialType)) continue;
    values[row.credentialType] = vault.decryptCredentialText(siteId, row.credentialType, {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.authTag,
      keyVersion: row.keyVersion,
    });
  }
  return values;
}

export function loadCredentialValue(
  database: DatabaseConnection,
  vault: CredentialVault,
  siteId: string,
  credentialType: string,
): string | undefined {
  const row = database.db
    .select()
    .from(credentials)
    .where(and(
      eq(credentials.siteId, siteId),
      eq(credentials.credentialType, credentialType),
      isNull(credentials.revokedAt),
    ))
    .orderBy(desc(credentials.keyVersion), desc(credentials.updatedAt))
    .get();
  if (!row) return undefined;
  return vault.decryptCredentialText(siteId, credentialType, {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.authTag,
    keyVersion: row.keyVersion,
  });
}

export function credentialPresence(database: DatabaseConnection, siteId: string): string[] {
  return database.db
    .select({ key: credentials.credentialType })
    .from(credentials)
    .where(and(eq(credentials.siteId, siteId), isNull(credentials.revokedAt)))
    .all()
    .map((row) => row.key)
    .sort();
}
