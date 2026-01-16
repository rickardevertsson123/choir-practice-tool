import { NextResponse } from 'next/server'
import { requireUser } from '../../../_auth'
import { getSupabaseAdmin } from '../../../../../lib/supabaseAdmin'

export async function POST(
  request: Request,
  ctx: { params: Promise<{ groupId: string }> }
) {
  const user = await requireUser(request)
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'Email not verified' }, { status: 403 })
  }

  const { groupId } = await ctx.params
  const supabase = getSupabaseAdmin()

  // Soft-remove membership so it disappears from /groups (we only show active/pending).
  const { error } = await supabase
    .from('group_memberships')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('group_id', groupId)
    .eq('user_id', user.id)
    .in('status', ['active', 'pending'])

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}


