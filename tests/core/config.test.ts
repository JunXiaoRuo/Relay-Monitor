import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertSupportedNodeVersion, loadConfig } from '../../backend/config.js';

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('runtime configuration', () => {
  it('pins the supported runtime to Node 22.19+ in the 22.x line', () => {
    expect(() => assertSupportedNodeVersion('22.19.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion('22.99.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion('22.18.9')).toThrow(/22\.19/i);
    expect(() => assertSupportedNodeVersion('23.0.0')).toThrow(/22\.x/i);
  });

  it('treats WEB_ORIGIN as an optional legacy address hint', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).webOrigin).toBeUndefined();
    expect(loadConfig({ NODE_ENV: 'test', WEB_ORIGIN: '   ' }).webOrigin).toBeUndefined();
    expect(loadConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: '  https://monitor.example.com:8443  ',
    }).webOrigin).toBe('https://monitor.example.com:8443');
  });

  it('requires a pre-provisioned production key and parses allowed CIDRs', () => {
    const directory = join(tmpdir(), `relay-monitor-config-${process.pid}-${Date.now()}`);
    temporaryPaths.push(directory);
    mkdirSync(directory, { recursive: true });
    const keyPath = join(directory, 'master.key');

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATA_DIR: directory,
        DATABASE_URL: join(directory, 'monitor.db'),
        MASTER_KEY_FILE: keyPath,
      }),
    ).toThrow(/must already exist/i);

    writeFileSync(keyPath, Buffer.alloc(32, 1));
    const loaded = loadConfig({
      NODE_ENV: 'production',
      DATA_DIR: directory,
      DATABASE_URL: join(directory, 'monitor.db'),
      MASTER_KEY_FILE: keyPath,
      OUTBOUND_ALLOWED_CIDRS: '10.20.0.0/16, 192.168.50.0/24,10.20.0.0/16',
      MANAGED_RESTART: 'true',
      SESSION_COOKIE_SECURE: 'true',
    });
    expect(loaded.outboundAllowedCidrs).toEqual(['10.20.0.0/16', '192.168.50.0/24']);
    expect(loaded.managedRestart).toBe(true);
    expect(loaded.sessionCookieSecure).toBe('true');
  });
});
