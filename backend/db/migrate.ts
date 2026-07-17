import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { schema } from './schema.js';

export function resolveMigrationsFolder(explicitFolder?: string): string {
  const candidates = [
    explicitFolder,
    fileURLToPath(new URL('./migrations', import.meta.url)),
    resolve(process.cwd(), 'backend/db/migrations'),
    resolve(process.cwd(), 'dist/server/backend/db/migrations'),
  ].filter((candidate): candidate is string => candidate !== undefined);

  const folder = candidates.find((candidate) => existsSync(resolve(candidate, 'meta/_journal.json')));
  if (!folder) {
    throw new Error(`Database migrations were not found. Checked: ${candidates.join(', ')}`);
  }
  return folder;
}

export function runMigrations(
  database: BetterSQLite3Database<typeof schema>,
  migrationsFolder?: string,
): void {
  migrate(database, { migrationsFolder: resolveMigrationsFolder(migrationsFolder) });
}
