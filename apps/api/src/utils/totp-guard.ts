import { FastifyRequest, FastifyReply } from 'fastify'
import { db } from '../db/client'

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const row = await (db as any).selectFrom('settings').selectAll().where('key', '=', key).executeTakeFirst()
    return row ? (row.value as T) : fallback
  } catch { return fallback }
}

export async function isActionTotpRequired(action: string): Promise<boolean> {
  try {
    const row = await (db as any)
      .selectFrom('totp_action_rules')
      .select('enabled')
      .where('action', '=', action)
      .executeTakeFirst()
    return row?.enabled === true
  } catch { return false }
}

export function isSessionElevated(req: FastifyRequest): boolean {
  const until = req.session.totpElevatedUntil
  return typeof until === 'number' && until > Date.now()
}

// Middleware factory — call as preHandler on any route that needs TOTP gating.
// Returns 403 { require_totp: true, action } when TOTP is required but not satisfied.
// The frontend catches this and shows the TOTP modal, then retries the request.
export function requireTotpElevation(action: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.session.user) { reply.code(401).send({ error: 'Unauthorized' }); return }

    const required = await isActionTotpRequired(action)
    if (!required) return  // TOTP not configured for this action — allow

    if (isSessionElevated(req)) return  // already elevated — allow

    // User's MFA must be enabled to use action-level TOTP
    if (!req.session.user.mfaEnabled) {
      reply.code(403).send({
        error: 'Action requires TOTP but your account has no MFA configured. Enable MFA in your account settings first.',
        require_mfa_setup: true,
        action,
      })
      return
    }

    reply.code(403).send({ require_totp: true, action })
  }
}

// Called by POST /auth/totp/elevate after successful code verification.
export async function elevateSession(req: FastifyRequest): Promise<void> {
  const minutes = await getSetting<number>('totp_elevation_minutes', 15)
  req.session.totpElevatedUntil = Date.now() + minutes * 60 * 1000
}
