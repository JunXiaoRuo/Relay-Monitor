import type { FastifyRequest } from 'fastify';

import type { DatabaseConnection } from '../db/index.js';
import { auditLogs } from '../db/index.js';
import { createId } from './ids.js';

export interface AuditInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  adminId?: string | null;
  metadata?: Record<string, unknown>;
}

function compactUserAgent(value: string | undefined): string | null {
  return value ? value.slice(0, 500) : null;
}

export function recordAudit(
  connection: DatabaseConnection,
  request: FastifyRequest,
  input: AuditInput,
): void {
  connection.db.insert(auditLogs).values({
    id: createId('audit'),
    adminId: input.adminId ?? request.relayAdmin?.id ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    requestId: request.id,
    ipAddress: request.ip,
    userAgent: compactUserAgent(request.headers['user-agent']),
    metadataJson: JSON.stringify(input.metadata ?? {}),
  }).run();
}
