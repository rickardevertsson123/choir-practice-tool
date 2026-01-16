import { getSupabaseAnon } from '../../lib/supabaseAnon'

export type AuthedUser = {
  id: string
  email: string | null
  email_confirmed_at: string | null
  display_name: string | null
}

export async function requireUser(request: Request): Promise<AuthedUser> {
  const auth = request.headers.get('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  const token = m?.[1]
  if (!token) {
    throw new Response('Missing bearer token', { status: 401 })
  }

  const supabase = getSupabaseAnon()
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) {
    throw new Response('Invalid session', { status: 401 })
  }

  const u = data.user
  return {
    id: u.id,
    email: u.email ?? null,
    email_confirmed_at: (u as any).email_confirmed_at ?? null,
    display_name: ((u as any)?.user_metadata?.display_name as string | undefined)?.trim?.() || null,
  }
}


