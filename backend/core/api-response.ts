import type { FastifyRequest } from 'fastify';

import type { ApiError, ApiSuccess } from '../../shared/types.js';

export function success<T>(request: FastifyRequest, data: T): ApiSuccess<T> {
  return {
    data,
    request_id: request.id,
  };
}

export function failure(
  request: FastifyRequest,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ApiError {
  return {
    error: { code, message, details },
    request_id: request.id,
  };
}
