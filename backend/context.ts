import type { AppConfig } from './config.js';
import { config as defaultConfig } from './config.js';
import { createBuiltinAdapterRegistry, type AdapterRegistry } from './adapters/index.js';
import { initializeCredentialVault, type CredentialVault } from './core/vault.js';
import { initializeDatabase, type DatabaseConnection } from './db/index.js';
import {
  loadActiveServerAccess,
  type ActiveServerAccess,
} from './services/server-access-settings.js';

export interface RuntimeState {
  schedulerRunning: boolean;
  schedulerLagMs: number;
  lastScheduleSuccessAt: string | null;
}

export interface AppContext {
  config: AppConfig;
  database: DatabaseConnection;
  vault: CredentialVault;
  adapters: AdapterRegistry;
  serverAccess: ActiveServerAccess;
  startedAt: string;
  runtime: RuntimeState;
  close(): Promise<void>;
}

export function createAppContext(config: AppConfig = defaultConfig): AppContext {
  const database = initializeDatabase(config);
  let vault: CredentialVault | undefined;
  let serverAccess: ActiveServerAccess;
  try {
    vault = initializeCredentialVault(config);
    serverAccess = loadActiveServerAccess(database, config);
  } catch (error) {
    vault?.destroy();
    database.close();
    throw error;
  }

  return {
    config,
    database,
    vault,
    adapters: createBuiltinAdapterRegistry(),
    serverAccess,
    startedAt: new Date().toISOString(),
    runtime: {
      schedulerRunning: false,
      schedulerLagMs: 0,
      lastScheduleSuccessAt: null,
    },
    close: async () => {
      serverAccess.destroy();
      vault.destroy();
      database.close();
    },
  };
}
