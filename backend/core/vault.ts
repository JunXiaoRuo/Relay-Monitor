import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { AppConfig } from '../config.js';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEYRING_FORMAT = 'relay-monitor-keyring-v1';

export interface EncryptedCredential {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export interface SerializedEncryptedCredential {
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  key_version: number;
}

export interface MasterKeyOptions {
  filePath: string;
  environment: 'development' | 'test' | 'production';
}

export interface MasterKeyRing {
  currentKeyVersion: number;
  keys: Map<number, Buffer>;
  sourceFormat: 'legacy' | 'keyring';
}

function decodeMasterKey(fileContents: Buffer): Buffer {
  if (fileContents.length === KEY_BYTES) return Buffer.from(fileContents);

  const text = fileContents.toString('utf8').trim();
  if (/^[a-fA-F0-9]{64}$/.test(text)) return Buffer.from(text, 'hex');

  try {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length === KEY_BYTES && decoded.toString('base64').replace(/=+$/, '') === text.replace(/=+$/, '')) {
      return decoded;
    }
    decoded.fill(0);
  } catch {
    // Report one format-independent error below.
  }
  throw new Error('Master key must contain exactly 32 random bytes (raw, hex, or base64)');
}

function decodeKeyringKey(value: unknown, version: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Master keyring version ${version} must contain a base64 key`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.length !== KEY_BYTES ||
    decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')
  ) {
    decoded.fill(0);
    throw new Error(`Master keyring version ${version} must contain exactly 32 base64-encoded bytes`);
  }
  return decoded;
}

function parseMasterKeyRing(fileContents: Buffer, legacyCurrentKeyVersion: number): MasterKeyRing {
  if (fileContents.length === KEY_BYTES || !fileContents.toString('utf8').trimStart().startsWith('{')) {
    return {
      currentKeyVersion: legacyCurrentKeyVersion,
      keys: new Map([[legacyCurrentKeyVersion, decodeMasterKey(fileContents)]]),
      sourceFormat: 'legacy',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContents.toString('utf8'));
  } catch {
    throw new Error('Master keyring is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Master keyring must be a JSON object');
  }
  const object = parsed as Record<string, unknown>;
  if (object.format !== KEYRING_FORMAT) {
    throw new Error(`Unsupported master keyring format; expected ${KEYRING_FORMAT}`);
  }
  if (!Number.isSafeInteger(object.current_key_version) || (object.current_key_version as number) < 1) {
    throw new Error('Master keyring current_key_version must be a positive integer');
  }
  if (!object.keys || typeof object.keys !== 'object' || Array.isArray(object.keys)) {
    throw new Error('Master keyring keys must be an object');
  }

  const keys = new Map<number, Buffer>();
  try {
    for (const [versionText, value] of Object.entries(object.keys as Record<string, unknown>)) {
      if (!/^[1-9]\d*$/.test(versionText)) {
        throw new Error(`Master keyring version '${versionText}' is not a positive integer`);
      }
      const version = Number(versionText);
      if (!Number.isSafeInteger(version)) {
        throw new Error(`Master keyring version '${versionText}' is too large`);
      }
      keys.set(version, decodeKeyringKey(value, versionText));
    }
    const currentKeyVersion = object.current_key_version as number;
    if (!keys.has(currentKeyVersion)) {
      throw new Error(`Master keyring does not contain current version ${currentKeyVersion}`);
    }
    return { currentKeyVersion, keys, sourceFormat: 'keyring' };
  } catch (error) {
    for (const key of keys.values()) key.fill(0);
    throw error;
  }
}

function assertKeyFilePermissions(filePath: string, environment: MasterKeyOptions['environment']): void {
  const file = lstatSync(filePath);
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error('Master key path must refer to a regular, non-symbolic-link file');
  }
  if (process.platform === 'win32') return;
  const permissions = statSync(filePath).mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    const message = `Master key permissions must be 0600 or stricter; found ${permissions.toString(8)}`;
    if (environment === 'production') throw new Error(message);
    chmodSync(filePath, 0o600);
  }
}

export function loadOrCreateMasterKey(options: MasterKeyOptions): Buffer {
  if (!existsSync(options.filePath)) {
    if (options.environment === 'production') {
      throw new Error(`Master key must be provisioned before production startup: ${options.filePath}`);
    }

    mkdirSync(dirname(options.filePath), { recursive: true, mode: 0o700 });
    const generated = randomBytes(KEY_BYTES);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(options.filePath, 'wx', 0o600);
      writeFileSync(descriptor, generated);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
    } finally {
      generated.fill(0);
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  assertKeyFilePermissions(options.filePath, options.environment);
  const contents = readFileSync(options.filePath);
  if (contents.length !== KEY_BYTES && contents.toString('utf8').trimStart().startsWith('{')) {
    const keyring = parseMasterKeyRing(contents, 1);
    try {
      const current = keyring.keys.get(keyring.currentKeyVersion);
      if (!current) throw new Error('Current master key is unavailable');
      return Buffer.from(current);
    } finally {
      for (const key of keyring.keys.values()) key.fill(0);
    }
  }
  return decodeMasterKey(contents);
}

export function loadMasterKeyRing(
  options: MasterKeyOptions,
  legacyCurrentKeyVersion: number,
): MasterKeyRing {
  if (!Number.isSafeInteger(legacyCurrentKeyVersion) || legacyCurrentKeyVersion < 1) {
    throw new TypeError('Legacy master key version must be a positive integer');
  }
  if (!existsSync(options.filePath)) {
    loadOrCreateMasterKey(options).fill(0);
  }
  assertKeyFilePermissions(options.filePath, options.environment);
  return parseMasterKeyRing(readFileSync(options.filePath), legacyCurrentKeyVersion);
}

export function serializeMasterKeyRing(
  currentKeyVersion: number,
  keys: ReadonlyMap<number, Uint8Array>,
): Buffer {
  if (!Number.isSafeInteger(currentKeyVersion) || currentKeyVersion < 1 || !keys.has(currentKeyVersion)) {
    throw new Error('A valid current master key version must be present in the keyring');
  }
  const serializedKeys: Record<string, string> = {};
  for (const [version, key] of [...keys.entries()].sort(([left], [right]) => left - right)) {
    if (!Number.isSafeInteger(version) || version < 1 || key.byteLength !== KEY_BYTES) {
      throw new Error('Every serialized master key must have a positive version and contain 32 bytes');
    }
    serializedKeys[String(version)] = Buffer.isBuffer(key)
      ? key.toString('base64')
      : Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString('base64');
  }
  return Buffer.from(`${JSON.stringify({
    format: KEYRING_FORMAT,
    current_key_version: currentKeyVersion,
    keys: serializedKeys,
  }, null, 2)}\n`, 'utf8');
}

export function writeMasterKeyFileAtomic(filePath: string, contents: Uint8Array): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const existing = existsSync(filePath) ? lstatSync(filePath) : undefined;
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error('Master key path must refer to a regular, non-symbolic-link file');
  }
  if (existing && process.platform !== 'win32' && process.getuid?.() !== 0 && existing.uid !== process.getuid?.()) {
    throw new Error('Master key rotation must run as the master key file owner (or root)');
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (existing && process.platform !== 'win32') {
      const preservedMode = existing.mode & 0o600;
      chmodSync(temporaryPath, preservedMode === 0 ? 0o600 : preservedMode);
      if (process.getuid?.() === 0) chownSync(temporaryPath, existing.uid, existing.gid);
    }
    renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function credentialAad(siteId: string, credentialType: string, keyVersion: number): Buffer {
  if (!siteId || !credentialType || siteId.includes('\0') || credentialType.includes('\0')) {
    throw new TypeError('Credential AAD fields must be non-empty and must not contain NUL characters');
  }
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new TypeError('Credential key version must be a positive integer');
  }
  return Buffer.from(`${siteId}\0${credentialType}\0${keyVersion}`, 'utf8');
}

export class CredentialVault {
  readonly currentKeyVersion: number;
  readonly #keys = new Map<number, Buffer>();

  constructor(currentKeyVersion: number, keys: ReadonlyMap<number, Uint8Array>) {
    if (!Number.isSafeInteger(currentKeyVersion) || currentKeyVersion < 1) {
      throw new TypeError('Current key version must be a positive integer');
    }
    for (const [version, key] of keys) {
      if (!Number.isSafeInteger(version) || version < 1 || key.byteLength !== KEY_BYTES) {
        throw new TypeError('Every vault key must have a positive version and contain 32 bytes');
      }
      this.#keys.set(version, Buffer.from(key));
    }
    if (!this.#keys.has(currentKeyVersion)) throw new Error('Current vault key is missing');
    this.currentKeyVersion = currentKeyVersion;
  }

  encryptCredential(siteId: string, credentialType: string, plaintext: string | Uint8Array): EncryptedCredential {
    const key = this.#keys.get(this.currentKeyVersion);
    if (!key) throw new Error('Current vault key is unavailable');

    const nonce = randomBytes(NONCE_BYTES);
    const aad = credentialAad(siteId, credentialType, this.currentKeyVersion);
    const source = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_BYTES });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(source), cipher.final()]);
      return {
        ciphertext,
        nonce,
        authTag: cipher.getAuthTag(),
        keyVersion: this.currentKeyVersion,
      };
    } finally {
      source.fill(0);
    }
  }

  decryptCredential(siteId: string, credentialType: string, encrypted: EncryptedCredential): Buffer {
    const key = this.#keys.get(encrypted.keyVersion);
    if (!key) throw new Error(`Vault key version ${encrypted.keyVersion} is unavailable`);
    if (encrypted.nonce.length !== NONCE_BYTES || encrypted.authTag.length !== AUTH_TAG_BYTES) {
      throw new Error('Encrypted credential envelope is invalid');
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(credentialAad(siteId, credentialType, encrypted.keyVersion));
      decipher.setAuthTag(encrypted.authTag);
      return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
    } catch {
      throw new Error('Credential authentication failed');
    }
  }

  decryptCredentialText(siteId: string, credentialType: string, encrypted: EncryptedCredential): string {
    const plaintext = this.decryptCredential(siteId, credentialType, encrypted);
    try {
      return plaintext.toString('utf8');
    } finally {
      plaintext.fill(0);
    }
  }

  destroy(): void {
    for (const key of this.#keys.values()) key.fill(0);
    this.#keys.clear();
  }
}

export function serializeEncryptedCredential(encrypted: EncryptedCredential): SerializedEncryptedCredential {
  return {
    ciphertext: encrypted.ciphertext.toString('base64'),
    nonce: encrypted.nonce.toString('base64'),
    auth_tag: encrypted.authTag.toString('base64'),
    key_version: encrypted.keyVersion,
  };
}

export function parseEncryptedCredential(serialized: SerializedEncryptedCredential): EncryptedCredential {
  return {
    ciphertext: Buffer.from(serialized.ciphertext, 'base64'),
    nonce: Buffer.from(serialized.nonce, 'base64'),
    authTag: Buffer.from(serialized.auth_tag, 'base64'),
    keyVersion: serialized.key_version,
  };
}

export function initializeCredentialVault(config: AppConfig): CredentialVault {
  const keyring = loadMasterKeyRing({
    filePath: config.masterKeyFile,
    environment: config.nodeEnv,
  }, config.masterKeyVersion);
  try {
    return new CredentialVault(keyring.currentKeyVersion, keyring.keys);
  } finally {
    for (const key of keyring.keys.values()) key.fill(0);
  }
}
