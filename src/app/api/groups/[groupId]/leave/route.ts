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

  // Look up caller membership.
  const { data: me, error: meErr } = await supabase
    .from('group_memberships')
    .select('role,status')
    .eq('group_id', groupId)
    .eq('user_id', user.id)
    .in('status', ['active', 'pending'])
    .maybeSingle()
  if (meErr) return NextResponse.json({ error: meErr.message }, { status: 500 })
  if (!me) return NextResponse.json({ error: 'Not a member' }, { status: 404 })

  const nowIso = new Date().toISOString()

  // Prevent groups from ending up without an admin.
  // - If caller is the last active admin and there are other active members: block leaving.
  // - If caller is the last active member (i.e. leaving would make the group empty): delete the group.
  if (me.status === 'active' && me.role === 'admin') {
    const { count: adminCount, error: adminCountErr } = await supabase
      .from('group_memberships')
      .select('user_id', { count: 'exact', head: true })
      .eq('group_id', groupId)
      .eq('status', 'active')
      .eq('role', 'admin')
    if (adminCountErr) return NextResponse.json({ error: adminCountErr.message }, { status: 500 })

    if ((adminCount ?? 0) <= 1) {
      const { count: activeMemberCount, error: activeMemberCountErr } = await supabase
        .from('group_memberships')
        .select('user_id', { count: 'exact', head: true })
        .eq('group_id', groupId)
        .eq('status', 'active')
      if (activeMemberCountErr) return NextResponse.json({ error: activeMemberCountErr.message }, { status: 500 })

      // If group would become empty, delete it (avoids a group without admin).
      if ((activeMemberCount ?? 0) <= 1) {
        // Best-effort cleanup of storage assets.
        try {
          const { data: g } = await supabase.from('groups').select('cover_image_path').eq('id', groupId).maybeSingle()
          const coverPath = (g as any)?.cover_image_path as string | null
          if (coverPath) {
            await supabase.storage.from('group-covers').remove([coverPath])
          }

          const { data: scoreRows } = await supabase
            .from('group_scores')
            .select('storage_path')
            .eq('group_id', groupId)
          const scorePaths = (scoreRows ?? [])
            .map((r: any) => r?.storage_path)
            .filter((p: any) => typeof p === 'string' && p.length > 0)
          if (scorePaths.length > 0) {
            await supabase.storage.from('group-scores').remove(scorePaths)
          }
        } catch {
          // ignore cleanup errors
        }

        const { error: delErr } = await supabase.from('groups').delete().eq('id', groupId)
        if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
        return NextResponse.json({ ok: true, deletedGroup: true })
      }

      // Otherwise block: someone must remain admin.
      return NextResponse.json(
        { error: 'Cannot leave: you are the last admin. Promote another admin or remove members first.' },
        { status: 400 }
      )
    }
  }

  // Soft-remove membership so it disappears from /groups (we only show active/pending).
  const { error } = await supabase
    .from('group_memberships')
    .update({ status: 'rejected', updated_at: nowIso })
    .eq('group_id', groupId)
    .eq('user_id', user.id)
    .in('status', ['active', 'pending'])

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}


