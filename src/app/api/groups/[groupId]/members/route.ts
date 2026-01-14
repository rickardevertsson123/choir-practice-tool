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

  const { data, error } = await supabase
    .from('group_memberships')
    .select('user_id,role,status,created_at,profiles:profiles(email,display_name)')
    .eq('group_id', groupId)
    .in('status', ['active', 'pending'])
    .order('status', { ascending: false })
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const members = (data ?? []).map((r: any) => ({
    userId: r.user_id as string,
    role: r.role as string,
    status: r.status as string,
    createdAt: r.created_at as string,
    email: r.profiles?.email ?? null,
    displayName: r.profiles?.display_name ?? null,
  }))

  return NextResponse.json({ members })
}


