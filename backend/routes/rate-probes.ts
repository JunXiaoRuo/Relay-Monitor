import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  API_MAX_PAGE_SIZE,
  MAX_RATE_PROBE_INTERVAL_SECONDS,
  MAX_RATE_PROBE_TIMEOUT_SECONDS,
  MIN_RATE_PROBE_INTERVAL_SECONDS,
  MIN_RATE_PROBE_TIMEOUT_SECONDS,
} from '../../shared/constants.js';
import type { AppContext } from '../context.js';
import { success } from '../core/api-response.js';
import { recordAudit } from '../core/audit.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
} from '../core/idempotency.js';
import {
  getRateProbeConfig,
  listRateProbeModels,
  listRateProbeRuns,
  runRateProbe,
  updateRateProbeConfig,
} from '../services/rate-probe.js';

const paramsSchema = z.object({ id: z.string().min(1).max(80) });
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(API_MAX_PAGE_SIZE).default(20),
});

export async function registerRateProbeRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get('/api/v1/rates/:id/probe-config', {
    schema: {
      tags: ['monitoring'],
      summary: '读取倍率模型实测配置',
      params: paramsSchema,
    },
  }, async (request) => success(request, getRateProbeConfig(context, request.params.id)));

  typed.put('/api/v1/rates/:id/probe-config', {
    schema: {
      tags: ['monitoring'],
      summary: '保存倍率模型实测配置',
      params: paramsSchema,
      body: z.object({
        model_mode: z.enum(['auto', 'manual']),
        model: z.string().trim().min(1).max(200).nullable().optional(),
        key_mode: z.enum(['bound', 'existing', 'auto_create', 'manual']).optional(),
        upstream_key_id: z.string().trim().regex(/^\d+$/).max(40).nullable().optional(),
        use_site_api_key: z.boolean().optional(),
        custom_api_key: z.string().trim().min(1).max(16_384).nullable().optional(),
        max_output_tokens: z.number().int().min(16).max(256),
        auto_probe_enabled: z.boolean().optional(),
        probe_interval_seconds: z.number().int()
          .min(MIN_RATE_PROBE_INTERVAL_SECONDS)
          .max(MAX_RATE_PROBE_INTERVAL_SECONDS)
          .refine((value) => value % 60 === 0, '自动实测间隔必须按整分钟填写')
          .optional(),
        timeout_seconds: z.number().int()
          .min(MIN_RATE_PROBE_TIMEOUT_SECONDS)
          .max(MAX_RATE_PROBE_TIMEOUT_SECONDS)
          .optional(),
        retry_count: z.number().int().min(0).max(10).optional(),
        retry_interval_seconds: z.number().int().min(0).max(3_600).optional(),
        auto_create: z.object({
          quota_limit: z.number().positive().max(10).optional(),
          expires_in_seconds: z.number().int().min(86_400).max(30 * 86_400).optional(),
        }).optional(),
      }),
    },
  }, async (request, reply) => {
    const idempotency = claimIdempotencyKey(context.database, {
      scope: `${request.relayAdmin?.id ?? 'anonymous'}:PUT:/api/v1/rates/${request.params.id}/probe-config`,
      key: request.headers['idempotency-key'],
      request: { rate_id: request.params.id, ...request.body },
    });
    if (idempotency.kind === 'replay') {
      reply.code(idempotency.responseStatus);
      return idempotency.responseBody;
    }
    try {
    const result = await updateRateProbeConfig(context, request.params.id, {
      modelMode: request.body.model_mode,
      ...(request.body.model === undefined ? {} : { model: request.body.model }),
      ...(request.body.key_mode === undefined ? {} : { keyMode: request.body.key_mode }),
      ...(request.body.upstream_key_id === undefined ? {} : { upstreamKeyId: request.body.upstream_key_id }),
      ...(request.body.use_site_api_key === undefined ? {} : { useSiteApiKey: request.body.use_site_api_key }),
      ...(request.body.custom_api_key === undefined ? {} : { customApiKey: request.body.custom_api_key }),
      maxOutputTokens: request.body.max_output_tokens,
      ...(request.body.auto_probe_enabled === undefined ? {} : { enabled: request.body.auto_probe_enabled }),
      ...(request.body.probe_interval_seconds === undefined
        ? {}
        : { intervalSeconds: request.body.probe_interval_seconds }),
      ...(request.body.timeout_seconds === undefined
        ? {}
        : { timeoutSeconds: request.body.timeout_seconds }),
      ...(request.body.retry_count === undefined ? {} : { retryCount: request.body.retry_count }),
      ...(request.body.retry_interval_seconds === undefined
        ? {}
        : { retryIntervalSeconds: request.body.retry_interval_seconds }),
      ...(request.body.auto_create === undefined ? {} : {
        autoCreate: {
          ...(request.body.auto_create.quota_limit === undefined
            ? {}
            : { quotaLimit: request.body.auto_create.quota_limit }),
          ...(request.body.auto_create.expires_in_seconds === undefined
            ? {}
            : { expiresInSeconds: request.body.auto_create.expires_in_seconds }),
        },
      }),
      ...(typeof request.headers['idempotency-key'] === 'string'
        ? { idempotencyKey: request.headers['idempotency-key'] }
        : {}),
    });
    recordAudit(context.database, request, {
      action: 'rate_probe.config_update',
      resourceType: 'rate',
      resourceId: request.params.id,
      metadata: {
        model_mode: result.model_mode,
        key_mode: result.key_mode,
        use_site_api_key: result.use_site_api_key,
        custom_api_key_present: result.custom_api_key_present,
        max_output_tokens: result.max_output_tokens,
        auto_probe_enabled: result.auto_probe_enabled,
        probe_interval_seconds: result.probe_interval_seconds,
        timeout_seconds: result.timeout_seconds,
        retry_count: result.retry_count,
        retry_interval_seconds: result.retry_interval_seconds,
      },
    });
    const response = success(request, result);
    completeIdempotencyKey(context.database, idempotency, {
      responseStatus: 200,
      responseBody: response,
      resourceId: request.params.id,
    });
    return response;
    } catch (error) {
      failIdempotencyKey(context.database, idempotency);
      throw error;
    }
  });

  typed.post('/api/v1/rates/:id/probe-models', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    schema: {
      tags: ['monitoring'],
      summary: '使用当前测试 Key 获取可用模型',
      params: paramsSchema,
    },
  }, async (request) => {
    const result = await listRateProbeModels(context, request.params.id);
    recordAudit(context.database, request, {
      action: 'rate_probe.models_list',
      resourceType: 'rate',
      resourceId: request.params.id,
      metadata: { model_count: result.items.length },
    });
    return success(request, result);
  });

  typed.post('/api/v1/rates/:id/probe', {
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    schema: {
      tags: ['monitoring'],
      summary: '执行一次最小流式模型实测',
      params: paramsSchema,
      body: z.object({
        model: z.string().trim().min(1).max(200).optional(),
      }).default({}),
    },
  }, async (request, reply) => {
    const idempotency = claimIdempotencyKey(context.database, {
      scope: `${request.relayAdmin?.id ?? 'anonymous'}:POST:/api/v1/rates/${request.params.id}/probe`,
      key: request.headers['idempotency-key'],
      request: { rate_id: request.params.id, ...request.body },
    });
    if (idempotency.kind === 'replay') {
      reply.code(idempotency.responseStatus);
      return idempotency.responseBody;
    }
    try {
      const run = await runRateProbe(context, request.params.id, request.body.model);
      const response = success(request, run);
      recordAudit(context.database, request, {
        action: 'rate_probe.run',
        resourceType: 'rate',
        resourceId: request.params.id,
        metadata: {
          run_id: run.id,
          status: run.status,
          requested_model: run.requested_model,
          returned_model: run.returned_model,
        },
      });
      completeIdempotencyKey(context.database, idempotency, {
        responseStatus: 200,
        responseBody: response,
        resourceId: run.id,
      });
      return response;
    } catch (error) {
      failIdempotencyKey(context.database, idempotency);
      throw error;
    }
  });

  typed.get('/api/v1/rates/:id/probes', {
    schema: {
      tags: ['monitoring'],
      summary: '查询倍率模型实测历史',
      params: paramsSchema,
      querystring: pageSchema,
    },
  }, async (request) => success(request, listRateProbeRuns(
    context,
    request.params.id,
    request.query.page,
    request.query.page_size,
  )));
}
