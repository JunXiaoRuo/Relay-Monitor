import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { config } from '../config.js';
import { createId } from '../core/ids.js';
import {
  assertValidAdminPassword,
  hashAdminPassword,
  normalizeAdminUsername,
} from '../core/password.js';
import { initializeDatabase, type DatabaseConnection } from '../db/client.js';

export interface AdminPasswordInput {
  username: string;
  password: string;
  displayName?: string;
}

function now(): string {
  return new Date().toISOString();
}

export async function createAdmin(
  connection: DatabaseConnection,
  input: AdminPasswordInput,
): Promise<string> {
  const username = normalizeAdminUsername(input.username);
  assertValidAdminPassword(input.password);
  const passwordHash = await hashAdminPassword(input.password);
  const adminId = createId('adm');
  const timestamp = now();

  const transaction = connection.sqlite.transaction(() => {
    connection.sqlite
      .prepare(
        `insert into admins
          (id, username, display_name, password_hash, is_active, failed_login_count,
           password_changed_at, created_at, updated_at)
         values (?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      )
      .run(adminId, username, input.displayName?.trim() || username, passwordHash, timestamp, timestamp, timestamp);
    connection.sqlite
      .prepare(
        `insert into audit_logs
          (id, admin_id, action, resource_type, resource_id, metadata_json, created_at)
         values (?, ?, 'admin.created', 'admin', ?, '{}', ?)`,
      )
      .run(createId('aud'), adminId, adminId, timestamp);
  });

  try {
    transaction();
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
      throw new Error(`Administrator '${username}' already exists`);
    }
    throw error;
  }
  return adminId;
}

export async function resetAdminPassword(
  connection: DatabaseConnection,
  input: AdminPasswordInput,
): Promise<string> {
  const username = normalizeAdminUsername(input.username);
  assertValidAdminPassword(input.password);
  const admin = connection.sqlite
    .prepare('select id from admins where username = ?')
    .get(username) as { id: string } | undefined;
  if (!admin) throw new Error(`Administrator '${username}' does not exist`);

  const passwordHash = await hashAdminPassword(input.password);
  const timestamp = now();
  connection.sqlite.transaction(() => {
    connection.sqlite
      .prepare(
        `update admins
         set password_hash = ?, failed_login_count = 0, locked_until = null,
             password_changed_at = ?, updated_at = ?
         where id = ?`,
      )
      .run(passwordHash, timestamp, timestamp, admin.id);
    connection.sqlite
      .prepare(
        `update admin_sessions set revoked_at = ?
         where admin_id = ? and revoked_at is null`,
      )
      .run(timestamp, admin.id);
    connection.sqlite
      .prepare(
        `insert into audit_logs
          (id, admin_id, action, resource_type, resource_id, metadata_json, created_at)
         values (?, ?, 'admin.password_reset', 'admin', ?, '{}', ?)`,
      )
      .run(createId('aud'), admin.id, admin.id, timestamp);
  })();
  return admin.id;
}

function argumentValue(name: string): string | undefined {
  const equalsPrefix = `--${name}=`;
  const equalsValue = process.argv.find((argument) => argument.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readPasswordFromPipe(): string {
  const value = readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
  if (!value) throw new Error('No password was received on standard input');
  return value;
}

function readHiddenLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error('A TTY is required; use --password-stdin for a protected input pipe');
  }

  return new Promise((resolve, reject) => {
    const wasRaw = process.stdin.isRaw;
    let value = '';

    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = [...value].slice(0, -1).join('');
        } else if (character >= ' ') {
          value += character;
        }
      }
    };

    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function obtainPassword(): Promise<string> {
  if (hasFlag('password-stdin')) return readPasswordFromPipe();
  const password = await readHiddenLine('Password: ');
  const confirmation = await readHiddenLine('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match');
  return password;
}

export async function runAdminCli(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'create' && command !== 'reset-password') {
    throw new Error('Usage: admin.ts <create|reset-password> --username <name> [--password-stdin]');
  }
  const username = argumentValue('username');
  if (!username) throw new Error('--username is required');

  const password = await obtainPassword();
  const connection = initializeDatabase(config);
  try {
    if (command === 'create') {
      const displayName = argumentValue('display-name');
      const id = await createAdmin(connection, {
        username,
        password,
        ...(displayName ? { displayName } : {}),
      });
      console.info(`Administrator '${normalizeAdminUsername(username)}' created (${id}).`);
    } else {
      await resetAdminPassword(connection, { username, password });
      console.info(`Password reset for '${normalizeAdminUsername(username)}'; active sessions were revoked.`);
    }
  } finally {
    connection.close();
  }
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  runAdminCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Administrator operation failed');
    process.exitCode = 1;
  });
}
