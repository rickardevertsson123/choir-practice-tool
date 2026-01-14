import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '../../../../../lib/supabaseAdmin'
import { requireUser } from '../../../_auth'

function toHex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Hex(text: string) {
  const enc = new TextEncoder()
  const data = enc.encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toHex(digest)
}

function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ groupId: string }> }
) {
  const user = await requireUser(request)
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'Email not verified' }, { status: 403 })
  }

  const { groupId } = await ctx.params
  const body = await request.json().catch(() => ({}))
  const expiresAt = typeof body?.expiresAt === 'string' ? body.expiresAt : null
  if (!expiresAt) return NextResponse.json({ error: 'Missing expiresAt' }, { status: 400 })

  const supabase = getSupabaseAdmin()

  // Ensure caller is an active admin in this group.
  const { data: m, error: em } = await supabase
    .from('group_memberships')
    .select('role,status')
    .eq('group_id', groupId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (em) return NextResponse.json({ error: em.message }, { status: 500 })
  if (!m || m.status !== 'active' || m.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Rotate: revoke existing invites for this group.
  await supabase
    .from('group_invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('group_id', groupId)
    .is('revoked_at', null)

  const token = randomToken()
  const tokenHash = await sha256Hex(token)

  const { error: ei } = await supabase.from('group_invites').insert({
    group_id: groupId,
    token_hash: tokenHash,
    expires_at: expiresAt,
    created_by: user.id,
  })
  if (ei) return NextResponse.json({ error: ei.message }, { status: 500 })

  const joinUrl = `${new URL(request.url).origin}/join/${token}`
  return NextResponse.json({ joinUrl, expiresAt })
}


