import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  finalizeMasterKeyRotation,
  rotateMasterKey,
} from '../../backend/cli/master-key.js';
import { CredentialVault, loadMasterKeyRing } from '../../backend/core/vault.js';
import { openDatabase, type DatabaseConnection } from '../../backend/db/client.js';

const temporaryDirectories: string[] = [];
const CHANNEL_SECRET_AAD_TYPE = 'notification_channel_secret';

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-key-rotation-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function seedEncryptedRows(connection: DatabaseConnection, vault: CredentialVault): void {
  connection.sqlite.prepare(
    `insert into sites (id, adapter_type, name, base_url)
     values ('site_rotation', 'sub2api', 'Rotation test', 'https://example.com')`,
  ).run();
  const credential = vault.encryptCredential('site_rotation', 'api_key', 'credential-test-secret');
  connection.sqlite.prepare(
    `insert into credentials
       (id, site_id, credential_type, ciphertext, nonce, auth_tag, key_version)
     values ('cred_rotation', 'site_rotation', 'api_key', ?, ?, ?, ?)`,
  ).run(credential.ciphertext, credential.nonce, credential.authTag, credential.keyVersion);

  const current = vault.encryptCredential('channel_rotation', CHANNEL_SECRET_AAD_TYPE, 'channel-current-secret');
  const previous = vault.encryptCredential('channel_rotation', CHANNEL_SECRET_AAD_TYPE, 'channel-previous-secret');
  connection.sqlite.prepare(
    `insert into notification_channels
       (id, name, url, secret_type, secret_ciphertext, secret_nonce, secret_auth_tag,
        secret_key_version, previous_secret_ciphertext, previous_secret_nonce,
        previous_secret_auth_tag, previous_secret_key_version)
     values ('channel_rotation', 'Rotation channel', 'https://hooks.example.com', 'hmac_sha256',
             ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    current.ciphertext,
    current.nonce,
    current.authTag,
    current.keyVersion,
    previous.ciphertext,
    previous.nonce,
    previous.authTag,
    previous.keyVersion,
  );
}

function readCredential(connection: DatabaseConnection): {
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  key_version: number;
} {
  return connection.sqlite.prepare(
    `select ciphertext, nonce, auth_tag, key_version from credentials where id = 'cred_rotation'`,
  ).get() as {
    ciphertext: Buffer;
    nonce: Buffer;
    auth_tag: Buffer;
    key_version: number;
  };
}

describe('master key rotation CLI core', () => {
  it('atomically re-encrypts credentials and both channel secret slots, then safely prunes old keys', () => {
    const directory = temporaryDirectory();
    const keyPath = join(directory, 'master.key');
    const oldKey = Buffer.alloc(32, 3);
    writeFileSync(keyPath, oldKey);
    const connection = openDatabase({ path: join(directory, 'monitor.db') });
    const oldVault = new CredentialVault(1, new Map([[1, oldKey]]));
    seedEncryptedRows(connection, oldVault);
    oldVault.destroy();

    try {
      const result = rotateMasterKey(connection, {
        filePath: keyPath,
        environment: 'test',
        legacyCurrentKeyVersion: 1,
        newKeyVersion: 2,
      });
      expect(result).toEqual({
        previousKeyVersion: 1,
        currentKeyVersion: 2,
        credentialsRotated: 1,
        channelSecretsRotated: 1,
        previousChannelSecretsRotated: 1,
      });

      const keyring = loadMasterKeyRing({ filePath: keyPath, environment: 'test' }, 1);
      const vault = new CredentialVault(keyring.currentKeyVersion, keyring.keys);
      const credential = readCredential(connection);
      expect([...keyring.keys.keys()]).toEqual([1, 2]);
      expect(credential.key_version).toBe(2);
      expect(vault.decryptCredentialText('site_rotation', 'api_key', {
        ciphertext: credential.ciphertext,
        nonce: credential.nonce,
        authTag: credential.auth_tag,
        keyVersion: credential.key_version,
      })).toBe('credential-test-secret');

      const channel = connection.sqlite.prepare(
        `select secret_ciphertext, secret_nonce, secret_auth_tag, secret_key_version,
                previous_secret_ciphertext, previous_secret_nonce, previous_secret_auth_tag,
                previous_secret_key_version
         from notification_channels where id = 'channel_rotation'`,
      ).get() as Record<string, Buffer | number>;
      expect(channel.secret_key_version).toBe(2);
      expect(channel.previous_secret_key_version).toBe(2);
      expect(vault.decryptCredentialText('channel_rotation', CHANNEL_SECRET_AAD_TYPE, {
        ciphertext: channel.secret_ciphertext as Buffer,
        nonce: channel.secret_nonce as Buffer,
        authTag: channel.secret_auth_tag as Buffer,
        keyVersion: channel.secret_key_version as number,
      })).toBe('channel-current-secret');
      expect(vault.decryptCredentialText('channel_rotation', CHANNEL_SECRET_AAD_TYPE, {
        ciphertext: channel.previous_secret_ciphertext as Buffer,
        nonce: channel.previous_secret_nonce as Buffer,
        authTag: channel.previous_secret_auth_tag as Buffer,
        keyVersion: channel.previous_secret_key_version as number,
      })).toBe('channel-previous-secret');
      vault.destroy();
      for (const key of keyring.keys.values()) key.fill(0);

      const finalized = finalizeMasterKeyRotation(connection, {
        filePath: keyPath,
        environment: 'test',
        legacyCurrentKeyVersion: 1,
      });
      expect(finalized).toEqual({ currentKeyVersion: 2, removedKeyVersions: [1] });
      const finalKeyring = loadMasterKeyRing({ filePath: keyPath, environment: 'test' }, 1);
      expect([...finalKeyring.keys.keys()]).toEqual([2]);
      for (const key of finalKeyring.keys.values()) key.fill(0);
    } finally {
      connection.close();
    }
  });

  it('rolls back every database write and restores the exact legacy key file on failure', () => {
    const directory = temporaryDirectory();
    const keyPath = join(directory, 'master.key');
    const oldKey = Buffer.alloc(32, 5);
    writeFileSync(keyPath, oldKey);
    const originalFile = readFileSync(keyPath);
    const connection = openDatabase({ path: join(directory, 'monitor.db') });
    const oldVault = new CredentialVault(1, new Map([[1, oldKey]]));
    seedEncryptedRows(connection, oldVault);
    connection.sqlite.exec(
      `create trigger force_key_rotation_failure
       before update of secret_ciphertext on notification_channels
       begin
         select raise(abort, 'forced rotation failure');
       end`,
    );

    try {
      let failure: unknown;
      try {
        rotateMasterKey(connection, {
          filePath: keyPath,
          environment: 'test',
          legacyCurrentKeyVersion: 1,
          newKeyVersion: 2,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain('credential-test-secret');
      expect(String(failure)).not.toContain('channel-current-secret');
      expect(readFileSync(keyPath).equals(originalFile)).toBe(true);
      const credential = readCredential(connection);
      expect(credential.key_version).toBe(1);
      expect(oldVault.decryptCredentialText('site_rotation', 'api_key', {
        ciphertext: credential.ciphertext,
        nonce: credential.nonce,
        authTag: credential.auth_tag,
        keyVersion: credential.key_version,
      })).toBe('credential-test-secret');
      const channelVersion = connection.sqlite.prepare(
        `select secret_key_version from notification_channels where id = 'channel_rotation'`,
      ).get() as { secret_key_version: number };
      expect(channelVersion.secret_key_version).toBe(1);
    } finally {
      originalFile.fill(0);
      oldVault.destroy();
      connection.close();
    }
  });
});
