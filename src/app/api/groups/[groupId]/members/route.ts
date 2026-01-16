import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '../../../../../lib/supabaseAdmin'
import { requireUser } from '../../../_auth'

export async function GET(
  request: Request,
  ctx: { params: Promise<{ groupId: string }> }
) {
  const user = await requireUser(request)
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'Email not verified' }, { status: 403 })
  }

  const { groupId } = await ctx.params
  const supabase = getSupabaseAdmin()

  // Ensure caller is an active member in this group (admin gets extra visibility).
  const { data: m, error: em } = await supabase
    .from('group_memberships')
    .select('role,status')
    .eq('group_id', groupId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (em) return NextResponse.json({ error: em.message }, { status: 500 })
  if (!m || m.status !== 'active') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const isAdmin = m.role === 'admin'
  const q = supabase
    .from('group_memberships')
    .select('user_id,role,status,created_at,profiles:profiles(email,display_name,avatar_path)')
    .eq('group_id', groupId)
    .in('status', isAdmin ? ['active', 'pending'] : ['active'])
    .order('status', { ascending: false })
    .order('created_at', { ascending: true })
  const { data, error } = await q

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const members = (data ?? []).map((r: any) => ({
    userId: r.user_id as string,
    role: r.role as string,
    status: r.status as string,
    createdAt: r.created_at as string,
    // Don't leak emails to non-admins.
    email: isAdmin ? (r.profiles?.email ?? null) : null,
    displayName: r.profiles?.display_name ?? null,
    avatarPath: r.profiles?.avatar_path ?? null,
  }))

  return NextResponse.json({ members })
}


