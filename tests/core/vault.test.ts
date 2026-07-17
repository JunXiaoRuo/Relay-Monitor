import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CredentialVault,
  initializeCredentialVault,
  loadMasterKeyRing,
  loadOrCreateMasterKey,
  parseEncryptedCredential,
  serializeEncryptedCredential,
  serializeMasterKeyRing,
} from '../../backend/core/vault.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-vault-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('credential vault', () => {
  it('creates an external development key but never creates one in production', () => {
    const developmentPath = join(temporaryDirectory(), 'keys', 'master.key');
    const key = loadOrCreateMasterKey({ filePath: developmentPath, environment: 'development' });
    expect(key).toHaveLength(32);
    expect(readFileSync(developmentPath)).toHaveLength(32);

    const productionPath = join(temporaryDirectory(), 'master.key');
    expect(() =>
      loadOrCreateMasterKey({ filePath: productionPath, environment: 'production' }),
    ).toThrow(/provisioned before production/i);
  });

  it('uses a fresh nonce and binds ciphertext to site, type, and version', () => {
    const key = Buffer.alloc(32, 7);
    const vault = new CredentialVault(3, new Map([[3, key]]));
    const first = vault.encryptCredential('site_A', 'access_token', 'top-secret');
    const second = vault.encryptCredential('site_A', 'access_token', 'top-secret');

    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(vault.decryptCredentialText('site_A', 'access_token', first)).toBe('top-secret');
    expect(() => vault.decryptCredentialText('site_B', 'access_token', first)).toThrow(/authentication failed/i);
    expect(() => vault.decryptCredentialText('site_A', 'refresh_token', first)).toThrow(/authentication failed/i);

    const serialized = serializeEncryptedCredential(first);
    expect(vault.decryptCredentialText('site_A', 'access_token', parseEncryptedCredential(serialized))).toBe(
      'top-secret',
    );
    vault.destroy();
  });

  it('rejects tampered ciphertext without exposing plaintext', () => {
    const vault = new CredentialVault(1, new Map([[1, Buffer.alloc(32, 9)]]));
    const encrypted = vault.encryptCredential('site_A', 'api_key', 'sk-example-secret');
    encrypted.ciphertext[0] = (encrypted.ciphertext[0] ?? 0) ^ 1;
    expect(() => vault.decryptCredentialText('site_A', 'api_key', encrypted)).toThrow(
      'Credential authentication failed',
    );
  });

  it('loads legacy and versioned keyrings and decrypts old and new envelopes during rotation', () => {
    const directory = temporaryDirectory();
    const keyPath = join(directory, 'master.key');
    const oldKey = Buffer.alloc(32, 4);
    const newKey = Buffer.alloc(32, 8);
    writeFileSync(keyPath, oldKey);

    const legacy = loadMasterKeyRing({ filePath: keyPath, environment: 'test' }, 6);
    expect(legacy.sourceFormat).toBe('legacy');
    expect(legacy.currentKeyVersion).toBe(6);
    expect([...legacy.keys.keys()]).toEqual([6]);
    for (const key of legacy.keys.values()) key.fill(0);

    const oldVault = new CredentialVault(6, new Map([[6, oldKey]]));
    const oldEnvelope = oldVault.encryptCredential('site_A', 'api_key', 'old-envelope');
    writeFileSync(keyPath, serializeMasterKeyRing(7, new Map([
      [6, oldKey],
      [7, newKey],
    ])));
    const keyring = loadMasterKeyRing({ filePath: keyPath, environment: 'test' }, 1);
    const transitionVault = new CredentialVault(keyring.currentKeyVersion, keyring.keys);
    const newEnvelope = transitionVault.encryptCredential('site_A', 'api_key', 'new-envelope');

    expect(keyring.sourceFormat).toBe('keyring');
    expect(keyring.currentKeyVersion).toBe(7);
    expect(transitionVault.decryptCredentialText('site_A', 'api_key', oldEnvelope)).toBe('old-envelope');
    expect(transitionVault.decryptCredentialText('site_A', 'api_key', newEnvelope)).toBe('new-envelope');
    const startupVault = initializeCredentialVault({
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 8080,
      timezone: 'UTC',
      dataDir: directory,
      databasePath: join(directory, 'monitor.db'),
      masterKeyFile: keyPath,
      masterKeyVersion: 1,
      logLevel: 'silent',
      trustProxy: false,
      webOrigin: 'http://127.0.0.1:5173',
      databaseBusyTimeoutMs: 5_000,
      maxConcurrentSites: 1,
      outboundAllowedCidrs: [],
      isProduction: false,
    });
    expect(startupVault.currentKeyVersion).toBe(7);
    expect(startupVault.decryptCredentialText('site_A', 'api_key', oldEnvelope)).toBe('old-envelope');
    expect(startupVault.decryptCredentialText('site_A', 'api_key', newEnvelope)).toBe('new-envelope');
    startupVault.destroy();
    transitionVault.destroy();
    oldVault.destroy();
    for (const key of keyring.keys.values()) key.fill(0);
  });
});
