import {
  createPrivateKey,
  X509Certificate,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { createSecureContext, type SecureContextOptions } from 'node:tls';
import { domainToASCII } from 'node:url';

import { eq } from 'drizzle-orm';

import type { AppConfig } from '../config.js';
import { AppError } from '../core/errors.js';
import { createId, isId } from '../core/ids.js';
import { serverAccessSettings, type DatabaseConnection } from '../db/index.js';

export const GLOBAL_SERVER_ACCESS_SETTINGS_ID = 'global';
const MAX_CERTIFICATE_BYTES = 256 * 1024;
const MAX_PRIVATE_KEY_BYTES = 128 * 1024;

export type ServerAccessProtocol = 'http' | 'https';

export interface StoredServerAccessSettings {
  tlsEnabled: boolean;
  accessHost: string;
  tlsMaterialId: string | null;
  updatedAt: string | null;
}

export interface ServerCertificateMetadata {
  configured: boolean;
  subject: string | null;
  issuer: string | null;
  subjectAltName: string | null;
  validFrom: string | null;
  validTo: string | null;
  fingerprintSha256: string | null;
  hostMatches: boolean | null;
}

export interface ActiveServerAccess {
  settings: StoredServerAccessSettings;
  protocol: ServerAccessProtocol;
  secureCookies: boolean;
  httpsOptions?: SecureContextOptions;
  destroy(): void;
}

interface ValidatedTlsMaterial {
  certificate: Buffer;
  privateKey: Buffer;
  metadata: ServerCertificateMetadata;
}

function fallbackAccessHost(config: AppConfig): string {
  if (config.webOrigin) {
    try {
      return normalizeAccessHost(new URL(config.webOrigin).hostname);
    } catch {
      // AppConfig is normally schema-validated; continue for manually assembled legacy configs.
    }
  }
  if (!['0.0.0.0', '::', '[::]'].includes(config.host)) {
    try {
      return normalizeAccessHost(config.host);
    } catch {
      // Fastify will report an invalid listen host; keep this display fallback usable.
    }
  }
  return '127.0.0.1';
}

export function normalizeAccessHost(input: string): string {
  let value = input.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (!value || value.length > 253 || /[\s/@?#\\]/.test(value)) {
    throw new AppError('SERVER_ACCESS_HOST_INVALID', '访问主机必须是有效的 IP 地址或域名', 400);
  }
  if (isIP(value)) return value.toLowerCase();
  const ascii = domainToASCII(value.replace(/\.$/, '')).toLowerCase();
  if (
    !ascii ||
    ascii.length > 253 ||
    !ascii.split('.').every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))
  ) {
    throw new AppError('SERVER_ACCESS_HOST_INVALID', '访问主机必须是有效的 IP 地址或域名', 400);
  }
  return ascii;
}

export function readServerAccessSettings(
  database: DatabaseConnection,
  config: AppConfig,
): StoredServerAccessSettings {
  const row = database.db.select().from(serverAccessSettings)
    .where(eq(serverAccessSettings.id, GLOBAL_SERVER_ACCESS_SETTINGS_ID)).get();
  if (!row) {
    return {
      tlsEnabled: false,
      accessHost: fallbackAccessHost(config),
      tlsMaterialId: null,
      updatedAt: null,
    };
  }
  return {
    tlsEnabled: row.tlsEnabled,
    accessHost: normalizeAccessHost(row.accessHost),
    tlsMaterialId: row.tlsMaterialId,
    updatedAt: row.updatedAt,
  };
}

export function serverAccessUrl(protocol: ServerAccessProtocol, host: string, port: number): string {
  const normalizedHost = normalizeAccessHost(host);
  const urlHost = isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost;
  const defaultPort = (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443);
  return `${protocol}://${urlHost}${defaultPort ? '' : `:${port}`}`;
}

function materialDirectory(config: AppConfig, materialId: string): string {
  if (!isId(materialId, 'tls')) {
    throw new AppError('SERVER_TLS_MATERIAL_INVALID', 'SSL 证书材料标识无效', 500);
  }
  return join(config.dataDir, 'tls', 'materials', materialId);
}

function materialPaths(config: AppConfig, materialId: string): { certificate: string; privateKey: string } {
  const directory = materialDirectory(config, materialId);
  return {
    certificate: join(directory, 'server.crt'),
    privateKey: join(directory, 'server.key'),
  };
}

function readLimitedFile(path: string, maximumBytes: number): Buffer {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) {
    throw new Error('invalid TLS material size');
  }
  return readFileSync(path);
}

function validateTlsMaterial(
  certificate: Buffer | string,
  privateKey: Buffer | string,
  accessHost: string,
  requireHostMatch = true,
): ValidatedTlsMaterial {
  const certificateBuffer = Buffer.isBuffer(certificate) ? Buffer.from(certificate) : Buffer.from(certificate, 'utf8');
  const privateKeyBuffer = Buffer.isBuffer(privateKey) ? Buffer.from(privateKey) : Buffer.from(privateKey, 'utf8');
  if (certificateBuffer.length < 1 || certificateBuffer.length > MAX_CERTIFICATE_BYTES) {
    throw new AppError('SERVER_CERTIFICATE_INVALID', '服务器证书大小无效', 400);
  }
  if (privateKeyBuffer.length < 1 || privateKeyBuffer.length > MAX_PRIVATE_KEY_BYTES) {
    throw new AppError('SERVER_PRIVATE_KEY_INVALID', '服务器私钥大小无效', 400);
  }

  try {
    const leaf = new X509Certificate(certificateBuffer);
    const key = createPrivateKey(privateKeyBuffer);
    if (!leaf.checkPrivateKey(key)) {
      throw new AppError('SERVER_CERTIFICATE_KEY_MISMATCH', '服务器证书与私钥不匹配', 400);
    }
    createSecureContext({ cert: certificateBuffer, key: privateKeyBuffer });

    const validFromMs = Date.parse(leaf.validFrom);
    const validToMs = Date.parse(leaf.validTo);
    const now = Date.now();
    if (!Number.isFinite(validFromMs) || !Number.isFinite(validToMs) || now < validFromMs || now >= validToMs) {
      throw new AppError('SERVER_CERTIFICATE_EXPIRED', '服务器证书尚未生效或已经过期', 400);
    }

    const host = normalizeAccessHost(accessHost);
    const matched = isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host);
    if (requireHostMatch && !matched) {
      throw new AppError('SERVER_CERTIFICATE_HOST_MISMATCH', '服务器证书未覆盖当前访问 IP 或域名', 400);
    }

    return {
      certificate: certificateBuffer,
      privateKey: privateKeyBuffer,
      metadata: {
        configured: true,
        subject: leaf.subject || null,
        issuer: leaf.issuer || null,
        subjectAltName: leaf.subjectAltName || null,
        validFrom: Number.isFinite(validFromMs) ? new Date(validFromMs).toISOString() : null,
        validTo: Number.isFinite(validToMs) ? new Date(validToMs).toISOString() : null,
        fingerprintSha256: leaf.fingerprint256 || null,
        hostMatches: Boolean(matched),
      },
    };
  } catch (error) {
    certificateBuffer.fill(0);
    privateKeyBuffer.fill(0);
    if (error instanceof AppError) throw error;
    throw new AppError(
      'SERVER_TLS_MATERIAL_INVALID',
      '服务器证书或私钥格式无效；私钥必须是未加密 PEM，并与证书匹配',
      400,
    );
  }
}

function loadTlsMaterial(
  config: AppConfig,
  materialId: string,
  accessHost: string,
  requireHostMatch = true,
): ValidatedTlsMaterial {
  try {
    const paths = materialPaths(config, materialId);
    return validateTlsMaterial(
      readLimitedFile(paths.certificate, MAX_CERTIFICATE_BYTES),
      readLimitedFile(paths.privateKey, MAX_PRIVATE_KEY_BYTES),
      accessHost,
      requireHostMatch,
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SERVER_TLS_MATERIAL_MISSING', '已配置的 SSL 证书文件缺失或无法读取', 500);
  }
}

export function inspectServerCertificate(
  config: AppConfig,
  settings: StoredServerAccessSettings,
): ServerCertificateMetadata {
  if (!settings.tlsMaterialId) {
    return {
      configured: false,
      subject: null,
      issuer: null,
      subjectAltName: null,
      validFrom: null,
      validTo: null,
      fingerprintSha256: null,
      hostMatches: null,
    };
  }
  try {
    const material = loadTlsMaterial(config, settings.tlsMaterialId, settings.accessHost, false);
    material.certificate.fill(0);
    material.privateKey.fill(0);
    return material.metadata;
  } catch {
    return {
      configured: false,
      subject: null,
      issuer: null,
      subjectAltName: null,
      validFrom: null,
      validTo: null,
      fingerprintSha256: null,
      hostMatches: null,
    };
  }
}

export function storeTlsMaterial(
  config: AppConfig,
  certificatePem: string,
  privateKeyPem: string,
  accessHost: string,
): { materialId: string; metadata: ServerCertificateMetadata } {
  const material = validateTlsMaterial(certificatePem, privateKeyPem, accessHost);
  const materialId = createId('tls');
  const materialsRoot = join(config.dataDir, 'tls', 'materials');
  const staging = join(materialsRoot, `.${materialId}.tmp`);
  const destination = join(materialsRoot, materialId);
  try {
    mkdirSync(materialsRoot, { recursive: true, mode: 0o700 });
    chmodSync(join(config.dataDir, 'tls'), 0o700);
    chmodSync(materialsRoot, 0o700);
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, 'server.crt'), material.certificate, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(staging, 'server.key'), material.privateKey, { flag: 'wx', mode: 0o600 });
    renameSync(staging, destination);
  } catch {
    rmSync(staging, { recursive: true, force: true });
    throw new AppError('SERVER_TLS_MATERIAL_WRITE_FAILED', '服务器证书保存失败，请检查数据目录权限', 500);
  } finally {
    material.certificate.fill(0);
    material.privateKey.fill(0);
  }
  return { materialId, metadata: material.metadata };
}

export function removeTlsMaterial(config: AppConfig, materialId: string): void {
  rmSync(materialDirectory(config, materialId), { recursive: true, force: true });
}

export function assertUsableStoredTlsMaterial(
  config: AppConfig,
  settings: StoredServerAccessSettings,
): ServerCertificateMetadata {
  if (!settings.tlsMaterialId) {
    throw new AppError('SERVER_CERTIFICATE_REQUIRED', '启用 HTTPS 前需要配置服务器证书和私钥', 400);
  }
  const material = loadTlsMaterial(config, settings.tlsMaterialId, settings.accessHost);
  material.certificate.fill(0);
  material.privateKey.fill(0);
  return material.metadata;
}

export function loadActiveServerAccess(database: DatabaseConnection, config: AppConfig): ActiveServerAccess {
  const settings = readServerAccessSettings(database, config);
  let material: ValidatedTlsMaterial | undefined;
  if (settings.tlsEnabled) {
    if (!settings.tlsMaterialId) {
      throw new Error('HTTPS 已启用，但系统设置中没有可用的服务器证书');
    }
    try {
      material = loadTlsMaterial(config, settings.tlsMaterialId, settings.accessHost);
    } catch (error) {
      throw new Error(error instanceof Error ? `HTTPS 启动失败：${error.message}` : 'HTTPS 启动失败');
    }
  }

  // Active built-in TLS always requires secure cookie semantics. The explicit
  // override exists for HTTPS terminated by a trusted external proxy.
  const secureCookies = settings.tlsEnabled || config.sessionCookieSecure === 'true';
  return {
    settings,
    protocol: settings.tlsEnabled ? 'https' : 'http',
    secureCookies,
    ...(material ? { httpsOptions: { cert: material.certificate, key: material.privateKey } } : {}),
    destroy: () => {
      material?.certificate.fill(0);
      material?.privateKey.fill(0);
    },
  };
}
