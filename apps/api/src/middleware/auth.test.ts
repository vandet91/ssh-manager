import { describe, it, expect } from 'vitest'
import { requireAuth } from './auth'

function makeReqReply(user?: object) {
  const req = { session: { user } } as Parameters<typeof requireAuth>[0]
  const codes: number[] = []
  const bodies: unknown[] = []
  const reply = { code: (c: number) => { codes.push(c); return reply }, send: (b: unknown) => { bodies.push(b); return reply } } as unknown as Parameters<typeof requireAuth>[1]
  return { req, reply, codes, bodies }
}

describe('requireAuth', () => {
  it('allows authenticated user', async () => {
    const { req, reply, codes } = makeReqReply({ id: '1', email: 'u@e.com', mfaEnabled: false, mfaPending: false })
    await requireAuth(req, reply)
    expect(codes).toHaveLength(0)
  })

  it('returns 401 for unauthenticated user', async () => {
    const { req, reply, codes } = makeReqReply(undefined)
    await requireAuth(req, reply)
    expect(codes).toContain(401)
  })

  it('returns 403 when MFA pending', async () => {
    const { req, reply, codes } = makeReqReply({ id: '1', email: 'u@e.com', mfaEnabled: false, mfaPending: true })
    await requireAuth(req, reply)
    expect(codes).toContain(403)
  })
})
