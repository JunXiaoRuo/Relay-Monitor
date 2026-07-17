import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './backend/db/migrations',
  schema: './backend/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? './data/monitor.db',
  },
  strict: true,
  verbose: true,
});
