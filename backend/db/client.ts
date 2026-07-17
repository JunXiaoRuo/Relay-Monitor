import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { AppConfig } from '../config.js';
import { runMigrations } from './migrate.js';
import { schema } from './schema.js';

export interface OpenDatabaseOptions {
  path: string;
  busyTimeoutMs?: number;
  runMigrations?: boolean;
  migrationsFolder?: string;
}

export interface DatabaseConnection {
  sqlite: BetterSqlite3.Database;
  db: BetterSQLite3Database<typeof schema>;
  path: string;
  close(): void;
}

function prepareDatabaseDirectory(databasePath: string): void {
  if (databasePath === ':memory:' || databasePath.startsWith('file:')) return;
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o750 });
}

export function openDatabase(options: OpenDatabaseOptions): DatabaseConnection {
  prepareDatabaseDirectory(options.path);
  const sqlite = new BetterSqlite3(options.path);

  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
    sqlite.pragma('synchronous = FULL');
    sqlite.pragma('wal_autocheckpoint = 1000');
    if (options.path !== ':memory:') sqlite.pragma('journal_mode = WAL');

    const db = drizzle(sqlite, { schema });
    if (options.runMigrations !== false) runMigrations(db, options.migrationsFolder);

    return {
      sqlite,
      db,
      path: options.path,
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export function initializeDatabase(config: AppConfig): DatabaseConnection {
  return openDatabase({
    path: config.databasePath,
    busyTimeoutMs: config.databaseBusyTimeoutMs,
    runMigrations: true,
  });
}
