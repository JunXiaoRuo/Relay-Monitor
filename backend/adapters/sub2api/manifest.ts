import { z } from 'zod';

import { ADAPTER_CONTRACT_VERSION, type AdapterManifest, type CredentialInput } from '../contracts/types.js';

const credentialKeys = [
  'email',
  'password',
  'access_token',
  'refresh_token',
  'api_key',
  'auto_reauthenticate',
  'turnstile_token',
  'temp_token',
  'totp_code',
] as const;

const persistableKeys = new Set([
  'email',
  'password',
  'access_token',
  'refresh_token',
  'api_key',
  'auto_reauthenticate',
]);

const credentialValueSchema = z.union([z.string(), z.boolean()]);

export const sub2ApiCredentialSchema: z.ZodType<CredentialInput> = z
  .object({
    mode: z.enum(['password', 'token']),
    values: z.record(z.enum(credentialKeys), credentialValueSchema.optional()),
    persistKeys: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.mode === 'password') {
      if (typeof input.values.email !== 'string' || input.values.email.trim() === '') {
        context.addIssue({ code: 'custom', path: ['values', 'email'], message: '必须填写登录邮箱' });
      }
      if (typeof input.values.password !== 'string' || input.values.password === '') {
        context.addIssue({ code: 'custom', path: ['values', 'password'], message: '必须填写登录密码' });
      }
    } else if (
      typeof input.values.access_token !== 'string' ||
      input.values.access_token.trim() === ''
    ) {
      context.addIssue({
        code: 'custom',
        path: ['values', 'access_token'],
        message: '必须填写 Access Token',
      });
    }

    for (const key of input.persistKeys ?? []) {
      if (!persistableKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['persistKeys'],
          message: `凭据 ${key} 只能临时使用，不能保存`,
        });
      }
    }
  });

const manifest: AdapterManifest = {
  contractVersion: ADAPTER_CONTRACT_VERSION,
  adapterType: 'sub2api',
  adapterVersion: '1.0.0',
  adapterSchemaVersion: 1,
  displayName: 'Sub2API',
  monitorTypes: ['connectivity', 'rates', 'balance', 'auth'],
  credentialFields: [
    {
      key: 'email',
      input: 'email',
      secret: false,
      requiredWhen: ['password'],
      persistable: true,
    },
    {
      key: 'password',
      input: 'password',
      secret: true,
      requiredWhen: ['password'],
      persistable: true,
    },
    {
      key: 'access_token',
      input: 'password',
      secret: true,
      requiredWhen: ['token'],
      persistable: true,
    },
    { key: 'refresh_token', input: 'password', secret: true, persistable: true },
    { key: 'api_key', input: 'password', secret: true, persistable: true },
    { key: 'auto_reauthenticate', input: 'toggle', secret: false, persistable: true },
  ],
  sensitiveFields: [
    'password',
    'access_token',
    'refresh_token',
    'api_key',
    'turnstile_token',
    'temp_token',
    'totp_code',
  ],
  capabilities: {
    authRefresh: true,
    balances: true,
    rates: true,
    channels: true,
    activeProbe: true,
  },
};

Object.freeze(manifest);

export function sub2ApiManifest(): AdapterManifest {
  return manifest;
}
