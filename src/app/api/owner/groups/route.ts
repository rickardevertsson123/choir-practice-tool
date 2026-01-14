import { NextResponse } from 'next/server'
import { admin, requireOwner } from '../_auth'

export async function GET(request: Request) {
  await requireOwner(request)
  const supabase = admin()

  const url = new URL(request.url)
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '50')))

  let query = supabase
    .from('groups')
    .select('id,name,created_at,disabled_at,disabled_reason')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (q) query = query.ilike('name', `%${q}%`)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ groups: data ?? [] })
}


