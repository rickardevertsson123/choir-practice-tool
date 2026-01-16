import { NextResponse } from 'next/server'
import { requireUser } from '../../_auth'
import { getSupabaseAdmin } from '../../../../lib/supabaseAdmin'

export async function POST(request: Request) {
  const user = await requireUser(request)
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'Email not verified' }, { status: 403 })
  }

  const supabase = getSupabaseAdmin()

  // Delete groups created by this user (FK groups.created_by -> profiles would block user deletion otherwise).
  const { error: eg } = await supabase.from('groups').delete().eq('created_by', user.id)
  if (eg) return NextResponse.json({ error: eg.message }, { status: 500 })

  // Remove memberships (not strictly needed if groups delete cascades, but covers groups owned by others).
  const { error: em } = await supabase.from('group_memberships').delete().eq('user_id', user.id)
  if (em) return NextResponse.json({ error: em.message }, { status: 500 })

  // Delete auth user (cascades profiles row).
  const { error: eu } = await supabase.auth.admin.deleteUser(user.id)
  if (eu) return NextResponse.json({ error: eu.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}


