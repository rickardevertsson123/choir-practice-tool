import { getSupabaseAdmin } from '../../../lib/supabaseAdmin'
import { getSupabaseAnon } from '../../../lib/supabaseAnon'

export async function requireOwner(request: Request): Promise<{ ownerEmail: string }> {
  const ownerEmail = process.env.OWNER_EMAIL
  if (!ownerEmail) throw new Error('Missing OWNER_EMAIL')

  const auth = request.headers.get('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  const token = m?.[1]
  if (!token) {
    throw new Response('Missing bearer token', { status: 401 })
  }

  // Validate the token and fetch the user.
  // NOTE: we can use the normal Supabase client here (anon key) since we're only verifying the JWT.
  const supabase = getSupabaseAnon()
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) {
    throw new Response('Invalid session', { status: 401 })
  }

  const email = data.user.email || ''
  if (email.toLowerCase() !== ownerEmail.toLowerCase()) {
    throw new Response('Forbidden', { status: 403 })
  }

  return { ownerEmail: email }
}

export function admin() {
  return getSupabaseAdmin()
}


