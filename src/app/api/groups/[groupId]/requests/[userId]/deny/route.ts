import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '../../../../../../../lib/supabaseAdmin'
import { requireUser } from '../../../../../_auth'

export async function POST(
  request: Request,
  ctx: { params: Promise<{ groupId: string; userId: string }> }
) {
  const user = await requireUser(request)
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'Email not verified' }, { status: 403 })
  }

  const { groupId, userId } = await ctx.params
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

  const { error } = await supabase
    .from('group_memberships')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('status', 'pending')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}


