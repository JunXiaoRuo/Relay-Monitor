import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const optionalUrlString = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() || undefined : value,
  z.string().url().optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  TZ: z.string().min(1).default('Asia/Shanghai'),
  DATA_DIR: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  MASTER_KEY_FILE: z.string().min(1).optional(),
  MASTER_KEY_VERSION: z.coerce.number().int().positive().default(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.string().default('false'),
  MANAGED_RESTART: booleanString.default(false),
  SESSION_COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  WEB_ORIGIN: optionalUrlString,
  DATABASE_BUSY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(5_000),
  MAX_CONCURRENT_SITES: z.coerce.number().int().min(1).max(100).default(5),
  OUTBOUND_ALLOWED_CIDRS: z.string().default(''),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  timezone: string;
  dataDir: string;
  databasePath: string;
  masterKeyFile: string;
  /** Fallback version for legacy single-key files; versioned keyrings embed their current version. */
  masterKeyVersion: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  trustProxy: boolean | string;
  managedRestart: boolean;
  sessionCookieSecure: 'auto' | 'true' | 'false';
  webOrigin: string | undefined;
  databaseBusyTimeoutMs: number;
  maxConcurrentSites: number;
  outboundAllowedCidrs: string[];
  isProduction: boolean;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const [majorText, minorText] = version.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);

  if (major !== 22 || !Number.isInteger(minor) || minor < 19) {
    throw new Error(`Relay Monitor requires Node.js 22.19 or newer in the 22.x release line; found ${version}`);
  }
}

function resolveFilePath(value: string, baseDirectory: string): string {
  if (value.startsWith('file:')) {
    return fileURLToPath(value);
  }
  return isAbsolute(value) ? value : resolve(baseDirectory, value);
}

function defaultDevelopmentDataDirectory(): string {
  const configuredHome = process.env.RELAY_MONITOR_HOME;
  if (configuredHome) return resolve(configuredHome);

  // Keep credentials outside the source tree unless DATA_DIR explicitly opts in.
  return join(homedir(), '.relay-monitor');
}

function parseTrustProxy(value: string): boolean | string {
  const parsedBoolean = booleanString.safeParse(value.toLowerCase());
  return parsedBoolean.success ? parsedBoolean.data : value;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  assertSupportedNodeVersion();
  const values = environmentSchema.parse(environment);
  const isProduction = values.NODE_ENV === 'production';
  const defaultDataDir = isProduction ? '/var/lib/relay-monitor' : defaultDevelopmentDataDirectory();
  const dataDir = resolveFilePath(values.DATA_DIR ?? defaultDataDir, process.cwd());
  const databasePath = resolveFilePath(values.DATABASE_URL ?? join(dataDir, 'monitor.db'), process.cwd());
  const masterKeyFile = resolveFilePath(
    values.MASTER_KEY_FILE ?? (isProduction ? '/etc/relay-monitor/master.key' : join(dataDir, 'master.key')),
    process.cwd(),
  );

  if (isProduction && !existsSync(masterKeyFile)) {
    throw new Error(`MASTER_KEY_FILE must already exist in production: ${masterKeyFile}`);
  }

  return {
    nodeEnv: values.NODE_ENV,
    host: values.HOST,
    port: values.PORT,
    timezone: values.TZ,
    dataDir,
    databasePath,
    masterKeyFile,
    masterKeyVersion: values.MASTER_KEY_VERSION,
    logLevel: values.LOG_LEVEL,
    trustProxy: parseTrustProxy(values.TRUST_PROXY),
    managedRestart: values.MANAGED_RESTART,
    sessionCookieSecure: values.SESSION_COOKIE_SECURE,
    webOrigin: values.WEB_ORIGIN,
    databaseBusyTimeoutMs: values.DATABASE_BUSY_TIMEOUT_MS,
    maxConcurrentSites: values.MAX_CONCURRENT_SITES,
    outboundAllowedCidrs: [
      ...new Set(
        values.OUTBOUND_ALLOWED_CIDRS.split(',')
          .map((cidr) => cidr.trim())
          .filter(Boolean),
      ),
    ],
    isProduction,
  };
}

export function loadLocalEnvironmentFile(path = resolve('.env')): void {
  if (process.env.NODE_ENV === 'production' || !existsSync(path)) return;
  process.loadEnvFile(path);
}

export function configDirectories(config: AppConfig): string[] {
  return [...new Set([config.dataDir, dirname(config.databasePath), dirname(config.masterKeyFile)])];
}

loadLocalEnvironmentFile();
export const config = loadConfig();
