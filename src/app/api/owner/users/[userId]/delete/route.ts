import { NextResponse } from 'next/server'
import { admin, requireOwner } from '../../../_auth'

export async function POST(
  request: Request,
  ctx: { params: Promise<{ userId: string }> }
) {
  await requireOwner(request)
  const supabase = admin()
  const { userId } = await ctx.params

  // Delete groups created by this user (FK groups.created_by -> profiles would block user deletion otherwise).
  const { error: eg } = await supabase.from('groups').delete().eq('created_by', userId)
  if (eg) return NextResponse.json({ error: eg.message }, { status: 500 })

  // Remove memberships (covers groups owned by others).
  const { error: em } = await supabase.from('group_memberships').delete().eq('user_id', userId)
  if (em) return NextResponse.json({ error: em.message }, { status: 500 })

  const { error: eu } = await supabase.auth.admin.deleteUser(userId)
  if (eu) return NextResponse.json({ error: eu.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}


