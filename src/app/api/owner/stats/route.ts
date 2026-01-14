import { NextResponse } from 'next/server'
import { admin, requireOwner } from '../_auth'

export async function GET(request: Request) {
  await requireOwner(request)
  const supabase = admin()

  // Counts from app tables (profiles + groups). These tables are created via supabase SQL.
  const [{ count: userCount, error: e1 }, { count: disabledUserCount, error: e2 }] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('profiles').select('*', { count: 'exact', head: true }).not('disabled_at', 'is', null),
  ])

  const [{ count: groupCount, error: e3 }, { count: disabledGroupCount, error: e4 }] = await Promise.all([
    supabase.from('groups').select('*', { count: 'exact', head: true }),
    supabase.from('groups').select('*', { count: 'exact', head: true }).not('disabled_at', 'is', null),
  ])

  const err = e1 || e2 || e3 || e4
  if (err) {
    return NextResponse.json(
      { error: err.message, hint: 'Have you applied the SQL schema (profiles/groups tables)?' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    users: userCount ?? 0,
    disabledUsers: disabledUserCount ?? 0,
    groups: groupCount ?? 0,
    disabledGroups: disabledGroupCount ?? 0,
  })
}


