import { z } from 'zod';

import {
  API_MAX_PAGE_SIZE,
  API_PAGE_SIZE,
  AUTH_STATUSES,
  BALANCE_KINDS,
  MONITOR_TYPES,
  RATE_KINDS,
  SERVICE_STATUSES,
  SNAPSHOT_QUALITIES,
} from './constants.js';

export const decimalStringSchema = z
  .string()
  .trim()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/, 'Invalid decimal string');

export const monitorTypeSchema = z.enum(MONITOR_TYPES);
export const serviceStatusSchema = z.enum(SERVICE_STATUSES);
export const authStatusSchema = z.enum(AUTH_STATUSES);
export const rateKindSchema = z.enum(RATE_KINDS);
export const balanceKindSchema = z.enum(BALANCE_KINDS);
export const snapshotQualitySchema = z.enum(SNAPSHOT_QUALITIES);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(API_MAX_PAGE_SIZE).default(API_PAGE_SIZE),
});

export const monitorConfigInputSchema = z.object({
  enabled: z.boolean(),
  interval_seconds: z.number().int().min(10).max(86_400),
  timeout_seconds: z.number().int().min(1).max(120),
  retry_count: z.number().int().min(0).max(10).default(1),
  retry_interval_seconds: z.number().int().min(0).max(3_600).default(60),
  schedule_jitter_percent: z.number().int().min(0).max(50),
});

export const createSiteInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  adapter_type: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  base_url: z.string().url().max(2_048),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  notes: z.string().max(4_000).optional(),
  tls_verify: z.boolean().default(true),
});
