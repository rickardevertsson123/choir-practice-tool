import { NextResponse } from 'next/server'
import { admin, requireOwner } from '../../../_auth'

export async function POST(
  request: Request,
  ctx: { params: Promise<{ groupId: string }> }
) {
  await requireOwner(request)
  const supabase = admin()
  const { groupId } = await ctx.params

  const body = await request.json().catch(() => ({}))
  const disabled = Boolean(body?.disabled)
  const reason = typeof body?.reason === 'string' ? body.reason : null

  const patch = disabled
    ? { disabled_at: new Date().toISOString(), disabled_reason: reason }
    : { disabled_at: null, disabled_reason: null }

  const { error } = await supabase.from('groups').update(patch).eq('id', groupId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}


