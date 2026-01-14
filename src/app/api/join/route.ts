import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '../../../lib/supabaseAdmin'
import { requireUser } from '../_auth'
import { sendEmail } from '../../../lib/email'

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

export async function POST(request: Request) {
  const user = await requireUser(request)
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'Email not verified' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const token = typeof body?.token === 'string' ? body.token : ''
  if (!token || token.length < 16) return NextResponse.json({ error: 'Invalid token' }, { status: 400 })

  const supabase = getSupabaseAdmin()

  const tokenHash = await sha256Hex(token)
  const nowIso = new Date().toISOString()

  const { data: invite, error: ei } = await supabase
    .from('group_invites')
    .select('group_id,expires_at,revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (ei) return NextResponse.json({ error: ei.message }, { status: 500 })
  if (!invite) return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
  if (invite.revoked_at) return NextResponse.json({ error: 'Invite revoked' }, { status: 410 })
  if (invite.expires_at < nowIso) return NextResponse.json({ error: 'Invite expired' }, { status: 410 })

  // IMPORTANT: never overwrite an existing role (e.g. admin) via join link.
  const { data: existing, error: exErr } = await supabase
    .from('group_memberships')
    .select('role,status')
    .eq('group_id', invite.group_id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 })

  if (existing?.status === 'active') {
    // Already a member (or admin). Do nothing.
    return NextResponse.json({ ok: true, groupId: invite.group_id, alreadyActive: true })
  }

  if (existing) {
    // Re-request access (keep role, just move to pending).
    const { error: uErr } = await supabase
      .from('group_memberships')
      .update({ status: 'pending', updated_at: nowIso })
      .eq('group_id', invite.group_id)
      .eq('user_id', user.id)
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })
  } else {
    // New request.
    const { error: iErr } = await supabase.from('group_memberships').insert({
      group_id: invite.group_id,
      user_id: user.id,
      role: 'member',
      status: 'pending',
      updated_at: nowIso,
    })
    if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 })
  }

  // Notify admins (optional via RESEND_API_KEY + EMAIL_FROM)
  const { data: g, error: eg } = await supabase
    .from('groups')
    .select('name')
    .eq('id', invite.group_id)
    .maybeSingle()
  if (eg) return NextResponse.json({ error: eg.message }, { status: 500 })

  const { data: admins, error: ea } = await supabase
    .from('group_memberships')
    .select('user_id,profiles:profiles(email)')
    .eq('group_id', invite.group_id)
    .eq('role', 'admin')
    .eq('status', 'active')
  if (ea) return NextResponse.json({ error: ea.message }, { status: 500 })

  const adminEmails = (admins ?? [])
    .map((a: any) => a.profiles?.email)
    .filter((e: any) => typeof e === 'string' && e.length > 3) as string[]

  const groupName = g?.name ?? invite.group_id
  const emailRes =
    adminEmails.length > 0
      ? await sendEmail({
          to: adminEmails,
          subject: `New join request: ${groupName}`,
          text: `A user (${user.email ?? user.id}) requested to join "${groupName}".\n\nReview: ${new URL(
            `/g/${invite.group_id}`,
            request.url
          ).toString()}`,
        })
      : { ok: true, skipped: true }

  return NextResponse.json({ ok: true, groupId: invite.group_id, emailed: emailRes.ok && !emailRes.skipped, emailSkipped: emailRes.skipped ?? false })
}


