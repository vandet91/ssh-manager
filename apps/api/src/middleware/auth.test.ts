import { describe, it, expect, vi } from 'vitest'
import { requirePermission } from './auth'

function makeReqReply(role: string, mfaPending = false) {
  const req = { session: { user: { id: '1', email: 'u@e.com', role, mfaEnabled: false, mfaPending } } } as Parameters<ReturnType<typeof requirePermission>>[0]
  const codes: number[] = []
  const bodies: unknown[] = []
  const reply = { code: (c: number) => { codes.push(c); return reply }, send: (b: unknown) => { bodies.push(b); return reply } } as unknown as Parameters<ReturnType<typeof requirePermission>>[1]
  return { req, reply, codes, bodies }
}

describe('requirePermission', () => {
  it('allows admin on any permission', async () => {
    const { req, reply, codes } = makeReqReply('admin')
    await requirePermission('servers:write')(req, reply)
    expect(codes).toHaveLength(0)
  })

  it('allows operator on servers:write', async () => {
    const { req, reply, codes } = makeReqReply('operator')
    await requirePermission('servers:write')(req, reply)
    expect(codes).toHaveLength(0)
  })

  it('blocks viewer on servers:write', async () => {
    const { req, reply, codes } = makeReqReply('viewer')
    await requirePermission('servers:write')(req, reply)
    expect(codes).toContain(403)
  })

  it('blocks developer on keys:write', async () => {
    const { req, reply, codes } = makeReqReply('developer')
    await requirePermission('keys:write')(req, reply)
    expect(codes).toContain(403)
  })

  it('allows developer on servers:read', async () => {
    const { req, reply, codes } = makeReqReply('developer')
    await requirePermission('servers:read')(req, reply)
    expect(codes).toHaveLength(0)
  })

  it('blocks when MFA pending', async () => {
    const { req, reply, codes } = makeReqReply('admin', true)
    await requirePermission('servers:read')(req, reply)
    expect(codes).toContain(403)
  })

  it('returns 401 for unauthenticated user', async () => {
    const req = { session: {} } as Parameters<ReturnType<typeof requirePermission>>[0]
    const codes: number[] = []
    const reply = { code: (c: number) => { codes.push(c); return reply }, send: () => reply } as unknown as Parameters<ReturnType<typeof requirePermission>>[1]
    await requirePermission('servers:read')(req, reply)
    expect(codes).toContain(401)
  })
})
