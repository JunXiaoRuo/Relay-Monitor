import { pathToFileURL } from 'node:url';

import { config } from '../config.js';
import { initializeDatabase } from '../db/client.js';

export function migrateDatabase(): void {
  const connection = initializeDatabase(config);
  try {
    const migrations = connection.sqlite
      .prepare('select id, hash, created_at from __drizzle_migrations order by created_at')
      .all();
    console.info(`Database is ready at ${connection.path}; ${migrations.length} migration(s) applied.`);
  } finally {
    connection.close();
  }
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  try {
    migrateDatabase();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Database migration failed');
    process.exitCode = 1;
  }
}
