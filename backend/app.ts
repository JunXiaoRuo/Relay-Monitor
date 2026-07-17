import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';

import { AdapterError, adapterErrorPublicMessage } from './adapters/index.js';
import { createAppContext, type AppContext } from './context.js';
import { failure } from './core/api-response.js';
import { AppError } from './core/errors.js';
import { createId } from './core/ids.js';
import { UnsafeUrlError } from './core/ssrf.js';
import { registerAdapterRoutes } from './routes/adapters.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMonitorDataRoutes } from './routes/monitor-data.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerOperationRoutes } from './routes/operations.js';
import { registerRateProbeRoutes } from './routes/rate-probes.js';
import { registerSiteRoutes } from './routes/sites.js';
import { registerSettingsRoutes } from './routes/settings.js';
import {
  authenticateAdminRequest,
  registerSessionRoutes,
} from './routes/session.js';
import { createSchedulerRuntime } from './services/scheduler-runtime.js';
import { createOutboxWorker } from './services/outbox-worker.js';

export interface BuildAppOptions {
  context?: AppContext;
  closeContext?: boolean;
  startScheduler?: boolean;
  startOutboxWorker?: boolean;
  requestRestart?: () => void;
}

const PUBLIC_PATHS = new Set(['/healthz', '/readyz', '/api/v1/session/login']);

function isProtectedPath(url: string): boolean {
  const pathname = url.split('?', 1)[0] ?? url;
  return pathname === '/openapi.json' || (pathname.startsWith('/api/v1/') && !PUBLIC_PATHS.has(pathname));
}

function configureErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send(failure(request, 'VALIDATION_ERROR', '请求参数无效', {
        issues: error.validation.map((issue) => ({
          path: issue.instancePath,
          message: issue.message,
        })),
      }));
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(failure(request, error.code, error.message, error.details));
    }
    if (error instanceof ZodError) {
      return reply.code(400).send(failure(request, 'VALIDATION_ERROR', '请求参数无效', {
        issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      }));
    }
    if (error instanceof UnsafeUrlError) {
      return reply.code(422).send(failure(request, error.code, error.message));
    }
    if (error instanceof AdapterError) {
      const statusCode = error.code === 'UPSTREAM_RATE_LIMITED'
        ? 429
        : error.code === 'UPSTREAM_UNREACHABLE'
          ? 503
          : error.code === 'UPSTREAM_SERVER_ERROR'
            ? 502
            : error.code === 'UPSTREAM_SCHEMA_ERROR'
              ? 422
              : error.code === 'ADAPTER_UNAVAILABLE'
                ? 400
                : 409;
      return reply.code(statusCode).send(failure(request, error.code, adapterErrorPublicMessage(error), {
        ...error.details,
        ...(error.retryAfterMs === undefined ? {} : { retry_after_ms: error.retryAfterMs }),
      }));
    }
    const codedError = error && typeof error === 'object'
      ? error as { code?: unknown; message?: unknown }
      : undefined;
    if (
      typeof codedError?.code === 'string' &&
      codedError.code.startsWith('AUTH_') &&
      typeof codedError.message === 'string'
    ) {
      return reply.code(400).send(failure(request, codedError.code, codedError.message));
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return reply.code(500).send(failure(request, 'INTERNAL_ERROR', '服务器处理请求时发生错误'));
  });
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const context = options.context ?? createAppContext();
  const closeContext = options.closeContext ?? options.context === undefined;
  const app = Fastify({
    trustProxy: context.config.trustProxy,
    ...(context.serverAccess.httpsOptions ? { https: context.serverAccess.httpsOptions } : {}),
    genReqId: () => createId('req'),
    logger: {
      level: context.config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers.set-cookie',
          '*.password',
          '*.access_token',
          '*.refresh_token',
          '*.api_key',
          '*.secret',
          '*.certificate_pem',
          '*.private_key_pem',
        ],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 1024 * 1024,
  });
  const schedulerRuntime = createSchedulerRuntime(context, (error, job) => {
    app.log.error({ err: error, job_id: job?.id, site_id: job?.siteId }, 'Scheduler task failed');
  });
  const outboxWorker = createOutboxWorker(context, (error, message) => {
    app.log.error({ err: error, outbox_id: message?.id, event_id: message?.eventId }, 'Outbox worker failed');
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('relayAdmin', null);
  app.decorateRequest('relaySession', null);

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(helmet, {
    // Built-in TLS is reversible from the admin UI. A persisted HSTS policy
    // would make the browser keep upgrading requests after switching to HTTP.
    hsts: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // Production can intentionally serve HTTP on a trusted LAN. Helmet's
        // default directive would upgrade the page assets to HTTPS and break it.
        upgradeInsecureRequests: null,
      },
    },
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Relay Monitor API',
        version: '1.0.0',
        description: 'Adapter-neutral relay monitoring administration API',
      },
    },
    transform: jsonSchemaTransform,
  });
  configureErrorHandler(app);

  app.addHook('onRequest', async (request) => {
    if (isProtectedPath(request.url)) {
      authenticateAdminRequest(request, {
        config: context.config,
        database: context.database,
        secureCookies: context.serverAccess.secureCookies,
      });
    }
  });

  await registerHealthRoutes(app, context);
  await registerSessionRoutes(app, {
    config: context.config,
    database: context.database,
    secureCookies: context.serverAccess.secureCookies,
  });
  await registerAdapterRoutes(app, context.adapters);
  await registerSiteRoutes(app, context);
  await registerMonitorDataRoutes(app, context);
  await registerRateProbeRoutes(app, context);
  await registerNotificationRoutes(app, context);
  await registerSettingsRoutes(
    app,
    context,
    options.requestRestart ? { requestRestart: options.requestRestart } : {},
  );
  await registerOperationRoutes(app, context);

  app.get('/openapi.json', async () => app.swagger());

  const webRoot = resolve(process.cwd(), 'dist/web');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      index: false,
    });
  }

  app.get('/', async (_request, reply) => {
    if (existsSync(resolve(webRoot, 'index.html'))) return reply.sendFile('index.html');
    return {
      name: 'Relay Monitor',
      status: 'api_ready',
      web: context.config.webOrigin,
    };
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      existsSync(resolve(webRoot, 'index.html'))
    ) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send(failure(request, 'NOT_FOUND', '请求的资源不存在'));
  });

  const shouldStartScheduler = options.startScheduler ?? context.config.nodeEnv !== 'test';
  const shouldStartOutboxWorker = options.startOutboxWorker ?? shouldStartScheduler;
  if (shouldStartScheduler || shouldStartOutboxWorker) {
    app.addHook('onReady', async () => {
      if (shouldStartScheduler) await schedulerRuntime.start();
      if (shouldStartOutboxWorker) await outboxWorker.start();
    });
  }
  app.addHook('onClose', async () => {
    await schedulerRuntime.stop();
    await outboxWorker.stop();
    if (closeContext) await context.close();
  });
  return app;
}
