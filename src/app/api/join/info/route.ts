import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '../../../../lib/supabaseAdmin'

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

export async function GET(request: Request) {
  const u = new URL(request.url)
  const token = u.searchParams.get('token') || ''
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

  const { data: g, error: eg } = await supabase
    .from('groups')
    .select('id,name,cover_image_path,description_md,disabled_at,disabled_reason')
    .eq('id', invite.group_id)
    .maybeSingle()
  if (eg) return NextResponse.json({ error: eg.message }, { status: 500 })
  if (!g) return NextResponse.json({ error: 'Group not found' }, { status: 404 })

  let coverUrl: string | null = null
  if (g.cover_image_path) {
    const { data, error } = await supabase.storage.from('group-covers').createSignedUrl(g.cover_image_path, 60 * 30)
    if (!error) coverUrl = data?.signedUrl ?? null
  }

  return NextResponse.json({
    group: {
      id: g.id,
      name: g.name,
      description_md: g.description_md ?? null,
      disabled_at: g.disabled_at ?? null,
      disabled_reason: g.disabled_reason ?? null,
      coverUrl,
    },
  })
}


