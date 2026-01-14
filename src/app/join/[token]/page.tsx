'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { getSupabaseBrowser } from '../../../lib/supabaseBrowser'

export default function JoinPage() {
  const params = useParams()
  const token = String((params as any)?.token ?? '')
  const supabase = useMemo(() => getSupabaseBrowser(), [])

  const [status, setStatus] = useState<'loading' | 'need_login' | 'need_verify' | 'ready' | 'done' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      const user = data.session?.user
      if (!user) {
        setStatus('need_login')
        return
      }
      if (!user.email_confirmed_at) {
        setStatus('need_verify')
        return
      }
      setStatus('ready')
    })
    return () => {
      cancelled = true
    }
  }, [supabase])

  async function requestJoin() {
    setError(null)
    setStatus('loading')
    const { data } = await supabase.auth.getSession()
    const s = data.session
    if (!s) {
      setStatus('need_login')
      return
    }

    try {
      const r = await fetch('/api/join', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setStatus('done')
    } catch (e: any) {
      setError(e?.message ? String(e.message) : 'Unknown error')
      setStatus('error')
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: 16 }}>
      <h2>Join group</h2>

      {status === 'need_login' && (
        <>
          <p>You need to log in to request membership.</p>
          <p>
            <a href="/auth">Go to login</a>
          </p>
        </>
      )}

      {status === 'need_verify' && (
        <>
          <p>Your email is not verified. Verify your email, then refresh this page.</p>
          <p>
            <a href="/groups">Go to My groups</a>
          </p>
        </>
      )}

      {(status === 'ready' || status === 'error') && (
        <>
          <p>This will create a pending membership request for the group invite you opened.</p>
          <button onClick={requestJoin}>Request membership</button>
        </>
      )}

      {status === 'done' && (
        <>
          <p>Request sent. An admin will review it.</p>
          <p>
            <a href="/groups">Back to My groups</a>
          </p>
        </>
      )}

      {error && <p style={{ color: '#ef4444', marginTop: 12 }}>{error}</p>}

      <p style={{ marginTop: 16 }}>
        <a href="/">Home</a>
      </p>
    </div>
  )
}


