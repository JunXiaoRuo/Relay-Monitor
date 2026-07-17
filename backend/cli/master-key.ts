import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { config } from '../config.js';
import {
  CredentialVault,
  loadMasterKeyRing,
  serializeMasterKeyRing,
  writeMasterKeyFileAtomic,
  type EncryptedCredential,
  type MasterKeyOptions,
  type MasterKeyRing,
} from '../core/vault.js';
import { initializeDatabase, type DatabaseConnection } from '../db/client.js';

const CHANNEL_SECRET_AAD_TYPE = 'notification_channel_secret';

interface CredentialRow {
  id: string;
  site_id: string;
  credential_type: string;
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  key_version: number;
}

interface ChannelRow {
  id: string;
  secret_ciphertext: Buffer | null;
  secret_nonce: Buffer | null;
  secret_auth_tag: Buffer | null;
  secret_key_version: number | null;
  previous_secret_ciphertext: Buffer | null;
  previous_secret_nonce: Buffer | null;
  previous_secret_auth_tag: Buffer | null;
  previous_secret_key_version: number | null;
}

interface NullableEnvelope {
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  authTag: Buffer | null;
  keyVersion: number | null;
}

export interface RotateMasterKeyOptions extends MasterKeyOptions {
  legacyCurrentKeyVersion: number;
  newKeyVersion?: number;
}

export interface MasterKeyRotationResult {
  previousKeyVersion: number;
  currentKeyVersion: number;
  credentialsRotated: number;
  channelSecretsRotated: number;
  previousChannelSecretsRotated: number;
}

export interface FinalizeMasterKeyResult {
  currentKeyVersion: number;
  removedKeyVersions: number[];
}

function credentialRows(connection: DatabaseConnection): CredentialRow[] {
  return connection.sqlite.prepare(
    `select id, site_id, credential_type, ciphertext, nonce, auth_tag, key_version
     from credentials order by id`,
  ).all() as CredentialRow[];
}

function channelRows(connection: DatabaseConnection): ChannelRow[] {
  return connection.sqlite.prepare(
    `select id, secret_ciphertext, secret_nonce, secret_auth_tag, secret_key_version,
            previous_secret_ciphertext, previous_secret_nonce, previous_secret_auth_tag,
            previous_secret_key_version
     from notification_channels order by id`,
  ).all() as ChannelRow[];
}

function requiredEnvelope(row: CredentialRow): EncryptedCredential {
  return {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
    keyVersion: row.key_version,
  };
}

function nullableEnvelope(
  label: string,
  ciphertext: Buffer | null,
  nonce: Buffer | null,
  authTag: Buffer | null,
  keyVersion: number | null,
): EncryptedCredential | undefined {
  const values = [ciphertext, nonce, authTag, keyVersion];
  if (values.every((value) => value === null)) return undefined;
  if (ciphertext === null || nonce === null || authTag === null || keyVersion === null) {
    throw new Error(`${label} has an incomplete encrypted envelope`);
  }
  return { ciphertext, nonce, authTag, keyVersion };
}

function channelEnvelopes(row: ChannelRow): { current?: EncryptedCredential; previous?: EncryptedCredential } {
  const current = nullableEnvelope(
    `Notification channel ${row.id} current secret`,
    row.secret_ciphertext,
    row.secret_nonce,
    row.secret_auth_tag,
    row.secret_key_version,
  );
  const previous = nullableEnvelope(
    `Notification channel ${row.id} previous secret`,
    row.previous_secret_ciphertext,
    row.previous_secret_nonce,
    row.previous_secret_auth_tag,
    row.previous_secret_key_version,
  );
  return {
    ...(current ? { current } : {}),
    ...(previous ? { previous } : {}),
  };
}

function decryptAndDiscard(
  vault: CredentialVault,
  ownerId: string,
  credentialType: string,
  envelope: EncryptedCredential,
  label: string,
): void {
  let plaintext: Buffer | undefined;
  try {
    plaintext = vault.decryptCredential(ownerId, credentialType, envelope);
  } catch {
    throw new Error(`${label} could not be authenticated with the configured master keyring`);
  } finally {
    plaintext?.fill(0);
  }
}

function validateAllCiphertext(connection: DatabaseConnection, vault: CredentialVault): void {
  for (const row of credentialRows(connection)) {
    decryptAndDiscard(
      vault,
      row.site_id,
      row.credential_type,
      requiredEnvelope(row),
      `Credential ${row.id}`,
    );
  }
  for (const row of channelRows(connection)) {
    const envelopes = channelEnvelopes(row);
    if (envelopes.current) {
      decryptAndDiscard(vault, row.id, CHANNEL_SECRET_AAD_TYPE, envelopes.current, `Notification channel ${row.id} current secret`);
    }
    if (envelopes.previous) {
      decryptAndDiscard(vault, row.id, CHANNEL_SECRET_AAD_TYPE, envelopes.previous, `Notification channel ${row.id} previous secret`);
    }
  }
}

function reencrypt(
  sourceVault: CredentialVault,
  destinationVault: CredentialVault,
  ownerId: string,
  credentialType: string,
  envelope: EncryptedCredential,
  label: string,
): EncryptedCredential {
  let plaintext: Buffer | undefined;
  try {
    plaintext = sourceVault.decryptCredential(ownerId, credentialType, envelope);
    return destinationVault.encryptCredential(ownerId, credentialType, plaintext);
  } catch {
    throw new Error(`${label} could not be rotated`);
  } finally {
    plaintext?.fill(0);
  }
}

function rotateRows(
  connection: DatabaseConnection,
  sourceVault: CredentialVault,
  destinationVault: CredentialVault,
): Omit<MasterKeyRotationResult, 'previousKeyVersion' | 'currentKeyVersion'> {
  const timestamp = new Date().toISOString();
  let credentialsRotated = 0;
  let channelSecretsRotated = 0;
  let previousChannelSecretsRotated = 0;
  const updateCredential = connection.sqlite.prepare(
    `update credentials
     set ciphertext = ?, nonce = ?, auth_tag = ?, key_version = ?, updated_at = ?
     where id = ?`,
  );
  for (const row of credentialRows(connection)) {
    const encrypted = reencrypt(
      sourceVault,
      destinationVault,
      row.site_id,
      row.credential_type,
      requiredEnvelope(row),
      `Credential ${row.id}`,
    );
    const result = updateCredential.run(
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.authTag,
      encrypted.keyVersion,
      timestamp,
      row.id,
    );
    if (result.changes !== 1) throw new Error(`Credential ${row.id} changed during master key rotation`);
    credentialsRotated += 1;
  }

  const updateCurrent = connection.sqlite.prepare(
    `update notification_channels
     set secret_ciphertext = ?, secret_nonce = ?, secret_auth_tag = ?,
         secret_key_version = ?, updated_at = ?
     where id = ?`,
  );
  const updatePrevious = connection.sqlite.prepare(
    `update notification_channels
     set previous_secret_ciphertext = ?, previous_secret_nonce = ?,
         previous_secret_auth_tag = ?, previous_secret_key_version = ?, updated_at = ?
     where id = ?`,
  );
  for (const row of channelRows(connection)) {
    const envelopes = channelEnvelopes(row);
    if (envelopes.current) {
      const encrypted = reencrypt(
        sourceVault,
        destinationVault,
        row.id,
        CHANNEL_SECRET_AAD_TYPE,
        envelopes.current,
        `Notification channel ${row.id} current secret`,
      );
      if (updateCurrent.run(
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        encrypted.keyVersion,
        timestamp,
        row.id,
      ).changes !== 1) {
        throw new Error(`Notification channel ${row.id} changed during master key rotation`);
      }
      channelSecretsRotated += 1;
    }
    if (envelopes.previous) {
      const encrypted = reencrypt(
        sourceVault,
        destinationVault,
        row.id,
        CHANNEL_SECRET_AAD_TYPE,
        envelopes.previous,
        `Notification channel ${row.id} previous secret`,
      );
      if (updatePrevious.run(
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        encrypted.keyVersion,
        timestamp,
        row.id,
      ).changes !== 1) {
        throw new Error(`Notification channel ${row.id} changed during master key rotation`);
      }
      previousChannelSecretsRotated += 1;
    }
  }
  return { credentialsRotated, channelSecretsRotated, previousChannelSecretsRotated };
}

function destroyKeyring(keyring: MasterKeyRing): void {
  for (const key of keyring.keys.values()) key.fill(0);
  keyring.keys.clear();
}

function restoreOriginalKeyFile(filePath: string, originalContents: Buffer, rotationError: unknown): never {
  try {
    writeMasterKeyFileAtomic(filePath, originalContents);
  } catch {
    throw new Error(
      'Master key rotation failed and the database was rolled back, but the original master key file could not be restored',
      { cause: rotationError },
    );
  }
  throw rotationError;
}

export function rotateMasterKey(
  connection: DatabaseConnection,
  options: RotateMasterKeyOptions,
): MasterKeyRotationResult {
  if (connection.sqlite.inTransaction) throw new Error('Master key rotation requires a dedicated database connection');
  const originalContents = readFileSync(options.filePath);
  const sourceKeyring = loadMasterKeyRing(options, options.legacyCurrentKeyVersion);
  let sourceVault: CredentialVault | undefined;
  let destinationVault: CredentialVault | undefined;
  const generatedKey = randomBytes(32);
  let candidateInstalled = false;
  let transactionStarted = false;
  try {
    sourceVault = new CredentialVault(sourceKeyring.currentKeyVersion, sourceKeyring.keys);
    validateAllCiphertext(connection, sourceVault);

    const highestVersion = Math.max(0, ...sourceKeyring.keys.keys());
    const newKeyVersion = options.newKeyVersion ?? highestVersion + 1;
    if (!Number.isSafeInteger(newKeyVersion) || newKeyVersion <= highestVersion) {
      throw new Error(`New master key version must be an integer greater than ${highestVersion}`);
    }
    const candidateKeys = new Map<number, Uint8Array>(sourceKeyring.keys);
    candidateKeys.set(newKeyVersion, generatedKey);
    destinationVault = new CredentialVault(newKeyVersion, candidateKeys);
    const candidateContents = serializeMasterKeyRing(newKeyVersion, candidateKeys);
    try {
      writeMasterKeyFileAtomic(options.filePath, candidateContents);
      candidateInstalled = true;
    } finally {
      candidateContents.fill(0);
    }

    const installedKeyring = loadMasterKeyRing(options, options.legacyCurrentKeyVersion);
    try {
      if (
        installedKeyring.currentKeyVersion !== newKeyVersion ||
        installedKeyring.keys.size !== candidateKeys.size ||
        [...candidateKeys].some(([version, key]) => !installedKeyring.keys.get(version)?.equals(key))
      ) {
        throw new Error('The candidate master keyring could not be verified after installation');
      }
    } finally {
      destroyKeyring(installedKeyring);
    }

    connection.sqlite.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const counts = rotateRows(connection, sourceVault, destinationVault);
    validateAllCiphertext(connection, destinationVault);
    connection.sqlite.exec('COMMIT');
    transactionStarted = false;
    return {
      previousKeyVersion: sourceKeyring.currentKeyVersion,
      currentKeyVersion: newKeyVersion,
      ...counts,
    };
  } catch (error) {
    if (transactionStarted && !connection.sqlite.inTransaction) {
      throw new Error(
        'Master key rotation ended with an uncertain database commit state; the dual-version keyring was retained for recovery',
        { cause: error },
      );
    }
    if (transactionStarted) connection.sqlite.exec('ROLLBACK');
    if (candidateInstalled) restoreOriginalKeyFile(options.filePath, originalContents, error);
    throw error;
  } finally {
    originalContents.fill(0);
    generatedKey.fill(0);
    sourceVault?.destroy();
    destinationVault?.destroy();
    destroyKeyring(sourceKeyring);
  }
}

export function finalizeMasterKeyRotation(
  connection: DatabaseConnection,
  options: MasterKeyOptions & { legacyCurrentKeyVersion: number },
): FinalizeMasterKeyResult {
  if (connection.sqlite.inTransaction) throw new Error('Master key finalization requires a dedicated database connection');
  const keyring = loadMasterKeyRing(options, options.legacyCurrentKeyVersion);
  const vault = new CredentialVault(keyring.currentKeyVersion, keyring.keys);
  let transactionStarted = false;
  try {
    connection.sqlite.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    validateAllCiphertext(connection, vault);
    const referencedVersions = new Set<number>();
    for (const row of credentialRows(connection)) referencedVersions.add(row.key_version);
    for (const row of channelRows(connection)) {
      const envelopes = channelEnvelopes(row);
      if (envelopes.current) referencedVersions.add(envelopes.current.keyVersion);
      if (envelopes.previous) referencedVersions.add(envelopes.previous.keyVersion);
    }
    const staleReferences = [...referencedVersions].filter((version) => version !== keyring.currentKeyVersion);
    if (staleReferences.length > 0) {
      throw new Error(`Cannot finalize: encrypted rows still reference key version(s) ${staleReferences.sort().join(', ')}`);
    }
    const currentKey = keyring.keys.get(keyring.currentKeyVersion);
    if (!currentKey) throw new Error('Current master key is unavailable');
    const contents = serializeMasterKeyRing(keyring.currentKeyVersion, new Map([[keyring.currentKeyVersion, currentKey]]));
    try {
      writeMasterKeyFileAtomic(options.filePath, contents);
    } finally {
      contents.fill(0);
    }
    connection.sqlite.exec('COMMIT');
    transactionStarted = false;
    return {
      currentKeyVersion: keyring.currentKeyVersion,
      removedKeyVersions: [...keyring.keys.keys()]
        .filter((version) => version !== keyring.currentKeyVersion)
        .sort((left, right) => left - right),
    };
  } catch (error) {
    if (transactionStarted && connection.sqlite.inTransaction) connection.sqlite.exec('ROLLBACK');
    throw error;
  } finally {
    vault.destroy();
    destroyKeyring(keyring);
  }
}

function argumentValue(name: string): string | undefined {
  const equalsPrefix = `--${name}=`;
  const equalsValue = process.argv.find((argument) => argument.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireStoppedServiceConfirmation(): void {
  if (!process.argv.includes('--confirm-service-stopped')) {
    throw new Error('Stop Relay Monitor first, then pass --confirm-service-stopped');
  }
}

export function runMasterKeyCli(): void {
  const command = process.argv[2];
  if (command !== 'rotate' && command !== 'finalize') {
    throw new Error('Usage: master-key.ts <rotate|finalize> --confirm-service-stopped [--new-version <number>]');
  }
  requireStoppedServiceConfirmation();
  const connection = initializeDatabase(config);
  try {
    if (command === 'rotate') {
      const requestedVersion = argumentValue('new-version');
      const newKeyVersion = requestedVersion === undefined ? undefined : Number(requestedVersion);
      const result = rotateMasterKey(connection, {
        filePath: config.masterKeyFile,
        environment: config.nodeEnv,
        legacyCurrentKeyVersion: config.masterKeyVersion,
        ...(newKeyVersion === undefined ? {} : { newKeyVersion }),
      });
      console.info(
        `Master key rotated from version ${result.previousKeyVersion} to ${result.currentKeyVersion}; ` +
        `${result.credentialsRotated} credential(s), ${result.channelSecretsRotated} current channel secret(s), ` +
        `and ${result.previousChannelSecretsRotated} previous channel secret(s) were re-encrypted.`,
      );
      console.info(`The versioned keyring atomically replaced ${config.masterKeyFile}; no key material was printed.`);
      return;
    }
    const result = finalizeMasterKeyRotation(connection, {
      filePath: config.masterKeyFile,
      environment: config.nodeEnv,
      legacyCurrentKeyVersion: config.masterKeyVersion,
    });
    console.info(
      `Master keyring finalized at version ${result.currentKeyVersion}; ` +
      `${result.removedKeyVersions.length} older key version(s) removed.`,
    );
  } finally {
    connection.close();
  }
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  try {
    runMasterKeyCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Master key operation failed');
    process.exitCode = 1;
  }
}
