import { afterEach, describe, expect, it } from 'vitest';

import { createAdmin, resetAdminPassword } from '../../backend/cli/admin.js';
import { verifyAdminPassword } from '../../backend/core/password.js';
import { openDatabase, type DatabaseConnection } from '../../backend/db/client.js';

let connection: DatabaseConnection | undefined;

afterEach(() => {
  connection?.close();
  connection = undefined;
});

describe('administrator CLI operations', () => {
  it('creates an administrator, audits it, resets the password, and revokes sessions', async () => {
    connection = openDatabase({ path: ':memory:' });
    const adminId = await createAdmin(connection, {
      username: 'Admin',
      displayName: 'Operations',
      password: 'initial secure passphrase',
    });
    const initial = connection.sqlite
      .prepare('select username, display_name, password_hash from admins where id = ?')
      .get(adminId) as { username: string; display_name: string; password_hash: string };
    expect(initial.username).toBe('admin');
    expect(initial.display_name).toBe('Operations');
    expect(await verifyAdminPassword(initial.password_hash, 'initial secure passphrase')).toBe(true);

    connection.sqlite
      .prepare(
        `insert into admin_sessions
          (id, admin_id, token_hash, csrf_token_hash, expires_at)
         values ('sess_test', ?, 'token_hash', 'csrf_hash', '2099-01-01T00:00:00.000Z')`,
      )
      .run(adminId);
    await resetAdminPassword(connection, {
      username: 'ADMIN',
      password: 'replacement secure passphrase',
    });

    const reset = connection.sqlite
      .prepare('select password_hash from admins where id = ?')
      .get(adminId) as { password_hash: string };
    expect(await verifyAdminPassword(reset.password_hash, 'replacement secure passphrase')).toBe(true);
    expect(
      (connection.sqlite.prepare('select revoked_at from admin_sessions where id = ?').get('sess_test') as {
        revoked_at: string | null;
      }).revoked_at,
    ).not.toBeNull();
    expect(
      (connection.sqlite.prepare('select count(*) as count from audit_logs').get() as { count: number }).count,
    ).toBe(2);
  });

  it('does not overwrite an existing administrator', async () => {
    connection = openDatabase({ path: ':memory:' });
    const input = { username: 'admin', password: 'initial secure passphrase' };
    await createAdmin(connection, input);
    await expect(createAdmin(connection, input)).rejects.toThrow(/already exists/i);
  });
});
