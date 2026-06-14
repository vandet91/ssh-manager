import { FastifyRequest } from 'fastify'
import { db } from '../db/client'

export interface AuditParams {
  userId?: string
  userEmail?: string
  action: string
  resource?: string
  resourceId?: string
  serverId?: string
  details?: Record<string, unknown>
  request?: FastifyRequest
}

export async function writeAuditLog(params: AuditParams): Promise<void> {
  await db.insertInto('audit_logs').values({
    user_id: params.userId ?? null,
    user_email: params.userEmail ?? null,
    action: params.action,
    resource: params.resource ?? null,
    resource_id: params.resourceId ?? null,
    server_id: params.serverId ?? null,
    details: params.details ? JSON.stringify(params.details) : '{}',
    ip_address: params.request?.ip ?? null,
    user_agent: params.request?.headers?.['user-agent'] ?? null,
  }).execute()
}
