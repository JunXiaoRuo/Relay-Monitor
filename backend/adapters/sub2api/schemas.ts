import { isLosslessNumber } from 'lossless-json';
import { z } from 'zod';

import { normalizeDecimal } from '../../core/decimal.js';

function scalarText(value: unknown): unknown {
  if (isLosslessNumber(value)) return value.toString();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return value;
}

function canonicalDecimal(value: string): string {
  return normalizeDecimal(value);
}

export const decimalTextSchema = z.preprocess(
  scalarText,
  z
    .string()
    .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/)
    .transform(canonicalDecimal),
);

export const optionalDecimalTextSchema = z.preprocess(
  (value) => (value === null || value === undefined ? value : scalarText(value)),
  decimalTextSchema.nullish(),
);

export const integerTextSchema = z.preprocess(
  scalarText,
  z.string().regex(/^-?(?:0|[1-9]\d*)$/),
);

const integerNumberSchema = z.preprocess(
  scalarText,
  z
    .string()
    .regex(/^\d+$/)
    .transform((value, context) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) {
        context.addIssue({ code: 'custom', message: 'Integer exceeds the safe range' });
        return z.NEVER;
      }
      return number;
    }),
);

const flexibleBooleanSchema = z.preprocess((value) => {
  const scalar = scalarText(value);
  if (scalar === '1') return true;
  if (scalar === '0') return false;
  return scalar;
}, z.boolean());

const userSummarySchema = z
  .object({
    id: integerTextSchema.optional(),
    email: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

export const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: integerNumberSchema.optional(),
    token_type: z.string().min(1).default('Bearer'),
    user: userSummarySchema.optional(),
  })
  .passthrough();

export const twoFactorResponseSchema = z
  .object({
    requires_2fa: z.literal(true),
    temp_token: z.string().min(1),
    user_email_masked: z.string().optional(),
  })
  .passthrough();

export const loginResponseSchema = z.union([tokenResponseSchema, twoFactorResponseSchema]);

export const publicSettingsSchema = z
  .object({
    geetest_enabled: flexibleBooleanSchema.optional().default(false),
    turnstile_enabled: flexibleBooleanSchema.optional().default(false),
  })
  .passthrough();

export const userProfileSchema = z
  .object({
    id: integerTextSchema.optional(),
    email: z.string().optional(),
    username: z.string().optional(),
    status: z.string().optional(),
    balance: decimalTextSchema,
    frozen_balance: optionalDecimalTextSchema,
    total_recharged: optionalDecimalTextSchema,
  })
  .passthrough();

export const groupSchema = z
  .object({
    id: integerTextSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    platform: z.string().min(1),
    rate_multiplier: decimalTextSchema,
    status: z.string().optional(),
    is_exclusive: flexibleBooleanSchema.optional(),
    subscription_type: z.string().optional(),
    peak_rate_enabled: flexibleBooleanSchema.optional(),
    peak_start: z.string().optional(),
    peak_end: z.string().optional(),
    peak_rate_multiplier: optionalDecimalTextSchema,
  })
  .passthrough();

export const groupsSchema = z.array(groupSchema);

const userRateEntrySchema = z
  .object({
    group_id: integerTextSchema,
    rate_multiplier: decimalTextSchema,
  })
  .passthrough();

export const userGroupRatesSchema = z
  .union([z.record(z.string(), decimalTextSchema), z.array(userRateEntrySchema)])
  .transform((value): Record<string, string> => {
    if (!Array.isArray(value)) return value;
    return Object.fromEntries(value.map((entry) => [entry.group_id, entry.rate_multiplier]));
  });

const channelGroupSchema = z
  .object({
    id: integerTextSchema,
    name: z.string(),
    platform: z.string(),
  })
  .passthrough();

const channelSectionSchema = z
  .object({
    platform: z.string(),
    groups: z.array(channelGroupSchema).default([]),
    supported_models: z.array(z.unknown()).default([]),
  })
  .passthrough();

export const channelsSchema = z.array(
  z
    .object({
      name: z.string(),
      description: z.string().optional(),
      platforms: z.array(channelSectionSchema).default([]),
    })
    .passthrough(),
);

const modelSchema = z.union([
  z.string().min(1).transform((id) => ({ id })),
  z
    .object({
      id: z.string().min(1),
    })
    .passthrough(),
]);

export const modelsResponseSchema = z
  .union([
    z.object({ data: z.array(modelSchema) }).passthrough(),
    z.object({ models: z.array(modelSchema) }).passthrough(),
    z.array(modelSchema).transform((data) => ({ data })),
  ])
  .transform((value): Array<{ id: string }> => {
    if ('data' in value && Array.isArray(value.data)) {
      return value.data as Array<{ id: string }>;
    }
    return (value as { models: Array<{ id: string }> }).models;
  });

export const apiKeySchema = z
  .object({
    id: integerTextSchema,
    key: z.string().min(1).max(512),
    name: z.string().min(1).max(200),
    group_id: z.preprocess(
      (value) => value === null || value === undefined ? value : scalarText(value),
      integerTextSchema.nullish(),
    ),
    status: z.string().min(1).max(80),
    expires_at: z.string().nullable().optional(),
    quota: optionalDecimalTextSchema,
    quota_used: optionalDecimalTextSchema,
    group: z.object({ id: integerTextSchema, name: z.string().min(1) }).passthrough().nullable().optional(),
  })
  .passthrough();

export const apiKeyListSchema = z.object({
  items: z.array(apiKeySchema),
  total: integerNumberSchema.optional(),
  page: integerNumberSchema.optional(),
  page_size: integerNumberSchema.optional(),
  pages: integerNumberSchema.optional(),
}).passthrough();

export const upstreamEnvelopeSchema = z
  .object({
    code: z.preprocess(scalarText, z.union([z.literal('0'), z.literal(0)])).optional(),
    data: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

export const upstreamErrorSchema = z
  .object({
    code: z.preprocess(scalarText, z.union([z.string(), z.number()])).optional(),
    reason: z.string().optional(),
    message: z.string().optional(),
    error: z.union([z.string(), z.object({ message: z.string().optional() }).passthrough()]).optional(),
  })
  .passthrough();

export type TokenResponse = z.output<typeof tokenResponseSchema>;
export type GroupResponse = z.output<typeof groupSchema>;
export type ApiKeyResponse = z.output<typeof apiKeySchema>;
export type UserProfileResponse = z.output<typeof userProfileSchema>;
